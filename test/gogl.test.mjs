// The WebGL recorder (tabtopd/gogl.js) in a stand-in for Moli's page: a
// WebGL2 context with only some methods of its own and no constants, as
// Moli's is. Checks what the page is told (reflection from the shaders'
// source, attribute locations, constants) and the log the agent reads.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

// As gobrowser.go puts it in the page (goGLPageJS): the calls and
// extensions recorded, the constants and the reading of shaders' source,
// then the hook, in one function.
const file = (name) => readFileSync(new URL(`../tabtopd/${name}`, import.meta.url), "utf8");
const source = "(() => {\n" + file("gogl-surface.js") + "\n" + file("gogl-enums.js") + "\n" + file("goglsl.js") + "\n" + file("gogl.js") + "\n})();\n";

function page() {
    const context = vm.createContext({ btoa, atob, Promise, Symbol, Math, JSON, Number, String, Array, Object, Reflect, Map, Set, WeakMap, WeakSet, Error, ArrayBuffer, Uint8Array, Uint16Array, Int32Array, Float32Array, Uint8ClampedArray, DataView });
    vm.runInContext(`
        class EventTarget {
            addEventListener(type, f) { ((this.__l ||= {})[type] ||= []).push(f); }
            dispatchEvent(event) {
                event.target = this;
                for (const at of this === document ? [document] : [this, document]) for (const f of at.__l?.[event.type] ?? []) f.call(at, event);
                return true;
            }
        }
        class Event { constructor(type, init = {}) { this.type = type; this.bubbles = !!init.bubbles; } preventDefault() {} }
        class CustomEvent extends Event { constructor(type, init = {}) { super(type, init); this.detail = init.detail; } }
        class WebGLRenderingContext {
            constructor(canvas) { this.canvas = canvas; }
            getContextAttributes() { return { alpha: true, depth: true, stencil: false, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: false }; }
            createShader() { return {}; }
            createProgram() { return {}; }
            createBuffer() { return {}; }
            getUniformLocation() { return {}; }
            getProgramParameter() { return null; }
            // Engines may return empty identity strings; /go overrides these.
            getParameter() { return ""; }
        }
        class WebGL2RenderingContext {
            constructor(canvas) { this.canvas = canvas; }
            getContextAttributes() { return { alpha: true, depth: true, stencil: false, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: false }; }
            createShader() { return {}; }
            createProgram() { return {}; }
            createBuffer() { return {}; }
            getUniformLocation() { return {}; }
            getProgramParameter() { return null; }
            getParameter() { return ""; }
        }
        class HTMLCanvasElement extends EventTarget {
            constructor() { super(); this.width = 300; this.height = 150; }
            getContext(kind) {
                if (kind === "webgl2") return this.gl2 ||= new WebGL2RenderingContext(this);
                if (kind === "webgl" || kind === "experimental-webgl") return this.gl1 ||= new WebGLRenderingContext(this);
                return null;
            }
        }
        const document = new EventTarget();
        document.createElement = () => new HTMLCanvasElement();
        globalThis.document = document;
        // The window: events on its document's nodes reach it after the document.
        globalThis.addEventListener = (type, f, options) => document.addEventListener(type, f, options);
        Object.assign(globalThis, { EventTarget, Event, CustomEvent, WebGLRenderingContext, WebGL2RenderingContext, HTMLCanvasElement });
    `, context);
    vm.runInContext(source, context);
    // read is what the agent gets for the canvas: the log, whole or since
    // the last read; undo gives that back.
    const read = (canvas, how = "delta") => {
        let reply;
        context.document.addEventListener("__tabtop_canvas_pixels", (e) => { if (e.target === canvas) reply = JSON.parse(e.detail); });
        canvas.dispatchEvent(new context.CustomEvent("__tabtop_webgl_capture", { bubbles: true, detail: how }));
        return reply;
    };
    const undo = (canvas, how = "delta") => canvas.dispatchEvent(new context.CustomEvent("__tabtop_webgl_undo", { bubbles: true, detail: how }));
    return { context, read, undo };
}

