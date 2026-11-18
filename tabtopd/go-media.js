// The remote browser's audio and video (see docs/browser-plan.md, section
// 6). The copy of the page in the frame can't play anything (its policy
// has no media, and it's at an origin of its own, which the streaming
// service worker doesn't serve): where the page had a player with a file
// to play, the frame draws a box, and here a native player is laid over it,
// in this trusted page, its file read from the site by the server in parts
// as it plays (go-resource "media", ranges through the service worker, as
// the files page's previews play theirs; see preview-media.js). The site
// isn't contacted from this device; the player is this page's, not the
// site's: its script doesn't run here.
import { call, collect } from "../tabtop/requests.js";
import { mediaStream } from "../tabtop/media-stream.js";

const MAX_PLAYERS = 8;

// picture(url) is a picture the page has fetched through the server (a
// Blob), for a video's poster; sized(key, ratio) is told a video's
// proportions, once known, for its box.
export function goMedia(frame, { picture, sized } = {}) {
    const players = new Map();  // the frame's box's key -> {element, stopped}
    const abort = new AbortController();
    let layer = null;

    // place lays a player over its box, kept within the frame's area (the
    // frame says where the box is); hidden while its box isn't shown.
    function place(key, rect, shown) {
        const media = players.get(key)?.element;
        if (!media) return;
        if (!shown || !rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) {
            media.style.display = "none";
            return;
        }
        const area = frame.getBoundingClientRect(), host = frame.parentElement.getBoundingClientRect();
        const left = Math.max(0, rect.x), top = Math.max(0, rect.y);
        const right = Math.min(area.width, rect.x + rect.width), bottom = Math.min(area.height, rect.y + rect.height);
        if (right - left < 8 || bottom - top < 8) {
            media.style.display = "none";  // scrolled out of the frame
            return;
        }
        Object.assign(media.style, {
            display: "", left: `${area.left - host.left + left}px`, top: `${area.top - host.top + top}px`,
            width: `${right - left}px`, height: `${bottom - top}px`,
        });
    }

    return {
        // open makes a player for the box key, of kind, playing src (an
        // http(s) address the page had); its error, if it can't.
        async open({ key, kind, src, rect, muted, loop, poster }) {
            if (!["audio", "video"].includes(kind) || !Number.isSafeInteger(key) || typeof src !== "string" || !/^https?:\/\//i.test(src)) {
                return { error: "This media can't be played here." };
            }
            if (players.has(key)) return {};
            if (players.size >= MAX_PLAYERS || abort.signal.aborted) return { error: "Too many players on this page." };
            const entry = {};
            players.set(key, entry);
            let tunnel;
            const cancel = () => tunnel?.close();
            abort.signal.addEventListener("abort", cancel, { once: true });
            try {
                // Its size, type and version, asked for first; it's read in
                // parts as it plays.
                tunnel = await call({ type: "go-resource", resource: "media", url: src });
                abort.signal.throwIfAborted();
                const info = tunnel.reply;
                await collect(tunnel, 1, () => {});
                if (!info.mime?.startsWith(kind + "/") && !(kind === "video" && info.mime?.startsWith("audio/"))) throw new Error("Not a supported media file.");
                if (!Number.isSafeInteger(info.total_size) || info.total_size < 1) throw new Error("Not a supported media file.");
                tunnel.close();
                const file = { size: info.total_size, type: info.mime, mtime: info.validator, remote: true, via: "go-resource" };
                const media = await mediaStream(info.url, file, abort.signal);
                entry.element = media;
                abort.signal.throwIfAborted();
                media.addEventListener("loadedmetadata", () => {
                    if (media.videoWidth > 0 && media.videoHeight > 0) sized?.(key, media.videoWidth / media.videoHeight);
                });
                media.muted = !!muted;
                media.loop = !!loop;
                if (kind === "video" && typeof poster === "string" && /^https?:\/\//i.test(poster) && picture) {
                    picture(poster).then((blob) => { if (!abort.signal.aborted) media.poster = URL.createObjectURL(blob); }, () => {});
                }
                Object.assign(media.style, { position: "absolute", background: "#000", zIndex: "2", display: "none" });
                if (!layer) {
                    layer = document.createElement("div");
                    Object.assign(layer.style, { position: "absolute", inset: "0", pointerEvents: "none", overflow: "hidden" });
                    frame.parentElement.append(layer);
                }
                media.style.pointerEvents = "auto";
                layer.append(media);
                place(key, rect, true);
                return {};
            } catch (error) {
                entry.element?.stop?.();
                if (players.get(key) === entry) players.delete(key);
                return { error: abort.signal.aborted ? "" : error.message };
            } finally {
                abort.signal.removeEventListener("abort", cancel);
                tunnel?.close();
            }
        },
        place,
        // keep stops the players of boxes not among keys: gone from the page.
        keep(keys) {
            for (const key of [...players.keys()]) if (!keys.has(key)) this.close(key);
        },
        // close stops the player of a box that's gone.
        close(key) {
            const player = players.get(key);
            player?.element?.stop?.();
            player?.element?.remove();
            players.delete(key);
        },
        stop() {
            abort.abort();
            for (const player of players.values()) {
                player.element?.stop?.();
                player.element?.remove();
            }
            players.clear();
            layer?.remove();
            layer = null;
        },
    };
}
