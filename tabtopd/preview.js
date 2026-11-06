// Previews on the files page, served by tabtopd: pictures, video, sound
// and text, shown over the page instead of saved. The file is fetched
// through the tunnel as for a download and held in memory (see collect),
// Buffered formats have size limits; audio and video use byte ranges through a
// service worker. Download in the preview fetches the selected file.
//
// A file shown as a page of this site could run scripts that read the
// session, and ~/Downloads holds whatever the desktop's browser saved. So
// each kind is shown by an element that can't run what's in it: <img> for
// pictures (an SVG's scripts don't run in one), <video> and <audio>, and
// text and source views as the text of a <pre>.
// Nothing is shown in a frame of the site. HTML and Markdown (see
// markdownFrame), PDFs (see pdfFrame) and EPUB books (see epubFrame) are
// shown in sandboxed frames of their own origin, which can't reach the site
// or this page.
// Text in a language it knows is coloured by highlight.js (see colour),
// which only ever adds <span class> elements around the text, escaped; what
// it makes is checked for that before it's shown, and the page's CSP lets
// no script in it run anyway.

import { glyphs, iconSVG } from "./glyphs.js";
import { call, collect, uploadFile } from "./requests.js";
import { askBookDetails, askYes, copyText, statusRow } from "./ui.js";
import { checkJSON, formatJSON, FormatTooBig, jsonView, parseJSON } from "./json-view.js";
import { tableView } from "./table-view.js";

function el(tag, props = {}, ...children) {
    const e = Object.assign(document.createElement(tag), props);
    e.append(...children);
    return e;
}

const join = (dir, name) => (dir ? `${dir}/${name}` : name);

// What's previewed, by extension: its kind and the type it's shown as.
const types = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
    bmp: "image/bmp", ico: "image/x-icon", svg: "image/svg+xml",
    mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mkv: "video/x-matroska", mov: "video/quicktime", ogv: "video/ogg",
    mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", oga: "audio/ogg", ogg: "audio/ogg", opus: "audio/ogg",
    wav: "audio/wav", flac: "audio/flac",
};
const textExtensions = new Set(("txt text md markdown rst org tex log csv tsv json jsonl ndjson xml yaml yml toml ini cfg conf " +
    "env properties sh bash zsh fish ps1 bat py rb pl php lua js mjs cjs ts tsx jsx go rs c h cc cpp cxx hpp java kt " +
    "swift cs scala sql diff patch css scss html htm srt vtt").split(" "));

// The language highlight.js colours text in, by extension, or by the whole
// name for names without one.
const languages = {
    md: "markdown", markdown: "markdown", json: "json", jsonl: "json", ndjson: "json", xml: "xml", html: "xml", htm: "xml",
    yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini", cfg: "ini", conf: "ini", properties: "ini", env: "bash",
    sh: "bash", bash: "bash", zsh: "bash", fish: "bash", ps1: "powershell", bat: "dos", py: "python", rb: "ruby", pl: "perl",
    php: "php", lua: "lua", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "typescript",
    tsx: "typescript", go: "go", rs: "rust", c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", java: "java",
    kt: "kotlin", swift: "swift", cs: "csharp", scala: "scala", sql: "sql", diff: "diff", patch: "diff", css: "css",
    scss: "scss", tex: "latex", dockerfile: "dockerfile", makefile: "makefile", gnumakefile: "makefile",
    "nginx.conf": "nginx", ".bashrc": "bash", ".profile": "bash", ".zshrc": "bash",
};

// languageOf is the language to colour the file named name in, or "".
function languageOf(name) {
    const lower = name.toLowerCase();
    if (Object.hasOwn(languages, lower)) {
        return languages[lower];
    }
    const dot = lower.lastIndexOf(".");
    return dot > 0 && Object.hasOwn(languages, lower.slice(dot + 1)) ? languages[lower.slice(dot + 1)] : "";
}

// Text longer than this isn't coloured: highlight.js could take seconds.
const COLOUR_LIMIT = 512 * 1024;

// The languages loaded beside highlight.js's own (see highlightFiles in
// tabtopd).
const MORE_LANGUAGES = ["dockerfile", "dos", "latex", "nginx", "powershell", "scala"];

// highlighter loads highlight.js, the first time it's asked, and resolves
// to it, or null if it can't be loaded (as where tabtopd has none).
let loading = null;
function highlighter() {
    loading ??= import("./highlight/highlight.min.js").then(async (m) => {
        const hljs = m.default;
        await Promise.all(MORE_LANGUAGES.map(async (l) => {
            try {
                hljs.registerLanguage(l, (await import("./highlight/languages/" + l + ".min.js")).default);
            } catch {
                // That language stays plain.
            }
        }));
        return hljs;
    }).catch(() => null);
    return loading;
}

// colour returns a <code> holding text coloured as language, or null if it
// can't be.
async function colour(text, language) {
    const hljs = language && text.length <= COLOUR_LIMIT ? await highlighter() : null;
    if (!hljs?.getLanguage(language)) {
        return null;
    }
    let html;
    try {
        html = hljs.highlight(text, { language, ignoreIllegals: true }).value;
    } catch {
        return null;
    }
    // Only spans with classes, around text: anything else, and it's shown
    // plain.
    const t = document.createElement("template");
    t.innerHTML = html;
    for (const e of t.content.querySelectorAll("*")) {
        if (e.tagName !== "SPAN" || [...e.attributes].some((a) => a.name !== "class")) {
            return null;
        }
    }
    // (The HTML parser makes line endings \n, as the <pre> shows them anyway.)
    if (t.content.textContent !== text.replace(/\r\n?/g, "\n")) {
        return null;
    }
    const code = el("code", { className: `hljs language-${language}` });
    code.append(t.content);
    return code;
}

// The most of each kind that's previewed, in bytes.
// Audio, video and PDFs are read in ranges, and a book a chapter at a time
// (see epubFrame), so these have no whole-file buffer limit.
const limits = { image: 50e6, video: Number.MAX_SAFE_INTEGER, audio: Number.MAX_SAFE_INTEGER, text: 2e6, pdf: Number.MAX_SAFE_INTEGER, epub: Number.MAX_SAFE_INTEGER, zip: Number.MAX_SAFE_INTEGER };

function typeOf(name) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
    if (ext === "zip") return { kind: "zip", type: "application/zip" };
    if (ext === "pdf") {
        return { kind: "pdf", type: "application/pdf" };
    }
    if (ext === "epub") {
        return { kind: "epub", type: "application/epub+zip" };
    }
    if (Object.hasOwn(types, ext)) {
        return { kind: types[ext].split("/")[0], type: types[ext] };
    }
    // Names without an extension, as README and Makefile, are mostly text;
    // a file that isn't says so when it's shown.
    return !ext || textExtensions.has(ext) ? { kind: "text", type: "text/plain" } : null;
}

// previewable reports whether a file named name, of size bytes, is
// previewed.
export function previewable(name, bytes) {
    const t = typeOf(name);
    return !!t && bytes <= limits[t.kind];
}

