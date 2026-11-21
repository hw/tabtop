// The remote browser, served by tabtopd at go/ (see gopage.go). Pages are
// loaded and run on the server by an engine of their own (Moli), one per
// tab, through a "go" tunnel (see goroute.go); what comes back is a
// snapshot of each page's document, which this page hands to a frame,
// sandboxed at an origin of its own and allowed to load nothing from the
// web, to show (see go-frame.js). The frame asks this page for the
// pictures, stylesheets and fonts a document uses, which come through the
// server too ("go-resource"; see goresource.go). So this device never
// contacts the sites shown.
//
// What's done in the shown page (clicks, typing, keys, forms sent) is done
// in the engine, where the page's scripts see it, and what that changes
// comes back as changes, or a new page; dialogs the page opens are asked
// here, and files it leads to are offered to be saved into Downloads.
//
// The address bar takes an address, or words to search for (the search
// engine chosen in Settings). Back, forward and reload are this page's:
// each loads an address again in the engine. The address shown is kept in
// this page's own address, after #, so reloading the tab carries on where
// it was. If the connection is lost, the page tries again by itself (see
// reconnect.js), with a new engine, loading the page that was shown.

import { navBar, nameTab, pages, openPage } from "../tabtop/nav.js";
import { iconSVG } from "../tabtop/glyphs.js";
import { forgetSession, storedSession, TunnelSocket } from "../tabtop/tunnel.js";
import { reconnect } from "../tabtop/reconnect.js";
import { warnExpiry } from "../tabtop/expiry.js";
import { call, collect, setLoginTitle } from "../tabtop/requests.js";
import { goMedia } from "./go-media.js";

// Address-bar search engines (Settings; gosites.go's goSearchEngines).
// prefix is the URL up to and including the query parameter's "="; param
// is that parameter's name (for showing the words searched for).
const SEARCH_ENGINES = {
    duckduckgo: { prefix: "https://html.duckduckgo.com/html/?q=", param: "q" },
    google: { prefix: "https://www.google.com/search?q=", param: "q" },
    bing: { prefix: "https://www.bing.com/search?q=", param: "q" },
    brave: { prefix: "https://search.brave.com/search?q=", param: "q" },
};
let searchEngine = "duckduckgo";
function searchOf(id = searchEngine) { return SEARCH_ENGINES[id] ?? SEARCH_ENGINES.duckduckgo; }
function isSearch(url) { return Object.values(SEARCH_ENGINES).some((e) => url.startsWith(e.prefix)); }
function searchWords(url) {
    for (const e of Object.values(SEARCH_ENGINES)) {
        if (!url.startsWith(e.prefix)) continue;
        try { return new URL(url).searchParams.get(e.param) || ""; } catch { return ""; }
    }
    return null;
}
async function loadSearchEngine() {
    try {
        const t = await call({ type: "go-settings" });
        const id = t.reply?.searchEngine;
        t.close();
        if (typeof id === "string" && SEARCH_ENGINES[id]) searchEngine = id;
    } catch { /* keep the default */ }
}
loadSearchEngine();
// One of the tabs' page's tabs (go-tabs.js: go/tab?id=N in a frame of it),
// or on its own: its number keeps what it keeps apart from the others',
// and the tabs' page has its history (and the device's back).
const tabId = (() => {
    const id = new URLSearchParams(location.search).get("id") ?? "";
    return /^\d{1,6}$/.test(id) ? id : "";
})();
const inTabs = (() => {
    try { return window.parent !== window && parent.location.origin === location.origin; } catch { return false; }
})();
function toTabs(m) {
    if (inTabs) parent.postMessage({ ...m, goTab: tabId }, location.origin);
}
const windowList = document.getElementById("go_window_list"), windowListRows = windowList.querySelector("ul");
function hideWindowList() { windowList.hidden = true; }
function showWindowList(tabs) {
    windowList.hidden = false;
    windowListRows.replaceChildren(...tabs.filter((t) => Number.isSafeInteger(t.id) && typeof t.title === "string").map((t) => {
        const row = document.createElement("li");
        row.classList.toggle("current", t.current === true);
        const pick = Object.assign(document.createElement("button"), { type: "button", className: "pick", textContent: t.title });
        pick.addEventListener("click", () => toTabs({ type: "select-window", id: t.id }));
        const close = Object.assign(document.createElement("button"), { type: "button", className: "close", textContent: "×" });
        close.setAttribute("aria-label", `Close ${t.title}`);
        close.addEventListener("click", () => toTabs({ type: "close-window", id: t.id }));
        row.append(pick, close);
        return row;
    }));
    windowList.querySelector(".done").focus();
}
windowList.querySelector(".done").addEventListener("click", hideWindowList);
windowList.addEventListener("keydown", (e) => { if (e.key === "Escape") hideWindowList(); });
// The address this tab last showed, kept for its reloads (sessionStorage).
const KEPT = "tabtop-go-kept" + (tabId ? ":" + tabId : "");
// Its pages back and forward, likewise (the tab's own history has an entry
// for each, on this page's address, which says which: see remember).
const KEPT_HISTORY = "tabtop-go-history" + (tabId ? ":" + tabId : "");
// Its token on the server: the tab there runs on a while (5 minutes) if
// the connection's lost, and a connection bringing this takes it back,
// as it is (goresume.go). This browser tab's only: a reload takes it back.
const KEPT_RESUME = "tabtop-go-resume" + (tabId ? ":" + tabId : "");
const resumeToken = {
    get() { try { return sessionStorage.getItem(KEPT_RESUME) || ""; } catch { return ""; } },
    set(token) { try { token ? sessionStorage.setItem(KEPT_RESUME, token) : sessionStorage.removeItem(KEPT_RESUME); } catch { /* not kept */ } },
};
// Sites opened, newest first, for the start (localStorage: this device's
// only, never sent anywhere; forgotten from the start).
const RECENT = "tabtop-go-recent";
const RECENT_MAX = 8;
// What the frame may have fetched for one page, in all.
const PAGE_BUDGET = 128 << 20;
const RESOURCE_LIMITS = { image: 10 << 20, css: 4 << 20, font: 8 << 20 };

// The browser's tab is named for links from the other pages to find: the
// tabs' page's, not one of its tabs' frames.
if (!inTabs) nameTab("go");
setLoginTitle("Browser");
const $ = (id) => document.getElementById(id);
const back = $("go_back"), forward = $("go_forward"), reload = $("go_reload");
const address = $("go_url"), status = $("go_status"), notice = $("go_notice"), start = $("go_start");

// The bar's icons (drawn, not characters: the same on every device).
const ICONS = {
    back: '<path d="M15 5l-7 7 7 7"/>',
    forward: '<path d="M9 5l7 7-7 7"/>',
    reload: '<path d="M19 12a7 7 0 1 1-2.05-4.95"/><path d="M19 4v4h-4"/>',
    stop: '<path d="M6 6l12 12M18 6L6 18"/>',
    clear: '<circle cx="12" cy="12" r="8"/><path d="M9.5 9.5l5 5M14.5 9.5l-5 5"/>',
    // The browser's own bars hidden, this one kept: a window, its top bar
    // going up.
    hideBrowser: '<rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 10h18M12 17v-4m-2.5 2L12 12.5l2.5 2.5"/>',
    insecure: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.01"/>',
    fullscreen: '<path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5"/>',
    exitFullscreen: '<path d="M4 9h5V4m11 5h-5V4M4 15h5v5m11-5h-5v5"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    clear: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    sites: '<circle cx="12" cy="12" r="8"/><circle cx="9.5" cy="10" r="1"/><circle cx="14.5" cy="13.5" r="1"/><circle cx="10.5" cy="15" r="1"/>',
    controls: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
    shield: '<path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6z"/>',
    // A gear (Feather's, MIT).
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
back.innerHTML = icon("back");
forward.innerHTML = icon("forward");
$("go_clear").innerHTML = icon("clear");

// The menu, at the end of the bar: forward, then the other pages and
// logging out (the bar of links the other pages have at the top, here in
// the menu to leave the page the room).
const menu = $("go_menu"), menuPanel = $("go_menu_panel");
// The menu's first row (go.html): Forward (on a phone, whose bar has no
// room for it), Desktop, Full screen, Hide browser; each a glyph over its
// name.
const desktop = $("go_menu_desktop");
desktop.insertAdjacentHTML("afterbegin", iconSVG("desktop"));
const desktopKey = "tabtop-go-desktop" + (tabId ? ":" + tabId : "");
let desktopOn = false;
try { desktopOn = sessionStorage.getItem(desktopKey) === "1"; } catch { /* default */ }
desktop.setAttribute("aria-pressed", String(desktopOn));
const menuForward = $("go_menu_forward");
menuForward.insertAdjacentHTML("afterbegin", icon("forward"));
menuForward.addEventListener("click", () => { openMenu(false); menu.focus(); goBy(1); });
desktop.addEventListener("click", () => {
    desktopOn = !desktopOn;
    desktop.setAttribute("aria-pressed", String(desktopOn));
    try {
        if (desktopOn) sessionStorage.setItem(desktopKey, "1");
        else sessionStorage.removeItem(desktopKey);
    } catch { /* this page only */ }
    openMenu(false);
    menu.focus();
    if (at >= 0) load(entries[at].url, { push: false });
    else viewSoon();
});

const hideBrowser = $("go_menu_hide_browser");
const fullScreen = $("go_menu_fullscreen"), exitFullScreen = $("go_exit_fullscreen");
hideBrowser.insertAdjacentHTML("afterbegin", icon("hideBrowser"));
fullScreen.insertAdjacentHTML("afterbegin", icon("fullscreen"));
exitFullScreen.innerHTML = icon("exitFullscreen");
const fullScreenRoot = document.documentElement;
let screenMode = "", nativeFullScreen = false, nativeRequest;
let tabsCompact = false, tabsCount = 1;
function updateTabsButton() {
    const tabs = $("go_tabs");
    tabs.hidden = !inTabs || (!tabsCompact && screenMode !== "browser");
    tabs.querySelector(".count").textContent = String(tabsCount);
    tabs.setAttribute("aria-label", `Tabs: ${tabsCount} open`);
}

function showScreenMode(mode) {
    screenMode = mode;
    const immersive = mode === "full";
    hideBrowser.setAttribute("aria-pressed", String(mode === "browser"));
    fullScreen.setAttribute("aria-pressed", String(immersive));
    fullScreenRoot.classList.toggle("go-fullscreen", immersive);
    updateTabsButton();
    exitFullScreen.hidden = !immersive;
    openMenu(false);
    (immersive ? exitFullScreen : menu).focus();
}

function leaveFullScreen() {
    showScreenMode("");
    if (document.fullscreenElement === fullScreenRoot) document.exitFullscreen().catch(() => {});
}

async function toggleScreenMode(mode) {
    if (screenMode === mode) {
        leaveFullScreen();
        return;
    }
    showScreenMode(mode);
    if (document.fullscreenElement === fullScreenRoot) return;
    if (!nativeRequest && document.fullscreenEnabled) {
        nativeRequest = fullScreenRoot.requestFullscreen({ navigationUI: "hide" })
            .catch(() => {})
            .finally(() => { nativeRequest = null; });
    }
    await nativeRequest;
    if (!screenMode && document.fullscreenElement === fullScreenRoot) {
        document.exitFullscreen().catch(() => {});
    } else if (screenMode === "browser" && document.fullscreenElement !== fullScreenRoot) {
        showScreenMode("");
        note("The browser couldn't hide its toolbar.");
    }
}

hideBrowser.addEventListener("click", () => toggleScreenMode("browser"));
fullScreen.addEventListener("click", () => toggleScreenMode("full"));
exitFullScreen.addEventListener("click", leaveFullScreen);
document.addEventListener("fullscreenchange", () => {
    if (document.fullscreenElement === fullScreenRoot) nativeFullScreen = true;
    else if (nativeFullScreen && !document.fullscreenElement) {
        nativeFullScreen = false;
        if (screenMode) showScreenMode("");
    }
});


menu.innerHTML = icon("menu");
$("go_menu_settings").innerHTML = `${icon("settings")}<span class="label">Settings</span>`;
// Open Site controls (go/sites) or Settings (go/settings) in a fresh
// lightbox frame so it leaves the browser's back and forward history alone.
const settingsBox = $("go_settings");
let settingsFrame = null;
function openSettings(page) {
    openMenu(false);
    settingsFrame?.remove();
    const there = new URL(page, location.href);
    // Site controls open at the page's site when there's a page.
    const host = at >= 0 && !isSearch(entries[at].url) ? hostOf(entries[at].url).replace(/:\d+$/, "") : "";
    if (page === "sites" && host) {
        there.searchParams.set("site", host);
        // Whether the page is secure (https), for Site controls to say.
        there.searchParams.set("secure", entries[at].url.startsWith("https:") ? "1" : "0");
    }
    const title = page === "sites" ? "Site controls" : "Settings";
    $("go_settings_h").textContent = title;
    settingsFrame = Object.assign(document.createElement("iframe"), { title, src: there.href });
    settingsBox.append(settingsFrame);
    // The site's icon (its /favicon.ico, through the server as the page's
    // pictures are), for Site controls to show by its name.
    if (page === "sites" && host) {
        const frame = settingsFrame, origin = new URL(entries[at].url).origin;
        frame.addEventListener("load", () => {
            cachedResource("image", origin + "/favicon.ico").then((blob) => {
                if (settingsFrame === frame) frame.contentWindow?.postMessage({ goSiteIcon: blob, host }, location.origin);
            }, () => {});
        }, { once: true });
    }
    settingsBox.showModal();
    settingsBox.querySelector(".close").focus();
}
// The site's button, at the address's start: its controls (Site controls,
// go/sites), and at a glance what's to know of it: not https (a warning),
// ads and trackers blocked on the page (a shield, how many: sites refused
// whole, and addresses; goadblock.go). Shown with a page's site, not while
// the address is edited.
const siteButton = $("go_site"), addressForm = $("go_address");
let adsBlocked = 0;
function showSiteButton() {
    const entry = at >= 0 ? entries[at] : null;
    const site = entry && !isSearch(entry.url) && address.classList.contains("site") ? hostOf(entry.url).replace(/:\d+$/, "").replace(/^www\./, "") : "";
    siteButton.hidden = !site;
    addressForm.classList.toggle("with-site", !!site);
    if (!site) return;
    const insecure = address.classList.contains("insecure");
    // What's to know, each its glyph: not https; ads blocked (its count
    // after it); neither, its controls.
    const glyphs = [...(insecure ? ["insecure"] : []), ...(adsBlocked > 0 ? ["shield"] : []), ...(!insecure && !adsBlocked ? ["controls"] : [])].join();
    if (siteButton.dataset.glyph !== glyphs) {
        for (const svg of siteButton.querySelectorAll("svg")) svg.remove();
        siteButton.querySelector(".count").insertAdjacentHTML("beforebegin", glyphs.split(",").map((g) => icon(g)).join(""));
        siteButton.dataset.glyph = glyphs;
    }
    siteButton.classList.toggle("insecure", insecure);
    siteButton.classList.toggle("ads", adsBlocked > 0);
    siteButton.querySelector(".count").textContent = adsBlocked > 0 ? String(adsBlocked) : "";
    const said = [`Site controls for ${site}`];
    if (insecure) said.push("not secure (http)");
    if (adsBlocked > 0) said.push(`${adsBlocked} ${adsBlocked === 1 ? "ad or tracker" : "ads and trackers"} blocked on this page`);
    siteButton.title = siteButton.ariaLabel = said.join("; ");
    addressForm.style.setProperty("--site-width", `${siteButton.offsetWidth + 4}px`);
}
function showAds(count) {
    adsBlocked = count;
    showSiteButton();
}
siteButton.addEventListener("click", () => openSettings("sites"));
$("go_menu_settings").addEventListener("click", () => openSettings("settings"));
settingsBox.querySelector(".close").addEventListener("click", () => settingsBox.close());
settingsBox.addEventListener("click", (e) => { if (e.target === settingsBox) settingsBox.close(); });  // beside it (its backdrop)
settingsBox.addEventListener("close", () => {
    // The close event comes a moment after it's shut: opened again
    // meanwhile, the frame is the new one's, kept.
    if (settingsBox.open) return;
    settingsFrame?.remove();
    settingsFrame = null;
});
window.addEventListener("message", (e) => {
    if (!settingsFrame || e.source !== settingsFrame.contentWindow || e.origin !== location.origin) return;
    if (e.data?.goSettings === "close") settingsBox.close();
    else if (e.data?.goSettings === "media-changed") refreshMediaPolicy();
    else if (e.data?.goSettings === "theme-changed") refreshTheme();
    else if (e.data?.goSettings === "search-changed") loadSearchEngine();
    // Site controls' Reload page (a change that holds for what loads next),
    // and its link to Settings.
    else if (e.data?.goSettings === "reload" && at >= 0) { settingsBox.close(); load(entries[at].url, { push: false }); }
    else if (e.data?.goSettings === "open-settings") openSettings("settings");
});
const nav = navBar("go", { logOutIcon: true });
for (const item of nav.children) {
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = (item.title || "").replace(/ \(.*$/, "");
    item.append(label);
}
// Set apart: the browser's own items, the other pages, logging out.
const logOutItem = nav.querySelector(":scope > button");
if (logOutItem) {
    const sep = document.createElement("div");
    sep.className = "sep";
    sep.setAttribute("role", "separator");
    logOutItem.before(sep);
}
menuPanel.append(nav);
// The session's warning, which goes in that bar: shown below this one.
new MutationObserver(() => {
    const warning = nav.querySelector("#tabtop_expiry");
    if (warning) document.body.append(warning);
}).observe(nav, { childList: true });
function openMenu(open) {
    menuPanel.hidden = !open;
    if (open) mediaMenu();
    else media?.mark(null);
    menu.setAttribute("aria-expanded", String(open));
    if (open) {
        const first = [...menuPanel.querySelectorAll("button:not(:disabled), input:not(:disabled), a[href]")]
            .find((item) => item.getClientRects().length);
        (first ?? menu).focus();
    }
}
menu.addEventListener("click", () => openMenu(menuPanel.hidden));
menuPanel.addEventListener("click", (e) => {
    if (e.target.closest("a, button")) openMenu(false);
});
document.addEventListener("pointerdown", (e) => {
    if (!menuPanel.hidden && !menuPanel.contains(e.target) && !menu.contains(e.target)) openMenu(false);
}, true);
// (The page's own frame takes the pointer: leaving for it closes it too.)
window.addEventListener("blur", () => openMenu(false));
menuPanel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        openMenu(false);
        menu.focus();
    }
});
warnExpiry();

