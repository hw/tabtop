// MobileSAM, for magic select: the image encoder analyses a picture once
// (RGB, 0-255, its longest side 1024 pixels; the model normalizes and pads
// it), and the mask decoder turns each click or box into a mask, at the
// analysed size. Model and runtime are local assets; only this worker may
// run WebAssembly, not the page. The models' tensor names stay here.
"use strict";
let runtime = null, encoder = null, decoder = null, embedding = null, size = null;

const load = (name) => {
    runtime ??= (async () => {
        importScripts("./background/ort.wasm.min.js");
        ort.env.wasm.numThreads = 1; // no SharedArrayBuffer or cross-origin isolation required
        ort.env.wasm.proxy = false;
        ort.env.wasm.wasmPaths = new URL("./background/", self.location.href).href;
    })().catch((err) => { runtime = null; throw err; });
    return runtime.then(() => ort.InferenceSession.create(new URL("./segment/" + name, self.location.href).href, { executionProviders: ["wasm"] }));
};
const encoderSession = () => encoder ??= load("mobile_sam_encoder.onnx").catch((err) => { encoder = null; throw err; });
const decoderSession = () => decoder ??= load("mobile_sam_decoder.onnx").catch((err) => { decoder = null; throw err; });

async function encode({ rgba, width, height }) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || Math.max(width, height) !== 1024 || rgba.length !== width * height * 4)
        throw new Error("Invalid picture to analyse");
    embedding?.dispose(); embedding = null; size = null;
    const rgb = new Float32Array(width * height * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4) { rgb[j++] = rgba[i]; rgb[j++] = rgba[i + 1]; rgb[j++] = rgba[i + 2]; }
    decoderSession().catch(() => {}); // (loaded meanwhile, for the first click)
    const model = await encoderSession();
    const input = new ort.Tensor("float32", rgb, [height, width, 3]);
    try {
        const out = await model.run({ input_image: input });
        embedding = out.image_embeddings;
        if (embedding.dims.join(",") !== "1,256,64,64") throw new Error("Invalid picture analysis");
        size = [height, width];
    } finally { input.dispose(); }
}

// run is the decoder's mask (as logits, at the analysed size) for points
// and their labels, and how good it thinks it is (0 to 1).
async function run(coords, labels) {
    if (!embedding) throw new Error("The picture hasn't been analysed");
    const n = labels.length;
    if (!(coords instanceof Float32Array) || !(labels instanceof Float32Array) || !n || n > 16 || coords.length !== n * 2) throw new Error("Invalid selection");
    const model = await decoderSession();
    const feeds = {
        image_embeddings: embedding,
        point_coords: new ort.Tensor("float32", coords, [1, n, 2]),
        point_labels: new ort.Tensor("float32", labels, [1, n]),
        mask_input: new ort.Tensor("float32", new Float32Array(256 * 256), [1, 1, 256, 256]),
        has_mask_input: new ort.Tensor("float32", Float32Array.of(0), [1]),
        // The analysed size: the masks come back at it.
        orig_im_size: new ort.Tensor("float32", Float32Array.from(size), [2]),
    };
    let out;
    try {
        out = await model.run(feeds);
        const masks = out.masks, [height, width] = size;
        if (masks.dims.join(",") !== `1,1,${height},${width}`) throw new Error("Invalid selection mask");
        return { logits: Float32Array.from(masks.data), score: out.iou_predictions.data[0] };
    } finally {
        for (const [name, tensor] of Object.entries(feeds)) if (name !== "image_embeddings") tensor.dispose();
        for (const tensor of Object.values(out ?? {})) tensor.dispose();
    }
}

async function decode({ coords, labels }) {
    const { logits } = await run(coords, labels);
    const mask = new Uint8Array(logits.length);
    for (let i = 0; i < mask.length; i++) mask[i] = logits[i] > 0 ? 1 : 0;
    return mask;
}

// Finding every object: a click at each point of a grid over the picture.
// What's kept is what the model's sure of (its own score), what's stable
// (much the same outline a little either side of its threshold), neither a
// speck nor the background (most of the picture, or reaching three of its
// sides); and of outlines much alike, the best. The rest, in one mask.
const GRID = 8, MIN_SCORE = .8, MIN_STABILITY = .9, MIN_AREA = .002, MAX_AREA = .5, SAME = .7;
async function everything() {
    if (!embedding) throw new Error("The picture hasn't been analysed");
    const [height, width] = size, total = width * height, kept = [];
    for (let gy = 0; gy < GRID; gy++) for (let gx = 0; gx < GRID; gx++) {
        const px = (gx + .5) * width / GRID, py = (gy + .5) * height / GRID;
        const { logits, score } = await run(Float32Array.from([px, py, 0, 0]), Float32Array.from([1, -1]));
        if (!(score >= MIN_SCORE)) continue;
        let area = 0, inner = 0, outer = 0, left = width, right = -1, top = height, bottom = -1;
        const mask = new Uint8Array(total);
        for (let i = 0; i < total; i++) {
            const v = logits[i];
            if (v > 1) inner++;
            if (v > -1) outer++;
            if (v > 0) {
                mask[i] = 1; area++;
                const x = i % width, y = (i - x) / width;
                if (x < left) left = x; if (x > right) right = x; if (y < top) top = y; if (y > bottom) bottom = y;
            }
        }
        if (!area || inner / outer < MIN_STABILITY || area < MIN_AREA * total || area > MAX_AREA * total) continue;
        if ((left === 0) + (top === 0) + (right === width - 1) + (bottom === height - 1) >= 3) continue;
        const found = { mask, area, box: [left, top, right, bottom], rank: score * inner / outer };
        // Much like one kept already: the better of the two.
        const like = kept.findIndex((k) => {
            if (k.box[0] > right || k.box[2] < left || k.box[1] > bottom || k.box[3] < top) return false;
            let both = 0;
            for (let y = Math.max(top, k.box[1]); y <= Math.min(bottom, k.box[3]); y++)
                for (let x = Math.max(left, k.box[0]); x <= Math.min(right, k.box[2]); x++) both += mask[y * width + x] & k.mask[y * width + x];
            return both / (area + k.area - both) > SAME;
        });
        if (like < 0) kept.push(found);
        else if (found.rank > kept[like].rank) kept[like] = found;
    }
    const union = new Uint8Array(total);
    for (const { mask } of kept) for (let i = 0; i < total; i++) union[i] |= mask[i];
    return { mask: union, count: kept.length };
}

self.onmessage = async ({ data }) => {
    try {
        if (data.encode) { await encode(data.encode); self.postMessage({ encoded: true }); }
        else if (data.decode) { const mask = await decode(data.decode); self.postMessage({ mask }, [mask.buffer]); }
        else if (data.everything) { const { mask, count } = await everything(); self.postMessage({ mask, count }, [mask.buffer]); }
        else throw new Error("Unknown request");
    } catch (err) {
        self.postMessage({ error: err?.message ?? String(err) });
    }
};
