// Sandboxed frame adapters. Only their message bridge can fetch file data.
import { createRangedFileReader, validFileRange } from "./ranged-file.js";
import { call, collect } from "./requests.js";
import { el } from "./preview-dom.js";
import { typeOf, resolvePath } from "./preview-model.js";
import { readingTheme, bookPlace, setBookPlace } from "./preview-settings.js";
import { previewLink } from "./preview-links.js";
import { pictureLoader } from "./preview-pictures.js";
import { frameResources, remoteResource, resourceAddress, webAddress } from "./preview-resources.js";
import { frameMedia } from "./preview-media.js";

const readRange = createRangedFileReader({ call, collect });

// A picture from the web (at url, from webAddress), as mode allows.
function frameExternalPicture(url, mode, reserve, signal) {
    if (mode === "direct") return { url };
    if (mode !== "proxy") return { error: "External resources are blocked." };
    return remoteResource(url, "image", reserve, signal);
}

// All frame formats share the same sandbox and message lifecycle.
function sandboxFrame(className, title, source, externalMode = "none") {
    const frame = el("iframe", { className, title });
    frame.setAttribute("sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox");
    frame.setAttribute("referrerpolicy", "no-referrer");
    const url = new URL(source, import.meta.url);
    if (externalMode === "direct") url.searchParams.set("external", "direct");
    frame.src = url.href;
    frame.external = externalMode === "direct" ? "direct" : "";
    return frame;
}
function bindFrame(frame, answer, opts, ready, themed = false) {
    const message = (event) => {
        if (event.source !== frame.contentWindow || !event.data || typeof event.data !== "object") return;
        const m = event.data;
        // A frame that navigated itself to another CSP mode than the one
        // asked for is sent back, not answered.
        if (m.type === "ready" && (m.external ?? "") !== (frame.external ?? "")) { frame.src = frame.src; return; }
        if (m.type === "external-resources" && Number.isSafeInteger(m.count) && m.count >= 0) { opts.externalFound?.(m.count); return; }
        if (m.type === "external") return previewLink(frame, m.href);
        if (m.type === "navigate") return opts.navigate?.(m.location);
        if (m.type === "position" && m.location && Number.isFinite(m.location.top) && Number.isFinite(m.location.left)) { frame.previewLocation = m.location; return; }
        if (m.type === "rendered") { frame.dataset.rendered = JSON.stringify(m.report); return; }
        if (m.type === "ready" && themed) frame.contentWindow?.postMessage({ type: "theme", theme: readingTheme() }, "*");
        return answer(m);
    };
    window.addEventListener("message", message);
    frame.stop = () => window.removeEventListener("message", message);
    frame.restore = (location) => {
        opts.location = location;
        if (ready()) frame.contentWindow?.postMessage({ type: "restore", location }, "*");
    };
}

