package main

import (
	"encoding/json"
	"os"
	"regexp"
	"strconv"
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

// glViewerJS is the viewer's WebGL replay.
const glViewerJS = "go-frame-gl.js"

// TestGoCanvasGLMethodLists: the calls the page's hook records (gogl.js),
// the server forwards and the viewer replays (go-frame-gl.js) are the same
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
	viewer := words(glViewerJS, "const glMethods = new Set((")
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
	compare("gogl.js", hook, "gocanvasgl.go", server)
	compare("gocanvasgl.go", server, "gogl.js", hook)
	compare("gogl.js", hook, "go-frame-gl.js", viewer)
	// And the extensions replayed.
	b, _ := os.ReadFile(glViewerJS)
	m := regexp.MustCompile(`const glExtensionList = \[([^\]]*)\]`).FindSubmatch(b)
	if m == nil {
		t.Fatal("go-frame-gl.js: glExtensionList not found")
	}
	listed := map[string]bool{}
	for _, name := range regexp.MustCompile(`"([^"]+)"`).FindAllSubmatch(m[1], -1) {
		listed[string(name[1])] = true
		if !goCanvasGLExtensions[string(name[1])] {
			t.Errorf("go-frame-gl.js replays extension %s, gocanvasgl.go refuses it", name[1])
		}
	}
	for name := range goCanvasGLExtensions {
		if !listed[name] {
			t.Errorf("gocanvasgl.go accepts extension %s, go-frame-gl.js doesn't replay it", name)
		}
	}
	compare("go-frame-gl.js", viewer, "gogl.js", hook)
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

// glLine is the line of file that starts (after its indent) with start.
func glLine(t *testing.T, file, start string) string {
	t.Helper()
	b, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), start) {
			return line
		}
	}
	t.Fatalf("%s: %q not found", file, start)
	return ""
}

// glStrings are the words in a line's string literals.
func glStrings(line string) map[string]bool {
	out := map[string]bool{}
	for _, m := range regexp.MustCompile(`"([^"]*)"`).FindAllStringSubmatch(line, -1) {
		for _, w := range strings.Fields(m[1]) {
			out[w] = true
		}
	}
	return out
}

// glNumber is the value of a JS number literal, or a shift of two.
func glNumber(t *testing.T, s string) int {
	t.Helper()
	m := regexp.MustCompile(`^(\d+)(?: << (\d+))?$`).FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		t.Fatalf("not a number: %q", s)
	}
	n, _ := strconv.Atoi(m[1])
	if m[2] != "" {
		shift, _ := strconv.Atoi(m[2])
		n <<= shift
	}
	return n
}

func glSameSet(t *testing.T, what string, aName string, a map[string]bool, bName string, b map[string]bool) {
	t.Helper()
	for k := range a {
		if !b[k] {
			t.Errorf("%s: %s has %s, %s hasn't", what, aName, k, bName)
		}
	}
	for k := range b {
		if !a[k] {
			t.Errorf("%s: %s has %s, %s hasn't", what, bName, k, aName)
		}
	}
}

