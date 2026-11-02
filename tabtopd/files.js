// The files page, served by tabtopd (see tunnel.go). It lists ~/Downloads
// and fetches files through the encrypted tunnel; the folder shown is the
// path after "#". Files download (see download.js), never shown as a page
// on this site; pictures, video, sound and text open in a preview instead,
// where they're small enough (see preview.js). A folder, or several files
// and folders picked with their checkboxes, download as one zip. Files and
// folders dropped or pasted on the page are uploaded into the folder shown,
// as are those picked with its buttons (see drop.js, uploadFile and
// makeFolder), and each file and folder can be renamed, moved into another
// folder (from its menu, or dragged onto the folder), and deleted. The
// list sorts by any column (see sortEntries), and can be used from the
// keyboard (see listKeys). While the page is in view, the list updates
// itself as the folder changes (see watchChanges), keeping what's typed in
// the filter box, ticked and focused. Opened again, the page goes back to
// the folder it last showed, where it was scrolled to (see Places). Below,
// it lists the live sessions and recent logins (see showSessions). If the
// server can't be reached, it says so and tries again (see reconnect.js).

import { FolderModel } from "./folder-model.js";
import { createTimeFormatter } from "./file-format.js";
import { createSessionView } from "./sessions-view.js";
import { deleteFiles, dropUploads } from "./drop.js";
import { askFolder, askName, rowMenu, statusRow } from "./ui.js";
import { iconSVG, nameTab, navBar } from "./nav.js";
import { call, folderInfo, makeFolder, shellPath, uploadFile } from "./requests.js";
import { fetchFile, fetchZip, humanBytes } from "./download.js";
import { preview, previewable } from "./preview.js";
import { reconnect, reconnected } from "./reconnect.js";
import { warnExpiry } from "./expiry.js";

// The page draws into its own element, so the login form and summary
// (see tunnel.js), added to the body, outlive a redraw.
// Above it, links to the desktop and the terminal, Security and sessions,
// and Log out (see nav.js), which stay as the page is redrawn.
const timeFormatter = createTimeFormatter();
const { setTimeZone, friendlyTime, exactTime } = timeFormatter;
const page = document.createElement("main");
const nav = navBar("files", { logOutIcon: true });
document.body.replaceChildren(nav, page);
nameTab("files");

// The sessions and recent logins show in place of a folder, at this
// address, opened with the button by Log out, which goes back to the
// folder last shown (see showSecurity).
const SECURITY = "#sessions";
const onSecurity = () => location.hash === SECURITY;
let lastDir = "";
const SECURITY_TITLE = "Security and sessions";
const security = el("button", { type: "button", className: "security", title: SECURITY_TITLE });
security.setAttribute("aria-label", SECURITY_TITLE);
security.innerHTML = iconSVG("security");
security.addEventListener("click", () => {
    location.hash = onSecurity() ? dirHash(lastDir) : SECURITY;
});
nav.querySelector(":scope > button").before(security);
const { checkSecurity, showSessions } = createSessionView({ security, refresh: () => show(), formatTime: timeFormatter.shortTime });

function el(tag, props = {}, ...children) {
    const e = Object.assign(document.createElement(tag), props);
    e.append(...children);
    return e;
}