// The frame: sandboxed with scripts only, its document from the server,
// with a CSP that lets it load nothing from the web (see gopage.go).
const frame = document.createElement("iframe");
// The page's players, laid under the copy's boxes (go-media.js) so images
// and chrome in the copy keep z-order above the pixels; posters fetched as
// the page's pictures are; a video's proportions told to its box.
let media = null;
const mediaHelp = {
    picture: (url) => cachedResource("image", url),
    // A part of a player's file, over the tab's tunnel if it's open (null
    // if not: the player asks on a tunnel of its own).
    range: (url, part) => (ws?.readyState === TunnelSocket.OPEN ? mediaViaTab(ws, url, part) : null),
    sized: (key, ratio, meta) => frame.contentWindow?.postMessage({ type: "media-state", key, ratio, meta }, "*"),
    played: (key, play) => frame.contentWindow?.postMessage({ type: "media-state", key, play }, "*"),
    // Scrolling done over a player in the watch UI, for the frame to do in
    // the page under it: where (in the frame) and by how much.
    passOn: (x, y, dx, dy, how) => {
        const f = frame.getBoundingClientRect();
        frame.contentWindow?.postMessage({ type: "media-scroll", x: x - f.left, y: y - f.top, dx, dy, how }, "*");
    },
    failed: (key, error, blocked) => frame.contentWindow?.postMessage({ type: "media-state", key, error, blocked }, "*"),
    // Outline the copy's media box (underlaid pixels can't show an outline).
    marked: (key) => frame.contentWindow?.postMessage({ type: "media-mark", key }, "*"),
    // A player's state changed: the menu's list of them (mediaMenu).
    changed: () => mediaMenu(),
    // A video's file saved into Downloads (the player's Download), saying
    // how it goes there; where Files are off, not offered.
    // (The likeliest first, the player's picker taking it: the longest,
    // not an ad's, which isn't offered; see savedStreams.)
    streamsToSave: () => savedStreams().map(({ url, about }) => ({
        label: streamName(url, about),
        save: (say, opts) => saveFile(url, say, true, undefined, opts),
    })),
    download: pages.some((p) => p.id === "files") ? (url, say, opts) => saveFile(url, say, false, undefined, opts) : null,
    // A clear Media Source buffer the player already has (no HLS/DASH
    // manifest): spilled to the server while it plays, remuxed on Save.
    saveMSE: pages.some((p) => p.id === "files") ? (stream, say, opts) => saveMSECapture(stream, say, opts) : null,
    spillMSE: pages.some((p) => p.id === "files") ? (stream, ev) => spillMSECapture(stream, ev) : null,
    abortMSE: pages.some((p) => p.id === "files") ? (stream) => abortMSECapture(stream) : null,
};

