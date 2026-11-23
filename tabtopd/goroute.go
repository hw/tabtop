package main

// The remote browser's tunnel route, "go" (see docs/browser-plan.md,
// sections 4 and 6). One tunnel is one browsing context: its own engine
// (goengine.go), started for it and killed when it closes, as it does when
// the page closes it, the session ends or logs out, or the server stops.
// What goes over it, both ways, is gobrowser.go's.
//
// The page sends JSON text:
//
//	{"op":"navigate","url":...,"view":{"w":...,"h":...,"dpr":...}}  {"op":"stop"}
//	{"op":"viewport","view":{...}}  the frame's size, orientation or colour scheme changed: the engine follows
//	{"op":"event","gen":N,"kind":"click"|"input"|"change"|"key"|"submit"|"focus","id":...}
//	{"op":"event","gen":N,"kind":"mouse","type":"down"|"up"|"move"|"wheel"|"cancel","id":...,"fx":...,"fy":...,...}
//	{"op":"event","gen":N,"kind":"key","type":"down"|"up","id":...,"key":...,"code":...,"keyCode":...}  (goinput.go)
//	{"op":"dialog","accept":...,"text":...}  {"op":"resync","gen":N}
//
// and the server answers, for each generation (a navigation, the person's
// or the page's):
//
//	{"type":"go-loading","gen":N,"url":...,"by":"you"|"page"}
//	{"type":"go-snapshot","gen":N,"url":final,"base":...,"title":...,"doc":tree,"again":bool}
//	{"type":"go-changes","gen":N,"seq":K,"title":...,"ops":[...]}
//	{"type":"go-url","gen":N,"url":...}         the page changed its address itself
//	{"type":"go-dialog","gen":N,"kind":...,"message":...,"default":...,"url":...}
//	{"type":"go-file","gen":N,"url":...,"mime":...}  a file, not a page
//	{"type":"go-error","gen":N,"message":...}
//
// A snapshot's nodes are {"i":id,"t":type,"n":name,"v":text,"a":[name,
// value,...],"c":[...]}, read by the agent (goagent.js) in an isolated
// world, with what can never be shown left out (scripts, noscript,
// templates, comments, event handler attributes), again here (goClean). It's
// still the page's, so the page that shows it sanitizes it again, and loads
// nothing from the web itself.
import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"image/png"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	// Engines (browsing contexts) open at once, for a session and in all.
	maxGoPerSession = 6
	maxGoEngines    = 12
	// goClientMessage is the largest message the page may send: a URL.
	goClientMessage = 64 << 10
	maxGoURL        = 8 << 10
	// goSnapshotLimit is the largest snapshot sent; a bigger page is an
	// error, not a partial one.
	goSnapshotLimit = 16 << 20
	// goLoadTimeout is how long a page has to load before what's there is
	// shown anyway.
	goLoadTimeout = 30 * time.Second
	goCallTimeout = 15 * time.Second
)

// openGo counts an engine for session, unless that's too many.
func (g *server) openGo(session string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.goEngines == nil {
		g.goEngines = map[string]int{}
	}
	total := 0
	for _, n := range g.goEngines {
		total += n
	}
	if total >= maxGoEngines || g.goEngines[session] >= maxGoPerSession {
		return false
	}
	g.goEngines[session]++
	return true
}

func (g *server) closeGo(session string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.goEngines[session]--; g.goEngines[session] <= 0 {
		delete(g.goEngines, session)
	}
}

