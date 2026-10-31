package main

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newTTYTestServer(t *testing.T) (*server, *httptest.Server) {
	t.Helper()
	dir := t.TempDir()
	for _, name := range ttyAssets {
		os.WriteFile(filepath.Join(dir, name), []byte("export {}"), 0o644)
	}
	g := &server{base: "/", sessions: map[string]*session{}, failures: map[string][]time.Time{},
		pending: map[string]int{}, ttys: map[string]int{}, termDir: dir}
	srv := httptest.NewServer(http.HandlerFunc(g.tty))
	t.Cleanup(srv.Close)
	return g, srv
}

func get(t *testing.T, url string) *http.Response {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp
}

func TestTTYOff(t *testing.T) {
	g, srv := newTTYTestServer(t)
	g.termDir = ""
	if resp := get(t, srv.URL+"/tty/"); resp.StatusCode != http.StatusNotFound {
		t.Errorf("status %d, want 404", resp.StatusCode)
	}
}

func TestTTYPage(t *testing.T) {
	g, srv := newTTYTestServer(t)
	resp := get(t, srv.URL+"/tty/")
	// ghostty-web fetches and compiles its WebAssembly from a data: URL.
	csp := resp.Header.Get("Content-Security-Policy")
	if resp.StatusCode != http.StatusOK || !strings.Contains(csp, "default-src 'self'") ||
		!strings.Contains(csp, "'wasm-unsafe-eval'") || !strings.Contains(csp, "connect-src 'self' data:") {
		t.Errorf("page: status %d, CSP %q", resp.StatusCode, csp)
	}
	tag := g.ttyPath()
	for p, want := range map[string]int{"/tty/tty.js": 200, "/tty/" + tag + "/ghostty-web.js": 200,
		"/tty/" + tag + "/" + ghosttyStub: 200, "/tty/" + tag + "/PowerlineSymbols.otf": 200,
		"/tty/ghostty-web.js": 404, "/tty/ghostty-0123456789ab/ghostty-web.js": 404, "/tty/" + tag + "/tty.js": 404,
		"/tty/xterm.mjs": 404, "/tty/../main.go": 404, "/tty/other": 404, "/tty/ws": 404} {
		if resp := get(t, srv.URL+p); resp.StatusCode != want {
			t.Errorf("%s: status %d, want %d", p, resp.StatusCode, want)
		}
	}
	// The page and its script are sent afresh, pointing at the cached files.
	for p, want := range map[string]string{"/tty/": `url("` + tag + `/PowerlineSymbols.otf")`, "/tty/tty.js": `"./` + tag + `/ghostty-web.js"`} {
		resp, err := http.Get(srv.URL + p)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if !strings.Contains(string(body), want) || !strings.Contains(resp.Header.Get("Cache-Control"), "no-store") {
			t.Errorf("%s: Cache-Control %q, without %s", p, resp.Header.Get("Cache-Control"), want)
		}
	}
	resp = get(t, srv.URL+"/tty/"+tag+"/PowerlineSymbols.otf")
	if resp.Header.Get("Content-Type") != "font/otf" || !strings.Contains(resp.Header.Get("Cache-Control"), "immutable") {
		t.Errorf("font: Content-Type %q, Cache-Control %q", resp.Header.Get("Content-Type"), resp.Header.Get("Cache-Control"))
	}
}

func TestTTYLimit(t *testing.T) {
	g, _ := newTTYTestServer(t)
	for i := range maxTTYs {
		if !g.openTTY("a") {
			t.Fatalf("terminal %d refused", i+1)
		}
	}
	if g.openTTY("a") {
		t.Error("terminal over the limit allowed")
	}
	if !g.openTTY("b") {
		t.Error("another session's terminal refused")
	}
	g.closeTTY("a")
	if !g.openTTY("a") {
		t.Error("terminal refused after one closed")
	}
}

// TestTTYAssetsMissing checks that the terminal's files aren't cached
// while one is missing, are once it's back, and that a path keeps giving
// the bytes it was named after.
func TestTTYAssetsMissing(t *testing.T) {
	g, srv := newTTYTestServer(t)
	font := filepath.Join(g.termDir, "PowerlineSymbols.otf")
	os.Remove(font)
	if p := g.ttyPath(); p != "ghostty-missing" {
		t.Fatalf("path with a file missing: %q", p)
	}
	resp := get(t, srv.URL+"/tty/ghostty-missing/ghostty-web.js")
	if resp.StatusCode != http.StatusNotFound || strings.Contains(resp.Header.Get("Cache-Control"), "immutable") {
		t.Errorf("with a file missing: status %d, Cache-Control %q", resp.StatusCode, resp.Header.Get("Cache-Control"))
	}

	os.WriteFile(font, []byte("font"), 0o644)
	if p := g.ttyPath(); p != "ghostty-missing" {
		t.Fatalf("tried again before assetRetry: %q", p)
	}
	g.ttyFiles.failed = time.Time{} // as if assetRetry had passed
	tag := g.ttyPath()
	os.WriteFile(font, []byte("changed"), 0o644)
	r, err := http.Get(srv.URL + "/tty/" + tag + "/PowerlineSymbols.otf")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(r.Body)
	r.Body.Close()
	if string(body) != "font" || g.ttyPath() != tag {
		t.Errorf("after the file changed: %q at %s, now %s", body, tag, g.ttyPath())
	}
}

func TestTTYAssetsGzip(t *testing.T) {
	g, srv := newTTYTestServer(t)
	js := strings.Repeat("export const x = 1;\n", 1000)
	os.WriteFile(filepath.Join(g.termDir, "ghostty-web.js"), []byte(js), 0o644)
	url := srv.URL + "/tty/" + g.ttyPath() + "/ghostty-web.js"
	for _, tc := range []struct {
		accept string
		gzip   bool
	}{{"gzip, deflate, br", true}, {"br;q=1, gzip;q=0.5", true}, {"gzip;q=0", false}, {"", false},
		{"identity;q=0, *;q=1", true}, {"*", true}, {"*;q=0", false}, {"gzip;q=0, *", false}, {"*, gzip;q=0", false}} {
		req, _ := http.NewRequest("GET", url, nil)
		if tc.accept != "" {
			req.Header.Set("Accept-Encoding", tc.accept)
		}
		resp, err := http.DefaultTransport.RoundTrip(req) // no transparent decompression
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		gz := resp.Header.Get("Content-Encoding") == "gzip"
		if gz != tc.gzip || resp.Header.Get("Vary") != "Accept-Encoding" ||
			!strings.HasPrefix(resp.Header.Get("Content-Type"), "text/javascript") {
			t.Errorf("%q: gzip %v, headers %v", tc.accept, gz, resp.Header)
			continue
		}
		if gz {
			zr, err := gzip.NewReader(bytes.NewReader(body))
			if err != nil {
				t.Fatal(err)
			}
			body, _ = io.ReadAll(zr)
		}
		if string(body) != js {
			t.Errorf("%q: body differs", tc.accept)
		}
	}
}
