package main

// The server's side of WebGL mirroring: a page's WebGL command logs
// (gogl.js, read by goagent.js) are checked here before they're sent on to
// be replayed in the viewer (go-frame-gl.js): the calls, their arguments and
// the objects they refer to, a delta against what its stream's full log
// made, and how many WebGL canvases a document has.

import (
	"bytes"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"math"
	"strings"
)

// goGLSurface is the WebGL the mirror records (gogl.js), forwards (here)
// and replays (go-frame-gl.js), in one file for the three:
// gogl-surface.json, which go generate makes gogl-surface.js of for the two
// scripts.
//
//go:generate go run gen_gogl_surface.go
//go:embed gogl-surface.json
var goGLSurfaceJSON []byte

var goGLSurface = func() (s struct {
	Methods       []string `json:"methods"`
	WebGL2Methods []string `json:"webgl2Methods"` // the WebGL2 context's own
	// WebGL1Aliases are WebGL2's calls a WebGL1 context has by an
	// extension: [extension, its method], in the order tried.
	WebGL1Aliases     map[string][][2]string `json:"webgl1Aliases"`
	ExtensionCommands map[string]string      `json:"extensionCommands"`
	StringMethods     []string               `json:"stringMethods"`
	Extensions        []string               `json:"extensions"` // in the order the page is told them
	WebGL2Extensions  []string               `json:"webgl2Extensions"`
	Limits            struct {
		Commands  int `json:"commands"`
		LogBytes  int `json:"logBytes"`
		DataBytes int `json:"dataBytes"`
		Canvases  int `json:"canvases"`
	} `json:"limits"`
}) {
	decoder := json.NewDecoder(bytes.NewReader(goGLSurfaceJSON))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&s); err != nil {
		panic("gogl-surface.json: " + err.Error())
	}
	return s
}()

func goGLSet(names ...[]string) map[string]bool {
	out := map[string]bool{}
	for _, list := range names {
		for _, name := range list {
			out[name] = true
		}
	}
	return out
}

var (
	goCanvasGLMax     = goGLSurface.Limits.LogBytes
	goCanvasGLOpsMax  = goGLSurface.Limits.Commands
	goCanvasGLDataMax = goGLSurface.Limits.DataBytes // a typed array's or texture's bytes
)

var goCanvasGLMethods = goGLSet(goGLSurface.Methods)

// goCanvasGL2Methods are WebGL2's: the context's, and the calls of an
// extension only WebGL2 has.
var goCanvasGL2Methods = func() map[string]bool {
	out := goGLSet(goGLSurface.WebGL2Methods)
	for method, extension := range goGLSurface.ExtensionCommands {
		if goCanvasGL2Extensions[extension] {
			out[method] = true
		}
	}
	return out
}()

// goCanvasGLExtensionMethods: WebGL2's calls a WebGL1 stream may have, by
// the extensions any of which gives it ("a|b").
var goCanvasGLExtensionMethods = func() map[string]string {
	out := map[string]string{}
	for method, aliases := range goGLSurface.WebGL1Aliases {
		var extensions []string
		for _, alias := range aliases {
			extensions = append(extensions, alias[0])
		}
		out[method] = strings.Join(extensions, "|")
	}
	return out
}()

// goCanvasGLExtensionCommands are an extension's own calls (not WebGL2's
// under another name): refused unless it's turned on, in either version.
var goCanvasGLExtensionCommands = goGLSurface.ExtensionCommands

