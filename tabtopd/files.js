// The files page, served by tabtopd (see tunnel.go). It lists ~/Downloads
// and fetches files through the encrypted tunnel; the folder shown is the
// path after "#". Where the browser allows service
// workers (HTTPS or localhost), a fetched file streams into an ordinary
// download through download-sw.js, so it goes to disk as it arrives;
// elsewhere it's collected first and then saved (see saveFile). Either way
// it's never shown as a page on this site. A folder, or several files and
// folders picked with their checkboxes, download as one zip (see fetchZip).
// Files and folders dropped on the page are uploaded into the folder shown,
// as are those picked with its buttons (see drop.js, uploadFile and
// makeFolder), and each file and folder can be renamed and deleted.
// Below, it lists the live sessions and recent logins (see showSessions).

import * as tunnel from "./tunnel.js";
import { deleteFiles, dropUploads, statusRow } from "./drop.js";

// The page draws into its own element, so the login form and summary
// (see tunnel.js), added to the body, outlive a redraw.
const page = document.createElement("main");
document.body.replaceChildren(page);

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

// call runs a request with the session, logging in again if it's over.
async function call(req) {
    for (;;) {
        const session = await tunnel.session("Downloads");
        try {
            return await tunnel.Tunnel.open(req, session);
        } catch (err) {
            if (!err.login) {
                throw err;
            }
            tunnel.forgetSession();
        }
    }
}

// Counts calls to show, so one whose listing arrives after a later one's
// draws nothing: moving quickly between folders ends on the last.
let shown = 0;

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
        if (me === shown) {
            page.replaceChildren(el("h1", { textContent: "Downloads" }), el("p", { className: "error", textContent: err.message }),
                el("p", {}, el("a", { href: "#/", textContent: "Back to the top" })));
        }
        return;
    }
    t.close();
    if (me !== shown) {
        return;
    }
    const title = "/" + (dir ? dir + "/" : "");
    document.title = "Downloads " + title;

    const sessions = el("div", { id: "sessions" });
    showSessions(sessions);
    const logout = el("button", { textContent: "Log out" });
    logout.addEventListener("click", async () => {
        try {
            await tunnel.request({ type: "logout" });
        } catch {
            // Forgotten here either way.
        }
        tunnel.forgetSession();
        show();
    });
    // Checked entries, by name, and the bar that offers what to do with
    // them, shown while there are any.
    const selected = new Map();
    const boxes = [];
    const count = el("span");
    const selection = el("div", { className: "selection", hidden: true }, count,
        button("zip", "Download as .zip", () => fetchZip(dir, [...selected.keys()])),
        button("delete", "Delete", () => deleteFiles([...selected.values()].map((e) => deletion(dir, e)), show)));
    const all = el("input", { type: "checkbox", title: "Select all" });
    const updateSelection = () => {
        selection.hidden = !selected.size;
        count.textContent = `${selected.size} selected`;
        all.checked = selected.size > 0 && selected.size === boxes.length;
        all.indeterminate = selected.size > 0 && selected.size < boxes.length;
    };
    all.addEventListener("change", () => {
        for (const [box, e] of boxes) {
            box.checked = all.checked;
            all.checked ? selected.set(e.name, e) : selected.delete(e.name);
        }
        updateSelection();
    });

    const rows = [];
    if (dir) {
        const up = dir.split("/").slice(0, -1).join("/");
        rows.push(el("tr", {}, el("td", { className: "sel" }), el("td", { className: "name" }, el("a", { href: dirHash(up), textContent: "../" })),
            el("td"), el("td", { className: "mod" }), el("td")));
    }
    for (const e of t.reply.entries) {
        const path = join(dir, e.name);
        const link = el("a", { href: e.dir ? dirHash(path) : "#", textContent: e.name + (e.dir ? "/" : "") });
        if (!e.dir) {
            link.addEventListener("click", (ev) => {
                ev.preventDefault();
                fetchFile(path, link);
            });
        }
        const box = el("input", { type: "checkbox", title: `Select ${e.name}` });
        box.addEventListener("change", () => {
            box.checked ? selected.set(e.name, e) : selected.delete(e.name);
            updateSelection();
        });
        boxes.push([box, e]);
        const act = el("td", { className: "act" },
            ...(e.dir ? [button("zip", "Download .zip", () => fetchZip(dir, [e.name]))] : []),
            button("rename", "Rename", () => rename(dir, e)),
            button("delete", "Delete", () => deleteFiles([deletion(dir, e)], show)));
        rows.push(el("tr", {}, el("td", { className: "sel" }, box), el("td", { className: "name" }, link),
            el("td", { className: "num", textContent: e.size ?? "" }),
            el("td", { className: "num mod", textContent: e.modified }), act));
    }
    if (!t.reply.entries.length) {
        rows.push(el("tr", {}, el("td", { colSpan: 5, textContent: "No files yet." })));
    }
    const newFolder = button("", "New folder…", async () => {
        const name = prompt("The new folder's name:");
        if (!name) {
            return;
        }
        const row = statusRow(`${name}/: making`);
        try {
            const got = await makeFolder(dir, name);
            row.set(got === name ? `${name}/: made` : `${name}/: made as ${got}/, since the name is taken`);
        } catch (err) {
            row.set(`${name}/: not made: ${err.message}`, true);
        }
        await show();
    });
    page.replaceChildren(
        el("div", { className: "bar" }, el("h1", { textContent: "Downloads" + title }), logout),
        selection,
        el("table", {}, el("tr", {}, el("th", { className: "sel" }, all), el("th", { textContent: "Name" }),
            el("th", { className: "num", textContent: "Size" }), el("th", { className: "num mod", textContent: "Modified" }), el("th")), ...rows),
        ...(t.reply.truncated ? [el("p", { className: "error", textContent: `This folder has more than ${t.reply.max} entries, ` +
            `so only ${t.reply.max} of them are shown, chosen in no particular order.` })] : []),
        el("p", { className: "upload" }, uploadButton(), newFolder,
            el("span", { className: "hint", textContent: "Or drop files or folders on this page. They go into this folder, end-to-end encrypted." })),
        sessions);
}

