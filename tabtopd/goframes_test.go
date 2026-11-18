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

// normal gives every node in a snapshot its children list, for walking.
func normal(n map[string]any) {
	if _, ok := n["c"].([]any); !ok {
		n["c"] = []any{}
	}
	for _, k := range n["c"].([]any) {
		normal(k.(map[string]any))
	}
}
