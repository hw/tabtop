import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { read3MF, readModel, slicedGCode, MAX_TRIANGLES } from "../tabtopd/model-3mf.js";

// unzip is a zip's files, by name (as fflate's unzipSync has them).
function unzip(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), files = {};
    let end = bytes.length - 22;
    while (v.getUint32(end, true) !== 0x06054b50) end--;
    let at = v.getUint32(end + 16, true);
    for (let n = v.getUint16(end + 10, true); n > 0; n--) {
        const method = v.getUint16(at + 10, true), size = v.getUint32(at + 20, true);
        const nameLen = v.getUint16(at + 28, true), extra = v.getUint16(at + 30, true), comment = v.getUint16(at + 32, true);
        const local = v.getUint32(at + 42, true), name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
        const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
        const data = bytes.subarray(start, start + size);
        files[name] = method === 8 ? new Uint8Array(inflateRawSync(data)) : data;
        at += 46 + nameLen + extra + comment;
    }
    return files;
}
const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} isn't ${b}`);
const enc = (s) => new TextEncoder().encode(s);
const RELS = enc('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="r0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>');
// A cube of side s, at the origin, as a 3MF object's mesh; its triangles' extra attributes, attrs.
const cube = (s = 10, attrs = () => "") => {
    const v = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]];
    const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
    return `<mesh><vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}" />`).join("")}</vertices>` +
        `<triangles>${t.map(([a, b, c], i) => `<triangle v1="${a}" v2="${b}" v3="${c}"${attrs(i)}/>`).join("")}</triangles></mesh>`;
};
const model = (resources, build, unit = "millimeter") => enc(`<?xml version="1.0" encoding="UTF-8"?>
<model unit="${unit}" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">
<resources>${resources}</resources><build>${build}</build></model>`);

test("PrusaSlicer's 3MF: the prism it was made of", () => {
    const { mesh, facts } = read3MF(unzip(new Uint8Array(readFileSync(new URL("data/3d/prusa.3mf", import.meta.url)))));
    assert.equal(facts.triangles, 96);
    near(facts.volume, 6 * 12 * 36 * Math.sin(Math.PI / 12), 0.01);
    for (let c = 0; c < 2; c++) near(facts.max[c] - facts.min[c], 12, 1e-3);
    near(facts.max[2] - facts.min[2], 6, 1e-3);
    assert.equal(mesh.position.length, 96 * 9);
    assert.equal(mesh.color, null);
    // Each triangle's normal, flat, a unit long.
    for (let i = 0; i < mesh.normal.length; i += 3) near(Math.hypot(mesh.normal[i], mesh.normal[i + 1], mesh.normal[i + 2]), 1, 1e-5);
});

test("Bambu Studio's and Orca's layout: objects in model files of their own, by p:path; ids each file's own", () => {
    const part = (s) => model(`<object id="1" type="model">${cube(s)}</object>`, "");
    const files = {
        "_rels/.rels": RELS,
        "3D/3dmodel.model": model(
            `<object id="2" type="model"><components><component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></components></object>` +
            `<object id="4" type="model"><components><component p:path="/3D/Objects/object_2.model" objectid="1"/></components></object>`,
            `<item objectid="2" transform="1 0 0 0 1 0 0 0 1 100 100 0" printable="1"/><item objectid="4" transform="1 0 0 0 1 0 0 0 1 130 100 0"/>`),
        "3D/Objects/object_1.model": part(10),
        "3D/Objects/object_2.model": part(20),
    };
    const { facts } = read3MF(files);
    assert.equal(facts.triangles, 24);
    near(facts.volume, 1000 + 8000, 1e-2);
    assert.deepEqual(facts.min, [100, 100, 0]);
    assert.deepEqual(facts.max, [150, 120, 20]);
});

test("colours: base materials by triangle, colour groups by corner, the object's own as its default", () => {
    const files = {
        "_rels/.rels": RELS,
        "3D/3dmodel.model": model(
            `<basematerials id="5"><base name="red" displaycolor="#FF0000"/><base name="white" displaycolor="#FFFFFFFF"/></basematerials>` +
            `<m:colorgroup id="6"><m:color color="#0000FF"/><m:color color="#00FF00"/></m:colorgroup>` +
            `<object id="1" type="model" pid="5" pindex="1">${cube(10, (i) => (i === 0 ? ' pid="5" p1="0"' : i === 1 ? ' pid="6" p1="0" p2="1" p3="0"' : ""))}</object>`,
            `<item objectid="1"/>`),
    };
    const { mesh } = read3MF(files);
    const rgb = (t, corner) => [...mesh.color.subarray(t * 9 + corner * 3, t * 9 + corner * 3 + 3)].map((v) => Math.round(v * 1000) / 1000);
    assert.deepEqual(rgb(0, 0), [1, 0, 0]);
    assert.deepEqual(rgb(1, 0), [0, 0, 1]);
    assert.deepEqual(rgb(1, 1), [0, 1, 0]);
    assert.deepEqual(rgb(2, 2), [1, 1, 1]);
});

test("units, transforms and nesting; what refers to itself, or to what isn't there", () => {
    // An inch cube, scaled by two along Z and moved: 25.4 × 25.4 × 50.8 mm.
    let { facts } = read3MF({ "_rels/.rels": RELS, "3D/3dmodel.model": model(`<object id="1">${cube(1)}</object>`, `<item objectid="1" transform="1 0 0 0 1 0 0 0 2 5 0 0"/>`, "inch") });
    assert.deepEqual(facts.min.map((v) => Math.round(v * 10) / 10), [127, 0, 0]);
    assert.deepEqual(facts.max.map((v) => Math.round(v * 10) / 10), [152.4, 25.4, 50.8]);
    // Components within components, one of them itself: each placed once.
    ({ facts } = read3MF({ "_rels/.rels": RELS, "3D/3dmodel.model": model(
        `<object id="1">${cube(1)}</object><object id="2"><components><component objectid="1"/><component objectid="1" transform="1 0 0 0 1 0 0 0 1 3 0 0"/><component objectid="2"/></components></object><object id="3"><components><component objectid="2" transform="1 0 0 0 1 0 0 0 1 0 5 0"/></components></object>`,
        `<item objectid="3"/>`) }));
    assert.equal(facts.triangles, 24);
    assert.deepEqual(facts.max, [4, 6, 1]);
    assert.throws(() => read3MF({ "_rels/.rels": RELS, "3D/3dmodel.model": model(`<object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>`, `<item objectid="1"/>`) }), /refer to vertices it hasn't got/);
    assert.throws(() => read3MF({ "_rels/.rels": RELS, "3D/3dmodel.model": model(`<object id="1">${cube()}</object>`, "") }), /no shapes/);
    assert.throws(() => read3MF({}), /no 3D model/);
    assert.ok(MAX_TRIANGLES >= 1e6);
});

test("the model's text is read for what matters, its namespaces whatever they're called", () => {
    const m = readModel(`<model unit="centimeter"><resources><o:object xmlns:o="x" id="7"><o:mesh><o:vertices><o:vertex x='1' y="2" z="3"/></o:vertices><o:triangles/></o:mesh></o:object></resources></model>`);
    assert.equal(m.unit, 10);
    assert.deepEqual(m.objects.get("7").mesh.vertices, [1, 2, 3]);
});

test("a sliced 3MF's G-code: its first plate's", () => {
    const one = enc("G1 X1 E1"), two = enc("G1 X2 E2");
    assert.equal(slicedGCode({ "Metadata/plate_2.gcode": two, "Metadata/plate_1.gcode": one, "Metadata/plate_1.gcode.md5": enc("x") }), one);
    assert.equal(slicedGCode({ "3D/3dmodel.model": enc("") }), null);
});