// deletion is how deleteFiles (see drop.js) deletes the entry e in dir.
function deletion(dir, e) {
    return { name: e.name, dir: e.dir, remove: () => call({ type: "delete", path: join(dir, e.name) }).then((t) => t.close()) };
}

// rename asks for a new name for the entry e in dir, and renames it.
async function rename(dir, e) {
    const slash = e.dir ? "/" : "";
    const name = prompt(`Rename ${e.name}${slash} to:`, e.name);
    if (!name || name === e.name) {
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
    const when = (t) => new Date(t).toLocaleString();
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

async function fetchFile(path, link) {
    const label = link.textContent;
    const sw = await worker();
    let t;
    try {
        t = await call({ type: "file", path });
    } catch (err) {
        link.textContent = `${label} (${err.message})`;
        return;
    }
    const { name, size } = t.reply;
    const progress = (got) => (link.textContent = `${label} (${size ? Math.floor(got * 100 / size) : 100}%)`);
    const failed = await (sw ? streamFile : saveFile)(t, name, size, progress, sw);
    link.textContent = failed ? `${label} (${failed})` : label;
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

// complete reports whether a download that's ended came whole: all size
// bytes of a file, or a zip (size null) the server said it finished.
function complete(t, got, size) {
    return size === null ? t.trailer?.done === true : got === size;
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

// saveFile collects the file, then saves it, and returns why it failed, or
// "". Each chunk becomes a Blob as it arrives, which moves it out of the
// page's memory into the browser's blob storage; Chrome keeps large ones in
// temporary files on disk.
async function saveFile(t, name, size, progress) {
    const chunks = [];
    let got = 0;
    for (let data; (data = await t.nextChunk());) {
        chunks.push(new Blob([data]));
        got += data.byteLength;
        progress(got);
    }
    if (!complete(t, got, size)) {
        return `failed: ${t.closeReason || "connection lost"}`;
    }
    const url = URL.createObjectURL(new Blob(chunks, { type: "application/octet-stream" }));
    const a = el("a", { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return "";
}

// Uploads are sent in chunks the size of the server's, at most
// UPLOAD_WINDOW of them ahead of those it has acknowledged writing, so a
// slow server or disk doesn't pile the file up in the browser.
const UPLOAD_CHUNK = 256 * 1024;
const UPLOAD_WINDOW = 16;

// uploadFile uploads a dropped or picked file into the folder dir, and
// returns the name it was saved as, and any warning. Aborting signal ends
// it, and the server then deletes what it had of the file.
async function uploadFile(file, progress, dir, signal) {
    signal.throwIfAborted();
    const t = await call({ type: "upload", path: dir, name: file.name, size: file.size });
    const abort = () => t.close();
    signal.addEventListener("abort", abort);
    try {
        signal.throwIfAborted();  // while it was opening
        const chunks = Math.ceil(file.size / UPLOAD_CHUNK);
        let sent = 0;
        let acked = 0;
        for (;;) {
            while (sent < chunks && sent - acked < UPLOAD_WINDOW) {
                const start = sent * UPLOAD_CHUNK;
                t.sendData(new Uint8Array(await file.slice(start, start + UPLOAD_CHUNK).arrayBuffer()));
                sent++;
            }
            const m = await t.next();
            if (!m) {
                throw new Error(t.closeReason || "connection lost");
            }
            if (m.text !== undefined) {
                const res = JSON.parse(m.text);
                if (res.name && acked === chunks) {
                    return { name: res.name, warning: res.warning };
                }
                throw new Error(res.error || "the server's reply is malformed");
            }
            acked++;
            progress(Math.min(acked * UPLOAD_CHUNK, file.size));
        }
    } finally {
        signal.removeEventListener("abort", abort);
        t.close();
    }
}

// uploadButton makes the page's upload button (see drop.js).
let uploadButton;

// makeFolder makes the folder name in dir for an upload, and returns the
// name it got.
async function makeFolder(dir, name) {
    const t = await call({ type: "mkdir", path: dir, name });
    t.close();
    return t.reply.name;
}

uploadButton = dropUploads(uploadFile, makeFolder, show, currentDir);
window.addEventListener("hashchange", show);
show();
