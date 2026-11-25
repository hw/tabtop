// The remote browser's end-to-end check, run by go-check.sh.
//
//   node go-check.mjs site DIR            writes the test site into DIR
//   node go-check.mjs check BASE PORT SITE checks /go at BASE with the
//                                         Chrome whose DevTools are on PORT,
//                                         browsing the test site at SITE
//
// Throughout, every request Chrome makes, from the page and from its frames,
// is recorded: none may go anywhere but the TabTop server.
import { writeFileSync } from "node:fs";
import { writeSite } from "./browser/go-site.mjs";
import { afterPaint, createBrowserHarness, sleep, totp } from "./browser/harness.mjs";
import { step } from "./browser/go/step.mjs";
import { pages } from "./browser/go/pages.mjs";
import { sites } from "./browser/go/sites.mjs";
import { input } from "./browser/go/input.mjs";
import { popupsStreams } from "./browser/go/popups-streams.mjs";
import { pointerWebgl } from "./browser/go/pointer-webgl.mjs";
import { video } from "./browser/go/video.mjs";
import { framesTabs } from "./browser/go/frames-tabs.mjs";
import { certsNet } from "./browser/go/certs-net.mjs";
import { webApis } from "./browser/go/web-apis.mjs";

const [mode, ...args] = process.argv.slice(2);

// --- The check --------------------------------------------------------

