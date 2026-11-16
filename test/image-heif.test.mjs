// HEIF (AVIF, HEIC) metadata: tabtopd/image-heif.js, on files made here
// box by box, so each way a file can say where its items are is tried.
// (The image build doesn't check this against libheif; the session that
// wrote it did, on libheif's and libavif's own sample files.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { heifType, heifMetadata, heifExif, heifReplaceExif } from "../tabtopd/image-heif.js";
import { exifOf, replaceExif, metadataOf, knownFrom } from "../tabtopd/image-meta.js";
import { readExif, editExif } from "../tabtopd/image-exif.js";

const enc = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
const num = (value, bytes) => { const out = new Uint8Array(bytes); for (let i = 0, v = BigInt(value); i < bytes; i++, v >>= 8n) out[bytes - 1 - i] = Number(v & 255n); return out; };
const box = (type, ...parts) => { const body = cat(...parts); return cat(num(8 + body.length, 4), enc(type), body); };
const full = (type, version, ...parts) => box(type, num(version, 1), num(0, 3), ...parts);

// A HEIF file: ftyp, meta (hdlr, pitm, iinf, iloc, iref, idat as asked),
// then mdat; or mdat first (`mdatFirst`). items: [{id, type, data,
// inIdat, split, toEnd, contentType}]. iloc: {version, offset, length,
// base, index} sizes; the first item's bytes given a base offset if base.
function heif({ brand = "heic", items, primary = 1, iloc = {}, irefVersion = 0, refs = [], mdatFirst = false }) {
    const { version = 1, offset = 4, length = 4, base = 0, index = 0 } = iloc;
    const ftyp = box("ftyp", enc(brand), num(0, 4), enc("mif1"), enc(brand));
    const infes = items.map((i) => full("infe", 2, num(i.id, 2), num(0, 2), enc(i.type), Uint8Array.of(0), ...(i.type === "mime" ? [enc(i.contentType ?? "application/rdf+xml"), Uint8Array.of(0)] : [])));
    const iinf = full("iinf", 0, num(items.length, 2), ...infes);
    const pitm = full("pitm", 0, num(primary, 2));
    const hdlr = full("hdlr", 0, num(0, 4), enc("pict"), new Uint8Array(12), Uint8Array.of(0));
    const iref = refs.length ? full("iref", irefVersion, ...refs.map((r) => box(r.type, num(r.from, irefVersion ? 4 : 2), num(r.to.length, 2), ...r.to.map((t) => num(t, irefVersion ? 4 : 2))))) : null;
    const idatItems = items.filter((i) => i.inIdat), idatData = cat(...idatItems.map((i) => i.data));
    const idat = idatItems.length ? box("idat", idatData) : null;
    const mdatItems = items.filter((i) => !i.inIdat), mdatData = cat(...mdatItems.map((i) => i.data));
    // iloc, made with where mdat's data begins (found by making it twice).
    const make = (mdatAt) => {
        const entries = [];
        let inMdat = mdatAt, inIdat = 0;
        for (const [n, i] of items.entries()) {
            const method = i.inIdat ? 1 : 0, at = i.inIdat ? inIdat : inMdat, b = n === 0 && base && method === 0 ? at - 3 : 0;
            const extents = i.split ? [[at - b, 3], [at + 3 - b, i.data.length - 3]] : [[at - b, i.toEnd ? 0 : i.data.length]];
            entries.push(cat(num(i.id, version < 2 ? 2 : 4), ...(version >= 1 ? [num(method, 2)] : []), num(0, 2), ...(base ? [num(b, base)] : []), num(extents.length, 2),
                ...extents.flatMap(([o, l]) => [...(index ? [num(0, index)] : []), num(o, offset), num(l, length)])));
            if (i.inIdat) inIdat += i.data.length; else inMdat += i.data.length;
        }
        return full("iloc", version, Uint8Array.of((offset << 4) | length, (base << 4) | (version >= 1 ? index : 0)), num(items.length, version < 2 ? 2 : 4), ...entries);
    };
    const metaOf = (mdatAt) => full("meta", 0, hdlr, pitm, make(mdatAt), iinf, ...(iref ? [iref] : []), ...(idat ? [idat] : []));
    if (mdatFirst) {
        const mdat = box("mdat", mdatData);
        return cat(ftyp, mdat, metaOf(ftyp.length + 8));
    }
    const first = metaOf(0), mdatAt = ftyp.length + first.length + 8;
    return cat(ftyp, metaOf(mdatAt), box("mdat", mdatData));
}
// An EXIF item's bytes: its offset to the TIFF header (here, past "Exif\0\0"), then that.
const exifItem = (tiff) => cat(num(6, 4), enc("Exif\0\0"), tiff);
const camera = () => editExif(null, { make: "Canon", model: "EOS R6", artist: "A. Photographer" }, { edits: [{ group: "GPS", tag: 1, type: 2, value: "N" }, { group: "GPS", tag: 2, type: 5, value: "1/1, 2/1, 3/1" }] });
// The picture's own bytes: what mustn't change.
const PICTURE = Uint8Array.from({ length: 300 }, (_, i) => (i * 37 + 11) & 255);

