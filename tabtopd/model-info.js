// What the 3D preview (model-view.js) says of a model, worked out from its
// triangles and G-code's moves, not from what's drawn: its size, how many
// triangles, the volume it encloses; and whether a 3MF or AMF (a zip) is
// small enough, unpacked, to be read.

// The most a zipped model unpacks to (a 3MF, read in a worker: its XML
// must fit in a string), and the most files in it.
export const MAX_UNZIPPED = 400 << 20;
export const MAX_ZIP_ENTRIES = 20000;

// meshFacts is {triangles, min, max, volume} of the triangles positions
// (x, y, z of each corner) has, by index if given (three at a time): volume
// is what's enclosed, in cubic units, if the surface is closed and its
// triangles face out (otherwise less meaningful: it's the absolute sum).
export function meshFacts(positions, index = null) {
    const count = index ? index.length : positions.length / 3;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i + 2 < positions.length; i += 3) {
        for (let c = 0; c < 3; c++) {
            const v = positions[i + c];
            if (v < min[c]) min[c] = v;
            if (v > max[c]) max[c] = v;
        }
    }
    let volume = 0;
    const at = (k) => (index ? index[k] : k) * 3;
    for (let k = 0; k + 2 < count; k += 3) {
        const a = at(k), b = at(k + 1), c = at(k + 2);
        const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
        const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
        const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];
        volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    }
    return { triangles: Math.floor(count / 3), min, max, volume: Math.abs(volume) };
}

// combine is the facts of several meshes', together.
export function combine(facts) {
    const out = { triangles: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], volume: 0 };
    for (const f of facts) {
        out.triangles += f.triangles;
        out.volume += f.volume;
        for (let c = 0; c < 3; c++) {
            out.min[c] = Math.min(out.min[c], f.min[c]);
            out.max[c] = Math.max(out.max[c], f.max[c]);
        }
    }
    return out;
}

const number = (v, digits = 1) => v.toLocaleString("en", { maximumFractionDigits: digits, minimumFractionDigits: 0 });

// sizeText is "40 × 20 × 10 mm", of min and max, in unit ("" for none said).
export function sizeText(min, max, unit = "mm") {
    if (!min.every(Number.isFinite)) return "";
    return `${[0, 1, 2].map((c) => number(max[c] - min[c], 2)).join(" × ")}${unit ? ` ${unit}` : ""}`;
}

// durationText is "1 h 02 min", "3 min 05 s", of seconds.
export function durationText(s) {
    if (!Number.isFinite(s) || s < 0) return "";
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = Math.round(s % 60);
    return h ? `${h} h ${String(m).padStart(2, "0")} min` : m ? `${m} min ${String(sec).padStart(2, "0")} s` : `${sec} s`;
}

const plural = (n, one) => `${n.toLocaleString("en")} ${one}${n === 1 ? "" : "s"}`;

// describeMesh is the info line of a model: "40 × 20 × 10 mm · 1,234
// triangles · 3.2 cm³" (cm³ from mm³: the units printing formats use).
// A scene's (glTF's, FBX's) is in its unit ("m"; "" for not said), without
// a volume (it's seldom a solid), with its textures: "… · 3 textures".
export function describeMesh(f, { unit = "mm", volume = true, textures = null } = {}) {
    const parts = [sizeText(f.min, f.max, unit), plural(f.triangles, "triangle")];
    if (volume && f.volume > 0) parts.push(`${number(f.volume / 1000, 2)} cm³`);
    if (textures) parts.push(plural(textures, "texture"));
    return parts.filter(Boolean).join(" · ");
}

// missingText is what's said of the files a model refers to that aren't
// there: "2 files it refers to aren't here: a.png, b.bin".
export function missingText(missing) {
    if (!missing.length) return "";
    const names = missing.map((m) => String(m).split(/[\\/]/).pop());
    const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? ", …" : "");
    return `${missing.length === 1 ? "a file it refers to isn't" : `${missing.length} files it refers to aren't`} here: ${shown}`;
}

