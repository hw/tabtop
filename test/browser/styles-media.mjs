import http from "node:http";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pngSquare, videoFixture } from "./fixtures.mjs";

export async function checkStylesAndMedia(checks) {
    const { work, container, inContainer, step, ev, waitFor, click, open, listed, inFrame, sleep, cdp } = checks;
    await step("files: proxy CSS imports, fonts, and streaming embedded media", async () => {
        const font = execFileSync("docker", ["exec", container, "cat", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]);
        const audio = Buffer.alloc(32 * 1024 * 1024);
        audio.write("RIFF"); audio.writeUInt32LE(audio.length - 8, 4); audio.write("WAVEfmt ", 8); audio.writeUInt32LE(16, 16);
        audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28);
        audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write("data", 36); audio.writeUInt32LE(audio.length - 44, 40);
        const original = readFileSync(videoFixture(work));
        const video = Buffer.alloc(original.length + (32 << 20));
        original.copy(video); video.writeUInt32BE(32 << 20, original.length); video.write("free", original.length + 4);
        const hits = [];
        const server = http.createServer((req, res) => {
            const path = new URL(req.url, "http://test").pathname;
            const direct = (req.headers["user-agent"] ?? "").includes("Mozilla");
            hits.push({ path, direct, range: req.headers.range });
            res.setHeader("Cache-Control", "no-store");
            res.setHeader("Access-Control-Allow-Origin", "*");
            if (path === "/start.css") { res.writeHead(302, { Location: "/css/main.css" }); res.end(); return; }
            const staticFiles = {
                "/css/main.css": ["text/css", '@import "nested.css";.copy{font-family:ProxyTest;color:rgb(11,22,33);background-image:url(../image.png)}'],
                "/css/nested.css": ["text/css", '@import "main.css";@font-face{font-family:ProxyTest;src:url(../font.ttf) format("truetype")}.copy{font-weight:400}'],
                "/font.ttf": ["font/ttf", font], "/image.png": ["image/png", pngSquare(20)],
            };
            if (path in staticFiles) { const [type, data] = staticFiles[path]; res.writeHead(200, { "Content-Type": type }); res.end(data); return; }
            const body = path === "/audio.wav" ? audio : path === "/video.mp4" ? video : null;
            if (!body) { res.writeHead(404); res.end(); return; }
            const type = path.endsWith("wav") ? "audio/wav" : "video/mp4";
            const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
            res.setHeader("ETag", '"version-one"'); res.setHeader("Accept-Ranges", "bytes"); res.setHeader("Content-Type", type);
            if (match) {
                const start = Number(match[1]), end = match[2] ? Math.min(Number(match[2]), body.length - 1) : body.length - 1;
                if (start >= body.length || end < start) { res.writeHead(416, { "Content-Range": `bytes */${body.length}` }); res.end(); return; }
                res.writeHead(206, { "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${body.length}` });
                res.end(body.subarray(start, end + 1));
            } else { res.writeHead(200, { "Content-Length": body.length }); res.end(body); }
        });
        await new Promise(resolve => server.listen(0, "0.0.0.0", resolve));
        const gateway = execFileSync("docker", ["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}", container], { encoding: "utf8" }).trim();
        const root = `http://${gateway}:${server.address().port}`;
        const name = "styled-media.html";
        const html = `<html><head><link rel="stylesheet" href="${root}/start.css"></head><body><p class="copy">Remote typography and a background.</p><a id="external-link" href="${root}/target">Open URL</a><a id="image-link" href="${root}/target"><img src="${root}/image.png"></a><audio src="${root}/audio.wav"></audio><video><source src="${root}/video.mp4" type="video/mp4"></video><script>parent.postMessage("unsafe-script","*")</script></body></html>`;
        writeFileSync(`${work}/${name}`, html);
        execFileSync("docker", ["cp", "-q", `${work}/${name}`, `${container}:/home/user/Downloads/media/${name}`]);
        execFileSync("docker", ["exec", container, "chown", "user", `/home/user/Downloads/media/${name}`]);
        try {
            await ev('localStorage.setItem("tabtop.html-view","rendered")');
            await open("fs/#/media/", `${listed}.includes(${JSON.stringify(name)})`, name);
            await ev(`[...document.querySelectorAll("td.name a")].find(a => a.textContent === ${JSON.stringify(name)}).click()`);
            const control = 'document.querySelector("dialog.preview .external-resources")';
            await waitFor(`!${control}?.hidden && ${control}.dataset.mode === "none"`, "stylesheet and media external resource detection");
            await sleep(150);
            if (hits.length) throw new Error("No external fetched a stylesheet or media");
            await click(control);
            await click('document.querySelector("dialog.preview .external-proxy")');
            try {
                await waitFor('document.querySelector("dialog.preview .preview-media-layer audio")?.duration > 1000 && document.querySelector("dialog.preview .preview-media-layer video")?.duration > 29', "streamed audio and video metadata", 60000);
            } catch (error) {
                const state = await ev(`JSON.stringify({mode:${control}.dataset.mode, menu:document.querySelector(".external-menu").hidden,players:[...document.querySelectorAll("dialog.preview audio,dialog.preview video")].map(m=>({kind:m.tagName,duration:m.duration,state:m.readyState,error:m.error?.code,details:m.dataset.error})),report:document.querySelector("iframe.html")?.dataset.rendered})`);
                throw new Error(error.message + " " + state + " hits=" + JSON.stringify(hits));
            }
            let ready = false;
            for (let i = 0; i < 60; i++) {
                ready = await inFrame("md-frame.html", `getComputedStyle(document.querySelector(".copy")).color === "rgb(11, 22, 33)" && [...document.fonts].some(font => font.family === "ProxyTest" && font.status === "loaded")`);
                if (ready) break;
                await sleep(100);
            }
            if (!ready || !hits.some(h => h.path === "/font.ttf") || !hits.some(h => h.path === "/image.png") || hits.some(h => h.direct)) throw new Error(`CSS or fonts did not stay within proxy mode: ${JSON.stringify(hits)}`);
            for (const id of ["external-link", "image-link"]) {
                const at = await inFrame("md-frame.html", `(() => { const a = document.getElementById(${JSON.stringify(id)}); const r = a.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`);
                const frame = await ev('(() => { const r = document.querySelector("iframe.html").getBoundingClientRect(); return {x:r.x,y:r.y}; })()');
                for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: frame.x + at.x, y: frame.y + at.y, button: "left", clickCount: 1 });
                await waitFor('!!document.querySelector("dialog.preview-link[open]")', "real pointer click on " + id);
                await ev('document.querySelector("dialog.preview-link button.close").click()');
                await waitFor('!document.querySelector("dialog.preview-link")', "link dialog closes");
            }
            if (!await inFrame("md-frame.html", 'document.querySelector("#image-link img").naturalWidth === 20')) throw new Error("external inline image is not displayed");
            const audioElement = 'document.querySelector("dialog.preview .preview-media-layer audio")';
            const videoElement = 'document.querySelector("dialog.preview .preview-media-layer video")';
            if (!await ev(`${audioElement}.dataset.streamed === "true" && ${videoElement}.dataset.streamed === "true"`)) throw new Error("embedded media was buffered rather than streamed");
            await ev(`${audioElement}.currentTime = 900; ${audioElement}.play()`);
            await waitFor(`${audioElement}.currentTime > 900.2`, "audio playback after a remote seek", 20000);
            await ev(`${audioElement}.pause(); ${videoElement}.muted = true; ${videoElement}.currentTime = 24; ${videoElement}.play()`);
            await waitFor(`${videoElement}.currentTime > 24.2 && ${videoElement}.videoWidth === 320`, "video playback after a remote seek", 20000);
            await ev(`${videoElement}.pause()`);
            const ranges = hits.filter(h => h.path === "/audio.wav" || h.path === "/video.mp4");
            if (!ranges.some(h => h.path === "/audio.wav" && Number(/^bytes=(\d+)/.exec(h.range ?? "")?.[1]) > 1 << 20) || ranges.some(h => {
                const m = /^bytes=(\d+)-(\d+)$/.exec(h.range ?? "");
                return !m || Number(m[2]) - Number(m[1]) + 1 > 1 << 20;
            })) throw new Error(`media reads were not bounded ranges: ${JSON.stringify(ranges)}`);
            // Direct has native stylesheet/font/media requests, and removes the trusted players.
            await click(control);
            await click('document.querySelector("dialog.preview .external-direct")');
            await waitFor(`${control}.dataset.mode === "direct" && !document.querySelector(".preview-media-layer")`, "direct mode removed proxied media");
            await sleep(500);
            if (!hits.some(h => h.direct && h.path === "/css/main.css")) throw new Error("Direct did not load the stylesheet through the browser");
            await click(control);
            await click('document.querySelector("dialog.preview .external-none")');
            await waitFor(`${control}.dataset.mode === "none"`, "resources blocked again");
            await ev('document.querySelector("dialog.preview button.close").click()');
            await waitFor('!document.querySelector("dialog.preview")', "styled media preview closes");
        } finally {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
            inContainer("rm", `/home/user/Downloads/media/${name}`);
        }
        return "CSS redirect/import cycle, relative fonts/backgrounds, bounded 1 MiB audio/video reads and seeking, Direct and cancellation";
    });
}
