// Text/table editors and EPUB metadata editing. Preview orchestration supplies
// the current-file checks; editors own their save snapshots and UI resources.
import { glyphs, iconSVG } from "./glyphs.js";
import { call, collect, uploadFile, saveBlob } from "./requests.js";
import { humanBytes } from "./file-format.js";
import { askBookDetails, askYes, askLine, statusRow } from "./ui.js";
import { checkJSON, formatJSON, FormatTooBig, parseJSON } from "./json-view.js";
import { tableView } from "./table-view.js";
import { el, join } from "./preview-dom.js";
import { limits, typeOf, formatOf, jsonLines, languageOf } from "./preview-model.js";
import { colour } from "./preview-content.js";
import { markdownFrame } from "./preview-frames.js";
import { moveBookPlace, editHighlight, setEditHighlight } from "./preview-settings.js";

// editableText reports whether blob is text that can be edited here: not
// too big, and UTF-8, which is what it's saved as.
export async function editableText(blob) {
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

// Keep the native textarea for selection, undo, accessibility and input methods.
// Only its paint is replaced; the highlighted copy never receives input.
function syntaxEditor(box, name) {
    const language = languageOf(name);
    const toggle = el("button", { type: "button", className: "syntax-toggle glyph", hidden: !language });
    toggle.innerHTML = iconSVG("syntax");
    toggle.setAttribute("aria-label", "Syntax highlighting");
    if (!language) return { element: box, toggle, stop() {} };
    let enabled = editHighlight();
    const showToggle = () => {
        toggle.setAttribute("aria-pressed", String(enabled));
        toggle.title = enabled ? "Turn off syntax highlighting" : "Turn on syntax highlighting";
    };
    showToggle();
    const paint = el("pre", { className: "editor-highlight" });
    paint.setAttribute("aria-hidden", "true");
    const element = el("div", { className: "syntax-editor" }, paint, box);
    let timer, generation = 0, composing = false;
    const sync = () => {
        paint.style.width = box.clientWidth + "px";
        paint.style.height = box.clientHeight + "px";
        paint.scrollTop = box.scrollTop;
        paint.scrollLeft = box.scrollLeft;
    };
    const refresh = () => {
        clearTimeout(timer);
        const version = ++generation;
        element.classList.remove("highlighted");
        if (composing || !enabled) return;
        timer = setTimeout(async () => {
            const value = box.value;
            // colour applies the preview's size cap and validates the markup.
            const code = await colour(value, language);
            if (generation !== version || box.value !== value || !code) return;
            // Preserve the final blank line in pre's layout.
            code.append(document.createTextNode("\n"));
            paint.replaceChildren(code);
            element.classList.add("highlighted");
            sync();
        }, 150);
    };
    const compose = () => { composing = true; refresh(); };
    const composed = () => { composing = false; refresh(); };
    toggle.addEventListener("click", () => {
        enabled = !enabled;
        setEditHighlight(enabled);
        showToggle();
        refresh();
    });
    box.addEventListener("input", refresh);
    box.addEventListener("scroll", sync);
    box.addEventListener("compositionstart", compose);
    box.addEventListener("compositionend", composed);
    const resize = new ResizeObserver(sync);
    resize.observe(box);
    refresh();
    return { element, toggle, stop() {
        ++generation;
        clearTimeout(timer);
        resize.disconnect();
        box.removeEventListener("input", refresh);
        box.removeEventListener("scroll", sync);
        box.removeEventListener("compositionstart", compose);
        box.removeEventListener("compositionend", composed);
    } };
}

// Cache logical line starts so moving the caret doesn't rescan large files.
function editorPosition(box) {
    const location = el("button", { type: "button", className: "hint editor-position", title: "Go to line (Ctrl G; Line:Column)" });
    location.setAttribute("aria-label", "Go to line and column");
    let text, starts;
    const update = () => {
        if (text !== box.value) {
            text = box.value;
            starts = [0];
            for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) starts.push(at + 1);
        }
        const offset = box.selectionDirection === "backward" ? box.selectionStart : box.selectionEnd;
        let low = 0, high = starts.length;
        while (low + 1 < high) {
            const mid = Math.floor((low + high) / 2);
            if (starts[mid] <= offset) low = mid;
            else high = mid;
        }
        const label = `${low + 1}:${offset - starts[low] + 1}`;
        if (location.textContent !== label) location.textContent = label;
    };
    const events = ["input", "select", "selectionchange", "keyup", "click", "focus"];
    for (const event of events) box.addEventListener(event, update);
    update();
    return { element: location, stop() {
        for (const event of events) box.removeEventListener(event, update);
        location.remove();
    } };
}

