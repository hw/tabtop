// HEIF pictures (AVIF, HEIC): ISO base media files, a tree of boxes, whose
// metadata are items of the "meta" box: an "infe" in "iinf" says what each
// item is ("Exif"; "mime" of application/rdf+xml, XMP), and "iloc" where
// its bytes are (in the file, or in "idat"). An EXIF item's bytes are a
// 4-byte count of bytes before its TIFF header, then the TIFF block.
//
// heifExif reads the EXIF block; heifReplaceExif writes a new one: a new
// item where there was none (described in iinf, linked to the picture by
// iref's "cdsc"), its bytes in an "mdat" of their own at the file's end;
// the old bytes cleared (so what was removed is gone), and the meta box
// written again, every other item's place moved by as much as it grew.
// The pictures' own bytes stay as they were. Everything is read as
// possibly wrong: counts, sizes and offsets are checked, and what doesn't
// hold together is refused, not guessed at.

const MAX_ITEMS = 4096, MAX_EXTENTS = 65536;
const ascii = (b, at, s) => at + s.length <= b.length && [...s].every((c, i) => b[at + i] === c.charCodeAt(0));
const enc = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const fail = (why) => { throw new Error(why); };

// The brands that say a file is a HEIF picture, and of which kind.
const BRANDS = { avif: "image/avif", avis: "image/avif", heic: "image/heic", heix: "image/heic", heim: "image/heic", heis: "image/heic",
    hevc: "image/heic", hevx: "image/heic", mif1: "image/heif", msf1: "image/heif" };
export const HEIF_TYPES = new Set(["image/avif", "image/heic", "image/heif"]);

// heifType is the type the file's first bytes say it is ("image/avif",
// "image/heic", "image/heif"), or null if it isn't HEIF.
export function heifType(bytes) {
    if (bytes.length < 12 || !ascii(bytes, 4, "ftyp")) return null;
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    const brands = [String.fromCharCode(...bytes.subarray(8, 12))];
    for (let at = 16; at + 4 <= Math.min(size, bytes.length); at += 4) brands.push(String.fromCharCode(...bytes.subarray(at, at + 4)));
    for (const prefer of ["avif", "avis", "heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1"]) if (brands.includes(prefer)) return BRANDS[prefer];
    return null;
}

// The boxes from begin to end of bytes: [{type, start, header, end}];
// null if they don't fit exactly.
function boxes(bytes, begin = 0, end = bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), out = [];
    for (let at = begin; at < end;) {
        if (end - at < 8) return null;
        let size = view.getUint32(at), header = 8;
        const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
        if (size === 1) {
            if (end - at < 16) return null;
            const big = view.getBigUint64(at + 8);
            if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
            size = Number(big); header = 16;
        } else if (size === 0) size = end - at; // to the end
        if (size < header || at + size > end) return null;
        if (type === "uuid") header += 16;
        if (header > size) return null;
        out.push({ type, start: at, header, end: at + size });
        if (out.length > 100000) return null;
        at += size;
    }
    return out;
}

// A reader of big-endian fields from `at` on, that can't read past `end`.
function cursor(bytes, at, end) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const need = (n) => { if (at + n > end) fail("The HEIF metadata is cut short."); };
    return {
        get at() { return at; },
        u8() { need(1); return view.getUint8(at++); },
        u16() { need(2); const v = view.getUint16(at); at += 2; return v; },
        u32() { need(4); const v = view.getUint32(at); at += 4; return v; },
        // An unsigned number of n bytes (0, 4 or 8; 8 must be safe).
        un(n) {
            if (n === 0) return 0;
            if (n === 4) return this.u32();
            if (n === 8) { need(8); const v = view.getBigUint64(at); at += 8; if (v > BigInt(Number.MAX_SAFE_INTEGER)) fail("A HEIF offset is too large."); return Number(v); }
            fail("Unsupported HEIF field size.");
        },
        str() { const from = at; while (at < end && bytes[at]) at++; need(1); const s = new TextDecoder().decode(bytes.subarray(from, at)); at++; return s; },
        skip(n) { need(n); at += n; },
    };
}