// currentDir is the folder shown, or, while the sessions are, the one
// shown last, which uploads dropped then go into.
function currentDir() {
    if (onSecurity()) {
        return lastDir;
    }
    const p = decodeURIComponent(location.hash.replace(/^#\/?/, ""));
    return p.replace(/^\/+|\/+$/g, "");
}

const join = (dir, name) => (dir ? `${dir}/${name}` : name);

function button(className, textContent, onClick) {
    const b = el("button", { type: "button", className, textContent });
    b.addEventListener("click", onClick);
    return b;
}

function dirHash(dir) {
    return "#/" + dir.split("/").filter(Boolean).map(encodeURIComponent).join("/") + (dir ? "/" : "");
}

// Counts calls to show, so one whose listing arrives after a later one's
// draws nothing: moving quickly between folders ends on the last.
const folder = new FolderModel();

// The folder the page shows, once one is.


// show draws the folder named after the "#". It resolves to false if the
// server couldn't be reached, having started trying again, else true.
// With refresh, it's the folder shown, listed again because it changed,
// and the sessions below aren't.
async function show({ refresh = false } = {}) {
    security.setAttribute("aria-pressed", String(onSecurity()));
    if (onSecurity()) {
        showSecurity();
        return true;
    }
    const me = folder.begin();
    let dir, t;
    try {
        try {
            dir = currentDir();
        } catch {
            throw new Error("This folder's address is malformed.");  // "#/bad%"
        }
        t = await call({ type: "list", path: dir });
    } catch (err) {
        if (!folder.current(me)) {
            return true;
        }
        if (err.lost) {
            // The folder already shown stays, as it was last seen.
            if (dir !== folder.dir) {
                folder.dir = null;
                page.replaceChildren(breadcrumbs(dir ?? ""), el("p", { className: "error", textContent: err.message }));
            }
            reconnect("Can't reach the server.", () => show());
            return false;
        }
        if (restoring) {
            // The folder last shown is gone: start at the top instead.
            restoring = false;
            history.replaceState(null, "", "#/");
            return show();
        }
        stopChanges();
        folder.dir = null;
        page.replaceChildren(el("h1", { className: "crumbs", textContent: "~/Downloads" }), el("p", { className: "error", textContent: err.message }),
            el("p", {}, el("a", { href: "#/", textContent: "Back to the top" })));
        return true;
    }
    t.close();
    if (!folder.current(me)) {
        return true;
    }
    restoring = false;
    // The same folder drawn again keeps what's typed, ticked and focused.
    const kept = dir === folder.dir ? keepState() : null;
    const arrived = dir !== folder.dir;
    lastDir = dir;
    reconnected();
    folder.load(me, dir, t.reply.entries, kept);
    return renderFolder({ dir, reply: t.reply, kept, arrived, refresh });
}

// Rendering consumes model state; requests and stale-response policy stay in show.
function renderFolder({ dir, reply, kept, arrived, refresh }) {
    document.title = "Downloads /" + (dir ? dir + "/" : "");

    if (!refresh) {
        checkSecurity();
    }
    // Checked entries, by name, and the bar that offers what to do with
    // them, shown while there are any.
    const entries = reply.entries;
    setTimeZone(reply.tz || undefined);
    const selected = folder.selected;
    const count = el("span");
    const selection = el("div", { className: "selection", hidden: true }, count,
        button("zip", "Download as .zip", () => fetchZip(dir, [...selected.keys()])),
        button("move", "Move to…", () => askMove(dir, [...selected.keys()])),
        button("delete", "Delete", () => deleteFiles([...selected.values()].map((e) => deletion(dir, e)), show)),
        button("", "Clear selection", () => {
            selected.clear();
            drawRows();
        }));
    // The filter box narrows the list to names with what's typed in them;
    // "Select all" then picks those shown.
    let visible = entries;
    const filter = el("input", { type: "search", className: "filter", placeholder: "Filter this folder  ( / )", autocomplete: "off",
        spellcheck: false, value: folder.filter });
    filter.setAttribute("aria-label", "Filter this folder");
    const matches = el("span", { className: "hint" });
    filter.addEventListener("input", () => {
        folder.filter = filter.value;
        drawRows();
    });
    const all = el("input", { type: "checkbox", title: "Select all shown" });
    const updateSelection = () => {
        const picked = visible.filter((e) => selected.has(e.name)).length;
        selection.hidden = !selected.size;
        count.textContent = `${selected.size} selected` + (picked < selected.size ? ` (${selected.size - picked} not shown)` : "");
        all.checked = picked > 0 && picked === visible.length;
        all.indeterminate = picked > 0 && picked < visible.length;
    };
    all.addEventListener("change", () => {
        folder.selectVisible(all.checked);
        drawRows();
    });

    // The column headers sort the list: clicking one sorts by it, and
    // clicking it again turns the order round.
    const head = el("tr");
    const tbody = el("tbody");
    const sortButton = (key, text) => {
        const th = el("th", { className: key === "name" ? "" : key === "size" ? "num size" : "num mod" },
            button("sort", text, () => {
                folder.sort = { key, desc: folder.sort.key === key ? !folder.sort.desc : key !== "name" };
                saveSort();
                drawRows();
            }));
        th.dataset.key = key;
        return th;
    };
    head.append(el("th", { className: "sel" }, all), sortButton("name", "Name"), sortButton("size", "Size"),
        sortButton("time", "Modified"), el("th", { className: "act" }));

    const drawRows = () => {
        for (const th of head.querySelectorAll("th[data-key]")) {
            const on = th.dataset.key === folder.sort.key;
            th.setAttribute("aria-sort", on ? (folder.sort.desc ? "descending" : "ascending") : "none");
            th.querySelector("button").dataset.arrow = on ? (folder.sort.desc ? "▼" : "▲") : "";
        }
        // Focus in the list stays on the same row as it's redrawn.
        const focused = document.activeElement?.closest?.("tbody tr")?.dataset.name;
        const rows = [];
        if (dir) {
            const up = dir.split("/").slice(0, -1).join("/");
            const tr = el("tr", {}, el("td", { className: "sel" }), el("td", { className: "name" }, el("a", { href: dirHash(up), textContent: "../" })),
                el("td", { className: "size" }), el("td", { className: "mod" }), el("td"));
            tr.dataset.name = "..";
            moveTarget(tr, dir, up);
            rows.push(tr);
        }
        const q = folder.filter.trim();
        visible = folder.visible;
        matches.textContent = q ? `${visible.length} of ${entries.length} shown` : "";
        const sorted = folder.sorted;
        // Previewing one steps through the rest shown that can be.
        const previews = sorted.filter((e) => !e.dir && previewable(e.name, e.bytes ?? 0));
        const open = (e) => preview(dir, previews, previews.indexOf(e), fetchFile);
        for (const e of sorted) {
            const path = join(dir, e.name);
            const canPreview = previews.includes(e);
            const link = el("a", { href: e.dir ? dirHash(path) : "#", textContent: e.name + (e.dir ? "/" : "") });
            if (!e.dir) {
                link.addEventListener("click", (ev) => {
                    ev.preventDefault();
                    canPreview ? open(e) : fetchFile(path);
                });
            }
            const box = el("input", { type: "checkbox", title: `Select ${e.name}`, checked: selected.has(e.name) });
            box.addEventListener("change", () => {
                folder.select(e.name, box.checked);
                updateSelection();
            });
            const menu = rowMenu(`Actions for ${e.name}`, [
                ...(canPreview ? [["preview", "Preview", () => open(e)]] : []),
                ...(e.dir ? [["zip", "Download as .zip", () => fetchZip(dir, [e.name])]] : [["download", "Download", () => fetchFile(path)]]),
                ["rename", "Rename…", () => rename(dir, e)],
                ["move", "Move to…", () => askMove(dir, [e.name])],
                ["copy", "Copy path", () => copyPath(path)],
                ["delete", "Delete…", () => deleteFiles([deletion(dir, e)], show)],
            ]);
            const tr = el("tr", { draggable: true }, el("td", { className: "sel" }, box), el("td", { className: "name" }, link),
                el("td", { className: "num size", textContent: e.size ?? "", title: e.dir ? "" : `${(e.bytes ?? 0).toLocaleString()} bytes` }),
                el("td", { className: "num mod", textContent: e.time ? friendlyTime(e.time) : e.modified,
                    title: e.time ? exactTime(e.time) : "" }),
                el("td", { className: "act" }, menu));
            tr.dataset.name = e.name;
            // Dragged onto a folder, a row moves there, with the rest
            // ticked if it's one of them.
            tr.addEventListener("dragstart", (ev) => {
                const names = selected.has(e.name) ? [...selected.keys()] : [e.name];
                ev.dataTransfer.setData(MOVE_TYPE, JSON.stringify({ dir, names }));
                ev.dataTransfer.effectAllowed = "move";
            });
            if (e.dir) {
                moveTarget(tr, dir, path);
            }
            rows.push(tr);
        }
        if (!entries.length) {
            rows.push(el("tr", {}, el("td", { colSpan: 5, textContent: "No files yet." })));
        } else if (!visible.length) {
            rows.push(el("tr", {}, el("td", { colSpan: 5, textContent: `Nothing here has “${filter.value.trim()}” in its name.` })));
        }
        tbody.replaceChildren(...rows);
        updateSelection();
        const again = focused && [...tbody.rows].find((tr) => tr.dataset.name === focused);
        again?.querySelector("td.name a")?.focus();
    };
    drawRows();

    const newFolder = button("", "New folder…", async () => {
        const name = await askName("The new folder's name:", "Make folder");
        if (name === null) {
            return;
        }
        const row = statusRow(`${name}/: making`);
        try {
            const got = await makeFolder(dir, name);
            row.set(got === name ? `${name}/: made` : `${name}/: made as ${got}/, since the name is taken`);
        } catch (err) {
            row.set(`${name}/: not made: ${err.message}`, true);
        }
        row.finish();
        await show();
    });
    const crumbs = breadcrumbs(dir);
    for (const a of crumbs.querySelectorAll("a")) {
        moveTarget(a, dir, a.dataset.dir);
    }
    page.replaceChildren(
        crumbs,
        ...(entries.length ? [el("div", { className: "find" }, filter, matches)] : []),
        selection,
        el("table", { className: "file-table" }, el("thead", {}, head), tbody),
        ...(reply.truncated ? [el("p", { className: "error", textContent: `This folder has more than ${reply.max} entries, ` +
            `so only ${reply.max} of them are shown, chosen in no particular order.` })] : []),
        el("p", { className: "upload" }, uploadButton(), newFolder,
            el("span", { className: "hint", textContent: "Or drop files or folders on this page. They go into this folder, end-to-end encrypted." })),
        ...(reply.total ? [diskSpace(reply.free, reply.total)] : []));
    if (arrived) {
        scrollTo(0, scrolls.get(dir) ?? 0);
    }
    if (kept?.filterFocus && filter.isConnected) {
        filter.focus();
        filter.setSelectionRange(...kept.filterFocus);
    } else if (kept?.focused) {
        [...tbody.rows].find((tr) => tr.dataset.name === kept.focused)?.querySelector(kept.focusedBox ? "td.sel input" : "td.name a")
            ?.focus({ preventScroll: true });
    }
    // Arriving in a folder from the keyboard, it goes on in the list.
    if (keyboardArrived) {
        keyboardArrived = false;
        tbody.querySelector("td.name a")?.focus();
    }
    watchChanges(dir);
    return true;
}

// keepState is what the folder shown has typed in its filter box, ticked,
// and focused, to keep when it's drawn again.
function keepState() {
    const active = document.activeElement;
    const filter = page.querySelector("input.filter");
    return {
        filter: filter?.value ?? "",
        filterFocus: active && active === filter ? [filter.selectionStart, filter.selectionEnd] : null,
        selected: folder.snapshot().selected,
        focused: page.contains(active) ? active.closest("tbody tr")?.dataset.name : undefined,
        focusedBox: !!active?.matches?.("td.sel input"),
    };
}

// Live updates -----------------------------------------------------------

// The changes request open for the folder shown, while the page is in
// view: {dir, t}. Only while it's in view, so a tab left in the background
// holds nothing open, and the session can end for being idle (see
// session.go).
let changes = null;
let changesFailed = 0;  // how many in a row ended soon after they started

// watchChanges keeps a changes request open for dir, which the server
// answers each time something in it changes, and lists it again then. If
// the request ends, as when the connection's lost or the folder's gone,
// the folder is listed again, which says what happened, or reconnects, and
// watches it again: soon at first, less often if it keeps ending.
function watchChanges(dir) {
    if (document.visibilityState !== "visible") {
        stopChanges();
        return;
    }
    if (changes?.dir === dir) {
        return;
    }
    stopChanges();
    const me = (changes = { dir, t: null });
    (async () => {
        const started = Date.now();
        let t;
        try {
            t = await call({ type: "changes", path: dir });
        } catch {
            if (changes === me) {
                changes = null;  // no updates for this folder this time
            }
            return;
        }
        me.t = t;
        if (changes !== me) {
            t.close();
            return;
        }
        while (await t.next()) {
            refreshSoon();
        }
        if (changes !== me) {
            return;  // stopped
        }
        changes = null;
        changesFailed = Date.now() - started < 10000 ? changesFailed + 1 : 0;
        setTimeout(() => folder.dir === dir && show({ refresh: true }), Math.min(500 * 2 ** changesFailed, 60000));
    })();
}

function stopChanges() {
    const c = changes;
    changes = null;
    c?.t?.close();
}

// refreshSoon lists the folder shown again, once nothing's in the way: a
// row's menu open, or something being dragged.
let refreshTimer = 0;
let dragging = false;
function refreshSoon() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
        if (dragging || document.body.classList.contains("dropping") || page.querySelector("details.menu[open]")) {
            refreshSoon();
        } else if (folder.dir !== null) {
            show({ refresh: true });
        }
    }, 300);
}
document.addEventListener("dragstart", () => (dragging = true));
document.addEventListener("dragend", () => (dragging = false));
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") {
        stopChanges();
    } else if (folder.dir !== null) {
        show({ refresh: true });  // catches up, and watches again
    }
});

