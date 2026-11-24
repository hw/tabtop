package main

// A tab's resources (see docs/browser-plan.md, section 4): the pictures,
// stylesheets and fonts its page shows, fetched here by the broker
// (goresource.go) and sent to the page over the tab's own tunnel, not a
// tunnel each: a new tunnel is a WebSocket and a key exchange, which on a
// distant connection took longer than the fetch. And fetched ahead: as soon
// as a page's snapshot is sent, its stylesheets, pictures and what its
// stylesheets use (imports, fonts, pictures), as the page shown will ask
// for them, so they're here, or on their way, when it does.
//
// The page asks {"op":"res","rid":N,"kind":...,"url":...}; the answer is
// {"type":"go-res","rid":N,"size":...,"mime":...,"url":...} (or "error"),
// then the bytes, in binary messages of the request's number (4 bytes, big
// endian) and up to goResChunk of them. A player's file comes the same way, a range at a
// time ({"op":"res","kind":"media",...,"offset","length","if_size",
// "if_mtime"}; the answer says total_size and validator too: serveMedia).

import (
	"context"
	"encoding/binary"
	"errors"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

const (
	goResChunk      = 256 << 10 // bytes in a binary message
	goResCacheMax   = 64 << 20  // a tab's resources kept, in all
	goPrefetchMax   = 300       // resources fetched ahead for one page, in all
	goPrefetchBytes = 128 << 20 // and their bytes (the page's own budget)
	goPrefetchers   = 4         // fetching at once for it
	goResServesMax  = 64        // a tab's requests answered at once
	goResQueueMax   = 2000      // and waiting their turn (more: refused)
)

// goResCache is a tab's resources: fetched, or being fetched, by kind and
// address; the oldest dropped once there's more than goResCacheMax.
type goResCache struct {
	mu      sync.Mutex
	entries map[string]*goResEntry
	order   []string // keys, oldest first
	bytes   int
}

type goResEntry struct {
	done chan struct{}
	f    goFetched
}

func newGoResCache() *goResCache { return &goResCache{entries: map[string]*goResEntry{}} }

// get is what's kept for key, fetching it with fetch if nothing is (or
// waiting for what's being fetched); a failure isn't kept.
func (c *goResCache) get(ctx context.Context, key string, fetch func() goFetched) goFetched {
	c.mu.Lock()
	e := c.entries[key]
	if e == nil {
		e = &goResEntry{done: make(chan struct{})}
		c.entries[key] = e
		c.order = append(c.order, key)
		c.mu.Unlock()
		e.f = fetch()
		close(e.done)
		c.mu.Lock()
		if e.f.err != nil {
			c.drop(key)
		} else {
			c.bytes += len(e.f.data)
			for c.bytes > goResCacheMax && len(c.order) > 1 && c.order[0] != key {
				c.drop(c.order[0])
			}
		}
		c.mu.Unlock()
		return e.f
	}
	c.mu.Unlock()
	select {
	case <-e.done:
		return e.f
	case <-ctx.Done():
		return goFetched{err: ctx.Err()}
	}
}

// has is whether key is kept or being fetched.
func (c *goResCache) has(key string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.entries[key] != nil
}

// clear forgets what's kept (what's being fetched is fetched as it is: it
// began after what's cleared was).
func (c *goResCache) clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, k := range slices.Clone(c.order) {
		select {
		case <-c.entries[k].done:
			c.drop(k)
		default:
		}
	}
}

// drop forgets key (c.mu held).
func (c *goResCache) drop(key string) {
	e := c.entries[key]
	if e == nil {
		return
	}
	delete(c.entries, key)
	for i, k := range c.order {
		if k == key {
			c.order = append(c.order[:i], c.order[i+1:]...)
			break
		}
	}
	select {
	case <-e.done:
		c.bytes -= len(e.f.data)
	default:
	}
}

// resource fetches kind at raw for this tab, through its cache.
func (b *goBrowser) resource(ctx context.Context, kind, raw string) goFetched {
	if b.resources == nil {
		return goFetched{err: errGoNoResources}
	}
	// An ad's, now: not given from what was kept while it was let through
	// (its site's ads allowed, or ad blocking off).
	if u, err := url.Parse(raw); err == nil && b.from().adBlocked(u, kind) {
		return goFetched{err: errors.New(goRefusals["ads"])}
	}
	return b.res.get(ctx, kind+" "+raw, func() goFetched {
		// Not the page's request's own context: what's fetched is kept,
		// for the page's next request, if this one's given up.
		return goFetchResource(b.ctx, b.resources, b.session, kind, raw, b.ua(), b.from())
	})
}

