// Reads models for the 3D preview (model-view.js), off the page's thread,
// so a big one doesn't freeze it: G-code by gcode.js (binary G-code,
// .bgcode, unpacked by bgcode.js first); 3MF by
// model-3mf.js (a sliced one, .gcode.3mf, by its plate's G-code); STL,
// OBJ, PLY and VRML by three.js's loaders. (AMF's and Collada's loaders
// read XML with DOMParser, which workers haven't: the page reads those.)
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
import { vrmlMade } from "./model-limits.js";

// The most a VRML file is (unpacked, if gzip'd): three.js's loader takes
// some 50 times that in memory, and a second for each 4 MB.
export const MAX_VRML = 16 << 20;

self.onmessage = async ({ data }) => {
    try {
        const { format, bytes, name = "" } = data;
        if (format === "gcode" || format === "gco") return gcodeReply(new Uint8Array(bytes));
        if (format === "bgcode") {
            const { Unzlib } = await import("./three/fflate.module.js");
            // No more than size bytes: unpacked a little at a time (4 KB in),
            // stopped as soon as more than that has come. (fflate's
            // unzlibSync, given a buffer, fills it, but goes on unpacking
            // the rest, unkept: seconds, for a block made to be huge.)
            const inflate = (data, size) => {
                const out = new Uint8Array(size);
                let n = 0;
                const unzlib = new Unzlib((chunk) => {
                    if (n + chunk.length > size) throw new Error("a block of it doesn't unpack to its size");
                    out.set(chunk, n);
                    n += chunk.length;
                });
                // (Its last 4 bytes, zlib's checksum, with the last push.)
                const body = Math.max(0, data.length - 4);
                for (let at = 0; at < body; at += 4096) unzlib.push(data.subarray(at, Math.min(body, at + 4096)), false);
                unzlib.push(data.subarray(body), true);
                return out.subarray(0, n);
            };
            const { gcode, truncated } = readBGCode(new Uint8Array(bytes), inflate);
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
        } else if (format === "wrl" || format === "vrml" || format === "wrz") {
            parts.push(...await vrmlParts(new Uint8Array(bytes)));
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

// vrmlParts is a VRML (97) file's shapes, each placed as its transforms
// place it, its material's colour as its vertices' (VRML's lights,
// viewpoints and backgrounds aren't shown; nor its textures, which a worker
// can't make pictures of). A gzip'd one (as .wrz, or .wrl) is unpacked first.
async function vrmlParts(bytes) {
    const THREE = await import("./three/three.module.js");
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        const { Gunzip } = await import("./three/fflate.module.js");
        const chunks = [];
        let n = 0;
        const gunzip = new Gunzip((chunk) => {
            if ((n += chunk.length) > MAX_VRML) throw new Error(`it's too big to read here (it unpacks to more than ${MAX_VRML >> 20} MB)`);
            chunks.push(chunk);
        });
        for (let at = 0; at < bytes.length; at += 65536) gunzip.push(bytes.subarray(at, Math.min(bytes.length, at + 65536)), at + 65536 >= bytes.length);
        bytes = new Uint8Array(n);
        let at = 0;
        for (const c of chunks) { bytes.set(c, at); at += c.length; }
    }
    if (bytes.length > MAX_VRML) throw new Error(`it's too big to read here (it's more than ${MAX_VRML >> 20} MB)`);
    // (Its Backgrounds made WorldInfo, which isn't drawn: a background is
    // spheres round it all, not what it shows, and three.js's loader fails
    // on one with a ground colour but no angle for it.)
    const text = new TextDecoder().decode(bytes).replace(/\bBackground(?=\s*\{)/g, "WorldInfo");
    if (!/^#VRML V2\.0/.test(text)) throw new Error(/^#VRML V1\.0/.test(text) ? "it's VRML 1.0, which this preview doesn't read (2.0 only)" : "it isn't a VRML 2.0 file");
    // (What it makes, counted first: its loader copies what each USE uses.)
    vrmlMade(text);
    // (Its textures: none, here, rather than the picture a worker can't make.)
    THREE.TextureLoader.prototype.load = () => new THREE.Texture();
    const { VRMLLoader } = await import("./three/VRMLLoader.js");
    const scene = new VRMLLoader().parse(text, "");
    scene.updateMatrixWorld(true);
    const parts = [];
    scene.traverse((o) => {
        if (!(o.isMesh || o.isLine || o.isPoints) || !o.geometry?.attributes?.position) return;
        const geometry = o.geometry.clone().applyMatrix4(o.matrixWorld);
        const material = [o.material].flat()[0];
        if (!geometry.attributes.color && material?.color && !o.isLine) {
            const c = material.color, n = geometry.attributes.position.count, colors = new Float32Array(n * 3);
            for (let i = 0; i < n; i++) { colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b; }
            geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
        }
        parts.push(part(o.isMesh ? "mesh" : o.isPoints ? "points" : "lines", geometry));
    });
    if (!parts.length) throw new Error("it has no shapes in it");
    return parts;
}

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
    // (Normals made for a mesh whose faces each have their own corners are
    // flat: it's facets, as an STL's, for the page to smooth if asked.)
    let madeFlat = false;
    if (kind === "mesh" && !usableNormals(geometry.attributes.normal)) {
        geometry.computeVertexNormals();
        madeFlat = !geometry.index;
    }
    const own = (attr) => (attr ? (attr.isInterleavedBufferAttribute ? Float32Array.from({ length: attr.count * attr.itemSize }, (_, i) => attr.getComponent(Math.floor(i / attr.itemSize), i % attr.itemSize)) : attr.array) : null);
    return { kind, position: own(geometry.attributes.position), normal: own(geometry.attributes.normal),
        color: own(geometry.attributes.color), uv: own(geometry.attributes.uv), index: geometry.index?.array ?? null,
        // Which material each run of it is (an OBJ's usemtl).
        groups: geometry.groups.map(({ start, count, materialIndex }) => ({ start, count, materialIndex })),
        // (PLY's colours are bytes, 0 to 255, meaning 0 to 1.)
        colorNormalized: !!geometry.attributes.color?.normalized, madeFlat };
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