function recoveryDownload(name, snapshot) {
    const button = el("button", { type: "button", className: "download-changes", textContent: "Download my changes", hidden: true });
    button.addEventListener("click", () => saveBlob(snapshot(), name));
    return button;
}

// Position and reveal the caret, including when logical lines wrap.
function goToEditorLine(box, lineNumber, column = 1) {
    const text = box.value;
    let offset = 0;
    for (let line = 1; line < lineNumber; line++) {
        const next = text.indexOf("\n", offset);
        if (next < 0) { offset = text.length; break; }
        offset = next + 1;
    }
    const lineEnd = text.indexOf("\n", offset);
    offset = Math.min(offset + Math.max(0, column - 1), lineEnd < 0 ? text.length : lineEnd);
    box.focus({ preventScroll: true });
    box.setSelectionRange(offset, offset);
    const mirror = el("div");
    const style = getComputedStyle(box);
    for (const property of ["font", "lineHeight", "letterSpacing", "padding", "tabSize", "whiteSpace", "overflowWrap", "boxSizing"]) {
        mirror.style[property] = style[property];
    }
    Object.assign(mirror.style, { position: "fixed", top: "0", left: "0", visibility: "hidden", width: box.clientWidth + "px" });
    const caret = el("span", { textContent: "\u200b" });
    mirror.append(document.createTextNode(text.slice(0, offset)), caret);
    document.body.append(mirror);
    box.scrollTop = Math.max(0, caret.offsetTop - box.clientHeight / 2);
    mirror.remove();
    box.dispatchEvent(new Event("scroll"));
}

// Error messages stay inert text; only their reported source locations are
// buttons; jumping uses the same caret positioning as Go to line.
function editorMessage(target, message, box) {
    target.replaceChildren();
    let end = 0;
    for (const match of message.matchAll(/\bline (\d+)(?:, column (\d+))?/g)) {
        target.append(document.createTextNode(message.slice(end, match.index)));
        const jump = el("button", { type: "button", className: "editor-error-jump", textContent: match[0],
            title: `Go to ${match[0]}` });
        jump.addEventListener("click", () => {
            goToEditorLine(box, Number(match[1]), Number(match[2] ?? 1));
        });
        target.append(jump);
        end = match.index + match[0].length;
    }
    target.append(document.createTextNode(message.slice(end)));
}

// startTableEditing uses the same Save/Done lifecycle and conflict checks
// as the text editor, with records kept in their original order.
export async function startTableEditing({ body, current, blob, saved }) {
    const note = el("p", { className: "hint edit-status", hidden: true });
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await blob.arrayBuffer());
    const table = tableView(text, { ...current.tableOptions, tab: /\.tsv$/i.test(current.name), editable: true,
        changed: () => { note.hidden = true; note.textContent = table.dirty() ? "Changed, not saved." : "Saved."; } });
    const recovery = recoveryDownload(current.name, () => new Blob([table.snapshot().text], { type: "text/plain" }));
    const editor = el("div", { className: "table-editor" }, table, note, recovery);
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
            note.hidden = false;
            return;
        }
        saving = true;
        note.hidden = true;
        note.classList.remove("error");
        note.textContent = "Saving…";
        try {
            const reply = await uploadFile(file, () => {}, current.dir, new AbortController().signal, true,
                { expect: { mtime: current.mtime, size: current.size } });
            recovery.hidden = true;
            saved(new Blob([snapshot.text], { type: "text/plain" }), reply);
            table.markSaved(snapshot);
            note.textContent = table.dirty() ? "Saved; changed since." : "Saved.";
        } catch (err) {
            note.classList.add("error");
            note.textContent = `Not saved: ${err.message}`;
            recovery.hidden = false;
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
    return { saving: () => saving, dirty: () => table.dirty(), canSave: () => table.canEdit(), save, stop: () => table.stop() };
}

