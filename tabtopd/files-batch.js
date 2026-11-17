// Batch actions for the files selection bar: edit pictures together, convert
// HEIC to JPEG, extract ZIP — using the same helpers as image/preview tools.
import { call, collect, serverDecoded, SERVER_DECODED, uploadFile } from "./requests.js";
import { typeOf } from "./preview-model.js";
import { encodePage } from "./image-export.js";
import { join } from "./preview-dom.js";
import { statusRow } from "./ui.js";
import { assertWritableRoot } from "./fs-context.js";

const MAX_BATCH = 50;
const MAX_EXTRACT = 1000;        // a zip-extract request's entries, at most (zip_extract.go)
const MAX_IMAGE = 50e6;

export function batchableImages(entries) {
    return entries.filter((e) => !e.dir && typeOf(e.name)?.kind === "image" && (e.bytes ?? 0) <= MAX_IMAGE);
}

export function batchableHeic(entries) {
    return entries.filter((e) => !e.dir && SERVER_DECODED.has(typeOf(e.name)?.type) && (e.bytes ?? 0) <= MAX_IMAGE);
}

export function batchableZips(entries) {
    return entries.filter((e) => !e.dir && typeOf(e.name)?.kind === "zip");
}

async function loadBlob(path, signal, type = "application/octet-stream") {
    const t = await call({ type: "file", path }, { signal });
    try {
        return await collect(t, t.reply.size, () => {}, type);
    } finally {
        t.close();
    }
}

async function saveBlob(blob, name, dir, signal, replace) {
    return uploadFile(new File([blob], name, { type: blob.type || "application/octet-stream" }), () => {}, dir, signal, replace);
}

async function runEach(label, items, work) {
    assertWritableRoot();
    if (!items.length) return;
    // (Said where it's seen: the button's own errors go nowhere.)
    if (items.length > MAX_BATCH) {
        const row = statusRow(`${label}: choose at most ${MAX_BATCH} files (${items.length} are chosen).`);
        row.set(`${label}: choose at most ${MAX_BATCH} files (${items.length} are chosen).`, true);
        row.finish();
        return;
    }
    const row = statusRow(`${label}: 0 of ${items.length}`, true);
    const { signal } = row;
    let done = 0, failed = 0;
    try {
        for (const item of items) {
            signal.throwIfAborted();
            row.set(`${label}: ${done + 1} of ${items.length} · ${item.name}`);
            row.progress(done / items.length);
            try {
                await work(item, signal);
                done++;
            } catch (err) {
                if (err?.name === "AbortError" || signal.aborted) throw err;
                failed++;
                console.error(label, item.name, err);
            }
            row.progress(done / items.length);
        }
        row.set(failed
            ? `${label}: finished ${done} of ${items.length} (${failed} failed)`
            : `${label}: finished ${done} of ${items.length}`, failed > 0);
        row.finish();
    } catch (err) {
        if (signal.aborted) row.set(`${label}: cancelled`, true);
        else row.set(`${label}: ${err.message || err}`, true);
        row.finish();
        if (!signal.aborted) throw err;
    }
}

// Those Edit together opens: pictures the browser can draw (not HEIC, which
// only the server can, nor SVG).
export function editableImages(entries) {
    return batchableImages(entries).filter((e) => {
        const type = typeOf(e.name)?.type;
        return !SERVER_DECODED.has(type) && type !== "image/svg+xml";
    });
}

// batchEditTogether opens the pictures selected in the editor (see
// pdf-image-editor.js), each a card, to be rotated, cropped, resized, their
// metadata removed, and the rest, together; saved beside them or over them
// (if the root can be written), or downloaded. The files are fetched first.
export async function batchEditTogether(dir, entries, refresh, writable) {
    const items = editableImages(entries);
    if (!items.length) return;
    const say = (text) => {
        const row = statusRow(text);
        row.set(text, true);
        row.finish();
    };
    if (items.length > MAX_BATCH) return say(`Edit together: choose at most ${MAX_BATCH} pictures (${items.length} are chosen).`);
    const MAX_BYTES = 256 * 1024 * 1024;
    if (items.reduce((n, e) => n + (e.bytes ?? 0), 0) > MAX_BYTES) return say("Edit together: the pictures chosen are over 256 MiB in all. Choose fewer.");
    const row = statusRow(`Edit together: opening 0 of ${items.length}`, true);
    const { signal } = row;
    const images = [];
    try {
        for (const entry of items) {
            signal.throwIfAborted();
            row.set(`Edit together: opening ${images.length + 1} of ${items.length} · ${entry.name}`);
            row.progress(images.length / items.length);
            const type = typeOf(entry.name).type;
            images.push({ name: entry.name, type, blob: await loadBlob(join(dir, entry.name), signal, type) });
        }
        row.finish();
    } catch (err) {
        row.set(signal.aborted ? "Edit together: cancelled" : `Edit together: ${err.message || err}`, true);
        row.finish();
        return;
    }
    const { pdfImageEditor } = await import("./pdf-image-editor.js");
    const where = dir ? dir.split("/").pop() : "this folder";
    pdfImageEditor({
        name: `${images.length} ${images.length === 1 ? "picture" : "pictures"} in ${where}`, count: 0, images,
        save: writable ? (blob, name, replace, signal) => saveBlob(blob, name, dir, signal, replace) : null,
        closed: () => refresh?.(),
    });
}

export async function batchHeicToJpeg(dir, entries, refresh) {
    const images = batchableHeic(entries);
    await runEach("HEIC → JPEG", images, async (entry, signal) => {
        const path = join(dir, entry.name);
        const blob = await serverDecoded(path, { mtime: entry.mtime, size: entry.bytes, signal });
        const { blob: jpeg } = await encodePage(blob, "image/jpeg");
        const base = entry.name.replace(/\.[^.]+$/, "") || entry.name;
        await saveBlob(jpeg, `${base}.jpg`, dir, signal, false);
    });
    await refresh?.();
}

export async function batchExtractZips(dir, entries, refresh) {
    const zips = batchableZips(entries);
    await runEach("Extract ZIP", zips, async (entry, signal) => {
        const path = join(dir, entry.name);
        const listed = await call({ type: "zip-preview", path }, { signal });
        let indexes, mtime, size;
        try {
            // Its files that can be extracted (not its folders' own entries,
            // nor what's unsafe or encrypted), of the version listed.
            indexes = (listed.reply.entries ?? []).filter((e) => e.extractable && Number.isInteger(e.index)).map((e) => e.index);
            ({ mtime, size } = listed.reply);
        } finally {
            listed.close();
        }
        if (!indexes.length) throw new Error("The archive has nothing to extract.");
        // (At most MAX_EXTRACT a request, as the server takes.)
        for (let at = 0; at < indexes.length; at += MAX_EXTRACT) {
            const t = await call({ type: "zip-extract", path, entries: indexes.slice(at, at + MAX_EXTRACT), if_mtime: mtime, if_size: size }, { signal });
            t.close();
        }
    });
    await refresh?.();
}
