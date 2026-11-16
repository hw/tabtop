// 3MF, read for the 3D preview in its worker (model-worker.js), as
// three.js's loader can't be: that reads XML with DOMParser, which workers
// haven't, and on the page a big model freezes it for seconds.
//
// What's drawn of a 3MF: its build's items, each an object's mesh, or its
// components' (other objects, in this model file or, as Bambu Studio and
// Orca write them, another: p:path), placed by their transforms, in the
// model's unit; coloured by their base materials or colour groups (the
// materials extension's), where they say. Ids are a model file's own, as
// the spec has them. Textures and the like aren't read (it's drawn in its
// colours, or one).
//
// The XML isn't parsed as a document: its tags are found in its text, as
// only a few kinds, with plain attributes, matter.

// The most triangles drawn, once placed; components nested deeper than
// MAX_DEPTH aren't followed (nor ones that contain themselves).
export const MAX_TRIANGLES = 20e6;
const MAX_DEPTH = 16;
// The most times objects are placed (an object used by many, used by
// many, is placed many times over).
export const MAX_PLACEMENTS = 100000;
const UNITS = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };
const CORE = "3dmodel";

// attributes is a tag's, by name ("p:path" as written), its text from the
// name on ("vertex x=…").
function attributes(tag) {
    const out = {};
    for (const m of tag.matchAll(/(?<![\w:.-])([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1]] = m[3] ?? m[4];
    return out;
}

// localName is a tag's name without its namespace prefix.
const localName = (name) => name.slice(name.indexOf(":") + 1);

// colour is #RRGGBB(AA) as [r, g, b], 0 to 1, made linear from sRGB (as
// three.js draws vertex colours), or null.
function colour(text) {
    const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(text ?? "").trim());
    if (!m) return null;
    const v = parseInt(m[1], 16);
    return [v >> 16 & 255, v >> 8 & 255, v & 255].map(linear);
}
const linear = (byte) => {
    const c = byte / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
// The preview's model colour (model-view.js's MODEL, #8fa8c8), linear.
const DEFAULT = [0x8f, 0xa8, 0xc8].map(linear);

// readModel reads one model file's text: {unit, objects (by id: {mesh:
// {vertices, triangles, pid, pindex}, components}), properties (by id: an
// array of colours, or null for ones not read), build ([{objectid,
// transform, path}])}.
export function readModel(text) {
    const model = { unit: 1, objects: new Map(), properties: new Map(), build: [] };
    let object = null, group = null;
    let vertices = null, triangles = null;
    // (Its rest begins with what a name can't have, and none has "<": so
    // no text, however made, is gone over more than about twice.)
    const tag = /<\s*(\/?)([\w:.-]+)((?:[^\w:.<>-][^<>]*)?)>/g;
    for (let m; (m = tag.exec(text));) {
        const [, closing, rawName, rest] = m;
        const name = localName(rawName);
        if (closing) {
            if (name === "mesh") vertices = triangles = null;
            else if (name === "object") object = null;
            else if (name === "basematerials" || name === "colorgroup") group = null;
            continue;
        }
        if (name === "vertex" && vertices) {
            // The hot path: x, y and z only.
            const x = /\bx\s*=\s*["']([^"']*)/.exec(rest), y = /\by\s*=\s*["']([^"']*)/.exec(rest), z = /\bz\s*=\s*["']([^"']*)/.exec(rest);
            vertices.push(Number(x?.[1]), Number(y?.[1]), Number(z?.[1]));
        } else if (name === "triangle" && triangles) {
            const a = attributes(rest);
            triangles.push([Number(a.v1), Number(a.v2), Number(a.v3), a.pid, a.p1, a.p2, a.p3]);
        } else if (name === "model") {
            model.unit = UNITS[attributes(rest).unit ?? "millimeter"] ?? 1;
        } else if (name === "object") {
            const a = attributes(rest);
            object = { mesh: null, components: [], pid: a.pid, pindex: a.pindex };
            model.objects.set(a.id, object);
        } else if (name === "mesh" && object) {
            vertices = [];
            triangles = [];
            object.mesh = { vertices, triangles };
        } else if (name === "component" && object) {
            const a = attributes(rest);
            object.components.push({ objectid: a.objectid, transform: a.transform, path: a["p:path"] ?? a.path });
        } else if (name === "basematerials" || name === "colorgroup") {
            group = [];
            model.properties.set(attributes(rest).id, group);
        } else if ((name === "base" || name === "color") && group) {
            const a = attributes(rest);
            group.push(colour(name === "base" ? a.displaycolor : a.color));
        } else if (name === "item") {
            const a = attributes(rest);
            model.build.push({ objectid: a.objectid, transform: a.transform, path: a["p:path"] ?? a.path });
        } else if (["texture2dgroup", "compositematerials", "multiproperties"].includes(name)) {
            // Not read: what refers to it is drawn in the default colour.
            model.properties.set(attributes(rest).id, null);
        }
    }
    return model;
}

// matrix is a 3MF transform ("m00 m01 m02 m10 … m32": a point's row times
// it) as 12 numbers; identity if there's none, or it isn't one.
function matrix(text) {
    const v = String(text ?? "").trim().split(/\s+/).map(Number);
    return v.length === 12 && v.every(Number.isFinite) ? v : [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
}
// times is a then b (a point transformed by a, then by b).
function times(a, b) {
    const out = new Array(12);
    for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 3; c++) {
            out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c] + (r === 3 ? b[9 + c] : 0);
        }
    }
    return out;
}