// startEditing puts an editor for the file current, held in blob, in
// body: a box with its text, and for Markdown, beside it as it's rendered,
// again as typing pauses. It keeps the file's line endings and byte order
// mark as they were. Saving (Save, or Ctrl S) writes it back through the
// tunnel, replacing the file, but only if it's still as it was read: else
// it says so, and the text stays. saved(blob, reply) is told of each save.
// It returns {dirty(), save(), stop()}.
export async function startEditing({ body, current, blob, markdown, saved }) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    let text = new TextDecoder().decode(bytes);  // without the BOM
    const crlf = (text.match(/\r\n/g)?.length ?? 0) > (text.match(/(?<!\r)\n/g)?.length ?? 0);
    const box = el("textarea", { className: "editor", value: text, spellcheck: false, autocomplete: "off" });
    box.setAttribute("aria-label", `The text of ${current.name}`);
    let savedText = box.value;  // as the box has it: line endings made \n
    const position = editorPosition(box);
    const note = el("p", { className: "hint edit-status", hidden: true });
    const syntax = syntaxEditor(box, current.name);
    const parts = [syntax.element];
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
        jsonStatus.hidden = !why;
        editorMessage(jsonStatus, why ? `Not JSON: ${why}` : lines ? "Each line is JSON." : "It's JSON.", box);
        return why;
    };
    if (json) {
        checkNow();
    }
    const format = el("button", { type: "button", className: "format", textContent: "Format",
        title: "Lay the JSON out, a value to a line, indented", hidden: !json || lines });
    // Chrome's insertText takes time growing with the square of the lines
    // it puts in: 1,500 lines take two seconds, and a 48,000-line file,
    // most of an hour, the page frozen meanwhile. So only a small result
    // goes in as typing would, undoable with the rest; a larger one is set
    // at once, and that Format alone undone with Ctrl+Z (and redone with
    // Ctrl+Shift+Z or Ctrl+Y) while the text is as it left it.
    const FORMAT_TYPED_LINES = 400;
    let formatUndo = null; // {before, after, start, end, undone}
    const linesOver = (text, max) => {
        for (let at = 0, n = 1; (at = text.indexOf("\n", at) + 1) > 0;) {
            if (++n > max) {
                return true;
            }
        }
        return false;
    };
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
            jsonStatus.hidden = false;
            jsonStatus.textContent = `Not laid out: ${err.message}.`;
            return;
        }
        if (laid !== box.value) {
            if (linesOver(laid, FORMAT_TYPED_LINES)) {
                formatUndo = { before: box.value, after: laid, start: box.selectionStart, end: box.selectionEnd, undone: false };
                box.value = laid;
                box.setSelectionRange(0, 0);
                box.scrollTop = 0;
            } else {
                formatUndo = null;
                box.select();
                // As typing would, so it can be undone.
                if (!document.execCommand?.("insertText", false, laid)) {
                    box.value = laid;
                }
            }
            box.dispatchEvent(new Event("input"));
        }
    });
    box.addEventListener("keydown", (e) => {
        if (!formatUndo || !(e.ctrlKey || e.metaKey) || e.altKey) {
            return;
        }
        const key = e.key.toLowerCase();
        const undo = key === "z" && !e.shiftKey;
        const redo = key === "z" && e.shiftKey || key === "y" && !e.shiftKey;
        const f = formatUndo;
        if (undo && !f.undone && box.value === f.after) {
            e.preventDefault();
            box.value = f.before;
            box.setSelectionRange(f.start, f.end);
            f.undone = true;
            box.dispatchEvent(new Event("input"));
        } else if (redo && f.undone && box.value === f.before) {
            e.preventDefault();
            box.value = f.after;
            box.setSelectionRange(0, 0);
            f.undone = false;
            box.dispatchEvent(new Event("input"));
        }
    });
    // Edited since: that Format can no longer be undone on its own.
    box.addEventListener("input", () => {
        if (formatUndo && box.value !== (formatUndo.undone ? formatUndo.before : formatUndo.after)) {
            formatUndo = null;
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
            note.hidden = false;
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
            editorMessage(note, `Not rendered: ${err.message}`, box);
            note.hidden = false;
        } finally {
            t?.close();
        }
    };
    if (markdown) {
        preview = await markdownFrame("", current.dir, { html: "" });
        parts.push(preview);
        rerender();
    }
    const recovery = recoveryDownload(current.name, () => {
        const text = crlf ? box.value.replace(/\n/g, "\r\n") : box.value;
        return new Blob([...(bom ? [new Uint8Array([0xef, 0xbb, 0xbf])] : []), text], { type: "text/plain" });
    });
    const editor = el("div", { className: markdown ? "editing split" : "editing" },
        el("div", { className: "edit-bar" }, note, jsonStatus, recovery), el("div", { className: "panes" }, ...parts));
    body.replaceChildren(editor);
    box.focus();

    const dirty = () => box.value !== savedText;
    const show = () => {
        note.hidden = true;
        note.classList.remove("error");
        note.textContent = dirty() ? "Changed, not saved." : "Saved.";
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
                show(); // Notify the toolbar observer after cancelling validation.
                return;
            }
        }
        let out = crlf ? value.replace(/\n/g, "\r\n") : value;
        const encoded = new TextEncoder().encode(out);
        const parts = bom ? [new Uint8Array([0xef, 0xbb, 0xbf]), encoded] : [encoded];
        const file = new File(parts, current.name, { type: "text/plain" });
        note.hidden = true;
        note.classList.remove("error");
        note.textContent = "Saving…";
        try {
            const reply = await uploadFile(file, () => {}, current.dir, new AbortController().signal, true,
                { expect: { mtime: current.mtime, size: current.size } });
            recovery.hidden = true;
            savedText = value;
            note.dataset.mtime = reply.mtime ?? "";
            saved(new Blob(parts, { type: "text/plain" }), reply);
            note.textContent = box.value === value ? "Saved." : "Saved; changed since.";
        } catch (err) {
            note.classList.add("error");
            note.textContent = `Not saved: ${err.message}`;
            recovery.hidden = false;
        } finally {
            saving = false;
        }
    };
    let askingLine = false, stopped = false;
    const goToLine = async () => {
        if (askingLine || stopped) return;
        askingLine = true;
        try {
            const offset = box.selectionDirection === "backward" ? box.selectionStart : box.selectionEnd;
            const prefix = box.value.slice(0, offset);
            const line = prefix.split("\n").length;
            const column = prefix.length - prefix.lastIndexOf("\n");
            const total = box.value.split("\n").length;
            const chosen = await askLine(`${line}:${column}`, total);
            if (!stopped) {
                if (chosen !== null) goToEditorLine(box, chosen.line, chosen.column);
                else box.focus({ preventScroll: true });
            }
        } finally {
            askingLine = false;
        }
    };
    position.element.addEventListener("click", goToLine);
    const onKey = (e) => {
        if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "g") {
            e.preventDefault();
            goToLine();
            return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
            e.preventDefault();
            save();
        }
    };
    editor.addEventListener("keydown", onKey);
    return {
        goToLine,
        cursorLocation: position.element,
        syntaxToggle: syntax.toggle,
        formatButton: format,
        saving: () => saving,
        dirty,
        save,
        stop() {
            stopped = true;
            position.stop();
            clearTimeout(renderTimer);
            clearTimeout(checking);
            syntax.stop();
            preview?.stop();
        },
    };
}

