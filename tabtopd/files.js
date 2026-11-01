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

import * as tunnel from "./tunnel.js";
import { deleteFiles, dropUploads } from "./drop.js";
import { askFolder, askName, rowMenu, statusRow } from "./ui.js";
import { nameTab, navBar } from "./nav.js";
import { call, fileNames, makeFolder, shellPath, uploadFile } from "./requests.js";
import { fetchFile, fetchZip } from "./download.js";
import { preview, previewable } from "./preview.js";
import { reconnect, reconnected } from "./reconnect.js";
import { warnExpiry } from "./expiry.js";

// The page draws into its own element, so the login form and summary
// (see tunnel.js), added to the body, outlive a redraw.
// Above it, links to the desktop and the terminal, and Log out (see
// nav.js), which stay as the page is redrawn.
const page = document.createElement("main");
document.body.replaceChildren(navBar("files"), page);
nameTab("files");

function el(tag, props = {}, ...children) {
    const e = Object.assign(document.createElement(tag), props);
    e.append(...children);
    return e;
}

function currentDir() {
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
let shown = 0;

// The folder the page shows, once one is.
let shownDir = null;

// show draws the folder named after the "#". It resolves to false if the
// server couldn't be reached, having started trying again, else true.
// With refresh, it's the folder shown, listed again because it changed,
// and the sessions below aren't.
async function show({ refresh = false } = {}) {
    const me = ++shown;
    let dir, t;
    try {
        try {
            dir = currentDir();
        } catch {
            throw new Error("This folder's address is malformed.");  // "#/bad%"
        }
        t = await call({ type: "list", path: dir });
    } catch (err) {
        if (me !== shown) {
            return true;
        }
        if (err.lost) {
            // The folder already shown stays, as it was last seen.
            if (dir !== shownDir) {
                shownDir = null;
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
        shownDir = null;
        page.replaceChildren(el("h1", { textContent: "Downloads" }), el("p", { className: "error", textContent: err.message }),
            el("p", {}, el("a", { href: "#/", textContent: "Back to the top" })));
        return true;
    }
    t.close();
    if (me !== shown) {
        return true;
    }
    restoring = false;
    // The same folder drawn again keeps what's typed, ticked and focused.
    const kept = dir === shownDir ? keepState() : null;
    const arrived = dir !== shownDir;
    shownDir = dir;
    reconnected();
    document.title = "Downloads /" + (dir ? dir + "/" : "");

    const sessions = (kept && document.getElementById("sessions")) || el("div", { id: "sessions" });
    if (!refresh || !sessions.childElementCount) {
        showSessions(sessions);
    }
    // Checked entries, by name, and the bar that offers what to do with
    // them, shown while there are any.
    const entries = t.reply.entries;
    setTimeZone(t.reply.tz || undefined);
    const selected = new Map(entries.filter((e) => kept?.selected.has(e.name)).map((e) => [e.name, e]));
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
        spellcheck: false, value: entries.length ? kept?.filter ?? "" : "" });
    filter.setAttribute("aria-label", "Filter this folder");
    const matches = el("span", { className: "hint" });
    filter.addEventListener("input", () => drawRows());
    const all = el("input", { type: "checkbox", title: "Select all shown" });
    const updateSelection = () => {
        const picked = visible.filter((e) => selected.has(e.name)).length;
        selection.hidden = !selected.size;
        count.textContent = `${selected.size} selected` + (picked < selected.size ? ` (${selected.size - picked} not shown)` : "");
        all.checked = picked > 0 && picked === visible.length;
        all.indeterminate = picked > 0 && picked < visible.length;
    };
    all.addEventListener("change", () => {
        for (const e of visible) {
            all.checked ? selected.set(e.name, e) : selected.delete(e.name);
        }
        drawRows();
    });

    // The column headers sort the list: clicking one sorts by it, and
    // clicking it again turns the order round.
    const head = el("tr");
    const tbody = el("tbody");
    const sortButton = (key, text) => {
        const th = el("th", { className: key === "name" ? "" : key === "size" ? "num" : "num mod" },
            button("sort", text, () => {
                sort = { key, desc: sort.key === key ? !sort.desc : key !== "name" };
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
            const on = th.dataset.key === sort.key;
            th.setAttribute("aria-sort", on ? (sort.desc ? "descending" : "ascending") : "none");
            th.querySelector("button").dataset.arrow = on ? (sort.desc ? "▼" : "▲") : "";
        }
        // Focus in the list stays on the same row as it's redrawn.
        const focused = document.activeElement?.closest?.("tbody tr")?.dataset.name;
        const rows = [];
        if (dir) {
            const up = dir.split("/").slice(0, -1).join("/");
            const tr = el("tr", {}, el("td", { className: "sel" }), el("td", { className: "name" }, el("a", { href: dirHash(up), textContent: "../" })),
                el("td"), el("td", { className: "mod" }), el("td"));
            tr.dataset.name = "..";
            moveTarget(tr, dir, up);
            rows.push(tr);
        }
        const q = filter.value.trim().toLocaleLowerCase();
        visible = q ? entries.filter((e) => e.name.toLocaleLowerCase().includes(q)) : entries;
        matches.textContent = q ? `${visible.length} of ${entries.length} shown` : "";
        const sorted = sortEntries(visible);
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
                box.checked ? selected.set(e.name, e) : selected.delete(e.name);
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
                el("td", { className: "num", textContent: e.size ?? "", title: e.dir ? "" : `${(e.bytes ?? 0).toLocaleString()} bytes` }),
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
        el("table", {}, el("thead", {}, head), tbody),
        ...(t.reply.truncated ? [el("p", { className: "error", textContent: `This folder has more than ${t.reply.max} entries, ` +
            `so only ${t.reply.max} of them are shown, chosen in no particular order.` })] : []),
        el("p", { className: "upload" }, uploadButton(), newFolder,
            el("span", { className: "hint", textContent: "Or drop files or folders on this page. They go into this folder, end-to-end encrypted." })),
        sessions);
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
        selected: new Set([...page.querySelectorAll("tbody td.sel input:checked")].map((box) => box.closest("tr").dataset.name)),
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
        setTimeout(() => shownDir === dir && show({ refresh: true }), Math.min(500 * 2 ** changesFailed, 60000));
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
        } else if (shownDir !== null) {
            show({ refresh: true });
        }
    }, 300);
}
document.addEventListener("dragstart", () => (dragging = true));
document.addEventListener("dragend", () => (dragging = false));
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") {
        stopChanges();
    } else if (shownDir !== null) {
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
    if (shownDir === null) {
        return;
    }
    scrolls.set(shownDir, scrollY);
    clearTimeout(placeTimer);
    placeTimer = setTimeout(savePlace, 300);
}, { passive: true });