// Places -----------------------------------------------------------------

// How far down each folder shown in this visit was scrolled, to go back
// there; and, kept for the next visit where the browser allows, the last
// folder shown and how far down it was.
const PLACE_KEY = "tabtop-files-place";
const scrolls = new Map();

// Set while showing the folder last shown, from the last visit.
let restoring = false;

let placeTimer = 0;
addEventListener("scroll", () => {
    if (folder.dir === null) {
        return;
    }
    scrolls.set(folder.dir, scrollY);
    clearTimeout(placeTimer);
    placeTimer = setTimeout(savePlace, 300);
}, { passive: true });

function savePlace() {
    if (folder.dir === null) {
        return;
    }
    try {
        localStorage.setItem(PLACE_KEY, JSON.stringify({ dir: folder.dir, y: Math.round(scrolls.get(folder.dir) ?? 0) }));
    } catch {
        // Not kept, then.
    }
}

// restorePlace goes to the folder last shown, if the page was opened
// without one.
function restorePlace() {
    if (location.hash) {
        return;
    }
    try {
        const place = JSON.parse(localStorage.getItem(PLACE_KEY));
        if (typeof place?.dir === "string" && place.dir) {
            history.replaceState(null, "", dirHash(place.dir));
            restoring = true;
        }
        if (typeof place?.dir === "string" && Number.isFinite(place.y)) {
            scrolls.set(place.dir, place.y);
        }
    } catch {
        // The top, then.
    }
}

