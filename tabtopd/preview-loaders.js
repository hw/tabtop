// Format-specific transport loading. The controller owns cancellation and
// creates object URLs only after a load is still current.
import { call, collect } from "./requests.js";
import { typeOf, limits, binaryChunkSize } from "./preview-model.js";
import { join } from "./preview-dom.js";
const PDF_FIRST = 64 * 1024;
const UNKNOWN_FIRST = 10_000_000;

const loaders = {
    zip: async (open) => open({ type: "zip-preview" }, (t) => ({ entries: t.reply.entries })),
    epub: async (open) => open({ type: "epub" }, (t) => ({ book: t.reply.book })),
    pdf: async (open) => open({ type: "file", offset: 0, length: PDF_FIRST }, async (t, type) => ({
        start: await (await collect(t, t.reply.length, () => {}, type)).arrayBuffer(),
    })),
    audio: loadMedia,
    video: loadMedia,
    image: loadBuffered,
    text: loadBuffered,
    hex: loadBuffered,
    // Its schema, asked of the server (see sqlite.go); rows come as shown.
    sqlite: async (open) => open({ type: "sqlite" }, (t) => ({ schema: { ...t.reply.answer, wal_mode: !!t.reply.wal_mode }, wal: !!t.reply.wal })),
};
const sqliteType = { kind: "sqlite", type: "application/vnd.sqlite3" };
// What every SQLite database starts with.
const SQLITE_MAGIC = [..."SQLite format 3\0"].map((c) => c.charCodeAt(0));
async function isSQLite(blob) {
    const head = new Uint8Array(await blob.slice(0, SQLITE_MAGIC.length).arrayBuffer());
    return head.length === SQLITE_MAGIC.length && SQLITE_MAGIC.every((b, i) => head[i] === b);
}
// startsAsDatabase reports whether the file at path starts as an SQLite
// database does: its first bytes only, asked for. (Not if they can't be
// read: what's shown instead says why.)
async function startsAsDatabase(path, signal) {
    signal?.throwIfAborted();
    let t;
    try {
        t = await call({ type: "file", path, offset: 0, length: SQLITE_MAGIC.length }, { signal });
        return await isSQLite(await collect(t, t.reply.length, () => {}, "application/octet-stream"));
    } catch {
        return false;
    } finally {
        t?.close();
        signal?.throwIfAborted();
    }
}

// What the server says of a file that isn't a database it can read (not
// one, or damaged): shown in hex instead.
const notDatabase = (err) => err?.code === "not-database";
function loadMedia(open) {
    return open({ type: "file", offset: 0, length: 1 }, async (t, type) => {
        await collect(t, t.reply.length, () => {}, type);
        return {};
    });
}
function loadBuffered(open, progress) {
    return open({ type: "file" }, async (t, type) => ({ blob: await collect(t, t.reply.size, progress, type) }));
}

async function identifyText(file, blob) {
    try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(await blob.arrayBuffer(), { stream: file.truncated });
        file.textAvailable = !/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(text);
    } catch {
        file.textAvailable = false;
    }
    if (!file.textAvailable) {
        file.kind = "hex";
        file.type = "application/octet-stream";
    }
}

// Thrown by open, below, for a file too big for its own preview.
const tooBig = new Error("it's too big to preview that way");