// TestGoCanvasGLTablesInStep: the rest of what the page's hook (gogl.js),
// the server and the viewer each keep by hand of the WebGL they mirror
// agree: WebGL2's calls, the extensions WebGL1 has them by, the
// extensions' own calls, the calls taking strings, WebGL2's own
// extensions, and the limits on a log.
func TestGoCanvasGLTablesInStep(t *testing.T) {
	// WebGL2's calls (the hook's are the context's: the iOES calls are an
	// extension's, not the context's).
	viewer2 := glStrings(glLine(t, glViewerJS, "const gl2OnlyMethods"))
	hook2 := glStrings(glLine(t, "gogl.js", "const gl2OnlyMethods"))
	viewerContext2 := map[string]bool{}
	for m := range viewer2 {
		if !strings.HasSuffix(m, "iOES") {
			viewerContext2[m] = true
		}
	}
	glSameSet(t, "WebGL2 calls", "gogl.js", hook2, glViewerJS, viewerContext2)
	glSameSet(t, "WebGL2 calls", "gocanvasgl.go", goCanvasGL2Methods, glViewerJS, viewer2)

	// WebGL2's calls in WebGL1, by extension: method -> extensions.
	aliases := map[string]bool{}
	line := glLine(t, glViewerJS, "const extensionMethods")
	for _, m := range regexp.MustCompile(`(\w+): \[([^\]]*)\]`).FindAllStringSubmatch(line, -1) {
		names := regexp.MustCompile(`"([^"]*)"`).FindAllStringSubmatch(m[2], -1)
		var extensions []string
		for i := 0; i < len(names); i += 2 {
			extensions = append(extensions, names[i][1])
		}
		aliases[m[1]+"="+strings.Join(extensions, "|")] = true
	}
	server := map[string]bool{}
	for m, extensions := range goCanvasGLExtensionMethods {
		server[m+"="+extensions] = true
	}
	glSameSet(t, "WebGL1 aliases", "gocanvasgl.go", server, glViewerJS, aliases)

	// An extension's own calls: method -> its extension.
	commands := map[string]bool{}
	line = glLine(t, glViewerJS, "const extensionCommandMethods")
	m := regexp.MustCompile(`\[([^\]]*)\]\.map\(\(name\) => \[name, \["(\w+)", name\]\]\)`).FindStringSubmatch(line)
	if m == nil {
		t.Fatalf("%s: extensionCommandMethods not understood: %s", glViewerJS, line)
	}
	for name := range glStrings(m[1]) {
		commands[name+"="+m[2]] = true
	}
	b, _ := os.ReadFile(glViewerJS)
	for _, m := range regexp.MustCompile(`extensionCommandMethods\.(\w+) = \["(\w+)"`).FindAllStringSubmatch(string(b), -1) {
		commands[m[1]+"="+m[2]] = true
	}
	server = map[string]bool{}
	for m, extension := range goCanvasGLExtensionCommands {
		server[m+"="+extension] = true
	}
	glSameSet(t, "extension calls", "gocanvasgl.go", server, glViewerJS, commands)

	// Calls taking strings.
	glSameSet(t, "string calls", "gocanvasgl.go", goCanvasGLStringMethods, glViewerJS, glStrings(glLine(t, glViewerJS, "const glStringMethods")))

	// The extensions the hook offers, and WebGL2's own.
	glSameSet(t, "extensions", "gocanvasgl.go", goCanvasGLExtensions, "gogl.js", glStrings(glLine(t, "gogl.js", "const supportedExtensions")))
	line = glLine(t, "gogl.js", "function extensionSupported")
	only2 := map[string]bool{}
	for _, m := range regexp.MustCompile(`name !== "(\w+)"`).FindAllStringSubmatch(line, -1) {
		only2[m[1]] = true
	}
	if !strings.Contains(line, "state.version === 2") {
		t.Errorf("gogl.js: extensionSupported not understood: %s", line)
	}
	glSameSet(t, "WebGL2 extensions", "gocanvasgl.go", goCanvasGL2Extensions, "gogl.js", only2)

	// The limits: a log's calls and bytes, a call's data, a page's canvases.
	hookLimit := func(name string) int {
		line := glLine(t, "gogl.js", "const "+name+" = ")
		return glNumber(t, strings.TrimSuffix(strings.SplitN(line, " = ", 2)[1], ";"))
	}
	limits := map[string]int{}
	line = glLine(t, glViewerJS, "const glLimits = ")
	for _, m := range regexp.MustCompile(`(\w+): ([\d <]+)`).FindAllStringSubmatch(line, -1) {
		limits[m[1]] = glNumber(t, m[2])
	}
	for _, c := range []struct {
		what                 string
		server, hook, viewer int
	}{
		{"calls in a log", goCanvasGLOpsMax, hookLimit("maxCommands"), limits["commands"]},
		{"a log's bytes", goCanvasGLMax, hookLimit("maxJSON"), limits["log"]},
		{"a call's data", goCanvasGLDataMax, hookLimit("maxData"), goCanvasGLDataMax},
		{"a page's WebGL canvases", goGLStreamsMax, goGLStreamsMax, limits["mirrors"]},
	} {
		if c.server != c.hook || c.server != c.viewer {
			t.Errorf("%s: gocanvasgl.go %d, gogl.js %d, %s %d", c.what, c.server, c.hook, glViewerJS, c.viewer)
		}
	}
}
