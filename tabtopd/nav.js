// Links between the site's pages, the desktop, the terminal and the files
// page, and logging out, served by tabtopd. Each page shows them its own
// way: novnc.js in noVNC's control bar, tty.js and files.js in a bar at
// the top (see navBar).
//
// Each page names its tab after itself, and the links open a page in the
// tab of that name, so a tab already showing it is used again (where the
// browser lets one tab find another, as for tabs opened from each other)
// rather than a new one opened each time.

import { forgetSession, request } from "./tunnel.js";

const root = new URL("../", import.meta.url);  // the site's root, under any base path

export const pages = [
    { id: "desktop", label: "Desktop", href: new URL("vnc.html?autoconnect=1", root).href },
    { id: "terminal", label: "Terminal", href: new URL("tty/", root).href },
    { id: "files", label: "Files", href: new URL("downloads/", root).href },
];

const tabName = (id) => `tabtop-${id}`;

// nameTab names this tab after the page it shows.
export function nameTab(id) {
    window.name = tabName(id);
}

// openPage opens the page id in its tab, at hash if given.
export function openPage(id, hash = "") {
    const page = pages.find((p) => p.id === id);
    window.open(page.href + hash, tabName(id))?.focus();
}

// terminalOn resolves to whether the site serves a terminal: it can be
// turned off (WEB_TTY=0).
let terminal = null;
export function terminalOn() {
    terminal ??= fetch(new URL("tty/", root), { method: "HEAD", cache: "no-store" }).then((r) => r.ok, () => true);
    return terminal;
}

// logOut ends the session, everywhere it's used, and reloads this page,
// which then asks for a login.
export async function logOut() {
    try {
        await request({ type: "logout" });
    } catch {
        // Forgotten here either way.
    }
    forgetSession();
    location.reload();
}

// navBar makes a bar of links to the other pages, the current one, named
// current, shown as where you are, and a Log out button.
export function navBar(current) {
    const nav = document.createElement("nav");
    nav.className = "tabtop-nav";
    nav.setAttribute("aria-label", "TabTop");
    for (const page of pages) {
        let item;
        if (page.id === current) {
            item = document.createElement("span");
            item.setAttribute("aria-current", "page");
        } else {
            item = document.createElement("a");
            item.href = page.href;
            item.target = tabName(page.id);
            if (page.id === "terminal") {
                terminalOn().then((on) => (item.hidden = !on));
            }
        }
        item.textContent = page.label;
        nav.append(item);
    }
    const out = document.createElement("button");
    out.type = "button";
    out.textContent = "Log out";
    out.addEventListener("click", logOut);
    nav.append(out);
    return nav;
}