// diskSpace says how much room is left for uploads: free of total bytes,
// in red once it's under a twentieth.
function diskSpace(free, total) {
    const low = free < total / 20;
    return el("p", { className: low ? "space error" : "space hint",
        textContent: `${humanBytes(free)} free of ${humanBytes(total)}${low ? ": uploads bigger than that are refused" : ""}` });
}

// breadcrumbs is the page's heading for dir: Downloads and each folder
// down to it, each but the last a link to it.
function breadcrumbs(dir) {
    const parts = dir ? dir.split("/") : [];
    const h1 = el("h1", { className: "crumbs" });
    // As a path, the way the terminal shows it: ~/Downloads/a/b.
    const names = ["~/Downloads", ...parts];
    names.forEach((name, i) => {
        if (i) {
            h1.append(el("span", { className: "sep", textContent: "/" }));
        }
        if (i === names.length - 1) {
            h1.append(el("span", { textContent: name }));
            h1.lastChild.setAttribute("aria-current", "page");
        } else {
            h1.append(el("a", { href: dirHash(parts.slice(0, i).join("/")), textContent: name }));
            h1.lastChild.dataset.dir = parts.slice(0, i).join("/");
        }
    });
    return h1;
}

// The list's order: by name, size or time, either way round. Folders come
// first either way, and those with the same size or time by name. It's
// kept for the next visit, where the browser allows.

