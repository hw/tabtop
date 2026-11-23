// The remote browser's tabs, at go/: each a frame of go/tab?id=N (go.js),
// with a browsing context, a tunnel and an engine of its own. This page has
// the strip of tabs (a wide screen) or the list of them (a phone: the tab's
// own bar has a button for it), the history (the device's back goes to the
// page before in the tab shown: each tab says where it is, and its entries
// here say which tab and page), and the tabs to open again after a reload
// (sessionStorage: this browser tab's own).
//
// A tab may be private (goincognito.go): its sites' cookies and storage
// kept apart on the server, in memory, and forgotten with the session's
// last private tab; nothing of it kept on this device (its recent sites,
// its title in the device's history). Which tabs are is said to each by
// sessionStorage (tabtop-go-private:N), never in its frame's address.
//
// A window a page opens comes here (go.js's "popup") and opens in a tab of
// its own (private, if the page's was), or, with as many tabs as may be, in
// the one that opened it. An
// address never goes into a frame's address (go/tab?id=N only), the tab's
// own, or the history: it's handed over by message.

import { session } from "../tabtop/tunnel.js";
import { nameTab } from "../tabtop/nav.js";

const MAX_TABS = 6;  // the server's engines for a session (maxGoPerSession)
const KEPT = "tabtop-go-tabs";

nameTab("go");

const $ = (id) => document.getElementById(id);
const strip = $("tabs"), frames = $("frames"), overview = $("overview");
const compact = matchMedia("(pointer: coarse), (max-width: 600px)");

let tabs = [];    // {id, title, loading, at, private, frame, el}
let shown = null; // the tab shown
let next = 1;

const tabOf = (id) => tabs.find((t) => t.id === id);
function tell(t, m) {
    t.frame.contentWindow?.postMessage({ ...m, goTabs: true }, location.origin);
}

function keep() {
    try {
        sessionStorage.setItem(KEPT, JSON.stringify({ ids: tabs.map((t) => t.id), private: tabs.filter((t) => t.private).map((t) => t.id), shown: shown?.id ?? null, next }));
    } catch { /* not kept */ }
}

// open makes a tab: a frame of go/tab with its number, told what to load
// (a window a page opened) once it's there; private, told so before it
// starts.
function open({ id = next++, url = "", show = true, private: priv = false } = {}) {
    if (tabs.length >= MAX_TABS) return null;
    next = Math.max(next, id + 1);
    try {
        if (priv) sessionStorage.setItem(`tabtop-go-private:${id}`, "1");
        else sessionStorage.removeItem(`tabtop-go-private:${id}`);
    } catch {
        if (priv) return null;  // it couldn't be told: not opened as a tab that isn't
    }
    const frame = document.createElement("iframe");
    const title = priv ? "Private tab" : "New tab";
    frame.title = title;
    frame.allow = "autoplay; fullscreen; clipboard-write";
    frame.hidden = true;
    const t = { id, title, loading: false, at: -1, private: priv, frame };
    frame.addEventListener("load", () => {
        tell(t, { type: "count", count: tabs.length, compact: compact.matches });
        if (url) tell(t, { type: "open", url });
        url = "";
        if (shown === t) tell(t, { type: "focus" });
    });
    frame.src = `tab?id=${id}`;
    frames.append(frame);
    tabs.push(t);
    drawTab(t);
    if (show || !shown) showTab(t);
    counted();
    keep();
    return t;
}

function close(t) {
    const i = tabs.indexOf(t);
    if (i < 0) return;
    tabs.splice(i, 1);
    // Its engine closed at once, not kept for a connection to come back
    // (goresume.go): told first, then its frame (and tunnel) goes.
    tell(t, { type: "close" });
    t.frame.hidden = true;
    setTimeout(() => t.frame.remove(), 300);
    t.el.remove();
    try {
        sessionStorage.removeItem(`tabtop-go-kept:${t.id}`);
        sessionStorage.removeItem(`tabtop-go-history:${t.id}`);
        sessionStorage.removeItem(`tabtop-go-resume:${t.id}`);
        sessionStorage.removeItem(`tabtop-go-desktop:${t.id}`);
        sessionStorage.removeItem(`tabtop-go-private:${t.id}`);
    } catch { /* none */ }
    if (!tabs.length) open();
    else if (shown === t) showTab(tabs[Math.min(i, tabs.length - 1)]);
    counted();
    drawOverview();
    keep();
}

