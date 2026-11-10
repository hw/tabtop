// Checks a running TabTop end to end in headless Chrome, through the pages
// a person uses: login, desktop, audio, the files page (list, free space,
// download, preview, upload, replacing on a name clash, pasting, the
// keyboard, delete, updating itself, going back to the folder last shown,
// folder upload picked and dropped, folder delete, zips, new folder,
// new file, rename, move, copying a path, deleting several, cancelling an upload,
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

import { createBrowserHarness, sleep } from "./browser/harness.mjs";
import { checkBinary } from "./browser/binary.mjs";
import { checkZIP } from "./browser/zip.mjs";
import { checkAudio, checkVideo, checkMKV } from "./browser/media.mjs";
import { checkText, checkHTML, checkExternalResources, checkMarkdownRender, checkMarkdownLinks, checkTextEdit, checkPDF, checkEPUB, checkEPUBPictureBudget } from "./browser/documents.mjs";
import { checkCells, checkStructured } from "./browser/tables.mjs";
import { checkStylesheetConditions } from "./browser/stylesheet-conditions.mjs";
import { checkSavedHTML } from "./browser/saved-html.mjs";
import { checkStylesAndMedia } from "./browser/styles-media.mjs";
import { checkServices } from "./browser/services.mjs";

const [port, base, downloads, work, container, group = "all"] = process.argv.slice(2);
// inContainer runs a command in the container as its user, and returns
// what it prints.
const inContainer = (...args) => execFileSync("docker", ["exec", "-u", "user", container, ...args], { encoding: "utf8" }).trim();
const browser = await createBrowserHarness({ port, base });
const { cdp, ev, waitFor, click, press, type, open, newTab, listed, row, answer, waitForFile, status, setFiles, inFrame, inMarkdownFrame, checkPreviewLink, exceptions } = browser;
const rendered = `JSON.parse(document.querySelector("dialog.preview iframe.markdown")?.dataset.rendered ?? "null")`;

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

const checks = { port, base, downloads, work, container, inContainer, sleep, step, totp, cdp, ev, waitFor, click, press, type, open, newTab, listed, row, answer, waitForFile, status, setFiles, inFrame, inMarkdownFrame, checkPreviewLink, rendered };
const groups = {
    services: [checkServices],
    binary: [checkBinary], zip: [checkZIP], audio: [checkAudio], video: [checkVideo], mkv: [checkMKV],
    media: [checkAudio, checkVideo, checkMKV], text: [checkText], html: [checkStylesheetConditions, checkSavedHTML, checkStylesAndMedia, checkExternalResources, checkHTML],
    markdown: [checkMarkdownRender, checkMarkdownLinks, checkTextEdit], editing: [checkTextEdit], pdf: [checkPDF],
    epub: [checkEPUB, checkEPUBPictureBudget], tables: [checkCells, checkStructured],
    previews: [checkStylesheetConditions, checkSavedHTML, checkStylesAndMedia, checkExternalResources, checkBinary, checkZIP, checkAudio, checkVideo, checkMKV, checkText, checkHTML, checkMarkdownRender, checkMarkdownLinks, checkTextEdit, checkPDF, checkEPUB, checkEPUBPictureBudget, checkCells, checkStructured],
};
if (group !== "all" && !groups[group]) throw new Error(`Unknown group ${group}; choose all, ${Object.keys(groups).join(", ")}`);

try {
    await cdp("Runtime.enable");
    await cdp("Log.enable");
    await cdp("Page.enable");
    await cdp("DOM.enable");
    await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await cdp("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
    await cdp("Page.addScriptToEvaluateOnNewDocument", { source: socketHook });

    if (group !== "all") {
        await step("login for " + group, async () => {
            await open(group === "services" ? "tty/" : "fs/#/", `!!document.querySelector("#tabtop_login input")`, "the login form");
            const code = await totp();
            await ev(`(() => { const i = document.querySelector("#tabtop_login input"); i.value = ${JSON.stringify(code)}; i.form.requestSubmit(); })()`);
            await waitFor(group === "services" ? `!document.querySelector("#tabtop_login") && !!document.querySelector("#terminal canvas")`
                : `!document.querySelector("#tabtop_login") && ${listed}.includes("hello.txt")`, "the logged-in page");
        });
        for (const check of groups[group]) await check(checks);
    } else {
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
        await waitFor(`document.activeElement?.closest("tr")?.dataset.name === "hello.txt"`, "focus restored to the previewed file");
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
        if (!(await ev(`!!document.querySelector(".retry-preview") && !!document.querySelector(".download-fallback")`))) throw new Error("failed preview lost its recovery actions");
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

    await checkZIP(checks);

    await checkAudio(checks);

    await checkVideo(checks);

    await checkMKV(checks);

    await checkBinary(checks);
    await checkText(checks);

    await checkStylesheetConditions(checks);
    await checkSavedHTML(checks);
    await checkHTML(checks);
    await checkExternalResources(checks);
    await checkStylesAndMedia(checks);

    await checkMarkdownRender(checks);

    await checkMarkdownLinks(checks);

    await checkTextEdit(checks);

    await checkPDF(checks);

    await checkEPUB(checks);
    await checkEPUBPictureBudget(checks);

    await checkCells(checks);

    await checkStructured(checks);

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

    await step("files: new folder, new file and rename", async () => {
        await ev(`[...document.querySelectorAll("p.upload button")].find((b) => b.textContent === "New folder…").click()`);
        await answer("made-here");
        await waitFor(`${listed}.includes("made-here/")`, "made-here/");
        await ev(`[...document.querySelectorAll("p.upload button")].find((b) => b.textContent === "New file…").click()`);
        await answer("notes.md");
        await waitFor(`${listed}.includes("notes.md")`, "notes.md");
        await ev(`[...document.querySelectorAll("p.upload button")].find((b) => b.textContent === "New file…").click()`);
        await answer("notes.md");
        await waitFor(`${listed}.includes("notes (1).md")`, "notes.md taken → notes (1).md");
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

    }

    await step("no uncaught errors in the pages", async () => {
        if (exceptions.length) {
            throw new Error(exceptions.join("; "));
        }
    });
} catch {
    // Reported by step.
}
browser.close();
process.exit(failed ? 1 : 0);