// preview shows files[index] of files, [{name, bytes}] in the folder dir,
// and steps through the rest with the arrow buttons and keys. Download
// downloads the one shown, through the encrypted tunnel, as the files page
// does: download(path). Its menu (▾) has that too, and, with
// opts.direct(path), Direct Download: straight over HTTPS, not through
// the tunnel. A link in a Markdown file to another file opens
// that one instead, with Back to return (see follow); text can be edited
// and saved (see startEditing).
export function preview(dir, files, index, download, opts = {}) {
    const name = el("strong");
    const where = el("span", { className: "hint" });
    const button = (text, label, className = "") => {
        const b = el("button", { type: "button", textContent: text, title: label, className });
        b.setAttribute("aria-label", label);
        return b;
    };
    const back = button("", "Back to the previous location", "back glyph");
    back.innerHTML = iconSVG("back");
    back.hidden = true;
    const prev = button(glyphs.previous, "Previous (←)");
    const next = button(glyphs.next, "Next (→)");
    prev.addEventListener("click", () => show(index - 1));
    next.addEventListener("click", () => show(index + 1));
    // Download, and its menu.
    const save = button("", "Download, through the encrypted tunnel", "download glyph");
    save.innerHTML = iconSVG("download");
    const more = button(glyphs.chevronDown, "Other ways to download", "download-more");
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-expanded", "false");
    const downloads = el("div", { className: "download-menu", hidden: true });
    downloads.setAttribute("role", "menu");
    const showDownloads = (show) => {
        downloads.hidden = !show;
        more.setAttribute("aria-expanded", String(show));
        if (show) {
            downloads.querySelector("button")?.focus();
        }
    };
    const choice = (glyph, label, className, onClick) => {
        const b = button("", label, `glyph ${className}`);
        b.innerHTML = glyph;
        b.setAttribute("role", "menuitem");
        b.addEventListener("click", () => {
            showDownloads(false);
            onClick();
        });
        return b;
    };
    more.addEventListener("click", () => showDownloads(downloads.hidden));
    downloads.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            // Only the menu: not the preview too.
            e.preventDefault();
            e.stopPropagation();
            showDownloads(false);
            more.focus();
        }
    });
    const saveGroup = el("span", { className: "download-group" }, save, more, downloads);
    // Markdown is shown rendered, CSV as a table and JSON as a tree, or
    // each raw, as its text, as last chosen (see VIEWS): two buttons, the
    // one for the way it's shown pressed.
    // Light or dark, for what's shown in a frame of its own (rendered
    // Markdown, a book), or as the system is: chosen in turn (see THEMES).
    const theme = button("", "", "theme glyph");
    theme.hidden = true;
    const showTheme = () => {
        const [glyph, label] = THEMES[readingTheme()];
        theme.textContent = glyph;
        theme.title = `${label} (click to change)`;
        theme.setAttribute("aria-label", theme.title);
    };
    showTheme();
    theme.addEventListener("click", () => {
        const order = Object.keys(THEMES);
        setReadingTheme(order[(order.indexOf(readingTheme()) + 1) % order.length]);
        showTheme();
        for (const f of dialog.querySelectorAll("iframe.markdown, iframe.html, iframe.epub")) {
            f.contentWindow?.postMessage({ type: "theme", theme: readingTheme() }, "*");
        }
    });
    const view = el("span", { className: "views", role: "group", hidden: true });
    view.setAttribute("aria-label", "Show it");
    const setView = (format) => {
        if (!format) {
            return;
        }
        const ways = [[true, VIEWS[format].toShown], [false, VIEWS[format].toText]];
        view.replaceChildren(...ways.map(([way, [label, title]]) => {
            const b = el("button", { type: "button", className: "view glyph", textContent: label, title });
            b.setAttribute("aria-label", title);
            b.setAttribute("aria-pressed", String(viewShown(format) === way));
            b.addEventListener("click", () => {
                if (viewShown(format) !== way) {
                    setViewShown(format, way);
                    if (blob && !editing) {
                        draw(shown);
                    }
                }
            });
            return b;
        }));
    };
    const edit = button(glyphs.edit, "Edit this file", "edit glyph");
    edit.hidden = true;
    const store = button("Save", "Save (Ctrl S)", "primary save-edit");
    const done = button("Done", "Stop editing", "done-edit");
    store.hidden = done.hidden = true;
    const close = el("button", { type: "button", className: "close", textContent: glyphs.close, title: "Close (Esc)" });
    close.setAttribute("aria-label", "Close");
    // The whole window, or the box it starts as: as last chosen.
    const widen = button("", "", "widen glyph");
    const showWide = () => {
        const wide = previewWide();
        dialog.classList.toggle("wide", wide);
        widen.textContent = wide ? glyphs.contract : glyphs.expand;
        widen.title = wide ? "Back to a box" : "Fill the window";
        widen.setAttribute("aria-label", widen.title);
        widen.setAttribute("aria-pressed", String(wide));
    };
    widen.addEventListener("click", () => {
        setPreviewWide(!previewWide());
        showWide();
    });
    const body = el("div", { className: "body" });
    const dialog = el("dialog", { className: "preview" },
        el("div", { className: "head" }, back, name, where, edit, store, done, theme, view, prev, next, saveGroup, widen, close), body);
    showWide();

    // What's shown: counted, so a file that arrives after the next was
    // asked for is dropped; its tunnel while it's coming; then it, and
    // the file it is, {dir, name, size, mtime}.
    let shown = 0;
    let t = null;
    let blob = null;
    let url = null;
    let frame = null;
    let current = null;
    // Downloads follow the selection even while its preview is loading,
    // or if it can't be shown.
    let selectedPath = null;
    // Location snapshots only: bounded, without keeping old frames or file data.
    const trail = [];
    const remember = (location) => {
        const kind = current?.kind === "text" ? formatOf(current.name) : current?.kind;
        const at = previewLocation(kind, location);
        if (!at || !current || editing) {
            return;
        }
        trail.push({ dir: current.dir, name: current.name, location: at });
        if (trail.length > 100) {
            trail.shift();
        }
        back.hidden = false;
    };
    // The editor, while editing: {dirty(), stop()}.
    let editing = null;
    const stop = () => {
        t?.close();
        t = null;
        frame?.stop();
        frame = null;
        blob = null;
        if (url) {
            URL.revokeObjectURL(url);
            url = null;
        }
    };

    // leaveEditing stops editing, asking first if there are changes not
    // saved, and resolves to whether it did.
    const leaveEditing = async () => {
        if (!editing) {
            return true;
        }
        if (editing.dirty() && !(await askYes(`Your changes to ${current.name} aren't saved. Discard them?`, "Discard"))) {
            return false;
        }
        editing.stop();
        editing = null;
        store.hidden = done.hidden = true;
        return true;
    };

    // show shows files[i], leaving any trail of files followed.
    const show = async (i) => {
        if (i < 0 || i >= files.length || !(await leaveEditing())) {
            return;
        }
        trail.length = 0;
        index = i;
        display(dir, files[i].name);
    };

    // display shows the file name in the folder d, scrolled to the heading
    // fragment if it's Markdown.
    const display = async (d, fname, fragment = "", location = null) => {
        const me = ++shown;
        stop();
        const path = join(d, fname);
        selectedPath = path;
        name.textContent = d === dir ? fname : path;
        dialog.setAttribute("aria-label", fname);
        const following = d !== dir || fname !== files[index].name;
        back.hidden = !trail.length;
        where.textContent = !following && files.length > 1 ? `${index + 1} of ${files.length}` : "";
        prev.hidden = next.hidden = following || files.length < 2;
        prev.disabled = index === 0;
        next.disabled = index === files.length - 1;
        edit.hidden = view.hidden = true;
        const status = el("p", { className: "hint", textContent: "Loading…" });
        body.replaceChildren(status);
        try {
            if (typeOf(fname)?.kind === "zip") {
                const tt = await call({ type: "zip-preview", path });
                tt.close();
                if (me !== shown) return;
                const { entries, size, mtime } = tt.reply;
                current = { dir: d, name: fname, size, mtime, kind: "zip", entries };
                await draw(me, fragment, location);
                return;
            }
            // A book: what tabtopd reads of it; the frame asks for its
            // chapters as they're read (see epubFrame).
            if (typeOf(fname)?.kind === "epub") {
                const tt = await call({ type: "epub", path });
                tt.close();
                if (me !== shown) {
                    return;
                }
                const { book, size, mtime } = tt.reply;
                current = { dir: d, name: fname, size, mtime, kind: "epub", book };
                await draw(me, fragment, location);
                return;
            }
            // A PDF: only its start, for now; the frame asks for the rest as
            // it needs it (see pdfFrame).
            const pdf = typeOf(fname)?.kind === "pdf";
            const media = ["video", "audio"].includes(typeOf(fname)?.kind);
            const tt = await call(pdf || media ? { type: "file", path, offset: 0, length: media ? 1 : PDF_FIRST } : { type: "file", path });
            if (me !== shown) {
                tt.close();
                return;
            }
            t = tt;
            const { size, mtime } = tt.reply;
            const { kind, type } = typeOf(fname);
            if (size > limits[kind]) {
                throw new Error("it's grown too big to preview; download it instead");
            }
            if (media) {
                await collect(tt, tt.reply.length, () => {}, type);
                if (me !== shown) return;
                t = null;
                current = { dir: d, name: fname, size, mtime, kind, type };
                await draw(me, fragment, location);
                return;
            }
            if (pdf) {
                const start = await collect(tt, tt.reply.length, () => {}, type);
                if (me !== shown) {
                    return;
                }
                t = null;
                current = { dir: d, name: fname, size, mtime, kind, start: await start.arrayBuffer() };
                await draw(me, fragment, location);
                return;
            }
            const got = await collect(tt, size, (n) => (status.textContent = `Loading… ${size ? Math.floor(n * 100 / size) : 100}%`), type);
            if (me !== shown) {
                return;
            }
            t = null;
            blob = got;
            url = URL.createObjectURL(blob);
            current = { dir: d, name: fname, size, mtime, kind };
            await draw(me, fragment, location);
        } catch (err) {
            if (me === shown) {
                body.replaceChildren(el("p", { className: "error", textContent: `${fname} can't be shown: ${err.message}` }));
            }
        }
    };

    // draw shows the current file, held in blob, as the one shown me.
    // Each drawing is numbered, as each file shown is: one begun later (to
    // show it another way, say), or editing begun, makes those before it
    // stale, and what they make is dropped, not shown over it.
    let drawing = 0;
    const draw = async (me, fragment = "", location = null) => {
        const mine = ++drawing;
        const stale = () => me !== shown || mine !== drawing || !!editing;
        const { kind } = current;
        const format = kind === "text" ? formatOf(current.name) : "";
        if (format === "table") {
            current.tableOptions = body.querySelector(".table-view")?.options() ?? current.tableOptions;
        }
        const editable = kind === "epub" || kind === "text" && await editableText(blob);
        if (stale()) {
            return;
        }
        view.hidden = !format;
        setView(format);
        theme.hidden = !(kind === "epub" || (format === "markdown" || format === "html") && viewShown(format));
        edit.hidden = !editable;
        edit.title = kind === "epub" ? "Edit the book's title, author and cover" : "Edit this file";
        edit.setAttribute("aria-label", edit.title);
        frame?.stop();
        frame = null;
        let shownAs;
        if (kind === "zip") {
            shownAs = zipListing(current.entries);
        } else if (kind === "video" || kind === "audio") {
            const { mediaStream } = await import("./media-stream.js");
            if (stale()) return;
            const abort = new AbortController();
            frame = { stop: () => abort.abort() };
            shownAs = await mediaStream(join(current.dir, current.name), current, abort.signal);
        } else if (kind === "pdf") {
            shownAs = pdfFrame(join(current.dir, current.name), current, { location, navigate: remember });
        } else if (kind === "epub") {
            shownAs = epubFrame(join(current.dir, current.name), current, { location, navigate: remember });
        } else if ((format === "markdown" || format === "html") && viewShown(format)) {
            try {
                shownAs = format === "html"
                    ? await markdownFrame("", current.dir, { format: "html", html: await blob.text(), fragment, location, open: follow, navigate: remember })
                    : await markdownFrame(join(current.dir, current.name), current.dir, { fragment, location, open: follow, navigate: remember });
            } catch (err) {
                // Its source, then, saying why.
                shownAs = el("div", { className: "fallback" },
                    el("p", { className: "hint", textContent: `Shown as written: ${current.name} can't be rendered (${err.message}).` }),
                    await render(kind, blob, url, current.name));
            }
        } else if (format && viewShown(format)) {
            shownAs = await structured(format, blob, url, current.name, current.tableOptions);
        } else {
            shownAs = await render(kind, blob, url, current.name);
        }
        if (stale()) {
            shownAs.stop?.();
            return;
        }
        if (shownAs.stop) {
            frame = shownAs;
        }
        body.replaceChildren(shownAs);
    };

    // follow opens what a link in the Markdown shown, href, points at, by a
    // path relative to it: a file previewed here, else downloaded.
    const follow = async (href, location) => {
        const [p, fragment = ""] = href.split("#");
        const path = p ? resolvePath(current.dir, p) : join(current.dir, current.name);
        if (path === null || path === "") {
            return;
        }
        if (!typeOf(path.split("/").pop())) {
            download(path);
            dialog.close();
            return;
        }
        remember(location);
        const slash = path.lastIndexOf("/");
        display(slash < 0 ? "" : path.slice(0, slash), path.slice(slash + 1), fragment);
    };
    let goingBack = false;
    back.addEventListener("click", async () => {
        if (goingBack || !trail.length) {
            return;
        }
        goingBack = true;
        try {
            if (!(await leaveEditing())) {
                return;
            }
            const to = trail.pop();
            back.hidden = !trail.length;
            if (current?.dir === to.dir && current?.name === to.name && frame?.restore) {
                frame.restore(to.location);
            } else {
                await display(to.dir, to.name, "", to.location);
            }
        } finally {
            goingBack = false;
        }
    });


    // Editing: the text in a box, and for Markdown, beside it as it's
    // rendered; Save writes it back over the file, unless the file has
    // changed since it was read (see unchangedSince in tabtopd).
    edit.addEventListener("click", async () => {
        if (current?.kind === "epub") {
            editBook();
            return;
        }
        if (!blob || editing) {
            return;
        }
        // A save finishing after another file is shown (its editor left
        // meanwhile) is that file's no more: only the file it was is told.
        const file = current;
        file.tableOptions = body.querySelector(".table-view")?.options() ?? file.tableOptions;
        // This editor owns the version of its blob. A save from an editor
        // left earlier may update file while this one's still editing old data.
        const editorFile = { ...file };
        drawing++;  // what's being drawn now isn't to be shown over the editor
        const start = formatOf(file.name) === "table" && viewShown("table") ? startTableEditing : startEditing;
        editing = await start({
            body, current: editorFile, blob, markdown: languageOf(file.name) === "markdown",
            saved(newBlob, reply) {
                editorFile.mtime = reply.mtime;
                editorFile.size = reply.size;
                file.mtime = reply.mtime;
                file.size = reply.size;
                if (current !== file) {
                    return;
                }
                URL.revokeObjectURL(url);
                blob = newBlob;
                url = URL.createObjectURL(blob);
            },
        });
        frame?.stop();
        frame = null;
        edit.hidden = view.hidden = saveGroup.hidden = prev.hidden = next.hidden = true;
        // Editing Markdown, it's rendered beside, in a frame.
        theme.hidden = languageOf(file.name) !== "markdown";
        store.disabled = editing.canSave?.() === false;
        store.hidden = done.hidden = false;
    });
    store.addEventListener("click", () => editing?.save());

    // editBook asks for the book's new title, author and cover, and saves
    // them, as the book was opened (or not, if it's changed since), then
    // shows it again.
    let editingBook = false;
    const editBook = async () => {
        // One at a time: a second click, while the first's cover comes, or
        // its dialog's open, does nothing.
        if (editingBook) {
            return;
        }
        editingBook = true;
        try {
            await editBookNow();
        } finally {
            editingBook = false;
        }
    };
    const editBookNow = async () => {
        const file = current;
        const path = join(file.dir, file.name);
        const expect = { if_mtime: file.mtime, if_size: file.size };
        const coverPath = file.book.cover ?? "";
        const coverType = coverPath ? (typeOf(coverPath.split("/").pop())?.type ?? "") : "";
        let coverURL = null;
        if (coverPath) {
            try {
                const t = await call({ type: "epub", path, item: coverPath, ...expect });
                coverURL = URL.createObjectURL(await collect(t, t.reply.size, () => {}, t.reply.mime));
            } catch {
                // Not shown, then.
            }
        }
        if (current !== file) {
            // Another file shown meanwhile: not this one's details over it.
            if (coverURL) {
                URL.revokeObjectURL(coverURL);
            }
            return;
        }
        const canMake = !coverPath || COVER_TYPES.includes(coverType);
        const got = await askBookDetails({ title: file.book.title ?? "", creator: file.book.creator ?? "", hasCover: !!coverPath, coverURL,
            coverNote: canMake ? "" : `Its cover is ${pictureName(coverType)}, and only JPEG, PNG and WebP covers can be replaced here.`,
            pick: () => pickPicture(file.dir) });
        if (coverURL) {
            URL.revokeObjectURL(coverURL);
        }
        const tidy = (v) => v.trim().split(/\s+/).filter(Boolean).join(" ");
        if (!got || tidy(got.title) === tidy(file.book.title ?? "") &&
            tidy(got.creator) === tidy(file.book.creator ?? "") && !got.picture) {
            return;
        }
        // Saved, if asked to, though another file's been shown since; said
        // where it's shown, or, if it isn't, in the transfers.
        const shownHere = current === file;
        const status = el("p", { className: "hint saving", textContent: "Saving the book…" });
        const row = shownHere ? null : statusRow(`${file.name}: saving its details…`);
        if (shownHere) {
            body.prepend(status);
        }
        try {
            const bytes = got.picture ? await coverBytes(got.picture, coverType || newCoverType(await pictureType(got.picture))) : null;
            const t = await call({ type: "epub-edit", path, ...expect, title: tidy(got.title), creator: tidy(got.creator),
                size: bytes?.byteLength ?? 0 });
            for (let at = 0; bytes && at < bytes.byteLength; at += MARKDOWN_PIECE) {
                t.sendData(bytes.subarray(at, at + MARKDOWN_PIECE));
            }
            const m = await t.next();
            t.close();
            const res = m?.text !== undefined ? JSON.parse(m.text) : null;
            if (!res?.book) {
                throw new Error(res?.error ?? t.closeReason ?? "the connection was lost");
            }
            // Its time and size, to read it by from now on: as told, or if
            // not told, as read again.
            let { size, mtime, book } = res;
            if (!Number.isSafeInteger(size) || typeof mtime !== "string") {
                const again = await call({ type: "epub", path });
                again.close();
                ({ size, mtime, book } = again.reply);
            }
            moveBookPlace(path, file.size, size);
            Object.assign(file, { size, mtime, book });
            if (res.warning) {
                const w = statusRow(`${file.name}: ${res.warning}`);
                w.set(`${file.name}: ${res.warning}`, true);
                w.finish();
            }
            if (row) {
                row.set(`${file.name}: its details saved`);
                row.finish();
            }
            if (current === file && !editing) {
                await draw(shown);
            }
        } catch (err) {
            status.className = "error saving";
            status.textContent = `The book wasn't changed: ${err.message}`;
            if (row) {
                row.set(`${file.name}: its details weren't saved: ${err.message}`, true);
                row.finish();
            }
        }
    };
    done.addEventListener("click", async () => {
        if (await leaveEditing()) {
            saveGroup.hidden = false;
            prev.hidden = next.hidden = current.dir !== dir || current.name !== files[index].name || files.length < 2;
            draw(shown);
        }
    });

    // Download: as the files page does, through the tunnel, whatever the
    // preview holds of it. Direct Download: straight over HTTPS.
    const downloadShown = async (how) => {
        const path = selectedPath;
        if (path !== null && (await leaveEditing())) {
            how(path);
        }
    };
    save.addEventListener("click", () => downloadShown(download));
    downloads.append(choice(iconSVG("download"), "Download, through the encrypted tunnel", "download-tunnel", () => downloadShown(download)));
    if (opts.direct) {
        downloads.append(choice(iconSVG("download-direct"), "Direct Download, straight over HTTPS, not through the encrypted tunnel", "download-direct",
            () => downloadShown(opts.direct)));
    }
    // A click elsewhere closes the menu.
    dialog.addEventListener("click", (e) => {
        if (!downloads.hidden && !saveGroup.contains(e.target)) {
            showDownloads(false);
        }
    });
    // Closing, by its button, Escape or the backdrop, asks first if there
    // are changes not saved.
    const closeAsking = async () => {
        if (await leaveEditing()) {
            dialog.close();
        }
    };
    close.addEventListener("click", closeAsking);
    dialog.addEventListener("cancel", (e) => {
        if (e.target !== dialog) return;
        if (editing) {
            e.preventDefault();
            closeAsking();
        }
    });
    dialog.addEventListener("keydown", (e) => {
        // Ctrl+F, over a PDF, finds in it, not in this page.
        const pdf = dialog.querySelector("iframe.pdf");
        if (pdf && (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "f") {
            e.preventDefault();
            pdf.focus();
            pdf.contentWindow?.postMessage({ type: "find" }, "*");
            return;
        }
        // (Not from what takes the arrows itself: a box, a list, a sound, or
        // a table or tree scrolled sideways.)
        if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !editing && !e.defaultPrevented &&
            !e.target.closest("video, audio, input, textarea, select, .table-scroll, .json-scroll, .table-filter-pop")) {
            e.preventDefault();
            if (current?.dir === dir && current?.name === files[index].name) {
                show(index + (e.key === "ArrowLeft" ? -1 : 1));
            }
        }
    });
    // A click on the backdrop, outside the box, closes it.
    dialog.addEventListener("click", (e) => {
        const r = dialog.getBoundingClientRect();
        if (e.target === dialog && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) {
            closeAsking();
        }
    });
    dialog.addEventListener("close", (e) => {
        if (e.target !== dialog) return;
        shown++;
        editing?.stop();
        editing = null;
        stop();
        dialog.remove();
    });
    document.body.append(dialog);
    dialog.showModal();
    close.focus();
    show(index);
}