// The meta box's parts: its version and flags, its children; and from
// them, the primary item, every item's type, where each is, and its links.
function readMeta(bytes) {
    const top = boxes(bytes);
    if (!top || top[0]?.type !== "ftyp") fail("This isn't a HEIF file whose boxes hold together.");
    const metas = top.filter((b) => b.type === "meta");
    if (metas.length !== 1) fail("A HEIF file needs exactly one meta box.");
    const meta = metas[0];
    if (meta.end - meta.start < meta.header + 4) fail("The HEIF meta box is cut short.");
    const children = boxes(bytes, meta.start + meta.header + 4, meta.end);
    if (!children) fail("The HEIF meta box's contents don't hold together.");
    const child = (type) => {
        const found = children.filter((c) => c.type === type);
        if (found.length > 1) fail(`The HEIF meta box has more than one ${type}.`);
        return found[0] ?? null;
    };
    const pitm = child("pitm"), iinf = child("iinf"), iloc = child("iloc"), iref = child("iref"), idat = child("idat");
    if (!iinf || !iloc) fail("The HEIF meta box has no item information or locations.");
    // Primary item.
    let primary = null;
    if (pitm) { const c = cursor(bytes, pitm.start + pitm.header, pitm.end), v = c.u8(); c.skip(3); primary = v === 0 ? c.u16() : c.u32(); }
    // Items' types (infe, versions 2 and 3).
    const types = new Map(), contentTypes = new Map();
    {
        const c = cursor(bytes, iinf.start + iinf.header, iinf.end), v = c.u8(); c.skip(3);
        const count = v === 0 ? c.u16() : c.u32();
        if (count > MAX_ITEMS) fail("The HEIF file has too many items.");
        const entries = boxes(bytes, c.at, iinf.end);
        if (!entries || entries.length !== count) fail("The HEIF item information doesn't hold together.");
        for (const e of entries) {
            if (e.type !== "infe") continue;
            const r = cursor(bytes, e.start + e.header, e.end), ev = r.u8(); r.skip(3);
            if (ev < 2) continue; // (versions 0 and 1 have no item type: not one of these)
            const id = ev === 2 ? r.u16() : r.u32(); r.u16(); // protection index
            const type = String.fromCharCode(r.u8(), r.u8(), r.u8(), r.u8());
            types.set(id, type);
            if (type === "mime") { r.str(); contentTypes.set(id, r.at < e.end ? r.str() : ""); }
        }
    }
    // Where each item is (iloc versions 0 to 2).
    const loc = (() => {
        const c = cursor(bytes, iloc.start + iloc.header, iloc.end), version = c.u8(); c.skip(3);
        if (version > 2) fail("Unsupported HEIF item locations.");
        const a = c.u8(), b = c.u8();
        const sizes = { offset: a >> 4, length: a & 15, base: b >> 4, index: version >= 1 ? b & 15 : 0 };
        for (const n of Object.values(sizes)) if (![0, 4, 8].includes(n)) fail("Unsupported HEIF item location sizes.");
        const count = version < 2 ? c.u16() : c.u32();
        if (count > MAX_ITEMS) fail("The HEIF file has too many items.");
        const items = [];
        let extents = 0;
        for (let i = 0; i < count; i++) {
            const id = version < 2 ? c.u16() : c.u32();
            const method = version >= 1 ? c.u16() & 15 : 0;
            const reference = c.u16(), base = c.un(sizes.base), n = c.u16();
            if ((extents += n) > MAX_EXTENTS) fail("The HEIF file has too many item pieces.");
            const list = [];
            for (let k = 0; k < n; k++) list.push({ index: c.un(sizes.index), offset: c.un(sizes.offset), length: c.un(sizes.length) });
            items.push({ id, method, reference, base, extents: list });
        }
        return { version, sizes, items };
    })();
    // Links between items (iref: references of each type, from one to others).
    const refs = [];
    let irefVersion = 0;
    if (iref) {
        const c = cursor(bytes, iref.start + iref.header, iref.end);
        irefVersion = c.u8(); c.skip(3);
        const list = boxes(bytes, c.at, iref.end);
        if (!list) fail("The HEIF item links don't hold together.");
        for (const r of list) {
            const rc = cursor(bytes, r.start + r.header, r.end), id = () => (irefVersion === 0 ? rc.u16() : rc.u32());
            const from = id(), n = rc.u16(), to = [];
            for (let k = 0; k < n; k++) to.push(id());
            refs.push({ type: r.type, from, to });
        }
    }
    return { top, meta, children, primary, types, contentTypes, loc, refs, irefVersion, idat };
}