// loadPreview loads the file name in dir to preview, as mode says (null:
// as its name says). A file too big for its own preview, or for the text
// view, is shown in hex instead: the first part, the rest read as it's
// looked at, however big it is; so is one named as a database that isn't
// (by its first bytes, or as SQLite finds it).
// One of no known type that starts as a database does is shown as one.
export async function loadPreview(dir, name, { signal, progress = () => {}, mode = null } = {}) {
    // Named as a database: one only if it starts as one, else its bytes.
    if (mode === null && typeOf(name)?.kind === "sqlite" && !(await startsAsDatabase(join(dir, name), signal))) {
        return loadAs(dir, name, { signal, progress, mode: "hex" });
    }
    let loaded;
    try {
        loaded = await loadAs(dir, name, { signal, progress, mode });
    } catch (err) {
        const asDatabase = mode === "sqlite" || mode === null && typeOf(name)?.kind === "sqlite";
        if (err !== tooBig && !(asDatabase && notDatabase(err))) throw err;
        return loadAs(dir, name, { signal, progress, mode: "hex" });
    }
    if (mode === "auto" && loaded.file.sqlite) {
        // Its tables, if they can be read; if not (not a database after
        // all, or busy, or slow), the bytes already loaded, from which its
        // tables can be asked for again.
        try {
            return await loadAs(dir, name, { signal, progress, mode: "sqlite" });
        } catch (err) {
            if (err?.name === "AbortError" || signal?.aborted) throw err;
        }
    }
    return loaded;
}

async function loadAs(dir, name, { signal, progress, mode }) {
    const type = mode === "text" || mode === "hex" ? { kind: mode, type: mode === "text" ? "text/plain" : "application/octet-stream" }
        : mode === "sqlite" ? sqliteType : typeOf(name) ?? (mode === "auto" ? { kind: "text", type: "text/plain" } : null);
    if (!type || !Object.hasOwn(loaders, type.kind)) throw new Error("this file isn't supported for preview");
    const unknown = !typeOf(name);
    const prefix = mode === "hex" || unknown && ["auto", "text"].includes(mode);
    const first = mode === "text" ? UNKNOWN_FIRST : binaryChunkSize;
    const path = join(dir, name);
    let file;
    const open = async (request, consume) => {
        signal?.throwIfAborted();
        const t = await call({ ...request, path });
        const cancel = () => t.close();
        signal?.addEventListener("abort", cancel, { once: true });
        try {
            signal?.throwIfAborted();
            const { size, mtime } = t.reply;
            if (!prefix && size > limits[type.kind]) throw tooBig;
            const previewSize = prefix ? (request.offset ?? 0) + t.reply.length : size;
            file = { dir, name, size, mtime, ...type, prefix, previewSize, truncated: prefix && previewSize < size };
            progress(0, ["text", "hex", "image"].includes(type.kind) ? previewSize : null);
            return await consume(t, type.type);
        } finally {
            signal?.removeEventListener("abort", cancel);
            t.close();
        }
    };
    const load = prefix
        ? (open, progress) => open({ type: "file", offset: 0, length: first }, async (t, type) =>
            ({ blob: await collect(t, t.reply.length, progress, type) }))
        : loaders[type.kind];
    let { blob = null, ...metadata } = await load(open, (n) => progress(n, file.previewSize));
    // A database, whatever it's called: its tables can be shown too.
    if (type.kind === "sqlite" || blob && await isSQLite(blob)) file.sqlite = true;
    if (blob && unknown) {
        // Unknown files share one preview: readable UTF-8 starts as text,
        // while binary/control bytes start in the hex and structure view.
        await identifyText(file, blob);
    }
    if (blob && !unknown && file.kind === "text" && new Uint8Array(await blob.slice(0, 8000).arrayBuffer()).includes(0)) {
        // Named as text, but not (a NUL, as render tells): its bytes, in hex.
        file.kind = "hex";
        file.type = "application/octet-stream";
        file.textAvailable = false;
    }
    if (mode === "auto" && unknown && file.kind === "text" && file.previewSize < Math.min(file.size, UNKNOWN_FIRST)) {
        const head = blob, begin = file.previewSize, end = Math.min(file.size, UNKNOWN_FIRST);
        const tail = await open({ type: "file", offset: begin, length: end - begin, if_mtime: file.mtime, if_size: file.size },
            (t, type) => collect(t, t.reply.length, n => progress(begin + n, end), type));
        blob = new Blob([head, tail], { type: file.type });
        await identifyText(file, blob);
    }
    signal?.throwIfAborted();
    return { file: Object.assign(file, metadata), blob };
}
