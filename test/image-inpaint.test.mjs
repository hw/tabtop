import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { repairBounds, mergeRepair } from "../tabtopd/image-inpaint.js";

const worker = readFileSync(new URL("../tabtopd/image-inpaint-worker.js", import.meta.url), "utf8");
test("repair crops include context, stay inside the image, and ignore subtract-only masks", () => {
    assert.deepEqual(repairBounds([{ rect: { x: 40, y: 50, width: 20, height: 10 } }], 200, 150), { x: 8, y: 18, width: 84, height: 74 });
    assert.deepEqual(repairBounds([{ points: [[0, 0], [10, 10]], radius: 10 }], 100, 100), { x: 0, y: 0, width: 52, height: 52 });
    assert.throws(() => repairBounds([{ points: [[50, 50]], radius: 10, erase: true }], 100, 100), /Select an area/);
});
test("inpainting only changes masked RGB and preserves input alpha exactly", () => {
    const original = Uint8ClampedArray.of(10, 20, 30, 255, 40, 50, 60, 128, 70, 80, 90, 0);
    const filled = new Uint8ClampedArray(12).fill(200);
    const mask = Uint8ClampedArray.of(0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 128);
    const out = mergeRepair(original, filled, mask);
    assert.deepEqual([...out.slice(0, 8)], [10, 20, 30, 255, 200, 200, 200, 128]);
    assert.equal(out[11], 0);
    assert.deepEqual([...original.slice(4, 8)], [40, 50, 60, 128]);
    assert.throws(() => mergeRepair(original, filled.subarray(4), mask), /Invalid/);
});
test("MI-GAN uses planar uint8 RGB and binary keep/fill masks, releases tensors, and retries a failed load", async () => {
    let attempts = 0, disposed = 0;
    const messages = [], tensors = [], self = { location: { href: "http://localhost/tabtop/image-inpaint-worker.js" }, postMessage: (m) => messages.push(m) };
    const ort = { env: { wasm: {} }, Tensor: class {
        constructor(type, data, dims) { Object.assign(this, { type, data, dims }); tensors.push(this); }
        dispose() { disposed++; }
    }, InferenceSession: { create: async () => {
        if (++attempts === 1) throw new Error("offline");
        return { outputNames: ["result"], run: async ({ image, mask }) => {
            assert.deepEqual([...image.data], [10, 40, 20, 50, 30, 60]);
            assert.deepEqual([...mask.data], [0, 255]);
            return { result: { type: "uint8", dims: [1, 3, 1, 2], data: Uint8Array.of(1, 4, 2, 5, 3, 6), dispose() { disposed++; } } };
        } };
    } } };
    runInNewContext(worker, { self, ort, URL, importScripts() {} });
    const input = { rgba: Uint8ClampedArray.of(10, 20, 30, 128, 40, 50, 60, 255), mask: Uint8Array.of(0, 255), width: 2, height: 1 };
    await self.onmessage({ data: input });
    assert.match(messages[0].error, /offline/);
    await self.onmessage({ data: input });
    assert.equal(attempts, 2);
    assert.deepEqual([...messages[1].rgba], [1, 2, 3, 255, 4, 5, 6, 255]);
    assert.equal(disposed, 3);
    assert.ok(tensors.every((v) => v.type === "uint8"));
});