// An item's pieces, where they are in the file: [[begin, end]…]; null if
// any is outside the file (or its idat), or they come to more than the
// file (pieces may repeat what's in it: not so many times over). A piece
// whose length is 0 runs to the end of the file (or of idat).
function itemRanges(bytes, m, item) {
    if (item.reference !== 0 || item.method > 1) return null;
    if (item.method === 1 && !m.idat) return null;
    const ranges = [];
    let total = 0;
    for (const e of item.extents) {
        const begin = item.method === 0 ? item.base + e.offset : m.idat.start + m.idat.header + item.base + e.offset;
        const limit = item.method === 0 ? bytes.length : m.idat.end;
        const end = e.length === 0 ? limit : begin + e.length;
        if (begin < 0 || end > limit || end < begin) return null;
        total += end - begin;
        if (total > bytes.length) return null;
        ranges.push([begin, end]);
    }
    return ranges;
}

// An item's bytes: its pieces, one after another; null if they aren't
// where they can be (see itemRanges).
function itemBytes(bytes, m, item) {
    const ranges = itemRanges(bytes, m, item);
    if (!ranges) return null;
    const parts = ranges.map(([begin, end]) => bytes.subarray(begin, end));
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
}

// The EXIF items (by their links, those of the primary picture first).
function exifItems(m) {
    return m.loc.items.filter((i) => m.types.get(i.id) === "Exif");
}

// heifMetadata is what metadata a HEIF file has: ["EXIF", "XMP"]; and its
// EXIF orientation (which, in HEIF, isn't what turns the picture: its own
// irot and imir do, as browsers show it; so it's said as 1).
export function heifMetadata(bytes) {
    try {
        const m = readMeta(bytes), kinds = [];
        if (exifItems(m).length) kinds.push("EXIF");
        if ([...m.contentTypes.values()].some((t) => t === "application/rdf+xml")) kinds.push("XMP");
        return { kinds, orientation: 1 };
    } catch {
        return { kinds: [], orientation: 1 };
    }
}

// heifExif is the file's EXIF block (from its TIFF header), or null if it
// has none. It throws for one it can't read, or that has more than one.
export function heifExif(bytes) {
    const m = readMeta(bytes), items = exifItems(m);
    if (items.length > 1) fail("This image has multiple EXIF blocks; editing them is not supported.");
    if (!items.length) return null;
    const data = itemBytes(bytes, m, items[0]);
    if (!data || data.length < 4) fail("The EXIF item's bytes are outside the file.");
    const skip = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
    if (4 + skip > data.length) fail("The EXIF item's header offset is outside it.");
    return data.subarray(4 + skip);
}

// A box of type with these contents (a full box's version and flags among them).
function box(type, ...parts) {
    const size = 8 + parts.reduce((n, p) => n + p.length, 0), out = new Uint8Array(size), view = new DataView(out.buffer);
    view.setUint32(0, size);
    out.set(enc(type), 4);
    let at = 8;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
}
function fields(...list) {
    const size = list.reduce((n, [, bytes]) => n + bytes, 0), out = new Uint8Array(size), view = new DataView(out.buffer);
    let at = 0;
    for (const [value, bytes] of list) {
        if (bytes === 1) view.setUint8(at, value);
        else if (bytes === 2) view.setUint16(at, value);
        else if (bytes === 4) view.setUint32(at, value);
        else if (bytes === 8) view.setBigUint64(at, BigInt(value));
        at += bytes;
    }
    return out;
}