// mediaMenu lists the page's videos and sounds at the menu's top: how
// each is doing, where it's from (its site and file name; the whole
// address to a screen reader, and to hover over), and Skip or Hide. The
// menu's button is marked while there are any, so these actions are handy.
const MEDIA_ICONS = {
    play: '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>',
    pause: '<path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" stroke="none"/>',
    watch: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9.5v5l4.5-2.5z" fill="currentColor"/>',
    skip: '<path d="M5 5l9 7-9 7z M16 5h3v14h-3z" fill="currentColor" stroke="none"/>',
    hide: '<path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.2A10.8 10.8 0 0 1 12 5c5 0 8.5 5 8.5 7a8.5 8.5 0 0 1-2.2 3.5M6.2 6.2C3.9 7.7 1.5 10.5 1.5 12c0 2 3.5 7 8.5 7 1.2 0 2.3-.3 3.3-.8"/>',
};
const mediaIcon = (name) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${MEDIA_ICONS[name]}</svg>`;
// A device-wide user choice, when made; otherwise the site's media policy
// supplies the autoplay default. The switch can always override that default.
const AUTOPLAY = "tabtop-go-autoplay-paused";
let autoplayOverride = (() => {
    try {
        const saved = localStorage.getItem(AUTOPLAY);
        return saved === "1" ? false : saved === "0" ? true : null;
    } catch { return null; }
})();
let siteMedia = "allow";
let mediaPolicyRequest = 0;
const shouldAutoplay = () => autoplayOverride ?? (siteMedia !== "no-autoplay" && siteMedia !== "block");

function applyMediaPolicy(policy) {
    const wasBlocked = siteMedia === "block";
    siteMedia = policy;
    media?.block(policy === "block");
    media?.autoplay(shouldAutoplay());
    if (wasBlocked && policy !== "block") toFrame({ type: "media-allowed" });
    mediaMenu();
}

// refreshTheme takes Dark mode for the page shown afresh (changed in Site
// controls): the engine tells the page again what it prefers.
async function refreshTheme() {
    const entry = entries[at];
    if (!entry) return;
    try {
        const t = await call({ type: "go-settings", name: entry.url });
        t.close();
        if (entries[at] !== entry) return;
        ws?.send(JSON.stringify({ op: "theme" }));
    } catch { /* the next snapshot says it */ }
}

async function refreshMediaPolicy() {
    const entry = entries[at];
    const shownBefore = shown, request = ++mediaPolicyRequest;
    if (!entry) return;
    try {
        const t = await call({ type: "go-settings", name: entry.url });
        t.close();
        if (request === mediaPolicyRequest && entries[at] === entry && shown === shownBefore) {
            applyMediaPolicy(t.reply.effectiveMedia);
            media?.blockHosts(t.reply.videoHosts);
        }
    } catch { /* the next snapshot includes the server setting */ }
}

function newMedia() {
    const m = goMedia(frame, { ...mediaHelp, emeReply(message, id) {
        if (m !== media || ws?.readyState !== TunnelSocket.OPEN) return;
        const value = JSON.stringify(message);
        if (value.length <= 49152) ws.send(JSON.stringify({ op: "event", kind: "eme-reply", id, gen: shown, value }));
    } });
    m.autoplay(shouldAutoplay());
    return m;
}
function glyph(name, label, act, { disabled = false, pressed } = {}) {
    const b = Object.assign(document.createElement("button"), { type: "button", className: "glyph", disabled, title: label });
    b.setAttribute("aria-label", label);
    if (pressed !== undefined) b.setAttribute("aria-pressed", String(pressed));
    b.innerHTML = mediaIcon(name);
    b.addEventListener("click", (e) => {
        e.stopPropagation();  // (the menu stays open: there may be more to do)
        act();
    });
    return b;
}
// holdToBlock has a Skip held (half a second; or its context menu: a right
// click, a long touch's) block the videos from the host the video comes
// from (its own address's, not the page's: test.com's page with a video
// from something.com blocks something.com's), wherever they're played:
// those playing stopped, none played after (Site controls), with Undo. A
// video the site streams by its own player has no address of its own: its
// page's site's videos are blocked.
function holdToBlock(button, p) {
    button.classList.add("hold");
    let timer = 0, held = false;
    const block = () => {
        held = true;
        navigator.vibrate?.(30);  // (a phone's: felt as it's done)
        openMenu(false);
        blockVideos(p);
    };
    button.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        held = false;
        clearTimeout(timer);
        timer = setTimeout(block, 600);
    });
    for (const type of ["pointerup", "pointerleave", "pointercancel"]) button.addEventListener(type, () => clearTimeout(timer));
    button.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        clearTimeout(timer);
        if (!held) block();
    });
    // Held: its click (as it's let go) isn't a skip.
    button.addEventListener("click", (e) => {
        if (!held) return;
        e.stopImmediatePropagation();
        held = false;
    }, true);
}
async function blockVideos(p) {
    const url = entries[at]?.url;
    if (!url) return;
    let host = "";
    try { host = /^https?:/i.test(p?.src ?? "") ? new URL(p.src).hostname.replace(/^www\./, "") : ""; } catch { /* none */ }
    if (host) {
        // Its own host's: blocked, those playing from it stopped; Undo
        // lets it be again, and loads the page again.
        try {
            const t = await call({ type: "go-settings-set", name: host, setting: "videos-host-block" });
            t.close();
            media?.blockHosts(t.reply.videoHosts);
            warn(`Videos from ${host} are blocked: they won't play, on any page (Site controls: the button at the address’s start).`, {
                error: false, label: "Undo",
                retry: async () => {
                    try {
                        const u = await call({ type: "go-settings-set", name: host, setting: "videos-host-allow" });
                        u.close();
                        media?.blockHosts(u.reply.videoHosts);
                        if (entries[at]?.url === url) load(url, { push: false });
                    } catch (err) { warn(err.message); }
                },
            });
        } catch (err) {
            warn(err.message || "Its videos couldn't be blocked.");
        }
        return;
    }
    const site = hostOf(url).replace(/^www\./, "");
    try {
        const previous = await call({ type: "go-settings", name: url });
        previous.close();
        const policy = previous.reply.media?.[previous.reply.site] ?? "default";
        const t = await call({ type: "go-settings-set", name: url, setting: "videos-block" });
        t.close();
        if (entries[at]?.url === url) applyMediaPolicy("block");
        warn(`Videos are blocked on ${site}: its pages' videos won't play (Site controls: the button at the address’s start).`, {
            error: false, label: "Undo",
            retry: async () => {
                try {
                    const u = await call({ type: "go-settings-set", name: url, setting: "videos-" + policy });
                    u.close();
                    if (entries[at]?.url === url) load(url, { push: false });
                } catch (err) { warn(err.message); }
            },
        });
    } catch (err) {
        warn(err.message || "Its videos couldn't be blocked.");
    }
}
$("go_menu_autoplay").innerHTML = `<span>Autoplay</span><span class="knob" aria-hidden="true"></span>`;
$("go_menu_autoplay").addEventListener("click", (e) => {
    e.stopPropagation();
    autoplayOverride = !shouldAutoplay();
    try { localStorage.setItem(AUTOPLAY, autoplayOverride ? "1" : "0"); } catch { /* this page only */ }
    media?.autoplay(shouldAutoplay());
    mediaMenu();
});
let mediaDrawn = "", mediaDrawnOpen = false;
function mediaMenu() {
    const section = $("go_menu_media"), list = section.querySelector("ul");
    const players = media?.list() ?? [];
    menu.classList.toggle("has-media", players.length > 0);
    menu.setAttribute("aria-label", players.length ? `Menu (${players.length} playing or loading on this page)` : "Menu");
    section.hidden = !players.length;
    const videos = players.every((p) => p.kind === "video");
    section.querySelector("h2").textContent = videos ? "Videos on this page" : "Videos and sounds on this page";
    // Drawn again only as what's shown changes: a row replaced as it's
    // pressed takes no click, and a focus moves.
    const drawn = JSON.stringify([autoplayOverride, siteMedia, players.map(({ key, state, short, src, skippable, playing, ready, watching }) => [key, state, short, src, skippable, playing, ready, watching])]);
    if (drawn === mediaDrawn && !menuPanel.hidden === mediaDrawnOpen) return;
    mediaDrawn = drawn;
    mediaDrawnOpen = !menuPanel.hidden;
    // Autoplay paused, or not: every player paused, and the page's starting
    // them not done, till one's played here or the switch is turned on.
    // (A switch, named: a glyph alone would read as "play all".)
    const toggle = $("go_menu_autoplay");
    toggle.setAttribute("role", "switch");
    toggle.disabled = siteMedia === "block";
    toggle.setAttribute("aria-checked", String(shouldAutoplay()));
    toggle.title = toggle.disabled ? "Videos are blocked in Site controls" : autoplayOverride === null && !shouldAutoplay()
        ? "Autoplay defaults to off for this site; turn it on here"
        : shouldAutoplay() ? "Autoplay is on: turn it off to stop pages starting videos" : "Autoplay is off: pages' videos wait to be played";
    toggle.removeAttribute("aria-pressed");

    const focused = document.activeElement?.closest?.("#go_menu_media li");
    const focusedKey = focused?.dataset.key, focusedAct = document.activeElement?.dataset?.act;
    list.replaceChildren(...players.map((p, i) => {
        const li = document.createElement("li");
        li.dataset.key = String(p.key);
        const noun = p.kind === "video" ? "video" : "sound";
        const about = Object.assign(document.createElement("div"), { className: "about" });
        // Numbered as they are on the page, top first: which is which.
        const ordinal = players.length > 1 ? `${noun === "video" ? "Video" : "Sound"} ${i + 1} · ` : "";
        const state = Object.assign(document.createElement("div"), { className: "state", textContent: ordinal + p.state });
        const where = Object.assign(document.createElement("div"), { className: "where", textContent: p.short });
        if (p.src) where.title = p.src;
        about.append(state, where);
        const which = `${noun} ${i + 1}${p.src ? `, ${p.src}` : ""}`;
        // Ended videos can be hidden; live players can be skipped as before.
        const endedVideo = p.kind === "video" && (p.state === "Ended" || p.state === "Skipped");
        const skip = endedVideo
            ? glyph("hide", `Hide ${which} from the page`, () => media?.hide(p.key))
            : glyph("skip", `Skip ${which} to its end (Shift+N on it); hold to block videos from its host`, () => media?.skip(p.key), { disabled: !p.skippable });
        if (!endedVideo) holdToBlock(skip, p);
        const acts = [
            ...(p.kind === "video" ? [glyph("watch", `Watch ${which} in the player: full screen, its speed, back and on`, () => { openMenu(false); media?.watch(p.key); }, { disabled: !p.ready || p.watching })] : []),
            glyph(p.playing ? "pause" : "play", `${p.playing ? "Pause" : "Play"} ${which}`, () => media?.toggle(p.key), { disabled: !p.ready }),
            skip,
        ];
        for (const [j, b] of acts.entries()) b.dataset.act = String(j);
        const buttons = Object.assign(document.createElement("div"), { className: "acts" });
        buttons.append(...acts);
        li.append(about, buttons);
        // Pointed at or focused: its player outlined on the page.
        li.addEventListener("pointerenter", () => media?.mark(p.key));
        li.addEventListener("pointerleave", () => media?.mark(null));
        li.addEventListener("focusin", () => media?.mark(p.key));
        li.addEventListener("focusout", () => media?.mark(null));
        return li;
    }));
    if (focusedKey) {
        const row = list.querySelector(`li[data-key="${CSS.escape(focusedKey)}"]`);
        (row?.querySelector(`button[data-act="${CSS.escape(focusedAct ?? "")}"]:not(:disabled)`) ?? row?.querySelector("button:not(:disabled)"))?.focus();
    }
}
frame.id = "go_view";
frame.title = "Page";
frame.setAttribute("sandbox", "allow-scripts");
frame.setAttribute("referrerpolicy", "no-referrer");
const frameURL = new URL("../tabtop/go-frame.html", import.meta.url).href;
// A token for the frame's document alone: sent once it's loaded, and
// required on every message from it after, so another document in the
// frame (were one ever loaded there) is ignored.
let token;
let frameReady;
let frameIsReady;
let loads = 0;  // the frame's load events since its src was last set
let greeted = false;  // the token handed to the frame's document already
let lastRender = null;  // the page shown, to show again in a new frame
function resetFrame() {
    token = crypto.randomUUID();
    frameIsReady = new Promise((resolve) => (frameReady = resolve));
    loads = 0;
    greeted = false;
    frame.src = frameURL;
    if (lastRender) toFrame(lastRender);
}
// The frame's document should never change but by resetFrame: its policy
// lets it load nothing from the web, and the page's frame-src stops it
// leaving for elsewhere, but if it's ever navigated away all the same (to
// the browser's "blocked" page, say), it's put back.
frame.addEventListener("load", () => {
    if (++loads > 1) resetFrame();
});
const toFrame = (m) => frameIsReady.then(() => frame.contentWindow?.postMessage(m, "*"));
resetFrame();
document.body.append(frame);
media = newMedia();

// History: this page's, by address; the engine only loads what it's told.
let entries = [];  // {url, title}
let at = -1;
let ws = null;  // the tunnel, while open
let connecting = null;  // a connect() going
let gen = 0;    // the newest generation, as the server numbers them (see goroute.go)
let shown = 0;  // the generation whose document the frame has
let loading = false;
let rendering = false; // snapshot received; the frame is preparing styles and resources
let spent = 0;  // bytes fetched for the frame for the page shown

// target turns what was typed into an address: one as it is, a host
// with https://, or words searched for (the engine in Settings).
function target(text) {
    const s = text.trim();
    if (!s) return null;
    if (/^https?:\/\//i.test(s)) return s;
    if (!/\s/.test(s) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(s) || /^localhost(:\d+)?(\/|$)/i.test(s)) return "https://" + s;
    return searchOf().prefix + encodeURIComponent(s);
}

function show(text) {
    status.textContent = text;
}

function warn(message, { retry = null, error = true, label = "Try again", edit = false } = {}) {
    notice.querySelector("p").textContent = message;
    notice.classList.toggle("error", error);
    const button = notice.querySelector(".primary");
    button.textContent = label;
    button.hidden = !retry;
    button.onclick = retry ? () => { notice.hidden = true; retry(); } : null;
    notice.querySelector(".edit").hidden = !edit;
    notice.hidden = false;
}
notice.querySelector(".dismiss").addEventListener("click", () => { notice.hidden = true; });
notice.querySelector(".edit").addEventListener("click", () => { notice.hidden = true; address.focus(); address.select(); });

// --- Pop-ups the page wants to open -------------------------------------
//
// Asked about one at a time: open it (in a tab of its own) or not, the
// answer kept for the site that asked unless the person unticks it.
const popupBox = $("go_popup");
let popupAsks = [];
function askPopup(m) {
    if (popupAsks.length >= 8) return;
    popupAsks.push(m);
    if (popupAsks.length === 1) showPopupAsk();
}
function showPopupAsk() {
    const m = popupAsks[0];
    if (!m) {
        popupBox.hidden = true;
        return;
    }
    const site = typeof m.site === "string" && m.site ? m.site : "This page";
    $("go_popup_text").textContent = `${site} wants to open a pop-up: ${hostOf(m.url)}`;
    popupBox.querySelector(".remember span").textContent = m.site ? `Remember for ${m.site}` : "Remember for this site";
    popupBox.querySelector(".remember").hidden = !m.site;
    popupBox.querySelector(".remember input").checked = true;
    popupBox.hidden = false;
    popupBox.querySelector(".open").focus();
}
function answerPopup(accept) {
    const m = popupAsks.shift();
    if (m && ws) ws.send(JSON.stringify({ op: "popup-answer", id: m.id, accept, remember: !!m.site && popupBox.querySelector(".remember input").checked }));
    showPopupAsk();
}
popupBox.querySelector(".open").addEventListener("click", () => answerPopup(true));
popupBox.querySelector(".refuse").addEventListener("click", () => answerPopup(false));
popupBox.addEventListener("keydown", (e) => { if (e.key === "Escape") answerPopup(false); });
// note says something for a few seconds (in the status), then goes.
let noteTimer = 0;
function note(text) {
    show(text);
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { if (status.textContent === text) show(""); }, 4000);
}

