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
// notice offers to download it here (see watchDownloads).

import { TunnelSocket } from "./tunnel.js";
import { logOut, nameTab, openPage, terminalOn } from "./nav.js";
import { dropUploads } from "./drop.js";
import { call, fileNames, makeFolder, setLoginTitle, uploadFile } from "./requests.js";
import { fetchFile, humanBytes } from "./download.js";

window.tabtopChannel = () => new TunnelSocket({ type: "vnc" }, { title: "Desktop" });

nameTab("desktop");

const icon = (body) => "data:image/svg+xml," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="25" height="25" viewBox="0 0 25 25" fill="none" ' +
    'stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + body + "</svg>");

const buttons = [
    ["terminal", "Terminal (opens in its own tab)", icon('<rect x="3" y="5" width="19" height="15" rx="2"/><path d="M7 10l3 2.5-3 2.5m5 1h5"/>'),
        () => openPage("terminal")],
    ["files", "Files in Downloads (opens in its own tab)", icon('<path d="M3 7.5a1.5 1.5 0 0 1 1.5-1.5h5l2 2.5h9a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5h-16a1.5 1.5 0 0 1-1.5-1.5z"/>'),
        () => openPage("files")],
    ["logout", "Log out (here, in the terminal and on the files page)", icon('<path d="M10 4.5h-5v16h5m4-12l4.5 4-4.5 4m4.5-4h-10"/>'),
        logOut],
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
dropUploads(uploadFile, makeFolder, () => {}, () => "", "(~/Downloads)", fileNames);

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
        button("Files", "", () => openPage("files")),
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

new MutationObserver(() => {
    const connected = document.documentElement.classList.contains("noVNC_connected");
    if (connected !== wanted) {
        wanted = connected;
        connected ? watchDownloads() : watching?.close();
    }
}).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