function savePlace() {
    if (shownDir === null) {
        return;
    }
    try {
        localStorage.setItem(PLACE_KEY, JSON.stringify({ dir: shownDir, y: Math.round(scrolls.get(shownDir) ?? 0) }));
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

// breadcrumbs is the page's heading for dir: Downloads and each folder
// down to it, each but the last a link to it.
function breadcrumbs(dir) {
    const parts = dir ? dir.split("/") : [];
    const h1 = el("h1", { className: "crumbs" });
    const names = ["Downloads", ...parts];
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
let sort = { key: "name", desc: false };
try {
    const saved = JSON.parse(localStorage.getItem("tabtop-files-sort"));
    if (["name", "size", "time"].includes(saved?.key)) {
        sort = { key: saved.key, desc: !!saved.desc };
    }
} catch {
    // The default, then.
}

function saveSort() {
    try {
        localStorage.setItem("tabtop-files-sort", JSON.stringify(sort));
    } catch {
        // Only for this visit, then.
    }
}

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare;

function sortEntries(entries) {
    const dirSign = (e) => (e.dir ? 0 : 1);
    const value = { name: () => 0, size: (e) => e.bytes ?? 0, time: (e) => e.time ?? 0 }[sort.key];
    return [...entries].sort((a, b) => {
        let c = value(a) - value(b);
        if (sort.key === "name" || c === 0) {
            c = byName(a.name, b.name);
        }
        return dirSign(a) - dirSign(b) || (sort.desc ? -c : c);
    });
}

// The time zone the page shows times in: the server's TZ, from its
// listings, UTC until then, or if this browser doesn't know the zone.
let timeZone;

// clocks are the formats for times in timeZone, made again when it
// changes.
let clocks = null;

function setTimeZone(tz = "UTC") {
    try {
        new Intl.DateTimeFormat(undefined, { timeZone: tz });
    } catch {
        tz = "UTC";  // a zone this browser doesn't know
    }
    if (clocks && tz === timeZone) {
        return;
    }
    timeZone = tz;
    const f = (options) => new Intl.DateTimeFormat(undefined, { timeZone, ...options });
    clocks = {
        relativeDay: new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }),
        clock: f({ hour: "numeric", minute: "2-digit" }),
        weekday: f({ weekday: "short" }),
        dayMonth: f({ day: "numeric", month: "short" }),
        withYear: f({ dateStyle: "medium" }),
        exact: f({ weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit",
            second: "2-digit", timeZoneName: "short" }),
        short: f({ dateStyle: "short", timeStyle: "medium" }),
        ymd: new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "numeric", day: "numeric" }),
    };
}
setTimeZone();

