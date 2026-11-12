import { test } from "node:test";
import assert from "node:assert/strict";
import { knownFrom, metadataOf, stripped, withMetadata, tiffOrientation, upright, orientationOnly } from "../tabtopd/image-meta.js";

const t = (s) => [...s].map((c) => c.charCodeAt(0));
const seg = (marker, payload) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255, ...payload];
// Little-endian TIFF, with an Orientation, o, and another tag.
const tiff = (o) => [0x49, 0x49, 42, 0, 8, 0, 0, 0, 2, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, o, 0, 0, 0, 0x0f, 0x01, 2, 0, 4, 0, 0, 0, ...t("Cam\0"), 0, 0, 0, 0];
const scan = [0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0x12, 0x34, 0x56, 0xff, 0xd9];
const jpeg = (o = 6) => Uint8Array.from([0xff, 0xd8,
    ...seg(0xe0, t("JFIF\0\x01\x01\0\0\x01\0\x01\0\0")),
    ...seg(0xe1, [...t("Exif\0\0"), ...tiff(o)]),
    ...seg(0xe1, t("http://ns.adobe.com/xap/1.0/\0<x/>")),
    ...seg(0xe2, t("ICC_PROFILE\0\x01\x01colour")),
    ...seg(0xed, [...t("Photoshop 3.0\0"), ...t("8BIM"), 0x04, 0x04, 0, 0, 0, 0, 0, 4, ...t("iptc")]),
    ...seg(0xfe, t("a comment")),
    ...seg(0xdb, [0, ...Array(64).fill(1)]),
    ...scan]);

test("EXIF orientation, read and set upright, in either byte order", () => {
    assert.equal(tiffOrientation(Uint8Array.from(tiff(6))), 6);
    assert.equal(tiffOrientation(upright(Uint8Array.from(tiff(6)))), 1);
    assert.equal(tiffOrientation(orientationOnly(8)), 8);
    assert.equal(tiffOrientation(upright(orientationOnly(8))), 1);
    assert.equal(tiffOrientation(Uint8Array.of(1, 2, 3)), 1);
});

test("a JPEG: its metadata found; stripped, losslessly, its orientation kept alone; given back, upright", () => {
    const j = jpeg(6);
    assert.deepEqual(metadataOf(j, "image/jpeg"), { kinds: ["EXIF", "XMP", "IPTC", "comment"], orientation: 6 });
    const s = stripped(j, "image/jpeg");
    // The orientation alone, as EXIF, so it stands as it did; the colour
    // profile and the image data as they were.
    assert.deepEqual(metadataOf(s, "image/jpeg"), { kinds: ["EXIF"], orientation: 6 });
    assert.ok(Buffer.from(s).includes(Buffer.from("ICC_PROFILE")));
    assert.ok(!Buffer.from(s).includes(Buffer.from("Cam")) && !Buffer.from(s).includes(Buffer.from("a comment")));
    assert.deepEqual([...s.subarray(s.length - scan.length)], scan);
    assert.deepEqual([...s.subarray(0, 4)], [0xff, 0xd8, 0xff, 0xe0], "JFIF first still");
    // Upright already: no EXIF at all.
    assert.deepEqual(metadataOf(stripped(jpeg(1), "image/jpeg"), "image/jpeg").kinds, []);
    // Re-encoded (as a canvas makes it), given its metadata back: upright,
    // and not the colour profile (the canvas's pixels are sRGB).
    const encoded = Uint8Array.from([0xff, 0xd8, ...seg(0xe0, t("JFIF\0\x01\x01\0\0\x01\0\x01\0\0")), ...seg(0xdb, [0, ...Array(64).fill(2)]), ...scan]);
    const back = withMetadata(encoded, j, "image/jpeg");
    assert.deepEqual(metadataOf(back, "image/jpeg"), { kinds: ["EXIF", "XMP", "IPTC", "comment"], orientation: 1 });
    assert.ok(Buffer.from(back).includes(Buffer.from("Cam")));
    assert.ok(!Buffer.from(back).includes(Buffer.from("ICC_PROFILE")));
    assert.deepEqual([...back.subarray(back.length - scan.length)], scan);
});