// Archive paths are inert text, including traversal names and symlinks.
// Entry sizes stay decimal strings so ZIP64 values retain their precision.
function zipListing(entries) {
    const input = el("input", { type: "search", placeholder: "Filter by path", className: "zip-filter" });
    input.setAttribute("aria-label", "Filter ZIP contents");
    const summary = el("span", { className: "hint" });
    summary.setAttribute("role", "status");
    const rows = el("tbody");
    const table = el("table", { className: "zip-table" }, el("thead", {}, el("tr", {},
        ...["Path", "Type", "Size", "Packed", "Modified"].map((name) => el("th", { textContent: name })))), rows);
    const more = el("button", { type: "button", textContent: "Show more", hidden: true });
    let shown = 500;
    const bytes = (value) => BigInt(value).toLocaleString() + " B";
    const update = () => {
        const query = input.value.toLowerCase();
        const found = entries.filter((entry) => entry.name.toLowerCase().includes(query));
        rows.replaceChildren(...found.slice(0, shown).map((entry) => el("tr", {},
            el("td", { className: "name", textContent: entry.name }),
            el("td", { textContent: entry.kind + (entry.encrypted ? " · Encrypted" : "") }),
            el("td", { className: "num", textContent: entry.kind === "Folder" ? "—" : bytes(entry.size) }),
            el("td", { className: "num", textContent: entry.kind === "Folder" ? "—" : bytes(entry.packed) }),
            el("td", { textContent: entry.modified ? new Date(entry.modified).toLocaleString() : "—" }))));
        summary.textContent = `${entries.length.toLocaleString()} entries` +
            (query ? ` · ${found.length.toLocaleString()} matching` : "") +
            (found.length > shown ? ` · first ${shown.toLocaleString()} shown` : "");
        more.hidden = found.length <= shown;
    };
    input.addEventListener("input", () => { shown = 500; update(); });
    more.addEventListener("click", () => { shown += 500; update(); });
    update();
    return el("div", { className: "zip-listing" }, el("div", { className: "zip-tools" }, input, summary),
        el("div", { className: "zip-scroll" }, table, more));
}

