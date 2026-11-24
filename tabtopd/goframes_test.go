package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

// TestGoFramesWithMoli has a page embed one from another origin, which the
// agent in the page's world can't read: it's read in a world of its own and
// sent as its iframe's content, then again as it changes, and as it goes
// to another page. Set TABTOP_TEST_MOLI to a Moli binary to run it.
func TestGoFramesWithMoli(t *testing.T) {
	moli := os.Getenv("TABTOP_TEST_MOLI")
	if moli == "" {
		t.Skip("TABTOP_TEST_MOLI isn't set to a Moli binary")
	}
	inner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		if r.URL.Path == "/next" {
			io.WriteString(w, `<!doctype html><p>next page</p>`)
			return
		}
		io.WriteString(w, `<!doctype html><p id=p>inner text</p><script>
setTimeout(() => { document.getElementById("p").textContent = "inner later"; }, 1500);
setTimeout(() => { location.href = "/next"; }, 4000);
</script>`)
	}))
	defer inner.Close()
	top := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		io.WriteString(w, `<!doctype html><title>top</title><p>outside</p><iframe id=f src="`+inner.URL+`/inner"></iframe>`)
	}))
	defer top.Close()
	goTestPorts(t, portOf(t, top.URL), portOf(t, inner.URL))
	g, url, s := newGoServer(t, moli)
	t.Logf("engine mode: %s", g.goMode)
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	tc := openSession(t, ctx, url, s)
	if r := tc.request(t, ctx, map[string]any{"type": "go"}); r["ok"] != true {
		t.Fatal(r)
	}
	sendGo(t, ctx, tc, map[string]any{"op": "navigate", "url": top.URL + "/page"})
	var iframe float64
	for iframe == 0 {
		m := tc.readJSON(t, ctx)
		if m["type"] != "go-snapshot" {
			continue
		}
		var find func(n map[string]any)
		find = func(n map[string]any) {
			if n["n"] == "iframe" {
				iframe, _ = n["i"].(float64)
			}
			for _, k := range n["c"].([]any) {
				find(k.(map[string]any))
			}
		}
		doc := m["doc"].(map[string]any)
		normal(doc)
		find(doc)
		if p, _ := json.Marshal(doc); strings.Contains(string(p), "inner text") {
			t.Fatal("another origin's page read by the page's own agent")
		}
	}
	for _, want := range []string{"inner text", "inner later", "next page"} {
		for {
			m := tc.readJSON(t, ctx)
			if m["type"] != "go-changes" {
				continue
			}
			ops, _ := m["ops"].([]any)
			found := false
			for _, o := range ops {
				op := o.(map[string]any)
				if op["o"] != "c" || op["i"] != iframe {
					continue
				}
				kids, _ := op["c"].([]any)
				if len(kids) != 1 || kids[0].(map[string]any)["t"] != float64(9) || !strings.HasPrefix(kids[0].(map[string]any)["b"].(string), inner.URL) {
					t.Fatalf("not the frame's document: %v", op)
				}
				p, _ := json.Marshal(kids)
				found = strings.Contains(string(p), want)
			}
			if found {
				t.Logf("the frame shows %q", want)
				break
			}
		}
	}
	tc.c.CloseNow()
}

