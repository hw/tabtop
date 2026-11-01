// Downloading files and zips from ~/Downloads through the encrypted
// tunnel, served by tabtopd, for the files page and the desktop's notices
// of new downloads. Where the browser allows service workers (HTTPS or
// localhost), a fetched file streams into an ordinary download through
// download-sw.js, so it goes to disk as it arrives; elsewhere it's
// collected first and then saved (see saveFile). Either way it's never
// shown as a page on this site. How each goes shows in the transfers
// panel (see ui.js).

import { call, collect, complete, saveBlob } from "./requests.js";
import { statusRow } from "./ui.js";

function el(tag, props = {}, ...children) {
    const e = Object.assign(document.createElement(tag), props);
    e.append(...children);
    return e;
}

// downloadWorker resolves to the active download service worker, or null
// where there's none: over plain HTTP, or where the browser refuses it (as
// in some private windows).
let downloadWorker = null;

// DOWNLOAD_SW_VERSION names the worker's version in its address. A
// browser checks an unchanged address for a newer worker only now and
// then, so it goes up whenever download-sw.js changes in a way the page
// relies on, as it did when zips of unknown size came in (2).
const DOWNLOAD_SW_VERSION = 2;

function worker() {
    downloadWorker ??= (async () => {
        try {
            const reg = await navigator.serviceWorker.register(new URL(`./download-sw.js?v=${DOWNLOAD_SW_VERSION}`, import.meta.url),
                { scope: new URL("./stream/", import.meta.url).pathname });
            // A browser that used the page before may still run an older
            // worker, which a new version replaces: wait for it to take
            // over, so downloads use it.
            const end = Date.now() + 5000;
            while ((!reg.active || reg.installing || reg.waiting) && Date.now() < end) {
                await new Promise((r) => setTimeout(r, 50));
            }
            return reg.active;
        } catch {
            return null;
        }
    })();
    return downloadWorker;
}

// fetchFile downloads the file at path. How it goes shows in the
// transfers panel, with a Cancel button.
export async function fetchFile(path) {
    const label = path.split("/").pop();
    const row = statusRow(`${label}: starting`, true);
    try {
        const sw = await worker();
        const t = await call({ type: "file", path });
        row.signal.addEventListener("abort", () => t.close());
        if (row.signal.aborted) {
            t.close();  // while it was opening
        }
        const { name, size } = t.reply;
        const progress = (got) => {
            row.set(`${name}: ${size ? Math.floor(got * 100 / size) : 100}%`);
            row.progress(size ? got / size : 1);
        };
        const failed = await (sw ? streamFile : saveFile)(t, name, size, progress, sw);
        if (row.signal.aborted) {
            row.set(`${name}: cancelled`);
        } else if (failed) {
            row.set(`${name}: ${failed}`, true);
        } else {
            row.set(`${name}: downloaded, ${humanBytes(size)}`);
        }
    } catch (err) {
        row.set(`${label}: not downloaded: ${err.message}`, true);
    }
    row.finish();
}

// The biggest a zip request can be: the server takes requests up to 1 MiB.
const MAX_REQUEST = 1000000;

// fetchZip downloads names, in the folder dir, as one zip, which the server
// makes as it sends it. How it goes shows in the status list, with a
// Cancel button.
export async function fetchZip(dir, names) {
    const label = names.length === 1 ? `${names[0]}/` : `${names.length} items`;
    const row = statusRow(`${label}: zipping`, true);
    try {
        const req = { type: "zip", path: dir, names };
        if (JSON.stringify(req).length > MAX_REQUEST) {
            throw new Error("too many to download at once; pick fewer");
        }
        const sw = await worker();
        const t = await call(req);
        row.signal.addEventListener("abort", () => t.close());
        if (row.signal.aborted) {
            t.close();  // while it was opening
        }
        const { name } = t.reply;
        let bytes = 0;
        const progress = (got) => {
            bytes = got;
            row.set(`${name}: ${humanBytes(got)}`);
            row.progress(null);
        };
        const failed = await (sw ? streamFile : saveFile)(t, name, null, progress, sw);
        if (row.signal.aborted) {
            row.set(`${name}: cancelled`);
        } else if (failed) {
            row.set(`${name}: ${failed}`, true);
        } else if (t.trailer.skipped) {
            row.set(`${name}: downloaded, ${humanBytes(bytes)}, without ${t.trailer.skipped} files or folders that couldn't be read`, true);
        } else {
            row.set(`${name}: downloaded, ${humanBytes(bytes)}`);
        }
    } catch (err) {
        row.set(`${label}: not downloaded: ${err.message}`, true);
    }
    row.finish();
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
function streamFile(t, name, size, progress, sw) {
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
            done = true;
            clearInterval(ping);
            clearTimeout(idle);
            port1.onmessage = null;
            t.close();
            setTimeout(() => frame.remove(), 1000);
            resolve(failed);
        }
        port1.onmessage = async (e) => {
            const m = e.data;
            if (m.started) {
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
        sw.postMessage({ type: "download", id, name, size, port: port2 }, [port2]);
        frame.src = new URL(`./stream/${id}/${encodeURIComponent(name)}`, import.meta.url).href;
        document.body.append(frame);
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
