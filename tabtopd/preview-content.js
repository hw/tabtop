// Format-specific views for buffered files; their DOM is inert or constructed
// by the existing table/JSON renderers. The controller owns their lifetime.
import { el } from "./preview-dom.js";
import { glyphs, iconSVG } from "./glyphs.js";
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

// zipTree builds a folder tree from flat ZIP entries. Synthetic folder nodes
// fill path prefixes that have no directory entry of their own. Files keep
// archive order among themselves and sit above folders at each level, so
// top-level files stay early in the listing when a folder is expanded.
function zipTree(entries) {
    const folders = new Map();
    const roots = [];
    const ensureFolder = (folderPath) => {
        let node = folders.get(folderPath);
        if (node) {
            return node;
        }
        node = { path: folderPath, entry: null, children: [], folder: true };
        folders.set(folderPath, node);
        const slash = folderPath.lastIndexOf("/", folderPath.length - 2);
        const parent = slash >= 0 ? folderPath.slice(0, slash + 1) : "";
        if (parent) {
            ensureFolder(parent).children.push(node);
        } else {
            roots.push(node);
        }
        return node;
    };
    for (const entry of entries) {
        if (entry.kind === "Folder" || entry.name.endsWith("/")) {
            const path = entry.name.endsWith("/") ? entry.name : `${entry.name}/`;
            ensureFolder(path).entry = entry;
            continue;
        }
        const slash = entry.name.lastIndexOf("/");
        const file = { path: entry.name, entry, children: null, folder: false };
        if (slash >= 0) {
            ensureFolder(entry.name.slice(0, slash + 1)).children.push(file);
        } else {
            roots.push(file);
        }
    }
    const byKind = (list) => {
        const files = list.filter((n) => !n.folder);
        const dirs = list.filter((n) => n.folder);
        for (const dir of dirs) {
            byKind(dir.children);
        }
        list.splice(0, list.length, ...files, ...dirs);
    };
    byKind(roots);
    return roots;
}