try {
    const saved = JSON.parse(localStorage.getItem("tabtop-files-sort"));
    if (["name", "size", "time"].includes(saved?.key)) {
        folder.sort = { key: saved.key, desc: !!saved.desc };
    }
} catch {
    // The default, then.
}

function saveSort() {
    try {
        localStorage.setItem("tabtop-files-sort", JSON.stringify(folder.sort));
    } catch {
        // Only for this visit, then.
    }
}

// deletion is how deleteFiles (see drop.js) deletes the entry e in dir.
function deletion(dir, e) {
    return { name: e.name, dir: e.dir, remove: () => call({ type: "delete", path: join(dir, e.name) }).then((t) => t.close()) };
}

// rename asks for a new name for the entry e in dir, and renames it.
async function rename(dir, e) {
    const slash = e.dir ? "/" : "";
    const name = await askName(`Rename ${e.name}${slash} to:`, "Rename", e.name, !e.dir);
    if (name === null || name === e.name) {
        return;
    }
    const row = statusRow(`${e.name}${slash}: renaming`);
    try {
        const t = await call({ type: "rename", path: join(dir, e.name), name });
        t.close();
        row.set(`${e.name}${slash}: renamed to ${name}${slash}`);
    } catch (err) {
        row.set(`${e.name}${slash}: not renamed: ${err.message}`, true);
    }
    row.finish();
    await show();
}

