// The remote browser's check (go-check.mjs), its steps of video feeds,
// embedded pages of other origins, scrolling, stylesheets, large pages, tabs
// and private tabs; GO_SITES and GO_SOAK.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sleep } from "../harness.mjs";
import { step } from "./step.mjs";

// framesTabs runs them, with ctx: the check's browser, the site it browses, and its helpers (see check).
export async function framesTabs(ctx) {
    const { goTo, site, frame, frameWait, waitFor, frameClick, viewOrigin, cdp, browser, ev, base, leave, submitUrl } = ctx;
    await step("a scrolling video feed releases old players and honors the page's dimensions", async () => {
        await goTo(site + "long-feed.html", "Long feed");
        for (let i = 0; i < 11; i++) {
            await frame(`document.getElementById("clips").scrollTop = ${i * 180}`);
            await frameWait(`document.getElementById("clip-${i}")?.textContent === ""`, `clip ${i + 1}'s player`);
            await waitFor(`(() => {
                const players = document.querySelectorAll("video");
                const video = players[0];
                return players.length === 1 && video.readyState >= 1 &&
                    video.getBoundingClientRect().width > 290 && video.getBoundingClientRect().height === 180;
            })()`, `only clip ${i + 1} retained at the feed dimensions`);
        }
    });

    await step("an embedded page of another origin that's hidden (displayed none) isn't read till it's shown", async () => {
        await goTo(site + "xframe-hidden.html", "Hidden frame");
        await frameWait(`!!document.getElementById("show")`, "its button");
        const read = `!!document.getElementById("x")?.shadowRoot?.querySelector("#b")`;
        await sleep(3500);  // (a few of the frames' rounds: once a second)
        if (await frame(read)) throw new Error("a hidden frame's page was read");
        await frameClick("#show");
        await frameWait(read, "its page, read once it's shown", 20000);
    });

    await step("a press, typing, Enter, hover and a tap in an embedded page of another origin reach it there", async () => {
        await goTo(site + "xframe.html", "Other origin");
        const inner = (expr) => frame(`(() => { const root = document.getElementById("x")?.shadowRoot; return root ? (${expr})(root) : null; })()`);
        await frameWait(`!!document.getElementById("x")?.shadowRoot?.querySelector("#b")`, "the embedded page's copy", 20000);
        const p = JSON.parse(await inner(`(root) => { const b = root.querySelector("#b").getBoundingClientRect(); return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2 }); }`));
        const f = await viewOrigin();
        for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: f.x + p.x, y: f.y + p.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
        await frameWait(`/^pressed \\[/.test(document.getElementById("x")?.shadowRoot?.querySelector("#s")?.textContent || "")`, "the press in the other origin's page", 15000);
        const inCopy = async (sel) => {
            const q = JSON.parse(await inner(`(root) => { const e = root.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return JSON.stringify({ x: e.x + e.width / 2, y: e.y + e.height / 2 }); }`));
            return { x: f.x + q.x, y: f.y + q.y };
        };
        // Typing in it, and Enter sending its form.
        const field = await inCopy("#t");
        for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, ...field, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
        await browser.type("hi");
        await frameWait(`document.getElementById("x")?.shadowRoot?.querySelector("#echo")?.textContent === "typed hi"`, "what was typed, in the other origin's page", 15000);
        await browser.press("Enter");
        await frameWait(`document.getElementById("x")?.shadowRoot?.querySelector("#sent")?.textContent === "sent hi"`, "its form sent by Enter", 15000);
        // Hovering.
        await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...(await inCopy("#h")), button: "none" });
        await frameWait(`document.getElementById("x")?.shadowRoot?.querySelector("#hs")?.textContent === "hovered"`, "the hover in the other origin's page", 15000);
        // A tap: a press there, on what's under the finger (not the
        // iframe's touch, whose place is the engine's iframe's), once.
        await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
        try {
            await sleep(500);  // the toolbar as for touch: the page moves down
            Object.assign(f, await viewOrigin());
            const tap = await inCopy("#tb");
            await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [tap] });
            await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
            const said = `document.getElementById("x")?.shadowRoot?.querySelector("#ts")?.textContent`;
            await frameWait(`${said} === "tapped 1"`, "the tap in the other origin's page", 15000);
            await sleep(500);
            const now = await frame(said);
            if (now !== "tapped 1") throw new Error(`then ${now}: pressed twice?`);
        } finally {
            await cdp("Emulation.setTouchEmulationEnabled", { enabled: false });
        }
    });

    await step("a scroll box's sizes and scrolling, as shown, for a page that goes by them", async () => {
        await goTo(site + "reels.html", "Reels");
        await frameWait(`document.getElementById("sized")?.textContent === "box 300 high, reels 300"`, "the box's sizes, as shown");
        const f = await viewOrigin();
        const box = JSON.parse(await frame(`(() => { const b = document.getElementById("box").getBoundingClientRect(); return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2 }); })()`));
        for (const want of [1, 2]) {
            await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x: f.x + box.x, y: f.y + box.y, deltaX: 0, deltaY: 300 });
            await frameWait(`document.getElementById("status")?.textContent === "reel ${want}"`, `reel ${want}, scrolled to`);
        }
        // The page scrolling it itself: shown scrolled, and the page told
        // where it went.
        const next = JSON.parse(await frame(`(() => { const b = document.getElementById("next").getBoundingClientRect(); return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2 }); })()`));
        for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: f.x + next.x, y: f.y + next.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
        await frameWait(`document.getElementById("box")?.scrollTop === 900`, "the box scrolled by the page, shown");
        await frameWait(`document.getElementById("status")?.textContent === "reel 3"`, "reel 3, scrolled to by the page");
        // A page that puts it where this one's snapping puts it back from,
        // each time it hears where it is: told once, not again and again.
        await goTo(site + "snapback.html", "Snap back");
        await sleep(4000);
        const heard = Number(await frame(`document.getElementById("heard").textContent`));
        if (heard > 4) throw new Error(`the page heard its box scrolled ${heard} times in 4 s: put back and told, again and again`);
    });

    await step("rules put into a stylesheet by script, as it loads and after", async () => {
        await goTo(site + "cssom.html", "Rules");
        await frameWait(`getComputedStyle(document.getElementById("early")).color === "rgb(1, 2, 3)"`, "the rule put in as it loaded");
        await frameWait(`getComputedStyle(document.getElementById("late")).color === "rgb(4, 5, 6)"`, "the rule put in after");
    });

    await step("a large page, sent compressed, and what it changes as it's shown", async () => {
        await goTo(site + "big.html", "Big");
        await frameWait(`document.querySelectorAll("p.row").length === 3000 && document.getElementById("items")?.children.length === 20`, "every row, and the 20 items added as it was shown", 30000);
        const last = await frame(`document.getElementById("items").lastElementChild.textContent`);
        if (last !== "item 20") throw new Error(`the last item says ${last}`);
    });

    await step("tabs: a window a page opens is a tab of its own, tabs are made and closed, back goes back in its tab, and they're kept", async () => {
        await ev(`location.href = ${JSON.stringify(new URL("go/", base).href)}`);
        const inTab = (n, expr) => ev(`(() => { const f = document.querySelectorAll("#frames iframe")[${n}]; const document_ = f?.contentDocument; return document_ ? ((document) => (${expr}))(document_) : null; })()`);
        const count = () => ev(`document.querySelectorAll("#frames iframe").length`);
        const shownTab = () => ev(`[...document.querySelectorAll("#frames iframe")].findIndex((f) => !f.hidden)`);
        // (The tab's script run, connected: the address given it is taken by
        // it, not by the bare form.)
        await waitFor(`document.querySelectorAll("#frames iframe").length === 1 && ((d) => d?.readyState === "complete" && !!d.getElementById("go_url") && d.getElementById("go_progress")?.hidden)(document.querySelector("#frames iframe").contentDocument)`, "the tabs' page, one tab, connected", 30000);
        // The tab loads a page, which opens a window: a tab of its own.
        await inTab(0, `(() => { const i = document.getElementById("go_url"); i.value = ${JSON.stringify(site + "interact.html")}; i.form.requestSubmit(); return true; })()`);
        await waitFor(`/^Interact/.test(document.querySelector(".tab .title")?.textContent || "")`, "the first tab's page", 30000);
        // (The copy is in the tab's frame here: its place is that frame's,
        // the view's in it, the element's in the copy.)
        for (let i = 0; i < 100 && !(await frame(`!!document.getElementById("open")`).catch(() => false)); i++) await sleep(200);
        await sleep(1000);
        const at = await ev(`(() => { const f = document.querySelectorAll("#frames iframe")[0]; const r = f.getBoundingClientRect(), v = f.contentDocument.getElementById("go_view").getBoundingClientRect(); return { x: r.x + v.x, y: r.y + v.y }; })()`);
        const b = JSON.parse(await frame(`(() => { const b = document.getElementById("open").getBoundingClientRect(); return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2 }); })()`));
        for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: at.x + b.x, y: at.y + b.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
        // Asked about (the site's pop-ups have no setting): opened.
        await waitFor(`!document.querySelector("#frames iframe").contentDocument.getElementById("go_popup").hidden`, "asked about the pop-up", 30000);
        await inTab(0, `(() => { document.querySelector("#go_popup .remember input").checked = false; document.querySelector("#go_popup .open").click(); return true; })()`);
        await waitFor(`document.querySelectorAll("#frames iframe").length === 2 && /^Second/.test(document.querySelectorAll(".tab .title")[1]?.textContent || "")`, "the opened window, in a tab of its own", 30000);
        if ((await shownTab()) !== 1) throw new Error("the new tab isn't shown");
        if (!/^Interact/.test(await inTab(0, "document.title"))) throw new Error("the first tab left its page");
        // Back (the device's): to the first tab's page, in its tab.
        await ev(`history.back()`);
        await waitFor(`[...document.querySelectorAll("#frames iframe")].findIndex((f) => !f.hidden) === 0`, "back, in the first tab", 15000);
        // A new tab, and closing it.
        await ev(`document.getElementById("new").click()`);
        await waitFor(`document.querySelectorAll("#frames iframe").length === 3`, "a new tab");
        if ((await shownTab()) !== 2) throw new Error("the new tab isn't shown");
        await ev(`document.querySelectorAll(".tab .close")[2].click()`);
        await waitFor(`document.querySelectorAll("#frames iframe").length === 2`, "the tab closed");
        // Kept: the page loaded again has its tabs, each at its page.
        await ev(`location.reload()`);
        await waitFor(`document.querySelectorAll("#frames iframe").length === 2 && /^Interact/.test(document.querySelectorAll(".tab .title")[0]?.textContent || "") && /^Second/.test(document.querySelectorAll(".tab .title")[1]?.textContent || "")`, "the tabs again, at their pages", 45000);
        // On a phone: no strip; each tab's bar has a button for the list of
        // tabs, and still fits.
        await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
        try {
            const tabDoc = `[...document.querySelectorAll("#frames iframe")].find((f) => !f.hidden).contentDocument`;
            // (A moment with no tab shown, as the window's resized: waited out.)
            await waitFor(`${tabDoc.replace(").contentDocument", ")?.contentDocument")}?.getElementById("go_tabs")?.hidden === false && getComputedStyle(document.getElementById("strip")).display === "none"`, "the tabs' button, no strip");
            const fits = await ev(`(() => { const d = ${tabDoc}; return d.getElementById("go_menu").getBoundingClientRect().right <= d.defaultView.innerWidth && d.querySelector("#go_tabs .count").textContent === "2"; })()`);
            if (!fits) throw new Error("the phone's bar doesn't fit, or doesn't count the tabs");
            await ev(`${tabDoc}.getElementById("go_tabs").click()`);
            await waitFor(`!document.getElementById("overview").hidden && document.querySelectorAll("#overview li").length === 2`, "the list of tabs");
            await ev(`document.querySelector("#overview .done").click()`);
            // Hide browser asks for the browser's full screen, which a page gets only
            // from a person's own press: the mouse's, where the button is (in the tab's
            // frame). (Not a finger's: a phone's browser moves a tap to what's near it
            // that takes one, which may be the tabs' page's, not the button.)
            await waitFor(`document.getElementById("overview").hidden`, "the list of tabs gone");
            // (What the tap brings, and what's asked of full screen, noted to say why, if it isn't.)
            await ev(`(() => { const w = ${tabDoc}.defaultView; w.__said = []; const note = (s) => w.__said.push(s + "@" + Math.round(w.performance.now()));
                for (const t of ["touchend", "pointerdown", "click", "fullscreenchange", "fullscreenerror"]) w.document.addEventListener(t, (e) => note(t + ":" + (e.target.id || e.target.tagName) + ":" + w.navigator.userActivation.isActive), true);
                const ask = w.Element.prototype.requestFullscreen, leave = w.Document.prototype.exitFullscreen;
                w.Element.prototype.requestFullscreen = function (...a) { note("asked"); return ask.apply(this, a).then((v) => (note("granted"), v), (e) => { note("refused:" + e.message); throw e; }); };
                w.Document.prototype.exitFullscreen = function (...a) { note("left:" + new Error().stack.split("\\n")[2]?.trim()); return leave.apply(this, a); }; })()`);
            await ev(`${tabDoc}.getElementById("go_menu").click()`);
            // (Once nothing's over it: the list of tabs going, the menu shown. What's
            // under the point, in the page and in the tab's frame, is the button.)
            // (A touch's point is the screen's: the page's, as zoomed and panned on a phone.)
            const hideAt = `(() => { const f = [...document.querySelectorAll("#frames iframe")].find((f) => !f.hidden), r = f.getBoundingClientRect(), v = visualViewport,
                b = ${tabDoc}.getElementById("go_menu_hide_browser").getBoundingClientRect(), cx = r.left + b.left + b.width / 2, cy = r.top + b.top + b.height / 2;
                return { f, cx, cy, x: Math.round((cx - v.offsetLeft) * v.scale), y: Math.round((cy - v.offsetTop) * v.scale), bx: b.left + b.width / 2, by: b.top + b.height / 2, v: [v.scale, v.offsetLeft, v.offsetTop] }; })()`;
            await waitFor(`(() => { const p = ${hideAt}; return document.elementFromPoint(p.cx, p.cy) === p.f && ${tabDoc}.elementFromPoint(p.bx, p.by)?.closest("#go_menu_hide_browser"); })()`, "Hide browser under the finger");
            const at = await ev(`(() => { const { x, y, v } = ${hideAt}; return { x, y, v }; })()`);
            // (The first input after the phone's emulated can go nowhere, headless Chrome's
            // seen here: the mouse moved to the button till the tab sees it, then pressed.)
            await cdp("Page.bringToFront");
            await ev(`${tabDoc}.defaultView.__moved = false; ${tabDoc}.getElementById("go_menu_hide_browser").addEventListener("mousemove", () => { ${tabDoc}.defaultView.__moved = true; }, { once: true })`);
            for (let i = 0; i < 50 && !(await ev(`${tabDoc}.defaultView.__moved`)); i++) {
                await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x + (i % 2), y: at.y });
                await sleep(200);
            }
            if (!(await ev(`${tabDoc}.defaultView.__moved`))) throw new Error("Chrome did not deliver pointer input to Hide browser");
            await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", buttons: 1, clickCount: 1 });
            await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", buttons: 0, clickCount: 1 });
            await waitFor(`${tabDoc}.defaultView.document.fullscreenElement === ${tabDoc}.defaultView.document.documentElement && getComputedStyle(${tabDoc}.getElementById("go_bar")).display !== "none"`, "Hide Original Browser keeps the /go toolbar in fullscreen").catch(async (err) => {
                const state = await ev(`JSON.stringify({ pressed: ${tabDoc}.getElementById("go_menu_hide_browser").getAttribute("aria-pressed"), menu: !${tabDoc}.getElementById("go_menu_panel").hidden,
                    enabled: ${tabDoc}.fullscreenEnabled, top: document.fullscreenElement?.tagName ?? null, notice: ${tabDoc}.getElementById("go_status")?.textContent || ${tabDoc}.querySelector("#go_notice:not([hidden]) p")?.textContent || "" })`).catch((e) => e.message);
                const said = await ev(`JSON.stringify(${tabDoc}.defaultView.__said)`).catch((e) => e.message);
                throw new Error(`${err.message} (it shows ${state}; in the tab: ${said}; tapped at ${JSON.stringify(at)})`);
            });
            await ev(`${tabDoc}.getElementById("go_tabs").click()`);
            await waitFor(`!${tabDoc}.getElementById("go_window_list").hidden && ${tabDoc}.querySelectorAll("#go_window_list li").length === 2`, "the window list opens in fullscreen with the toolbar");
            await ev(`${tabDoc}.querySelector("#go_window_list .done").click(); ${tabDoc}.getElementById("go_menu").click(); ${tabDoc}.getElementById("go_menu_hide_browser").click()`);
            await waitFor(`!${tabDoc}.defaultView.document.fullscreenElement`, "leaving Hide Original Browser exits fullscreen");
        } finally {
            await cdp("Emulation.setTouchEmulationEnabled", { enabled: false });
            await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        }
        // No address in any frame's own (go/tab?id=N only).
        const srcs = await ev(`[...document.querySelectorAll("#frames iframe")].map((f) => f.getAttribute("src")).join()`);
        if (!/^tab\?id=\d+,tab\?id=\d+$/.test(srcs)) throw new Error(`the frames are at ${srcs}`);
        // (The page left marked, and the new one's script run, connected:
        // the address it's given next taken by it, not by the bare form.)
        await leave(`location.href = ${JSON.stringify(new URL("go/tab", base).href)};`, { what: "a tab on its own again, connected", ready: `!!document.getElementById("go_url") && document.getElementById("go_progress").hidden` });
    });

    await step("private tabs: the account's cookies not given nor added to, shared by private tabs and forgotten with the last; no recent sites; a window one opens is private", async () => {
        await ev(`location.href = ${JSON.stringify(new URL("go/", base).href)}`);
        const host = new URL(site).hostname;
        const tabDoc = (n) => `document.querySelectorAll("#frames iframe")[${n}]?.contentDocument`;
        const inTab = (n, expr) => ev(`((document) => document ? (${expr}) : null)(${tabDoc(n)})`);
        const count = () => ev(`document.querySelectorAll("#frames iframe").length`);
        const connected = (n, what) => waitFor(`((d) => d?.readyState === "complete" && !!d.getElementById("go_url") && d.getElementById("go_progress")?.hidden)(${tabDoc(n)})`, what, 30000);
        const titleOf = (n) => `(document.querySelectorAll(".tab .title")[${n}]?.textContent || "")`;
        // A page loaded in tab n, shown (a hidden tab's view has no size),
        // its title (the strip's) waited for.
        const load = async (n, url, title) => {
            await ev(`document.querySelectorAll(".tab")[${n}].click()`);
            await inTab(n, `(() => { const i = document.getElementById("go_url"); i.value = ${JSON.stringify(url)}; i.form.requestSubmit(); return true; })()`);
            await waitFor(`${titleOf(n)}.startsWith(${JSON.stringify(title)})`, `${title} in tab ${n}`, 30000).catch(async (err) => {
                throw new Error(`${err.message} (it shows ${await ev(titleOf(n))})`);
            });
        };
        const sent = async (n) => { await load(n, site + "sent", "Sent "); return (await ev(titleOf(n))).replace(/^Sent /, ""); };
        await waitFor(`document.querySelectorAll("#frames iframe").length >= 1`, "the tabs' page", 30000);
        await connected(0, "the first tab, connected");
        // (Nothing kept for the site from the steps before.)
        await ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call({ type: "go-cookies-forget", name: ${JSON.stringify(host)} }); t.close(); })`);
        // The account's cookie, set in a tab that isn't private.
        await load(0, site + "cookie?set", "Cookie");
        if ((await sent(0)) !== "kept=yes") throw new Error("the account's cookie wasn't set");
        try { await ev(`localStorage.removeItem("tabtop-go-recent")`); } catch { /* none */ }
        // A private tab: marked, not named in this page's title, not given
        // the account's cookie.
        const before = await count();
        await ev(`document.getElementById("new_private").click()`);
        await waitFor(`document.querySelectorAll("#frames iframe").length === ${before + 1}`, "a private tab");
        const p1 = before;
        await connected(p1, "the private tab, connected");
        const marked = await ev(`(() => { const d = ${tabDoc(p1)}; return document.querySelectorAll(".tab")[${p1}].classList.contains("private") && d.documentElement.classList.contains("go-private") && /^Private tab/.test(d.querySelector("#go_start h1").textContent); })()`);
        if (!marked) throw new Error("the private tab isn't marked as one");
        // Its bar: Back's own arrow, violet (its disabled tint, with nothing
        // to go back to), the address field tinted, its empty text saying
        // so; never a glyph in Back's place: wide, full screen, or narrow.
        // A normal tab's: the arrow, not tinted.
        const bar = (n) => ev(`(() => { const d = ${tabDoc(n)}, a = d.getElementById("go_url"), b = d.getElementById("go_back"); return JSON.stringify({ back: b.querySelector("path").getAttribute("d"), color: getComputedStyle(b).color, field: getComputedStyle(a).borderColor, placeholder: a.placeholder }); })()`);
        const privateBar = async (where) => {
            const got = await bar(p1), n = JSON.parse(got);
            if (n.back !== "M15 5l-7 7 7 7" || !["rgb(196, 181, 253)", "rgb(139, 124, 184)"].includes(n.color) || n.field !== "rgb(139, 111, 214)" || n.placeholder !== "Private · address or search") throw new Error(`a private tab's bar, ${where}: ${got}`);
        };
        await privateBar("wide");
        const normal = JSON.parse(await bar(0));
        if (normal.back !== "M15 5l-7 7 7 7" || ["rgb(196, 181, 253)", "rgb(139, 124, 184)"].includes(normal.color) || normal.field === "rgb(139, 111, 214)" || /Private/.test(normal.placeholder)) throw new Error(`a normal tab's bar: ${JSON.stringify(normal)}`);
        await ev(`(() => { const d = ${tabDoc(p1)}; d.getElementById("go_menu").click(); d.getElementById("go_menu_fullscreen").click(); })()`);
        await waitFor(`${tabDoc(p1)}.documentElement.classList.contains("go-fullscreen")`, "the private tab full screen", 10000);
        if ((await ev(`${tabDoc(p1)}.querySelector("#go_back path").getAttribute("d")`)) !== "M15 5l-7 7 7 7") throw new Error("Back, full screen, isn't its arrow");
        await ev(`${tabDoc(p1)}.getElementById("go_exit_fullscreen").click()`);
        await waitFor(`!${tabDoc(p1)}.documentElement.classList.contains("go-fullscreen")`, "the private tab out of full screen", 10000);
        await privateBar("out of full screen");
        await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
        try {
            await sleep(500);
            await privateBar("narrow");
        } finally {
            await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        }
        if ((await sent(p1)) !== "nothing") throw new Error("a private tab was given the account's cookie");
        if ((await ev("document.title")) !== "Private – Browser") throw new Error(`the page's title names the private tab's page: ${await ev("document.title")}`);
        // Its own sign-in: kept for it, and for another private tab (made
        // from its menu), not for the account's tabs nor in their jar.
        await load(p1, site + "cookie?session", "Cookie");
        if ((await sent(p1)) !== "signin=s") throw new Error("a private tab's own cookie wasn't kept for it");
        if ((await ev(`localStorage.getItem("tabtop-go-recent")`)) !== null) throw new Error("a private tab's site was kept in the recent sites");
        await inTab(p1, `(() => { document.getElementById("go_menu").click(); document.getElementById("go_menu_private").click(); return true; })()`);
        await waitFor(`document.querySelectorAll("#frames iframe").length === ${before + 2} && document.querySelectorAll(".tab")[${before + 1}].classList.contains("private")`, "a second private tab, from the menu");
        const p2 = before + 1;
        await connected(p2, "the second private tab, connected");
        if ((await sent(p2)) !== "signin=s") throw new Error("private tabs don't share their cookies");
        if ((await sent(0)) !== "kept=yes") throw new Error("the account's tab got the private tab's cookie");
        const listed = await ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call({ type: "go-cookies" }); t.close(); return t.reply.sites.find((s) => s.site === ${JSON.stringify(host)})?.cookies ?? 0; })`);
        if (listed !== 1) throw new Error(`the account's jar lists ${listed} cookies for the site (the private tab's too?)`);
        // A window a private tab's page opens: a private tab, nothing
        // asked to be remembered.
        await load(p2, site + "opener.html", "Opener");
        await waitFor(`${tabDoc(p2)}.getElementById("go_view").getAttribute("aria-busy") !== "true"`, "the opener shown", 30000);
        await sleep(1500);
        const at = await ev(`(() => { const f = document.querySelectorAll("#frames iframe")[${p2}]; const r = f.getBoundingClientRect(), v = f.contentDocument.getElementById("go_view").getBoundingClientRect(); return { x: r.x + v.x + v.width / 2, y: r.y + v.y + v.height / 2 }; })()`);
        for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
        await waitFor(`document.querySelectorAll("#frames iframe").length === ${before + 3} || !${tabDoc(p2)}.getElementById("go_popup").hidden`, "the window opened, or asked about", 30000);
        if (await count() === before + 2) {
            if (!(await inTab(p2, `document.querySelector("#go_popup .remember").hidden`))) throw new Error("a private tab offers to remember a pop-up's answer");
            await inTab(p2, `(document.querySelector("#go_popup .open").click(), true)`);
        }
        await waitFor(`document.querySelectorAll("#frames iframe").length === ${before + 3} && /^Second/.test(${titleOf(before + 2)})`, "the opened window, in a tab of its own", 30000);
        if (!(await ev(`document.querySelectorAll(".tab")[${before + 2}].classList.contains("private")`))) throw new Error("a window a private tab opened isn't private");
        if ((await sent(before + 2)) !== "signin=s") throw new Error("a window a private tab opened hasn't its sign-in");
        // The private tabs closed: their cookies forgotten; a new one starts
        // with none.
        for (let i = 0; i < 3; i++) {
            await ev(`document.querySelectorAll(".tab .close")[${before}].click()`);
            await waitFor(`document.querySelectorAll("#frames iframe").length === ${before + 2 - i}`, "a private tab closed");
        }
        // (Their engines ended and the session's private jar let go: the
        // server's, at once on each tab's close, but not said to the page.)
        await sleep(2000);
        await ev(`document.getElementById("new_private").click()`);
        await waitFor(`document.querySelectorAll("#frames iframe").length === ${before + 1}`, "a private tab again");
        await connected(before, "the new private tab, connected");
        if ((await sent(before)) !== "nothing") throw new Error("a new private tab had the closed ones' cookie");
        // Kept as private through this page's reload.
        await ev(`location.reload()`);
        await waitFor(`document.querySelectorAll("#frames iframe").length === ${before + 1}`, "the tabs again", 45000);
        await connected(before, "the private tab again, connected");
        if (!(await ev(`document.querySelectorAll(".tab")[${before}].classList.contains("private") && ${tabDoc(before)}.documentElement.classList.contains("go-private")`))) throw new Error("a private tab came back from a reload as one that isn't");
        await ev(`document.querySelectorAll(".tab .close")[${before}].click()`);
        await waitFor(`document.querySelectorAll("#frames iframe").length === ${before}`, "the private tab closed");
        // (The account's cookie forgotten: the steps after's.)
        await ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call({ type: "go-cookies-forget", name: ${JSON.stringify(host)} }); t.close(); })`);
        await leave(`location.href = ${JSON.stringify(new URL("go/tab", base).href)};`, { what: "a tab on its own again, connected", ready: `!!document.getElementById("go_url") && document.getElementById("go_progress").hidden` });
    });

    await step("starting tab private (Settings' Starting tab): the browser's first tab private; a blank tab switched to the other kind in its place; New tab still a normal tab, New private tab (the strip's and the menu's) a private one; a normal tab's window normal", async () => {
        const tabDoc = (n) => `document.querySelectorAll("#frames iframe")[${n}]?.contentDocument`;
        const inTab = (n, expr) => ev(`((document) => document ? (${expr}) : null)(${tabDoc(n)})`);
        const connected = (n, what) => waitFor(`((d) => d?.readyState === "complete" && !!d.getElementById("go_url") && d.getElementById("go_progress")?.hidden)(${tabDoc(n)})`, what, 30000);
        const kind = (n) => ev(`(() => { const strip = document.querySelectorAll(".tab")[${n}].classList.contains("private"), inTab = ${tabDoc(n)}.documentElement.classList.contains("go-private"); return strip === inTab ? (strip ? "private" : "normal") : "mixed"; })()`);
        const tabs = (n, what) => waitFor(`document.querySelectorAll("#frames iframe").length === ${n}`, what, 30000);
        const setting = (on) => ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call({ type: "go-settings-set", setting: ${JSON.stringify(on ? "tabs-private" : "tabs-normal")} }); t.close(); return t.reply.privateDefault; })`);
        try {
            if ((await setting(true)) !== true) throw new Error("the starting tab not said private");
            // The browser opened (no tabs kept): its first tab private.
            await leave(`sessionStorage.clear(); location.href = ${JSON.stringify(new URL("go/", base).href)};`, { what: "the tabs page", ready: `document.querySelectorAll("#frames iframe").length === 1` });
            await connected(0, "its first tab, connected");
            if ((await kind(0)) !== "private") throw new Error(`the first tab is ${await kind(0)}`);
            // Each button its own kind, whatever the browser started in.
            const labels = await ev(`document.getElementById("new").title + " | " + document.getElementById("new_private").getAttribute("aria-label")`);
            if (!/^New tab \| New private tab$/.test(labels)) throw new Error(`the strip's buttons: ${labels}`);
            // The first tab blank: the other kind asked for switches it, in
            // its place, rather than opening another; and back.
            const switched = async (button, want) => {
                await ev(`document.getElementById(${JSON.stringify(button)}).click()`);
                await waitFor(`document.querySelectorAll("#frames iframe").length === 1 && document.querySelector(".tab").classList.contains("private") === ${want === "private"}`, `the blank tab switched to ${want}`, 30000);
                await connected(0, `the ${want} tab, connected`);
                if ((await kind(0)) !== want) throw new Error(`the blank tab, switched, is ${await kind(0)}`);
            };
            await switched("new", "normal");
            await switched("new_private", "private");
            // Not blank (a page in it): New tab opens a normal tab.
            const loaded = async (n, url, title) => {
                await ev(`document.querySelectorAll(".tab")[${n}].click()`);
                await inTab(n, `(() => { const i = document.getElementById("go_url"); i.value = ${JSON.stringify(url)}; i.form.requestSubmit(); return true; })()`);
                await waitFor(`${JSON.stringify(title)} === (document.querySelectorAll(".tab .title")[${n}]?.textContent || "").slice(0, ${title.length})`, `${title} in tab ${n}`, 30000);
            };
            await loaded(0, site + "index.html", "Fixture");
            await ev(`document.getElementById("new").click()`);
            await tabs(2, "New tab's tab");
            await connected(1, "New tab's tab, connected");
            if ((await kind(1)) !== "normal") throw new Error(`New tab opened a ${await kind(1)} tab`);
            await loaded(1, site + "opener.html", "Opener");
            await ev(`document.getElementById("new_private").click()`);
            await tabs(3, "New private tab's tab");
            await connected(2, "New private tab's tab, connected");
            if ((await kind(2)) !== "private") throw new Error(`New private tab opened a ${await kind(2)} tab`);
            await inTab(1, `(() => { document.getElementById("go_menu").click(); document.getElementById("go_menu_private").click(); return true; })()`);
            await tabs(4, "the menu's New private tab");
            await connected(3, "the menu's tab, connected");
            if ((await kind(3)) !== "private") throw new Error(`the menu's New private tab opened a ${await kind(3)} tab`);
            await ev(`document.querySelectorAll(".tab .close")[3].click()`);
            await tabs(3, "that tab closed");
            // A window a normal tab's page opens: normal, the starting tab
            // private or not.
            await ev(`document.querySelectorAll(".tab")[1].click()`);
            await inTab(1, `(() => { const i = document.getElementById("go_url"); i.value = ${JSON.stringify(site + "opener.html")}; i.form.requestSubmit(); return true; })()`);
            await waitFor(`/^Opener/.test(document.querySelectorAll(".tab .title")[1]?.textContent || "")`, "the opener", 30000);
            await waitFor(`${tabDoc(1)}.getElementById("go_view").getAttribute("aria-busy") !== "true"`, "the opener shown", 30000);
            await sleep(1500);
            const at = await ev(`(() => { const f = document.querySelectorAll("#frames iframe")[1]; const r = f.getBoundingClientRect(), v = f.contentDocument.getElementById("go_view").getBoundingClientRect(); return { x: r.x + v.x + v.width / 2, y: r.y + v.y + v.height / 2 }; })()`);
            for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
            await waitFor(`document.querySelectorAll("#frames iframe").length === 4 || !${tabDoc(1)}.getElementById("go_popup").hidden`, "the window opened, or asked about", 30000);
            if ((await ev(`document.querySelectorAll("#frames iframe").length`)) === 3) await inTab(1, `(document.querySelector("#go_popup .open").click(), true)`);
            await waitFor(`document.querySelectorAll("#frames iframe").length === 4 && /^Second/.test(document.querySelectorAll(".tab .title")[3]?.textContent || "")`, "the opened window, in a tab of its own", 30000);
            await connected(3, "the opened window, connected");
            if ((await kind(3)) !== "normal") throw new Error(`a window a normal tab opened is ${await kind(3)}`);
            // Settings shows it (a tab's), and sets it back.
            await inTab(1, `(() => { document.getElementById("go_menu").click(); document.getElementById("go_menu_settings").click(); return true; })()`);
            const settingsDoc = `${tabDoc(1)}.querySelector("#go_settings iframe")?.contentDocument`;
            await waitFor(`((d) => { const s = d?.getElementById("tabs_default"); return !!s && !s.disabled && s.value === "private"; })(${settingsDoc})`, "Settings' Starting tab, private", 30000);
            await ev(`(() => { const s = (${settingsDoc}).getElementById("tabs_default"); s.value = "normal"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
            await waitFor(`/starts in a normal tab/.test((${settingsDoc}).getElementById("done").textContent)`, "Settings saying it's normal again", 15000);
            if ((await setting(false)) !== false) throw new Error("not normal again");
        } finally {
            await setting(false).catch(() => {});
        }
        await leave(`sessionStorage.clear(); location.href = ${JSON.stringify(new URL("go/tab", base).href)};`, { what: "a tab on its own again, connected", ready: `!!document.getElementById("go_url") && document.getElementById("go_progress").hidden` });
    });

    // With GO_SITES (space-separated addresses), real sites too, each with
    // a screenshot in GO_SHOTS (default the working directory).
    for (const url of (process.env.GO_SITES || "").split(/\s+/).filter(Boolean)) {
        await step(`real site ${url}`, async () => {
            const before = await ev(`document.title`);
            await submitUrl(url);
            await waitFor(`document.title !== ${JSON.stringify(before)} || !document.getElementById("go_notice").hidden`, "the site", 60000);
            await waitFor(`document.getElementById("go_status").textContent === "" || !document.getElementById("go_notice").hidden`, "it shown", 60000).catch(() => {});
            await sleep(1500);
            const shot = await cdp("Page.captureScreenshot", { format: "png" });
            const file = join(process.env.GO_SHOTS || ".", `${new URL(url).host.replace(/[^\w.-]/g, "_")}.png`);
            writeFileSync(file, Buffer.from(shot.data, "base64"));
            const notice = await ev(`document.getElementById("go_notice").hidden ? "" : document.querySelector("#go_notice p").textContent`);
            if (notice) throw new Error(notice);
            const stats = await frame(`({ elements: document.getElementsByTagName("*").length, images: [...document.images].filter((i) => i.getAttribute("src")?.startsWith("blob:")).length + "/" + document.images.length,
                missing: [...document.images].filter((i) => !i.getAttribute("src")).slice(0, 4).map((i) => i.outerHTML.slice(0, 160)) })`);
            if (process.env.GO_DEBUG) console.log(JSON.stringify(stats.missing, null, 1));
            return `${await ev(`document.title`)}; ${stats.elements} elements, pictures fetched ${stats.images}; ${file}`;
        });
    }

    // With GO_SOAK=N, N pages one after another in the one tab, through
    // GO_SITES or else the test site's pages: a long session, for the
    // engine's memory (go-check.sh reports it).
    const soak = Number(process.env.GO_SOAK || 0);
    if (soak > 0) {
        await step(`a long session: ${soak} pages in one tab`, async () => {
            const sites = (process.env.GO_SITES || "").split(/\s+/).filter(Boolean);
            // Each page's title differs from the one before, to tell it's shown.
            const list = sites.length > 1 ? sites : ["index.html", "second.html"].map((p) => site + p);
            const slow = [];
            for (let i = 0; i < soak; i++) {
                const url = list[i % list.length];
                const t = Date.now();
                const before = await ev(`document.title`);
                await submitUrl(url);
                await waitFor(`document.getElementById("go_status").textContent === "" && document.title !== ${JSON.stringify(before)} || !document.getElementById("go_notice").hidden`, `page ${i + 1}, ${url}`, 60000);
                const notice = await ev(`document.getElementById("go_notice").hidden ? "" : document.querySelector("#go_notice p").textContent`);
                if (notice) throw new Error(`page ${i + 1}, ${url}: ${notice}`);
                if (Date.now() - t > 10000) slow.push(`${url} ${Date.now() - t} ms`);
            }
            return `all shown${slow.length ? `; slow: ${slow.slice(0, 5).join(", ")}` : ""}`;
        });
    }

}