// External destinations are validated again outside the sandbox.
export function previewWebURL(value) {
    if (typeof value !== "string" || value.length > 16384) return null;
    try {
        const url = new URL(value);
        return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
    } catch {
        return null;
    }
}

function previewLink(frame, href) {
    const url = previewWebURL(href);
    const owner = frame.closest("dialog") ?? document.body;
    if (!url || owner.querySelector("dialog.preview-link[open]")) return;
    const heading = el("p", { textContent: "Open external link?" });
    const address = el("p", { className: "link-url", textContent: url });
    const status = el("p", { className: "hint", role: "status" });
    const cancel = el("button", { type: "button", textContent: "Cancel" });
    const copy = el("button", { type: "button", textContent: "Copy URL" });
    const proceed = el("button", { type: "button", className: "primary", textContent: "Open in browser" });
    const dialog = el("dialog", { className: "preview-link" }, heading, address, status,
        el("div", { className: "buttons" }, cancel, copy, proceed));
    dialog.setAttribute("aria-label", "Open external link?");
    dialog.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
            e.preventDefault();
            dialog.close();
        }
    });
    dialog.addEventListener("cancel", (e) => {
        e.preventDefault();
        e.stopPropagation();
        dialog.close();
    });
    cancel.addEventListener("click", () => dialog.close());
    copy.addEventListener("click", async () => {
        try {
            await copyText(url);
            status.textContent = "URL copied";
        } catch {
            status.textContent = "Couldn't copy the URL. Select and copy the address above.";
        }
    });
    proceed.addEventListener("click", () => {
        window.open(url, "_blank", "noopener,noreferrer");
        dialog.close();
    });
    dialog.addEventListener("close", () => dialog.remove());
    owner.append(dialog);
    dialog.showModal();
    copy.focus();
}