func goCanvasGLArg(raw json.RawMessage) bool {
	if len(raw) > goCanvasGLMax {
		return false
	}
	var value any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if dec.Decode(&value) != nil {
		return false
	}
	var check func(any, int) bool
	check = func(v any, depth int) bool {
		if depth > 8 {
			return false
		}
		switch x := v.(type) {
		case nil, bool:
			return true
		case json.Number:
			n, err := x.Float64()
			return err == nil && !math.IsInf(n, 0) && !math.IsNaN(n)
		case string:
			return len(x) <= 256<<10
		case []any:
			if len(x) > 64 {
				return false
			}
			for _, item := range x {
				if !check(item, depth+1) {
					return false
				}
			}
			return true
		case map[string]any:
			if ref, ok := x["ref"]; ok && len(x) == 1 {
				n, ok := ref.(json.Number)
				if !ok {
					return false
				}
				id, err := n.Int64()
				return err == nil && id > 0 && id <= 1<<20
			}
			if location, ok := x["location"].(string); ok && len(x) == 2 {
				program, ok := x["program"].(json.Number)
				if !ok || len(location) > 256 {
					return false
				}
				id, err := program.Int64()
				return err == nil && id > 0 && id <= 1<<20
			}
			if pixels, ok := x["pixels"]; ok && len(x) == 3 {
				w, wok := x["width"].(json.Number)
				h, hok := x["height"].(json.Number)
				if !wok || !hok || !check(pixels, depth+1) {
					return false
				}
				width, we := w.Int64()
				height, he := h.Int64()
				if we != nil || he != nil || width < 1 || height < 1 || width > goCanvasSizeMax || height > goCanvasSizeMax || width*height > goCanvasPixelsMax {
					return false
				}
				pixelMap, ok := pixels.(map[string]any)
				if !ok || pixelMap["typed"] != "Uint8ClampedArray" {
					return false
				}
				data, ok := pixelMap["data"].(string)
				if !ok {
					return false
				}
				decoded, err := base64.StdEncoding.DecodeString(data)
				return err == nil && int64(len(decoded)) == width*height*4
			}
			if typ, ok := x["typed"].(string); ok && len(x) == 2 {
				switch typ {
				case "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "Float16Array", "Float32Array", "Float64Array":
				default:
					return false
				}
				data, ok := x["data"].(string)
				if !ok || len(data) > goCanvasGLMax {
					return false
				}
				decoded, err := base64.StdEncoding.DecodeString(data)
				return err == nil && len(decoded) <= goCanvasGLDataMax
			}
			return false
		default:
			return false
		}
	}
	return check(value, 0)
}

// goCanvasGLRefsValid rejects references to objects that the stream has not
// created yet. The viewer checks again when restoring the command log.
func goCanvasGLRefsValid(raw json.RawMessage, objects map[int]bool) bool {
	var value any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if dec.Decode(&value) != nil {
		return false
	}
	var check func(any, int) bool
	check = func(v any, depth int) bool {
		if depth > 8 {
			return false
		}
		switch x := v.(type) {
		case []any:
			for _, item := range x {
				if !check(item, depth+1) {
					return false
				}
			}
		case map[string]any:
			if ref, ok := x["ref"]; ok && len(x) == 1 {
				n, ok := ref.(json.Number)
				if !ok {
					return false
				}
				id, err := n.Int64()
				return err == nil && objects[int(id)]
			}
			if _, ok := x["location"].(string); ok && len(x) == 2 {
				n, ok := x["program"].(json.Number)
				if !ok {
					return false
				}
				id, err := n.Int64()
				return err == nil && objects[int(id)]
			}
			for _, item := range x {
				if !check(item, depth+1) {
					return false
				}
			}
		}
		return true
	}
	return check(value, 0)
}

// goGLLog is a canvas's WebGL command log as it comes from the page's
// hook (gogl.js's capture protocol), by way of its agent, in a snapshot's
// canvas (gl) and in a change (o "g"), and as it goes on to the viewer
// (go-frame-gl.js's webglLog): the calls (JSON), the canvas's size, whether
// it's whole or the calls since the last, the WebGL version and the
// context's attributes (a bitmask).
type goGLLog struct {
	Log        string `json:"v"`
	W          int    `json:"w"`
	H          int    `json:"h"`
	Full       bool   `json:"r"`
	Version    int    `json:"version"`
	Attributes int    `json:"attributes"`
}

// check checks the log: a whole one when prior is nil, else the calls
// since the last, continuing prior (see goCanvasGLCheck).
func (l *goGLLog) check(prior *goGLStream) (*goGLStream, bool) {
	if l == nil || l.Attributes < 0 || l.Attributes > 63 {
		return nil, false
	}
	return goCanvasGLCheck(l.Log, l.W, l.H, l.Version, prior)
}

// goGLStream is what the server knows of one canvas's WebGL command stream
// across change batches: which objects its log has created and which
// extensions it has turned on, so that a delta (only the calls since the last
// batch) may refer to them. A full log starts a new one.
type goGLStream struct {
	version    int
	objects    map[int]bool
	extensions map[string]bool
}

