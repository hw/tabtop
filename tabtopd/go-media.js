// The remote browser's audio and video (see docs/browser-plan.md, section
// 6). The copy of the page in the frame can't play anything (its policy
// has no media, and it's at an origin of its own, which the streaming
// service worker doesn't serve): where the page had a player with a file
// to play, the frame draws a box, and here a native player is laid over it,
// in this trusted page, its file read from the site by the server in parts
// as it plays (ranges through the service worker, as the files page's
// previews play theirs, see preview-media.js; asked for over the tab's
// tunnel, a few parts ahead). The site
// isn't contacted from this device; the player is this page's, not the
// site's: its script doesn't run here.
import { call, collect } from "../tabtop/requests.js";
import { createMediaSource } from "../tabtop/media-source.js";
import { mediaWorker } from "../tabtop/stream-worker.js";

const MAX_PLAYERS = 8;

// picture(url) is a picture the page has fetched through the server (a
// Blob), for a video's poster; sized(key, ratio) is told a video's
// proportions, once known, for its box.
// Parts of a player's file asked for before it asks, to be there when it
// does: the server's fetch of one and its way here overlap the next's, and
// the round trip to the server is hidden. A part's 1 MiB (media-source.js).
const AHEAD = 3;
const AHEAD_KEEP = 30_000;  // a part asked for ahead and not taken, kept so long

