// A native audio or video element backed by encrypted, version-checked file ranges.
// Each browser fetch gets a fresh MessagePort from the stateless service
// worker, so restarting the worker doesn't lose an open preview's identity.
import { call, collect } from "./requests.js";
import { mediaWorker } from "./download.js";

const PART = 1 << 20;
const BUFFER_LIMIT = 200e6;

export async function mediaStream(path, file, signal) {
    const worker = await mediaWorker();
    signal?.throwIfAborted();
    const kind = file.type.startsWith("audio/") ? "audio" : "video";
    const media = document.createElement(kind);
    Object.assign(media, { controls: true, playsInline: true, preload: "metadata" });
    media.dataset.bytes = "0";
    let stopped = false;
    let objectURL = null;
    const active = new Set();
    let workerInstance = null;
    const retiredInstances = new Set();
    const finish = (request) => {
        if (request.closed) return;
        request.closed = true;
        request.tunnel?.close();
        request.port.close();
        active.delete(request);
    };
    const id = worker ? crypto.randomUUID() : null;
    const answer = (e) => {
        if (e.data?.type !== "media-range" || e.data.id !== id || !e.ports[0] ||
            new URL(e.source?.scriptURL ?? "about:blank").pathname !== new URL("./download-sw.js", import.meta.url).pathname) return;
        const port = e.ports[0];
        // A stopped worker cannot send cancellation on its old ports. Retire
        // those requests when its replacement first contacts this preview.
        // Keep live paused responses: an idle timeout would break resuming.
        if (retiredInstances.has(e.data.instance)) {
            port.postMessage({ error: "worker was replaced" });
            port.close();
            return;
        }
        if (typeof e.data.instance === "string" && e.data.instance.length <= 100 && e.data.instance !== workerInstance) {
            if (workerInstance !== null) {
                retiredInstances.add(workerInstance);
                if (retiredInstances.size > 32) retiredInstances.delete(retiredInstances.values().next().value);
            }
            for (const request of active) finish(request);
            workerInstance = e.data.instance;
        }
        if (stopped || active.size >= 8) {
            port.postMessage({ error: "media preview is unavailable" });
            port.close();
            return;
        }
        const request = { port, tunnel: null, closed: false, busy: false };
        active.add(request);
        port.onmessage = async ({ data: m }) => {
            if (m?.cancel) { finish(request); return; }
            if (request.closed || request.busy) return;
            const { begin, end } = m ?? {};
            if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end > file.size || end <= begin || end - begin > PART) {
                port.postMessage({ error: "not a part of the media file" });
                finish(request);
                return;
            }
            request.busy = true;
            try {
                const t = await call({ type: "file", path, offset: begin, length: end - begin, if_mtime: file.mtime, if_size: file.size });
                if (request.closed || stopped) { t.close(); return; }
                request.tunnel = t;
                const blob = await collect(t, end - begin, () => {}, file.type);
                const bytes = await blob.arrayBuffer();
                if (request.closed) return;
                media.dataset.bytes = String(Number(media.dataset.bytes) + bytes.byteLength);
                port.postMessage({ bytes }, [bytes]);
            } catch (err) {
                if (!request.closed) {
                    media.dataset.error = err.message;
                    port.postMessage({ error: err.message });
                    finish(request);
                }
            } finally {
                request.tunnel?.close();
                request.tunnel = null;
                request.busy = false;
            }
        };
        port.start();
        port.postMessage({ size: file.size, type: file.type });
    };
    media.stop = () => {
        if (stopped) return;
        stopped = true;
        signal?.removeEventListener("abort", media.stop);
        navigator.serviceWorker?.removeEventListener("message", answer);
        for (const request of active) {
            request.port.postMessage({ error: "preview closed" });
            finish(request);
        }
        media.removeEventListener("error", failed);
        media.pause();
        media.removeAttribute("src");
        media.load();
        if (objectURL) URL.revokeObjectURL(objectURL);
    };
    const failed = () => {
        const note = document.createElement("p");
        note.className = "hint";
        note.textContent = media.dataset.error || `This ${kind} can't be played here. Download it instead.`;
        media.stop();
        media.replaceWith(note);
    };
    media.addEventListener("error", failed);
    signal?.addEventListener("abort", media.stop, { once: true });
    if (worker) {
        navigator.serviceWorker.addEventListener("message", answer);
        media.dataset.streamed = "true";
        media.src = new URL(`./stream/media/${id}`, import.meta.url).href;
    } else {
        if (file.size > BUFFER_LIMIT) throw new Error(`streaming requires HTTPS and service worker support; download this ${kind} instead`);
        const t = await call({ type: "file", path, if_mtime: file.mtime, if_size: file.size });
        try {
            const cancel = () => t.close();
            signal?.addEventListener("abort", cancel, { once: true });
            try {
                signal?.throwIfAborted();
                const blob = await collect(t, file.size, () => {}, file.type);
                signal?.throwIfAborted();
                objectURL = URL.createObjectURL(blob);
            } finally {
                signal?.removeEventListener("abort", cancel);
            }
        } finally {
            t.close();
        }
        media.dataset.streamed = "false";
        media.dataset.bytes = String(file.size);
        media.src = objectURL;
    }
    return media;
}
