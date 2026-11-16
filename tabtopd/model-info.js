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

// sizeText is "40 × 20 × 10 mm", of min and max.
export function sizeText(min, max, unit = "mm") {
    if (!min.every(Number.isFinite)) return "";
    return `${[0, 1, 2].map((c) => number(max[c] - min[c], 2)).join(" × ")} ${unit}`;
}

// durationText is "1 h 02 min", "3 min 05 s", of seconds.
export function durationText(s) {
    if (!Number.isFinite(s) || s < 0) return "";
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = Math.round(s % 60);
    return h ? `${h} h ${String(m).padStart(2, "0")} min` : m ? `${m} min ${String(sec).padStart(2, "0")} s` : `${sec} s`;
}

// describeMesh is the info line of a model: "40 × 20 × 10 mm · 1,234
// triangles · 3.2 cm³" (cm³ from mm³: the units printing formats use).
export function describeMesh(f) {
    const parts = [sizeText(f.min, f.max), `${f.triangles.toLocaleString("en")} triangle${f.triangles === 1 ? "" : "s"}`];
    if (f.volume > 0) parts.push(`${number(f.volume / 1000, 2)} cm³`);
    return parts.filter(Boolean).join(" · ");
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

// zipTooBig is why a zip's files (by its central directory) are too much
// to unpack, or "" if they aren't: more than MAX_ZIP_ENTRIES of them, or
// more than limit together. One that isn't a zip is "".
export function zipTooBig(bytes, limit = MAX_UNZIPPED) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = -1;
    for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 65557; i--) {
        if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) return "";
    let count = view.getUint16(end + 10, true), at = view.getUint32(end + 16, true);
    // Zip64: its own end record has them.
    if (end >= 20 && view.getUint32(end - 20, true) === 0x07064b50) {
        const z = Number(view.getBigUint64(end - 12, true));
        if (z + 56 <= bytes.length && view.getUint32(z, true) === 0x06064b50) {
            count = Number(view.getBigUint64(z + 32, true));
            at = Number(view.getBigUint64(z + 48, true));
        }
    }
    if (count > MAX_ZIP_ENTRIES) return `it holds ${count.toLocaleString("en")} files`;
    let total = 0;
    for (let k = 0; k < count; k++) {
        if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) return "its file list is damaged";
        let size = view.getUint32(at + 24, true);
        const nameLen = view.getUint16(at + 28, true), extraLen = view.getUint16(at + 30, true), commentLen = view.getUint16(at + 32, true);
        if (size === 0xffffffff) {
            // Zip64's extra field has the real size first.
            for (let e = at + 46 + nameLen; e + 4 <= at + 46 + nameLen + extraLen && e + 4 <= bytes.length;) {
                const id = view.getUint16(e, true), len = view.getUint16(e + 2, true);
                if (id === 1 && len >= 8 && e + 12 <= bytes.length) { size = Number(view.getBigUint64(e + 4, true)); break; }
                e += 4 + len;
            }
        }
        total += size;
        if (total > limit) return `it unpacks to more than ${Math.round(limit / (1 << 20))} MB`;
        at += 46 + nameLen + extraLen + commentLen;
    }
    return "";
}
