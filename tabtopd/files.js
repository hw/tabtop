// The files page, served by tabtopd (see tunnel.go). It lists ~/Downloads
// and fetches files through the encrypted tunnel; the folder shown is the
// path after "#". Where the browser allows service
// workers (HTTPS or localhost), a fetched file streams into an ordinary
// download through download-sw.js, so it goes to disk as it arrives;
// elsewhere it's collected first and then saved (see saveFile). Either way
// it's never shown as a page on this site. Pictures, video, sound and text
// open in a preview instead, where they're small enough (see preview.js).
// A folder, or several files and
// folders picked with their checkboxes, download as one zip (see fetchZip).
// Files and folders dropped on the page are uploaded into the folder shown,
// as are those picked with its buttons (see drop.js, uploadFile and
// makeFolder), and each file and folder can be renamed and deleted from
// its menu. The list sorts by any column (see sortEntries). Below, it
// lists the live sessions and recent logins (see showSessions). If the
// server can't be reached, it says so and tries again (see reconnect.js).

import * as tunnel from "./tunnel.js";
import { deleteFiles, dropUploads } from "./drop.js";
import { askName, rowMenu, statusRow } from "./ui.js";
import { nameTab, navBar } from "./nav.js";
import { call, collect, complete, makeFolder, saveBlob, uploadFile } from "./requests.js";
import { preview, previewable } from "./preview.js";
import { reconnect, reconnected } from "./reconnect.js";

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
async function show() {
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
            reconnect("Can't reach the server.", show);
            return false;
        }
        shownDir = null;
        page.replaceChildren(el("h1", { textContent: "Downloads" }), el("p", { className: "error", textContent: err.message }),
            el("p", {}, el("a", { href: "#/", textContent: "Back to the top" })));
        return true;
    }
    t.close();
    if (me !== shown) {
        return true;
    }
    shownDir = dir;
    reconnected();
    document.title = "Downloads /" + (dir ? dir + "/" : "");

    const sessions = el("div", { id: "sessions" });
    showSessions(sessions);
    // Checked entries, by name, and the bar that offers what to do with
    // them, shown while there are any.
    const entries = t.reply.entries;
    setTimeZone(t.reply.tz || undefined);
    const selected = new Map();
    const count = el("span");
    const selection = el("div", { className: "selection", hidden: true }, count,
        button("zip", "Download as .zip", () => fetchZip(dir, [...selected.keys()])),
        button("delete", "Delete", () => deleteFiles([...selected.values()].map((e) => deletion(dir, e)), show)),
        button("", "Clear selection", () => {
            selected.clear();
            drawRows();
        }));
    // The filter box narrows the list to names with what's typed in them;
    // "Select all" then picks those shown.
    let visible = entries;
    const filter = el("input", { type: "search", className: "filter", placeholder: "Filter this folder  ( / )", autocomplete: "off",
        spellcheck: false });
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
        const rows = [];
        if (dir) {
            const up = dir.split("/").slice(0, -1).join("/");
            rows.push(el("tr", {}, el("td", { className: "sel" }), el("td", { className: "name" }, el("a", { href: dirHash(up), textContent: "../" })),
                el("td"), el("td", { className: "mod" }), el("td")));
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
                ["delete", "Delete…", () => deleteFiles([deletion(dir, e)], show)],
            ]);
            rows.push(el("tr", {}, el("td", { className: "sel" }, box), el("td", { className: "name" }, link),
                el("td", { className: "num", textContent: e.size ?? "", title: e.dir ? "" : `${(e.bytes ?? 0).toLocaleString()} bytes` }),
                el("td", { className: "num mod", textContent: e.time ? friendlyTime(e.time) : e.modified,
                    title: e.time ? exactTime(e.time) : "" }),
                el("td", { className: "act" }, menu)));
        }
        if (!entries.length) {
            rows.push(el("tr", {}, el("td", { colSpan: 5, textContent: "No files yet." })));
        } else if (!visible.length) {
            rows.push(el("tr", {}, el("td", { colSpan: 5, textContent: `Nothing here has “${filter.value.trim()}” in its name.` })));
        }
        tbody.replaceChildren(...rows);
        updateSelection();
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
    page.replaceChildren(
        breadcrumbs(dir),
        ...(entries.length ? [el("div", { className: "find" }, filter, matches)] : []),
        selection,
        el("table", {}, el("thead", {}, head), tbody),
        ...(t.reply.truncated ? [el("p", { className: "error", textContent: `This folder has more than ${t.reply.max} entries, ` +
            `so only ${t.reply.max} of them are shown, chosen in no particular order.` })] : []),
        el("p", { className: "upload" }, uploadButton(), newFolder,
            el("span", { className: "hint", textContent: "Or drop files or folders on this page. They go into this folder, end-to-end encrypted." })),
        sessions);
    return true;
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