// Keep only bounded, serializable reading positions from sandboxed previews.
export function previewLocation(kind, value) {
    if (!value || typeof value !== "object") return null;
    const finite = (n, lo, hi) => Number.isFinite(n) && n >= lo && n <= hi;
    if ((kind === "markdown" || kind === "html") && finite(value.top, 0, 1e9) && finite(value.left, -1e9, 1e9)) {
        return { kind, top: value.top, left: value.left };
    }
    if (kind === "epub" && typeof value.item === "string" && value.item.length > 0 && value.item.length < 1000 &&
        finite(value.fraction, 0, 1) && Number.isInteger(value.size) && finite(value.size, 0, 6)) {
        return { kind, item: value.item, fraction: value.fraction, size: value.size };
    }
    if (kind === "pdf" && Number.isSafeInteger(value.page) && finite(value.page, 1, 1e6) &&
        finite(value.offset, 0, 1) && finite(value.left, -1e9, 1e9) && finite(value.zoom, 0.25, 4) &&
        ["width", "page", "actual"].includes(value.mode)) {
        return { kind, page: value.page, offset: value.offset, left: value.left, zoom: value.zoom, mode: value.mode };
    }
    return null;
}

// resolvePath names a path within Downloads, or null when it escapes it.
export function resolvePath(dir, p) {
    let decoded;
    try {
        decoded = decodeURIComponent(p.split("?")[0]);
    } catch {
        return null;
    }
    if (decoded.startsWith("/")) {
        return null;
    }
    if (decoded === "") {
        return "";
    }
    const parts = dir ? dir.split("/") : [];
    for (const s of decoded.split("/")) {
        if (s === "" || s === ".") {
            continue;
        }
        if (s === "..") {
            if (!parts.length) {
                return null;
            }
            parts.pop();
        } else {
            parts.push(s);
        }
    }
    return parts.join("/");
}

// editableText reports whether blob is text that can be edited here: not
// too big, and UTF-8, which is what it's saved as.
async function editableText(blob) {
    if (blob.size > limits.text) {
        return false;
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.subarray(0, 8000).includes(0)) {
        return false;
    }
    try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return true;
    } catch {
        return false;
    }
}

// The pieces text being edited is sent to be rendered in: the server's
// chunk size (fileChunk in tabtopd).
const MARKDOWN_PIECE = 256 * 1024;

// How long typing pauses before Markdown being edited is rendered again.
const EDIT_RENDER_PAUSE = 600;

// startTableEditing uses the same Save/Done lifecycle and conflict checks
// as the text editor, with records kept in their original order.
async function startTableEditing({ body, current, blob, saved }) {
    const note = el("p", { className: "hint edit-status", textContent: "Editing cells. Ctrl S saves." });
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await blob.arrayBuffer());
    const table = tableView(text, { ...current.tableOptions, tab: /\.tsv$/i.test(current.name), editable: true,
        changed: () => { note.textContent = table.dirty() ? "Changed, not saved. Ctrl S saves." : "Saved."; } });
    const editor = el("div", { className: "table-editor" }, table, note);
    body.replaceChildren(editor);
    let saving = false;
    const save = async () => {
        if (saving || !table.canEdit()) {
            return;
        }
        const snapshot = table.snapshot();
        const file = new File([snapshot.text], current.name, { type: "text/plain" });
        if (file.size > limits.text) {
            note.textContent = "Too large to save from the table (the limit is 2 MB).";
            return;
        }
        saving = true;
        note.classList.remove("error");
        note.textContent = "Saving…";
        try {
            const reply = await uploadFile(file, () => {}, current.dir, new AbortController().signal, true,
                { expect: { mtime: current.mtime, size: current.size } });
            saved(new Blob([snapshot.text], { type: "text/plain" }), reply);
            table.markSaved(snapshot);
            note.textContent = table.dirty() ? "Saved; changed since. Ctrl S saves." : "Saved.";
        } catch (err) {
            note.classList.add("error");
            note.textContent = `Not saved: ${err.message}`;
        } finally {
            saving = false;
        }
    };
    editor.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
            e.preventDefault();
            save();
        }
    });
    return { dirty: () => table.dirty(), canSave: () => table.canEdit(), save, stop: () => table.stop() };
}

