// Binary G-code (.bgcode), as Prusa's printers and PrusaSlicer write it
// (libbgcode's doc/specifications.md): read back into G-code text, for
// gcode.js, in the 3D preview's worker (model-worker.js).
//
// A file is a header ("GCDE", its version, its checksum's kind), then
// blocks: each a header (its type, its compression, its size unpacked
// and, compressed, packed), its parameters (a thumbnail's 6 bytes, the
// rest's 2: their encoding), its data, and a CRC32 if the file has them.
// Data is stored as it is, or compressed with Deflate (zlib's), or
// Heatshrink (a window of 2^11 or 2^12 bytes, 4-bit counts); G-code's is
// also MeatPack'd (its commonest characters 4 bits each). Metadata blocks
// are INI text (key=value lines): given to gcode.js as the comments a
// slicer's G-code has them in ("; key = value"), so it says what made the
// file, the time it estimated, and its filament's diameter.

const MAGIC = 0x45444347;           // "GCDE"
const BLOCK_MAX = 64 << 20;         // a block's data unpacked, at most
export const BGCODE_MAX = 512 << 20; // all its G-code, at most (more isn't read: truncated)
const TYPES = { 0: "file", 1: "gcode", 2: "slicer", 3: "printer", 4: "print", 5: "thumbnail" };

// heatshrink unpacks Heatshrink's data, with windowBits, into size bytes.
export function heatshrink(data, windowBits, lookaheadBits, size) {
    const out = new Uint8Array(size);
    let at = 0, byte = 0, bit = 0, i = 0;
    // bits is the next n bits, the most significant first; -1 at the end.
    const bits = (n) => {
        let v = 0;
        for (let k = 0; k < n; k++) {
            if (bit === 0) {
                if (i >= data.length) return -1;
                byte = data[i++];
                bit = 0x80;
            }
            v = (v << 1) | (byte & bit ? 1 : 0);
            bit >>= 1;
        }
        return v;
    };
    while (at < size) {
        const tag = bits(1);
        if (tag < 0) break;
        if (tag) {
            const c = bits(8);
            if (c < 0) break;
            out[at++] = c;
        } else {
            const index = bits(windowBits), count = bits(lookaheadBits);
            if (index < 0 || count < 0) break;
            const back = index + 1;
            for (let k = 0; k <= count && at < size; k++, at++) out[at] = at - back >= 0 ? out[at - back] : 0;
        }
    }
    if (at !== size) throw new Error("its data is cut short");
    return out;
}

// meatPack is G-code text from MeatPack's packing of it (as libbgcode's
// MeatPack::unbinarize, without the spaces it puts back: gcode.js reads
// "G1X10Y5" as it reads "G1 X10 Y5").
export function meatPack(data) {
    const out = new Uint8Array(data.length * 2 + 16);
    let n = 0;
    const put = (c) => { out[n++] = c; };
    const CHARS = [..."0123456789. \nGX"].map((c) => c.charCodeAt(0));
    let packing = false, noSpaces = false, signal = 0, command = false, held = 0, full = 0;
    const char = (v) => (v === 11 && noSpaces ? 69 /* E */ : CHARS[v]);
    const rx = (c) => {
        if (!packing) return put(c);
        if (full > 0) {
            put(c);
            if (held) { put(held); held = 0; }
            full--;
            return;
        }
        const low = c & 0xf, high = c >> 4;
        if (low === 0xf) {
            full++;
            if (high === 0xf) full++;
            else held = char(high);
        } else {
            const first = char(low);
            put(first);
            if (first !== 10) {
                if (high === 0xf) full++;
                else put(char(high));
            }
        }
    };
    for (const c of data) {
        if (c === 0xff) {
            if (signal > 0) { command = true; signal = 0; } else signal++;
            continue;
        }
        if (command) {
            if (c === 251) packing = true;
            else if (c === 250 || c === 249) packing = false;
            else if (c === 247) noSpaces = true;
            else if (c === 246) noSpaces = false;
            command = false;
            continue;
        }
        if (signal > 0) { rx(0xff); signal = 0; }
        rx(c);
    }
    return out.subarray(0, n);
}

// readBGCode reads a .bgcode's bytes: {gcode (a Uint8Array of its G-code,
// its metadata first, as comments), truncated, thumbnails (how many)}; or
// throws, saying why ("it …"). inflate is fflate's unzlibSync (zlib's
// Deflate, unpacked: the worker has it).
export function readBGCode(bytes, inflate, { max = BGCODE_MAX } = {}) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 10 || view.getUint32(0, true) !== MAGIC) throw new Error("it isn't binary G-code");
    const version = view.getUint32(4, true), checksum = view.getUint16(8, true);
    if (version !== 1) throw new Error(`it's binary G-code of version ${version}, which this preview doesn't read`);
    if (checksum > 1) throw new Error("its checksums are of a kind this preview doesn't know");
    const metadata = [], parts = [];
    let at = 10, total = 0, truncated = false, thumbnails = 0;
    const need = (n) => {
        if (at + n > bytes.length) throw new Error("it's cut short");
    };
    while (at < bytes.length) {
        need(8);
        const type = view.getUint16(at, true), compression = view.getUint16(at + 2, true), size = view.getUint32(at + 4, true);
        let packed = size;
        at += 8;
        if (compression !== 0) {
            need(4);
            packed = view.getUint32(at, true);
            at += 4;
        }
        const params = type === 5 ? 6 : 2;
        need(params);
        const encoding = view.getUint16(at, true);
        at += params;
        need(packed + (checksum ? 4 : 0));
        const data = bytes.subarray(at, at + packed);
        at += packed + (checksum ? 4 : 0);
        if (!(type in TYPES)) throw new Error(`it has a block of a kind this preview doesn't know (${type})`);
        if (type === 5) { thumbnails++; continue; }
        if (truncated) continue;
        if (size > BLOCK_MAX) throw new Error("a block of it is too big to read here");
        let raw;
        if (compression === 0) raw = data;
        else if (compression === 1) raw = inflate(data);
        else if (compression === 2 || compression === 3) raw = heatshrink(data, compression === 2 ? 11 : 12, 4, size);
        else throw new Error(`it's compressed in a way this preview doesn't know (${compression})`);
        if (raw.length !== size) throw new Error("a block of it doesn't unpack to its size");
        if (type === 1) {
            const text = encoding === 0 ? raw : meatPack(raw);
            if (total + text.length > max) { truncated = true; continue; }
            parts.push(text);
            total += text.length;
        } else {
            metadata.push([TYPES[type], new TextDecoder().decode(raw)]);
        }
    }
    // The metadata, as comments a slicer's G-code would have: what made
    // it, as "generated by"; the rest, "key = value".
    let head = "";
    for (const [, text] of metadata) {
        for (const line of text.split(/\r?\n/)) {
            const m = /^\s*([^=]+?)\s*=\s*(.*)$/.exec(line);
            if (!m) continue;
            head += m[1].toLowerCase() === "producer" ? `; generated by ${m[2]}\n` : `; ${m[1]} = ${m[2]}\n`;
        }
    }
    const headBytes = new TextEncoder().encode(head);
    const gcode = new Uint8Array(headBytes.length + total);
    gcode.set(headBytes);
    let o = headBytes.length;
    for (const p of parts) { gcode.set(p, o); o += p.length; }
    return { gcode, truncated, thumbnails };
}
