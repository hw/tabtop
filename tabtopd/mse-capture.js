// Capture of clear Media Source (MSE) appends for Save stream: the viewer's
// relay already has the bytes (go-media.js). Completed fMP4 / progressive
// pieces spill to the server as they accumulate so local RAM stays small;
// encrypted or WebM captures are not saved.

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
            else if (type === "moov" || type === "trak" || type === "mdia" || type === "minf" || type === "stbl" ||
                type === "stsd" || type === "moof" || type === "traf" || type === "schi") walk(body);
            return !encrypted;
        });
    };
    walk(data);
    return encrypted;
}

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
    const parts = [];
    let partStart = -1;
    for (const b of boxes) {
        if (b.start < initEnd) continue;
        if (b.type === "styp" || b.type === "moof") {
            if (partStart >= 0) parts.push(data.subarray(partStart, b.start));
            partStart = b.start;
        }
    }
    if (partStart >= 0) parts.push(data.subarray(partStart));
    if (!parts.length) throw new Error("buffered stream has no media segments yet");
    return { init: data.subarray(0, initEnd), parts };
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
export function createCapture({ spill } = {}) {
    const tracks = new Map();
    let encrypted = false, full = false, ended = false, sealed = false;
    let spilledProgressive = 0, spilledParts = 0, unsaved = false;
    let spillChain = Promise.resolve();
    let spilling = false, spillAgain = false, spillForce = false;

    const trackOf = (index) => {
        let t = tracks.get(index);
        if (!t) {
            t = {
                mime: "",
                buf: new Uint8Array(0),
                init: null,
                parts: [],
                partsBytes: 0,
                progressiveReady: [],
                progressiveBytes: 0,
                spilledInit: false,
                mode: "", // "" | "fmp4" | "progressive"
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

    const setEncrypted = () => {
        encrypted = true;
        clearAll();
    };

    const setBuf = (t, next) => {
        t.buf = next;
        full = localHeld() > MSE_CAPTURE_LIMIT;
    };

    // parseTrack moves complete boxes from t.buf into init / parts / progressiveReady.
    const parseTrack = (t, force = false) => {
        if (encrypted || !t.buf.length) return;
        if (mp4Encrypted(t.buf)) {
            setEncrypted();
            return;
        }
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
            const taken = t.buf.subarray(0, end);
            setBuf(t, t.buf.subarray(end));
            t.progressiveReady.push(taken);
            t.progressiveBytes += taken.length;
            return;
        }

        // fMP4
        if (!t.spilledInit && !t.init) {
            let initEnd = 0;
            for (const b of boxes) {
                if (b.type === "moof" || b.type === "styp") break;
                initEnd = b.end;
            }
            if (initEnd <= 0) return;
            t.init = t.buf.subarray(0, initEnd);
            setBuf(t, t.buf.subarray(initEnd));
            return parseTrack(t, force);
        }

        const { boxes: partBoxes, complete: partsComplete } = listBoxes(t.buf);
        if (!partBoxes.length) return;
        let partStart = -1;
        const ranges = [];
        for (const b of partBoxes) {
            if (b.type === "styp" || b.type === "moof") {
                if (partStart >= 0) ranges.push([partStart, b.start]);
                partStart = b.start;
            }
        }
        if (force && partsComplete && partStart >= 0) {
            const frag = partBoxes.filter((b) => b.start >= partStart);
            if (frag.some((b) => b.type === "moof") && frag.some((b) => b.type === "mdat")) {
                ranges.push([partStart, t.buf.length]);
                partStart = -1;
            }
        }
        if (!ranges.length) return;
        const consumeTo = partStart >= 0 ? partStart : ranges[ranges.length - 1][1];
        for (const [start, end] of ranges) {
            const piece = t.buf.subarray(start, end);
            t.parts.push(piece);
            t.partsBytes += piece.length;
        }
        setBuf(t, t.buf.subarray(consumeTo));
    };

    const emit = async (track, kind, bytes) => {
        if (!(bytes instanceof Uint8Array) || !bytes.length) return;
        if (typeof spill === "function") await spill({ track, kind, bytes });
        if (kind === "part") spilledParts++;
        if (kind === "progressive") spilledProgressive += bytes.length;
        if (kind === "init") {
            const t = tracks.get(track);
            if (t) t.spilledInit = true;
        }
        unsaved = true;
    };

    const flushReady = async (force) => {
        for (const [index, t] of tracks) {
            if (/webm/i.test(t.mime)) continue;
            parseTrack(t, force);
            if (encrypted) return;

            const soft = force || localHeld() >= MSE_SPILL_SOFT ||
                t.partsBytes >= MSE_SPILL_SOFT || t.progressiveBytes >= MSE_SPILL_SOFT;

            if (t.mode === "progressive") {
                if (!soft && !force) continue;
                while (t.progressiveReady.length) {
                    const chunk = t.progressiveReady.shift();
                    t.progressiveBytes -= chunk.length;
                    await emit(index, "progressive", chunk);
                    full = localHeld() > MSE_CAPTURE_LIMIT;
                }
                continue;
            }

            if (t.mode !== "fmp4") continue;

            // Spill init as soon as at least one part is ready (or on force).
            if (t.init && !t.spilledInit && (t.parts.length > 0 || spilledParts > 0 || force)) {
                const init = t.init;
                t.init = null;
                await emit(index, "init", init);
                full = localHeld() > MSE_CAPTURE_LIMIT;
            }

            if (!soft && !(t.spilledInit && t.parts.length && spilledParts === 0)) continue;

            while (t.parts.length) {
                const part = t.parts.shift();
                t.partsBytes -= part.length;
                await emit(index, "part", part);
                full = localHeld() > MSE_CAPTURE_LIMIT;
                if (!force && t.partsBytes < MSE_SPILL_SOFT && localHeld() < MSE_SPILL_SOFT) break;
            }
        }
        full = localHeld() > MSE_CAPTURE_LIMIT;
    };

    const scheduleSpill = (force = false) => {
        if (force) spillForce = true;
        spillAgain = true;
        spillChain = spillChain.then(async () => {
            if (spilling) return;
            spilling = true;
            try {
                while (spillAgain && !encrypted) {
                    spillAgain = false;
                    const forceNow = spillForce;
                    spillForce = false;
                    await flushReady(forceNow);
                }
            } catch {
                full = localHeld() > MSE_CAPTURE_LIMIT;
            } finally {
                spilling = false;
            }
        });
        return spillChain;
    };

    return {
        get encrypted() { return encrypted; },
        get ended() { return ended; },
        get bytes() { return localHeld(); },
        get full() { return full; },
        markEncrypted() { setEncrypted(); },
        end() {
            ended = true;
            return scheduleSpill(true);
        },
        add(index, mime) {
            const t = trackOf(index);
            if (mime) t.mime = String(mime);
        },
        append(index, bytes) {
            if (encrypted || full || !(bytes instanceof Uint8Array) || !bytes.length) return;
            if (mp4Encrypted(bytes)) {
                setEncrypted();
                return;
            }
            const t = trackOf(index);
            if (/webm/i.test(t.mime)) return;
            if (localHeld() + bytes.length > MSE_CAPTURE_LIMIT) {
                full = true;
                return;
            }
            const next = new Uint8Array(t.buf.length + bytes.length);
            next.set(t.buf);
            next.set(bytes, t.buf.length);
            setBuf(t, next);
            parseTrack(t, false);
            if (!sealed && !encrypted && (localHeld() >= MSE_SPILL_SOFT || t.partsBytes >= MSE_SPILL_SOFT || t.progressiveBytes >= MSE_SPILL_SOFT)) {
                scheduleSpill(false);
            }
        },
        // seal stops further spills (Save is finalizing the staging tunnel).
        async seal() {
            sealed = true;
            await scheduleSpill(true);
        },
        saveable() {
            if (encrypted) return false;
            if (unsaved && (spilledProgressive > 0 || spilledParts > 0)) return true;
            for (const t of tracks.values()) {
                if (/webm/i.test(t.mime)) return false;
                if (t.mode === "progressive" && t.progressiveBytes > 0) return true;
                if ((t.spilledInit || t.init) && t.parts.length > 0) return true;
                try {
                    if (!t.buf.length) continue;
                    const split = splitMp4(t.buf);
                    if (split.progressive || (split.init && split.parts?.length)) return true;
                } catch { /* not ready */ }
            }
            return false;
        },
        // markSaved clears the offer after a successful finalize; further
        // appends may spill again to a new staging session.
        markSaved() { unsaved = false; sealed = false; },
        flush() {
            return scheduleSpill(true);
        },
    };
}