// startEditing puts an editor for the file current, held in blob, in
// body: a box with its text, and for Markdown, beside it as it's rendered,
// again as typing pauses. It keeps the file's line endings and byte order
// mark as they were. Saving (Save, or Ctrl S) writes it back through the
// tunnel, replacing the file, but only if it's still as it was read: else
// it says so, and the text stays. saved(blob, reply) is told of each save.
// It returns {dirty(), save(), stop()}.
async function startEditing({ body, current, blob, markdown, saved }) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    let text = new TextDecoder().decode(bytes);  // without the BOM
    const crlf = (text.match(/\r\n/g)?.length ?? 0) > (text.match(/(?<!\r)\n/g)?.length ?? 0);
    const box = el("textarea", { className: "editor", value: text, spellcheck: false, autocomplete: "off" });
    box.setAttribute("aria-label", `The text of ${current.name}`);
    let savedText = box.value;  // as the box has it: line endings made \n
    const note = el("p", { className: "hint edit-status", textContent: "Editing. Ctrl S saves." });
    const parts = [box];
    // JSON is checked as it's typed, and Format lays it out. Saving it
    // broken asks first, if it was JSON to start with (files with
    // comments, as some settings files have, never were).
    const json = formatOf(current.name) === "json";
    const lines = jsonLines(current.name);
    const jsonStatus = el("p", { className: "hint json-status", hidden: !json });
    const wasJSON = json && !checkJSON(text, lines);
    const checkNow = () => {
        const why = checkJSON(box.value, lines);
        jsonStatus.classList.toggle("error", !!why);
        jsonStatus.textContent = why ? `Not JSON: ${why}` : lines ? "Each line is JSON." : "It's JSON.";
        return why;
    };
    if (json) {
        checkNow();
    }
    const format = el("button", { type: "button", className: "format", textContent: "Format",
        title: "Lay the JSON out, a value to a line, indented", hidden: !json || lines });
    format.addEventListener("click", () => {
        let laid;
        try {
            laid = formatJSON(parseJSON(box.value)) + (box.value.endsWith("\n") ? "\n" : "");
        } catch (err) {
            if (!(err instanceof FormatTooBig)) {
                checkNow();
                return;
            }
            jsonStatus.classList.add("error");
            jsonStatus.textContent = `Not laid out: ${err.message}.`;
            return;
        }
        if (laid !== box.value) {
            box.select();
            // As typing would, so it can be undone.
            if (!document.execCommand?.("insertText", false, laid)) {
                box.value = laid;
            }
            box.dispatchEvent(new Event("input"));
        }
    });
    let preview = null;
    let renderTimer;
    // One render at a time, so one that's slow can't come after, and over,
    // one of newer text: asked for while one goes, another follows it, of
    // the text as it is then.
    let rendering = false;
    let renderAgain = false;
    const rerender = async () => {
        if (rendering) {
            renderAgain = true;
            return;
        }
        rendering = true;
        try {
            await renderOnce();
        } finally {
            rendering = false;
            if (renderAgain) {
                renderAgain = false;
                rerender();
            }
        }
    };
    const renderOnce = async () => {
        // The text goes after the request, as an upload's does: as JSON,
        // too much of it would be more than a request can be.
        const text = new TextEncoder().encode(box.value);
        if (text.length > limits.text) {
            note.textContent = "Too long to render as it's typed.";
            return;
        }
        let t;
        try {
            t = await call({ type: "markdown", size: text.length });
            for (let at = 0; at < text.length; at += MARKDOWN_PIECE) {
                t.sendData(text.subarray(at, at + MARKDOWN_PIECE));
            }
            const m = await t.next();
            const res = m?.text !== undefined ? JSON.parse(m.text) : null;
            if (!res?.html && res?.html !== "") {
                throw new Error(res?.error ?? t.closeReason ?? "the connection was lost");
            }
            preview?.update(res.html);
        } catch (err) {
            note.textContent = `Not rendered: ${err.message}`;
        } finally {
            t?.close();
        }
    };
    if (markdown) {
        preview = await markdownFrame("", current.dir, { html: "" });
        parts.push(preview);
        rerender();
    }
    const editor = el("div", { className: markdown ? "editing split" : "editing" },
        el("div", { className: "edit-bar" }, note, jsonStatus, format), el("div", { className: "panes" }, ...parts));
    body.replaceChildren(editor);
    box.focus();

    const dirty = () => box.value !== savedText;
    const show = () => {
        note.classList.remove("error");
        note.textContent = dirty() ? "Changed, not saved. Ctrl S saves." : "Saved.";
    };
    let checking;
    box.addEventListener("input", () => {
        show();
        if (json) {
            clearTimeout(checking);
            checking = setTimeout(checkNow, 300);
        }
        if (markdown) {
            clearTimeout(renderTimer);
            renderTimer = setTimeout(rerender, EDIT_RENDER_PAUSE);
        }
    });
    box.addEventListener("keydown", (e) => {
        if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
            // A tab, rather than moving on from the box.
            e.preventDefault();
            box.setRangeText("\t", box.selectionStart, box.selectionEnd, "end");
            box.dispatchEvent(new Event("input"));
        }
    });
    let saving = false;
    const save = async () => {
        if (saving) {
            return;
        }
        saving = true;
        const value = box.value;
        if (wasJSON) {
            clearTimeout(checking);
            const why = checkNow();
            if (why && !(await askYes(`${current.name} isn't JSON as it is now (${why}). Save it anyway?`, "Save anyway"))) {
                saving = false;
                return;
            }
        }
        let out = crlf ? value.replace(/\n/g, "\r\n") : value;
        const encoded = new TextEncoder().encode(out);
        const parts = bom ? [new Uint8Array([0xef, 0xbb, 0xbf]), encoded] : [encoded];
        const file = new File(parts, current.name, { type: "text/plain" });
        note.classList.remove("error");
        note.textContent = "Saving…";
        try {
            const reply = await uploadFile(file, () => {}, current.dir, new AbortController().signal, true,
                { expect: { mtime: current.mtime, size: current.size } });
            savedText = value;
            note.dataset.mtime = reply.mtime ?? "";
            saved(new Blob(parts, { type: "text/plain" }), reply);
            note.textContent = box.value === value ? "Saved." : "Saved; changed since. Ctrl S saves.";
        } catch (err) {
            note.classList.add("error");
            note.textContent = `Not saved: ${err.message}`;
        } finally {
            saving = false;
        }
    };
    const onKey = (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
            e.preventDefault();
            save();
        }
    };
    editor.addEventListener("keydown", onKey);
    return {
        dirty,
        save,
        stop() {
            clearTimeout(renderTimer);
            clearTimeout(checking);
            preview?.stop();
        },
    };
}

// render makes what shows blob, a file of kind at url.
async function render(kind, blob, url, name) {
    const unshown = (what) => el("p", { className: "error", textContent: `This browser can't show ${what}. Download it instead.` });
    if (kind === "image") {
        const img = el("img", { src: url, alt: name });
        img.addEventListener("error", () => img.replaceWith(unshown("this picture")));
        return img;
    }
    if (kind === "video" || kind === "audio") {
        const media = el(kind, { src: url, controls: true, playsInline: true });
        media.addEventListener("error", () => media.replaceWith(unshown(`this ${kind === "video" ? "video" : "sound"}`)));
        return media;
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!bytes.length) {
        return el("p", { className: "hint", textContent: "This file is empty." });
    }
    if (bytes.subarray(0, 8000).includes(0)) {
        return el("p", { className: "hint", textContent: "This file isn't text, so it can't be shown here. Download it instead." });
    }
    const text = new TextDecoder().decode(bytes);
    const coloured = await colour(text, languageOf(name));
    return coloured ? el("pre", { className: "coloured" }, coloured) : el("pre", { textContent: text });
}