// A PNG's chunk, its CRC worked out as the module does, independently.
const crc = (bytes) => {
    let c = 0xffffffff;
    for (const b of bytes) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
    return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
    const td = [...t(type), ...data], sum = crc(td);
    return [data.length >>> 24, (data.length >>> 16) & 255, (data.length >>> 8) & 255, data.length & 255, ...td, sum >>> 24, (sum >>> 16) & 255, (sum >>> 8) & 255, sum & 255];
};
const chunksOf = (b) => {
    const out = [];
    for (let at = 8; at < b.length;) {
        const len = (b[at] << 24 | b[at + 1] << 16 | b[at + 2] << 8 | b[at + 3]) >>> 0;
        const type = String.fromCharCode(...b.subarray(at + 4, at + 8));
        const sum = (b[at + 8 + len] << 24 | b[at + 9 + len] << 16 | b[at + 10 + len] << 8 | b[at + 11 + len]) >>> 0;
        assert.equal(sum, crc(b.subarray(at + 4, at + 8 + len)), `${type}'s CRC`);
        out.push(type);
        at += 12 + len;
    }
    return out;
};
const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

test("a PNG: text and EXIF stripped (the orientation kept), colour kept, CRCs right; given back, upright", () => {
    const p = Uint8Array.from([...sig, ...chunk("IHDR", Array(13).fill(1)), ...chunk("tEXt", t("Author\0me")), ...chunk("eXIf", tiff(3)),
        ...chunk("iCCP", t("p\0\0x")), ...chunk("tIME", Array(7).fill(1)), ...chunk("IDAT", [9, 9, 9]), ...chunk("IEND", [])]);
    assert.deepEqual(metadataOf(p, "image/png"), { kinds: ["text", "EXIF"], orientation: 3 });
    const s = stripped(p, "image/png");
    assert.deepEqual(chunksOf(s), ["IHDR", "eXIf", "iCCP", "IDAT", "IEND"]);
    assert.equal(metadataOf(s, "image/png").orientation, 3);
    const encoded = Uint8Array.from([...sig, ...chunk("IHDR", Array(13).fill(2)), ...chunk("IDAT", [7]), ...chunk("IEND", [])]);
    const back = withMetadata(encoded, p, "image/png");
    assert.deepEqual(chunksOf(back), ["IHDR", "tEXt", "eXIf", "IDAT", "IEND"]);
    assert.deepEqual(metadataOf(back, "image/png"), { kinds: ["text", "EXIF"], orientation: 1 });
});

test("a WebP: EXIF and XMP chunks and their flags gone, the size right; not if it must keep its orientation", () => {
    const riff = (chunks) => {
        const body = chunks.flatMap(([type, data]) => [...t(type), data.length & 255, (data.length >> 8) & 255, 0, 0, ...data, ...(data.length & 1 ? [0] : [])]);
        const size = 4 + body.length;
        return Uint8Array.from([...t("RIFF"), size & 255, size >> 8 & 255, 0, 0, ...t("WEBP"), ...body]);
    };
    const w = (o) => riff([["VP8X", [0x0c | 0x20, 0, 0, 0, 1, 0, 0, 1, 0, 0]], ["ICCP", [1, 2]], ["VP8 ", [5, 5, 5]], ["EXIF", tiff(o)], ["XMP ", t("<x/>")]]);
    assert.deepEqual(metadataOf(w(1), "image/webp"), { kinds: ["EXIF", "XMP"], orientation: 1 });
    const s = stripped(w(1), "image/webp");
    assert.deepEqual(metadataOf(s, "image/webp").kinds, []);
    assert.equal(s[20], 0x20, "the ICC flag kept, EXIF's and XMP's cleared");
    assert.equal(s[4] | s[5] << 8, s.length - 8, "the RIFF size");
    assert.ok(Buffer.from(s).includes(Buffer.from("ICCP")) && Buffer.from(s).includes(Buffer.from("VP8 ")));
    assert.equal(stripped(w(6), "image/webp"), null);
});

