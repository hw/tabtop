// Native players live in the trusted page, aligned over inert placeholders in
// its opaque-origin document frame. This keeps the existing native range/SW
// transport usable without weakening the document sandbox's origin isolation.
import { call, collect } from "./requests.js";
import { mediaStream } from "./media-stream.js";
import { resourceAddress } from "./preview-resources.js";
import { el } from "./preview-dom.js";
import { typeOf } from "./preview-model.js";

export function frameMedia(frame, dir, mode) {
    const players = new Map();
    const abort = new AbortController();
    let layer;
    function place(id, rect) {
        const media = players.get(id)?.element;
        const host = frame.parentElement;
        if (!media || !host || !rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return;
        const area = frame.getBoundingClientRect(), parent = host.getBoundingClientRect();
        // Kept inside the frame's own area: the document chooses the rect.
        const width = Math.max(0, Math.min(area.width, rect.width)), height = Math.max(0, Math.min(400, area.height, rect.height));
        const x = Math.max(0, Math.min(area.width - width, rect.x)), y = Math.max(0, Math.min(area.height - height, rect.y));
        media.style.left = `${area.left - parent.left + x}px`;
        media.style.top = `${area.top - parent.top + y}px`;
        media.style.width = `${width}px`;
        media.style.height = `${height}px`;
    }
    return {
        async open({ src, base = "", kind, id, rect }) {
            if (!["audio", "video"].includes(kind) || !Number.isSafeInteger(id) || players.has(id) || players.size >= 8 || abort.signal.aborted) return { error: "Media preview is unavailable." };
            // From the web, only in Proxy mode; beside the file, in any.
            const at = resourceAddress(src, base, dir);
            if (!at) return { error: "Media source not supported." };
            if (at.remote && mode !== "proxy") return { error: "External media is blocked." };
            if (!at.remote && typeOf(at.url.split("/").pop() ?? "")?.kind !== kind) return { error: `Not ${kind === "audio" ? "audio" : "a video"}: ${at.url}` };
            const entry = {};
            players.set(id, entry);
            let tunnel;
            const cancel = () => tunnel?.close();
            abort.signal.addEventListener("abort", cancel, { once: true });
            try {
                let path, file;
                if (at.remote) {
                    tunnel = await call({ type: "preview-resource", resource: "media", url: at.url });
                    abort.signal.throwIfAborted();
                    const info = tunnel.reply;
                    await collect(tunnel, 1, () => {});
                    if (!info.mime?.startsWith(kind + "/") || !Number.isSafeInteger(info.total_size) || info.total_size < 1) throw new Error("Not a supported media source.");
                    path = info.url;
                    file = { size: info.total_size, type: info.mime, mtime: info.validator, remote: true };
                } else {
                    // Only its size and version asked for; it's read in
                    // parts as it plays.
                    tunnel = await call({ type: "file", path: at.url, offset: 0, length: 1 });
                    abort.signal.throwIfAborted();
                    const { size, mtime } = tunnel.reply;
                    if (!Number.isSafeInteger(size) || size < 1) throw new Error("Not a supported media source.");
                    path = at.url;
                    file = { size, type: typeOf(at.url.split("/").pop()).type, mtime };
                }
                tunnel.close();
                const media = await mediaStream(path, file, abort.signal);
                // Kept before anything else can throw, so it's stopped if so.
                entry.element = media;
                abort.signal.throwIfAborted();
                media.classList.add("preview-embedded-media");
                layer ??= el("div", { className: "preview-media-layer" });
                frame.parentElement.append(layer);
                layer.append(media);
                place(id, rect);
                return { media: true };
            } catch (error) {
                entry.element?.stop();
                if (players.get(id) === entry) players.delete(id);
                return { error: /^not found\.?$/i.test(error.message) ? `Local media not found: ${at.url}` : error.message };
            } finally {
                abort.signal.removeEventListener("abort", cancel);
                tunnel?.close();
            }
        },
        place,
        stop() {
            abort.abort();
            for (const player of players.values()) player.element?.stop();
            players.clear();
            layer?.remove();
        },
    };
}