// The page being left, while the next is slow to come: dimmed, and its
// players paused, after a second.
let leaving = 0;
function update() {
    $("go_progress").hidden = !(loading || rendering);
    frame.setAttribute("aria-busy", String(loading || rendering));
    if ((loading || rendering) && !leaving && !frame.classList.contains("leaving")) {
        leaving = setTimeout(() => {
            leaving = 0;
            if (!loading && !rendering) return;
            frame.classList.add("leaving");
            if (loading) media.pauseAll();  // (not the next page's: rendering, they're its)
        }, 1000);
    } else if (!loading && !rendering) {
        clearTimeout(leaving);
        leaving = 0;
        frame.classList.remove("leaving");
    }
    // Back: a page back; with none, but some forward, the history panel
    // (Forward's there, on a phone: not in the bar).
    back.disabled = at <= 0 && at >= entries.length - 1;
    forward.disabled = menuForward.disabled = at >= entries.length - 1;
    reload.disabled = at < 0;
    reload.innerHTML = icon(loading ? "stop" : "reload");
    reload.title = loading ? "Stop" : "Reload";
    reload.setAttribute("aria-label", reload.title);
    const entry = entries[at];
    if (entry && document.activeElement !== address) showSite(entry.url);
    addressButtons();
    frame.title = entry ? entry.title || hostOf(entry.url) : "Page";
    document.title = entry ? `${entry.title || hostOf(entry.url)} – Browser` : "Browser";
    if (entry) {
        // Kept in this tab only, so that reloading it carries on (see the
        // start, below): not in the tab's own address (/go/#…), which the
        // browser keeps in its history (and syncs), and shows to whoever
        // sees the screen.
        try {
            sessionStorage.setItem(KEPT, entry.url);
            sessionStorage.setItem(KEPT_HISTORY, JSON.stringify({ entries: entries.slice(-50).map((e) => ({ url: e.url, title: e.title })), at: at - Math.max(0, entries.length - 50) }));
        } catch { /* not kept */ }
    }
    // Its title and whether it's loading, for its tab.
    toTabs({ type: "state", title: entry ? entry.title || hostOf(entry.url) : "New tab", loading: loading || rendering });
}

// The address bar, but while it's edited, shows the site only (the words
// searched for, for a search), the whole address in data-url; an address
// that isn't https marked so.
function showSite(url) {
    let text = url, insecure = false;
    try {
        const u = new URL(url);
        insecure = u.protocol !== "https:";
        const words = searchWords(url);
        text = words !== null ? (words || u.host) : (insecure ? "http://" : "") + u.host.replace(/^www\./, "");
    } catch { /* as it is */ }
    address.value = text;
    address.dataset.url = url;
    address.title = url;
    address.classList.add("site");
    address.classList.toggle("insecure", insecure);
    showSiteButton();
}
function editAddress() {
    const entry = entries[at];
    if (address.classList.contains("site")) {
        address.classList.remove("site", "insecure");
        if (entry) address.value = entry.url;
        showSiteButton();
    }
}
// Reload (or stop) at the end of the address, or, while it's edited and
// has something in it, clear.
function addressButtons() {
    const editing = document.activeElement === address;
    $("go_clear").hidden = !editing || !address.value;
    reload.hidden = editing;
}

// recent keeps the site of an address opened, for the start: the site
// only (not the page), not a search, this device's only.
function recent(url) {
    let origin;
    try {
        const u = new URL(url);
        if (isSearch(url) || !/^https?:$/.test(u.protocol)) return;
        origin = u.origin;
    } catch { return; }
    try {
        const list = recentSites().filter((o) => o !== origin);
        localStorage.setItem(RECENT, JSON.stringify([origin, ...list].slice(0, RECENT_MAX)));
    } catch { /* not kept */ }
}
function recentSites() {
    try {
        const list = JSON.parse(localStorage.getItem(RECENT) || "[]");
        return Array.isArray(list) ? list.filter((o) => typeof o === "string" && /^https?:\/\/[^/]+$/i.test(o)).slice(0, RECENT_MAX) : [];
    } catch { return []; }
}
function showRecent() {
    const list = $("go_recent"), sites = recentSites();
    list.replaceChildren(...sites.map((origin) => {
        const li = document.createElement("li");
        const b = Object.assign(document.createElement("button"), { type: "button", textContent: hostOf(origin).replace(/^www\./, "") });
        b.title = origin;
        b.addEventListener("click", () => load(origin));
        li.append(b);
        return li;
    }));
    list.hidden = $("go_recent_clear").hidden = !sites.length;
}
$("go_recent_clear").addEventListener("click", () => {
    try { localStorage.removeItem(RECENT); } catch { /* none */ }
    showRecent();
    address.focus();
});

// remember gives the entry now shown one of the tab's own history (on this
// page's address: the page's own never goes there, nor to the browser's
// history), so the device's back (a swipe, a button) goes back a page
// here (see popstate), not away from this page. The first is this page's
// own entry.
function remember() {
    if (inTabs) {
        toTabs({ type: "history", at });  // the tabs' page keeps it
        return;
    }
    try {
        if (at === 0) history.replaceState({ goAt: 0 }, "");
        else history.pushState({ goAt: at }, "");
    } catch { /* not kept: the bar's buttons still go back */ }
}
window.addEventListener("popstate", (e) => {
    const i = e.state?.goAt;
    if (!Number.isSafeInteger(i) || i < 0 || i >= entries.length || i === at) return;
    at = i;
    load(entries[at].url, { push: false });
});
// goBy goes back (-1) or forward (1) a page, or as many as step says (a
// page picked from the history list): by the tab's history, when it's
// this page's (so it stays in step), else here.
function goBy(step) {
    const to = at + step;
    if (!step || to < 0 || to >= entries.length) return;
    if (inTabs) {
        toTabs({ type: "step", step, at });  // by its history, or back here ("go")
        return;
    }
    if (history.state?.goAt === at) {
        history.go(step);
        return;
    }
    at = to;
    load(entries[at].url, { push: false });
}

function hostOf(url) {
    try { return new URL(url).host; } catch { return url; }
}

// load has the engine load url: as a new entry after the one shown, or
// (push false) as the one shown again.
function load(url, { push = true } = {}) {
    if (push) {
        entries = entries.slice(0, at + 1);
        entries.push({ url, title: "" });
        at = entries.length - 1;
        remember();
    }
    start.hidden = true;
    notice.hidden = true;
    loading = true;
    rendering = false;
    show(`Loading ${hostOf(url)}…`);
    update();
    if (!ws) {
        connecting ??= connect().then((ok) => ok || reconnect("Can't reach the server.", connect)).finally(() => (connecting = null));
        return;
    }
    sentView = view();
    ws.send(JSON.stringify({ op: "navigate", url, view: sentView }));
}

// The page's window in the engine is the size of the frame here (and its
// pixel ratio), so a page laying itself out for a phone or a wide screen,
// or measuring where its parts are, does so as it's shown. Measured here,
// on the frame element, not asked of what's in it; sent with each
// navigation, and again when it changes.
let sentView = null;
// The copy's layout size, as the frame says (its scroll bars left out: a
// page is laid out in what's left of the frame, and the engine's window,
// which has none, is made that, not the frame's whole width, or what the
// page places by its width, a carousel's slides, is off by a scroll bar).
let laidOut = null;
function view() {
    const r = frame.getBoundingClientRect();
    const inside = (v, frameSize) => Math.round(laidOut && v > 0 && v <= frameSize ? v : frameSize);
    return {
        w: inside(laidOut?.w, r.width), h: inside(laidOut?.h, r.height), dpr: Math.round((window.devicePixelRatio || 1) * 100) / 100,
        // The display, to the page: this window (its own screen isn't told).
        sw: Math.round(window.innerWidth), sh: Math.round(window.innerHeight),
        // Touch, if this device has it: the page offers what it offers to
        // touch screens, and takes the touches given it.
        touch: navigator.maxTouchPoints > 0, desktop: desktopOn,
        // Which way up the device is held: the page's screen.orientation and
        // (orientation: …) media queries follow it. Where the device doesn't
        // say, the window's shape.
        ...orientation(),
        // Light or dark, as this browser is: the page's (prefers-color-scheme)
        // and matchMedia follow it.
        scheme: colorScheme.matches ? "dark" : "light",
    };
}
function orientation() {
    const o = screen.orientation;
    if (o && /^(portrait|landscape)-(primary|secondary)$/.test(o.type)) return { o: o.type, a: Math.round(o.angle) || 0 };
    const portrait = window.innerHeight >= window.innerWidth;
    return { o: portrait ? "portrait-primary" : "landscape-primary", a: portrait ? 0 : 90 };
}
const colorScheme = matchMedia("(prefers-color-scheme: dark)");
const sameView = (a, b) => !!a && !!b && ["w", "h", "dpr", "sw", "sh", "touch", "desktop", "o", "a", "scheme"].every((k) => a[k] === b[k]);
let viewTimer = 0;
const viewSizes = new ResizeObserver(() => viewSoon());
function viewSoon() {
    clearTimeout(viewTimer);
    viewTimer = setTimeout(() => {
        const v = view();
        if (!ws || !v.w || !v.h || sameView(v, sentView) || keyboardUp()) return;
        sentView = v;
        ws.send(JSON.stringify({ op: "viewport", view: v }));
    }, 250);
}
viewSizes.observe(frame);
viewSizes.observe(document.documentElement);  // the window: the display
// Turned: a half turn (landscape one way to the other) changes no size.
screen.orientation?.addEventListener?.("change", () => viewSoon());
window.addEventListener("orientationchange", () => viewSoon());
// Light or dark flipped: the engine's page follows, as orientation does.
colorScheme.addEventListener("change", () => viewSoon());
// A device's keyboard, up for typing here or in the page: the frame's
// shorter for it (below), but the page in the engine keeps its size (as a
// phone's browser keeps a page's layout as its keyboard comes and goes),
// so it isn't laid out again, its scripts told of a resize, for each.
function keyboardUp() {
    const vv = window.visualViewport;
    const typing = document.activeElement === address || document.activeElement === frame;
    return !!vv && typing && navigator.maxTouchPoints > 0 && window.innerHeight - vv.height > 100;
}
// Mobile keyboards resize the visual viewport even when the layout viewport
// stays unchanged. Keep the toolbar and the remaining page in that space.
function fitViewport() {
    document.body.style.height = window.visualViewport ? `${window.visualViewport.height}px` : "100dvh";
}
window.visualViewport?.addEventListener("resize", fitViewport);
fitViewport();

function stop() {
    if (!ws || !loading) return;
    ws.send(JSON.stringify({ op: "stop" }));
    loading = false;
    rendering = false;
    show("");
    update();
}

// --- The tunnel -------------------------------------------------------