func (g *server) routeGo(c *tunnelCall) {
	switch {
	case !g.goOn:
		c.r.fail("The remote browser is turned off (WEB_GO=0).")
		return
	case g.goMode == goUnavailable:
		c.r.fail("The remote browser is unavailable: " + g.goWhy + ".")
		return
	}
	c.t.c.SetReadLimit(goClientMessage + tunnelOverhead)
	sandboxed := g.goMode == goSandboxed
	// A tab kept while its connection was lost (goresume.go), its token
	// brought back from the same session: taken back as it is. (A token
	// of a tab gone, or another session's: a new tab, as before.)
	tabs := g.goTabList()
	if t := tabs.find(c.req.Resume, c.session); t != nil {
		if !c.r.accept(map[string]any{"sandboxed": sandboxed, "resume": t.token, "resumed": true}) {
			return
		}
		logGoTab("taken back", c.ip)
		if t.lend(newGoLink(c.t, c.req.Deflate), true) {
			logGoTab("connection gone", c.ip)
		}
		return
	}
	// At the limit: a tab no one's connected to makes way (the one let go
	// longest ago), as it would have closed at once before tabs were kept.
	if !g.openGo(c.session) && !(tabs.makeRoom(c.session) && g.openGo(c.session)) {
		c.r.fail("Too many remote browser tabs are open.")
		return
	}
	e, err := startGoEngine(g.goConfig)
	if err != nil {
		g.closeGo(c.session)
		log.Printf("go: engine for %s: %v", c.ip, err)
		c.r.fail("The remote browser's engine didn't start.")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
	cdp, err := dialCDP(ctx, e)
	var page, target string
	if err == nil {
		page, target, err = cdp.newPageTarget(ctx)
	}
	for _, m := range []string{"Page.enable", "Runtime.enable", "Network.enable"} {
		if err == nil {
			err = cdp.call(ctx, page, m, nil, nil)
		}
	}
	// A file input's chooser told, not shown (gouploads.go); an engine
	// that can't, its file inputs left as they are.
	if err == nil {
		if ferr := cdp.call(ctx, page, "Page.setInterceptFileChooserDialog", map[string]any{"enabled": true}, nil); ferr != nil {
			goDebugf("file chooser not intercepted: %v", ferr)
		}
	}
	cancel()
	if err != nil {
		if cdp != nil {
			cdp.close()
		}
		e.kill("its tab didn't start")
		g.closeGo(c.session)
		log.Printf("go: engine for %s: %v", c.ip, err)
		c.r.fail("The remote browser's engine didn't start.")
		return
	}
	b := newGoBrowser(e, cdp, page, target)
	onAd := b.adCounted
	e.proxy.onAd.Store(&onAd)    // counted for the page (goadblock.go)
	e.proxy.certs.Store(b.certs) // its certificate exceptions' guard (gocert.go)
	b.resources, b.session = g.goResources, c.session
	// The account's cookies, given before anything's loaded; what the
	// tab's sites set taken back as it closes (gocookies.go).
	b.jar, b.storage = g.goCookies, g.goStorage
	b.sites = g.goSites
	t := &goTab{token: goToken(), session: c.session, b: b, ended: make(chan struct{})}
	tabs.add(t) // the token can be used as soon as the reply arrives
	if !c.r.accept(map[string]any{"sandboxed": sandboxed, "resume": t.token}) {
		tabs.remove(t)
		close(t.ended)
		cdp.close()
		e.kill("its tab was closed")
		g.closeGo(c.session)
		return
	}
	log.Printf("go: remote browser tab from %s opened (%s)", c.ip, g.goMode)
	go g.runGoTab(t, tabs, c.ip)
	if t.lend(newGoLink(c.t, c.req.Deflate), false) {
		logGoTab("connection gone", c.ip)
	}
}

// runGoTab runs a tab, from its first connection till it ends: closed,
// its engine gone, its session ended, or not taken back in time.
func (g *server) runGoTab(t *goTab, tabs *goTabs, ip string) {
	b, e := t.b, t.b.e
	defer close(t.ended)
	defer tabs.remove(t)
	defer g.closeGo(t.session)
	defer e.kill("its tab was closed")
	defer b.cdp.close()
	defer g.abortMSEStages(t.token)
	defer goPruneCacheSoon(g.goConfig.cache) // what it added, kept to size
	if dir := g.goConfig.cache; dir != "" {
		// And while it runs: a tab kept open for hours adds to it too.
		prune := time.NewTicker(goCacheEvery)
		done := make(chan struct{})
		defer func() { prune.Stop(); close(done) }()
		go func() {
			for {
				select {
				case <-prune.C:
					goPruneCacheSoon(dir)
				case <-done:
					return
				}
			}
		}()
	}
	ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
	b.startStorage(ctx)
	cancel()
	ctx, cancel = context.WithTimeout(context.Background(), goCallTimeout)
	b.startUA(ctx)
	b.startCookies(ctx)
	cancel()
	defer b.endCookies()
	defer b.endStorage()
	b.run()
	log.Printf("go: remote browser tab from %s closed", ip)
}

// goURL checks a URL the page asked for: HTTP or HTTPS, with a host and no
// credentials. Where it may go is the egress proxy's to decide.
func goURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if len(raw) > maxGoURL {
		return "", errors.New("That address is too long.")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.Scheme != "http" && u.Scheme != "https" {
		return "", errors.New("Enter an address starting with http:// or https://.")
	}
	if u.User != nil {
		return "", errors.New("Addresses with a user name or password aren't supported.")
	}
	return u.String(), nil
}

// goNavError is what the page is told when a navigation fails.
func goNavError(err error) string {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "ERR_FAILED"), strings.Contains(msg, "ERR_TUNNEL"), strings.Contains(msg, "ERR_PROXY"):
		return "The page couldn't be loaded: the site can't be reached from here, or the server doesn't allow that address."
	case errors.Is(err, context.DeadlineExceeded):
		return "The page took too long to load."
	}
	return "The page couldn't be loaded (" + msg + ")."
}