async function check(base, port, site, adSite) {
    const browser = await createBrowserHarness({ port, base });
    const { cdp, ev, waitFor, open, inFrame, exceptions } = browser;
    const frame = (expr) => inFrame("go-frame.html", expr);
    // frameClick clicks the element in the frame that sel finds, at its place
    // on the screen: a click the page sees as a person's.
    // The page held in view while the next is built takes nothing (see
    // render in go-frame.js): a click is for the page shown.
    const pageShown = () => waitFor(`document.getElementById("go_view").getAttribute("aria-busy") !== "true"`, "the page shown", 30000);
    // A click right after a modal dialog closes can be routed by Chrome as
    // if the dialog's backdrop were still there (the frame is in a process
    // of its own, found by hit-test data that's updated a frame later): the
    // frame never gets it. Seen in CI, 2 of 5 runs, never by a person. So
    // every click waits for the next frames to be drawn.
    const dialogGone = () => afterPaint(ev);
    async function frameClick(sel) {
        await pageShown();
        await dialogGone();
        const r = await frame(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({ block: "center" }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
        const f = await viewOrigin();
        for (const type of ["mousePressed", "mouseReleased"]) {
            await cdp("Input.dispatchMouseEvent", { type, x: f.x + r.x, y: f.y + r.y, button: "left", clickCount: 1 });
        }
    }
    // frameDrop drags data (as Input.dispatchDragEvent takes it) from
    // outside onto the point where() measures, once the page is shown and
    // drawn: over it a few times, a drawn frame apart, as a person's drag
    // is (the copy's frame takes Files on a dragover of its own: a drop
    // before it has is refused), then dropped.
    async function frameDrop(where, data) {
        await pageShown();
        await dialogGone();
        const to = await where();
        await cdp("Input.dispatchDragEvent", { type: "dragEnter", ...to, data });
        for (let i = 0; i < 3; i++) {
            await cdp("Input.dispatchDragEvent", { type: "dragOver", ...to, data });
            await dialogGone();
        }
        await cdp("Input.dispatchDragEvent", { type: "drop", ...to, data });
    }
    // submitUrl goes to url as a person does: typed into the address
    // field, submitted.
    const submitUrl = (url) => ev(`(() => { const i = document.getElementById("go_url"); i.value = ${JSON.stringify(url)}; i.form.requestSubmit(); })()`);
    // viewOrigin is where the copy's frame is in the window: what a point
    // in the frame is offset by, for the window's input.
    const viewOrigin = () => ev(`(() => { const b = document.getElementById("go_view").getBoundingClientRect(); return { x: b.x, y: b.y }; })()`);
    // closeSettings closes the Settings dialog by its ✕, and waits for it
    // to be closed (said as what).
    async function closeSettings(what = "Settings closed") {
        await ev(`document.querySelector("#go_settings .close").click()`);
        await waitFor(`!document.getElementById("go_settings").open`, what);
    }
    // stillNot watches, for ms, that what read (ev or frame) says of expr
    // doesn't come true: failing as soon as it does, with what, rather than
    // looking once at the end of a wait (and missing what came and went).
    async function stillNot(read, expr, what, ms) {
        for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
            if (await read(expr).catch(() => false)) throw new Error(what);
        }
    }
    // leave leaves the page by script (js: setting location.href, or a
    // reload; with sessionStorage cleared first, or forgetKept), and waits
    // for the page that comes: loaded, and ready as ready says.
    const forgetKept = `sessionStorage.removeItem("tabtop-go-kept"); sessionStorage.removeItem("tabtop-go-history"); sessionStorage.removeItem("tabtop-go-resume");`;
    async function leave(js, { what, ready = "true" }) {
        await ev(`(() => { window.__leaving = true; ${js} })()`);
        await waitFor(`!window.__leaving && document.readyState === "complete" && (${ready})`, what, 30000);
    }
    async function frameWait(expr, what, ms = 15000) {
        for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
            if (await frame(expr).catch(() => false)) return;
        }
        throw new Error(`timed out waiting for ${what}: ${await frame("document.body?.innerText.slice(0, 200)").catch((e) => e.message)}`);
    }
    const goTo = async (url, title) => {
        await submitUrl(url);
        try {
            await waitFor(`document.title.startsWith(${JSON.stringify(title)})`, title, 30000);
        } catch (err) {
            // What the page shows instead, to say why.
            const shows = await ev(`JSON.stringify({ title: document.title, at: location.pathname, status: document.getElementById("go_status")?.textContent, notice: document.getElementById("go_notice")?.hidden ? "" : document.getElementById("go_notice")?.textContent, url: document.getElementById("go_url")?.dataset.url, reconnect: document.getElementById("tabtop_reconnect")?.textContent })`).catch((e) => e.message);
            throw new Error(`${err.message} (the page shows ${shows})`);
        }
        await pageShown();
    };
    const origin = new URL(base).origin;

    // Every request, from the page and its frames, in-process or not.
    const requests = [];
    let choosersOpened = 0;  // this browser's own file choosers opened (Page.fileChooserOpened, while they're taken)
    browser.events.addEventListener("Page.fileChooserOpened", () => { choosersOpened++; });
    // Through a connection of its own to the browser, attached to every
    // page and frame as they come.
    const ws = new WebSocket((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl);
    await new Promise((resolve) => (ws.onopen = resolve));
    let n = 0;
    const call = (method, params = {}, sessionId) => new Promise((resolve) => {
        const id = ++n;
        const done = (e) => { const m = JSON.parse(e.data); if (m.id === id) { ws.removeEventListener("message", done); resolve(m.result); } };
        ws.addEventListener("message", done);
        ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
    ws.addEventListener("message", (e) => {
        const m = JSON.parse(e.data);
        if (m.method === "Target.attachedToTarget") {
            call("Network.enable", {}, m.params.sessionId);
            call("Runtime.runIfWaitingForDebugger", {}, m.params.sessionId);
        }
        if (m.method === "Network.requestWillBeSent") requests.push(m.params.request.url);
    });
    await call("Target.setDiscoverTargets", { discover: true });
    await call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: "page" }, { type: "iframe" }] });

    await cdp("Page.enable");
    await cdp("Log.enable");
    await cdp("Runtime.enable");
    await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

    await step("log in on /go", async () => {
        const observer = new AbortController();
        const options = { signal: observer.signal };
        const startupRequests = new Map();
        const failures = [];
        browser.events.addEventListener("Network.requestWillBeSent", ({ detail }) => {
            startupRequests.set(detail.requestId, detail.request.url);
        }, options);
        browser.events.addEventListener("Network.loadingFailed", ({ detail }) => {
            if (!detail.canceled) failures.push(`${startupRequests.get(detail.requestId) ?? detail.type}: ${detail.errorText}`);
        }, options);
        browser.events.addEventListener("Network.responseReceived", ({ detail }) => {
            if (detail.response.status >= 400) failures.push(`${detail.response.url}: HTTP ${detail.response.status}`);
        }, options);
        browser.events.addEventListener("Log.entryAdded", ({ detail: { entry } }) => {
            if (entry.level === "error") failures.push(entry.text);
        }, options);
        try {
            await cdp("Network.enable");
            // The standalone tab uses the same startup as a tab inside /go.
            await open("go/tab", '!!document.getElementById("tabtop_login_code")', "the login form");
            const code = await totp();
            await ev(`(() => { const i = document.getElementById("tabtop_login_code"); i.value = ${JSON.stringify(code)}; i.form.requestSubmit(); })()`);
            const loginError = 'document.querySelector("#tabtop_login h1 + p")?.textContent';
            // The address field is in the HTML. The resume token arrives
            // only after tabtopd accepts the authenticated browser tunnel.
            await waitFor(`(!document.getElementById("tabtop_login") && !!sessionStorage.getItem("tabtop-go-resume")) || !!(${loginError})`, "the authenticated /go tunnel");
            const error = await ev(loginError);
            if (error) throw new Error(`sign-in rejected: ${error}`);
        } catch (err) {
            const page = await ev(`({
                at: location.href, ready: document.readyState,
                storedSession: Object.keys(localStorage).includes("tabtop_session:" + new URL("../", location.href).pathname),
                form: !!document.getElementById("tabtop_login"),
                status: document.getElementById("go_status")?.textContent,
                notice: document.getElementById("go_notice")?.innerText,
            })`).catch((e) => e.message);
            const diagnostics = [...new Set([...exceptions, ...failures])].slice(-12);
            throw new Error(`${err.message}; page ${JSON.stringify(page)}${diagnostics.length ? `; browser errors: ${diagnostics.join(" | ")}` : ""}`);
        } finally {
            observer.abort();
        }
    });

    // at is where on the screen the element in the frame that sel finds is,
    // fx and fy across and down it.
    async function at(sel, fx = 0.5, fy = 0.5) {
        const r = await frame(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({ block: "nearest" }); const b = e.getBoundingClientRect(); return { x: b.x + b.width * ${fx}, y: b.y + b.height * ${fy} }; })()`);
        const f = await viewOrigin();
        return { x: f.x + r.x, y: f.y + r.y };
    }
    const mouse = (type, p, extra = {}) => cdp("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "none", ...extra });
    async function clickAt(p, { button = "left", count = 1 } = {}) {
        const buttons = { left: 1, right: 2, middle: 4 }[button];
        await mouse("mousePressed", p, { button, buttons, clickCount: count });
        await mouse("mouseReleased", p, { button, buttons: 0, clickCount: count });
    }
    // press is a real click (the person's: full screen needs one) on what
    // sel finds in the page around the frame (a menu's, a player's), held
    // hold ms, once it's drawn where it's pressed: a click just after it's
    // shown over the frame can be routed to the frame, as after a dialog
    // (see dialogGone; seen in CI, a menu's Watch pressed as it opened).
    // unseen: where it is, though it isn't what's there (a control hidden,
    // whose place is pressed).
    async function press(sel, { hold = 0, unseen = false } = {}) {
        await dialogGone();
        const where = `(() => { const e = document.querySelector(${JSON.stringify(sel)}), r = e?.getBoundingClientRect(); if (!r?.width) return null;
            const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2); return ${unseen} || e.contains(document.elementFromPoint(x, y)) ? { x, y } : null; })()`;
        let p = null;
        for (const end = Date.now() + 10000; !(p = await ev(where)); await sleep(100)) {
            if (Date.now() > end) throw new Error(`timed out waiting for ${sel} shown where it's pressed`);
        }
        await cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...p, button: "left", buttons: 1, clickCount: 1 });
        if (hold) await sleep(hold);
        await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...p, button: "left", buttons: 0, clickCount: 1 });
    }
    const pageLog = () => frame(`document.getElementById("log").textContent`);
    // WebGL drawn in the engine is replayed in the copy (gogl.js, gocanvasgl.go,
    // go-frame-gl.js): webgl.html's canvases, in the steps that follow in turn.
    // The copy's canvas's pixel at (x, y) is within 4 of want's.
    const glAt = (id, x, y, want) => `(() => { const c = document.getElementById(${JSON.stringify(id)}); const gl = c && (c.getContext("webgl2") || c.getContext("webgl"));
        if (!gl) return false; const p = new Uint8Array(4); gl.readPixels(${x}, ${y}, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
        return ${JSON.stringify(want)}.every((v, i) => v === null || Math.abs(v - p[i]) <= 4); })()`;

    // With GO_VIDEO_URL, only this, after logging in: how a video from the
    // web loads and plays (GO_LINK="delay,rate" puts a far link between
    // this browser and the server: see the end of this file).
    const farVideo = () => step("a video from the web (GO_VIDEO_URL), timed", async () => {
        const t0 = Date.now();
        await goTo(site + "far.html", "Far");
        const tPage = Date.now() - t0;
        await waitFor(`!!document.querySelector("video")`, "the player", 60000);
        const tPlayer = Date.now() - t0;
        await waitFor(`document.querySelector("video").readyState >= 1`, "metadata", 60000);
        const tMeta = Date.now() - t0;
        await ev(`(() => { const v = document.querySelector("video"); v.muted = true; window.__w = 0; v.addEventListener("waiting", () => window.__w++); v.play(); })()`);
        await waitFor(`document.querySelector("video").currentTime > 0`, "playing", 60000);
        const tPlay = Date.now() - t0;
        await sleep(15000);
        const r = await ev(`(() => { const v = document.querySelector("video"); return { t: v.currentTime, stalls: window.__w, bytes: v.dataset.bytes, buf: v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0 }; })()`);
        return (`page ${tPage} player ${tPlayer} metadata ${tMeta} playing ${tPlay} ms; after 15 s: ${JSON.stringify(r)}`);
    });
    // With GO_PROBE (a module's path), only that, after logging in: its
    // default export, given the steps' helpers, to look into a site.
    if (process.env.GO_PROBE) {
        const probe = (await import(new URL(process.env.GO_PROBE, `file://${process.cwd()}/`).href)).default;
        await step("probe (GO_PROBE)", () => probe({ ev, frame, frameWait, frameClick, cdp, goTo, waitFor, sleep, writeFileSync, site, adSite, browser })).catch(() => { process.exitCode = 1; });
        ws.close();
        browser.close();
        process.exit();
    }
    if (process.env.GO_VIDEO_URL) {
        await farVideo().catch(() => { process.exitCode = 1; });
        ws.close();
        browser.close();
        process.exit();  // the link's connections, if any, needn't close
    }

    // The steps, in their modules (test/browser/go/), in turn: each given
    // the browser, the site and the helpers above (choosersOpened read as
    // it is then, as it counts on).
    const ctx = { adSite, at, base, browser, cdp, clickAt, closeSettings, ev, exceptions, forgetKept, frame, frameClick, frameDrop,
        frameWait, glAt, goTo, inFrame, leave, mouse, origin, pageLog, pageShown, press, requests, site, stillNot, submitUrl, viewOrigin, waitFor, get choosersOpened() { return choosersOpened; } };
    await pages(ctx);
    await sites(ctx);
    await input(ctx);
    await popupsStreams(ctx);
    await pointerWebgl(ctx);
    await video(ctx);
    await framesTabs(ctx);
    await certsNet(ctx);
    await webApis(ctx);

    if (exceptions.length) {
        console.log(`exceptions on the page:\n  ${exceptions.join("\n  ")}`);
        process.exitCode = 1;
    }
    ws.close();
    browser.close();
}

