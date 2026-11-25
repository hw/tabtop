// The pictures 3D printing files have of themselves, for the files page's
// grid (see thumbnails.js): a slicer's 3MF's (Metadata/thumbnail.png, or
// a plate's), G-code's (base64 in comments at its start: "; thumbnail
// begin 300x300 12345" … "; thumbnail end", as PrusaSlicer, Cura, Orca and
// Bambu Studio write them), and binary G-code's (thumbnail blocks, before
// its G-code). Only what's needed is read (readRange): a 3MF's directory,
// at its end, and the one picture; G-code's start. Of several, the
// largest PNG or JPEG is taken (QOI, which browsers don't show, isn't).
import { fileType } from "./preview-model.js";

// modelThumbnailed reports whether a file named name may have a picture
// of itself (thumbnail in file-types.json: 3MF, G-code, binary G-code).
export const modelThumbnailed = (name) => fileType(name)?.thumbnail === true;
const HEAD = 2 << 20;            // the start of a G-code file, where its pictures are looked for
const MAX_IMAGE = 8 << 20;       // a picture bigger than this isn't taken
const MAX_DIRECTORY = 4 << 20;   // a 3MF's directory, at most
const MAX_BLOCKS = 256;          // binary G-code's blocks looked through, at most

// picture is {bytes, type} if bytes are a PNG's or a JPEG's (by their
// first bytes, not by what the file says), else null.
function picture(bytes) {
    if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return { bytes, type: "image/png" };
    if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { bytes, type: "image/jpeg" };
    return null;
}
const largest = (found) => found.filter((f) => f.picture).sort((a, b) => b.pixels - a.pixels)[0]?.picture ?? null;

// modelThumbnail is the picture the file named name, size bytes long,
// has of itself ({bytes, type}), or null. readRange(offset, length)
// resolves to those bytes of it (fewer at its end).
export async function modelThumbnail(name, size, readRange) {
    const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
    if (ext === "3mf") return zipThumbnail(size, readRange);
    if (ext === "bgcode") return bgcodeThumbnail(await readRange(0, Math.min(size, HEAD)));
    if (ext === "gcode" || ext === "gco") return gcodeThumbnail(await readRange(0, Math.min(size, HEAD)));
    return null;
}

// gcodeThumbnail is the largest picture in G-code text's comments.
export function gcodeThumbnail(bytes) {
    // (Latin-1: one character a byte; base64 is ASCII.)
    const text = new TextDecoder("latin1").decode(bytes);
    const found = [];
    const begin = /^;[ \t]*thumbnail(?:_(PNG|JPG|QOI))?[ \t]+begin[ \t]+(\d+)[ \t]*x[ \t]*(\d+)[ \t]+(\d+)/gm;
    for (let m; (m = begin.exec(text));) {
        const [, format = "PNG", w, h, length] = m;
        const end = text.indexOf(`thumbnail${m[1] ? `_${m[1]}` : ""} end`, begin.lastIndex);
        if (end < 0) break; // cut off by the end of what was read
        begin.lastIndex = end;
        if (format === "QOI" || Number(length) > MAX_IMAGE * 4 / 3) continue;
        // Its lines, each "; " and base64.
        const base64 = text.slice(text.indexOf("\n", m.index) + 1, text.lastIndexOf("\n", end)).replace(/^;[ \t]?/gm, "").replace(/\s+/g, "");
        let decoded;
        try {
            decoded = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        } catch {
            continue;
        }
        found.push({ pixels: Number(w) * Number(h), picture: picture(decoded) });
    }
    return largest(found);
}

