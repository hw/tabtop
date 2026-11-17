// Batch actions for the files selection bar: strip EXIF, rotate, convert
// HEIC to JPEG, extract ZIP — using the same helpers as image/preview tools.
import { call, collect, serverDecoded, SERVER_DECODED, uploadFile } from "./requests.js";
import { typeOf } from "./preview-model.js";
import { stripped, withMetadata } from "./image-meta.js";
import { transform } from "./image-view.js";
import { encodePage } from "./image-export.js";
import { join } from "./preview-dom.js";
import { statusRow } from "./ui.js";
import { assertWritableRoot } from "./fs-context.js";

const MAX_BATCH = 50;
const MAX_EXTRACT = 1000;        // a zip-extract request's entries, at most (zip_extract.go)
const MAX_IMAGE = 50e6;
const WRITABLE = new Set(["image/jpeg", "image/png", "image/webp"]);

export function batchableImages(entries) {
    return entries.filter((e) => !e.dir && typeOf(e.name)?.kind === "image" && (e.bytes ?? 0) <= MAX_IMAGE);
}

// Those whose bytes can be cleaned or written again as they are (JPEG, PNG,
// WebP): Strip EXIF and Rotate change only these; others (GIF, BMP, AVIF,
// SVG, HEIC…) would be lost, or saved in another format under their name.
export function rewritableImages(entries) {
    return batchableImages(entries).filter((e) => WRITABLE.has(typeOf(e.name)?.type));
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

function canvasBlob(canvas, type) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (!blob) reject(new Error("This browser couldn't encode the image."));
            else resolve(blob);
        }, type, type === "image/png" ? undefined : 0.92);
    });
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

export async function batchStripExif(dir, entries, refresh) {
    const images = rewritableImages(entries);
    await runEach("Strip EXIF", images, async (entry, signal) => {
        const path = join(dir, entry.name);
        const type = typeOf(entry.name).type;
        const bytes = new Uint8Array(await (await loadBlob(path, signal, type)).arrayBuffer());
        // (One it can't clean as it is, a WebP turned by its EXIF, a JPEG it
        // can't read: failed, and left as it was.)
        const out = stripped(bytes, type);
        if (!out) throw new Error("its metadata can't be removed without changing the picture");
        await saveBlob(new Blob([out], { type }), entry.name, dir, signal, true);
    });
    await refresh?.();
}

export async function batchRotateRight(dir, entries, refresh) {
    const images = rewritableImages(entries);
    await runEach("Rotate right", images, async (entry, signal) => {
        const path = join(dir, entry.name);
        const type = typeOf(entry.name).type;
        const blob = await loadBlob(path, signal, type);
        const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
        try {
            signal.throwIfAborted();
            const { canvas } = transform(bitmap, bitmap.width, bitmap.height, ["right"]);
            const encoded = new Uint8Array(await (await canvasBlob(canvas, type)).arrayBuffer());
            // Its metadata (when it was taken, where…) kept, said upright at its new size.
            const next = withMetadata(encoded, new Uint8Array(await blob.arrayBuffer()), type, canvas.width, canvas.height);
            canvas.width = canvas.height = 0;
            await saveBlob(new Blob([next], { type }), entry.name, dir, signal, true);
        } finally {
            bitmap.close();
        }
    });
    await refresh?.();
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
