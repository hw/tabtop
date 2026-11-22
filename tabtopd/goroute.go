package main

// The remote browser's tunnel route, "go" (see docs/browser-plan.md,
// sections 4 and 6). One tunnel is one browsing context: its own engine
// (goengine.go), started for it and killed when it closes, as it does when
// the page closes it, the session ends or logs out, or the server stops.
// What goes over it, both ways, is gobrowser.go's.
//
// The page sends JSON text:
//
//	{"op":"navigate","url":...,"view":{"w":...,"h":...,"dpr":...}}  {"op":"stop"}
//	{"op":"viewport","view":{...}}  the frame's size, orientation or colour scheme changed: the engine follows
//	{"op":"event","gen":N,"kind":"click"|"input"|"change"|"key"|"submit"|"focus","id":...}
//	{"op":"event","gen":N,"kind":"mouse","type":"down"|"up"|"move"|"wheel"|"cancel","id":...,"fx":...,"fy":...,...}
//	{"op":"event","gen":N,"kind":"key","type":"down"|"up","id":...,"key":...,"code":...,"keyCode":...}  (goinput.go)
//	{"op":"dialog","accept":...,"text":...}  {"op":"resync","gen":N}
//
// and the server answers, for each generation (a navigation, the person's
// or the page's):
//
//	{"type":"go-loading","gen":N,"url":...,"by":"you"|"page"}
//	{"type":"go-snapshot","gen":N,"url":final,"base":...,"title":...,"doc":tree,"again":bool}
//	{"type":"go-changes","gen":N,"seq":K,"title":...,"ops":[...]}
//	{"type":"go-url","gen":N,"url":...}         the page changed its address itself
//	{"type":"go-dialog","gen":N,"kind":...,"message":...,"default":...,"url":...}
//	{"type":"go-file","gen":N,"url":...,"mime":...}  a file, not a page
//	{"type":"go-error","gen":N,"message":...}
//
// A snapshot's nodes are {"i":id,"t":type,"n":name,"v":text,"a":[name,
// value,...],"c":[...]}, read by the agent (goagent.js) in an isolated
// world, with what can never be shown left out (scripts, noscript,
// templates, comments, event handler attributes), again here (goClean). It's
// still the page's, so the page that shows it sanitizes it again, and loads
// nothing from the web itself.
import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image/png"
	"log"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	// Engines (browsing contexts) open at once, for a session and in all.
	maxGoPerSession = 6
	maxGoEngines    = 12
	// goClientMessage is the largest message the page may send: a URL.
	goClientMessage = 64 << 10
	maxGoURL        = 8 << 10
	// goSnapshotLimit is the largest snapshot sent; a bigger page is an
	// error, not a partial one.
	goSnapshotLimit = 16 << 20
	// goLoadTimeout is how long a page has to load before what's there is
	// shown anyway.
	goLoadTimeout = 30 * time.Second
	goCallTimeout = 15 * time.Second
)

// openGo counts an engine for session, unless that's too many.
func (g *server) openGo(session string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.goEngines == nil {
		g.goEngines = map[string]int{}
	}
	total := 0
	for _, n := range g.goEngines {
		total += n
	}
	if total >= maxGoEngines || g.goEngines[session] >= maxGoPerSession {
		return false
	}
	g.goEngines[session]++
	return true
}

func (g *server) closeGo(session string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.goEngines[session]--; g.goEngines[session] <= 0 {
		delete(g.goEngines, session)
	}
}