// bgcodeThumbnail is the largest picture in binary G-code's thumbnail
// blocks (see bgcode.js: they come before its G-code).
export function bgcodeThumbnail(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 10 || view.getUint32(0, true) !== 0x45444347) return null;
    const checksum = view.getUint16(8, true) ? 4 : 0;
    const found = [];
    let at = 10;
    for (let n = 0; n < MAX_BLOCKS && at + 12 <= bytes.length; n++) {
        const type = view.getUint16(at, true), compression = view.getUint16(at + 2, true), size = view.getUint32(at + 4, true);
        const packed = compression ? view.getUint32(at + 8, true) : size;
        const head = compression ? 12 : 8, params = type === 5 ? 6 : 2;
        if (type === 1) break; // its G-code: no more pictures
        if (type === 5 && compression === 0 && at + head + params + size <= bytes.length && size <= MAX_IMAGE) {
            const format = view.getUint16(at + head, true), w = view.getUint16(at + head + 2, true), h = view.getUint16(at + head + 4, true);
            if (format === 0 || format === 1) found.push({ pixels: w * h, picture: picture(bytes.slice(at + head + params, at + head + params + size)) });
        }
        at += head + params + packed + checksum;
    }
    return largest(found);
}

// The picture a 3MF has, by its name: the package's own (Metadata/
// thumbnail.png), else a plate's, else any other in Metadata/ but a
// "pick" one (Bambu Studio's: its parts, coloured to tell them apart).
function rank(name) {
    const n = name.toLowerCase();
    if (n === "metadata/thumbnail.png" || n === "metadata/thumbnail.jpg") return 0;
    if (/^metadata\/plate_1\.(png|jpg)$/.test(n)) return 1;
    if (/^metadata\/plate_\d+\.(png|jpg)$/.test(n)) return 2;
    if (/^metadata\/(?!pick_)[^/]+\.(png|jpe?g)$/.test(n)) return 3;
    return -1;
}

// zipThumbnail is the picture in a 3MF (a ZIP): its directory read from
// its end, then the one entry.
export async function zipThumbnail(size, readRange) {
    const tailLength = Math.min(size, 22 + 0xffff);
    const tail = await readRange(size - tailLength, tailLength);
    const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tv.getUint32(i, true) === 0x06054b50) { end = i; break; }
    if (end < 0) return null;
    const dirSize = tv.getUint32(end + 12, true), dirOffset = tv.getUint32(end + 16, true);
    if (dirSize > MAX_DIRECTORY || dirOffset + dirSize > size) return null;
    const tailStart = size - tailLength;
    const dir = dirOffset >= tailStart ? tail.subarray(dirOffset - tailStart, dirOffset - tailStart + dirSize) : await readRange(dirOffset, dirSize);
    const dv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
    const decoder = new TextDecoder();
    let best = null;
    for (let at = 0; at + 46 <= dir.length && dv.getUint32(at, true) === 0x02014b50;) {
        const nameLength = dv.getUint16(at + 28, true);
        const entry = {
            method: dv.getUint16(at + 10, true), packed: dv.getUint32(at + 20, true), size: dv.getUint32(at + 24, true),
            offset: dv.getUint32(at + 42, true), name: decoder.decode(dir.subarray(at + 46, at + 46 + nameLength)),
        };
        const r = rank(entry.name);
        if (r >= 0 && (!best || r < best.rank)) best = { ...entry, rank: r };
        at += 46 + nameLength + dv.getUint16(at + 30, true) + dv.getUint16(at + 32, true);
    }
    if (!best || best.size > MAX_IMAGE || best.packed > MAX_IMAGE || (best.method !== 0 && best.method !== 8)) return null;
    const local = await readRange(best.offset, 30);
    const lv = new DataView(local.buffer, local.byteOffset, local.byteLength);
    if (local.length < 30 || lv.getUint32(0, true) !== 0x04034b50) return null;
    const data = await readRange(best.offset + 30 + lv.getUint16(26, true) + lv.getUint16(28, true), best.packed);
    if (data.length !== best.packed) return null;
    return picture(best.method === 0 ? data : await inflate(data, best.size));
}

// inflate is Deflate'd data unpacked (by the browser's own), into no more
// than size bytes: what's past that isn't unpacked.
async function inflate(data, size) {
    const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
    const out = new Uint8Array(size);
    let at = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (at + value.length > size) throw new Error("it unpacks to more than it says");
            out.set(value, at);
            at += value.length;
        }
    } finally {
        reader.cancel().catch(() => {});
    }
    return out.subarray(0, at);
}