// goNode is a node of a snapshot.
type goNode struct {
	ID        int         `json:"i"`
	Type      int         `json:"t"`
	Name      string      `json:"n,omitempty"`
	Value     string      `json:"v,omitempty"`
	Base      string      `json:"b,omitempty"`  // base URL of an embedded document
	FrameDoc  int         `json:"f,omitempty"`  // identity of a separately read iframe document
	CanvasPNG string      `json:"p,omitempty"`  // bounded Canvas2D PNG, base64
	GL        *goGLLog    `json:"gl,omitempty"` // bounded WebGL command log, whole
	CanvasErr string      `json:"pe,omitempty"` // why the canvas has no readable pixels
	glStream  *goGLStream // the WebGL log's state, for the deltas after it
	Attrs     []string    `json:"a,omitempty"`
	Kids      []*goNode   `json:"c,omitempty"`
	// Shadow is an element's shadow root (Type 11), its nodes numbered as
	// the document's (goagent.js's serShadow); SS, a shadow root's adopted
	// stylesheets, by the number of their text, which a document's CSS
	// (Type 9, a snapshot's) or a batch's says.
	Shadow *goNode           `json:"s,omitempty"`
	SS     int               `json:"ss,omitempty"`
	CSS    map[string]string `json:"css,omitempty"`
}

const (
	goCanvasPNGMax    = 1 << 20
	goCanvasPixelsMax = 16 << 20
	goCanvasSizeMax   = 4096
)

