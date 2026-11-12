import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { BackgroundRemover, adjustAlpha, mapImagePoint } from "../tabtopd/image-background.js";

const source = readFileSync(new URL("../tabtopd/image-background-worker.js", import.meta.url), "utf8");
const pixels = 320 * 320;
test("selection and brush coordinates follow rotations, flips, crops and resizes in either direction", () => {
    const steps = ["right", { x: 10, y: 20, width: 50, height: 60 }, { resize: [100, 120] }];
    assert.deepEqual(mapImagePoint([40, 35], 100, 80, steps), [70, 40]);
    assert.deepEqual(mapImagePoint([70, 40], 100, 80, steps, true), [40, 35]);
    for (const turn of ["left", "right", "h", "v"]) {
        const ops = [turn, { x: 5, y: 8, width: 40, height: 45 }, { resize: [160, 180] }, "left", "h"];
        const point = [25.5, 32.25];
        assert.deepEqual(mapImagePoint(mapImagePoint(point, 100, 80, ops), 100, 80, ops, true), point);
    }
});
test("mask adjustments preserve defaults, remove more with a higher threshold, and control softness", () => {
    const alpha = Uint8ClampedArray.of(0, 64, 128, 192, 255);
    assert.deepEqual(adjustAlpha(alpha, 5, 1), alpha);
    const low = adjustAlpha(alpha, 5, 1, { threshold: 30 });
    const high = adjustAlpha(alpha, 5, 1, { threshold: 70 });
    assert.ok(high.every((value, i) => value <= low[i]));
    assert.deepEqual([...adjustAlpha(alpha, 5, 1, { softness: 0 })], [0, 0, 255, 255, 255]);
    assert.deepEqual([...alpha], [0, 64, 128, 192, 255], "the original mask remains available for Reset");
});

test("grow and shrink move mask boundaries in both axes without changing flat fields", () => {
    const dot = new Uint8ClampedArray(25);
    dot[12] = 255;
    const grown = adjustAlpha(dot, 5, 5, { grow: 20 });
    assert.equal(grown.filter((v) => v === 255).length, 9);
    assert.deepEqual(adjustAlpha(grown, 5, 5, { grow: -20 }), dot);
    assert.ok(adjustAlpha(new Uint8ClampedArray(25).fill(255), 5, 5, { grow: -20 }).every((v) => v === 255));
    assert.ok(adjustAlpha(new Uint8ClampedArray(25), 5, 5, { grow: 20 }).every((v) => v === 0));
});
const evaluate = (extra = {}) => {
    const context = { self: {}, ...extra };
    runInNewContext(source + "\nself.normalize = normalize; self.alphaMask = alphaMask;", context);
    return context.self;
};

test("U2NetP input: RGB normalized by max, ImageNet mean/std, planar channels; black is finite", () => {
    const { normalize } = evaluate();
    const rgba = new Uint8ClampedArray(pixels * 4);
    rgba.set([100, 50, 25, 255]);
    const input = normalize(rgba);
    assert.equal(input.length, pixels * 3);
    for (const [at, want] of [[0, (1 - .485) / .229], [pixels, (.5 - .456) / .224], [pixels * 2, (.25 - .406) / .225]]) {
        assert.ok(Math.abs(input[at] - want) < 1e-6);
    }
    assert.ok(normalize(new Uint8ClampedArray(pixels * 4)).every(Number.isFinite));
    assert.throws(() => normalize(new Uint8Array(4)), /Invalid/);
});

test("U2NetP output: soft alpha, flat predictions preserve the image, malformed results fail", () => {
    const { alphaMask } = evaluate();
    const values = new Float32Array(pixels).fill(.2);
    values[1] = .5;
    values[2] = .8;
    assert.deepEqual([...alphaMask(values).slice(0, 3)], [0, 127, 255]);
    assert.ok(alphaMask(new Float32Array(pixels).fill(.4)).every((v) => v === 255));
    values[3] = NaN;
    assert.throws(() => alphaMask(values), /Invalid/);
    assert.throws(() => alphaMask(new Float32Array(1)), /Invalid/);
});

test("a model load failure is retried, and the first foreground output is transferred", async () => {
    const replies = [];
    let loads = 0;
    const self = evaluate({
        self: { location: { href: "http://localhost/tabtop/image-background-worker.js" }, postMessage: (m) => replies.push(m) }, URL,
        importScripts() {},
        ort: {
            env: { wasm: {} },
            Tensor: class { dispose() {} },
            InferenceSession: { create: async () => {
                if (++loads === 1) throw new Error("offline");
                return { inputNames: ["input"], outputNames: ["foreground"], run: async () => ({ foreground: { data: new Float32Array(pixels).fill(.5), dispose() {} } }) };
            } },
        },
    });
    await self.onmessage({ data: { rgba: new Uint8ClampedArray(pixels * 4) } });
    assert.match(replies[0].error, /offline/);
    await self.onmessage({ data: { rgba: new Uint8ClampedArray(pixels * 4) } });
    assert.equal(loads, 2);
    assert.equal(replies[1].alpha.length, pixels);
});

test("the editor reuses its worker with fresh canvases; cancel rejects the request and allows a retry", async () => {
    const workers = [];
    const oldWorker = globalThis.Worker, oldDocument = globalThis.document;
    globalThis.Worker = class {
        constructor() { workers.push(this); }
        postMessage() {}
        terminate() { this.terminated = true; }
    };
    globalThis.document = { createElement: () => ({ getContext: () => ({
        drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(pixels * 4) }),
        createImageData: () => ({ data: new Uint8ClampedArray(pixels * 4) }), putImageData() {},
    }) }) };
    const remover = new BackgroundRemover();
    try {
        const first = remover.remove({});
        workers[0].onmessage({ data: { alpha: new Uint8ClampedArray(pixels) } });
        const firstCanvas = await first;
        const second = remover.remove({});
        workers[0].onmessage({ data: { alpha: new Uint8ClampedArray(pixels) } });
        assert.notEqual(await second, firstCanvas, "each result belongs to its own edit");
        assert.equal(workers.length, 1);
        const pending = remover.remove({});
        remover.cancel();
        await assert.rejects(pending, /cancelled/);
        assert.equal(workers[0].terminated, true);
        const retry = remover.remove({});
        assert.equal(workers.length, 2);
        workers[1].onmessage({ data: { error: "unavailable" } });
        await assert.rejects(retry, /unavailable/);
    } finally {
        remover.cancel();
        globalThis.Worker = oldWorker;
        globalThis.document = oldDocument;
    }
});
