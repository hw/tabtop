// Thumbnails of pictures for the files page's grid: made in the browser
// from the file, small, and kept for the visit, in memory only (what they
// show is private: nothing of it is left in the browser once the page is
// closed), by the file's root, path, size and time, so a file changed gets
// a new one. Only a few are made at once, and only for what's shown.
import { call, collect, serverDecoded, SERVER_DECODED } from "./requests.js";
import { typeOf } from "./preview-model.js";
import { rootStorageScope } from "./fs-context.js";
import { THUMBNAIL_CACHE } from "./session-state.js";

export const THUMB_SIZE = 192;      // the longer side, in pixels
const MAX_SOURCE = 40e6;            // larger pictures aren't read for one
const AT_ONCE = 3;

// Those an earlier version kept in Cache Storage go.
try {
    globalThis.caches?.delete(THUMBNAIL_CACHE).catch(() => {});
} catch { /* no Cache Storage here */ }

const MAX_MEMORY = 600;             // object URLs held at once, the least used going first
const memory = new Map();           // key: object URL, this visit, least recently used first
const pending = [];
let running = 0;

// thumbnailable reports whether a thumbnail can be made of the file e.
export function thumbnailable(e) {
    const t = !e.dir && typeOf(e.name);
    return !!t && t.kind === "image" && (e.bytes ?? 0) > 0 && (e.bytes ?? 0) <= MAX_SOURCE;
}

// keyOf is the thumbnail's key: by the file's path, its size and time
// (which another version of it has another of).
const keyOf = (path, e) => `${location.origin}/tabtop-thumbnail/${encodeURIComponent(rootStorageScope())}/${encodeURIComponent(path)}?b=${e.bytes ?? 0}&t=${encodeURIComponent(e.time ?? e.modified ?? "")}`;

// thumbnail resolves to an object URL of a thumbnail of the file e at
// path, or null if one can't be made; signal gives up waiting for it.
export async function thumbnail(path, e, signal) {
    const key = keyOf(path, e);
    if (memory.has(key)) {
        const url = memory.get(key);
        memory.delete(key);
        memory.set(key, url); // used now: last to go
        return url;
    }
    await turn(signal);
    try {
        signal.throwIfAborted();
        const blob = await make(path, e, signal);
        if (!blob) return null;
        return remember(key, blob);
    } finally {
        running--;
        pending.shift()?.();
    }
}

// remember holds blob, as an object URL for key, letting the least used
// go beyond MAX_MEMORY, so a long visit doesn't hold every one it saw
// (one let go, wanted again, is made again).
function remember(key, blob) {
    // Made twice at once (a folder redrawn meanwhile): the first kept.
    if (memory.has(key)) return memory.get(key);
    const url = URL.createObjectURL(blob);
    memory.set(key, url);
    if (memory.size > MAX_MEMORY) {
        // Not one a picture on the page still has (it may not have loaded
        // it yet): those stay, however many.
        const shown = new Set([...document.querySelectorAll("td.thumb img")].map((img) => img.src));
        for (const [k, old] of memory) {
            if (memory.size <= MAX_MEMORY) break;
            if (shown.has(old)) continue;
            memory.delete(k);
            URL.revokeObjectURL(old);
        }
    }
    return url;
}

// turn waits till fewer than AT_ONCE are being made.
function turn(signal) {
    if (running < AT_ONCE) {
        running++;
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        const go = () => {
            signal.removeEventListener("abort", stop);
            running++;
            resolve();
        };
        const stop = () => {
            const i = pending.indexOf(go);
            if (i >= 0) pending.splice(i, 1);
            reject(signal.reason);
        };
        signal.addEventListener("abort", stop, { once: true });
        pending.push(go);
    });
}

// make reads the file, and draws it small. A HEIC picture, which most
// browsers can't decode, is decoded by the server: its own thumbnail, if
// it has one.
async function make(path, e, signal) {
    const blob = SERVER_DECODED.has(typeOf(e.name).type)
        // (One that can't be decoded has none; one given up on, or not
        // decoded now, the server busy, isn't remembered: it's tried again.)
        ? await serverDecoded(path, { thumbnail: true, signal }).catch((err) => { signal.throwIfAborted(); return null; })
        : await read(path, e, signal);
    if (!blob) return null;
    return draw(blob, signal);
}

// read is the file e at path, or null if it's too large to be drawn small.
async function read(path, e, signal) {
    const t = await call({ type: "file", path }, { signal });
    const abort = () => t.close();
    signal.addEventListener("abort", abort, { once: true });
    let blob;
    try {
        if (t.reply.size > MAX_SOURCE) return null;
        blob = await collect(t, t.reply.length ?? t.reply.size, () => {}, typeOf(e.name).type);
    } finally {
        signal.removeEventListener("abort", abort);
        t.close();
    }
    return blob;
}

// draw is the picture in blob, at most THUMB_SIZE on its longer side, as WebP.
async function draw(blob, signal) {
    signal.throwIfAborted();
    // An <img> decodes all a browser shows, SVG included (whose scripts
    // don't run there), and applies EXIF orientation.
    const url = URL.createObjectURL(blob);
    try {
        const img = new Image();
        img.decoding = "async";
        img.src = url;
        await img.decode();
        const w = img.naturalWidth || THUMB_SIZE, h = img.naturalHeight || THUMB_SIZE;
        const scale = Math.min(1, THUMB_SIZE / Math.max(w, h));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        const g = canvas.getContext("2d");
        g.imageSmoothingQuality = "high";
        g.drawImage(img, 0, 0, canvas.width, canvas.height);
        return await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.8));
    } catch {
        return null;  // not a picture this browser can show
    } finally {
        URL.revokeObjectURL(url);
    }
}