// TestGoNestedFramesWithMoli exercises three cross-origin iframe levels:
// discovery, incremental rendering, and routed input into the innermost.
func TestGoNestedFramesWithMoli(t *testing.T) {
	moli := os.Getenv("TABTOP_TEST_MOLI")
	if moli == "" {
		t.Skip("TABTOP_TEST_MOLI isn't set to a Moli binary")
	}
	inner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		io.WriteString(w, `<!doctype html><button id=b onclick="document.getElementById('p').textContent='nested clicked'">click nested</button><p id=p>nested ready</p>`)
	}))
	defer inner.Close()
	mid := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		io.WriteString(w, `<!doctype html><title>mid</title><iframe id=nested src="`+inner.URL+`/inner"></iframe>`)
	}))
	defer mid.Close()
	outer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		io.WriteString(w, `<!doctype html><title>outer</title><iframe id=mid src="`+mid.URL+`/mid"></iframe>`)
	}))
	defer outer.Close()
	top := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		io.WriteString(w, `<!doctype html><title>top</title><iframe id=outer src="`+outer.URL+`/outer"></iframe>`)
	}))
	defer top.Close()
	goTestPorts(t, portOf(t, top.URL), portOf(t, outer.URL), portOf(t, mid.URL), portOf(t, inner.URL))
	g, url, s := newGoServer(t, moli)
	t.Logf("engine mode: %s", g.goMode)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tc := openSession(t, ctx, url, s)
	if r := tc.request(t, ctx, map[string]any{"type": "go"}); r["ok"] != true {
		t.Fatal(r)
	}
	sendGo(t, ctx, tc, map[string]any{"op": "navigate", "url": top.URL + "/page"})
	var gen, outerOwner float64
	for outerOwner == 0 {
		m := tc.readJSON(t, ctx)
		if m["type"] != "go-snapshot" {
			continue
		}
		gen, _ = m["gen"].(float64)
		doc := m["doc"].(map[string]any)
		normal(doc)
		var find func(map[string]any)
		find = func(n map[string]any) {
			if n["n"] == "iframe" {
				outerOwner, _ = n["i"].(float64)
			}
			for _, k := range n["c"].([]any) {
				find(k.(map[string]any))
			}
		}
		find(doc)
	}
	// Nested frame updates are addressed from the outermost iframe (i /
	// path). Wait until the outer copy has the mid and innermost frames
	// grafted, with the button in the deepest document.
	var midOwner, nestedOwner, outerWorld, midWorld, innerWorld, button float64
	for button == 0 {
		m := tc.readJSON(t, ctx)
		if m["type"] != "go-changes" {
			continue
		}
		for _, raw := range m["ops"].([]any) {
			op := raw.(map[string]any)
			if op["o"] != "c" || op["i"] != outerOwner {
				continue
			}
			kids, _ := op["c"].([]any)
			if len(kids) != 1 {
				continue
			}
			doc := kids[0].(map[string]any)
			normal(doc)
			if path, _ := op["path"].([]any); len(path) != 0 {
				// A deeper frame's own update: content is that document.
				continue
			}
			outerWorld, _ = op["f"].(float64)
			var frames []map[string]any
			var walk func(map[string]any)
			walk = func(n map[string]any) {
				if n["n"] == "iframe" && n["f"] != nil {
					frames = append(frames, n)
				}
				for _, k := range n["c"].([]any) {
					walk(k.(map[string]any))
				}
			}
			walk(doc)
			if len(frames) < 2 {
				continue
			}
			midOwner, _ = frames[0]["i"].(float64)
			midWorld, _ = frames[0]["f"].(float64)
			nestedOwner, _ = frames[1]["i"].(float64)
			innerWorld, _ = frames[1]["f"].(float64)
			if children, ok := frames[1]["c"].([]any); ok && len(children) != 0 {
				var findButton func(map[string]any)
				findButton = func(node map[string]any) {
					if node["n"] == "button" {
						button, _ = node["i"].(float64)
					}
					for _, k := range node["c"].([]any) {
						findButton(k.(map[string]any))
					}
				}
				findButton(children[0].(map[string]any))
			}
		}
	}
	if outerWorld == 0 || midWorld == 0 || innerWorld == 0 || midOwner == 0 || nestedOwner == 0 {
		t.Fatalf("missing nested frame identity: mid=%v nested=%v outerW=%v midW=%v innerW=%v", midOwner, nestedOwner, outerWorld, midWorld, innerWorld)
	}
	for _, phase := range []string{"down", "up"} {
		buttons := 1
		if phase == "up" {
			buttons = 0
		}
		sendGo(t, ctx, tc, map[string]any{"op": "event", "gen": gen, "kind": "mouse", "id": outerOwner,
			"frame": button, "fdoc": innerWorld, "route": []int{int(outerOwner), int(midOwner), int(nestedOwner)}, "docs": []int{0, int(outerWorld), int(midWorld)},
			"type": phase, "fx": .5, "fy": .5, "button": 0, "buttons": buttons})
	}
	for {
		m := tc.readJSON(t, ctx)
		if m["type"] != "go-changes" {
			continue
		}
		b, _ := json.Marshal(m["ops"])
		if strings.Contains(string(b), "nested clicked") {
			break
		}
	}
	tc.c.CloseNow()
}

// normal gives every node in a snapshot its children list, for walking.
func normal(n map[string]any) {
	if _, ok := n["c"].([]any); !ok {
		n["c"] = []any{}
	}
	for _, k := range n["c"].([]any) {
		normal(k.(map[string]any))
	}
}
