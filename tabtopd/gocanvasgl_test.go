package main

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"testing"
)

// glOps runs one WebGL op through goCleanOps with the tab's streams, and
// says what came out: "g" (forwarded) or "p" (the canvas marked unsupported).
func glOps(t *testing.T, streams map[int]*goGLStream, id int, log string, full bool, version int) string {
	t.Helper()
	raw, _ := json.Marshal(map[string]any{"o": "g", "i": id, "v": log, "w": 10, "h": 10, "r": full, "version": version, "attributes": 27})
	seen := goSeen{gl: streams}
	out := goCleanOps([]json.RawMessage{raw}, &seen)
	if len(out) != 1 {
		t.Fatalf("ops out: %v", out)
	}
	return out[0].(map[string]any)["o"].(string)
}

// TestGoCanvasGLDeltas: a delta may use what the full log before it made
// (objects, a WebGL1 extension's methods), and only that.
func TestGoCanvasGLDeltas(t *testing.T) {
	full := `[{"m":"getExtension","a":["OES_vertex_array_object"]},{"m":"createProgram","a":[],"r":1,"rt":"program"},{"m":"getUniformLocation","a":[{"ref":1},"u"],"r":2,"rt":"uniform"},{"m":"clear","a":[16384],"fb":0}]`
	delta := `[{"m":"uniform1f","a":[{"ref":2},0.5],"up":1},{"m":"createVertexArray","a":[],"r":3,"rt":"vertexarray"},{"m":"bindVertexArray","a":[{"ref":3}]},{"m":"drawArrays","a":[4,0,3],"fb":0,"pr":1}]`
	next := `[{"m":"bindVertexArray","a":[{"ref":3}]},{"m":"drawArrays","a":[4,0,3],"fb":0,"pr":1}]`
	streams := map[int]*goGLStream{}
	if got := glOps(t, streams, 7, delta, false, 1); got != "p" {
		t.Fatalf("a delta with no full log before it: %s", got)
	}
	if got := glOps(t, streams, 7, full, true, 1); got != "g" {
		t.Fatalf("full log: %s", got)
	}
	if got := glOps(t, streams, 7, delta, false, 1); got != "g" {
		t.Fatalf("delta: %s", got)
	}
	if got := glOps(t, streams, 7, next, false, 1); got != "g" {
		t.Fatalf("a later delta, using an object the last one made: %s", got)
	}
	// Another canvas's objects aren't this one's.
	if got := glOps(t, streams, 8, next, false, 1); got != "p" {
		t.Fatalf("another canvas's delta: %s", got)
	}
	// A version other than the stream's is refused, and the stream forgotten.
	if got := glOps(t, streams, 7, next, false, 2); got != "p" || streams[7] != nil {
		t.Fatalf("a delta of another version: %s, stream kept %v", got, streams[7] != nil)
	}
	if got := glOps(t, streams, 7, next, false, 1); got != "p" {
		t.Fatalf("a delta after a refused one: %s", got)
	}
	// A full log starts afresh: a ref to an object of the old log is refused.
	if got := glOps(t, streams, 7, `[{"m":"clear","a":[16384],"fb":0}]`, true, 1); got != "g" {
		t.Fatalf("a fresh full log: %s", got)
	}
	if got := glOps(t, streams, 7, `[{"m":"useProgram","a":[{"ref":1}]}]`, false, 1); got != "p" {
		t.Fatalf("a delta using an object of the old log: %s", got)
	}
	// An object ID made twice is refused.
	glOps(t, streams, 9, full, true, 1)
	if got := glOps(t, streams, 9, `[{"m":"createBuffer","a":[],"r":2,"rt":"buffer"}]`, false, 1); got != "p" {
		t.Fatalf("an object ID made again: %s", got)
	}
}

// TestGoCanvasGLStreamsFromSnapshot: a snapshot's canvases start the
// streams their changes continue.
func TestGoCanvasGLStreamsFromSnapshot(t *testing.T) {
	doc := &goNode{ID: 1, Type: 9, Kids: []*goNode{{ID: 2, Type: 1, Name: "canvas", CanvasGL: `[{"m":"createBuffer","a":[],"r":1,"rt":"buffer"}]`, CanvasGLW: 4, CanvasGLH: 4, CanvasGLV: 2, CanvasGLA: 28},
		{ID: 3, Type: 1, Name: "canvas", CanvasGL: `[{"m":"nope","a":[]}]`, CanvasGLW: 4, CanvasGLH: 4, CanvasGLV: 2, CanvasGLA: 28}}}
	if goClean(doc) == nil {
		t.Fatal("snapshot refused")
	}
	streams := map[int]*goGLStream{}
	goGLStreamsOf(doc, streams)
	if streams[2] == nil || !streams[2].objects[1] || streams[3] != nil {
		t.Fatalf("streams: %v", streams)
	}
	if doc.Kids[1].CanvasErr != "unsupported" || doc.Kids[1].CanvasGL != "" {
		t.Fatalf("an invalid log kept: %+v", doc.Kids[1])
	}
	if got := glOps(t, streams, 2, `[{"m":"bindBuffer","a":[34962,{"ref":1}]}]`, false, 2); got != "g" {
		t.Fatalf("a delta after the snapshot: %s", got)
	}
}

