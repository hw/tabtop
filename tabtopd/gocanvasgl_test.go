package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// glOps runs one WebGL op through goCleanOps with the tab's streams, and
// says what came out: "g" (forwarded) or "p" (the canvas marked unsupported).
func glOps(t *testing.T, streams map[int]*goGLStream, id int, log string, full bool, version int) string {
	t.Helper()
	raw, _ := json.Marshal(map[string]any{"o": "g", "i": id, "gl": map[string]any{"v": log, "w": 10, "h": 10, "r": full, "version": version, "attributes": 27}})
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
	doc := &goNode{ID: 1, Type: 9, Kids: []*goNode{{ID: 2, Type: 1, Name: "canvas", GL: &goGLLog{Log: `[{"m":"createBuffer","a":[],"r":1,"rt":"buffer"}]`, W: 4, H: 4, Full: true, Version: 2, Attributes: 27}},
		{ID: 3, Type: 1, Name: "canvas", GL: &goGLLog{Log: `[{"m":"nope","a":[]}]`, W: 4, H: 4, Full: true, Version: 2, Attributes: 27}}}}
	if goClean(doc) == nil {
		t.Fatal("snapshot refused")
	}
	streams := map[int]*goGLStream{}
	goGLStreamsOf(doc, streams)
	if streams[2] == nil || !streams[2].objects[1] || streams[3] != nil {
		t.Fatalf("streams: %v", streams)
	}
	if doc.Kids[1].CanvasErr != "unsupported" || doc.Kids[1].GL != nil {
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
		// A size as a string or an array, which WebGL would take as a number.
		`[{"m":"createBuffer","a":[],"r":1},{"m":"bindBuffer","a":[34962,{"ref":1}]},{"m":"bufferData","a":[34962,"1073741824",35044]}]`,
		`[{"m":"createBuffer","a":[],"r":1},{"m":"bindBuffer","a":[34962,{"ref":1}]},{"m":"bufferData","a":[34962,[1073741824],35044]}]`,
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

// TestGoGLSurfaceGenerated: gogl-surface.js, the page's hook's and the
// viewer's copy of gogl-surface.json, is the one go generate makes of it
// now (go generate, then commit both).
func TestGoGLSurfaceGenerated(t *testing.T) {
	gobin, err := exec.LookPath("go")
	if err != nil {
		gobin = filepath.Join(runtime.GOROOT(), "bin", "go")
	}
	dir := t.TempDir()
	if out, err := exec.Command(gobin, "run", "gen_gogl_surface.go", dir).CombinedOutput(); err != nil {
		t.Fatalf("go run gen_gogl_surface.go: %v\n%s", err, out)
	}
	want, _ := os.ReadFile(filepath.Join(dir, "gogl-surface.js"))
	if got, _ := os.ReadFile("gogl-surface.js"); len(want) == 0 || string(got) != string(want) {
		t.Error("gogl-surface.js isn't gogl-surface.json's: run go generate")
	}
}

// TestGoGLSurfaceInStep: gogl-surface.json's tables agree with each other:
// WebGL2's calls, and the extensions' and those taking strings, are calls
// the mirror has; the extensions they name are ones it has.
func TestGoGLSurfaceInStep(t *testing.T) {
	s := goGLSurface
	once := func(what string, list []string) map[string]bool {
		seen := map[string]bool{}
		for _, name := range list {
			if name == "" || seen[name] {
				t.Errorf("%s: %q empty or twice", what, name)
			}
			seen[name] = true
		}
		return seen
	}
	methods, extensions := once("methods", s.Methods), once("extensions", s.Extensions)
	webgl2 := once("webgl2Methods", s.WebGL2Methods)
	for name := range webgl2 {
		if !methods[name] {
			t.Errorf("WebGL2's %s isn't among the methods", name)
		}
	}
	for name := range once("stringMethods", s.StringMethods) {
		if !methods[name] {
			t.Errorf("%s takes a string but isn't among the methods", name)
		}
	}
	for name := range once("webgl2Extensions", s.WebGL2Extensions) {
		if !extensions[name] {
			t.Errorf("WebGL2's extension %s isn't among the extensions", name)
		}
	}
	for method, aliases := range s.WebGL1Aliases {
		if !webgl2[method] || len(aliases) == 0 {
			t.Errorf("WebGL1 alias of %s: not WebGL2's, or by no extension", method)
		}
		for _, alias := range aliases {
			if !extensions[alias[0]] || alias[1] == "" {
				t.Errorf("WebGL1 alias of %s: %v", method, alias)
			}
		}
	}
	for method, extension := range s.ExtensionCommands {
		if !methods[method] || webgl2[method] || !extensions[extension] {
			t.Errorf("extension call %s (%s): not a method, the WebGL2 context's own, or an extension not had", method, extension)
		}
	}
	if l := s.Limits; l.Commands < 1 || l.LogBytes < 1 || l.DataBytes < 1 || l.DataBytes > l.LogBytes || l.Canvases < 1 {
		t.Errorf("limits: %+v", l)
	}
}

// TestGoCanvasGLCanvasesBounded: a document's WebGL canvases are bounded,
// in a snapshot and as they come in changes.
func TestGoCanvasGLCanvasesBounded(t *testing.T) {
	doc := &goNode{ID: 1, Type: 9}
	for i := 0; i < goGLStreamsMax+4; i++ {
		doc.Kids = append(doc.Kids, &goNode{ID: 10 + i, Type: 1, Name: "canvas", GL: &goGLLog{Log: `[]`, W: 4, H: 4, Full: true, Version: 1, Attributes: 27}})
	}
	goClean(doc)
	streams := map[int]*goGLStream{}
	goGLStreamsOf(doc, streams)
	shown := 0
	for _, k := range doc.Kids {
		if k.GL != nil {
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

// TestGoCanvasGLExtensionCommands: an extension's own call is refused
// unless its extension was turned on, in WebGL1 and WebGL2 alike, as the
// viewer refuses it (go-frame-gl.js's extensionCommandMethods).
func TestGoCanvasGLExtensionCommands(t *testing.T) {
	for _, version := range []int{1, 2} {
		for _, c := range []struct {
			log  string
			want bool
		}{
			{`[{"m":"polygonModeWEBGL","a":[1032,6913]}]`, false},
			{`[{"m":"getExtension","a":["WEBGL_polygon_mode"]},{"m":"polygonModeWEBGL","a":[1032,6913]}]`, true},
			{`[{"m":"enableiOES","a":[3042,0]}]`, false},
			{`[{"m":"getExtension","a":["OES_draw_buffers_indexed"]},{"m":"enableiOES","a":[3042,0]}]`, version == 2},
		} {
			if got := goCanvasGLValid(c.log, 4, 4, version); got != c.want {
				t.Errorf("WebGL%d %s: valid %v, want %v", version, c.log, got, c.want)
			}
		}
	}
}

// TestGoCanvasGLLogShape: a WebGL log goes on to the viewer in one shape,
// in a snapshot's canvas and in a change alike ({v, w, h, r, version,
// attributes}: go-frame-gl.js's webglLog), and only with what's known of
// it; attributes past the bitmask's six bits are refused.
func TestGoCanvasGLLogShape(t *testing.T) {
	const want = `{"v":"[]","w":4,"h":4,"r":true,"version":1,"attributes":27}`
	raw, _ := json.Marshal(map[string]any{"o": "g", "i": 5, "gl": map[string]any{"v": "[]", "w": 4, "h": 4, "r": true, "version": 1, "attributes": 27, "extra": "dropped"}})
	seen := goSeen{gl: map[int]*goGLStream{}}
	out, _ := json.Marshal(goCleanOps([]json.RawMessage{raw}, &seen))
	if string(out) != `[{"gl":`+want+`,"i":5,"o":"g"}]` {
		t.Errorf("a change's log: %s", out)
	}
	var node goNode
	if json.Unmarshal([]byte(`{"i":2,"t":1,"n":"canvas","gl":{"v":"[]","w":4,"h":4,"r":true,"version":1,"attributes":27}}`), &node) != nil || goClean(&node) == nil {
		t.Fatal("snapshot canvas refused")
	}
	if b, _ := json.Marshal(node.GL); string(b) != want {
		t.Errorf("a snapshot canvas's log: %s", b)
	}
	for _, attributes := range []int{-1, 64} {
		node := goNode{ID: 2, Type: 1, Name: "canvas", GL: &goGLLog{Log: "[]", W: 4, H: 4, Full: true, Version: 1, Attributes: attributes}}
		goClean(&node)
		if node.GL != nil || node.CanvasErr != "unsupported" {
			t.Errorf("attributes %d: %+v", attributes, node)
		}
	}
}

// TestGoGLCaptureEvents: the page's hook (gogl.js) and its agent
// (goagent.js) name the capture protocol's events alike.
func TestGoGLCaptureEvents(t *testing.T) {
	hook, _ := os.ReadFile("gogl.js")
	agent, _ := os.ReadFile("goagent.js")
	for _, event := range []string{"__tabtop_webgl_capture", "__tabtop_webgl_undo", "__tabtop_webgl_dirty", "__tabtop_canvas_pixels", "__tabtop_frame_canvas", "__tabtop_frame_canvas_reply", "__tabtop_frame_canvas_dirty"} {
		if !strings.Contains(string(hook), `"`+event+`"`) || !strings.Contains(string(agent), `"`+event+`"`) {
			t.Errorf("%s isn't in both gogl.js and goagent.js", event)
		}
	}
}
