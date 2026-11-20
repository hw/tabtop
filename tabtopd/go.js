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
// The address bar takes an address, or words to search for (with
// DuckDuckGo). Back, forward and reload are this page's: each loads an
// address again in the engine. The address shown is kept in this page's
// own address, after #, so reloading the tab carries on where it was. If
// the connection is lost, the page tries again by itself (see
// reconnect.js), with a new engine, loading the page that was shown.

import { navBar, nameTab, pages, openPage } from "../tabtop/nav.js";
import { forgetSession, storedSession, TunnelSocket } from "../tabtop/tunnel.js";
import { reconnect } from "../tabtop/reconnect.js";
import { warnExpiry } from "../tabtop/expiry.js";
import { call, collect, setLoginTitle } from "../tabtop/requests.js";
import { goMedia } from "./go-media.js";

const SEARCH = "https://html.duckduckgo.com/html/?q=";
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
// The address this tab last showed, kept for its reloads (sessionStorage).
const KEPT = "tabtop-go-kept" + (tabId ? ":" + tabId : "");
// Its pages back and forward, likewise (the tab's own history has an entry
// for each, on this page's address, which says which: see remember).
const KEPT_HISTORY = "tabtop-go-history" + (tabId ? ":" + tabId : "");
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
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    sites: '<circle cx="12" cy="12" r="8"/><circle cx="9.5" cy="10" r="1"/><circle cx="14.5" cy="13.5" r="1"/><circle cx="10.5" cy="15" r="1"/>',
    settings: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
back.innerHTML = icon("back");
forward.innerHTML = icon("forward");
$("go_clear").innerHTML = icon("clear");

