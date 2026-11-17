// The quality a picture is written again at, by default: a JPEG's own
// (estimated from its quantization table), kept within 60–98; a lossless
// WebP losslessly; else 92.
import test from "node:test";
import assert from "node:assert/strict";
import { jpegQuality, webpLossless, savingQuality } from "../tabtopd/image-meta.js";

const STD = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
const ZZ = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56,
    57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];
// A JPEG's head as libjpeg writes it at quality q: its luminance table, in zigzag order.
const jpeg = (q, precision = 0) => {
    const s = q < 50 ? 5000 / q : 200 - 2 * q;
    const t = ZZ.map((i) => Math.min(255, Math.max(1, Math.floor((STD[i] * s + 50) / 100))));
    const body = precision ? t.flatMap((v) => [0, v]) : t;
    return Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0, body.length + 3, (precision << 4) | 0, ...body, 0xff, 0xda, 0, 2]);
};
const webp = (kind) => Uint8Array.from([..."RIFF"].map((c) => c.charCodeAt(0)).concat([20, 0, 0, 0], [..."WEBP" + kind].map((c) => c.charCodeAt(0)), [4, 0, 0, 0, 0, 0, 0, 0]));

test("a JPEG's quality, from its quantization table", () => {
    for (const q of [10, 30, 50, 70, 85, 92, 95, 100]) assert.equal(jpegQuality(jpeg(q)), q, `quality ${q}`);
    assert.equal(jpegQuality(jpeg(80, 1)), 80, "16-bit table");
    assert.equal(jpegQuality(Uint8Array.of(0xff, 0xd8, 0xff, 0xda, 0, 2)), null, "no table");
    assert.equal(jpegQuality(Uint8Array.of(1, 2, 3)), null, "not a JPEG");
});

test("written again at its own quality: within 60–98; a lossless WebP losslessly; else 92", () => {
    assert.deepEqual([30, 75, 99].map((q) => savingQuality(jpeg(q), "image/jpeg")), [60, 75, 98]);
    assert.equal(webpLossless(webp("VP8L")), true);
    assert.equal(webpLossless(webp("VP8 ")), false);
    assert.equal(savingQuality(webp("VP8L"), "image/webp"), 100);
    assert.equal(savingQuality(webp("VP8 "), "image/webp"), 92);
    assert.equal(savingQuality(Uint8Array.of(1), "image/png"), 92);
});