// goGLStreamsMax bounds a document's WebGL canvases: those beyond are shown
// as unsupported (each costs the viewer a GPU context).
var goGLStreamsMax = goGLSurface.Limits.Canvases

// goCanvasGLExtensions are the extensions the mirror replays;
// goCanvasGL2Extensions those only WebGL2 has.
var goCanvasGLExtensions = goGLSet(goGLSurface.Extensions)
var goCanvasGL2Extensions = goGLSet(goGLSurface.WebGL2Extensions)

// goCanvasGLStringMethods take a string argument; goCanvasGLSequenceMethod
// says which take a sequence (uniform*v and the like).
var goCanvasGLStringMethods = goGLSet(goGLSurface.StringMethods)

func goCanvasGLSequenceMethod(m string) bool {
	return strings.HasSuffix(m, "v") || m == "drawBuffers" || strings.HasPrefix(m, "invalidate") || m == "transformFeedbackVaryings"
}

// goCanvasGLKeys are a command's fields: any other (or another case of one,
// which encoding/json would take as it) is refused, so that what's checked
// here is what the viewer reads.
var goCanvasGLKeys = map[string]bool{"m": true, "a": true, "r": true, "rt": true, "q": true, "program": true, "up": true, "pr": true, "fb": true, "name": true}

func goCanvasGLValid(encoded string, width, height, version int) bool {
	_, ok := goCanvasGLCheck(encoded, width, height, version, nil)
	return ok
}

// goCanvasGLCheck validates a WebGL command log: a full one when prior is
// nil, else a delta continuing prior (which it updates, and which the caller
// must forget if the delta is refused). It returns the stream's state after
// the log.
func goCanvasGLCheck(encoded string, width, height, version int, prior *goGLStream) (*goGLStream, bool) {
	if prior != nil && prior.version != version {
		return nil, false
	}
	if encoded == "" || len(encoded) > goCanvasGLMax || !strings.HasPrefix(encoded, "[") || (version != 1 && version != 2) || width < 1 || height < 1 || width > goCanvasSizeMax || height > goCanvasSizeMax || int64(width)*int64(height) > goCanvasPixelsMax {
		return nil, false
	}
	var commands []struct {
		Method         string            `json:"m"`
		Args           []json.RawMessage `json:"a"`
		Result         int               `json:"r"`
		Query          *int              `json:"q"`
		Prog           int               `json:"program"`
		UniformProgram int               `json:"up"`
		DrawProgram    int               `json:"pr"`
		Framebuffer    int               `json:"fb"`
		Name           string            `json:"name"`
	}
	if json.Unmarshal([]byte(encoded), &commands) != nil || len(commands) > goCanvasGLOpsMax {
		return nil, false
	}
	var fields []map[string]json.RawMessage
	if json.Unmarshal([]byte(encoded), &fields) != nil || len(fields) != len(commands) {
		return nil, false
	}
	for _, command := range fields {
		for key := range command {
			if !goCanvasGLKeys[key] {
				return nil, false
			}
		}
	}
	stream := prior
	if stream == nil {
		stream = &goGLStream{version: version, objects: make(map[int]bool), extensions: make(map[string]bool)}
	}
	objects, extensions := stream.objects, stream.extensions
	for _, command := range commands {
		if !goCanvasGLMethods[command.Method] || command.Args == nil || len(command.Args) > 16 {
			return nil, false
		}
		if extension, ok := goCanvasGLExtensionCommands[command.Method]; ok && !extensions[extension] {
			return nil, false
		}
		if version == 1 && goCanvasGL2Methods[command.Method] {
			required := strings.Split(goCanvasGLExtensionMethods[command.Method], "|")
			supported := false
			for _, extension := range required {
				if extension != "" && extensions[extension] {
					supported = true
					break
				}
			}
			if !supported {
				return nil, false
			}
		}
		for _, arg := range command.Args {
			if !goCanvasGLArg(arg) || !goCanvasGLRefsValid(arg, objects) {
				return nil, false
			}
			// WebGL turns a string or an array into a number where it wants
			// one: only the calls that take them may have them (go-frame-gl.js's
			// glCheck, the same).
			if t := bytes.TrimSpace(arg); len(t) > 0 && (t[0] == '"' && !goCanvasGLStringMethods[command.Method] || t[0] == '[' && !goCanvasGLSequenceMethod(command.Method)) {
				return nil, false
			}
		}
		if command.Result < 0 || command.Result > 1<<20 || command.Prog < 0 || command.Prog > 1<<20 || command.UniformProgram < 0 || command.UniformProgram > 1<<20 || command.DrawProgram < 0 || command.DrawProgram > 1<<20 || command.Framebuffer < 0 || command.Framebuffer > 1<<20 || command.Query != nil && (*command.Query < 0 || *command.Query > 1<<20) || len(command.Name) > 256 {
			return nil, false
		}
		for _, ref := range []int{command.Prog, command.UniformProgram, command.DrawProgram, command.Framebuffer} {
			if ref > 0 && !objects[ref] {
				return nil, false
			}
		}
		if command.Result > 0 {
			if objects[command.Result] {
				return nil, false
			}
			objects[command.Result] = true
		}
		if command.Method == "getExtension" {
			var extension string
			if len(command.Args) != 1 || json.Unmarshal(command.Args[0], &extension) != nil || !goCanvasGLExtensions[extension] {
				return nil, false
			}
			if version == 1 && goCanvasGL2Extensions[extension] {
				return nil, false
			}
			extensions[extension] = true
		}
	}
	if len(objects) > goCanvasGLOpsMax*2 {
		return nil, false
	}
	return stream, true
}

