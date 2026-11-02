// Hooks noVNC up to the encrypted tunnel, served by tabtopd (see e2e.go).
// The image's noVNC asks window.tabtopChannel for a channel to use instead
// of its WebSocket URL: a TunnelSocket carrying RFB. The tunnel's login is
// the desktop's: it shows the login form when there's no session, and
// Xvnc, which only the gateway can reach, asks for nothing more.
//
// It also adds buttons to noVNC's control bar that open the terminal and
// the files page, and log out (see nav.js), and uploads files and folders
// dropped on the page into ~/Downloads, as the files page does (see
// drop.js), showing how they go in a transfers panel styled by
// desktop.css. While the desktop is connected, when a file is saved into
// ~/Downloads, as when the desktop's browser finishes downloading one, a
// notice offers to download it here (see watchDownloads), and text copied
// on either side reaches the other's clipboard (see shareClipboard). Ten
// minutes before the login runs out, a banner offers to log in again (see
// expiry.js).

import { TunnelSocket } from "./tunnel.js";
import { iconSVG, logOut, nameTab, openPage, terminalOn } from "./nav.js";
import { dropUploads } from "./drop.js";
import { call, folderInfo, makeFolder, setLoginTitle, uploadFile } from "./requests.js";
import { fetchFile, humanBytes } from "./download.js";
import { warnExpiry } from "./expiry.js";

window.tabtopChannel = () => new TunnelSocket({ type: "vnc" }, { title: "Desktop" });

nameTab("desktop");
warnExpiry();

// White, as noVNC's own icons are.
const icon = (id) => "data:image/svg+xml," + encodeURIComponent(iconSVG(id, "#fff"));

const buttons = [
    ["terminal", "Terminal (opens in its own tab)", icon("terminal"), () => openPage("terminal")],
    ["files", "Files in Downloads (opens in its own tab)", icon("files"), () => openPage("files")],
    ["logout", "Log out (here, in the terminal and on the files page)", icon("logout"), logOut],
];

const settings = document.getElementById("noVNC_settings_button");
if (settings) {
    for (const [id, title, src, onClick] of buttons) {
        const b = Object.assign(document.createElement("input"), { type: "image", id: `tabtop_${id}_button`, className: "noVNC_button", src, alt: title, title });
        b.addEventListener("click", onClick);
        settings.before(b);
        if (id === "terminal") {
            terminalOn().then((on) => b.classList.toggle("noVNC_hidden", !on));
        }
    }
} else {
    console.warn("tabtop: noVNC's control bar wasn't found; no links to the terminal and files");
}

document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href: new URL("./desktop.css", import.meta.url).href }));
setLoginTitle("Desktop");
dropUploads(uploadFile, makeFolder, () => {}, () => "", "(~/Downloads)", folderInfo);

// The notices, newest at the top, at most MAX_NOTICES; each stays until
// it's used or dismissed.
const MAX_NOTICES = 4;
const notices = Object.assign(document.createElement("div"), { id: "tabtop_notices" });
notices.setAttribute("role", "status");
document.body.append(notices);

function notice(name, bytes) {
    const button = (text, className, onClick) => {
        const b = Object.assign(document.createElement("button"), { type: "button", textContent: text, className });
        b.addEventListener("click", onClick);
        return b;
    };
    const text = Object.assign(document.createElement("p"), { textContent: `${name} was saved in Downloads (${humanBytes(bytes)}).` });
    const box = document.createElement("div");
    box.className = "notice";
    box.append(text,
        button("Download", "primary", () => {
            box.remove();
            fetchFile(name);
        }),
        button("Files", "", () => openPage("files", "#/")),  // where it is, not the folder last shown
        button("✕", "close", () => box.remove()));
    box.lastChild.title = box.lastChild.ariaLabel = "Dismiss";
    notices.prepend(box);
    while (notices.children.length > MAX_NOTICES) {
        notices.lastChild.remove();
    }
}