// markdownFrame shows the Markdown file at path, in the folder dir, as
// tabtopd renders it (see markdown.go), in a frame of md-frame.html,
// sandboxed without allow-same-origin: its scripts (KaTeX, Mermaid,
// highlight.js) run at an origin of their own, which can't read the
// session or this page. It talks to this page only by messages: it's sent
// the HTML once it's ready, and asks for the pictures beside the file
// (see framePicture), which this page fetches through the tunnel, and
// passes on links to other files, to opts.open(href). With path "", it
// shows opts.html instead, and update(html) shows other HTML, as text
// being edited changes. opts.fragment is a heading to scroll to. The frame
// opts.format="html" rebuilds raw HTML from an allowlist inside the sandbox.
// The frame returned has update() and stop(), which stops answering it. What it
// rendered last is put in its data-rendered, as JSON.
export async function markdownFrame(path, dir, opts = {}) {
    let html = opts.html ?? "";
    if (path) {
        const t = await call({ type: "markdown", path });
        t.close();
        html = t.reply.html;
    }
    const htmlMode = opts.format === "html";
    const frame = sandboxFrame(htmlMode ? "html" : "markdown", htmlMode ? "HTML, rendered" : "Markdown, rendered", "md-frame.html", opts.externalMode);
    let ready = false;
    let pictures = null, render = 0, resources = null, media = null;
    const newPictures = () => pictureLoader({
        resolve: src => webAddress(src) ?? resolvePath(dir, src.split("#")[0]),
        load: (src, reserve, signal) => webAddress(src)
            ? frameExternalPicture(src, opts.externalMode, reserve, signal) : framePicture(src, reserve, signal),
    });
    const send = (fragment = "", location = null) => frame.contentWindow?.postMessage({ type: "render", html, fragment, location, format: htmlMode ? "html" : "markdown", externalMode: opts.externalMode ?? "none" }, "*");
    const answer = async (m) => {
        if (m.type === "ready") {
            ready = true;
            send(opts.fragment ?? "", opts.location);
        } else if (m.type === "render-start" && Number.isSafeInteger(m.render) && m.render > render) {
            render = m.render;
            pictures?.stop();
            pictures = newPictures();
            resources?.stop(); media?.stop();
            resources = frameResources(dir, opts.externalMode ?? "none");
            media = frameMedia(frame, dir, opts.externalMode ?? "none");
        } else if (m.type === "resource" && m.render === render && resources) {
            const loader = resources;
            let got = await loader.read({ src: m.src, base: m.base ?? "", kind: m.kind });
            if (loader !== resources) got = { error: "Preview replaced." };
            const bytes = got.bytes?.slice(0);
            frame.contentWindow?.postMessage({ id: m.id, ...got, ...(bytes ? { bytes } : {}) }, "*", bytes ? [bytes] : []);
        } else if (m.type === "media" && m.render === render && media) {
            const owner = media;
            const got = await owner.open({ ...m, id: m.mediaId });
            if (owner === media) frame.contentWindow?.postMessage({ id: m.id, ...got }, "*");
        } else if (m.type === "media-positions" && m.render === render && Array.isArray(m.positions)) {
            for (const at of m.positions.slice(0, 8)) media?.place(at.id, at.rect);
        } else if (m.type === "media-direct" && m.render === render) {
            const at = resourceAddress(m.src, "", dir);
            frame.contentWindow?.postMessage({ id: m.id, ...(opts.externalMode === "direct" && at?.remote ? { url: at.url } : { error: "External media is blocked." }) }, "*");
        } else if (m.type === "image" && typeof m.src === "string") {
            const loader = pictures;
            let got = loader && m.render === render ? await loader.read(m.src) : { error: "Preview replaced." };
            if (loader !== pictures) got = { error: "Preview replaced." };
            // Keep the cached source, but transfer the reply copy to the frame.
            const bytes = got.bytes?.slice(0);
            frame.contentWindow?.postMessage({ id: m.id, ...got, ...(bytes ? { bytes } : {}) }, "*", bytes ? [bytes] : []);
        } else if (m.type === "open" && typeof m.href === "string") {
            opts.open?.(m.href, m.location);

        }
    };
    bindFrame(frame, answer, opts, () => ready, true);
    const unbind = frame.stop;
    frame.stop = () => { pictures?.stop(); resources?.stop(); media?.stop(); resources = media = pictures = null; unbind(); };
    frame.update = (newHTML) => {
        html = newHTML;
        if (ready) {
            send();
        }
    };
    return frame;
}

