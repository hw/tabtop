// Hooks noVNC up to the encrypted tunnel, served by tabtopd (see e2e.go).
// The image's noVNC asks window.tabtopChannel for a channel to use instead
// of its WebSocket URL: a TunnelSocket carrying RFB. The tunnel's login is
// the desktop's: it shows the login form when there's no session, and
// Xvnc, which only the gateway can reach, asks for nothing more.
//
// It also adds buttons to noVNC's control bar that open the terminal and
// the files page, and log out (see nav.js).

import { TunnelSocket } from "./tunnel.js";
import { logOut, nameTab, openPage, terminalOn } from "./nav.js";

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