// goGLStreamsOf collects the WebGL streams of the canvases in a cleaned
// tree, by node ID, into streams; past goGLStreamsMax, a canvas's log is
// taken out of the tree.
func goGLStreamsOf(n *goNode, streams map[int]*goGLStream) {
	if n == nil {
		return
	}
	if n.glStream != nil {
		if _, known := streams[n.ID]; n.ID > 0 && (known || len(streams) < goGLStreamsMax) {
			streams[n.ID] = n.glStream
		} else {
			// One too many: shown as unsupported, as it couldn't go on.
			n.glStream, n.GL = nil, nil
			n.CanvasErr = "unsupported"
		}
	}
	for _, k := range n.Kids {
		goGLStreamsOf(k, streams)
	}
}

// glStreamOK says whether canvas id has a stream.
func (s *goSeen) glStreamOK(id int) (*goGLStream, bool) {
	if s == nil || s.gl == nil {
		return nil, false
	}
	stream, ok := s.gl[id]
	return stream, ok
}

// glFull says whether the document has as many WebGL canvases as it may.
func (s *goSeen) glFull() bool { return s != nil && s.gl != nil && len(s.gl) >= goGLStreamsMax }

// glStream is the WebGL stream checked so far for canvas id, if any.
func (s *goSeen) glStream(id int) *goGLStream {
	if s == nil || s.gl == nil {
		return nil
	}
	return s.gl[id]
}

// glOp checks a change's WebGL log (o "g"): a full one (r), or the calls
// since the last, continuing the stream checked so far. It's sent on as it
// came, or the canvas is marked unsupported.
func (seen *goSeen) glOp(op *goChangeOp) map[string]any {
	// A delta continues the stream the server has checked so far;
	// without one (refused before, or never sent whole) it's refused.
	var prior *goGLStream
	ok := op.GL != nil
	if ok && !op.GL.Full {
		prior = seen.glStream(op.I)
		ok = prior != nil
	}
	if _, known := seen.glStreamOK(op.I); ok && op.GL.Full && !known && seen.glFull() {
		ok = false // one WebGL canvas too many
	}
	var stream *goGLStream
	if ok {
		stream, ok = op.GL.check(prior)
	}
	if ok && seen != nil && seen.gl != nil {
		seen.gl[op.I] = stream
	}
	if ok {
		return goCanvasOp(map[string]any{"o": "g", "i": op.I, "gl": op.GL}, op.Path)
	}
	if seen != nil && seen.gl != nil {
		delete(seen.gl, op.I)
	}
	return goCanvasOp(map[string]any{"o": "p", "i": op.I, "v": "", "pe": "unsupported"}, op.Path)
}
