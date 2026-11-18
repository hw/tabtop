package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// newGoServer is an e2e server with the remote browser on, its engine the
// fake one (or engine, if not "").
func newGoServer(t *testing.T, engine string) (*server, string, testSession) {
	t.Helper()
	g, srv := newE2EServer(t)
	g.goOn, g.goMode = true, goUnsandboxed
	g.goConfig = fakeEngineConfig(t, goUnsandboxed, "ok")
	if engine != "" {
		bwrap, _ := exec.LookPath("bwrap")
		mode, _ := goSandboxProbe(bwrap, true)
		only127 := func(a netip.Addr) bool { return a.Unmap() == netip.MustParseAddr("127.0.0.1") }
		g.goMode = mode
		g.goConfig = goEngineConfig{engine: engine, mode: mode, bwrap: bwrap, allow: only127, logf: t.Logf}
	}
	return g, srv.URL, login(t, testCtx(t), srv.URL, code(0))
}

// sendGo sends the page's message m on the go tunnel.
func sendGo(t *testing.T, ctx context.Context, tc *tunnelClient, m map[string]any) {
	t.Helper()
	b, _ := json.Marshal(m)
	if err := tc.write(ctx, msgText, b); err != nil {
		t.Fatal(err)
	}
}

// goEngineRunDirs are the run directories of this process's engines.
func goEngineRunDirs(t *testing.T) []string {
	dirs, _ := filepath.Glob(filepath.Join(os.TempDir(), "tabtop-go-*"))
	var mine []string
	for _, d := range dirs {
		if b, err := os.ReadFile(filepath.Join(d, goOwnerFile)); err == nil && string(b) == strconv.Itoa(os.Getpid()) {
			mine = append(mine, d)
		}
	}
	return mine
}

func TestGoRouteOffAndUnavailable(t *testing.T) {
	g, url, s := newGoServer(t, "")
	ctx := testCtx(t)
	g.goOn = false
	if r := openSession(t, ctx, url, s).request(t, ctx, map[string]any{"type": "go"}); !strings.Contains(r["error"].(string), "WEB_GO=0") {
		t.Errorf("off: %v", r)
	}
	g.goOn, g.goMode, g.goWhy = true, goUnavailable, "bubblewrap can't make its sandbox here"
	if r := openSession(t, ctx, url, s).request(t, ctx, map[string]any{"type": "go"}); !strings.Contains(r["error"].(string), "bubblewrap") {
		t.Errorf("unavailable: %v", r)
	}
}

func TestGoRouteBrowses(t *testing.T) {
	g, url, s := newGoServer(t, "")
	ctx := testCtx(t)
	tc := openSession(t, ctx, url, s)
	if r := tc.request(t, ctx, map[string]any{"type": "go"}); r["ok"] != true || r["sandboxed"] != false {
		t.Fatalf("opening: %v", r)
	}
	expect := func(typ string, gen int) map[string]any {
		t.Helper()
		m := tc.readJSON(t, ctx)
		if m["type"] != typ || m["gen"] != float64(gen) {
			t.Fatalf("got %v, want %s for generation %d", m, typ, gen)
		}
		return m
	}

	sendGo(t, ctx, tc, map[string]any{"op": "navigate", "url": "javascript:alert(1)"})
	if m := expect("go-error", 1); !strings.Contains(m["message"].(string), "http://") {
		t.Errorf("javascript: URL: %v", m)
	}
	sendGo(t, ctx, tc, map[string]any{"op": "navigate", "url": "https://user:pw@example.test/"})
	expect("go-error", 2)

	sendGo(t, ctx, tc, map[string]any{"op": "navigate", "url": " https://example.test/page "})
	if m := expect("go-loading", 3); m["url"] != "https://example.test/page" {
		t.Errorf("loading %v", m["url"])
	}
	snap := expect("go-snapshot", 3)
	if snap["url"] != "https://example.test/page" || snap["title"] != "Fake page" {
		t.Errorf("snapshot of %v titled %q", snap["url"], snap["title"])
	}
	doc, _ := json.Marshal(snap["doc"])
	for _, banned := range []string{"steal()", "secret comment", "no scripts", `"script"`, `"noscript"`, "onload", "OnClick"} {
		if strings.Contains(string(doc), banned) {
			t.Errorf("the snapshot has %s: %s", banned, doc)
		}
	}
	for _, kept := range []string{`"n":"p"`, `"v":"hello"`, `"href","/next"`, `"class","main"`} {
		if !strings.Contains(string(doc), kept) {
			t.Errorf("the snapshot lacks %s: %s", kept, doc)
		}
	}

	// Within the document: no load follows, the snapshot comes at once.
	sendGo(t, ctx, tc, map[string]any{"op": "navigate", "url": "https://example.test/page#part"})
	expect("go-loading", 4)
	expect("go-snapshot", 4)

	sendGo(t, ctx, tc, map[string]any{"op": "navigate", "url": "https://unreachable.test/"})
	expect("go-loading", 5)
	if m := expect("go-error", 5); !strings.Contains(m["message"].(string), "can't be reached") {
		t.Errorf("unreachable: %v", m)
	}

	if dirs := goEngineRunDirs(t); len(dirs) != 1 {
		t.Errorf("%d engines running, want 1", len(dirs))
	}
	// Closing the tab kills its engine.
	tc.c.CloseNow()
	waitFor(t, "the engine to be killed", func() bool { return len(goEngineRunDirs(t)) == 0 })
	waitFor(t, "the engine to be uncounted", func() bool {
		g.mu.Lock()
		defer g.mu.Unlock()
		return len(g.goEngines) == 0
	})
}

