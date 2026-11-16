// Text (ASCII) FBX, as model-view.js reads it: fbxText (model-resources.js)
// then three.js's FBXLoader, from THREE_ASSETS (a folder
// scripts/three/vendor.sh made: the image's /opt/three), else skipped.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fbxText } from "../tabtopd/model-resources.js";

const assets = process.env.THREE_ASSETS;

test("a text FBX written with spaces after commas, and a texture's Vector scaling: placed and textured as written", { skip: !assets && "THREE_ASSETS isn't set" }, async () => {
    // (Its texture is made in the page: an image element, here a stand-in.)
    globalThis.document ??= { createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, style: {} }) };
    const { FBXLoader } = await import(pathToFileURL(`${resolve(assets)}/FBXLoader.js`).href);
    const bytes = new Uint8Array(readFileSync(new URL("data/3d/turned-ascii.fbx", import.meta.url)));
    const read = (buffer) => {
        let mesh;
        new FBXLoader().parse(buffer, "").traverse((o) => { if (o.isMesh) mesh = o; });
        return mesh;
    };
    // As three.js reads it, unchanged: its place and size lost, its texture's repeat nonsense.
    const raw = read(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
    assert.ok(!raw.scale.toArray().every(Number.isFinite) || !raw.material.map.repeat.toArray().every(Number.isFinite));
    // As read here.
    const mesh = read(new TextEncoder().encode(fbxText(bytes)).buffer);
    assert.deepEqual(mesh.position.toArray(), [5, 0, 0]);
    assert.deepEqual(mesh.scale.toArray(), [10, 10, 10]);
    assert.ok(Math.abs(mesh.rotation.x + Math.PI / 2) < 1e-9);
    assert.deepEqual(mesh.material.map.repeat.toArray(), [2, 3]);
    assert.deepEqual(mesh.material.map.offset.toArray(), [0, 0]);
});
