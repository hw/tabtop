// Downloading files and zips from ~/Downloads through the encrypted
// tunnel, served by tabtopd, for the files page and the desktop's notices
// of new downloads. Where the browser allows service workers (HTTPS or
// localhost), a fetched file streams into an ordinary download through
// download-sw.js, so it goes to disk as it arrives; elsewhere it's
// collected first and then saved (see saveFile). Either way it's never
// shown as a page on this site. How each goes shows in the transfers
// panel (see ui.js).

import { call, collect, complete, saveBlob } from "./requests.js";
import { runTransfer } from "./transfer.js";
import { statusRow } from "./ui.js";
import { streamWorker } from "./stream-worker.js";
// Compatibility for pages loaded before worker registration was extracted.
export { streamWorker, mediaWorker } from "./stream-worker.js";

function el(tag, props = {}, ...children) {
    const e = Object.assign(document.createElement(tag), props);
    e.append(...children);
    return e;
}

// File and ZIP downloads share lifecycle handling; their wire metadata and
// progress presentation remain different (ZIP sizes are unknown).
export function fetchFile(path) {
    return fetchDownload({ type: "file", path }, path.split("/").pop(), "starting", () => fetchFile(path));
}

// Leave room below the gateway's 1 MiB request limit.
const MAX_REQUEST = 1000000;

export function fetchZip(dir, names) {
    const label = names.length === 1 ? `${names[0]}/` : `${names.length} items`;
    return fetchDownload({ type: "zip", path: dir, names }, label, "zipping", () => fetchZip(dir, names));
}

async function fetchDownload(req, label, starting, retry) {
    const zip = req.type === "zip";
    const row = statusRow(`${label}: ${starting}`, true);
    row.destination("To: browser downloads");
    let name = label;
    let opened = false;
    const result = await runTransfer({
        signal: row.signal, retry,
        progress: (bytes, size) => {
            row.set(zip ? `${name}: ${humanBytes(bytes)}` : `${name}: ${size ? Math.floor(bytes * 100 / size) : 100}%`);
            row.progress(zip ? null : size ? bytes / size : 1);
        },
        run: async ({ signal, own, progress }) => {
            if (zip && JSON.stringify(req).length > MAX_REQUEST) {
                throw new Error("too many to download at once; pick fewer");
            }
            const sw = await streamWorker();
            signal.throwIfAborted();
            const t = await call(req);
            own(() => t.close());
            name = t.reply.name;
            opened = true;
            const size = zip ? null : t.reply.size;
            let bytes = 0;
            const failed = await (sw ? streamFile : saveFile)(t, name, size, (got) => {
                bytes = got;
                progress(got, size);
            }, sw, own);
            if (failed) { throw new Error(failed); }
            return { bytes: zip ? bytes : size, skipped: t.trailer?.skipped ?? 0 };
        },
    });
    if (result.state === "cancelled") {
        row.set(`${name}: cancelled`);
    } else if (result.state === "failed") {
        row.set(`${name}: ${opened ? "" : "not downloaded: "}${result.error.message}`, true);
    } else {
        const { bytes, skipped } = result.value;
        row.set(`${name}: downloaded, ${humanBytes(bytes)}${skipped ? `, without ${skipped} files or folders that couldn't be read` : ""}`, !!skipped);
    }
    row.finish(result.retry);
}

// humanBytes is a size as the listing shows it (see humanSize in main.go):
// in units of 1024, so the two agree.
export function humanBytes(n) {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    for (; n >= 1024 && i < units.length - 1; i++) {
        n /= 1024;
    }
    return `${i ? n.toFixed(1) : n} ${units[i]}`;
}

// How long the download may go without asking for more before it's given
// up, as when the browser stops the service worker or the download is
// paused, rather than leave it waiting with the tunnel open.
const STREAM_IDLE = 30000;

// streamFile hands the file to the service worker, one chunk each time the
// browser's download asks for more, and returns why it failed, or "". The
// service worker's response has the file's size, so the browser fails the
// download, rather than keeping it, if this ends early.
function streamFile(t, name, size, progress, sw, own) {
    return new Promise((resolve) => {
        const { port1, port2 } = new MessageChannel();
        const id = crypto.randomUUID();
        const frame = el("iframe", { hidden: true });
        let got = 0;
        let done = false;
        const ping = setInterval(() => sw.postMessage({ type: "ping" }), 10000);  // keeps it running
        let idle = setTimeout(() => finish("the download didn't start"), 10000);
        const stalled = () => {
            port1.postMessage({ error: "stalled" });
            finish("failed: the download stopped");
        };
        function finish(failed) {
            if (done) { return; }
            done = true;
            clearInterval(ping);
            clearTimeout(idle);
            clearTimeout(fallback);
            port1.onmessage = null;
            setTimeout(() => { frame.remove(); port1.close(); }, 1000);
            resolve(failed);
        }
        port1.onmessage = async (e) => {
            const m = e.data;
            if (m.ready) {
                openFrame();
            } else if (m.started) {
                clearTimeout(idle);
                idle = setTimeout(stalled, STREAM_IDLE);
                progress(0);
            } else if (m.cancel) {
                finish("cancelled");
            } else if (m.pull) {
                clearTimeout(idle);
                const data = await t.nextChunk();
                if (done) {
                    return;
                }
                idle = setTimeout(stalled, STREAM_IDLE);
                if (data) {
                    got += data.byteLength;
                    progress(got);
                    port1.postMessage({ data }, [data]);
                } else if (complete(t, got, size)) {
                    port1.postMessage({ done: true });
                    finish("");
                } else {
                    port1.postMessage({ error: "ended early" });
                    finish(`failed: ${t.closeReason || "connection lost"}`);
                }
            }
        };
        // The frame opens once the worker says it's ready (see
        // download-sw.js), or after a while anyway, for an older worker
        // that doesn't say.
        const openFrame = () => {
            clearTimeout(fallback);
            if (!frame.src && !done) {
                frame.src = new URL(`./stream/${id}/${encodeURIComponent(name)}`, import.meta.url).href;
                document.body.append(frame);
            }
        };
        const fallback = setTimeout(openFrame, 2000);
        own(() => finish("cancelled"));
        sw.postMessage({ type: "download", id, name, size, port: port2 }, [port2]);
    });
}

// saveFile collects the file (see collect), then saves it, and returns why
// it failed, or "".
async function saveFile(t, name, size, progress) {
    try {
        saveBlob(await collect(t, size, progress), name);
        return "";
    } catch (err) {
        return `failed: ${err.message}`;
    }
}
