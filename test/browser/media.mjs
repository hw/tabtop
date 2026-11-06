import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { videoFixture } from "./fixtures.mjs";

export async function checkAudio(checks) {
    const { work, container, inContainer, step, cdp, ev, waitFor, click, type, open, listed, status } = checks;
    await step("files: stream large audio and seek", async () => {
        // Valid PCM WAV with sparse silence, above the old 200 MB limit.
        const dataSize = 220000000;
        const header = Buffer.alloc(44);
        header.write("RIFF", 0); header.writeUInt32LE(dataSize + 36, 4);
        header.write("WAVEfmt ", 8); header.writeUInt32LE(16, 16);
        header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
        header.writeUInt32LE(8000, 24); header.writeUInt32LE(16000, 28);
        header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
        header.write("data", 36); header.writeUInt32LE(dataSize, 40);
        writeFileSync(`${work}/range.wav`, header);
        truncateSync(`${work}/range.wav`, dataSize + 44);
        execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=8", "-c:a", "libmp3lame", `${work}/range.mp3`]);
        for (const name of ["range.wav", "range.mp3"]) {
            execFileSync("docker", ["cp", "-q", `${work}/${name}`, `${container}:/home/user/Downloads/media/${name}`]);
            execFileSync("docker", ["exec", container, "chown", "user", `/home/user/Downloads/media/${name}`]);
        }
        await open("fs/#/media/", `${listed}.includes("range.wav") && ${listed}.includes("range.mp3")`, "the audio files");
        await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === "range.wav").click()`);
        const audio = 'document.querySelector("dialog.preview audio")';
        await waitFor(`${audio}?.dataset.streamed === "true" && ${audio}.duration > 13000`, "large WAV metadata", 30000);
        const first = await ev(`Number(${audio}.dataset.bytes)`);
        if (first >= dataSize / 4) throw new Error(`audio metadata fetched ${first} bytes of ${dataSize}`);
        await ev(`${audio}.muted = true; ${audio}.currentTime = 6000; ${audio}.play()`);
        await waitFor(`${audio}.currentTime > 6000.2 && !${audio}.paused`, "audio playback after seeking", 15000);
        await ev(`${audio}.pause()`);
        const range = await ev(`fetch(${audio}.src, { headers: { Range: "bytes=4-15" } }).then(async (r) => ({ status: r.status, type: r.headers.get("Content-Type"), range: r.headers.get("Content-Range"), length: (await r.arrayBuffer()).byteLength }))`);
        if (range.status !== 206 || range.type !== "audio/wav" || range.range !== `bytes 4-15/${dataSize + 44}` || range.length !== 12) throw new Error(`WAV ranges: ${JSON.stringify(range)}`);
        await cdp("ServiceWorker.enable");
        // Hold all eight response channels open, then kill their worker before
        // it can cancel them. Its replacement must reclaim those slots.
        await ev(`(async () => {
            window.audioRestartURL = ${audio}.src;
            ${audio}.removeAttribute("src"); ${audio}.load();
            await new Promise((resolve) => setTimeout(resolve, 200));
            window.audioHeldRequests = [];
            for (let n = 0; n < 8; n++) {
                const abort = new AbortController();
                const response = await fetch(window.audioRestartURL, { headers: { Range: "bytes=1000-" }, signal: abort.signal });
                if (response.status !== 206) throw new Error("couldn't open all eight media channels: " + response.status);
                window.audioHeldRequests.push({ response, abort });
            }
        })()`);
        await cdp("ServiceWorker.stopAllWorkers");
        const resumed = await ev(`fetch(window.audioRestartURL, { headers: { Range: "bytes=0-7" } }).then(async (r) => ({ status: r.status, size: (await r.arrayBuffer()).byteLength }))`);
        if (resumed.status !== 206 || resumed.size !== 8) throw new Error(`audio after worker restart: ${JSON.stringify(resumed)}`);
        await ev(`(async () => {
            for (const { response, abort } of window.audioHeldRequests) {
                abort.abort();
                await response.body.cancel().catch(() => {});
            }
            delete window.audioHeldRequests;
        })()`);
        inContainer("sh", "-c", "printf x >> ~/Downloads/media/range.wav");
        const stale = await ev(`fetch(window.audioRestartURL, { headers: { Range: "bytes=0-15" } }).then((r) => r.arrayBuffer()).then(() => false, () => true)`);
        if (!stale || !(await ev(`${audio}.dataset.error.includes("changed since")`))) throw new Error("changed audio was served as the original version");
        await ev(`window.closedAudio = ${audio}; document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "large audio preview closed");
        if (await ev(`window.closedAudio.hasAttribute("src")`)) throw new Error("closing the preview left audio active");
        await ev(`delete window.closedAudio; delete window.audioRestartURL`);
        // Compressed audio uses the same path and supports native seeking.
        await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === "range.mp3").click()`);
        await waitFor(`${audio}?.dataset.streamed === "true" && ${audio}.duration > 7`, "MP3 metadata", 30000);
        await ev(`${audio}.muted = true; ${audio}.currentTime = 5; ${audio}.play()`);
        await waitFor(`${audio}.currentTime > 5.2 && !${audio}.paused`, "MP3 playback after seeking", 15000);
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "MP3 preview closed");
        inContainer("sh", "-c", "rm ~/Downloads/media/range.wav ~/Downloads/media/range.mp3");
        return `220 MB WAV; ${(first / 1e3).toFixed(0)} KB for metadata, seeking, worker restart, stale-file rejection, cleanup; MP3 playback and seeking`;
    });
}

export async function checkVideo(checks) {
    const { work, container, inContainer, step, cdp, ev, waitFor, click, open, listed, status } = checks;
    await step("files: stream video ranges and seek", async () => {
        // A real indexed MP4 plus a large free box: previews must work above
        // the old 200 MB limit without collecting the padding into memory.
        copyFileSync(videoFixture(work), `${work}/range.mp4`);
        const original = readFileSync(`${work}/range.mp4`).length;
        const free = Buffer.alloc(8);
        const padding = 220000000;
        free.writeUInt32BE(padding, 0);
        free.write("free", 4);
        writeFileSync(`${work}/range.mp4`, free, { flag: "a" });
        const size = original + padding;
        truncateSync(`${work}/range.mp4`, size);
        execFileSync("docker", ["cp", "-q", `${work}/range.mp4`, `${container}:/home/user/Downloads/media/range.mp4`]);
        execFileSync("docker", ["exec", container, "chown", "user", "/home/user/Downloads/media/range.mp4"]);
        await open("fs/#/media/", `${listed}.includes("range.mp4")`, "the large video");
        await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === "range.mp4").click()`);
        const video = 'document.querySelector("dialog.preview video")';
        await waitFor(`${video}?.dataset.streamed === "true" && ${video}.readyState >= 1 && ${video}.duration > 29`, "video metadata from ranges", 30000);
        const first = await ev(`Number(${video}.dataset.bytes)`);
        if (first >= size / 4) throw new Error(`video metadata fetched ${first} of ${size} bytes`);
        await ev(`${video}.muted = true; ${video}.currentTime = 24; ${video}.play()`);
        await waitFor(`${video}.currentTime > 24.2 && ${video}.videoWidth === 320`, "playback after seeking", 15000);
        await ev(`${video}.pause()`);
        // Exact, suffix and invalid HTTP ranges through the same transport.
        const ranges = await ev(`(async () => {
            const src = ${video}.src;
            const first = await fetch(src, { headers: { Range: "bytes=0-15" } });
            const bytes = new Uint8Array(await first.arrayBuffer());
            const suffix = await fetch(src, { headers: { Range: "bytes=-512" } });
            const tail = new Uint8Array(await suffix.arrayBuffer());
            const invalid = await fetch(src, { headers: { Range: "bytes=${size}-" } });
            return { first: first.status, length: bytes.length, range: first.headers.get("Content-Range"), signature: String.fromCharCode(...bytes.slice(4,8)),
                suffix: suffix.status, tail: tail.length, zeros: tail.every((b) => b === 0), invalid: invalid.status };
        })()`);
        if (ranges.first !== 206 || ranges.length !== 16 || ranges.range !== `bytes 0-15/${size}` || ranges.signature !== "ftyp" || ranges.suffix !== 206 || ranges.tail !== 512 || !ranges.zeros || ranges.invalid !== 416) throw new Error(`video ranges: ${JSON.stringify(ranges)}`);
        // No transient worker state is needed to resume an open preview.
        await cdp("ServiceWorker.enable");
        await cdp("ServiceWorker.stopAllWorkers");
        const resumed = await ev(`fetch(${video}.src, { headers: { Range: "bytes=8-15" } }).then(async (r) => ({ status: r.status, size: (await r.arrayBuffer()).byteLength }))`);
        if (resumed.status !== 206 || resumed.size !== 8) throw new Error(`video after worker restart: ${JSON.stringify(resumed)}`);
        // A modified file must fail instead of mixing different versions.
        inContainer("sh", "-c", "printf x >> ~/Downloads/media/range.mp4");
        const stale = await ev(`fetch(${video}.src, { headers: { Range: "bytes=0-15" } }).then((r) => r.arrayBuffer()).then(() => false, () => true)`);
        if (!stale || !(await ev(`${video}.dataset.error.includes("changed since")`))) throw new Error("changed video was served as the original version");
        await ev(`window.closedVideo = ${video}; document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "video closed");
        if (await ev(`window.closedVideo.hasAttribute("src")`)) throw new Error("closing the preview left the media source active");
        await ev(`delete window.closedVideo`);
        inContainer("rm", "/home/user/Downloads/media/range.mp4");
        return `${(size / 1e6).toFixed(1)} MB video; ${(first / 1e3).toFixed(0)} KB for metadata, playback after seeking, exact/suffix ranges, worker restart, changed-file rejection and cleanup`;
    });
}

export async function checkMKV(checks) {
    const { work, container, inContainer, step, ev, waitFor, click, type, open, listed, status } = checks;
    await step("files: stream MKV and seek", async () => {
        // Remux the indexed H.264 fixture into Matroska, without transcoding.
        execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", videoFixture(work), "-c", "copy", `${work}/range.mkv`]);
        execFileSync("docker", ["cp", "-q", `${work}/range.mkv`, `${container}:/home/user/Downloads/media/range.mkv`]);
        execFileSync("docker", ["exec", container, "chown", "user", "/home/user/Downloads/media/range.mkv"]);
        await open("fs/#/media/", `${listed}.includes("range.mkv")`, "the MKV video");
        await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === "range.mkv").click()`);
        const video = 'document.querySelector("dialog.preview video")';
        await waitFor(`${video}?.dataset.streamed === "true" && ${video}.readyState >= 1 && ${video}.duration > 29`, "MKV metadata from ranges", 30000);
        await ev(`${video}.muted = true; ${video}.currentTime = 24; ${video}.play()`);
        await waitFor(`${video}.currentTime > 24.2 && ${video}.videoWidth === 320`, "MKV playback after seeking", 15000);
        const range = await ev(`fetch(${video}.src, { headers: { Range: "bytes=0-15" } }).then(async (r) => ({ status: r.status, type: r.headers.get("Content-Type"), length: (await r.arrayBuffer()).byteLength }))`);
        if (range.status !== 206 || range.type !== "video/x-matroska" || range.length !== 16) throw new Error(`MKV range: ${JSON.stringify(range)}`);
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "MKV preview closed");
        inContainer("rm", "/home/user/Downloads/media/range.mkv");
        return "Matroska/H.264 streamed, played and sought using byte ranges";
    });
}