test("which files are HEIF, and of what kind", () => {
    const ftyp = (major, ...brands) => cat(box("ftyp", enc(major), num(0, 4), ...brands.map(enc)), new Uint8Array(8));
    assert.deepEqual([ftyp("heic"), ftyp("avif"), ftyp("mif1", "avif"), ftyp("mif1", "heic"), ftyp("mif1"), ftyp("isom", "mp41"), new Uint8Array(4), enc("\x89PNG\r\n\x1a\n\0\0\0\0")].map(heifType),
        ["image/heic", "image/avif", "image/avif", "image/heic", "image/heif", null, null, null]);
});

test("EXIF and XMP read from where iloc says, in each of its forms; written so other items stay put", () => {
    const tiff = camera(), xmp = enc("<x:xmpmeta>where</x:xmpmeta>");
    const layouts = [
        { name: "iloc 0, 4-byte offsets", iloc: { version: 0 } }, { name: "iloc 1, 8-byte offsets", iloc: { version: 1, offset: 8, length: 8 } },
        { name: "iloc 2 (32-bit ids)", iloc: { version: 2 } }, { name: "a base offset", iloc: { version: 1, base: 4 } }, { name: "an extent index", iloc: { version: 1, index: 4 } },
        { name: "EXIF in idat", exifInIdat: true }, { name: "EXIF in two pieces", split: true }, { name: "the picture to the file's end", pictureToEnd: true, pictureLast: true },
        { name: "mdat before meta", mdatFirst: true }, { name: "iref version 1", irefVersion: 1 }, { name: "AVIF", brand: "avif" },
    ];
    for (const l of layouts) {
        const picture = { id: 1, type: l.brand === "avif" ? "av01" : "hvc1", data: PICTURE, toEnd: l.pictureToEnd };
        const items = [{ id: 2, type: "Exif", data: exifItem(tiff), inIdat: l.exifInIdat, split: l.split }, { id: 3, type: "mime", data: xmp }];
        const file = heif({ brand: l.brand, items: l.pictureLast ? [...items, picture] : [picture, ...items], iloc: l.iloc, irefVersion: l.irefVersion, mdatFirst: l.mdatFirst,
            refs: [{ type: "cdsc", from: 2, to: [1] }, { type: "cdsc", from: 3, to: [1] }] });
        const type = heifType(file);
        assert.deepEqual(metadataOf(file, type), { kinds: ["EXIF", "XMP"], orientation: 1 }, l.name);
        assert.equal(readExif(exifOf(file, type)).fields.artist, "A. Photographer", l.name);
        const next = editExif(exifOf(file, type), { artist: "Someone Else" }, { removeGPS: true });
        const out = replaceExif(file, type, next), text = new TextDecoder("latin1").decode(out);
        assert.deepEqual([readExif(exifOf(out, type)).fields.artist, readExif(exifOf(out, type)).rows.some((r) => r.group === "GPS")], ["Someone Else", false], l.name);
        // What was taken out isn't in the file; the picture's bytes, and the XMP's, are, unchanged and where iloc says.
        assert.ok(!text.includes("A. Photographer"), `${l.name}: the old artist is left`);
        assert.ok(text.includes("<x:xmpmeta>where</x:xmpmeta>") && metadataOf(out, type).kinds.includes("XMP"), l.name);
        const at = text.indexOf(new TextDecoder("latin1").decode(PICTURE));
        assert.ok(at > 0, `${l.name}: the picture's bytes are gone`);
        // And it can be written again.
        assert.equal(readExif(exifOf(replaceExif(out, type, editExif(exifOf(out, type), { artist: "Third" })), type)).fields.artist, "Third", l.name);
    }
});

