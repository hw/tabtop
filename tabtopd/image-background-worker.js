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

// The offline client (scripts/bootstrap/file-launcher.mjs) runs this from
// a blob: URL, which no path can be resolved against, and fetches its files
// through the tunnel: script loads a script as importScripts does, when
// it's done; at is a file's address, as fetch() is to be given it.
const offline = !!self.tabtopImportScripts;
const script = (url) => (offline ? self.tabtopImportScripts(url) : importScripts(url));
const at = (url) => (offline ? url : new URL(url, self.location.href).href);

// ONNX Runtime, set up to run here: on one thread (no SharedArrayBuffer or
// cross-origin isolation required), not proxied. Offline, it's given its
// module (which it would otherwise import from the server) and its
// WebAssembly, as the client fetched them.
async function runtime() {
    await script("./background/ort.wasm.min.js");
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    if (offline) {
        ort.env.wasm.wasmPaths = { mjs: await self.tabtopModuleURL("./background/ort-wasm-simd-threaded.mjs") };
        ort.env.wasm.wasmBinary = await (await fetch("./background/ort-wasm-simd-threaded.wasm")).arrayBuffer();
    } else {
        ort.env.wasm.wasmPaths = new URL("./background/", self.location.href).href;
    }
}

let session = null;
const load = () => session ??= (async () => {
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
