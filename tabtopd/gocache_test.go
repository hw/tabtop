package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// The shared cache is kept within its size: the entries used longest ago
// go first; links an engine might put there are removed, not followed.
func TestGoPruneCache(t *testing.T) {
	dir := t.TempDir()
	outside := filepath.Join(t.TempDir(), "keep")
	os.WriteFile(outside, []byte("not the cache's"), 0o600)
	now := time.Now()
	for i, name := range []string{"a.entry", "b.entry", "c.entry", "d.entry"} {
		os.Mkdir(filepath.Join(dir, name), 0o700)
		body := filepath.Join(dir, name, "body.bin")
		os.WriteFile(body, make([]byte, 100<<10), 0o600)
		at := now.Add(time.Duration(i-10) * time.Minute) // a oldest, d newest
		os.Chtimes(body, at, at)
		os.Chtimes(filepath.Join(dir, name), at, at)
	}
	os.Symlink(outside, filepath.Join(dir, "link.entry"))
	goPruneCache(dir, 250<<10)
	for name, want := range map[string]bool{"a.entry": false, "b.entry": false, "c.entry": true, "d.entry": true} {
		if _, err := os.Stat(filepath.Join(dir, name)); (err == nil) != want {
			t.Errorf("%s kept: %v, want %v", name, err == nil, want)
		}
	}
	if _, err := os.Stat(outside); err != nil {
		t.Errorf("the link's target went: %v", err)
	}
}

// TestGoCacheWithMoli has two engines, one after the other, share the
// cache: what the first fetched, the second has on disk and doesn't ask
// for again. Set TABTOP_TEST_MOLI to a Moli binary to run it.
func TestGoCacheWithMoli(t *testing.T) {
	moli := os.Getenv("TABTOP_TEST_MOLI")
	if moli == "" {
		t.Skip("TABTOP_TEST_MOLI isn't set to a Moli binary")
	}
	var scripts, sheets atomic.Int32
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/app.js":
			scripts.Add(1)
			w.Header().Set("Content-Type", "text/javascript")
			w.Header().Set("Cache-Control", "public, max-age=3600")
			io.WriteString(w, `document.getElementById("p").textContent = "scripted";`)
		case "/app.css":
			sheets.Add(1)
			w.Header().Set("Content-Type", "text/css")
			w.Header().Set("Cache-Control", "public, max-age=3600")
			io.WriteString(w, `p { color: teal }`)
		default:
			w.Header().Set("Content-Type", "text/html")
			io.WriteString(w, `<!doctype html><title>Cached</title><link rel=stylesheet href=/app.css><p id=p>static</p><script src=/app.js></script>`)
		}
	}))
	defer site.Close()
	goTestPorts(t, portOf(t, site.URL))
	only127 := func(a netip.Addr) bool { return a.Unmap() == netip.MustParseAddr("127.0.0.1") }
	bwrap, _ := exec.LookPath("bwrap")
	mode, _ := goSandboxProbe(bwrap, true) // sandboxed where it can be
	cache := t.TempDir()
	load := func() string {
		e, err := startGoEngine(goEngineConfig{engine: moli, mode: mode, bwrap: bwrap, allow: only127, cache: cache, logf: t.Logf})
		if err != nil {
			t.Fatal(err)
		}
		defer e.kill("test over")
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		c, err := dialCDP(ctx, e)
		if err != nil {
			t.Fatal(err)
		}
		defer c.close()
		session, err := c.newPage(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if err := c.call(ctx, session, "Page.navigate", map[string]any{"url": site.URL + "/page"}, nil); err != nil {
			t.Fatal(err)
		}
		var got string
		for i := 0; i < 100 && got != "scripted"; i++ {
			var r struct {
				Result struct {
					Value string `json:"value"`
				} `json:"result"`
			}
			if c.call(ctx, session, "Runtime.evaluate", map[string]any{"expression": `(document.getElementById("p") || {}).textContent`, "returnByValue": true}, &r) == nil {
				got = r.Result.Value
			}
			time.Sleep(50 * time.Millisecond)
		}
		return got
	}
	t.Logf("engine mode: %s", mode)
	if got := load(); got != "scripted" {
		t.Fatalf("first engine: the page reads %q", got)
	}
	if got := load(); got != "scripted" {
		t.Fatalf("second engine: the page reads %q", got)
	}
	if s, c := scripts.Load(), sheets.Load(); s != 1 || c != 1 {
		t.Errorf("the script fetched %d times, the stylesheet %d: not from the shared cache the second time", s, c)
	}
	entries, _ := os.ReadDir(cache)
	if len(entries) == 0 || !strings.HasSuffix(entries[0].Name(), ".entry") {
		t.Errorf("not Moli's cache: %v", entries)
	}
}
