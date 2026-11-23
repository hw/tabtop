// Read-only comparisons. File bytes use the normal authenticated tunnel;
// diff computation is isolated in a disposable worker, with bounded input.
import { call, collect } from "./requests.js";
import { el, maximizeButton } from "./preview-dom.js";
import { glyphs, iconSVG } from "./glyphs.js";
import { binaryNamed, languageOf, probablyDatabase, textModel, typeOf } from "./preview-model.js";
import { colour } from "./preview-content.js";
import { MAX_DIFF_BYTES, lineText } from "./text-diff.js";

const PAGE_ROWS = 500;
// textNamed reports whether name may well be a text file's: one shown as
// text, a model that's text (G-code, OBJ), or of a type that isn't known
// (notes.bak), unless it's a binary's or a database's name. What isn't
// text after all says so when compared.
const textNamed = (name) => {
    const type = typeOf(name);
    return type ? type.kind === "text" || textModel(name) : !binaryNamed(name) && !probablyDatabase(name);
};
// comparableText reports whether entries (a folder's, selected) are two
// text files, each small enough to compare.
export function comparableText(entries) {
    return entries.length === 2 && entries.every(entry => !entry.dir && textNamed(entry.name) && (entry.bytes ?? 0) <= MAX_DIFF_BYTES);
}
// loadDiffText reads the text file at path, or with request, what that
// asks for (a version of it, say), answered as a file request is.
export async function loadDiffText(path, signal, request = { type: "file", path, offset: 0, length: MAX_DIFF_BYTES + 1 }) {
    signal.throwIfAborted();
    const tunnel = await call(request, { signal });
    const cancel = () => tunnel.close();
    signal.addEventListener("abort", cancel, { once: true });
    try {
        signal.throwIfAborted();
        if (tunnel.reply.size > MAX_DIFF_BYTES) throw new Error(`${path}: each text file must be at most 2 MB.`);
        const blob = await collect(tunnel, tunnel.reply.length, () => {});
        signal.throwIfAborted();
        try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await blob.arrayBuffer()); }
        catch { throw new Error(`${path}: choose a UTF-8 text file.`); }
    } finally {
        signal.removeEventListener("abort", cancel);
        tunnel.close();
    }
}

function compute(left, right, signal) {
    return new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const worker = new Worker(new URL("./text-diff-worker.js", import.meta.url), { type: "module" });
        const finish = (error, result) => {
            clearTimeout(timer);
            signal.removeEventListener("abort", cancel);
            worker.terminate();
            if (error) reject(error); else resolve(result);
        };
        const cancel = () => finish(signal.reason);
        const timer = setTimeout(() => finish(new Error("Comparison took too long. Try smaller text files.")), 5000);
        signal.addEventListener("abort", cancel, { once: true });
        worker.onmessage = ({ data }) => finish(data.error ? new Error(data.error) : null, data.result);
        worker.onerror = (event) => { event.preventDefault(); finish(new Error("Couldn't start the comparison worker. Close and try again.")); };
        worker.postMessage({ left, right });
    });
}

// Split validated highlight.js spans at line boundaries, cloning their open
// ancestors, so multiline tokens keep their syntax colours on subsequent lines.
export function splitHighlight(code) {
    const lines = [document.createDocumentFragment()];
    const stack = [];
    let target = lines[0];
    const walk = (node) => {
        if (node.nodeType === 3) {
            const parts = node.textContent.split("\n");
            parts.forEach((part, i) => {
                if (i) {
                    target = document.createDocumentFragment(); lines.push(target);
                    for (const frame of stack) {
                        frame.copy = frame.source.cloneNode(false);
                        target.append(frame.copy); target = frame.copy;
                    }
                }
                target.append(document.createTextNode(part));
            });
        } else {
            const frame = { source: node, copy: node.cloneNode(false) };
            target.append(frame.copy); stack.push(frame); target = frame.copy;
            for (const child of node.childNodes) walk(child);
            stack.pop(); target = stack.at(-1)?.copy ?? lines.at(-1);
        }
    };
    for (const child of code.childNodes) walk(child);
    return lines;
}
async function highlightedLines(doc, name) {
    const text = doc.lines.map(lineText).join("\n");
    const code = await colour(text, languageOf(name));
    return code ? splitHighlight(code) : null;
}
function metadata(doc) {
    return `UTF-8${doc.bom ? " with BOM" : ""} · ${doc.endings} · ${doc.finalNewline ? "Final newline" : "No final newline"}`;
}

