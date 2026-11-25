// What the image editor's AI workers share (image-background-worker.js,
// image-segment-worker.js, image-inpaint-worker.js), each loading it first:
// ONNX Runtime, set up to run in the worker, and how its files are
// reached. Served with "./background/" made the runtime's path, as the
// workers are (page_assets.go).
"use strict";
// The offline client (scripts/bootstrap/file-launcher.mjs) runs a worker
// from a blob: URL, which no path can be resolved against, and fetches its
// files through the tunnel: script loads a script as importScripts does,
// when it's done; at is a file's address, as fetch() is to be given it.
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
