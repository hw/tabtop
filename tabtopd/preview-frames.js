// Sandboxed frame adapters. Only their message bridge can fetch file data.
import { createRangedFileReader, validFileRange } from "./ranged-file.js";
import { call, collect } from "./requests.js";
import { el } from "./preview-dom.js";
import { typeOf, resolvePath } from "./preview-model.js";
import { readingTheme, bookPlace, setBookPlace } from "./preview-settings.js";
import { previewLink } from "./preview-links.js";

const readRange = createRangedFileReader({ call, collect });

// All frame formats share the same sandbox and message lifecycle.
function sandboxFrame(className, title, source) {
    const frame = el("iframe", { className, title });
    frame.setAttribute("sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.src = new URL(source, import.meta.url).href;
    return frame;
}
function bindFrame(frame, answer, opts, ready, themed = false) {
    const message = (event) => {
        if (event.source !== frame.contentWindow || !event.data || typeof event.data !== "object") return;
        const m = event.data;
        if (m.type === "external") return previewLink(frame, m.href);
        if (m.type === "navigate") return opts.navigate?.(m.location);
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
    const frame = sandboxFrame(htmlMode ? "html" : "markdown", htmlMode ? "HTML, rendered" : "Markdown, rendered", "md-frame.html");
    let ready = false;
    let asked = 0;
    const pictures = new Map();  // by src, as asked: each fetched once, however often it's rendered
    const send = (fragment = "", location = null) => frame.contentWindow?.postMessage({ type: "render", html, fragment, location, format: htmlMode ? "html" : "markdown" }, "*");
    const answer = async (m) => {
        if (m.type === "ready") {
            ready = true;
            send(opts.fragment ?? "", opts.location);
        } else if (m.type === "image" && typeof m.src === "string") {
            if (!pictures.has(m.src)) {
                pictures.set(m.src, framePicture(dir, m.src, ++asked));
            }
            const got = await pictures.get(m.src);
            // A copy for each answer: what's sent is moved, not copied.
            frame.contentWindow?.postMessage({ id: m.id, ...got, ...(got.bytes ? { bytes: got.bytes.slice(0) } : {}) }, "*");
        } else if (m.type === "open" && typeof m.href === "string") {
            opts.open?.(m.href, m.location);

        }
    };
    bindFrame(frame, answer, opts, () => ready, true);
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
    const frame = sandboxFrame("epub", file.book.title || file.name, "epub-frame.html");
    const ask = (item) => call({ type: "epub", path, item, if_mtime: file.mtime, if_size: file.size });
    const reply = (m) => frame.contentWindow?.postMessage(m, "*", m.bytes ? [m.bytes] : []);
    const answer = async (m) => {
        if (m.type === "ready") {
            ready = true;
            reply({ type: "open", book: file.book, start: opts.location ?? bookPlace(path, file.size) });
        } else if (m.type === "chapter" && typeof m.item === "string") {
            try {
                const t = await ask(m.item);
                t.close();
                reply({ id: m.id, html: t.reply.html });
            } catch (err) {
                reply({ id: m.id, error: err.message });
            }
        } else if (m.type === "image" && typeof m.src === "string") {
            if (typeOf(m.src.split("/").pop() ?? "")?.kind !== "image") {
                reply({ id: m.id, error: "not a picture" });
                return;
            }
            try {
                const t = await ask(m.src);
                if (!t.reply.mime?.startsWith("image/") || !Number.isSafeInteger(t.reply.size)) {
                    t.close();
                    throw new Error("not a picture");
                }
                const blob = await collect(t, t.reply.size, () => {}, t.reply.mime);
                reply({ id: m.id, bytes: await blob.arrayBuffer(), mime: t.reply.mime });
            } catch (err) {
                reply({ id: m.id, error: err.message });
            }
        } else if (m.type === "at" && typeof m.item === "string" && m.item.length < 1000 && Number.isFinite(m.fraction)) {
            setBookPlace(path, file.size, { item: m.item, fraction: m.fraction, size: Number.isInteger(m.size) ? m.size : undefined });

        }
    };
    bindFrame(frame, answer, opts, () => ready, true);
    return frame;
}

// The most pictures a Markdown file's frame is given, and the biggest.
const FRAME_PICTURES = 100;
const FRAME_PICTURE_BYTES = 20e6;

// framePicture fetches the picture src, the n-th asked for, relative to
// the folder dir, for a Markdown file's frame: {bytes, mime}, or {error}.
// Only pictures in ~/Downloads, by a path from dir.
async function framePicture(dir, src, n) {
    if (n > FRAME_PICTURES) {
        return { error: "too many pictures" };
    }
    const path = resolvePath(dir, src.split("#")[0]);
    if (path === null) {
        return { error: "not in Downloads, beside this file" };
    }
    const t = typeOf(path.split("/").pop() ?? "");
    if (t?.kind !== "image") {
        return { error: "not a picture" };
    }
    try {
        const tt = await call({ type: "file", path });
        const { size } = tt.reply;
        if (size > FRAME_PICTURE_BYTES) {
            tt.close();
            return { error: "too big to show" };
        }
        const blob = await collect(tt, size, () => {}, t.type);
        return { bytes: await blob.arrayBuffer(), mime: t.type };
    } catch (err) {
        return { error: err.message };
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

        }
    };
    bindFrame(frame, answer, opts, () => ready);
    return frame;
}
