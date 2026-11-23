package main

import (
	"encoding/json"
	"testing"
)

// TestGoShadowCleaned: what the server keeps of shadow roots, as the rest
// of a page: a root (a fragment only) cleaned as a snapshot's, its event
// handlers and scripts left out; a root attached since ({o: "s"}) and the
// adopted stylesheets a root names ({o: "ss"}) passed on; their texts by
// number only; and the walks of a document's nodes going into roots.
func TestGoShadowCleaned(t *testing.T) {
	ops := func(raw ...string) []map[string]any {
		t.Helper()
		var in []json.RawMessage
		for _, r := range raw {
			in = append(in, json.RawMessage(r))
		}
		var out []map[string]any
		b, _ := json.Marshal(goCleanOps(in, &goSeen{gl: map[int]*goGLStream{}}))
		json.Unmarshal(b, &out)
		return out
	}
	got := ops(
		`{"o":"s","i":5,"s":{"i":6,"t":11,"ss":3,"c":[{"i":7,"t":1,"n":"b","a":["onclick","x()","id","ok"]},{"i":8,"t":1,"n":"script"}]}}`,
		`{"o":"s","i":5,"s":{"i":9,"t":1,"n":"div"}}`,
		`{"o":"ss","i":6,"ss":4}`,
		`{"o":"ss","i":6,"ss":-1}`,
	)
	if len(got) != 2 {
		t.Fatalf("ops kept: %+v", got)
	}
	s, _ := got[0]["s"].(map[string]any)
	kids, _ := s["c"].([]any)
	if got[0]["o"] != "s" || len(kids) != 1 || s["ss"] != float64(3) {
		t.Errorf("a root attached since: %+v", got[0])
	}
	if b, _ := kids[0].(map[string]any); len(b["a"].([]any)) != 2 {
		t.Errorf("its event handler kept: %+v", b)
	}
	if got[1]["o"] != "ss" || got[1]["ss"] != float64(4) {
		t.Errorf("a root's adopted stylesheets: %+v", got[1])
	}

	// Texts by number only; ss and css only where they belong.
	if css := goCleanCSS(map[string]string{"1": "a{}", "x": "b{}", "01": "c{}", "0": "d{}", "-2": "e{}"}); len(css) != 1 || css["1"] != "a{}" {
		t.Errorf("adopted texts: %v", css)
	}
	doc := goClean(&goNode{ID: 1, Type: 9, CSS: map[string]string{"2": "p{}", "no": "q{}"}, SS: 5, Kids: []*goNode{
		{ID: 2, Type: 1, Name: "div", SS: 3, CSS: map[string]string{"1": "x{}"}, Shadow: &goNode{ID: 3, Type: 11, SS: 2, CSS: map[string]string{"1": "y{}"}}},
	}})
	el := doc.Kids[0]
	if len(doc.CSS) != 1 || doc.SS != 0 || el.SS != 0 || el.CSS != nil || el.Shadow.SS != 2 || el.Shadow.CSS != nil {
		t.Errorf("ss and css cleaned: doc %v/%d, element %v/%d, root %v/%d", doc.CSS, doc.SS, el.CSS, el.SS, el.Shadow.CSS, el.Shadow.SS)
	}

	// The walks of a document go into its roots: frame owners, canvases.
	tree := &goNode{ID: 1, Type: 9, Kids: []*goNode{{ID: 2, Type: 1, Name: "x-card", Shadow: &goNode{ID: 3, Type: 11, Kids: []*goNode{
		{ID: 4, Type: 1, Name: "iframe"},
		{ID: 5, Type: 1, Name: "canvas", GL: &goGLLog{Log: "[]", W: 4, H: 4, Full: true, Version: 1, Attributes: 27}},
	}}}}}
	if n := findGoNode(tree, 4); n == nil || n.Name != "iframe" {
		t.Error("an iframe in a shadow root not found")
	}
	goClean(tree)
	streams := map[int]*goGLStream{}
	goGLStreamsOf(tree, streams)
	if _, ok := streams[5]; !ok {
		t.Error("a WebGL canvas in a shadow root not counted")
	}
}
