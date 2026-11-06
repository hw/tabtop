// Format-specific transport loading. The controller owns cancellation and
// creates object URLs only after a load is still current.
import { call, collect } from "./requests.js";
import { typeOf, limits } from "./preview-model.js";
import { join } from "./preview-dom.js";
const PDF_FIRST = 64 * 1024;

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

export async function loadPreview(dir, name, { signal, progress = () => {} } = {}) {
    const type = typeOf(name);
    if (!type || !Object.hasOwn(loaders, type.kind)) throw new Error("this file isn't supported for preview");
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
            if (size > limits[type.kind]) throw new Error("it's grown too big to preview; download it instead");
            file = { dir, name, size, mtime, ...type };
            progress(0, ["text", "image"].includes(type.kind) ? size : null);
            return await consume(t, type.type);
        } finally {
            signal?.removeEventListener("abort", cancel);
            t.close();
        }
    };
    const { blob = null, ...metadata } = await loaders[type.kind](open, (n) => progress(n, file.size));
    signal?.throwIfAborted();
    return { file: Object.assign(file, metadata), blob };
}
