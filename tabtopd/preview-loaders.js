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
};
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

export async function loadPreview(dir, name, { signal, progress = () => {}, mode = null } = {}) {
    const type = mode === "text" || mode === "hex" ? { kind: mode, type: mode === "text" ? "text/plain" : "application/octet-stream" } : typeOf(name) ?? (mode === "auto" ? { kind: "text", type: "text/plain" } : null);
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
            if (!prefix && size > limits[type.kind]) throw new Error("it's grown too big to preview; download it instead");
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
    if (blob && unknown) {
        // Unknown files share one preview: readable UTF-8 starts as text,
        // while binary/control bytes start in the hex and structure view.
        await identifyText(file, blob);
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