test("a file with no EXIF gets one: an item, described, linked to the picture, its bytes at the end", () => {
    for (const refs of [[], [{ type: "thmb", from: 4, to: [1] }]]) {
        const items = [{ id: 1, type: "hvc1", data: PICTURE }, ...(refs.length ? [{ id: 4, type: "hvc1", data: PICTURE.slice(0, 40) }] : [])];
        const file = heif({ items, refs }), type = heifType(file);
        assert.equal(exifOf(file, type), null);
        assert.deepEqual(metadataOf(file, type).kinds, []);
        const out = replaceExif(file, type, camera());
        assert.deepEqual([metadataOf(out, type).kinds, readExif(exifOf(out, type)).fields.make], [["EXIF"], "Canon"]);
        // (Its id is the next free one; the picture's link stays.)
        const text = new TextDecoder("latin1").decode(out);
        assert.ok(text.includes("cdsc") && (refs.length === 0 || text.includes("thmb")));
        assert.ok(text.indexOf(new TextDecoder("latin1").decode(PICTURE)) > 0);
    }
});

test("what's refused: sequences, several EXIF blocks, items elsewhere, and what doesn't hold together", () => {
    const tiff = camera();
    const two = heif({ items: [{ id: 1, type: "hvc1", data: PICTURE }, { id: 2, type: "Exif", data: exifItem(tiff) }, { id: 3, type: "Exif", data: exifItem(tiff) }] });
    assert.throws(() => heifExif(two), /multiple EXIF/);
    const sequence = cat(heif({ items: [{ id: 1, type: "hvc1", data: PICTURE }] }), box("moov", new Uint8Array(8)));
    assert.equal(heifExif(sequence), null);
    assert.throws(() => heifReplaceExif(sequence, tiff), /sequence/);
    for (const broken of [new Uint8Array(20), cat(box("ftyp", enc("heic"), num(0, 4)), box("mdat", PICTURE))]) assert.throws(() => heifExif(broken), Error);
    // An EXIF item whose offset to its TIFF header is past its end.
    const bad = heif({ items: [{ id: 1, type: "hvc1", data: PICTURE }, { id: 2, type: "Exif", data: cat(num(9999, 4), tiff) }] });
    assert.throws(() => heifExif(bad), /header offset/);
    // HEIF's metadata is anywhere in the file: its first bytes don't say it all.
    const file = heif({ items: [{ id: 1, type: "hvc1", data: PICTURE }] });
    assert.equal(knownFrom(file.subarray(0, 64), "image/heic", file.length), false);
});

test("cut short or with bytes changed anywhere: an error or an answer, never a hang, and never a file that loses the picture", () => {
    let seed = 7;
    const random = (n) => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
    const files = [heif({ items: [{ id: 1, type: "hvc1", data: PICTURE }, { id: 2, type: "Exif", data: exifItem(camera()) }], refs: [{ type: "cdsc", from: 2, to: [1] }] }),
        heif({ items: [{ id: 1, type: "av01", data: PICTURE }], iloc: { version: 2, offset: 8, length: 8 }, brand: "avif" })];
    const began = performance.now();
    for (const whole of files) {
        for (let n = 0; n < whole.length; n += 3) {
            const cut = whole.subarray(0, n);
            try { heifExif(cut); } catch (err) { assert.ok(err instanceof Error); }
            heifMetadata(cut);
        }
        for (let t = 0; t < 2000; t++) {
            const bytes = whole.slice();
            for (let k = 1 + random(3); k > 0; k--) bytes[random(bytes.length)] = [0, 0xff, 0x7f, random(256)][random(4)];
            heifMetadata(bytes);
            let out = null;
            try { out = heifReplaceExif(bytes, camera()); } catch (err) { assert.ok(err instanceof Error); }
            // Whatever's written still has the picture's bytes.
            if (out) assert.ok(new TextDecoder("latin1").decode(out).includes(new TextDecoder("latin1").decode(PICTURE.subarray(0, 60))) || !new TextDecoder("latin1").decode(bytes).includes(new TextDecoder("latin1").decode(PICTURE.subarray(0, 60))));
        }
    }
    assert.ok(performance.now() - began < 20000);
});

test("EXIF that shares its bytes with the picture (running to the end, before it): refused, not cleared with it", () => {
    const tiff = camera();
    const file = heif({ items: [{ id: 2, type: "Exif", data: exifItem(tiff), toEnd: true }, { id: 1, type: "hvc1", data: PICTURE }],
        refs: [{ type: "cdsc", from: 2, to: [1] }] });
    const before = file.slice();
    assert.throws(() => heifReplaceExif(file, camera()), /shares its bytes/);
    assert.deepEqual(file, before);
});
