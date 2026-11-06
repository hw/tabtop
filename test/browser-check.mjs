// Checks a running TabTop end to end in headless Chrome, through the pages
// a person uses: login, desktop, audio, the files page (list, free space,
// download, preview, upload, replacing on a name clash, pasting, the
// keyboard, delete, updating itself, going back to the folder last shown,
// folder upload picked and dropped, folder delete, zips, new folder,
// rename, move, copying a path, deleting several, cancelling an upload,
// retrying a failed download, ending another session, which is named by
// its browser, marking a failed login's warning as seen, refusing files
// that won't fit together, and carrying on with an upload whose connection
// was lost), a file dropped on the desktop and the notice of one saved
// there, the desktop's clipboard, the terminal (its font size keys, touch
// keys, a file dropped on it, searching its history, and notifications of
// bells and notify), reconnecting after the connection is lost on each
// page, logging in again when warned the login is ending, and logout.
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
import { createHash, createHmac, randomBytes } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";

const [port, base, downloads, work, container] = process.argv.slice(2);
// inContainer runs a command in the container as its user, and returns
// what it prints.
const inContainer = (...args) => execFileSync("docker", ["exec", "-u", "user", container, ...args], { encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// zipFile is a zip of [name, content] entries, stored, as an EPUB's
// mimetype must be (and the rest may be).
function zipFile(entries) {
    const parts = [];
    const central = [];
    let at = 0;
    for (const [name, content] of entries) {
        const data = Buffer.from(content);
        const nameBytes = Buffer.from(name);
        const head = Buffer.alloc(30);
        head.writeUInt32LE(0x04034b50, 0);
        head.writeUInt16LE(20, 4);
        head.writeUInt32LE(crc32(data), 14);
        head.writeUInt32LE(data.length, 18);
        head.writeUInt32LE(data.length, 22);
        head.writeUInt16LE(nameBytes.length, 26);
        const entry = Buffer.alloc(46);
        entry.writeUInt32LE(0x02014b50, 0);
        entry.writeUInt16LE(20, 4);
        entry.writeUInt16LE(20, 6);
        entry.writeUInt32LE(crc32(data), 16);
        entry.writeUInt32LE(data.length, 20);
        entry.writeUInt32LE(data.length, 24);
        entry.writeUInt16LE(nameBytes.length, 28);
        entry.writeUInt32LE(at, 42);
        parts.push(head, nameBytes, data);
        central.push(entry, nameBytes);
        at += head.length + nameBytes.length + data.length;
    }
    const dir = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(dir.length, 12);
    end.writeUInt32LE(at, 16);
    return Buffer.concat([...parts, dir, end]);
}

// pngSquare is a size×size PNG, blue.
function pngSquare(size) {
    return pngPicture(size, size);
}
function pngPicture(width, height) {
    const chunk = (type, data) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(body));
        return Buffer.concat([len, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;  // bits
    ihdr[9] = 2;  // RGB
    const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [40, 90, 200]).flat())]);
    const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", pixels), chunk("IEND", Buffer.alloc(0))]);
}

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
// cdp sends Chrome method, to the page, or with sessionId, to a target
// attached to (as a frame in a process of its own).
const cdp = (method, params = {}, sessionId = undefined) => new Promise((resolve, reject) => {
    const n = ++id;
    const timer = setTimeout(() => reject(new Error(`${method}: no answer from Chrome`)), 30000);
    pending.set(n, (m) => {
        clearTimeout(timer);
        m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result);
    });
    ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
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
        // A navigation can have created its context before its document root.
        if (await ev(`!!document.documentElement && (${expr})`)) {
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
const keyCodes = { ArrowDown: 40, ArrowUp: 38, Enter: 13, Backspace: 8, Escape: 27, " ": 32, "=": 187, "0": 48, f: 70 };
async function press(key, modifiers = 0) {
    const code = { " ": "Space", "=": "Equal", "0": "Digit0", f: "KeyF" }[key] ?? key;
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
    // The topmost dialog: a question asked over the preview, say.
    const top = `[...document.querySelectorAll("dialog[open]")].at(-1)`;
    await waitFor(`!!${top}`, "the dialog");
    if (text !== undefined) {
        await ev(`(() => { const i = ${top}.querySelector("input"); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event("input")); })()`);
    }
    await ev(`${top}.querySelector("button.primary").click()`);
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

    await step("microphone", async () => {
        // The desktop's own default devices: the browser's microphone in,
        // and its sound still out through tabtop.
        const pulse = (cmd) => inContainer("env", "XDG_RUNTIME_DIR=/tmp/runtime-user", "sh", "-c", cmd);
        const source = pulse("pactl get-default-source");
        const sink = pulse("pactl get-default-sink");
        if (source !== "tabtop_mic_in" || sink !== "tabtop") {
            throw new Error(`default source ${source}, sink ${sink}`);
        }
        // As applications list them.
        const described = (kind, name) => pulse(`pactl list ${kind} | awk '$1 == "Name:" { n = $2 } n == "${name}" && $1 == "Description:" { sub(/^[ \t]*Description: /, ""); print; exit }'`);
        const names = [described("sinks", "tabtop"), described("sources", "tabtop_mic_in")].join(", ");
        if (names !== "TabTop Audio, TabTop Mic") {
            throw new Error(`the devices are named ${names}`);
        }
        await click(`document.getElementById("tabtop_mic_button")`);
        await waitFor(`document.getElementById("tabtop_mic_button").title === "Stop the microphone"`, "the microphone to start");
        // Chrome's fake microphone beeps: what an application on the
        // desktop records from the default source mustn't be silence.
        const peak = Number(pulse(
            "timeout 3 parec -d @DEFAULT_SOURCE@ --raw --format=s16le --rate=48000 --channels=1 | head -c 192000 " +
            "| od -An -td2 -v | awk '{for (i = 1; i <= NF; i++) if ($i > m || -$i > m) m = ($i < 0 ? -$i : $i)} END {print m + 0}'"));
        if (!(peak > 1000)) {
            throw new Error(`the desktop's microphone is silent (peak ${peak})`);
        }
        await click(`document.getElementById("tabtop_mic_button")`);
        await waitFor(`document.getElementById("tabtop_mic_button").title.startsWith("Send your microphone")`, "the microphone to stop");
        return `peak ${peak}`;
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
        await open("fs/", `!!document.querySelector("table")`, "the listing");
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
        // Download downloads it through the tunnel, as the files page
        // does, here over the one the last step downloaded. A real click:
        // without one, Chrome holds back a second download.
        const p = `${downloads}/hello.txt`;
        const downloaded = async (what) => {
            await waitForFile(p, `hello.txt, ${what}`);
            await sleep(500);
            if (readFileSync(p, "utf8") !== "hello from the desktop\n") {
                throw new Error(`${what}, hello.txt holds ${JSON.stringify(readFileSync(p, "utf8"))}`);
            }
        };
        rmSync(p);
        await click(`document.querySelector("dialog.preview button.download")`);
        await downloaded("downloaded from the preview");
        // Direct Download, from its menu: straight over HTTPS, by a link
        // for one download, used up by it.
        rmSync(p);
        await click(`document.querySelector("dialog.preview button.download-more")`);
        await waitFor(`!document.querySelector("dialog.preview .download-menu").hidden`, "the download menu");
        await click(`document.querySelector("dialog.preview button.download-direct")`);
        await downloaded("downloaded directly from the preview");
        if (!(await ev(`document.querySelector("dialog.preview .download-menu").hidden`))) {
            throw new Error("the download menu stayed open");
        }
        // The whole window, and back; kept for the next.
        const width = `document.querySelector("dialog.preview").getBoundingClientRect().width`;
        const boxed = await ev(width);
        await ev(`document.querySelector("dialog.preview button.widen").click()`);
        await waitFor(`${width} === document.documentElement.clientWidth && document.querySelector("dialog.preview button.widen").textContent === "⤡"`,
            "the preview, filling the window (beside any scrollbar, not under it)");
        if (await ev(`localStorage.getItem("tabtop.preview-wide")`) !== "1") {
            throw new Error("filling the window wasn't kept");
        }
        await ev(`document.querySelector("dialog.preview button.widen").click()`);
        await waitFor(`${width} === ${boxed}`, "the preview, a box again");
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "the preview to close");
    });

    await step("files: preview downloads follow a file that can't be shown", async () => {
        await ev(`import("/tabtop/preview.js").then(({ preview }) => {
            window.previewDownloads = [];
            preview("", [{ name: "hello.txt", bytes: 23 }, { name: "missing-preview.png", bytes: 1 }], 0,
                (path) => window.previewDownloads.push(["tunnel", path]),
                { direct: (path) => window.previewDownloads.push(["direct", path]) });
        })`);
        await waitFor(`!!document.querySelector("dialog.preview pre")`, "the first file's preview");
        await ev(`[...document.querySelectorAll("dialog.preview button")].find((b) => b.title === "Next (→)").click()`);
        await waitFor(`document.querySelector("dialog.preview .error")?.textContent.includes("missing-preview.png")`, "the missing file's error");
        await ev(`document.querySelector("dialog.preview button.download").click()`);
        await waitFor(`window.previewDownloads.length === 1`, "the tunnel download callback");
        await ev(`document.querySelector("dialog.preview button.download-more").click();
            document.querySelector("dialog.preview button.download-direct").click()`);
        await waitFor(`window.previewDownloads.length === 2`, "the direct download callback");
        const got = await ev(`window.previewDownloads`);
        const want = [["tunnel", "missing-preview.png"], ["direct", "missing-preview.png"]];
        if (JSON.stringify(got) !== JSON.stringify(want)) {
            throw new Error(`downloads after a failed preview: ${JSON.stringify(got)}`);
        }
        await ev(`delete window.previewDownloads; document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "the preview to close");
    });

    await step("files: preview a sound", async () => {
        await open("fs/#/media/", `${listed}.includes("tone.wav")`, "media/tone.wav");
        await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === "tone.wav").click()`);
        await waitFor(`document.querySelector("dialog.preview audio")?.duration > 0.9`, "the sound to load", 15000);
        await ev(`document.querySelector("dialog.preview").close()`);
        // A picture pasted here is uploaded, named for when.
        await ev(`(() => { const dt = new DataTransfer(); dt.items.add(new File(["png"], "image.png", { type: "image/png" }));
            document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true })); })()`);
        await waitFor(`/Pasted [-\\d]+ [.\\d]+\\.png: uploaded/.test(${status})`, "the pasted picture");
        await waitFor(`${listed}.some((n) => n.startsWith("Pasted "))`, "it to be listed");
        await open("fs/#/", `document.title === "Downloads /" && !!document.querySelector("table")`, "the listing");
    });

    await step("files: preview ZIP contents", async () => {
        const entries = [["folder/", ""], ["hello.txt", "hello"], ["<img src=x onerror=alert(1)>", "inert"]];
        for (let n = 0; n < 650; n++) entries.push([`folder/item-${n}.txt`, "content"]);
        const archive = zipFile(entries);
        const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
        archive.writeUInt16LE(1, central + 8); // Metadata-only encrypted entry.
        const end = archive.subarray(archive.length - 22);
        const directorySize = end.readUInt32LE(12);
        const fake = Buffer.from(archive.subarray(central, central + directorySize));
        fake.write("decoy//", 46);
        writeFileSync(`${work}/listing.zip`, Buffer.concat([archive.subarray(0, archive.length - 22), Buffer.from("GAP!"), fake, end]));
        const encoded = zipFile([["cafe.txt", "x"]]);
        encoded[33] = 0x82; // CP437 é in local and central filenames.
        encoded[encoded.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 49] = 0x82;
        writeFileSync(`${work}/encoding.zip`, encoded);
        writeFileSync(`${work}/empty.zip`, zipFile([]));
        writeFileSync(`${work}/broken.zip`, "not a zip");
        for (const name of ["listing.zip", "encoding.zip", "empty.zip", "broken.zip"]) {
            execFileSync("docker", ["cp", "-q", `${work}/${name}`, `${container}:/home/user/Downloads/media/${name}`]);
            execFileSync("docker", ["exec", container, "chown", "user", `/home/user/Downloads/media/${name}`]);
        }
        await open("fs/#/media/", `${listed}.includes("listing.zip")`, "the ZIP files");
        const show = async (name) => {
            await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === ${JSON.stringify(name)}).click()`);
            await waitFor(`!!document.querySelector("dialog.preview .zip-listing")`, name + " contents");
        };
        const close = async () => {
            await ev(`document.querySelector("dialog.preview button.close").click()`);
            await waitFor(`!document.querySelector("dialog.preview")`, "ZIP preview closed");
        };
        await show("listing.zip");
        const details = await ev(`({ rows: document.querySelectorAll(".zip-table tbody tr").length, text: document.querySelector(".zip-listing").textContent,
            injected: document.querySelectorAll(".zip-table img, .zip-table script, .zip-table a").length })`);
        if ((await ev(`document.querySelector(".zip-table tbody td").textContent`)) !== "folder/") throw new Error("ZIP preview followed the decoy directory");
        if (details.rows !== 500 || !details.text.includes("653 entries") || !details.text.includes("Encrypted") || !details.text.includes("<img src=x onerror=alert(1)>") || details.injected) throw new Error(`ZIP listing: ${JSON.stringify(details)}`);
        await ev(`document.querySelector(".zip-scroll > button").click()`);
        await waitFor(`document.querySelectorAll(".zip-table tbody tr").length === 653`, "all ZIP rows");
        await ev(`(() => { const b = document.querySelector(".zip-filter"); b.value = "item-649"; b.dispatchEvent(new Event("input")); })()`);
        await waitFor(`document.querySelectorAll(".zip-table tbody tr").length === 1 && document.querySelector(".zip-table tbody td").textContent === "folder/item-649.txt"`, "ZIP path filtered");
        await close();
        await show("encoding.zip");
        if ((await ev(`document.querySelector(".zip-table tbody td").textContent`)) !== "café.txt") throw new Error("ZIP legacy filename encoding was lost");
        await ev(`(() => { const b = document.querySelector(".zip-filter"); b.value = "café"; b.dispatchEvent(new Event("input")); })()`);
        if ((await ev(`document.querySelectorAll(".zip-table tbody tr").length`)) !== 1) throw new Error("decoded ZIP name wasn't searchable");
        await close();
        await show("empty.zip");
        if (!(await ev(`document.querySelector(".zip-listing").textContent.includes("0 entries")`))) throw new Error("empty ZIP wasn't listed");
        await close();
        await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === "broken.zip").click()`);
        await waitFor(`document.querySelector("dialog.preview .error")?.textContent.includes("ZIP can't be listed")`, "invalid ZIP error");
        if (!(await ev(`!!document.querySelector("dialog.preview button.download")`))) throw new Error("failed ZIP preview lost Download");
        await close();
        inContainer("sh", "-c", "rm ~/Downloads/media/listing.zip ~/Downloads/media/encoding.zip ~/Downloads/media/empty.zip ~/Downloads/media/broken.zip");
        return "paged and filtered contents, inert filenames, encrypted flag, empty archive and invalid archive handling";
    });

    await step("files: stream large audio and seek", async () => {
        // Valid PCM WAV with sparse silence, above the old 200 MB limit.
        const dataSize = 220000000;
        const header = Buffer.alloc(44);
        header.write("RIFF", 0); header.writeUInt32LE(dataSize + 36, 4);
        header.write("WAVEfmt ", 8); header.writeUInt32LE(16, 16);
        header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
        header.writeUInt32LE(8000, 24); header.writeUInt32LE(16000, 28);
        header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
        header.write("data", 36); header.writeUInt32LE(dataSize, 40);
        writeFileSync(`${work}/range.wav`, header);
        truncateSync(`${work}/range.wav`, dataSize + 44);
        execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=8", "-c:a", "libmp3lame", `${work}/range.mp3`]);
        for (const name of ["range.wav", "range.mp3"]) {
            execFileSync("docker", ["cp", "-q", `${work}/${name}`, `${container}:/home/user/Downloads/media/${name}`]);
            execFileSync("docker", ["exec", container, "chown", "user", `/home/user/Downloads/media/${name}`]);
        }
        await open("fs/#/media/", `${listed}.includes("range.wav") && ${listed}.includes("range.mp3")`, "the audio files");
        await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === "range.wav").click()`);
        const audio = 'document.querySelector("dialog.preview audio")';
        await waitFor(`${audio}?.dataset.streamed === "true" && ${audio}.duration > 13000`, "large WAV metadata", 30000);
        const first = await ev(`Number(${audio}.dataset.bytes)`);
        if (first >= dataSize / 4) throw new Error(`audio metadata fetched ${first} bytes of ${dataSize}`);
        await ev(`${audio}.muted = true; ${audio}.currentTime = 6000; ${audio}.play()`);
        await waitFor(`${audio}.currentTime > 6000.2 && !${audio}.paused`, "audio playback after seeking", 15000);
        await ev(`${audio}.pause()`);
        const range = await ev(`fetch(${audio}.src, { headers: { Range: "bytes=4-15" } }).then(async (r) => ({ status: r.status, type: r.headers.get("Content-Type"), range: r.headers.get("Content-Range"), length: (await r.arrayBuffer()).byteLength }))`);
        if (range.status !== 206 || range.type !== "audio/wav" || range.range !== `bytes 4-15/${dataSize + 44}` || range.length !== 12) throw new Error(`WAV ranges: ${JSON.stringify(range)}`);
        await cdp("ServiceWorker.enable");
        // Hold all eight response channels open, then kill their worker before
        // it can cancel them. Its replacement must reclaim those slots.
        await ev(`(async () => {
            window.audioRestartURL = ${audio}.src;
            ${audio}.removeAttribute("src"); ${audio}.load();
            await new Promise((resolve) => setTimeout(resolve, 200));
            window.audioHeldRequests = [];
            for (let n = 0; n < 8; n++) {
                const abort = new AbortController();
                const response = await fetch(window.audioRestartURL, { headers: { Range: "bytes=1000-" }, signal: abort.signal });
                if (response.status !== 206) throw new Error("couldn't open all eight media channels: " + response.status);
                window.audioHeldRequests.push({ response, abort });
            }
        })()`);
        await cdp("ServiceWorker.stopAllWorkers");
        const resumed = await ev(`fetch(window.audioRestartURL, { headers: { Range: "bytes=0-7" } }).then(async (r) => ({ status: r.status, size: (await r.arrayBuffer()).byteLength }))`);
        if (resumed.status !== 206 || resumed.size !== 8) throw new Error(`audio after worker restart: ${JSON.stringify(resumed)}`);
        await ev(`(async () => {
            for (const { response, abort } of window.audioHeldRequests) {
                abort.abort();
                await response.body.cancel().catch(() => {});
            }
            delete window.audioHeldRequests;
        })()`);
        inContainer("sh", "-c", "printf x >> ~/Downloads/media/range.wav");
        const stale = await ev(`fetch(window.audioRestartURL, { headers: { Range: "bytes=0-15" } }).then((r) => r.arrayBuffer()).then(() => false, () => true)`);
        if (!stale || !(await ev(`${audio}.dataset.error.includes("changed since")`))) throw new Error("changed audio was served as the original version");
        await ev(`window.closedAudio = ${audio}; document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "large audio preview closed");
        if (await ev(`window.closedAudio.hasAttribute("src")`)) throw new Error("closing the preview left audio active");
        await ev(`delete window.closedAudio; delete window.audioRestartURL`);
        // Compressed audio uses the same path and supports native seeking.
        await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === "range.mp3").click()`);
        await waitFor(`${audio}?.dataset.streamed === "true" && ${audio}.duration > 7`, "MP3 metadata", 30000);
        await ev(`${audio}.muted = true; ${audio}.currentTime = 5; ${audio}.play()`);
        await waitFor(`${audio}.currentTime > 5.2 && !${audio}.paused`, "MP3 playback after seeking", 15000);
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "MP3 preview closed");
        inContainer("sh", "-c", "rm ~/Downloads/media/range.wav ~/Downloads/media/range.mp3");
        return `220 MB WAV; ${(first / 1e3).toFixed(0)} KB for metadata, seeking, worker restart, stale-file rejection, cleanup; MP3 playback and seeking`;
    });

    await step("files: stream video ranges and seek", async () => {
        // A real indexed MP4 plus a large free box: previews must work above
        // the old 200 MB limit without collecting the padding into memory.
        execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=12", "-t", "30", "-c:v", "libx264", "-preset", "ultrafast", "-g", "12", "-crf", "24", "-pix_fmt", "yuv420p", "-movflags", "+faststart", `${work}/range.mp4`]);
        const original = readFileSync(`${work}/range.mp4`).length;
        const free = Buffer.alloc(8);
        const padding = 220000000;
        free.writeUInt32BE(padding, 0);
        free.write("free", 4);
        writeFileSync(`${work}/range.mp4`, free, { flag: "a" });
        const size = original + padding;
        truncateSync(`${work}/range.mp4`, size);
        execFileSync("docker", ["cp", "-q", `${work}/range.mp4`, `${container}:/home/user/Downloads/media/range.mp4`]);
        execFileSync("docker", ["exec", container, "chown", "user", "/home/user/Downloads/media/range.mp4"]);
        await open("fs/#/media/", `${listed}.includes("range.mp4")`, "the large video");
        await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === "range.mp4").click()`);
        const video = 'document.querySelector("dialog.preview video")';
        await waitFor(`${video}?.dataset.streamed === "true" && ${video}.readyState >= 1 && ${video}.duration > 29`, "video metadata from ranges", 30000);
        const first = await ev(`Number(${video}.dataset.bytes)`);
        if (first >= size / 4) throw new Error(`video metadata fetched ${first} of ${size} bytes`);
        await ev(`${video}.muted = true; ${video}.currentTime = 24; ${video}.play()`);
        await waitFor(`${video}.currentTime > 24.2 && ${video}.videoWidth === 320`, "playback after seeking", 15000);
        await ev(`${video}.pause()`);
        // Exact, suffix and invalid HTTP ranges through the same transport.
        const ranges = await ev(`(async () => {
            const src = ${video}.src;
            const first = await fetch(src, { headers: { Range: "bytes=0-15" } });
            const bytes = new Uint8Array(await first.arrayBuffer());
            const suffix = await fetch(src, { headers: { Range: "bytes=-512" } });
            const tail = new Uint8Array(await suffix.arrayBuffer());
            const invalid = await fetch(src, { headers: { Range: "bytes=${size}-" } });
            return { first: first.status, length: bytes.length, range: first.headers.get("Content-Range"), signature: String.fromCharCode(...bytes.slice(4,8)),
                suffix: suffix.status, tail: tail.length, zeros: tail.every((b) => b === 0), invalid: invalid.status };
        })()`);
        if (ranges.first !== 206 || ranges.length !== 16 || ranges.range !== `bytes 0-15/${size}` || ranges.signature !== "ftyp" || ranges.suffix !== 206 || ranges.tail !== 512 || !ranges.zeros || ranges.invalid !== 416) throw new Error(`video ranges: ${JSON.stringify(ranges)}`);
        // No transient worker state is needed to resume an open preview.
        await cdp("ServiceWorker.enable");
        await cdp("ServiceWorker.stopAllWorkers");
        const resumed = await ev(`fetch(${video}.src, { headers: { Range: "bytes=8-15" } }).then(async (r) => ({ status: r.status, size: (await r.arrayBuffer()).byteLength }))`);
        if (resumed.status !== 206 || resumed.size !== 8) throw new Error(`video after worker restart: ${JSON.stringify(resumed)}`);
        // A modified file must fail instead of mixing different versions.
        inContainer("sh", "-c", "printf x >> ~/Downloads/media/range.mp4");
        const stale = await ev(`fetch(${video}.src, { headers: { Range: "bytes=0-15" } }).then((r) => r.arrayBuffer()).then(() => false, () => true)`);
        if (!stale || !(await ev(`${video}.dataset.error.includes("changed since")`))) throw new Error("changed video was served as the original version");
        await ev(`window.closedVideo = ${video}; document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "video closed");
        if (await ev(`window.closedVideo.hasAttribute("src")`)) throw new Error("closing the preview left the media source active");
        await ev(`delete window.closedVideo`);
        inContainer("rm", "/home/user/Downloads/media/range.mp4");
        return `${(size / 1e6).toFixed(1)} MB video; ${(first / 1e3).toFixed(0)} KB for metadata, playback after seeking, exact/suffix ranges, worker restart, changed-file rejection and cleanup`;
    });

    await step("files: stream MKV and seek", async () => {
        // Remux the indexed H.264 fixture into Matroska, without transcoding.
        execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", `${work}/range.mp4`, "-c", "copy", `${work}/range.mkv`]);
        execFileSync("docker", ["cp", "-q", `${work}/range.mkv`, `${container}:/home/user/Downloads/media/range.mkv`]);
        execFileSync("docker", ["exec", container, "chown", "user", "/home/user/Downloads/media/range.mkv"]);
        await open("fs/#/media/", `${listed}.includes("range.mkv")`, "the MKV video");
        await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === "range.mkv").click()`);
        const video = 'document.querySelector("dialog.preview video")';
        await waitFor(`${video}?.dataset.streamed === "true" && ${video}.readyState >= 1 && ${video}.duration > 29`, "MKV metadata from ranges", 30000);
        await ev(`${video}.muted = true; ${video}.currentTime = 24; ${video}.play()`);
        await waitFor(`${video}.currentTime > 24.2 && ${video}.videoWidth === 320`, "MKV playback after seeking", 15000);
        const range = await ev(`fetch(${video}.src, { headers: { Range: "bytes=0-15" } }).then(async (r) => ({ status: r.status, type: r.headers.get("Content-Type"), length: (await r.arrayBuffer()).byteLength }))`);
        if (range.status !== 206 || range.type !== "video/x-matroska" || range.length !== 16) throw new Error(`MKV range: ${JSON.stringify(range)}`);
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "MKV preview closed");
        inContainer("rm", "/home/user/Downloads/media/range.mkv");
        return "Matroska/H.264 streamed, played and sought using byte ranges";
    });

    await step("files: preview text in colour", async () => {
        inContainer("sh", "-c", `cd ~/Downloads/media && printf 'def greet(name):\\n    return f"hi {name}"  # say hi\\n' > colours.py `
            + `&& printf 'package main\\r\\n\\r\\nfunc main() {}\\r\\n' > crlf.go `
            + `&& printf '<img src=x onerror="document.title=1"><script>document.title=2</script>\\n' > page.html`);
        await open("fs/#/media/", `${listed}.includes("colours.py") && ${listed}.includes("page.html")`, "the files to preview");
        const show = async (name) => {
            await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === ${JSON.stringify(name)}).click()`);
            await waitFor(`!!document.querySelector("dialog.preview[open] pre")`, name);
        };
        const close = async () => {
            await ev(`document.querySelector("dialog.preview button.close").click()`);
            await waitFor(`!document.querySelector("dialog.preview")`, "the preview to close");
        };
        await show("colours.py");
        await waitFor(`document.querySelector("dialog.preview pre.coloured code.language-python .hljs-keyword")?.textContent === "def"`,
            "colours.py in colour");
        if (await ev(`document.querySelector("dialog.preview pre").textContent`) !== 'def greet(name):\n    return f"hi {name}"  # say hi\n') {
            throw new Error("colours.py's text isn't shown as it is");
        }
        await close();
        await show("crlf.go");
        await waitFor(`document.querySelector("dialog.preview pre.coloured .hljs-keyword")?.textContent === "package"`, "crlf.go in colour");
        await close();
        // A web page's source: coloured, and only ever text.
        await ev(`localStorage.setItem("tabtop.html-view", "source")`);
        const title = await ev("document.title");
        await show("page.html");
        await waitFor(`!!document.querySelector("dialog.preview pre.coloured .hljs-tag")`, "page.html in colour");
        if (await ev(`!!document.querySelector("dialog.preview pre img, dialog.preview pre script")`)
            || !(await ev(`document.querySelector("dialog.preview pre").textContent.startsWith("<img src=x")`))
            || await ev("document.title") !== title) {
            throw new Error("page.html's source was made into elements");
        }
        await close();
        await ev(`localStorage.removeItem("tabtop.html-view")`);
        inContainer("sh", "-c", "cd ~/Downloads/media && rm colours.py crlf.go page.html");
        await open("fs/#/", `document.title === "Downloads /" && !!document.querySelector("table")`, "the listing");
        return "Python, Go with CRLF, and HTML's source as text";
    });

    const inMarkdownFrame = (expr) => inFrame("md-frame.html", expr);
    const inFrame = async (page, expr) => {
        const { targetInfos } = await cdp("Target.getTargets");
        const target = targetInfos.find((t) => t.type === "iframe" && t.url.includes(page));
        if (!target) {
            throw new Error(`no ${page} frame`);
        }
        const { sessionId } = await cdp("Target.attachToTarget", { targetId: target.targetId, flatten: true });
        try {
            const r = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true }, sessionId);
            if (r.exceptionDetails) {
                throw new Error(`${expr}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
            }
            return r.result.value;
        } finally {
            await cdp("Target.detachFromTarget", { sessionId }).catch(() => {});
        }
    };
    const checkPreviewLink = async (framePage, click, url) => {
        const prompt = 'document.querySelector("dialog.preview-link[open]")';
        const before = (await cdp("Target.getTargets")).targetInfos.filter((t) => t.type === "page").length;
        await inFrame(framePage, click);
        await waitFor(`!!${prompt}`, "the external link prompt");
        if ((await ev(`${prompt}.querySelector(".link-url").textContent`)) !== url) throw new Error("the prompt shows the wrong URL");
        const after = (await cdp("Target.getTargets")).targetInfos.filter((t) => t.type === "page").length;
        if (after !== before) throw new Error("a preview link opened before confirmation");
        await cdp("Browser.grantPermissions", { origin: new URL(base).origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
        await ev(`[...${prompt}.querySelectorAll("button")].find((b) => b.textContent === "Copy URL").click()`);
        await waitFor(`${prompt}?.querySelector('[role="status"]').textContent === "URL copied"`, "the URL copied");
        if ((await ev(`navigator.clipboard.readText()`)) !== url) throw new Error("the copied URL differs from the link");
        await press("Escape");
        try {
            await waitFor(`!${prompt} && !!document.querySelector("dialog.preview[open]")`, "only the link prompt closed", 5000);
        } catch (err) {
            throw new Error(`${err.message}: ${JSON.stringify(await ev(`({ dialogs: [...document.querySelectorAll("dialog")].map((d) => ({className: d.className, open: d.open})), focused: document.activeElement?.outerHTML.slice(0, 200) })`))}`);
        }
        // Middle-click also asks. Confirm without fetching an external site.
        await inFrame(framePage, click.replace('.click()', '.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }))'));
        await waitFor(`!!${prompt}`, "the middle-click prompt");
        await ev(`window.previewRealOpen = window.open; window.previewOpened = null; window.open = (...args) => { window.previewOpened = args; };`);
        try {
            await ev(`[...${prompt}.querySelectorAll("button")].find((b) => b.textContent === "Open in browser").click()`);
            const opened = await ev(`window.previewOpened`);
            if (JSON.stringify(opened) !== JSON.stringify([url, "_blank", "noopener,noreferrer"])) throw new Error(`external open: ${JSON.stringify(opened)}`);
            await waitFor(`!${prompt}`, "the confirmed prompt closed");
        } finally {
            await ev(`window.open = window.previewRealOpen; delete window.previewRealOpen; delete window.previewOpened;`);
        }
    };
    await step("files: preview HTML safely", async () => {
        const html = `<!doctype html><html><head><title>Untrusted title</title>
            <base href="https://example.com/"><meta http-equiv="refresh" content="0;url=https://example.com/">
            <link rel="stylesheet" href="https://example.com/style.css"><style>@import 'https://example.com/import.css';</style>
            <script>parent.postMessage('html-ran', '*')</script></head><body onload="parent.postMessage('html-ran', '*')">
            <h1 id="top">HTML preview</h1><p id="styled" style="color: rgb(12, 34, 56); font-weight: bold; position: fixed; background-image: url(https://example.com/css.png)" onclick="parent.postMessage('html-ran', '*')">Styled text</p>
            <table><tr><th>Heading</th><td>Cell</td></tr></table><img src="htmlpic.png" alt="Local"><img src="https://example.com/track.png" alt="Remote">
            <iframe src="https://example.com/"></iframe><object data="https://example.com/"></object><form action="https://example.com/"><input autofocus><button>Submit</button></form>
            <svg onload="parent.postMessage('html-ran', '*')"><script>parent.postMessage('html-ran', '*')</script></svg>
            <a href="javascript:parent.postMessage('html-ran','*')">Bad link</a><a href="https://example.com/">Web</a><a href="next.htm#part">Next file</a>
            ${'<p>More readable content.</p>'.repeat(80)}<h2 id="end">End</h2><a href="#top">Top</a></body></html>`;
        writeFileSync(`${work}/demo.html`, html);
        writeFileSync(`${work}/next.htm`, `<h1>Next file</h1>${'<p>Filler.</p>'.repeat(50)}<h2 id="part">Part</h2>`);
        writeFileSync(`${work}/htmlpic.png`, pngSquare(40));
        for (const name of ["demo.html", "next.htm", "htmlpic.png"]) {
            execFileSync("docker", ["cp", "-q", `${work}/${name}`, `${container}:/home/user/Downloads/media/${name}`]);
            execFileSync("docker", ["exec", container, "chown", "user", `/home/user/Downloads/media/${name}`]);
        }
        await open("fs/#/media/", `${listed}.includes("demo.html")`, "HTML files");
        await ev(`window.htmlRan = 0; window.addEventListener("message", (e) => { if (e.data === "html-ran") window.htmlRan++; }); localStorage.removeItem("tabtop.html-view");`);
        const show = async () => {
            await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === "demo.html").click()`);
            await waitFor(`JSON.parse(document.querySelector("dialog.preview iframe.html")?.dataset.rendered ?? "null")?.images === 1`, "HTML rendered with its local image");
        };
        await show();
        const details = await inFrame("md-frame.html", `(() => {
            const doc = document.getElementById("doc"), styled = getComputedStyle(document.getElementById("styled"));
            return { bad: doc.querySelectorAll("script, style, link, meta, base, iframe, object, form, input, button, svg, math, [onclick], [onload], [srcset]").length,
                badLinks: [...doc.querySelectorAll("a[href]")].some((a) => /^javascript:/i.test(a.getAttribute("href"))),
                text: doc.textContent, color: styled.color, position: styled.position, background: styled.backgroundImage,
                width: document.querySelector("img")?.naturalWidth, height: innerHeight };
        })()`);
        if (details.bad || details.badLinks || !details.text.includes("Styled text") || !details.text.includes("Cell") || details.color !== "rgb(12, 34, 56)" || details.position !== "static" || details.background !== "none" || details.height < 300 || await ev(`window.htmlRan`)) {
            throw new Error(`HTML sanitation: ${JSON.stringify(details)}`);
        }
        await checkPreviewLink("md-frame.html", `document.querySelector('a[href="https://example.com/"]').click()`, "https://example.com/");
        // Heading history and history across .html/.htm files.
        await inFrame("md-frame.html", `document.getElementById("end").scrollIntoView()`);
        const at = await inFrame("md-frame.html", `scrollY`);
        await inFrame("md-frame.html", `document.querySelector('a[href="#top"]').click()`);
        await waitFor(`!document.querySelector("dialog.preview button.back").hidden`, "HTML heading history");
        await ev(`document.querySelector("dialog.preview button.back").click()`);
        await sleep(100);
        if (Math.abs((await inFrame("md-frame.html", `scrollY`)) - at) > 3) throw new Error("HTML Back lost the heading position");
        await inFrame("md-frame.html", `document.querySelector('a[href="next.htm#part"]').click()`);
        await waitFor(`document.querySelector("dialog.preview .head strong").textContent === "next.htm" && !!document.querySelector("dialog.preview iframe.html")?.dataset.rendered`, "linked HTM file");
        await ev(`document.querySelector("dialog.preview button.back").click()`);
        await waitFor(`document.querySelector("dialog.preview .head strong").textContent === "demo.html" && !!document.querySelector("dialog.preview iframe.html")?.dataset.rendered`, "Back to the HTML file");
        if (Math.abs((await inFrame("md-frame.html", `scrollY`)) - at) > 3) throw new Error("HTML Back lost the file position");
        await ev(`document.querySelector('dialog.preview button[aria-label="Source: the HTML as written"]').click()`);
        await waitFor(`document.querySelector("dialog.preview pre")?.textContent.includes("<script>")`, "HTML source");
        await ev(`document.querySelector('dialog.preview button[aria-label="Rendered: the HTML as it reads"]').click()`);
        await waitFor(`!!document.querySelector("dialog.preview iframe.html")?.dataset.rendered`, "HTML rendered again");
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "HTML preview closed");
        await show();
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "HTML preview closed again");
        inContainer("sh", "-c", "cd ~/Downloads/media && rm demo.html next.htm htmlpic.png");
        return "sanitized HTML and inline formatting, local images, source toggle, web link confirmation and Back history";
    });

    await step("files: preview Markdown, rendered", async () => {
        writeFileSync(`${work}/doc.md`, "# Notes\n\nInline $e^{i\\pi} + 1 = 0$, and on its own:\n\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$\n\n| Thing | Count |\n|:--|--:|\n| apples | 3 |\n\n```go\nfunc main() { fmt.Println(\"hi\") }\n```\n\n```mermaid\ngraph LR; A[Start] --> B[End]\n```\n\n![pixel](pic.png) ![remote](https://example.com/x.png)\n\n<script>document.title = \"ran\"</script>\n");
        execFileSync("docker", ["cp", "-q", `${work}/doc.md`, `${container}:/home/user/Downloads/media/doc.md`]);
        inContainer("sh", "-c", "echo iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg== "
            + "| base64 -d > ~/Downloads/media/pic.png");
        execFileSync("docker", ["exec", container, "chown", "user", "/home/user/Downloads/media/doc.md"]);
        await open("fs/#/media/", `${listed}.includes("doc.md") && ${listed}.includes("pic.png")`, "doc.md");
        const title = await ev("document.title");
        await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === "doc.md").click()`);
        await waitFor(`!!document.querySelector("dialog.preview iframe.markdown")?.dataset.rendered`, "doc.md, rendered", 60000);
        const report = JSON.parse(await ev(`document.querySelector("dialog.preview iframe.markdown").dataset.rendered`));
        if (report.math !== 2 || report.diagrams !== 1 || report.code !== 1 || report.images !== 1 || report.remote !== 1 || report.errors.length) {
            throw new Error(`rendered: ${JSON.stringify(report)}`);
        }
        const sandbox = await ev(`document.querySelector("dialog.preview iframe.markdown").getAttribute("sandbox")`);
        if (sandbox.includes("allow-same-origin") || await ev("document.title") !== title) {
            throw new Error(`the frame is sandboxed as "${sandbox}", or something in it ran here`);
        }
        // Its source, coloured; and back; the choice remembered.
        await ev(`document.querySelector('dialog.preview .views button[aria-pressed="false"]').click()`);
        await waitFor(`document.querySelector("dialog.preview pre.coloured")?.textContent.startsWith("# Notes")`, "doc.md's source");
        if (await ev(`localStorage.getItem("tabtop.markdown-view")`) !== "source") {
            throw new Error("the choice of source wasn't kept");
        }
        await ev(`document.querySelector('dialog.preview .views button[aria-pressed="false"]').click()`);
        await waitFor(`!!document.querySelector("dialog.preview iframe.markdown")?.dataset.rendered`, "doc.md, rendered again", 60000);
        // Dark, as chosen (◐, ☀, then ☾), and kept, for the next opened.
        const themeButton = `document.querySelector("dialog.preview button.theme")`;
        const frameTheme = `(document.documentElement.dataset.theme ?? "") + " " + getComputedStyle(document.body).backgroundColor`;
        await ev(`${themeButton}.click()`);
        await ev(`${themeButton}.click()`);
        for (let i = 0; await inMarkdownFrame(frameTheme) !== "dark rgb(28, 28, 30)"; i++) {
            if (i === 20) {
                throw new Error(`the frame, set dark: ${await inMarkdownFrame(frameTheme)}`);
            }
            await sleep(100);
        }
        if (await ev(`localStorage.getItem("tabtop.reading-theme")`) !== "dark" || await ev(`${themeButton}.textContent`) !== "☾") {
            throw new Error("dark wasn't kept");
        }
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "the preview to close");
        await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === "doc.md").click()`);
        await waitFor(`!!document.querySelector("dialog.preview iframe.markdown")?.dataset.rendered`, "doc.md, opened again", 60000);
        if (await inMarkdownFrame(frameTheme) !== "dark rgb(28, 28, 30)") {
            throw new Error(`opened again: ${await inMarkdownFrame(frameTheme)}`);
        }
        // Back to as the system is.
        await ev(`${themeButton}.click()`);
        await waitFor(`localStorage.getItem("tabtop.reading-theme") === ""`, "the system's theme again");
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "the preview to close");
        inContainer("sh", "-c", "cd ~/Downloads/media && rm doc.md pic.png");
        await open("fs/#/", `document.title === "Downloads /" && !!document.querySelector("table")`, "the listing");
        return `math ${report.math}, diagrams ${report.diagrams}, code ${report.code}, pictures ${report.images}, remote left out ${report.remote}`;
    });

    // inMarkdownFrame evaluates expr in the preview's Markdown frame, which
    // the page itself can't reach: it's sandboxed, with an origin of its own.
    // Chrome runs it in a process of its own, as a target to attach to.
    const rendered = `JSON.parse(document.querySelector("dialog.preview iframe.markdown")?.dataset.rendered ?? "null")`;

    await step("files: Markdown links, front matter and contents", async () => {
        inContainer("sh", "-c", "mkdir -p ~/Downloads/media/more");
        writeFileSync(`${work}/index.md`, "---\ntitle: Index\ntags: [check]\n---\n# Index\n\n## One\n\n## Two\n\n## Three\n\nSee [the page](more/page.md#part-two). [Web](https://example.com/).\n");
        writeFileSync(`${work}/page.md`, "# Page\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\n## Part two\n\nBack [to the index](../index.md).\n");
        for (const [from, to] of [["index.md", "media/index.md"], ["page.md", "media/more/page.md"]]) {
            execFileSync("docker", ["cp", "-q", `${work}/${from}`, `${container}:/home/user/Downloads/${to}`]);
            execFileSync("docker", ["exec", container, "chown", "user", `/home/user/Downloads/${to}`]);
        }
        await open("fs/#/media/", `${listed}.includes("index.md")`, "index.md");
        await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === "index.md").click()`);
        await waitFor(`${rendered}?.contents === 4`, "index.md, rendered with its contents");
        if (!(await ev(`${rendered}.frontMatter`))) {
            throw new Error("index.md's front matter isn't folded away");
        }
        await checkPreviewLink("md-frame.html", `document.querySelector('a[href="https://example.com/"]').click()`, "https://example.com/");
        // Its link to another file, in another folder: opened here, at
        // the heading it names, with Back.
        await ev(`document.querySelector("dialog.preview iframe.markdown").dataset.rendered = ""`);
        await inMarkdownFrame(`document.querySelector('a[href="more/page.md#part-two"]').click()`);
        await waitFor(`document.querySelector("dialog.preview .head strong").textContent === "media/more/page.md" && !!${rendered}
            && !document.querySelector("dialog.preview button.back").hidden`, "page.md, from the link");
        if ((await ev(`${rendered}.scrolled`)) < 100) {
            throw new Error("page.md wasn't scrolled to Part two");
        }
        const linkedPosition = await inMarkdownFrame(`scrollY`);
        await inMarkdownFrame(`(() => { const a = document.createElement("a"); a.href = "#page"; document.getElementById("doc").append(a); a.click(); })()`);
        if ((await inMarkdownFrame(`scrollY`)) > 100) throw new Error("Markdown heading link didn't jump to the top");
        await ev(`document.querySelector("dialog.preview button.back").click()`);
        await sleep(100);
        if (Math.abs((await inMarkdownFrame(`scrollY`)) - linkedPosition) > 3) throw new Error("Markdown Back lost the heading position");
        await ev(`document.querySelector("dialog.preview button.back").click()`);
        await waitFor(`document.querySelector("dialog.preview .head strong").textContent === "index.md"
            && document.querySelector("dialog.preview button.back").hidden`, "back at index.md");
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "the preview to close");
        return "contents of 4, front matter folded, a link followed to its heading, and back";
    });

    await step("files: edit a file and save it", async () => {
        inContainer("sh", "-c", "printf '#!/bin/sh\\r\\necho one\\r\\n' > ~/Downloads/media/edit.sh && chmod 755 ~/Downloads/media/edit.sh");
        const statEdit = () => inContainer("stat", "-c", "%y %s inode %i", "/home/user/Downloads/media/edit.sh");
        const made = statEdit();
        await open("fs/#/media/", `${listed}.includes("edit.sh")`, "edit.sh");
        const preview = async (name) => {
            await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === ${JSON.stringify(name)}).click()`);
            await waitFor(`!!document.querySelector("dialog.preview button.edit:not([hidden])")`, `${name}, with Edit`);
            await ev(`document.querySelector("dialog.preview button.edit").click()`);
            await waitFor(`!!document.querySelector("dialog.preview textarea.editor")`, `${name}'s editor`);
        };
        const type = (text) => ev(`(() => { const b = document.querySelector("dialog.preview textarea.editor"); b.value = ${JSON.stringify(text)};
            b.dispatchEvent(new Event("input")); })()`);
        const saveKeys = () => ev(`document.querySelector("dialog.preview textarea.editor").dispatchEvent(new KeyboardEvent("keydown",
            { key: "s", ctrlKey: true, bubbles: true }))`);
        // In brackets: in "a ?? b === c", === goes first.
        const note = `(document.querySelector("dialog.preview .edit-status")?.textContent ?? "")`;
        await preview("edit.sh");
        if (await ev(`document.querySelector("dialog.preview textarea.editor").value`) !== "#!/bin/sh\necho one\n") {
            throw new Error("the editor doesn't hold edit.sh's text");
        }
        await type("#!/bin/sh\necho two\n");
        await saveKeys();
        await waitFor(`${note} === "Saved."`, "the save");
        // Its line endings and permissions, kept.
        const held = inContainer("sh", "-c", "od -An -c ~/Downloads/media/edit.sh | tr -s ' '");
        const want = inContainer("sh", "-c", "printf '#!/bin/sh\\r\\necho two\\r\\n' | od -An -c | tr -s ' '");
        const mode = inContainer("stat", "-c", "%a", "/home/user/Downloads/media/edit.sh");
        if (held !== want || mode !== "755") {
            // What the editor had, when the save's answer says the file
            // changed, and the file then and a little later.
            const box = await ev(`document.querySelector("dialog.preview textarea.editor")?.value`);
            const replied = await ev(`document.querySelector("dialog.preview .edit-status")?.dataset.mtime`);
            const stat = statEdit();
            await sleep(2000);
            const later = inContainer("sh", "-c", "od -An -c ~/Downloads/media/edit.sh | tr -s ' '");
            throw new Error(`edit.sh holds ${JSON.stringify(held)}, mode ${mode}; want ${JSON.stringify(want)}, 755. `
                + `The editor had ${JSON.stringify(box)}; the save answered mtime ${replied}; the file was made ${made}, was ${stat} `
                + `when read, and 2 s later is ${statEdit()}, holding ${JSON.stringify(later)}`);
        }
        // Changed meanwhile, by something else: not saved over.
        inContainer("sh", "-c", "sleep 0.01; echo '# added elsewhere' >> ~/Downloads/media/edit.sh");
        await type("#!/bin/sh\necho three\n");
        await saveKeys();
        await waitFor(`${note}.includes("Not saved: It's been changed since it was opened")`, "the save refused");
        if (!inContainer("cat", "/home/user/Downloads/media/edit.sh").includes("added elsewhere")) {
            throw new Error("the save went over the change made elsewhere");
        }
        // Done, with changes not saved: asked first.
        await ev(`document.querySelector("dialog.preview button.done-edit").click()`);
        await waitFor(`(document.querySelectorAll("dialog[open]")[1]?.textContent ?? "").includes("aren't saved")`, "the question");
        await answer();
        await waitFor(`!document.querySelector("dialog.preview textarea.editor")`, "editing ended");
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "the preview to close");
        // Markdown: rendered beside it, as it's typed.
        await preview("index.md");
        await waitFor(`!!document.querySelector("dialog.preview .editing iframe.markdown")?.dataset.rendered`, "index.md, rendered beside it");
        await ev(`document.querySelector("dialog.preview .editing iframe.markdown").dataset.rendered = ""`);
        await type("# Changed\n\n$x^2$\n");
        await waitFor(`JSON.parse(document.querySelector("dialog.preview .editing iframe.markdown").dataset.rendered || "null")?.math === 1`,
            "the change, rendered");

        await ev(`document.querySelector("dialog.preview button.done-edit").click()`);
        await answer();
        await waitFor(`!document.querySelector("dialog.preview textarea.editor")`, "editing ended");
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "the preview to close");
        inContainer("sh", "-c", "cd ~/Downloads/media && rm -r edit.sh index.md more");
        await open("fs/#/", `document.title === "Downloads /" && !!document.querySelector("table")`, "the listing");
        return "CRLF and 755 kept, a stale save refused, unsaved changes asked about, Markdown rendered as typed";
    });

    await step("files: preview a PDF, a part at a time", async () => {
        // 40 pages: the first with text and a link, each after with a big
        // picture that doesn't compress, so most of the file is pages not
        // looked at yet.
        writeFileSync(`${work}/pdf-source.html`, `<!doctype html><style>@page { size: A4; margin: 1cm } section { page-break-after: always }
            canvas { width: 17cm; height: 17cm }</style>
            <section><h1>A PDF</h1><p>The first page, with <a href="https://example.com/">a link to example.com</a>. <a href="#page-three">Jump ahead</a></p></section>
            ${Array.from({ length: 39 }, (_, i) => `<section id="${i === 1 ? "page-three" : "p" + (i + 2)}"><h2>Page ${i + 2}</h2><canvas width="900" height="900"></canvas></section>`).join("")}
            <script>for (const c of document.querySelectorAll("canvas")) { const x = c.getContext("2d"), d = x.createImageData(900, 900);
            for (let i = 0; i < d.data.length; i++) d.data[i] = Math.random() * 256 | 0; x.putImageData(d, 0, 0); } window.done = true;</script>`);
        // And 10 pages of pictures alone, as a scanned PDF is.
        writeFileSync(`${work}/scanned-source.html`, `<!doctype html><style>@page { size: A4; margin: 1cm } div { page-break-after: always }
            canvas { width: 10cm; height: 10cm }</style>
            ${Array.from({ length: 10 }, () => `<div><canvas width="60" height="60"></canvas></div>`).join("")}
            <script>for (const c of document.querySelectorAll("canvas")) { const x = c.getContext("2d"); x.fillStyle = "#468"; x.fillRect(5, 5, 50, 50); }
            window.done = true;</script>`);
        const printed = async (source, name) => {
            await cdp("Page.navigate", { url: `file://${work}/${source}` });
            await waitFor("window.done === true", `${name}'s source`);
            const { stream } = await cdp("Page.printToPDF", { printBackground: true, transferMode: "ReturnAsStream" });
            const parts = [];
            for (;;) {
                const r = await cdp("IO.read", { handle: stream, size: 1 << 20 });
                parts.push(Buffer.from(r.data, r.base64Encoded ? "base64" : "utf8"));
                if (r.eof) {
                    break;
                }
            }
            await cdp("IO.close", { handle: stream });
            const pdf = Buffer.concat(parts);
            writeFileSync(`${work}/${name}`, pdf);
            execFileSync("docker", ["cp", "-q", `${work}/${name}`, `${container}:/home/user/Downloads/media/${name}`]);
            execFileSync("docker", ["exec", container, "chown", "user", `/home/user/Downloads/media/${name}`]);
            return pdf;
        };
        const pdf = await printed("pdf-source.html", "big.pdf");
        await printed("scanned-source.html", "scanned.pdf");

        await open("fs/#/media/", `${listed}.includes("big.pdf")`, "big.pdf");
        await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === "big.pdf").click()`);
        const report = `JSON.parse(document.querySelector("dialog.preview iframe.pdf")?.dataset.rendered ?? "null")`;
        const fetched = `Number(document.querySelector("dialog.preview iframe.pdf")?.dataset.bytes ?? 0)`;
        await waitFor(`${report}?.pages === 40 && ${report}.drawn.includes(1)`, "big.pdf's first page", 60000);
        const first = await ev(fetched);
        const r1 = await ev(report);
        if (r1.errors.length || r1.links < 1) {
            throw new Error(`the first page: ${JSON.stringify(r1)}`);
        }
        if (first > pdf.length / 4) {
            throw new Error(`${first} bytes of ${pdf.length} fetched for the first page`);
        }
        await checkPreviewLink("pdf-frame.html", `document.querySelector('.page[data-page="1"] a[href="https://example.com/"]').click()`, "https://example.com/");
        // Its text: over it, where it's drawn, to be selected.
        await waitFor(`${report}?.text.includes(1)`, "the first page's text", 30000);
        const text = await inFrame("pdf-frame.html", `(() => {
            const box = document.querySelector('.page[data-page="1"]'), layer = box.querySelector(".textLayer");
            const heading = [...layer.querySelectorAll("span")].find((s) => s.textContent.includes("A PDF"));
            const r = new Range();
            r.selectNodeContents(layer);
            getSelection().removeAllRanges();
            getSelection().addRange(r);
            const b = box.getBoundingClientRect(), h = heading?.getBoundingClientRect();
            return { selected: getSelection().toString(), inside: !!h && h.width > 20 && h.left >= b.left && h.right <= b.right && h.top >= b.top && h.bottom <= b.top + b.height / 4 };
        })()`);
        if (!/A PDF/.test(text.selected) || !/first page/.test(text.selected) || !text.inside) {
            throw new Error(`the first page's text: ${JSON.stringify(text)}`);
        }
        // The last page: fetched as it's shown, without those between.
        await inFrame("pdf-frame.html", `document.querySelector('.page[data-page="40"]').scrollIntoView()`);
        await waitFor(`${report}?.drawn.includes(40)`, "big.pdf's last page", 60000);
        const last = await ev(fetched);
        if (last <= first || last > pdf.length / 2) {
            throw new Error(`${last} bytes of ${pdf.length} fetched by the last page, ${first} by the first`);
        }
        // Internal PDF links retain the prior page and reading position.
        await inFrame("pdf-frame.html", `scrollTo(0, 150)`);
        await waitFor(`${report}?.drawn.includes(1)`, "the first page redrawn");
        const pdfPosition = await inFrame("pdf-frame.html", `scrollY`);
        await inFrame("pdf-frame.html", `document.querySelector('.page[data-page="1"] a[href="#"]').click()`);
        await waitFor(`!document.querySelector("dialog.preview button.back").hidden && ${report}?.drawn.includes(3)`, "the PDF link to page three");
        await inFrame("pdf-frame.html", `document.querySelector("#bar button.fit-page").click()`);
        await ev(`document.querySelector("dialog.preview button.back").click()`);
        await sleep(200);
        if (Math.abs((await inFrame("pdf-frame.html", `scrollY`)) - pdfPosition) > 3) throw new Error("PDF Back lost the original reading position");
        await waitFor(`document.querySelector("dialog.preview button.back").hidden`, "PDF history exhausted");
        if (!(await inFrame("pdf-frame.html", `document.querySelector("#bar button.fit-width").getAttribute("aria-pressed") === "true"`))) throw new Error("PDF Back didn't restore its zoom mode");
        // A page asked for, by clicking where it says which: gone to.
        await inFrame("pdf-frame.html", `(() => { document.querySelector("#bar button.where").click(); const b = document.querySelector("#bar input.go-to");
            b.value = "25"; b.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
        await waitFor(`${report}?.drawn.includes(25)`, "page 25, asked for", 60000);
        for (let i = 0; ; i++) {
            const at = await inFrame("pdf-frame.html", `!document.querySelector("#bar .where").hidden && document.querySelector("#bar .where").textContent`);
            if (at === "Page 25 of 40") {
                break;
            }
            if (i === 20) {
                throw new Error(`gone to page 25, the bar says ${at}`);
            }
            await sleep(100);
        }
        // Escape, and nothing's asked.
        const asked = await inFrame("pdf-frame.html", `(() => { document.querySelector("#bar button.where").click(); const b = document.querySelector("#bar input.go-to");
            const shown = !b.hidden; b.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            return shown && b.hidden && !document.querySelector("#bar .where").hidden; })()`);
        if (!asked) {
            throw new Error("the page box didn't open, or close with Escape");
        }
        // Fit uses both dimensions, and grows beyond the former 1,000px cap.
        const assertFitted = async (wide = false) => {
            let size;
            for (let i = 0; i < 100; i++) {
                size = await inFrame("pdf-frame.html", `(() => {
                    const bar = document.querySelector("#bar");
                    const n = Number(document.querySelector("button.where").textContent.match(/\\d+/)?.[0]);
                    const box = document.querySelector('.page[data-page="' + n + '"]');
                    const r = box.getBoundingClientRect();
                    const w = document.querySelector("#pages").clientWidth - 16, h = innerHeight - bar.offsetHeight - 24;
                    return { width: r.width, height: r.height, fitted: !!box.querySelector("canvas") && r.width <= w + 1 && r.height <= h + 1
                        && Math.min(Math.abs(r.width - w), Math.abs(r.height - h)) <= 2
                        && r.top >= bar.getBoundingClientRect().bottom - 1 && r.bottom <= innerHeight + 1 };
                })()`);
                if (size.fitted && (!wide || size.width > 1000)) {
                    return;
                }
                await sleep(200);
            }
            throw new Error(`the PDF didn't fit the window: ${JSON.stringify(size)}`);
        };
        await inFrame("pdf-frame.html", `[...document.querySelectorAll("#bar button")].find((b) => b.title === "Zoom in").click();
            document.querySelector("#bar button.fit-page").click()`);
        await assertFitted();
        const wasWide = await ev(`document.querySelector("dialog.preview button.widen").getAttribute("aria-pressed") === "true"`);
        try {
            await cdp("Emulation.setDeviceMetricsOverride", { width: 1800, height: 1800, deviceScaleFactor: 1, mobile: false });
            if (!wasWide) {
                await ev(`document.querySelector("dialog.preview button.widen").click()`);
            }
            await assertFitted(true);
        } finally {
            await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
            if (!wasWide) {
                await ev(`document.querySelector("dialog.preview button.widen").click()`);
            }
        }
        await assertFitted();
        // 100% is a fixed PDF-point-to-CSS-pixel scale, independent of the window.
        const mediaBox = /\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/.exec(pdf.toString("latin1"));
        if (!mediaBox) {
            throw new Error("the PDF fixture has no MediaBox");
        }
        const actualWidth = (Number(mediaBox[3]) - Number(mediaBox[1])) * 96 / 72;
        const actualHeight = (Number(mediaBox[4]) - Number(mediaBox[2])) * 96 / 72;
        const assertActual = async () => {
            let size;
            for (let i = 0; i < 100; i++) {
                size = await inFrame("pdf-frame.html", `(() => {
                    const n = Number(document.querySelector("button.where").textContent.match(/\\d+/)?.[0]);
                    const box = document.querySelector('.page[data-page="' + n + '"]');
                    const r = box.getBoundingClientRect();
                    return { width: r.width, height: r.height, drawn: !!box.querySelector("canvas"),
                        actual: document.querySelector("button.actual-size").getAttribute("aria-pressed") === "true",
                        fit: document.querySelector("button.fit-page").getAttribute("aria-pressed") === "true" };
                })()`);
                if (size.drawn && size.actual && !size.fit && Math.abs(size.width - actualWidth) <= 1 && Math.abs(size.height - actualHeight) <= 1) {
                    return;
                }
                await sleep(200);
            }
            throw new Error(`100% wasn't the fixed PDF size: ${JSON.stringify(size)}`);
        };
        await inFrame("pdf-frame.html", `document.querySelector("button.actual-size").click()`);
        await assertActual();
        await inFrame("pdf-frame.html", `[...document.querySelectorAll("#bar button")].find((b) => b.title === "Zoom in").click();
            document.querySelector("button.actual-size").click()`);
        await assertActual();
        try {
            await cdp("Emulation.setDeviceMetricsOverride", { width: 1800, height: 1000, deviceScaleFactor: 1, mobile: false });
            await sleep(300); // let the frame's resize layout run before checking its fixed scale
            await assertActual();
        } finally {
            await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        }
        // The adjacent width preset fills the container and follows resizing.
        const assertWidth = async () => {
            let size;
            for (let i = 0; i < 100; i++) {
                size = await inFrame("pdf-frame.html", `(() => {
                    const n = Number(document.querySelector("button.where").textContent.match(/\\d+/)?.[0]);
                    const box = document.querySelector('.page[data-page="' + n + '"]');
                    return { width: box.getBoundingClientRect().width, available: document.querySelector("#pages").clientWidth - 16,
                        drawn: !!box.querySelector("canvas"), selected: document.querySelector("button.fit-width").getAttribute("aria-pressed") === "true",
                        other: !!document.querySelector("button.fit-page[aria-pressed=true], button.actual-size[aria-pressed=true]") };
                })()`);
                if (size.drawn && size.selected && !size.other && Math.abs(size.width - size.available) <= 1) {
                    return;
                }
                await sleep(200);
            }
            throw new Error(`the PDF didn't fit the preview width: ${JSON.stringify(size)}`);
        };
        await inFrame("pdf-frame.html", `document.querySelector("button.fit-width").click()`);
        await assertWidth();
        try {
            await cdp("Emulation.setDeviceMetricsOverride", { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false });
            await sleep(300);
            await assertWidth();
        } finally {
            await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        }
        await inFrame("pdf-frame.html", `document.querySelector("button.fit-page").click()`);
        await assertFitted();
        // Find: through every page's text, to the match, highlighted.
        const findFor = (q) => inFrame("pdf-frame.html", `(() => { const f = document.querySelector("input.find"); f.value = ${JSON.stringify(q)};
            f.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
        const foundNow = `${report}?.found`;
        // Ctrl+F, pressed in the page, not the frame: to the frame's Find.
        await ev(`document.querySelector("dialog.preview button.close").focus()`);
        await press("f", 2);
        for (let i = 0; await inFrame("pdf-frame.html", `document.activeElement?.className`) !== "find"; i++) {
            if (i === 20) {
                throw new Error("Ctrl+F didn't go to Find");
            }
            await sleep(100);
        }
        // Mostly pictures, so it stops to ask once it's fetched 32 MB more.
        const beforeFind = await ev(fetched);
        await findFor("page 37");
        await waitFor(`${foundNow}.paused.startsWith("Fetched")`, "finding to stop and ask", 60000);
        const atPause = await ev(fetched);
        if (atPause - beforeFind > 48 << 20) {
            throw new Error(`${atPause - beforeFind} bytes fetched before finding asked`);
        }
        await inFrame("pdf-frame.html", `document.querySelector("button.keep-looking").click()`);
        await waitFor(`${foundNow}.searched === 40 && ${foundNow}.matches === 1 && ${foundNow}.page === 37 && ${report}.text.includes(37)`, "page 37 found", 60000);
        const lit = await inFrame("pdf-frame.html", `(() => { const h = CSS.highlights.get("found-current"); const [r] = h ?? [];
            return { size: h?.size ?? 0, text: r?.toString() ?? "", top: r?.getBoundingClientRect().top ?? -1, height: innerHeight,
                where: document.querySelector(".where").textContent }; })()`);
        if (lit.size !== 1 || !/^Page\s+37$/.test(lit.text) || lit.top < 0 || lit.top > lit.height || lit.where !== "Page 37 of 40") {
            throw new Error(`page 37's match: ${JSON.stringify(lit)}`);
        }
        await findFor("PAGE");
        await waitFor(`${foundNow}.query === "PAGE" && ${foundNow}.searched === 40`, "every page searched", 60000);
        const pageMatches = (await ev(report)).found.matches;
        if (pageMatches !== 40) {
            throw new Error(`"PAGE" found ${pageMatches} times, not 40`);
        }
        const searched = await ev(fetched);
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "the preview to close");

        // A PDF without text: finding stops after the first pages, till asked.
        await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === "scanned.pdf").click()`);
        await waitFor(`${report}?.pages === 10 && ${report}.drawn.includes(1)`, "scanned.pdf's first page", 60000);
        await findFor("anything");
        await waitFor(`${foundNow}.paused && ${foundNow}.searched === 8`, "finding to stop at 8 pages", 60000);
        await inFrame("pdf-frame.html", `document.querySelector("button.keep-looking").click()`);
        await waitFor(`!${foundNow}.paused && ${foundNow}.searched === 10 && ${foundNow}.matches === 0`, "the rest looked through", 60000);
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "the preview to close");
        inContainer("sh", "-c", "rm ~/Downloads/media/big.pdf ~/Downloads/media/scanned.pdf");
        await open("fs/#/", `document.title === "Downloads /" && !!document.querySelector("table")`, "the listing");
        return `${(pdf.length / 1e6).toFixed(1)} MB, 40 pages: ${(first / 1e3).toFixed(0)} KB for page 1, ${(last / 1e6).toFixed(1)} MB with page 40, ` +
            `asked after ${((atPause - beforeFind) / 1e6).toFixed(1)} MB more, ${(searched / 1e6).toFixed(1)} MB once searched; ` +
            "text selected, found with Ctrl+F and highlighted; a scanned one's finding stopped till asked";
    });

    await step("files: read an EPUB book", async () => {
        // A book of three chapters: the first with a picture, a link to a
        // place in the third, and a script that mustn't run; the second
        // long, to be read halfway, and opened there again.
        const filler = Array.from({ length: 80 }, (_, i) => `<p>Line ${i + 1} of the second chapter.</p>`).join("");
        const chapter = (title, body) => `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml">` +
            `<head><title/><script>parent.postMessage("ran", "*")</script></head><body><h1>${title}</h1>${body}</body></html>`;
        const book = zipFile([
            ["mimetype", "application/epub+zip"],
            ["META-INF/container.xml", `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">` +
                `<rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`],
            ["OEBPS/book.opf", `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">` +
                `<dc:title>The Check Book</dc:title><dc:creator>A. Checker</dc:creator><dc:language>en</dc:language></metadata><manifest>` +
                `<item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>` +
                `<item id="c1" href="text/one.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="text/two.xhtml" media-type="application/xhtml+xml"/>` +
                `<item id="c3" href="text/three.xhtml" media-type="application/xhtml+xml"/><item id="p" href="images/square.png" media-type="image/png"/>` +
                `</manifest><spine><itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/></spine></package>`],
            ["OEBPS/nav.xhtml", `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>` +
                `<nav epub:type="toc"><ol><li><a href="text/one.xhtml">Chapter One</a></li><li><a href="text/two.xhtml">Chapter Two</a></li>` +
                `<li><a href="text/three.xhtml">Chapter Three</a></li></ol></nav></body></html>`],
            ["OEBPS/text/one.xhtml", chapter("One", `<p>The first chapter's text.</p><img src="../images/square.png" alt="A square"/>` +
                `<img src="data:image/png;base64,${pngSquare(20).toString("base64")}" alt="Inline"/>` +
                `<p><a href="https://example.com/">Web</a></p><p onclick="parent.postMessage('ran', '*')">On to <a href="three.xhtml#later">later in the third</a>.</p>`)],
            ["OEBPS/text/two.xhtml", chapter("Two", filler)],
            ["OEBPS/text/three.xhtml", chapter("Three", `${filler.replaceAll("second", "third")}<p id="later">Later on.</p>${filler}`)],
            ["OEBPS/images/square.png", pngSquare(40)],
        ]);
        writeFileSync(`${work}/book.epub`, book);
        execFileSync("docker", ["cp", "-q", `${work}/book.epub`, `${container}:/home/user/Downloads/media/book.epub`]);
        execFileSync("docker", ["exec", container, "chown", "user", "/home/user/Downloads/media/book.epub"]);
        await ev(`window.ran = 0; window.addEventListener("message", (e) => { if (e.data === "ran") window.ran++; })`);

        const report = `JSON.parse(document.querySelector("dialog.preview iframe.epub")?.dataset.rendered ?? "null")`;
        const inBook = (expr) => inFrame("epub-frame.html", expr);
        const openBook = async () => {
            await open("fs/#/media/", `${listed}.includes("book.epub")`, "book.epub");
            await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === "book.epub").click()`);
        };
        const close = async () => {
            await ev(`document.querySelector("dialog.preview button.close").click()`);
            await waitFor(`!document.querySelector("dialog.preview")`, "the preview to close");
        };
        await openBook();
        await waitFor(`${report}?.stage === "shown" && ${report}.chapter === 1 && ${report}.pictures === 1`, "the first chapter, with its picture", 30000);
        const first = await inBook(`({ text: document.getElementById("doc").textContent, scripts: document.querySelectorAll("#doc script, [onclick]").length,
            picture: document.querySelector("#doc img")?.naturalWidth ?? 0,
            inline: document.querySelector('#doc img[alt="Inline"]')?.naturalWidth ?? 0, title: document.querySelector("#contents .book").textContent,
            where: document.querySelector("#bar .where").textContent })`);
        if (!first.text.includes("The first chapter's text.") || first.scripts || first.picture !== 40 || first.inline !== 20 ||
            first.title !== "The Check BookA. Checker" || first.where !== "Chapter 1 of 3 · Chapter One") {
            throw new Error(`the first chapter: ${JSON.stringify(first)}`);
        }
        await checkPreviewLink("epub-frame.html", `document.querySelector('#doc a[href="https://example.com/"]').click()`, "https://example.com/");
        // A link to a place in another chapter: there, at it.
        await inBook(`[...document.querySelectorAll("#doc a")].find((a) => a.textContent === "later in the third").click()`);
        await waitFor(`${report}?.chapter === 3`, "the third chapter");
        const later = await inBook(`(() => { const r = document.getElementById("b-later").getBoundingClientRect(); return { top: r.top, height: innerHeight }; })()`);
        if (later.top < 0 || later.top > later.height / 2) {
            throw new Error(`the link's place: ${JSON.stringify(later)}`);
        }
        await ev(`document.querySelector("dialog.preview button.back").click()`);
        await waitFor(`${report}?.chapter === 1 && ${report}.stage === "shown"`, "Back to the first chapter");
        if ((await inBook(`scrollY`)) > 3) throw new Error("EPUB Back lost the original position");
        await waitFor(`document.querySelector("dialog.preview button.back").hidden`, "EPUB history exhausted");
        // The contents, to the second chapter; read halfway.
        await inBook(`document.querySelector('#bar button[aria-label="Contents"]').click()`);
        await inBook(`[...document.querySelectorAll("#contents li button")].find((b) => b.textContent === "Chapter Two").click()`);
        await waitFor(`${report}?.chapter === 2 && ${report}.stage === "shown"`, "the second chapter");
        // At its end, the chapters before and after, in a bar at the frame's
        // foot; further up, not.
        const endsShown = `document.getElementById("ends").classList.contains("shown")`;
        await inBook(`scrollTo(0, document.documentElement.scrollHeight)`);
        for (let i = 0; !(await inBook(endsShown)); i++) {
            if (i === 20) {
                throw new Error("no bar of chapters at the chapter's end");
            }
            await sleep(100);
        }
        await sleep(400); // (it slides in)
        const bar = await inBook(`(() => { const r = document.getElementById("ends").getBoundingClientRect();
            return { bottom: Math.round(r.bottom), height: innerHeight, buttons: [...document.querySelectorAll("#ends button")].map((b) => b.textContent) }; })()`);
        if (bar.bottom !== bar.height || bar.buttons.join() !== "‹ Chapter One,Chapter Three ›") {
            throw new Error(`the bar: ${JSON.stringify(bar)}`);
        }
        await inBook(`scrollTo(0, (document.documentElement.scrollHeight - innerHeight) / 2)`);
        await sleep(1000);
        if (await inBook(endsShown)) {
            throw new Error("the bar of chapters stayed, halfway up");
        }
        await close();
        // Opened again: there.
        await openBook();
        await waitFor(`${report}?.chapter === 2 && ${report}.stage === "shown"`, "the book, where it was left", 30000);
        await sleep(300);
        const back = await inBook(`scrollY / (document.documentElement.scrollHeight - innerHeight)`);
        if (back < 0.4 || back > 0.6) {
            throw new Error(`opened again ${back} of the way down the second chapter, not halfway`);
        }
        // ›, to the next chapter.
        await inBook(`document.querySelector('#bar button[aria-label^="The next chapter"]').click()`);
        await waitFor(`${report}?.chapter === 3`, "the next chapter");

        // Its details: a new title and author, and a cover, where it had
        // none; shown again, where it was.
        // The cover, a picture in Downloads, chosen there.
        writeFileSync(`${work}/cover.png`, pngSquare(60));
        execFileSync("docker", ["cp", "-q", `${work}/cover.png`, `${container}:/home/user/Downloads/media/cover.png`]);
        execFileSync("docker", ["exec", container, "chown", "user", "/home/user/Downloads/media/cover.png"]);
        const top = `[...document.querySelectorAll("dialog[open]")].at(-1)`;
        await ev(`document.querySelector("dialog.preview button.edit").click()`);
        await waitFor(`${top}?.querySelector(".cover-field .no-cover:not([hidden])")`, "the details, without a cover");
        await ev(`(() => { const [title, author] = ${top}.querySelectorAll("input[type=text]");
            title.value = "A Checked Book"; author.value = "B. Checker"; })()`);
        await ev(`${top}.querySelector("button.cover-pick").click()`);
        const picture = (name) => `[...document.querySelectorAll("dialog.picker button.picker-picture")].find((b) => b.textContent === ${JSON.stringify(name)})`;
        await waitFor(`document.querySelector("dialog.picker .picker-where")?.textContent === "Downloads / media" && !!${picture("cover.png")}`,
            "the picker, in the book's folder");
        await ev(`${picture("cover.png")}.click()`);
        await waitFor(`!document.querySelector("dialog.picker") && ${top}.querySelector("img.cover:not([hidden])")?.naturalWidth === 60`, "the new cover, shown");
        // Saved, it's shown again, in a new frame.
        const savedAndShown = async () => {
            await ev(`document.querySelector("dialog.preview iframe.epub").dataset.old = "1"`);
            await ev(`${top}.querySelector("button.primary").click()`);
            await waitFor(`!!document.querySelector("dialog.preview iframe.epub:not([data-old])") && ${report}?.chapter === 3 && ` +
                `${report}.stage === "shown" && !document.querySelector("dialog.preview p.saving")`, "the book shown again, changed", 60000);
        };
        await savedAndShown();
        // (The frame that showed it before may be listed a moment longer.)
        let changed = "";
        for (const end = Date.now() + 10000; changed !== "A Checked BookB. Checker" && Date.now() < end; await sleep(200)) {
            changed = await inBook(`document.querySelector("#contents .book")?.textContent ?? ""`).catch(() => "");
        }
        if (changed !== "A Checked BookB. Checker") {
            throw new Error(`the book's details read back as ${JSON.stringify(changed)}`);
        }
        await ev(`document.querySelector("dialog.preview button.edit").click()`);
        await waitFor(`${top}?.querySelector("img.cover:not([hidden])")?.naturalWidth === 60`, "the new cover, read back");
        const fields = await ev(`[...${top}.querySelectorAll("input[type=text]")].map((i) => i.value)`);
        await ev(`${top}.querySelector(".buttons button:not(.primary)").click()`);
        if (fields.join() !== "A Checked Book,B. Checker") {
            throw new Error(`the details read back as ${fields}`);
        }
        // A cover it has, replaced: by a picture from this computer, dropped
        // on the dialog (not uploaded into the folder, as one dropped on the
        // page is), too big, made smaller, as the type it is.
        await waitFor(`!document.querySelector("dialog:not(.preview)[open]")`, "the details to close");
        await ev(`document.querySelector("dialog.preview button.edit").click()`);
        await waitFor(`${top}?.querySelector("img.cover:not([hidden])")?.naturalWidth === 60`, "the cover");
        // (dataTransfer holds a file made here, as a drop from the desktop would.)
        const picked = (w, h, name) => `(async () => { const c = new OffscreenCanvas(${w}, ${h}); c.getContext("2d").fillRect(0, 0, 10, 10);
            const dt = new DataTransfer(); dt.items.add(new File([await c.convertToBlob({ type: "image/png" })], "${name}", { type: "image/png" }));
            return dt; })()`;
        await ev(`(async () => { const dt = await ${picked(3200, 2400, "big-cover.png")};
            ${top}.querySelector(".cover-field").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt })); })()`);
        await waitFor(`${top}.querySelector("img.cover:not([hidden])")?.naturalWidth === 3200`, "the big cover, dropped, shown");
        await savedAndShown();
        if (inContainer("ls", "/home/user/Downloads/media").includes("big-cover.png")) {
            throw new Error("the picture dropped on the dialog was uploaded too");
        }
        await ev(`document.querySelector("dialog.preview button.edit").click()`);
        await waitFor(`${top}?.querySelector("img.cover:not([hidden])")?.naturalWidth === 3000`, "the cover, made smaller, read back", 30000);
        // One pasted: shown as the new one, till it's cancelled.
        // Pasted into the title, a copy's picture isn't taken for the cover.
        await ev(`(async () => { const dt = await ${picked(20, 20, "image.png")};
            ${top}.querySelector("input[type=text]").dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt })); })()`);
        await sleep(300);
        if (await ev(`${top}.querySelector("img.cover:not([hidden])")?.naturalWidth`) !== 3000) {
            throw new Error("a picture pasted into the title was taken for the cover");
        }
        await ev(`(async () => { const dt = await ${picked(20, 20, "image.png")};
            ${top}.querySelector(".cover-field").dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt })); })()`);
        await waitFor(`${top}.querySelector("img.cover:not([hidden])")?.naturalWidth === 20`, "a picture pasted, shown");
        await ev(`${top}.querySelector(".buttons button:not(.primary)").click()`);
        await close();
        if (await ev("window.ran")) {
            throw new Error("the book's scripts ran");
        }
        inContainer("sh", "-c", "rm ~/Downloads/media/book.epub ~/Downloads/media/cover.png");
        await open("fs/#/", `document.title === "Downloads /" && !!document.querySelector("table")`, "the listing");
        return "contents, a picture fetched and one inline, a link to another chapter's place, the next chapter, opened again where it was left; " +
            "its title, author and cover changed, and that cover replaced, made smaller";
    });

    await step("files: edit CSV and TSV cells", async () => {
        const original = '\ufeffsep=;\r\nname;note;score\r\nAlice;"hello\r\nworld";10\r\nBob;plain;2\r\n';
        for (const [name, text] of [["edit.csv", original], ["edit.tsv", "name\tvalue\nA\told"], ["broken.csv", 'name,value\nA,"open'],
            ["space.csv", "name age\nAlice 10\nBob 20\n"],
            ["expanded.csv", "name,value\n" + Array.from({ length: 2000 }, (_, i) => `row${i},1`).join("\n")],
            ["directive.csv", "title\nAlice\n"], ["literal-bom.csv", '"\ufeffaccount",balance\nAlice,10\n'],
            ["pending.csv", "name,value\nAlice,10\nBob,20\n"], ["pending.txt", "value=10\nother=20\n"]]) {
            writeFileSync(`${work}/${name}`, text);
            execFileSync("docker", ["cp", "-q", `${work}/${name}`, `${container}:/home/user/Downloads/media/${name}`]);
            execFileSync("docker", ["exec", container, "chown", "user", `/home/user/Downloads/media/${name}`]);
        }
        const openTable = async (name, prepare = async () => {}) => {
            await open("fs/#/media/", `${listed}.includes(${JSON.stringify(name)})`, name);
            await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === ${JSON.stringify(name)}).click()`);
            await waitFor(`!!document.querySelector("dialog.preview .table-view")`, "the table");
            await prepare();
            await ev(`document.querySelector("dialog.preview button.edit").click()`);
            await waitFor(`!!document.querySelector("dialog.preview .table-editor")`, "the cell editor");
        };
        const cell = (name, column) => `[...document.querySelectorAll("dialog.preview tbody tr")].find((tr) => tr.children[1].textContent === ${JSON.stringify(name)}).children[${column + 1}]`;
        const change = async (name, column, value, key = "Enter") => {
            await ev(`${cell(name, column)}.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`);
            await waitFor(`!!document.querySelector("textarea.table-cell-editor")`, "the cell's textarea");
            await ev(`(() => { const b = document.querySelector("textarea.table-cell-editor"); b.value = ${JSON.stringify(value)};
                b.dispatchEvent(new Event("input")); b.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true })); })()`);
            await waitFor(`!document.querySelector("textarea.table-cell-editor")`, "the cell committed or cancelled");
        };
        const save = () => ev(`document.querySelector("dialog.preview button.save-edit").click()`);
        const status = `document.querySelector("dialog.preview .edit-status")?.textContent`;
        const read = (name) => Buffer.from(inContainer("python3", "-c", `import base64; print(base64.b64encode(open('/home/user/Downloads/media/${name}', 'rb').read()).decode())`), "base64").toString("utf8");
        await openTable("edit.csv");
        await ev(`[...document.querySelectorAll("dialog.preview button.col-name")].find((b) => b.textContent === "score").click()`);
        await waitFor(`document.querySelector("dialog.preview tbody tr").children[1].textContent === "Bob"`, "Bob sorted first");
        await change("Bob", 2, "20");
        await waitFor(`document.querySelector("dialog.preview tbody tr").children[1].textContent === "Alice"`, "the edited score, sorted again");
        const value = 'new;"value"\nnext';
        await change("Bob", 1, value);
        await change("Alice", 2, "999", "Escape");
        await save();
        await waitFor(`${status} === "Saved."`, "the table saved");
        let expected = '\ufeffsep=;\r\nname;note;score\r\nAlice;"hello\r\nworld";10\r\nBob;"new;""value""\nnext";20\r\n';
        if (read("edit.csv") !== expected) {
            throw new Error(`saved CSV: ${JSON.stringify(read("edit.csv"))}`);
        }
        // Filtered edits still change the original record, not its visible position.
        await ev(`(() => { const f = document.querySelector("dialog.preview input.table-filter"); f.value = "Bob"; f.dispatchEvent(new Event("input")); })()`);
        await waitFor(`document.querySelectorAll("dialog.preview tbody tr").length === 1`, "Bob filtered");
        await change("Bob", 2, "21");
        await ev(`document.querySelector("dialog.preview button.done-edit").click()`);
        await waitFor(`!!document.querySelector("dialog:not(.preview)[open]")`, "unsaved cell changes asked about");
        await ev(`document.querySelector("dialog:not(.preview)[open] .buttons button:not(.primary)").click()`);
        await waitFor(`!!document.querySelector("dialog.preview .table-editor")`, "still editing");
        await save();
        await waitFor(`${status} === "Saved."`, "the filtered edit saved");
        expected = expected.replace(';20\r\n', ';21\r\n');
        if (read("edit.csv") !== expected) {
            throw new Error("the filtered edit changed the wrong record");
        }
        await change("Bob", 2, "22");
        // A concurrent writer wins; the table must not overwrite it.
        inContainer("sh", "-c", "printf '\\nexternal' >> ~/Downloads/media/edit.csv");
        await save();
        await waitFor(`${status}?.startsWith("Not saved:")`, "the stale table save refused");
        if (read("edit.csv") !== expected + "\nexternal") {
            throw new Error("the concurrent CSV change was overwritten");
        }
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await answer();
        await waitFor(`!document.querySelector("dialog.preview")`, "discarded changes");
        await openTable("edit.tsv");
        await ev(`${cell("A", 1)}.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`);
        await waitFor(`!!document.querySelector("textarea.table-cell-editor")`, "the TSV cell's textarea");
        await ev(`(() => { const b = document.querySelector("textarea.table-cell-editor"); b.value = "new\\tvalue";
            b.dispatchEvent(new Event("input")); b.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true })); })()`);
        await waitFor(`${status} === "Saved."`, "the TSV saved");
        if (read("edit.tsv") !== 'name\tvalue\nA\t"new\tvalue"') {
            throw new Error("the TSV delimiter or final newline changed");
        }
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "the TSV closed");
        await openTable("broken.csv");
        if (await ev(`document.querySelectorAll("dialog.preview td.editable-cell").length || !document.querySelector("dialog.preview button.save-edit").disabled`)) {
            throw new Error("malformed CSV allowed cell editing");
        }
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "the malformed CSV closed");

        // Entering and leaving Edit keeps the chosen split and headings.
        const count = `document.querySelector("dialog.preview .table-count")?.textContent`;
        await openTable("space.csv", async () => {
            await ev(`(() => { const s = document.querySelector(".table-delimiter"); s.value = " "; s.dispatchEvent(new Event("change"));
                const h = document.querySelector(".table-bar label.check input"); h.checked = false; h.dispatchEvent(new Event("change")); })()`);
            await waitFor(`${count} === "3 rows × 2 columns"`, "the manual split and headings");
        });
        await waitFor(`${count} === "3 rows × 2 columns" && document.querySelector(".table-delimiter").value === " "`, "the same split in Edit");
        await change("Alice", 1, "11");
        await save();
        await waitFor(`${status} === "Saved."`, "the space-separated file saved");
        if (read("space.csv") !== "name age\nAlice 11\nBob 20\n") {
            throw new Error("the chosen delimiter wasn't used to save");
        }
        await ev(`document.querySelector("dialog.preview button.done-edit").click()`);
        await waitFor(`!document.querySelector(".table-editor") && ${count} === "3 rows × 2 columns"`, "the same table after Done");
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "the space-separated table closed");

        // A cell in a later batch stays visible and focused after committing.
        await openTable("expanded.csv");
        await ev(`document.querySelector("dialog.preview button.table-more").click()`);
        await waitFor(`document.querySelectorAll("dialog.preview tbody tr").length === 2000`, "all 2,000 rows expanded");
        await change("row1500", 1, "2");
        await waitFor(`document.querySelectorAll("dialog.preview tbody tr").length === 2000
            && document.activeElement === ${cell("row1500", 1)} && document.activeElement.textContent === "2"`, "the later edited row stays visible and focused");
        await save();
        await waitFor(`${status} === "Saved."`, "the expanded table saved");
        if (read("expanded.csv").split("\n")[1501] !== "row1500,2") {
            throw new Error("the later row wasn't saved");
        }
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "the expanded table closed");

        // Literal sep= text in the first record must survive reopening.
        await openTable("directive.csv", async () => {
            await ev(`(() => { const h = document.querySelector(".table-bar label.check input"); h.checked = false; h.dispatchEvent(new Event("change")); })()`);
        });
        await change("title", 0, "sep=:");
        await save();
        await waitFor(`${status} === "Saved."`, "the literal directive saved");
        await ev(`document.querySelector("dialog.preview button.done-edit").click()`);
        await waitFor(`!document.querySelector(".table-editor") && ${count} === "2 rows × 1 column"
            && document.querySelector("dialog.preview tbody tr").children[1].textContent === "sep=:"`, "the first record retained");
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "the literal directive table closed");

        await openTable("literal-bom.csv");
        await change("Alice", 1, "11");
        await save();
        await waitFor(`${status} === "Saved."`, "the literal BOM saved");
        if (read("literal-bom.csv") !== '"\ufeffaccount",balance\nAlice,11\n') {
            throw new Error("a cell's literal U+FEFF was converted to a file BOM");
        }
        await ev(`document.querySelector("dialog.preview button.done-edit").click()`);
        await waitFor(`!document.querySelector(".table-editor") && document.querySelector("button.col-name")?.textContent === "\ufeffaccount"`, "the literal BOM retained after reopening");
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "the literal BOM table closed");

        // Hold only the first upload's completion reply, after the server has
        // saved it. Reopening an editor must retain its older snapshot version.
        for (const name of ["pending.csv", "pending.txt"]) {
            const csv = name.endsWith(".csv");
            await open("fs/#/media/", `${listed}.includes(${JSON.stringify(name)})`, name);
            await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === ${JSON.stringify(name)}).click()`);
            await waitFor(`!!document.querySelector("dialog.preview button.edit:not([hidden])")`, "the Edit button");
            await ev(`document.querySelector("dialog.preview button.edit").click()`);
            await waitFor(`!!document.querySelector(${JSON.stringify(csv ? ".table-editor" : "textarea.editor")})`, "the first editor");
            await ev(`import("/tabtop/tunnel.js").then(({ Tunnel }) => {
                const original = Tunnel.open; let held = false;
                window.restorePendingSave = () => { Tunnel.open = original; window.releasePendingSave?.(); };
                Tunnel.open = async function (req, ...args) {
                    const t = await original.call(this, req, ...args);
                    if (!held && req.type === "upload" && req.name === ${JSON.stringify(name)}) {
                        held = true; const next = t.next.bind(t);
                        t.next = async () => {
                            const m = await next();
                            if (m?.text && JSON.parse(m.text).name) {
                                await new Promise((resolve) => { window.releasePendingSave = resolve; });
                            }
                            return m;
                        };
                    }
                    return t;
                };
            })`);
            try {
                if (csv) {
                    await change("Alice", 1, "11");
                } else {
                    await ev(`(() => { const b = document.querySelector("textarea.editor"); b.value = "value=11\\nother=20\\n"; b.dispatchEvent(new Event("input")); })()`);
                }
                await save();
                await waitFor(`typeof window.releasePendingSave === "function"`, "the first save's reply held");
                await ev(`document.querySelector("button.done-edit").click()`);
                await answer();
                await waitFor(`!document.querySelector(".table-editor, textarea.editor")`, "the first editor left");
                await ev(`document.querySelector("dialog.preview button.edit").click()`);
                await waitFor(`!!document.querySelector(${JSON.stringify(csv ? ".table-editor" : "textarea.editor")})`, "the older snapshot reopened");
                await ev(`(async () => { window.restorePendingSave(); await new Promise((r) => setTimeout(r, 0)); })()`);
                if (csv) {
                    await change("Bob", 1, "21");
                } else {
                    await ev(`(() => { const b = document.querySelector("textarea.editor"); b.value = "value=10\\nother=21\\n"; b.dispatchEvent(new Event("input")); })()`);
                }
                await save();
                await waitFor(`${status}?.startsWith("Not saved:")`, "the older editor's save refused");
                const expected = csv ? "name,value\nAlice,11\nBob,20\n" : "value=11\nother=20\n";
                if (read(name) !== expected) {
                    throw new Error(`${name}: the pending save was overwritten by an older editor`);
                }
                await ev(`document.querySelector("dialog.preview button.close").click()`);
                await answer();
                await waitFor(`!document.querySelector("dialog.preview")`, "the stale editor closed");
            } finally {
                await ev(`window.restorePendingSave?.(); delete window.restorePendingSave; delete window.releasePendingSave;`);
            }
        }
    });

    await step("files: CSV as a table, JSON as a tree", async () => {
        writeFileSync(`${work}/people.csv`, 'name,city,score\r\n"Smith, J","Paris\r\nFR",10\r\nDoe,Rome,9\r\nLee,Oslo,100\r\n');
        const items = Array.from({ length: 1200 }, (_, i) => ({ id: i, name: `item ${i}` }));
        writeFileSync(`${work}/data.json`, JSON.stringify({ items, meta: { deep: { needle: "found" } } }));
        writeFileSync(`${work}/config.json`, '{"a":1,"b":[1,2]}\n');
        // More rows, and more lines that aren't JSON, than a call can take
        // arguments.
        writeFileSync(`${work}/many.csv`, "1,2\n".repeat(150000));
        writeFileSync(`${work}/bad.jsonl`, "x\n".repeat(150000));
        // 500 lists of 500, opened; and 20,000 items, the last found.
        writeFileSync(`${work}/wide.json`, JSON.stringify(Array.from({ length: 500 }, () => Array(500).fill(0))));
        writeFileSync(`${work}/long.json`, JSON.stringify(Array.from({ length: 20000 }, (_, i) => `entry ${i}`)));
        for (const f of ["people.csv", "data.json", "config.json", "many.csv", "bad.jsonl", "wide.json", "long.json"]) {
            execFileSync("docker", ["cp", "-q", `${work}/${f}`, `${container}:/home/user/Downloads/media/${f}`]);
            execFileSync("docker", ["exec", container, "chown", "user", `/home/user/Downloads/media/${f}`]);
        }
        const openFile = async (name, ready, what) => {
            await open("fs/#/media/", `${listed}.includes(${JSON.stringify(name)})`, name);
            await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === ${JSON.stringify(name)}).click()`);
            await waitFor(ready, what);
        };
        const closePreview = async () => {
            await ev(`document.querySelector("dialog.preview button.close").click()`);
            await waitFor(`!document.querySelector("dialog.preview")`, "the preview to close");
        };

        // The CSV: a table, the quoted comma and line break in their cells.
        const cells = `[...document.querySelectorAll("dialog.preview .table-scroll tbody tr")].map((tr) => [...tr.children].slice(1).map((td) => td.textContent))`;
        const tableCount = `document.querySelector("dialog.preview .table-count")?.textContent`;
        await openFile("people.csv", `${tableCount} === "3 rows × 3 columns"`, "the CSV as a table");
        const first = await ev(cells);
        if (JSON.stringify(first) !== JSON.stringify([["Smith, J", "Paris\r\nFR", "10"], ["Doe", "Rome", "9"], ["Lee", "Oslo", "100"]])) {
            throw new Error(`the table: ${JSON.stringify(first)}`);
        }
        const sortBy = (heading) => ev(`[...document.querySelectorAll("dialog.preview thead th button")].find((b) => b.firstChild.textContent === ${JSON.stringify(heading)}).click()`);
        const scores = `${cells}.map((r) => r[2]).join()`;
        await sortBy("score");
        await waitFor(`${scores} === "9,10,100"`, "sorted by score, as numbers");
        await sortBy("score");
        await waitFor(`${scores} === "100,10,9"`, "sorted by score, the other way");
        await ev(`(() => { const f = document.querySelector("dialog.preview input.table-filter"); f.value = "rome"; f.dispatchEvent(new Event("input")); })()`);
        await waitFor(`${tableCount} === "1 of 3 rows × 3 columns" && ${cells}[0][0] === "Doe"`, "filtered to Rome");
        await ev(`document.querySelector('dialog.preview .views button[aria-pressed="false"]').click()`);
        await waitFor(`document.querySelector("dialog.preview .body pre")?.textContent.includes('"Smith, J"')`, "the CSV as text");
        await ev(`document.querySelector('dialog.preview .views button[aria-pressed="false"]').click()`);
        await waitFor(`!!document.querySelector("dialog.preview .table-view")`, "the table again");
        // Each column filtered by value, as its type is; then all cleared.
        const column = (heading) => `[...document.querySelectorAll("dialog.preview thead tr.heads th")].find((th) => th.querySelector(".col-name")?.textContent === ${JSON.stringify(heading)})`;
        const filterBy = async (heading, op, value) => {
            await ev(`${column(heading)}.querySelector("button.col-filter").click()`);
            await waitFor(`!document.querySelector("dialog.preview .table-filter-pop").hidden`, `${heading}'s filter`);
            await ev(`(() => { const p = document.querySelector("dialog.preview .table-filter-pop");
                p.querySelector("select.filter-op").value = ${JSON.stringify(op)}; p.querySelector("input.filter-value").value = ${JSON.stringify(value)};
                p.querySelector("button.primary").click(); })()`);
        };
        await filterBy("score", ">", "9");
        await waitFor(`${tableCount} === "2 of 3 rows × 3 columns" && ${scores} === "10,100"`, "scores over 9");
        await filterBy("name", "starts", "s");
        await waitFor(`${tableCount} === "1 of 3 rows × 3 columns" && ${cells}[0][0] === "Smith, J" &&
            ${column("name")}.querySelector("button.col-filter").textContent === "▼"`, "names starting s, scores over 9");
        await ev(`document.querySelector("dialog.preview button.table-clear-filters").click()`);
        await waitFor(`${tableCount} === "3 rows × 3 columns"`, "the filters cleared");
        // A number's filter takes only a number.
        await filterBy("score", "<", "ten");
        await waitFor(`document.querySelector("dialog.preview .filter-why")?.textContent === "That's not a number."`, "a number asked for");
        await ev(`document.querySelector("dialog.preview .table-filter-pop").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
        // Statistics, of the rows shown: chosen, and kept.
        if (await ev(`document.querySelector("input.table-stats-on").checked || !!document.querySelector(".table-stats-choice input:checked")`)) {
            throw new Error("statistics aren't all off by default");
        }
        await ev(`(() => { const b = document.querySelector("dialog.preview input.table-stats-on"); b.click(); })()`);
        const alignment = await ev(`(() => {
            const bar = document.querySelector(".table-bar"), r = bar.getBoundingClientRect();
            const summary = bar.querySelector(".table-summary").getBoundingClientRect();
            const choices = document.querySelector(".table-stats-choice").getBoundingClientRect();
            const labels = [...document.querySelectorAll(".table-stats-choice label")].map((l) => l.getBoundingClientRect());
            return { right: Math.abs(summary.right - (r.right - parseFloat(getComputedStyle(bar).paddingRight))),
                center: Math.abs((labels[0].left + labels.at(-1).right) / 2 - (choices.left + choices.right) / 2) };
        })()`);
        if (alignment.right > 1 || alignment.center > 1) {
            throw new Error(`table controls aren't aligned: ${JSON.stringify(alignment)}`);
        }
        if (await ev(`!!document.querySelector("dialog.preview tr.stats")`)) {
            throw new Error("statistics were shown before choosing any");
        }
        await ev(`[...document.querySelectorAll(".table-stats-choice label")].filter((l) => ["Sum", "Average", "Max", "Unique"].includes(l.textContent.trim()))
            .forEach((l) => l.querySelector("input").click())`);
        const stat = (key) => `[...document.querySelectorAll("dialog.preview tr.stat-${key} td")].map((td) => td.textContent)`;
        await waitFor(`${stat("sum")}.join() === ",,119" && ${stat("mean")}.join() === ",,39.6666666667" && ${stat("unique")}.join() === "3,3,3"`, "the statistics");
        if (!JSON.parse(await ev(`localStorage.getItem("tabtop.table-stats")`)).on) {
            throw new Error("statistics on wasn't kept");
        }
        // Of the rows filtered in, only; how many, in the corner.
        const corner = `document.querySelector("dialog.preview th.corner").textContent`;
        if (await ev(corner) !== "3 rows") {
            throw new Error(`the corner says ${await ev(corner)}`);
        }
        await filterBy("score", "<", "50");
        await waitFor(`${stat("sum")}.join() === ",,19" && ${stat("max")}.join() === ",,10" && ${corner} === "2 of 3"`, "the statistics of the rows filtered in");
        await ev(`document.querySelector("dialog.preview button.table-clear-filters").click()`);
        await waitFor(`${stat("sum")}.join() === ",,119"`, "all the rows' again");
        // A column's width, dragged by its heading's handle; a double click
        // fits it again.
        const nameWidth = `${column("name")}.getBoundingClientRect().width`;
        const before = await ev(nameWidth);
        const handle = await ev(`(() => { const r = ${column("name")}.querySelector(".col-resize").getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
        await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: handle[0], y: handle[1], button: "left", clickCount: 1 });
        await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: handle[0] + 150, y: handle[1], button: "left", buttons: 1 });
        await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: handle[0] + 150, y: handle[1], button: "left", clickCount: 1 });
        const after = await ev(nameWidth);
        if (Math.abs(after - before - 150) > 3) {
            throw new Error(`dragged 150 px wider, the column went from ${before} to ${after}`);
        }
        await ev(`${column("name")}.querySelector(".col-resize").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`);
        await waitFor(`Math.abs(${nameWidth} - ${before}) < 3`, "the column fitted again");
        await ev(`document.querySelector("dialog.preview input.table-stats-on").click()`);
        await waitFor(`!document.querySelector("dialog.preview tr.stats")`, "the statistics off");
        // Split another way, then as found.
        const splitBy = (d) => ev(`(() => { const s = document.querySelector("dialog.preview select.table-delimiter"); s.value = ${JSON.stringify(d)};
            s.dispatchEvent(new Event("change")); })()`);
        await splitBy(";");
        await waitFor(`${tableCount}?.endsWith("× 1 column")`, "split by semicolons: one column");
        await splitBy("");
        await waitFor(`${tableCount} === "3 rows × 3 columns"`, "split as found again");
        await closePreview();
        await openFile("many.csv", `${tableCount} === "150,000 rows × 2 columns" && document.querySelectorAll("dialog.preview tbody tr").length === 1000`,
            "150,000 rows, the first 1,000 shown");
        await closePreview();
        await openFile("wide.json", `!!document.querySelector("dialog.preview .json-tree")`, "500 lists of 500");
        const wide = await ev(`document.querySelectorAll("dialog.preview .json-tree li").length`);
        if (wide > 2600) {
            throw new Error(`${wide} rows made to open 500 lists of 500`);
        }
        await closePreview();
        await openFile("long.json", `!!document.querySelector("dialog.preview .json-tree")`, "20,000 items");
        const started = Date.now();
        await ev(`(() => { const f = document.querySelector("dialog.preview input.json-search"); f.value = "entry 19999";
            f.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
        await waitFor(`document.querySelector("dialog.preview .json-line.current .hit")?.textContent === '"entry 19999"'`, "the last of 20,000, found", 15000);
        const took = Date.now() - started;
        // Made: the first rows, and a few around it, not all before it.
        const around = await ev(`({ rows: document.querySelectorAll("dialog.preview .json-tree li:not(.more)").length,
            gaps: [...document.querySelectorAll("dialog.preview .json-tree li.more")].map((li) => li.textContent) })`);
        if (around.rows > 700 || !around.gaps.some((g) => g.includes("not shown here"))) {
            throw new Error(`to show the last of 20,000: ${JSON.stringify(around)}`);
        }
        await closePreview();
        await openFile("bad.jsonl", `document.querySelector("dialog.preview .json-errors")?.textContent.startsWith("150,000 lines aren't JSON")`,
            "150,000 lines that aren't JSON, said");
        await closePreview();

        // The JSON: a tree; a match in its 1,200 items past those made yet,
        // and one deep down, unfolded to.
        const current = `document.querySelector("dialog.preview .json-line.current")`;
        await openFile("data.json", `!!document.querySelector("dialog.preview .json-tree")`, "the JSON as a tree");
        const made = await ev(`document.querySelectorAll("dialog.preview .json-tree li").length`);
        if (made > 600) {
            throw new Error(`${made} rows made to start`);
        }
        const search = (q) => ev(`(() => { const f = document.querySelector("dialog.preview input.json-search"); f.value = ${JSON.stringify(q)};
            f.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
        await search("item 1100");
        await waitFor(`${current}?.querySelector(".hit")?.textContent === '"item 1100"' && document.querySelector("dialog.preview .json-found").textContent === "1 of 1"`,
            "item 1100, past the first 500");
        await search("needle");
        await waitFor(`${current}?.querySelector(".json-key.hit")?.textContent === "needle"`, "the needle, deep down");
        await ev(`document.querySelector("dialog.preview .json-bar button.json-fold-all").click()`);
        await waitFor(`[...document.querySelectorAll("dialog.preview .json-tree > li > ul")].every((u) => u.hidden)`, "all folded");
        await closePreview();

        // Editing JSON: laid out; broken, and saving it asks first.
        const box = `document.querySelector("dialog.preview textarea.editor")`;
        const status = `document.querySelector("dialog.preview .json-status")?.textContent ?? ""`;
        await openFile("config.json", `!!document.querySelector("dialog.preview button.edit:not([hidden])")`, "config.json, with Edit");
        await ev(`document.querySelector("dialog.preview button.edit").click()`);
        await waitFor(`!!${box} && (${status}) === "It's JSON."`, "the editor, checking");
        await ev(`document.querySelector("dialog.preview button.format").click()`);
        await waitFor(`${box}.value === '{\\n  "a": 1,\\n  "b": [\\n    1,\\n    2\\n  ]\\n}\\n'`, "the JSON laid out");
        await ev(`(() => { const b = ${box}; b.value = '{"a": }\\n'; b.dispatchEvent(new Event("input")); })()`);
        await waitFor(`(${status}).startsWith("Not JSON: a value should be here")`, "the JSON found broken");
        await ev(`${box}.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }))`);
        const top = `[...document.querySelectorAll("dialog[open]")].at(-1)`;
        await waitFor(`${top}?.textContent.includes("isn't JSON as it is now")`, "a question before saving it broken");
        await ev(`${top}.querySelector(".buttons button:not(.primary)").click()`);
        await waitFor(`!document.querySelector("dialog:not(.preview)[open]")`, "the question gone");
        await ev(`(() => { const b = ${box}; b.value = '{"a": 2}\\n'; b.dispatchEvent(new Event("input")); })()`);
        await waitFor(`(${status}) === "It's JSON."`, "the JSON fixed");
        await ev(`${box}.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }))`);
        await waitFor(`document.querySelector("dialog.preview .edit-status")?.textContent === "Saved."`, "the fixed JSON saved");
        const saved = inContainer("cat", "/home/user/Downloads/media/config.json");
        if (saved !== '{"a": 2}') {
            throw new Error(`config.json holds ${JSON.stringify(saved)}`);
        }
        await closePreview();
        inContainer("sh", "-c", "cd ~/Downloads/media && rm people.csv data.json config.json many.csv bad.jsonl wide.json long.json");
        await open("fs/#/", `document.title === "Downloads /" && !!document.querySelector("table")`, "the listing");
        return `a CSV sorted, filtered by column and value, with statistics, and split another way, quotes and all; 150,000 rows; 500 lists of 500 opened in ${wide} rows; ` +
            `the last of 20,000 found in ${took} ms, ${around.rows} rows made; JSON searched past what's shown, and folded; JSON laid out, and asked about saving broken`;
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
        await open("fs/#/up-folder%20(1)/sub/deeper/", `${listed}.includes("c.txt")`, "up-folder (1)/sub/deeper/c.txt");
        await open("fs/#/up-folder/sub/", `${listed}.sort().join() === "../,b.txt,deeper/"`, "up-folder/sub/ to hold deeper/ and b.txt");
        // The heading leads back up.
        const crumbs = await ev(`[...document.querySelectorAll("h1.crumbs a")].map((a) => a.textContent).join()`);
        if (crumbs !== "~/Downloads,up-folder") {
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
        await open("fs/", `location.hash === "#/up-folder/sub/" && ${listed}.includes("b.txt")`, "up-folder/sub/, as last shown");
    });

    await step("files: updates itself", async () => {
        await open("fs/#/", `${listed}.includes("hello.txt")`, "the listing");
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
        await open("fs/#/", `document.title === "Downloads /" && !!document.querySelector("table")`, "the listing");
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
        await open("fs/#/made-here/", `${listed}.includes("renamed.txt")`, "made-here/renamed.txt");
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
        await open("fs/#/", `${listed}.includes("renamed.txt")`, "renamed.txt, back");
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
        const named = await ev(`[...document.querySelectorAll("#sessions .sessions-table tr")].filter((r) => r.textContent.includes("Chrome on Linux")).length`);
        if (named !== 2) {
            throw new Error(`${named} sessions are named Chrome on Linux, not 2`);
        }
        await ev(`document.querySelector("#sessions button.end").click()`);
        await answer();
        await waitFor(`/Ended the session/.test(${status}) && !document.querySelector("#sessions button.end")`, "the session to end");
        // A failed login since this one marks the shield, until it's
        // marked as seen.
        await ev(`import("/tabtop/tunnel.js").then((m) => m.login("x000000")).then(() => "", (e) => e.message)`);
        await cdp("Page.reload");
        await waitFor(`!!${button}?.classList.contains("attention") && !!document.querySelector("#sessions p.attention button.seen")`,
            "the warning, with Mark as seen");
        await ev(`document.querySelector("#sessions p.attention button.seen").click()`);
        await waitFor(`!${button}.classList.contains("attention") && !document.querySelector("#sessions p.attention")`, "the warning to go");
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
        await open("fs/#/", `document.title === "Downloads /" && !!document.querySelector("table")`, "the listing");
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
        // It says so, and carries on by itself once it can reach the
        // gateway again, without a Retry.
        await waitFor(`/resume.bin: [\\d.]+%, connection lost, reconnecting/.test(${status})`, "the upload to say it's reconnecting");
        await waitFor(`/resume.bin: uploaded/.test(${status})`, "the upload, carried on");
        const log = execFileSync("sh", ["-c", 'docker logs "$1" 2>&1', "sh", container], { encoding: "utf8", maxBuffer: 64 << 20 });
        const resumed = /upload of "resume\.bin" resumed at ([\d.]+ \w+)/.exec(log);
        if (!resumed) {
            throw new Error("it was sent again from the start");
        }
        const want = createHash("sha256").update(readFileSync(`${work}/resume.bin`)).digest("hex");
        if (inContainer("sha256sum", "/home/user/Downloads/resume.bin").split(" ")[0] !== want) {
            throw new Error("resume.bin was saved wrong");
        }
        return `carried on from ${resumed[1]}`;
    });

    await step("files: share links, with wget and curl", async () => {
        inContainer("sh", "-c", "echo shared with wget > ~/Downloads/share-me.txt");
        await open("fs/#/", `${listed}.includes("resume.bin") && ${listed}.includes("share-me.txt")`, "the listing");
        // Share… with what it offers first (1 day, any number of
        // downloads), then the link, from the dialog showing it.
        const share = async (name) => {
            await ev(`${row(name)}.querySelector("button.share").click()`);
            await answer();
            await waitFor(`!!document.querySelector("dialog[open] input")?.value.includes("/fs/")`, `the link to ${name}`);
            const url = await ev(`document.querySelector("dialog[open] input").value`);
            await ev(`document.querySelector("dialog[open] button:not(.primary)").click()`);
            if (!new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}fs/[A-Za-z0-9_-]{22}/${name.replace(".", "\\.")}$`).test(url)) {
                throw new Error(`the link to ${name} is ${url}`);
            }
            return url;
        };
        const hello = await share("share-me.txt");
        // Plain wget, which saves it under the name at the end of the URL.
        const dir = `${work}/shared`;
        mkdirSync(dir, { recursive: true });
        execFileSync("wget", ["-q", hello], { cwd: dir });
        if (readFileSync(`${dir}/share-me.txt`, "utf8") !== "shared with wget\n") {
            throw new Error("wget fetched the wrong share-me.txt");
        }
        // A big one, cut off part way, then carried on with curl -C -, and
        // with wget -c.
        const big = await share("resume.bin");
        const want = createHash("sha256").update(readFileSync(`${work}/resume.bin`)).digest("hex");
        const sum = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
        const part = `${dir}/curl.bin`;
        execFileSync("sh", ["-c", 'curl -sS "$1" | head -c 5000000 > "$2"', "sh", big, part]);
        execFileSync("curl", ["-fsS", "-C", "-", "-o", part, big]);
        if (sum(part) !== want) {
            throw new Error("curl -C - didn't carry on to the whole file");
        }
        copyFileSync(part, `${dir}/resume.bin`);
        truncateSync(`${dir}/resume.bin`, 7000000);
        execFileSync("wget", ["-q", "-c", big], { cwd: dir });
        if (sum(`${dir}/resume.bin`) !== want) {
            throw new Error("wget -c didn't carry on to the whole file");
        }
        // Listed under Share links, and revoked from there.
        const shareTab = `document.querySelector(".tabtop-nav button.shares")`;
        await ev(`${shareTab}.click()`);
        await waitFor(`document.querySelectorAll("#shares button.revoke").length === 2`, "the two links, listed");
        const counted = await ev(`[...document.querySelectorAll("#shares .shares-table tr")].find((r) => r.textContent.includes("resume.bin"))
            ?.querySelector("td.num")?.textContent ?? ""`);
        if (!counted.startsWith("1")) {
            throw new Error(`resume.bin's downloads show as ${counted}, not 1 (the resumes don't count)`);
        }
        await ev(`[...document.querySelectorAll("#shares .shares-table tr")].find((r) => r.textContent.includes("share-me.txt")).querySelector("button.revoke").click()`);
        await answer();
        await waitFor(`/Revoked the link to share-me.txt/.test(${status}) && document.querySelectorAll("#shares button.revoke").length === 1`, "the link revoked");
        const code = execFileSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", hello], { encoding: "utf8" });
        if (code !== "404") {
            throw new Error(`a revoked link answers ${code}`);
        }
        await ev(`${shareTab}.click()`);
        await open("fs/#/", `${listed}.includes("share-me.txt")`, "the listing again");
        // Direct Download: a link for one download, shown to copy.
        await ev(`${row("share-me.txt")}.querySelector("button.direct").click()`);
        await waitFor(`!!document.querySelector("dialog[open] input")?.value.includes("/fs/")`, "the direct download link");
        const direct = await ev(`document.querySelector("dialog[open] input").value`);
        await ev(`document.querySelector("dialog[open] button:not(.primary)").click()`);
        const fetched = (url) => execFileSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", url], { encoding: "utf8" });
        const codes = [fetched(direct), fetched(direct)].join(" ");
        if (codes !== "200 410") {
            throw new Error(`the direct download link answers ${codes}, not 200 then 410`);
        }
        return "wget, wget -c, curl -C - and Direct Download";
    });

    // linkFrom takes the link a dialog shows, and closes it.
    const linkFrom = async (what) => {
        await waitFor(`!!document.querySelector("dialog[open] input")?.value.includes("/fs/")`, what);
        const url = await ev(`document.querySelector("dialog[open] input").value`);
        await ev(`document.querySelector("dialog[open] button:not(.primary)").click()`);
        return url;
    };
    const httpCode = (...args) => execFileSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", ...args], { encoding: "utf8" });

    await step("share links: a page for browsers, its button counting", async () => {
        await open("fs/#/", `${listed}.includes("share-me.txt")`, "the listing");
        await ev(`${row("share-me.txt")}.querySelector("button.direct").click()`);
        const url = await linkFrom("the direct download link");
        // Fetched as a chat app's preview or a mail scanner would: the
        // page, which doesn't use the link up.
        for (let i = 0; i < 3; i++) {
            const page = execFileSync("curl", ["-fsS", "-H", "Accept: text/html,*/*;q=0.8", url], { encoding: "utf8" });
            if (!page.includes(`<form method="post">`) || !page.includes("share-me.txt")) {
                throw new Error(`a browser's request for the link got ${page.slice(0, 200)}`);
            }
        }
        // In Chrome: the page, then its Download button.
        rmSync(`${downloads}/share-me.txt`, { force: true });
        await open(url.slice(base.length), `document.querySelector("form button")?.textContent === "Download"`, "the link's page");
        await ev(`document.querySelector("form button").click()`);
        await waitForFile(`${downloads}/share-me.txt`, "share-me.txt, from the Download button");
        await sleep(500);
        if (readFileSync(`${downloads}/share-me.txt`, "utf8") !== "shared with wget\n") {
            throw new Error("the Download button saved the wrong share-me.txt");
        }
        // That was its one download.
        if (httpCode(url) !== "410") {
            throw new Error("the link still works after its one download, from the button");
        }
        // Given more from Share links, where it's listed first,
        // the newest: it works again, at the same address.
        await open("fs/#shares", `!!document.querySelector("#shares .shares-table")`, "Share links");
        const listedLink = `[...document.querySelectorAll("#shares .shares-table tr")].find((r) => r.textContent.includes("share-me.txt"))`;
        await ev(`${listedLink}.querySelector("button.change").click()`);
        await waitFor(`document.querySelectorAll("dialog[open] select").length === 2`, "the Change dialog");
        await ev(`document.querySelectorAll("dialog[open] select")[1].value = "5"`);
        await answer();
        await waitFor(`/Changed the link to share-me.txt/.test(${status}) && ${listedLink}?.textContent.includes("1 of 5")`, "the link, changed");
        if (httpCode(url) !== "200") {
            throw new Error("the link given more downloads still doesn't work");
        }
        // Shown again, as it was made.
        await ev(`${listedLink}.querySelector("button.show-link").click()`);
        const shown = await linkFrom("the link, shown again");
        if (shown !== url) {
            throw new Error(`shown again as ${shown}, not ${url}`);
        }
        return "the page three times, then the button: one download; then given 5, and shown again";
    });

    await step("upload links: from a browser, and with curl -T", async () => {
        await open("fs/#/", `!!document.querySelector("button.upload-link")`, "the listing");
        await ev(`document.querySelector("button.upload-link").click()`);
        await answer("from the browser check");  // its label
        const url = await linkFrom("the upload link");
        if (!/\/fs\/[A-Za-z0-9_-]{22}\/$/.test(url)) {
            throw new Error(`the upload link is ${url}`);
        }
        writeFileSync(`${work}/via-curl.txt`, "sent with curl\n");
        const sent = execFileSync("curl", ["-fsS", "-T", `${work}/via-curl.txt`, url], { encoding: "utf8" });
        if (sent.trim() !== "Uploaded via-curl.txt") {
            throw new Error(`curl -T says ${sent}`);
        }
        // Its page, in Chrome, picking a file.
        writeFileSync(`${work}/via-page.txt`, "sent from the page\n");
        await open(url.slice(base.length), `!!document.querySelector("form.upload input[type=file]")`, "the upload page");
        await setFiles("form.upload input[type=file]", [`${work}/via-page.txt`]);
        // Marked, to tell the page's script sending it (which stays on
        // the page) from the form posting it, which it falls back to if
        // the script is blocked: one that loads the page again.
        await ev(`window.stayed = true; document.querySelector("form.upload button").click()`);
        await waitFor(`document.getElementById("sent")?.textContent.includes("Uploaded via-page.txt")`, "the upload from the page");
        if (!(await ev(`window.stayed === true`))) {
            throw new Error("the upload page's script didn't run: the form posted the file instead");
        }
        for (const [name, text] of [["via-curl.txt", "sent with curl"], ["via-page.txt", "sent from the page"]]) {
            if (inContainer("cat", `/home/user/Downloads/${name}`) !== text) {
                throw new Error(`${name} wasn't saved right`);
            }
        }
        // A big one, in pieces, through a connection lost part way: the
        // page carries on from where it got to.
        const big = randomBytes(40 << 20);
        writeFileSync(`${work}/pieces.bin`, big);
        await cdp("Network.enable");
        await cdp("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 8 << 20 });
        await setFiles("form.upload input[type=file]", [`${work}/pieces.bin`]);
        await ev(`document.querySelector("form.upload button").click()`);
        await waitFor(`(document.querySelector("#sent li:last-child progress")?.value ?? 0) > 0.3`, "the big upload to get going");
        await cdp("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        await waitFor(`document.querySelector("#sent li:last-child")?.textContent.includes("connection lost, trying again")`, "the page to say it's trying again");
        await sleep(1500);
        await cdp("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        await waitFor(`document.getElementById("sent")?.textContent.includes("Uploaded pieces.bin")`, "the big upload, carried on", 120000);
        await cdp("Network.disable");
        if (inContainer("sha256sum", "/home/user/Downloads/pieces.bin").split(" ")[0] !== createHash("sha256").update(big).digest("hex")) {
            throw new Error("pieces.bin was saved wrong");
        }
        if (!(await ev(`window.stayed === true`))) {
            throw new Error("the upload page loaded again, so its script didn't send pieces.bin");
        }
        // Listed, with the three files.
        await open("fs/#shares", `!!document.querySelector("#shares .shares-table")`, "Share links");
        await waitFor(`[...document.querySelectorAll("#shares .shares-table tr")].some((r) => r.textContent.includes("Upload into Downloads/")
            && r.textContent.includes("3 of 10 files") && r.querySelector("strong")?.textContent === "from the browser check")`,
            "the upload link, listed with its label");
        return "curl -T, the page, and 40 MB in pieces through a lost connection";
    });

    await step("security: a warning when the client IP looks like a proxy's", async () => {
        // Through a proxy of the check's own, which says who it passes on
        // in X-Forwarded-For but isn't trusted: the gateway then takes the
        // proxy (Docker's gateway, as the container sees it) as the client.
        const target = new URL(base);
        const xff = "203.0.113.9";
        const proxy = http.createServer((req, res) => {
            const up = http.request({ host: target.hostname, port: target.port, method: req.method, path: req.url,
                headers: { ...req.headers, "x-forwarded-for": xff } }, (r) => {
                res.writeHead(r.statusCode, r.headers);
                r.pipe(res);
            });
            up.on("error", () => res.destroy());
            req.pipe(up);
        });
        proxy.on("upgrade", (req, socket, head) => {
            const up = net.connect(Number(target.port), target.hostname, () => {
                const lines = [`${req.method} ${req.url} HTTP/1.1`];
                for (let i = 0; i < req.rawHeaders.length; i += 2) {
                    lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
                }
                up.write([...lines, `X-Forwarded-For: ${xff}`, "", ""].join("\r\n"));
                up.write(head);
                socket.pipe(up).pipe(socket);
            });
            up.on("error", () => socket.destroy());
            socket.on("error", () => up.destroy());
        });
        await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
        const tab = await newTab(`http://127.0.0.1:${proxy.address().port}${target.pathname}fs/#sessions`);
        try {
            await tab.waitFor(`!!document.querySelector("#tabtop_login input")`, "the login form, through the proxy");
            const code = await totp();
            await tab.ev(`(() => { const i = document.querySelector("#tabtop_login input"); i.value = ${JSON.stringify(code)}; i.form.requestSubmit(); })()`);
            await tab.waitFor(`!!document.querySelector("#sessions .ip-warning")`, "the warning");
            const text = await tab.ev(`document.querySelector("#sessions .ip-warning").textContent`);
            if (!/sees this browser as [\d.]+, which looks like a proxy's address/.test(text) || !text.includes("WEB_TRUSTED_PROXIES=")) {
                throw new Error(`the warning says ${text}`);
            }
            if (!(await tab.ev(`document.querySelector(".tabtop-nav button.security").classList.contains("attention")`))) {
                throw new Error("Sessions and Activity isn't marked");
            }
            // Logged out again, so the other session doesn't mark the
            // main tab's page.
            await tab.ev(`document.querySelector(".tabtop-nav button.logout").click()`);
            await tab.waitFor(`!!document.querySelector("#tabtop_login input")`, "the login form, logged out");
        } finally {
            await tab.close();
            proxy.close();
            proxy.closeAllConnections?.();
        }
        // Without the proxy, no warning.
        await open("fs/#/", `!!document.querySelector("table")`, "the listing");
        await open("fs/#sessions", `!!document.querySelector("#sessions .sessions-table")`, "Sessions and Activity, directly");
        if (await ev(`!!document.querySelector("#sessions .ip-warning")`)) {
            throw new Error("the warning shows without the proxy");
        }
        return "through an untrusted proxy, and not without it";
    });

    await step("files: fetch from a URL", async () => {
        // resume.bin, from a server of the check's own on this machine,
        // which the container reaches through Docker's gateway: a private
        // address, which this container's WEB_FETCH_PRIVATE=1 allows.
        const server = http.createServer((req, res) => {
            if (req.url !== "/resume.bin") {
                res.writeHead(404).end();
                return;
            }
            const data = readFileSync(`${work}/resume.bin`);
            res.writeHead(200, { "Content-Length": data.length, "Content-Type": "application/octet-stream" }).end(data);
        });
        await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
        const inspect = (f) => execFileSync("docker", ["inspect", "-f", f, container], { encoding: "utf8" }).trim();
        const gateway = inspect("{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}");
        const own = inspect("{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}");
        try {
            await open("fs/#/", `${listed}.includes("resume.bin")`, "the listing");
            await ev(`document.querySelector("button.fetch-url").click()`);
            await answer(`http://${gateway}:${server.address().port}/resume.bin`);
            await waitFor(`/resume \\(1\\).bin: fetched from [\\d.]+:\\d+ into Downloads/.test(${status})`, "the fetch", 120000);
        } finally {
            server.close();
            server.closeAllConnections?.();
        }
        const sums = inContainer("sh", "-c", "sha256sum ~/Downloads/resume.bin ~/Downloads/'resume (1).bin' | cut -d' ' -f1 | uniq | wc -l");
        if (sums !== "1") {
            throw new Error("resume (1).bin isn't the same as resume.bin");
        }
        await waitFor(`${listed}.includes("resume (1).bin")`, "resume (1).bin, listed");
        // From this machine itself: refused, by 127.0.0.1 and by the
        // container's own address on its network, private as it is.
        for (const host of ["127.0.0.1", own]) {
            await ev(`document.querySelector("button.fetch-url").click()`);
            await answer(`http://${host}:6080/fs/`);
            await waitFor(`(${status}).includes("${host}:6080: not fetched: that address is on this machine")`, `the fetch from ${host}, refused`);
        }
        return "200 MB from the Docker host; 127.0.0.1 and the container's own address refused";
    });

    await step("security: the activity log, downloaded and cleared", async () => {
        await open("fs/#/media/", `${listed}.includes("tone.wav")`, "the folder before opening the tabs");
        await ev(`document.querySelector(".tabtop-nav button.shares").click()`);
        await waitFor(`location.hash === "#shares" && document.title === "Share links" && !!document.querySelector("#shares .cleanup")`, "Share links");
        if (await ev(`!!document.querySelector("#shares .activity, #shares .sessions-table, #shares .logins-table")`)) {
            throw new Error("the share links tab includes sessions or activity");
        }
        if (!(await ev(`!!(document.querySelector("#shares .shares-table").compareDocumentPosition(document.querySelector("#shares .cleanup")) & Node.DOCUMENT_POSITION_FOLLOWING)`))) {
            throw new Error("Temporary files is not after the share links");
        }
        await ev(`document.querySelector(".tabtop-nav button.shares").click()`);
        await waitFor(`location.hash === "#/media/" && ${listed}.includes("tone.wav")
            && document.querySelector(".tabtop-nav button.shares").getAttribute("aria-pressed") === "false"`, "back to the previous folder");
        await ev(`document.querySelector(".tabtop-nav button.security").click()`);
        await waitFor(`location.hash === "#sessions" && document.title === "Sessions and Activity" && !!document.querySelector("#sessions .activity-table")
            && document.querySelector(".tabtop-nav button.security").getAttribute("aria-pressed") === "true"
            && document.querySelector(".tabtop-nav button.shares").getAttribute("aria-pressed") === "false"`, "Sessions and Activity");
        const headings = await ev(`[...document.querySelectorAll("#sessions h2")].map((h) => h.textContent)`);
        if (headings.join() !== "Sessions,Recent logins,Activity" || await ev(`!!document.querySelector("#sessions .shares-table, #sessions .cleanup")`)) {
            throw new Error(`the sessions tab's sections: ${headings}`);
        }
        await open("fs/#sessions", `!!document.querySelector("#sessions .activity-table") && document.title === "Sessions and Activity"`, "Sessions and Activity, opened directly");
        const table = `document.querySelector("#sessions .activity-table").textContent`;
        await ev(`document.querySelector("#sessions .activity button.more")?.click()`);
        for (const want of ["logged in with Chrome on Linux", "login failed", "made a share link to share-me.txt",
            "downloaded share-me.txt through a share link", "made an upload link to Downloads", "uploaded via-curl.txt",
            "uploaded pieces.bin", "fetched resume (1).bin", "from 127.0.0.1:6080 failed", "failed: that address is on this machine"]) {
            await waitFor(`${table}.includes(${JSON.stringify(want)})`, `"${want}" in the activity log`);
        }
        // Kept in the file the entrypoint names, which no token is in.
        const kept = inContainer("cat", "/home/user/.config/tabtop/activity.jsonl");
        if (!kept.includes("made a share link to share-me.txt") || /\/fs\/[A-Za-z0-9_-]{22}/.test(kept)) {
            throw new Error("the activity log's file doesn't hold what it should, or holds a link");
        }
        // Filtered: failed logins only, then by words.
        const shownRows = `[...document.querySelectorAll("#sessions .activity-table tr")].slice(1).map((r) => r.textContent)`;
        await ev(`(() => { const s = document.querySelector("#sessions .activity select.kind"); s.value = "login-failed"; s.dispatchEvent(new Event("change")); })()`);
        await waitFor(`${shownRows}.length > 0 && ${shownRows}.every((t) => t.includes("login failed"))`, "only failed logins");
        await ev(`(() => { const s = document.querySelector("#sessions .activity select.kind"); s.value = ""; s.dispatchEvent(new Event("change")); })()`);
        await waitFor(`!!document.querySelector("#sessions .activity input.filter")`, "the filter box");
        await ev(`(() => { const i = document.querySelector("#sessions .activity input.filter"); i.value = "share-me"; i.dispatchEvent(new Event("input")); })()`);
        await waitFor(`${shownRows}.length > 0 && ${shownRows}.every((t) => t.includes("share-me"))
            && /\\d+ of \\d+ shown/.test(document.querySelector("#sessions .activity .find").textContent)`, "only share-me.txt's entries");
        await ev(`(() => { const i = document.querySelector("#sessions .activity input.filter"); i.value = ""; i.dispatchEvent(new Event("input")); })()`);
        await waitFor(`!document.querySelector("#sessions .activity .find .hint")`, "the filter, cleared");
        // Downloaded, oldest first.
        await ev(`document.querySelector("#sessions .activity button.download").click()`);
        const name = `tabtop-activity-${new Date().toISOString().slice(0, 10)}.tsv`;
        await waitForFile(`${downloads}/${name}`, name);
        await sleep(300);
        const lines = readFileSync(`${downloads}/${name}`, "utf8").trim().split("\n");
        if (lines[0] !== "time\tfrom\tsession\tkind\twhat" || !lines[1].includes("\tlogin\t") || lines.length < 10) {
            throw new Error(`${name} starts ${lines.slice(0, 2).join(" | ")}`);
        }
        // Cleared: one entry left, saying so.
        await ev(`document.querySelector("#sessions .activity button.clear").click()`);
        await answer();
        await waitFor(`document.querySelectorAll("#sessions .activity-table tr").length === 2 && ${table}.includes("cleared the activity log")`,
            "the log, cleared");
        return `${lines.length - 1} entries downloaded, then cleared`;
    });

    await step("security: links revoked together, and cleaning up", async () => {
        await open("fs/#shares", `!!document.querySelector("#shares .shares-table")`, "the links");
        const links = `document.querySelectorAll("#shares .shares-table button.revoke").length`;
        // Those used up, in one go (the direct download links each used once).
        const before = await ev(links);
        const usedUp = await ev(`Number(document.querySelector("#shares button.revoke-used-up")?.textContent.match(/\\d+/)?.[0] ?? 0)`);
        if (!usedUp) {
            throw new Error("no links are offered as used up");
        }
        await ev(`document.querySelector("#shares button.revoke-used-up").click()`);
        await answer();
        await waitFor(`/Revoked ${usedUp} link/.test(${status}) && ${links} === ${before - usedUp}`, "the used-up links, revoked");
        // Two ticked, revoked together.
        await ev(`[...document.querySelectorAll("#shares .shares-table td.sel input")].slice(0, 2).forEach((c) => c.click())`);
        await waitFor(`document.querySelector("#shares button.revoke-picked").textContent === "Revoke 2 selected…"`, "two ticked");
        await ev(`document.querySelector("#shares button.revoke-picked").click()`);
        await answer();
        await waitFor(`/Revoked 2 links/.test(${status}) && ${links} === ${before - usedUp - 2}`, "the two, revoked");
        // A temporary file a crash left, an hour old: cleaned up.
        inContainer("sh", "-c", "head -c 1000 /dev/zero > ~/Downloads/.tabtop-upload-0123456789abcdef.part && "
            + "touch -d '1 hour ago' ~/Downloads/.tabtop-upload-0123456789abcdef.part");
        await ev(`document.querySelector("#shares button.clean-up").click()`);
        await waitFor(`/leftover temporary file/.test(document.querySelector("dialog[open]")?.textContent ?? "")`, "what cleaning up would delete");
        await answer();
        await waitFor(`/Cleaned up/.test(${status})`, "the cleanup");
        if (inContainer("sh", "-c", "ls -a ~/Downloads | grep -c '^.tabtop-upload-' || true") !== "0") {
            throw new Error("the temporary file is still there");
        }
        return `${usedUp} used up, then 2 picked, revoked; one leftover cleaned up`;
    });

    await step("security: names, several links changed, and choices remembered", async () => {
        // The Share dialog starts with the choices made last time.
        await open("fs/#/", `${listed}.includes("share-me.txt")`, "the listing");
        await ev(`${row("share-me.txt")}.querySelector("button.share").click()`);
        await waitFor(`document.querySelectorAll("dialog[open] select").length === 2`, "the Share dialog");
        await ev(`document.querySelectorAll("dialog[open] select")[1].value = "5"`);
        await answer();
        await linkFrom("the link, allowing 5");
        await ev(`${row("share-me.txt")}.querySelector("button.share").click()`);
        await waitFor(`document.querySelectorAll("dialog[open] select").length === 2`, "the Share dialog again");
        const again = await ev(`document.querySelectorAll("dialog[open] select")[1].value`);
        await ev(`document.querySelector("dialog[open] button:not(.primary)").click()`);
        if (again !== "5") {
            throw new Error(`the Share dialog starts with ${again} downloads, not the 5 chosen last time`);
        }
        // This browser's session, named.
        await open("fs/#sessions", `!!document.querySelector("#sessions .sessions-table")`, "Sessions and Activity");
        const mine = `[...document.querySelectorAll("#sessions .sessions-table tr")].find((r) => r.textContent.includes("(this browser)"))`;
        await ev(`${mine}.querySelector("button.name-session").click()`);
        await answer("browser check");
        await waitFor(`${mine}?.querySelector("strong")?.textContent === "browser check"`, "the session, named");
        if (await ev(`localStorage.getItem("tabtop.session-name")`) !== "browser check") {
            throw new Error("this browser didn't keep its session's name");
        }
        await ev(`document.querySelector(".tabtop-nav button.shares").click()`);
        await waitFor(`!!document.querySelector("#shares .shares-table")`, "the share links");
        // Links about to end are marked.
        if (!(await ev(`!!document.querySelector("#shares .shares-table .soon")?.textContent.startsWith("ends in")`))) {
            throw new Error("no link is marked as ending soon");
        }
        // Two links changed together: a week from now, labelled.
        await ev(`[...document.querySelectorAll("#shares .shares-table td.sel input")].slice(0, 2).forEach((c) => c.click())`);
        await ev(`document.querySelector("#shares button.change-picked").click()`);
        await waitFor(`!!document.querySelector("dialog[open] select")`, "the Change dialog");
        await ev(`document.querySelector("dialog[open] select").value = "604800"`);
        await answer("for Alice");
        await waitFor(`/Changed 2 links/.test(${status}) && [...document.querySelectorAll("#shares .shares-table strong")]
            .filter((s) => s.textContent === "for Alice").length === 2`, "the two links, changed");
        // The activity log names the session that did it.
        await ev(`document.querySelector(".tabtop-nav button.security").click()`);
        await waitFor(`[...document.querySelectorAll("#sessions .activity-table tr")].some((r) => r.textContent.includes("changed 2 links")
            && r.textContent.includes("browser check"))`, "the change, in the activity log with the session's name");
        return "Share dialog remembered 5; session named; 2 links changed";
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
        await open("fs/#/", `${listed}.includes("tty-check.txt")`, "tty-check.txt, written in the terminal");
    });

    await step("terminal: font menu", async () => {
        await open("tty/", `!!document.querySelector("canvas")`, "the terminal");
        // TabTop's own font, both weights, loaded before it drew, with the
        // Nerd Font's icons (U+E0B0 is the status line's arrow).
        await waitFor(`[...document.fonts].filter((f) => f.family.replaceAll('"', "") === "TabTop JetBrains Mono" && f.status === "loaded").length === 2`,
            "TabTop's font, regular and bold");
        if (!(await ev(`document.fonts.check('14px "TabTop JetBrains Mono"', "\ue0b0 \uf418")`))) {
            throw new Error("TabTop's font has no Nerd Font icons");
        }
        const menu = `document.getElementById("tty_font_menu")`;
        const select = `document.getElementById("tty_font_family")`;
        await click(`document.querySelector(".tabtop-nav button.font")`);
        await waitFor(`!${menu}.hidden`, "the font menu");
        const first = await ev(`${select}.options[0].textContent`);
        if (first !== "JetBrains Mono Nerd Font (TabTop's)") {
            throw new Error(`the menu starts with ${first}`);
        }
        // A font this computer hasn't got: kept, said so, and TabTop's drawn.
        await ev(`(() => { const s = ${select}; s.value = s.options[s.options.length - 1].value; s.dispatchEvent(new Event("change")); })()`);
        await ev(`(() => { const i = ${menu}.querySelector("input"); i.value = "No Such Font"; i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
        await waitFor(`localStorage.getItem("tabtop-tty-font-family") === "No Such Font"`, "the font kept");
        await waitFor(`${menu}.querySelector(".note:not([hidden])")?.textContent.includes("doesn't seem to have No Such Font")`, "the menu to say it's missing");
        await click(`[...${menu}.querySelectorAll("button")].find((b) => b.textContent === "+")`);
        await waitFor(`localStorage.getItem("tabtop-tty-font-size") === "15" && document.getElementById("tty_font_size").textContent === "15 px"`, "a bigger font");
        await click(`[...${menu}.querySelectorAll("button")].find((b) => b.textContent === "Reset")`);
        await waitFor(`localStorage.getItem("tabtop-tty-font-size") === null`, "the size back");
        await ev(`(() => { const s = ${select}; s.value = ""; s.dispatchEvent(new Event("change")); })()`);
        await waitFor(`localStorage.getItem("tabtop-tty-font-family") === null`, "TabTop's font again");
        await press("Escape");
        await waitFor(`${menu}.hidden`, "the menu to close");
        return `${await ev(`${select}.options.length - 2`)} of this computer's fonts offered`;
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
        await open("fs/#/", `${listed}.includes("dropped-copy.txt")`, "dropped-copy.txt, copied from the path typed");
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

    await step("terminal: notifications", async () => {
        // Headless Chrome shows none, so a stand-in records them; and the
        // tab counts as in front, so it's made to seem not to be.
        await ev(`(() => {
            window.shownNotices = [];
            window.Notification = class {
                static permission = "granted";
                static requestPermission() { return Promise.resolve("granted"); }
                constructor(title, o) { window.shownNotices.push(title + ": " + o.body); }
                addEventListener() {}
                close() {}
            };
            document.hasFocus = () => false;
            return true;
        })()`);
        const bell = `document.querySelector(".tabtop-nav button.notify")`;
        await ev(`${bell}.click()`);
        await waitFor(`${bell}.getAttribute("aria-pressed") === "true"`, "notifications on");
        await click(`document.querySelector("canvas")`);
        await type("notify checked-$((40+2))");
        await press("Enter");
        await waitFor(`window.shownNotices.includes("Terminal: checked-42") && document.title.startsWith("🔔")`,
            "the notification, and the title marked");
        await type("printf '\\a'");
        await press("Enter");
        await waitFor(`window.shownNotices.some((n) => n.endsWith(": The terminal rang its bell."))`, "the bell's notification");
        // Back in front: the mark goes.
        await ev(`document.hasFocus = () => true; window.dispatchEvent(new Event("focus")); true`);
        await waitFor(`!document.title.startsWith("🔔")`, "the title's mark to go");
        await ev(`${bell}.click()`);
        await waitFor(`${bell}.getAttribute("aria-pressed") === "false"`, "notifications off");
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
        await open("fs/#/", `${listed}.includes("keys.txt")`, "keys.txt, written with Ctrl U from the touch keys");
    });

    await step("a warning before the login ends", async () => {
        // A terminal open in another tab, to go on with the new login too.
        const tty = await newTab(base + "tty/");
        try {
            await tty.waitFor(`!!document.querySelector("canvas")`, "the terminal in another tab");
            await open("vnc.html?autoconnect=1", `document.documentElement.classList.contains("noVNC_connected")`, "the desktop");
            const sessionKey = JSON.stringify(await ev(`import("/tabtop/session-state.js").then((m) => m.SESSION_KEY)`));
            const old = await ev(`localStorage.getItem(${sessionKey})`);
            // As if it ends in 5 minutes.
            await ev(`(() => { const s = JSON.parse(localStorage.getItem(${sessionKey})); s.expires = Date.now() + 5 * 60000 - 1000;
                localStorage.setItem(${sessionKey}, JSON.stringify(s)); document.dispatchEvent(new Event("visibilitychange")); })()`);
            await waitFor(`/ends in 5 minutes/.test(document.getElementById("tabtop_expiry")?.textContent)`, "the warning on the desktop");
            // The other tab warns too, in its bar.
            await tty.waitFor(`/ends in 5 min/.test(document.querySelector(".tabtop-nav #tabtop_expiry")?.textContent)`, "the warning in the terminal");
            await ev(`[...document.querySelectorAll("#tabtop_expiry button")].find((b) => b.textContent === "Log in again").click()`);
            await waitFor(`!!document.querySelector("#tabtop_login input")`, "the login form");
            const code = await totp();
            await ev(`(() => { const i = document.querySelector("#tabtop_login input"); i.value = ${JSON.stringify(code)}; i.form.requestSubmit(); })()`);
            await waitFor(`!document.querySelector("#tabtop_login") && !document.getElementById("tabtop_expiry")`, "the warning to go");
            await tty.waitFor(`!document.getElementById("tabtop_expiry")`, "the warning to go from the terminal");
            const expires = await ev(`JSON.parse(localStorage.getItem(${sessionKey})).expires - Date.now()`);
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
        await open("fs/#/", `${listed}.includes("renewed.txt")`, "renewed.txt, written after the old login ended");
    });

    await step("logout", async () => {
        // An icon here, named for screen readers.
        const out = `document.querySelector(".tabtop-nav button.logout")`;
        await waitFor(`!!${out}`, "the logout button");
        const old = await ev(`import("/tabtop/session-state.js").then((m) => m.storedSession())`);
        await ev(`${out}.click()`);
        await waitFor(`!!document.querySelector("#tabtop_login")`, "the login form after logout");
        const revoked = await ev(`import("/tabtop/tunnel.js").then((m) => m.Tunnel.open({ type: "sessions" }, ${JSON.stringify(old)}))
            .then((t) => { t.close(); return false; }, (e) => e.login === true)`);
        if (!revoked) { throw new Error("the logged-out session still authenticates"); }
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
