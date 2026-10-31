package main

import (
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
	for _, name := range []string{"ghostty-web.js", ghosttyStub, "PowerlineSymbols.otf"} {
		os.WriteFile(filepath.Join(dir, name), []byte("export {}"), 0o644)
	}
	g := &server{base: "/", sessions: map[string]time.Time{}, failures: map[string][]time.Time{},
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
	_, srv := newTTYTestServer(t)
	resp := get(t, srv.URL+"/tty/")
	// ghostty-web fetches and compiles its WebAssembly from a data: URL.
	csp := resp.Header.Get("Content-Security-Policy")
	if resp.StatusCode != http.StatusOK || !strings.Contains(csp, "default-src 'self'") ||
		!strings.Contains(csp, "'wasm-unsafe-eval'") || !strings.Contains(csp, "connect-src 'self' data:") {
		t.Errorf("page: status %d, CSP %q", resp.StatusCode, csp)
	}
	for p, want := range map[string]int{"/tty/tty.js": 200, "/tty/ghostty-web.js": 200, "/tty/" + ghosttyStub: 200,
		"/tty/PowerlineSymbols.otf": 200, "/tty/xterm.mjs": 404, "/tty/../main.go": 404, "/tty/other": 404, "/tty/ws": 404} {
		if resp := get(t, srv.URL+p); resp.StatusCode != want {
			t.Errorf("%s: status %d, want %d", p, resp.StatusCode, want)
		}
	}
	if resp := get(t, srv.URL+"/tty/PowerlineSymbols.otf"); resp.Header.Get("Content-Type") != "font/otf" {
		t.Errorf("font Content-Type %q, want font/otf", resp.Header.Get("Content-Type"))
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
