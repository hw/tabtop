package main

// The remote browser's resource broker (see docs/browser-plan.md, section
// 4). The page showing a snapshot can't load anything from the web itself
// (its frame's policy allows no network origin), so the pictures,
// stylesheets and fonts a page uses come through the tunnel, as
// "go-resource" requests, fetched here where fetches may go: public
// addresses (and private ones with -go-private), checked on every
// connection and redirect. Nothing is sent but the request: no cookies, no
// referrer, a fixed User-Agent.
import (
	"context"
	"io"
	"mime"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"sync"
	"time"
)

const (
	maxGoImage = 10 << 20
	maxGoCSS   = 4 << 20 // sites' bundles are larger than previews' sheets
	maxGoFont  = 8 << 20
	// goUserAgent is what the broker says it is.
	goUserAgent = "Mozilla/5.0 (compatible; TabTop remote browser)"
)

// goResourceSlots bounds the broker's fetches at once, across sessions; a
// request waits a while for one, as a page asks for many together.
var goResourceSlots = newBoundedWork(8, 20*time.Second)

// goResourcePerSession bounds one session's share of those, so that tabs
// of one session waiting on a slow site can't hold up everyone else's: its
// requests over that wait their turn without holding a slot.
const goResourcePerSession = 4

var goSessionSlots = goSessionWork{work: map[string]*goSessionShare{}}

type goSessionWork struct {
	mu   sync.Mutex
	work map[string]*goSessionShare
}

type goSessionShare struct {
	work  *previewWork
	users int // requests holding or waiting for one of its slots
}

// acquire waits for one of session's slots, as acquireContext does.
func (s *goSessionWork) acquire(ctx context.Context, session string) (func(), bool) {
	s.mu.Lock()
	share := s.work[session]
	if share == nil {
		share = &goSessionShare{work: newBoundedWork(goResourcePerSession, 20*time.Second)}
		s.work[session] = share
	}
	share.users++
	s.mu.Unlock()
	done := func() {
		s.mu.Lock()
		if share.users--; share.users == 0 {
			delete(s.work, session)
		}
		s.mu.Unlock()
	}
	release, ok := share.work.acquireContext(ctx)
	if !ok {
		done()
		return nil, false
	}
	return func() { release(); done() }, true
}

func goResourceLimit(kind string) int64 {
	switch kind {
	case "image":
		return maxGoImage
	case "css":
		return maxGoCSS
	case "font":
		return maxGoFont
	}
	return 0
}

// newGoResourceClient fetches where allow says, as fetches do, but
// decompressing gzip as it reads: the limits count what's decompressed, so
// a small compressed response can't become a huge one.
func newGoResourceClient(allow func(netip.Addr) bool) *http.Client {
	client := newFetchClient(allow)
	transport := client.Transport.(*http.Transport).Clone()
	transport.DisableCompression = false
	client.Transport = transport
	redirects := client.CheckRedirect
	client.CheckRedirect = func(next *http.Request, via []*http.Request) error {
		if next.URL.User != nil || next.URL.Scheme != "http" && next.URL.Scheme != "https" || !goPortAllowed(next.URL) {
			return http.ErrUseLastResponse
		}
		next.Header.Del("Referer")
		return redirects(next, via)
	}
	return client
}

// goPortAllowed is whether u's port is one the remote browser may reach
// (goProxyPorts), as the engine's proxy checks its requests.
func goPortAllowed(u *url.URL) bool {
	port := u.Port()
	if port == "" {
		port = map[string]string{"http": "80", "https": "443"}[u.Scheme]
	}
	return goProxyPorts[port]
}

func (g *server) routeGoResource(c *tunnelCall) {
	switch {
	case !g.goOn:
		c.r.fail("The remote browser is turned off (WEB_GO=0).")
		return
	case g.goMode == goUnavailable || g.goResources == nil:
		c.r.fail("The remote browser is unavailable: " + g.goWhy + ".")
		return
	}
	kind := c.req.Resource
	limit := goResourceLimit(kind)
	if limit == 0 {
		c.r.fail("Unsupported resource type.")
		return
	}
	u, err := url.Parse(c.req.URL)
	if err != nil || u.Host == "" || u.User != nil || u.Scheme != "http" && u.Scheme != "https" || len(c.req.URL) > maxGoURL {
		c.r.fail("Give an HTTP or HTTPS address without credentials.")
		return
	}
	if !goPortAllowed(u) {
		c.r.fail("Resources load only from ports 80 and 443.")
		return
	}
	w := newChunkWriter(c.t)
	defer w.stop()
	mine, ok := goSessionSlots.acquire(w.ctx, c.session)
	if !ok && w.ctx.Err() != nil {
		return // the page stopped waiting
	} else if !ok {
		c.r.fail("Too many resources are loading; try again.")
		return
	}
	defer mine()
	release, ok := goResourceSlots.acquireContext(w.ctx)
	if !ok && w.ctx.Err() != nil {
		return // the page stopped waiting
	} else if !ok {
		c.r.fail("Too many resources are loading; try again.")
		return
	}
	defer release()
	ctx, cancel := context.WithTimeout(w.ctx, 30*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		c.r.fail("Invalid resource address.")
		return
	}
	request.Header.Set("User-Agent", goUserAgent)
	request.Header.Set("Accept", map[string]string{"image": "image/*", "css": "text/css", "font": "font/*, application/font-woff, */*;q=0.1"}[kind])
	response, err := g.goResources.Do(request)
	if err != nil {
		c.r.fail(fetchError(err).Error())
		return
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		c.r.fail("The resource wasn't found (HTTP " + strconv.Itoa(response.StatusCode) + ").")
		return
	}
	if enc := response.Header.Get("Content-Encoding"); enc != "" && enc != "identity" {
		// gzip is decompressed as it's read (and the header removed);
		// anything else wasn't asked for.
		c.r.fail("The resource came in an encoding that isn't supported.")
		return
	}
	media, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if !previewResourceType(kind, media) {
		c.r.fail("The resource isn't of the type asked for.")
		return
	}
	if response.ContentLength > limit {
		c.r.fail("The resource is too large (over " + strconv.FormatInt(limit>>20, 10) + " MB).")
		return
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		c.r.fail("The resource couldn't be read.")
		return
	}
	if int64(len(data)) > limit {
		c.r.fail("The resource is too large (over " + strconv.FormatInt(limit>>20, 10) + " MB).")
		return
	}
	if kind == "font" && !previewFont(data) {
		c.r.fail("The resource isn't a supported font.")
		return
	}
	if !c.r.accept(map[string]any{"size": len(data), "mime": media, "url": response.Request.URL.String()}) {
		return
	}
	if _, err := w.Write(data); err != nil {
		w.fail(err)
		return
	}
	if w.flush() == nil {
		c.r.finish(nil)
	}
}