// goCanvasPNGValid accepts only a bounded, decodable PNG. Canvas messages
// originate in the page's main world and are untrusted like the DOM tree.
func goCanvasPNGValid(encoded string) bool {
	if encoded == "" || len(encoded) > goCanvasPNGMax || len(encoded)%4 != 0 {
		return false
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(raw) > goCanvasPNGMax {
		return false
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(raw))
	if err != nil || cfg.Width < 1 || cfg.Height < 1 || cfg.Width > goCanvasSizeMax || cfg.Height > goCanvasSizeMax {
		return false
	}
	return int64(cfg.Width)*int64(cfg.Height) <= goCanvasPixelsMax
}

func goCanvasError(reason string) string {
	switch reason {
	case "tainted", "large", "unsupported", "unavailable":
		return reason
	default:
		return "unavailable"
	}
}

// goDropped are elements a snapshot leaves out, with all inside them:
// scripts have run in the engine already, noscript is for when they
// don't, and a template's content isn't the page's.
var goDropped = map[string]bool{"script": true, "noscript": true, "template": true}

// goClean takes out of a snapshot, again, what the serializer leaves out:
// elements that can never be shown and event handler attributes. (The page
// that shows the snapshot sanitizes it a third time.)
func goClean(n *goNode) *goNode {
	if n == nil {
		return nil
	}
	switch n.Type {
	case 1:
		n.Base = ""
		if goDropped[strings.ToLower(n.Name)] {
			return nil
		}
		if strings.EqualFold(n.Name, "canvas") {
			n.glStream = nil
			if n.GL != nil {
				stream, ok := n.GL.check(nil)
				n.glStream = stream
				if !ok {
					n.glStream = nil
					n.GL = nil
					n.CanvasErr = "unsupported"
				}
				n.CanvasPNG = ""
			} else if n.CanvasPNG != "" && !goCanvasPNGValid(n.CanvasPNG) {
				n.CanvasPNG = ""
				n.CanvasErr = "unavailable"
			}
			if n.CanvasPNG == "" && n.GL == nil {
				n.CanvasErr = goCanvasError(n.CanvasErr)
			} else if n.CanvasPNG != "" || n.GL != nil {
				n.CanvasErr = ""
			}
		} else {
			n.CanvasPNG, n.GL, n.CanvasErr = "", nil, ""
		}
		var attrs []string
		for i := 0; i+1 < len(n.Attrs); i += 2 {
			if !strings.HasPrefix(strings.ToLower(n.Attrs[i]), "on") {
				attrs = append(attrs, n.Attrs[i], n.Attrs[i+1])
			}
		}
		n.Attrs = attrs
		n.Value = ""
		n.SS, n.CSS = 0, nil
		// Its shadow root, cleaned as the rest: only one, a fragment.
		if n.Shadow != nil {
			if n.Shadow.Type == 11 {
				n.Shadow = goClean(n.Shadow)
			} else {
				n.Shadow = nil
			}
		}
	case 3:
		n.Name, n.Attrs, n.Kids, n.Shadow, n.SS, n.CSS = "", nil, nil, nil, 0, nil
		n.Base = ""
		return n
	case 9, 11:
		n.Name, n.Value, n.Attrs, n.Shadow = "", "", nil, nil
		if n.Type == 9 {
			n.CSS, n.SS = goCleanCSS(n.CSS), 0
		} else {
			n.CSS = nil
			if n.SS < 0 {
				n.SS = 0
			}
		}
		// An embedded page's base, which its addresses resolve against:
		// an http(s) one, or none.
		if u, err := goURL(n.Base); n.Type != 9 || err != nil {
			n.Base = ""
		} else {
			n.Base = u
		}
	default:
		return nil
	}
	kids := n.Kids[:0]
	for _, k := range n.Kids {
		if c := goClean(k); c != nil {
			kids = append(kids, c)
		}
	}
	n.Kids = kids
	return n
}

// goCleanCSS is adopted stylesheets' texts as they're sent on, by number:
// numbers only, as much text as a snapshot may hold.
func goCleanCSS(css map[string]string) map[string]string {
	if len(css) == 0 {
		return nil
	}
	out := map[string]string{}
	total := 0
	for k, v := range css {
		n, err := strconv.Atoi(k)
		if err != nil || n < 1 || strconv.Itoa(n) != k || total+len(v) > goSnapshotLimit {
			continue
		}
		total += len(v)
		out[k] = v
	}
	return out
}

// goTitleOf is the title a snapshot gives, made one line.
func goTitleOf(title string) string { return strings.Join(strings.Fields(title), " ") }

// goOwnerFile names, in an engine's run directory, the tabtopd it's for.
const goOwnerFile = "owner"

// sweepGoRunDirs removes run directories (tabtop-go-*) left by a tabtopd
// that's gone: killed, say, before it could remove them. Those of a
// tabtopd still running, this one included, are left alone.
func sweepGoRunDirs() {
	dirs, _ := filepath.Glob(filepath.Join(os.TempDir(), "tabtop-go-*"))
	for _, dir := range dirs {
		b, err := os.ReadFile(filepath.Join(dir, goOwnerFile))
		if err != nil {
			// Without an owner: one being made, unless it's old.
			if fi, err := os.Stat(dir); err != nil || time.Since(fi.ModTime()) < time.Hour {
				continue
			}
		} else if pid, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil {
			if err := syscall.Kill(pid, 0); pid == os.Getpid() || err == nil || errors.Is(err, syscall.EPERM) {
				continue
			}
		}
		os.RemoveAll(dir)
	}
}