// connect opens a tab's engine, then loads the entry shown, if any. It
// resolves to false if the server couldn't be reached, so it's worth
// trying again, else true.
// heard: something's come on the connection since it took a tab back;
// closing: the tab's being closed by the person (not reconnected).
let heard = true, closing = false;
// pageLeft: this page's being left (a reload, another page): its connection
// closing isn't one to come back from here. (It would: and with the tab's
// token the next page has just been given, sessionStorage being the
// browser tab's, take that page's tab from it.)
let pageLeft = false;
window.addEventListener("pagehide", () => { pageLeft = true; });
// (Back from the browser's cache: as it was, but for its connection.)
window.addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    pageLeft = false;
    if (!ws) connecting ??= connect().then((ok) => ok || reconnect("Can't reach the server.", connect)).finally(() => (connecting = null));
});
// One connection at a time: one open, or opening, is the one (a second,
// with the token the first was just given, would take the tab from it).
let opening = null;
function connect() {
    if (pageLeft || ws) return Promise.resolve(true);
    opening ??= open().finally(() => (opening = null));
    return opening;
}
function open() {
    return new Promise((resolve) => {
        const resume = resumeToken.get();
        const s = new TunnelSocket({ type: "go", deflate: canInflate, ...(resume ? { resume } : {}) }, { title: "Browser" });
        show("Connecting to TabTop…");
        $("go_progress").hidden = false;
        s.onopen = () => {
            ws = s;
            gen = shown = 0;
            show("");
            $("go_progress").hidden = true;
            const reply = s.reply ?? {};
            resumeToken.set(typeof reply.resume === "string" && reply.resume.length <= 64 ? reply.resume : "");
            if (reply.resumed) {
                // The tab, as it is now: the page it shows (or is loading)
                // comes as it does, at this window's size; not loaded again.
                sentView = view();
                ws.send(JSON.stringify({ op: "viewport", view: sentView }));
                notice.hidden = true;
                show("Carrying on…");
                // Nothing from it soon (held up on the server): a tab of
                // its own, the page loaded again, as without one to take back.
                heard = false;
                setTimeout(() => {
                    if (ws !== s || heard) return;
                    resumeToken.set("");
                    s.close();
                    ws = null;
                    connecting ??= connect().then((ok) => ok || reconnect("Can't reach the server.", connect)).finally(() => (connecting = null));
                }, 10_000);
            } else if (at >= 0) {
                load(entries[at].url, { push: false });
            }
            resolve(true);
        };
        // In the order they come, though a compressed one takes a moment to
        // decompress: what follows it (changes to it) waits for it.
        let inbox = Promise.resolve();
        s.onmessage = (e) => {
            inbox = inbox.then(() => take(e.data)).catch(() => {});
        };
        const take = async (data) => {
            if (ws !== s) return;
            heard = true;
            if (typeof data !== "string") {
                // Request number 0: a large message, compressed (see
                // sendLarge in gobrowser.go); any other, a resource's bytes.
                if (!(data instanceof ArrayBuffer) || data.byteLength < 4 || new DataView(data).getUint32(0) !== 0) {
                    resData(data);
                    return;
                }
                data = await inflate(data.slice(4));
                if (ws !== s) return;
            }
            let m;
            try { m = JSON.parse(data); } catch { return; }
            if (m.type === "go-taken") {
                // This tab opened in another window (a duplicated browser
                // tab), which has it now: this one starts its own next.
                resumeToken.set("");
                return;
            }
            if (m.type === "go-res") {
                resHeader(m);  // of any page: not a generation's
                return;
            }
            if (m.type === "go-ads") {
                // Not a generation's either: the server's count is always
                // the page it's at now's, whatever generation that is yet.
                if (ws === s && typeof m.count === "number") showAds(m.count);
                return;
            }
            if (ws !== s || !Number.isSafeInteger(m.gen) || m.gen < gen) return;  // an older page's
            gen = m.gen;
            message(m);
        };
        s.onclose = (e) => {
            resLost(s);
            if (closing || pageLeft) return;  // closed by the person, or the page left: nothing to come back to
            const was = ws === s;
            // One that isn't the page's now (replaced, or never opened to be
            // it): nothing of the one that is is touched, nor said.
            if (!was && ws) {
                resolve(!e.lost);
                return;
            }
            ws = null;
            loading = rendering = false;
            closeDialog();
            update();
            if (e.login) {
                forgetSession(s.session);
                storedSession() ? connect().then((ok) => ok || reconnect("Can't reach the server.", connect)) : location.reload();
            } else if (e.lost) {
                if (was) reconnect(resumeToken.get()
                    ? "Connection lost. The page carries on on the server for 5 minutes; reconnecting picks it up where it is."
                    : "Connection lost. Reconnecting will reload this page; unsaved input may be lost.", connect);
            } else {
                show("");
                warn(`${e.reason || "The browser’s engine was closed."} Reconnecting will reload the page; unsaved input may be lost.`, { retry: () => connect(), label: "Reconnect", edit: at >= 0 });
            }
            resolve(!e.lost);
        };
    });
}