// pictureChooser is a picker's dialog: a heading, where it's looking
// (where), a list of entries, and beside it (below, on a narrow screen),
// once one is clicked, a preview of the picture, with Select (and Cancel)
// to take it. fetch(entry, progress)
// resolves to the picture's File; it resolves, once the dialog's closed, to
// what select(entry, file) made of the one selected, or null.
function pictureChooser(heading, fetch, select) {
    const where = el("p", { className: "picker-where" });
    const list = el("ul", { className: "picker-list" });
    const status = el("p", { className: "hint picker-status" });
    status.setAttribute("aria-live", "polite");
    const image = el("img", { className: "picker-image", alt: "", hidden: true });
    const empty = "Click a picture to preview it.";
    const caption = el("p", { className: "hint picker-caption", textContent: empty });
    // Always there, so the list beside it keeps its width.
    const preview = el("figure", { className: "picker-preview" }, image, caption);
    const unshow = () => {
        image.hidden = true;
        image.removeAttribute("src");
        caption.textContent = empty;
    };
    const cancel = el("button", { type: "button", textContent: "Cancel" });
    const choose = el("button", { type: "button", className: "primary picker-select", textContent: "Select", disabled: true });
    const dialog = el("dialog", { className: "picker" }, el("p", { textContent: heading }), where,
        el("div", { className: "picker-body" }, list, preview), status, el("div", { className: "buttons" }, cancel, choose));
    let resolve;
    const done = new Promise((r) => (resolve = r));
    let shown = null; // {entry, file, url}: the picture previewed
    let asked = 0; // which click's fetch is the one wanted
    let chosen = null;
    const forget = () => {
        if (shown) {
            URL.revokeObjectURL(shown.url);
            shown = null;
        }
        choose.disabled = true;
    };
    cancel.addEventListener("click", () => dialog.close());
    choose.addEventListener("click", () => {
        if (shown) {
            chosen = select(shown.entry, shown.file);
            dialog.close();
        }
    });
    dialog.addEventListener("close", () => {
        asked++;
        forget();
        dialog.remove();
        resolve(chosen);
    });
    // Clicked: fetched and shown, for Select; another clicked meanwhile,
    // that one's shown instead.
    const look = async (entry, name, button) => {
        const mine = ++asked;
        forget();
        for (const b of list.querySelectorAll("button.chosen")) {
            b.classList.remove("chosen");
            b.removeAttribute("aria-current");
        }
        button.classList.add("chosen");
        button.setAttribute("aria-current", "true");
        unshow();
        status.textContent = `${name}: fetching…`;
        try {
            const file = await fetch(entry, (text) => mine === asked && (status.textContent = `${name}: ${text}`));
            if (mine !== asked) {
                return;
            }
            const url = URL.createObjectURL(file);
            image.src = url;
            try {
                await image.decode();
            } catch {
                URL.revokeObjectURL(url);
                if (mine === asked) {
                    status.textContent = `${name} can't be shown as a picture.`;
                }
                return;
            }
            if (mine !== asked) {
                URL.revokeObjectURL(url);
                return;
            }
            shown = { entry, file, url };
            caption.textContent = `${name}, ${image.naturalWidth} × ${image.naturalHeight}`;
            image.hidden = false;
            status.textContent = "";
            choose.disabled = false;
        } catch (err) {
            if (mine === asked) {
                status.textContent = `${name} can't be fetched: ${err.message}`;
            }
        }
    };
    const entry = (text, className, onClick, note = "") => {
        const b = el("button", { type: "button", className, textContent: text });
        b.addEventListener("click", () => onClick(b));
        return el("li", {}, b, ...(note ? [el("span", { className: "hint", textContent: note })] : []));
    };
    // A picture entry: clicked, previewed; double-clicked, selected once
    // it's shown.
    const picture = (text, value, name, note = "") => {
        const li = entry(text, "picker-picture", (b) => look(value, name, b), note);
        li.querySelector("button").addEventListener("dblclick", async () => {
            for (let i = 0; i < 100 && !shown && dialog.open; i++) {
                await new Promise((r) => setTimeout(r, 50));
            }
            if (shown?.entry === value) {
                choose.click();
            }
        });
        return li;
    };
    const show = () => {
        document.body.append(dialog);
        dialog.showModal();
    };
    // A new list: nothing previewed from the last.
    const listed = (items) => {
        asked++;
        forget();
        unshow();
        list.replaceChildren(...items);
    };
    return { dialog, where, list, status, cancel, entry, picture, listed, show, done };
}