// heifReplaceExif is the file with tiff as its EXIF block (see above).
export function heifReplaceExif(bytes, tiff) {
    const m = readMeta(bytes);
    if (m.top.some((b) => b.type === "moov")) fail("EXIF can't be changed in a HEIF image sequence.");
    if (m.loc.items.some((i) => i.reference !== 0)) fail("EXIF can't be changed where items are in other files.");
    const old = exifItems(m);
    if (old.length > 1) fail("This image has multiple EXIF blocks; editing them is not supported.");
    if (m.primary == null) fail("The HEIF file has no primary picture.");
    const out = bytes.slice();
    // The old EXIF bytes cleared, so what was taken out isn't left in the
    // file: unless they're another item's too (or, not in idat, meta's), as
    // clearing them would lose that.
    if (old.length) {
        const ranges = itemRanges(bytes, m, old[0]);
        if (!ranges) fail("The EXIF item's bytes are outside the file.");
        const overlaps = (a, b) => a[0] < b[1] && b[0] < a[1];
        for (const other of m.loc.items) {
            if (other.id === old[0].id) continue;
            const theirs = itemRanges(bytes, m, other) ?? [];
            if (ranges.some((r) => theirs.some((t) => overlaps(r, t)))) fail("This image's EXIF shares its bytes with another part of it; it can't be changed safely.");
        }
        if (old[0].method === 0 && ranges.some((r) => overlaps(r, [m.meta.start, m.meta.end]))) fail("This image's EXIF shares its bytes with another part of it; it can't be changed safely.");
        for (const [begin, end] of ranges) out.fill(0, begin, end);
    }
    const exifId = old[0]?.id ?? Math.max(0, ...m.loc.items.map((i) => i.id), ...m.types.keys()) + 1;
    const payload = new Uint8Array(4 + tiff.length);
    payload.set(tiff, 4); // (no bytes before its TIFF header)

    // The item locations, written again: every item where it was, but for
    // the EXIF one, which is in a new mdat at the end; with fields wide
    // enough for every place, version 1 where an item is in idat, 2 where
    // ids need 32 bits.
    const items = m.loc.items.filter((i) => i.id !== exifId).map((i) => ({ ...i, extents: i.extents.map((e) => ({ ...e })) }));
    const exifItem = { id: exifId, method: 0, reference: 0, base: 0, extents: [{ index: 0, offset: -1, length: payload.length }] };
    items.push(exifItem);
    const wide = items.some((i) => i.id > 0xffff), version = wide ? 2 : items.some((i) => i.method !== 0) || m.loc.version === 1 ? 1 : 0;
    const usesIndex = version >= 1 && m.loc.sizes.index > 0;

    // The new meta box, made with the offsets of items in the file moved
    // by `delta` (how much larger it is, for those after it); made twice:
    // the second time with the delta the first said.
    const metaStart = m.meta.start, oldMetaEnd = m.meta.end;
    const build = (delta, exifAt) => {
        const moved = items.map((i) => {
            if (i === exifItem) return { ...i, extents: [{ index: 0, offset: exifAt, length: payload.length }] };
            if (i.method !== 0) return i;
            // Absolute places, each moved if it's after where meta began;
            // one that ran to the file's end given its length (the EXIF's
            // mdat is after it now).
            return { ...i, base: 0, extents: i.extents.map((e) => {
                const at = i.base + e.offset, length = e.length === 0 ? bytes.length - at : e.length;
                return { ...e, offset: at >= oldMetaEnd ? at + delta : at, length };
            }) };
        });
        const big = moved.some((i) => i.base > 0xffffffff || i.extents.some((e) => e.offset > 0xffffffff || e.length > 0xffffffff));
        const offsetSize = big ? 8 : 4, lengthSize = big ? 8 : 4, baseSize = moved.some((i) => i.base > 0) ? offsetSize : 0, indexSize = usesIndex ? m.loc.sizes.index : 0;
        const parts = [fields([version, 1], [0, 3]), fields([(offsetSize << 4) | lengthSize, 1], [(baseSize << 4) | indexSize, 1]), fields([moved.length, version < 2 ? 2 : 4])];
        for (const i of moved) {
            parts.push(fields([i.id, version < 2 ? 2 : 4]));
            if (version >= 1) parts.push(fields([i.method, 2]));
            parts.push(fields([i.reference, 2]), ...(baseSize ? [fields([i.base, baseSize])] : []), fields([i.extents.length, 2]));
            for (const e of i.extents) parts.push(fields(...(indexSize ? [[e.index, indexSize]] : []), [e.offset, offsetSize], [e.length, lengthSize]));
        }
        const iloc = box("iloc", ...parts);
        // The EXIF item described, and linked to the picture, where it's new.
        let iinf = null, iref = null;
        if (!old.length) {
            const infeVersion = exifId > 0xffff ? 3 : 2;
            const infe = box("infe", fields([infeVersion, 1], [0, 3], [exifId, infeVersion === 2 ? 2 : 4], [0, 2]), enc("Exif"), Uint8Array.of(0));
            const iinfBox = m.children.find((c) => c.type === "iinf"), c = cursor(bytes, iinfBox.start + iinfBox.header, iinfBox.end), v = c.u8(); c.skip(3);
            const count = v === 0 ? c.u16() : c.u32(), entries = bytes.subarray(c.at, iinfBox.end);
            const countVersion = count + 1 > 0xffff ? 1 : v;
            iinf = box("iinf", fields([countVersion, 1], [0, 3], [count + 1, countVersion === 0 ? 2 : 4]), entries, infe);
            const list = [...m.refs, { type: "cdsc", from: exifId, to: [m.primary] }];
            const refVersion = m.irefVersion === 1 || list.some((r) => r.from > 0xffff || r.to.some((t) => t > 0xffff)) ? 1 : 0, id = refVersion === 0 ? 2 : 4;
            iref = box("iref", fields([refVersion, 1], [0, 3]), ...list.map((r) => box(r.type, fields([r.from, id], [r.to.length, 2], ...r.to.map((t) => [t, id])))));
        }
        // (The others as they are, but from the copy with the old EXIF cleared: it can be in idat.)
        const kids = m.children.map((c) => (c.type === "iloc" ? iloc : c.type === "iinf" && iinf ? iinf : c.type === "iref" && iref ? iref : out.subarray(c.start, c.end)));
        if (iref && !m.children.some((c) => c.type === "iref")) kids.push(iref);
        // (A meta box's own header: its size, type, version and flags, kept.)
        return box("meta", bytes.subarray(metaStart + m.meta.header, metaStart + m.meta.header + 4), ...kids);
    };
    let meta = build(0, 0);
    const delta = meta.length - (oldMetaEnd - metaStart);
    const total = out.length + delta, exifAt = total + 8;
    meta = build(delta, exifAt);
    if (meta.length - (oldMetaEnd - metaStart) !== delta) fail("The HEIF meta box couldn't be written.");
    // An item in idat moves with meta: its offsets are idat's own.
    const tail = box("mdat", payload), result = new Uint8Array(total + tail.length);
    result.set(out.subarray(0, metaStart), 0);
    result.set(meta, metaStart);
    result.set(out.subarray(oldMetaEnd), metaStart + meta.length);
    result.set(tail, total);
    // Read back: the EXIF is what was written, and every other item's bytes
    // are as they were in the file as it was (not as cleared: so clearing
    // that took any of theirs is found).
    if (!sameBytes(heifExif(result), tiff)) fail("The HEIF file couldn't be written back.");
    const after = readMeta(result);
    for (const i of m.loc.items) {
        if (i.id === exifId) continue;
        const was = itemBytes(bytes, m, i), now = itemBytes(result, after, after.loc.items.find((j) => j.id === i.id));
        if (!was || !now || !sameBytes(was, now)) fail("A HEIF item would have moved wrongly.");
    }
    return result;
}

function sameBytes(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}
