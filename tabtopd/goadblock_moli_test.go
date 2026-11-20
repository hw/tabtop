package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestGoAdMoliInterception holds Moli to what ad blocking by address
// relies on (goadblock.go): with every request paused (Fetch), a page's
// subresources come paused with their kinds, and one failed is never asked
// of its site, while one let go is. And Network.setBlockedURLs, the other
// way looked at (patterns the engine holds requests to itself, too plain
// for lists' rules), works too. Run with TABTOP_TEST_MOLI set to a Moli
// binary.
func TestGoAdMoliInterception(t *testing.T) {
	moli := os.Getenv("TABTOP_TEST_MOLI")
	if moli == "" {
		t.Skip("TABTOP_TEST_MOLI isn't set to a Moli binary")
	}
	var mu sync.Mutex
	asked := map[string]int{}
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		asked[r.URL.Path]++
		mu.Unlock()
		switch {
		case r.URL.Path == "/page":
			w.Header().Set("Content-Type", "text/html")
			io.WriteString(w, `<!doctype html><title>spike</title>
<img src="/urls-img.png"><img src="/fail-img.png"><img src="/ok-img.png">
<script src="/urls-script.js"></script><script src="/fail-script.js"></script>
<link rel="stylesheet" href="/fail-style.css">
<script>
window.done = (async () => {
  const out = [];
  for (const u of ["/urls-fetch", "/fail-fetch", "/ok-fetch"]) out.push(u + ":" + await fetch(u).then((r) => r.status, () => "failed"));
  out.push("xhr:" + await new Promise((ok) => { const x = new XMLHttpRequest(); x.open("GET", "/fail-xhr"); x.onload = () => ok(x.status); x.onerror = () => ok("failed"); x.send(); }));
  return out.join(" ");
})();
</script>`)
		case strings.HasSuffix(r.URL.Path, ".js"):
			w.Header().Set("Content-Type", "text/javascript")
			io.WriteString(w, "window.ran = (window.ran || []).concat("+strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/"), ".js")+"\"\");")
		default:
			io.WriteString(w, "x")
		}
	}))
	defer site.Close()
	goTestPorts(t, portOf(t, site.URL))
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	e, err := startGoEngine(goEngineConfig{engine: moli, mode: goUnsandboxed,
		allow: func(a netip.Addr) bool { return a.Unmap() == netip.MustParseAddr("127.0.0.1") }})
	if err != nil {
		t.Fatal(err)
	}
	defer e.kill("spike")
	c, err := dialCDP(ctx, e)
	if err != nil {
		t.Fatal(err)
	}
	defer c.close()
	page, _, err := c.newPageTarget(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range []string{"Page.enable", "Network.enable", "Runtime.enable"} {
		if err := c.call(ctx, page, m, nil, nil); err != nil {
			t.Fatal(err)
		}
	}
	// 1. The engine's own patterns.
	errBlocked := c.call(ctx, page, "Network.setBlockedURLs", map[string]any{"urls": []string{"*/urls-*"}}, nil)
	t.Logf("Network.setBlockedURLs: %v", errBlocked)
	// 2. Every request paused.
	errFetch := c.call(ctx, page, "Fetch.enable", map[string]any{"patterns": []map[string]string{{"urlPattern": "*", "requestStage": "Request"}}}, nil)
	t.Logf("Fetch.enable, every request: %v", errFetch)
	var types []string
	var failErr error
	go c.call(ctx, page, "Page.navigate", map[string]any{"url": site.URL + "/page"}, nil)
	deadline := time.After(8 * time.Second)
loop:
	for {
		select {
		case ev := <-c.Events:
			if ev.Method != "Fetch.requestPaused" {
				continue
			}
			var p struct {
				ID      string `json:"requestId"`
				Type    string `json:"resourceType"`
				Request struct {
					URL string `json:"url"`
				} `json:"request"`
			}
			json.Unmarshal(ev.Params, &p)
			path := p.Request.URL[strings.LastIndex(p.Request.URL, "/"):]
			types = append(types, path+"="+p.Type)
			if strings.HasPrefix(path, "/fail-") {
				if err := c.call(ctx, page, "Fetch.failRequest", map[string]any{"requestId": p.ID, "errorReason": "BlockedByClient"}, nil); err != nil {
					failErr = err
				}
			} else {
				c.call(ctx, page, "Fetch.continueRequest", map[string]any{"requestId": p.ID}, nil)
			}
		case <-deadline:
			break loop
		}
	}
	var r struct {
		Result struct {
			Value string
		}
	}
	c.call(ctx, page, "Runtime.evaluate", map[string]any{"expression": "window.done", "awaitPromise": true, "returnByValue": true}, &r)
	var ran struct {
		Result struct {
			Value []string
		}
	}
	c.call(ctx, page, "Runtime.evaluate", map[string]any{"expression": "window.ran || []", "returnByValue": true}, &ran)
	mu.Lock()
	var paths []string
	for p := range asked {
		paths = append(paths, p)
	}
	mu.Unlock()
	slices.Sort(paths)
	t.Logf("paused, by type: %v; the site was asked for %v; the page saw %s", types, paths, r.Result.Value)
	if errBlocked != nil || errFetch != nil || failErr != nil {
		t.Fatalf("setBlockedURLs %v, Fetch.enable %v, failRequest %v", errBlocked, errFetch, failErr)
	}
	for _, want := range []string{"/fail-script.js=Script", "/fail-style.css=Stylesheet", "/fail-fetch=XHR", "/fail-xhr=XHR"} {
		if !slices.Contains(types, want) {
			t.Errorf("not paused as %s", want)
		}
	}
	for _, p := range paths {
		if strings.HasPrefix(p, "/fail-") || strings.HasPrefix(p, "/urls-") {
			t.Errorf("%s was asked of the site", p)
		}
	}
	if !slices.Contains(paths, "/ok-fetch") || !strings.Contains(r.Result.Value, "/ok-fetch:200") || !strings.Contains(r.Result.Value, "/fail-fetch:failed") {
		t.Errorf("the page saw %q", r.Result.Value)
	}
}
