// MI-GAN's official uint8 pipeline: RGB CHW image, 255=keep/0=fill mask.
// Model and runtime are local assets; only this worker may execute WASM.
"use strict";
let session = null;
const load = () => session ??= (async () => {
    importScripts("./background/ort.wasm.min.js");
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = new URL("./background/", self.location.href).href;
    return ort.InferenceSession.create(new URL("./inpaint/migan.onnx", self.location.href).href, { executionProviders: ["wasm"] });
})().catch((err) => { session = null; throw err; });

function inputs(rgba, mask, width, height) {
    const count = width * height;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 1024 || height > 1024 || rgba.length !== count * 4 || mask.length !== count) throw new Error("Invalid inpainting input");
    const rgb = new Uint8Array(count * 3);
    for (let i = 0; i < count; i++) for (let c = 0; c < 3; c++) rgb[c * count + i] = rgba[i * 4 + c];
    return rgb;
}

self.onmessage = async ({ data: { rgba, mask, width, height } }) => {
    let imageTensor, maskTensor, outputs;
    try {
        const rgb = inputs(rgba, mask, width, height), model = await load();
        imageTensor = new ort.Tensor("uint8", rgb, [1, 3, height, width]);
        maskTensor = new ort.Tensor("uint8", mask, [1, 1, height, width]);
        outputs = await model.run({ image: imageTensor, mask: maskTensor });
        const result = outputs[model.outputNames[0]];
        if (result.type !== "uint8" || result.dims.join(",") !== [1, 3, height, width].join(",")) throw new Error("Invalid inpainting result");
        const data = new Uint8ClampedArray(width * height * 4), count = width * height;
        for (let i = 0; i < count; i++) {
            for (let c = 0; c < 3; c++) data[i * 4 + c] = result.data[c * count + i];
            data[i * 4 + 3] = 255;
        }
        self.postMessage({ rgba: data }, [data.buffer]);
    } catch (err) {
        self.postMessage({ error: err?.message ?? String(err) });
    } finally {
        imageTensor?.dispose();
        maskTensor?.dispose();
        for (const value of Object.values(outputs ?? {})) value.dispose();
    }
};
