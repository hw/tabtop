package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"strings"
	"testing"
	"time"
)

// TestGoShadowWithMoli: shadow roots read in Moli, as the agent reads them
// in its own world with goshadow.js in the page's: an open one with its
// adopted stylesheets and a slot, one within it, a closed one (made open,
// the page still told it's closed), one attached once its host's been
// sent, and changes in them.
func TestGoShadowWithMoli(t *testing.T) {
	moli := os.Getenv("TABTOP_TEST_MOLI")
	if moli == "" {
		t.Skip("TABTOP_TEST_MOLI isn't set")
	}
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		io.WriteString(w, `<!doctype html><title>Shadow</title>
<x-card id="card"><span id="slotted">slotted</span></x-card>
<div id="closedhost"></div>
<x-late id="late"></x-late>
<script>
window.sheet = new CSSStyleSheet();
sheet.replaceSync(":host { color: rgb(1, 2, 3) }");
customElements.define("x-card", class extends HTMLElement {
	constructor() {
		super();
		const r = this.attachShadow({ mode: "open" });
		r.adoptedStyleSheets = [sheet];
		r.innerHTML = '<b id="inner">inner</b><slot></slot><x-sub></x-sub>';
	}
});
customElements.define("x-sub", class extends HTMLElement {
	constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = '<i id="deep">deep</i>'; }
});
const c = document.getElementById("closedhost").attachShadow({ mode: "closed" });
c.innerHTML = '<u id="hidden">closed</u>';
window.closedRoot = c;
window.pageSees = [document.getElementById("closedhost").shadowRoot === null, c.mode].join();
</script>`)
	}))
	defer site.Close()
	goTestPorts(t, portOf(t, site.URL))
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	e, err := startGoEngine(goEngineConfig{engine: moli, mode: goUnsandboxed,
		allow: func(a netip.Addr) bool { return a.Unmap() == netip.MustParseAddr("127.0.0.1") }})
	if err != nil {
		t.Fatal(err)
	}
	defer e.kill("shadow test")
	c, err := dialCDP(ctx, e)
	if err != nil {
		t.Fatal(err)
	}
	defer c.close()
	page, _, err := c.newPageTarget(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"Page.enable", "Runtime.enable"} {
		if err := c.call(ctx, page, method, nil, nil); err != nil {
			t.Fatal(err)
		}
	}
	if err := c.call(ctx, page, "Page.addScriptToEvaluateOnNewDocument", map[string]any{"source": goShadowJS}, nil); err != nil {
		t.Fatal(err)
	}
	if err := c.call(ctx, page, "Page.navigate", map[string]string{"url": site.URL}, nil); err != nil {
		t.Fatal(err)
	}
	// in evaluates in the page's world (0) or the agent's.
	in := func(world int, expression string) string {
		t.Helper()
		p := map[string]any{"expression": expression, "returnByValue": true}
		if world != 0 {
			p["contextId"] = world
		}
		var r struct {
			Result           struct{ Value any }
			ExceptionDetails *struct {
				Exception struct{ Description string }
			}
		}
		if err := c.call(ctx, page, "Runtime.evaluate", p, &r); err != nil {
			t.Fatal(err)
		}
		if r.ExceptionDetails != nil {
			t.Fatalf("%.80s: %s", expression, r.ExceptionDetails.Exception.Description)
		}
		s, _ := r.Result.Value.(string)
		return s
	}
	for in(0, `document.readyState === "complete" && window.pageSees ? "yes" : ""`) != "yes" {
		if ctx.Err() != nil {
			t.Fatal("the page didn't load")
		}
		time.Sleep(20 * time.Millisecond)
	}
	var tree struct {
		FrameTree struct {
			Frame struct{ ID string }
		}
	}
	if err := c.call(ctx, page, "Page.getFrameTree", nil, &tree); err != nil {
		t.Fatal(err)
	}
	var world struct {
		ExecutionContextID int `json:"executionContextId"`
	}
	if err := c.call(ctx, page, "Page.createIsolatedWorld", map[string]any{"frameId": tree.FrameTree.Frame.ID, "worldName": "tabtop"}, &world); err != nil {
		t.Fatal(err)
	}
	agent := world.ExecutionContextID
	in(agent, goAgentJS)

	if got := in(0, "pageSees"); got != "true,closed" {
		t.Errorf("the page's world told of its closed root: %q", got)
	}
	var snap struct{ Doc *goNode }
	if err := json.Unmarshal([]byte(in(agent, "__tabtop.snapshot()")), &snap); err != nil {
		t.Fatal(err)
	}
	byID := func(root *goNode, id string) *goNode {
		var found *goNode
		var walk func(n *goNode)
		walk = func(n *goNode) {
			if n == nil || found != nil {
				return
			}
			for i := 0; i+1 < len(n.Attrs); i += 2 {
				if n.Attrs[i] == "id" && n.Attrs[i+1] == id {
					found = n
				}
			}
			for _, k := range n.Kids {
				walk(k)
			}
			walk(n.Shadow)
		}
		walk(root)
		return found
	}
	text := func(n *goNode) string {
		var b strings.Builder
		var walk func(n *goNode)
		walk = func(n *goNode) {
			if n == nil {
				return
			}
			if n.Type == 3 {
				b.WriteString(n.Value)
			}
			for _, k := range n.Kids {
				walk(k)
			}
		}
		walk(n)
		return b.String()
	}
	card := byID(snap.Doc, "card")
	if card == nil || card.Shadow == nil || card.Shadow.Type != 11 {
		t.Fatalf("x-card's shadow root not sent: %+v", card)
	}
	if k := card.Shadow.Kids; len(k) < 3 || k[0].Name != "style" || !strings.Contains(text(k[0]), "rgb(1, 2, 3)") {
		t.Errorf("its adopted stylesheet not first, as a <style>: %+v", k)
	}
	if n := byID(card.Shadow, "inner"); n == nil || text(n) != "inner" {
		t.Errorf("its content: %+v", n)
	}
	if byID(snap.Doc, "deep") == nil {
		t.Error("a shadow root within it not sent")
	}
	if byID(card, "slotted") == nil || byID(card.Shadow, "slotted") != nil {
		t.Error("its slotted child not its own (light) child")
	}
	if closed := byID(snap.Doc, "closedhost"); closed == nil || closed.Shadow == nil || byID(closed.Shadow, "hidden") == nil {
		t.Errorf("the closed root not read: %+v", closed)
	}
	if late := byID(snap.Doc, "late"); late == nil || late.Shadow != nil {
		t.Errorf("x-late, not yet defined: %+v", late)
	}

	// Changes: in a shadow root, a root attached since, adopted rules.
	type op struct {
		O string
		I int
		V *string
		C []*goNode
		S *goNode
	}
	changes := func() []op {
		t.Helper()
		raw := in(agent, "__tabtop.changes()")
		if raw == "" {
			return nil
		}
		var b struct{ Ops []op }
		if err := json.Unmarshal([]byte(raw), &b); err != nil {
			t.Fatal(err)
		}
		return b.Ops
	}
	changes()
	in(0, `document.getElementById("card").shadowRoot.getElementById("inner").textContent = "changed"`)
	in(0, `closedRoot.getElementById("hidden").setAttribute("title", "seen")`)
	in(0, `document.getElementById("card").shadowRoot.append(Object.assign(document.createElement("p"), { id: "appended", textContent: "appended" }))`)
	got := changes()
	var inner, closedAttr, appended bool
	for _, o := range got {
		for _, k := range o.C {
			if byID(k, "appended") != nil {
				appended = true
			}
		}
		for _, k := range o.C {
			if k.Type == 3 && k.Value == "changed" {
				inner = true
			}
		}
		if o.O == "t" && o.V != nil && *o.V == "changed" {
			inner = true
		}
		if o.O == "a" && o.V != nil && *o.V == "seen" {
			closedAttr = true
		}
	}
	if !inner || !closedAttr || !appended {
		t.Errorf("changes in shadow roots (open %v, closed %v, a root's own child %v): %+v", inner, closedAttr, appended, got)
	}
	in(0, `customElements.define("x-late", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = "<em id=\"later\">later</em>"; } })`)
	in(0, `sheet.replaceSync(":host { color: rgb(4, 5, 6) } em { color: red }")`)
	got = changes()
	var late, sheet bool
	for _, o := range got {
		if o.O == "s" && o.S != nil && byID(o.S, "later") != nil {
			late = true
		}
		if o.O == "t" && o.V != nil && strings.Contains(*o.V, "rgb(4, 5, 6)") {
			sheet = true
		}
	}
	if !late || !sheet {
		t.Errorf("a root attached since (%v), adopted rules changed (%v): %+v", late, sheet, got)
	}
	// The root attached since, changed itself: its own children said.
	in(0, `document.getElementById("late").shadowRoot.append(Object.assign(document.createElement("q"), { id: "later2" }))`)
	got = changes()
	var later2 bool
	for _, o := range got {
		for _, k := range o.C {
			if byID(k, "later2") != nil {
				later2 = true
			}
		}
	}
	if !later2 {
		t.Errorf("a child put in a root attached since: %+v", got)
	}
	// The server keeps them: cleaned, a shadow root's event handlers too.
	n := &goNode{ID: 1, Type: 1, Name: "div", Shadow: &goNode{ID: 2, Type: 11, Kids: []*goNode{
		{ID: 3, Type: 1, Name: "b", Attrs: []string{"onclick", "x()", "id", "ok"}},
		{ID: 4, Type: 1, Name: "script"},
	}}}
	if c := goClean(n); c.Shadow == nil || len(c.Shadow.Kids) != 1 || len(c.Shadow.Kids[0].Attrs) != 2 {
		t.Errorf("a shadow root cleaned: %+v", c.Shadow)
	}
	if c := goClean(&goNode{ID: 1, Type: 1, Name: "div", Shadow: &goNode{ID: 2, Type: 1, Name: "b"}}); c.Shadow != nil {
		t.Error("a shadow root that's not a fragment kept")
	}
}