// Moving ---------------------------------------------------------------

// What's dragged when a row is: {dir, names}, in this type, so dropping it
// isn't taken for files dropped to upload.
const MOVE_TYPE = "application/x-tabtop-move";

// moveTarget makes target, a row or link for the folder to, take rows
// dragged onto it from the folder dir, and move them there.
function moveTarget(target, dir, to) {
    const ours = (ev) => ev.dataTransfer?.types.includes(MOVE_TYPE);
    target.addEventListener("dragover", (ev) => {
        if (ours(ev)) {
            ev.preventDefault();
            ev.dataTransfer.dropEffect = "move";
            target.classList.add("drop-target");
        }
    });
    target.addEventListener("dragleave", () => target.classList.remove("drop-target"));
    target.addEventListener("drop", (ev) => {
        target.classList.remove("drop-target");
        if (!ours(ev)) {
            return;
        }
        ev.preventDefault();
        const { names } = JSON.parse(ev.dataTransfer.getData(MOVE_TYPE));
        // A folder dragged onto itself stays.
        moveNames(dir, names.filter((n) => join(dir, n) !== to), to);
    });
}

// askMove asks which folder to move names, in the folder dir, into, and
// moves them there.
async function askMove(dir, names) {
    const what = names.length === 1 ? names[0] : `these ${names.length} items`;
    const to = await askFolder(`Move ${what} into which folder? Give its path in Downloads, as photos/2026.`, "Move", dir);
    if (to !== null && to !== dir) {
        await moveNames(dir, names, to);
    }
}

// moveNames moves names, in the folder dir, into the folder to, showing
// how each goes in the transfers panel, then redraws the page.
async function moveNames(dir, names, to) {
    if (!names.length) {
        return;
    }
    const where = ["Downloads", ...to.split("/").filter(Boolean)].join(" / ");
    for (const name of names) {
        const row = statusRow(`${name}: moving to ${where}`);
        try {
            const t = await call({ type: "move", path: join(dir, name), to });
            t.close();
            row.set(`${name}: moved to ${where}`);
        } catch (err) {
            row.set(`${name}: not moved: ${err.message}`, true);
        }
        row.finish();
    }
    await show();
}

