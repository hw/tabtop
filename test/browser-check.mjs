// Checks a running TabTop end to end in headless Chrome, through the
// pages a person uses: login, desktop, audio, the files page (list, free
// space, download, preview, upload, replacing on a name clash, pasting,
// the keyboard, delete, updating itself, going back to the folder last
// shown, folder upload picked and dropped, folder delete, zips, new
// folder, rename, move, copying a path, deleting several, cancelling an
// upload, retrying a failed download, ending another session, which is
// named by its browser, refusing files that won't fit together, and
// carrying on with an upload whose connection was lost), a file
// dropped on the desktop and the notice of one saved there, the desktop's
// clipboard, the terminal (its font size keys, touch keys, a file dropped
// on it, and searching its history), reconnecting after the connection is
// lost on each page, logging in again when warned the login is ending,
// and logout.
// browser-check.sh starts the container and Chrome and runs it; it exits
// non-zero, saying which step failed, if anything doesn't work.
//
// Usage: node browser-check.mjs <devtools port> <site url> <download dir> <work dir> <container>
// The site's TOTP secret must be the Base32 of "12345678901234567890", and
// ~/Downloads must hold hello.txt with "hello from the desktop\n", and
// media/tone.wav, a second of sound. The work
// dir holds up.bin, big.bin (big enough to cancel while it uploads),
// resume.bin (big enough to cut off while it uploads), and the folder
// up-folder: a.txt, sub/b.txt and sub/deeper/c.txt, each holding its own
// name, and the empty folder empty.

import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";

