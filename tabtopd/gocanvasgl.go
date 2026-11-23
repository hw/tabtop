package main

// The server's side of WebGL mirroring: a page's WebGL command logs
// (gogl.js, read by goagent.js) are checked here before they're sent on to
// be replayed in the viewer (go-frame-gl.js): the calls, their arguments and
// the objects they refer to, a delta against what its stream's full log
// made, and how many WebGL canvases a document has.

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"math"
	"strings"
)

const (
	goCanvasGLMax     = 4 << 20
	goCanvasGLOpsMax  = 4096
	goCanvasGLDataMax = 2 << 20 // a typed array's or texture's bytes
)

var goCanvasGLMethods = func() map[string]bool {
	methods := strings.Fields("activeTexture attachShader disableVertexAttribArray polygonModeWEBGL bindAttribLocation bindBuffer bindFramebuffer bindRenderbuffer bindTexture blendColor blendEquation blendEquationSeparate blendFunc blendFuncSeparate bufferData bufferSubData clear clearColor clearDepth clearStencil colorMask compileShader copyTexImage2D copyTexSubImage2D cullFace deleteBuffer deleteFramebuffer deleteProgram deleteRenderbuffer deleteShader deleteTexture depthFunc depthMask depthRange detachShader disable enable enableVertexAttribArray framebufferRenderbuffer framebufferTexture2D frontFace generateMipmap getAttribLocation getExtension getUniformLocation hint lineWidth linkProgram pixelStorei polygonOffset renderbufferStorage sampleCoverage scissor shaderSource stencilFunc stencilFuncSeparate stencilMask stencilMaskSeparate stencilOp stencilOpSeparate texImage2D texParameterf texParameteri texSubImage2D uniform1f uniform1fv uniform1i uniform1iv uniform2f uniform2fv uniform2i uniform2iv uniform3f uniform3fv uniform3i uniform3iv uniform4f uniform4fv uniform4i uniform4iv uniformMatrix2fv uniformMatrix3fv uniformMatrix4fv useProgram validateProgram vertexAttrib1f vertexAttrib1fv vertexAttrib2f vertexAttrib2fv vertexAttrib3f vertexAttrib3fv vertexAttrib4f vertexAttrib4fv vertexAttribPointer viewport drawArrays drawElements createBuffer createFramebuffer createProgram createRenderbuffer createShader createTexture bindBufferBase bindBufferRange bindVertexArray blitFramebuffer clearBufferfi clearBufferfv clearBufferiv clearBufferuiv copyTexSubImage3D createVertexArray deleteVertexArray drawArraysInstanced drawElementsInstanced drawRangeElements framebufferTextureLayer readBuffer renderbufferStorageMultisample texImage3D texStorage2D texStorage3D texSubImage3D vertexAttribDivisor drawBuffers samplerParameterf samplerParameteri bindSampler createSampler deleteSampler bindTransformFeedback beginTransformFeedback endTransformFeedback createTransformFeedback deleteTransformFeedback pauseTransformFeedback resumeTransformFeedback createQuery deleteQuery beginQuery endQuery queryCounter getQuery getQueryParameter getFragDataLocation enableiOES disableiOES blendEquationiOES blendEquationSeparateiOES blendFunciOES blendFuncSeparateiOES colorMaskiOES copyBufferSubData invalidateFramebuffer invalidateSubFramebuffer compressedTexImage2D compressedTexSubImage2D compressedTexImage3D compressedTexSubImage3D uniform1ui uniform1uiv uniform2ui uniform2uiv uniform3ui uniform3uiv uniform4ui uniform4uiv uniformMatrix2x3fv uniformMatrix2x4fv uniformMatrix3x2fv uniformMatrix3x4fv uniformMatrix4x2fv uniformMatrix4x3fv uniformBlockBinding transformFeedbackVaryings vertexAttribIPointer vertexAttribI4i vertexAttribI4iv vertexAttribI4ui vertexAttribI4uiv")
	out := make(map[string]bool, len(methods))
	for _, method := range methods {
		out[method] = true
	}
	return out
}()

var goCanvasGL2Methods = func() map[string]bool {
	methods := strings.Fields("bindBufferBase bindBufferRange bindSampler bindTransformFeedback bindVertexArray beginQuery beginTransformFeedback blitFramebuffer clearBufferfi clearBufferfv clearBufferiv clearBufferuiv compressedTexImage3D compressedTexSubImage3D copyBufferSubData copyTexSubImage3D createQuery createSampler createTransformFeedback createVertexArray deleteQuery deleteSampler deleteTransformFeedback deleteVertexArray drawArraysInstanced drawBuffers drawElementsInstanced drawRangeElements endQuery endTransformFeedback framebufferTextureLayer getFragDataLocation enableiOES disableiOES blendEquationiOES blendEquationSeparateiOES blendFunciOES blendFuncSeparateiOES colorMaskiOES getQuery getQueryParameter invalidateFramebuffer invalidateSubFramebuffer pauseTransformFeedback queryCounter readBuffer renderbufferStorageMultisample resumeTransformFeedback samplerParameterf samplerParameteri texImage3D texStorage2D texStorage3D texSubImage3D transformFeedbackVaryings uniform1ui uniform1uiv uniform2ui uniform2uiv uniform3ui uniform3uiv uniform4ui uniform4uiv uniformBlockBinding uniformMatrix2x3fv uniformMatrix2x4fv uniformMatrix3x2fv uniformMatrix3x4fv uniformMatrix4x2fv uniformMatrix4x3fv vertexAttribDivisor vertexAttribIPointer vertexAttribI4i vertexAttribI4iv vertexAttribI4ui vertexAttribI4uiv")
	out := make(map[string]bool, len(methods))
	for _, method := range methods {
		out[method] = true
	}
	return out
}()

