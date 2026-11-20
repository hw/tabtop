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

export function goMedia(frame, { picture, sized, played, range, failed, passOn, changed } = {}) {
    // The player's parts, over the tab's tunnel (range), as tunnels for
    // ranged-file.js: what a go-resource request's tunnel would say, and
    // its bytes. Without range (the tab's tunnel isn't open), one of its own.
    const ahead = new Map();  // url + " " + offset -> {at, got: Promise}
    const arrived = new Map();  // url -> told of each part's bytes, while its player loads
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
        if (length > 0) arrived.get(url)?.(bytes?.byteLength ?? bytes?.length ?? 0);
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
    const streams = new Map();
    const streamLimit = 16 << 20;
    let streamBytes = 0;

    function releaseStream(stream) {
        streamBytes -= stream.bytes;
        stream.bytes = 0;
        stream.queue.length = 0;
        stream.closed = true;
        if (stream.url) URL.revokeObjectURL(stream.url);
    }

    function drainStream(stream) {
        const source = stream.source;
        if (stream.closed || !source || source.readyState === "closed") return;
        try {
            while (stream.queue.length && !stream.buffers.some((buffer) => buffer?.updating)) {
                const command = stream.queue.shift();
                const size = typeof command.data === "string" ? command.data.length : 0;
                streamBytes -= size;
                stream.bytes -= size;
                const buffer = stream.buffers[command.buffer];
                switch (command.op) {
                    case "add": {
                        if (command.buffer !== stream.buffers.length || stream.buffers.length >= 8 ||
                            typeof command.mime !== "string" || !MediaSource.isTypeSupported(command.mime)) throw new Error("Unsupported stream format.");
                        const added = source.addSourceBuffer(command.mime);
                        added.addEventListener("updateend", () => drainStream(stream));
                        stream.buffers.push(added);
                        break;
                    }
                    case "config":
                        if (buffer.mode !== command.mode) buffer.mode = command.mode;
                        if (buffer.timestampOffset !== command.offset) buffer.timestampOffset = command.offset;
                        if (buffer.appendWindowStart !== command.start || buffer.appendWindowEnd !== (command.end ?? Infinity)) {
                            buffer.appendWindowStart = 0;
                            buffer.appendWindowEnd = command.end ?? Infinity;
                            buffer.appendWindowStart = command.start;
                        }
                        break;
                    case "append": buffer.appendBuffer(Uint8Array.from(atob(command.data), (c) => c.charCodeAt(0))); break;
                    case "drop": source.removeSourceBuffer(buffer); stream.buffers[command.buffer] = null; break;
                    case "remove": buffer.remove(command.start, command.end); break;
                    // All chunks in this operation have reached native
                    // updateend before execution reaches the acknowledgment.
                    case "ack": stream.report(command.buffer); break;
                    case "abort": buffer.abort(); break;
                    case "type": buffer.changeType(command.mime); break;
                    case "duration": source.duration = command.value ?? Infinity; break;
                    case "end": source.endOfStream(); break;
                    case "error": throw new Error("The site's media stream exceeded the relay limit.");
                    default: throw new Error("Invalid media stream operation.");
                }
            }
        } catch (error) {
            failStream(stream, error.message);
        }
    }

    function failStream(stream, error) {
        stream.error = error;
        releaseStream(stream);
        if (stream.key === undefined) return;
        closePlayer(stream.key);
        failed?.(stream.key, error);
    }

    function receiveStreams(commands) {
        if (!Array.isArray(commands)) return;
        for (const raw of commands.slice(0, 64)) {
            const id = raw?.stream;
            if (!Number.isSafeInteger(id) || id < 1) continue;
            let stream = streams.get(id);
            if (!stream) {
                if (streams.size >= 32) continue;
                stream = { queue: [], buffers: [], bytes: 0 };
                streams.set(id, stream);
            }
            if (stream.closed) continue;
            // Keep only fields used by the relay. The remote page controls
            // these commands and can never supply a URL to this player.
            const command = { op: typeof raw.op === "string" ? raw.op.slice(0, 16) : "",
                buffer: Number.isInteger(raw.buffer) ? raw.buffer : -1,
                mime: typeof raw.mime === "string" ? raw.mime.slice(0, 256) : "",
                mode: raw.mode === "sequence" ? "sequence" : "segments",
                offset: Number.isFinite(raw.offset) ? raw.offset : 0,
                start: Number.isFinite(raw.start) ? raw.start : 0,
                end: Number.isFinite(raw.end) ? raw.end : null,
                value: Number.isFinite(raw.value) ? raw.value : null,
                data: typeof raw.data === "string" ? raw.data : "",
            };
            const size = command.data.length;
            if (size > 65536 || streamBytes + size > streamLimit || stream.queue.length >= 512) {
                failStream(stream, "The site's media stream exceeded the relay limit.");
                continue;
            }
            stream.queue.push(command);
            if (command.op === "append") stream.arrived?.(Math.floor(size * 3 / 4));  // base64's bytes
            stream.bytes += size;
            streamBytes += size;
            drainStream(stream);
        }
    }

    function streamPlayer(id, key, kind, entry) {
        if (typeof MediaSource !== "function") throw new Error("This browser does not support Media Source Extensions.");
        let stream = streams.get(id);
        if (!stream) {
            if (streams.size >= 32) throw new Error("Too many media streams on this page.");
            stream = { queue: [], buffers: [], bytes: 0 };
            streams.set(id, stream);
        }
        if (stream.closed || stream.source) throw new Error(stream.error || "The media stream is no longer available.");
        const element = document.createElement(kind);
        element.controls = true;
        if (kind === "video") element.playsInline = true;
        stream.key = key;
        stream.source = new MediaSource();
        stream.url = URL.createObjectURL(stream.source);
        entry.stream = stream;
        stream.source.addEventListener("sourceopen", () => drainStream(stream));
        element.addEventListener("error", () => {
            if (!stream.closed) failStream(stream, element.error?.message || "The media stream could not be decoded.");
        });
        element.src = stream.url;
        return element;
    }


    function closePlayer(key) {
        const player = players.get(key);
        if (!player) return;
        players.delete(key);
        player.controller.abort();
        if (player.stream) {
            releaseStream(player.stream);
            player.element?.removeAttribute("src");
            player.element?.load();
        }
        player.element?.remove();
        player.loading?.done();
        told();
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
        // Its end: where a feed snaps to (see the frame's scrollUnder).
        const end = (e) => {
            const t = e.changedTouches?.[0];
            if (last && t) passOn?.(t.clientX, t.clientY, 0, 0, "drag-end");
            last = null;
        };
        media.addEventListener("touchend", end, { passive: true });
        media.addEventListener("touchcancel", end, { passive: true });
        media.style.touchAction = "none";  // its drags are passed on, not the browser's
    }

    // place lays a player over its box, kept within the frame's area (the
    // frame says where the box is); hidden while its box isn't shown.
    document.addEventListener("fullscreenchange", () => {
        for (const player of players.values()) place(player.placement);
    }, { signal: abort.signal });

    function place({ key, rect, clip, shown, fit, position }) {
        const player = players.get(key);
        if (!player) return;
        player.placement = { key, rect, clip, shown, fit, position };
        const media = player.element, loading = player.loading?.box;
        if (media && document.fullscreenElement === media) {
            media.style.clipPath = "none";
            return;
        }
        const hide = () => {
            if (media) media.style.display = "none";
            if (loading) loading.hidden = true;
        };
        if (!media && !loading) return;
        if (!shown || !rect || !clip || ![rect.x, rect.y, rect.width, rect.height, clip.x, clip.y, clip.width, clip.height].every(Number.isFinite)) {
            hide();
            return;
        }
        const area = frame.getBoundingClientRect(), host = frame.parentElement.getBoundingClientRect();
        const left = Math.max(0, rect.x, clip.x), top = Math.max(0, rect.y, clip.y);
        const right = Math.min(area.width, rect.x + rect.width, clip.x + clip.width);
        const bottom = Math.min(area.height, rect.y + rect.height, clip.y + clip.height);
        if (right - left < 8 || bottom - top < 8) {
            hide();  // scrolled out of the frame
            return;
        }
        const box = {
            left: `${area.left - host.left + rect.x}px`, top: `${area.top - host.top + rect.y}px`,
            width: `${rect.width}px`, height: `${rect.height}px`,
            clipPath: `inset(${top - rect.y}px ${rect.x + rect.width - right}px ${rect.y + rect.height - bottom}px ${left - rect.x}px)`,
        };
        if (media) {
            Object.assign(media.style, box, {
                display: "",
                objectFit: ["fill", "contain", "cover", "none", "scale-down"].includes(fit) ? fit : "contain",
                objectPosition: typeof position === "string" && position.length <= 128 ? position : "",
            });
        }
        if (loading) {
            Object.assign(loading.style, box);
            loading.classList.toggle("small", bottom - top < 120 || right - left < 240);
            loading.hidden = false;
        }
    }

    // told tells the page that a player's state changed (its list, in the
    // menu: see list), at most once a frame.
    let telling = 0;
    function told() {
        if (telling || !changed) return;
        telling = requestAnimationFrame(() => {
            telling = 0;
            changed();
        });
    }

    // skip treats a player as played to its end: the page is told it ended
    // (pause, ended, its time its length), as when it plays to the end, so
    // what it does then (the next video, the one after an advert) it does.
    // One still loading stops loading; one loaded stays, at its end.
    function skip(key) {
        const player = players.get(key);
        if (!player || player.skipped) return;
        player.skipped = true;
        player.play = false;
        const media = player.element;
        const length = Number.isFinite(media?.duration) && media.duration > 0 ? media.duration : player.length || 0;
        if (!media) {
            closePlayer(key);  // loading: no more of it
        } else {
            player.loading?.done();
            media.pause();
            if (length > 0 && media.seekable?.length) {
                try { media.currentTime = length; } catch { /* where it was */ }
            }
        }
        played?.(key, { t: length, playing: false, ended: true });
        told();
    }

    // layerHere is the layer the players are laid in, over the frame.
    function layerHere() {
        if (!layer) {
            layer = document.createElement("div");
            Object.assign(layer.style, { position: "absolute", inset: "0", pointerEvents: "none", overflow: "hidden" });
            frame.parentElement.append(layer);
        }
        return layer;
    }

    // loader shows, over a player's box till it can play, that it's
    // loading: what, from where (the file's address; a stream's the site's
    // player fetches itself), and a bar, how far it's come to playing.
    // Its stage (stage(fraction or null, words)) and bytes (arrived(n))
    // are told it; done takes it away.
    function loader(kind, src, stream) {
        const box = document.createElement("div");
        box.className = "go-media-loading";
        box.hidden = true;
        box.setAttribute("role", "progressbar");
        box.setAttribute("aria-valuemin", "0");
        box.setAttribute("aria-valuemax", "100");
        const what = Object.assign(document.createElement("div"), { className: "what" });
        const bar = Object.assign(document.createElement("div"), { className: "bar unknown" });
        const fill = document.createElement("i");
        bar.append(fill);
        box.append(what, bar);
        const noun = kind === "video" ? "video" : "sound";
        let words = "", bytes = 0, done = false;
        const say = () => {
            const amount = bytes > 0 ? ` (${bytes >= 1 << 20 ? (bytes / (1 << 20)).toFixed(1) + " MB" : Math.ceil(bytes / 1024) + " KB"})` : "";
            what.textContent = words + amount;
            box.setAttribute("aria-label", `Loading the ${noun}: ${what.textContent}`);
            told();
        };
        layerHere().append(box);
        return {
            box,
            get said() { return done ? "" : what.textContent; },
            stage(fraction, said) {
                if (done) return;
                words = said;
                if (fraction === null) {
                    bar.classList.add("unknown");
                    box.removeAttribute("aria-valuenow");
                } else {
                    const at = Math.max(0, Math.min(1, fraction));
                    bar.classList.remove("unknown");
                    fill.style.width = `${Math.round(at * 100)}%`;
                    box.setAttribute("aria-valuenow", String(Math.round(at * 100)));
                }
                say();
            },
            arrived(n) {
                if (done || !(n > 0)) return;
                bytes += n;
                say();
            },
            done() {
                done = true;
                box.remove();
                told();
            },
        };
    }

    // shortAddress is an address as its site and file name, what's
    // between elided: "cdn.example.com/…/clip.mp4".
    function shortAddress(src) {
        try {
            const u = new URL(src);
            const parts = u.pathname.split("/").filter(Boolean);
            const name = parts.at(-1) ?? "";
            const path = parts.length > 1 ? `/…/${name}` : `/${name}`;
            return u.host.replace(/^www\./, "") + (path === "/" ? "" : path) + (u.search ? "?…" : "");
        } catch {
            return src;
        }
    }

    // How near to playing a player is: its stages, then what it has ahead
    // of where it plays, of the few seconds a browser wants to start.
    const READY_AHEAD = 3;
    function loadingUntilReady(media, loading, wantsPlay) {
        const ahead = () => {
            const t = media.currentTime || 0;
            for (let i = 0; i < media.buffered.length; i++) {
                if (media.buffered.start(i) <= t + 0.5 && media.buffered.end(i) > t) return media.buffered.end(i) - t;
            }
            return 0;
        };
        const update = (e) => {
            // Ready: enough to play on; or, not to be played, its first picture
            // there (or as much as the browser loads before it's played).
            if (media.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return ready();
            // (The browser loading no more till it's played: all there'll be.)
            if (e?.type === "suspend" && media.paused && media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return ready();
            if (!wantsPlay() && (media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA || e?.type === "suspend" && media.readyState >= HTMLMediaElement.HAVE_METADATA)) return ready();
            if (media.readyState >= HTMLMediaElement.HAVE_METADATA) {
                const want = Math.min(READY_AHEAD, Number.isFinite(media.duration) && media.duration > 0 ? media.duration : READY_AHEAD);
                loading.stage(0.4 + 0.6 * Math.min(1, ahead() / want), "Buffering…");
            }
        };
        const events = ["loadedmetadata", "progress", "suspend", "loadeddata", "canplay", "canplaythrough", "playing", "error", "emptied"];
        const ready = () => {
            for (const type of events) media.removeEventListener(type, update);
            loading.done();
        };
        for (const type of events) media.addEventListener(type, type === "error" ? ready : update);
        update();
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
        streams: receiveStreams,
        // open makes a player for the box key, of kind, playing src (an
        // http(s) address the page had); its error, if it can't.
        async open({ key, kind, src, rect, clip, shown, fit, position, muted, loop, poster, play }) {
            const streamId = typeof src === "string" && Number(/^blob:tabtop-media\/([1-9]\d*)$/.exec(src)?.[1]);
            if (!["audio", "video"].includes(kind) || !Number.isSafeInteger(key) || typeof src !== "string" || !(Number.isSafeInteger(streamId) || /^https?:\/\//i.test(src))) {
                return { error: "This media can't be played here." };
            }
            if (players.has(key)) return {};
            if (players.size >= MAX_PLAYERS || abort.signal.aborted) return { error: "Too many players on this page." };
            const controller = new AbortController();
            const { signal } = controller;
            const entry = { controller, play: !!play, placement: { key, rect, clip, shown: shown !== false, fit, position } };
            players.set(key, entry);
            // Loading, over its box, till it can play.
            const loading = entry.loading = loader(kind, src, !!streamId);
            Object.assign(entry, { kind, src, stream: !!streamId });
            told();
            loading.stage(null, streamId ? "Starting the stream…" : "Asking the site…");
            place(entry.placement);
            let tunnel;
            const cancel = () => tunnel?.close();
            signal.addEventListener("abort", cancel, { once: true });
            try {
                let media;
                if (streamId) {
                    media = streamPlayer(streamId, key, kind, entry);
                    entry.stream.arrived = (n) => loading.arrived(n);
                    loading.stage(0.15, "Loading the stream…");
                } else {
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
                    loading.stage(0.15, "Loading…");
                    arrived.set(info.url, (n) => loading.arrived(n));
                    signal.addEventListener("abort", () => arrived.delete(info.url), { once: true });
                    media = await mediaStream(info.url, file, signal);
                }
                entry.element = media;
                signal.throwIfAborted();
                loadingUntilReady(media, loading, () => entry.play);
                media.addEventListener("loadedmetadata", () => {
                    // Its proportions for its box, and its size and length
                    // for the page (the engine has none of its own).
                    const meta = { w: media.videoWidth || 0, h: media.videoHeight || 0, duration: Number.isFinite(media.duration) ? media.duration : 0 };
                    entry.length = meta.duration;
                    sized?.(key, media.videoWidth > 0 && media.videoHeight > 0 ? media.videoWidth / media.videoHeight : 0, meta);
                });
                // How it plays, for the page (its player script goes by its
                // element's: YouTube's Shorts shows the next video's player
                // once it's playing): as it starts, stops or ends, and where
                // it is, once a second.
                let toldAt = -Infinity;
                const report = (ack) => {
                    if (signal.aborted) return;
                    toldAt = performance.now();
                    // Skipped: ended, as said, till it's played again.
                    if (entry.skipped && !media.paused) entry.skipped = false;
                    const state = entry.skipped
                        ? { t: Number.isFinite(media.duration) ? media.duration : 0, playing: false, ended: true }
                        : { t: Number.isFinite(media.currentTime) ? media.currentTime : 0, playing: !media.paused && !media.ended, ended: media.ended };
                    if (entry.stream) {
                        const ranges = (list) => Array.from({ length: Math.min(list.length, 16) }, (_, i) => [list.start(i), list.end(i)]);
                        state.stream = streamId;
                        if (Number.isSafeInteger(ack)) state.ack = ack;
                        state.buffered = ranges(media.buffered);
                        const active = Array.from(entry.stream.source.sourceBuffers);
                        state.buffers = entry.stream.buffers.map((buffer) => active.includes(buffer) ? ranges(buffer.buffered) : []);
                    }
                    played?.(key, state);
                };
                if (entry.stream) entry.stream.report = report;
                for (const type of ["playing", "pause", "ended", "seeked"]) media.addEventListener(type, () => report());
                media.addEventListener("timeupdate", () => { if (performance.now() - toldAt >= 1000) report(); });
                media.muted = !!muted;
                media.loop = !!loop;
                if (kind === "video" && typeof poster === "string" && /^https?:\/\//i.test(poster) && picture) {
                    picture(poster).then((blob) => {
                        if (!signal.aborted) media.poster = entry.poster = URL.createObjectURL(blob);
                    }, () => {});
                }
                Object.assign(media.style, { position: "absolute", background: "#000", zIndex: "2", display: "none" });
                media.style.pointerEvents = "auto";
                passScrolling(media);
                // Its state, for the menu's list of players.
                for (const type of ["play", "playing", "pause", "ended", "emptied"]) media.addEventListener(type, told);
                // Shift+N, as video sites' "next video": skipped.
                media.addEventListener("keydown", (e) => {
                    if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "n") {
                        e.preventDefault();
                        skip(key);
                    }
                });
                layerHere().append(media);
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
        skip,
        // mark outlines a player's box (its row in the menu pointed at or
        // focused), or none (key null).
        mark(key) {
            for (const [k, p] of players) {
                for (const el of [p.element, p.loading?.box]) {
                    if (el) el.style.outline = k === key ? "3px solid #8ab4f8" : "";
                    if (el) el.style.outlineOffset = k === key ? "-3px" : "";
                }
            }
        },
        // list is the page's players, top first, for the menu: each's kind,
        // its address (whole, and short), and how it's doing.
        list() {
            const out = [];
            for (const [key, p] of players) {
                if (!p.kind) continue;
                const media = p.element;
                const loading = p.loading?.said;
                const state = p.skipped ? "Skipped" : loading ? loading : !media ? "Loading…" : media.ended ? "Ended" : media.paused ? "Paused" : "Playing";
                out.push({ key, kind: p.kind, src: p.stream ? "" : p.src, short: p.stream ? "Streamed by the site's own player" : shortAddress(p.src), state,
                    skippable: !p.skipped && !media?.ended, top: p.placement?.rect?.y ?? 0, shown: !!p.placement?.shown });
            }
            return out.sort((a, b) => a.top - b.top);
        },
        // play starts or stops the player of a box as the page did its own
        // (or does once it's made).
        play(key, on) {
            const player = players.get(key);
            if (!player) return;
            player.play = on;
            const media = player.element;
            if (on && player.skipped) {
                // The page played it again: from its start, skippable again.
                player.skipped = false;
                if (media) media.currentTime = 0;
                told();
            }
            if (media) on ? start(media) : media.pause();
        },
        // pauseAll pauses every player: the page they're on is being left.
        pauseAll() {
            for (const player of players.values()) player.element?.pause();
        },
        // keep stops the players of boxes not among keys: gone from the page.
        keep(keys) {
            for (const key of players.keys()) if (!keys.has(key)) closePlayer(key);
        },
        stop() {
            abort.abort();
            for (const key of players.keys()) closePlayer(key);
            ahead.clear();
            for (const stream of streams.values()) releaseStream(stream);
            streams.clear();
            layer?.remove();
            layer = null;
        },
    };
}
