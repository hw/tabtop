// The viewer's bounds on WebGL replay (tabtopd/go-frame.js, glCheck): what a
// page's log may ask of this browser's GPU, checked before each call.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../tabtopd/go-frame.js", import.meta.url), "utf8");
const from = source.indexOf("    const glExtensionList = ["), to = source.indexOf("    // glDrop gives up");
assert.ok(from > 0 && to > from, "glCheck found");
const { glCheck, glLimits } = new Function(`${source.slice(from, to)}; return { glCheck, glLimits };`)();
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