// downloadWorker resolves to the active download service worker, or null
// where there's none: over plain HTTP, or where the browser refuses it (as
// in some private windows).
let downloadWorker = null;

// DOWNLOAD_SW_VERSION names the worker's version in its address. A
// browser checks an unchanged address for a newer worker only now and
// then, so it goes up whenever download-sw.js changes in a way the page
// relies on, as it did when zips of unknown size came in (2).
const DOWNLOAD_SW_VERSION = 2;

function worker() {
    downloadWorker ??= (async () => {
        try {
            const reg = await navigator.serviceWorker.register(new URL(`./download-sw.js?v=${DOWNLOAD_SW_VERSION}`, import.meta.url),
                { scope: new URL("./stream/", import.meta.url).pathname });
            // A browser that used the page before may still run an older
            // worker, which a new version replaces: wait for it to take
            // over, so downloads use it.
            const end = Date.now() + 5000;
            while ((!reg.active || reg.installing || reg.waiting) && Date.now() < end) {
                await new Promise((r) => setTimeout(r, 50));
            }
            return reg.active;
        } catch {
            return null;
        }
    })();
    return downloadWorker;
}

// fetchFile downloads the file at path. How it goes shows in the
// transfers panel, with a Cancel button.
async function fetchFile(path) {
    const label = path.split("/").pop();
    const row = statusRow(`${label}: starting`, true);
    try {
        const sw = await worker();
        const t = await call({ type: "file", path });
        row.signal.addEventListener("abort", () => t.close());
        if (row.signal.aborted) {
            t.close();  // while it was opening
        }
        const { name, size } = t.reply;
        const progress = (got) => {
            row.set(`${name}: ${size ? Math.floor(got * 100 / size) : 100}%`);
            row.progress(size ? got / size : 1);
        };
        const failed = await (sw ? streamFile : saveFile)(t, name, size, progress, sw);
        if (row.signal.aborted) {
            row.set(`${name}: cancelled`);
        } else if (failed) {
            row.set(`${name}: ${failed}`, true);
        } else {
            row.set(`${name}: downloaded, ${humanBytes(size)}`);
        }
    } catch (err) {
        row.set(`${label}: not downloaded: ${err.message}`, true);
    }
    row.finish();
}

// The biggest a zip request can be: the server takes requests up to 1 MiB.
const MAX_REQUEST = 1000000;

