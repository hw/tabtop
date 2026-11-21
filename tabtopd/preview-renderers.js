// Preview rendering is a map of adapters; orchestration lives in preview.js.
// Each renderer returns a DOM element adapted to PreviewView by the controller.
import { kaitaiView } from "./kaitai-view.js";
import { call, collect, serverDecoded, SERVER_DECODED, uploadFile, saveBlob } from "./requests.js";
import { createRangedFileReader } from "./ranged-file.js";
import { binaryChunkSize, offlineUnavailable } from "./preview-model.js";
const readBinaryRange = createRangedFileReader({ call, collect });
import { fetchZipEntries } from "./download.js";
import { el } from "./preview-dom.js";
import { readOnlyRoot } from "./fs-context.js";
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
async function mediaView({ path, file, signal, download }) {
    const { mediaStream } = await import("./media-stream.js");
    signal?.throwIfAborted();
    const media = await mediaStream(path, file, signal);
    if (!(media instanceof HTMLVideoElement)) return media;
    // A video: shown here, with Watch, which takes it into TabTop's own
    // player (the remote browser's: video-player.js), over the whole screen,
    // and gives it back here as that's closed, where it got to.
    const box = el("div", { className: "video-view" }, media);
    const watch = el("button", { type: "button", className: "watch", title: "Watch in the player: full screen, its speed, back and on (Enter)" });
    watch.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9.5v5l4.5-2.5z" fill="currentColor"/></svg><span>Watch</span>';
    let closePlayer = null;
    const open = async () => {
        if (closePlayer) return;
        const { openPlayer } = await import("./video-player.js");
        if (closePlayer || !box.isConnected) return;
        watch.hidden = true;
        closePlayer = openPlayer(media, {
            title: file.name,
            // The preview's own download: through the tunnel, to this device.
            // (Not followed here: the browser's own download. Nothing to show a
            // player opened again, so its attach asks nothing.)
            download: download ? (say, opts) => { if (opts?.attach || opts?.detach) return; download(); say(`Downloading ${file.name}…`); } : null,
            downloadTitle: "Download it",
            into: box.closest("dialog") ?? document.body,
            closed: () => {
                closePlayer = null;
                watch.hidden = false;
                if (box.isConnected) watch.focus();
            },
        });
        if (media.paused) media.play().catch(() => {});
    };
    watch.addEventListener("click", open);
    media.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            open();
        }
    });
    // Left with the preview (another file shown, or it's closed): closed too.
    signal?.addEventListener("abort", () => closePlayer?.(), { once: true });
    box.append(watch);
    return box;
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
    // 3D printing's models and G-code, drawn (see model-view.js).
    // ("Save as STL" saves beside it, under a name not taken, where it can
    // be written; else it's downloaded.)
    model: async ({ file, blob, signal }) => {
        const { modelView } = await import("./model-view.js");
        const saveFile = async (made, name) => {
            if (readOnlyRoot()) {
                saveBlob(made, name);
                return `Downloaded ${name}.`;
            }
            const reply = await uploadFile(new File([made], name, { type: made.type }), () => {}, file.dir, new AbortController().signal, false);
            return `Saved beside it as ${reply?.name ?? name}.`;
        };
        return modelView({ file, blob, signal, saveFile });
    },
    // A HEIC picture, which most browsers can't decode, is shown as the
    // server decodes it; the file itself is what its EXIF is of.
    image: async ({ file, path, blob, url, saveMetadata, signal }) => {
        const { imageView } = await import("./image-view.js");
        const type = blob?.type || file.type;
        let shown = null;
        if (SERVER_DECODED.has(type)) {
            try {
                shown = await serverDecoded(path, { mtime: file.mtime, size: file.size, signal });
            } catch (err) {
                // Given up on: nothing, quietly (what's drawn now is another's).
                if (signal?.aborted) return el("p");
                // The server's reasons are sentences; the tunnel's ("connection lost") aren't.
                const said = String(err?.message || "");
                const why = /[.!?]$/.test(said) ? said : `This picture couldn't be decoded${said ? ` (${said})` : ""}.`;
                return el("p", { className: "error", textContent: `${why} Download it instead.` });
            }
        }
        return imageView({ file, blob, url, shown, saveMetadata });
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
    // (Its viewer would come from the server: see preview-model.js.)
    if (offlineUnavailable(options.kind)) throw new Error("this kind of file isn't supported by the offline client");
    return renderers[options.kind](options);
}
