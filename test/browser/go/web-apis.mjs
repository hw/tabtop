// The remote browser's check (go-check.mjs), its steps of what a page asks of
// the person's browser: the clipboard, notifications, encrypted media,
// location, sharing, file pickers, fullscreen, wake lock, permissions,
// pointer lock, orientation, vibration; no request but TabTop's; the offline
// client.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sleep, totp } from "../harness.mjs";
import { step } from "./step.mjs";

// webApis runs them, with ctx: the check's browser, the site it browses, and its helpers (see check).
export async function webApis(ctx) {
    const { cdp, ev, waitFor, frameClick, goTo, site, frameWait, frame, viewOrigin, submitUrl, adSite, leave, requests, base, inFrame, origin } = ctx;
    await step("the page's clipboard: a copy after a press (execCommand, a copy handler, writeText, in another origin's frame) on the person's clipboard, not one long after; a read asked of the person, pasted or refused", async () => {
        // This browser's own clipboard, read here: allowed, and the page
        // focused as a person's is (headless, it's not).
        await cdp("Browser.grantPermissions", { origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
        await cdp("Emulation.setFocusEmulationEnabled", { enabled: true });
        const clip = () => ev(`navigator.clipboard.readText()`);
        const set = (t) => ev(`navigator.clipboard.writeText(${JSON.stringify(t)})`);
        const noticed = () => ev(`document.getElementById("go_notice").hidden ? "none" : document.querySelector("#go_notice p").textContent`);
        const holds = (text, what) => waitFor(`navigator.clipboard.readText().then((t) => t === ${JSON.stringify(text)})`, what, 15000).catch(async (err) => {
            throw new Error(`${err.message} (the clipboard has ${JSON.stringify(await clip())}; the notice: ${await noticed()})`);
        });
        const copied = async (sel, text, what) => {
            await set("before");
            await frameClick(sel);
            await holds(text, what);
        };
        await goTo(site + "clipboard.html", "Clipboard");
        await frameWait(`!!document.getElementById("read")`, "the page's buttons");
        await copied("#exec", "copied by execCommand", "a textarea's text copied by execCommand");
        await copied("#handler", "set by a copy handler", "a copy handler's text");
        // A copy 6.5 s after its press: not the person's doing, not put there.
        await set("before");
        await frameClick("#late");
        await sleep(8000);
        if ((await clip()) !== "before") throw new Error(`a copy long after the press was put on the clipboard: ${JSON.stringify(await clip())}`);
        // In another origin's frame.
        const inner = (expr) => frame(`(() => { const root = document.getElementById("x")?.shadowRoot; return root ? (${expr})(root) : null; })()`);
        await frameWait(`!!document.getElementById("x")?.shadowRoot?.querySelector("#b")`, "the embedded page's copy", 20000);
        await set("before");
        const p = JSON.parse(await inner(`(root) => { const b = root.querySelector("#b").getBoundingClientRect(); return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2 }); }`));
        const f = await viewOrigin();
        for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: f.x + p.x, y: f.y + p.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
        await holds("copied in another origin's frame", "a copy in another origin's frame");
        // navigator.clipboard is a secure page's only: the site's https
        // (its certificate excepted, as the steps before may have).
        await submitUrl(site.replace(/^http:/, "https:") + "clipboard.html");
        await waitFor(`document.title.startsWith("Clipboard") || !document.getElementById("go_cert").hidden`, "the secure page, or its warning", 30000);
        if (!(await ev(`document.getElementById("go_cert").hidden`))) await ev(`document.querySelector("#go_cert .go").click()`);
        await waitFor(`document.title.startsWith("Clipboard")`, "the secure page", 30000);
        await frameWait(`!!document.getElementById("read")`, "its buttons");
        await copied("#write", "copied by writeText", "navigator.clipboard.writeText's text");
        // Its read: asked of the person; allowed, given what's on the clipboard.
        await set("for the page");
        await frameClick("#read");
        await waitFor(`!document.getElementById("go_paste").hidden`, "the person asked", 15000);
        if (!/wants to see what you copied/.test(await ev(`document.getElementById("go_paste_text").textContent`))) throw new Error("the question doesn't say what's asked");
        await ev(`document.querySelector("#go_paste .allow").click()`);
        await frameWait(`document.getElementById("got")?.textContent === "read: for the page"`, "the clipboard's text given to the page", 15000);
        // Refused: the page told so.
        await frameClick("#read");
        await waitFor(`!document.getElementById("go_paste").hidden`, "asked again (nothing remembered)", 15000);
        await ev(`document.querySelector("#go_paste .refuse").click()`);
        await frameWait(`document.getElementById("got")?.textContent === "refused: NotAllowedError"`, "the page told it was refused", 15000);
        await goTo(site + "index.html", "Fixture");
    });

    await step("the page's clipboard pictures (written with its text, read when allowed), its rich text (HTML written, a selection copied, read when allowed), and its notifications (asked after a press, allowed and kept, shown, felt, clicked, closed; as a notice where this browser shows none)", async () => {
        // (As the step before: this browser's clipboard allowed, the page
        // focused as a person's is; so it runs alone too, GO_ONLY.)
        await cdp("Browser.grantPermissions", { origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
        await cdp("Emulation.setFocusEmulationEnabled", { enabled: true });
        const secure = async (page, title) => {
            await goTo(site + "index.html", "Fixture");
            await submitUrl(site.replace(/^http:/, "https:") + page);
            await waitFor(`document.title.startsWith(${JSON.stringify(title)}) || !document.getElementById("go_cert").hidden`, "the secure page, or its warning", 30000);
            if (!(await ev(`document.getElementById("go_cert").hidden`))) await ev(`document.querySelector("#go_cert .go").click()`);
            await waitFor(`document.title.startsWith(${JSON.stringify(title)})`, "the secure page", 30000);
        };
        // A picture copied: on this browser's clipboard as the page drew it
        // (red, then blue), with its text.
        await secure("clipimage.html", "Clip image");
        await frameWait(`!!document.getElementById("readimg")`, "the page's buttons");
        await ev(`navigator.clipboard.writeText("before")`);
        await frameClick("#copyimg");
        const onClip = `navigator.clipboard.read().then(async (items) => {
            const it = items.find((i) => i.types.includes("image/png"));
            if (!it) return "no picture: " + items.map((i) => i.types.join(",")).join(" ");
            const bmp = await createImageBitmap(await it.getType("image/png"));
            const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext("2d");
            g.drawImage(bmp, 0, 0);
            const px = (x) => Array.from(g.getImageData(x, 2, 1, 1).data).join(",");
            const text = it.types.includes("text/plain") ? await (await it.getType("text/plain")).text() : "";
            return bmp.width + "x" + bmp.height + " " + px(1) + " " + px(6) + " " + text;
        })`;
        await waitFor(`${onClip}.then((s) => s === "8x6 255,0,0,255 0,0,255,255 a picture")`, "the picture on the clipboard, with its text", 15000)
            .catch(async (err) => { throw new Error(`${err.message}: ${await ev(onClip)}; the page: ${await frame(`document.getElementById("got").textContent`)}`); });
        // A big one (noise, about 3 MB): on the clipboard whole; one past
        // 8 MiB refused in the page.
        await frameClick("#copybig");
        await waitFor(`navigator.clipboard.read().then(async (items) => { const it = items.find((i) => i.types.includes("image/png")); if (!it) return false; const b = await createImageBitmap(await it.getType("image/png")); return b.width === 1200 && b.height === 900; })`, "a 3 MB picture on the clipboard", 60000)
            .catch(async (err) => { throw new Error(`${err.message}: the page: ${await frame(`document.getElementById("got").textContent`)}`); });
        const big = Number((await frame(`document.getElementById("got").textContent`)).replace(/^\D+/, ""));
        if (!(big > 3 << 20)) throw new Error(`the big picture was ${big} bytes`);
        await frameClick("#copyhuge");
        await frameWait(`document.getElementById("got")?.textContent === "write refused DataError"`, "one past 8 MiB refused", 60000)
            .catch(async (err) => { throw new Error(`${err.message}: ${await frame(`document.getElementById("got").textContent`)}`); });
        // Read, allowed: the page given this browser's picture and text.
        await ev(`(async () => { const c = new OffscreenCanvas(5, 7); const g = c.getContext("2d"); g.fillStyle = "#0a0"; g.fillRect(0, 0, 5, 7);
            await navigator.clipboard.write([new ClipboardItem({ "image/png": await c.convertToBlob({ type: "image/png" }), "text/plain": new Blob(["with text"], { type: "text/plain" }) })]); })()`);
        await frameClick("#readimg");
        await waitFor(`!document.getElementById("go_paste").hidden`, "the person asked", 15000);
        if (!/text and pictures/.test(await ev(`document.getElementById("go_paste_text").textContent`))) throw new Error("the question doesn't say pictures are asked for");
        await ev(`document.querySelector("#go_paste .allow").click()`);
        await frameWait(`document.getElementById("got")?.textContent === "read image/png,text/plain 5x7 with text"`, "the picture and its text given to the page", 15000)
            .catch(async (err) => { throw new Error(`${err.message}: ${await frame(`document.getElementById("got").textContent`)}`); });
        // Rich text: HTML written with its text, and a copy of what's
        // selected (as HTML too), on this browser's clipboard; read, allowed,
        // the page given the clipboard's HTML.
        const richOnClip = `navigator.clipboard.read().then(async (items) => { const it = items[0]; if (!it) return "nothing";
            const get = async (t) => (it.types.includes(t) ? (await it.getType(t)).text() : "");
            return JSON.stringify({ types: it.types, html: await get("text/html"), text: await get("text/plain") }); })`;
        const richIs = async (html, text, what) => waitFor(`${richOnClip}.then((s) => { const c = JSON.parse(s); return c.html.includes(${JSON.stringify(html)}) && c.text === ${JSON.stringify(text)}; })`, what, 15000)
            .catch(async (err) => { throw new Error(`${err.message}: ${await ev(richOnClip)}; the page: ${await frame(`document.getElementById("got").textContent`)}`); });
        await ev(`navigator.clipboard.writeText("before")`);
        await frameClick("#copyhtml");
        await richIs("<b>bold</b> words", "bold words", "the page's HTML on the clipboard, with its text");
        await ev(`navigator.clipboard.writeText("before")`);
        await frameClick("#copysel");
        await richIs("<i>slanted</i> text", "slanted text", "what's selected on the clipboard as HTML, with its text");
        await ev(`navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob(["<u>under</u> lined"], { type: "text/html" }), "text/plain": new Blob(["under lined"], { type: "text/plain" }) })])`);
        await frameClick("#readhtml");
        await waitFor(`!document.getElementById("go_paste").hidden`, "the person asked for the rich text", 15000);
        await ev(`document.querySelector("#go_paste .allow").click()`);
        await frameWait(`document.getElementById("got")?.textContent === "read text/html,text/plain with its html"`, "the clipboard's HTML given to the page", 15000)
            .catch(async (err) => { throw new Error(`${err.message}: ${await frame(`document.getElementById("got").textContent`)}`); });

        // Notifications: this browser's stood in for (recorded, its click
        // and close done here).
        const host = new URL(site).hostname;
        const setting = (s) => ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call({ type: "go-settings-set", name: ${JSON.stringify(host)}, setting: ${JSON.stringify(s)} }); t.close(); })`);
        await setting("notifications-default");
        await secure("notify.html", "Notify");
        const log = () => frame(`document.getElementById("log").textContent`);
        const perm = (text, what) => frameWait(`document.getElementById("perm")?.textContent === ${JSON.stringify(text)}`, what, 15000)
            .catch(async (err) => { throw new Error(`${err.message}: ${await frame(`document.getElementById("perm").textContent`)}`); });
        await perm("load default now default query prompt", "not yet asked");
        // Asked as it loaded (no press): answered, still to ask, not left waiting.
        await frameWait(`document.getElementById("early")?.textContent === "load-ask default;"`, "the ask made as it loaded answered", 15000);
        // Shown, not allowed: its error.
        await frameClick("#show");
        await frameWait(`document.getElementById("log").textContent === "error;"`, "an error, not allowed", 15000);
        // Asked long after a press: not asked, still to ask.
        await frameClick("#late");
        await frameWait(`document.getElementById("log").textContent.includes("late default")`, "a late ask, not asked", 20000);
        if (!(await ev(`document.getElementById("go_notify_ask").hidden`))) throw new Error("asked long after the press");
        // Asked after a press: allowed.
        await frameClick("#ask");
        await waitFor(`!document.getElementById("go_notify_ask").hidden`, "the person asked", 15000);
        const asked = await ev(`document.getElementById("go_notify_ask_text").textContent`);
        if (!asked.includes("wants to show you notifications") || !asked.includes(host)) throw new Error(`asked: ${asked}`);
        await ev(`document.querySelector("#go_notify_ask .allow").click()`);
        await frameWait(`document.getElementById("log").textContent.includes("asked granted")`, "the page told it's allowed", 15000);
        await perm("load default now granted query granted", "granted, and the permissions query says so");
        // This browser's notifications stood in for: recorded, their click
        // and close done here.
        await ev(`window.__notes = []; window.Notification = class { static permission = "granted"; static requestPermission() { return Promise.resolve(this.permission); }
            constructor(title, o) { this.title = title; this.o = o; window.__notes.push(this); setTimeout(() => this.onshow?.(), 0); }
            close() { this.closed = true; setTimeout(() => this.onclose?.(), 0); } };`);
        // Kept: loaded again, granted from its first script; the one it
        // showed as it loaded, shown.
        await secure("notify.html", "Notify");
        await perm("load granted now granted query granted", "granted as it loads");
        await frameWait(`document.getElementById("early")?.textContent.includes("load-show;")`, "the one shown as it loaded, shown", 15000)
            .catch(async (err) => { throw new Error(`${err.message}: ${await frame(`document.getElementById("early").textContent`)}`); });
        if (!(await ev(`__notes.some((n) => n.title === "At load")`))) throw new Error("the one shown as it loaded isn't in this browser");
        // Shown: in this browser, its site first; its icon fetched by the
        // server (the page's own picture), given as a PNG.
        await frameClick("#show");
        await waitFor(`window.__notes.some((n) => n.title === "Hello")`, "shown in this browser", 15000);
        const hello = `__notes.find((n) => n.title === "Hello")`;
        const shown = await ev(`JSON.stringify({ body: ${hello}.o.body, tag: ${hello}.o.tag, icon: (${hello}.o.icon ?? "").slice(0, 40) })`);
        const s0 = JSON.parse(shown);
        if (s0.body !== host + "\nfrom the page" || !s0.icon.startsWith("data:image/png;base64,") || !s0.tag?.endsWith(":t1")) throw new Error(`shown as ${shown}`);
        await frameWait(`document.getElementById("log").textContent.endsWith("show;")`, "the page told it's shown", 15000);
        await ev(`${hello}.onclick()`);
        await frameWait(`document.getElementById("log").textContent.endsWith("click;")`, "the page told it's clicked", 15000);
        await frameClick("#close");
        await waitFor(`${hello}.closed === true`, "closed in this browser by the page", 15000);
        await frameWait(`document.getElementById("log").textContent.endsWith("close;")`, "the page told it's closed", 15000);
        // One whose icon is a drawing (SVG): shown, its icon not.
        await frameClick("#svg");
        await waitFor(`window.__notes.some((n) => n.title === "Drawn")`, "the one with a drawing shown", 15000);
        if (await ev(`__notes.find((n) => n.title === "Drawn").o.icon ?? null`)) throw new Error("an SVG icon given");
        // A large picture (a data: one of about 1.2 MB): given whole, the
        // page's own change in the same batch shown too.
        await frameClick("#big");
        await waitFor(`window.__notes.some((n) => n.title === "Big")`, "the one with a large picture shown", 20000);
        const bigImage = await ev(`(__notes.find((n) => n.title === "Big").o.image ?? "").length`);
        if (bigImage < 1_100_000) throw new Error(`the large picture given as ${bigImage} characters`);
        await frameWait(`document.getElementById("log").textContent.includes("big;")`, "the page's change with it", 15000);
        // One with a vibration pattern: felt here as it's shown (its pause
        // at the end left off); a silent one with one, refused in the page.
        await ev(`window.__felt = []; Object.defineProperty(navigator, "vibrate", { configurable: true, value: (p) => { window.__felt.push(JSON.stringify(p)); return true; } })`);
        await frameClick("#vib");
        await waitFor(`window.__notes.some((n) => n.title === "Felt") && window.__felt.includes("[200,100,200]")`, "the one to be felt shown, and felt", 15000)
            .catch(async (err) => { throw new Error(`${err.message}: felt ${await ev(`JSON.stringify(window.__felt)`)}`); });
        if (await ev(`window.__notes.some((n) => n.title === "Quiet")`)) throw new Error("a silent one with a vibration shown");
        const vibLog = await frame(`document.getElementById("log").textContent`);
        if (!vibLog.includes("vib 200,100,200,100 true;quiet TypeError;")) throw new Error(`the page: ${vibLog}`);
        // This browser showing none: a notice here, Open its click.
        await ev(`Notification.permission = "denied"`);
        await frameClick("#show");
        await waitFor(`!document.getElementById("go_notice").hidden && document.querySelector("#go_notice p").textContent.includes("Hello — from the page")`, "a notice", 15000);
        await ev(`document.querySelector("#go_notice .primary").click()`);
        await frameWait(`document.getElementById("log").textContent.endsWith("click;")`, "the notice's Open, the page's click", 15000);
        // Its setting changed in Site controls: the page told at once.
        await setting("notifications-block");
        await perm("load granted now denied query denied", "blocked in Site controls, the page told");
        await setting("notifications-default");
        await goTo(site + "index.html", "Fixture");
    });

    await step("the page's encrypted media (EME, Clear Key): its keys and session the person's browser's, its license the page's, its stream played; and an embedded page's, of its origin and of another, at once, each its own", async () => {
        const secureAt = async (base, page, title) => {
            await submitUrl(base.replace(/^http:/, "https:") + page);
            await waitFor(`document.title.startsWith(${JSON.stringify(title)}) || !document.getElementById("go_cert").hidden`, "the secure page, or its warning", 30000);
            if (!(await ev(`document.getElementById("go_cert").hidden`))) await ev(`document.querySelector("#go_cert .go").click()`);
            await waitFor(`document.title.startsWith(${JSON.stringify(title)})`, "the secure page", 30000);
        };
        const log = () => frame(`document.getElementById("log")?.textContent ?? ""`);
        const played = `[...document.querySelectorAll("video")].some((v) => v.mediaKeys && v.currentTime > 0.5 && !v.error)`;
        // Autoplay on (a step before may have paused it, which holds back a
        // page's play()): each page's own play() starts its player.
        const autoplayWas = await ev(`document.getElementById("go_menu_autoplay").getAttribute("aria-checked")`);
        if (autoplayWas !== "true") await ev(`document.getElementById("go_menu_autoplay").click()`);
        await goTo(site + "index.html", "Fixture");
        await secureAt(site, "eme.html", "EME");
        await frameWait(`/key usable/.test(document.getElementById("log")?.textContent ?? "")`, "its key usable", 30000)
            .catch(async (err) => { throw new Error(`${err.message}: ${await log()}`); });
        if (!/^access org\.w3\.clearkey;keys;.*encrypted cenc;.*message;.*updated;/.test(await log())) throw new Error(`the page's EME: ${await log()}`);
        const players = () => ev(`JSON.stringify([...document.querySelectorAll("video")].map((v) => [!!v.mediaKeys, Math.round(v.currentTime * 10) / 10, v.error?.message ?? null, v.readyState]))`);
        await waitFor(played, "its stream played by its own play(), with the person's browser's keys", 30000)
            .catch(async (err) => { throw new Error(`${err.message}: ${await players()}; the page: ${await log()}`); });
        // In embedded pages: one of its origin (read by its agent), one of
        // another (https, its certificate excepted as the page's is), with
        // the page's own player, all at once.
        await goTo(site + "index.html", "Fixture");
        await secureAt(adSite, "index.html", "Fixture");
        await secureAt(site, "emeframe.html?other=" + encodeURIComponent(adSite.replace(/^http:/, "https:")), "EME frames");
        const inner = (id) => frame(`document.getElementById(${JSON.stringify(id)})?.shadowRoot?.querySelector("#log")?.textContent ?? ""`);
        const logs = async () => `the page: ${await log()}; its origin's frame: ${await inner("same")}; another's: ${await inner("other")}`;
        const usable = (text) => /^access org\.w3\.clearkey;keys;.*encrypted cenc;.*message;.*updated;.*key usable;/.test(text);
        await frameWait(`["same", "other"].every((id) => /key usable/.test(document.getElementById(id)?.shadowRoot?.querySelector("#log")?.textContent ?? "")) && /key usable/.test(document.getElementById("log")?.textContent ?? "")`, "each player's key usable", 45000)
            .catch(async (err) => { throw new Error(`${err.message}: ${await logs()}; the players: ${await players()}`); });
        for (const text of [await log(), await inner("same"), await inner("other")]) if (!usable(text)) throw new Error(`a player's EME: ${await logs()}`);
        // Each started by its page's own play() (an embedded page's too:
        // goframestreams.go's plays, or its page's agent's), with its own keys.
        await waitFor(`[...document.querySelectorAll("video")].filter((v) => v.mediaKeys && v.currentTime > 0.5 && !v.error).length >= 3`, "the three played, each with its keys", 30000)
            .catch(async (err) => { throw new Error(`${err.message}: ${await players()}; ${await logs()}`); });
        if (await ev(`new Set([...document.querySelectorAll("video")].filter((v) => v.mediaKeys).map((v) => v.mediaKeys)).size < 3`)) throw new Error("players share their keys");
        if (autoplayWas !== "true") await ev(`document.getElementById("go_menu_autoplay").click()`);
        await goTo(site + "index.html", "Fixture");
    });

    await step("the page's location: once, and followed (watchPosition) as it changes, the person told while it is; stopped by the page (clearWatch), or by the person", async () => {
        await cdp("Browser.grantPermissions", { origin, permissions: ["geolocation"] });
        const at = (latitude) => cdp("Emulation.setGeolocationOverride", { latitude, longitude: 103.8, accuracy: 10 });
        await at(1.5);
        await goTo(site + "index.html", "Fixture");
        await submitUrl(site.replace(/^http:/, "https:") + "where.html");
        await waitFor(`document.title.startsWith("Where") || !document.getElementById("go_cert").hidden`, "the secure page, or its warning", 30000);
        if (!(await ev(`document.getElementById("go_cert").hidden`))) await ev(`document.querySelector("#go_cert .go").click()`);
        await waitFor(`document.title.startsWith("Where")`, "the secure page", 30000);
        await frameWait(`!!document.getElementById("follow")`, "its buttons");
        const log = () => frame(`document.getElementById("log").textContent`);
        const logged = (re, what) => frameWait(`${re}.test(document.getElementById("log")?.textContent ?? "")`, what, 15000)
            .catch(async (err) => { throw new Error(`${err.message}: ${await log()}`); });
        const asked = async (allow) => {
            await waitFor(`!document.getElementById("go_device").hidden`, "the person asked", 15000);
            await ev(`document.querySelector("#go_device ${allow ? ".allow" : ".refuse"}").click()`);
        };
        // Once.
        await frameClick("#once");
        await asked(true);
        await logged(/once 1\.5;/, "its position, once");
        // Followed: asked, then each position as it changes, the person told.
        await frameClick("#follow");
        await waitFor(`/follow your location/.test(document.getElementById("go_device_text").textContent)`, "asked to follow", 15000);
        await asked(true);
        await logged(/pos 1\.5;/, "its first position");
        await waitFor(`!document.getElementById("go_location").hidden && /is following your location/.test(document.getElementById("go_location").textContent)`, "the person told it's followed", 10000);
        await at(2.5);
        await logged(/pos 2\.5;/, "a position as it changed");
        // Cleared by the page: not followed, the person's bar gone.
        await frameClick("#stop");
        await logged(/cleared;/, "cleared");
        await waitFor(`document.getElementById("go_location").hidden`, "the bar gone, the page having stopped it", 15000);
        await at(3.5);
        await sleep(2000);
        if (/pos 3\.5/.test(await log())) throw new Error(`followed after the page cleared it: ${await log()}`);
        // Followed again, stopped by the person: the page told (its error).
        await frameClick("#follow");
        await asked(true);
        await logged(/pos 3\.5;/, "followed again");
        await waitFor(`!document.getElementById("go_location").hidden`, "the bar again", 10000);
        await ev(`document.querySelector("#go_location .stop").click()`);
        await logged(/error 1;/, "the page told the person stopped it");
        await waitFor(`document.getElementById("go_location").hidden`, "the bar gone", 10000);
        await at(4.5);
        await sleep(2000);
        if (/pos 4\.5/.test(await log())) throw new Error(`followed after the person stopped it: ${await log()}`);
        await cdp("Emulation.clearGeolocationOverride");
        await goTo(site + "index.html", "Fixture");
    });

    await step("files the page shares (navigator.share({ files })): asked once they've come, given to this browser's share sheet as the page made them; a link too", async () => {
        // This browser's share sheet stood in for (headless, it has none),
        // there as /go loads: its capabilities are told as a tab connects.
        const { identifier } = await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
            if (window !== top) return;
            navigator.canShare = (d) => (d?.files ?? []).every((f) => f instanceof File);
            navigator.share = async (d) => {
                const files = await Promise.all((d.files ?? []).map(async (f) => ({ name: f.name, type: f.type, size: f.size, bytes: Array.from(new Uint8Array(await f.arrayBuffer())) })));
                window.__shared = JSON.stringify({ title: d.title, url: d.url, files });
            };
        })()` });
        const reload = async () => {
            await leave(`location.reload();`, { what: "/go again", ready: `document.getElementById("go_progress")?.hidden` });
        };
        try {
            await reload();
            await goTo(site + "index.html", "Fixture");
            await submitUrl(site.replace(/^http:/, "https:") + "share.html");
            await waitFor(`document.title.startsWith("Share") || !document.getElementById("go_cert").hidden`, "the secure page, or its warning", 30000);
            if (!(await ev(`document.getElementById("go_cert").hidden`))) await ev(`document.querySelector("#go_cert .go").click()`);
            await waitFor(`document.title.startsWith("Share")`, "the secure page", 30000);
            await frameWait(`/canShare true;/.test(document.getElementById("log")?.textContent ?? "")`, "files said shareable", 15000);
            await frameClick("#share");
            await waitFor(`!document.getElementById("go_device").hidden && /share sheet with 2 files/.test(document.getElementById("go_device_text").textContent)`, "asked, its files come", 30000)
                .catch(async (err) => { throw new Error(`${err.message}: ${await ev(`document.getElementById("go_device_text").textContent`)}; the page: ${await frame(`document.getElementById("log").textContent`)}`); });
            await ev(`document.querySelector("#go_device .allow").click()`);
            await frameWait(`/shared;/.test(document.getElementById("log")?.textContent ?? "")`, "the page told it's shared", 15000);
            const shared = JSON.parse(await ev(`window.__shared`));
            const want = { title: "Notes", files: [{ name: "note.txt", type: "text/plain", size: 19, bytes: Array.from(Buffer.from("hello from the page")) }, { name: "data.bin", type: "application/octet-stream", size: 5, bytes: [1, 2, 3, 4, 5] }] };
            if (JSON.stringify(shared) !== JSON.stringify(want)) throw new Error(`shared ${JSON.stringify(shared)}`);
            // A link, as before.
            await frameClick("#link");
            await waitFor(`!document.getElementById("go_device").hidden`, "asked to share a link", 15000);
            await ev(`document.querySelector("#go_device .allow").click()`);
            await frameWait(`/shared link;/.test(document.getElementById("log")?.textContent ?? "")`, "the link shared", 15000);
            if (JSON.parse(await ev(`window.__shared`)).url !== "https://example.com/") throw new Error(`shared ${await ev(`window.__shared`)}`);
        } finally {
            await cdp("Page.removeScriptToEvaluateOnNewDocument", { identifier });
            await reload().catch(() => {});
        }
        await goTo(site + "index.html", "Fixture");
    });

    await step("files opened and saved by the page (showOpenFilePicker, showSaveFilePicker): asked, this browser's pickers given its types, read and written through the engine", async () => {
        // This browser's pickers stood in for (headless, they'd wait on a
        // dialog): a file to open, and a destination kept in memory.
        const { identifier } = await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
            if (window !== top) return;
            window.showOpenFilePicker = async (opts) => {
                window.__openOpts = JSON.stringify(opts);
                return [{ kind: "file", name: "notes.txt", getFile: async () => new File(["hello from your device"], "notes.txt", { type: "text/plain", lastModified: 1700000000000 }) }];
            };
            window.showSaveFilePicker = async (opts) => {
                window.__saveOpts = JSON.stringify(opts);
                let data = new Uint8Array(0);
                const h = { kind: "file", name: opts.suggestedName, getFile: async () => new File([data], h.name, { type: "text/plain" }),
                    createWritable: async ({ keepExistingData } = {}) => {
                        let buf = keepExistingData ? data.slice() : new Uint8Array(0), size = buf.length;
                        return {
                            write: async (p) => {
                                const end = p.position + p.data.length;
                                if (end > buf.length) { const n = new Uint8Array(Math.max(end, buf.length * 2)); n.set(buf); buf = n; size = end; }
                                buf.set(p.data, p.position);
                                size = Math.max(size, end);
                            },
                            truncate: async (to) => { const n = new Uint8Array(to); n.set(buf.subarray(0, Math.min(to, size))); buf = n; size = to; },
                            close: async () => { data = buf.slice(0, size); window.__saved = data.length; },
                            abort: async () => {},
                        };
                    } };
                return h;
            };
        })()` });
        const reload = async () => {
            await leave(`location.reload();`, { what: "/go again", ready: `document.getElementById("go_progress")?.hidden` });
        };
        const log = () => frame(`document.getElementById("log")?.textContent ?? ""`);
        const logged = (re, what, ms = 30000) => frameWait(`${re}.test(document.getElementById("log")?.textContent ?? "")`, what, ms)
            .catch(async (err) => { throw new Error(`${err.message}: the page: ${await log()}; asked: ${await ev(`document.getElementById("go_device_text").textContent`)}`); });
        const allow = async (re) => {
            await waitFor(`!document.getElementById("go_device").hidden && ${re}.test(document.getElementById("go_device_text").textContent)`, "asked", 20000)
                .catch(async (err) => { throw new Error(`${err.message}: ${await ev(`document.getElementById("go_device_text").textContent`)}; the page: ${await log()}`); });
            await ev(`document.querySelector("#go_device .allow").click()`);
        };
        try {
            await reload();
            await goTo(site + "index.html", "Fixture");
            await submitUrl(site.replace(/^http:/, "https:") + "fsa.html");
            await waitFor(`document.title.startsWith("Pickers") || !document.getElementById("go_cert").hidden`, "the secure page, or its warning", 30000);
            if (!(await ev(`document.getElementById("go_cert").hidden`))) await ev(`document.querySelector("#go_cert .go").click()`);
            await waitFor(`document.title.startsWith("Pickers")`, "the secure page", 30000);
            await logged(/pickers function function;/, "the pickers given the page", 15000);
            // Opened: the person asked, their picker given the page's types;
            // the file read by the page (twice: staged once).
            await frameClick("#open");
            await allow(/wants to choose files/);
            await logged(/read file notes\.txt 22 true "hello from your device";again "hello from your device";may write prompt;not written NotAllowedError;/, "the file read by the page, not written");
            const types = JSON.parse(await ev(`window.__openOpts`)).types;
            if (JSON.stringify(types) !== JSON.stringify([{ description: "Text", accept: { "text/plain": [".txt"] } }])) throw new Error(`the picker given ${JSON.stringify(types)}`);
            // Saved: written in pieces, cut, then read back from its handle.
            await frameClick("#save");
            await allow(/wants to choose where to save/);
            let sum = 0;
            const want = Buffer.concat([Buffer.from("hello world"), Buffer.from(Array.from({ length: 2000000 }, (_, i) => i % 251)), Buffer.from("TAIL")]);
            for (const b of want) sum = (sum * 31 + b) >>> 0;
            const started = Date.now();
            await logged(new RegExp(`saved out\\.txt ${want.length} ${sum};`), "the file saved and read back", 60000);
            console.log(`     (saved ${want.length} bytes in ${Date.now() - started} ms)`);
            if (JSON.parse(await ev(`window.__saveOpts`)).suggestedName !== "out.txt" || (await ev(`window.__saved`)) !== want.length) throw new Error(`saved as ${await ev(`window.__saveOpts`)}, ${await ev(`window.__saved`)} bytes`);
        } finally {
            await cdp("Page.removeScriptToEvaluateOnNewDocument", { identifier });
            await reload().catch(() => {});
        }
        await goTo(site + "index.html", "Fixture");
    });

    await step("the page's fullscreen: its element over the window and the page alone over the screen after a press; left by Esc, the page or the menu, the page told; not long after a press; in another origin's frame", async () => {
        const full = () => ev(`document.documentElement.classList.contains("go-fullscreen")`);
        // The copy's element over the frame's whole window (the engine's,
        // at the frame's size, as it's laid out).
        const covers = (sel) => `(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return !!r && r.left <= 0.5 && r.top <= 0.5 && r.width >= innerWidth - 1 && r.height >= innerHeight - 1; })()`;
        await goTo(site + "fullscreen.html", "Fullscreen");
        await frameWait(`!!document.getElementById("fs")`, "the page's buttons");
        // Asked for after a press: allowed.
        await frameClick("#fs");
        await frameWait(`document.getElementById("result")?.textContent === "full true" && document.getElementById("change")?.textContent === "change player"`, "the page told it's fullscreen", 15000);
        await waitFor(`document.documentElement.classList.contains("go-fullscreen")`, "the page alone over the screen", 10000);
        await frameWait(covers("#player"), "its player over the whole window", 15000);
        // Esc: left, the page told, the screen back.
        await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
        await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
        await frameWait(`document.getElementById("change")?.textContent === "change none"`, "the page told Esc left it", 15000);
        await waitFor(`!document.documentElement.classList.contains("go-fullscreen")`, "the screen back", 10000);
        // Left by the page itself.
        await frameClick("#fs");
        await frameWait(`document.getElementById("change")?.textContent === "change player"`, "fullscreen again", 15000);
        await waitFor(`document.documentElement.classList.contains("go-fullscreen")`, "the page alone again", 10000);
        await frameClick("#exit");
        await frameWait(`document.getElementById("change")?.textContent === "change none"`, "left by the page", 15000);
        await waitFor(`!document.documentElement.classList.contains("go-fullscreen")`, "the screen back, the page having left it", 10000);
        // Left from the menu's exit.
        await frameClick("#fs");
        await waitFor(`document.documentElement.classList.contains("go-fullscreen")`, "the page alone a third time", 15000);
        await ev(`document.getElementById("go_exit_fullscreen").click()`);
        await frameWait(`document.getElementById("change")?.textContent === "change none"`, "the page told the person left it", 15000);
        // Long after its press: refused.
        await frameClick("#late");
        await frameWait(`/^late refused/.test(document.getElementById("result")?.textContent)`, "a fullscreen long after the press refused", 20000);
        if (await full()) throw new Error("a fullscreen long after the press was shown");
        // In another origin's frame: its element over its window, its
        // iframe over the page's.
        await goTo(site + "fullscreen.html?frame", "Fullscreen");
        const inner = (expr) => frame(`(() => { const root = document.getElementById("x")?.shadowRoot; return root ? (${expr})(root) : null; })()`);
        await frameWait(`!!document.getElementById("x")?.shadowRoot?.querySelector("#b")`, "the embedded page's copy", 20000);
        const p = JSON.parse(await inner(`(root) => { const b = root.querySelector("#b").getBoundingClientRect(); return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2 }); }`));
        const f = await viewOrigin();
        for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: f.x + p.x, y: f.y + p.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
        await waitFor(`document.documentElement.classList.contains("go-fullscreen")`, "the page alone, for its frame's element", 15000);
        await frameWait(covers("#x"), "the frame over the page's whole window", 15000);
        await frameWait(`document.getElementById("x")?.shadowRoot?.querySelector("#s")?.textContent === "full"`, "the frame's page told (its promise kept)", 15000);
        await ev(`document.getElementById("go_exit_fullscreen").click()`);
        await frameWait(`document.getElementById("x")?.shadowRoot?.querySelector("#s")?.textContent === "change none"`, "the frame's page told it was left", 15000);
        await frameWait(`!(${covers("#x")})`, "the frame back in its place", 15000);
        await goTo(site + "index.html", "Fixture");
    });

    await step("the page's screen wake lock: held here after a press, let go with its sentinel, released as it's lost here, let go as its page goes; not long after a press", async () => {
        if (!(await ev(`typeof navigator.wakeLock?.request === "function"`))) return "this browser has no wake lock";
        const secure = async (page, title) => {
            await goTo(site + "index.html", "Fixture");
            await submitUrl(site.replace(/^http:/, "https:") + page);
            await waitFor(`document.title.startsWith(${JSON.stringify(title)}) || !document.getElementById("go_cert").hidden`, "the secure page, or its warning", 30000);
            if (!(await ev(`document.getElementById("go_cert").hidden`))) await ev(`document.querySelector("#go_cert .go").click()`);
            await waitFor(`document.title.startsWith(${JSON.stringify(title)})`, "the secure page", 30000);
        };
        // (This browser's own, recorded; failing when told to.)
        await ev(`(() => { window.__wake = []; window.__wakeFails = false; Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request: async (type) => {
            if (window.__wakeFails) { window.__wake.push("refused"); throw new DOMException("no", "NotAllowedError"); }
            window.__wake.push("request " + type);
            const t = new EventTarget();
            t.release = async () => { window.__wake.push("release"); t.dispatchEvent(new Event("release")); };
            return t;
        } } }); return true; })()`);
        const wake = () => ev(`window.__wake.join(",")`);
        await secure("wakelock.html", "Wake lock");
        await frameWait(`!!document.getElementById("hold")`, "the page's buttons");
        await frameClick("#hold");
        await frameWait(`document.getElementById("r")?.textContent === "held screen false true"`, "the page's sentinel", 15000);
        await waitFor(`window.__wake.join(",") === "request screen"`, "this browser's held", 10000);
        await frameClick("#release");
        await frameWait(`document.getElementById("e")?.textContent === "released true 1"`, "the page's let go");
        await waitFor(`window.__wake.join(",") === "request screen,release"`, "this browser's let go", 10000);
        // Not held here: the page's released.
        await ev(`window.__wakeFails = true`);
        await frameClick("#hold");
        await frameWait(`document.getElementById("e")?.textContent === "released true 2"`, "the page's released, as it couldn't be held here", 15000);
        await ev(`window.__wakeFails = false`);
        // Held, then the page left: let go.
        await frameClick("#hold");
        await waitFor(`window.__wake.filter((w) => w === "request screen").length === 2`, "held again", 10000);
        await goTo(site + "index.html", "Fixture");
        await waitFor(`window.__wake.at(-1) === "release"`, "let go as its page went", 10000);
        // Long after its press: refused.
        await secure("wakelock.html", "Wake lock");
        await frameWait(`!!document.getElementById("late")`, "the page's buttons");
        await frameClick("#late");
        await frameWait(`document.getElementById("r")?.textContent === "refused NotAllowedError"`, "a wake lock long after the press refused", 20000);
        await goTo(site + "index.html", "Fixture");
        return await wake();
    });

    await step("the page's permissions say what's given here: the location asked for, the clipboard's write granted and read asked for, a wake lock and the pointer's granted, a camera or the like denied; on an http page, what needs a secure one denied", async () => {
        const read = async () => {
            await frameWait(`document.getElementById("out")?.textContent.startsWith("{")`, "the page's permissions", 15000);
            return JSON.parse(await frame(`document.getElementById("out").textContent`));
        };
        const want = (got, w, where) => {
            for (const [k, v] of Object.entries(w)) if (got[k] !== v) throw new Error(`${where}: ${k} is ${got[k]}, not ${v} (${JSON.stringify(got)})`);
        };
        await goTo(site + "perms.html", "Perms");
        want(await read(), { geolocation: "denied", "clipboard-read": "denied", "clipboard-write": "denied", camera: "denied", microphone: "denied", "screen-wake-lock": "denied", "pointer-lock": "granted", midi: "denied", push: "NotSupportedError", "push+uvo": "denied" }, "an http page");
        await goTo(site + "index.html", "Fixture");
        await submitUrl(site.replace(/^http:/, "https:") + "perms.html");
        await waitFor(`document.title.startsWith("Perms") || !document.getElementById("go_cert").hidden`, "the secure page, or its warning", 30000);
        if (!(await ev(`document.getElementById("go_cert").hidden`))) await ev(`document.querySelector("#go_cert .go").click()`);
        await waitFor(`document.title.startsWith("Perms")`, "the secure page", 30000);
        const location = await ev(`"geolocation" in navigator`);
        want(await read(), { geolocation: location ? "prompt" : "denied", notifications: "prompt", "clipboard-read": "prompt", "clipboard-write": "granted", camera: "denied",
            "screen-wake-lock": "granted", "pointer-lock": "granted", "persistent-storage": "granted", push: "NotSupportedError", "push+uvo": "denied" }, "an https page");
        await goTo(site + "index.html", "Fixture");
    });

    await step("the page's pointer lock: locked here after a press, the page told; its moves as movement, its presses and clicks on the locked element; left here (Esc), the page told; left by the page, left here; not long after a press", async () => {
        // (This browser's own lock stood in for in the copy, as a headless
        // one may not lock: recorded, its events as a browser's.)
        const stand = () => frame(`(() => { window.__lock = []; let on = false;
            Object.defineProperty(document, "pointerLockElement", { configurable: true, get: () => (on ? document.documentElement : null) });
            Element.prototype.requestPointerLock = function () { window.__lock.push("lock"); on = true; document.dispatchEvent(new Event("pointerlockchange")); return Promise.resolve(); };
            document.exitPointerLock = () => { window.__lock.push("exit"); on = false; document.dispatchEvent(new Event("pointerlockchange")); };
            return true; })()`);
        // First this browser's own lock, as it may be had here (the copy's
        // sandbox and policy allow it): said which.
        await cdp("Emulation.setFocusEmulationEnabled", { enabled: true });
        await goTo(site + "lock.html", "Lock");
        await frameWait(`!!document.getElementById("pad")`, "the pad");
        await frameClick("#pad");
        let real = "this browser's own lock not had here";
        for (let end = Date.now() + 6000; Date.now() < end; await sleep(200)) {
            const r = await frame(`document.getElementById("r").textContent`);
            if (r === "locked true") {
                real = "this browser's own lock had here";
                if ((await frame(`document.pointerLockElement === document.documentElement`)) !== true) throw new Error("the page told it's locked, the copy not");
                await frame(`document.exitPointerLock()`);
                await frameWait(`document.getElementById("c")?.textContent === "2 off"`, "the page told its real lock's left", 15000);
                break;
            }
            if (r.startsWith("refused")) break;
        }
        await goTo(site + "lock.html", "Lock");
        await frameWait(`!!document.getElementById("pad")`, "the pad");
        await stand();
        await frameClick("#pad");
        await frameWait(`document.getElementById("r")?.textContent === "locked true"`, "the page told it's locked", 15000)
            .catch(async (err) => { throw new Error(`${err.message}: ${await frame(`document.getElementById("r").textContent`)}, here ${await frame(`window.__lock.join(",")`)}`); });
        if ((await frame(`window.__lock.join(",")`)) !== "lock") throw new Error(`here: ${await frame(`window.__lock.join(",")`)}`);
        // Moves, as movement (the pointer moved by this browser's input).
        const f = await viewOrigin();
        const pad = JSON.parse(await frame(`(() => { const b = document.getElementById("pad").getBoundingClientRect(); return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2 }); })()`));
        for (let i = 1; i <= 6; i++) {
            await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: f.x + pad.x + i * 5, y: f.y + pad.y + i * 3 });
            await sleep(30);
        }
        await frameWait(`(() => { const [x, y] = document.getElementById("m").textContent.split(",").map(Number); return x >= 20 && y >= 12; })()`, "its moves as movement", 15000)
            .catch(async (err) => { throw new Error(`${err.message}: ${await frame(`document.getElementById("m").textContent`)}`); });
        // A press and release: a click on the locked element.
        for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: f.x + pad.x, y: f.y + pad.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
        await frameWait(`document.getElementById("k")?.textContent === "1"`, "a click on the locked element", 15000);
        // Left here (Esc): the page told.
        await frame(`document.exitPointerLock()`);
        await frameWait(`document.getElementById("c")?.textContent === "2 off"`, "the page told it's left", 15000);
        // Locked again; left by the page (a right press): left here.
        await frameClick("#pad");
        await frameWait(`document.getElementById("c")?.textContent === "3 on"`, "locked again", 15000);
        for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: f.x + pad.x, y: f.y + pad.y, button: "right", buttons: type === "mousePressed" ? 2 : 0, clickCount: 1 });
        await frameWait(`document.getElementById("c")?.textContent === "4 off"`, "left by the page", 15000);
        await frameWait(`window.__lock.at(-1) === "exit"`, "left here too", 15000);

        // Long after its press: refused.
        await frameClick("#late");
        await frameWait(`document.getElementById("r")?.textContent === "refused NotAllowedError"`, "a lock long after the press refused", 20000);
        await goTo(site + "index.html", "Fixture");
        return real;
    });

    await step("the page's screen orientation lock: refused out of its fullscreen; in it, this screen locked so, the page told; unlocked as its fullscreen's left", async () => {
        // (This browser's own lock, recorded; its fullscreen as the page's
        // is here, which a headless browser may not truly have.)
        await ev(`(() => { window.__orient = []; const o = screen.orientation;
            Object.defineProperty(o, "lock", { configurable: true, value: async (t) => { window.__orient.push("lock " + t); } });
            Object.defineProperty(o, "unlock", { configurable: true, value: () => { window.__orient.push("unlock"); } });
            if (!document.fullscreenElement) Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => document.documentElement.classList.contains("go-fullscreen") ? document.body : null });
            return true; })()`);
        await goTo(site + "fullscreen.html", "Fullscreen");
        await frameWait(`!!document.getElementById("lock")`, "the page's buttons");
        await frameClick("#lock");
        await frameWait(`document.getElementById("o")?.textContent === "lock SecurityError"`, "a lock out of fullscreen refused", 15000);
        await frameClick("#fs");
        await waitFor(`document.documentElement.classList.contains("go-fullscreen")`, "the page alone over the screen", 15000);
        await frameClick("#lock");
        await frameWait(`document.getElementById("o")?.textContent === "lock ok"`, "the lock, the page told", 15000)
            .catch(async (err) => { throw new Error(`${err.message}: ${await frame(`document.getElementById("o").textContent`)}, this browser ${await ev(`window.__orient.join(",")`)}`); });
        if ((await ev(`window.__orient.join(",")`)) !== "lock landscape") throw new Error(`this browser: ${await ev(`window.__orient.join(",")`)}`);
        await frameClick("#exit");
        await waitFor(`window.__orient.includes("unlock")`, "unlocked as its fullscreen was left", 15000);
        await ev(`delete document.fullscreenElement`);
        await goTo(site + "index.html", "Fixture");
    });

    await step("the page's app badge: its count, or a mark, before the tab's title and on this app's badge; cleared, and as its page goes; a count that isn't one refused", async () => {
        // This browser's app badge stood in for (recorded).
        await ev(`window.__badges = []; navigator.setAppBadge = (n) => { window.__badges.push(n === undefined ? "mark" : String(n)); return Promise.resolve(); };
            navigator.clearAppBadge = () => { window.__badges.push("clear"); return Promise.resolve(); };`);
        // (A secure page's only, as in browsers: over HTTPS, its warning passed.)
        await goTo(site + "index.html", "Fixture");
        await submitUrl(site.replace(/^http:/, "https:") + "badge.html");
        await waitFor(`document.title.startsWith("Badge") || !document.getElementById("go_cert").hidden`, "the secure page, or its warning", 30000);
        if (!(await ev(`document.getElementById("go_cert").hidden`))) await ev(`document.querySelector("#go_cert .go").click()`);
        await frameWait(`document.getElementById("log")?.textContent.includes("api function function")`, "the page's badge API", 30000)
            .catch(async (err) => { throw new Error(`${err.message}: ${await frame(`document.getElementById("log")?.textContent`)}`); });
        const badge = (title, last, what) => waitFor(`document.title === ${JSON.stringify(title)} && window.__badges.at(-1) === ${JSON.stringify(last)}`, what, 15000)
            .catch(async (err) => { throw new Error(`${err.message}: ${await ev(`JSON.stringify([document.title, window.__badges])`)}`); });
        await frameClick("#three");
        await badge("(3) Badge – Browser", "3", "its count before the title, and on the app's badge");
        await frameClick("#mark");
        await badge("• Badge – Browser", "mark", "its mark");
        await frameClick("#clear");
        await badge("Badge – Browser", "clear", "cleared");
        await frameClick("#bad");
        await frameWait(`document.getElementById("log").textContent.includes("bad TypeError")`, "a count that isn't one refused");
        await frameClick("#three");
        await badge("(3) Badge – Browser", "3", "its count again");
        await goTo(site + "index.html", "Fixture");
        await waitFor(`document.title === "Fixture – Browser" && window.__badges.at(-1) === "clear"`, "cleared as its page went", 15000)
            .catch(async (err) => { throw new Error(`${err.message}: ${await ev(`JSON.stringify([document.title, window.__badges])`)}`); });
    });

    await step("the page's media session: what it's playing (its artwork fetched by the server), its state, and its controls, this browser's; pressed, the page's handlers called; one it drops gone; cleared as its page goes", async () => {
        // This browser's handlers recorded (as its media keys would call them).
        await ev(`window.__handlers = {}; { const s = navigator.mediaSession, own = s.setActionHandler.bind(s);
            s.setActionHandler = (a, h) => { if (h) window.__handlers[a] = h; else delete window.__handlers[a]; try { own(a, h); } catch { /* not this browser's */ } }; }`);
        await goTo(site + "mediasession.html", "Media session");
        await frameWait(`document.getElementById("log")?.textContent.includes("refused TypeError,TypeError,TypeError;")`, "what isn't one refused in the page")
            .catch(async (err) => { throw new Error(`${err.message}: ${await frame(`document.getElementById("log")?.textContent`)}`); });
        await frameClick("#go");
        const session = `JSON.stringify({ title: navigator.mediaSession.metadata?.title, artist: navigator.mediaSession.metadata?.artist, album: navigator.mediaSession.metadata?.album,
            art: (navigator.mediaSession.metadata?.artwork ?? []).map((i) => i.src.slice(0, 22) + " " + i.sizes), state: navigator.mediaSession.playbackState, handlers: Object.keys(window.__handlers).sort() })`;
        const shows = (want, what) => waitFor(`${session} === ${JSON.stringify(JSON.stringify(want))}`, what, 15000)
            .catch(async (err) => { throw new Error(`${err.message}: ${await ev(session)}; the page: ${await frame(`document.getElementById("log").textContent`)}`); });
        await shows({ title: "Song", artist: "Band", album: "Record", art: ["data:image/png;base64, 8x8"], state: "playing", handlers: ["nexttrack", "pause", "play", "seekto"] },
            "this browser's session: the page's, its artwork fetched");
        await ev(`window.__handlers.nexttrack({ action: "nexttrack" })`);
        await ev(`window.__handlers.seekto({ action: "seekto", seekTime: 2.5 })`);
        await frameWait(`document.getElementById("log").textContent.includes("nexttrack;seekto 2.5;")`, "the page's handlers called, with their details")
            .catch(async (err) => { throw new Error(`${err.message}: ${await frame(`document.getElementById("log").textContent`)}`); });
        await frameClick("#drop");
        await shows({ title: "Song 2", artist: "Band", album: "Record", art: ["data:image/png;base64, 8x8"], state: "playing", handlers: ["pause", "play", "seekto"] },
            "the handler it dropped gone, its title changed");
        await goTo(site + "index.html", "Fixture");
        await waitFor(`!navigator.mediaSession.metadata && navigator.mediaSession.playbackState === "none" && Object.keys(window.__handlers).length === 0`, "cleared as its page went", 15000)
            .catch(async (err) => { throw new Error(`${err.message}: ${await ev(session)}`); });
    });

    await step("the page's vibration: felt here after a press (its pattern within reason), cancelled, and as its page goes; not long after a press; not another origin's frame's", async () => {
        // (This browser's own, recorded.)
        const felt = () => ev(`window.__felt.slice()`);
        const record = () => ev(`(() => { window.__felt = []; Object.defineProperty(navigator, "vibrate", { configurable: true, value: (p) => { window.__felt.push(JSON.stringify(p)); return true; } }); return true; })()`);
        await goTo(site + "vibrate.html", "Vibrate");
        await frameWait(`!!document.getElementById("buzz")`, "the page's buttons");
        await record();
        await frameClick("#buzz");
        await frameWait(`document.getElementById("r")?.textContent === "buzz true"`, "the page told it's felt");
        await waitFor(`window.__felt.includes("[200,100,300]")`, "its pattern felt here", 10000);
        // One too long: 99 entries, 10 s in all.
        await sleep(400);
        await frameClick("#long");
        await waitFor(`window.__felt.length >= 2`, "the long pattern, cut", 10000);
        const long = JSON.parse((await felt())[1]);
        if (!long.length || long.length > 99 || long.reduce((a, b) => a + b, 0) > 10000 || long[0] !== 10000) throw new Error(`the long pattern felt as ${JSON.stringify(long)}`);
        // Cancelled.
        await frameClick("#stop");
        await waitFor(`window.__felt.at(-1) === "[]" || window.__felt.at(-1) === "0"`, "the vibration cancelled", 10000);
        // Long after its press: not felt.
        const before = (await felt()).length;
        await frameClick("#late");
        await frameWait(`document.getElementById("r")?.textContent === "late true"`, "the late one asked", 15000);
        await sleep(1500);
        if ((await felt()).length !== before) throw new Error(`felt long after the press: ${JSON.stringify((await felt()).slice(before))}`);
        // Felt, then the page left: stopped.
        await sleep(300);
        await frameClick("#buzz");
        await waitFor(`window.__felt.filter((p) => p === "[200,100,300]").length === 2`, "felt again", 10000);
        const left = (await felt()).length;
        await goTo(site + "index.html", "Fixture");
        await waitFor(`window.__felt.slice(${left}).includes("0")`, "the vibration stopped as its page went", 10000);
        // Another origin's frame: false, and nothing felt.
        await goTo(site + "vibrate.html?frame", "Vibrate");
        await record();
        const inner = (expr) => frame(`(() => { const root = document.getElementById("x")?.shadowRoot; return root ? (${expr})(root) : null; })()`);
        await frameWait(`!!document.getElementById("x")?.shadowRoot?.querySelector("#b")`, "the embedded page's copy", 20000);
        const p = JSON.parse(await inner(`(root) => { const b = root.querySelector("#b").getBoundingClientRect(); return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2 }); }`));
        const f = await viewOrigin();
        for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: f.x + p.x, y: f.y + p.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
        await frameWait(`document.getElementById("x")?.shadowRoot?.querySelector("#s")?.textContent === "frame false"`, "another origin's frame told it's not felt", 15000);
        await sleep(1500);
        if ((await felt()).some((p) => p !== "0" && p !== "[]")) throw new Error(`another origin's frame's felt: ${JSON.stringify(await felt())}`);
        await goTo(site + "index.html", "Fixture");
    });

    await step("no request left this browser except to TabTop", async () => {
        const elsewhere = requests.filter((u) => !u.startsWith(origin + "/") && !/^(data|blob|about|chrome|devtools):/.test(u));
        if (elsewhere.length) throw new Error(`requests elsewhere: ${[...new Set(elsewhere)].join(", ")}`);
        return `${requests.length} requests, all to ${origin}`;
    });

    // (Last: it leaves this browser's page at the file, not /go.)
    await step("the offline client (tabtop.html from the pack, opened as a file): its browser (?page=go) connects by the tunnel alone, logs in, and shows a page in its own frame", async () => {
        const pack = JSON.parse(readFileSync(new URL("../../../tabtopd/bootstrap.client.json", import.meta.url), "utf8"));
        const dir = mkdtempSync(join(tmpdir(), "go-check-offline-"));
        const file = join(dir, "tabtop.html");
        writeFileSync(file, pack.files["tabtop.html"]);
        try {
            await cdp("Page.navigate", { url: `file://${file}?page=go` });
            await waitFor(`!!document.getElementById("server") && !document.getElementById("go").disabled`, "the offline client's form", 15000);
            await ev(`(() => { document.getElementById("server").value = ${JSON.stringify(base)}; document.getElementById("form").requestSubmit(); })()`);
            await waitFor(`!!document.querySelector("#tabtop_login input")`, "its login", 30000)
                .catch(async (err) => { throw new Error(`${err.message}: it shows ${await ev(`document.title + ": " + (document.getElementById("err")?.textContent ?? document.body?.innerText?.slice(0, 300))`)}`); });
            const code = await totp();
            await ev(`(() => { const i = document.querySelector("#tabtop_login input"); i.value = ${JSON.stringify(code)}; i.form.requestSubmit(); })()`);
            await waitFor(`!document.querySelector("#tabtop_login") && !!document.getElementById("go_url")`, "the browser page", 30000);
            await goTo(site + "index.html", "Fixture");
            // The page in its frame (built by the client: srcdoc, sandboxed,
            // so a target of its own at about:srcdoc).
            const shown = () => inFrame("about:srcdoc", `document.getElementById("h")?.textContent ?? ""`).catch((e) => e.message);
            const until = Date.now() + 20000;
            while ((await shown()) !== "Fixture") {
                if (Date.now() > until) throw new Error(`the page's frame shows ${JSON.stringify(await shown())}`);
                await sleep(250);
            }
            // Its other pages (their scripts minified, as all the pack's are)
            // start too, each to its login (any exception the page throws
            // fails the check: see exceptions, at its end).
            for (const page of ["desktop", "terminal", "files"]) {
                await cdp("Page.navigate", { url: `file://${file}?page=${page}${page === "desktop" ? "&autoconnect=1" : ""}` });
                await waitFor(`!!document.getElementById("server") && !document.getElementById("go").disabled`, `the ${page} page's form`, 15000);
                await ev(`(() => { document.getElementById("server").value = ${JSON.stringify(base)}; document.getElementById("form").requestSubmit(); })()`);
                await waitFor(`!!document.querySelector("#tabtop_login input")`, `the ${page} page, to its login`, 30000)
                    .catch(async (err) => { throw new Error(`${err.message}: it shows ${await ev(`document.title + ": " + (document.getElementById("err")?.textContent || document.body?.innerText?.slice(0, 300))`)}`); });
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

}