// A camera's EXIF, little-endian: IFD0 (Orientation 6, Make, a pointer to
// the EXIF directory), the EXIF directory (a maker's note with a preview
// in it, PixelXDimension, PixelYDimension), and IFD1, a thumbnail's.
const cameraTiff = () => {
    const b = new Uint8Array(200);
    const v = new DataView(b.buffer);
    const entry = (at, tag, type, count, value) => {
        v.setUint16(at, tag, true); v.setUint16(at + 2, type, true); v.setUint32(at + 4, count, true);
        if (type === 3 && count === 1) v.setUint16(at + 8, value, true); else v.setUint32(at + 8, value, true);
    };
    b.set([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
    // IFD0 at 8: 3 entries, next IFD at 120.
    v.setUint16(8, 3, true);
    entry(10, 0x0112, 3, 1, 6);
    entry(22, 0x010f, 2, 4, 0); b.set(t("Cam\0"), 30);
    entry(34, 0x8769, 4, 1, 50);
    v.setUint32(46, 120, true);
    // EXIF directory at 50: 3 entries; the note's 12 bytes at 100.
    v.setUint16(50, 3, true);
    entry(52, 0x927c, 7, 12, 100);
    entry(64, 0xa002, 4, 1, 4000);
    entry(76, 0xa003, 3, 1, 3000);
    v.setUint32(88, 0, true);
    b.set(t("NOTEPREVIEW!"), 100);
    // IFD1 at 120: 2 entries; its JPEG's 16 bytes at 160.
    v.setUint16(120, 2, true);
    entry(122, 0x0201, 4, 1, 160);
    entry(134, 0x0202, 4, 1, 16);
    v.setUint32(146, 0, true);
    b.set(t("THUMBNAILTHUMBNA"), 160);
    return b;
};

test("EXIF given back with a re-encoded picture: no thumbnail or maker's note left, its size the new one's, upright", () => {
    const tiffIn = cameraTiff();
    const j = Uint8Array.from([0xff, 0xd8, ...seg(0xe1, [...t("Exif\0\0"), ...tiffIn]),
        ...seg(0xed, [...t("Photoshop 3.0\0"), ...t("8BIM"), 0x04, 0x04, 0, 0, 0, 0, 0, 2, 7, 7, ...t("8BIM"), 0x04, 0x0c, 0, 0, 0, 0, 0, 4, ...t("TMB!")]),
        ...seg(0xe1, t("http://ns.adobe.com/xap/1.0/\0<x xmlns:xmpGImg='http://ns.adobe.com/xap/1.0/g/img/'/>")),
        ...seg(0xdb, [0, ...Array(64).fill(1)]), ...scan]);
    const encoded = Uint8Array.from([0xff, 0xd8, ...seg(0xdb, [0, ...Array(64).fill(2)]), ...scan]);
    const back = withMetadata(encoded, j, "image/jpeg", 300, 200);
    const has = (s) => Buffer.from(back).includes(Buffer.from(s));
    assert.ok(!has("THUMBNAIL") && !has("NOTEPREVIEW") && !has("TMB!"), "no thumbnail, preview or Photoshop thumbnail");
    assert.ok(!has("xmpGImg"), "no XMP holding a picture");
    assert.ok(has("Cam") && has("Photoshop 3.0"), "the rest kept");
    assert.deepEqual(metadataOf(back, "image/jpeg"), { kinds: ["EXIF", "IPTC"], orientation: 1 });
    const at = Buffer.from(back).indexOf("Exif\0\0") + 6;
    const tiffOut = new DataView(back.buffer, back.byteOffset + at);
    assert.equal(tiffOut.getUint32(46, true), 0, "no IFD1");
    assert.equal(tiffOut.getUint16(50, true), 2, "the EXIF directory, less its note");
    assert.equal(tiffOut.getUint16(52, true), 0xa002);
    assert.equal(tiffOut.getUint32(60, true), 300);
    assert.equal(tiffOut.getUint16(64, true), 0xa003);
    assert.equal(tiffOut.getUint16(72, true), 200);
    // EXIF that can't be read well enough: left out, not given back whole.
    const bad = cameraTiff();
    new DataView(bad.buffer).setUint32(46, 5000, true);
    const j2 = Uint8Array.from([0xff, 0xd8, ...seg(0xe1, [...t("Exif\0\0"), ...bad]), ...seg(0xdb, [0, ...Array(64).fill(1)]), ...scan]);
    assert.deepEqual(metadataOf(withMetadata(encoded, j2, "image/jpeg", 300, 200), "image/jpeg").kinds, []);
});

test("what a picture's first bytes say of its metadata: a JPEG's, once they reach its image data; a PNG's or WebP's, only all of it", () => {
    const j = jpeg(6);
    const scanAt = Buffer.from(j).indexOf(Buffer.from([0xff, 0xda]));
    assert.equal(knownFrom(j.subarray(0, scanAt + 4), "image/jpeg", j.length + 1000), true);
    assert.equal(knownFrom(j.subarray(0, 30), "image/jpeg", j.length), false);
    assert.equal(knownFrom(Uint8Array.of(1, 2), "image/png", 10), false);
    assert.equal(knownFrom(Uint8Array.of(1, 2), "image/png", 2), true);
    assert.equal(knownFrom(Uint8Array.of(1, 2), "image/gif", 10), true);
});

test("CRC-32 is the standard one, and the same had a part at a time", async () => {
    const { crc32 } = await import("../tabtopd/image-meta.js");
    const bytes = new TextEncoder().encode("123456789");
    assert.equal(crc32(bytes), 0xcbf43926);
    assert.equal(crc32(bytes.subarray(4), crc32(bytes.subarray(0, 4))), 0xcbf43926);
    assert.equal(crc32(new Uint8Array()), 0);
});
