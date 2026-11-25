package main

// The remote browser's pages (see docs/browser-plan.md, section 5): the
// page at go/ (go.html, go.js), the trusted one, which holds the session
// and the tunnel; and the frame it shows pages in, served under /tabtop/ as
// go-frame.html (go-frame.js), sandboxed and kept from the web by its CSP.
import (
	"embed"
	"net/http"
	"strings"
)

const goPrefix = "/go/"

//go:embed go.html go.js go-device.js go-media.js go-eme.js mse-capture.js mse-stages.js go-cookies.js go-tabs.html go-tabs.js go-sites.html go-sites.js go-settings.html go-settings.js go-settings-parse.js go-pages.js go-pages.css
var goFiles embed.FS

const (
	// goPageCSP is the /go page's: everything from the site, the tunnel's
	// WebSocket to it, and frames only from it (go-frame.html); its media
	// players' parts from the streaming service worker (go-media.js), at
	// the page's own origin.
	goPageCSP = "default-src 'none'; script-src 'self'; connect-src 'self' data:; style-src 'unsafe-inline'; " +
		"img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"

	// goTabsCSP is the tabs' page's, at go/: each tab a frame of the site's
	// (go/tab), the login's tunnel, nothing else.
	goTabsCSP = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; " +
		"frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

	// goCookiesCSP is the browser's own pages', Site controls (with each
	// site's cookies) and Settings: their scripts and stylesheet, the
	// tunnel to the site, nothing else; shown in a frame of the site's own
	// only (the browser's lightbox, go.js), never another site's. Its
	// pictures: its own, and the site's icon (blob:, handed it by go.js).
	goCookiesCSP = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
		"base-uri 'none'; form-action 'none'; frame-ancestors 'self'"

	// goFrameCSP is the frame's: its own script and the CSS parser only,
	// the page's styles inline, and pictures and fonts only as blob: and
	// data: URLs, which the page hands it. No connections, frames,
	// objects, workers, forms or base. Its own sandbox too, with scripts
	// alone: opened as a page of its own, it's still at an origin of its
	// own, never the site's, and can't open popups or navigate the page
	// above it.
	goFrameCSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src blob: data:; font-src blob: data:; " +
		"media-src 'none'; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; " +
		"manifest-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts allow-pointer-lock"

	// goFrameSandbox is the sandbox the /go page gives the frame (go.js);
	// a test holds the two together. (Its pointer locked for a page that
	// asks: gopointerlock.go. It runs none of the page's scripts.)
	goFrameSandbox = "allow-scripts allow-pointer-lock"
)

// goFrameHTML is the frame's page: the CSS parser, the WebGL it replays
// (gogl-surface.js) and its replay, then its agent.
const goFrameHTML = "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>Page</title>\n" +
	"<script src=\"third-party/css-tree.js\"></script><script src=\"gogl-surface.js\"></script><script src=\"go-frame-gl.js\"></script><script src=\"go-frame.js\"></script>\n"

// goPage serves the /go page and its script.
func (g *server) goPage(w http.ResponseWriter, r *http.Request) {
	if !g.goOn {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	h := w.Header()
	h.Set("Cache-Control", "no-store, no-transform")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	switch strings.TrimPrefix(r.URL.Path, goPrefix) {
	case "":
		// The tabs (go-tabs.js), each a frame of go/tab.
		setPageHeaders(h, goTabsCSP)
		h.Set("Content-Type", "text/html; charset=utf-8")
		page, _ := goFiles.ReadFile("go-tabs.html")
		w.Write(page)
	case "tab":
		// A tab: the page that holds a browsing context's tunnel (go.js),
		// in the tabs' page, or on its own.
		setPageHeaders(h, goPageCSP)
		h.Set("Content-Type", "text/html; charset=utf-8")
		page, _ := goFiles.ReadFile("go.html")
		w.Write(page)
	case "cookie":
		// Its cookies and site data: in Site controls, now. (Said as it
		// is, relative: http.Redirect would make it a path from the root,
		// without the base path a proxy serves TabTop under.)
		h.Set("Location", "sites#cookies")
		w.WriteHeader(http.StatusFound)
	case "settings", "sites":
		// A site's settings were at go/settings?site=, before Settings
		// had that address: they're Site controls now.
		page := strings.TrimPrefix(r.URL.Path, goPrefix)
		if page == "settings" && r.URL.Query().Has("site") {
			h.Set("Location", "sites?"+r.URL.RawQuery)
			w.WriteHeader(http.StatusFound)
			return
		}
		// Site controls: each site's settings (gosites.go) and the cookies
		// kept for it (gocookies.go), and the defaults for them all.
		// Settings: the browser's own, ad blocking (goadblock.go).
		// Their scripts, the tunnel, nothing else.
		setPageHeaders(h, goCookiesCSP)
		h.Set("Content-Type", "text/html; charset=utf-8")
		html, _ := goFiles.ReadFile("go-" + page + ".html")
		w.Write(html)
	case "go.js", "go-device.js", "go-media.js", "go-eme.js", "mse-capture.js", "mse-stages.js", "go-cookies.js", "go-tabs.js", "go-sites.js", "go-settings.js", "go-settings-parse.js", "go-pages.js":
		h.Set("Content-Type", "text/javascript; charset=utf-8")
		js, _ := goFiles.ReadFile(strings.TrimPrefix(r.URL.Path, goPrefix))
		w.Write(js)
	case "go-pages.css":
		h.Set("Content-Type", "text/css; charset=utf-8")
		css, _ := goFiles.ReadFile("go-pages.css")
		w.Write(css)
	default:
		http.NotFound(w, r)
	}
}

// goFrame serves the frame's page, with its CSP.
func goFrame(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	setPageHeaders(h, goFrameCSP)
	w.Write([]byte(goFrameHTML))
}