export function goMedia(frame, { picture, sized, range, failed, passOn } = {}) {
    // The player's parts, over the tab's tunnel (range), as tunnels for
    // ranged-file.js: what a go-resource request's tunnel would say, and
    // its bytes. Without range (the tab's tunnel isn't open), one of its own.
    const ahead = new Map();  // url + " " + offset -> {at, got: Promise}
    function part(url, offset, length, size, mtime) {
        const got = range?.(url, { offset, length, if_size: size, if_mtime: mtime });
        got?.catch(() => {});
        return got;
    }
    function readAhead(url, from, size, mtime, length) {
        for (let i = 0, at = from; i < AHEAD && at < size; i++, at += length) {
            const key = url + " " + at;
            if (ahead.has(key)) continue;
            const got = part(url, at, Math.min(length, size - at), size, mtime);
            if (!got) return;
            ahead.set(key, { got, length: Math.min(length, size - at) });
            if (ahead.size > AHEAD * MAX_PLAYERS) ahead.delete(ahead.keys().next().value);
            setTimeout(() => ahead.get(key)?.got === got && ahead.delete(key), AHEAD_KEEP);
        }
    }
    async function tabCall(req) {
        if (req.type !== "go-resource" || req.resource !== "media" || !range) return call(req);
        const { url, offset = 0, length = 0, if_size: size = 0, if_mtime: mtime = "" } = req;
        const key = url + " " + offset;
        let got = ahead.get(key);
        ahead.delete(key);
        if (got && got.length !== length) got = null;  // a part cut otherwise (a seek's)
        if (!got) {
            // Not what was asked for ahead: the player went elsewhere.
            for (const k of [...ahead.keys()]) if (k.startsWith(url + " ")) ahead.delete(k);
            got = { got: part(url, offset, length, size, mtime) };
            if (!got.got) return call(req);
        }
        if (length > 0) readAhead(url, offset + length, size, mtime, length);
        const { bytes, reply } = await got.got;
        return { reply, bytes, close() {} };
    }
    const mediaStream = createMediaSource({ call: tabCall, collect, getWorker: mediaWorker, onError: (media, error) => {
        for (const [key, entry] of players) {
            if (entry.element !== media) continue;
            closePlayer(key);
            failed?.(key, error);
            break;
        }
    } });

    const players = new Map();  // the frame's box's key -> {element, stopped}
    const abort = new AbortController();
    let layer = null;

    function closePlayer(key) {
        const player = players.get(key);
        if (!player) return;
        players.delete(key);
        player.controller.abort();
        player.element?.remove();
        if (player.poster) URL.revokeObjectURL(player.poster);
    }

    // passScrolling has the wheel turned, or a finger dragged, over a player
    // scroll the page under it, as it would were the player the page's (a
    // feed of videos scrolled through, the video taking the screen), not
    // the player: what it's given goes to the frame (passOn). Taps, and
    // the player's own controls, are the player's still.
    function passScrolling(media) {
        media.addEventListener("wheel", (e) => {
            const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1;
            e.preventDefault();
            passOn?.(e.clientX, e.clientY, e.deltaX * unit, e.deltaY * unit, "wheel");
        }, { passive: false });
        let last = null;
        media.addEventListener("touchstart", (e) => {
            const t = e.touches[0];
            last = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY } : null;
        }, { passive: true });
        media.addEventListener("touchmove", (e) => {
            const t = e.touches[0];
            if (!last || !t || e.touches.length !== 1) return;
            e.preventDefault();
            passOn?.(t.clientX, t.clientY, last.x - t.clientX, last.y - t.clientY, "drag");
            last = { x: t.clientX, y: t.clientY };
        }, { passive: false });
        media.addEventListener("touchend", () => { last = null; }, { passive: true });
        media.style.touchAction = "none";  // its drags are passed on, not the browser's
    }

    // place lays a player over its box, kept within the frame's area (the
    // frame says where the box is); hidden while its box isn't shown.
    function place({ key, rect, clip, shown, fit, position }) {
        const player = players.get(key);
        if (!player) return;
        player.placement = { key, rect, clip, shown, fit, position };
        const media = player.element;
        if (!media) return;
        if (!shown || !rect || !clip || ![rect.x, rect.y, rect.width, rect.height, clip.x, clip.y, clip.width, clip.height].every(Number.isFinite)) {
            media.style.display = "none";
            return;
        }
        const area = frame.getBoundingClientRect(), host = frame.parentElement.getBoundingClientRect();
        const left = Math.max(0, rect.x, clip.x), top = Math.max(0, rect.y, clip.y);
        const right = Math.min(area.width, rect.x + rect.width, clip.x + clip.width);
        const bottom = Math.min(area.height, rect.y + rect.height, clip.y + clip.height);
        if (right - left < 8 || bottom - top < 8) {
            media.style.display = "none";  // scrolled out of the frame
            return;
        }
        Object.assign(media.style, {
            display: "", left: `${area.left - host.left + rect.x}px`, top: `${area.top - host.top + rect.y}px`,
            width: `${rect.width}px`, height: `${rect.height}px`,
            clipPath: `inset(${top - rect.y}px ${rect.x + rect.width - right}px ${rect.y + rect.height - bottom}px ${left - rect.x}px)`,
            objectFit: ["fill", "contain", "cover", "none", "scale-down"].includes(fit) ? fit : "contain",
            objectPosition: typeof position === "string" && position.length <= 128 ? position : "",
        });
    }

    // start plays media, muted if this browser won't play it with sound
    // unasked (its autoplay rules: the person can unmute it).
    function start(media) {
        media.play().catch((err) => {
            if (err?.name !== "NotAllowedError" || media.muted) return;
            media.muted = true;
            return media.play();
        }).catch(() => {});
    }

    return {
        // open makes a player for the box key, of kind, playing src (an
        // http(s) address the page had); its error, if it can't.
        async open({ key, kind, src, rect, clip, fit, position, muted, loop, poster, play }) {
            if (!["audio", "video"].includes(kind) || !Number.isSafeInteger(key) || typeof src !== "string" || !/^https?:\/\//i.test(src)) {
                return { error: "This media can't be played here." };
            }
            if (players.has(key)) return {};
            if (players.size >= MAX_PLAYERS || abort.signal.aborted) return { error: "Too many players on this page." };
            const controller = new AbortController();
            const { signal } = controller;
            const entry = { controller, play: !!play, placement: { key, rect, clip, shown: true, fit, position } };
            players.set(key, entry);
            let tunnel;
            const cancel = () => tunnel?.close();
            signal.addEventListener("abort", cancel, { once: true });
            try {
                // Its size, type and version, asked for first; it's read in
                // parts as it plays.
                tunnel = await tabCall({ type: "go-resource", resource: "media", url: src });
                signal.throwIfAborted();
                const info = tunnel.reply;
                if (!tunnel.bytes) await collect(tunnel, 1, () => {});
                if (!info.mime?.startsWith(kind + "/") && !(kind === "video" && info.mime?.startsWith("audio/"))) throw new Error("Not a supported media file.");
                if (!Number.isSafeInteger(info.total_size) || info.total_size < 1) throw new Error("Not a supported media file.");
                tunnel.close();
                const file = { size: info.total_size, type: info.mime, mtime: info.validator, remote: true, via: "go-resource" };
                const media = await mediaStream(info.url, file, signal);
                entry.element = media;
                signal.throwIfAborted();
                media.addEventListener("loadedmetadata", () => {
                    // Its proportions for its box, and its size and length
                    // for the page (the engine has none of its own).
                    const meta = { w: media.videoWidth || 0, h: media.videoHeight || 0, duration: Number.isFinite(media.duration) ? media.duration : 0 };
                    sized?.(key, media.videoWidth > 0 && media.videoHeight > 0 ? media.videoWidth / media.videoHeight : 0, meta);
                });
                media.muted = !!muted;
                media.loop = !!loop;
                if (kind === "video" && typeof poster === "string" && /^https?:\/\//i.test(poster) && picture) {
                    picture(poster).then((blob) => {
                        if (!signal.aborted) media.poster = entry.poster = URL.createObjectURL(blob);
                    }, () => {});
                }
                Object.assign(media.style, { position: "absolute", background: "#000", zIndex: "2", display: "none" });
                if (!layer) {
                    layer = document.createElement("div");
                    Object.assign(layer.style, { position: "absolute", inset: "0", pointerEvents: "none", overflow: "hidden" });
                    frame.parentElement.append(layer);
                }
                media.style.pointerEvents = "auto";
                passScrolling(media);
                layer.append(media);
                place(entry.placement);
                if (entry.play) start(media);
                return {};
            } catch (error) {
                entry.element?.stop?.();
                if (players.get(key) !== entry) return null;
                closePlayer(key);
                return { error: error.message };
            } finally {
                signal.removeEventListener("abort", cancel);
                tunnel?.close();
            }
        },
        place,
        // play starts or stops the player of a box as the page did its own
        // (or does once it's made).
        play(key, on) {
            const player = players.get(key);
            if (!player) return;
            player.play = on;
            const media = player.element;
            if (media) on ? start(media) : media.pause();
        },
        // keep stops the players of boxes not among keys: gone from the page.
        keep(keys) {
            for (const key of players.keys()) if (!keys.has(key)) closePlayer(key);
        },
        stop() {
            abort.abort();
            for (const key of players.keys()) closePlayer(key);
            ahead.clear();
            layer?.remove();
            layer = null;
        },
    };
}
