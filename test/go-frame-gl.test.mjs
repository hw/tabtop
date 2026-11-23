// The viewer's WebGL replay (tabtopd/go-frame-gl.js): its bounds on what a
// page's log may ask of this browser's GPU (glCheck), checked before each
// call, and the replay itself, on a stand-in for a canvas's WebGL context.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../tabtopd/go-frame-gl.js", import.meta.url), "utf8");
// A replay of its own, with what the copy gives it (host) and a clock.
function makeGL({ host = {}, now = () => 0 } = {}) {
    const scope = {};
    new Function("globalThis", "performance", source)(scope, { now });
    return scope.goFrameGL({ current: () => 1, drawn2D: () => false, replaceCanvas: (d, el) => el, ...host });
}
const { glCheck, glLimits } = makeGL();
const replay = (commands) => { const mirror = {}; for (const [m, ...a] of commands) glCheck(mirror, { m, a }); return mirror; };
const tex = [["createTexture"], ["bindTexture", 0x0DE1, { ref: 1 }]];

test("allocations past the bounds are refused", () => {
    for (const commands of [
        [["bindBuffer", 0x8892, { ref: 1 }], ["bufferData", 0x8892, 1 << 30, 0x88E4]],
        [...tex, ["texStorage2D", 0x0DE1, 1, 0x8058, 8192, 8192]],
        [...tex, ["texStorage2D", 0x0DE1, 15, 0x8058, 1024, 1024]],
        [...tex, ["texImage2D", 0x0DE1, 0, 0x1908, 16384, 16, 0, 0x1908, 0x1401, null]],
        [...tex, ["texImage3D", 0x8C1A, 0, 0x8058, 2048, 2048, 2048, 0, 0x1908, 0x1401, null]],
        [["bindRenderbuffer", 0x8D41, { ref: 1 }], ["renderbufferStorageMultisample", 0x8D41, 64, 0x8058, 256, 256]],
        [["drawArrays", 4, 0, 2 ** 31 - 1]],
        [["drawArraysInstanced", 4, 0, 3, 2 ** 31 - 1]],
        [["getExtension", "WEBGL_lose_context"]],
        // Sizes WebGL would take from a string or an array.
        [["bindBuffer", 0x8892, { ref: 1 }], ["bufferData", 0x8892, "1073741824", 0x88E4]],
        [["bindBuffer", 0x8892, { ref: 1 }], ["bufferData", 0x8892, [1 << 30], 0x88E4]],
        // Storage counted to whatever's bound: by bindBufferBase, or the vertex array's own element buffer; none, refused.
        [["bufferData", 0x8892, 1 << 20, 0x88E4]],
        [["bindBuffer", 0x8893, { ref: 1 }], ["createVertexArray"], ["bindVertexArray", { ref: 2 }], ["bufferData", 0x8893, 1 << 20, 0x88E4]],
    ]) assert.throws(() => replay(commands), Error, JSON.stringify(commands.at(-1)));
});

test("what a context holds at once is bounded, counting storage given again once", () => {
    // 4096² RGBA8 is 64 MiB: given again to the same texture, it's still 64.
    const again = [...tex];
    for (let i = 0; i < 20; i++) again.push(["texImage2D", 0x0DE1, 0, 0x1908, 4096, 4096, 0, 0x1908, 0x1401, null]);
    assert.equal(replay(again).budget.total, 64 << 20);
    // Five textures of it each are 320 MiB, past the context's 256.
    const many = [];
    for (let i = 1; i <= 5; i++) many.push(["bindTexture", 0x0DE1, { ref: i }], ["texImage2D", 0x0DE1, 0, 0x1908, 4096, 4096, 0, 0x1908, 0x1401, null]);
    assert.throws(() => replay(many), /budget/);
    // Deleted, its storage is given back.
    const freed = [];
    for (let i = 1; i <= 5; i++) freed.push(["bindTexture", 0x0DE1, { ref: i }], ["texImage2D", 0x0DE1, 0, 0x1908, 4096, 4096, 0, 0x1908, 0x1401, null], ["deleteTexture", { ref: i }]);
    assert.equal(replay(freed).budget.total, 0);
    assert.ok(glLimits.context >= 4 * (64 << 20) - 1);
});