// Whether previews fill the window, as last chosen in this browser.
const PREVIEW_WIDE = "tabtop.preview-wide";
function previewWide() {
    try {
        return localStorage.getItem(PREVIEW_WIDE) === "1";
    } catch {
        return false;
    }
}
function setPreviewWide(wide) {
    try {
        localStorage.setItem(PREVIEW_WIDE, wide ? "1" : "0");
    } catch {
        // Only for now, then.
    }
}

// The themes for what's shown in a frame (rendered Markdown, a book), in
// the order the button goes through them: as the system is, light, dark;
// as last chosen in this browser.
const THEMES = { "": [glyphs.themeAuto, "Light or dark as the system is"], light: [glyphs.themeLight, "Light"], dark: [glyphs.themeDark, "Dark"] };
const READING_THEME = "tabtop.reading-theme";
function readingTheme() {
    try {
        const t = localStorage.getItem(READING_THEME) ?? "";
        return Object.hasOwn(THEMES, t) ? t : "";
    } catch {
        return "";
    }
}
function setReadingTheme(t) {
    try {
        localStorage.setItem(READING_THEME, t);
    } catch {
        // Only for now, then.
    }
}

// The ways text files are shown other than as text, by format: whether
// they are is kept in this browser, under key, as shown or text (the
// values Markdown's has always had); and the view button's text and title
// for each way.
const VIEWS = {
    html: { key: "tabtop.html-view", shown: "rendered", text: "source",
        toText: [glyphs.source, "Source: the HTML as written"], toShown: [glyphs.markdown, "Rendered: the HTML as it reads"] },
    markdown: { key: "tabtop.markdown-view", shown: "rendered", text: "source",
        toText: [glyphs.source, "Source: the Markdown as written"], toShown: [glyphs.markdown, "Rendered: the Markdown as it reads"] },
    table: { key: "tabtop.table-view", shown: "table", text: "text",
        toText: [glyphs.source, "Raw: the file as it is, as text"], toShown: [glyphs.table, "Table: the file as a table"] },
    json: { key: "tabtop.json-view", shown: "tree", text: "text",
        toText: [glyphs.source, "Raw: the JSON as it is, as text"], toShown: [glyphs.json, "Tree: the JSON as a tree"] },
};

// formatOf is the format a text file named name has another view for:
// HTML, Markdown, table (CSV, TSV) or JSON (JSON, JSON Lines); or "".
function formatOf(name) {
    const ext = name.toLowerCase().split(".").pop();
    if (ext === "html" || ext === "htm") return "html";
    if (languageOf(name) === "markdown") {
        return "markdown";
    }
    return ext === "csv" || ext === "tsv" ? "table" : ext === "json" || ext === "jsonl" || ext === "ndjson" ? "json" : "";
}
const jsonLines = (name) => /\.(jsonl|ndjson)$/i.test(name);

function viewShown(format) {
    try {
        return localStorage.getItem(VIEWS[format].key) !== VIEWS[format].text;
    } catch {
        return true;
    }
}
function setViewShown(format, shown) {
    try {
        localStorage.setItem(VIEWS[format].key, shown ? VIEWS[format].shown : VIEWS[format].text);
    } catch {
        // Only for now, then.
    }
}

