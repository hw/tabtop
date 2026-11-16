// Searching the text of the files in a folder, and those in it (see
// search.go): what's found, a line at a time, opens the file at that line.
import { call } from "./requests.js";
import { el } from "./preview-dom.js";
import { iconSVG } from "./glyphs.js";

// openSearch shows the search of the folder dir, named label; open(path,
// line, match) shows the file at path at that line.
export function openSearch({ dir, label, open }) {
    const focus = document.activeElement;
    const close = el("button", { type: "button", className: "search-close close-glyph", title: "Close (Esc)", ariaLabel: "Close" });
    close.innerHTML = iconSVG("close-circle");
    const query = el("input", { type: "search", className: "search-query", placeholder: "Text to find", autocomplete: "off", spellcheck: false });
    query.setAttribute("aria-label", "Text to find");
    const matchCase = el("input", { type: "checkbox", className: "search-case" });
    const regex = el("input", { type: "checkbox", className: "search-regex" });
    const go = el("button", { type: "submit", className: "primary search-go", textContent: "Search" });
    const status = el("p", { className: "hint search-status", textContent: `Finds lines with the text in the text files in ${label} and the folders in it.` });
    status.setAttribute("role", "status");
    const results = el("div", { className: "search-results" });
    const form = el("form", { className: "search-form" }, query, go,
        el("label", {}, matchCase, " Match case"), el("label", {}, regex, " Regular expression"));
    const dialog = el("dialog", { className: "search" },
        el("div", { className: "search-head" }, el("strong", { textContent: `Search in ${label}` }), close), form, status, results);
    dialog.setAttribute("aria-label", `Search in ${label}`);
    let running = null;  // {stop()} while a search runs
    const done = () => {
        running?.stop();
        if (dialog.open) dialog.close();
        dialog.remove();
        focus?.focus?.();
    };
    close.addEventListener("click", done);
    dialog.addEventListener("close", done);
    // Escape stops a search going before it closes.
    dialog.addEventListener("cancel", (e) => {
        if (running) {
            e.preventDefault();
            running.stop();
        }
    });
    form.addEventListener("submit", (e) => {
        e.preventDefault();
        if (running) {
            running.stop();
            return;
        }
        if (query.value) search();
    });
    document.body.append(dialog);
    dialog.showModal();
    query.focus();

    async function search() {
        results.replaceChildren();
        status.classList.remove("error");
        status.textContent = "Searching…";
        go.textContent = "Stop";
        const abort = new AbortController();
        let t = null;
        running = { stop: () => { abort.abort(); try { t?.sendText(JSON.stringify({ cancel: true })); } catch { /* gone */ } } };
        const files = new Map();  // path: its list of lines
        let count = 0;
        const add = (m) => {
            let lines = files.get(m.path);
            if (!lines) {
                lines = el("ol", { className: "search-lines" });
                files.set(m.path, lines);
                results.append(el("section", { className: "search-file" }, el("h3", { textContent: m.path }), lines));
            }
            const item = el("button", { type: "button", className: "search-line", title: `Open ${m.path} at line ${m.line}` },
                el("span", { className: "search-number", textContent: String(m.line) }),
                el("span", { className: "search-text" }, m.before, el("mark", { textContent: m.match }), m.after));
            item.addEventListener("click", () => open(m.path, m.line, m.match));
            lines.append(el("li", {}, item));
            count++;
        };
        try {
            t = await call({ type: "search", path: dir, query: query.value, regex: regex.checked, match_case: matchCase.checked }, { signal: abort.signal });
            for (;;) {
                const m = await t.next();
                if (!m) throw new Error(abort.signal.aborted ? "cancelled" : "The connection was lost.");
                if (m.text === undefined) continue;
                const r = JSON.parse(m.text);
                if (r.error) throw new Error(r.error);
                if (r.found) {
                    r.found.forEach(add);
                    status.textContent = `Searching… ${count} line${count === 1 ? "" : "s"} found`;
                    continue;
                }
                const lines = `${r.matches} line${r.matches === 1 ? "" : "s"}`;
                status.textContent = (r.matches ? `${lines} found in ${files.size} file${files.size === 1 ? "" : "s"}` : "Nothing found")
                    + `, of ${r.files} text file${r.files === 1 ? "" : "s"} read` + (r.stopped ? `. It stopped there: ${r.stopped}.` : ".")
                    + (r.unreadable ? ` ${r.unreadable} folder${r.unreadable === 1 ? "" : "s"} couldn't be opened, so weren't searched.` : "");
                break;
            }
        } catch (err) {
            const cancelled = abort.signal.aborted || err.message === "cancelled";
            status.textContent = cancelled ? `Stopped, with ${count} line${count === 1 ? "" : "s"} found.` : `The search failed: ${err.message}`;
            status.classList.toggle("error", !cancelled);
        } finally {
            t?.close();
            running = null;
            go.textContent = "Search";
        }
    }
}

// revealLine selects, in the text shown in root (a <pre>), match on its
// line'th line, or the whole line if it isn't there, and scrolls to it.
export function revealLine(root, line, match) {
    const pre = root.querySelector("pre");
    if (!pre || !(line >= 1)) return false;
    const text = pre.textContent;
    let start = 0;
    for (let i = 1; i < line; i++) {
        const n = text.indexOf("\n", start);
        if (n < 0) return false;
        start = n + 1;
    }
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    let from = start, to = end;
    // A long match comes cut short, marked "…": found by what's left.
    const found = (m) => (m ? text.slice(start, end).indexOf(m) : -1);
    let at = found(match);
    if (at < 0 && match?.endsWith("…")) {
        match = match.slice(0, -1);
        at = found(match);
    }
    if (at >= 0) {
        from = start + at;
        to = from + match.length;
    }
    const range = document.createRange();
    const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    let seen = 0, started = false;
    for (let node; (node = walker.nextNode());) {
        const len = node.data.length;
        if (!started && from <= seen + len) {
            range.setStart(node, from - seen);
            started = true;
        }
        if (started && to <= seen + len) {
            range.setEnd(node, to - seen);
            break;
        }
        seen += len;
    }
    if (!started) return false;
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    // Into the middle of whatever scrolls it.
    let box = pre;
    while (box && box !== document.body && !(box.scrollHeight > box.clientHeight && getComputedStyle(box).overflowY !== "visible")) {
        box = box.parentElement;
    }
    if (box && box !== document.body) {
        const r = range.getBoundingClientRect(), b = box.getBoundingClientRect();
        box.scrollTop += r.top - b.top - box.clientHeight / 3;
        box.scrollLeft += Math.max(0, r.right - b.right + 40);
    }
    return true;
}
