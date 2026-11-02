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

// Icons for the pages and logging out, drawn the way noVNC draws its
// control bar's: 25 by 25, in round strokes 2 wide. novnc.js puts them in
// that bar; navBar in the bar at the top of the other pages.
export const icons = {
    desktop: '<rect x="2.5" y="4" width="20" height="13.5" rx="1.5"/><path d="M8.5 21h8m-4-3.5v3.5"/>',
    terminal: '<rect x="3" y="5" width="19" height="15" rx="2"/><path d="M7 10l3 2.5-3 2.5m5 1h5"/>',
    files: '<path d="M3 7.5a1.5 1.5 0 0 1 1.5-1.5h5l2 2.5h9a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5h-16a1.5 1.5 0 0 1-1.5-1.5z"/>',
    logout: '<path d="M10 4.5h-5v16h5m4-12l4.5 4-4.5 4m4.5-4h-10"/>',
};

// iconSVG draws the icon id in color (by default, the text's).
export function iconSVG(id, color = "currentColor") {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="25" height="25" viewBox="0 0 25 25" fill="none" stroke="${color}" ` +
        `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[id]}</svg>`;
}

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

// navBar makes a bar of links to the other pages, each an icon named by
// its title and label, the current one, named current, shown as where you
// are, and a Log out button.
export function navBar(current) {
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
    out.textContent = "Log out";
    out.addEventListener("click", logOut);
    nav.append(out);
    return nav;
}