// structured shows blob, text named name, as a table (format table) or a
// tree (json); or, if it can't be, as text, saying why.
async function structured(format, blob, url, name, tableOptions) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!bytes.length || bytes.subarray(0, 8000).includes(0)) {
        return render("text", blob, url, name);
    }
    const text = new TextDecoder().decode(bytes);
    if (format === "table") {
        return tableView(text, { ...tableOptions, tab: /\.tsv$/i.test(name) });
    }
    const got = jsonView(text, { lines: jsonLines(name) });
    if (got.view) {
        return got.view;
    }
    return el("div", { className: "fallback" }, el("p", { className: "error", textContent: `Shown as text. ${got.error}` }),
        await render("text", blob, url, name));
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
async function markdownFrame(path, dir, opts = {}) {
    let html = opts.html ?? "";
    if (path) {
        const t = await call({ type: "markdown", path });
        t.close();
        html = t.reply.html;
    }
    const htmlMode = opts.format === "html";
    const frame = el("iframe", { className: htmlMode ? "html" : "markdown", title: htmlMode ? "HTML, rendered" : "Markdown, rendered" });
    frame.setAttribute("sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.src = new URL("md-frame.html", import.meta.url).href;
    let ready = false;
    let asked = 0;
    const pictures = new Map();  // by src, as asked: each fetched once, however often it's rendered
    const send = (fragment = "", location = null) => frame.contentWindow?.postMessage({ type: "render", html, fragment, location, format: htmlMode ? "html" : "markdown" }, "*");
    const answer = async (e) => {
        if (e.source !== frame.contentWindow || !e.data || typeof e.data !== "object") {
            return;
        }
        const m = e.data;
        if (m.type === "ready") {
            ready = true;
            frame.contentWindow?.postMessage({ type: "theme", theme: readingTheme() }, "*");
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
        } else if (m.type === "external") {
            previewLink(frame, m.href);
        } else if (m.type === "navigate") {
            opts.navigate?.(m.location);
        } else if (m.type === "rendered") {
            frame.dataset.rendered = JSON.stringify(m.report);
        }
    };
    window.addEventListener("message", answer);
    frame.stop = () => window.removeEventListener("message", answer);
    frame.restore = (location) => {
        opts.location = location;
        if (ready) frame.contentWindow?.postMessage({ type: "restore", location }, "*");
    };
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
function epubFrame(path, file, opts = {}) {
    let ready = false;
    const frame = el("iframe", { className: "epub", title: file.book.title || file.name });
    frame.setAttribute("sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.src = new URL("epub-frame.html", import.meta.url).href;
    const ask = (item) => call({ type: "epub", path, item, if_mtime: file.mtime, if_size: file.size });
    const reply = (m) => frame.contentWindow?.postMessage(m, "*", m.bytes ? [m.bytes] : []);
    const answer = async (e) => {
        if (e.source !== frame.contentWindow || !e.data || typeof e.data !== "object") {
            return;
        }
        const m = e.data;
        if (m.type === "ready") {
            ready = true;
            reply({ type: "theme", theme: readingTheme() });
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
        } else if (m.type === "external") {
            previewLink(frame, m.href);
        } else if (m.type === "navigate") {
            opts.navigate?.(m.location);
        } else if (m.type === "rendered") {
            frame.dataset.rendered = JSON.stringify(m.report);
        }
    };
    window.addEventListener("message", answer);
    frame.stop = () => window.removeEventListener("message", answer);
    frame.restore = (location) => {
        opts.location = location;
        if (ready) frame.contentWindow?.postMessage({ type: "restore", location }, "*");
    };
    return frame;
}

// pickPicture asks for a picture in Downloads, starting in the folder
// start, going into its folders and up, and resolves to it, fetched through
// the tunnel, as a File, or null if none is chosen.
function pickPicture(start) {
    return new Promise((resolve) => {
        const where = el("p", { className: "picker-where" });
        const list = el("ul", { className: "picker-list" });
        const status = el("p", { className: "hint picker-status" });
        status.setAttribute("aria-live", "polite");
        const cancel = el("button", { type: "button", textContent: "Cancel" });
        const dialog = el("dialog", { className: "picker" }, el("p", { textContent: "A picture in Downloads, for the cover" }), where, list, status,
            el("div", { className: "buttons" }, cancel));
        let chosen = null;
        let shownDir = null;
        cancel.addEventListener("click", () => dialog.close());
        dialog.addEventListener("close", () => {
            dialog.remove();
            resolve(chosen);
        });
        const entry = (text, className, onClick, note = "") => {
            const b = el("button", { type: "button", className, textContent: text });
            b.addEventListener("click", onClick);
            return el("li", {}, b, ...(note ? [el("span", { className: "hint", textContent: note })] : []));
        };
        const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
        const show = async (dir) => {
            shownDir = dir;
            where.textContent = ["Downloads", ...dir.split("/").filter(Boolean)].join(" / ");
            list.replaceChildren();
            status.textContent = "Loading…";
            let entries;
            try {
                const t = await call({ type: "list", path: dir });
                t.close();
                entries = t.reply.entries.filter((e) => !e.name.startsWith("."));
            } catch (err) {
                status.textContent = `It can't be listed: ${err.message}`;
                return;
            }
            if (shownDir !== dir) {
                return;
            }
            const byName = (a, b) => collator.compare(a.name, b.name);
            const folders = entries.filter((e) => e.dir).sort(byName);
            const pictures = entries.filter((e) => !e.dir && typeOf(e.name)?.kind === "image" && (e.bytes ?? 0) <= limits.image).sort(byName);
            list.replaceChildren(
                ...(dir ? [entry(`${glyphs.upFolder} Up`, "picker-up", () => show(dir.split("/").slice(0, -1).join("/")))] : []),
                ...folders.map((e) => entry(`${glyphs.folder} ${e.name}/`, "picker-folder", () => show(join(dir, e.name)))),
                ...pictures.map((e) => entry(e.name, "picker-picture", () => take(join(dir, e.name), e.name), e.size ?? "")));
            status.textContent = pictures.length ? "" : "No pictures here.";
            list.querySelector("button")?.focus();
        };
        const take = async (path, name) => {
            const type = typeOf(name).type;
            status.textContent = `${name}: fetching…`;
            try {
                const t = await call({ type: "file", path });
                const blob = await collect(t, t.reply.size, (n) => (status.textContent = `${name}: ${t.reply.size ? Math.floor(n * 100 / t.reply.size) : 100}%`), type);
                chosen = new File([blob], name, { type });
                dialog.close();
            } catch (err) {
                status.textContent = `${name} can't be fetched: ${err.message}`;
            }
        };
        document.body.append(dialog);
        dialog.showModal();
        show(start);
    });
}

// The types a cover can be replaced as: those a browser can make.
const COVER_TYPES = ["image/jpeg", "image/png", "image/webp"];
// The longest side a new cover is given, in pixels.
const COVER_SIDE = 3000;

// newCoverType is the type a book without a cover is given one as, for a
// picture of type: as it is, if it can be, else JPEG.
const newCoverType = (type) => (COVER_TYPES.includes(type) ? type : "image/jpeg");

// pictureName names the type of picture type is, as a cover's said to be.
function pictureName(type) {
    const name = { "image/svg+xml": "SVG", "image/gif": "GIF", "image/avif": "AVIF", "image/bmp": "BMP" }[type];
    return name ? `${name === "AVIF" ? "an" : "a"} ${name} picture` : "a picture of another kind";
}

// pictureType is the type of picture file is, by its first bytes (not its
// name, which may be wrong): JPEG, PNG or WebP, or "".
async function pictureType(file) {
    const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const text = (from, to) => String.fromCharCode(...b.subarray(from, to));
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
        return "image/jpeg";
    }
    if (text(1, 4) === "PNG" && b[0] === 0x89) {
        return "image/png";
    }
    return text(0, 4) === "RIFF" && text(8, 12) === "WEBP" ? "image/webp" : "";
}

// coverBytes is the picture file as a cover of type: as it is, if it's that
// type and not too big; else drawn again, as that type, at most COVER_SIDE
// on its longer side.
async function coverBytes(file, type) {
    let bitmap;
    try {
        bitmap = await createImageBitmap(file);
    } catch {
        throw new Error("that picture can't be read");
    }
    const scale = Math.min(1, COVER_SIDE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= 20e6 && await pictureType(file) === type) {
        bitmap.close();
        return new Uint8Array(await file.arrayBuffer());
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (type === "image/jpeg") {
        // JPEG has no see-through: white, not black, behind.
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.9));
    canvas.width = canvas.height = 0;
    // A browser that can't make the type makes PNG instead.
    if (blob?.type !== type) {
        throw new Error(`this browser can't make ${type.split("/")[1].toUpperCase()} pictures, as the cover must be`);
    }
    if (blob.size > 20e6) {
        throw new Error("the picture is too big, even made smaller");
    }
    return new Uint8Array(await blob.arrayBuffer());
}

// Where each book was read to, in this browser, by its path and size: the
// most recent BOOK_PLACES of them.
const BOOK_PLACES = 50;
const placeKey = (path, size) => `${path}\n${size}`;
function bookPlaces() {
    try {
        const all = JSON.parse(localStorage.getItem("tabtop.bookPlaces") ?? "{}");
        return all && typeof all === "object" ? all : {};
    } catch {
        return {};
    }
}
function bookPlace(path, size) {
    return bookPlaces()[placeKey(path, size)] ?? null;
}
// moveBookPlace keeps where the book at path was read to, as it changes
// size (its details changed).
function moveBookPlace(path, from, to) {
    const place = bookPlace(path, from);
    if (place) {
        setBookPlace(path, to, place);
    }
}
function setBookPlace(path, size, place) {
    const all = bookPlaces();
    delete all[placeKey(path, size)];
    all[placeKey(path, size)] = place;
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - BOOK_PLACES))) {
        delete all[k];
    }
    try {
        localStorage.setItem("tabtop.bookPlaces", JSON.stringify(all));
    } catch {
        // Not remembered, then.
    }
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

// How much of a PDF is fetched before it's shown: enough, usually, for
// pdf.js to find its way about.
const PDF_FIRST = 64 * 1024;
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
function pdfFrame(path, file, opts = {}) {
    let ready = false;
    const frame = el("iframe", { className: "pdf", title: "PDF" });
    frame.setAttribute("sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.src = new URL("pdf-frame.html", import.meta.url).href;
    let fetched = file.start.byteLength;
    frame.dataset.bytes = String(fetched);
    let going = 0;
    const queue = [];
    const part = async (begin, end) => {
        if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end > file.size || end <= begin || end - begin > PDF_PART) {
            return { error: "not a part of the file" };
        }
        while (going >= PDF_PARTS_AT_ONCE) {
            await new Promise((resolve) => queue.push(resolve));
        }
        going++;
        try {
            const t = await call({ type: "file", path, offset: begin, length: end - begin, if_mtime: file.mtime, if_size: file.size });
            const bytes = await (await collect(t, t.reply.length, () => {}, "application/pdf")).arrayBuffer();
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
    const answer = async (e) => {
        if (e.source !== frame.contentWindow || !e.data || typeof e.data !== "object") {
            return;
        }
        const m = e.data;
        if (m.type === "ready") {
            ready = true;
            const initial = file.start.slice(0);
            frame.contentWindow.postMessage({ type: "open", size: file.size, initial, location: opts.location }, "*", [initial]);
        } else if (m.type === "range") {
            const got = await part(m.begin, m.end);
            frame.contentWindow?.postMessage({ id: m.id, ...got }, "*", got.bytes ? [got.bytes] : []);
        } else if (m.type === "external") {
            previewLink(frame, m.href);
        } else if (m.type === "navigate") {
            opts.navigate?.(m.location);
        } else if (m.type === "rendered") {
            frame.dataset.rendered = JSON.stringify(m.report);
        }
    };
    window.addEventListener("message", answer);
    frame.stop = () => window.removeEventListener("message", answer);
    frame.restore = (location) => {
        opts.location = location;
        if (ready) frame.contentWindow?.postMessage({ type: "restore", location }, "*");
    };
    return frame;
}