// describeGCode is the info line of a G-code file, parsed (see gcode.js).
export function describeGCode(g) {
    const layers = g.layers.z.length;
    const parts = [];
    if (g.bounds) parts.push(sizeText(g.bounds.min, g.bounds.max));
    parts.push(`${layers.toLocaleString("en")} layer${layers === 1 ? "" : "s"}`);
    if (g.filament > 0) parts.push(`${number(g.filament / 1000, 2)} m of filament`);
    if (g.time !== null) parts.push(`about ${durationText(g.time)}`);
    if (g.slicer) parts.push(g.slicer);
    return parts.join(" · ");
}

// zipTooBig is why a zip's files are too much to unpack, or "" if they
// aren't: more than MAX_ZIP_ENTRIES of them, or more than limit together.
// One that isn't a zip is "". It reads the zip's file list exactly as
// fflate's unzipSync does (which three.js's loaders and model-worker.js
// unzip with), so what's counted is what would be unpacked: the count of
// files "on this disk", and zip64's fields' low 32 bits, as it has them.
export function zipTooBig(bytes, limit = MAX_UNZIPPED) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = (at) => (at >= 0 && at + 2 <= bytes.length ? view.getUint16(at, true) : -1);
    const u32 = (at) => (at >= 0 && at + 4 <= bytes.length ? view.getUint32(at, true) : -1);
    let end = -1;
    for (let i = bytes.length - 22; i >= 0 && bytes.length - i <= 65558; i--) {
        if (u32(i) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) return "";
    let count = u16(end + 8), at = u32(end + 16);
    let zip64 = u32(end - 20) === 0x07064b50;
    if (zip64) {
        const z = u32(end - 12);
        zip64 = u32(z) === 0x06064b50;
        if (zip64) {
            count = u32(z + 32);
            at = u32(z + 48);
        }
    }
    if (count < 0 || at < 0) return "its file list is damaged";
    if (count > MAX_ZIP_ENTRIES) return `it holds ${count.toLocaleString("en")} files`;
    let total = 0;
    for (let k = 0; k < count; k++) {
        if (u32(at) !== 0x02014b50) return "its file list is damaged";
        let size = u32(at + 24);
        const nameLen = u16(at + 28), extraLen = u16(at + 30), commentLen = u16(at + 32);
        if (size === 0xffffffff && zip64) {
            // Its real size, in zip64's extra field, first.
            for (let e = at + 46 + nameLen; e + 4 < at + 46 + nameLen + extraLen; e += 4 + u16(e + 2)) {
                if (u16(e) === 1) {
                    size = u32(e + 4) + u32(e + 8) * 4294967296;
                    break;
                }
            }
        }
        if (size < 0) return "its file list is damaged";
        total += size;
        if (total > limit) return `it unpacks to more than ${Math.round(limit / (1 << 20))} MB`;
        at += 46 + nameLen + extraLen + commentLen;
    }
    return "";
}

// The most triangles meshCheck looks at (its tables are some 50 bytes a
// triangle; a million take a second or so): a model with more isn't checked.
export const MAX_CHECKED = 2e6;

// mix spreads a number's bits over all of them (murmur3's last step): a
// float's bits (whose low ones are mostly 0) hash well after it.
function mix(h) {
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
}

