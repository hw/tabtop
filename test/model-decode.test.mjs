// Compressed glTF: three.js's GLTFLoader given model-decode.js's decoders,
// which ask model-decode-worker.js, run here as a browser would run it (a
// worker's global, its importScripts and fetch reading THREE_ASSETS, the
// vendored three.js folder), its WebAssembly the real decoders'.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

const assets = process.env.THREE_ASSETS;
const data = (name) => readFileSync(new URL(`data/3d/${name}`, import.meta.url));
const workerSource = readFileSync(new URL("../tabtopd/model-decode-worker.js", import.meta.url), "utf8");

// FakeWorker runs the worker's script in a context of its own, as a
// dedicated worker's global: ./three/ files from THREE_ASSETS.
class FakeWorker {
    constructor() {
        const file = (url) => {
            const name = new URL(url, "https://tabtop.test/tabtop/").pathname.replace(/^\/tabtop\/three\//, "");
            if (name.includes("/")) throw new Error(`not a three.js file: ${url}`);
            return readFileSync(join(resolve(assets), name));
        };
        const context = {
            console, URL, WebAssembly, Promise, setTimeout, clearTimeout, TextDecoder, TextEncoder,
            location: { href: "https://tabtop.test/tabtop/model-decode-worker.js" },
            fetch: async (url) => { const bytes = file(url); return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) }; },
            postMessage: (message, transfer) => setImmediate(() => this.onmessage?.({ data: structuredClone(message, { transfer }) })),
        };
        context.self = context;
        context.importScripts = (...urls) => { for (const url of urls) vm.runInContext(file(url).toString("utf8"), context, { filename: url }); };
        vm.createContext(context);
        vm.runInContext(workerSource, context, { filename: "model-decode-worker.js" });
        this.context = context;
    }
    postMessage(message, transfer) {
        const copy = structuredClone(message, { transfer });
        setImmediate(() => this.context.onmessage({ data: copy }));
    }
    terminate() {}
}

async function loaders() {
    globalThis.Worker = FakeWorker;
    globalThis.self ??= globalThis; // (GLTFLoader uses self.URL, as on a page)
    globalThis.ProgressEvent ??= class extends Event { constructor(type, init = {}) { super(type); Object.assign(this, init); } };
    const href = (name) => `${pathToFileURL(resolve(assets)).href}/${name}`;
    const THREE = await import(href("three.module.js"));
    const { GLTFLoader } = await import(href("GLTFLoader.js"));
    const { gltfDecoders } = await import("../tabtopd/model-decode.js");
    // (Each file it names, found as model-view.js's manager finds them: here, as data: URLs.)
    const read = (files) => {
        const manager = new THREE.LoadingManager();
        manager.setURLModifier((u) => (files[u] ? `data:application/octet-stream;base64,${files[u].toString("base64")}` : u));
        const loader = new GLTFLoader(manager);
        const { draco, meshopt, ktx2 } = gltfDecoders(THREE, manager);
        return loader.setDRACOLoader(draco).setMeshoptDecoder(meshopt).setKTX2Loader(ktx2);
    };
    const meshes = (gltf) => { const out = []; gltf.scene.traverse((o) => o.isMesh && out.push(o)); return out; };
    return { THREE, read, meshes };
}

test("compressed glTF: Draco's meshes, meshopt's buffers and KTX2 textures, decoded in the worker", { skip: !assets && "THREE_ASSETS isn't set" }, async () => {
    const { THREE, read, meshes } = await loaders();
    const size = (mesh) => new THREE.Box3().setFromBufferAttribute(mesh.geometry.attributes.position).getSize(new THREE.Vector3()).toArray().map((v) => Math.round(v * 1000) / 1000);

    // Draco (Khronos's Box): its 12 triangles, a unit cube, with normals.
    const draco = data("box-draco.gltf");
    let gltf = await read({ "box-draco.bin": data("box-draco.bin") }).parseAsync(draco.buffer.slice(draco.byteOffset, draco.byteOffset + draco.length), "");
    let [mesh] = meshes(gltf);
    assert.equal(mesh.geometry.index.count / 3, 12);
    assert.deepEqual(size(mesh), [1, 1, 1]);
    assert.ok(mesh.geometry.attributes.normal);

    // meshopt (the same Box, gltfpack'd): the same cube.
    const glb = data("box-meshopt.glb");
    gltf = await read({}).parseAsync(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.length), "");
    [mesh] = meshes(gltf);
    assert.equal(mesh.geometry.index.count / 3, 12);
    // (Quantized, so placed by its node's scale: the cube, as drawn.)
    mesh.updateWorldMatrix(true, false);
    const box = new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3()).toArray().map((v) => Math.round(v * 100) / 100);
    assert.deepEqual(box, [1, 1, 1]);

    // KTX2: a triangle textured with one of Khronos's lamp's, beside it.
    const b64 = (a) => Buffer.from(a.buffer).toString("base64");
    const textured = JSON.stringify({
        asset: { version: "2.0" }, extensionsUsed: ["KHR_texture_basisu"], extensionsRequired: ["KHR_texture_basisu"],
        buffers: [{ byteLength: 36, uri: `data:application/octet-stream;base64,${b64(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))}` }],
        bufferViews: [{ buffer: 0, byteLength: 36 }],
        accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] }],
        images: [{ uri: "lamp.ktx2", mimeType: "image/ktx2" }],
        textures: [{ extensions: { KHR_texture_basisu: { source: 0 } } }],
        materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
        nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0,
    });
    gltf = await read({ "lamp.ktx2": data("lamp-occlusion.ktx2") }).parseAsync(new TextEncoder().encode(textured).buffer, "");
    [mesh] = meshes(gltf);
    const map = mesh.material.map;
    assert.ok(map?.isDataTexture, "a texture of its pixels");
    const { width, height, data: pixels } = map.image;
    assert.ok(width > 0 && height > 0 && pixels.length === width * height * 4, `${width}×${height}, ${pixels.length} bytes`);
    assert.ok(pixels.some((v, i) => i % 4 !== 3 && v > 0), "not all black");

    // A texture that isn't KTX2: none (as a missing picture is), not a failure.
    gltf = await read({ "lamp.ktx2": Buffer.from("not a texture") }).parseAsync(new TextEncoder().encode(textured).buffer, "");
    [mesh] = meshes(gltf);
    assert.equal(mesh.material.map, null);
});