const vertex = `#version 300 es
#define attribute in
#define NUM_LIGHTS 2
precision highp float;
uniform mat4 projectionMatrix; // a comment
uniform mat4 modelViewMatrix, unusedMatrix;
struct Light { vec3 direction; vec3 color; };
#if NUM_LIGHTS > 0
uniform Light lights[ NUM_LIGHTS ];
#endif
#ifdef USE_MAP
uniform sampler2D map;
#else
uniform vec4 tint;
#endif
attribute vec3 position;
layout(location = 5) in vec2 uv;
in mat4 instanceMatrix;
uniform Block { mat4 m; } block;
vec3 f(in vec3 x) { return x; }
void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const fragment = `#version 300 es
precision highp float;
in vec2 vUv;
uniform vec4 tint;
uniform sampler2D shadows[3];
out vec4 color;
void main() { color = tint; }`;

test("the hook's constants and shader reading are its own, not the page's", () => {
    const { context } = page();
    for (const name of ["glSurface", "enums", "gl2Enums", "standardEnums1", "standardEnums2", "glslTypes", "glslValue", "glslActive", "glslDeclared"]) {
        assert.equal(vm.runInContext(`typeof ${name}`, context), "undefined", name);
    }
});

test("VENDOR and RENDERER are fixed WebKit-like strings for WebGL1 and WebGL2", () => {
    const { context } = page();
    for (const kind of ["webgl", "webgl2"]) {
        const gl = new context.HTMLCanvasElement().getContext(kind);
        assert.ok(gl, kind);
        assert.equal(gl.getParameter(gl.VENDOR), "WebKit", kind);
        assert.equal(gl.getParameter(gl.RENDERER), "WebKit WebGL", kind);
    }
});

test("a program is reflected from its shaders' source, as a browser would report it", () => {
    const { context } = page();
    const gl = new context.HTMLCanvasElement().getContext("webgl2");
    assert.equal(gl.ACTIVE_UNIFORMS, 0x8B86, "standard constants filled in");
    assert.equal(context.WebGL2RenderingContext.FLOAT_MAT4, 0x8B5C, "on the constructor too");
    const program = gl.createProgram();
    for (const [type, text] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]]) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, text);
        gl.compileShader(shader);
        gl.attachShader(program, shader);
    }
    gl.bindAttribLocation(program, 0, "position");
    gl.linkProgram(program);
    const uniforms = Array.from({ length: gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) }, (_, i) => gl.getActiveUniform(program, i));
    assert.deepEqual(uniforms.map((u) => [u.name, u.type, u.size]), [
        ["projectionMatrix", gl.FLOAT_MAT4, 1], ["modelViewMatrix", gl.FLOAT_MAT4, 1], ["unusedMatrix", gl.FLOAT_MAT4, 1],
        ["lights[0].direction", gl.FLOAT_VEC3, 1], ["lights[0].color", gl.FLOAT_VEC3, 1], ["lights[1].direction", gl.FLOAT_VEC3, 1], ["lights[1].color", gl.FLOAT_VEC3, 1],
        ["tint", gl.FLOAT_VEC4, 1], ["shadows[0]", gl.SAMPLER_2D, 3],
    ]);
    const attributes = Array.from({ length: gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES) }, (_, i) => gl.getActiveAttrib(program, i).name);
    assert.deepEqual(attributes, ["position", "uv", "instanceMatrix"], "a fragment shader's inputs aren't attributes");
    // Bound, by layout, then the first free ones (a mat4 takes four).
    assert.deepEqual(["position", "uv", "instanceMatrix", "vUv"].map((n) => gl.getAttribLocation(program, n)), [0, 5, 1, -1]);
    assert.equal(gl.getProgramParameter(program, gl.ATTACHED_SHADERS), 2);
    assert.equal(gl.getProgramParameter(program, gl.LINK_STATUS), true);
});

test("the log carries attributes by name, and a delta the agent couldn't send is read again", () => {
    const { context, read, undo } = page();
    const canvas = new context.HTMLCanvasElement();
    const gl = canvas.getContext("webgl2");
    const program = gl.createProgram();
    const shader = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(shader, "attribute vec2 a; attribute vec2 p; void main() { gl_Position = vec4(p, a); }");
    gl.compileShader(shader);
    gl.attachShader(program, shader);
    gl.linkProgram(program);
    gl.useProgram(program);
    const at = gl.getAttribLocation(program, "p");
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.enableVertexAttribArray(at);
    gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const full = read(canvas, "full");
    assert.equal(full.gl?.r, true);
    const log = JSON.parse(full.gl?.v);
    const pointer = log.find((c) => c.m === "vertexAttribPointer");
    assert.deepEqual(pointer.a[0], { location: "p", program: log.find((c) => c.m === "createProgram").r });
    assert.equal(log.find((c) => c.m === "getAttribLocation").name, "p");

    gl.disableVertexAttribArray(at);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const delta = read(canvas);
    assert.equal(delta.gl?.r, false);
    assert.deepEqual(JSON.parse(delta.gl?.v).map((c) => c.m), ["disableVertexAttribArray", "drawArrays"]);
    undo(canvas);
    assert.equal(read(canvas).gl?.v, delta.gl?.v, "given back, the same calls are read again");
    assert.equal(read(canvas).gl?.v, "[]");
    undo(canvas, "full");
    assert.equal(read(canvas).gl?.r, true, "a whole log given back is sent whole");
});

test("an extension the mirror can't replay is refused to the page, not fatal", () => {
    const { context, read } = page();
    const canvas = new context.HTMLCanvasElement();
    const gl = canvas.getContext("webgl2");
    assert.equal(gl.getExtension("WEBGL_debug_renderer_info"), null);
    assert.ok(!gl.getSupportedExtensions().includes("WEBGL_debug_renderer_info"));
    gl.clear(gl.COLOR_BUFFER_BIT);
    assert.ok(read(canvas, "full").gl?.v, "the canvas is still mirrored");
    gl.finish();
    gl.flush();
});

test("a render loop binding its texture and buffer each frame is compacted, not given up", () => {
    const { context, read } = page();
    const canvas = new context.HTMLCanvasElement();
    const gl = canvas.getContext("webgl2");
    const texture = gl.createTexture(), buffer = gl.createBuffer();
    read(canvas, "full");
    for (let frame = 0; frame < 3000; frame++) {
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        const got = read(canvas);
        assert.ok(!got?.e, `given up at frame ${frame}: ${got?.e}`);
    }
});

test("compaction keeps the binds what's kept after them needs", () => {
    const { context, read } = page();
    const canvas = new context.HTMLCanvasElement();
    const gl = canvas.getContext("webgl2");
    const a = gl.createTexture(), b = gl.createTexture();
    read(canvas, "full");
    gl.bindTexture(gl.TEXTURE_2D, a);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));  // into a
    for (let frame = 0; frame < 2000; frame++) {
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.bindTexture(gl.TEXTURE_2D, frame % 2 ? a : b);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        read(canvas);
    }
    const log = JSON.parse(read(canvas, "full").gl?.v);
    const upload = log.findIndex((c) => c.m === "texImage2D");
    assert.ok(upload > 0, "the upload lost");
    const before = log.slice(0, upload).filter((c) => c.m === "bindTexture").at(-1);
    assert.equal(before?.a[1]?.ref, log.find((c) => c.m === "createTexture").r, "the upload's texture bind lost");
    const binds = log.filter((c) => c.m === "bindTexture").length;
    assert.ok(binds < 1000, `binds not compacted: ${binds} of 2001 kept`);
});

test("compaction doesn't keep a copy of the canvas without the draws it copied (a feedback effect)", () => {
    const { context, read } = page();
    const canvas = new context.HTMLCanvasElement();
    const gl = canvas.getContext("webgl2");
    const trail = gl.createTexture();
    read(canvas, "full");
    gl.bindTexture(gl.TEXTURE_2D, trail);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 300, 150, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    for (let frame = 0; frame < 3000; frame++) {
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, 3);                         // (sampling the trail)
        gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, 300, 150);  // the frame into the trail
        const got = read(canvas);
        if (got?.e) return;                                         // given up: shown as unsupported, not wrong
        if (frame % 100 !== 99) continue;
        const log = JSON.parse(read(canvas, "full").gl?.v);
        read(canvas);
        let drawn = false;
        for (const c of log) {
            if (c.m === "clear") drawn = false;
            else if (c.m === "drawArrays") drawn = true;
            else if (c.m === "copyTexSubImage2D") assert.ok(drawn, `frame ${frame}: a copy kept without the draws it read`);
        }
    }
});

test("a copy from another framebuffer (once, at start) doesn't stop the canvas's compaction", () => {
    const { context, read } = page();
    const canvas = new context.HTMLCanvasElement();
    const gl = canvas.getContext("webgl2");
    const texture = gl.createTexture(), fbo = gl.createFramebuffer();
    read(canvas, "full");
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 0, 0, 16, 16, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    for (let frame = 0; frame < 3000; frame++) {
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        const got = read(canvas);
        assert.ok(!got?.e, `given up at frame ${frame}: ${got?.e}`);
    }
});