test("storage given by way of bindBufferBase and a vertex array is counted", () => {
    const base = [];
    for (let i = 1; i <= 5; i++) base.push(["bindBufferBase", 0x8A11, 0, { ref: i }], ["bufferData", 0x8A11, 60 << 20, 0x88E4]);
    assert.throws(() => replay(base), /budget/);
    const vao = replay([["bindVertexArray", { ref: 9 }], ["bindBuffer", 0x8893, { ref: 1 }], ["bufferData", 0x8893, 1 << 20, 0x88E4], ["bindVertexArray", null], ["bindVertexArray", { ref: 9 }], ["bufferData", 0x8893, 2 << 20, 0x88E4]]);
    assert.equal(vao.budget.total, 2 << 20);
    // The bound vertex array deleted: its element buffer is no longer what's bound.
    assert.throws(() => replay([["bindVertexArray", { ref: 9 }], ["bindBuffer", 0x8893, { ref: 1 }], ["deleteVertexArray", { ref: 9 }], ["bufferData", 0x8893, 1 << 20, 0x88E4]]), /nothing bound/);
});

test("ordinary scenes pass", () => {
    replay([...tex, ["texImage2D", 0x0DE1, 0, 0x1908, 512, 512, 0, 0x1908, 0x1401, { typed: "Uint8Array", data: "AAAA" }],
        ["bindBuffer", 0x8892, { ref: 2 }], ["bufferData", 0x8892, { typed: "Float32Array", data: "AAAAAA==" }, 0x88E4],
        ["drawElementsInstanced", 4, 36, 0x1403, 0, 1000], ["getExtension", "OES_texture_float"], ["drawArrays", 4, 0, 3]]);
});

test("storage deleted while still attached elsewhere stays counted till let go", () => {
    const FB = 0x8D40, RB = 0x8D41, T2D = 0x0DE1, COLOR0 = 0x8CE0, AB = 0x8892;
    const big = ["texImage2D", T2D, 0, 0x1908, 4096, 4096, 0, 0x1908, 0x1401, null];
    // A texture attached to a framebuffer not bound, deleted: GL keeps it.
    const textures = [];
    for (let i = 1; i <= 5; i++) textures.push(["bindFramebuffer", FB, { ref: 100 + i }], ["bindTexture", T2D, { ref: i }], big,
        ["framebufferTexture2D", FB, COLOR0, T2D, { ref: i }, 0], ["bindFramebuffer", FB, null], ["deleteTexture", { ref: i }]);
    assert.throws(() => replay(textures), /budget/, "attached textures' storage given back on delete");
    // A renderbuffer, the same.
    const renderbuffers = [];
    for (let i = 1; i <= 5; i++) renderbuffers.push(["bindFramebuffer", FB, { ref: 100 + i }], ["bindRenderbuffer", RB, { ref: i }], ["renderbufferStorage", RB, 0x8058, 4096, 4096],
        ["framebufferRenderbuffer", FB, COLOR0, RB, { ref: i }], ["bindFramebuffer", FB, null], ["deleteRenderbuffer", { ref: i }]);
    assert.throws(() => replay(renderbuffers), /budget/, "attached renderbuffers' storage given back on delete");
    // A buffer a vertex array not bound reads from.
    const buffers = [];
    for (let i = 1; i <= 5; i++) buffers.push(["bindVertexArray", { ref: 100 + i }], ["bindBuffer", AB, { ref: i }], ["bufferData", AB, 60 << 20, 0x88E4],
        ["vertexAttribPointer", 0, 4, 0x1406, false, 0, 0], ["bindVertexArray", null], ["deleteBuffer", { ref: i }]);
    assert.throws(() => replay(buffers), /budget/, "a vertex array's buffers' storage given back on delete");
    // Let go: its framebuffer deleted (or it detached), or deleted while its framebuffer's bound.
    const freed = [];
    for (let i = 1; i <= 5; i++) freed.push(["bindFramebuffer", FB, { ref: 100 + i }], ["bindTexture", T2D, { ref: i }], big,
        ["framebufferTexture2D", FB, COLOR0, T2D, { ref: i }, 0], ["bindFramebuffer", FB, null], ["deleteTexture", { ref: i }], ["deleteFramebuffer", { ref: 100 + i }]);
    assert.equal(replay(freed).budget.total, 0);
    const detached = [];
    for (let i = 1; i <= 5; i++) detached.push(["bindFramebuffer", FB, { ref: 100 + i }], ["bindTexture", T2D, { ref: i }], big,
        ["framebufferTexture2D", FB, COLOR0, T2D, { ref: i }, 0], ["deleteTexture", { ref: i }]);
    assert.equal(replay(detached).budget.total, 0);
    const vertexArrays = [];
    for (let i = 1; i <= 5; i++) vertexArrays.push(["bindVertexArray", { ref: 100 + i }], ["bindBuffer", AB, { ref: i }], ["bufferData", AB, 60 << 20, 0x88E4],
        ["vertexAttribPointer", 0, 4, 0x1406, false, 0, 0], ["bindVertexArray", null], ["deleteBuffer", { ref: i }], ["deleteVertexArray", { ref: 100 + i }]);
    assert.equal(replay(vertexArrays).budget.total, 0);
});

