// Checks a running TabTop end to end in headless Chrome, through the
// pages a person uses: login, desktop, audio, the files page (list,
// download, preview, upload, replacing on a name clash, pasting, the
// keyboard, delete, folder upload picked and dropped, folder delete, zips,
// new folder, rename, move, copying a path, deleting several, cancelling
// an upload), a file dropped on the desktop and the notice of one saved
// there, the terminal (its font size and touch keys), reconnecting after
// the connection is lost on each page, and logout.
// browser-check.sh starts the container and Chrome and runs it; it exits
// non-zero, saying which step failed, if anything doesn't work.
//
// Usage: node browser-check.mjs <devtools port> <site url> <download dir> <work dir>
// The site's TOTP secret must be the Base32 of "12345678901234567890", and
// ~/Downloads must hold hello.txt with "hello from the desktop\n", and
// media/tone.wav, a second of sound. The work
// dir holds up.bin, big.bin (big enough to cancel while it uploads), and
// the folder up-folder: a.txt, sub/b.txt and sub/deeper/c.txt, each holding
// its own name, and the empty folder empty.

import { createHmac } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";

const [port, base, downloads, work] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// totp is the current code, waiting first if the current one is about to
// expire, so it's still good when it arrives.
async function totp() {
    while (30 - (Date.now() / 1000) % 30 < 3) {
        await sleep(500);
    }
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
        cdp("Page.handleJavaScriptDialog", { accept: true });
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
    throw new Error(`timed out waiting for ${what}`);
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
        const nav = await ev(`[...document.querySelectorAll(".tabtop-nav a, .tabtop-nav [aria-current]")].map((a) => a.textContent).join()`);
        if (nav !== "Desktop,Terminal,Files") {
            throw new Error(`the bar at the top holds ${nav}`);
        }
        if (!(await ev(listed)).includes("hello.txt")) {
            throw new Error(`hello.txt isn't listed: ${await ev(listed)}`);
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
        await open("downloads/", `!!document.querySelector("table")`, "the listing");
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

    await step("files: folder dropped", async () => {
        await open("downloads/", `!!document.querySelector("table")`, "the listing");
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
        await open("downloads/", `${listed}.includes("renamed.txt")`, "renamed.txt, back");
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
        await open("downloads/", `!!document.querySelector("table")`, "the listing");
        if ((await ev(listed)).includes("big.bin")) {
            throw new Error("big.bin was saved");
        }
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

    await step("terminal", async () => {
        await open("tty/", `!!document.querySelector("canvas")`, "the terminal");
        if (await ev(`!!document.querySelector("#tabtop_login")`)) {
            throw new Error("asked for a login again");
        }
        const nav = await ev(`[...document.querySelectorAll(".tabtop-nav a")].map((a) => a.textContent).join()`);
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
        await open("downloads/", `${listed}.includes("tty-check.txt")`, "tty-check.txt, written in the terminal");
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
        await open("downloads/", `${listed}.includes("keys.txt")`, "keys.txt, written with Ctrl U from the touch keys");
    });

    await step("logout", async () => {
        await waitFor(`[...document.querySelectorAll("button")].some((b) => b.textContent === "Log out")`, "the logout button");
        await ev(`[...document.querySelectorAll("button")].find((b) => b.textContent === "Log out").click()`);
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