function showTab(t) {
    shown = t;
    for (const x of tabs) {
        x.frame.hidden = x !== t;
        x.el.setAttribute("aria-selected", String(x === t));
        x.el.tabIndex = x === t ? 0 : -1;
    }
    document.title = docTitle(t);
    t.el.scrollIntoView({ block: "nearest", inline: "nearest" });
    tell(t, { type: "focus" });
    t.frame.focus();
    keep();
}

// docTitle is this page's title for the tab shown: a private tab's page
// isn't named, as the device's history keeps the title.
const docTitle = (t) => t.private ? "Private – Browser" : `${t.title} – Browser`;

// The mark of a private tab: a hat and glasses, incognito (drawn, not a
// character; go.js's the same).
const PRIVATE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 11h18"/><path d="M6 11l1.6-6.3a1 1 0 0 1 1.3-.7L12 5.2l3.1-1.2a1 1 0 0 1 1.3.7L18 11"/><circle cx="7.5" cy="16.5" r="3"/><circle cx="16.5" cy="16.5" r="3"/><path d="M10.5 16.5c1-.8 2-.8 3 0"/></svg>';

function drawTab(t) {
    const el = document.createElement("div");
    el.className = "tab";
    el.classList.toggle("private", t.private);
    el.setAttribute("role", "tab");
    const title = Object.assign(document.createElement("span"), { className: "title", textContent: t.title });
    if (t.private) {
        const mark = Object.assign(document.createElement("span"), { className: "mark", innerHTML: PRIVATE_ICON, title: "Private tab" });
        mark.setAttribute("role", "img");
        mark.setAttribute("aria-label", "Private");
        el.append(mark);
    }
    const x = Object.assign(document.createElement("button"), { type: "button", className: "close", textContent: "✕", tabIndex: -1 });
    x.setAttribute("aria-label", "Close tab");
    x.addEventListener("click", (e) => { e.stopPropagation(); close(t); });
    el.append(title, x);
    el.addEventListener("click", () => showTab(t));
    el.addEventListener("auxclick", (e) => { if (e.button === 1) close(t); });  // the middle button
    el.addEventListener("keydown", (e) => {
        const i = tabs.indexOf(t);
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
            const to = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
            showTab(to);
            to.el.focus();
        } else if (e.key === "Delete") {
            close(t);
        }
    });
    t.el = el;
    t.titleEl = title;
    strip.append(el);
}

function titled(t) {
    t.titleEl.textContent = t.title;
    t.el.title = t.private ? `${t.title} (private)` : t.title;
    t.el.classList.toggle("loading", t.loading);
    t.frame.title = t.title;
    if (shown === t) document.title = docTitle(t);
    drawOverview();
}

// counted tells each tab how many there are (its button for the list, on
// a phone), and the new tab buttons whether there's room for one.
function counted() {
    for (const t of tabs) tell(t, { type: "count", count: tabs.length, compact: compact.matches });
    const full = tabs.length >= MAX_TABS;
    $("new").disabled = $("new_private").disabled = overview.querySelector(".new").disabled = overview.querySelector(".new-private").disabled = full;
    $("new").title = full ? `At most ${MAX_TABS} tabs` : "New tab";
    $("new_private").title = full ? `At most ${MAX_TABS} tabs` : "New private tab: sites' cookies and data forgotten when the last private tab closes";
}
compact.addEventListener("change", () => {
    document.body.classList.toggle("compact", compact.matches);
    counted();
});
document.body.classList.toggle("compact", compact.matches);

// --- The list of tabs (a phone) ---------------------------------------------

function drawOverview() {
    if (overview.hidden) return;
    overview.querySelector("ul").replaceChildren(...tabs.map((t) => {
        const li = document.createElement("li");
        li.classList.toggle("shown", t === shown);
        li.classList.toggle("private", t.private);
        const pick = Object.assign(document.createElement("button"), { type: "button", className: "pick", textContent: t.title });
        if (t.private) {
            pick.insertAdjacentHTML("afterbegin", PRIVATE_ICON);
            pick.setAttribute("aria-label", `${t.title} (private)`);
        }
        pick.addEventListener("click", () => { showTab(t); overview.hidden = true; });
        const x = Object.assign(document.createElement("button"), { type: "button", className: "close", textContent: "✕" });
        x.setAttribute("aria-label", `Close ${t.title}`);
        x.addEventListener("click", () => close(t));
        li.append(pick, x);
        return li;
    }));
}
function showOverview() {
    overview.hidden = false;
    drawOverview();
    overview.querySelector(".done").focus();
}
overview.querySelector(".done").addEventListener("click", () => {
    overview.hidden = true;
    shown?.frame.focus();
});
overview.querySelector(".new").addEventListener("click", () => {
    overview.hidden = true;
    open();
});
overview.querySelector(".new-private").addEventListener("click", () => {
    overview.hidden = true;
    open({ private: true });
});
$("new_private").innerHTML = PRIVATE_ICON;
$("new_private").addEventListener("click", () => open({ private: true }));
overview.addEventListener("keydown", (e) => { if (e.key === "Escape") overview.querySelector(".done").click(); });
$("new").addEventListener("click", () => open());

