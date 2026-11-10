// Native players live in the trusted page, aligned over inert placeholders in
// its opaque-origin document frame. This keeps the existing native range/SW
// transport usable without weakening the document sandbox's origin isolation.
import { call, collect } from "./requests.js";
import { mediaStream } from "./media-stream.js";
import { resourceAddress } from "./preview-resources.js";
import { el } from "./preview-dom.js";

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
            if (mode !== "proxy" || !["audio", "video"].includes(kind) || !Number.isSafeInteger(id) || players.has(id) || players.size >= 8 || abort.signal.aborted) return { error: "Media preview is unavailable." };
            const at = resourceAddress(src, base, dir);
            if (!at?.remote) return { error: "This media preview needs an HTTP or HTTPS source." };
            const entry = {};
            players.set(id, entry);
            let tunnel;
            const cancel = () => tunnel?.close();
            abort.signal.addEventListener("abort", cancel, { once: true });
            try {
                tunnel = await call({ type: "preview-resource", resource: "media", url: at.url });
                abort.signal.throwIfAborted();
                const info = tunnel.reply;
                await collect(tunnel, 1, () => {});
                if (!info.mime?.startsWith(kind + "/") || !Number.isSafeInteger(info.total_size) || info.total_size < 1) throw new Error("Not a supported media source.");
                const media = await mediaStream(info.url, { size: info.total_size, type: info.mime, mtime: info.validator, remote: true }, abort.signal);
                abort.signal.throwIfAborted();
                media.classList.add("preview-embedded-media");
                entry.element = media;
                layer ??= el("div", { className: "preview-media-layer" });
                frame.parentElement.append(layer);
                layer.append(media);
                place(id, rect);
                return { media: true };
            } catch (error) {
                entry.element?.stop();
                if (players.get(id) === entry) players.delete(id);
                return { error: error.message };
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
