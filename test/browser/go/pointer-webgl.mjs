// The remote browser's check (go-check.mjs), its steps of the mouse and keys,
// a video switched to MediaSource, WebGL.
import { sleep } from "../harness.mjs";
import { step } from "./step.mjs";

// pointerWebgl runs them, with ctx: the check's browser, the site it browses, and its helpers (see check).
export async function pointerWebgl(ctx) {
    const { goTo, site, frameWait, frameClick, frame, browser, pageLog, mouse, at, clickAt, waitFor, ev, glAt, adSite } = ctx;
    await step("the mouse and keys reach the page as a browser's own input, each once", async () => {
        await goTo(site + "input.html", "Input");
        await frameWait(`!!document.getElementById("count")`, "the page");
        await frameClick("#count");
        await frameWait(`document.getElementById("n").textContent === "1"`, "a click, by the mouse");
        await frame(`document.getElementById("count").focus()`);
        await browser.press(" ");
        await frameWait(`document.getElementById("n").textContent === "2"`, "a press, by Space");
        await browser.press("Enter");
        await frameWait(`document.getElementById("n").textContent === "3"`, "a press, by Enter");
        await sleep(1000);
        const n = await frame(`document.getElementById("n").textContent`);
        if (n !== "3") throw new Error(`pressed 3 times, counted ${n}`);
        const log = await pageLog();
        if (log !== "count true;count true;count true;") throw new Error(`the page saw ${log}`);
    });

    await step("hover, a button that listens for the pointer, double and right clicks, the wheel, where in an element", async () => {
        await mouse("mouseMoved", await at("#trigger"));
        await frameWait(`document.getElementById("host").classList.contains("open")`, "the menu shown by hovering");
        await frameClick("#pointer");
        await frameWait(`document.getElementById("log").textContent.includes("pointer pressed")`, "the pointer-only button pressed");
        const pad = await at("#pad", 0.75, 0.5);
        await clickAt(pad);
        await frameWait(`document.getElementById("log").textContent.includes("pad right")`, "the click on the pad's right half");
        await clickAt(pad, { count: 2 });
        await frameWait(`document.getElementById("log").textContent.includes("dblclick")`, "the double click");
        await clickAt(pad, { button: "right" });
        await frameWait(`document.getElementById("log").textContent.includes("contextmenu")`, "the right click");
        await mouse("mouseWheel", pad, { deltaX: 0, deltaY: 120 });
        await frameWait(`document.getElementById("log").textContent.includes("wheel down")`, "the wheel");
    });

    await step("what the engine has covered is clicked all the same; a press let go outside isn't a click", async () => {
        await frameClick("#under");
        await frameWait(`document.getElementById("log").textContent.includes("under clicked")`, "the covered button clicked");
        // Pressed in the frame, let go over the address bar.
        await mouse("mousePressed", await at("#count"), { button: "left", buttons: 1, clickCount: 1 });
        await mouse("mouseReleased", { x: 200, y: 40 }, { button: "left", buttons: 0, clickCount: 1 });
        await frameClick("#count");
        await frameWait(`document.getElementById("n").textContent === "4"`, "the next click");
        await sleep(800);
        const n = await frame(`document.getElementById("n").textContent`);
        if (n !== "4") throw new Error(`counted ${n}, not 4: the press let go outside clicked too`);
    });

    await step("the same video switches from a file to a MediaSource stream", async () => {
        await frame(`window.addEventListener("message", (e) => {
            if (e.source === parent && e.data?.type === "render") window.relayGeneration = e.data.gen;
        })`);
        await goTo(site + "relay.html", "Relay");
        await waitFor(`[...document.querySelectorAll("video")].some((v) => v.readyState >= 2 && Math.abs(v.duration - 5) < 0.5)`, "the preroll", 30000);
        await ev(`(() => { const v = document.querySelector("video"); v.currentTime = v.duration - 0.2; return v.play(); })()`);
        await frameWait(`document.getElementById("status").textContent === "stream supplied"`, "the site handed over the stream");
        await waitFor(`[...document.querySelectorAll("video")].some((v) => v.src.startsWith("blob:") && Math.abs(v.duration - 3) < 0.5 && v.currentTime > 0.25)`,
            "the relayed main video advancing", 30000);
        await ev(`window.relayPlayer = document.querySelector("video")`);
        await frame(`window.relayBox = document.getElementById("player");
            window.dispatchEvent(new MessageEvent("message", { source: parent,
                data: { type: "changes", gen: window.relayGeneration, ops: [{ i: -1 }] } }))`);
        await frameWait(`window.relayBox !== document.getElementById("player")`, "the rebuilt player box");
        await sleep(300);
        if (!await ev(`window.relayPlayer === document.querySelector("video") && window.relayPlayer.isConnected`)) {
            throw new Error("a same-page snapshot replaced the native stream player");
        }
    });


    await step("WebGL drawn in the engine is replayed in the copy: WebGL1 and WebGL2", async () => {
        await goTo(site + "webgl.html", "WebGL");
        await frameWait(`${glAt("still", 32, 32, [0, 255, 0, 255])} && ${glAt("still", 2, 2, [255, 0, 0, 255])}`, "the WebGL1 square, green on red");
        await frameWait(`${glAt("two", 32, 32, [0, 0, 255, 255])} && ${glAt("two", 2, 2, [255, 0, 0, 255])}`, "the WebGL2 square, blue on red");
    });

    await step("a WebGL animation is shown frame by frame, through its log's compaction, and its canvas still takes clicks and is seen by the page's IntersectionObserver", async () => {
        // The animation, started by a click given to the engine's page: frames
        // as it goes (sent as the calls since the last), then its last one,
        // after its log has been compacted and sent whole (the canvas
        // replaced for it), and a click there still reaches the page.
        await frameWait(glAt("moving", 32, 32, [0, 0, 0, 255]), "the animation's first frame");
        const t0 = Date.now();
        await frameClick("#moving");
        const seen = new Set();
        for (const end = Date.now() + 20000; Date.now() < end; await sleep(150)) {
            const p = await frame(`(() => { const gl = document.getElementById("moving").getContext("webgl"); const p = new Uint8Array(4); gl.readPixels(32, 32, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p); return p.join(); })()`);
            seen.add(p);
            if (p === "255,0,128,255") break;
        }
        if (!seen.has("255,0,128,255")) throw new Error(`the animation's last frame not shown: ${[...seen].join(" ")}`);
        if (seen.size < 3) throw new Error(`the animation shown in ${seen.size} frames`);
        const animated = Date.now() - t0;
        await frameClick("#moving");
        await frameWait(`${glAt("moving", 32, 32, [0, 0, 255, 255])} && document.getElementById("n").textContent === "clicked"`, "the animated canvas, clicked again, blue");
        // The page's IntersectionObserver still sees it, scrolled out and in.
        await frameWait(`document.getElementById("io").textContent === "in"`, "the page told its canvas is in view");
        await frame(`scrollTo(0, 2500)`);
        await frameWait(`document.getElementById("io").textContent === "out"`, "the page told its canvas, replaced, is out of view");
        await frame(`scrollTo(0, 0)`);
        await frameWait(`document.getElementById("io").textContent === "in"`, "the page told its canvas is in view again");
        return `${seen.size} frames of the animation seen, its last ${animated} ms after the click`;
    });

    await step("a WebGL canvas drawn past its log's cap is shown unavailable, its context given up, greyed", async () => {
        // Drawn past the cap: not shown, and its last frame not left either.
        await frameWait(glAt("overrun", 32, 32, [0, 255, 0, 255]), "the canvas to overrun, green");
        await frameClick("#overrun");
        // (Its replay context given up, freeing the GPU's memory: nothing
        // drawn, on a grey background.)
        await frameWait(`(() => { const c = document.getElementById("overrun"); return /unsupported|unavailable/.test(c.title) && c.style.backgroundColor === "rgb(221, 221, 221)" && c.getContext("webgl").isContextLost(); })()`, "the overrun canvas unavailable, its context given up, greyed out");
    });

    await step("a WebGL canvas the page resizes is resized in the copy", async () => {
        // Resized by the page and drawn again: the copy's canvas too.
        await frameWait(glAt("sized", 32, 32, [0, 255, 0, 255]), "the canvas to resize, green");
        await frameClick("#sized");
        await frameWait(`document.getElementById("sized").width === 96 && document.getElementById("sized").height === 48 && ${glAt("sized", 48, 24, [0, 0, 255, 255])} && ${glAt("sized", 2, 2, [255, 0, 0, 255])}`, "the resized canvas, 96 by 48, blue on red");
    });

    await step("a WebGL update past a batch's budget still comes", async () => {
        // An update past a batch's WebGL budget still comes (first in its batch).
        await frameWait(glAt("upload", 32, 32, [0, 255, 0, 255]), "the canvas to upload to, green");
        await frameClick("#upload");
        await frameWait(`/mirrored/.test(document.getElementById("upload").title) && ${glAt("upload", 32, 32, [0, 0, 255, 255])}`, "the big upload's canvas, blue, still mirrored", 30000);
    });

    await step("the viewer's WebGL contexts lost together are given back and drawn again; a shader the viewer can't compile shown unavailable", async () => {
        // The viewer's contexts lost together, as a GPU reset loses them, and
        // given back: each replayed from what it kept (one reset, however
        // many contexts it took).
        await frame(`(window.__lose = ["still", "two", "moving"].map((id) => { const c = document.getElementById(id), lose = (c.getContext("webgl2") || c.getContext("webgl")).getExtension("WEBGL_lose_context"); lose.loseContext(); return lose; }), 0)`);
        await frameWait(`["still", "two", "moving"].every((id) => /unavailable/.test(document.getElementById(id).title))`, "the lost contexts labelled");
        await frame(`(window.__lose.forEach((lose) => lose.restoreContext()), 0)`);
        await frameWait(`["still", "two", "moving"].every((id) => /mirrored/.test(document.getElementById(id).title)) && ${glAt("still", 32, 32, [0, 255, 0, 255])} && ${glAt("still", 2, 2, [255, 0, 0, 255])} && ${glAt("two", 32, 32, [0, 0, 255, 255])} && ${glAt("moving", 32, 32, [0, 0, 255, 255])}`, "the contexts given back, drawn again");
        const titles = await frame(`["still", "two", "moving", "broken"].map((id) => document.getElementById(id).title)`);
        if (titles.slice(0, 3).some((t) => !/mirrored/.test(t)) || !/unavailable/.test(titles[3])) throw new Error(`the canvases say ${JSON.stringify(titles)}`);
    });

    await step("WebGL in embedded pages of the same site and another, still and animating", async () => {
        // In embedded pages: the same site's (read by the page's agent, its
        // canvases by way of the page's gogl.js) and another site's (read in
        // a world of its own), still and animating.
        const pixelIn = (id) => `(() => { let c; const walk = (r) => { for (const e of r.querySelectorAll("*")) { if (e.id === ${JSON.stringify(id)} && e.localName === "canvas") c = e; if (e.shadowRoot) walk(e.shadowRoot); } }; walk(document);
            const gl = c?.getContext("webgl2") || c?.getContext("webgl"); if (!gl) return ""; const p = new Uint8Array(4); gl.readPixels(32, 32, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p); return p.join(); })()`;
        const inFrame = (id, want) => `${pixelIn(id)} === ${JSON.stringify(want.join())}`;
        for (const [frameSite, which] of [[site, "the same site's"], [adSite, "another site's"]]) {
            await goTo(site + "glframe.html?src=" + encodeURIComponent(frameSite + "webgl.html"), "GL frame");
            await frameWait(`${inFrame("still", [0, 255, 0, 255])} && ${inFrame("two", [0, 0, 255, 255])}`, `WebGL in ${which} frame`);
            await goTo(site + "glframe.html?src=" + encodeURIComponent(frameSite + "glanim.html"), "GL frame");
            const frames = new Set();
            for (const end = Date.now() + 25000; Date.now() < end && !frames.has("255,0,0,255"); await sleep(100)) frames.add(await frame(pixelIn("a")));
            frames.delete("");
            if (!frames.has("255,0,0,255")) throw new Error(`the animation in ${which} frame not shown to its end: ${[...frames].join(" ")}`);
            if (frameSite === site && frames.size < 5) throw new Error(`the animation in ${which} frame shown in ${frames.size} frames`);
        }
    });

    await step("a page's WebGL canvases past 16 are labelled; one replacing its canvas 20 times still shows its last", async () => {
        // A page with more WebGL canvases than are mirrored: the rest so labelled.
        await goTo(site + "glmany.html", "GL many");
        await frameWait(`(() => { const t = [...document.querySelectorAll("canvas")].map((c) => c.title); return t.length === 20 && t.filter((x) => /mirrored/.test(x)).length === 16 && t.filter((x) => /unsupported|unavailable/.test(x)).length === 4; })()`, "16 of 20 canvases mirrored, 4 labelled");
        // A page replacing its WebGL canvas more times than may be mirrored at
        // once: those gone aren't counted, so its last is still shown.
        await goTo(site + "glswap.html", "GL swap");
        await frameWait(`document.querySelectorAll("canvas").length === 1 && /mirrored/.test(document.getElementById("c")?.title) && ${glAt("c", 16, 16, [0, 0, 255, 255])}`, "the 20th WebGL canvas, mirrored, blue", 20000).catch(async (err) => {
            const shows = await frame(`JSON.stringify({ canvases: document.querySelectorAll("canvas").length, title: document.getElementById("c")?.title, n: document.getElementById("n")?.textContent })`).catch((e) => e.message);
            throw new Error(`${err.message} (it shows ${shows})`);
        });
    });

    await step("three.js draws in the engine and in the copy", async () => {
        // three.js: a red box on blue; a lit, textured green ball on black.
        await goTo(site + "three.html", "Three");
        await frameWait(`document.getElementById("s").textContent === "drawn"`, "three.js drawing in the engine");
        await frameWait(`${glAt("three", 64, 64, [255, 0, 0, 255])} && ${glAt("three", 2, 2, [0, 0, 255, 255])}`, "three.js's red box on blue");
        await frameWait(`document.getElementById("f").textContent === "20"`, "three.js's 20 frames of requestAnimationFrame", 20000);
        await frameWait(`(() => { const gl = document.getElementById("lit").getContext("webgl2"); const p = new Uint8Array(4); gl.readPixels(64, 64, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
            return p[1] > 100 && p[0] < 100 && p[2] < 100; })() && ${glAt("lit", 2, 2, [0, 0, 0, 255])}`, "three.js's lit green ball on black");
    });

}
