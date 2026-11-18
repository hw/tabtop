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

const SEARCH = "https://html.duckduckgo.com/html/?q=";
// The address this tab last showed, kept for its reloads (sessionStorage).
const KEPT = "tabtop-go-kept";
// What the frame may have fetched for one page, in all.
const PAGE_BUDGET = 128 << 20;
const RESOURCE_LIMITS = { image: 10 << 20, css: 4 << 20, font: 8 << 20 };

nameTab("go");
setLoginTitle("Browser");
document.body.prepend(navBar("go", { logOutIcon: true }));
warnExpiry();

const $ = (id) => document.getElementById(id);
const back = $("go_back"), forward = $("go_forward"), reload = $("go_reload");
const address = $("go_url"), status = $("go_status"), notice = $("go_notice"), start = $("go_start");

// The frame: sandboxed with scripts only, its document from the server,
// with a CSP that lets it load nothing from the web (see gopage.go).
const frame = document.createElement("iframe");
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

function update() {
    $("go_progress").hidden = !(loading || rendering);
    frame.setAttribute("aria-busy", String(loading || rendering));
    back.disabled = at <= 0;
    forward.disabled = at >= entries.length - 1;
    reload.disabled = at < 0;
    reload.textContent = loading ? "✕" : "⟳";
    reload.title = loading ? "Stop" : "Reload";
    reload.setAttribute("aria-label", reload.title);
    const entry = entries[at];
    if (entry && document.activeElement !== address) address.value = entry.url;
    frame.title = entry ? entry.title || hostOf(entry.url) : "Page";
    document.title = entry ? `${entry.title || hostOf(entry.url)} – Browser` : "Browser";
    if (entry) {
        history.replaceState(null, "", "#" + entry.url);
        // So that reloading this tab carries on (see the start, below).
        try { sessionStorage.setItem(KEPT, entry.url); } catch { /* not kept */ }
    }
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
function view() {
    const r = frame.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), dpr: Math.round((window.devicePixelRatio || 1) * 100) / 100 };
}
let viewTimer = 0;
new ResizeObserver(() => {
    clearTimeout(viewTimer);
    viewTimer = setTimeout(() => {
        const v = view();
        if (!ws || !v.w || !v.h || (sentView && v.w === sentView.w && v.h === sentView.h && v.dpr === sentView.dpr)) return;
        sentView = v;
        ws.send(JSON.stringify({ op: "viewport", view: v }));
    }, 250);
}).observe(frame);
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
        const s = new TunnelSocket({ type: "go" }, { title: "Browser" });
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
        s.onmessage = (e) => {
            if (ws !== s) return;
            if (typeof e.data !== "string") {
                resData(e.data);  // a resource's bytes
                return;
            }
            let m;
            try { m = JSON.parse(e.data); } catch { return; }
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
            }
            loading = true;
            rendering = false;
            notice.hidden = true;
            closeDialog();
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
            }
            if (!m.again) spent = 0;
            show("Preparing images and styles…");
            shown = m.gen;
            lastRender = { type: "render", gen: m.gen, url: m.url, base: m.base, doc: m.doc, again: !!m.again, io: m.io };
            toFrame(lastRender);
            update();
            break;
        }
        case "go-changes":
            if (m.gen === shown) toFrame({ type: "changes", gen: m.gen, ops: m.ops, title: m.title, io: m.io });
            break;
        case "go-url":
            // The page changed its address itself (history.pushState, a
            // link within it): a new entry, as browsers make.
            if (typeof m.url === "string" && at >= 0 && m.url !== entries[at].url) {
                entries = entries.slice(0, at + 1);
                entries.push({ url: m.url, title: m.title || entries[at].title });
                at++;
                update();
            }
            break;
        case "go-dialog":
            openDialog(m);
            break;
        case "go-dialog-closed":
            closeDialog();
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
    if (spent + m.size > PAGE_BUDGET) return resFail(m.rid, "the page uses too much");
    spent += m.size;
    r.size = m.size;
    r.mime = r.kind === "css" ? "text/css" : typeof m.mime === "string" ? m.mime : "";
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
    if (r.got === r.size) {
        resWaiting.delete(rid);
        r.resolve(new Blob(r.parts, { type: r.mime }));
    }
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
                    location: num(m.location), repeat: !!m.repeat };
                ws.send(JSON.stringify({ op: "event", gen: m.gen, kind, id, value, checked, key, code, shift, ctrl, alt, meta, submitter, ...input }));
            }
            break;
        case "resync":
            if (ws && m.gen === shown) ws.send(JSON.stringify({ op: "resync", gen: m.gen }));
            break;
        case "io": {
            const rect = (r) => (Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) ? r : null);
            // What this browser saw of the elements the page observes: on to
            // the engine, in pieces well within a message's limit.
            if (ws && m.gen === shown && Array.isArray(m.entries)) {
                const entries = m.entries.filter((e) => e && Number.isSafeInteger(e.o) && Number.isSafeInteger(e.i))
                    .map((e) => ({ o: e.o, i: e.i, hit: !!e.hit, ratio: Number(e.ratio) || 0, b: rect(e.b), r: rect(e.r), rb: rect(e.rb) }));
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
    const input = dialog.querySelector("input");
    input.hidden = kind !== "prompt";
    input.value = typeof m.default === "string" ? m.default : "";
    dialog.querySelector(".cancel").hidden = kind === "alert";
    if (!dialog.open) dialog.showModal();
    (kind === "prompt" ? input : dialog.querySelector(".ok")).focus();
}
function closeDialog() {
    if (dialog.open) dialog.close();
}
function answerDialog(accept) {
    const input = dialog.querySelector("input");
    ws?.send(JSON.stringify({ op: "dialog", accept, text: input.hidden ? "" : input.value }));
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

$("go_address").addEventListener("submit", (e) => {
    e.preventDefault();
    const url = target(address.value);
    if (url) {
        address.blur();
        load(url);
    }
});
back.addEventListener("click", () => { if (at > 0) { at--; load(entries[at].url, { push: false }); } });
forward.addEventListener("click", () => { if (at < entries.length - 1) { at++; load(entries[at].url, { push: false }); } });
reload.addEventListener("click", () => (loading ? stop() : at >= 0 && load(entries[at].url, { push: false })));
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.activeElement === address) {
        address.value = entries[at]?.url || "";
        address.blur();
    }
    if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); back.click(); }
    if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); forward.click(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") { e.preventDefault(); address.focus(); address.select(); }
});

// Start where the tab's address says (after #), if anywhere: an address
// as it was kept there (see update), or one typed or linked to.
const kept = location.hash.slice(1);
let typed = kept;
try { typed = /^https?:/i.test(kept) ? kept : decodeURIComponent(kept); } catch { /* as it is */ }
let first = kept ? target(typed) : null;
// An address in the link only loads at once if this tab put it there (a
// reload): a link from elsewhere could have the server load anything it
// may reach, private networks too with WEB_GO_PRIVATE, so it waits in the
// address bar for Enter.
let ours = false;
try { ours = !!first && sessionStorage.getItem(KEPT) === first; } catch { /* not kept */ }
if (first && !ours) {
    address.value = first;
    show("Press Enter to load this address.");
    first = null;
}
// Connected at once, as the terminal is: the login form shows now if
// there's no session, and the engine is ready before the first address.
if (first) {
    load(first);
} else {
    update();
    address.focus();
    connecting = connect().then((ok) => ok || reconnect("Can't reach the server.", connect)).finally(() => (connecting = null));
}