// pickPicture asks for a picture in Downloads, starting in the folder
// start, going into its folders and up, and resolves to it, fetched through
// the tunnel, as a File, or null if none is selected.
function pickPicture(start) {
    const p = pictureChooser("A picture in Downloads, for the cover", async (path, progress) => {
        const name = path.split("/").pop();
        const type = typeOf(name).type;
        const t = await call({ type: "file", path });
        const blob = await collect(t, t.reply.size, (n) => progress(`${t.reply.size ? Math.floor(n * 100 / t.reply.size) : 100}%`), type);
        return new File([blob], name, { type });
    }, (path, file) => file);
    let shownDir = null;
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    const show = async (dir) => {
        shownDir = dir;
        p.where.textContent = ["Downloads", ...dir.split("/").filter(Boolean)].join(" / ");
        p.listed([]);
        p.status.textContent = "Loading…";
        let entries;
        try {
            const t = await call({ type: "list", path: dir });
            t.close();
            entries = t.reply.entries.filter((e) => !e.name.startsWith("."));
        } catch (err) {
            p.status.textContent = `It can't be listed: ${err.message}`;
            return;
        }
        if (shownDir !== dir) {
            return;
        }
        const byName = (a, b) => collator.compare(a.name, b.name);
        const folders = entries.filter((e) => e.dir).sort(byName);
        const pictures = entries.filter((e) => !e.dir && typeOf(e.name)?.kind === "image" && (e.bytes ?? 0) <= limits.image).sort(byName);
        p.listed([
            ...(dir ? [p.entry(`${glyphs.upFolder} Up`, "picker-up", () => show(dir.split("/").slice(0, -1).join("/")))] : []),
            ...folders.map((e) => p.entry(`${glyphs.folder} ${e.name}/`, "picker-folder", () => show(join(dir, e.name)))),
            ...pictures.map((e) => p.picture(e.name, join(dir, e.name), e.name, e.size ?? ""))]);
        p.status.textContent = pictures.length ? "" : "No pictures here.";
        p.list.querySelector("button")?.focus();
    };
    p.show();
    show(start);
    return p.done;
}

