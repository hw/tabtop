// model-worker.js against the three.js files the image serves: with
// THREE_ASSETS set to a folder scripts/three/vendor.sh made (the image's
// /opt/three), else skipped. Its "./three/" imports are pointed there, as
// tabtopd points them.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const assets = process.env.THREE_ASSETS;
const here = new URL("../tabtopd/", import.meta.url);

// worker is the worker's onmessage, answering as a promise.
async function worker() {
    const dir = mkdtempSync(join(tmpdir(), "model-worker-"));
    for (const f of ["gcode.js", "model-info.js", "model-3mf.js"]) copyFileSync(new URL(f, here), join(dir, f));
    const js = readFileSync(new URL("model-worker.js", here), "utf8").replaceAll('"./three/', `"${pathToFileURL(resolve(assets)).href}/`);
    writeFileSync(join(dir, "model-worker.js"), js);
    let answer;
    globalThis.self = { postMessage: (m) => answer(m) };
    await import(pathToFileURL(join(dir, "model-worker.js")).href);
    const onmessage = globalThis.self.onmessage;
    return (format, bytes, name = "") => new Promise((ok) => { answer = ok; onmessage({ data: { format, bytes, name } }); });
}

test("the worker reads STL, OBJ, PLY and G-code, and says what's wrong", { skip: !assets && "THREE_ASSETS isn't set" }, async () => {
    const read = await worker();
    const stl = readFileSync(new URL("../test/data/3d/prism.stl", import.meta.url));
    let r = await read("stl", stl.buffer.slice(stl.byteOffset, stl.byteOffset + stl.length));
    assert.equal(r.parts.length, 1);
    assert.equal(r.parts[0].kind, "mesh");
    assert.equal(r.facts.triangles, 96);
    // A 24-sided prism of radius 6, 6 tall: 6 × 24 × ½ × 36 × sin(15°).
    assert.ok(Math.abs(r.facts.volume - 6 * 12 * 36 * Math.sin(Math.PI / 12)) < 0.01, String(r.facts.volume));
    // Its normals are 0, 0, 0 (as many STL files' are): made again, so it's lit.
    const n = r.parts[0].normal;
    for (let i = 0; i < n.length; i += 3) assert.ok(Math.abs(Math.hypot(n[i], n[i + 1], n[i + 2]) - 1) < 1e-4);

    // (A wire in an object of its own: OBJLoader draws a whole object as lines if it has any.)
    r = await read("obj", new TextEncoder().encode("v 0 0 0\nv 1 0 0\nv 0 1 0\no face\nf 1 2 3\no wire\nl 1 3\n").buffer);
    assert.deepEqual(r.parts.map((p) => p.kind).sort(), ["lines", "mesh"]);
    assert.equal(r.facts.triangles, 1);

    r = await read("ply", new TextEncoder().encode("ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n1 0 0\n0 2 0\n").buffer);
    assert.equal(r.parts[0].kind, "points");
    assert.equal(r.facts.points, 3);
    assert.deepEqual(r.facts.max, [1, 2, 0]);
    // Coloured: bytes that stand for 0 to 1.
    r = await read("ply", new TextEncoder().encode("ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n0 0 0 255 128 0\n").buffer);
    assert.equal(r.parts[0].colorNormalized, true);
    // (Made linear from sRGB, as three.js draws colours: 128 is 55.)
    assert.deepEqual([...r.parts[0].color], [255, 55, 0]);

    const g = readFileSync(new URL("../test/data/3d/cura.gcode", import.meta.url));
    r = await read("gcode", g.buffer.slice(g.byteOffset, g.byteOffset + g.length));
    assert.equal(r.gcode.layers.z.length, 20);

    // A 3MF, unzipped with fflate: PrusaSlicer's, of the same prism.
    const tmf = readFileSync(new URL("../test/data/3d/prusa.3mf", import.meta.url));
    r = await read("3mf", tmf.buffer.slice(tmf.byteOffset, tmf.byteOffset + tmf.length), "prism.3mf");
    assert.equal(r.parts[0].kind, "mesh");
    assert.equal(r.facts.triangles, 96);
    r = await read("3mf", new TextEncoder().encode("not a zip").buffer);
    assert.ok(r.error);

    r = await read("step", new ArrayBuffer(4));
    assert.equal(r.error, "its format isn't known");
});
