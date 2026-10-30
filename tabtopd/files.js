// The downloads page with WEB_E2E=1, served by tabtopd (see e2e.go). It
// lists ~/Downloads and fetches files through the encrypted tunnel; the
// folder shown is the path after "#". A fetched file is held in memory and
// then saved as a download (never shown as a page on this site).

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

async function fetchFile(path, link) {
    const label = link.textContent;
    let t;
    try {
        t = await call({ type: "file", path });
    } catch (err) {
        link.textContent = `${label} (${err.message})`;
        return;
    }
    const { name, size } = t.reply;
    const chunks = [];
    let got = 0;
    for (let m; (m = await t.next());) {
        if (m.data) {
            chunks.push(m.data);
            got += m.data.byteLength;
            link.textContent = `${label} (${size ? Math.floor(got * 100 / size) : 100}%)`;
        }
    }
    if (got !== size) {
        link.textContent = `${label} (failed: ${t.closeReason || "connection lost"})`;
        return;
    }
    link.textContent = label;
    const url = URL.createObjectURL(new Blob(chunks, { type: "application/octet-stream" }));
    const a = el("a", { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}

if (!e2e.enabled) {
    page.replaceChildren(el("p", { textContent: "End-to-end encryption is off." }));
} else {
    window.addEventListener("hashchange", show);
    show();
}
