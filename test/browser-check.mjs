// Checks a running TabTop end to end in headless Chrome, through the
// pages a person uses: login, desktop, audio, the files page (list,
// download, upload, delete, folder upload picked and dropped, folder
// delete, zips, new folder, rename, deleting several, cancelling an
// upload), the terminal, and logout.
// browser-check.sh starts the container and Chrome and runs it; it exits
// non-zero, saying which step failed, if anything doesn't work.
//
// Usage: node browser-check.mjs <devtools port> <site url> <download dir> <work dir>
// The site's TOTP secret must be the Base32 of "12345678901234567890", and
// ~/Downloads must hold hello.txt with "hello from the desktop\n". The work
// dir holds up.bin, big.bin (big enough to cancel while it uploads), and
// the folder up-folder: a.txt, sub/b.txt and sub/deeper/c.txt, each holding
// its own name, and the empty folder empty.

import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

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
        // Leaving the desktop asks first; confirm() is replaced below.
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
async function open(path, ready, what) {
    await cdp("Page.navigate", { url: base + path });
    await waitFor(ready, what);
}
const listed = `[...document.querySelectorAll("td.name a")].map((a) => a.textContent)`;
const row = (name) => `[...document.querySelectorAll("tr")].find((tr) => tr.querySelector("td.name a")?.textContent === ${JSON.stringify(name)})`;
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

    await step("files: list, without a second login", async () => {
        await open("downloads/", `!!document.querySelector("table")`, "the listing");
        if (!(await ev(listed)).includes("hello.txt")) {
            throw new Error(`hello.txt isn't listed: ${await ev(listed)}`);
        }
    });

    await step("files: download", async () => {
        await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === "hello.txt").click()`);
        const p = `${downloads}/hello.txt`;
        for (const end = Date.now() + 20000; Date.now() < end && !existsSync(p);) {
            await sleep(200);
        }
        const got = existsSync(p) ? readFileSync(p, "utf8") : "nothing";
        if (got !== "hello from the desktop\n") {
            const shown = await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent.startsWith("hello.txt"))?.textContent`);
            throw new Error(`downloaded ${JSON.stringify(got)}; the page shows ${JSON.stringify(shown)}`);
        }
    });

    await step("files: upload", async () => {
        await setFiles(`p.upload input[type=file]:not([webkitdirectory])`, [`${work}/up.bin`]);
        await waitFor(`/up.bin: uploaded/.test(${status})`, "the upload");
        await waitFor(`${listed}.includes("up.bin")`, "up.bin to be listed");
    });

    await step("files: delete", async () => {
        await ev(`window.confirm = () => true`);
        await ev(`[...document.querySelectorAll("tr")].find((tr) => tr.querySelector("td.name a")?.textContent === "up.bin").querySelector("button.delete").click()`);
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
    });

    await step("files: folder dropped", async () => {
        await open("downloads/", `!!document.querySelector("table")`, "the listing");
        const data = { items: [], files: [`${work}/up-folder`], dragOperationsMask: 1 };
        for (const type of ["dragEnter", "dragOver", "drop"]) {
            await cdp("Input.dispatchDragEvent", { type, x: 300, y: 300, data });
        }
        await waitFor(`/up-folder\\/: 3 of 3 files uploaded, as up-folder \\(2\\)\\//.test(${status})`, "the dropped folder, renamed");
    });

    await step("files: delete a folder", async () => {
        await ev(`window.confirm = () => true`);
        await ev(`[...document.querySelectorAll("tr")].find((tr) => tr.querySelector("td.name a")?.textContent === "up-folder (1)/").querySelector("button.delete").click()`);
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
        await ev(`window.prompt = () => "made-here"`);
        await ev(`[...document.querySelectorAll("p.upload button")].find((b) => b.textContent === "New folder…").click()`);
        await waitFor(`${listed}.includes("made-here/")`, "made-here/");
        await ev(`window.prompt = () => "renamed.txt"`);
        await ev(`${row("hello.txt")}.querySelector("button.rename").click()`);
        await waitFor(`${listed}.includes("renamed.txt") && !${listed}.includes("hello.txt")`, "hello.txt renamed");
    });

    await step("files: delete several", async () => {
        for (const name of ["made-here/", "renamed.txt"]) {
            await ev(`${row(name)}.querySelector("td.sel input").click()`);
        }
        await ev(`document.querySelector(".selection button.delete").click()`);
        await waitFor(`!${listed}.includes("made-here/") && !${listed}.includes("renamed.txt")`, "both to go");
    });

    await step("files: cancel an upload", async () => {
        await setFiles(`p.upload input[type=file]:not([webkitdirectory])`, [`${work}/big.bin`]);
        // Part way, so the gateway has part of it to delete.
        await waitFor(`/big.bin: [1-9]\\d*%/.test(${status})`, "the upload to get going");
        await ev(`[...document.querySelectorAll("#uploads p")].find((p) => p.textContent.startsWith("big.bin")).querySelector("button.cancel").click()`);
        await waitFor(`/big.bin: cancelled/.test(${status})`, "the cancel");
        await open("downloads/", `!!document.querySelector("table")`, "the listing");
        if ((await ev(listed)).includes("big.bin")) {
            throw new Error("big.bin was saved");
        }
    });

    await step("terminal", async () => {
        await open("tty/", `!!document.querySelector("canvas")`, "the terminal");
        if (await ev(`!!document.querySelector("#tabtop_login")`)) {
            throw new Error("asked for a login again");
        }
        await sleep(2000);  // for the shell's prompt
        await click(`document.querySelector("canvas")`);
        // A key at a time: the terminal reads key events, not text input.
        for (const ch of "echo tty-$((6*7)) > ~/Downloads/tty-check.txt") {
            await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch });
            await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
        }
        await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
        await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        await sleep(1000);
        await open("downloads/", `${listed}.includes("tty-check.txt")`, "tty-check.txt, written in the terminal");
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