// The page's streams, as the player's Save stream offers them
// (gostreams.go; go-media.js): by address, what each is ({height, duration, live}, as far as its manifests
// say), in the order they came.
const manifests = new Map();
let manifestGeneration;
const AD_AT_MOST = 60;     // seconds: a stream this short beside a long one is an ad's
const MAIN_AT_LEAST = 120; // seconds: the long one
// savedStreams is the page's streams to save, the likeliest first: the
// longest (the video, not an ad before it or a preview), then those not
// known to be long, newest first. Passed over: a live one (it can't be
// saved), and an ad's (a minute or less, beside one of two minutes or more).
function savedStreams() {
    const all = [...manifests].map(([url, about], i) => ({ url, about, i }));
    const longest = Math.max(0, ...all.map(s => s.about.duration || 0));
    return all
        .filter(s => !s.about.live && !(longest >= MAIN_AT_LEAST && s.about.duration > 0 && s.about.duration <= AD_AT_MOST))
        .sort((a, b) => (b.about.duration || 0) - (a.about.duration || 0) || b.i - a.i);
}
// streamName names a stream by what it is: its picture's height, how long
// it lasts, and the site it's from ("1080p · 12:34 · xhcdn.com"); by its
// file's name too, where neither's known.
function streamName(url, about) {
    const u = new URL(url);
    // (Its site: the host's last two names, three for a country's
    // "co.uk"; an address, as it is.)
    const host = u.hostname.replace(/^www\./, ""), labels = host.split(".");
    const site = /^[\d.]+$|^\[/.test(host) ? host : labels.slice(labels.length > 2 && labels.at(-2).length <= 3 ? -3 : -2).join(".");
    const d = Math.round(about.duration || 0);
    const length = d > 0 ? (d >= 3600 ? `${Math.floor(d / 3600)}:${String(Math.floor(d / 60) % 60).padStart(2, "0")}` : `${Math.floor(d / 60)}`) + `:${String(d % 60).padStart(2, "0")}` : "";
    const known = [about.height > 0 ? `${about.height}p` : "", length].filter(Boolean);
    return [...(known.length ? known : [u.pathname.split("/").pop() || u.host]), site].join(" · ");
}
function message(m) {
    switch (m.type) {
        case "go-manifest": {
            // A page this one didn't see load (a tab taken back, its page
            // shown already): its streams, from scratch. (An older page's
            // never come here: see the socket's handler.)
            if (m.gen !== manifestGeneration) {
                manifestGeneration = m.gen;
                manifests.clear();
            }
            if (typeof m.url !== "string" || !pages.some(p => p.id === "files")) break;
            const num = (v, most) => (Number.isFinite(v) && v > 0 && v <= most ? v : 0);
            const about = { height: num(m.height, 100000), duration: num(m.duration, 1e7), live: m.live === true };
            // Offered again, with more said of it (how long, once known):
            // as it was, in its place.
            // The newest kept: past 24, the oldest goes (as the server's).
            if (!manifests.has(m.url) && manifests.size >= 24) manifests.delete(manifests.keys().next().value);
            manifests.set(m.url, about);
            break;
        }
        case "go-manifests-clear":
            // The page gone to another place in itself (a single-page site's
            // next video): its streams afresh.
            if (m.gen === manifestGeneration) {
                manifests.clear();
            }
            break;
        case "go-loading":
            manifestGeneration = m.gen;
            manifests.clear();
            showAds(0);
            if (m.by === "page" && typeof m.url === "string") {
                // The page went somewhere itself: a link, a form, a script.
                entries = entries.slice(0, at + 1);
                entries.push({ url: m.url, title: "" });
                at = entries.length - 1;
                remember();
            }
            loading = true;
            rendering = false;
            notice.hidden = true;
            // Pop-ups the page left asked about are gone with it, as a
            // browser's notice of them is.
            popupAsks = [];
            popupBox.hidden = true;
            // A question the page is waiting on is gone with it; what it
            // only said (a notice) stays, read or not.
            if (!noticing) closeDialog();
            show(`Loading ${hostOf(m.url)}…`);
            update();
            break;
        case "go-reload":
            // Taken back with nothing to show: loaded again.
            if (at >= 0) load(entries[at].url, { push: false });
            else show("");
            break;
        case "go-snapshot": {
            loading = false;
            rendering = true;
            const entry = entries[at];
            if (entry) {
                entry.url = typeof m.url === "string" && /^https?:/i.test(m.url) ? m.url : entry.url;
                entry.title = typeof m.title === "string" ? m.title : "";
                if (!m.again) recent(entry.url);
            }
            if (!m.again) spent = 0;
            show("Preparing images and styles…");
            if (!m.again && shown !== m.gen) {
                // Another page: its players, not the last one's.
                media.stop();
                media = newMedia();
            }
            shown = m.gen;
            applyMediaPolicy(m.mediaPolicy ?? "allow");
            media.blockHosts(m.videoHosts);
            lastRender = { type: "render", gen: m.gen, url: m.url, base: m.base, doc: m.doc, again: !!m.again, io: m.io, at: m.at, hide: m.hide };
            toFrame(lastRender);
            update();
            break;
        }
        case "go-changes":
            if (m.gen === shown) media.streams(m.streams);
            if (m.gen === shown) {
                media.eme(m.eme);
                toFrame({ type: "changes", gen: m.gen, ops: m.ops, title: m.title, io: m.io, scrolls: m.scrolls, hide: m.hide });
                // Kept with the page, for a frame given it again.
                if (Array.isArray(m.hide) && lastRender?.gen === m.gen) lastRender.hide = [...(lastRender.hide ?? []), ...m.hide];
            }
            break;
        case "go-net":
            // Whether the page being read is still loading: the frame holds
            // a new page back until it settles (it checks the gen).
            toFrame({ type: "net", gen: m.gen, busy: !!m.busy });
            break;
        case "go-url":
            // The page changed its address itself (history.pushState, a
            // link within it): a new entry, as browsers make.
            if (typeof m.url === "string" && at >= 0 && m.url !== entries[at].url) {
                entries = entries.slice(0, at + 1);
                entries.push({ url: m.url, title: m.title || entries[at].title });
                at++;
                remember();
                update();
            }
            break;
        case "go-dialog":
            noticing = null;
            openDialog(m);
            break;
        case "go-dialog-notice":
            // Asked, and answered by the engine itself (godialogs.js):
            // shown, one after another, but the page didn't wait.
            if (m.gen === shown && notices.length < 16) {
                notices.push(m);
                noticesSeen.set(m.gen, (noticesSeen.get(m.gen) ?? 0) + 1);
                if (!dialog.open) showNotice();
            }
            break;
        case "go-dialog-closed":
            closeDialog();
            break;
        case "go-popup":
            // A window the page opened: a tab of its own, or (none to be
            // had, or this tab on its own) this one, as a link of the page's.
            if (typeof m.url === "string" && /^https?:\/\//i.test(m.url)) {
                if (inTabs) toTabs({ type: "popup", url: m.url });
                else load(m.url);
            }
            break;
        case "go-popup-ask":
            // A site with nothing said of its pop-ups: the person's asked.
            if (Number.isSafeInteger(m.id) && typeof m.url === "string") askPopup(m);
            break;
        case "go-popup-blocked":
            note(m.why === "blocked" ? "A pop-up to a blocked site wasn't opened." : `A pop-up from ${m.site || "this site"} was blocked (Site controls: the button at the address’s start).`);
            break;
        case "go-file":
            loading = rendering = false;
            show("");
            offerFile(m.url, m.mime);
            update();
            break;
        case "go-error":
            loading = rendering = false;
            show("");
            warn(m.message || "The page couldn’t be loaded.", { retry: at >= 0 ? () => load(entries[at].url, { push: false }) : null, label: "Retry", edit: true });
            update();
            break;
    }
}

// --- The frame --------------------------------------------------------

// Resources fetched, kept for pages shown again (back, reload), up to
// CACHE bytes, the oldest dropped first.
const CACHE = 64 << 20;
const cache = new Map();  // kind + url -> Promise of a Blob
let cached = 0;
// forgetResources forgets what's kept here for the copy (Clear cache).
function forgetResources() {
    cache.clear();
    cached = 0;
}
// Settings can be open in the lightbox or in a separate browser tab.
const cacheEvents = new BroadcastChannel(new URL("./", location.href).pathname + "cache");
cacheEvents.addEventListener("message", ({ data }) => {
    if (data === "cleared") forgetResources();
});
function cachedResource(kind, url) {
    const key = kind + " " + url;
    let got = cache.get(key);
    if (got) {
        cache.delete(key);
        cache.set(key, got);  // most recently used last
        return got;
    }
    got = fetchResource(kind, url).then((blob) => {
        if (cache.get(key) !== got) return blob;  // forgotten meanwhile (Clear cache): not counted
        cached += blob.size;
        for (const [k, p] of cache) {
            if (cached <= CACHE || k === key) break;
            cache.delete(k);
            p.then((b) => (cached -= b.size), () => {});
        }
        return blob;
    });
    got.catch(() => cache.delete(key));
    cache.set(key, got);
    return got;
}

// fetchResource fetches what the frame asked for through the server, as a
// Blob, within the page's budget: over the tab's own tunnel (the server has
// usually fetched it already, see goprefetch.go), or one of its own if
// that isn't open.
async function fetchResource(kind, url) {
    const limit = RESOURCE_LIMITS[kind];
    if (!limit || typeof url !== "string" || !/^https?:\/\//i.test(url)) throw new Error("not allowed");
    if (ws?.readyState === TunnelSocket.OPEN) return viaTab(ws, kind, url, limit);
    const t = await call({ type: "go-resource", resource: kind, url });
    const { size, mime } = t.reply;
    if (!Number.isSafeInteger(size) || size < 0 || size > limit) {
        t.close();
        throw new Error("too large");
    }
    if (spent + size > PAGE_BUDGET) {
        t.close();
        throw new Error("the page uses too much");
    }
    spent += size;
    return collect(t, size, () => {}, kind === "css" ? "text/css" : mime);
}

// Large messages may come compressed (raw deflate), if this browser can
// decompress them, as it says when it opens the tunnel.
const canInflate = (() => {
    try { return typeof DecompressionStream === "function" && !!new DecompressionStream("deflate-raw"); } catch { return false; }
})();
function inflate(bytes) {
    return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
}

// Resources over the tab's tunnel: asked for by number; the answer, a
// header, then the bytes in binary messages that start with the number.
let lastRid = 0;
const resWaiting = new Map();  // number -> what's come of it
function viaTab(s, kind, url, limit) {
    return new Promise((resolve, reject) => {
        const rid = ++lastRid;
        resWaiting.set(rid, { s, kind, limit, resolve, reject, parts: [], got: 0, size: -1, mime: "" });
        s.send(JSON.stringify({ op: "res", rid, kind, url }));
    });
}
// mediaViaTab asks for part of a player's file ({offset, length, if_size,
// if_mtime}; length 0, its first byte, to learn of it): its bytes as a
// Blob and the server's word on it, as a go-resource "media" request's.
// Not counted against the page's budget: a player reads what's played.
const MEDIA_PART = 1 << 20;
function mediaViaTab(s, url, part) {
    return new Promise((resolve, reject) => {
        const rid = ++lastRid;
        resWaiting.set(rid, { s, kind: "media", limit: MEDIA_PART, media: true, resolve, reject, parts: [], got: 0, size: -1, mime: "" });
        s.send(JSON.stringify({ op: "res", rid, kind: "media", url, offset: part.offset ?? 0, length: part.length ?? 0,
            if_size: part.if_size ?? 0, if_mtime: part.if_mtime ?? "" }));
    });
}
function resFail(rid, message) {
    const r = resWaiting.get(rid);
    resWaiting.delete(rid);
    r?.reject(new Error(message));
}
function resHeader(m) {
    const r = resWaiting.get(m.rid);
    if (!r) return;
    if (typeof m.error === "string") return resFail(m.rid, m.error);
    if (!Number.isSafeInteger(m.size) || m.size < 0 || m.size > r.limit) return resFail(m.rid, "too large");
    if (!r.media && spent + m.size > PAGE_BUDGET) return resFail(m.rid, "the page uses too much");
    if (!r.media) spent += m.size;
    r.size = m.size;
    r.mime = r.kind === "css" ? "text/css" : typeof m.mime === "string" ? m.mime : "";
    if (r.media) r.reply = { size: m.size, mime: r.mime, url: m.url, total_size: m.total_size, validator: m.validator };
    if (r.size === 0) resDone(m.rid, r);
}
function resDone(rid, r) {
    resWaiting.delete(rid);
    if (r.media) {
        const bytes = new Uint8Array(r.size);
        let offset = 0;
        for (const part of r.parts) {
            bytes.set(part, offset);
            offset += part.length;
        }
        r.resolve({ bytes: bytes.buffer, reply: r.reply });
    } else {
        r.resolve(new Blob(r.parts, { type: r.mime }));
    }
}
function resData(buf) {
    if (!(buf instanceof ArrayBuffer) || buf.byteLength < 4) return;
    const rid = new DataView(buf).getUint32(0);
    const r = resWaiting.get(rid);
    if (!r || r.size < 0) return;
    const part = new Uint8Array(buf, 4);
    r.parts.push(part);
    r.got += part.length;
    if (r.got > r.size) return resFail(rid, "more than it said");
    if (r.got === r.size) resDone(rid, r);
}
// What was asked of a tunnel that's gone won't come.
function resLost(s) {
    for (const [rid, r] of resWaiting) if (r.s === s) resFail(rid, "the connection was lost");
}

window.addEventListener("message", (e) => {
    if (e.source !== frame.contentWindow || !e.data || typeof e.data !== "object") return;
    const m = e.data;
    if (m.type === "loaded") {
        // Once for each frame document, to the first to ask: the renderer
        // asks as it starts, so anything asking again isn't it.
        if (greeted) return;
        greeted = true;
        frame.contentWindow.postMessage({ type: "hello", token }, "*");
        return;
    }
    if (m.token !== token) return;
    switch (m.type) {
        case "ready":
            frameReady();
            break;
        case "layout":
            if (Number.isFinite(m.w) && Number.isFinite(m.h) && m.w > 0 && m.h > 0) {
                laidOut = { w: m.w, h: m.h };
                viewSoon();
            }
            break;
        case "resource":
            cachedResource(m.kind, m.url).then(
                (blob) => frame.contentWindow?.postMessage({ type: "resource", id: m.id, blob }, "*"),
                (err) => frame.contentWindow?.postMessage({ type: "resource", id: m.id, error: String(err?.message || err) }, "*"));
            break;
        case "navigate":
            if (typeof m.url === "string" && /^https?:\/\//i.test(m.url)) load(m.url);
            break;
        case "event":
            // Done in the engine, for the document shown only.
            if (ws && m.gen === shown && Number.isSafeInteger(m.id)) {
                const { kind, id, value, checked, key, code, shift, ctrl, alt, meta, submitter } = m;
                // The mouse and keys, as input (see goinput.go): numbers
                // and words only ("phase" here, as "type" is the message's).
                const num = (v) => (Number.isFinite(v) ? v : 0);
                const input = { type: typeof m.phase === "string" ? m.phase : "", fx: num(m.fx), fy: num(m.fy), button: num(m.button),
                    buttons: num(m.buttons), count: num(m.count), dx: num(m.dx), dy: num(m.dy), keyCode: num(m.keyCode),
                    location: num(m.location), repeat: !!m.repeat, sx: num(m.sx), sy: num(m.sy), tap: !!m.tap, frame: num(m.frame), fdoc: num(m.fdoc),
                    route: (Array.isArray(m.route) ? m.route.slice(0, 2) : []).map(num), docs: (Array.isArray(m.docs) ? m.docs.slice(0, 2) : []).map(num),
                    points: (Array.isArray(m.points) ? m.points.slice(0, 10) : []).map((p) => ({ id: num(p?.id), fx: num(p?.fx), fy: num(p?.fy), t: num(p?.t) })),
                    items: (Array.isArray(m.items) ? m.items.slice(0, 3) : []).map((i) => ({ type: String(i?.type ?? ""), data: String(i?.data ?? "") })) };
                ws.send(JSON.stringify({ op: "event", gen: m.gen, kind, id, value, checked, key, code, shift, ctrl, alt, meta, submitter, ...input }));
            }
            break;
        case "resync":
            if (ws && m.gen === shown) ws.send(JSON.stringify({ op: "resync", gen: m.gen }));
            break;
        case "media":
            // A player for a box in the copy (go-media.js).
            if (m.gen === shown && Number.isSafeInteger(m.key)) {
                const owner = media;
                owner.open(m).then((got) => {
                    if (got && owner === media) frame.contentWindow?.postMessage({ type: "media-state", key: m.key, error: got.error ?? "", blocked: got.blocked }, "*");
                });
            }
            break;
        case "drop-files":
            if (m.gen === shown) warn("Files can’t be dropped into the remote browser: it doesn’t take files from this device.", { error: false });
            break;
        case "media-play":
            // The page started or stopped its player (a feed's next video).
            if (m.gen === shown && Number.isSafeInteger(m.key)) media.play(m.key, !!m.play);
            break;
        case "media-positions":
            if (m.gen === shown && Array.isArray(m.positions)) {
                const keys = new Set();
                for (const at of m.positions.slice(0, 256)) {
                    if (!Number.isSafeInteger(at?.key)) continue;
                    keys.add(at.key);
                    media.place(at);
                }
                media.keep(keys);
            }
            break;
        case "io": {
            const rect = (r) => (Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) ? r : null);
            // An element's sizes, for the page's ResizeObserver (goobserve.js).
            const sizes = (z) => (Array.isArray(z) && z.length === 8 && z.every((v) => Number.isFinite(v) && v >= 0) ? z : undefined);
            // What this browser saw of the elements the page observes: on to
            // the engine, in pieces well within a message's limit.
            if (ws && m.gen === shown && Array.isArray(m.entries)) {
                const entries = m.entries.filter((e) => e && Number.isSafeInteger(e.o) && Number.isSafeInteger(e.i))
                    .map((e) => ({ o: e.o, i: e.i, hit: !!e.hit, ratio: Number(e.ratio) || 0, b: rect(e.b), r: rect(e.r), rb: rect(e.rb), z: sizes(e.z) }));
                for (let at = 0; at < entries.length; at += 500) {
                    ws.send(JSON.stringify({ op: "io", gen: m.gen, entries: entries.slice(at, at + 500) }));
                }
            }
            break;
        }
        case "title":
            if (m.gen === shown && entries[at] && typeof m.title === "string" && m.title !== entries[at].title) {
                entries[at].title = m.title;
                update();
            }
            break;
        case "rendered":
            if (m.gen === shown && !loading) {
                rendering = false;
                show("");
                if (m.report?.error) warn(`The page couldn’t be shown: ${m.report.error}`, {
                    retry: () => load(entries[at].url, { push: false }), label: "Reload page", edit: true,
                });
                update();
            }
            break;
    }
});

// --- Dialogs and files -------------------------------------------------

const dialog = $("go_dialog");
// openDialog asks what the page's alert, confirm or prompt asks; the page
// waits for the answer (or the server answers for it, after a minute).
function openDialog(m) {
    const kind = ["alert", "confirm", "prompt"].includes(m.kind) ? m.kind : "alert";
    // Said to come from the document that asked (the server's word), not
    // from the address bar's: a page may open a popup, which loads in this
    // tab, and ask straight after, before its own document has gone.
    const from = typeof m.url === "string" && /^https?:/i.test(m.url) ? hostOf(m.url) : "The page";
    dialog.querySelector("p").textContent = `${from} says: ${m.message ?? ""}`;
    const input = dialog.querySelector("input[type=text]");
    input.hidden = kind !== "prompt";
    // Asked before by this page: it may be asking in a loop, which this
    // stops (answered by the server from then on).
    const quiet = dialog.querySelector(".quiet");
    quiet.hidden = !m.again;
    quiet.querySelector("input").checked = false;
    input.value = typeof m.default === "string" ? m.default : "";
    dialog.querySelector(".cancel").hidden = kind === "alert";
    if (!dialog.open) dialog.showModal();
    (kind === "prompt" ? input : dialog.querySelector(".ok")).focus();
}
// What the page asked by alert, confirm or prompt with an engine that
// answered it itself, to show; the one shown; how many a page has asked.
let notices = [];
let noticing = null;
const noticesSeen = new Map();  // gen -> how many
function showNotice() {
    noticing = notices.shift() ?? null;
    if (!noticing) return;
    const m = noticing;
    const note = m.kind === "alert" ? "" : `\n\n(It got no answer: this browser's engine answers ${m.kind === "confirm" ? "such questions with Cancel" : "prompts with nothing"} itself, at once.)`;
    openDialog({ kind: "alert", message: (m.message ?? "") + note, url: m.url, again: noticesSeen.get(m.gen) > 1 });
}
function closeDialog() {
    if (dialog.open) dialog.close();
}
function answerDialog(accept) {
    const input = dialog.querySelector("input[type=text]");
    const quiet = dialog.querySelector(".quiet");
    if (noticing) {
        // Shown only: nothing to answer, unless it's to show no more.
        const enough = !quiet.hidden && quiet.querySelector("input").checked;
        if (enough) {
            ws?.send(JSON.stringify({ op: "dialog", accept: false, text: "", quiet: true }));
            notices = [];
        }
        noticing = null;
        closeDialog();
        showNotice();
        return;
    }
    ws?.send(JSON.stringify({ op: "dialog", accept, text: input.hidden ? "" : input.value, quiet: !quiet.hidden && quiet.querySelector("input").checked }));
    closeDialog();
}
// (OK is the form's submit button: answered by the submit, below, once.)
dialog.querySelector(".cancel").addEventListener("click", () => answerDialog(false));
dialog.addEventListener("cancel", (e) => { e.preventDefault(); answerDialog(false); });
dialog.querySelector("form").addEventListener("submit", (e) => { e.preventDefault(); answerDialog(true); });

// offerFile offers to save a file the page led to (a PDF, an archive) into
// Downloads: fetched there by the server, as Fetch from URL on the files
// page does, never through this device.
function offerFile(url, mime) {
    const what = `This is a file from ${hostOf(url)} (${mime || "unknown type"}), not a page.`;
    if (!pages.some((p) => p.id === "files")) {
        warn(`${what} Files are turned off on this server, so it can't be saved here.`, { error: false });
        return;
    }
    warn(`${what} Save it into Downloads?`, { error: false, retry: () => saveFile(url), label: "Save into Downloads" });
}
// saveFile saves url into Downloads, saying how it goes (say: where, as
// the player does over the page; else the page's status, and its notice).
const downloadKey = "tabtop-go-downloads:" + tabId;
const downloads = new Set();
function rememberDownloads() {
    try { sessionStorage.setItem(downloadKey, JSON.stringify([...downloads].filter(job => job.id))); } catch { /* storage unavailable */ }
}
// followDownload follows a download being saved, by its id, through a lost
// connection: asked again, less and less often, for FOLLOW_FOR; then given
// up on here (the server may still be saving it: Downloads shows it).
const FOLLOW_FOR = 120000;
async function followDownload(id) {
    const until = Date.now() + FOLLOW_FOR;
    for (let delay = 1000; ; delay = Math.min(delay * 2, 15000)) {
        try { return await call({ type: "fetch", name: id }); }
        catch (err) {
            if (!err.lost) throw err;
            if (Date.now() >= until) throw Object.assign(new Error("lost touch with the server"), { lostTouch: true });
        }
        await new Promise(resolve => setTimeout(resolve, delay));
    }
}
// runningDownload is the download of url (a file, or a stream) going on,
// if there is one: a player opened again shows it, not a second one.
function runningDownload(url, stream) {
    for (const job of downloads) if (url && job.url === url && job.stream === stream && !job.cancelling) return job;
    return null;
}
// saveFile saves url (a stream's manifest, if stream) into Downloads, as a
// job that's followed here, through lost connections and the page's
// reloads, saying how it goes to say (a player's) or the page. With attach,
// only a running one's said, to a player opened again; and one of the same
// is never started twice: the player asking is told of the one going on.
async function saveFile(url, say = null, stream = false, job = { id: "", label: hostOf(url), cancelling: false }, { attach = false, detach = false } = {}) {
    // A player closed: what it was shown goes to the page instead (its
    // status, then its notice), not to the player gone.
    if (detach) {
        for (const running of downloads) {
            if (running.say !== say) continue;
            running.say = null;
            running.tell?.();
        }
        return;
    }
    // (Taken back after the page's reload: its address and kind, kept.)
    if (!url && job.url) {
        url = job.url;
        stream = !!job.stream;
    }
    const running = job.id ? null : runningDownload(url, stream);
    if (running || attach) {
        if (running && say) {
            running.say = say;
            running.tell?.();
        }
        return;
    }
    job.url = url;
    job.stream = stream;
    job.say = say;
    let t;
    const button = document.createElement("button");
    button.className = "item";
    const labelButton = () => {
        button.textContent = (job.cancelling ? "Cancelling " : "Cancel download · ") + job.label;
        button.disabled = job.cancelling;
    };
    const sendCancel = () => {
        try { t?.sendText(JSON.stringify({ cancel: true })); } catch { /* sent when reconnected */ }
    };
    const cancel = () => {
        job.cancelling = true;
        labelButton();
        rememberDownloads();
        sendCancel();
        if (job.say) job.say("Cancelling download…", null);
    };
    // What it says now, to a player that comes to show it.
    let saying = [`Saving ${job.label} into Downloads…`, null];
    job.tell = () => {
        if (job.say) job.say(saying[0], saying[1], job.cancelling ? null : cancel);
        else show(saying[0] + (typeof saying[1] === "number" ? ` · ${Math.floor(saying[1] * 100)}%` : ""));
    };
    downloads.add(job);
    button.onclick = cancel;
    labelButton();
    $("go_downloads").append(button);
    const starting = `Saving ${job.label} into Downloads…`;
    if (job.say) job.say(starting, null, cancel);
    else show(starting);
    try {
        t = job.id ? await followDownload(job.id)
            : await call({ type: "fetch", path: "", url, from_go: true, save_stream: stream, go_tab: resumeToken.get() });
        job.id = t.reply.fetch.id;
        rememberDownloads();
        if (job.cancelling) sendCancel();
        for (;;) {
            const m = await t.next();
            if (!m) {
                t.close();
                t = null;
                t = await followDownload(job.id);
                if (job.cancelling) sendCancel();
                continue;
            }
            if (m.text === undefined) continue;
            const res = JSON.parse(m.text);
            if (res.error) throw new Error(res.error);
            if (res.fetch && !res.fetch.done) {
                const { got, total, name } = res.fetch;
                if (name && name !== job.label) {
                    job.label = name;
                    labelButton();
                    rememberDownloads();
                }
                const fraction = res.fetch.parts > 0 ? (res.fetch.partsDone || 0) / res.fetch.parts : Number.isFinite(total) && total > 0 && Number.isFinite(got) && got >= 0
                    ? Math.min(1, got / total) : null;
                saying = [`Saving ${name || "file"} into Downloads…`, fraction];
                if (job.say) {
                    job.tell();
                    continue;
                }
                const amount = Number.isFinite(got) && got >= 0 ? `${(got / 1048576).toFixed(1)} MB` : "";
                const progress = fraction !== null ? `${Math.floor(fraction * 100)}% · ${amount}` : amount;
                show(`Saving ${name || "file"}${progress ? ` · ${progress}` : ""}…`);
            }
            if (res.fetch?.done) {
                if (job.say) return job.say(`Saved ${res.fetch.name} into Downloads.`);
                show("");
                warn(`Saved ${res.fetch.name} into Downloads.`, { error: false, retry: () => openPage("files"), label: "Open Downloads" });
                return;
            }
        }
    } catch (err) {
        if (err.message === "cancelled") {
            if (job.say) return job.say("Download cancelled.");
            show("");
            warn("Download cancelled.", { error: false });
            return;
        }
        if (err.lostTouch) {
            // (Not that it failed: it may still be saving, on the server.)
            const said = `Lost touch with the download of ${job.label}; it may still be saving: see Downloads.`;
            if (job.say) return job.say(said);
            show("");
            warn(said, { error: false, retry: () => openPage("files"), label: "Open Downloads" });
            return;
        }
        if (err.message === "That fetch finished a while ago.") {
            // Followed again after long enough that the server's forgotten how
            // it ended: not that it failed (it may well be in Downloads).
            const said = `The download of ${job.label} finished a while ago: see Downloads.`;
            if (job.say) return job.say(said);
            show("");
            warn(said, { error: false, retry: () => openPage("files"), label: "Open Downloads" });
            return;
        }
        if (job.say) return job.say(`Not saved: ${err.message}`);
        show("");
        warn(`Not saved: ${err.message}`, { retry: url ? () => saveFile(url, null, stream) : () => openPage("files"), label: url ? "Retry save" : "Open Downloads" });
    } finally {
        t?.close();
        downloads.delete(job);
        button.remove();
        rememberDownloads();
    }
}

// MSE spill staging: completed clear-MP4 pieces go to the server while the
// stream plays (gostreammse.go); Save finalizes the remux into Downloads.
const MSE_UPLOAD_CHUNK = 256 * 1024;
const MSE_KIND = { init: 1, part: 2, progressive: 3 };
const mseStages = new WeakMap(); // stream -> stage session

async function openMSEStageSession() {
    const t = await call({ type: "fetch", path: "", from_go: true, save_mse: true, mse_stage: true, go_tab: resumeToken.get() });
    const id = t.reply?.stage;
    if (!id) {
        t.close();
        throw new Error("the server didn't open a stream stage");
    }
    let closed = false;
    const sendAndAck = async (bytes) => {
        t.sendData(bytes);
        const m = await t.next();
        if (!m) throw Object.assign(new Error("lost touch with the server"), { lostTouch: true });
        if (m.text !== undefined) {
            const res = JSON.parse(m.text);
            if (res.error) throw new Error(res.error);
            throw new Error("the server's reply is malformed");
        }
    };
    return {
        id,
        tunnel: t,
        async write({ track, kind, bytes }) {
            if (closed) throw new Error("buffered stream was cancelled");
            const kindByte = MSE_KIND[kind];
            if (!kindByte || !(bytes instanceof Uint8Array) || !bytes.length) {
                throw new Error("invalid stream frame");
            }
            const header = new Uint8Array(6);
            header[0] = track & 0xff;
            header[1] = kindByte;
            new DataView(header.buffer).setUint32(2, bytes.length);
            let offset = 0;
            const firstLen = Math.min(bytes.length, MSE_UPLOAD_CHUNK - 6);
            const first = new Uint8Array(6 + firstLen);
            first.set(header);
            first.set(bytes.subarray(0, firstLen), 6);
            await sendAndAck(first);
            offset = firstLen;
            while (offset < bytes.length) {
                const end = Math.min(offset + MSE_UPLOAD_CHUNK, bytes.length);
                await sendAndAck(bytes.subarray(offset, end));
                offset = end;
            }
        },
        abort() {
            if (closed) return;
            closed = true;
            try { t.sendText(JSON.stringify({ cancel: true })); } catch { /* closed */ }
            try { t.close(); } catch { /* closed */ }
        },
        get closed() { return closed; },
        markClosed() { closed = true; },
    };
}

async function ensureMSEStage(stream) {
    let stage = mseStages.get(stream);
    if (stage && !stage.closed) return stage;
    stage = await openMSEStageSession();
    mseStages.set(stream, stage);
    return stage;
}

async function spillMSECapture(stream, ev) {
    const stage = await ensureMSEStage(stream);
    await stage.write(ev);
}

function abortMSECapture(stream) {
    const stage = mseStages.get(stream);
    if (!stage) return;
    mseStages.delete(stream);
    stage.abort();
}

async function saveMSECapture(stream, say = null, { attach = false, detach = false } = {}) {
    const url = "mse:buffered";
    if (detach) {
        for (const running of downloads) {
            if (running.say !== say) continue;
            running.say = null;
            running.tell?.();
        }
        return;
    }
    const running = runningDownload(url, true);
    if (running || attach) {
        if (running && say) {
            running.say = say;
            running.tell?.();
        }
        return;
    }
    if (stream?.element?.mediaKeys) {
        stream.capture?.markEncrypted();
        abortMSECapture(stream);
    }
    if (stream?.capture?.encrypted) {
        if (say) say("Not saved: encrypted streams can't be saved");
        else warn("Not saved: encrypted streams can't be saved");
        return;
    }
    try {
        if (stream?.capture?.seal) await stream.capture.seal();
        else await stream?.capture?.flush?.();
    } catch (err) {
        if (say) say(`Not saved: ${err.message}`);
        else warn(`Not saved: ${err.message}`);
        return;
    }
    if (!stream?.capture?.saveable()) {
        if (say) say("Not saved: buffered stream has no media segments yet");
        else warn("Not saved: buffered stream has no media segments yet");
        return;
    }
    const job = { id: "", label: "stream.mp4", url, stream: true, cancelling: false, say };
    let stage;
    const button = document.createElement("button");
    button.className = "item";
    const labelButton = () => {
        button.textContent = (job.cancelling ? "Cancelling " : "Cancel download · ") + job.label;
        button.disabled = job.cancelling;
    };
    const sendCancel = () => {
        try { stage?.tunnel?.sendText(JSON.stringify({ cancel: true })); } catch { /* sent when reconnected */ }
    };
    const cancel = () => {
        job.cancelling = true;
        labelButton();
        rememberDownloads();
        sendCancel();
        if (job.say) job.say("Cancelling download…", null);
    };
    let saying = [`Saving buffered stream into Downloads…`, null];
    job.tell = () => {
        if (job.say) job.say(saying[0], saying[1], job.cancelling ? null : cancel);
        else show(saying[0] + (typeof saying[1] === "number" ? ` · ${Math.floor(saying[1] * 100)}%` : ""));
    };
    downloads.add(job);
    button.onclick = cancel;
    labelButton();
    $("go_downloads").append(button);
    if (job.say) job.say(saying[0], null, cancel);
    else show(saying[0]);
    try {
        stage = await ensureMSEStage(stream);
        if (job.cancelling) {
            sendCancel();
            throw new Error("cancelled");
        }
        stage.tunnel.sendText(JSON.stringify({ finalize: true }));
        mseStages.delete(stream);
        stage.markClosed();
        for (;;) {
            const m = await stage.tunnel.next();
            if (!m) {
                if (!job.id) throw Object.assign(new Error("lost touch with the server"), { lostTouch: true });
                stage.tunnel.close();
                stage.tunnel = await followDownload(job.id);
                if (job.cancelling) sendCancel();
                continue;
            }
            if (m.text === undefined) continue;
            const res = JSON.parse(m.text);
            if (res.error) throw new Error(res.error);
            if (res.fetch && !job.id) {
                job.id = res.fetch.id || "";
                rememberDownloads();
            }
            if (res.fetch && !res.fetch.done) {
                const { got, total, name } = res.fetch;
                if (name && name !== job.label) {
                    job.label = name;
                    labelButton();
                    rememberDownloads();
                }
                const fraction = res.fetch.parts > 0 ? (res.fetch.partsDone || 0) / res.fetch.parts
                    : Number.isFinite(total) && total > 0 && Number.isFinite(got) && got >= 0 ? Math.min(1, got / total) : null;
                saying = [`Saving ${name || "stream"} into Downloads…`, fraction];
                job.tell();
                continue;
            }
            if (res.fetch?.done) {
                stream?.capture?.markSaved?.();
                if (job.say) return job.say(`Saved ${res.fetch.name} into Downloads.`);
                show("");
                warn(`Saved ${res.fetch.name} into Downloads.`, { error: false, retry: () => openPage("files"), label: "Open Downloads" });
                return;
            }
        }
    } catch (err) {
        if (err.message === "cancelled") {
            if (job.say) return job.say("Download cancelled.");
            show("");
            warn("Download cancelled.", { error: false });
            return;
        }
        if (err.lostTouch) {
            const said = `Lost touch with the download of ${job.label}; it may still be saving: see Downloads.`;
            if (job.say) return job.say(said);
            show("");
            warn(said, { error: false, retry: () => openPage("files"), label: "Open Downloads" });
            return;
        }
        if (job.say) return job.say(`Not saved: ${err.message}`);
        show("");
        warn(`Not saved: ${err.message}`, { retry: () => openPage("files"), label: "Open Downloads" });
    } finally {
        try { stage?.tunnel?.close(); } catch { /* closed */ }
        downloads.delete(job);
        button.remove();
        rememberDownloads();
    }
}

if (pages.some(p => p.id === "files")) {
    try {
        for (const job of JSON.parse(sessionStorage.getItem(downloadKey) || "[]")) {
            if (!/^[0-9a-f]{16}$/.test(job?.id) || typeof job.label !== "string") continue;
            // (What it saves, as kept: an http(s) address, a stream or not.)
            job.url = typeof job.url === "string" && /^https?:\/\//i.test(job.url) && job.url.length <= 8192 ? job.url : null;
            job.stream = job.stream === true;
            saveFile(null, null, false, job);
        }
    } catch { /* nothing to resume */ }
}

// --- Controls ---------------------------------------------------------

// Keep the URL on focus, selected so typing or pasting replaces it. A
// second click or an arrow key places the caret for editing instead.
let selectAddressOnClick = false;
address.addEventListener("pointerdown", () => {
    selectAddressOnClick = document.activeElement !== address;
});
address.addEventListener("focus", () => {
    editAddress();
    address.select();
    addressButtons();
});
address.addEventListener("input", addressButtons);
$("go_clear").addEventListener("pointerdown", (e) => e.preventDefault());  // the address keeps the focus
$("go_clear").addEventListener("click", () => {
    address.value = "";
    address.focus();
    addressButtons();
});
address.addEventListener("click", () => {
    // The focusing click may collapse the selection made by focus.
    if (selectAddressOnClick) address.select();
    selectAddressOnClick = false;
});
address.addEventListener("blur", () => {
    selectAddressOnClick = false;
    // What was typed and not sent goes, as a browser's bar has it.
    setTimeout(() => { if (document.activeElement !== address) update(); });
});

$("go_address").addEventListener("submit", (e) => {
    e.preventDefault();
    const url = target(address.value);
    if (url) {
        address.blur();
        load(url);
    }
});
back.addEventListener("click", () => held || (at > 0 ? goBy(-1) : showHistory(back, -1)));
forward.addEventListener("click", () => held || goBy(1));

// Back (or forward) held, or its context menu (a right click): the pages
// that way, the nearest first, to go to one, as a browser's own do.
const historyPanel = $("go_history");
let held = false, holdTimer = 0;
function showHistory(button, way) {
    const pages = [];
    for (let i = at + way; i >= 0 && i < entries.length && pages.length < 20; i += way) pages.push(i);
    if (!pages.length && entries.length <= 1) return;
    historyPanel.replaceChildren(...pages.map((i) => {
        const b = Object.assign(document.createElement("button"), { type: "button", className: "item" });
        b.setAttribute("role", "menuitem");
        b.append(Object.assign(document.createElement("span"), { className: "title", textContent: entries[i].title || hostOf(entries[i].url) }),
            Object.assign(document.createElement("span"), { className: "where", textContent: hostOf(entries[i].url).replace(/^www\./, "") }));
        b.title = entries[i].url;
        b.addEventListener("click", () => {
            openHistory(null);
            goBy(i - at);
        });
        return b;
    }));
    // At its foot, as glyphs side by side: Back, Forward, and Clear
    // history (this tab's pages back and forward forgotten, the one it's on
    // kept).
    const foot = Object.assign(document.createElement("div"), { className: "foot" });
    const footGlyph = (name, label, act, disabled) => {
        const b = Object.assign(document.createElement("button"), { type: "button", className: `glyph ${name}`, title: label, disabled });
        b.setAttribute("role", "menuitem");
        b.setAttribute("aria-label", label);
        b.innerHTML = icon(name);
        b.addEventListener("click", () => { openHistory(null); act(); });
        return b;
    };
    foot.append(footGlyph("back", "Back: a page back", () => goBy(-1), at <= 0),
        footGlyph("forward", "Forward: a page on", () => goBy(1), at >= entries.length - 1),
        footGlyph("clear", "Clear history: forget this tab's pages back and forward", () => clearHistory(), entries.length <= 1));
    historyPanel.append(foot);
    historyPanel.setAttribute("aria-label", way < 0 ? "Pages back" : "Pages forward");
    historyPanel.style.left = Math.max(4, Math.round(button.getBoundingClientRect().left)) + "px";
    openHistory(button);
}
// clearHistory forgets the tab's pages but the one it's on: Back and
// Forward have none, nor has a reload. (The browser's own history keeps
// its entries for this page, which go nowhere now.)
function clearHistory() {
    if (at < 0) return;
    entries = [entries[at]];
    at = 0;
    if (inTabs) toTabs({ type: "history", at: 0, cleared: true });
    else try { history.replaceState({ goAt: 0 }, ""); } catch { /* as it is */ }
    update();
    note("History cleared: this tab's pages back and forward are forgotten.");
}
let historyFrom = null;
function openHistory(button) {
    historyFrom?.setAttribute("aria-expanded", "false");
    historyFrom = button;
    historyPanel.hidden = !button;
    if (button) {
        openMenu(false);
        button.setAttribute("aria-expanded", "true");
        historyPanel.querySelector("button:not(:disabled)")?.focus();
    }
}
for (const [button, way] of [[back, -1], [forward, 1]]) {
    button.setAttribute("aria-haspopup", "true");
    button.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        held = false;
        clearTimeout(holdTimer);
        holdTimer = setTimeout(() => {
            held = true;  // its click, as it's let go, isn't a step
            navigator.vibrate?.(10);
            showHistory(button, way);
        }, 500);
    });
    // Let go: held, its click (as it's let go, in the same task) isn't a
    // step; then not held (a touch held has no click after it, and the next
    // press, a key's, is a step).
    const letGo = () => {
        clearTimeout(holdTimer);
        if (held) setTimeout(() => (held = false));
    };
    button.addEventListener("pointerup", letGo);
    button.addEventListener("pointerleave", letGo);
    button.addEventListener("pointercancel", letGo);
    // A held touch's own menu (or a right click): the list instead.
    button.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (historyPanel.hidden || historyFrom !== button) showHistory(button, way);
    });
    // A press that isn't held: a step again.
    button.addEventListener("click", () => setTimeout(() => (held = false)), true);
}
document.addEventListener("pointerdown", (e) => {
    if (!historyPanel.hidden && !historyPanel.contains(e.target) && e.target !== historyFrom) openHistory(null);
}, true);
window.addEventListener("blur", () => openHistory(null));
historyPanel.addEventListener("keydown", (e) => {
    const items = [...historyPanel.querySelectorAll("button:not(:disabled)")], i = items.indexOf(document.activeElement);
    if (e.key === "Escape") {
        const from = historyFrom;
        openHistory(null);
        from?.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
    }
});
reload.addEventListener("click", () => (loading ? stop() : at >= 0 && load(entries[at].url, { push: false })));
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.activeElement === address) {
        address.value = entries[at]?.url || "";
        address.blur();
    }
    if (e.key === "Escape" && !menuPanel.hidden) openMenu(false);
    if (e.key === "Escape" && !e.defaultPrevented && screenMode === "full" && !document.fullscreenElement && !$("go_dialog").open) leaveFullScreen();
    if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); back.click(); }
    if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); forward.click(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") { e.preventDefault(); address.focus(); address.select(); }
});

