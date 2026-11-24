// Capture of Media Source (MSE) appends for Save stream: the viewer's
// relay already has the bytes (go-media.js). Completed fMP4 / progressive
// pieces, and WebM's init and clusters, spill to the server as they
// accumulate so local RAM stays small. A Clear Key stream's (EME) is
// spilled encrypted with its keys (maySpill, markKeys) and saved decrypted
// (gostreammse.go); a WebM one, or a stream whose keys a CDM keeps, is not
// saved (nor a WebM one appended at an offset: gowebm.go takes its times
// as they are).

export const MSE_SPILL_SOFT = 4 << 20;
export const MSE_CAPTURE_LIMIT = 16 << 20;

const ENC_BOXES = new Set(["encv", "enca", "senc", "tenc", "pssh"]);

// mp4Boxes walks ISO-BMFF boxes in data, calling visit(type, body, headerStart, boxEnd).
// Returns true when every byte was a complete box; false if a trailing box is incomplete.
export function mp4Boxes(data, visit) {
    let at = 0;
    while (at + 8 <= data.length) {
        let size = (data[at] << 24) | (data[at + 1] << 16) | (data[at + 2] << 8) | data[at + 3];
        let header = 8;
        if (size === 1) {
            if (at + 16 > data.length) return false;
            size = Number((BigInt(data[at + 8]) << 56n) | (BigInt(data[at + 9]) << 48n) | (BigInt(data[at + 10]) << 40n) |
                (BigInt(data[at + 11]) << 32n) | (BigInt(data[at + 12]) << 24n) | (BigInt(data[at + 13]) << 16n) |
                (BigInt(data[at + 14]) << 8n) | BigInt(data[at + 15]));
            header = 16;
        } else if (size === 0) {
            size = data.length - at;
        }
        if (size < header || at + size > data.length) return false;
        const type = String.fromCharCode(data[at + 4], data[at + 5], data[at + 6], data[at + 7]);
        if (visit(type, data.subarray(at + header, at + size), at, at + size) === false) return true;
        at += size;
    }
    return at === data.length;
}

export function mp4Encrypted(data) {
    let encrypted = false;
    const walk = (bytes) => {
        mp4Boxes(bytes, (type, body) => {
            if (ENC_BOXES.has(type)) encrypted = true;
            // (stsd's entries come after its version, flags and count.)
            else if (type === "stsd") walk(body.subarray(8));
            else if (type === "moov" || type === "trak" || type === "mdia" || type === "minf" || type === "stbl" ||
                type === "moof" || type === "traf" || type === "schi") walk(body);
            return !encrypted;
        });
    };
    walk(data);
    return encrypted;
}

