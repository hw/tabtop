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
	"compress/gzip"
	"context"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/andybalholm/brotli"
)

const (
	maxGoImage = 10 << 20
	maxGoCSS   = 4 << 20 // sites' bundles are larger than previews' sheets
	maxGoFont  = 8 << 20
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
		if next.URL.User != nil || next.URL.Scheme != "http" && next.URL.Scheme != "https" || !goPortAllowed(next.URL) || goBlockedHost(next.URL.Hostname()) {
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

// goUnlabelled is whether a media type says nothing of what the bytes are.
func goUnlabelled(media string) bool {
	switch media {
	case "", "application/octet-stream", "binary/octet-stream", "application/binary", "application/unknown":
		return true
	}
	return false
}

// goSniffImage is the type of a raster picture the bytes are (PNG, JPEG,
// GIF, WebP, BMP or icon), or "" for anything else: never SVG or HTML,
// which only a label lets through.
func goSniffImage(data []byte) string {
	switch t := http.DetectContentType(data); t {
	case "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/x-icon":
		return t
	}
	return ""
}

// goFetched is a resource fetched for a page: its bytes, what they are,
// and where they came from (after redirects); or why not.
type goFetched struct {
	data  []byte
	media string
	url   string
	err   error
}

// goFetchResource fetches raw, as a resource of kind, for session: with
// client, where the remote browser may go, within the kind's limit, of the
// kind's types (a picture labelled as just bytes looked at, as browsers
// do), waiting for a slot of the session's share and of all.
func goFetchResource(ctx context.Context, client *http.Client, session, kind, raw, userAgent string) goFetched {
	fail := func(m string) goFetched { return goFetched{err: errors.New(m)} }
	limit := goResourceLimit(kind)
	if limit == 0 {
		return fail("Unsupported resource type.")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.Scheme != "http" && u.Scheme != "https" || len(raw) > maxGoURL {
		return fail("Give an HTTP or HTTPS address without credentials.")
	}
	if !goPortAllowed(u) {
		return fail("Resources load only from ports 80 and 443.")
	}
	if goBlockedHost(u.Hostname()) {
		return fail(goRefusals["blocked"])
	}
	mine, ok := goSessionSlots.acquire(ctx, session)
	if !ok {
		return fail("Too many resources are loading; try again.")
	}
	defer mine()
	release, ok := goResourceSlots.acquireContext(ctx)
	if !ok {
		return fail("Too many resources are loading; try again.")
	}
	defer release()
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return fail("Invalid resource address.")
	}
	request.Header.Set("User-Agent", userAgent) // the tab's (gouseragent.go)
	request.Header.Set("Accept", map[string]string{"image": "image/*", "css": "text/css", "font": "font/*, application/font-woff, */*;q=0.1"}[kind])
	// Brotli and gzip, as a browser asks (decoded below; asked here, not by
	// the transport, which would then decode gzip alone).
	request.Header.Set("Accept-Encoding", "br, gzip")
	response, err := client.Do(request)
	if err != nil {
		return goFetched{err: fetchError(err)}
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fail("The resource wasn't found (HTTP " + strconv.Itoa(response.StatusCode) + ").")
	}
	// Decoded as it's read: what's limited below is what it decodes to (a
	// small file that decodes to a great deal is stopped there).
	body := io.Reader(response.Body)
	switch enc := strings.ToLower(strings.TrimSpace(response.Header.Get("Content-Encoding"))); enc {
	case "", "identity":
	case "br":
		body = brotli.NewReader(response.Body)
	case "gzip", "x-gzip":
		zr, err := gzip.NewReader(response.Body)
		if err != nil {
			return fail("The resource couldn't be read.")
		}
		defer zr.Close()
		body = zr
	default:
		return fail("The resource came in an encoding that isn't supported.") // not asked for
	}
	media, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	// A picture labelled as just bytes (some storage services say
	// binary/octet-stream for everything) is looked at, as browsers do:
	// below, once it's read.
	sniff := kind == "image" && goUnlabelled(media)
	if !sniff && !previewResourceType(kind, media) {
		return fail("The resource isn't of the type asked for.")
	}
	tooLarge := "The resource is too large (over " + strconv.FormatInt(limit>>20, 10) + " MB)."
	if response.ContentLength > limit {
		return fail(tooLarge)
	}
	data, err := io.ReadAll(io.LimitReader(body, limit+1))
	if err != nil {
		return fail("The resource couldn't be read.")
	}
	if int64(len(data)) > limit {
		return fail(tooLarge)
	}
	if sniff {
		if media = goSniffImage(data); media == "" {
			return fail("The resource isn't of the type asked for.")
		}
	}
	if kind == "font" && !previewFont(data) {
		return fail("The resource isn't a supported font.")
	}
	return goFetched{data: data, media: media, url: response.Request.URL.String()}
}

// routeGoResource answers a "go-resource" request, on a tunnel of its own:
// how a page's resources came before the tab's own tunnel carried them
// (see goprefetch.go), and still do when it isn't open.
func (g *server) routeGoResource(c *tunnelCall) {
	switch {
	case !g.goOn:
		c.r.fail("The remote browser is turned off (WEB_GO=0).")
		return
	case g.goMode == goUnavailable || g.goResources == nil:
		c.r.fail("The remote browser is unavailable: " + g.goWhy + ".")
		return
	}
	if c.req.Resource == "media" {
		// Audio and video, in byte ranges, for the players the /go page
		// lays over the copy (go-media.js): where the remote browser may
		// go, on HTTP's and HTTPS's ports.
		u, err := url.Parse(c.req.URL)
		if err != nil || len(c.req.URL) > maxGoURL || !goPortAllowed(u) {
			c.r.fail("Media loads only from ports 80 and 443.")
			return
		}
		if goBlockedHost(u.Hostname()) {
			c.r.fail(goRefusals["blocked"])
			return
		}
		// The session's share of the broker's slots, as its pictures'
		// are (goSessionSlots): one session's players can't hold them all.
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		mine, ok := goSessionSlots.acquire(ctx, c.session)
		cancel()
		if !ok {
			c.r.fail("Too many resources are loading; try again.")
			return
		}
		defer mine()
		// With no tab to ask, the cookies kept for the media's site that
		// any page may send it (SameSite=None).
		var cookies func(*url.URL) string
		if g.goCookies != nil {
			cookies = func(u *url.URL) string { return g.goCookies.header(u, "") }
		}
		serveRemoteResource(c.t, c.req, c.r, g.goResources, goResourceSlots, goSessionUA(c.session), cookies)
		return
	}
	w := newChunkWriter(c.t)
	defer w.stop()
	f := goFetchResource(w.ctx, g.goResources, c.session, c.req.Resource, c.req.URL, goSessionUA(c.session))
	if f.err != nil {
		if w.ctx.Err() == nil {
			c.r.fail(f.err.Error())
		}
		return
	}
	if !c.r.accept(map[string]any{"size": len(f.data), "mime": f.media, "url": f.url}) {
		return
	}
	if _, err := w.Write(f.data); err != nil {
		w.fail(err)
		return
	}
	if w.flush() == nil {
		c.r.finish(nil)
	}
}
