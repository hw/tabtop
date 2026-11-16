// model-worker.js against the three.js files the image serves: with
// THREE_ASSETS set to a folder scripts/three/vendor.sh made (the image's
// /opt/three), else skipped. Its "./three/" imports are pointed there, as
// tabtopd points them.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const assets = process.env.THREE_ASSETS;
const here = new URL("../tabtopd/", import.meta.url);

// worker is the worker's onmessage, answering as a promise.
async function worker() {
    const dir = mkdtempSync(join(tmpdir(), "model-worker-"));
    for (const f of ["gcode.js", "model-info.js", "model-3mf.js", "bgcode.js"]) copyFileSync(new URL(f, here), join(dir, f));
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
    assert.deepEqual(r.facts.check, { open: 0, nonManifold: 0, flipped: 0, pieces: 1 });
    // A 24-sided prism of radius 6, 6 tall: 6 × 24 × ½ × 36 × sin(15°).
    assert.ok(Math.abs(r.facts.volume - 6 * 12 * 36 * Math.sin(Math.PI / 12)) < 0.01, String(r.facts.volume));
    // Its normals are 0, 0, 0 (as many STL files' are): made again, so it's lit.
    const n = r.parts[0].normal;
    for (let i = 0; i < n.length; i += 3) assert.ok(Math.abs(Math.hypot(n[i], n[i + 1], n[i + 2]) - 1) < 1e-4);

    // (A wire in an object of its own: OBJLoader draws a whole object as lines if it has any.)
    r = await read("obj", new TextEncoder().encode("v 0 0 0\nv 1 0 0\nv 0 1 0\no face\nf 1 2 3\no wire\nl 1 3\n").buffer);
    assert.deepEqual(r.parts.map((p) => p.kind).sort(), ["lines", "mesh"]);
    assert.equal(r.facts.triangles, 1);

    // Its materials: the files it names, each mesh's by name, by group; its UVs.
    r = await read("obj", new TextEncoder().encode("mtllib looks.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nv 1 1 0\nvt 0 0\nvt 1 0\nvt 0 1\nvt 1 1\nusemtl red\nf 1/1 2/2 3/3\nusemtl wood\nf 2/2 4/4 3/3\n").buffer);
    assert.deepEqual(r.libraries, ["looks.mtl"]);
    assert.deepEqual(r.parts[0].materials, ["red", "wood"]);
    assert.deepEqual(r.parts[0].groups, [{ start: 0, count: 3, materialIndex: 0 }, { start: 3, count: 3, materialIndex: 1 }]);
    assert.deepEqual([...r.parts[0].uv.subarray(0, 6)], [0, 0, 1, 0, 0, 1]);

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

    // Binary G-code, unpacked (fflate's zlib, Heatshrink, MeatPack): as its text.
    const bg = readFileSync(new URL("../test/data/3d/prism.bgcode", import.meta.url));
    r = await read("bgcode", bg.buffer.slice(bg.byteOffset, bg.byteOffset + bg.length));
    assert.equal(r.gcode.layers.z.length, 20);
    assert.match(r.gcode.slicer, /^PrusaSlicer/);
    assert.equal(r.gcode.extrude.width.length, r.gcode.extrude.types.length);

    // A block that says it's 10 bytes, but Deflate'd from 256 MB: refused, at once.
    const huge = deflateSync(Buffer.alloc(256 << 20, 65), { level: 9 });
    const head = Buffer.alloc(22);
    head.write("GCDE", 0); head.writeUInt32LE(1, 4); head.writeUInt16LE(0, 8);
    head.writeUInt16LE(1, 10); head.writeUInt16LE(1, 12); head.writeUInt32LE(10, 14); head.writeUInt32LE(huge.length, 18);
    const bomb = Buffer.concat([head, Buffer.alloc(2), huge]);
    const started = Date.now();
    r = await read("bgcode", bomb.buffer.slice(bomb.byteOffset, bomb.byteOffset + bomb.length));
    assert.match(r.error, /doesn't unpack to its size/);
    assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`);

    r = await read("step", new ArrayBuffer(4));
    assert.equal(r.error, "its format isn't known");
});

// Files made to take a pattern quadratic time (or worse): a 3MF of 2 KB,
// unpacked to 1 MB, hung the worker for minutes. Each is answered at once.
test("the worker reads files made to be slow to parse quickly", { skip: !assets && "THREE_ASSETS isn't set" }, async () => {
    const read = await worker();
    const { zipSync, strToU8 } = await import(`${pathToFileURL(resolve(assets)).href}/fflate.module.js`);
    const N = 1 << 20;
    const rels = '<Relationships><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';
    const threeMF = (model, relsText = rels) => zipSync({ "_rels/.rels": strToU8(relsText), "3D/3dmodel.model": strToU8(model) }, { level: 9 });
    // A .bgcode: its header, a slicer metadata block (stored) of one long line, a little G-code.
    const block = (type, data) => {
        const h = Buffer.alloc(10);
        h.writeUInt16LE(type, 0); h.writeUInt16LE(0, 2); h.writeUInt32LE(data.length, 4); h.writeUInt16LE(0, 8);
        return Buffer.concat([h, data]);
    };
    const head = Buffer.alloc(10);
    head.write("GCDE", 0); head.writeUInt32LE(1, 4); head.writeUInt16LE(0, 8);
    const files = [
        ["a tag's name, then spaces", "3mf", threeMF('<model unit="millimeter"><a' + " ".repeat(N))],
        ["an attribute's long name", "3mf", threeMF('<model unit="millimeter" ' + "a".repeat(N) + "></model>")],
        ["relationships, never closed", "3mf", threeMF('<model unit="millimeter"></model>', "<Relationship ".repeat(N / 14))],
        ["a long metadata line", "bgcode", Buffer.concat([head, block(2, Buffer.from("a" + " ".repeat(N) + "b\n")), block(1, Buffer.from("G1 X0 Y0 Z0.2\nG1 X10 Y0 E1\n"))])],
    ];
    for (const [what, format, bytes] of files) {
        const started = Date.now();
        const r = await read(format, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), `slow.${format}`);
        assert.ok(Date.now() - started < 1000, `${what}: ${Date.now() - started} ms`);
        if (format === "3mf") assert.equal(r.error, "it has no shapes in it", what);
        else assert.ok(r.gcode, what);
    }
});