var goCanvasGLExtensionMethods = map[string]string{
	"createVertexArray": "OES_vertex_array_object", "bindVertexArray": "OES_vertex_array_object", "deleteVertexArray": "OES_vertex_array_object",
	"drawArraysInstanced": "ANGLE_instanced_arrays|WEBGL_multi_draw", "drawElementsInstanced": "ANGLE_instanced_arrays|WEBGL_multi_draw", "vertexAttribDivisor": "ANGLE_instanced_arrays", "drawBuffers": "WEBGL_draw_buffers",
}

// goCanvasGLExtensionCommands are an extension's own calls (not WebGL2's
// under another name): refused unless it's turned on, in either version
// (go-frame-gl.js's extensionCommandMethods).
var goCanvasGLExtensionCommands = map[string]string{
	"enableiOES": "OES_draw_buffers_indexed", "disableiOES": "OES_draw_buffers_indexed", "blendEquationiOES": "OES_draw_buffers_indexed", "blendEquationSeparateiOES": "OES_draw_buffers_indexed",
	"blendFunciOES": "OES_draw_buffers_indexed", "blendFuncSeparateiOES": "OES_draw_buffers_indexed", "colorMaskiOES": "OES_draw_buffers_indexed",
	"polygonModeWEBGL": "WEBGL_polygon_mode",
}

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
const goGLStreamsMax = 16

// goCanvasGLExtensions are the extensions the mirror replays (gogl.js's
// supportedExtensions, go-frame-gl.js's glExtensionList).
var goCanvasGLExtensions = func() map[string]bool {
	out := map[string]bool{}
	for _, name := range strings.Fields("OES_element_index_uint OES_standard_derivatives WEBGL_depth_texture OES_texture_float OES_texture_float_linear OES_texture_half_float OES_texture_half_float_linear EXT_color_buffer_float EXT_color_buffer_half_float EXT_float_blend OES_draw_buffers_indexed WEBGL_polygon_mode EXT_texture_filter_anisotropic EXT_disjoint_timer_query EXT_disjoint_timer_query_webgl2 OES_vertex_array_object ANGLE_instanced_arrays WEBGL_draw_buffers WEBGL_multi_draw WEBGL_compressed_texture_s3tc WEBGL_compressed_texture_s3tc_srgb WEBGL_compressed_texture_etc WEBGL_compressed_texture_etc1 WEBGL_compressed_texture_pvrtc WEBGL_compressed_texture_atc WEBGL_compressed_texture_astc EXT_texture_compression_bptc EXT_texture_compression_rgtc") {
		out[name] = true
	}
	return out
}()

// goCanvasGL2Extensions are those only WebGL2 has (gogl.js's
// extensionSupported).
var goCanvasGL2Extensions = map[string]bool{"EXT_color_buffer_float": true, "OES_draw_buffers_indexed": true}

// goCanvasGLStringMethods take a string argument; goCanvasGLSequenceMethod
// says which take a sequence (uniform*v and the like).
var goCanvasGLStringMethods = map[string]bool{"shaderSource": true, "getExtension": true, "bindAttribLocation": true, "getUniformLocation": true, "getAttribLocation": true, "getFragDataLocation": true, "transformFeedbackVaryings": true}

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
			n.glStream, n.CanvasGL, n.CanvasGLW, n.CanvasGLH, n.CanvasGLR, n.CanvasGLV, n.CanvasGLA = nil, "", 0, 0, false, 0, 0
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
	ok := op.V != nil && op.Attributes >= 0 && op.Attributes <= 63
	if ok && !op.R {
		prior = seen.glStream(op.I)
		ok = prior != nil
	}
	if _, known := seen.glStreamOK(op.I); ok && op.R && !known && seen.glFull() {
		ok = false // one WebGL canvas too many
	}
	var stream *goGLStream
	if ok {
		stream, ok = goCanvasGLCheck(*op.V, op.W, op.H, op.Version, prior)
	}
	if ok && seen != nil && seen.gl != nil {
		seen.gl[op.I] = stream
	}
	if ok {
		return goCanvasOp(map[string]any{"o": "g", "i": op.I, "v": *op.V, "w": op.W, "h": op.H, "r": op.R, "version": op.Version, "attributes": op.Attributes}, op.Path)
	}
	if seen != nil && seen.gl != nil {
		delete(seen.gl, op.I)
	}
	return goCanvasOp(map[string]any{"o": "p", "i": op.I, "v": "", "pe": "unsupported"}, op.Path)
}