func (g *server) routeGo(c *tunnelCall) {
	switch {
	case !g.goOn:
		c.r.fail("The remote browser is turned off (WEB_GO=0).")
		return
	case g.goMode == goUnavailable:
		c.r.fail("The remote browser is unavailable: " + g.goWhy + ".")
		return
	}
	c.t.c.SetReadLimit(goClientMessage + tunnelOverhead)
	sandboxed := g.goMode == goSandboxed
	// A tab kept while its connection was lost (goresume.go), its token
	// brought back from the same session: taken back as it is. (A token
	// of a tab gone, or another session's: a new tab, as before.)
	tabs := g.goTabList()
	if t := tabs.find(c.req.Resume, c.session); t != nil {
		if !c.r.accept(map[string]any{"sandboxed": sandboxed, "resume": t.token, "resumed": true}) {
			return
		}
		logGoTab("taken back", c.ip)
		if t.lend(newGoLink(c.t, c.req.Deflate), true) {
			logGoTab("connection gone", c.ip)
		}
		return
	}
	// At the limit: a tab no one's connected to makes way (the one let go
	// longest ago), as it would have closed at once before tabs were kept.
	if !g.openGo(c.session) && !(tabs.makeRoom(c.session) && g.openGo(c.session)) {
		c.r.fail("Too many remote browser tabs are open.")
		return
	}
	e, err := startGoEngine(g.goConfig)
	if err != nil {
		g.closeGo(c.session)
		log.Printf("go: engine for %s: %v", c.ip, err)
		c.r.fail("The remote browser's engine didn't start.")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
	cdp, err := dialCDP(ctx, e)
	var page, target string
	if err == nil {
		page, target, err = cdp.newPageTarget(ctx)
	}
	for _, m := range []string{"Page.enable", "Runtime.enable", "Network.enable"} {
		if err == nil {
			err = cdp.call(ctx, page, m, nil, nil)
		}
	}
	cancel()
	if err != nil {
		if cdp != nil {
			cdp.close()
		}
		e.kill("its tab didn't start")
		g.closeGo(c.session)
		log.Printf("go: engine for %s: %v", c.ip, err)
		c.r.fail("The remote browser's engine didn't start.")
		return
	}
	b := newGoBrowser(e, cdp, page, target)
	onAd := b.adCounted
	e.proxy.onAd.Store(&onAd)    // counted for the page (goadblock.go)
	e.proxy.certs.Store(b.certs) // its certificate exceptions' guard (gocert.go)
	b.resources, b.session = g.goResources, c.session
	// The account's cookies, given before anything's loaded; what the
	// tab's sites set taken back as it closes (gocookies.go).
	b.jar, b.storage = g.goCookies, g.goStorage
	b.sites = g.goSites
	t := &goTab{token: goToken(), session: c.session, b: b, ended: make(chan struct{})}
	tabs.add(t) // the token can be used as soon as the reply arrives
	if !c.r.accept(map[string]any{"sandboxed": sandboxed, "resume": t.token}) {
		tabs.remove(t)
		close(t.ended)
		cdp.close()
		e.kill("its tab was closed")
		g.closeGo(c.session)
		return
	}
	log.Printf("go: remote browser tab from %s opened (%s)", c.ip, g.goMode)
	go g.runGoTab(t, tabs, c.ip)
	if t.lend(newGoLink(c.t, c.req.Deflate), false) {
		logGoTab("connection gone", c.ip)
	}
}

// runGoTab runs a tab, from its first connection till it ends: closed,
// its engine gone, its session ended, or not taken back in time.
func (g *server) runGoTab(t *goTab, tabs *goTabs, ip string) {
	b, e := t.b, t.b.e
	defer close(t.ended)
	defer tabs.remove(t)
	defer g.closeGo(t.session)
	defer e.kill("its tab was closed")
	defer b.cdp.close()
	defer g.abortMSEStages(t.token)
	defer goPruneCacheSoon(g.goConfig.cache) // what it added, kept to size
	if dir := g.goConfig.cache; dir != "" {
		// And while it runs: a tab kept open for hours adds to it too.
		prune := time.NewTicker(goCacheEvery)
		done := make(chan struct{})
		defer func() { prune.Stop(); close(done) }()
		go func() {
			for {
				select {
				case <-prune.C:
					goPruneCacheSoon(dir)
				case <-done:
					return
				}
			}
		}()
	}
	ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
	b.startStorage(ctx)
	cancel()
	ctx, cancel = context.WithTimeout(context.Background(), goCallTimeout)
	b.startUA(ctx)
	b.startCookies(ctx)
	cancel()
	defer b.endCookies()
	defer b.endStorage()
	b.run()
	log.Printf("go: remote browser tab from %s closed", ip)
}

// goURL checks a URL the page asked for: HTTP or HTTPS, with a host and no
// credentials. Where it may go is the egress proxy's to decide.
func goURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if len(raw) > maxGoURL {
		return "", errors.New("That address is too long.")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.Scheme != "http" && u.Scheme != "https" {
		return "", errors.New("Enter an address starting with http:// or https://.")
	}
	if u.User != nil {
		return "", errors.New("Addresses with a user name or password aren't supported.")
	}
	return u.String(), nil
}

// goNavError is what the page is told when a navigation fails.
func goNavError(err error) string {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "ERR_FAILED"), strings.Contains(msg, "ERR_TUNNEL"), strings.Contains(msg, "ERR_PROXY"):
		return "The page couldn't be loaded: the site can't be reached from here, or the server doesn't allow that address."
	case errors.Is(err, context.DeadlineExceeded):
		return "The page took too long to load."
	}
	return "The page couldn't be loaded (" + msg + ")."
}