// WebM (EBML). ebml is the element at data[at:]: {id, start, data, end}
// (end -1: of unknown size), null if its head isn't all there, {bad} if
// it isn't one.
const EBML_HEADER = 0x1A45DFA3, WEBM_SEGMENT = 0x18538067, WEBM_CLUSTER = 0x1F43B675, WEBM_TRACKS = 0x1654AE6B;
const WEBM_TOP = new Set([WEBM_CLUSTER, 0x1C53BB6B, 0x114D9B74, 0x1549A966, WEBM_TRACKS, 0x1254C367, 0x1043A770, 0x1941A469, EBML_HEADER, WEBM_SEGMENT]);
export function ebml(data, at) {
    if (at >= data.length) return null;
    let n = 1;
    for (let m = 0x80; n <= 4 && !(data[at] & m); m >>= 1) n++;
    if (n > 4) return { bad: true };
    const s = at + n;
    if (s >= data.length) return null;
    let id = 0;
    for (let i = at; i < s; i++) id = id * 256 + data[i];
    let k = 1;
    for (let m = 0x80; k <= 8 && !(data[s] & m); m >>= 1) k++;
    if (k > 8) return { bad: true };
    if (s + k > data.length) return null;
    let size = data[s] & (0xff >> k), all = size === (0xff >> k);
    for (let i = s + 1; i < s + k; i++) {
        size = size * 256 + data[i];
        all = all && data[i] === 0xff;
    }
    return { id, start: at, data: s + k, end: all ? -1 : s + k + size };
}
// webmEncoded is whether a WebM init's Tracks has a track encrypted
// ("encrypted": ContentEncryption) or otherwise encoded ("encoded").
function webmEncoded(data, from, to) {
    let encoded = false, encrypted = false;
    const walk = (a, b, depth) => {
        for (let at = a; at < b;) {
            const e = ebml(data, at);
            if (!e || e.bad || e.end < 0 || e.end > b) return;
            if (e.id === 0x5035) encrypted = true;   // ContentEncryption
            if (e.id === 0x6D80) encoded = true;     // ContentEncodings
            // (TrackEntry, ContentEncodings, ContentEncoding: looked in.)
            if (depth < 4 && (e.id === 0xAE || e.id === 0x6D80 || e.id === 0x6240)) walk(e.data, e.end, depth + 1);
            at = e.end;
        }
    };
    walk(from, to, 0);
    return encrypted ? "encrypted" : encoded ? "encoded" : "";
}
// webmInit is where a WebM stream's init ends in data (at its first
// Cluster, or its end once its Tracks are all there): {end}, {} if it
// isn't all there yet, {encrypted} or {encoded}.
export function webmInit(data) {
    const h = ebml(data, 0);
    if (!h || h.bad || h.id !== EBML_HEADER || h.end < 0) return {};
    if (h.end > data.length) return {};
    const seg = ebml(data, h.end);
    if (!seg || seg.bad || seg.id !== WEBM_SEGMENT) return {};
    let tracks = false;
    for (let at = seg.data; at <= data.length;) {
        if (at === data.length) return tracks ? { end: at } : {};
        const e = ebml(data, at);
        if (!e || e.bad) return {};
        if (e.id === WEBM_CLUSTER) return tracks ? { end: at } : {};
        if (e.end < 0 || e.end > data.length) return {};
        if (e.id === WEBM_TRACKS) {
            tracks = true;
            const enc = webmEncoded(data, e.data, e.end);
            if (enc) return { [enc]: true };
        }
        at = e.end;
    }
    return {};
}
// webmClusters is the clusters complete in data (an unknown-sized one ends
// at the next top-level element; at data's end, only if force): {ranges,
// consumeTo, newInit (where another init begins, or -1)}.
export function webmClusters(data, force) {
    const ranges = [];
    let at = 0;
    while (at < data.length) {
        const e = ebml(data, at);
        if (!e || e.bad) break;
        if (e.id === EBML_HEADER) return { ranges, consumeTo: at, newInit: at };
        if (e.end >= 0) {
            if (e.end > data.length) break;
            if (e.id === WEBM_CLUSTER) ranges.push([at, e.end]);
            at = e.end;
            continue;
        }
        if (e.id !== WEBM_CLUSTER) break;
        let end = -1, c = e.data;
        while (c < data.length) {
            const k = ebml(data, c);
            if (!k || k.bad) break;
            if (WEBM_TOP.has(k.id)) { end = c; break; }
            if (k.end < 0 || k.end > data.length) break;
            c = k.end;
        }
        if (end < 0 && force && c === data.length) end = c;
        if (end < 0) break;
        ranges.push([at, end]);
        at = end;
    }
    return { ranges, consumeTo: at, newInit: -1 };
}
const startsWebm = (data) => data.length >= 4 && [WEBM_CLUSTER, EBML_HEADER].includes(((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0);

// splitMp4 turns concatenated fMP4 appends into { progressive } or { init, parts }.
export function splitMp4(data) {
    let hasMoof = false, hasMoov = false, hasMdat = false;
    const boxes = [];
    if (!mp4Boxes(data, (type, _body, start, end) => {
        boxes.push({ type, start, end });
        if (type === "moof") hasMoof = true;
        if (type === "moov") hasMoov = true;
        if (type === "mdat") hasMdat = true;
    })) {
        throw new Error("incomplete MP4 boxes in the buffered stream");
    }
    if (!hasMoov) throw new Error("buffered stream has no MP4 header");
    if (!hasMoof && hasMdat) return { progressive: data };
    if (!hasMoof) throw new Error("buffered stream has no media segments yet");
    let initEnd = 0;
    for (const b of boxes) {
        if (b.type === "moof" || b.type === "styp") break;
        initEnd = b.end;
    }
    if (initEnd <= 0) throw new Error("buffered stream has no MP4 header");
    const { ranges } = fragmentRanges(boxes.filter(b => b.start >= initEnd), data.length, true);
    const parts = ranges.map(([start, end]) => data.subarray(start, end));
    if (!parts.length) throw new Error("buffered stream has no media segments yet");
    return { init: data.subarray(0, initEnd), parts };
}

// styp starts a segment and belongs to its following moof/mdat pair.
function fragmentRanges(boxes, end, flush) {
    const ranges = [];
    let start = -1, moof = false, mdat = false;
    for (const b of boxes) {
        if (b.type === "styp" || b.type === "moof") {
            if (moof && mdat) {
                ranges.push([start, b.start]);
                start = -1;
                moof = mdat = false;
            }
            if (start < 0) start = b.start;
            if (b.type === "moof") moof = true;
        } else if (b.type === "mdat" && moof) mdat = true;
    }
    if (flush && moof && mdat) ranges.push([start, end]);
    return { ranges, consumeTo: ranges.at(-1)?.[1] ?? 0 };
}

// startsFragment is whether data begins with a box a fragment (or an init)
// begins with, of a size that can be one.
const FRAGMENT_STARTS = new Set(["moof", "styp", "ftyp", "moov", "emsg", "prft", "sidx"]);
function startsFragment(data) {
    if (data.length < 8) return false;
    const size = (data[0] << 24 | data[1] << 16 | data[2] << 8 | data[3]) >>> 0;
    return (size === 1 || size >= 8) && FRAGMENT_STARTS.has(String.fromCharCode(data[4], data[5], data[6], data[7]));
}

function listBoxes(data) {
    const boxes = [];
    const complete = mp4Boxes(data, (type, _body, start, end) => {
        boxes.push({ type, start, end });
    });
    return { boxes, complete };
}

// createCapture keeps a small local working set and calls spill({track, kind, bytes})
// for completed pieces (kind: "init" | "part" | "progressive"). If spill returns a
// Promise, bytes stay counted until it settles (backpressure).
//
// What's spilled goes to one staging session on the server. When that's gone
// (saved, a save failed, a spill failed) or must be (the player switched
// quality, which brings a new init), restart() begins again: onRestart is told
// (to let the old session go), each fMP4 track's init is sent again first, and
// a progressive stream, whose start is gone with it, isn't saveable any more.
export function createCapture({ spill, onRestart } = {}) {
    const tracks = new Map();
    let encrypted = false, armed = false, keysKnown = false, webmEnc = false;
    let full = false, ended = false, sealed = false;
    let incomplete = false, spillError = null;
    // A Clear Key stream's keys, as they came (its key ID in hex, its key
    // in hex): spilled to its stage once (again after a restart), and what
    // saving decrypted takes (gostreammse.go).
    const keys = new Map();
    let keysSent = false;
    // Spilling waits while the stream is encrypted and its keys may still
    // come (a Clear Key player's are given once its page's license has:
    // expectKeys, markKeys); never, one whose keys a CDM keeps, or a WebM
    // encrypted one's (neither is saved decrypted).
    const maySpill = () => !webmEnc && (!encrypted || armed || keysKnown);
    const checkSpill = () => {
        if (!spillError) return;
        const error = spillError;
        spillError = null;
        throw error;
    };
    // Not saved: a track neither MP4 nor WebM, or both kinds together.
    const unsupported = () => {
        const kinds = new Set();
        for (const t of tracks.values()) {
            if (!t.mime) continue;
            const kind = /^(audio|video)\/(mp4|webm)(?:\s*;|$)/i.exec(t.mime)?.[2]?.toLowerCase();
            if (!kind) return true;
            kinds.add(kind);
        }
        return kinds.size > 1;
    };
    let spilledProgressive = 0, spilledParts = 0, unsaved = false;
    let generation = 0;  // restarts: a spill of an earlier one doesn't count
    let spillChain = Promise.resolve();
    let spilling = false, spillAgain = false, spillForce = false;

    const trackOf = (index) => {
        let t = tracks.get(index);
        if (!t) {
            // Its track on the server (0-7, gostreammse.go): the least the
            // capture's others don't have, not the page's SourceBuffer
            // number, which only grows as buffers are made again.
            const used = new Set([...tracks.values()].map((other) => other.slot));
            let slot = 0;
            while (used.has(slot)) slot++;
            t = {
                slot,
                mime: "",
                offset: 0, windowStart: 0, windowEnd: Infinity,
                buf: new Uint8Array(0),
                init: null,
                parts: [],
                partsBytes: 0,
                progressiveReady: [],
                progressiveBytes: 0,
                spilledInit: false,
                initCopy: null,  // its init, to send again after a restart
                mode: "", // "" | "fmp4" | "progressive" | "lost" (progressive, its start gone)
            };
            tracks.set(index, t);
        }
        return t;
    };

    const heldOf = (t) => t.buf.length + (t.init?.length ?? 0) + t.partsBytes + t.progressiveBytes;
    const localHeld = () => {
        let n = 0;
        for (const t of tracks.values()) n += heldOf(t);
        return n;
    };

    const clearAll = () => {
        for (const t of tracks.values()) {
            t.buf = new Uint8Array(0);
            t.init = null;
            t.parts = [];
            t.partsBytes = 0;
            t.progressiveReady = [];
            t.progressiveBytes = 0;
        }
        full = false;
    };

    // The stream is encrypted: its init's or appends' boxes say so, or its
    // player asked for keys. Not refused by itself: a Clear Key stream's
    // keys are given it (markKeys) and it's saved decrypted; what it holds
    // is spilled once its keys may be known (maySpill), and it's saveable
    // only once they are. A WebM one can't be decrypted at the save
    // (gowebm.go takes no encrypted tracks): refused, what's held let go.
    const setEncrypted = () => {
        encrypted = true;
    };
    const setWebmEncrypted = () => {
        encrypted = webmEnc = true;
        clearAll();
    };

    const setBuf = (t, next) => {
        t.buf = next;
        full = localHeld() > MSE_CAPTURE_LIMIT;
    };

    // parseWebm moves a WebM track's init, then its complete clusters, from
    // t.buf into init / parts.
    const parseWebm = (t, force) => {
        if (webmEnc || !t.buf.length) return;
        if (!t.spilledInit && !t.init) {
            const at = webmInit(t.buf);
            if (at.encrypted) return setWebmEncrypted();
            if (at.encoded) {
                incomplete = true;  // (encoded otherwise: not saveable)
                return;
            }
            if (!at.end) return;
            t.mode = "webm";
            t.init = t.buf.subarray(0, at.end);
            t.initCopy = t.init;
            setBuf(t, t.buf.subarray(at.end));
            return parseWebm(t, force);
        }
        const { ranges, consumeTo, newInit } = webmClusters(t.buf, force);
        for (const [start, end] of ranges) {
            const piece = t.buf.subarray(start, end);
            t.parts.push({ bytes: piece, offset: t.offset, windowStart: t.windowStart, windowEnd: t.windowEnd });
            t.partsBytes += piece.length;
            if (t.offset !== 0 || t.windowStart !== 0 || t.windowEnd !== Infinity) incomplete = true;
        }
        setBuf(t, t.buf.subarray(consumeTo));
        if (newInit < 0) return;
        // Another init (a quality switch): the same again, let go; else,
        // as an fMP4's, the session begun again from it.
        const at = webmInit(t.buf);
        if (at.encrypted) return setWebmEncrypted();
        if (!at.end) return;
        const again = t.buf.subarray(0, at.end);
        if (t.initCopy && again.length === t.initCopy.length && again.every((v, i) => v === t.initCopy[i])) {
            setBuf(t, t.buf.subarray(at.end));
            return parseWebm(t, force);
        }
        if (sealed) {
            incomplete = true;
            return;
        }
        t.init = again;
        t.initCopy = again;
        t.spilledInit = false;
        t.parts = [];
        t.partsBytes = 0;
        setBuf(t, t.buf.subarray(at.end));
        restart(t);
        return parseWebm(t, force);
    };

    // parseTrack moves complete boxes from t.buf into init / parts / progressiveReady.
    const parseTrack = (t, force = false) => {
        if (/webm/i.test(t.mime)) return parseWebm(t, force);
        if (!t.buf.length) return;
        if (mp4Encrypted(t.buf)) setEncrypted();
        const { boxes, complete } = listBoxes(t.buf);
        if (!boxes.length) return;

        const hasMoov = boxes.some((b) => b.type === "moov");
        const hasMoof = boxes.some((b) => b.type === "moof");
        const hasMdat = boxes.some((b) => b.type === "mdat");

        if (!t.mode) {
            if (!hasMoov) return;
            if (hasMoof) t.mode = "fmp4";
            else if (hasMdat) t.mode = "progressive";
            else return;
        }

        if (t.mode === "progressive") {
            const end = boxes[boxes.length - 1].end;
            if (end <= 0) return;
            if (t.windowStart !== 0 || t.windowEnd !== Infinity) incomplete = true;
            const taken = t.buf.subarray(0, end);
            setBuf(t, t.buf.subarray(end));
            t.progressiveReady.push(taken);
            t.progressiveBytes += taken.length;
            return;
        }

        if (t.mode !== "fmp4") return;
        // fMP4
        if (!t.spilledInit && !t.init) {
            let initEnd = 0;
            for (const b of boxes) {
                if (b.type === "moof" || b.type === "styp") break;
                initEnd = b.end;
            }
            if (initEnd <= 0) return;
            t.init = t.buf.subarray(0, initEnd);
            t.initCopy = t.init;
            setBuf(t, t.buf.subarray(initEnd));
            return parseTrack(t, force);
        }

        const { boxes: partBoxes, complete: partsComplete } = listBoxes(t.buf);
        if (!partBoxes.length) return;
        // A new init (ftyp, moov): the player switched quality (hls.js,
        // dash.js and Shaka append the new rendition's init to the same
        // buffer). Parts before it are of the old init, which can't be saved
        // with the new one's: begin again from it.
        const moovAt = partBoxes.findIndex((b) => b.type === "moov");
        if (moovAt >= 0) {
            // The same init again (Shaka, dash.js, after a seek past what's
            // buffered, clearing it): nothing's changed; it's let go, the
            // session kept.
            const start = moovAt > 0 && partBoxes[moovAt - 1].type === "ftyp" ? partBoxes[moovAt - 1].start : partBoxes[moovAt].start;
            const end = partBoxes.find((b, k) => k > moovAt && (b.type === "moof" || b.type === "styp"))?.start ?? (partsComplete ? t.buf.length : -1);
            const again = end > start ? t.buf.subarray(start, end) : null;
            if (again && t.initCopy && again.length === t.initCopy.length && again.every((v, i) => v === t.initCopy[i])) {
                const rest = new Uint8Array(t.buf.length - again.length);
                rest.set(t.buf.subarray(0, start));
                rest.set(t.buf.subarray(end), start);
                setBuf(t, rest);
                return parseTrack(t, force);
            }
        }
        if (moovAt >= 0 && sealed) {
            // Mid-save: the session being saved isn't let go (restart would
            // abort it). The save's refused (incomplete: seal throws), the
            // new init left buffered, taken as it's unsealed.
            incomplete = true;
            return;
        }
        if (moovAt >= 0) {
            const start = moovAt > 0 && partBoxes[moovAt - 1].type === "ftyp" ? partBoxes[moovAt - 1].start : partBoxes[moovAt].start;
            const next = partBoxes.find((b, k) => k > moovAt && (b.type === "moof" || b.type === "styp"));
            if (!next) return;  // (its first part, to know where it ends)
            t.init = t.buf.subarray(start, next.start);
            t.initCopy = t.init;
            t.spilledInit = false;
            t.parts = [];
            t.partsBytes = 0;
            setBuf(t, t.buf.subarray(next.start));
            restart(t);
            return parseTrack(t, force);
        }
        const { ranges, consumeTo } = fragmentRanges(partBoxes, t.buf.length, force && partsComplete);
        if (!ranges.length) return;
        for (const [start, end] of ranges) {
            const piece = t.buf.subarray(start, end);
            t.parts.push({ bytes: piece, offset: t.offset, windowStart: t.windowStart, windowEnd: t.windowEnd });
            t.partsBytes += piece.length;
            // An encrypted fragment in an append window can't be saved: what
            // the window clips out of it would break its samples' senc.
            if (encrypted && (t.windowStart > 0 || t.windowEnd !== Infinity)) incomplete = true;
        }
        setBuf(t, t.buf.subarray(consumeTo));
    };

    const emit = async (track, kind, bytes, timing = {}) => {
        if (!(bytes instanceof Uint8Array) || !bytes.length) return;
        const was = generation;
        if (typeof spill === "function") {
            try {
                const slot = kind === "key" ? 0 : tracks.get(track)?.slot ?? track;
                await spill({ track: slot, kind, ...timing, bytes });
            } catch (err) {
                // A session let go already (restarted: a quality switch, a
                // gap) failing its spill in flight: expected, not the next
                // session's error.
                if (was !== generation) return;
                // Its session's gone, and what was spilled to it.
                restart();
                spillError = err;
                throw err;
            }
        }
        if (was !== generation) return;  // spilled to a session since let go
        if (kind === "key") return;  // (its stage has them; nothing saved yet)
        if (kind === "part") spilledParts++;
        if (kind === "progressive") spilledProgressive += bytes.length;
        if (kind === "init") {
            const t = tracks.get(track);
            if (t) t.spilledInit = true;
        }
        unsaved = true;
    };

    const flushReady = async (force) => {
        // Begun again while a spill was awaited (a quality switch, appended
        // meanwhile): what was queued is the new session's, each track's
        // init owed first. Scanned again from the start.
        const gen = generation;
        const stale = () => {
            if (gen === generation) return false;
            spillAgain = true;
            spillForce ||= force;
            return true;
        };
        // The keys go first, once (again to a session begun again), so a
        // save's never of a stage they're not in.
        if (keysKnown && !keysSent) {
            keysSent = true;
            for (const [kid, key] of keys) {
                await emit(0, "key", new TextEncoder().encode(JSON.stringify({ kid, key })));
                if (stale()) return;
            }
        }
        for (const [index, t] of tracks) {
            parseTrack(t, force);

            const soft = force || localHeld() >= MSE_SPILL_SOFT ||
                t.partsBytes >= MSE_SPILL_SOFT || t.progressiveBytes >= MSE_SPILL_SOFT;

            if (t.mode === "progressive") {
                if (!soft && !force) continue;
                while (t.progressiveReady.length) {
                    const chunk = t.progressiveReady.shift();
                    t.progressiveBytes -= chunk.length;
                    await emit(index, "progressive", chunk);
                    if (stale()) return;
                    full = localHeld() > MSE_CAPTURE_LIMIT;
                }
                continue;
            }

            if (t.mode !== "fmp4" && t.mode !== "webm") continue;

            // Spill init as soon as at least one part is ready (or on force).
            if (t.init && !t.spilledInit && (t.parts.length > 0 || spilledParts > 0 || force)) {
                const init = t.init;
                t.init = null;
                await emit(index, "init", init);
                if (stale()) return;
                full = localHeld() > MSE_CAPTURE_LIMIT;
            }

            if (!soft && !(t.spilledInit && t.parts.length && spilledParts === 0)) continue;

            while (t.parts.length) {
                const part = t.parts.shift();
                t.partsBytes -= part.bytes.length;
                await emit(index, "part", part.bytes, part);
                if (stale()) return;
                full = localHeld() > MSE_CAPTURE_LIMIT;
                if (!force && t.partsBytes < MSE_SPILL_SOFT && localHeld() < MSE_SPILL_SOFT) break;
            }
        }
        full = localHeld() > MSE_CAPTURE_LIMIT;
    };

    // restart begins a new staging session (see createCapture): kept is a
    // track whose init was just replaced (its parts already dropped).
    function restart(kept = null) {
        generation++;
        spillError = null;
        incomplete = false;
        spilledParts = 0;
        spilledProgressive = 0;
        unsaved = false;
        sealed = false;
        keysSent = false;  // (the keys go to the new session's stage too)
        resume();
        for (const t of tracks.values()) {
            if (t.mode === "progressive" && t !== kept) {
                t.mode = "lost";
                t.progressiveReady = [];
                t.progressiveBytes = 0;
                t.buf = new Uint8Array(0);
            } else if ((t.mode === "fmp4" || t.mode === "webm") && t !== kept) {
                t.spilledInit = false;
                t.init = t.initCopy;
            }
        }
        full = localHeld() > MSE_CAPTURE_LIMIT;
        try { onRestart?.(); } catch { /* the session's let go regardless */ }
    }

    // Sealed (a save finalizing its session), spills wait (an end() or a
    // flush() then would send a part over the finalize), but the seal's own;
    // they're done once unsealed or a new session's begun (unsealed).
    let sealing = false, waiting = false;
    function resume() {
        if (!waiting || sealed) return;
        waiting = false;
        scheduleSpill(false);  // (spillForce kept, if it was asked)
    }
    const scheduleSpill = (force = false) => {
        if (sealed && !sealing) {
            waiting = true;
            spillForce ||= force;
            return spillChain;
        }
        if (force) spillForce = true;
        spillAgain = true;
        spillChain = spillChain.then(async () => {
            if (spilling) return;
            spilling = true;
            try {
                while (spillAgain && maySpill()) {
                    spillAgain = false;
                    const forceNow = spillForce;
                    spillForce = false;
                    await flushReady(forceNow);
                }
            } catch (err) {
                spillError = err;
                full = localHeld() > MSE_CAPTURE_LIMIT;
            } finally {
                spilling = false;
            }
        });
        return spillChain;
    };

    return {
        get encrypted() { return encrypted; },
        get armed() { return armed; },
        get keysKnown() { return keysKnown; },
        get ended() { return ended; },
        get bytes() { return localHeld(); },
        get full() { return full; },
        markEncrypted() { setEncrypted(); },
        // expectKeys: its player attached Clear Key MediaKeys (go-eme.js):
        // its keys are coming, what's held is spilled from then on.
        expectKeys() {
            if (armed) return;
            armed = true;
            scheduleSpill(true);
        },
        // markKeys: its page's license answered with keys (its key ID in
        // hex, its key in hex): they go to its stage, and the stream is
        // saveable decrypted.
        markKeys(coming) {
            for (const [kid, key] of Object.entries(coming ?? {})) {
                if (typeof kid === "string" && kid !== "" && typeof key === "string" && key !== "" && keys.size < 16) keys.set(kid, key);
            }
            if (!keys.size) return;
            keysKnown = true;
            scheduleSpill(true);
        },
        end() {
            ended = true;
            return scheduleSpill(true);
        },
        add(index, mime) {
            const t = trackOf(index);
            if (mime) t.mime = String(mime);
        },
        drop(index) {
            if (!tracks.delete(index)) return;
            // Mid-save (sealed), the session being saved isn't let go
            // (restart would abort it): refused if it's still sealing (seal
            // throws), begun again once unsealed, or taken (sessionTaken).
            if (sealed) incomplete = true;
            else restart();
        },
        append(index, bytes, offset = 0, windowStart = 0, windowEnd = Infinity) {
            if (webmEnc || !(bytes instanceof Uint8Array) || !bytes.length) return;
            const t = trackOf(index);
            const webm = /webm/i.test(t.mime);
            if (!webm && mp4Encrypted(bytes)) setEncrypted();
            if (t.mode === "lost") return;
            if (t.offset !== offset || t.windowStart !== windowStart || t.windowEnd !== windowEnd) {
                // Attribute all complete fragments already buffered to the old offset.
                parseTrack(t, true);
                if ((t.mode === "fmp4" || t.mode === "webm") && t.buf.length) incomplete = true;
                t.offset = offset;
                t.windowStart = windowStart;
                t.windowEnd = windowEnd;
            }
            if (full || localHeld() + bytes.length > MSE_CAPTURE_LIMIT) {
                // Spills lag playback: this append's dropped. A fragment left
                // half had would run into the next (its box sizes from
                // mid-data): what's buffered of it goes too, and nothing's
                // taken again till an append starts a fragment (resync). A
                // progressive file can't have a gap: not saveable any more.
                full = true;
                if (t.mode === "progressive") {
                    t.mode = "lost";
                    t.progressiveReady = [];
                    t.progressiveBytes = 0;
                }
                t.buf = new Uint8Array(0);
                t.resync = true;
                // What's held of this track before the gap can't be saved
                // with what comes after: let go. Mid-save (sealed), the
                // session being saved has none of it; else it's begun again
                // from after the gap (the session spilled so far, gapped,
                // can't be saved), saveable again once more's spilled.
                t.parts = [];
                t.partsBytes = 0;
                if (sealed) incomplete = true;
                else restart();
                // Full till a spill says it isn't (flushReady): one's asked
                // for, as none may be going (or none would ever say).
                full = true;
                scheduleSpill(false);
                return;
            }
            if (t.resync) {
                if (!(webm ? startsWebm(bytes) : startsFragment(bytes))) return;
                t.resync = false;
            }
            const next = new Uint8Array(t.buf.length + bytes.length);
            next.set(t.buf);
            next.set(bytes, t.buf.length);
            setBuf(t, next);
            parseTrack(t, false);
            if (!sealed && maySpill() && (localHeld() >= MSE_SPILL_SOFT || t.partsBytes >= MSE_SPILL_SOFT || t.progressiveBytes >= MSE_SPILL_SOFT)) {
                scheduleSpill(false);
            }
        },
        // seal stops further spills (Save is finalizing the staging tunnel).
        async seal() {
            checkSpill();
            if (unsupported()) throw new Error("buffered stream contains an unsupported track format");
            if (encrypted && !keysKnown) throw new Error("encrypted streams can't be saved without their keys");
            if (incomplete) throw new Error("some buffered media was missed");
            sealed = true;
            sealing = true;
            const flushed = scheduleSpill(true);
            sealing = false;
            await flushed;
            checkSpill();
            if (unsupported() || incomplete) throw new Error("buffered tracks changed during save");
        },
        saveable() {
            if (webmEnc || incomplete || unsupported()) return false;
            if (encrypted) {
                // Encrypted: saved decrypted only once its keys came, and
                // only a fragmented MP4's (a WebM track's, a whole file's or
                // a lost progressive one's can't be; a windowed one's
                // refused as it's spilled).
                if (!keysKnown) return false;
                for (const t of tracks.values()) {
                    if (/webm/i.test(t.mime) || t.mode === "progressive" || t.mode === "lost") return false;
                }
            }
            if (unsaved && (spilledProgressive > 0 || spilledParts > 0)) return true;
            for (const t of tracks.values()) {
                if (t.mode === "lost") continue;
                if (t.mode === "progressive" && t.progressiveBytes > 0) return true;
                if ((t.spilledInit || t.init) && t.parts.length > 0) return true;
                if (/webm/i.test(t.mime)) continue;
                try {
                    if (!t.buf.length) continue;
                    const split = splitMp4(t.buf);
                    if (split.progressive || (split.init && split.parts?.length)) return true;
                } catch { /* not ready */ }
            }
            return false;
        },
        // sessionTaken: the save's started with the session (go.js): spills
        // go on at once, unsealed, to a new one, so playback while the save
        // remuxes isn't dropped against the capture's limit.
        sessionTaken() { restart(); },
        // markSaved: the save done (its session taken already).
        markSaved() { unsaved = spilledParts > 0 || spilledProgressive > 0; },
        // saveFailed: a finalize that didn't start a save. Its session's gone
        // (the server gives a session up once it's finalized).
        saveFailed() { restart(); },
        // unseal: a save that never finalized (nothing to save yet): spills go
        // on to the same session.
        unseal() {
            sealed = false;
            // What it holds has a gap, or a new init waiting (both met
            // mid-save): begun again (spills go on to a new session).
            if (incomplete) restart();
            else resume();
        },
        flush() {
            return scheduleSpill(true);
        },
    };
}