// copyPath copies the path of path, in ~/Downloads, as a shell takes it
// (see shellPath).
async function copyPath(path) {
    const text = shellPath(path);
    const row = statusRow("");
    try {
        await copyText(text);
        row.set(`Copied ${text}`);
    } catch {
        row.set(`Couldn't copy ${text}`, true);
    }
    row.finish();
}

// copyText puts text on the clipboard: with the clipboard API where the
// browser has it (over HTTPS or on localhost) and allows it, else the old
// way.
async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return;
    } catch {
        // No clipboard API here, or not allowed.
    }
    const area = el("textarea", { value: text, readOnly: true });
    Object.assign(area.style, { position: "fixed", opacity: "0" });
    (document.querySelector("dialog[open]") ?? document.body).append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    if (!ok) {
        throw new Error("not copied");
    }
}

// The keyboard -----------------------------------------------------------

// Set when a folder was opened from the keyboard, so the next one drawn
// puts the focus in its list.
let keyboardArrived = false;

// listKeys lets the list be used from the keyboard, where the focus isn't
// in a text box, a menu or a dialog: ↑ and ↓ move between rows, Enter opens
// the one there (as clicking it), Space ticks it, F2 renames it, Delete
// deletes it, and Backspace goes up a folder.
function listKeys(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector("dialog[open]") ||
        e.target.closest?.("input:not([type=checkbox]), textarea, [contenteditable], details.menu")) {
        return;
    }
    const rows = [...document.querySelectorAll("main tbody tr")].filter((tr) => tr.dataset.name);
    const row = e.target.closest?.("main tbody tr");
    const focus = (tr) => tr?.querySelector("td.name a")?.focus();
    switch (e.key) {
    case "ArrowDown":
    case "ArrowUp": {
        const i = rows.indexOf(row);
        focus(i < 0 ? rows[0] : rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]);
        break;
    }
    case "Enter":
        if (row && e.target.matches("a") && (row.dataset.name === ".." || e.target.textContent.endsWith("/"))) {
            keyboardArrived = true;
        }
        return;  // the link does the rest
    case " ":
        if (!row || row.dataset.name === ".." || e.target.matches("input")) {
            return;
        }
        row.querySelector("td.sel input")?.click();
        break;
    case "F2":
        row?.querySelector("button.rename")?.click();
        break;
    case "Delete":
        row?.querySelector("button.delete")?.click();
        break;
    case "Backspace": {
        const up = document.querySelector('main tbody tr[data-name=".."] a');
        if (!up) {
            return;
        }
        keyboardArrived = true;
        up.click();
        break;
    }
    default:
        return;
    }
    e.preventDefault();
}

// showSecurity shows the sessions and recent logins in place of a folder.
function showSecurity() {
    folder.invalidate();  // a folder's listing still on its way draws nothing
    stopChanges();
    folder.dir = null;  // nor is it scrolled, saved as the place, or refreshed
    document.title = "Security and sessions";
    const box = el("div", { id: "sessions" });
    page.replaceChildren(el("h1", { textContent: "Security and sessions" }), box);
    scrollTo(0, 0);
    showSessions(box);
}

// uploadButton makes the page's upload button (see drop.js).
const uploadButton = dropUploads(uploadFile, makeFolder, () => show(), currentDir, "", folderInfo);
document.addEventListener("keydown", listKeys);
// "/" goes to the filter box, as in many sites' search, unless typing.
document.addEventListener("keydown", (e) => {
    if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.target.closest?.("input, textarea, [contenteditable], dialog")) {
        const box = document.querySelector("input.filter");
        if (box) {
            e.preventDefault();
            box.focus();
        }
    }
});
window.addEventListener("hashchange", () => show());
// Saved on the way out too, as the last scroll may not have been.
addEventListener("pagehide", savePlace);
warnExpiry();
restorePlace();
show();