if (mode === "site") {
    writeSite(args[0]);
} else if (mode === "check") {
    let base = args[0];
    if (process.env.GO_LINK) {
        // A far link between the browser and the server: one-way delay (ms)
        // and bytes a second each way, pipelined as a network's are.
        const [delay, rate] = process.env.GO_LINK.split(",").map(Number);
        const net = await import("node:net");
        const target = new URL(base);
        const port = Number(target.port), host = target.hostname;
        const shaped = (from, to) => {
            let busy = 0;
            from.on("data", (chunk) => {
                const now = Date.now();
                busy = Math.max(now, busy) + chunk.length / rate * 1000;
                setTimeout(() => to.write(chunk), busy + delay - now);
            });
            from.on("end", () => setTimeout(() => to.end(), Math.max(0, busy + delay - Date.now())));
            from.on("error", () => to.destroy());
        };
        const proxy = net.createServer((c) => {
            const u = net.connect(port, host);
            shaped(c, u);
            shaped(u, c);
        }).listen(0, "127.0.0.1");
        await new Promise((r) => proxy.on("listening", r));
        proxy.unref();
        target.port = String(proxy.address().port);
        base = target.href;
        console.log(`link: ${delay} ms each way, ${rate} bytes a second, through ${base}`);
    }
    await check(base, Number(args[1]), args[2], args[3]);
} else {
    console.error("usage: go-check.mjs site DIR | check BASE PORT SITE [ADS]");
    process.exit(2);
}
