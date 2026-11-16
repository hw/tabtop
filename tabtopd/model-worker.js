// Reads models for the 3D preview (model-view.js), off the page's thread,
// so a big one doesn't freeze it: G-code by gcode.js (binary G-code,
// .bgcode, unpacked by bgcode.js first); 3MF by
// model-3mf.js (a sliced one, .gcode.3mf, by its plate's G-code); STL,
// OBJ and PLY by three.js's loaders. (AMF's loader reads XML with
// DOMParser, which workers haven't: the page reads those.)
//
// Given {format, bytes, name}, it answers with {gcode} (what parseGCode
// makes of it), or {parts, facts}: each shape's kind ("mesh", "lines",
// "points") and arrays (position, and normal, color, index where it has
// them; colorNormalized if color's are integers standing for 0 to 1; an
// OBJ's, its uv, groups and materials' names too), and what model-info.js's
// meshFacts says of them all, and an OBJ's libraries (the .mtl files it
// names); or {error}. Arrays are moved, not copied.
//
// tabtopd points its "./three/" imports at -three-dir, as model-view.js's.
import { parseGCode } from "./gcode.js";
import { meshFacts, combine, meshCheck, combineChecks, zipTooBig, MAX_UNZIPPED, MAX_ZIP_ENTRIES } from "./model-info.js";
import { read3MF, slicedGCode } from "./model-3mf.js";
import { readBGCode } from "./bgcode.js";

self.onmessage = async ({ data }) => {
    try {
        const { format, bytes, name = "" } = data;
        if (format === "gcode" || format === "gco") return gcodeReply(new Uint8Array(bytes));
        if (format === "bgcode") {
            const { unzlibSync } = await import("./three/fflate.module.js");
            const { gcode, truncated } = readBGCode(new Uint8Array(bytes), unzlibSync);
            return gcodeReply(gcode, truncated);
        }
        if (format === "3mf") return await threeMFReply(new Uint8Array(bytes), name);
        const parts = [];
        let libraries = [];
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
            const obj = new OBJLoader().parse(new TextDecoder().decode(bytes));
            // Its materials' files (mtllib), which the page reads: each
            // mesh's names its materials, by its groups.
            libraries = obj.materialLibraries ?? [];
            obj.traverse((o) => {
                if (!o.geometry?.attributes?.position) return;
                const p = part(o.isMesh ? "mesh" : o.isPoints ? "points" : "lines", o.geometry);
                p.materials = [o.material].flat().map((m) => m?.name ?? "");
                parts.push(p);
            });
        } else {
            throw new Error("its format isn't known");
        }
        const facts = combine(parts.map((p) => {
            const f = meshFacts(p.position, p.kind === "mesh" ? p.index : new Uint32Array(0));
            return p.kind === "mesh" ? f : { ...f, triangles: 0, volume: 0 };
        }));
        const points = parts.filter((p) => p.kind === "points").reduce((n, p) => n + p.position.length / 3, 0);
        // How its surfaces hold together, for printing (not a point cloud's, nor lines').
        const meshes = parts.filter((p) => p.kind === "mesh");
        const check = meshes.length ? combineChecks(meshes.map((p) => meshCheck(p.position, p.index))) : null;
        partsReply(parts, { ...facts, points, check }, libraries);
    } catch (err) {
        self.postMessage({ error: err?.message || String(err) });
    }
};

function partsReply(parts, facts, libraries = []) {
    const moved = parts.flatMap((p) => [p.position, p.normal, p.color, p.uv, p.index].filter(Boolean).map((a) => a.buffer));
    self.postMessage({ parts, facts, libraries }, [...new Set(moved)]);
}

// gcodeReply posts what parseGCode makes of bytes (truncated: they're
// only the first part of what there is).
function gcodeReply(bytes, truncated = false) {
    const g = parseGCode(bytes);
    if (truncated) g.truncated = true;
    const x = g.extrude;
    self.postMessage({ gcode: g }, [x.positions.buffer, x.types.buffer, x.speed.buffer, x.flow.buffer, x.width.buffer, x.height.buffer,
        x.temp.buffer, x.fan.buffer, g.travel.positions.buffer, g.layers.extrudeEnd.buffer, g.layers.travelEnd.buffer, g.layers.z.buffer]);
}

// threeMFReply reads a 3MF (a zip, checked for what it unpacks to before
// it's unpacked): its model; or, sliced (named .gcode.3mf, or with no
// model), its first plate's G-code.
async function threeMFReply(bytes, name) {
    const why = zipTooBig(bytes);
    if (why) throw new Error(`it's too big to unpack here (${why})`);
    const { unzipSync } = await import("./three/fflate.module.js");
    // (And, as it unpacks, counted again: no more than zipTooBig allows.)
    let files = 0, unpacked = 0;
    const wanted = (f) => {
        if (++files > MAX_ZIP_ENTRIES) throw new Error("it holds too many files");
        if (!/^(_rels\/|3D\/|Metadata\/plate_\d+\.gcode$)/i.test(f.name)) return false;
        unpacked += f.originalSize;
        if (unpacked > MAX_UNZIPPED) throw new Error(`it's too big to unpack here (it unpacks to more than ${MAX_UNZIPPED >> 20} MB)`);
        return true;
    };
    const unpackedFiles = unzipSync(bytes, { filter: wanted });
    const gcode = slicedGCode(unpackedFiles);
    if (gcode && /\.gcode\.3mf$/i.test(name)) return gcodeReply(gcode);
    let model;
    try {
        model = read3MF(unpackedFiles);
    } catch (err) {
        if (gcode) return gcodeReply(gcode);
        throw err;
    }
    const { mesh, facts } = model;
    partsReply([{ kind: "mesh", position: mesh.position, normal: mesh.normal, color: mesh.color, index: null, colorNormalized: false }],
        { ...facts, points: 0, check: meshCheck(mesh.position) });
}

// part is a shape's arrays, its normals made if it's a mesh without them,
// or with some that aren't (STL files often have 0, 0, 0: unlit, black).
function part(kind, geometry) {
    if (kind === "mesh" && !usableNormals(geometry.attributes.normal)) geometry.computeVertexNormals();
    const own = (attr) => (attr ? (attr.isInterleavedBufferAttribute ? Float32Array.from({ length: attr.count * attr.itemSize }, (_, i) => attr.getComponent(Math.floor(i / attr.itemSize), i % attr.itemSize)) : attr.array) : null);
    return { kind, position: own(geometry.attributes.position), normal: own(geometry.attributes.normal),
        color: own(geometry.attributes.color), uv: own(geometry.attributes.uv), index: geometry.index?.array ?? null,
        // Which material each run of it is (an OBJ's usemtl).
        groups: geometry.groups.map(({ start, count, materialIndex }) => ({ start, count, materialIndex })),
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