// serveRes answers the page's request for a resource, over the tab's
// tunnel, from a goroutine of its own: its bytes go between the tab's other
// messages, a chunk at a time.
func (b *goBrowser) serveRes(m goClientMsg) {
	if m.RID <= 0 {
		return
	}
	if b.serving >= goResServesMax {
		// Its turn waited for, not refused (a page asks for hundreds at
		// once); dropped if the page is left first (leftPage).
		if len(b.resQueue) < goResQueueMax {
			b.resQueue = append(b.resQueue, m)
			return
		}
		b.send(map[string]any{"type": "go-res", "rid": m.RID, "error": "Too many resources are loading; try again."})
		return
	}
	b.serving++
	ctx := b.resCtx
	go func() {
		defer b.post(func() {
			b.serving--
			b.nextRes()
		})
		if m.Kind == "media" {
			b.serveMedia(m)
			return
		}
		f := b.resource(ctx, m.Kind, m.URL)
		if f.err != nil {
			goDebugf("res %s %s: %v", m.Kind, goHost(m.URL), f.err)
			b.send(map[string]any{"type": "go-res", "rid": m.RID, "error": f.err.Error()})
			return
		}
		if b.send(map[string]any{"type": "go-res", "rid": m.RID, "size": len(f.data), "mime": f.media, "url": f.url}) != nil {
			return
		}
		for at := 0; at < len(f.data) || at == 0; at += goResChunk {
			end := min(at+goResChunk, len(f.data))
			p := binary.BigEndian.AppendUint32(make([]byte, 0, 4+end-at), uint32(m.RID))
			if b.t.Write(b.ctx, websocket.MessageBinary, append(p, f.data[at:end]...)) != nil || end == len(f.data) {
				return
			}
		}
	}()
}

// nextRes starts the requests waiting their turn, as there's room.
func (b *goBrowser) nextRes() {
	for b.serving < goResServesMax && len(b.resQueue) > 0 {
		m := b.resQueue[0]
		b.resQueue = b.resQueue[1:]
		b.serveRes(m)
	}
	if len(b.resQueue) == 0 {
		b.resQueue = nil // its array let go
	}
}

// leftPage drops what the page being left asked for and hasn't had: those
// waiting their turn (told so, the page's requests ended), and those
// waiting on what's being fetched, which goes on, kept for whoever asks
// next. The next page's aren't held up behind them.
func (b *goBrowser) leftPage() {
	b.device, b.pip, b.imagePaste, b.locWatch = nil, nil, nil, nil
	b.fullscreenGone() // (gofullscreen.go)
	b.notifyGone()     // (gonotify.go)
	for _, m := range b.resQueue {
		b.send(map[string]any{"type": "go-res", "rid": m.RID, "error": "The page was left."})
	}
	b.resQueue = nil
	if b.resCancel != nil {
		b.resCancel()
	}
	b.resCtx, b.resCancel = context.WithCancel(b.ctx)
}

// serveMedia answers a player's request for a range of its file (see
// go-media.js), as a go-resource "media" request is answered, but over the
// tab's tunnel: a part asked for on a tunnel of its own waited for that
// tunnel's connection and handshake first, several round trips a part.
func (b *goBrowser) serveMedia(m goClientMsg) {
	fail := func(err error) {
		b.send(map[string]any{"type": "go-res", "rid": m.RID, "error": err.Error()})
	}
	u, err := url.Parse(m.URL)
	if err != nil || len(m.URL) > maxGoURL || !goPortAllowed(u) {
		fail(errors.New("Media loads only from ports 80 and 443."))
		return
	}
	if goBlockedHost(u.Hostname()) {
		fail(errors.New(goRefusals["blocked"]))
		return
	}
	if b.sites.videoHostBlocked(u.Hostname()) {
		fail(errors.New(goRefusals["videos"]))
		return
	}
	if b.resources == nil {
		fail(errGoNoResources)
		return
	}
	// The session's share of the broker's slots, as its pictures' are.
	ctx, cancel := context.WithTimeout(b.ctx, 20*time.Second)
	mine, ok := goSessionSlots.acquire(ctx, b.session)
	cancel()
	if !ok {
		fail(errors.New("Too many resources are loading; try again."))
		return
	}
	defer mine()
	data, reply, err := goFetchMedia(b.ctx, b.session, tunnelRequest{Resource: "media", URL: m.URL, Offset: m.Offset, Length: m.Length,
		IfSize: m.IfSize, IfMtime: m.IfMtime}, b.resources, goResourceSlots, b.ua(), b.from())
	if err != nil {
		if b.ctx.Err() == nil {
			fail(err)
		}
		return
	}
	reply["type"], reply["rid"] = "go-res", m.RID
	if b.send(reply) != nil {
		return
	}
	for at := 0; at < len(data); at += goResChunk {
		end := min(at+goResChunk, len(data))
		p := binary.BigEndian.AppendUint32(make([]byte, 0, 4+end-at), uint32(m.RID))
		if b.t.Write(b.ctx, websocket.MessageBinary, append(p, data[at:end]...)) != nil {
			return
		}
	}
}