func TestGoRouteLimitsEngines(t *testing.T) {
	_, url, s := newGoServer(t, "")
	ctx := testCtx(t)
	for i := 0; i < maxGoPerSession; i++ {
		tc := openSession(t, ctx, url, s)
		if r := tc.request(t, ctx, map[string]any{"type": "go"}); r["ok"] != true {
			t.Fatalf("tab %d: %v", i+1, r)
		}
		defer tc.c.CloseNow()
	}
	r := openSession(t, ctx, url, s).request(t, ctx, map[string]any{"type": "go"})
	if !strings.Contains(r["error"].(string), "Too many") {
		t.Errorf("one tab too many: %v", r)
	}
}

func TestGoRouteEndsWithSession(t *testing.T) {
	_, url, s := newGoServer(t, "")
	ctx := testCtx(t)
	tc := openSession(t, ctx, url, s)
	if r := tc.request(t, ctx, map[string]any{"type": "go"}); r["ok"] != true {
		t.Fatal(r)
	}
	if r := openSession(t, ctx, url, s).request(t, ctx, map[string]any{"type": "logout"}); r["ok"] != true {
		t.Fatalf("logout: %v", r)
	}
	waitFor(t, "logging out to kill the engine", func() bool { return len(goEngineRunDirs(t)) == 0 })
}

func TestSweepGoRunDirs(t *testing.T) {
	// A process that's gone: one that's been waited for.
	cmd := exec.Command("true")
	cmd.Run()
	gone := cmd.Process.Pid
	make := func(owner string) string {
		dir, err := os.MkdirTemp("", "tabtop-go-")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { os.RemoveAll(dir) })
		if owner != "" {
			os.WriteFile(filepath.Join(dir, goOwnerFile), []byte(owner), 0o600)
		}
		return dir
	}
	left, ours, fresh := make(strconv.Itoa(gone)), make(strconv.Itoa(os.Getpid())), make("")
	sweepGoRunDirs()
	if _, err := os.Stat(left); !os.IsNotExist(err) {
		t.Error("a gone tabtopd's run directory was kept")
	}
	for _, d := range []string{ours, fresh} {
		if _, err := os.Stat(d); err != nil {
			t.Errorf("%s was removed", d)
		}
	}
}

func TestGoURL(t *testing.T) {
	for raw, ok := range map[string]bool{
		"https://example.com/a?b#c": true, "http://example.com": true, " https://example.com ": true,
		"javascript:alert(1)": false, "file:///etc/passwd": false, "data:text/html,x": false, "about:blank": false,
		"https://": false, "example.com": false, "https://u:p@example.com/": false, "ftp://example.com/": false,
		"https://example.com/" + strings.Repeat("a", maxGoURL): false,
	} {
		if _, err := goURL(raw); (err == nil) != ok {
			t.Errorf("%q: %v", raw, err)
		}
	}
}

// waitFor waits up to 10 seconds for cond.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		if cond() {
			return
		}
	}
	t.Fatalf("timed out waiting for %s", what)
}

// TestGoRouteWithMoli browses a page through the route with the real
// engine. Set TABTOP_TEST_MOLI to a Moli binary to run it.
func TestGoRouteWithMoli(t *testing.T) {
	moli := os.Getenv("TABTOP_TEST_MOLI")
	if moli == "" {
		t.Skip("TABTOP_TEST_MOLI isn't set to a Moli binary")
	}
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		io.WriteString(w, `<!doctype html><title>Moli page</title><base href="/sub/"><p id=p onclick="x()">static</p><img src="pic.png"><script>document.getElementById("p").textContent = "scripted";</script>`)
	}))
	defer site.Close()
	goTestPorts(t, portOf(t, site.URL))
	g, url, s := newGoServer(t, moli)
	t.Logf("engine mode: %s", g.goMode)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tc := openSession(t, ctx, url, s)
	if r := tc.request(t, ctx, map[string]any{"type": "go"}); r["ok"] != true {
		t.Fatal(r)
	}
	sendGo(t, ctx, tc, map[string]any{"op": "navigate", "url": site.URL + "/page"})
	if m := tc.readJSON(t, ctx); m["type"] != "go-loading" {
		t.Fatalf("got %v", m)
	}
	snap := tc.readJSON(t, ctx)
	doc, _ := json.Marshal(snap["doc"])
	t.Logf("%s %q base %v, %d bytes", snap["type"], snap["title"], snap["base"], len(doc))
	if snap["type"] != "go-snapshot" || snap["title"] != "Moli page" || snap["base"] != site.URL+"/sub/" {
		t.Errorf("snapshot: %v %v %v", snap["type"], snap["title"], snap["base"])
	}
	if !strings.Contains(string(doc), `"v":"scripted"`) || strings.Contains(string(doc), "onclick") || strings.Contains(string(doc), "getElementById") {
		t.Errorf("document: %s", doc)
	}
	sendGo(t, ctx, tc, map[string]any{"op": "navigate", "url": "http://[::1]:9/"})
	tc.readJSON(t, ctx)
	if m := tc.readJSON(t, ctx); m["type"] != "go-error" {
		t.Errorf("a refused address: %v", m)
	}
	tc.c.CloseNow()
	waitFor(t, "the engine to be killed", func() bool { return len(goEngineRunDirs(t)) == 0 })
}