// epubFrame shows the book at path, file {name, size, mtime, book}, in a
// sandboxed frame (see epub-frame.js), answering its asking for chapters
// and pictures by fetching each through the tunnel, from the book as it
// was opened, and remembering where it's read to.
export function epubFrame(path, file, opts = {}) {
    let ready = false;
    const frame = sandboxFrame("epub", file.book.title || file.name, "epub-frame.html", opts.externalMode);
    let render = 0, pictures = null, chapterAbort = null;
    const ask = async (item, signal, consume) => {
        let tunnel;
        const cancel = () => tunnel?.close();
        signal.addEventListener("abort", cancel, { once: true });
        try {
            signal.throwIfAborted();
            tunnel = await call({ type: "epub", path, item, if_mtime: file.mtime, if_size: file.size });
            signal.throwIfAborted();
            return await consume(tunnel);
        } finally {
            signal.removeEventListener("abort", cancel);
            tunnel?.close();
        }
    };
    const newPictures = () => pictureLoader({
        // The child resolves book URLs to decoded ZIP-entry paths (itemOf).
        // Preserve literal '%' and '#' in those filenames rather than decoding
        // or splitting them a second time.
        resolve: src => webAddress(src) ?? src,
        load: (src, reserve, signal) => webAddress(src) ? frameExternalPicture(src, opts.externalMode, reserve, signal) : ask(src, signal, async t => {
            if (typeOf(src.split("/").pop() ?? "")?.kind !== "image" ||
                !t.reply.mime?.startsWith("image/") || !Number.isSafeInteger(t.reply.size) || t.reply.size < 0 ||
                t.reply.size > 20 * 1024 * 1024) throw new Error("not a supported picture");
            if (!reserve(t.reply.size)) return { error: "Pictures exceed the 64 MiB preview budget." };
            const blob = await collect(t, t.reply.size, () => {}, t.reply.mime);
            signal.throwIfAborted();
            return { bytes: await blob.arrayBuffer(), mime: t.reply.mime };
        }),
    });
    const reply = (m) => frame.contentWindow?.postMessage(m, "*", m.bytes ? [m.bytes] : []);
    const answer = async (m) => {
        if (m.type === "ready") {
            ready = true;
            reply({ type: "open", book: file.book, start: opts.location ?? bookPlace(path, file.size), externalMode: opts.externalMode ?? "none" });
        } else if (m.type === "chapter" && typeof m.item === "string" && Number.isSafeInteger(m.render) && m.render > render) {
            render = m.render;
            chapterAbort?.abort();
            pictures?.stop();
            chapterAbort = new AbortController();
            pictures = newPictures();
            try {
                const got = await ask(m.item, chapterAbort.signal, t => ({ html: t.reply.html }));
                reply({ id: m.id, ...got });
            } catch (err) {
                reply({ id: m.id, error: err.message });
            }
        } else if (m.type === "image" && typeof m.src === "string") {
            if (!webAddress(m.src) && typeOf(m.src.split("/").pop() ?? "")?.kind !== "image") {
                reply({ id: m.id, error: "not a picture" });
                return;
            }
            const loader = pictures;
            let got = loader && m.render === render ? await loader.read(m.src) : { error: "Chapter replaced." };
            if (loader !== pictures) got = { error: "Chapter replaced." };
            const bytes = got.bytes?.slice(0);
            reply({ id: m.id, ...got, ...(bytes ? { bytes } : {}) });
        } else if (m.type === "at" && typeof m.item === "string" && m.item.length < 1000 && Number.isFinite(m.fraction)) {
            frame.previewLocation = { item: m.item, fraction: m.fraction, size: Number.isInteger(m.size) ? m.size : undefined };
            setBookPlace(path, file.size, { item: m.item, fraction: m.fraction, size: Number.isInteger(m.size) ? m.size : undefined });

        }
    };
    bindFrame(frame, answer, opts, () => ready, true);
    const unbind = frame.stop;
    frame.stop = () => { chapterAbort?.abort(); pictures?.stop(); pictures = null; unbind(); };
    return frame;
}

// Per-source cap, in addition to pictureLoader's count and cumulative budgets.
const FRAME_PICTURE_BYTES = 20e6;

// Read a confined, canonical picture path after reserving its cache space.
async function framePicture(path, reserve, signal) {
    const t = typeOf(path.split("/").pop() ?? "");
    if (t?.kind !== "image") {
        return { error: "not a picture" };
    }
    let tt;
    const cancel = () => tt?.close();
    signal.addEventListener("abort", cancel, { once: true });
    try {
        signal.throwIfAborted();
        tt = await call({ type: "file", path });
        signal.throwIfAborted();
        const { size } = tt.reply;
        if (size > FRAME_PICTURE_BYTES) {
            return { error: "too big to show" };
        }
        if (!reserve(size)) return { error: "Pictures exceed the 64 MiB preview budget." };
        const blob = await collect(tt, size, () => {}, t.type);
        signal.throwIfAborted();
        return { bytes: await blob.arrayBuffer(), mime: t.type };
    } catch (err) {
        return { error: /^not found\.?$/i.test(err.message) ? `Local image not found: ${path}` : err.message };
    } finally {
        signal.removeEventListener("abort", cancel);
        tt?.close();
    }
}

// The most of a PDF its frame may ask for at once, and the most requests
// for parts going at once.
const PDF_PART = 16 << 20;
const PDF_PARTS_AT_ONCE = 4;