// meshCheck is how a mesh's surface holds together, for printing: its
// edges used by one face only (open: holes), by more than two (not
// manifold), and by two facing opposite ways (one of them inside out: its
// edge run the same way by both); and how many pieces it's in. Corners at
// the same place are the same corner (an STL's, or a 3MF's, triangles each
// have their own). positions as meshFacts has them, index if given. It's
// null for more than MAX_CHECKED triangles.
export function meshCheck(positions, index = null) {
    const corners = index ? index.length : positions.length / 3;
    const triangles = Math.floor(corners / 3);
    if (triangles > MAX_CHECKED) return null;
    // Each corner's place, as one id: an open-addressed table of its
    // coordinates' bits (exactly the same place, the same id).
    const floats = positions instanceof Float32Array ? positions : Float32Array.from(positions);
    const bitsOf = new Uint32Array(floats.buffer, floats.byteOffset, floats.length);
    const vertexCount = positions.length / 3;
    let size = 1;
    while (size < vertexCount * 2) size <<= 1;
    const table = new Int32Array(size).fill(-1), weld = new Int32Array(vertexCount);
    let ids = 0;
    const firstOf = new Int32Array(vertexCount);
    for (let v = 0; v < vertexCount; v++) {
        const a = bitsOf[v * 3], b = bitsOf[v * 3 + 1], c = bitsOf[v * 3 + 2];
        let h = mix(a ^ mix(b ^ mix(c))) & (size - 1);
        for (;;) {
            const at = table[h];
            if (at < 0) {
                table[h] = v;
                firstOf[v] = ids;
                weld[v] = ids++;
                break;
            }
            if (bitsOf[at * 3] === a && bitsOf[at * 3 + 1] === b && bitsOf[at * 3 + 2] === c) {
                weld[v] = firstOf[at];
                break;
            }
            h = (h + 1) & (size - 1);
        }
    }
    // Each edge: how many faces use it, and which ways (+1 run low to
    // high, -1 high to low); a table keyed by its two corners' ids.
    let edgeSize = 1;
    while (edgeSize < triangles * 3) edgeSize <<= 1;
    const keys = new Float64Array(edgeSize).fill(-1), uses = new Int32Array(edgeSize), ways = new Int32Array(edgeSize);
    // Pieces: corners joined by a face are one.
    const parent = new Int32Array(ids);
    for (let i = 0; i < ids; i++) parent[i] = i;
    const root = (i) => {
        while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
        return i;
    };
    const corner = (k) => weld[index ? index[k] : k];
    for (let t = 0; t < triangles; t++) {
        const v = [corner(t * 3), corner(t * 3 + 1), corner(t * 3 + 2)];
        if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) continue; // no area: no edges
        for (let e = 0; e < 3; e++) {
            const p = v[e], q = v[(e + 1) % 3];
            const lo = Math.min(p, q), hi = Math.max(p, q), key = lo * ids + hi;
            let h = mix(lo ^ mix(hi)) & (edgeSize - 1);
            while (keys[h] !== -1 && keys[h] !== key) h = (h + 1) & (edgeSize - 1);
            keys[h] = key;
            uses[h]++;
            ways[h] += p < q ? 1 : -1;
            const a = root(p), b = root(q);
            if (a !== b) parent[a] = b;
        }
    }
    let open = 0, nonManifold = 0, flipped = 0;
    for (let h = 0; h < edgeSize; h++) {
        if (keys[h] === -1) continue;
        if (uses[h] === 1) open++;
        else if (uses[h] > 2) nonManifold++;
        else if (ways[h] !== 0) flipped++;
    }
    // Pieces: of the corners faces use.
    const used = new Uint8Array(ids);
    for (let k = 0; k < triangles * 3; k++) used[corner(k)] = 1;
    let pieces = 0;
    for (let i = 0; i < ids; i++) if (used[i] && root(i) === i) pieces++;
    return { open, nonManifold, flipped, pieces };
}

// meshCheckText is what's said of a check (see meshCheck), or "" if there
// wasn't one: "watertight", or what's wrong; and how many pieces.
export function meshCheckText(check) {
    if (!check) return "";
    const plural = (n, one, many = `${one}s`) => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;
    const wrong = [check.open && plural(check.open, "open edge"), check.nonManifold && plural(check.nonManifold, "non-manifold edge"),
        check.flipped && plural(check.flipped, "flipped edge")].filter(Boolean);
    const pieces = check.pieces > 1 ? `${check.pieces.toLocaleString("en")} pieces` : "";
    return [wrong.length ? wrong.join(", ") : "watertight", pieces].filter(Boolean).join(" · ");
}

// combineChecks is several meshes' checks, together (null if any wasn't).
export function combineChecks(checks) {
    if (!checks.length || checks.some((c) => !c)) return null;
    return checks.reduce((a, c) => ({ open: a.open + c.open, nonManifold: a.nonManifold + c.nonManifold, flipped: a.flipped + c.flipped, pieces: a.pieces + c.pieces }),
        { open: 0, nonManifold: 0, flipped: 0, pieces: 0 });
}
