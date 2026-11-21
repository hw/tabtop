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