// read3MF reads a 3MF's files (by name, as unzipped: Uint8Arrays): {mesh:
// {position, normal, color (or null)}, facts: {triangles, min, max,
// volume}}, its triangles as placed, in millimetres; or throws, saying why
// ("it …").
export function read3MF(files) {
    const decoder = new TextDecoder();
    const text = (name) => (files[name] ? decoder.decode(files[name]) : null);
    // The model file the package's relationships name, else the usual one.
    const rels = text("_rels/.rels") ?? "";
    let root = null;
    for (const m of rels.matchAll(/<\s*Relationship\b([^<>]*)>/g)) {
        const a = attributes(m[1]);
        if (String(a.Type ?? "").endsWith(CORE) && a.Target) root = a.Target.replace(/^\//, "");
    }
    root ??= Object.keys(files).find((n) => /^3D\/[^/]+\.model$/i.test(n));
    if (!root || !files[root]) throw new Error("it has no 3D model in it");
    const models = new Map();
    const modelOf = (path) => {
        const key = path.replace(/^\//, "");
        if (!models.has(key)) {
            const t = text(key);
            models.set(key, t === null ? null : readModel(t));
        }
        return models.get(key);
    };
    const top = modelOf(root);
    const scale = top.unit;

    // How many triangles each object comes to, its components' included,
    // each worked out once: so a model whose objects use each other many
    // times over is found too big before it's placed, not after.
    const where = (c, path) => (c.path ? c.path.replace(/^\//, "") : path);
    const totals = new Map(), working = new Set();
    const triangles = (path, id) => {
        const key = `${path}#${id}`;
        if (totals.has(key)) return totals.get(key);
        const object = modelOf(path)?.objects.get(id);
        if (!object || working.has(key) || working.size > MAX_DEPTH) return 0;
        working.add(key);
        let n = object.mesh?.triangles.length ?? 0;
        for (const c of object.components) n += triangles(where(c, path), c.objectid);
        working.delete(key);
        totals.set(key, n);
        return n;
    };
    const items = top.build.map((item) => [where(item, root), item]);
    const total = items.reduce((n, [path, item]) => n + triangles(path, item.objectid), 0);
    if (total > MAX_TRIANGLES) throw new Error(`it has more than ${MAX_TRIANGLES / 1e6} million triangles`);

    // Count first, so the arrays are made once, the size they'll be.
    const placed = [];  // [mesh, matrix, model, object]
    let count = 0;
    const visit = (path, id, m, depth, seen) => {
        const model = modelOf(path);
        const object = model?.objects.get(id);
        const key = `${path}#${id}`;
        // (Nothing to draw under it: not gone into.)
        if (!object || depth > MAX_DEPTH || seen.has(key) || !triangles(path, id)) return;
        if (object.mesh?.triangles.length) {
            count += object.mesh.triangles.length;
            if (count > MAX_TRIANGLES) throw new Error(`it has more than ${MAX_TRIANGLES / 1e6} million triangles`);
            if (placed.length >= MAX_PLACEMENTS) throw new Error(`it places its parts more than ${MAX_PLACEMENTS.toLocaleString("en")} times`);
            placed.push([object.mesh, m, model, object]);
        }
        const inner = new Set(seen).add(key);
        for (const c of object.components) visit(where(c, path), c.objectid, times(matrix(c.transform), m), depth + 1, inner);
    };
    const units = [scale, 0, 0, 0, scale, 0, 0, 0, scale, 0, 0, 0];
    for (const [path, item] of items) visit(path, item.objectid, times(matrix(item.transform), units), 0, new Set());
    if (!count) throw new Error("it has no shapes in it");

    const position = new Float32Array(count * 9), normal = new Float32Array(count * 9);
    let color = null;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    let volume = 0, t = 0;
    const p = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (const [mesh, m, model, object] of placed) {
        const v = mesh.vertices;
        // A part placed mirrored (its transform's determinant negative)
        // turns its triangles inside out: its volume, counted as it was.
        const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
        const sign = det < 0 ? -1 : 1;
        for (const [a, b, c, pid = object.pid, p1 = object.pindex, p2 = p1, p3 = p1] of mesh.triangles) {
            for (const [k, i] of [[0, a], [1, b], [2, c]]) {
                const x = v[i * 3], y = v[i * 3 + 1], z = v[i * 3 + 2];
                for (let d = 0; d < 3; d++) {
                    const w = x * m[d] + y * m[3 + d] + z * m[6 + d] + m[9 + d];
                    p[k * 3 + d] = w;
                    if (w < min[d]) min[d] = w;
                    if (w > max[d]) max[d] = w;
                }
            }
            if (!p.every(Number.isFinite)) throw new Error("its triangles refer to vertices it hasn't got");
            position.set(p, t * 9);
            // Flat: each triangle's own normal.
            const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2], vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2];
            let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            const l = Math.hypot(nx, ny, nz) || 1;
            nx /= l; ny /= l; nz /= l;
            for (let k = 0; k < 3; k++) normal.set([nx, ny, nz], t * 9 + k * 3);
            volume += sign * (p[0] * (p[4] * p[8] - p[5] * p[7]) - p[1] * (p[3] * p[8] - p[5] * p[6]) + p[2] * (p[3] * p[7] - p[4] * p[6])) / 6;
            const group = pid === undefined ? undefined : model.properties.get(pid);
            if (group) {
                color ??= new Float32Array(count * 9).fill(-1);
                for (const [k, idx] of [[0, p1], [1, p2], [2, p3]]) {
                    const rgb = group[Number(idx ?? 0)];
                    if (rgb) color.set(rgb, t * 9 + k * 3);
                }
            }
            t++;
        }
    }
    // What has no colour of its own, where others have: the default.
    if (color) for (let i = 0; i < color.length; i++) if (color[i] < 0) color[i] = DEFAULT[i % 3];
    return { mesh: { position, normal, color }, facts: { triangles: count, min, max, volume: Math.abs(volume) } };
}

// slicedGCode is the G-code a sliced 3MF (Bambu Studio's and Orca's
// .gcode.3mf) has for its first plate, or null if it isn't one.
export function slicedGCode(files) {
    const name = Object.keys(files).filter((n) => /^Metadata\/plate_\d+\.gcode$/i.test(n)).sort((a, b) => parseInt(a.match(/\d+/)) - parseInt(b.match(/\d+/)))[0];
    return name ? files[name] : null;
}