// The menu, at the end of the bar: forward, then the other pages and
// logging out (the bar of links the other pages have at the top, here in
// the menu to leave the page the room).
const menu = $("go_menu"), menuPanel = $("go_menu_panel"), menuForward = $("go_menu_forward");
menu.innerHTML = icon("menu");
menuForward.innerHTML = `${icon("forward")}<span class="label">Forward</span>`;
// Cookies and site data: a page of its own (go/cookie, go-cookies.js),
// in a tab of its own, this one's page kept.
$("go_menu_sites").innerHTML = `${icon("sites")}<span class="label">Cookies and site data</span>`;
// Site settings: sites blocked, pop-ups (go/settings, go-settings.js).
$("go_menu_settings").innerHTML = `${icon("settings")}<span class="label">Site settings</span>`;
const nav = navBar("go", { logOutIcon: true });
for (const item of nav.children) {
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = (item.title || "").replace(/ \(.*$/, "");
    item.append(label);
}
menuPanel.append(nav);
// The session's warning, which goes in that bar: shown below this one.
new MutationObserver(() => {
    const warning = nav.querySelector("#tabtop_expiry");
    if (warning) document.body.append(warning);
}).observe(nav, { childList: true });
function openMenu(open) {
    menuPanel.hidden = !open;
    menu.setAttribute("aria-expanded", String(open));
    if (open) (menuPanel.querySelector("button:not(:disabled), a:not([hidden])") ?? menuPanel).focus();
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
// The page's players, laid over the copy's boxes (go-media.js): their
// posters fetched as the page's pictures are; a video's proportions told to
// its box.
let media = null;
const mediaHelp = {
    picture: (url) => cachedResource("image", url),
    // A part of a player's file, over the tab's tunnel if it's open (null
    // if not: the player asks on a tunnel of its own).
    range: (url, part) => (ws?.readyState === TunnelSocket.OPEN ? mediaViaTab(ws, url, part) : null),
    sized: (key, ratio, meta) => frame.contentWindow?.postMessage({ type: "media-state", key, ratio, meta }, "*"),
    played: (key, play) => frame.contentWindow?.postMessage({ type: "media-state", key, play }, "*"),
    // Scrolling done over a player (go-media.js), for the frame to do in
    // the page under it: where (in the frame) and by how much.
    passOn: (x, y, dx, dy, how) => {
        const f = frame.getBoundingClientRect();
        frame.contentWindow?.postMessage({ type: "media-scroll", x: x - f.left, y: y - f.top, dx, dy, how }, "*");
    },
    failed: (key, error) => frame.contentWindow?.postMessage({ type: "media-state", key, error }, "*"),
};
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
media = goMedia(frame, mediaHelp);

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
// with https://, or words searched for.
function target(text) {
    const s = text.trim();
    if (!s) return null;
    if (/^https?:\/\//i.test(s)) return s;
    if (!/\s/.test(s) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(s) || /^localhost(:\d+)?(\/|$)/i.test(s)) return "https://" + s;
    return SEARCH + encodeURIComponent(s);
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
    back.disabled = at <= 0;
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
        text = url.startsWith(SEARCH) ? u.searchParams.get("q") || u.host : (insecure ? "http://" : "") + u.host.replace(/^www\./, "");
    } catch { /* as it is */ }
    address.value = text;
    address.dataset.url = url;
    address.title = url;
    address.classList.add("site");
    address.classList.toggle("insecure", insecure);
}
function editAddress() {
    const entry = entries[at];
    if (address.classList.contains("site")) {
        address.classList.remove("site", "insecure");
        if (entry) address.value = entry.url;
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
        if (url.startsWith(SEARCH) || !/^https?:$/.test(u.protocol)) return;
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
        touch: navigator.maxTouchPoints > 0,
        // Which way up the device is held: the page's screen.orientation and
        // (orientation: …) media queries follow it. Where the device doesn't
        // say, the window's shape.
        ...orientation(),
    };
}
function orientation() {
    const o = screen.orientation;
    if (o && /^(portrait|landscape)-(primary|secondary)$/.test(o.type)) return { o: o.type, a: Math.round(o.angle) || 0 };
    const portrait = window.innerHeight >= window.innerWidth;
    return { o: portrait ? "portrait-primary" : "landscape-primary", a: portrait ? 0 : 90 };
}
const sameView = (a, b) => !!a && !!b && ["w", "h", "dpr", "sw", "sh", "touch", "o", "a"].every((k) => a[k] === b[k]);
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
function connect() {
    return new Promise((resolve) => {
        const s = new TunnelSocket({ type: "go", deflate: canInflate }, { title: "Browser" });
        show("Connecting to TabTop…");
        $("go_progress").hidden = false;
        s.onopen = () => {
            ws = s;
            gen = shown = 0;
            show("");
            $("go_progress").hidden = true;
            if (at >= 0) load(entries[at].url, { push: false });
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
            if (m.type === "go-res") {
                resHeader(m);  // of any page: not a generation's
                return;
            }
            if (ws !== s || !Number.isSafeInteger(m.gen) || m.gen < gen) return;  // an older page's
            gen = m.gen;
            message(m);
        };
        s.onclose = (e) => {
            resLost(s);
            const was = ws === s;
            ws = null;
            loading = rendering = false;
            closeDialog();
            update();
            if (e.login) {
                forgetSession(s.session);
                storedSession() ? connect().then((ok) => ok || reconnect("Can't reach the server.", connect)) : location.reload();
            } else if (e.lost) {
                if (was) reconnect("Connection lost. Reconnecting will reload this page; unsaved input may be lost.", connect);
            } else {
                show("");
                warn(`${e.reason || "The browser’s engine was closed."} Reconnecting will reload the page; unsaved input may be lost.`, { retry: () => connect(), label: "Reconnect", edit: at >= 0 });
            }
            resolve(!e.lost);
        };
    });
}

function message(m) {
    switch (m.type) {
        case "go-loading":
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
                media = goMedia(frame, mediaHelp);
            }
            shown = m.gen;
            lastRender = { type: "render", gen: m.gen, url: m.url, base: m.base, doc: m.doc, again: !!m.again, io: m.io };
            toFrame(lastRender);
            update();
            break;
        }
        case "go-changes":
            if (m.gen === shown) media.streams(m.streams);
            if (m.gen === shown) toFrame({ type: "changes", gen: m.gen, ops: m.ops, title: m.title, io: m.io, scrolls: m.scrolls });
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
            note(m.why === "blocked" ? "A pop-up to a blocked site wasn't opened." : `A pop-up from ${m.site || "this site"} was blocked (☰ → Site settings).`);
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
function cachedResource(kind, url) {
    const key = kind + " " + url;
    let got = cache.get(key);
    if (got) {
        cache.delete(key);
        cache.set(key, got);  // most recently used last
        return got;
    }
    got = fetchResource(kind, url).then((blob) => {
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
                    if (got && owner === media) frame.contentWindow?.postMessage({ type: "media-state", key: m.key, error: got.error ?? "" }, "*");
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
async function saveFile(url) {
    show(`Saving ${hostOf(url)}’s file into Downloads…`);
    let t;
    try {
        t = await call({ type: "fetch", path: "", url, from_go: true });
        for (;;) {
            const m = await t.next();
            if (!m) throw new Error("the connection was lost; see the files page");
            if (m.text === undefined) continue;
            const res = JSON.parse(m.text);
            if (res.error) throw new Error(res.error);
            if (res.fetch && !res.fetch.done) {
                const { got, total, name } = res.fetch;
                const amount = Number.isFinite(got) && got >= 0 ? `${(got / 1048576).toFixed(1)} MB` : "";
                const progress = Number.isFinite(total) && total > 0 && amount
                    ? `${Math.min(100, Math.floor(got / total * 100))}% · ${amount}` : amount;
                show(`Saving ${name || "file"} from ${hostOf(url)}${progress ? ` · ${progress}` : ""}…`);
            }
            if (res.fetch?.done) {
                show("");
                warn(`Saved ${res.fetch.name} into Downloads.`, { error: false, retry: () => openPage("files"), label: "Open Downloads" });
                return;
            }
        }
    } catch (err) {
        show("");
        warn(`Not saved: ${err.message}`, { retry: () => saveFile(url), label: "Retry save" });
    } finally {
        t?.close();
    }
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
back.addEventListener("click", () => held || goBy(-1));
forward.addEventListener("click", () => held || goBy(1));

// Back (or forward) held, or its context menu (a right click): the pages
// that way, the nearest first, to go to one, as a browser's own do.
const historyPanel = $("go_history");
let held = false, holdTimer = 0;
function showHistory(button, way) {
    const pages = [];
    for (let i = at + way; i >= 0 && i < entries.length && pages.length < 20; i += way) pages.push(i);
    if (!pages.length) return;
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
    historyPanel.setAttribute("aria-label", way < 0 ? "Pages back" : "Pages forward");
    historyPanel.style.left = Math.max(4, Math.round(button.getBoundingClientRect().left)) + "px";
    openHistory(button);
}
let historyFrom = null;
function openHistory(button) {
    historyFrom?.setAttribute("aria-expanded", "false");
    historyFrom = button;
    historyPanel.hidden = !button;
    if (button) {
        openMenu(false);
        button.setAttribute("aria-expanded", "true");
        historyPanel.querySelector("button")?.focus();
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
    const letGo = () => clearTimeout(holdTimer);
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
    const items = [...historyPanel.querySelectorAll("button")], i = items.indexOf(document.activeElement);
    if (e.key === "Escape") {
        const from = historyFrom;
        openHistory(null);
        from?.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
    }
});
menuForward.addEventListener("click", () => goBy(1));
reload.addEventListener("click", () => (loading ? stop() : at >= 0 && load(entries[at].url, { push: false })));
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.activeElement === address) {
        address.value = entries[at]?.url || "";
        address.blur();
    }
    if (e.key === "Escape" && !menuPanel.hidden) openMenu(false);
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
        case "count":
            $("go_tabs").hidden = !m.compact;
            $("go_tabs").querySelector(".count").textContent = String(m.count);
            $("go_tabs").setAttribute("aria-label", `Tabs: ${m.count} open`);
            break;
        case "focus":
            if (at < 0) address.focus();
            break;
    }
});
$("go_tabs").addEventListener("click", () => toTabs({ type: "show" }));

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
    connecting = connect().then((ok) => ok || reconnect("Can't reach the server.", connect)).finally(() => (connecting = null));
}