// A stand-in canvas whose WebGL context records the calls made of it (and
// of its extensions) and is lost and given back as a browser's is: its
// events dispatched later, not in the call.
function fakeCanvas({ locations = {} } = {}) {
    const listeners = {};
    const calls = [];
    let gl = null, lost = false;
    const recorder = (prefix, target = {}) => new Proxy(target, {
        get(t, name) {
            if (name in t) return t[name];
            if (typeof name !== "string") return undefined;
            return (...args) => { calls.push([prefix + name, ...args]); return name.startsWith("create") ? { made: name } : undefined; };
        },
    });
    const fire = (type) => setTimeout(() => {
        const event = { type, prevented: false, preventDefault() { this.prevented = true; } };
        for (const fn of listeners[type] ?? []) fn(event);
        if (type === "webglcontextlost") el.lastLost = event;
    }, 0);
    const el = {
        width: 0, height: 0, title: "", style: {}, isConnected: true, parentNode: {}, calls, lastLost: null,
        addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
        setAttribute(name, value) { this[name === "aria-label" ? "label" : name] = value; },
        removeAttribute(name) { delete this[name === "aria-label" ? "label" : name]; },
        getContext(type, attributes) {
            if (gl) return gl.type === type ? gl : null;
            const extensions = {};
            gl = recorder("", {
                type, NO_ERROR: 0, COMPILE_STATUS: 0x8B81, LINK_STATUS: 0x8B82,
                getContextAttributes: () => ({ ...attributes }),
                isContextLost: () => lost,
                getError: () => 0,
                getShaderParameter: () => true,
                getProgramParameter: () => true,
                getAttribLocation: (program, name) => locations[name] ?? 0,
                getExtension(name) {
                    if (name === "WEBGL_lose_context") return {
                        loseContext() { lost = true; fire("webglcontextlost"); },
                        restoreContext() { lost = false; fire("webglcontextrestored"); },
                    };
                    return extensions[name] ??= recorder(name + ".");
                },
            });
            return gl;
        },
    };
    return el;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const log = (...commands) => JSON.stringify(commands.map(([m, ...a]) => ({ m, a })));
const clearTo = (r) => log(["clearColor", r, 0, 0, 1], ["clear", 0x4000]);
const mirrored = (el) => /mirrored/.test(el.title);
const drawn = (el) => el.calls.filter(([m]) => !m.includes("Extension"));

test("a full log is replayed on a context of its own, and the calls after it added", () => {
    const { webglFrame } = makeGL();
    const el = fakeCanvas();
    assert.equal(webglFrame(el, clearTo(1), 64, 32, 1, 27, true), el);
    assert.ok(mirrored(el), el.title);
    assert.deepEqual([el.width, el.height], [64, 32]);
    webglFrame(el, clearTo(0.5), 64, 32, 1, 27, false);
    assert.deepEqual(drawn(el), [["clearColor", 1, 0, 0, 1], ["clear", 0x4000], ["clearColor", 0.5, 0, 0, 1], ["clear", 0x4000]]);
});

test("calls with no full log before them, or past the limits, leave the canvas unavailable, greyed", () => {
    const { webglFrame } = makeGL();
    const orphan = fakeCanvas();
    webglFrame(orphan, clearTo(1), 8, 8, 1, 27, false);
    assert.match(orphan.title, /unavailable/);
    assert.equal(orphan.style.backgroundColor, "#ddd");
    for (const [encoded, w] of [[clearTo(1), 8192], [JSON.stringify(Array(glLimits.commands + 1).fill({ m: "flush", a: [] })), 8], [log(["notAWebGLCall"]), 8]]) {
        const el = fakeCanvas();
        webglFrame(el, encoded, w, 8, 1, 27, true);
        assert.match(el.title, /unavailable/, encoded.slice(0, 40));
    }
    // The calls since the last, past what a context's log may hold.
    const el = fakeCanvas();
    webglFrame(el, clearTo(1), 8, 8, 1, 27, true);
    const many = JSON.stringify(Array(glLimits.commands).fill({ m: "clear", a: [0x4000] }));
    webglFrame(el, many, 8, 8, 1, 27, false);
    assert.match(el.title, /unavailable/);
});

test("in WebGL1, WebGL2's calls go to the extension the log turned on", () => {
    const { webglFrame } = makeGL();
    const el = fakeCanvas();
    webglFrame(el, log(["getExtension", "ANGLE_instanced_arrays"], ["drawArraysInstanced", 4, 0, 3, 2]), 8, 8, 1, 27, true);
    assert.ok(mirrored(el), el.title);
    assert.deepEqual(el.calls.at(-1), ["ANGLE_instanced_arrays.drawArraysInstancedANGLE", 4, 0, 3, 2]);
    const without = fakeCanvas();
    webglFrame(without, log(["drawArraysInstanced", 4, 0, 3, 2]), 8, 8, 1, 27, true);
    assert.match(without.title, /unavailable/);
});

test("a call setting up an attribute this browser's compiler left out is skipped", () => {
    const { webglFrame } = makeGL();
    const el = fakeCanvas({ locations: { gone: -1, kept: 2 } });
    webglFrame(el, log(["createProgram"], ["enableVertexAttribArray", { location: "gone", program: 1 }], ["enableVertexAttribArray", { location: "kept", program: 1 }]).replace('"createProgram","a":[]', '"createProgram","a":[],"r":1'), 8, 8, 1, 27, true);
    assert.ok(mirrored(el), el.title);
    assert.deepEqual(drawn(el).filter(([m]) => m === "enableVertexAttribArray"), [["enableVertexAttribArray", 2]]);
});

test("typed data is given to GL as the array it was", () => {
    const { webglFrame } = makeGL();
    const el = fakeCanvas();
    const data = Buffer.from(new Float32Array([1, 2.5]).buffer).toString("base64");
    const encoded = JSON.stringify([{ m: "createBuffer", a: [], r: 1 }, { m: "bindBuffer", a: [0x8892, { ref: 1 }] }, { m: "bufferData", a: [0x8892, { typed: "Float32Array", data }, 0x88E4] }]);
    webglFrame(el, encoded, 8, 8, 1, 27, true);
    assert.ok(mirrored(el), el.title);
    const given = drawn(el).find(([m]) => m === "bufferData")[2];
    assert.ok(given instanceof Float32Array);
    assert.deepEqual([...given], [1, 2.5]);
});

test("a context the viewer loses is given back and replayed once; lost again, it isn't", async () => {
    const { webglFrame } = makeGL();
    const el = fakeCanvas();
    webglFrame(el, clearTo(1), 8, 8, 1, 27, true);
    const lose = el.getContext("webgl").getExtension("WEBGL_lose_context");
    lose.loseContext();
    await settle();
    assert.ok(el.lastLost.prevented, "the loss let be given back");
    assert.match(el.title, /unavailable/);
    const before = drawn(el).length;
    lose.restoreContext();
    await settle();
    assert.ok(mirrored(el), el.title);
    assert.deepEqual(drawn(el).slice(before), [["clearColor", 1, 0, 0, 1], ["clear", 0x4000]]);
    lose.loseContext();
    await settle();
    assert.equal(el.lastLost.prevented, false, "lost a second time: not given back");
});

test("losses within a second are one GPU reset; three resets in a minute turn WebGL off, for longer each time", async () => {
    let t = 0;
    const { webglFrame } = makeGL({ now: () => t });
    const canvases = [];
    const shown = () => { const el = fakeCanvas(); webglFrame(el, clearTo(1), 8, 8, 1, 27, true); canvases.push(el); return el; };
    const loseAt = async (at, ...els) => { t = at; for (const el of els) el.getContext("webgl").getExtension("WEBGL_lose_context").loseContext(); await settle(); return els.map((el) => el.lastLost.prevented); };
    // One reset losing three: all given back.
    assert.deepEqual(await loseAt(0, shown(), shown(), shown()), [true, true, true]);
    assert.deepEqual(await loseAt(2000, shown()), [true]);
    // The third reset in the minute: not given back, and no new mirrors.
    assert.deepEqual(await loseAt(4000, shown()), [false]);
    assert.match(shown().title, /unavailable/);
    // A minute on, WebGL again; three more resets turn it off for two.
    t = 64000;
    assert.ok(mirrored(shown()));
    await loseAt(64000, shown()); await loseAt(66000, shown()); await loseAt(68000, shown());
    t = 68000 + 61000;
    assert.match(shown().title, /unavailable/, "off for two minutes the second time");
    t = 68000 + 121000;
    assert.ok(mirrored(shown()));
});

test("at most 16 canvases are mirrored at once; those gone from the copy make way", () => {
    const { webglFrame } = makeGL();
    const els = Array.from({ length: glLimits.mirrors }, () => { const el = fakeCanvas(); webglFrame(el, clearTo(1), 8, 8, 1, 27, true); return el; });
    assert.ok(els.every(mirrored));
    const extra = fakeCanvas();
    webglFrame(extra, clearTo(1), 8, 8, 1, 27, true);
    assert.match(extra.title, /unavailable/);
    // One seen in the copy (as the 17th was tried), then taken out of it:
    // its context given up for the next.
    els[0].isConnected = false;
    const next = fakeCanvas();
    webglFrame(next, clearTo(1), 8, 8, 1, 27, true);
    assert.ok(mirrored(next), next.title);
    assert.equal(els[0].getContext("webgl").isContextLost(), true, "the one taken out gave its context up");
    assert.ok(els.slice(1).every((el) => !el.getContext("webgl").isContextLost()));
});

test("a full log again replays on a new canvas (the copy's), the old one's context given up", () => {
    let replaced = null;
    const gl = makeGL({ host: { replaceCanvas: (d, el) => { gl.forget(el); replaced = fakeCanvas(); return replaced; } } });
    const el = fakeCanvas();
    gl.webglFrame(el, clearTo(1), 8, 8, 1, 27, true);
    const out = gl.webglFrame(el, clearTo(0), 8, 8, 1, 27, true);
    assert.equal(out, replaced);
    assert.ok(mirrored(replaced));
    assert.equal(el.getContext("webgl").isContextLost(), true);
});

test("a WebGL canvas given up for a 2D note is greyed, its context lost; a 2D one isn't touched", () => {
    const { webglFrame, giveUp } = makeGL();
    const el = fakeCanvas();
    webglFrame(el, clearTo(1), 8, 8, 1, 27, true);
    assert.equal(giveUp(el), true, "a WebGL context: no 2D note on it");
    assert.equal(el.style.backgroundColor, "#ddd");
    assert.equal(el.getContext("webgl").isContextLost(), true);
    const plain = fakeCanvas();
    assert.equal(giveUp(plain), false);
    assert.equal(plain.style.backgroundColor, undefined);
});