// dayNumber counts days to when's date in timeZone, to tell how many days
// apart two times are there.
function dayNumber(when) {
    const part = Object.fromEntries(clocks.ymd.formatToParts(when).map((p) => [p.type, Number(p.value)]));
    return Date.UTC(part.year, part.month - 1, part.day) / 86400000;
}

// friendlyTime is a time in Unix seconds as people say it, in the
// browser's language and the page's time zone: today's and yesterday's
// with the time, the rest of the past week's by the day and time, this
// year's by the date, and older ones with the year. exactTime is the whole
// of it, shown on hover.
function friendlyTime(seconds) {
    const when = new Date(seconds * 1000);
    const now = new Date();
    const days = dayNumber(now) - dayNumber(when);
    if (days === 0 || days === 1) {
        const name = clocks.relativeDay.format(-days, "day");  // "today", "yesterday"
        return `${name[0].toUpperCase()}${name.slice(1)} ${clocks.clock.format(when)}`;
    }
    if (days > 1 && days < 7) {
        return `${clocks.weekday.format(when)} ${clocks.clock.format(when)}`;
    }
    const year = (d) => clocks.ymd.formatToParts(d).find((p) => p.type === "year").value;
    return year(when) === year(now) ? clocks.dayMonth.format(when) : clocks.withYear.format(when);
}

function exactTime(seconds) {
    return clocks.exact.format(seconds * 1000);
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

// showSessions lists the logins that are still live, where each has been
// used from, and recent logins, with a button that ends every session.
async function showSessions(box) {
    let r;
    try {
        const t = await call({ type: "sessions" });
        t.close();
        r = t.reply;
    } catch (err) {
        box.replaceChildren(el("p", { className: "error", textContent: `Sessions: ${err.message}` }));
        return;
    }
    const when = (t) => clocks.short.format(new Date(t));
    const everywhere = el("button", { textContent: "Log out everywhere" });
    everywhere.addEventListener("click", async () => {
        try {
            await tunnel.request({ type: "logout-all" });
        } catch {
            // Forgotten here either way.
        }
        tunnel.forgetSession();
        show();
    });
    const rows = r.sessions.map((s) => {
        const login = s.uses[0];
        const others = s.uses.slice(1).map((u) => `${u.ip} (last ${when(u.last)})`).join(", ");
        return el("tr", {}, el("td", { textContent: when(s.created) + (s.current ? " (this browser)" : "") }),
            el("td", { className: "name" }, login.ip, ...(others ? [el("br"), el("span", { className: "error", textContent: "also " + others })] : [])),
            el("td", { className: "num", textContent: s.open }));
    });
    const logins = r.logins.map((l) => el("tr", {}, el("td", { textContent: when(l.time) }),
        el("td", { className: "name", textContent: l.ip }),
        el("td", { className: l.ok ? "" : "error", textContent: l.ok ? "logged in" : "failed" })));
    const idle = r.idle_minutes ? ` A login with nothing open ends after ${r.idle_minutes} minutes.` : "";
    box.replaceChildren(
        el("div", { className: "bar" }, el("h2", { textContent: "Sessions" }), everywhere),
        el("table", {}, el("tr", {}, el("th", { textContent: "Logged in" }), el("th", { textContent: "Used from" }),
            el("th", { className: "num", textContent: "Open" })), ...rows),
        el("h2", { textContent: "Recent logins" }),
        el("table", {}, ...(logins.length ? logins : [el("tr", {}, el("td", { textContent: "None since the server started." }))])),
        el("p", { className: "hint", textContent: "A session used from an address it didn't log in from is marked in red. "
            + "This page could hide that if it was changed on the way; the gateway also logs it (docker logs)." + idle }));
}


// uploadButton makes the page's upload button (see drop.js).
const uploadButton = dropUploads(uploadFile, makeFolder, () => show(), currentDir, "", fileNames);
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