// The watch is only open while the desktop is connected, as the sound is,
// so a tab left disconnected holds nothing open, and the session can end
// for being idle (see session.go).
let wanted = false;    // whether the desktop is connected
let running = false;   // whether watchDownloads is
let watching = null;   // the watch's tunnel, while it's open

// watchDownloads keeps a watch request open while wanted, which the
// server answers with each file saved into ~/Downloads, trying again,
// less often each time, if it's lost; it stops if the server refuses it.
async function watchDownloads() {
    if (running) {
        return;
    }
    running = true;
    for (let wait = 2000; wanted; wait = Math.min(wait * 2, 60000)) {
        try {
            const t = await call({ type: "watch" });
            if (!wanted) {
                t.close();
                break;
            }
            watching = t;
            wait = 2000;
            for (let m; (m = await t.next());) {
                const saved = m.text && JSON.parse(m.text);
                if (saved?.saved) {
                    notice(saved.saved, saved.bytes);
                }
            }
        } catch (err) {
            if (!err.lost) {
                console.warn(`tabtop: no notices of new downloads: ${err.message}`);
                break;
            }
        }
        watching = null;
        if (wanted) {
            await new Promise((r) => setTimeout(r, wait));
        }
    }
    watching = null;
    running = false;
}

// The clipboard -----------------------------------------------------------

// shareClipboard links the desktop's clipboard to this computer's, which
// browsers only allow on HTTPS or localhost. Text copied on the desktop is
// put on this computer's clipboard as it arrives. Text copied here goes to
// the desktop when the page is switched back to, where the browser lets
// the page read the clipboard: Chrome and Edge ask once, the first time
// the desktop is clicked; others, which would ask every time, are left to
// noVNC's clipboard panel. Either way, the panel shows the desktop's.
let shared = null;      // the RFB connection it's set up on
let lastText = null;    // the text last passed either way, not passed back

async function shareClipboard() {
    if (!window.isSecureContext || !navigator.clipboard) {
        return;
    }
    // noVNC's own module, already loaded by the page, and its connection.
    const { default: UI } = await import("../app/ui.js");
    const rfb = UI.rfb;
    if (!rfb || rfb === shared) {
        return;
    }
    shared = rfb;
    rfb.addEventListener("clipboard", (e) => {
        lastText = e.detail.text;
        navigator.clipboard.writeText(e.detail.text).catch(() => {
            // Not focused, or not allowed: the panel has it.
        });
    });
}

// readable resolves to whether the page may read the clipboard without
// asking ("granted"), may ask ("prompt"), or neither.
async function readable() {
    try {
        return (await navigator.permissions.query({ name: "clipboard-read" })).state;
    } catch {
        return "denied";  // a browser without the permission, as Firefox
    }
}

// sendClipboard passes this computer's clipboard to the desktop, if it's
// changed. With ask, it may ask for permission first.
async function sendClipboard(ask = false) {
    if (!wanted || !shared || !window.isSecureContext || !navigator.clipboard?.readText) {
        return;
    }
    const state = await readable();
    if (state !== "granted" && !(ask && state === "prompt")) {
        return;
    }
    let text;
    try {
        text = await navigator.clipboard.readText();
    } catch {
        return;  // refused, or the page isn't focused
    }
    if (text && text !== lastText) {
        lastText = text;
        shared.clipboardPasteFrom(text);
        const panel = document.getElementById("noVNC_clipboard_text");
        if (panel) {
            panel.value = text;
        }
    }
}

addEventListener("focus", () => sendClipboard());
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && sendClipboard());
let asked = false;
document.addEventListener("pointerdown", (e) => {
    if (!asked && wanted && e.target.closest?.("#noVNC_container")) {
        asked = true;
        sendClipboard(true);
    }
}, true);

new MutationObserver(() => {
    const connected = document.documentElement.classList.contains("noVNC_connected");
    if (connected !== wanted) {
        wanted = connected;
        connected ? watchDownloads() : watching?.close();
        if (connected) {
            shareClipboard().then(() => sendClipboard());
        }
    }
}).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
