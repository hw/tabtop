// Reads models for the 3D preview (model-view.js), off the page's thread,
// so a big one doesn't freeze it: G-code by gcode.js; 3MF by
// model-3mf.js (a sliced one, .gcode.3mf, by its plate's G-code); STL,
// OBJ and PLY by three.js's loaders. (AMF's loader reads XML with
// DOMParser, which workers haven't: the page reads those.)
//
// Given {format, bytes, name}, it answers with {gcode} (what parseGCode
// makes of it), or {parts, facts}: each shape's kind ("mesh", "lines",
// "points") and arrays (position, and normal, color, index where it has
// them; colorNormalized if color's are integers standing for 0 to 1), and
// what model-info.js's meshFacts says of them all; or {error}. Arrays are
// moved, not copied.
//
// tabtopd points its "./three/" imports at -three-dir, as model-view.js's.
import { parseGCode } from "./gcode.js";
import { meshFacts, combine, zipTooBig } from "./model-info.js";
import { read3MF, slicedGCode } from "./model-3mf.js";

self.onmessage = async ({ data }) => {
    try {
        const { format, bytes, name = "" } = data;
        if (format === "gcode" || format === "gco") return gcodeReply(new Uint8Array(bytes));
        if (format === "3mf") return await threeMFReply(new Uint8Array(bytes), name);
        const parts = [];
        if (format === "stl") {
            const { STLLoader } = await import("./three/STLLoader.js");
            parts.push(part("mesh", new STLLoader().parse(bytes)));
        } else if (format === "ply") {
            const { PLYLoader } = await import("./three/PLYLoader.js");
            const geometry = new PLYLoader().parse(bytes);
            // No faces: a point cloud.
            parts.push(part(geometry.index ? "mesh" : "points", geometry));
        } else if (format === "obj") {
            const { OBJLoader } = await import("./three/OBJLoader.js");
            new OBJLoader().parse(new TextDecoder().decode(bytes)).traverse((o) => {
                if (o.geometry?.attributes?.position) parts.push(part(o.isMesh ? "mesh" : o.isPoints ? "points" : "lines", o.geometry));
            });
        } else {
            throw new Error("its format isn't known");
        }
        const facts = combine(parts.map((p) => {
            const f = meshFacts(p.position, p.kind === "mesh" ? p.index : new Uint32Array(0));
            return p.kind === "mesh" ? f : { ...f, triangles: 0, volume: 0 };
        }));
        const points = parts.filter((p) => p.kind === "points").reduce((n, p) => n + p.position.length / 3, 0);
        partsReply(parts, { ...facts, points });
    } catch (err) {
        self.postMessage({ error: err?.message || String(err) });
    }
};

function partsReply(parts, facts) {
    const moved = parts.flatMap((p) => [p.position, p.normal, p.color, p.index].filter(Boolean).map((a) => a.buffer));
    self.postMessage({ parts, facts }, [...new Set(moved)]);
}

// gcodeReply posts what parseGCode makes of bytes.
function gcodeReply(bytes) {
    const g = parseGCode(bytes);
    self.postMessage({ gcode: g }, [g.extrude.positions.buffer, g.extrude.types.buffer, g.travel.positions.buffer,
        g.layers.extrudeEnd.buffer, g.layers.travelEnd.buffer, g.layers.z.buffer]);
}

// threeMFReply reads a 3MF (a zip, checked for what it unpacks to before
// it's unpacked): its model; or, sliced (named .gcode.3mf, or with no
// model), its first plate's G-code.
async function threeMFReply(bytes, name) {
    const why = zipTooBig(bytes);
    if (why) throw new Error(`it's too big to unpack here (${why})`);
    const { unzipSync } = await import("./three/fflate.module.js");
    const files = unzipSync(bytes, { filter: (f) => /^(_rels\/|3D\/|Metadata\/plate_\d+\.gcode$)/i.test(f.name) });
    const gcode = slicedGCode(files);
    if (gcode && /\.gcode\.3mf$/i.test(name)) return gcodeReply(gcode);
    let model;
    try {
        model = read3MF(files);
    } catch (err) {
        if (gcode) return gcodeReply(gcode);
        throw err;
    }
    const { mesh, facts } = model;
    partsReply([{ kind: "mesh", position: mesh.position, normal: mesh.normal, color: mesh.color, index: null, colorNormalized: false }], { ...facts, points: 0 });
}

// part is a shape's arrays, its normals made if it's a mesh without them,
// or with some that aren't (STL files often have 0, 0, 0: unlit, black).
function part(kind, geometry) {
    if (kind === "mesh" && !usableNormals(geometry.attributes.normal)) geometry.computeVertexNormals();
    const own = (attr) => (attr ? (attr.isInterleavedBufferAttribute ? Float32Array.from({ length: attr.count * attr.itemSize }, (_, i) => attr.getComponent(Math.floor(i / attr.itemSize), i % attr.itemSize)) : attr.array) : null);
    return { kind, position: own(geometry.attributes.position), normal: own(geometry.attributes.normal),
        color: own(geometry.attributes.color), index: geometry.index?.array ?? null,
        // (PLY's colours are bytes, 0 to 255, meaning 0 to 1.)
        colorNormalized: !!geometry.attributes.color?.normalized };
}

// usableNormals reports whether every one of normals is a direction.
function usableNormals(normals) {
    if (!normals || normals.isInterleavedBufferAttribute || normals.itemSize !== 3) return false;
    const a = normals.array;
    for (let i = 0; i < a.length; i += 3) {
        const l = a[i] * a[i] + a[i + 1] * a[i + 1] + a[i + 2] * a[i + 2];
        if (!(l > 0.25 && l < 4)) return false;
    }
    return true;
}
