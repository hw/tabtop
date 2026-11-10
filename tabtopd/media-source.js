import { createRangedFileReader, validFileRange } from "./ranged-file.js";

// One native media source and its range-request lifecycle. Dependencies are
// explicit so cancellation and worker recovery can be tested through exports.
const PART = 1 << 20;
const BUFFER_LIMIT = 200e6;

export function createMediaSource({ call, collect, getWorker,
    document = globalThis.document, serviceWorker = globalThis.navigator?.serviceWorker,
    randomUUID = () => crypto.randomUUID(), urlAPI = URL, baseURL = import.meta.url }) {
    const readRange = createRangedFileReader({ call, collect });
    return async function mediaStream(path, file, signal) {
        const worker = await getWorker();
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
            request.abort.abort();
            request.port.close();
            active.delete(request);
        };
        const id = worker ? randomUUID() : null;
        const answer = (e) => {
            if (e.data?.type !== "media-range" || e.data.id !== id || !e.ports[0] ||
                new URL(e.source?.scriptURL ?? "about:blank").pathname !== new URL("./download-sw.js", baseURL).pathname) return;
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
            const request = { port, abort: new AbortController(), closed: false, busy: false };
            active.add(request);
            port.onmessage = async ({ data: m }) => {
                if (m?.cancel) { finish(request); return; }
                if (request.closed || request.busy) return;
                const { begin, end } = m ?? {};
                if (!validFileRange(begin, end, file.size, PART)) {
                    port.postMessage({ error: "not a part of the media file" });
                    finish(request);
                    return;
                }
                request.busy = true;
                try {
                    const bytes = await readRange(path, file, begin, end, { maxBytes: PART, signal: request.abort.signal });
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
            serviceWorker?.removeEventListener("message", answer);
            for (const request of active) {
                request.port.postMessage({ error: "preview closed" });
                finish(request);
            }
            media.removeEventListener("error", failed);
            media.pause();
            media.removeAttribute("src");
            media.load();
            if (objectURL) urlAPI.revokeObjectURL(objectURL);
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
            serviceWorker.addEventListener("message", answer);
            media.dataset.streamed = "true";
            media.src = new URL(`./stream/media/${id}`, baseURL).href;
        } else {
            if (file.remote) throw new Error("Proxied media streaming requires HTTPS and service worker support.");
            if (file.size > BUFFER_LIMIT) throw new Error(`streaming requires HTTPS and service worker support; download this ${kind} instead`);
            const t = await call({ type: "file", path, if_mtime: file.mtime, if_size: file.size });
            try {
                const cancel = () => t.close();
                signal?.addEventListener("abort", cancel, { once: true });
                try {
                    signal?.throwIfAborted();
                    const blob = await collect(t, file.size, () => {}, file.type);
                    signal?.throwIfAborted();
                    objectURL = urlAPI.createObjectURL(blob);
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
    };
}
