// A picture's metadata, in its bytes, for the picture editor (see
// image-view.js): what a JPEG, PNG or WebP has (EXIF, XMP, IPTC, comments
// and text), its EXIF orientation; and the picture without it, losslessly
// (its pixels' bytes as they were), or a picture re-encoded given it back.
//
// Kept apart from metadata, as what the pixels mean rather than what's
// said of them: colour profiles (a JPEG's APP2 ICC, a PNG's iCCP, sRGB,
// gAMA, cHRM, a WebP's ICCP) and a JPEG's JFIF and Adobe segments.

const text = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const ascii = (b, at, s) => at + s.length <= b.length && [...s].every((c, i) => b[at + i] === c.charCodeAt(0));
const concat = (parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
};
const be32 = (n) => Uint8Array.of(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);

// --- EXIF (TIFF) ---------------------------------------------------------

// tiffOrientation is the Orientation (tag 0x0112) in TIFF data's first
// directory, 1 to 8, or 1 if it has none (or isn't TIFF).
export function tiffOrientation(tiff) {
    const at = orientationAt(tiff);
    if (at < 0) return 1;
    const little = tiff[0] === 0x49;
    const v = little ? tiff[at] | (tiff[at + 1] << 8) : (tiff[at] << 8) | tiff[at + 1];
    return v >= 1 && v <= 8 ? v : 1;
}

// orientationAt is where the Orientation's value is in TIFF data, or -1.
function orientationAt(tiff) {
    if (tiff.length < 8) return -1;
    const little = tiff[0] === 0x49 && tiff[1] === 0x49, big = tiff[0] === 0x4d && tiff[1] === 0x4d;
    if (!little && !big) return -1;
    const u16 = (i) => (little ? tiff[i] | (tiff[i + 1] << 8) : (tiff[i] << 8) | tiff[i + 1]);
    const u32 = (i) => (little ? (tiff[i] | (tiff[i + 1] << 8) | (tiff[i + 2] << 16) | (tiff[i + 3] << 24)) >>> 0
        : ((tiff[i] << 24) | (tiff[i + 1] << 16) | (tiff[i + 2] << 8) | tiff[i + 3]) >>> 0);
    if (u16(2) !== 42) return -1;
    const ifd = u32(4);
    if (ifd + 2 > tiff.length) return -1;
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 12 > tiff.length) return -1;
        if (u16(e) === 0x0112 && u16(e + 2) === 3) return e + 8;
    }
    return -1;
}

// upright is TIFF data said to be the right way up (Orientation 1), as a
// picture whose pixels have been turned to stand as it said is.
export function upright(tiff) {
    const out = tiff.slice();
    const at = orientationAt(out);
    if (at >= 0) {
        const little = out[0] === 0x49;
        out[at] = little ? 1 : 0;
        out[at + 1] = little ? 0 : 1;
    }
    return out;
}