// Each side supplies {name, label, text} or {name, label, load(signal)}.
// Return immediately so a caller leaving its editor can cancel this dialog.
// Closed, it gives the focus back to what had it, or, if that's gone (a
// listing redrawn under it), to restoreFocus's choice.
export function openTextDiff({ left, right, restoreFocus = null }) {
    const focus = document.activeElement;
    const controller = new AbortController();
    const { signal } = controller;
    const closeButton = el("button", { type: "button", className: "diff-close close-glyph", title: "Close (Esc)", ariaLabel: "Close" });
    closeButton.innerHTML = iconSVG("close-circle");
    const summary = el("p", { className: "diff-summary", textContent: "Loading text files…" });
    summary.setAttribute("role", "status");
    const previous = el("button", { type: "button", className: "diff-previous glyph", textContent: glyphs.chevronUp, title: "Previous change", ariaLabel: "Previous change", disabled: true });
    const next = el("button", { type: "button", className: "diff-next glyph", textContent: glyphs.chevronDown, title: "Next change", ariaLabel: "Next change", disabled: true });
    const position = el("span", { className: "diff-position" });
    position.setAttribute("aria-live", "polite");
    const earlier = el("button", { type: "button", className: "diff-page-back", textContent: "Previous rows", disabled: true });
    const later = el("button", { type: "button", className: "diff-page-next", textContent: "Next rows", disabled: true });
    const range = el("span", { className: "diff-range" });
    const content = el("div", { className: "diff-scroll", tabIndex: 0 });
    content.setAttribute("aria-label", "Side-by-side text comparison");
    let unified = matchMedia("(max-width: 40rem)").matches;
    const layout = el("button", { type: "button", className: "diff-layout glyph" });
    const updateLayout = () => {
        layout.innerHTML = iconSVG(unified ? "syntax" : "compare");
        layout.title = unified ? "Show split view" : "Show unified view";
        layout.setAttribute("aria-label", layout.title);
        layout.setAttribute("aria-pressed", String(unified));
        content.setAttribute("aria-label", unified ? "Unified text comparison" : "Side-by-side text comparison");
    };
    layout.addEventListener("click", () => { unified = !unified; updateLayout(); if (model) draw(); });
    updateLayout();
    const dialog = el("dialog", { className: "text-diff", ariaLabel: "Compare text files" },
        el("div", { className: "diff-head" }, el("strong", { textContent: "Compare text files" }), closeButton),
        el("div", { className: "diff-tools" }, layout, previous, next, position), summary, content,
        el("div", { className: "diff-pages" }, earlier, range, later));
    let model, highlights, page = 0, active = -1, stopped = false;
    closeButton.before(maximizeButton(dialog, "diff-maximize"));
    const stop = () => {
        if (stopped) return;
        stopped = true;
        controller.abort();
        if (dialog.open) dialog.close();
        dialog.remove();
        if (focus?.isConnected) focus.focus({ preventScroll: true });
        else restoreFocus?.();
    };
    closeButton.addEventListener("click", stop);
    dialog.addEventListener("close", stop);
    dialog.addEventListener("cancel", (e) => { e.preventDefault(); stop(); });
    document.body.append(dialog);
    dialog.showModal();

    const draw = () => {
        const body = el("tbody");
        const start = page * PAGE_ROWS, end = Math.min(model.rows.length, start + PAGE_ROWS);
        const codeCell = (side, index, changed) => {
            const doc = side === 0 ? model.left : model.right;
            const num = el("td", { className: "diff-number", textContent: index < 0 ? "" : `${changed ? side === 0 ? "− " : "+ " : ""}${index + 1}` });
            num.setAttribute("aria-label", index < 0 ? "No corresponding line" : `${changed ? side === 0 ? "Removed" : "Added" : "Unchanged"} line ${index + 1}`);
            const cell = el("td", { className: `diff-code${index < 0 ? " diff-gap" : changed ? side === 0 ? " diff-removed" : " diff-added" : ""}` });
            if (index >= 0) {
                const code = el("code", { className: "hljs" });
                const coloured = highlights[side]?.[index];
                if (coloured) code.append(coloured.cloneNode(true)); else code.textContent = lineText(doc.lines[index]);
                // Keep empty lines visibly selectable without changing their text.
                cell.append(el("pre", {}, code));
            }
            return [num, cell];
        };
        for (let i = start; i < end; i++) {
            const row = model.rows[i];
            const tr = el("tr", { className: row.change === active && active >= 0 ? "diff-current" : "" });
            tr.dataset.row = i;
            if (!unified) {
                tr.append(...codeCell(0, row.a, row.change >= 0), ...codeCell(1, row.b, row.change >= 0));
                body.append(tr);
            } else if (row.change < 0) {
                tr.append(...codeCell(1, row.b, false)); body.append(tr);
            } else {
                for (const [side, index] of [[0, row.a], [1, row.b]]) {
                    if (index < 0) continue;
                    const line = el("tr", { className: tr.className }); line.dataset.row = i;
                    line.append(...codeCell(side, index, true)); body.append(line);
                }
            }
        }
        // The change shown: one rectangle round all its rows (on this page),
        // its first row's top and its last's bottom drawn, and the sides.
        const current = body.querySelectorAll("tr.diff-current");
        if (current.length) {
            current[0].classList.add("diff-current-first");
            current[current.length - 1].classList.add("diff-current-last");
        }
        const heading = (side, doc) => el("th", { colSpan: 2, scope: "colgroup" }, el("strong", { textContent: side.label ?? side.name }), el("small", { textContent: metadata(doc) }));
        const headings = unified ? [el("th", { colSpan: 2 }, el("strong", { textContent: `${left.label ?? left.name} → ${right.label ?? right.name}` }), el("small", { textContent: `${metadata(model.left)} → ${metadata(model.right)}` }))] : [heading(left, model.left), heading(right, model.right)];
        content.replaceChildren(el("table", { className: `diff-table${unified ? " unified" : ""}` }, el("colgroup", {}, ...(unified ? ["number", "code"] : ["number", "code", "number", "code"]).map(kind => el("col", { className: "diff-" + kind }))),
            el("thead", {}, el("tr", {}, ...headings)), body));
        if (!model.rows.length) content.append(el("p", { textContent: "Both files are empty." }));
        range.textContent = model.rows.length ? `Rows ${start + 1}–${end} of ${model.rows.length}` : "0 rows";
        earlier.disabled = page === 0;
        later.disabled = end === model.rows.length;
        previous.disabled = next.disabled = !model.changes.length;
        position.textContent = active < 0 ? `${model.changes.length} change blocks` : `Change ${active + 1} of ${model.changes.length}`;
    };
    const go = (direction) => {
        if (!model?.changes.length) return;
        active = active < 0 ? direction > 0 ? 0 : model.changes.length - 1 : (active + direction + model.changes.length) % model.changes.length;
        page = Math.floor(model.changes[active] / PAGE_ROWS);
        draw();
        content.querySelector(`[data-row="${model.changes[active]}"]`)?.scrollIntoView({ block: "center" });
    };
    previous.addEventListener("click", () => go(-1));
    next.addEventListener("click", () => go(1));
    earlier.addEventListener("click", () => { page--; draw(); content.scrollTop = 0; });
    later.addEventListener("click", () => { page++; draw(); content.scrollTop = 0; });
    void (async () => {
        try {
            const texts = await Promise.all([left, right].map(side => side.load ? side.load(signal) : side.text));
            signal.throwIfAborted();
            summary.textContent = "Comparing…";
            model = await compute(...texts, signal);
            highlights = await Promise.all([highlightedLines(model.left, left.name), highlightedLines(model.right, right.name)]);
            signal.throwIfAborted();
            summary.textContent = model.identical ? "Files are identical." : `${model.removed} ${model.removed === 1 ? "line" : "lines"} removed · ${model.added} ${model.added === 1 ? "line" : "lines"} added` +
                (model.left.bom !== model.right.bom ? " · UTF-8 byte order mark differs" : "") +
                (model.approximate ? " · Large changes grouped; matching lines inside these blocks may be included." : "");
            draw();
        } catch (err) {
            if (signal.aborted) return;
            controller.abort(); // Cancel the other file if only one side failed.
            summary.classList.add("error");
            summary.textContent = `Can't compare: ${err.message}`;
        }
    })();
    return { close: stop };
}
