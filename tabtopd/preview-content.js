// Format-specific views for buffered files; their DOM is inert or constructed
// by the existing table/JSON renderers. The controller owns their lifetime.
import { el } from "./preview-dom.js";
import { languageOf, jsonLines } from "./preview-model.js";
import { tableView } from "./table-view.js";
import { jsonView } from "./json-view.js";

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

// render makes what shows blob, a file of kind at url.
export async function render(kind, blob, url, name) {
    const unshown = (what) => el("p", { className: "error", textContent: `This browser can't show ${what}. Download it instead.` });
    if (kind === "image") {
        const img = el("img", { src: url, alt: name });
        img.addEventListener("error", () => img.replaceWith(unshown("this picture")));
        return img;
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

// structured shows blob, text named name, as a table (format table) or a
// tree (json); or, if it can't be, as text, saying why.
export async function structured(format, blob, url, name, tableOptions) {
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

// Archive paths are inert text, including traversal names and symlinks.
// Entry sizes stay decimal strings so ZIP64 values retain their precision.
export function zipListing(entries, extract) {
    const input = el("input", { type: "search", placeholder: "Filter by path", className: "zip-filter" });
    input.setAttribute("aria-label", "Filter ZIP contents");
    const summary = el("span", { className: "hint" });
    summary.setAttribute("role", "status");
    const rows = el("tbody");
    const all = el("input", { type: "checkbox", className: "zip-select-shown" });
    all.setAttribute("aria-label", "Select shown files");
    all.title = "Select or deselect eligible files in the rows shown";
    const headers = ["Path", "Type", "Size", "Packed", "Modified", "Actions"].map((name) => el("th", { textContent: name }));
    headers[0].prepend(all);
    const table = el("table", { className: "zip-table" }, el("thead", {}, el("tr", {}, ...headers)), rows);
    const more = el("button", { type: "button", textContent: "Show more", hidden: true });
    const selected = new Set();
    let busy = false;
    const selectedButton = el("button", { type: "button", className: "zip-extract-selected" });
    const clear = el("button", { type: "button", className: "zip-clear-selection", textContent: "Clear selection" });
    const selectionSummary = el("span", { className: "zip-selection-summary", role: "status" });
    const byIndex = new Map(entries.map(entry => [entry.index, entry]));
    let visible = [];
    const sizeLabel = (size) => {
        for (const [unit, divisor] of [["GiB", 1n << 30n], ["MiB", 1n << 20n], ["KiB", 1n << 10n]]) {
            if (size >= divisor) return `${size / divisor}.${size * 10n / divisor % 10n} ${unit}`;
        }
        return `${size.toLocaleString()} B`;
    };
    const status = el("p", { className: "hint zip-extract-status", role: "status" });
    const selection = () => {
        const eligible = visible.filter(entry => entry.extractable);
        const checked = eligible.filter(entry => selected.has(entry.index)).length;
        all.checked = eligible.length > 0 && checked === eligible.length;
        all.indeterminate = checked > 0 && checked < eligible.length;
        all.disabled = busy || !eligible.length;
        const total = [...selected].reduce((n, id) => n + BigInt(byIndex.get(id).size), 0n);
        const hidden = selected.size - visible.filter(entry => selected.has(entry.index)).length;
        const over = selected.size > 1000 || total > 512n * (1n << 20n);
        selectionSummary.textContent = `${selected.size} file${selected.size === 1 ? "" : "s"} selected · ${sizeLabel(total)}` +
            (hidden ? ` · ${hidden} not shown` : "") + (over ? " · Exceeds extraction limit" : "");
        selectedButton.textContent = "Extract selected";
        selectedButton.disabled = busy || !selected.size || over;
        clear.disabled = busy || !selected.size;
    };
    const run = async (ids) => {
        if (busy || !ids.length) return;
        busy = true;
        status.className = "hint zip-extract-status";
        status.textContent = "Extracting…";
        update();
        try {
            const result = await extract(ids);
            selected.clear();
            const open = el("button", { type: "button", className: "primary zip-open-folder", textContent: "Open folder" });
            open.addEventListener("click", () => {
                location.hash = "#/" + result.path.split("/").map(encodeURIComponent).join("/");
                status.closest("dialog")?.close();
            });
            status.replaceChildren(`Extracted ${result.count} file${result.count === 1 ? "" : "s"} into ${result.path}. `, open);
            if (result.warning) {
                status.className = "warning zip-extract-status";
                status.append(" " + result.warning);
            }
        } catch (err) {
            status.className = "error zip-extract-status";
            status.textContent = err.message;
        } finally {
            busy = false;
            update();
        }
    };
    selectedButton.addEventListener("click", () => run([...selected]));
    all.addEventListener("change", () => {
        for (const entry of visible.filter(entry => entry.extractable)) {
            if (all.checked) selected.add(entry.index); else selected.delete(entry.index);
        }
        update();
    });
    clear.addEventListener("click", () => { selected.clear(); update(); });
    let shown = 500;
    const bytes = (value) => BigInt(value).toLocaleString() + " B";
    const update = () => {
        const query = input.value.toLowerCase();
        const found = entries.filter((entry) => entry.name.toLowerCase().includes(query));
        visible = found.slice(0, shown);
        rows.replaceChildren(...visible.map((entry) => {
            const checkbox = el("input", { type: "checkbox", checked: selected.has(entry.index), disabled: busy || !entry.extractable });
            checkbox.setAttribute("aria-label", `Select ${entry.name}`);
            checkbox.addEventListener("change", () => {
                if (checkbox.checked) selected.add(entry.index); else selected.delete(entry.index);
                selection();
            });
            const take = el("button", { type: "button", className: "zip-extract-one", textContent: "Extract", disabled: busy || !entry.extractable,
                title: entry.extractable ? "Extract into a new folder beside the ZIP" : entry.unavailable || "Unavailable" });
            take.addEventListener("click", () => run([entry.index]));
            return el("tr", {},
                el("td", { className: "name" }, checkbox, entry.name),
                el("td", {}, entry.kind, ...(entry.unavailable ? [el("span", { className: "zip-unavailable", textContent: entry.unavailable })] : [])),
                el("td", { className: "num", textContent: entry.kind === "Folder" ? "—" : bytes(entry.size) }),
                el("td", { className: "num", textContent: entry.kind === "Folder" ? "—" : bytes(entry.packed) }),
                el("td", { textContent: entry.modified ? new Date(entry.modified).toLocaleString() : "—" }), el("td", {}, take));
        }));
        selection();
        summary.textContent = `${entries.length.toLocaleString()} entries` +
            (query ? ` · ${found.length.toLocaleString()} matching` : "") +
            (found.length > shown ? ` · first ${shown.toLocaleString()} shown` : "");
        more.hidden = found.length <= shown;
    };
    input.addEventListener("input", () => { shown = 500; update(); });
    more.addEventListener("click", () => { shown += 500; update(); });
    update();
    return el("div", { className: "zip-listing" }, el("div", { className: "zip-tools" }, input, summary),
        el("p", { className: "hint zip-extract-note", textContent: "Extract into a new folder beside the ZIP, keeping paths. Up to 1,000 files and 512 MiB per extraction." }),
        el("div", { className: "zip-scroll" }, table, more),
        el("div", { className: "zip-action-bar" }, status, el("div", { className: "zip-selection-tools" }, selectionSummary, clear, selectedButton)));
}

