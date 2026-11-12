// Preview rendering is a map of adapters; orchestration lives in preview.js.
// Each renderer returns a DOM element adapted to PreviewView by the controller.
import { kaitaiView } from "./kaitai-view.js";
import { call, collect } from "./requests.js";
import { createRangedFileReader } from "./ranged-file.js";
import { binaryChunkSize } from "./preview-model.js";
const readBinaryRange = createRangedFileReader({ call, collect });
import { fetchZipEntries } from "./download.js";
import { el } from "./preview-dom.js";
import { render, structured, zipListing } from "./preview-content.js";
import { markdownFrame, epubFrame, pdfFrame } from "./preview-frames.js";

async function documentView(options) {
    const { file, path, blob, url, kind, location, fragment, open, navigate } = options;
    try {
        const opts = { fragment, location, open, navigate, externalMode: options.externalMode, externalFound: options.externalFound };
        return kind === "html"
            ? await markdownFrame("", file.dir, { ...opts, format: "html", html: await blob.text() })
            : await markdownFrame(path, file.dir, opts);
    } catch (err) {
        return el("div", { className: "fallback" },
            el("p", { className: "hint", textContent: `Shown as written: ${file.name} can't be rendered (${err.message}).` }),
            await render(file.kind, blob, url, file.name));
    }
}
async function mediaView({ path, file, signal }) {
    const { mediaStream } = await import("./media-stream.js");
    signal?.throwIfAborted();
    return mediaStream(path, file, signal);
}
const renderers = {
    zip: ({ file, path }) => zipListing(file.entries, {
        extract: async (entries) => {
            const t = await call({ type: "zip-extract", path, entries, if_mtime: file.mtime, if_size: file.size });
            t.close();
            return t.reply;
        },
        download: (entries) => fetchZipEntries(path, entries, file.mtime, file.size),
    }),
    epub: ({ path, file, location, navigate, externalMode, externalFound }) => epubFrame(path, file, { location, navigate, externalMode, externalFound }),
    pdf: ({ path, file, location, navigate }) => pdfFrame(path, file, { location, navigate }),
    audio: mediaView,
    video: mediaView,
    markdown: documentView,
    html: documentView,
    table: ({ file, blob, url }) => structured("table", blob, url, file.name, file.tableOptions),
    json: ({ file, blob, url }) => structured("json", blob, url, file.name),
    // Zoomed and panned, and edited (see image-view.js).
    image: async ({ file, blob, url }) => {
        const { imageView } = await import("./image-view.js");
        return imageView({ file, blob, url });
    },
    hex: async ({ file, path, blob, signal }) => kaitaiView(new Uint8Array(await blob.slice(0, binaryChunkSize).arrayBuffer()), {
        signal, size: file.size, format: file.sqlite ? "sqlite3" : "",
        readRange: (begin, end, { signal: rangeSignal } = {}) => end <= blob.size
            ? blob.slice(begin, end).arrayBuffer()
            : readBinaryRange(path, file, begin, end, { maxBytes: binaryChunkSize, signal: rangeSignal }),
        // In the file as it is now (file's version changes with a save).
        // A search given up on (another begun) is ended on the server too.
        search: async ({ pattern, mask, offset, backward, signal: searchSignal }) => {
            const t = await call({ type: "file-search", path, if_mtime: file.mtime, if_size: file.size, pattern, mask, offset, backward: backward || undefined },
                { signal: searchSignal });
            t.close();
            return t.reply;
        },
    }),
    text: ({ file, blob, url }) => render("text", blob, url, file.name, { truncated: file.truncated }),
    // Asked of the server as it's looked at, of the file as it was opened.
    sqlite: async ({ file, path }) => {
        const { sqliteView } = await import("./sqlite-view.js");
        return sqliteView({ name: file.name, schema: file.schema ?? {}, wal: file.wal, ask: async (q, signal) => {
            const t = await call({ type: "sqlite", path, if_mtime: file.mtime, if_size: file.size, sqlite: q }, { signal });
            t.close();
            return t.reply.answer;
        } });
    },
};
export function renderPreview(options) {
    if (!Object.hasOwn(renderers, options.kind)) throw new Error("this file can't be rendered");
    return renderers[options.kind](options);
}
