// U2NetP foreground masks. The model and ONNX Runtime are served locally,
// loaded only when asked. Only this worker may run WebAssembly, not the page.
// Input is a 320×320 RGBA sample of the current edit; output is its alpha mask.
"use strict";
const SIDE = 320, PIXELS = SIDE * SIDE;

// Match U2Net's RGB/max, ImageNet mean/std, planar float32 input.
function normalize(rgba) {
    if (rgba.length !== PIXELS * 4) throw new Error("Invalid background removal input");
    let max = 1;
    for (let i = 0; i < rgba.length; i += 4) max = Math.max(max, rgba[i], rgba[i + 1], rgba[i + 2]);
    const input = new Float32Array(PIXELS * 3);
    const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
    for (let c = 0; c < 3; c++) for (let i = 0; i < PIXELS; i++) input[c * PIXELS + i] = (rgba[i * 4 + c] / max - mean[c]) / std[c];
    return input;
}

function alphaMask(prediction) {
    if (prediction.length !== PIXELS) throw new Error("Invalid background removal result");
    let min = Infinity, max = -Infinity;
    for (const v of prediction) {
        if (!Number.isFinite(v)) throw new Error("Invalid background removal result");
        min = Math.min(min, v);
        max = Math.max(max, v);
    }
    const alpha = new Uint8ClampedArray(PIXELS);
    // A flat prediction carries no foreground boundary: keep the picture.
    if (max - min < 1e-8) alpha.fill(255);
    else for (let i = 0; i < PIXELS; i++) alpha[i] = Math.round((prediction[i] - min) / (max - min) * 255);
    return alpha;
}

// ONNX Runtime, and how its files are reached (ort-worker.js: offline,
// script, at, runtime): loaded first, as the offline client loads scripts
// (when that's done) or at once; what uses it waits for ortLoaded.
const ortLoaded = self.tabtopImportScripts ? self.tabtopImportScripts("./ort-worker.js") : Promise.resolve(importScripts("./ort-worker.js"));

let session = null;
const load = () => session ??= (async () => {
    await ortLoaded;
    await runtime();
    return ort.InferenceSession.create(at("./background/u2netp.onnx"), { executionProviders: ["wasm"] });
})().catch((err) => { session = null; throw err; });

self.onmessage = async ({ data: { rgba } }) => {
    let input, results;
    try {
        const model = await load();
        input = new ort.Tensor("float32", normalize(rgba), [1, 3, SIDE, SIDE]);
        results = await model.run({ [model.inputNames[0]]: input });
        const alpha = alphaMask(results[model.outputNames[0]].data);
        self.postMessage({ alpha }, [alpha.buffer]);
    } catch (err) {
        self.postMessage({ error: err?.message ?? String(err) });
    } finally {
        input?.dispose();
        for (const value of Object.values(results ?? {})) value.dispose();
    }
};