// --- The history ---------------------------------------------------------------
//
// Each page a tab shows is an entry here ({goTab, at}: no address), so the
// device's back goes back a page, in the tab it was in.

window.addEventListener("popstate", (e) => {
    const t = tabOf(e.state?.goTab);
    if (!t || !Number.isSafeInteger(e.state.at)) return;
    if (t !== shown) showTab(t);
    t.at = e.state.at;
    tell(t, { type: "go", at: e.state.at });
});

window.addEventListener("message", (e) => {
    if (e.origin !== location.origin || !e.data || typeof e.data !== "object") return;
    const t = tabs.find((x) => x.frame.contentWindow === e.source);
    if (!t) return;
    const m = e.data;
    switch (m.type) {
        case "state":
            t.title = typeof m.title === "string" && m.title.trim() ? m.title.slice(0, 200) : "New tab";
            t.loading = !!m.loading;
            titled(t);
            break;
        case "history":
            if (!Number.isSafeInteger(m.at)) break;
            t.at = m.at;
            if (t !== shown) break;  // (a tab not shown going on: not the device's back's)
            try {
                const state = { goTab: t.id, at: m.at };
                if (history.state?.goTab === t.id && m.at === 0 || !history.state) history.replaceState(state, "");
                else history.pushState(state, "");
            } catch { /* the bar's buttons still go back */ }
            break;
        case "step":
            // Back or forward a page, or more: by the history, if it's where it is;
            // else in the tab alone.
            // (More than one: a page picked from its list.)
            if (!Number.isSafeInteger(m.step) || !m.step || Math.abs(m.step) > 50 || !Number.isSafeInteger(m.at)) break;
            if (history.state?.goTab === t.id && history.state.at === m.at) history.go(m.step);
            else tell(t, { type: "go", at: m.at + m.step });
            break;
        case "popup":
            if (typeof m.url !== "string" || !/^https?:\/\//i.test(m.url) || m.url.length > 8192) break;
            if (!open({ url: m.url, private: t.private })) tell(t, { type: "open", url: m.url });  // no room: in the tab that opened it
            break;
        case "new-tab":
            // From the tab's menu: a tab, private or not, shown.
            open({ private: m.private === true });
            break;
        case "show":
            if (m.fullscreen) tell(t, { type: "window-list", tabs: tabs.map((x) => ({ id: x.id, title: x.title, current: x === shown })) });
            else showOverview();
            break;
        case "select-window": {
            const picked = tabOf(m.id);
            if (picked) {
                showTab(picked);
                tell(t, { type: "window-list-close" });
            }
            break;
        }
        case "close-window": {
            const picked = tabOf(m.id);
            if (picked) close(picked);
            if (shown) tell(t, { type: "window-list", tabs: tabs.map((x) => ({ id: x.id, title: x.title, current: x === shown })) });
            break;
        }
    }
});

// --- Starting --------------------------------------------------------------

// Logged in here, once, before the tabs ask (each would show the form).
await session("Browser");

// A link to /go/#<address>: out of this page's address at once, and given
// to the first tab, where it waits for Enter (go.js).
const linked = location.hash.slice(1);
if (linked) history.replaceState(null, "", location.pathname + location.search);

let kept = null;
try { kept = JSON.parse(sessionStorage.getItem(KEPT) || "null"); } catch { /* none */ }
const ids = Array.isArray(kept?.ids) ? kept.ids.filter((id) => Number.isSafeInteger(id) && id > 0).slice(0, MAX_TABS) : [];
next = Number.isSafeInteger(kept?.next) ? kept.next : 1;
const privateIds = new Set(Array.isArray(kept?.private) ? kept.private : []);
for (const id of ids) open({ id, show: false, private: privateIds.has(id) });
if (!tabs.length) open();
showTab(tabOf(kept?.shown) ?? tabs[0]);
if (linked) {
    let typed = linked;
    try { typed = decodeURIComponent(linked); } catch { /* as it is */ }
    const t = shown;
    t.frame.addEventListener("load", () => tell(t, { type: "linked", text: typed }), { once: true });
}