// fetchZip downloads names, in the folder dir, as one zip, which the server
// makes as it sends it. How it goes shows in the status list, with a
// Cancel button.
async function fetchZip(dir, names) {
    const label = names.length === 1 ? `${names[0]}/` : `${names.length} items`;
    const row = statusRow(`${label}: zipping`, true);
    try {
        const req = { type: "zip", path: dir, names };
        if (JSON.stringify(req).length > MAX_REQUEST) {
            throw new Error("too many to download at once; pick fewer");
        }
        const sw = await worker();
        const t = await call(req);
        row.signal.addEventListener("abort", () => t.close());
        if (row.signal.aborted) {
            t.close();  // while it was opening
        }
        const { name } = t.reply;
        let bytes = 0;
        const progress = (got) => {
            bytes = got;
            row.set(`${name}: ${humanBytes(got)}`);
            row.progress(null);
        };
        const failed = await (sw ? streamFile : saveFile)(t, name, null, progress, sw);
        if (row.signal.aborted) {
            row.set(`${name}: cancelled`);
        } else if (failed) {
            row.set(`${name}: ${failed}`, true);
        } else if (t.trailer.skipped) {
            row.set(`${name}: downloaded, ${humanBytes(bytes)}, without ${t.trailer.skipped} files or folders that couldn't be read`, true);
        } else {
            row.set(`${name}: downloaded, ${humanBytes(bytes)}`);
        }
    } catch (err) {
        row.set(`${label}: not downloaded: ${err.message}`, true);
    }
    row.finish();
}

function humanBytes(n) {
    const units = ["bytes", "KB", "MB", "GB", "TB"];
    let i = 0;
    for (; n >= 1000 && i < units.length - 1; i++) {
        n /= 1000;
    }
    return `${i ? n.toFixed(1) : n} ${units[i]}`;
}

// How long the download may go without asking for more before it's given
// up, as when the browser stops the service worker or the download is
// paused, rather than leave it waiting with the tunnel open.
const STREAM_IDLE = 30000;

// streamFile hands the file to the service worker, one chunk each time the
// browser's download asks for more, and returns why it failed, or "". The
// service worker's response has the file's size, so the browser fails the
// download, rather than keeping it, if this ends early.
function streamFile(t, name, size, progress, sw) {
    return new Promise((resolve) => {
        const { port1, port2 } = new MessageChannel();
        const id = crypto.randomUUID();
        const frame = el("iframe", { hidden: true });
        let got = 0;
        let done = false;
        const ping = setInterval(() => sw.postMessage({ type: "ping" }), 10000);  // keeps it running
        let idle = setTimeout(() => finish("the download didn't start"), 10000);
        const stalled = () => {
            port1.postMessage({ error: "stalled" });
            finish("failed: the download stopped");
        };
        function finish(failed) {
            done = true;
            clearInterval(ping);
            clearTimeout(idle);
            port1.onmessage = null;
            t.close();
            setTimeout(() => frame.remove(), 1000);
            resolve(failed);
        }
        port1.onmessage = async (e) => {
            const m = e.data;
            if (m.started) {
                clearTimeout(idle);
                idle = setTimeout(stalled, STREAM_IDLE);
                progress(0);
            } else if (m.cancel) {
                finish("cancelled");
            } else if (m.pull) {
                clearTimeout(idle);
                const data = await t.nextChunk();
                if (done) {
                    return;
                }
                idle = setTimeout(stalled, STREAM_IDLE);
                if (data) {
                    got += data.byteLength;
                    progress(got);
                    port1.postMessage({ data }, [data]);
                } else if (complete(t, got, size)) {
                    port1.postMessage({ done: true });
                    finish("");
                } else {
                    port1.postMessage({ error: "ended early" });
                    finish(`failed: ${t.closeReason || "connection lost"}`);
                }
            }
        };
        sw.postMessage({ type: "download", id, name, size, port: port2 }, [port2]);
        frame.src = new URL(`./stream/${id}/${encodeURIComponent(name)}`, import.meta.url).href;
        document.body.append(frame);
    });
}

// saveFile collects the file (see collect), then saves it, and returns why
// it failed, or "".
async function saveFile(t, name, size, progress) {
    try {
        saveBlob(await collect(t, size, progress), name);
        return "";
    } catch (err) {
        return `failed: ${err.message}`;
    }
}

// uploadButton makes the page's upload button (see drop.js).
const uploadButton = dropUploads(uploadFile, makeFolder, show, currentDir);
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
window.addEventListener("hashchange", show);
show();
