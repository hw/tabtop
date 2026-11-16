import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";
import { readBGCode, heatshrink, meatPack } from "../tabtopd/bgcode.js";
import { parseGCode } from "../tabtopd/gcode.js";

const fixture = (name) => new Uint8Array(readFileSync(new URL(`data/3d/${name}`, import.meta.url)));
// (As the worker's: no more than size; Node's says so by throwing.)
const inflate = (b, size) => new Uint8Array(inflateSync(b, { maxOutputLength: Math.max(1, size) }));
const text = (b) => new TextDecoder().decode(b);

// prism.bgcode and prism-text.gcode: PrusaSlicer 2.9.2's slicing of
// prism.stl, the same, as binary G-code (Deflate'd metadata, its G-code
// Heatshrink'd and MeatPack'd, with CRC32s) and as text.
test("PrusaSlicer's binary G-code reads as its text G-code does", () => {
    const { gcode, truncated, thumbnails } = readBGCode(fixture("prism.bgcode"), inflate);
    assert.equal(truncated, false);
    assert.equal(thumbnails, 0);
    const a = parseGCode(gcode), b = parseGCode(fixture("prism-text.gcode"));
    for (const key of ["filament", "time", "slicer", "filamentDiameter"]) assert.equal(a[key], b[key], key);
    assert.deepEqual(a.types, b.types);
    assert.deepEqual(a.layers.extrudeEnd, b.layers.extrudeEnd);
    assert.deepEqual(a.extrude.positions, b.extrude.positions);
    assert.deepEqual(a.extrude.width, b.extrude.width);
    assert.deepEqual(a.travel.positions, b.travel.positions);
    assert.match(a.slicer, /^PrusaSlicer 2\.9\.2/);
});

// bitsOf writes [value, bits] pairs, most significant bit first.
function bitsOf(pairs) {
    const out = [];
    let byte = 0, n = 0;
    for (const [value, bits] of pairs) {
        for (let k = bits - 1; k >= 0; k--) {
            byte = (byte << 1) | ((value >> k) & 1);
            if (++n === 8) { out.push(byte); byte = n = 0; }
        }
    }
    if (n) out.push(byte << (8 - n));
    return Uint8Array.from(out);
}

test("Heatshrink: literals, and copies from back in what's come (overlapping it), at both window sizes", () => {
    for (const window of [11, 12]) {
        // "abc", then 6 from 3 back: "abcabcabc"; then "x", then 2 from 1 back: "xxx".
        const data = bitsOf([[1, 1], [97, 8], [1, 1], [98, 8], [1, 1], [99, 8], [0, 1], [2, window], [5, 4],
            [1, 1], [120, 8], [0, 1], [0, window], [1, 4]]);
        assert.equal(text(heatshrink(data, window, 4, 12)), "abcabcabcxxx");
    }
    // Before the beginning: zeros, as its window starts.
    assert.deepEqual([...heatshrink(bitsOf([[0, 1], [3, 11], [1, 4]]), 11, 4, 2)], [0, 0]);
    assert.throws(() => heatshrink(bitsOf([[1, 1], [97, 8]]), 11, 4, 5), /cut short/);
});

test("MeatPack: packed pairs, characters it can't pack, commands, and E for space", () => {
    const on = [0xff, 0xff, 251], noSpaces = [0xff, 0xff, 247], off = [0xff, 0xff, 250];
    // G1 X10\n: pairs, the first of each in the low half.
    assert.equal(text(meatPack(Uint8Array.from([...on, 0x1d, 0xeb, 0x01, 0x0c]))), "G1 X10\n");
    // M1: M can't be packed (0xF: a full byte next), then 1 after it.
    assert.equal(text(meatPack(Uint8Array.from([...on, 0x1f, 77]))), "M1");
    // Neither packable: 0xFF (as the signal byte is, but alone), then two full bytes.
    assert.equal(text(meatPack(Uint8Array.from([...on, 0xff, 77, 78]))), "MN");
    // With no spaces, the space's code is E.
    assert.equal(text(meatPack(Uint8Array.from([...on, ...noSpaces, 0x1d, 0xbb]))), "G1EE");
    // Packing off: as it is (a comment, say).
    assert.equal(text(meatPack(Uint8Array.from([...off, ...new TextEncoder().encode("; hi\n")]))), "; hi\n");
});

// file builds a .bgcode: its header, then blocks [type, compression, data, params].
function file(blocks, { version = 1, checksum = 0 } = {}) {
    const parts = [];
    const head = new DataView(new ArrayBuffer(10));
    head.setUint32(0, 0x45444347, true); head.setUint32(4, version, true); head.setUint16(8, checksum, true);
    parts.push(new Uint8Array(head.buffer));
    for (const [type, compression, data, params = new Uint8Array(type === 5 ? 6 : 2), size = data.length] of blocks) {
        const packed = compression === 1 ? new Uint8Array(deflateSync(data)) : data;
        const h = new DataView(new ArrayBuffer(compression ? 12 : 8));
        h.setUint16(0, type, true); h.setUint16(2, compression, true); h.setUint32(4, size, true);
        if (compression) h.setUint32(8, packed.length, true);
        parts.push(new Uint8Array(h.buffer), params, packed, new Uint8Array(checksum ? 4 : 0));
    }
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
}
const enc = (s) => new TextEncoder().encode(s);

test("its blocks: metadata as comments, thumbnails passed over, G-code as it is or Deflate'd; what's refused", () => {
    const { gcode, thumbnails } = readBGCode(file([
        [0, 0, enc("Producer=PrusaSlicer 2.9.2\n")],
        [5, 0, Uint8Array.of(137, 80, 78, 71)],
        [4, 1, enc("estimated printing time (normal mode)=1h 2m 3s\n")],
        [1, 1, enc("G1 X1 E1\n")],
        [1, 0, enc("G1 X2 E2\n")],
    ], { checksum: 1 }), inflate);
    assert.equal(thumbnails, 1);
    assert.equal(text(gcode), "; generated by PrusaSlicer 2.9.2\n; estimated printing time (normal mode) = 1h 2m 3s\nG1 X1 E1\nG1 X2 E2\n");
    const g = parseGCode(gcode);
    assert.equal(g.slicer, "PrusaSlicer 2.9.2");
    assert.equal(g.time, 3723);
    // Only so much of its G-code: the rest, said to be left out.
    const big = readBGCode(file([[1, 0, enc("G1 X1 E1\n")], [1, 0, enc("G1 X2 E2\n")]]), inflate, { max: 12 });
    assert.equal(big.truncated, true);
    assert.equal(text(big.gcode), "G1 X1 E1\n");
    assert.throws(() => readBGCode(enc("GCODE, not"), inflate), /isn't binary G-code/);
    assert.throws(() => readBGCode(file([], { version: 2 }), inflate), /version 2/);
    assert.throws(() => readBGCode(file([[1, 0, enc("G1 X1\n")]]).slice(0, 20), inflate), /cut short/);
    assert.throws(() => readBGCode(file([[1, 9, enc("x")]]), inflate), /compressed in a way/);
    assert.throws(() => readBGCode(file([[7, 0, enc("x")]]), inflate), /kind this preview doesn't know/);
    assert.throws(() => readBGCode(file([[1, 2, Uint8Array.of(0), undefined, 65 << 20]]), inflate), /too big/);
    // Deflate'd, saying it's 10 bytes, but 10 MB: not unpacked past 10.
    const bomb = file([[1, 1, new Uint8Array(10 << 20), undefined, 10]]);
    assert.throws(() => readBGCode(bomb, inflate));
});