// tiffReader is TIFF data's byte order, read: {u16, u32, put16, put32}
// (each of an offset), or null if it isn't TIFF.
function tiffReader(tiff) {
    if (tiff.length < 8) return null;
    const little = tiff[0] === 0x49 && tiff[1] === 0x49, big = tiff[0] === 0x4d && tiff[1] === 0x4d;
    if (!little && !big) return null;
    const r = {
        u16: (i) => (little ? tiff[i] | (tiff[i + 1] << 8) : (tiff[i] << 8) | tiff[i + 1]),
        u32: (i) => (little ? (tiff[i] | (tiff[i + 1] << 8) | (tiff[i + 2] << 16) | (tiff[i + 3] << 24)) >>> 0
            : ((tiff[i] << 24) | (tiff[i + 1] << 16) | (tiff[i + 2] << 8) | tiff[i + 3]) >>> 0),
        put16: (i, v) => {
            [tiff[i], tiff[i + 1]] = little ? [v & 255, v >> 8] : [v >> 8, v & 255];
        },
        put32: (i, v) => {
            const b = [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
            for (let k = 0; k < 4; k++) tiff[i + k] = little ? b[3 - k] : b[k];
        },
    };
    return r.u16(2) === 42 ? r : null;
}

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

// forPicture is TIFF data (an EXIF block) made fit to go with a picture
// made from the one it was of, width by height, upright: no thumbnail (a
// smaller copy of the picture as it was, uncropped, unturned), nor a
// maker's note (where cameras keep their own such previews), their bytes
// cleared, not just let go; its pixel dimensions the picture's; said to be
// upright. null if it can't be read well enough to be sure of that.
export function forPicture(tiff, width, height) {
    const out = tiff.slice();
    const r = tiffReader(out);
    if (!r) return null;
    const n = out.length;
    const clear = (at, len) => {
        if (at > n || len > n - at) throw new RangeError("outside the EXIF block");
        out.fill(0, at, at + len);
    };
    // entries is a directory's at offset: [{at (the entry), tag, type, count,
    // value (where its value is), size}], and where its next-directory
    // offset is.
    const entries = (ifd) => {
        if (ifd + 2 > n) throw new RangeError("a directory outside the EXIF block");
        const count = r.u16(ifd), list = [];
        if (ifd + 2 + count * 12 + 4 > n) throw new RangeError("a directory outside the EXIF block");
        for (let i = 0; i < count; i++) {
            const at = ifd + 2 + i * 12, type = r.u16(at + 2), num = r.u32(at + 4);
            const size = (TYPE_SIZE[type] ?? 1) * num;
            list.push({ at, tag: r.u16(at), type, count: num, size, value: size <= 4 ? at + 8 : r.u32(at + 8) });
        }
        return { list, next: ifd + 2 + count * 12 };
    };
    // drop is a directory without the entry at e, its value's bytes
    // cleared: those after it moved up, its count and next offset with them.
    const drop = (ifd, e) => {
        if (e.size > 4) clear(e.value, e.size);
        const count = r.u16(ifd), end = ifd + 2 + count * 12 + 4;
        out.copyWithin(e.at, e.at + 12, end);
        out.fill(0, end - 12, end);
        r.put16(ifd, count - 1);
    };
    const setSize = (e, v) => {
        if (e.count !== 1) return;
        if (e.type === 4) r.put32(e.value, v);
        else if (e.type === 3) r.put16(e.value, Math.min(v, 0xffff));
    };
    try {
        const ifd0 = r.u32(4);
        let dir = entries(ifd0);
        for (const e of dir.list) {
            if (e.tag === 0x0112 && e.type === 3) r.put16(e.value, 1);
            if (e.tag === 0x0100) setSize(e, width);
            if (e.tag === 0x0101) setSize(e, height);
        }
        // The next directory (IFD1) is the thumbnail's: its picture's bytes,
        // and it, cleared.
        const ifd1 = r.u32(dir.next);
        if (ifd1) {
            const thumb = entries(ifd1);
            const tag = (t) => thumb.list.find((e) => e.tag === t);
            const valuesOf = (e) => Array.from({ length: e?.count ?? 0 }, (_, i) => (e.type === 3 ? r.u16(e.value + i * 2) : r.u32(e.value + i * 4)));
            const [jpegAt, jpegLen] = [tag(0x0201), tag(0x0202)];
            if (jpegAt && jpegLen) clear(r.u32(jpegAt.value), r.u32(jpegLen.value));
            const strips = valuesOf(tag(0x0111)), lengths = valuesOf(tag(0x0117));
            strips.forEach((at, i) => clear(at, lengths[i] ?? 0));
            for (const e of thumb.list) if (e.size > 4) clear(e.value, e.size);
            clear(ifd1, thumb.next + 4 - ifd1);
            r.put32(dir.next, 0);
        }
        // The EXIF directory: its pixel dimensions, and no maker's note.
        const exifPointer = dir.list.find((e) => e.tag === 0x8769);
        if (exifPointer) {
            const exif = r.u32(exifPointer.value);
            let sub = entries(exif);
            const note = sub.list.find((e) => e.tag === 0x927c);
            if (note) {
                drop(exif, note);
                sub = entries(exif);
            }
            for (const e of sub.list) {
                if (e.tag === 0xa002) setSize(e, width);
                if (e.tag === 0xa003) setSize(e, height);
            }
        }
    } catch {
        return null;
    }
    return out;
}

// orientationOnly is TIFF data saying only an Orientation, o.
export function orientationOnly(o) {
    // Big-endian; one entry: tag 0x0112, SHORT, one, o; then no next IFD.
    return Uint8Array.of(0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, o, 0, 0, 0, 0, 0, 0, 0);
}

// --- JPEG ----------------------------------------------------------------

// jpegSegments is a JPEG's segments up to its image data: [{marker, start,
// end}] (end past the segment), and where the rest (from SOS) begins; or
// null if it isn't a JPEG.
function jpegSegments(b) {
    if (b[0] !== 0xff || b[1] !== 0xd8) return null;
    const segs = [];
    let at = 2;
    while (at + 4 <= b.length) {
        if (b[at] !== 0xff) return null;
        const marker = b[at + 1];
        if (marker === 0xff) { at++; continue; }
        if (marker === 0xda) return { segs, rest: at };
        const len = (b[at + 2] << 8) | b[at + 3];
        if (len < 2 || at + 2 + len > b.length) return null;
        segs.push({ marker, start: at, end: at + 2 + len });
        at += 2 + len;
    }
    return null;
}
const jpegKind = (b, s) => {
    const body = s.start + 4;
    if (s.marker === 0xe1 && ascii(b, body, "Exif\0\0")) return "EXIF";
    if (s.marker === 0xe1 && ascii(b, body, "http://ns.adobe.com/xap/1.0/")) return "XMP";
    if (s.marker === 0xe1) return "XMP"; // (extended XMP, and the like)
    if (s.marker === 0xed) return "IPTC";
    if (s.marker === 0xfe) return "comment";
    // APP3 to APP12, APP15: makers' notes and the like. (APP0 JFIF, APP2 ICC
    // and APP14 Adobe say how to read the pixels: kept.)
    if (s.marker >= 0xe3 && s.marker <= 0xef && s.marker !== 0xee) return "other";
    return null;
};
const jpegSegment = (marker, payload) => concat([Uint8Array.of(0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255), payload]);

// --- PNG -----------------------------------------------------------------

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const PNG_META = { tEXt: "text", zTXt: "text", iTXt: "text", eXIf: "EXIF", tIME: "time" };
let crcTable = null;
function crc32(bytes) {
    crcTable ??= Array.from({ length: 256 }, (_, n) => {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        return c >>> 0;
    });
    let c = 0xffffffff;
    for (const x of bytes) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function pngChunks(b) {
    if (!PNG_SIGNATURE.every((x, i) => b[i] === x)) return null;
    const chunks = [];
    let at = 8;
    while (at + 12 <= b.length) {
        const len = ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
        const type = String.fromCharCode(...b.subarray(at + 4, at + 8));
        if (at + 12 + len > b.length) return null;
        chunks.push({ type, start: at, end: at + 12 + len, data: b.subarray(at + 8, at + 8 + len) });
        at += 12 + len;
        if (type === "IEND") break;
    }
    return chunks;
}
const pngChunk = (type, data) => {
    const td = concat([text(type), data]);
    return concat([be32(data.length), td, be32(crc32(td))]);
};

// --- WebP ----------------------------------------------------------------

function webpChunks(b) {
    if (!ascii(b, 0, "RIFF") || !ascii(b, 8, "WEBP")) return null;
    const chunks = [];
    let at = 12;
    while (at + 8 <= b.length) {
        const len = (b[at + 4] | (b[at + 5] << 8) | (b[at + 6] << 16) | (b[at + 7] << 24)) >>> 0;
        const end = at + 8 + len + (len & 1);
        if (end > b.length + 1) return null;
        chunks.push({ type: String.fromCharCode(...b.subarray(at, at + 4)), start: at, end: Math.min(end, b.length), data: b.subarray(at + 8, at + 8 + len) });
        at = end;
    }
    return chunks;
}
const webpTiff = (data) => (ascii(data, 0, "Exif\0\0") ? data.subarray(6) : data);

// --- What it has ---------------------------------------------------------

// metadataOf is what metadata the picture bytes, of type, have: {kinds
// (["EXIF", "XMP", …], each once), orientation (its EXIF's, 1 if none)}.
export function metadataOf(bytes, type) {
    const kinds = new Set();
    let orientation = 1;
    if (type === "image/jpeg") {
        const j = jpegSegments(bytes);
        for (const s of j?.segs ?? []) {
            const k = jpegKind(bytes, s);
            if (k) kinds.add(k);
            if (k === "EXIF") orientation = tiffOrientation(bytes.subarray(s.start + 10, s.end));
        }
    } else if (type === "image/png") {
        for (const c of pngChunks(bytes) ?? []) {
            const k = PNG_META[c.type];
            if (k) kinds.add(k);
            if (c.type === "eXIf") orientation = tiffOrientation(c.data);
        }
    } else if (type === "image/webp") {
        for (const c of webpChunks(bytes) ?? []) {
            if (c.type === "EXIF") {
                kinds.add("EXIF");
                orientation = tiffOrientation(webpTiff(c.data));
            }
            if (c.type === "XMP ") kinds.add("XMP");
        }
    }
    kinds.delete("time"); // (a PNG's last-changed time alone: not worth a mention)
    return { kinds: [...kinds], orientation };
}

// knownFrom reports whether what metadataOf says of the first bytes of a
// picture, of type, holds for all of it: a JPEG's metadata all comes
// before its image data, but a PNG's or a WebP's chunks can come anywhere,
// to its end.
export function knownFrom(head, type, size) {
    if (head.length >= size) return true;
    if (type === "image/jpeg") return jpegSegments(head) !== null;
    return type !== "image/png" && type !== "image/webp";
}

// --- Without it, losslessly ----------------------------------------------

// stripped is the picture bytes, of type, without their metadata, the rest
// byte for byte; an EXIF orientation other than upright is kept, alone,
// as the picture would stand otherwise turned. null if it can't be (not
// a picture of that type, or a WebP that must keep its orientation).
export function stripped(bytes, type, orientation = metadataOf(bytes, type).orientation) {
    if (type === "image/jpeg") {
        const j = jpegSegments(bytes);
        if (!j) return null;
        const keep = j.segs.filter((s) => !jpegKind(bytes, s)).map((s) => bytes.subarray(s.start, s.end));
        const turn = orientation !== 1 ? [jpegSegment(0xe1, concat([text("Exif\0\0"), orientationOnly(orientation)]))] : [];
        // (After JFIF, if it's first: where an EXIF segment goes.)
        const jfif = keep.length && bytes[j.segs[0].start + 1] === 0xe0 && !jpegKind(bytes, j.segs[0]) ? 1 : 0;
        return concat([bytes.subarray(0, 2), ...keep.slice(0, jfif), ...turn, ...keep.slice(jfif), bytes.subarray(j.rest)]);
    }
    if (type === "image/png") {
        const chunks = pngChunks(bytes);
        if (!chunks) return null;
        const parts = [PNG_SIGNATURE];
        for (const c of chunks) {
            if (PNG_META[c.type]) continue;
            parts.push(bytes.subarray(c.start, c.end));
            if (c.type === "IHDR" && orientation !== 1) parts.push(pngChunk("eXIf", orientationOnly(orientation)));
        }
        return concat(parts);
    }
    if (type === "image/webp") {
        const chunks = webpChunks(bytes);
        if (!chunks || orientation !== 1) return null;
        const parts = [];
        for (const c of chunks) {
            if (c.type === "EXIF" || c.type === "XMP ") continue;
            const chunk = bytes.slice(c.start, c.end);
            // VP8X's flags: no EXIF (0x08), no XMP (0x04), now.
            if (c.type === "VP8X") chunk[8] &= ~0x0c;
            parts.push(chunk);
        }
        const body = concat(parts);
        const size = 4 + body.length;
        return concat([text("RIFF"), Uint8Array.of(size & 255, (size >>> 8) & 255, (size >>> 16) & 255, size >>> 24), text("WEBP"), body]);
    }
    return null;
}

// --- Given it back -------------------------------------------------------

// photoshopWithout is a JPEG's APP13 payload ("Photoshop 3.0\0", then its
// resources) without its thumbnails (resources 0x0409 and 0x040C), or null
// if it can't be read.
function photoshopWithout(payload) {
    const head = "Photoshop 3.0\0";
    if (!ascii(payload, 0, head)) return null;
    const keep = [payload.subarray(0, head.length)];
    let at = head.length;
    while (at < payload.length) {
        if (!ascii(payload, at, "8BIM") || at + 7 > payload.length) return null;
        const id = (payload[at + 4] << 8) | payload[at + 5];
        const nameLen = payload[at + 6];
        const sizeAt = at + 6 + ((1 + nameLen + 1) & ~1);
        if (sizeAt + 4 > payload.length) return null;
        const size = ((payload[sizeAt] << 24) | (payload[sizeAt + 1] << 16) | (payload[sizeAt + 2] << 8) | payload[sizeAt + 3]) >>> 0;
        const end = sizeAt + 4 + size + (size & 1);
        if (end > payload.length + 1) return null;
        if (id !== 0x0409 && id !== 0x040c) keep.push(payload.subarray(at, Math.min(end, payload.length)));
        at = end;
    }
    return concat(keep);
}

// XMP holding a picture (a thumbnail, base64, in xmpGImg's namespace).
const XMP_PICTURE = text("http://ns.adobe.com/xap/1.0/g/img/");
const holds = (b, s) => {
    outer: for (let i = 0; i + s.length <= b.length; i++) {
        for (let k = 0; k < s.length; k++) if (b[i + k] !== s[k]) continue outer;
        return true;
    }
    return false;
};

// withMetadata is encoded (a JPEG or PNG made from the picture original,
// of the same type, without metadata, as canvases make them), width by
// height, with original's metadata given it: its EXIF said to be upright
// (the pixels turned as it said), of a picture that size, and without the
// thumbnails and previews the original's metadata might have of itself
// (which would show it as it was: uncropped, say); the rest as it was.
// encoded as it was if either isn't one (a WebP, say).
export function withMetadata(encoded, original, type, width, height) {
    const exif = (tiff) => forPicture(tiff, width, height);
    if (type === "image/jpeg") {
        const o = jpegSegments(original), e = jpegSegments(encoded);
        if (!o || !e) return encoded;
        const meta = [];
        for (const s of o.segs) {
            const k = jpegKind(original, s);
            const payload = original.subarray(s.start + 4, s.end);
            if (!k || k === "other") continue;
            if (k === "EXIF") {
                const tiff = exif(payload.subarray(6));
                if (tiff) meta.push(jpegSegment(0xe1, concat([text("Exif\0\0"), tiff])));
            } else if (k === "IPTC") {
                const kept = photoshopWithout(payload);
                if (kept) meta.push(jpegSegment(0xed, kept));
            } else if (k === "XMP" && holds(payload, XMP_PICTURE)) {
                continue;
            } else meta.push(original.subarray(s.start, s.end));
        }
        // Without any the encoder put there, then the original's, after JFIF.
        const own = e.segs.filter((s) => !jpegKind(encoded, s)).map((s) => encoded.subarray(s.start, s.end));
        const jfif = own.length && encoded[e.segs.find((s) => !jpegKind(encoded, s)).start + 1] === 0xe0 ? 1 : 0;
        return concat([encoded.subarray(0, 2), ...own.slice(0, jfif), ...meta, ...own.slice(jfif), encoded.subarray(e.rest)]);
    }
    if (type === "image/png") {
        const o = pngChunks(original), e = pngChunks(encoded);
        if (!o || !e) return encoded;
        const meta = [];
        for (const c of o) {
            if (!PNG_META[c.type] || c.type === "tIME") continue;
            if (c.type === "eXIf") {
                const tiff = exif(c.data);
                if (tiff) meta.push(pngChunk("eXIf", tiff));
                continue;
            }
            // Text: not EXIF, IPTC or the like as text ("Raw profile type
            // exif", ImageMagick's), which can't be gone through here, nor
            // compressed XMP, nor XMP holding a picture.
            const keyword = String.fromCharCode(...c.data.subarray(0, Math.max(0, c.data.indexOf(0))));
            if (/^Raw profile type /i.test(keyword)) continue;
            if (c.type === "iTXt" && keyword === "XML:com.adobe.xmp" && (c.data[keyword.length + 1] !== 0 || holds(c.data, XMP_PICTURE))) continue;
            meta.push(original.subarray(c.start, c.end));
        }
        const parts = [PNG_SIGNATURE];
        for (const c of e) {
            if (PNG_META[c.type]) continue;
            parts.push(encoded.subarray(c.start, c.end));
            if (c.type === "IHDR") parts.push(...meta);
        }
        return concat(parts);
    }
    return encoded;
}
