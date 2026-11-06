// Links between the site's pages, the desktop, the terminal and the files
// page, and logging out, served by tabtopd. Each page shows them its own
// way: novnc.js in noVNC's control bar, tty.js and files.js in a bar at
// the top (see navBar).
//
// Each page names its tab after itself, and the links open a page in the
// tab of that name, so a tab already showing it is used again (where the
// browser lets one tab find another, as for tabs opened from each other)
// rather than a new one opened each time.

import { forgetSession, request, storedSession } from "./tunnel.js";
import { iconSVG } from "./glyphs.js";

const root = new URL("../", import.meta.url);  // the site's root, under any base path

// Replaced by the gateway to match its enabled services.
const enabledPages = { desktop: true, terminal: true, files: true };
export const pages = [
    { id: "desktop", label: "Desktop", href: new URL("vnc.html?autoconnect=1", root).href },
    { id: "terminal", label: "Terminal", href: new URL("tty/", root).href },
    { id: "files", label: "Files", href: new URL("fs/", root).href },
].filter((page) => enabledPages[page.id]);

const tabName = (id) => `tabtop-${id}:${root.href}`;

// nameTab names this tab after the page it shows.
export function nameTab(id) {
    window.name = tabName(id);
}

// openPage opens the page id in its tab, at hash if given.
export function openPage(id, hash = "") {
    const page = pages.find((p) => p.id === id);
    if (!page) return;
    window.open(page.href + hash, tabName(id))?.focus();
}

// terminalOn resolves to whether the site serves a terminal: it can be
// turned off (WEB_TTY=0).
let terminal = null;
export function terminalOn() {
    terminal ??= fetch(new URL("tty/", root), { method: "HEAD", cache: "no-store" }).then((r) => r.ok, () => true);
    return terminal;
}

const LOGOUT_TIMEOUT = 3000;
let loggingOut = null;

// Forget locally before waiting for revocation. A stalled server must not
// leave credentials saved or prevent this page from returning to login.
export function logOut({ everywhere = false } = {}) {
    if (loggingOut) { return loggingOut; }
    const old = storedSession();
    forgetSession();
    loggingOut = revokeSession(old, everywhere ? "logout-all" : "logout").finally(() => {
        loggingOut = null;
        location.reload();
    });
    return loggingOut;
}

async function revokeSession(old, type) {
    if (!old) { return; }
    let timer;
    try {
        await Promise.race([
            request({ type }, old),
            new Promise((resolve) => { timer = setTimeout(resolve, LOGOUT_TIMEOUT); }),
        ]);
    } catch {
        // Local logout still completes if server revocation fails.
    } finally {
        clearTimeout(timer);
    }
}

// navBar makes a bar of links to the other pages, each an icon named by
// its title and label, the current one, named current, shown as where you
// are, and a Log out button: an icon too, with logOutIcon.
export function navBar(current, { logOutIcon = false } = {}) {
    const nav = document.createElement("nav");
    nav.className = "tabtop-nav";
    nav.setAttribute("aria-label", "TabTop");
    for (const page of pages) {
        let item;
        if (page.id === current) {
            item = document.createElement("span");
            item.setAttribute("aria-current", "page");
            item.setAttribute("role", "img");
            item.title = `${page.label} (this page)`;
        } else {
            item = document.createElement("a");
            item.href = page.href;
            item.target = tabName(page.id);
            item.title = `${page.label} (opens in its own tab)`;
            if (page.id === "terminal") {
                terminalOn().then((on) => (item.hidden = !on));
            }
        }
        item.className = "page";
        item.setAttribute("aria-label", item.title);
        item.innerHTML = iconSVG(page.id);
        nav.append(item);
    }
    const out = document.createElement("button");
    out.type = "button";
    if (logOutIcon) {
        out.className = "logout";
        out.title = "Log out (here, on the desktop and in the terminal)";
        out.setAttribute("aria-label", out.title);
        out.innerHTML = iconSVG("logout");
    } else {
        out.textContent = "Log out";
    }
    out.addEventListener("click", logOut);
    nav.append(out);
    return nav;
}