const [port, base, downloads, work, container] = process.argv.slice(2);
// inContainer runs a command in the container as its user, and returns
// what it prints.
const inContainer = (...args) => execFileSync("docker", ["exec", "-u", "user", container, ...args], { encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// totp is the current code, waiting first if the current one is about to
// expire, so it's still good when it arrives, or if it was used already,
// since a code logs in only once.
let lastStep = -1;
async function totp() {
    while (30 - (Date.now() / 1000) % 30 < 3 || Math.floor(Date.now() / 30000) === lastStep) {
        await sleep(500);
    }
    lastStep = Math.floor(Date.now() / 30000);
    const c = Buffer.alloc(8);
    c.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
    const h = createHmac("sha1", "12345678901234567890").update(c).digest();
    const o = h[19] & 15;
    return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, "0");
}

// The DevTools protocol, on the browser's first page.
const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("can't reach Chrome's DevTools"));
});
let id = 0;
const pending = new Map();
const exceptions = [];
ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
    } else if (m.method === "Page.javascriptDialogOpening") {
        // Leaving the desktop asks first.
        cdp("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});  // gone already
    } else if (m.method === "Log.entryAdded" || m.method === "Runtime.consoleAPICalled") {
        // With CHECK_LOG set, the pages' console and Chrome's own messages
        // (as why it refused a download) go to stderr.
        const e = m.params.entry ?? { level: m.params.type, text: m.params.args.map((a) => a.value ?? a.description).join(" ") };
        if (process.env.CHECK_LOG) {
            console.error(`[${e.level}] ${e.text}`);
        }
    } else if (m.method === "Runtime.exceptionThrown") {
        const d = m.params.exceptionDetails;
        exceptions.push(`${d.exception?.description ?? d.text} (${d.url ?? "?"}:${d.lineNumber})`);
    }
};
const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    const timer = setTimeout(() => reject(new Error(`${method}: no answer from Chrome`)), 30000);
    pending.set(n, (m) => {
        clearTimeout(timer);
        m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result);
    });
    ws.send(JSON.stringify({ id: n, method, params }));
});
const ev = async (expr) => {
    const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
        throw new Error(`${expr}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    }
    return r.result.value;
};
async function waitFor(expr, what, ms = 30000) {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) {
        if (await ev(expr)) {
            return;
        }
    }
    // What the transfers panel says, if there's one, often says why.
    const panel = await ev(`document.getElementById("uploads")?.innerText.replaceAll("\\n", " | ") ?? ""`).catch(() => "");
    throw new Error(`timed out waiting for ${what}${panel ? ` (transfers: ${panel})` : ""}`);
}
async function click(expr) {
    const r = await ev(`(() => { const b = (${expr}).getBoundingClientRect(); return {x: b.x + b.width / 2, y: b.y + b.height / 2}; })()`);
    for (const type of ["mousePressed", "mouseReleased"]) {
        await cdp("Input.dispatchMouseEvent", { type, x: r.x, y: r.y, button: "left", clickCount: 1 });
    }
}
// press sends a key, as the keyboard does, to the focused element.
const keyCodes = { ArrowDown: 40, ArrowUp: 38, Enter: 13, Backspace: 8, " ": 32, "=": 187, "0": 48 };
async function press(key, modifiers = 0) {
    const code = { " ": "Space", "=": "Equal", "0": "Digit0" }[key] ?? key;
    const text = key === "Enter" ? "\r" : key.length === 1 && !modifiers ? key : undefined;
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCodes[key], modifiers, ...(text ? { text } : {}) });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCodes[key], modifiers });
}
// type types text a key at a time: the terminal reads key events, not
// text input.
async function type(text) {
    for (const ch of text) {
        await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch });
        await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
    }
}
async function open(path, ready, what) {
    await cdp("Page.navigate", { url: base + path });
    await waitFor(ready, what);
}
// newTab opens url in another tab, with what a step needs to use it: its
// own ev, waitFor, click and type, and close.
async function newTab(url) {
    const { targetId } = await cdp("Target.createTarget", { url });
    const t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((x) => x.id === targetId);
    const tws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((resolve) => (tws.onopen = resolve));
    let n = 0;
    const waiting = new Map();
    tws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        waiting.get(m.id)?.(m);
        waiting.delete(m.id);
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
        const i = ++n;
        waiting.set(i, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
        tws.send(JSON.stringify({ id: i, method, params }));
    });
    const tev = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
    return {
        ev: tev,
        async waitFor(expr, what, ms = 30000) {
            for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) {
                if (await tev(expr).catch(() => false)) {
                    return;
                }
            }
            throw new Error(`timed out waiting for ${what}`);
        },
        async click(expr) {
            const r = await tev(`(() => { const b = (${expr}).getBoundingClientRect(); return {x: b.x + b.width / 2, y: b.y + b.height / 2}; })()`);
            for (const type of ["mousePressed", "mouseReleased"]) {
                await send("Input.dispatchMouseEvent", { type, x: r.x, y: r.y, button: "left", clickCount: 1 });
            }
        },
        async type(text) {
            for (const ch of text) {
                const enter = ch === "\r" ? { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 } : { key: ch };
                await send("Input.dispatchKeyEvent", { type: "keyDown", ...enter, text: ch, unmodifiedText: ch });
                await send("Input.dispatchKeyEvent", { type: "keyUp", ...enter });
            }
        },
        async close() {
            tws.close();
            await cdp("Target.closeTarget", { targetId }).catch(() => {});
        },
    };
}
const listed = `[...document.querySelectorAll("td.name a")].map((a) => a.textContent)`;
const row = (name) => `[...document.querySelectorAll("tr")].find((tr) => tr.querySelector("td.name a")?.textContent === ${JSON.stringify(name)})`;
// answer chooses the primary button of the page's dialog, after typing
// text into it if given.
async function answer(text) {
    await waitFor(`!!document.querySelector("dialog[open]")`, "the dialog");
    if (text !== undefined) {
        await ev(`(() => { const i = document.querySelector("dialog[open] input"); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event("input")); })()`);
    }
    await ev(`document.querySelector("dialog[open] button.primary").click()`);
}
async function waitForFile(p, what) {
    for (const end = Date.now() + 30000; Date.now() < end; await sleep(200)) {
        if (existsSync(p)) {
            return;
        }
    }
    throw new Error(`timed out waiting for ${what}`);
}
const status = `(document.getElementById("uploads")?.textContent || "")`;
async function setFiles(selector, files) {
    const doc = await cdp("DOM.getDocument", {});
    const input = await cdp("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
    if (!input.nodeId) {
        throw new Error(`no ${selector}`);
    }
    await cdp("DOM.setFileInputFiles", { files, nodeId: input.nodeId });
}

// Each page's WebSockets are kept in window.sockets, so a step can close
// them as a lost connection would; while window.offline is set, new ones
// go nowhere, as if the server can't be reached.
const socketHook = `(() => {
    const Real = WebSocket;
    window.sockets = [];
    window.WebSocket = class extends Real {
        constructor(url, ...rest) {
            super(window.offline ? "ws://127.0.0.1:65535/" : url, ...rest);
            window.sockets.push(this);
        }
    };
})()`;
const dropConnections = `window.sockets.filter((s) => s.readyState === 1).forEach((s) => s.close())`;

let failed = false;
async function step(name, fn) {
    try {
        const note = await fn();
        console.log(`ok - ${name}${note ? `: ${note}` : ""}`);
    } catch (err) {
        console.log(`not ok - ${name}: ${err.message}`);
        failed = true;
        throw err;
    }
}

try {
    await cdp("Runtime.enable");
    await cdp("Log.enable");
    await cdp("Page.enable");
    await cdp("DOM.enable");
    await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await cdp("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
    await cdp("Page.addScriptToEvaluateOnNewDocument", { source: socketHook });

    await step("login and desktop", async () => {
        await open("vnc.html?autoconnect=1", `!!document.querySelector("#tabtop_login input")`, "the login form");
        const code = await totp();
        await ev(`(() => { const i = document.querySelector("#tabtop_login input"); i.value = ${JSON.stringify(code)}; i.form.requestSubmit(); })()`);
        await waitFor(`document.documentElement.classList.contains("noVNC_connected")`, "the desktop");
        const size = await ev(`(() => { const c = document.querySelector("#noVNC_container canvas"); return c && c.width && c.height ? c.width + "x" + c.height : ""; })()`);
        if (!size) {
            throw new Error("the desktop has no picture");
        }
        return size;
    });

    await step("audio", async () => {
        await ev(`document.getElementById("noVNC_control_bar_anchor")?.classList.remove("noVNC_idle"); document.getElementById("noVNC_control_bar").classList.add("noVNC_open")`);
        await sleep(800);
        await click(`document.getElementById("tabtop_audio_button")`);  // a real click, for user activation
        await waitFor(`document.getElementById("tabtop_audio_button").title.startsWith("Stop audio")`, "audio to start");
    });

    await step("desktop: links to the terminal and files", async () => {
        const shown = await ev(`["terminal", "files", "logout"].filter((id) => {
            const b = document.getElementById("tabtop_" + id + "_button");
            return b && !b.classList.contains("noVNC_hidden");
        }).join()`);
        if (shown !== "terminal,files,logout") {
            throw new Error(`the control bar has ${shown || "none of them"}`);
        }
    });

    await step("desktop: reconnects", async () => {
        await ev(dropConnections);
        await waitFor(`!document.documentElement.classList.contains("noVNC_connected")`, "the desktop to notice", 5000);
        await waitFor(`document.documentElement.classList.contains("noVNC_connected")`, "the desktop to reconnect", 15000);
        if (await ev(`!!document.querySelector("#tabtop_login")`)) {
            throw new Error("asked for a login again");
        }
    });

    await step("files: list, without a second login", async () => {
        await open("downloads/", `!!document.querySelector("table")`, "the listing");
        const nav = await ev(`[...document.querySelectorAll(".tabtop-nav .page")].map((a) => a.getAttribute("aria-label").split(" ")[0]).join()`);
        if (nav !== "Desktop,Terminal,Files") {
            throw new Error(`the bar at the top holds ${nav}`);
        }
        if (!(await ev(`/^Log out/.test(document.querySelector(".tabtop-nav button.logout svg") && document.querySelector(".tabtop-nav button.logout").getAttribute("aria-label"))`))) {
            throw new Error("Log out isn't an icon");
        }
        if (!(await ev(listed)).includes("hello.txt")) {
            throw new Error(`hello.txt isn't listed: ${await ev(listed)}`);
        }
        const space = await ev(`document.querySelector("p.space")?.textContent ?? ""`);
        if (!/^[\d.]+ [KMGT]?B free of [\d.]+ [KMGT]?B/.test(space)) {
            throw new Error(`the free space shows as ${JSON.stringify(space)}`);
        }
    });

    await step("files: download", async () => {
        await ev(`${row("hello.txt")}.querySelector("button.download").click()`);
        const p = `${downloads}/hello.txt`;
        for (const end = Date.now() + 20000; Date.now() < end && !existsSync(p);) {
            await sleep(200);
        }
        const got = existsSync(p) ? readFileSync(p, "utf8") : "nothing";
        if (got !== "hello from the desktop\n") {
            const shown = await ev(status);
            throw new Error(`downloaded ${JSON.stringify(got)}; the page shows ${JSON.stringify(shown)}`);
        }
    });

    await step("files: preview", async () => {
        await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === "hello.txt").click()`);
        await waitFor(`document.querySelector("dialog.preview[open] pre")?.textContent === "hello from the desktop\\n"`, "hello.txt's text");
        // Download saves the copy the preview holds, here over the one the
        // last step downloaded. A real click: without one, Chrome holds back
        // a second download.
        const p = `${downloads}/hello.txt`;
        rmSync(p);
        await click(`[...document.querySelectorAll("dialog.preview button")].find((b) => b.textContent === "Download")`);
        await waitForFile(p, "hello.txt, from the preview");
        await sleep(500);
        if (readFileSync(p, "utf8") !== "hello from the desktop\n") {
            throw new Error(`the preview's download holds ${JSON.stringify(readFileSync(p, "utf8"))}`);
        }
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "the preview to close");
    });

    await step("files: preview a sound", async () => {
        await open("downloads/#/media/", `${listed}.includes("tone.wav")`, "media/tone.wav");
        await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === "tone.wav").click()`);
        await waitFor(`document.querySelector("dialog.preview audio")?.duration > 0.9`, "the sound to load", 15000);
        await ev(`document.querySelector("dialog.preview").close()`);
        // A picture pasted here is uploaded, named for when.
        await ev(`(() => { const dt = new DataTransfer(); dt.items.add(new File(["png"], "image.png", { type: "image/png" }));
            document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true })); })()`);
        await waitFor(`/Pasted [-\\d]+ [.\\d]+\\.png: uploaded/.test(${status})`, "the pasted picture");
        await waitFor(`${listed}.some((n) => n.startsWith("Pasted "))`, "it to be listed");
        await open("downloads/#/", `document.title === "Downloads /" && !!document.querySelector("table")`, "the listing");
    });

    await step("files: upload", async () => {
        await setFiles(`p.upload input[type=file]:not([webkitdirectory])`, [`${work}/up.bin`]);
        await waitFor(`/up.bin: uploaded/.test(${status})`, "the upload");
        await waitFor(`${listed}.includes("up.bin")`, "up.bin to be listed");
        const when = await ev(`${row("up.bin")}.querySelector("td.mod").textContent`);
        if (!when.startsWith("Today ")) {
            throw new Error(`up.bin's time shows as ${JSON.stringify(when)}`);
        }
    });

    await step("files: upload over a file there, replacing it", async () => {
        await setFiles(`p.upload input[type=file]:not([webkitdirectory])`, [`${work}/up.bin`]);
        await waitFor(`document.querySelector("dialog[open]")?.textContent.includes("already has a file named up.bin")`, "the question");
        await answer();  // Replace
        await waitFor(`(${status}).split("up.bin: uploaded").length === 3`, "the second upload");
        if ((await ev(listed)).some((n) => n.startsWith("up (1)"))) {
            throw new Error("it was kept as another file");
        }
    });

    await step("files: sort", async () => {
        const files = `${listed}.filter((n) => !n.endsWith("/")).join()`;
        const sortBy = (name) => ev(`[...document.querySelectorAll("th button.sort")].find((b) => b.textContent === ${JSON.stringify(name)}).click()`);
        await sortBy("Size");
        await waitFor(`${files} === "up.bin,hello.txt"`, "the biggest first");
        await sortBy("Size");
        await waitFor(`${files} === "hello.txt,up.bin"`, "the smallest first");
        await sortBy("Name");
        await waitFor(`${files} === "hello.txt,up.bin"`, "by name");
    });

    await step("files: filter", async () => {
        const typeFilter = (text) => ev(`(() => { const f = document.querySelector("input.filter"); f.value = ${JSON.stringify(text)}; f.dispatchEvent(new Event("input")); })()`);
        await typeFilter("HELL");
        await waitFor(`${listed}.join() === "hello.txt"`, "only hello.txt");
        await typeFilter("nothing-like-it");
        await waitFor(`${listed}.length === 0 && document.querySelector("tbody").textContent.includes("Nothing here has")`, "nothing");
        await typeFilter("");
        await waitFor(`${listed}.includes("up.bin") && ${listed}.includes("hello.txt")`, "everything again");
    });

    await step("files: the keyboard", async () => {
        const focused = `document.activeElement.textContent`;
        await ev(`document.activeElement.blur()`);
        await press("ArrowDown");
        await waitFor(`${focused} === "media/"`, "the first row");
        await press("ArrowDown");
        await waitFor(`${focused} === "hello.txt"`, "the second row");
        await press(" ");
        await waitFor(`document.querySelector(".selection:not([hidden])")?.textContent.startsWith("1 selected")`, "hello.txt ticked");
        await press(" ");
        await press("ArrowUp");
        await press("Enter");
        await waitFor(`location.hash === "#/media/" && ${focused} === "../"`, "media/, with the focus in its list");
        await press("Backspace");
        await waitFor(`location.hash === "#/" && ${listed}.includes("hello.txt")`, "back up");
    });

    await step("files: delete", async () => {
        await ev(`${row("up.bin")}.querySelector("button.delete").click()`);
        await answer();
        await waitFor(`/up.bin: deleted/.test(${status})`, "the delete");
        await waitFor(`!${listed}.includes("up.bin")`, "up.bin to go");
    });

    await step("files: folder upload, twice", async () => {
        await setFiles(`p.upload input[webkitdirectory]`, [`${work}/up-folder`]);
        await waitFor(`/up-folder\\/: 3 of 3 files uploaded/.test(${status})`, "the folder upload");
        await setFiles(`p.upload input[webkitdirectory]`, [`${work}/up-folder`]);
        await waitFor(`/up-folder\\/: 3 of 3 files uploaded, as up-folder \\(1\\)\\//.test(${status})`, "the second, renamed");
        await open("downloads/#/up-folder%20(1)/sub/deeper/", `${listed}.includes("c.txt")`, "up-folder (1)/sub/deeper/c.txt");
        await open("downloads/#/up-folder/sub/", `${listed}.sort().join() === "../,b.txt,deeper/"`, "up-folder/sub/ to hold deeper/ and b.txt");
        // The heading leads back up.
        const crumbs = await ev(`[...document.querySelectorAll("h1.crumbs a")].map((a) => a.textContent).join()`);
        if (crumbs !== "Downloads,up-folder") {
            throw new Error(`the heading links to ${crumbs}`);
        }
        await ev(`[...document.querySelectorAll("h1.crumbs a")].find((a) => a.textContent === "up-folder").click()`);
        await waitFor(`${listed}.includes("sub/") && ${listed}.includes("a.txt")`, "up-folder/, from the heading");
    });

    await step("files: reconnects", async () => {
        await ev(`window.offline = true; location.hash = "#/up-folder/sub/"`);
        await waitFor(`document.getElementById("tabtop_reconnect")?.textContent.startsWith("Can't reach the server.")`, "the reconnect banner");
        await ev(`window.offline = false; [...document.querySelectorAll("#tabtop_reconnect button")].find((b) => b.textContent === "Try now").click()`);
        await waitFor(`${listed}.includes("b.txt") && !document.getElementById("tabtop_reconnect")`, "up-folder/sub/, once reconnected");
    });

    await step("files: back where it was", async () => {
        // Opened again without a folder, it shows the one last shown.
        await open("downloads/", `location.hash === "#/up-folder/sub/" && ${listed}.includes("b.txt")`, "up-folder/sub/, as last shown");
    });

    await step("files: updates itself", async () => {
        await open("downloads/#/", `${listed}.includes("hello.txt")`, "the listing");
        await ev(`window.notReloaded = true`);
        // What's typed in the filter box and ticked stays.
        await ev(`(() => { const f = document.querySelector("input.filter"); f.value = "hel"; f.dispatchEvent(new Event("input")); })()`);
        await ev(`${row("hello.txt")}.querySelector("td.sel input").click()`);
        await ev(`import("/tabtop/tunnel.js").then((m) => new Promise((resolve) => {
            const s = new m.TunnelSocket({ type: "tty" });
            s.onopen = () => setTimeout(() => { s.send(new TextEncoder().encode("echo new > ~/Downloads/hello-live.txt\\r")); setTimeout(() => { s.close(); resolve(); }, 500); }, 1500);
        }))`);
        await waitFor(`${listed}.includes("hello-live.txt")`, "hello-live.txt to appear by itself", 10000);
        const kept = await ev(`[window.notReloaded, document.querySelector("input.filter").value, ${row("hello.txt")}.querySelector("td.sel input").checked].join()`);
        if (kept !== "true,hel,true") {
            throw new Error(`after the update, reloaded, filter and tick are ${kept}`);
        }
        await ev(`${row("hello.txt")}.querySelector("td.sel input").click(); (() => { const f = document.querySelector("input.filter"); f.value = ""; f.dispatchEvent(new Event("input")); })()`);
        // And deleted, it goes.
        await ev(`import("/tabtop/tunnel.js").then((m) => new Promise((resolve) => {
            const s = new m.TunnelSocket({ type: "tty" });
            s.onopen = () => setTimeout(() => { s.send(new TextEncoder().encode("rm ~/Downloads/hello-live.txt\\r")); setTimeout(() => { s.close(); resolve(); }, 500); }, 1500);
        }))`);
        await waitFor(`!${listed}.includes("hello-live.txt")`, "hello-live.txt to go by itself", 10000);
    });

    await step("files: folder dropped", async () => {
        await open("downloads/#/", `document.title === "Downloads /" && !!document.querySelector("table")`, "the listing");
        const data = { items: [], files: [`${work}/up-folder`], dragOperationsMask: 1 };
        for (const type of ["dragEnter", "dragOver"]) {
            await cdp("Input.dispatchDragEvent", { type, x: 300, y: 300, data });
        }
        const overlay = await ev(`getComputedStyle(document.getElementById("drop_overlay")).display + " " + document.getElementById("drop_overlay").textContent`);
        if (overlay !== "flex Drop to upload into Downloads") {
            throw new Error(`while dragging, the overlay is ${JSON.stringify(overlay)}`);
        }
        await cdp("Input.dispatchDragEvent", { type: "drop", x: 300, y: 300, data });
        await waitFor(`/up-folder\\/: 3 of 3 files uploaded, as up-folder \\(2\\)\\//.test(${status})`, "the dropped folder, renamed");
    });

    await step("files: delete a folder", async () => {
        await ev(`${row("up-folder (1)/")}.querySelector("button.delete").click()`);
        await answer();
        await waitFor(`/up-folder \\(1\\)\\/: deleted/.test(${status})`, "the delete");
        await waitFor(`!${listed}.includes("up-folder (1)/")`, "up-folder (1)/ to go");
    });

    await step("files: download a folder as .zip", async () => {
        await ev(`${row("up-folder/")}.querySelector("button.zip").click()`);
        await waitFor(`/up-folder.zip: downloaded/.test(${status})`, "the zip");
        await waitForFile(`${downloads}/up-folder.zip`, "up-folder.zip");
    });

    await step("files: download several as .zip", async () => {
        for (const name of ["hello.txt", "up-folder/"]) {
            await ev(`${row(name)}.querySelector("td.sel input").click()`);
        }
        await waitFor(`document.querySelector(".selection:not([hidden])")?.textContent.includes("2 selected")`, "the selection bar");
        await ev(`document.querySelector(".selection button.zip").click()`);
        await waitFor(`/Downloads.zip: downloaded/.test(${status})`, "the zip");
        await waitForFile(`${downloads}/Downloads.zip`, "Downloads.zip");
    });

    await step("files: new folder and rename", async () => {
        await ev(`[...document.querySelectorAll("p.upload button")].find((b) => b.textContent === "New folder…").click()`);
        await answer("made-here");
        await waitFor(`${listed}.includes("made-here/")`, "made-here/");
        await ev(`${row("hello.txt")}.querySelector("button.rename").click()`);
        await answer("renamed.txt");
        await waitFor(`${listed}.includes("renamed.txt") && !${listed}.includes("hello.txt")`, "hello.txt renamed");
    });

    await step("files: move, and copy a path", async () => {
        await ev(`${row("renamed.txt")}.querySelector("button.move").click()`);
        await answer("made-here");
        await waitFor(`/renamed.txt: moved to Downloads \\/ made-here/.test(${status}) && !${listed}.includes("renamed.txt")`, "the move");
        await open("downloads/#/made-here/", `${listed}.includes("renamed.txt")`, "made-here/renamed.txt");
        await ev(`${row("renamed.txt")}.querySelector("button.copy").click()`);
        await waitFor(`${status}.includes("Copied ~/Downloads/made-here/renamed.txt")`, "the path copied");
        // Dragged onto "../", back up.
        await ev(`(() => { const dt = new DataTransfer();
            const fire = (target, type) => target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
            fire(${row("renamed.txt")}, "dragstart");
            const up = ${row("../")};
            fire(up, "dragover");
            fire(up, "drop"); })()`);
        await waitFor(`/renamed.txt: moved to Downloads$/.test(${status}) && !${listed}.includes("renamed.txt")`, "the move back");
        await open("downloads/#/", `${listed}.includes("renamed.txt")`, "renamed.txt, back");
    });

    await step("files: retry a failed download", async () => {
        const failedRow = `[...document.querySelectorAll("#uploads p")].find((p) => p.textContent.startsWith("later.txt: not downloaded"))`;
        await ev(`import("/tabtop/download.js").then((m) => { m.fetchFile("later.txt"); })`);
        await waitFor(`!!${failedRow}?.querySelector("button.retry")`, "the failure, with Retry");
        inContainer("sh", "-c", "echo later > ~/Downloads/later.txt");
        await ev(`${failedRow}.querySelector("button.retry").click()`);
        await waitFor(`/later.txt: downloaded/.test(${status}) && !${failedRow}`, "the download, retried");
        await waitForFile(`${downloads}/later.txt`, "later.txt");
    });

    await step("files: end another session", async () => {
        // Logged in somewhere else.
        const code = await totp();
        await ev(`import("/tabtop/tunnel.js").then((m) => m.login(${JSON.stringify(code)})).then(() => true)`);
        // Shown in place of the folder, from the button by Log out.
        const button = `document.querySelector(".tabtop-nav button.security")`;
        await ev(`${button}.click()`);
        await waitFor(`location.hash === "#sessions" && ${button}.getAttribute("aria-pressed") === "true" && !document.querySelector("main table.file-table")`,
            "the sessions, in place of the folder");
        await waitFor(`document.querySelectorAll("#sessions button.end").length === 1`, "the other session, with End…");
        // HeadlessChrome on Linux, as its User-Agent says.
        const named = await ev(`[...document.querySelectorAll("#sessions table:first-of-type tr")].filter((r) => r.textContent.includes("Chrome on Linux")).length`);
        if (named !== 2) {
            throw new Error(`${named} sessions are named Chrome on Linux, not 2`);
        }
        await ev(`document.querySelector("#sessions button.end").click()`);
        await answer();
        await waitFor(`/Ended the session/.test(${status}) && !document.querySelector("#sessions button.end")`, "the session to end");
        await ev(`${button}.click()`);
        await waitFor(`location.hash === "#/" && ${listed}.includes("renamed.txt") && ${button}.getAttribute("aria-pressed") === "false"`,
            "the folder again");
    });

    await step("files: delete several", async () => {
        for (const name of ["made-here/", "renamed.txt"]) {
            await ev(`${row(name)}.querySelector("td.sel input").click()`);
        }
        await ev(`document.querySelector(".selection button.delete").click()`);
        await answer();
        await waitFor(`!${listed}.includes("made-here/") && !${listed}.includes("renamed.txt")`, "both to go");
    });

    await step("files: cancel an upload", async () => {
        await setFiles(`p.upload input[type=file]:not([webkitdirectory])`, [`${work}/big.bin`]);
        // Part way, so the gateway has part of it to delete.
        await waitFor(`/big.bin: [1-9]\\d*%/.test(${status})`, "the upload to get going");
        await waitFor(`/^⇅ \\d+% · /.test(document.title)`, "its progress in the title");
        await ev(`[...document.querySelectorAll("#uploads p")].find((p) => p.textContent.startsWith("big.bin")).querySelector("button.cancel").click()`);
        await waitFor(`/big.bin: cancelled/.test(${status})`, "the cancel");
        await open("downloads/#/", `document.title === "Downloads /" && !!document.querySelector("table")`, "the listing");
        if ((await ev(listed)).includes("big.bin")) {
            throw new Error("big.bin was saved");
        }
    });

    await step("files: files that won't fit together", async () => {
        // Two that fit one at a time, but not both; sparse, so they take
        // no room here, and none is sent.
        const free = Number(inContainer("df", "-B1", "--output=avail", "/home/user/Downloads").split("\n").pop());
        for (const name of ["huge-1.bin", "huge-2.bin"]) {
            writeFileSync(`${work}/${name}`, "");
            truncateSync(`${work}/${name}`, Math.floor(free * 0.6));
        }
        await setFiles(`p.upload input[type=file]:not([webkitdirectory])`, [`${work}/huge-1.bin`, `${work}/huge-2.bin`]);
        const refused = `[...document.querySelectorAll("#uploads p")].filter((p) => /^huge-\\d\\.bin: not uploaded: there isn't room for all 2 files/.test(p.textContent) && p.querySelector("button.retry"))`;
        await waitFor(`${refused}.length === 2`, "both refused, with Retry");
        await ev(`${refused}.forEach((p) => p.remove())`);
        rmSync(`${work}/huge-1.bin`);
        rmSync(`${work}/huge-2.bin`);
        if (inContainer("sh", "-c", "find ~/Downloads -name 'huge-*' -o -name '.tabtop-upload-*'")) {
            throw new Error("something was sent");
        }
    });

    await step("files: carry on with an upload cut off", async () => {
        await setFiles(`p.upload input[type=file]:not([webkitdirectory])`, [`${work}/resume.bin`]);
        await waitFor(`/resume.bin: [1-9]\\d?%/.test(${status})`, "the upload to get going");
        await ev(dropConnections);
        const failedRow = `[...document.querySelectorAll("#uploads p")].find((p) => p.textContent.startsWith("resume.bin: failed"))`;
        await waitFor(`!!${failedRow}?.querySelector("button.retry")`, "the failure, with Retry");
        await ev(`${failedRow}.querySelector("button.retry").click()`);
        await waitFor(`/resume.bin: uploaded/.test(${status})`, "the upload, carried on");
        const log = execFileSync("sh", ["-c", 'docker logs "$1" 2>&1', "sh", container], { encoding: "utf8", maxBuffer: 64 << 20 });
        const resumed = /upload of resume\.bin resumed at ([\d.]+ \w+)/.exec(log);
        if (!resumed) {
            throw new Error("it was sent again from the start");
        }
        const want = createHash("sha256").update(readFileSync(`${work}/resume.bin`)).digest("hex");
        if (inContainer("sha256sum", "/home/user/Downloads/resume.bin").split(" ")[0] !== want) {
            throw new Error("resume.bin was saved wrong");
        }
        return `carried on from ${resumed[1]}`;
    });

    await step("desktop: a file dropped", async () => {
        await open("vnc.html?autoconnect=1", `document.documentElement.classList.contains("noVNC_connected")`, "the desktop");
        const data = { items: [], files: [`${work}/up-folder/sub/b.txt`], dragOperationsMask: 1 };
        for (const type of ["dragEnter", "dragOver"]) {
            await cdp("Input.dispatchDragEvent", { type, x: 600, y: 400, data });
        }
        const overlay = await ev(`getComputedStyle(document.getElementById("drop_overlay")).display + " " + document.getElementById("drop_overlay").textContent`);
        if (overlay !== "flex Drop to upload into Downloads (~/Downloads)") {
            throw new Error(`while dragging, the overlay is ${JSON.stringify(overlay)}`);
        }
        await cdp("Input.dispatchDragEvent", { type: "drop", x: 600, y: 400, data });
        await waitFor(`/b.txt: uploaded/.test(${status})`, "the upload");
        if (await ev(`!!document.querySelector("#tabtop_notices .notice")`)) {
            throw new Error("the upload was told of as a new download");
        }
    });

    await step("desktop: a notice of a file saved", async () => {
        // Saved by a program on the desktop, here through a terminal.
        await ev(`import("/tabtop/tunnel.js").then((m) => new Promise((resolve) => {
            const s = new m.TunnelSocket({ type: "tty" });
            s.onopen = () => setTimeout(() => { s.send(new TextEncoder().encode("echo saved > ~/Downloads/notice.txt\\r")); setTimeout(() => { s.close(); resolve(); }, 500); }, 1500);
        }))`);
        await waitFor(`document.querySelector("#tabtop_notices .notice")?.textContent.includes("notice.txt was saved in Downloads")`, "the notice");
        await click(`document.querySelector("#tabtop_notices .notice button.primary")`);
        await waitForFile(`${downloads}/notice.txt`, "notice.txt, downloaded from the notice");
    });

    await step("desktop: clipboard", async () => {
        const origin = new URL(base).origin;
        await cdp("Browser.grantPermissions", { origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
        await cdp("Emulation.setFocusEmulationEnabled", { enabled: true });
        // From the desktop: as noVNC passes on what Xvnc sends.
        await ev(`import("/app/ui.js").then(({ default: UI }) => UI.rfb.dispatchEvent(new CustomEvent("clipboard", { detail: { text: "from the desktop" } })))`);
        await waitFor(`navigator.clipboard.readText().then((t) => t === "from the desktop")`, "the desktop's text on this clipboard", 5000);
        // To the desktop, on coming back to the tab.
        await ev(`import("/app/ui.js").then(({ default: UI }) => {
            window.pasted = [];
            const real = UI.rfb.clipboardPasteFrom.bind(UI.rfb);
            UI.rfb.clipboardPasteFrom = (t) => { window.pasted.push(t); real(t); };
        })`);
        await ev(`navigator.clipboard.writeText("from this computer").then(() => dispatchEvent(new Event("focus")))`);
        await waitFor(`window.pasted.join() === "from this computer"`, "this computer's text sent to the desktop", 5000);
        // Not sent again, nor back.
        await ev(`dispatchEvent(new Event("focus"))`);
        await sleep(500);
        if (await ev(`window.pasted.length`) !== 1) {
            throw new Error(`sent ${await ev(`JSON.stringify(window.pasted)`)}`);
        }
    });

    await step("terminal", async () => {
        await open("tty/", `!!document.querySelector("canvas")`, "the terminal");
        if (await ev(`!!document.querySelector("#tabtop_login")`)) {
            throw new Error("asked for a login again");
        }
        const nav = await ev(`[...document.querySelectorAll(".tabtop-nav a")].map((a) => a.getAttribute("aria-label").split(" ")[0]).join()`);
        if (nav !== "Desktop,Files") {
            throw new Error(`the bar above the terminal links to ${nav}`);
        }
        await sleep(2000);  // for the shell's prompt
        // Lost, and back by itself: what's typed next goes to the shell.
        await ev(dropConnections);
        await waitFor(`!!document.getElementById("tabtop_reconnect")`, "the reconnect banner", 5000);
        await waitFor(`!document.getElementById("tabtop_reconnect")`, "the terminal to reconnect", 15000);
        await sleep(1000);
        await click(`document.querySelector("canvas")`);
        // A key at a time: the terminal reads key events, not text input.
        for (const ch of "echo tty-$((6*7)) > ~/Downloads/tty-check.txt") {
            await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch });
            await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
        }
        await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
        await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        await sleep(1000);
        // Ctrl = makes the text bigger, kept for next time; Ctrl 0 puts it back.
        await press("=", 2);
        await waitFor(`localStorage.getItem("tabtop-tty-font-size") === "15"`, "a bigger font");
        await press("0", 2);
        await waitFor(`localStorage.getItem("tabtop-tty-font-size") === null`, "the font back as it was");
        await open("downloads/#/", `${listed}.includes("tty-check.txt")`, "tty-check.txt, written in the terminal");
    });

    await step("terminal: a file dropped", async () => {
        await open("tty/", `!!document.querySelector("canvas")`, "the terminal");
        await sleep(2000);
        await click(`document.querySelector("canvas")`);
        await type("cp ");
        const data = { items: [], files: [`${work}/drop me.txt`], dragOperationsMask: 1 };
        for (const type of ["dragEnter", "dragOver"]) {
            await cdp("Input.dispatchDragEvent", { type, x: 600, y: 400, data });
        }
        const overlay = await ev(`getComputedStyle(document.getElementById("drop_overlay")).display + " " + document.getElementById("drop_overlay").textContent`);
        if (!overlay.startsWith("flex Drop to upload into Downloads")) {
            throw new Error(`while dragging, the overlay is ${JSON.stringify(overlay)}`);
        }
        await cdp("Input.dispatchDragEvent", { type: "drop", x: 600, y: 400, data });
        await waitFor(`/drop me.txt: uploaded/.test(${status})`, "the upload");
        await sleep(500);
        // Its path, typed at the cursor: copied with it.
        await type("~/Downloads/dropped-copy.txt");
        await press("Enter");
        await sleep(1000);
        await open("downloads/#/", `${listed}.includes("dropped-copy.txt")`, "dropped-copy.txt, copied from the path typed");
    });

    await step("terminal: search", async () => {
        await open("tty/", `!!document.querySelector("canvas")`, "the terminal");
        await sleep(2000);
        if (await ev(`window.open("javascript:alert(1)")`) !== null) {
            throw new Error("a javascript: link would open");
        }
        await click(`document.querySelector("canvas")`);
        await type("echo needle-$((40+2))");
        await press("Enter");
        await sleep(500);
        // Ctrl+Shift+F, as from the keyboard.
        for (const type of ["keyDown", "keyUp"]) {
            await cdp("Input.dispatchKeyEvent", { type, key: "F", code: "KeyF", windowsVirtualKeyCode: 70, modifiers: 2 | 8 });
        }
        // Opened out in place, in the bar at the top.
        await waitFor(`document.activeElement?.matches(".tabtop-nav #tty_search.open input")`, "the search box");
        await cdp("Input.insertText", { text: "needle-42" });
        await press("Enter");
        const mode = () => inContainer("tmux", "display", "-p", "-t", "web", "#{pane_in_mode} #{search_present} #{search_match}");
        for (const end = Date.now() + 5000; mode() !== "1 1 needle-42"; await sleep(200)) {
            if (Date.now() > end) {
                throw new Error(`tmux's copy mode, search and match: ${mode()}`);
            }
        }
        await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
        await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
        for (const end = Date.now() + 5000; !mode().startsWith("0"); await sleep(200)) {
            if (Date.now() > end) {
                throw new Error("still in copy mode after Esc");
            }
        }
        if (await ev(`document.getElementById("tty_search").classList.contains("open") || !document.querySelector("#tty_search button.search").offsetWidth`)) {
            throw new Error("the search box didn't fold back into the button");
        }
    });

    await step("terminal: touch keys", async () => {
        await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
        await cdp("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: "coarse" }, { name: "any-pointer", value: "coarse" }] });
        try {
            await open("tty/", `!!document.getElementById("touch_keys")`, "the touch keys");
            await sleep(2000);
            await click(`document.querySelector("canvas")`);
            // Ctrl, then U, clears what's typed so far.
            await type("garbage");
            await ev(`[...document.querySelectorAll("#touch_keys button")].find((b) => b.textContent === "Ctrl").click()`);
            await type("u");
            await type("echo keys-ok > ~/Downloads/keys.txt");
            if (await ev(`[...document.querySelectorAll("#touch_keys button")].find((b) => b.textContent === "Ctrl").getAttribute("aria-pressed")`) !== "false") {
                throw new Error("Ctrl stayed on after a key");
            }
            await press("Enter");
            await sleep(1000);
        } finally {
            await cdp("Emulation.setTouchEmulationEnabled", { enabled: false });
            await cdp("Emulation.setEmulatedMedia", { features: [] });
        }
        await open("downloads/#/", `${listed}.includes("keys.txt")`, "keys.txt, written with Ctrl U from the touch keys");
    });

    await step("a warning before the login ends", async () => {
        // A terminal open in another tab, to go on with the new login too.
        const tty = await newTab(base + "tty/");
        try {
            await tty.waitFor(`!!document.querySelector("canvas")`, "the terminal in another tab");
            await open("vnc.html?autoconnect=1", `document.documentElement.classList.contains("noVNC_connected")`, "the desktop");
            const old = await ev(`localStorage.getItem("tabtop_session")`);
            // As if it ends in 5 minutes.
            await ev(`(() => { const s = JSON.parse(localStorage.getItem("tabtop_session")); s.expires = Date.now() + 5 * 60000 - 1000;
                localStorage.setItem("tabtop_session", JSON.stringify(s)); document.dispatchEvent(new Event("visibilitychange")); })()`);
            await waitFor(`/ends in 5 minutes/.test(document.getElementById("tabtop_expiry")?.textContent)`, "the warning on the desktop");
            // The other tab warns too, in its bar.
            await tty.waitFor(`/ends in 5 min/.test(document.querySelector(".tabtop-nav #tabtop_expiry")?.textContent)`, "the warning in the terminal");
            await ev(`[...document.querySelectorAll("#tabtop_expiry button")].find((b) => b.textContent === "Log in again").click()`);
            await waitFor(`!!document.querySelector("#tabtop_login input")`, "the login form");
            const code = await totp();
            await ev(`(() => { const i = document.querySelector("#tabtop_login input"); i.value = ${JSON.stringify(code)}; i.form.requestSubmit(); })()`);
            await waitFor(`!document.querySelector("#tabtop_login") && !document.getElementById("tabtop_expiry")`, "the warning to go");
            await tty.waitFor(`!document.getElementById("tabtop_expiry")`, "the warning to go from the terminal");
            const expires = await ev(`JSON.parse(localStorage.getItem("tabtop_session")).expires - Date.now()`);
            if (expires < 11 * 3600000) {
                throw new Error(`the new login ends in ${expires} ms`);
            }
            // The old login is over: the desktop and the terminal go on
            // with the new one, without asking.
            if (await ev(`import("/tabtop/tunnel.js").then((m) => m.Tunnel.open({ type: "sessions" }, ${old})).then(() => "still works", (e) => e.login ? "" : e.message)`)) {
                throw new Error("the old login still works");
            }
            await sleep(3000);
            await waitFor(`document.documentElement.classList.contains("noVNC_connected") && !document.querySelector("#tabtop_login")`, "the desktop, reconnected");
            if (await tty.ev(`!!document.querySelector("#tabtop_login")`)) {
                throw new Error("the terminal asked for a login when the old one ended");
            }
            const live = await ev(`import("/tabtop/tunnel.js").then((m) => m.request({ type: "sessions" })).then((r) => r.sessions.length)`);
            if (live !== 1) {
                throw new Error(`${live} sessions are live, not just the new one`);
            }
            await tty.click(`document.querySelector("canvas")`);
            await tty.type("echo renewed > ~/Downloads/renewed.txt\r");
            await sleep(1000);
        } finally {
            await tty.close();
        }
        await open("downloads/#/", `${listed}.includes("renewed.txt")`, "renewed.txt, written after the old login ended");
    });

    await step("logout", async () => {
        // An icon here, named for screen readers.
        const out = `document.querySelector(".tabtop-nav button.logout")`;
        await waitFor(`!!${out}`, "the logout button");
        await ev(`${out}.click()`);
        await waitFor(`!!document.querySelector("#tabtop_login")`, "the login form after logout");
        await open("vnc.html?autoconnect=1", `!!document.querySelector("#tabtop_login input")`, "the desktop's login form after logout");
    });

    await step("no uncaught errors in the pages", async () => {
        if (exceptions.length) {
            throw new Error(exceptions.join("; "));
        }
    });
} catch {
    // Reported by step.
}
ws.close();
process.exit(failed ? 1 : 0);