// What the tabs' page says to this tab: go to one of its pages (the
// device's back), load what a page opened (a new tab's first), an address
// a link gave (waiting for Enter), how many tabs there are.
window.addEventListener("message", (e) => {
    if (!inTabs || e.source !== parent || e.origin !== location.origin || e.data?.goTabs !== true) return;
    const m = e.data;
    const web = typeof m.url === "string" && /^https?:\/\//i.test(m.url) && m.url.length <= 8192;
    switch (m.type) {
        case "go":
            if (Number.isSafeInteger(m.at) && m.at >= 0 && m.at < entries.length && m.at !== at) {
                at = m.at;
                load(entries[at].url, { push: false });
            }
            break;
        case "open":
            if (web) load(m.url);
            break;
        case "linked": {
            const url = typeof m.text === "string" && m.text.length <= 8192 ? target(m.text) : null;
            if (url) {
                address.value = url;
                show("Press Enter to load this address.");
                address.focus();
            }
            break;
        }
        case "close":
            // Closed by the person: not kept on the server either.
            resumeToken.set("");
            closing = true;
            ws?.send(JSON.stringify({ op: "close" }));
            break;
        case "count":
            tabsCompact = !!m.compact;
            if (Number.isSafeInteger(m.count)) tabsCount = m.count;
            updateTabsButton();
            break;
        case "window-list":
            if (screenMode === "browser" && Array.isArray(m.tabs)) showWindowList(m.tabs);
            break;
        case "window-list-close":
            hideWindowList();
            break;
        case "focus":
            if (at < 0) address.focus();
            break;
    }
});
$("go_tabs").addEventListener("click", () => toTabs({ type: "show", fullscreen: screenMode === "browser" }));