// pickEpubPicture asks for a picture already in the book at path (opened as
// file), listed from its pictures, and resolves to {item, file}: its path
// in the book, and its bytes, to show it; or null if none is selected.
function pickEpubPicture(file) {
    const path = join(file.dir, file.name);
    const p = pictureChooser("A picture in the book, for the cover", async (item, progress) => {
        const name = item.split("/").pop();
        const type = typeOf(name)?.type ?? "";
        const t = await call({ type: "epub", path, item, if_mtime: file.mtime, if_size: file.size });
        const blob = await collect(t, t.reply.size, (n) => progress(`${t.reply.size ? Math.floor(n * 100 / t.reply.size) : 100}%`), t.reply.mime || type);
        return new File([blob], name, { type: t.reply.mime || type });
    }, (item, picture) => ({ item, file: picture }));
    p.where.textContent = file.name;
    const pictures = Array.isArray(file.book?.pictures) ? file.book.pictures : [];
    p.listed(pictures.map((item) => p.picture(item, item, item.split("/").pop())));
    p.status.textContent = pictures.length ? "" : "No pictures in the book.";
    p.show();
    (p.list.querySelector("button") ?? p.cancel).focus();
    return p.done;
}

// The longest side a new cover is given, in pixels.
const COVER_SIDE = 3000;