// pdfFrame shows the PDF at path, file {size, mtime, start}, with pdf.js,
// in a frame of pdf-frame.html, sandboxed without allow-same-origin, as
// Markdown's is (see markdownFrame). The frame is given the file's start,
// and asks for the parts pdf.js needs as it needs them, which this page
// fetches through the tunnel: only parts of that file, as it was when it
// was opened (a part of it changed since fails, rather than mixing two
// versions). How much has been fetched is put in the frame's data-bytes,
// and what it's drawn in its data-rendered, as JSON. It has stop(), which
// stops answering it.
export function pdfFrame(path, file, opts = {}) {
    let ready = false;
    const frame = sandboxFrame("pdf", "PDF", "pdf-frame.html");
    const renders = new Map();
    let renderID = 0, imageEditor = null, openingImages = false, stopped = false;
    const renderPage = (number, dpi, signal, thumbnail = false) => new Promise((resolve, reject) => {
        if (stopped || signal.aborted) { reject(new Error("Page rendering cancelled.")); return; }
        const id = `pdf-image-${++renderID}`;
        const finish = (error, result) => {
            clearTimeout(timer); signal.removeEventListener("abort", abort); renders.delete(id);
            if (error) reject(new Error(error)); else resolve(result);
        };
        const abort = () => { frame.contentWindow?.postMessage({ type: "image-cancel", id }, "*"); finish("Page rendering cancelled."); };
        const timer = setTimeout(abort, 120000);
        signal.addEventListener("abort", abort, { once: true });
        renders.set(id, finish);
        frame.contentWindow?.postMessage({ type: "image-render", id, number, dpi, thumbnail }, "*");
    });
    let fetched = file.start.byteLength;
    frame.dataset.bytes = String(fetched);
    let going = 0;
    const queue = [];
    const part = async (begin, end) => {
        if (!validFileRange(begin, end, file.size, PDF_PART)) {
            return { error: "not a part of the file" };
        }
        while (going >= PDF_PARTS_AT_ONCE) {
            await new Promise((resolve) => queue.push(resolve));
        }
        going++;
        try {
            const bytes = await readRange(path, file, begin, end, { maxBytes: PDF_PART });
            fetched += bytes.byteLength;
            frame.dataset.bytes = String(fetched);
            return { bytes };
        } catch (err) {
            return { error: err.message };
        } finally {
            going--;
            queue.shift()?.();
        }
    };
    const answer = async (m) => {
        if (m.type === "ready") {
            ready = true;
            const initial = file.start.slice(0);
            frame.contentWindow.postMessage({ type: "open", size: file.size, initial, location: opts.location }, "*", [initial]);
        } else if (m.type === "range") {
            const got = await part(m.begin, m.end);
            frame.contentWindow?.postMessage({ id: m.id, ...got }, "*", got.bytes ? [got.bytes] : []);
        } else if (m.type === "image-rendered" && renders.has(m.id)) {
            const valid = m.blob instanceof Blob && m.blob.type === "image/png" && m.blob.size <= 64 * 1024 * 1024 &&
                [m.width,m.height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 8192) && m.width*m.height <= 16e6 &&
                [m.widthPt,m.heightPt].every(n => Number.isFinite(n) && n > 0 && n <= 100000);
            renders.get(m.id)(m.error || (!valid ? "Invalid rendered PDF page." : null), m);
        } else if (m.type === "edit-images" && Number.isSafeInteger(m.pages) && m.pages > 0 && m.pages <= 100000 && !stopped && !openingImages) {
            if (imageEditor) { imageEditor.focus(); return; }
            openingImages = true;
            try {
                const { pdfImageEditor } = await import("./pdf-image-editor.js");
                if (!stopped) imageEditor = pdfImageEditor({ name: path.split("/").pop(), count: m.pages,
                    current: Number.isSafeInteger(m.current) && m.current >= 1 && m.current <= m.pages ? m.current : 1,
                    renderPage, closed: () => { imageEditor = null; } });
            } finally { openingImages = false; }
        }
    };
    bindFrame(frame, answer, opts, () => ready);
    const stop = frame.stop;
    frame.stop = () => {
        stopped = true; imageEditor?.stop(); stop();
        for (const finish of [...renders.values()]) finish("PDF preview closed.");
    };
    return frame;
}
