package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGoPage(t *testing.T) {
	g, srv := newE2EServer(t)
	var get func(path string) (*http.Response, string)
	get = func(path string) (*http.Response, string) {
		t.Helper()
		client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		res, err := client.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(res.Body)
		res.Body.Close()
		return res, string(b)
	}

	// Off: nothing of it is served, and the bar has no link to it.
	for _, p := range []string{"/go/", "/go", "/go/go.js", "/tabtop/go-frame.html"} {
		if res, _ := get(p); res.StatusCode != http.StatusNotFound {
			t.Errorf("off: %s is %d", p, res.StatusCode)
		}
	}
	if _, nav := get("/tabtop/nav.js"); !strings.Contains(nav, `"go":false`) {
		t.Error("off: the bar links to the remote browser")
	}

	// On, as set at start (the routes are made then).
	g.goOn = true
	srv = httptest.NewServer(g.handler())
	defer srv.Close()
	// The tabs' page, and a tab: framed by the site only.
	res, tabsPage := get("/go/")
	if res.StatusCode != 200 || res.Header.Get("Content-Security-Policy") != goTabsCSP || !strings.Contains(tabsPage, `src="go-tabs.js"`) {
		t.Errorf("the tabs' page: %d %q", res.StatusCode, res.Header.Get("Content-Security-Policy"))
	}
	res, page := get("/go/tab")
	if res.StatusCode != 200 || res.Header.Get("Content-Security-Policy") != goPageCSP || !strings.Contains(page, `src="go.js"`) {
		t.Errorf("a tab: %d %q", res.StatusCode, res.Header.Get("Content-Security-Policy"))
	}
	if !strings.Contains(goPageCSP, "frame-ancestors 'self'") || !strings.Contains(goTabsCSP, "frame-ancestors 'none'") {
		t.Error("a tab must be framed by the site alone, the tabs' page by none")
	}
	if res, _ := get("/go"); res.StatusCode != http.StatusMovedPermanently || res.Header.Get("Location") != "/go/" {
		t.Errorf("/go: %d to %q", res.StatusCode, res.Header.Get("Location"))
	}
	res, js := get("/go/go.js")
	if res.StatusCode != 200 || !strings.HasPrefix(res.Header.Get("Content-Type"), "text/javascript") {
		t.Errorf("go.js: %d %s", res.StatusCode, res.Header.Get("Content-Type"))
	}
	// The sandbox the page gives the frame is exactly the frame's own.
	if !strings.Contains(js, `frame.setAttribute("sandbox", "`+goFrameSandbox+`")`) {
		t.Error("go.js doesn't sandbox the frame as goFrameSandbox says")
	}
	if !strings.HasSuffix(goFrameCSP, "sandbox "+goFrameSandbox) {
		t.Error("the frame's CSP sandbox differs from the page's")
	}
	res, frame := get("/tabtop/go-frame.html")
	if res.StatusCode != 200 || res.Header.Get("Content-Security-Policy") != goFrameCSP || frame != goFrameHTML {
		t.Errorf("the frame: %d %q", res.StatusCode, res.Header.Get("Content-Security-Policy"))
	}
	if _, nav := get("/tabtop/nav.js"); !strings.Contains(nav, `"go":true`) {
		t.Error("on: the bar has no link to the remote browser")
	}
	if res, _ := get("/tabtop/go-frame.js"); res.StatusCode != 200 {
		t.Errorf("go-frame.js: %d", res.StatusCode)
	}
	// Its cookies, at go/cookie: in Site controls now, gone to.
	if res, _ := get("/go/cookie"); res.StatusCode != http.StatusFound || res.Header.Get("Location") != "sites#cookies" {
		t.Errorf("go/cookie: %d to %q", res.StatusCode, res.Header.Get("Location"))
	}
	if res, _ := get("/go/go-cookies.js"); res.StatusCode != 200 || !strings.HasPrefix(res.Header.Get("Content-Type"), "text/javascript") {
		t.Errorf("go-cookies.js: %d", res.StatusCode)
	}
	// Site controls, with each site's cookies, at go/sites; Settings, for
	// every site, at go/settings; one stylesheet and helpers for both.
	if res, sites := get("/go/sites"); res.StatusCode != 200 || res.Header.Get("Content-Security-Policy") != goCookiesCSP || !strings.Contains(sites, `src="go-sites.js"`) {
		t.Errorf("Site controls: %d", res.StatusCode)
	}
	if res, settings := get("/go/settings"); res.StatusCode != 200 || res.Header.Get("Content-Security-Policy") != goCookiesCSP || !strings.Contains(settings, `src="go-settings.js"`) {
		t.Errorf("Settings: %d", res.StatusCode)
	}
	for _, f := range []string{"go-sites.js", "go-settings.js", "go-settings-parse.js", "go-pages.js"} {
		if res, _ := get("/go/" + f); res.StatusCode != 200 || !strings.HasPrefix(res.Header.Get("Content-Type"), "text/javascript") {
			t.Errorf("%s: %d", f, res.StatusCode)
		}
	}
	if res, _ := get("/go/go-pages.css"); res.StatusCode != 200 || !strings.HasPrefix(res.Header.Get("Content-Type"), "text/css") {
		t.Errorf("go-pages.css: %d", res.StatusCode)
	}
	// A site's settings, at the address they had: Site controls.
	if res, _ := get("/go/settings?site=example.com"); res.StatusCode != http.StatusFound || res.Header.Get("Location") != "sites?site=example.com" {
		t.Errorf("go/settings?site=: %d to %q", res.StatusCode, res.Header.Get("Location"))
	}
}

// TestGoFrameCSP holds the frame's policy to what keeps a page in: no
// network origin anywhere, no connections, frames, objects, workers, forms
// or base, scripts from the site alone, and the sandbox with scripts only.
func TestGoFrameCSP(t *testing.T) {
	directives := map[string]string{}
	for _, d := range strings.Split(goFrameCSP, ";") {
		name, value, _ := strings.Cut(strings.TrimSpace(d), " ")
		directives[name] = value
	}
	want := map[string]string{
		"default-src": "'none'", "script-src": "'self'", "style-src": "'unsafe-inline'",
		"img-src": "blob: data:", "font-src": "blob: data:", "media-src": "'none'", "connect-src": "'none'",
		"frame-src": "'none'", "child-src": "'none'", "worker-src": "'none'", "object-src": "'none'",
		"manifest-src": "'none'", "base-uri": "'none'", "form-action": "'none'", "frame-ancestors": "'self'",
		"sandbox": "allow-scripts",
	}
	for name, value := range want {
		if directives[name] != value {
			t.Errorf("%s is %q, want %q", name, directives[name], value)
		}
	}
	if len(directives) != len(want) {
		t.Errorf("unexpected directives: %v", directives)
	}
	for _, web := range []string{"http:", "https:", "*", "ws:", "wss:"} {
		if strings.Contains(goFrameCSP, web) {
			t.Errorf("the frame may load from %s", web)
		}
	}
}