// Start where this tab was (a reload: see update), or where a link to
// /go/#<address> says. The address after # is taken out of the tab's
// address at once, so the browser's history keeps /go/ only.
const linked = location.hash.slice(1);
if (linked) history.replaceState(null, "", location.pathname + location.search);
let first = null;
if (linked) {
    let typed = linked;
    try { typed = /^https?:/i.test(linked) ? linked : decodeURIComponent(linked); } catch { /* as it is */ }
    first = target(typed);
    // An address in a link only loads at once if it's where this tab was
    // (a reload of a page from before this change): a link from elsewhere
    // could have the server load anything it may reach, private networks
    // too with WEB_GO_PRIVATE, so it waits in the address bar for Enter.
    let ours = false;
    try { ours = !!first && sessionStorage.getItem(KEPT) === first; } catch { /* not kept */ }
    if (first && !ours) {
        address.value = first;
        show("Press Enter to load this address.");
        first = null;
    }
} else {
    try { first = sessionStorage.getItem(KEPT); } catch { /* not kept */ }
    if (first && !/^https?:\/\//i.test(first)) first = null;
    // Its pages back and forward too, if they're this one's.
    try {
        const kept = JSON.parse(sessionStorage.getItem(KEPT_HISTORY) || "null");
        const list = Array.isArray(kept?.entries) ? kept.entries.filter((e) => typeof e?.url === "string" && /^https?:\/\//i.test(e.url)).slice(-50) : [];
        if (first && Number.isSafeInteger(kept?.at) && list[kept.at]?.url === first) {
            entries = list.map((e) => ({ url: e.url, title: typeof e.title === "string" ? e.title : "" }));
            at = kept.at;
        }
    } catch { /* not kept */ }
}
// Connected at once, as the terminal is: the login form shows now if
// there's no session, and the engine is ready before the first address.
if (first && entries[at]?.url === first) {
    load(first, { push: false });
} else if (first) {
    load(first);
} else {
    update();
    showRecent();
    address.focus();
    connecting ??= connect().then((ok) => ok || reconnect("Can't reach the server.", connect)).finally(() => (connecting = null));
}
