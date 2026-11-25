// The remote browser's check (go-check.mjs), its steps of videos and sounds:
// players, saving, phones, autoplay and Skip, prompts, touches and swipes,
// feeds, MediaSource, HLS, blobs, downloads.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { png } from "../go-site.mjs";
import { siteFetch, sleep } from "../harness.mjs";
import { step } from "./step.mjs";

// video runs them, with ctx: the check's browser, the site it browses, and its helpers (see check).
export async function video(ctx) {
    const { cdp, ev, goTo, site, waitFor, frameWait, frame, frameClick, adSite, exceptions, submitUrl, viewOrigin, pageShown, frameDrop, at, stillNot, press } = ctx;
    await step("the page's view is white where a page draws nothing, and a dark page keeps its colour around a video played under it", async () => {
        // A screenshot's pixel, in the view's right half, clear of its notes.
        const viewPixel = async () => {
            const shot = (await cdp("Page.captureScreenshot", { format: "png" })).data;
            const at = await ev(`(() => { const r = document.getElementById("go_view").getBoundingClientRect(); return { x: Math.round(r.right - 40), y: Math.round(r.top + 300) }; })()`);
            return ev(`new Promise((r) => { const i = new Image(); i.onload = () => { const c = document.createElement("canvas"); c.width = i.width; c.height = i.height; const g = c.getContext("2d"); g.drawImage(i, 0, 0); r([...g.getImageData(${at.x}, ${at.y}, 1, 1).data].slice(0, 3).join()); }; i.src = "data:image/png;base64,${shot}"; })`);
        };
        await goTo(site + "second.html", "Second");
        await sleep(500);
        if (await viewPixel() !== "255,255,255") throw new Error(`a page with no background of its own shows ${await viewPixel()}, not white`);
        await goTo(site + "darkvideo.html", "Dark video");
        await waitFor(`document.getElementById("go_view").classList.contains("go-underlaid")`, "the video's player under the copy", 30000);
        await sleep(1000);
        if (await viewPixel() !== "16,32,48") throw new Error(`the dark page shows ${await viewPixel()} around its video, not its own #102030`);
        // Black (its blue 0: not taken for no colour), kept too.
        await goTo(site + "blackvideo.html", "Black video");
        await waitFor(`document.getElementById("go_view").classList.contains("go-underlaid")`, "the black page's video under the copy", 30000);
        await sleep(1000);
        if (await viewPixel() !== "0,0,0") throw new Error(`the black page shows ${await viewPixel()} around its video, not its own black`);
        // Its colour written as oklch() (Tailwind 4's), kept too.
        await goTo(site + "darkvideo-oklch.html", "Oklch video");
        await waitFor(`document.getElementById("go_view").classList.contains("go-underlaid")`, "the oklch page's video under the copy", 30000);
        await sleep(1000);
        const oklch = (await viewPixel()).split(",").map(Number);
        if (!oklch.every((v) => v < 90)) throw new Error(`the oklch() dark page shows ${oklch} around its video, not its own colour`);
    });

    await step("a video in another site's embedded page is seen: the page's backgrounds cleared over it", async () => {
        await goTo(site + "framevideo.html", "Frame video");
        await frameWait(`!!document.getElementById("f")?.shadowRoot?.querySelector("[data-go-video].go-media-live")`, "the embedded page's video, its player made", 30000);
        await frameWait(`(() => { const f = document.getElementById("f"), clear = (el) => /^rgba\\(\\d+, \\d+, \\d+, 0\\)$/.test(getComputedStyle(el).backgroundColor);
            return clear(document.body) && clear(document.documentElement) && clear(f.parentElement); })()`, "the page's backgrounds cleared over it", 15000);
    });

    await step("the wheel turned over a sound's player (laid over the page) scrolls the page", async () => {
        await goTo(site + "audiopage.html", "Audio page");
        await waitFor(`!!document.querySelector("audio")`, "the sound's player, over its box", 30000);
        await sleep(500);
        const p = await ev(`(() => { const r = document.querySelector("audio").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        for (let i = 0; i < 3; i++) {
            await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x: p.x, y: p.y, button: "none", deltaX: 0, deltaY: 200 });
            await sleep(200);
        }
        await frameWait(`scrollY > 100`, "the page scrolled by the wheel over the sound's player");
    });

    await step("a video's box, its style set again by the page as it plays, stays clear over it", async () => {
        await goTo(site + "restyle.html", "Restyle");
        await frameWait(`!!document.querySelector("#clip.go-media-live")`, "the video, its player made", 30000);
        await waitFor(`document.title.startsWith("Restyle done")`, "the page's restyle", 15000);
        await sleep(1000);
        const after = await frame(`getComputedStyle(document.getElementById("box")).backgroundColor`);
        if (after !== "rgba(0, 0, 0, 0)") throw new Error(`the box's background covers the video again: ${after}`);
    });

    await step("a video plays in a player under the copy, its file read through the server", async () => {
        await goTo(site + "video.html", "Video");
        await frameWait(`document.querySelector("#clip[data-go-video]")?.classList.contains("go-media-live")`, "the clip's box, its player made");
        // A plain Blob that isn't media (relayed, gomedia.js): its player says
        // it can't play it; an element with no file, that it has none.
        await frameWait(`!/^Loading|^$/.test(document.getElementById("streamed")?.textContent ?? "")`, "the Blob's box said what came of it", 15000).catch(() => {});
        const notes = await frame(`[document.getElementById("streamed").textContent, document.getElementById("silent").textContent]`);
        if (!/DEMUXER|decode|open|play/i.test(notes[0]) || /own player/.test(notes[0]) || !/nothing to play/.test(notes[1])) throw new Error(`the other boxes say ${JSON.stringify(notes)}`);
        await waitFor(`[...document.querySelectorAll("video")].some((v) => v.readyState >= 1 && Math.abs(v.duration - 5) < 0.5)`, "the player's clip, 5 s", 30000);
        await ev(`document.querySelector("video").play()`);
        await waitFor(`document.querySelector("video").currentTime > 0.5`, "the clip playing", 30000);
        // Aligned with its box, under the transparent frame.
        const over = await ev(`(() => { const v = document.querySelector("video"), f = document.getElementById("go_view");
            const vr = v.getBoundingClientRect(), fr = f.getBoundingClientRect();
            const under = v.parentElement && f.compareDocumentPosition(v.parentElement) & Node.DOCUMENT_POSITION_PRECEDING;
            return under && vr.width > 100 && vr.left >= fr.left && vr.right <= fr.right + 1 && vr.top >= fr.top; })()`);
        if (!over) throw new Error("the player isn't under its box, within the frame");
        // The page in the engine told the file's size and length, as a
        // browser's player would (gomedia.js): the engine has no media.
        await frameWait(`/^[1-9][0-9]*x[1-9][0-9]* 5 s$/.test(document.getElementById("meta").textContent)`, "the page told the video's size and length");
        // The wheel turned over the video hole scrolls the page (hits the frame).
        const y0 = await frame(`scrollY`);
        const p = await ev(`(() => { const r = document.querySelector("video").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x: p.x, y: p.y, button: "none", deltaX: 0, deltaY: 200 });
        await frameWait(`scrollY > ${y0} + 100`, "the page scrolled by the wheel over the player");
        await frame(`scrollTo(0, scrollY + document.getElementById("clip").getBoundingClientRect().top + 50)`);
        await waitFor(`(() => {
            const video = document.querySelector("video"), view = document.getElementById("go_view");
            const rect = video.getBoundingClientRect(), style = getComputedStyle(video);
            return Math.abs(rect.top - view.getBoundingClientRect().top + 50) < 1 &&
                rect.width === 320 && rect.height === 180 && style.clipPath.startsWith("inset(50px") &&
                style.objectFit === "cover" && style.objectPosition === "75% 25%";
        })()`, "the partly scrolled video retains its size and fit");
        await ev(`(() => {
            const v = window.rotatingPlayer = document.querySelector("video");
            v.currentTime = 0;
            return v.play();
        })()`);
        await frame(`window.addEventListener("resize", () => {
            setTimeout(() => {
                const box = document.getElementById("clip");
                const landscape = innerWidth > innerHeight;
                box.style.width = landscape ? "440px" : "280px";
                box.style.height = landscape ? "248px" : "158px";
            }, 120);
        })`);
        try {
            for (const [width, height, type, angle, expected] of [
                [500, 800, "portraitPrimary", 0, 280],
                [900, 500, "landscapePrimary", 90, 440],
                [500, 800, "portraitPrimary", 0, 280],
            ]) {
                await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false, screenOrientation: { type, angle } });
                await frameWait(`document.getElementById("clip").getBoundingClientRect().width === ${expected}`, "the delayed player layout");
                const box = await frame(`(() => { const r = document.getElementById("clip").getBoundingClientRect();
                    return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
                await waitFor(`(() => {
                    const v = window.rotatingPlayer, f = document.getElementById("go_view").getBoundingClientRect();
                    const r = v.getBoundingClientRect(), b = ${JSON.stringify(box)};
                    return v.isConnected && Math.abs(r.x - f.x - b.x) < 1 && Math.abs(r.y - f.y - b.y) < 1 &&
                        Math.abs(r.width - b.w) < 1 && Math.abs(r.height - b.h) < 1 &&
                        b.y < -1 && Math.abs(parseFloat(getComputedStyle(v).clipPath.slice(6)) + b.y) < 1 &&
                        getComputedStyle(v).objectFit === "cover";
                })()`, "the same clipped overlay follows the rotated box");
            }
            const time = await ev(`window.rotatingPlayer.currentTime`);
            await waitFor(`window.rotatingPlayer.currentTime > ${time}`, "playback continues after rotation");
        } finally {
            await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        }
        await goTo(site + "second.html", "Second");
        await waitFor(`!document.querySelector("video")`, "the player gone with its page");
    });

    await step("the menu's videos each have Save: pressed, a ring as it saves, then said saved", async () => {
        await goTo(site + "video.html", "Video");
        await waitFor(`[...document.querySelectorAll("video")].some((v) => v.readyState >= 1)`, "the player", 30000);
        await ev(`document.getElementById("go_menu_panel").hidden && document.getElementById("go_menu").click()`);
        // Download sits left of Watch, the player (Download … Watch … Play/Pause … Skip).
        await waitFor(`!!document.querySelector("#go_menu_media li .acts button")`, "the video in the menu", 15000);
        const order = await ev(`(() => {
            const labels = [...document.querySelector("#go_menu_media li .acts").children].map((b) => b.getAttribute("aria-label") || "");
            const i = (re) => labels.findIndex((l) => re.test(l));
            return { labels: labels.map((l) => l.split(" ")[0]), download: i(/^Download /), watch: i(/^Watch /), play: i(/^(Play|Pause) /), skip: i(/^(Skip|Hide) /) };
        })()`);
        // With Files off there's nowhere to save it: no Download.
        if (process.env.GO_NO_FS === "1") {
            if (order.download >= 0 || order.play < 0) throw new Error(`with Files off, the menu's acts: ${JSON.stringify(order)}`);
            await ev(`document.getElementById("go_menu").click()`);
            return "no Download, Files off";
        }
        if (order.download !== 0 || order.watch !== 1 || order.play !== 2 || order.skip !== 3) {
            throw new Error(`menu acts order (want Download, Watch, Play/Pause, Skip): ${JSON.stringify(order)}`);
        }
        const save = `[...document.querySelectorAll("#go_menu_media li .acts button")].find((b) => /^Download video/.test(b.getAttribute("aria-label")) || /^Cancel/.test(b.getAttribute("aria-label")) || b.classList.contains("saving"))`;
        await waitFor(`!!${save}`, "the clip's Save in the menu");
        await ev(`${save}.click()`);
        let ring = false;
        for (const end = Date.now() + 30000; Date.now() < end; await sleep(50)) {
            const at = await ev(`(() => { const b = ${save}; const n = b?.closest("li").querySelector(".note"); return { saving: !!b?.classList.contains("saving"), note: n?.hidden ? "" : n?.textContent }; })()`);
            ring = ring || at.saving;
            if (/^Saved /.test(at.note || "")) break;
        }
        const said = await ev(`${save}?.closest("li").querySelector(".note").textContent`);
        if (!/^Saved /.test(said)) throw new Error(`the save said ${JSON.stringify(said)}`);
        if (await ev(`${save}.classList.contains("saving")`)) throw new Error("still a ring, saved");
        await ev(`document.getElementById("go_menu").click()`);
        return ring ? "its ring seen" : "saved before its ring was seen";
    });

    await step("a video loading shows so over its box till it can play; the menu has its address", async () => {
        await goTo(site + "slow.html", "Slow video");
        await waitFor(`(() => { const l = document.querySelector(".go-media-loading"); return !!l && !l.hidden && !!l.querySelector(".bar") && /Asking|Loading|Buffering/.test(l.querySelector(".what").textContent); })()`, "the loading box", 15000);
        const over = await ev(`(() => { const l = document.querySelector(".go-media-loading").getBoundingClientRect(), f = document.getElementById("go_view").getBoundingClientRect();
            return Math.round(l.width) === 320 && Math.round(l.height) === 180 && l.left >= f.left && l.top >= f.top; })()`);
        if (!over) throw new Error("the loading box isn't over the video's box");
        // The menu: marked; its list has the video, its site and file name.
        await waitFor(`document.getElementById("go_menu").classList.contains("has-media")`, "the menu marked");
        await ev(`document.getElementById("go_menu").click()`);
        const row = await ev(`(() => { const li = document.querySelector("#go_menu_media li"); return li && { state: li.querySelector(".state").textContent, where: li.querySelector(".where").textContent, title: li.querySelector(".where").title, label: li.querySelector("button").getAttribute("aria-label") }; })()`);
        if (!row || !row.where.endsWith("/clip.mp4?…") || !row.title.endsWith("/clip.mp4?slow") || !row.label.includes("/clip.mp4?slow") || !/Asking|Loading|Buffering/.test(row.state)) throw new Error(`the menu lists ${JSON.stringify(row)}`);
        const head = await ev(`(() => { const h = document.getElementById("go_menu_media_h"); return { text: h.textContent, unseen: h.classList.contains("unseen") }; })()`);
        if (head.unseen || head.text !== "Videos on this page") throw new Error(`the heading with a video: ${JSON.stringify(head)}`);
        await ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
        await waitFor(`!document.querySelector(".go-media-loading") && document.querySelector("video")?.readyState >= 2`, "the video ready, the loading box gone", 60000);
    });

    await step("on a phone, a video loading fits its box, small or not; the menu's list of them fits the screen", async () => {
        await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
        try {
            await goTo(site + "phone.html", "Phone video");
            await waitFor(`document.querySelectorAll(".go-media-loading:not([hidden])").length === 2`, "both loading", 15000);
            await ev(`document.getElementById("go_menu").click()`);
            await waitFor(`document.querySelectorAll("#go_menu_media li").length === 2`, "both in the menu");
            if (process.env.GO_SHOT) writeFileSync(process.env.GO_SHOT, Buffer.from((await cdp("Page.captureScreenshot", { format: "png" })).data, "base64"));
            const got = await ev(`(() => {
                const r = (e) => e.getBoundingClientRect();
                const boxes = [...document.querySelectorAll(".go-media-loading")].sort((a, b) => r(a).top - r(b).top);
                const panel = r(document.getElementById("go_menu_panel"));
                const buttons = [...document.querySelectorAll("#go_menu_media button")].map((b) => Math.round(Math.min(r(b).height, r(b).width)));
                return { fits: boxes.every((b) => b.scrollHeight <= b.clientHeight + 1), small: boxes[1].classList.contains("small"),
                    panel: panel.left >= 0 && panel.right <= innerWidth, buttons };
            })()`);
            if (!got.fits || !got.small || !got.panel || got.buttons.some((h) => h < 44)) throw new Error(`on a phone: ${JSON.stringify(got)}`);
            // Numbered, top first; a row focused outlines its video on the page.
            await ev(`document.querySelectorAll("#go_menu_media li")[1].querySelector("button:not(:disabled)").focus()`);
            const marked = await ev(`(() => { const r = (e) => e.getBoundingClientRect(); const boxes = [...document.querySelectorAll(".go-media-loading")].sort((a, b) => r(a).top - r(b).top);
                return { states: [...document.querySelectorAll("#go_menu_media .state")].map((s) => s.textContent.split(" · ")[0]), outlines: boxes.map((b) => !!b.style.outline) }; })()`);
            if (marked.states.join() !== "Video 1,Video 2" || marked.outlines.join() !== "false,true") throw new Error(`the rows and their videos: ${JSON.stringify(marked)}`);
            await ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
            await waitFor(`!document.querySelector(".go-media-loading")`, "both ready", 60000);
        } finally {
            await cdp("Emulation.setTouchEmulationEnabled", { enabled: false });
            await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        }
    });

    await step("a video playing, the phone turned: its player stays shown, and on its box, after a quarter or a half turn", async () => {
        const turn = (w, h, type, angle) => cdp("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: true, screenOrientation: { type, angle } });
        await turn(390, 844, "portraitPrimary", 0);
        await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
        // Where the player is against its box (in the frame, so asked of it).
        const offBy = async () => {
            const box = await frame(`(() => { const r = document.getElementById("v").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
            return ev(`(() => { const f = document.getElementById("go_view").getBoundingClientRect(), v = document.querySelector("video").getBoundingClientRect(), b = ${JSON.stringify(box)};
                return Math.max(Math.abs(v.x - f.x - b.x), Math.abs(v.y - f.y - b.y), Math.abs(v.width - b.w), Math.abs(v.height - b.h)); })()`);
        };
        // Frames the player wasn't shown in, from now.
        const watch = () => ev(`(() => { window.__hidden = 0; window.__watching = true; const tick = () => { const v = document.querySelector("video"); if (!v || getComputedStyle(v).display === "none") __hidden++; if (__watching) requestAnimationFrame(tick); }; requestAnimationFrame(tick); return 0; })()`);
        const watched = () => ev(`(() => { __watching = false; return __hidden; })()`);
        let insets = false;
        try {
            await goTo(site + "rotate.html", "Rotate");
            await waitFor(`(() => { const v = document.querySelector("video"); return !!v && !v.paused && v.currentTime > 0.3 && getComputedStyle(v).display !== "none"; })()`, "the video playing, shown", 30000);
            const found = [];
            // A quarter turn.
            await watch();
            await turn(844, 390, "landscapePrimary", 90);
            await sleep(1500);
            const quarter = { hidden: await watched(), off: await offBy() };
            found.push(`quarter turn: hidden ${quarter.hidden} frames, off by ${Math.round(quarter.off)} px`);
            if (quarter.hidden > 0 || quarter.off > 1) throw new Error(found.join("; "));
            // A half turn, a notch's side swapped (where the browser can say).
            insets = (await cdp("Emulation.setSafeAreaInsetsOverride", { insets: { left: 47, right: 0, top: 0, bottom: 0 } }).then(() => true, () => false));
            if (insets) {
                await sleep(1000);
                const before = Math.round(await offBy());
                await watch();
                await cdp("Emulation.setSafeAreaInsetsOverride", { insets: { left: 0, right: 47, top: 0, bottom: 0 } });
                await turn(844, 390, "landscapeSecondary", 270);
                await sleep(1500);
                const half = { hidden: await watched(), off: await offBy() };
                found.push(`half turn: off by ${before} px before, hidden ${half.hidden} frames, off by ${Math.round(half.off)} px after`);
                if (before > 1 || half.hidden > 0 || half.off > 1) throw new Error(found.join("; "));
            } else {
                found.push("half turn: this browser can't emulate a notch");
            }
            return found.join("; ");
        } finally {
            if (insets) await cdp("Emulation.setSafeAreaInsetsOverride", { insets: {} }).catch(() => {});
            await cdp("Emulation.setTouchEmulationEnabled", { enabled: false });
            await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        }
    });

    await step("the menu's autoplay switch pauses every video and holds pages back; its player: full screen, speed, back, given back as closed", async () => {
        await goTo(site + "auto.html", "Autoplay");
        await waitFor(`(() => { const v = document.querySelector("video"); return !!v && !v.paused && v.currentTime > 0.3; })()`, "the page's video playing", 30000);
        // (Opened, not toggled: a step before may have left it open.)
        await ev(`document.getElementById("go_menu_panel").hidden && document.getElementById("go_menu").click()`);
        await waitFor(`!!document.querySelector("#go_menu_media li") && document.getElementById("go_menu_autoplay").getAttribute("aria-checked") === "true"`, "the menu's videos");
        // Autoplay paused: the video paused, its page told; the page
        // playing it again held back; played from the menu, it plays.
        // (Pressed where it is once the menu's list has settled: rows drawn
        // as the players report move it.)
        for (let last = "", end = Date.now() + 5000; Date.now() < end; await sleep(150)) {
            const at = await ev(`JSON.stringify(document.getElementById("go_menu_autoplay").getBoundingClientRect())`);
            if (at === last) break;
            last = at;
        }
        await press("#go_menu_autoplay");
        try {
            await waitFor(`document.querySelector("video").paused && document.getElementById("go_menu_autoplay").getAttribute("aria-checked") === "false"`, "paused by the switch");
            await frameWait(`document.getElementById("out").textContent === "pause paused"`, "the page told it's paused");
            await frameClick("#again");
            await sleep(1500);
            if (!(await ev(`document.querySelector("video").paused`))) throw new Error("the page played it, autoplay paused");
            await ev(`document.getElementById("go_menu").click()`);
            await waitFor(`!!document.querySelector("#go_menu_media li .acts button")`, "the menu again");
            await ev(`[...document.querySelectorAll("#go_menu_media li .acts button")].find((b) => /^Play /.test(b.getAttribute("aria-label") || "")).click()`);
            await waitFor(`!document.querySelector("video").paused`, "played from the menu");
        } finally {
            await ev(`(() => { if (document.getElementById("go_menu_panel").hidden) document.getElementById("go_menu").click(); const b = document.getElementById("go_menu_autoplay"); if (b.getAttribute("aria-checked") === "false") b.click(); })()`);
        }
        // The player: the video taken into it, full screen, kept to its
        // proportions; its speed and back 10 s; closed, given back.
        // The first video's Watch (after its Download, with Files on), pressed
        // once it's offered (any's offered, the first's could still be loading).
        await waitFor(`(() => { const b = document.querySelector("#go_menu_media li .acts button[data-act=watch]"); return /^Watch /.test(b?.getAttribute("aria-label") || "") && !b.disabled; })()`, "Watch offered for the first video");
        await press("#go_menu_media li .acts button[data-act=watch]");
        await waitFor(`!!document.querySelector("#video_player .stage video") && document.fullscreenElement?.id === "video_player"`, "the video in the player, full screen", 10000);
        const shape = await ev(`(() => { const v = document.querySelector("#video_player video"); return { fit: getComputedStyle(v).objectFit, controls: v.controls }; })()`);
        if (shape.fit !== "contain" || shape.controls) throw new Error(`in the player: ${JSON.stringify(shape)}`);
        // Its controls hidden as it plays untouched; a tap where its play
        // button is (unseen) shows them, and doesn't pause it.
        await ev(`document.querySelector("#video_player video").play()`);
        await waitFor(`!document.getElementById("video_player").classList.contains("awake") && !document.querySelector("#video_player video").paused`, "its controls hidden, playing", 8000);
        await press('#video_player .glyph.big', { unseen: true });
        await waitFor(`document.getElementById("video_player").classList.contains("awake")`, "its controls shown by the tap");
        if (await ev(`document.querySelector("#video_player video").paused`)) throw new Error("a tap on its hidden controls paused it");
        await ev(`(() => { const s = document.querySelector("#video_player .speed"); s.value = "2"; s.dispatchEvent(new Event("change")); })()`);
        if ((await ev(`document.querySelector("#video_player video").playbackRate`)) !== 2) throw new Error("its speed wasn't set");
        await ev(`document.querySelector("#video_player video").currentTime = 3`);
        await waitFor(`document.querySelector("#video_player video").currentTime >= 3`, "at 3 s");
        await press('#video_player button[aria-label^="Back"]');
        await waitFor(`document.querySelector("#video_player video").currentTime < 2`, "back 10 s (to its start)");
        // A double tap at the right: on 10 s (to its end), marked there.
        // Download: offered where Files are on (it saves into Downloads), not where they're off.
        const offered = await ev(`!!document.querySelector('#video_player button[aria-label^="Download"]')`);
        if (offered !== (process.env.GO_NO_FS !== "1")) throw new Error(`Download ${offered ? "offered, Files off" : "not offered"}`);
        if (offered) {
            // Saved, it's asked for as it was played: the tab's user agent, the site's cookies, the page as Referer.
            const told = async () => JSON.parse((await (await siteFetch(site + "seen")).text()).match(/<pre id=s>(.*)<\/pre>/s)[1]);
            const savesBefore = (await told()).saved?.length ?? 0;
            await press('#video_player button[aria-label^="Download"]');
            await waitFor(`/^Saved .* into Downloads\\.$/.test(document.querySelector("#video_player .note")?.textContent ?? "")`, "the clip saved into Downloads", 30000);
            const s = await told();
            const saved = s.saved?.at(-1), played = s["/clip.mp4"];
            if (!(s.saved?.length > savesBefore) || !played?.ua || !played.referer || saved.ua !== played.ua || saved.cookie !== played.cookie || saved.referer !== played.referer) {
                throw new Error(`saved with ${JSON.stringify(saved)}, played with ${JSON.stringify(played)}`);
            }
        }
        // (Paused: the clip loops, and 10 s on is its end, looped back from;
        // its mark noted as it's shown: it's gone in a moment.)
        await ev(`(() => { const v = document.querySelector("#video_player video"); v.pause(); v.currentTime = 1; const f = document.querySelector("#video_player .flash"); window.__flashed = ""; new MutationObserver(() => { if (f.classList.contains("shown")) window.__flashed = f.className; }).observe(f, { attributes: true }); return 0; })()`);
        await waitFor(`Math.abs(document.querySelector("#video_player video").currentTime - 1) < 0.2`, "at 1 s, paused");
        const right = await ev(`(() => { const r = document.getElementById("video_player").getBoundingClientRect(); return { x: Math.round(r.right - r.width * 0.2), y: Math.round(r.top + r.height * 0.3) }; })()`);
        for (const n of [1, 2]) {
            await cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...right, button: "left", buttons: 1, clickCount: n });
            await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...right, button: "left", buttons: 0, clickCount: n });
        }
        await waitFor(`document.querySelector("#video_player video").currentTime > 4 && /\\bright\\b/.test(window.__flashed)`, "on 10 s by a double tap at the right, marked there");
        await press('#video_player button[aria-label^="Close the player"]');
        await waitFor(`!document.getElementById("video_player") && !document.fullscreenElement && !!document.querySelector("video") && !document.querySelector("video").controls && getComputedStyle(document.querySelector("video")).display !== "none"`, "given back to its box, under the copy (no native controls)", 10000);
        await ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
    });

    await step("Skip held blocks videos from the video's own host, not the page's site: stopped, kept in Site controls, and Undo has them again", async () => {
        const settings = async () => ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call({ type: "go-settings" }); t.close(); return { hosts: t.reply.videoHosts ?? [], sites: t.reply.noVideos ?? [] }; })`);
        const host = new URL(site).hostname;
        // The page this site's, its video another's (as test.com's page with a video from
        // something.com): that one's host is what's blocked.
        const page = adSite ? site + "auto-from?from=" + encodeURIComponent(adSite) : site + "auto.html";
        const videoHost = adSite ? new URL(adSite).hostname : host;
        await goTo(page, "Autoplay");
        await waitFor(`(() => { const v = document.querySelector("video"); return !!v && !v.paused; })()`, "the video playing", 30000);
        await ev(`document.getElementById("go_menu").click()`);
        await waitFor(`!!document.querySelector("#go_menu_media li .acts button:last-child:not(:disabled)")`, "Skip offered");
        // Held by a finger (a phone's), wavering a little as fingers do. (Where it is
        // measured with touch on: a touch screen's layout is roomier, and moves it.)
        await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
        try {
            await sleep(300);
            const at = await ev(`(() => { const r = document.querySelector("#go_menu_media li .acts button:last-child").getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
            await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] });
            await sleep(300);
            await cdp("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: at.x + 3, y: at.y + 2 }] });
            await sleep(600);
            await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        } finally {
            await cdp("Emulation.setTouchEmulationEnabled", { enabled: false });
        }
        try {
            await waitFor(`!document.querySelector("video") && document.getElementById("go_notice").textContent.includes(${JSON.stringify("Videos from " + videoHost + " are blocked")})`, "its video stopped, said so");
            await frameWait(`/blocked/.test(document.getElementById("v").textContent)`, "its box says why");
            await frameWait(`document.getElementById("out").textContent === "pause paused"`, "the page told it's paused");
            const set = await settings();
            if (!set.hosts.includes(videoHost) || set.sites.includes(host) || adSite && set.hosts.includes(host)) throw new Error(`the settings: ${JSON.stringify(set)}`);
            // Loaded again: still none.
            await ev(`document.getElementById("go_reload").click()`);
            await sleep(3000);
            await frameWait(`/blocked/.test(document.getElementById("v").textContent)`, "blocked, loaded again");
            if (await ev(`!!document.querySelector("video")`)) throw new Error("a player, its host's videos blocked");
            // The page's site's own video, from its own host: played.
            if (adSite) {
                await goTo(site + "auto.html", "Autoplay");
                await waitFor(`(() => { const v = document.querySelector("video"); return !!v && !v.paused; })()`, "the site's own video playing", 30000);
            }
            // Undo (from the notice, still there? if not, the setting).
        } finally {
            const undo = await ev(`(() => { const n = document.getElementById("go_notice"); const b = n.querySelector(".primary"); if (!n.hidden && b && !b.hidden && b.textContent === "Undo") { b.click(); return true; } return false; })()`);
            if (!undo) await ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call({ type: "go-settings-set", name: ${JSON.stringify(videoHost)}, setting: "videos-host-allow" }); t.close(); })`);
        }
        if ((await settings()).hosts.includes(videoHost)) throw new Error("still blocked after Undo");
        await goTo(page, "Autoplay");
        await waitFor(`(() => { const v = document.querySelector("video"); return !!v && !v.paused; })()`, "its video playing again", 30000);
    });

    await step("a video skipped is, to the page, played to its end, whether playing or still loading: from the menu, or Shift+N", async () => {
        await goTo(site + "skip.html", "Skip");
        // The second still loading (sent slowly): skipped from the menu's list
        // (the page's videos, top first), it stops.
        await waitFor(`!!document.querySelector(".go-media-loading:not([hidden])")`, "the second loading", 15000);
        await ev(`document.getElementById("go_menu").click()`);
        await waitFor(`document.querySelectorAll("#go_menu_media li").length === 2`, "both videos in the menu");
        await ev(`document.querySelectorAll("#go_menu_media li")[1].querySelector(".acts button:last-child").click()`);
        await frameWait(`document.getElementById("b-out").textContent === "b ended at 0 true"`, "the second ended, to its page");
        await waitFor(`!document.querySelector(".go-media-loading")`, "its loading gone");
        await ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
        // The first playing: Shift+N on it skips it, at its end.
        await waitFor(`[...document.querySelectorAll("video")].some((v) => !v.paused && v.currentTime > 0.3)`, "the first playing", 30000);
        await ev(`[...document.querySelectorAll("video")].find((v) => !v.paused).focus()`);
        await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "N", code: "KeyN", modifiers: 8, windowsVirtualKeyCode: 78 });
        await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "N", code: "KeyN", modifiers: 8, windowsVirtualKeyCode: 78 });
        await frameWait(`document.getElementById("a-out").textContent === "a ended at 5 true"`, "the first ended at its end, to its page");
        await waitFor(`(() => { const v = [...document.querySelectorAll("video")]; return v.length === 1 && v[0].paused && Math.round(v[0].currentTime) === 5; })()`, "its player paused at the end, the other's closed");
        // In the menu: a skipped video can be hidden, then restored by
        // opening it in the /go player or by playing it again.
        await ev(`document.getElementById("go_menu").click()`);
        const rows = await ev(`[...document.querySelectorAll("#go_menu_media li")].map((li) => ({ state: li.querySelector(".state").textContent, hide: li.querySelector(".acts button:last-child").getAttribute("aria-label"), playDisabled: [...li.querySelectorAll(".acts button")].find((b) => /^(Play|Pause) /.test(b.getAttribute("aria-label") || ""))?.disabled }))`);
        if (rows.length !== 1 || rows[0].state !== "Skipped" || !rows[0].hide.startsWith("Hide") || rows[0].playDisabled) throw new Error(`the menu, after: ${JSON.stringify(rows)}`);
        await ev(`document.querySelector("#go_menu_media li .acts button:last-child").click()`);
        await waitFor(`getComputedStyle(document.querySelector("video")).display === "none"`, "the skipped video hidden");
        await ev(`[...document.querySelectorAll("#go_menu_media li .acts button")].find((b) => /^Play /.test(b.getAttribute("aria-label") || "")).click()`);
        await waitFor(`getComputedStyle(document.querySelector("video")).display !== "none" && !document.querySelector("video").paused`, "the video restored by Play");
        // (Each pressed once it's offered: Skip as the video can be skipped again, Hide once it's skipped.)
        const offered = (what) => `(() => { const b = document.querySelector("#go_menu_media li .acts button:last-child"); return !!b && !b.disabled && b.getAttribute("aria-label").startsWith(${JSON.stringify(what)}); })()`;
        await ev(`document.getElementById("go_menu").click()`);
        await waitFor(offered("Skip"), "Skip offered again");
        await ev(`document.querySelector("#go_menu_media li .acts button:last-child").click()`);
        await waitFor(`document.querySelector("#go_menu_media .state").textContent === "Skipped"`, "the video ended again");
        await ev(`document.getElementById("go_menu").click()`);
        await waitFor(offered("Hide"), "Hide offered again");
        await ev(`document.querySelector("#go_menu_media li .acts button:last-child").click()`);
        await waitFor(`getComputedStyle(document.querySelector("video")).display === "none"`, "the video hidden again");
        await ev(`document.getElementById("go_menu").click()`);
        await ev(`[...document.querySelectorAll("#go_menu_media li .acts button")].find((b) => /^Watch /.test(b.getAttribute("aria-label") || "")).click()`);
        await waitFor(`!!document.querySelector("#video_player video")`, "the hidden video opened in the /go player");
        await ev(`document.querySelector("#video_player button[aria-label^='Close the player']").click()`);
        await waitFor(`!!document.querySelector("video") && getComputedStyle(document.querySelector("video")).display !== "none"`, "the video restored from the /go player");
        await ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
    });

    await step("prompt, a page asking as it loads, a frame asking, and a page asking in a loop", async () => {
        const answer = async (text, ok = true) => {
            await waitFor(`document.getElementById("go_dialog").open`, "the dialog", 30000).catch(async (err) => {
                // What the page and the frame were doing (an intermittent miss in CI).
                const state = await ev(`JSON.stringify({ status: document.getElementById("go_status").textContent, busy: document.getElementById("go_view").getAttribute("aria-busy"),
                    notice: document.getElementById("go_notice").hidden ? "" : document.querySelector("#go_notice p").textContent })`).catch((e) => e.message);
                const there = await frame(`document.getElementById("status")?.textContent`).catch((e) => e.message);
                throw new Error(`${err.message}; page ${state}; frame status ${there}; exceptions ${JSON.stringify(exceptions)}`);
            });
            if (text !== undefined) await ev(`document.querySelector("#go_dialog input[type=text]").value = ${JSON.stringify(text)}`);
            await ev(`document.querySelector("#go_dialog ${ok ? ".ok" : ".cancel"}").click()`);
        };
        await goTo(site + "ask-prompt.html", "Prompts");
        await frameClick("#ask");
        await waitFor(`document.getElementById("go_dialog").open && document.querySelector("#go_dialog input[type=text]").value === "nobody"`, "the prompt, its default", 30000);
        await answer("Ann");
        await frameWait(`document.getElementById("status").textContent === "prompted Ann"`, "the answer typed");
        await frameClick("#ask");
        await answer(undefined, false);
        await frameWait(`document.getElementById("status").textContent === "prompted null"`, "no answer");
        await submitUrl(site + "ask-load.html");
        await answer();
        await waitFor(`document.title.startsWith("Asks")`, "the page", 30000);
        await frameWait(`!!document.getElementById("after")`, "the rest of the page, once answered");
        await goTo(site + "ask-frame.html", "Frame asks");
        await answer();
        await frameWait(`document.getElementById("status").textContent === "answered true"`, "the frame's answer");
        // A page asking in a loop: from its second, the person may stop it.
        await goTo(site + "ask-loop.html", "Loop");
        await frameClick("#loop");
        await waitFor(`document.getElementById("go_dialog").open`, "the first", 30000);
        if (!(await ev(`document.querySelector("#go_dialog .quiet").hidden`))) throw new Error("offered to stop it at its first");
        await ev(`document.querySelector("#go_dialog .ok").click()`);
        await waitFor(`document.getElementById("go_dialog").open && !document.querySelector("#go_dialog .quiet").hidden`, "the second, offering to stop it", 30000);
        await ev(`document.querySelector("#go_dialog .quiet input").click()`);
        await ev(`document.querySelector("#go_dialog .ok").click()`);
        await frameWait(`document.getElementById("status").textContent === "done"`, "the loop through, unasked", 30000);
        if (await ev(`document.getElementById("go_dialog").open`)) throw new Error("still asking");
    });

    await step("the display is this window; drags within the page, drops from outside, and touches go to the engine", async () => {
        await goTo(site + "hands.html", "Hands");
        const win = await ev(`innerWidth + "x" + innerHeight`);
        await frameWait(`document.getElementById("screen").textContent.startsWith(${JSON.stringify(win + " ")})`, `the display, ${win}`);
        // Within the page: the engine's drag, from the mouse.
        const at = async (sel) => {
            const r = await frame(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({ block: "center" }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
            const f = await viewOrigin();
            return { x: f.x + r.x, y: f.y + r.y };
        };
        await pageShown();
        const from = await at("#a"), to = await at("#t");
        await cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...from, button: "left", buttons: 1, clickCount: 1 });
        for (let i = 1; i <= 8; i++) {
            await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x + (to.x - from.x) * i / 8, y: from.y + (to.y - from.y) * i / 8, button: "left", buttons: 1 });
            await sleep(80);
        }
        await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...to, button: "left", buttons: 0, clickCount: 1 });
        await frameWait(`document.getElementById("status").textContent === "dropped from the page"`, "the drag within the page");
        // From outside: dragged over, then dropped.
        const data = { items: [{ mimeType: "text/plain", data: "from outside" }], dragOperationsMask: 1 };
        await frameDrop(() => at("#t"), data);
        await frameWait(`document.getElementById("status").textContent === "dropped from outside"`, "the drop from outside");
        // A touch: a tap, the engine's click from it (once).
        await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
        try {
            const tap = await at("#tap");
            await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [tap] });
            await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
            await frameWait(`document.getElementById("status").textContent === "tapped, touches 1"`, "the tap, as a touch");
            await sleep(500);
            const now = await frame(`document.getElementById("status").textContent`);
            if (now !== "tapped, touches 1") throw new Error(`then ${now}: clicked twice?`);
        } finally {
            await cdp("Emulation.setTouchEmulationEnabled", { enabled: false });
        }
    });

    await step("a page asking for more than a tab fetches at once has them all, in turn, not refused", async () => {
        await goTo(site + "many.html", "Many");
        await frameWait(`(() => { const imgs = [...document.images]; return imgs.length === 80 && imgs.every((i) => i.complete && i.naturalWidth > 0); })()`, "all 80 pictures (each sent slowly)", 90000);
    });

    await step("a swipe over a video a page swipes by its own script (as YouTube's Shorts on a phone) reaches the page, as a tap there does (the player's under the page)", async () => {
        await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
        try {
            await goTo(site + "swiped.html", "Swiped");
            await waitFor(`(() => { const v = document.querySelector("video"); return !!v && getComputedStyle(v).display !== "none" && v.getBoundingClientRect().height > 300; })()`, "the reel's player, under the page", 30000);
            const p = await ev(`(() => { const r = document.querySelector("video").getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height * 0.7) }; })()`);
            // A tap: the page's, as on a page whose own player it is (a click,
            // no swipe): the player is under the copy (go-media.js).
            await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [p] });
            await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
            await frameWait(`document.getElementById("out").textContent === "at 0, clicks 1"`, "the tap's click, on the page");
            // A swipe up over it: the page's own script goes to the next.
            await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [p] });
            for (let k = 1; k <= 8; k++) {
                await cdp("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: p.x, y: p.y - 30 * k }] });
                await sleep(30);
            }
            await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
            await frameWait(`document.getElementById("out").textContent === "at 1, clicks 1"`, "the next reel, by the page's swipe (no click)");
        } finally {
            await cdp("Emulation.setTouchEmulationEnabled", { enabled: false });
            await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        }
    });

    await step("a touch swipe that scrolls the page clicks nothing; a tap still clicks", async () => {
        await goTo(site + "swipe.html", "Swipe");
        await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
        try {
            // Swipes over the buttons, the copy scrolling under the finger as
            // it moves (as a browser scrolls it): it stays over the same
            // button, what's under it not moving. Fast and slow.
            const view = await ev(`(() => { const b = document.getElementById("go_view").getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height * 0.7) }; })()`);
            // Each from a page that's still: the viewer's own Chrome scrolls
            // the copy by touch too (a step's more than the test's), and in
            // CI flung it on after a quick swipe, a thousand pixels on, the
            // next swipe begun as it went (swipe 3 at b18, b19, not b9).
            const still = async () => {
                for (let last = NaN, end = Date.now() + 5000; ; await sleep(150)) {
                    const y = await frame(`Math.round(scrollY)`);
                    if (y === last || Date.now() > end) return y;
                    last = y;
                }
            };
            for (const [i, steps] of [[1, 10], [2, 4], [3, 2]]) {
                const y0 = await still();
                await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [view] });
                for (let k = 1; k <= steps; k++) {
                    const dy = Math.round(300 * k / steps);
                    await frame(`scrollTo(0, ${y0 + dy})`);
                    await cdp("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: view.x, y: view.y - dy }] });
                    await sleep(30);
                }
                await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
                await sleep(800);
                const out = await frame(`document.getElementById("out").textContent`);
                if (out !== "clicks 0") throw new Error(`swipe ${i} clicked: ${out} (from ${y0} to ${await frame(`Math.round(scrollY)`)})`);
            }
            // A tap still a click, once.
            await frame(`scrollTo(0, 0)`);
            const tap = await at("#b1");
            await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [tap] });
            await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
            await frameWait(`document.getElementById("out").textContent === "clicks 1 b1"`, "the tap's click");
        } finally {
            await cdp("Emulation.setTouchEmulationEnabled", { enabled: false });
        }
    });

    await step("a frame's own constructors are never handed the agent's functions", async () => {
        await goTo(site + "trap.html", "Trap");
        await frameWait(`document.getElementById("f")?.shadowRoot?.getElementById("inner")?.textContent === "inner changed"`, "the frame's change, seen all the same");
        const status = await frame(`document.getElementById("status").textContent`);
        if (status !== "safe") throw new Error(status);
    });

    await step("a feed: a video the page gives a file and plays plays here, and a swipe scrolls the page", async () => {
        await goTo(site + "feed.html", "Feed");
        // Empty <source src=""> (a placeholder) is nothing to play, not a
        // stuck empty URL that hides a later real src.
        await frameWait(`/nothing to play/.test(document.getElementById("b").textContent)`, "the second box, empty source");
        await frameClick("#nextclip");
        await frameWait(`document.querySelector("#b[data-go-video]")?.textContent === ""`, "its player made for the file it was given");
        await waitFor(`[...document.querySelectorAll("video")].some((v) => v.currentTime > 0.5)`, "it playing, as the page played it", 30000);
        // Scrolled by the person (a swipe, say: no wheel), and the page
        // sees itself scrolled. (Headless Chrome doesn't scroll the frame by
        // touch: a press, then the scroll, which is the person's still.)
        await frameClick("#scroller");
        await frame(`document.getElementById("scroller").scrollTop = 300`);
        await frameWait(`/^at [1-9]/.test(document.getElementById("status").textContent)`, "the page told of the scroll");
    });

    await step("a page's address space past a gigabyte, little used, is the page's", async () => {
        await goTo(site + "memory.html", "Memory");
        await frameWait(`document.getElementById("s")?.textContent === "memory 1258291200"`, "the page's memory made");
        await sleep(2000);
        // Still the same engine: not ended and the page loaded again.
        if (await ev(`!document.getElementById("go_notice").hidden || /Loading/.test(document.getElementById("go_status").textContent)`)) throw new Error("the page was loaded again");
    });

    await step("a video from a server without byte ranges plays; what a page loads says the page (Referer), unless that's off", async () => {
        await goTo(site + "norange.html", "No ranges");
        await waitFor(`[...document.querySelectorAll("video")].some((v) => v.readyState >= 1 && Math.abs(v.duration - 5) < 0.5)`, "the clip, 5 s, from a server without ranges", 30000);
        await ev(`[...document.querySelectorAll("video")].find((v) => v.readyState >= 1).play()`);
        await waitFor(`[...document.querySelectorAll("video")].some((v) => v.currentTime > 0.5)`, "it playing", 30000);
        await goTo(site + "seen", "Seen");
        let seen = JSON.parse(await frame(`document.getElementById("s").textContent`));
        if (!(seen.norange >= 1)) throw new Error("the server without ranges wasn't asked");
        if (seen["/pic.png"]?.referer !== site + "norange.html") throw new Error(`the picture said ${JSON.stringify(seen["/pic.png"]?.referer)}`);
        // Off: not said.
        const settings = (req) => ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call(${JSON.stringify(req)}); t.close(); return JSON.stringify(t.reply); })`);
        await settings({ type: "go-settings-set", name: "", setting: "referer-off" });
        try {
            await goTo(site + "noreferer.html", "No referer");
            await frameWait(`document.getElementById("pic")?.naturalWidth > 0`, "a picture not fetched before");
            await goTo(site + "seen", "Seen");
            seen = JSON.parse(await frame(`document.getElementById("s").textContent`));
            if (seen["/pic.png"]?.referer !== "") throw new Error(`with it off, the picture said ${JSON.stringify(seen["/pic.png"]?.referer)}`);
        } finally {
            await settings({ type: "go-settings-set", name: "", setting: "referer-on" });
        }
    });

    await step("a player the page hides till its video plays is played, and shown once it does", async () => {
        await goTo(site + "reel-player.html", "Reel player");
        await frameClick("#load");
        await frameWait(`document.getElementById("status")?.textContent === "playing"`, "the page told its video plays");
        await frameWait(`getComputedStyle(document.getElementById("wrap")).visibility === "visible"`, "the player shown by the page");
        await waitFor(`[...document.querySelectorAll("video")].some((v) => v.currentTime > 0.5 && v.style.display !== "none" && v.getBoundingClientRect().width > 300)`, "it under its box, playing", 30000);
        await frameWait(`/^time [1-9][0-9.]*$/.test(document.getElementById("time")?.textContent)`, "the page reading where it is, going on");
    });

    await step("a video's file picked as a browser picks it: an empty <source> passed over; an element's own empty src, nothing", async () => {
        await goTo(site + "sources.html", "Sources");
        await frameWait(`document.querySelector("#a[data-go-video]")?.textContent === ""`, "the first video's player, for its second <source>");
        await frameWait(`/nothing to play/.test(document.getElementById("b")?.textContent || "")`, "the second, its own src empty, nothing to play");
    });

    await step("a video with nothing to play shows nothing and is pressed through: what's under it is pressed", async () => {
        await goTo(site + "emptyvideo.html", "Empty video");
        await frameWait(`document.getElementById("v")?.classList.contains("go-media-empty")`, "the empty video's box");
        const look = await frame(`(() => { const s = getComputedStyle(document.getElementById("v")); return [s.pointerEvents, s.backgroundColor, s.color].join(" "); })()`);
        if (look !== "none rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)") throw new Error(`the empty box: ${look}`);
        await frameClick("#under");
        await frameWait(`document.getElementById("r")?.textContent === "button"`, "the button under it pressed", 15000)
            .catch(async (err) => { throw new Error(`${err.message}: ${await frame(`document.getElementById("r").textContent`)}`); });
    });

    await step("a player choosing its MediaSource as dash.js does gets one that works", async () => {
        await goTo(site + "dash-like.html", "DASH-like");
        await frameWait(`/^(made|failed)/.test(document.getElementById("out")?.textContent || "")`, "the player's choice");
        const out = await frame(`document.getElementById("out").textContent`);
        // Our ManagedMediaSource relay is always present and constructible.
        if (out !== "made managed true") throw new Error(`dash.js's choice of MediaSource: ${out}`);
    });

    await step("a MediaSource video the page pauses stops here too (as YouTube Shorts' pause); paused and played again at once, it plays", async () => {
        await goTo(site + "mse-pause.html", "MSE pause");
        // Its player's made but stays paused till it's played (the page's
        // play() of a stream its own player feeds doesn't start it): played
        // from the menu, as the person would.
        await ev(`document.getElementById("go_menu_panel").hidden && document.getElementById("go_menu").click()`);
        const play = `[...document.querySelectorAll("#go_menu_media li .acts button")].find((b) => /^Play /.test(b.getAttribute("aria-label") || "") && !b.disabled)`;
        await waitFor(`!!${play}`, "Play offered in the menu", 30000);
        await ev(`${play}.click()`);
        await waitFor(`(() => { const v = document.querySelector("video"); return !!v && !v.paused && v.currentTime > 0.3; })()`, "the stream playing", 30000);
        await frameWait(`document.getElementById("out").textContent === "play playing"`, "the page told it plays");
        await ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
        await waitFor(`document.getElementById("go_menu_panel").hidden`, "the menu closed");
        await frameClick("#pause");
        await frameWait(`document.getElementById("out").textContent === "pause paused"`, "the page told it's paused");
        await waitFor(`document.querySelector("video").paused`, "its player paused");
        // Played and paused at once (Shorts' pause, before the player's said
        // it plays): the page told it's paused, and the player stays so.
        await frameClick("#quick");
        await frameWait(`document.getElementById("out").textContent === "pause paused"`, "the page told it's paused, played and paused at once");
        await sleep(1500);
        if (!(await ev(`document.querySelector("video").paused`))) throw new Error("the player plays, the page having paused it at once");
        // A pause each time it was paused, the handler's own pause() nothing;
        // pause() on what's paused (not played since) fires nothing.
        if ((await frame(`document.getElementById("count").textContent`)) !== "2") throw new Error(`pause fired ${await frame(`document.getElementById("count").textContent`)} times, not 2`);
        await frameClick("#idle");
        await sleep(500);
        if ((await frame(`document.getElementById("count").textContent`)) !== "2") throw new Error("pause() on a paused video fired pause");
        // Played, paused and played again at once (Shorts stopping a reel
        // and playing it): it plays, the page told so; the pause a moment
        // later, of the pause() played over, isn't said.
        await frameClick("#again");
        await waitFor(`(() => { const v = document.querySelector("video"); return !!v && !v.paused; })()`, "its player playing, played again after its pause", 15000);
        await stillNot(ev, `document.querySelector("video").paused`, "the player was paused by the pause() the page played over", 1500);
        if ((await frame(`document.getElementById("out").textContent`)) !== "play playing") throw new Error(`the page told ${await frame(`document.getElementById("out").textContent`)}`);
    });

    await step("a MediaSource video the page plays before /go's agent is there (its first script) plays here, with no press", async () => {
        const toggle = `document.getElementById("go_menu_autoplay")`;
        const autoplayWas = await ev(`${toggle}.getAttribute("aria-checked") ?? String(${toggle}.checked)`);
        if (autoplayWas !== "true") await ev(`${toggle}.click()`);
        try {
            await goTo(site + "mse-early.html", "MSE early");
            await waitFor(`(() => { const v = document.querySelector("video"); return !!v && !v.paused && v.currentTime > 0.3; })()`, "its stream playing, played before the agent was there", 30000)
                .catch(async (err) => { throw new Error(`${err.message}: ${await ev(`JSON.stringify([...document.querySelectorAll("video")].map((v) => [v.paused, v.currentTime, v.readyState]))`)}`); });
        } finally {
            if (autoplayWas !== "true") await ev(`${toggle}.click()`);
        }
    });

    await step("a video attached as HLS.js does reaches canplay on the controller's video after segments arrive", async () => {
        await goTo(site + "mse-hls-like.html", "MSE HLS-like");
        await frameWait(`document.documentElement.getAttribute("data-mms") === "managed"`, "ManagedMediaSource is our relay");
        await frameWait(`document.querySelector(".videoElement")?.getAttribute("data-attached")?.startsWith("blob:tabtop-media/")`, "the relay attached to the controller's video");
        await frameWait(`/^start:/.test(document.documentElement.getAttribute("data-stream") || "")`, "startstreaming from the underlaid player");
        await frameWait(`document.documentElement.getAttribute("data-manifest") === "loaded"`, "manifest loaded over XHR in the engine");
        await frameWait(`document.querySelector(".videoWrapper .videoElement")?.getAttribute("data-metadata") === "1"`, "init segment gives the controller's video HAVE_METADATA");
        await frameWait(`document.getElementById("start-load")?.disabled === false`, "init segment append completed");
        const before = await frame(`(() => {
            const shell = document.querySelector(".player-html5"), video = document.querySelector(".videoElement");
            return /nothing to play/.test(shell.textContent) && !shell.hasAttribute("data-ready") &&
                !/nothing to play|own player/.test(video.textContent) && !video.hasAttribute("data-ready");
        })()`);
        if (!before) throw new Error("only the shell should be empty, and neither video should report canplay before media data arrives");
        await frameClick("#start-load");
        await frameWait(`Number(document.querySelector(".videoElement")?.getAttribute("data-ready")) >= 3`, "canplay after the media segment", 30000);
        if (await frame(`document.querySelector(".player-html5").hasAttribute("data-ready")`)) throw new Error("canplay reached the empty shell");
        // Play the underlaid video from /go's menu.
        await ev(`document.getElementById("go_menu_panel").hidden && document.getElementById("go_menu").click()`);
        const play = `[...document.querySelectorAll("#go_menu_media li .acts button")].find((b) => /^Play /.test(b.getAttribute("aria-label") || "") && !b.disabled)`;
        await waitFor(`!!${play}`, "Play offered in the menu", 30000);
        await ev(`${play}.click()`);
        await waitFor(`(() => { const v = document.querySelector("video"); return !!v && !v.paused && v.currentTime > 0.3 && getComputedStyle(v).display !== "none"; })()`, "the stream playing under its box", 30000);
        await ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
    });

    await step("a MediaSource stream in an embedded page, of this origin and another's, plays under its box; the page told how it plays", async () => {
        for (const kind of ["same", "other"]) {
            await goTo(site + "mse-frame.html" + (kind === "same" ? "?same" : ""), "MSE frame");
            const box = `document.getElementById("x")?.shadowRoot?.querySelector("[data-go-video]")`;
            await frameWait(`(() => { const b = ${box}; return !!b && !/nothing to play|own player/.test(b.textContent || ""); })()`, `the ${kind} origin's frame's stream known to its box`, 30000);
            await ev(`document.getElementById("go_menu_panel").hidden && document.getElementById("go_menu").click()`);
            const play = `[...document.querySelectorAll("#go_menu_media li .acts button")].find((b) => /^Play /.test(b.getAttribute("aria-label") || "") && !b.disabled)`;
            // Started by its page's own play() (passed on: goframestreams.go's
            // plays, or its page's agent's), or, autoplay paused by a step
            // before, by the menu's Play.
            const going = `[...document.querySelectorAll("video")].some((v) => v.src.startsWith("blob:") && (!v.paused || v.ended) && v.currentTime > 0.3)`;
            await waitFor(`${going} || (!!${play} && /Paused/.test(document.getElementById("go_menu_media")?.innerText || ""))`, "the stream playing, or Play offered in the menu, the stream ready", 30000).catch(async (err) => {
                throw new Error(`${err.message}: the menu: ${await ev(`document.getElementById("go_menu_media")?.innerText.replaceAll("\\n", " | ")`)}`);
            });
            if (!(await ev(going))) await ev(`${play}?.click()`);
            // (Its clip is 3 s: played, or played to its end.)
            await waitFor(`(() => { const v = document.querySelector("video"); return !!v && v.src.startsWith("blob:") && (!v.paused || v.ended) && v.currentTime > 0.3; })()`, `the ${kind} origin's frame's stream playing under its box`, 30000).catch(async (err) => {
                throw new Error(`${err.message}: ${await ev(`JSON.stringify([...document.querySelectorAll("video")].map((v) => ({ src: v.src.slice(0, 40), rs: v.readyState, t: v.currentTime, p: v.paused, e: v.ended })))`)}; the menu: ${await ev(`document.getElementById("go_menu_media")?.innerText.replaceAll("\\n", " | ")`)}`);
            });
            await ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
        }
    });

    await step("a video played from a plain Blob's URL plays under its box, in the page and in another origin's frame", async () => {
        for (const kind of ["page", "frame"]) {
            await goTo(site + "blob-video.html" + (kind === "frame" ? "?frame" : ""), "Blob video");
            const box = kind === "frame" ? `document.getElementById("x")?.shadowRoot?.querySelector("[data-go-video]")` : `document.querySelector("[data-go-video]")`;
            await frameWait(`(() => { const b = ${box}; return !!b && !/nothing to play|own player/.test(b.textContent || ""); })()`, `the ${kind}'s Blob video known to its box`, 30000).catch(async (err) => {
                throw new Error(`${err.message}: its box says ${JSON.stringify(await frame(`${box}?.textContent ?? "none"`))}`);
            });
            await ev(`document.getElementById("go_menu_panel").hidden && document.getElementById("go_menu").click()`);
            const play = `[...document.querySelectorAll("#go_menu_media li .acts button")].find((b) => /^Play /.test(b.getAttribute("aria-label") || "") && !b.disabled)`;
            await waitFor(`!!${play} && /Paused/.test(document.getElementById("go_menu_media")?.innerText || "")`, `the ${kind}'s Blob video ready, Play offered`, 30000).catch(async (err) => {
                throw new Error(`${err.message}: the menu: ${await ev(`document.getElementById("go_menu_media")?.innerText.replaceAll("\\n", " | ")`)}`);
            });
            await ev(`${play}.click()`);
            await waitFor(`(() => { const v = document.querySelector("video"); return !!v && v.src.startsWith("blob:") && (!v.paused || v.ended) && v.currentTime > 0.3 && v.duration > 1; })()`, `the ${kind}'s Blob video playing under its box`, 30000);
            // Saved from the menu: its file, as the page had it.
            if (process.env.GO_NO_FS !== "1" && kind === "page") {
                await ev(`document.getElementById("go_menu_panel").hidden && document.getElementById("go_menu").click()`);
                const save = `[...document.querySelectorAll("#go_menu_media li .acts button")].find((b) => /^Save /.test(b.getAttribute("aria-label") || "") && !b.disabled)`;
                await waitFor(`!!${save}`, "Save offered for the Blob's file", 15000);
                await ev(`${save}.click()`);
                const said = `[...document.querySelectorAll("#go_menu_media li .note")].map((n) => n.textContent).join(" ")`;
                await waitFor(`/Saved .+ into Downloads/.test(${said})`, "its file saved", 30000).catch(async (err) => { throw new Error(`${err.message}: ${await ev(said)}`); });
                const name = (await ev(said)).match(/Saved (.+?) into Downloads/)[1];
                if (!/^stream.*\.mp4$/.test(name)) throw new Error(`saved as ${name}`);
                if (process.env.GO_DOWNLOADS) {
                    const want = Buffer.from(await (await siteFetch(site + "clip.mp4")).arrayBuffer());
                    if (!readFileSync(join(process.env.GO_DOWNLOADS, name)).equals(want)) throw new Error(`${name} isn't the page's file`);
                }
            }
            await ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
        }
    });

    if (process.env.GO_NO_FS !== "1") await step("files the page makes to be downloaded (a link with download to a blob: or data: address): saved into Downloads after a press (one a press), asked first long after one", async () => {
        await goTo(site + "export.html", "Export");
        await frameWait(`!!document.getElementById("later")`, "its buttons");
        const notice = `document.getElementById("go_notice").hidden ? "" : document.querySelector("#go_notice p").textContent`;
        const saved = async (re, what) => {
            await waitFor(`${re}.test(${notice})`, what, 30000).catch(async (err) => { throw new Error(`${err.message}: the notice: ${await ev(notice)}`); });
            return (await ev(notice)).match(/Saved (.+?) into Downloads/)[1];
        };
        const holds = (name, want) => {
            if (process.env.GO_DOWNLOADS && !readFileSync(join(process.env.GO_DOWNLOADS, name)).equals(Buffer.from(want))) throw new Error(`${name} isn't what the page made`);
        };
        const csv = "name,count\nalpha,1\nbeta,2\n";
        // Its button's CSV (a link made, clicked, its address let go).
        await frameClick("#csv");
        const first = await saved(/Saved report.*\.csv into Downloads/, "the CSV saved");
        holds(first, csv);
        // A picture's link, clicked: saved, the page not left.
        await ev(`document.getElementById("go_notice").hidden = true`);
        await frameClick("#png");
        holds(await saved(/Saved dot.*\.png into Downloads/, "the picture saved"), png(2, 2, [10, 200, 90]));
        if (!(await ev(`document.title.startsWith("Export")`))) throw new Error("the page was left for its download");
        // Made long after its press: asked first, saved once allowed.
        await ev(`document.getElementById("go_notice").hidden = true`);
        await frameClick("#later");
        await waitFor(`/wants to save report\.csv/.test(${notice})`, "asked first", 20000).catch(async (err) => { throw new Error(`${err.message}: the notice: ${await ev(notice)}`); });
        await ev(`document.querySelector("#go_notice .primary").click()`);
        const later = await saved(/Saved report.*\.csv into Downloads/, "saved once allowed");
        if (later === first) throw new Error("saved over the first");
        holds(later, csv);
        // Two made by one press: the first saved, the second asked first
        // (a press is one download's, not a page's many).
        await ev(`document.getElementById("go_notice").hidden = true`);
        await frameClick("#two");
        const once = await saved(/Saved report.*\.csv into Downloads/, "the press's download saved");
        await waitFor(`/wants to save report\.csv/.test(${notice})`, "the second asked first", 20000).catch(async (err) => { throw new Error(`${err.message}: the notice: ${await ev(notice)}`); });
        if ([first, later].includes(once)) throw new Error("saved over an earlier one");
    });

}