func goHost(raw string) string {
	if u, err := url.Parse(raw); err == nil {
		return u.Host
	}
	return ""
}

// goPrefetcher fetches ahead for one page: what's wanted queued (at most
// goPrefetchMax, whatever a page's stylesheets ask for), a few at a time,
// until goPrefetchBytes have come or the tab goes to another page.
type goPrefetcher struct {
	ctx    context.Context
	cancel context.CancelFunc
	queue  chan goPrefetch
	count  atomic.Int32
	bytes  atomic.Int64
}

type goPrefetch struct {
	goWanted
	depth int
}

// want queues w, unless it's had or wanted already, or enough are.
func (p *goPrefetcher) want(b *goBrowser, w goWanted, depth int) {
	if p.ctx.Err() != nil || b.res.has(w.kind+" "+w.url) || p.count.Add(1) > goPrefetchMax {
		return
	}
	select {
	case p.queue <- goPrefetch{w, depth}:
	default:
	}
}

// work fetches what's queued; what a stylesheet uses is queued in turn
// (imports four deep, as the page shown follows them).
func (p *goPrefetcher) work(b *goBrowser) {
	for {
		var w goPrefetch
		select {
		case <-p.ctx.Done():
			return
		case w = <-p.queue:
		}
		f := b.res.get(p.ctx, w.kind+" "+w.url, func() goFetched {
			return goFetchResource(p.ctx, b.resources, b.session, w.kind, w.url, b.ua(), b.from())
		})
		if p.bytes.Add(int64(len(f.data))) > goPrefetchBytes {
			p.cancel() // the page's had its share
			return
		}
		if f.err != nil || w.kind != "css" || w.depth >= 4 {
			continue
		}
		for _, u := range goCSSWants(string(f.data)) {
			if abs := goResolve(u.url, w.url); abs != "" {
				p.want(b, goWanted{u.kind, abs}, w.depth+1)
			}
		}
	}
}

// prefetch fetches ahead what the page shown from snapshot doc will ask for:
// its stylesheets, pictures and inline styles' pictures, and what the
// stylesheets use, as the page shown takes them (goCSSWants); what was
// being fetched ahead for the page before stops.
func (b *goBrowser) prefetch(doc *goNode, base string) {
	if b.prefetcher != nil {
		b.prefetcher.cancel()
		b.prefetcher = nil
	}
	if b.resources == nil || doc == nil {
		return
	}
	wanted := goWants(doc, base)
	ctx, cancel := context.WithCancel(b.ctx)
	p := &goPrefetcher{ctx: ctx, cancel: cancel, queue: make(chan goPrefetch, goPrefetchMax)}
	b.prefetcher = p
	for _, w := range wanted {
		p.want(b, w, 0)
	}
	for range goPrefetchers {
		go p.work(b)
	}
}

