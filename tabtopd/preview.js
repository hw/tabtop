// Preview dialog orchestration: selection, history, editing transitions and
// resource lifetimes. Format-specific rendering lives in the preview modules.
import { glyphs, iconSVG } from "./glyphs.js";
import { askYes } from "./ui.js";
import { previewView } from "./preview-view.js";
import { el, join } from "./preview-dom.js";
import { typeOf, languageOf, formatOf, previewLocation, resolvePath } from "./preview-model.js";
import { previewWide, setPreviewWide, THEMES, readingTheme, setReadingTheme, VIEWS, viewShown, setViewShown } from "./preview-settings.js";
import { loadPreview } from "./preview-loaders.js";
import { renderPreview } from "./preview-renderers.js";
import { editableText, startEditing, startTableEditing, editBookDetails } from "./preview-editor.js";
export { previewable, previewLocation, resolvePath, previewWebURL } from "./preview-model.js";

// preview shows files[index] of files, [{name, bytes}] in the folder dir,
// and steps through the rest with the arrow buttons and keys. Download
// downloads the one shown, through the encrypted tunnel, as the files page
// does: download(path). Its menu (▾) has that too, and, with
// opts.direct(path), Direct Download: straight over HTTPS, not through
// the tunnel. A link in a Markdown file to another file opens
// that one instead, with Back to return (see follow); text can be edited
// and saved (see startEditing).
export function preview(dir, files, index, download, opts = {}) {
    const opener = document.activeElement;
    let previewMode = opts.mode ?? null;
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
        b.append(el("span", { textContent: label }));
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
    const saveStatus = el("span", { className: "hint save-status", hidden: true, role: "status" });
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
    const setMode = async mode => {
        if (mode === "text" && current?.textAvailable === false) return;
        if (!current || typeOf(current.name) || mode === current.kind || mode === null && previewMode === null || !(await leaveEditing())) return;
        previewMode = mode;
        if (blob && ["text", "hex"].includes(current.kind) && ["text", "hex"].includes(mode) &&
                (mode !== "text" || blob.size >= Math.min(current.size, 10_000_000))) {
            // Both views use the same bytes; switching does not fetch the file again.
            current = { ...current, kind: mode, type: mode === "text" ? "text/plain" : "application/octet-stream" };
            await draw(shown);
        } else {
            display(current.dir, current.name);
        }
    };
    const modeToggle = button("", "Show binary view", "preview-mode-toggle glyph");
    modeToggle.addEventListener("click", () => {
        if (!current || typeOf(current.name)) return;
        setMode(current.kind === "hex" ? "text" : "hex");
    });
    const previewNotice = el("p", { className: "hint preview-limit", role: "status", hidden: true });
    const body = el("div", { className: "body" });
    const dialog = el("dialog", { className: "preview" },
        el("div", { className: "head", role: "toolbar", ariaLabel: "Preview actions" }, name, back, where,
            el("span", { className: "preview-navigation", role: "group", ariaLabel: "Preview navigation" }, prev, next),
            el("span", { className: "preview-edit-actions", role: "group", ariaLabel: "Editing" }, edit, saveStatus, store, done),
            el("span", { className: "preview-appearance", role: "group", ariaLabel: "Appearance" }, theme, view, modeToggle),
            saveGroup, widen, close), previewNotice, body);
    showWide();

    // What's shown: counted, so a file that arrives after the next was
    // asked for is dropped; its tunnel while it's coming; then it, and
    // the file it is, {dir, name, size, mtime}.
    let shown = 0;
    let loadingAbort = null;
    let blob = null;
    let url = null;
    let frame = null;
    let rendererAbort = null;
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
    const editObserver = new MutationObserver(() => {
        if (!editing) return;
        const text = body.querySelector(".edit-status")?.textContent ?? "";
        saveStatus.textContent = editing.saving?.() ? "Saving…" : text.startsWith("Not saved:") ? text : editing.dirty() ? "Unsaved changes" : "Saved";
        saveStatus.classList.toggle("error", !!body.querySelector(".edit-status.error"));
        store.disabled = editing.saving?.() || editing.canSave?.() === false;
    });
    const stop = () => {
        rendererAbort?.abort();
        rendererAbort = null;
        loadingAbort?.abort();
        loadingAbort = null;
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
        editObserver.disconnect();
        saveStatus.hidden = true;
        editing.stop();
        editing.syntaxToggle?.remove();
        editing.formatButton?.remove();
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
        // An override belongs to this file, not to the next file or followed link.
        if (typeOf(fname)) previewMode = null;
        else if (selectedPath !== null && selectedPath !== path) previewMode = "auto";
        selectedPath = path;
        name.textContent = d === dir ? fname : path;
        dialog.setAttribute("aria-label", fname);
        const following = d !== dir || fname !== files[index].name;
        back.hidden = !trail.length;
        where.textContent = !following && files.length > 1 ? `${index + 1} of ${files.length}` : "";
        prev.hidden = next.hidden = following || files.length < 2;
        prev.disabled = index === 0;
        next.disabled = index === files.length - 1;
        edit.hidden = view.hidden = theme.hidden = modeToggle.hidden = previewNotice.hidden = true;
        const status = el("p", { className: "hint", textContent: "Loading…", role: "status" });
        body.replaceChildren(status);
        try {
            loadingAbort = new AbortController();
            const loaded = await loadPreview(d, fname, { mode: previewMode, signal: loadingAbort.signal, progress: (n, total) => {
                if (me === shown) status.textContent = total ? `Loading… ${Math.floor(n * 100 / total)}% · ${n.toLocaleString()} of ${total.toLocaleString()} bytes` : "Loading…";
            } });
            if (me !== shown) return;
            current = loaded.file;
            blob = loaded.blob;
            if (blob) url = URL.createObjectURL(blob);
            await draw(me, fragment, location);
        } catch (err) {
            if (me === shown) {
                const retry = button("Retry preview", "Try loading this preview again", "retry-preview");
                retry.addEventListener("click", () => display(d, fname, fragment, location));
                const downloadButton = button("Download", "Download this file", "download-fallback");
                downloadButton.addEventListener("click", () => download(path));
                body.replaceChildren(el("div", { className: "preview-failure" },
                    el("p", { className: "error", textContent: `${fname} can't be shown: ${err.message}` }), retry, downloadButton));
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
        modeToggle.hidden = !!typeOf(current.name);
        const binary = kind === "hex";
        modeToggle.innerHTML = iconSVG(binary ? "preview" : "binary");
        modeToggle.title = binary && current.textAvailable === false ? "Text view unavailable for this binary file" : binary ? "Show text view" : "Show binary view";
        modeToggle.setAttribute("aria-label", modeToggle.title);
        modeToggle.setAttribute("aria-pressed", String(binary));
        modeToggle.disabled = binary && current.textAvailable === false;
        previewNotice.hidden = binary || !current.truncated;
        previewNotice.textContent = current.truncated ? `Showing the first 10 MB (${current.previewSize.toLocaleString()} bytes) of ${current.size.toLocaleString()} bytes.` : "";
        const format = kind === "text" ? formatOf(current.name) : "";
        if (format === "table") {
            current.tableOptions = body.querySelector(".table-view")?.options() ?? current.tableOptions;
        }
        const editable = !current.truncated && (kind === "epub" || kind === "text" && await editableText(blob));
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
        rendererAbort?.abort();
        rendererAbort = new AbortController();
        const shownAs = await renderPreview({ file: current, path: join(current.dir, current.name), blob, url,
            kind: kind === "text" && format && viewShown(format) ? format : kind,
            fragment, location, open: follow, navigate: remember, signal: rendererAbort.signal });
        const rendered = previewView(shownAs);
        if (stale()) {
            rendered.stop();
            return;
        }
        frame = rendered;
        body.replaceChildren(rendered.element);
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
        if (!blob || editing || current?.truncated) {
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
        if (editing.syntaxToggle) widen.before(editing.syntaxToggle);
        if (editing.formatButton) store.before(editing.formatButton);
        edit.hidden = view.hidden = saveGroup.hidden = prev.hidden = next.hidden = true;
        // Editing Markdown, it's rendered beside, in a frame.
        theme.hidden = languageOf(file.name) !== "markdown";
        store.disabled = editing.canSave?.() === false;
        store.hidden = done.hidden = false;
        saveStatus.hidden = false;
        saveStatus.textContent = "No unsaved changes";
        saveStatus.classList.remove("error");
        editObserver.observe(body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class"] });
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
            const file = current;
            await editBookDetails({ file, body, isCurrent: () => current === file,
                isEditing: () => !!editing, refresh: () => draw(shown) });
        } finally {
            editingBook = false;
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
        downloads.append(choice(iconSVG("download-direct"), "Direct download — over HTTPS instead of the encrypted tunnel", "download-direct",
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
            !e.target.closest("video, audio, input, textarea, select, .table-scroll, .json-scroll, .table-filter-pop, .hex-view, .kaitai-view")) {
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
        editObserver.disconnect();
        editing?.stop();
        editing = null;
        stop();
        dialog.remove();
        requestAnimationFrame(() => {
            if (opts.restoreFocus) opts.restoreFocus();
            else if (opener?.isConnected) opener.focus({ preventScroll: true });
        });
    });
    document.body.append(dialog);
    dialog.showModal();
    close.focus();
    show(index);
}