// goNode is a node of a snapshot.
type goNode struct {
	ID        int         `json:"i"`
	Type      int         `json:"t"`
	Name      string      `json:"n,omitempty"`
	Value     string      `json:"v,omitempty"`
	Base      string      `json:"b,omitempty"` // base URL of an embedded document
	FrameDoc  int         `json:"f,omitempty"` // identity of a separately read iframe document
	CanvasPNG string      `json:"p,omitempty"` // bounded Canvas2D PNG, base64
	CanvasGL  string      `json:"g,omitempty"` // bounded WebGL command log, JSON
	CanvasGLW int         `json:"gw,omitempty"`
	CanvasGLH int         `json:"gh,omitempty"`
	CanvasGLR bool        `json:"gr,omitempty"`
	CanvasGLV int         `json:"gv,omitempty"`
	CanvasGLA int         `json:"ga,omitempty"` // context attributes bitmask plus one; zero means absent
	CanvasErr string      `json:"pe,omitempty"` // why the canvas has no readable pixels
	glStream  *goGLStream // the WebGL log's state, for the deltas after it
	Attrs     []string    `json:"a,omitempty"`
	Kids      []*goNode   `json:"c,omitempty"`
}

const (
	goCanvasPNGMax    = 1 << 20
	goCanvasPixelsMax = 16 << 20
	goCanvasSizeMax   = 4096
	goCanvasGLMax     = 4 << 20
	goCanvasGLOpsMax  = 4096
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
	"enableiOES": "OES_draw_buffers_indexed", "disableiOES": "OES_draw_buffers_indexed", "blendEquationiOES": "OES_draw_buffers_indexed", "blendEquationSeparateiOES": "OES_draw_buffers_indexed", "blendFunciOES": "OES_draw_buffers_indexed", "blendFuncSeparateiOES": "OES_draw_buffers_indexed", "colorMaskiOES": "OES_draw_buffers_indexed",
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
				return err == nil && len(decoded) <= 2<<20
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
// supportedExtensions, go-frame.js's glExtensionList).
var goCanvasGLExtensions = func() map[string]bool {
	out := map[string]bool{}
	for _, name := range strings.Fields("OES_element_index_uint OES_standard_derivatives WEBGL_depth_texture OES_texture_float OES_texture_float_linear OES_texture_half_float OES_texture_half_float_linear EXT_color_buffer_float EXT_color_buffer_half_float EXT_float_blend OES_draw_buffers_indexed WEBGL_polygon_mode EXT_texture_filter_anisotropic EXT_disjoint_timer_query EXT_disjoint_timer_query_webgl2 OES_vertex_array_object ANGLE_instanced_arrays WEBGL_draw_buffers WEBGL_multi_draw WEBGL_compressed_texture_s3tc WEBGL_compressed_texture_s3tc_srgb WEBGL_compressed_texture_etc WEBGL_compressed_texture_etc1 WEBGL_compressed_texture_pvrtc WEBGL_compressed_texture_atc WEBGL_compressed_texture_astc EXT_texture_compression_bptc EXT_texture_compression_rgtc") {
		out[name] = true
	}
	return out
}()

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
		if strings.HasSuffix(command.Method, "iOES") && (version != 2 || !extensions["OES_draw_buffers_indexed"]) {
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
			// one: only the calls that take them may have them (go-frame.js's
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
			if version == 1 && (extension == "EXT_color_buffer_float" || extension == "OES_draw_buffers_indexed") {
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

// goCanvasPNGValid accepts only a bounded, decodable PNG. Canvas messages
// originate in the page's main world and are untrusted like the DOM tree.
func goCanvasPNGValid(encoded string) bool {
	if encoded == "" || len(encoded) > goCanvasPNGMax || len(encoded)%4 != 0 {
		return false
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(raw) > goCanvasPNGMax {
		return false
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(raw))
	if err != nil || cfg.Width < 1 || cfg.Height < 1 || cfg.Width > goCanvasSizeMax || cfg.Height > goCanvasSizeMax {
		return false
	}
	return int64(cfg.Width)*int64(cfg.Height) <= goCanvasPixelsMax
}

func goCanvasError(reason string) string {
	switch reason {
	case "tainted", "large", "unsupported", "unavailable":
		return reason
	default:
		return "unavailable"
	}
}

// goDropped are elements a snapshot leaves out, with all inside them:
// scripts have run in the engine already, noscript is for when they
// don't, and a template's content isn't the page's.
var goDropped = map[string]bool{"script": true, "noscript": true, "template": true}

// goClean takes out of a snapshot, again, what the serializer leaves out:
// elements that can never be shown and event handler attributes. (The page
// that shows the snapshot sanitizes it a third time.)
func goClean(n *goNode) *goNode {
	if n == nil {
		return nil
	}
	switch n.Type {
	case 1:
		n.Base = ""
		if goDropped[strings.ToLower(n.Name)] {
			return nil
		}
		if strings.EqualFold(n.Name, "canvas") {
			n.glStream = nil
			if n.CanvasGL != "" {
				stream, ok := goCanvasGLCheck(n.CanvasGL, n.CanvasGLW, n.CanvasGLH, n.CanvasGLV, nil)
				n.glStream = stream
				if !ok || n.CanvasGLA < 1 || n.CanvasGLA > 64 {
					n.glStream = nil
					n.CanvasGL = ""
					n.CanvasGLA = 0
					n.CanvasErr = "unsupported"
				}
				n.CanvasPNG = ""
			} else if n.CanvasPNG != "" && !goCanvasPNGValid(n.CanvasPNG) {
				n.CanvasPNG = ""
				n.CanvasErr = "unavailable"
			}
			if n.CanvasPNG == "" && n.CanvasGL == "" {
				n.CanvasErr = goCanvasError(n.CanvasErr)
			} else if n.CanvasPNG != "" || n.CanvasGL != "" {
				n.CanvasErr = ""
			}
		} else {
			n.CanvasPNG, n.CanvasGL, n.CanvasGLW, n.CanvasGLH, n.CanvasGLR, n.CanvasGLV, n.CanvasGLA, n.CanvasErr = "", "", 0, 0, false, 0, 0, ""
		}
		var attrs []string
		for i := 0; i+1 < len(n.Attrs); i += 2 {
			if !strings.HasPrefix(strings.ToLower(n.Attrs[i]), "on") {
				attrs = append(attrs, n.Attrs[i], n.Attrs[i+1])
			}
		}
		n.Attrs = attrs
		n.Value = ""
	case 3:
		n.Name, n.Attrs, n.Kids = "", nil, nil
		n.Base = ""
		return n
	case 9, 11:
		n.Name, n.Value, n.Attrs = "", "", nil
		// An embedded page's base, which its addresses resolve against:
		// an http(s) one, or none.
		if u, err := goURL(n.Base); n.Type != 9 || err != nil {
			n.Base = ""
		} else {
			n.Base = u
		}
	default:
		return nil
	}
	kids := n.Kids[:0]
	for _, k := range n.Kids {
		if c := goClean(k); c != nil {
			kids = append(kids, c)
		}
	}
	n.Kids = kids
	return n
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

// goTitleOf is the title a snapshot gives, made one line.
func goTitleOf(title string) string { return strings.Join(strings.Fields(title), " ") }

// goOwnerFile names, in an engine's run directory, the tabtopd it's for.
const goOwnerFile = "owner"

// sweepGoRunDirs removes run directories (tabtop-go-*) left by a tabtopd
// that's gone: killed, say, before it could remove them. Those of a
// tabtopd still running, this one included, are left alone.
func sweepGoRunDirs() {
	dirs, _ := filepath.Glob(filepath.Join(os.TempDir(), "tabtop-go-*"))
	for _, dir := range dirs {
		b, err := os.ReadFile(filepath.Join(dir, goOwnerFile))
		if err != nil {
			// Without an owner: one being made, unless it's old.
			if fi, err := os.Stat(dir); err != nil || time.Since(fi.ModTime()) < time.Hour {
				continue
			}
		} else if pid, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil {
			if err := syscall.Kill(pid, 0); pid == os.Getpid() || err == nil || errors.Is(err, syscall.EPERM) {
				continue
			}
		}
		os.RemoveAll(dir)
	}
}