// Archive paths are inert text, including traversal names and symlinks.
// Entry sizes stay decimal strings so ZIP64 values retain their precision.
// actions: { extract(ids), download(ids) }.
export function zipListing(entries, actions) {
    const extract = typeof actions === "function" ? actions : actions.extract;
    const download = typeof actions === "function" ? null : actions.download;
    const input = el("input", { type: "search", placeholder: "Filter by path", className: "zip-filter" });
    input.setAttribute("aria-label", "Filter ZIP contents");
    const summary = el("span", { className: "hint" });
    summary.setAttribute("role", "status");
    const rows = el("tbody");
    const all = el("input", { type: "checkbox", className: "zip-select-shown" });
    all.setAttribute("aria-label", "Select shown files");
    all.title = "Select or deselect eligible files in the rows shown";
    const headers = [
        el("th", { className: "sel" }, all),
        el("th", { className: "zip-path", textContent: "Path" }),
        el("th", { className: "zip-type", textContent: "Type" }),
        el("th", { className: "num zip-size", textContent: "Size" }),
        el("th", { className: "num zip-packed", textContent: "Packed" }),
        el("th", { className: "zip-modified", textContent: "Modified" }),
        el("th", { className: "act", textContent: "Actions" }),
    ];
    const table = el("table", { className: "zip-table" }, el("thead", {}, el("tr", {}, ...headers)), rows);
    const more = el("button", { type: "button", textContent: "Show more", hidden: true });
    const selected = new Set();
    const collapsed = new Set();
    let busy = false;
    const extractSelected = el("button", { type: "button", className: "zip-extract-selected", textContent: "Extract selected" });
    const downloadSelected = el("button", { type: "button", className: "zip-download-selected", textContent: "Download selected", hidden: !download });
    const clear = el("button", { type: "button", className: "zip-clear-selection", textContent: "Clear selection" });
    const selectionSummary = el("span", { className: "zip-selection-summary", role: "status" });
    const byIndex = new Map(entries.map((entry) => [entry.index, entry]));
    const tree = zipTree(entries);
    let visible = [];
    const sizeLabel = (size) => {
        for (const [unit, divisor] of [["GiB", 1n << 30n], ["MiB", 1n << 20n], ["KiB", 1n << 10n]]) {
            if (size >= divisor) return `${size / divisor}.${size * 10n / divisor % 10n} ${unit}`;
        }
        return `${size.toLocaleString()} B`;
    };
    const status = el("p", { className: "hint zip-extract-status", role: "status" });
    // Extractable files under node, including nested folders.
    const fileDescendants = (node) => {
        if (!node.folder) {
            return node.entry?.extractable ? [node.entry] : [];
        }
        return node.children.flatMap(fileDescendants);
    };
    const selection = () => {
        const eligible = visible.filter((row) => !row.folder && row.entry?.extractable).map((row) => row.entry);
        const checked = eligible.filter((entry) => selected.has(entry.index)).length;
        all.checked = eligible.length > 0 && checked === eligible.length;
        all.indeterminate = checked > 0 && checked < eligible.length;
        all.disabled = busy || !eligible.length;
        const total = [...selected].reduce((n, id) => n + BigInt(byIndex.get(id).size), 0n);
        const shownSelected = visible.filter((row) => !row.folder && selected.has(row.entry?.index)).length;
        const hidden = selected.size - shownSelected;
        const over = selected.size > 1000 || total > 512n * (1n << 20n);
        selectionSummary.textContent = `${selected.size} file${selected.size === 1 ? "" : "s"} selected · ${sizeLabel(total)}` +
            (hidden ? ` · ${hidden} not shown` : "") + (over ? " · Exceeds limit" : "");
        extractSelected.disabled = busy || !selected.size || over;
        downloadSelected.disabled = busy || !selected.size || over;
        clear.disabled = busy || !selected.size;
    };
    const runExtract = async (ids) => {
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
    const runDownload = async (ids) => {
        if (busy || !ids.length || !download) return;
        busy = true;
        status.className = "hint zip-extract-status";
        status.textContent = "Downloading…";
        update();
        try {
            await download(ids);
            status.textContent = ids.length === 1 ? "Downloaded." : `Downloaded ${ids.length} files.`;
        } catch (err) {
            status.className = "error zip-extract-status";
            status.textContent = err.message;
        } finally {
            busy = false;
            update();
        }
    };
    extractSelected.addEventListener("click", () => runExtract([...selected]));
    downloadSelected.addEventListener("click", () => runDownload([...selected]));
    all.addEventListener("change", () => {
        for (const row of visible) {
            if (row.folder || !row.entry?.extractable) continue;
            if (all.checked) selected.add(row.entry.index); else selected.delete(row.entry.index);
        }
        update();
    });
    clear.addEventListener("click", () => { selected.clear(); update(); });
    let shown = 500;
    const bytes = (value) => BigInt(value).toLocaleString() + " B";
    const labelOf = (node) => node.folder
        ? (node.entry?.name || node.path).replace(/\/$/, "").split("/").pop() + "/"
        : node.path.split("/").pop();
    // Flatten depth-first. Collapsed folders hide their children; a filter
    // keeps ancestors of matches open so hits stay reachable.
    const flatten = (query) => {
        const out = [];
        const rec = (nodes, depth) => {
            for (const node of nodes) {
                const name = (node.entry?.name || node.path).toLowerCase();
                if (!node.folder) {
                    if (!query || name.includes(query)) {
                        out.push({ ...node, depth });
                    }
                    continue;
                }
                const childOut = [];
                const walkKids = (list, d) => {
                    for (const child of list) {
                        const childName = (child.entry?.name || child.path).toLowerCase();
                        if (!child.folder) {
                            if (!query || childName.includes(query)) {
                                childOut.push({ ...child, depth: d });
                            }
                            continue;
                        }
                        const before = childOut.length;
                        walkKids(child.children, d + 1);
                        const hasKids = childOut.length > before;
                        if (!query || childName.includes(query) || hasKids) {
                            const kids = childOut.splice(before);
                            const open = (!collapsed.has(child.path) || (query && hasKids)) && child.children.length > 0;
                            childOut.push({ ...child, depth: d, open });
                            if (open) {
                                childOut.push(...kids);
                            }
                        }
                    }
                };
                walkKids(node.children, depth + 1);
                const hasKids = childOut.length > 0;
                if (!query || name.includes(query) || hasKids) {
                    const open = (!collapsed.has(node.path) || (query && hasKids)) && node.children.length > 0;
                    out.push({ ...node, depth, open });
                    if (open) {
                        out.push(...childOut);
                    }
                }
            }
        };
        rec(tree, 0);
        return out;
    };
    const update = () => {
        const query = input.value.toLowerCase();
        const found = flatten(query);
        visible = found.slice(0, shown);
        rows.replaceChildren(...visible.map((row) => {
            const entry = row.entry;
            const pathCell = el("td", { className: "name", title: row.entry?.name || row.path });
            pathCell.style.paddingLeft = `${0.75 + row.depth * 1.1}rem`;
            if (row.folder) {
                const toggle = el("button", { type: "button", className: "zip-folder-toggle",
                    textContent: row.open ? glyphs.minus : glyphs.plus,
                    disabled: !row.children?.length });
                toggle.setAttribute("aria-label", row.open ? `Collapse ${labelOf(row)}` : `Expand ${labelOf(row)}`);
                toggle.setAttribute("aria-expanded", String(!!row.open));
                toggle.addEventListener("click", () => {
                    if (collapsed.has(row.path)) collapsed.delete(row.path); else collapsed.add(row.path);
                    update();
                });
                pathCell.append(toggle, el("span", { className: "zip-folder-name", textContent: labelOf(row) }));
            } else {
                pathCell.append(el("span", { className: "zip-file-name", textContent: labelOf(row) }));
            }
            const files = row.folder ? fileDescendants(row) : (entry?.extractable ? [entry] : []);
            const ids = files.map((f) => f.index);
            const checked = ids.length > 0 && ids.every((id) => selected.has(id));
            const partial = !checked && ids.some((id) => selected.has(id));
            const checkbox = el("input", { type: "checkbox", checked, disabled: busy || !ids.length });
            checkbox.indeterminate = partial;
            checkbox.setAttribute("aria-label", row.folder ? `Select files in ${labelOf(row)}` : `Select ${entry.name}`);
            checkbox.addEventListener("change", () => {
                for (const id of ids) {
                    if (checkbox.checked) selected.add(id); else selected.delete(id);
                }
                update();
            });
            const sel = el("td", { className: "sel" }, checkbox);
            const kind = entry?.kind || (row.folder ? "Folder" : "File");
            const unavailable = entry?.unavailable || "";
            const canTake = !busy && !!entry?.extractable;
            const save = el("button", { type: "button", className: "zip-download-one glyph",
                disabled: !canTake || !download,
                title: entry?.extractable ? "Download through the encrypted tunnel, without extracting into Downloads"
                    : unavailable || "Unavailable" });
            save.setAttribute("aria-label", entry?.extractable ? `Download ${entry.name}` : (unavailable || "Download unavailable"));
            save.innerHTML = iconSVG("download");
            save.hidden = !download;
            save.addEventListener("click", () => entry?.extractable && runDownload([entry.index]));
            const take = el("button", { type: "button", className: "zip-extract-one glyph",
                disabled: !canTake,
                title: entry?.extractable ? "Extract into a new folder beside the ZIP" : unavailable || "Unavailable" });
            take.setAttribute("aria-label", entry?.extractable ? `Extract ${entry.name}` : (unavailable || "Extract unavailable"));
            take.innerHTML = iconSVG("extract");
            take.addEventListener("click", () => entry?.extractable && runExtract([entry.index]));
            const tr = el("tr", { className: row.folder ? "zip-folder" : "" },
                sel, pathCell,
                el("td", { className: "zip-type" }, kind, ...(unavailable ? [el("span", { className: "zip-unavailable", textContent: unavailable })] : [])),
                el("td", { className: "num zip-size", textContent: row.folder || !entry ? "—" : bytes(entry.size) }),
                el("td", { className: "num zip-packed", textContent: row.folder || !entry ? "—" : bytes(entry.packed) }),
                el("td", { className: "zip-modified", textContent: entry?.modified ? new Date(entry.modified).toLocaleString() : "—" }),
                el("td", { className: "act" }, save, take));
            tr.dataset.path = entry?.name || row.path;
            return tr;
        }));
        selection();
        const matchCount = found.length;
        summary.textContent = `${entries.length.toLocaleString()} entries` +
            (query ? ` · ${matchCount.toLocaleString()} matching` : "") +
            (matchCount > shown ? ` · first ${shown.toLocaleString()} shown` : "");
        more.hidden = matchCount <= shown;
    };
    input.addEventListener("input", () => { shown = 500; update(); });
    more.addEventListener("click", () => { shown += 500; update(); });
    update();
    return el("div", { className: "zip-listing" }, el("div", { className: "zip-tools" }, input, summary),
        el("div", { className: "zip-scroll" }, table, more),
        el("div", { className: "zip-action-bar" }, status, el("div", { className: "zip-selection-tools" }, selectionSummary, clear, downloadSelected, extractSelected)));
}

