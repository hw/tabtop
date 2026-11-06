// Preview rendering is a map of adapters; orchestration lives in preview.js.
// Each renderer returns a DOM element adapted to PreviewView by the controller.
import { call } from "./requests.js";
import { el } from "./preview-dom.js";
import { render, structured, zipListing } from "./preview-content.js";
import { markdownFrame, epubFrame, pdfFrame } from "./preview-frames.js";

async function documentView(options) {
    const { file, path, blob, url, kind, location, fragment, open, navigate } = options;
    try {
        const opts = { fragment, location, open, navigate };
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
    zip: ({ file, path }) => zipListing(file.entries, async (entries) => {
        const t = await call({ type: "zip-extract", path, entries, if_mtime: file.mtime, if_size: file.size });
        t.close();
        return t.reply;
    }),
    epub: ({ path, file, location, navigate }) => epubFrame(path, file, { location, navigate }),
    pdf: ({ path, file, location, navigate }) => pdfFrame(path, file, { location, navigate }),
    audio: mediaView,
    video: mediaView,
    markdown: documentView,
    html: documentView,
    table: ({ file, blob, url }) => structured("table", blob, url, file.name, file.tableOptions),
    json: ({ file, blob, url }) => structured("json", blob, url, file.name),
    image: ({ file, blob, url }) => render("image", blob, url, file.name),
    text: ({ file, blob, url }) => render("text", blob, url, file.name),
};
export function renderPreview(options) {
    if (!Object.hasOwn(renderers, options.kind)) throw new Error("this file can't be rendered");
    return renderers[options.kind](options);
}