// goWants is what the page shown from doc will ask the broker for: its
// stylesheets, pictures and inline styles' pictures (an embedded page's
// against its own base); what the stylesheets use comes as they're read.
func goWants(doc *goNode, base string) []goWanted {
	var wanted []goWanted
	add := func(kind, raw, against string) {
		if len(wanted) >= goPrefetchMax {
			return
		}
		if u := goResolve(raw, against); u != "" {
			wanted = append(wanted, goWanted{kind, u})
		}
	}
	var walk func(n *goNode, base string)
	walk = func(n *goNode, base string) {
		if n == nil {
			return
		}
		if n.Type == 9 && n.Base != "" {
			base = n.Base // an embedded page's, its own
		}
		if n.Type == 1 {
			name := strings.ToLower(n.Name)
			attr := func(k string) string {
				for i := 0; i+1 < len(n.Attrs); i += 2 {
					if strings.EqualFold(n.Attrs[i], k) {
						return n.Attrs[i+1]
					}
				}
				return ""
			}
			switch name {
			case "link":
				rel := " " + strings.ToLower(attr("rel")) + " "
				if strings.Contains(rel, " stylesheet ") && !strings.Contains(rel, " alternate ") {
					add("css", attr("href"), base)
				}
			case "img":
				add("image", attr("src"), base)
			case "style":
				var text strings.Builder
				for _, k := range n.Kids {
					text.WriteString(k.Value)
				}
				for _, w := range goCSSWants(text.String()) {
					add(w.kind, w.url, base)
				}
			}
			if style := attr("style"); strings.Contains(strings.ToLower(style), "url(") {
				for _, w := range goCSSWants(style) {
					add(w.kind, w.url, base)
				}
			}
		}
		for _, k := range n.Kids {
			walk(k, base)
		}
		if n.Shadow != nil {
			walk(n.Shadow, base)
		}
	}
	walk(doc, base)
	return wanted
}

type goWanted struct{ kind, url string }

// goResolve is raw as an http(s) address, against base, or "".
func goResolve(raw, base string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" || strings.HasPrefix(strings.ToLower(raw), "data:") {
		return ""
	}
	b, err := url.Parse(base)
	if err != nil {
		return ""
	}
	u, err := b.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return ""
	}
	u.Fragment = ""
	return u.String()
}

var (
	goCSSURL      = regexp.MustCompile(`(?i)url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)`)
	goCSSImport   = regexp.MustCompile(`(?i)@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^)'"\s;]+))`)
	goCSSFontFace = regexp.MustCompile(`(?is)@font-face\s*\{[^}]*\}`)
	goCSSImageSet = regexp.MustCompile(`(?is)(?:-webkit-)?image-set\(([^)]*)\)`)
	goCSSString   = regexp.MustCompile(`"([^"]*)"|'([^']*)'`)
)

// goCSSWants is what a stylesheet's text uses, as the page shown fetches
// it (go-frame.js's stylesheet): @import as stylesheets, url() in
// @font-face as fonts, any other url() and image-set()'s strings as
// pictures. Escapes and comments aren't undone: what's missed is fetched
// when the page asks, as before.
func goCSSWants(text string) []goWanted {
	var out []goWanted
	first := func(m []string) string {
		for _, s := range m[1:] {
			if s != "" {
				return s
			}
		}
		return ""
	}
	fonts := map[int]bool{}
	for _, span := range goCSSFontFace.FindAllStringIndex(text, -1) {
		for _, m := range goCSSURL.FindAllStringSubmatchIndex(text[span[0]:span[1]], -1) {
			fonts[span[0]+m[0]] = true
		}
	}
	imports := map[int]bool{}
	for _, m := range goCSSImport.FindAllStringSubmatchIndex(text, -1) {
		parts := make([]string, 4)
		for i := 1; i <= 3; i++ {
			if m[2*i] >= 0 {
				parts[i] = text[m[2*i]:m[2*i+1]]
			}
		}
		if u := first(parts); u != "" {
			out = append(out, goWanted{"css", u})
		}
		// Its url(), if it has one, is the import's, not a picture.
		if loc := goCSSURL.FindStringIndex(text[m[0]:]); loc != nil && loc[0] < m[1]-m[0] {
			imports[m[0]+loc[0]] = true
		}
	}
	for _, m := range goCSSURL.FindAllStringSubmatchIndex(text, -1) {
		if imports[m[0]] {
			continue
		}
		parts := make([]string, 4)
		for i := 1; i <= 3; i++ {
			if m[2*i] >= 0 {
				parts[i] = text[m[2*i]:m[2*i+1]]
			}
		}
		u := first(parts)
		if u == "" || strings.HasPrefix(u, "#") {
			continue
		}
		// A @font-face's sources aren't fetched ahead: the copy asks for a
		// face's font only once its text uses it (go-frame.js), and for the
		// one source a browser would use, not the others (old formats,
		// fallbacks, faces for other scripts, fonts the page never shows).
		if fonts[m[0]] {
			continue
		}
		out = append(out, goWanted{"image", u})
	}
	for _, m := range goCSSImageSet.FindAllStringSubmatch(text, -1) {
		for _, s := range goCSSString.FindAllStringSubmatch(m[1], -1) {
			if u := first(s); u != "" {
				out = append(out, goWanted{"image", u})
			}
		}
	}
	return out
}

var errGoNoResources = errors.New("The remote browser can't fetch resources here.")