// coverType is the type a picture from outside the book is added to it as:
// JPEG or PNG (images/cover.jpg or .png; see epub_edit.go). A JPEG or PNG
// stays as it is; a photo of another kind (WebP, AVIF, BMP) is made a
// JPEG, and a drawing (GIF, SVG), which may be see-through, a PNG.
async function coverType(file) {
    const sniffed = await pictureType(file);
    if (sniffed === "image/jpeg" || sniffed === "image/png") {
        return sniffed;
    }
    return ["image/gif", "image/svg+xml"].includes(file.type) ? "image/png" : "image/jpeg";
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


// saveBookEdit sends an epub-edit for path with the given fields, updates
// file from the reply, and refreshes the preview when still shown.
async function saveBookEdit({ file, body, isCurrent, isEditing, refresh, title, creator, bytes = null, coverItem = "",
    removeItems = [], regenerateTOC = false, busy }) {
    const path = join(file.dir, file.name);
    const expect = { if_mtime: file.mtime, if_size: file.size };
    const shownHere = isCurrent();
    const status = el("p", { className: "hint saving", textContent: busy });
    const row = shownHere ? null : statusRow(`${file.name}: ${busy}`);
    if (shownHere) {
        body.prepend(status);
    }
    try {
        const t = await call({ type: "epub-edit", path, ...expect, title, creator,
            size: bytes?.byteLength ?? 0, cover_item: coverItem || undefined, remove_items: removeItems.length ? removeItems : undefined,
            regenerate_toc: regenerateTOC || undefined });
        for (let at = 0; bytes && at < bytes.byteLength; at += MARKDOWN_PIECE) {
            t.sendData(bytes.subarray(at, at + MARKDOWN_PIECE));
        }
        const m = await t.next();
        t.close();
        const res = m?.text !== undefined ? JSON.parse(m.text) : null;
        if (!res?.book) {
            throw new Error(res?.error ?? t.closeReason ?? "the connection was lost");
        }
        let { size, mtime, book } = res;
        if (!Number.isSafeInteger(size) || typeof mtime !== "string") {
            const again = await call({ type: "epub", path });
            again.close();
            ({ size, mtime, book } = again.reply);
        }
        moveBookPlace(path, file.size, size);
        const before = file.size;
        Object.assign(file, { size, mtime, book });
        if (removeItems.length) {
            // (Smaller, unless a new cover added more than went.)
            const said = `${file.name}: ${removeItems.length} picture${removeItems.length === 1 ? "" : "s"} removed` +
                (before > size ? `; ${humanBytes(before - size)} smaller` : "");
            const done = statusRow(said);
            done.set(said);
            done.finish();
        }
        if (res.warning) {
            const w = statusRow(`${file.name}: ${res.warning}`);
            w.set(`${file.name}: ${res.warning}`, true);
            w.finish();
        }
        if (row) {
            row.set(`${file.name}: saved`);
            row.finish();
        }
        if (isCurrent() && !isEditing()) {
            await refresh();
        }
    } catch (err) {
        status.className = "error saving";
        status.textContent = `The book wasn't changed: ${err.message}`;
        if (row) {
            row.set(`${file.name}: wasn't saved: ${err.message}`, true);
            row.finish();
        }
    }
}

export async function editBookDetails({ file, body, isCurrent, isEditing, refresh }) {
    const path = join(file.dir, file.name);
    const expect = { if_mtime: file.mtime, if_size: file.size };
    const coverPath = file.book.cover ?? "";
    let coverURL = null;
    if (coverPath) {
        try {
            const t = await call({ type: "epub", path, item: coverPath, ...expect });
            coverURL = URL.createObjectURL(await collect(t, t.reply.size, () => {}, t.reply.mime));
        } catch {
            // Not shown, then.
        }
    }
    if (!isCurrent()) {
        // Another file shown meanwhile: not this one's details over it.
        if (coverURL) {
            URL.revokeObjectURL(coverURL);
        }
        return;
    }
    const tidy = (v) => v.trim().split(/\s+/).filter(Boolean).join(" ");
    // What uses each picture, for removing those nothing does: asked now,
    // known when it's known.
    const uses = call({ type: "epub", path, uses: true, ...expect }).then((t) => {
        t.close();
        return t.reply.pictures;
    }).catch(() => null);
    const thumb = async (item, signal) => {
        const t = await call({ type: "epub", path, item, ...expect }, { signal });
        const stop = () => t.close();
        signal?.addEventListener("abort", stop, { once: true });
        try {
            const blob = await collect(t, t.reply.size, () => {}, t.reply.mime);
            signal?.throwIfAborted();
            return blob;
        } finally {
            signal?.removeEventListener("abort", stop);
            t.close();
        }
    };
    const got = await askBookDetails({ title: file.book.title ?? "", creator: file.book.creator ?? "", hasCover: !!coverPath, coverURL,
        uses, thumb, size: humanBytes,
        pick: () => pickPicture(file.dir), pickEpub: () => pickEpubPicture(file), hasTOC: (file.book.toc?.length ?? 0) > 0 });
    if (coverURL) {
        URL.revokeObjectURL(coverURL);
    }
    if (!got) {
        return;
    }
    if (got.rebuildTOC) {
        await saveBookEdit({ file, body, isCurrent, isEditing, refresh,
            title: tidy(file.book.title ?? ""), creator: tidy(file.book.creator ?? ""),
            regenerateTOC: true, busy: "Rebuilding the book's contents…" });
        return;
    }
    // The book's own cover, chosen from its pictures: no change.
    const coverItem = got.coverItem && got.coverItem !== coverPath ? got.coverItem : "";
    if (tidy(got.title) === tidy(file.book.title ?? "") &&
        tidy(got.creator) === tidy(file.book.creator ?? "") && !got.picture && !coverItem && !got.removeItems.length) {
        return;
    }
    // Saved, if asked to, though another file's been shown since; said
    // where it's shown, or, if it isn't, in the transfers.
    let bytes = null;
    if (got.picture) {
        try {
            bytes = await coverBytes(got.picture, await coverType(got.picture));
        } catch (err) {
            const w = statusRow(`${file.name}: the cover wasn't changed: ${err.message}`);
            w.set(`${file.name}: the cover wasn't changed: ${err.message}`, true);
            w.finish();
            return;
        }
    }
    await saveBookEdit({ file, body, isCurrent, isEditing, refresh,
        title: tidy(got.title), creator: tidy(got.creator), bytes, coverItem,
        removeItems: got.removeItems, busy: "Saving the book…" });
}
