// The downloads page with WEB_E2E=1, served by tabtopd (see e2e.go). It
// lists ~/Downloads and fetches files through the encrypted tunnel; the
// folder shown is the path after "#". Where the browser allows service
// workers (HTTPS or localhost), a fetched file streams into an ordinary
// download through download-sw.js, so it goes to disk as it arrives;
// elsewhere it's collected first and then saved (see saveFile). Either way
// it's never shown as a page on this site.

import * as e2e from "./e2e.js";

const page = document.body;

function el(tag, props = {}, ...children) {
    const e = Object.assign(document.createElement(tag), props);
    e.append(...children);
    return e;
}

function currentDir() {
    const p = decodeURIComponent(location.hash.replace(/^#\/?/, ""));
    return p.replace(/^\/+|\/+$/g, "");
}

function dirHash(dir) {
    return "#/" + dir.split("/").filter(Boolean).map(encodeURIComponent).join("/") + (dir ? "/" : "");
}

// call runs a request with the session, logging in again if it's over.
async function call(req) {
    for (;;) {
        const session = await e2e.session("Downloads");
        try {
            return await e2e.Tunnel.open(req, session);
        } catch (err) {
            if (!err.login) {
                throw err;
            }
            e2e.forgetSession();
        }
    }
}

async function show() {
    const dir = currentDir();
    let t;
    try {
        t = await call({ type: "list", path: dir });
    } catch (err) {
        page.replaceChildren(el("h1", { textContent: "Downloads" }), el("p", { className: "error", textContent: err.message }),
            el("p", {}, el("a", { href: "#/", textContent: "Back to the top" })));
        return;
    }
    t.close();
    const title = "/" + (dir ? dir + "/" : "");
    document.title = "Downloads " + title;

    const logout = el("button", { textContent: "Log out" });
    logout.addEventListener("click", async () => {
        try {
            await e2e.request({ type: "logout" });
        } catch {
            // Forgotten here either way.
        }
        e2e.forgetSession();
        show();
    });
    const rows = [];
    if (dir) {
        const up = dir.split("/").slice(0, -1).join("/");
        rows.push(el("tr", {}, el("td", { className: "name" }, el("a", { href: dirHash(up), textContent: "../" })),
            el("td"), el("td")));
    }
    for (const e of t.reply.entries) {
        const path = dir ? dir + "/" + e.name : e.name;
        const link = el("a", { href: e.dir ? dirHash(path) : "#", textContent: e.name + (e.dir ? "/" : "") });
        if (!e.dir) {
            link.addEventListener("click", (ev) => {
                ev.preventDefault();
                fetchFile(path, link);
            });
        }
        rows.push(el("tr", {}, el("td", { className: "name" }, link),
            el("td", { className: "num", textContent: e.size ?? "" }),
            el("td", { className: "num", textContent: e.modified })));
    }
    if (!t.reply.entries.length) {
        rows.push(el("tr", {}, el("td", { colSpan: 3, textContent: "No files yet." })));
    }
    page.replaceChildren(
        el("div", { className: "bar" }, el("h1", { textContent: "Downloads" + title }), logout),
        el("table", {}, el("tr", {}, el("th", { textContent: "Name" }), el("th", { className: "num", textContent: "Size" }),
            el("th", { className: "num", textContent: "Modified" })), ...rows),
        el("p", { style: "opacity: .7; font-size: 13px", textContent: "End-to-end encrypted." }));
}

// downloadWorker resolves to the active download service worker, or null
// where there's none: over plain HTTP, or where the browser refuses it (as
// in some private windows).
let downloadWorker = null;

function worker() {
    downloadWorker ??= (async () => {
        try {
            const reg = await navigator.serviceWorker.register(new URL("./download-sw.js", import.meta.url),
                { scope: new URL("./stream/", import.meta.url).pathname });
            for (const end = Date.now() + 5000; !reg.active && Date.now() < end;) {
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

// nextData returns the tunnel's next data message, or null once it's
// closed.
async function nextData(t) {
    for (let m; (m = await t.next());) {
        if (m.data) {
            return m.data;
        }
    }
    return null;
}

// How long the download may go without asking for more before it's given
// up, as when the browser stops the service worker or the download is
// paused: the tunnel doesn't stop sending meanwhile, so what arrives is
// held in memory.
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
                const data = await nextData(t);
                if (done) {
                    return;
                }
                idle = setTimeout(stalled, STREAM_IDLE);
                if (data) {
                    got += data.byteLength;
                    progress(got);
                    port1.postMessage({ data }, [data]);
                } else if (got === size) {
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
    for (let data; (data = await nextData(t));) {
        chunks.push(new Blob([data]));
        got += data.byteLength;
        progress(got);
    }
    if (got !== size) {
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

if (!e2e.enabled) {
    page.replaceChildren(el("p", { textContent: "End-to-end encryption is off." }));
} else {
    window.addEventListener("hashchange", show);
    show();
}