// TestGoCanvasGLRefused: what a log may not carry.
func TestGoCanvasGLRefused(t *testing.T) {
	for _, log := range []string{
		`[{"m":"eval","a":[]}]`,
		`[{"m":"clear","a":[{"x":1}]}]`,
		`[{"m":"bindBuffer","a":[34962,{"ref":5}]}]`,
		`[{"m":"createVertexArray","a":[],"r":1}]`, // WebGL2 in a WebGL1 log, without the extension
		`[{"m":"bufferData","a":[34962,{"typed":"Function","data":""},35044]}]`,
		`[{"m":"bufferData","a":[34962,{"typed":"Uint8Array","data":"!!"},35044]}]`,
		`{"m":"clear"}`,
		// encoding/json takes "A" as "a": checked as one thing, replayed as another.
		`[{"m":"bufferData","a":[{"evil":1},"x"],"A":[1],"r":7,"R":0}]`,
		`[{"m":"clear","a":[16384],"extra":1}]`,
		`[{"m":"getExtension","a":["WEBGL_lose_context"]}]`,
		`[{"m":"getExtension","a":["` + strings.Repeat("x", 1000) + `"]}]`,
		`[{"m":"getExtension","a":[]}]`,
		``,
	} {
		if goCanvasGLValid(log, 10, 10, 1) {
			t.Errorf("accepted %s", log)
		}
	}
	if goCanvasGLValid(`[]`, 5000, 10, 1) || goCanvasGLValid(`[]`, 10, 10, 3) {
		t.Error("accepted a canvas too large, or WebGL 3")
	}
}

// TestGoCanvasGLMethodLists: the calls the page's hook records (gogl.js),
// the server forwards and the viewer replays (go-frame.js) are the same
// list, kept by hand in three places. Queries answered in the engine alone
// (gogl.js's localQueryMethods) are never recorded.
func TestGoCanvasGLMethodLists(t *testing.T) {
	words := func(file, start string) map[string]bool {
		t.Helper()
		b, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		s := string(b)
		i := strings.Index(s, start)
		if i < 0 {
			t.Fatalf("%s: %q not found", file, start)
		}
		s = s[i+len(start):]
		s = s[:strings.Index(s, ").split")]
		out := map[string]bool{}
		for _, m := range regexp.MustCompile(`"([^"]*)"`).FindAllStringSubmatch(s, -1) {
			for _, w := range strings.Fields(m[1]) {
				out[w] = true
			}
		}
		return out
	}
	hook := words("gogl.js", "const allowed = new Set((")
	viewer := words("go-frame.js", "const glMethods = new Set((")
	for _, local := range strings.Fields("beginQuery createQuery deleteQuery endQuery getQuery getQueryParameter queryCounter") {
		delete(hook, local)
		delete(viewer, local)
	}
	server := map[string]bool{}
	for m := range goCanvasGLMethods {
		server[m] = true
	}
	for _, local := range strings.Fields("beginQuery createQuery deleteQuery endQuery getQuery getQueryParameter queryCounter") {
		delete(server, local)
	}
	compare := func(aName string, a map[string]bool, bName string, b map[string]bool) {
		for m := range a {
			if !b[m] {
				t.Errorf("%s has %s, %s hasn't", aName, m, bName)
			}
		}
	}
	compare("gogl.js", hook, "goroute.go", server)
	compare("goroute.go", server, "gogl.js", hook)
	compare("gogl.js", hook, "go-frame.js", viewer)
	// And the extensions replayed.
	b, _ := os.ReadFile("go-frame.js")
	m := regexp.MustCompile(`const glExtensionList = \[([^\]]*)\]`).FindSubmatch(b)
	if m == nil {
		t.Fatal("go-frame.js: glExtensionList not found")
	}
	listed := map[string]bool{}
	for _, name := range regexp.MustCompile(`"([^"]+)"`).FindAllSubmatch(m[1], -1) {
		listed[string(name[1])] = true
		if !goCanvasGLExtensions[string(name[1])] {
			t.Errorf("go-frame.js replays extension %s, goroute.go refuses it", name[1])
		}
	}
	for name := range goCanvasGLExtensions {
		if !listed[name] {
			t.Errorf("goroute.go accepts extension %s, go-frame.js doesn't replay it", name)
		}
	}
	compare("go-frame.js", viewer, "gogl.js", hook)
}

// TestGoCanvasGLCanvasesBounded: a document's WebGL canvases are bounded,
// in a snapshot and as they come in changes.
func TestGoCanvasGLCanvasesBounded(t *testing.T) {
	doc := &goNode{ID: 1, Type: 9}
	for i := 0; i < goGLStreamsMax+4; i++ {
		doc.Kids = append(doc.Kids, &goNode{ID: 10 + i, Type: 1, Name: "canvas", CanvasGL: `[]`, CanvasGLW: 4, CanvasGLH: 4, CanvasGLV: 1, CanvasGLA: 28})
	}
	goClean(doc)
	streams := map[int]*goGLStream{}
	goGLStreamsOf(doc, streams)
	shown := 0
	for _, k := range doc.Kids {
		if k.CanvasGL != "" {
			shown++
		} else if k.CanvasErr != "unsupported" {
			t.Fatalf("a canvas past the bound: %+v", k)
		}
	}
	if shown != goGLStreamsMax || len(streams) != goGLStreamsMax {
		t.Fatalf("%d shown, %d streams", shown, len(streams))
	}
	if got := glOps(t, streams, 999, `[]`, true, 1); got != "p" {
		t.Fatalf("one more in changes: %s", got)
	}
	if got := glOps(t, streams, 10, `[]`, true, 1); got != "g" {
		t.Fatalf("a full log for one already there: %s", got)
	}
}
