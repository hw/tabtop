// The remote browser's audio and video (see docs/browser-plan.md, section
// 6). The copy of the page in the frame can't play anything (its policy
// has no media, and it's at an origin of its own, which the streaming
// service worker doesn't serve): where the page had a player with a file
// to play, the frame draws a transparent hole, and here a native player is
// laid under the frame so images and chrome in the copy keep their z-order
// above the pixels. The file is read from the site by the server in parts
// as it plays (ranges through the service worker, as the files page's
// previews play theirs, see preview-media.js; asked for over the tab's
// tunnel, a few parts ahead). Loading chrome stays above the frame. The
// site isn't contacted from this device; the player is this page's, not the
// site's: its script doesn't run here.
import { encryptedMedia } from "./go-eme.js";
import { call, collect } from "../tabtop/requests.js";
import { createMediaSource } from "../tabtop/media-source.js";
import { mediaWorker } from "../tabtop/stream-worker.js";
import { openPlayer } from "../tabtop/video-player.js";
import { createCapture } from "./mse-capture.js";

const MAX_PLAYERS = 8;

// picture(url) is a picture the page has fetched through the server (a
// Blob), for a video's poster; sized(key, ratio) is told a video's
// proportions, once known, for its box.
// Parts of a player's file asked for before it asks, to be there when it
// does: the server's fetch of one and its way here overlap the next's, and
// the round trip to the server is hidden. A part's 1 MiB (media-source.js).
const AHEAD = 3;
const AHEAD_KEEP = 30_000;  // a part asked for ahead and not taken, kept so long

// mediaParts: the player's parts, over the tab's tunnel (range), as
// tunnels for ranged-file.js (tabCall); arrived, by url, told of each
// part's bytes while its player loads; clear, to let go of the parts
// asked for ahead. privateTab: the tab's private.
function mediaParts(range, privateTab) {
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
    // A tunnel of its own, for a private tab's page, says so: sent none
    // of the account's cookies (goincognito.go).
    const own = (req) => call(privateTab && req.type === "go-resource" ? { ...req, private: true } : req);
    async function tabCall(req) {
        if (req.type !== "go-resource" || req.resource !== "media" || !range) return own(req);
        const { url, offset = 0, length = 0, if_size: size = 0, if_mtime: mtime = "" } = req;
        const key = url + " " + offset;
        let got = ahead.get(key);
        ahead.delete(key);
        if (got && got.length !== length) got = null;  // a part cut otherwise (a seek's)
        if (!got) {
            // Not what was asked for ahead: the player went elsewhere.
            for (const k of [...ahead.keys()]) if (k.startsWith(url + " ")) ahead.delete(k);
            got = { got: part(url, offset, length, size, mtime) };
            if (!got.got) return own(req);
        }
        if (length > 0) readAhead(url, offset + length, size, mtime, length);
        const { bytes, reply } = await got.got;
        if (length > 0) arrived.get(url)?.(bytes?.byteLength ?? bytes?.length ?? 0);
        return { reply, bytes, close() {} };
    }
    return { tabCall, arrived, clear: () => ahead.clear() };
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
function loadingUntilReady(media, loading, wantsPlay, signal) {
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
    for (const type of events) media.addEventListener(type, type === "error" ? ready : update, { signal });
    update();
}

export function goMedia(frame, { picture, sized, played, range, failed, passOn, changed, marked, emeReply, download, saveMSE, spillMSE, abortMSE, streamsToSave, downloaded, private: privateTab = false } = {}) {
    const { tabCall, arrived, clear: clearAhead } = mediaParts(range, privateTab);
    const mediaStream = createMediaSource({ call: tabCall, collect, getWorker: mediaWorker, onError: (media, error) => {
        for (const [key, entry] of players) {
            if (entry.element !== media) continue;
            closePlayer(key);
            failed?.(key, error);
            break;
        }
    } });

    // Encrypted Media: each document's own (the page's, 0; an embedded
    // page of another origin's, by its world: goframeeme.go), its keys and
    // sessions not another's; at most 8, the oldest let go. A player's is
    // its node's: world × 2³² + its node there (go-frame.js).
    const emes = new Map();
    const emeOf = (doc) => {
        let e = emes.get(doc);
        if (!e) {
            if (emes.size >= 8) {
                const oldest = [...emes.keys()].find((d) => d !== 0);
                emes.get(oldest)?.stop();
                emes.delete(oldest);
            }
            e = encryptedMedia((message, node) => emeReply?.(message, node, doc), () => !blocked && !abort.signal.aborted,
                (node, keys) => emeKeys(doc * 2 ** 32 + node, keys));
            emes.set(doc, e);
        }
        return e;
    };
    const emeWorld = (node) => Math.floor(node / 2 ** 32);
    const eme = {
        player: (node, kind) => emeOf(emeWorld(node)).player(node % 2 ** 32, kind),
        opened: (node, element) => emeOf(emeWorld(node)).opened(node % 2 ** 32, element),
        closed: (node, element) => emes.get(emeWorld(node))?.closed(node % 2 ** 32, element),
        receive: (commands, doc = 0) => emeOf(doc).receive(commands),
        gone(doc) {
            emes.get(doc)?.stop();
            emes.delete(doc);
        },
        stop() {
            for (const e of emes.values()) e.stop();
            emes.clear();
        },
    };
    // emeKeys: a Clear Key stream's keys, for its element (go-eme.js): its
    // player's capture is told to expect them ({}), then given them as they
    // become usable, so it spills the stream encrypted with its keys and
    // Save saves it decrypted (mse-capture.js, gostreammse.go). Another key
    // system's never come, and its capture isn't saved.
    const emeKeys = (node, keys) => {
        for (const player of players.values()) {
            if (player.node !== node) continue;
            const capture = player.stream?.capture;
            if (!capture) continue;
            if (!Object.keys(keys).length) {
                capture.expectKeys?.();
                continue;
            }
            capture.markKeys?.(keys);
            // Saveable as its keys came: offered, where it wasn't before.
            reoffer(player);
        }
    };
    // reoffer: a player's stream became saveable since the menu's list or
    // the player (Watch, video-player.js) last asked (an encrypted stream's,
    // as its keys came): both asked again, so Save's offered there now.
    function reoffer(player) {
        told();
        if (!player.watching || !player.closeWatch?.setStreams) return;
        const { mseSave, manifests } = saveChoices(player);
        player.closeWatch.setStreams(player.stream ? [...manifests, ...mseSave] : []);
    }
    const players = new Map();  // the frame's box's key -> {element, stopped}
    const ours = new WeakSet();  // players being started by the page (start), not the person
    const abort = new AbortController();
    // underlay: white page backdrop + players, behind the transparent frame.
    // overlay: loading UI only, above the frame.
    let underlay = null, backdrop = null, overlay = null;
    // The page's own background, which the copy clears around a video's
    // hole (go-frame.js punchMediaHole): drawn behind the frame instead.
    let backdropColor = "#fff";
    const streams = new Map();
    const streamLimit = 16 << 20;
    let streamBytes = 0;

    function releaseStream(stream) {
        abortMSE?.(stream);
        if (stream.file && !stream.url) fileBytes -= stream.file.size;
        if (stream.file) stream.file.parts = [];
        streamBytes -= stream.bytes;
        stream.bytes = 0;
        stream.queue.length = 0;
        stream.closed = true;
        if (stream.url) URL.revokeObjectURL(stream.url);
    }

    const pageOffsets = new WeakMap();  // a SourceBuffer -> the page's timestampOffset, as last relayed
    function makeCapture(stream) {
        return createCapture({
            spill: spillMSE ? (ev) => spillMSE(stream, ev) : undefined,
            // A new staging session: the old one's let go (go.js).
            onRestart: abortMSE ? () => abortMSE(stream) : undefined,
        });
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
                        stream.capture?.add(command.buffer, command.mime);
                        break;
                    }
                    case "config":
                        if (buffer.mode !== command.mode) buffer.mode = command.mode;
                        // The page's offset, only as the page changes it: in
                        // sequence mode each append moves the native one on (the
                        // page's shim doesn't know), and setting it back would
                        // lay each segment over the last.
                        if (pageOffsets.get(buffer) !== command.offset) {
                            pageOffsets.set(buffer, command.offset);
                            if (buffer.timestampOffset !== command.offset) buffer.timestampOffset = command.offset;
                        }
                        if (buffer.appendWindowStart !== command.start || buffer.appendWindowEnd !== (command.end ?? Infinity)) {
                            buffer.appendWindowStart = 0;
                            buffer.appendWindowEnd = command.end ?? Infinity;
                            buffer.appendWindowStart = command.start;
                        }
                        break;
                    case "append": {
                        const bytes = Uint8Array.from(atob(command.data), (c) => c.charCodeAt(0));
                        buffer.appendBuffer(bytes);
                        const capture = stream.capture;
                        // In sequence mode the native append computes timestampOffset.
                        // The update event precedes updateend, which drains the next command.
                        if (capture) buffer.addEventListener("update", () => {
                            capture.append(command.buffer, bytes, buffer.timestampOffset, buffer.appendWindowStart, buffer.appendWindowEnd);
                        }, { once: true });
                        break;
                    }
                    case "drop":
                        source.removeSourceBuffer(buffer);
                        stream.buffers[command.buffer] = null;
                        stream.capture?.drop(command.buffer);
                        break;
                    case "remove": buffer.remove(command.start, command.end); break;
                    // All chunks in this operation have reached native
                    // updateend before execution reaches the acknowledgment.
                    case "ack": stream.report(command.buffer); break;
                    case "abort": buffer.abort(); break;
                    case "type":
                        buffer.changeType(command.mime);
                        stream.capture?.add(command.buffer, command.mime);
                        break;
                    case "duration": source.duration = command.value ?? Infinity; break;
                    case "end":
                        stream.capture?.end();
                        source.endOfStream();
                        break;
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
                stream = newStream();
                streams.set(id, stream);
            }
            if (stream.closed) continue;
            // A plain Blob the page plays (gomedia.js): its parts, gathered,
            // played whole once they've all come.
            if (raw.op === "file" || raw.op === "chunk" || raw.op === "fileend") {
                fileCommand(stream, raw);
                continue;
            }
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

    const FILE_MAX = 256 << 20;  // a plain Blob's bytes, played whole (gomedia.js's)
    const sharedFiles = new Map();  // a shared file's stream -> {blob, name}
    const sharedWaits = new Map();  // and what waits for it
    let fileBytes = 0;
    function fileCommand(stream, raw) {
        try {
            if (raw.op === "file") {
                if (stream.file) throw new Error("Invalid media stream operation.");
                // Its player made already, for a stream (its box came first:
                // an embedded page's, read apart): made one for a file.
                if (stream.source) {
                    if (stream.buffers.length) throw new Error("Invalid media stream operation.");
                    URL.revokeObjectURL(stream.url);
                    stream.url = null;
                    stream.source = null;
                    stream.capture = null;
                }
                // A download's (gomedia.js: a link with download the page
                // clicked): any type, saved, not played; its name said.
                const name = typeof raw.download === "string" ? raw.download.slice(0, 255) : null;
                // A file the page shares (navigator.share): kept for its share.
                const shared = typeof raw.share === "string" ? raw.share.slice(0, 255) : null;
                const mime = typeof raw.mime === "string" && (name !== null || shared !== null ? /^[\w.+-]{1,64}\/[\w.+-]{1,64}(?:;[^<>]{0,128})?$/ : /^(?:audio|video|application)\/[\w.+-]{1,64}(?:;[^<>]{0,128})?$/i).test(raw.mime) ? raw.mime : "";
                stream.file = { parts: [], size: 0, mime, total: Number.isSafeInteger(raw.value) && raw.value > 0 ? raw.value : 0, done: false };
                stream.capture = fileCapture(stream);
                if (name !== null) stream.saveName = name || "download";
                if (shared !== null) stream.shareName = shared || "file";
                return;
            }
            const file = stream.file;
            if (!file || file.done) throw new Error("Invalid media stream operation.");
            if (raw.op === "chunk") {
                if (typeof raw.data !== "string" || raw.data.length > 65536) throw new Error("Invalid media stream operation.");
                const bytes = Uint8Array.from(atob(raw.data), (c) => c.charCodeAt(0));
                if (file.size + bytes.length > FILE_MAX || fileBytes + bytes.length > FILE_MAX * 2) throw new Error("The site's media file is too large to play here.");
                file.parts.push(bytes);
                file.size += bytes.length;
                fileBytes += bytes.length;
                stream.arrived?.(bytes.length);
                return;
            }
            file.done = true;
            if (stream.shareName !== undefined) {
                // Shared: its file, whole, for its share (sharedFile).
                const blob = new Blob(file.parts, file.mime ? { type: file.mime } : {});
                fileBytes -= file.size;
                file.parts = [];
                for (const [id, s] of streams) {
                    if (s !== stream) continue;
                    streams.delete(id);
                    sharedFiles.set(id, { blob, name: stream.shareName });
                    if (sharedFiles.size > 16) sharedFiles.delete(sharedFiles.keys().next().value);
                    for (const wake of sharedWaits.get(id) ?? []) wake();
                    sharedWaits.delete(id);
                }
                return;
            }
            if (stream.saveName !== undefined) {
                // A download: its file, whole, handed on to be saved (go.js).
                stream.fileBlob = new Blob(file.parts, file.mime ? { type: file.mime } : {});
                fileBytes -= file.size;
                file.parts = [];
                for (const [id, s] of streams) if (s === stream) streams.delete(id);
                downloaded?.(stream, stream.saveName);
                return;
            }
            fileReady(stream);
        } catch (error) {
            failStream(stream, error.message);
        }
    }
    // fileReady gives a file stream's player its file, once both are there.
    function fileReady(stream) {
        const file = stream.file;
        if (!file?.done || !stream.element || stream.url || stream.closed) return;
        stream.fileBlob = new Blob(file.parts, file.mime ? { type: file.mime } : {});
        stream.url = URL.createObjectURL(stream.fileBlob);
        fileBytes -= file.size;
        file.parts = [];
        stream.element.src = stream.url;
    }

    // fileCapture saves a file stream's file (a Blob the page played, or a
    // download): whole, once it's all come, as one progressive piece of a
    // stage (go.js's saveMSECapture), named by the server from its bytes,
    // or by its download's name.
    // (Sent once to a stage: again once a save's taken it, or failed; not
    // when it was refused, the stage still holding it, to be saved again.)
    function fileCapture(stream) {
        let spilled = false;
        return {
            encrypted: false,
            markEncrypted() { this.encrypted = true; },
            saveable() { return !!stream.fileBlob && stream.fileBlob.size > 0 && !this.encrypted; },
            async flush() {
                if (spilled) return;
                if (!stream.fileBlob || !spillMSE) throw new Error("its file hasn't all come yet");
                await spillMSE(stream, { track: 0, kind: "progressive", bytes: new Uint8Array(await stream.fileBlob.arrayBuffer()) });
                spilled = true;
            },
            sessionTaken() { spilled = false; },
            saveFailed() { spilled = false; },
        };
    }

    function newStream() {
        const stream = { queue: [], buffers: [], bytes: 0, began: performance.now() };
        stream.capture = makeCapture(stream);
        return stream;
    }

    function streamPlayer(id, key, kind, entry) {
        if (typeof MediaSource !== "function") throw new Error("This browser does not support Media Source Extensions.");
        let stream = streams.get(id);
        if (!stream) {
            if (streams.size >= 32) throw new Error("Too many media streams on this page.");
            stream = newStream();
            streams.set(id, stream);
        }
        if (stream.closed || stream.source || stream.element) throw new Error(stream.error || "The media stream is no longer available.");
        if (stream.file) {
            // A plain Blob's: its file, once it's all come.
            const element = eme.player(entry.node, kind);
            eme.opened(entry.node, element);
            element.controls = false;
            if (kind === "video") element.playsInline = true;
            stream.key = key;
            stream.element = element;
            entry.stream = stream;
            element.addEventListener("error", () => {
                if (!stream.closed) failStream(stream, element.error?.message || "The media file could not be decoded.");
            }, { signal: entry.controller.signal });
            fileReady(stream);
            return element;
        }
        stream.capture ||= makeCapture(stream);
        const element = eme.player(entry.node, kind);
        eme.opened(entry.node, element);
        // Under the frame: no native controls (they'd cover page chrome).
        element.controls = false;
        if (kind === "video") element.playsInline = true;
        stream.key = key;
        stream.element = element;
        stream.source = new MediaSource();
        stream.url = URL.createObjectURL(stream.source);
        entry.stream = stream;
        stream.source.addEventListener("sourceopen", () => drainStream(stream));
        element.addEventListener("error", () => {
            if (!stream.closed) failStream(stream, element.error?.message || "The media stream could not be decoded.");
        }, { signal: entry.controller.signal });
        // Encrypted Media: the capture is told (and, its keys coming — a
        // Clear Key player's — it goes on spilling, and is saved
        // decrypted); one whose keys a CDM keeps lets its stage go.
        element.addEventListener("encrypted", () => {
            stream.capture?.markEncrypted();
            if (!stream.capture?.armed && !stream.capture?.keysKnown) abortMSE?.(stream);
        }, { signal: entry.controller.signal });
        element.src = stream.url;
        return element;
    }


    function closePlayer(key) {
        const player = players.get(key);
        if (!player) return;
        players.delete(key);
        eme.closed(player.node, player.element);
        player.closeWatch?.();
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
    function passScrolling(media, signal) {
        // In Watch's player, or laid over the frame (a sound's strip): what
        // would be the page's isn't the frame's to have, so it's passed on. (A
        // video under the frame has the frame's own.)
        const passes = () => "player" in media.dataset || (!!overlay && media.parentElement === overlay);
        media.addEventListener("wheel", (e) => {
            if (!passes()) return;
            const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1;
            e.preventDefault();
            passOn?.(e.clientX, e.clientY, e.deltaX * unit, e.deltaY * unit, "wheel");
        }, { passive: false, signal });
        let last = null;
        media.addEventListener("touchstart", (e) => {
            if (!passes()) return;
            const t = e.touches[0];
            last = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY } : null;
            if (last) passOn?.(t.clientX, t.clientY, 0, 0, "drag-start");
        }, { passive: true, signal });
        media.addEventListener("touchmove", (e) => {
            if (!passes()) return;
            const t = e.touches[0];
            if (!last || !t || e.touches.length !== 1) return;
            e.preventDefault();
            passOn?.(t.clientX, t.clientY, last.x - t.clientX, last.y - t.clientY, "drag");
            last = { x: t.clientX, y: t.clientY };
        }, { passive: false, signal });
        const end = (e) => {
            if (!passes()) { last = null; return; }
            const t = e.changedTouches?.[0];
            if (last && t) passOn?.(t.clientX, t.clientY, 0, 0, "drag-end");
            last = null;
        };
        media.addEventListener("touchend", end, { passive: true, signal });
        media.addEventListener("touchcancel", end, { passive: true, signal });
        media.style.touchAction = "none";
    }

    // place lays a player over its box, kept within the frame's area (the
    // frame says where the box is); hidden while its box isn't shown.
    document.addEventListener("fullscreenchange", () => {
        for (const player of players.values()) place(player.placement);
    }, { signal: abort.signal });
    // The frame moved, not resized (which its page would say): a half turn,
    // landscape one way to the other, a notch's margin from one side to the
    // other. Players placed again on their boxes, at once and once the
    // window's settled (a browser says its margins after it says it turned).
    let replaceTimer = 0;
    const replaceAll = () => {
        requestAnimationFrame(() => {
            syncBackdrop();
            for (const player of players.values()) place(player.placement);
        });
        clearTimeout(replaceTimer);
        replaceTimer = setTimeout(() => {
            syncBackdrop();
            for (const player of players.values()) place(player.placement);
        }, 300);
    };
    window.addEventListener("resize", replaceAll, { signal: abort.signal });
    window.addEventListener("orientationchange", replaceAll, { signal: abort.signal });
    screen.orientation?.addEventListener?.("change", replaceAll, { signal: abort.signal });
    window.visualViewport?.addEventListener("resize", replaceAll, { signal: abort.signal });

    function place({ key, rect, clip, shown, fit, position, loop }) {
        const player = players.get(key);
        if (!player) return;
        player.placement = { key, rect, clip, shown, fit, position };
        const media = player.element, loading = player.loading?.box;
        if (typeof loop === "boolean" && player.loop !== loop) {
            player.loop = loop;
            if (media) media.loop = loop;
        }
        if (media && "player" in media.dataset) return;  // in the watch player, not its box
        syncBackdrop();
        if (player.hidden) {
            if (media) media.style.display = "none";
            if (loading) loading.hidden = true;
            return;
        }
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

    // Its site's videos blocked (Site controls): none played, those
    // there stopped, the page told why in their boxes.
    const BLOCKED = "Videos from this site are blocked (Site controls: the button at the address’s start).";
    let blocked = false;
    // Hosts whose videos aren't played, whatever page they're on (a Skip
    // held, go.js; Site controls): by the host in the video's own address.
    const HOST_BLOCKED = "Videos from this host are blocked (Site controls: the button at the address’s start).";
    let blockedHosts = new Set();
    const videoHost = (src) => {
        // (As the server keeps it, goSettingHost: an IPv6 address without its brackets.)
        try { return /^https?:/i.test(src) ? new URL(src).hostname.toLowerCase().replace(/^www\./, "").replace(/^\[(.*)\]$/, "$1") : ""; } catch { return ""; }
    };

    // pageStarts plays a player the page started, unless autoplay's paused
    // (and it's not one the person played): then the page's told it's
    // paused, as a browser that won't autoplay tells it.
    function pageStarts(key, player) {
        const media = player.element;
        if (!media) return;
        if (autoplay || player.chosen) return start(media);
        media.pause();
        played?.(key, { t: Number.isFinite(media.currentTime) ? media.currentTime : 0, playing: false, ended: false });
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

    // saveChoices: what saves a player's stream: the page's manifests
    // (go.js's streamsToSave), and its buffered capture, if it's saveable.
    function saveChoices(player) {
        const mse = player.stream?.capture;
        if (player.element?.mediaKeys && !mse?.armed && !mse?.keysKnown) {
            // Encrypted Media whose keys a CDM keeps: its stream not saved.
            mse?.markEncrypted();
            abortMSE?.(player.stream);
        }
        const mseSave = saveMSE && mse?.saveable() ? [{
            label: player.stream.file ? "File" : "Buffered stream",
            save: (say, opts) => saveMSE(player.stream, say, opts),
        }] : [];
        // (Not the page's last place's streams to a stream begun since it
        // moved in itself: a single-page site's next video, perhaps fed
        // through Media Source alone.)
        const manifests = player.stream ? (streamsToSave?.() ?? []).filter((m) => !(m.staleSince <= player.stream.began)) : [];
        return { mseSave, manifests };
    }

    function syncBackdrop() {
        if (!backdrop || !frame.parentElement) return;
        const area = frame.getBoundingClientRect(), host = frame.parentElement.getBoundingClientRect();
        Object.assign(backdrop.style, {
            left: `${area.left - host.left}px`, top: `${area.top - host.top}px`,
            width: `${area.width}px`, height: `${area.height}px`,
        });
    }
    function underlayHere() {
        if (!underlay) {
            underlay = document.createElement("div");
            Object.assign(underlay.style, { position: "absolute", inset: "0", zIndex: "0", pointerEvents: "none", overflow: "hidden" });
            backdrop = document.createElement("div");
            Object.assign(backdrop.style, { position: "absolute", backgroundColor: backdropColor, zIndex: "0" });
            underlay.append(backdrop);
            frame.parentElement.insertBefore(underlay, frame);
            frame.classList.add("go-underlaid");
            syncBackdrop();
        }
        return underlay;
    }
    function overlayHere() {
        if (!overlay) {
            overlay = document.createElement("div");
            Object.assign(overlay.style, { position: "absolute", inset: "0", zIndex: "2", pointerEvents: "none", overflow: "hidden" });
            frame.parentElement.append(overlay);
        }
        return overlay;
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
        overlayHere().append(box);
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

    // start plays media, muted if this browser won't play it with sound
    // unasked (its autoplay rules: the person can unmute it).
    // Autoplay paused (the menu's): the page's starting a player isn't
    // done (and the page told it's paused), till the person plays it.
    let autoplay = true;
    function start(media) {
        ours.add(media);
        setTimeout(() => ours.delete(media), 1000);
        media.play().catch((err) => {
            if (err?.name !== "NotAllowedError" || media.muted) return;
            media.muted = true;
            return media.play();
        }).catch(() => {});
    }

    return {
        videoForNode(node) {
            for (const player of players.values()) {
                if (player.node === node && player.element instanceof HTMLVideoElement) return player.element;
            }
            return null;
        },
        streams: receiveStreams,
        // sharedFile is a file the page shares, by its stream's number, as a
        // File, once it's all come (null if it doesn't within 60 s).
        async sharedFile(id, type = "") {
            if (!sharedFiles.has(id)) {
                await new Promise((resolve) => {
                    const timer = setTimeout(resolve, 60000);
                    sharedWaits.set(id, [...(sharedWaits.get(id) ?? []), () => { clearTimeout(timer); resolve(); }]);
                });
            }
            const f = sharedFiles.get(id);
            if (!f) return null;
            sharedFiles.delete(id);
            return new File([f.blob], f.name, { type: type || f.blob.type });
        },
        // eme takes EME requests: the page's, or (doc) an embedded page's
        // of another origin; emeGone lets one's go.
        eme: (commands, doc = 0) => eme.receive(commands, doc),
        emeGone: (doc) => eme.gone(doc),
        // open makes a player for the box key, of kind, playing src (an
        // http(s) address the page had); its error, if it can't.
        async open({ key, node, kind, src, rect, clip, shown, fit, position, muted, loop, poster, play }) {
            const streamId = typeof src === "string" && Number(/^blob:tabtop-media\/([1-9]\d*)$/.exec(src)?.[1]);
            if (!["audio", "video"].includes(kind) || !Number.isSafeInteger(key) || typeof src !== "string" || !(Number.isSafeInteger(streamId) || /^https?:\/\//i.test(src))) {
                return { error: "This media can't be played here." };
            }
            if (players.has(key)) return {};
            if (blocked) return { error: BLOCKED, blocked: true };
            if (blockedHosts.has(videoHost(src))) return { error: HOST_BLOCKED, blocked: true };
            if (players.size >= MAX_PLAYERS || abort.signal.aborted) return { error: "Too many players on this page." };
            const controller = new AbortController();
            const { signal } = controller;
            const entry = { controller, node, play: !!play, loop: !!loop, placement: { key, rect, clip, shown: shown !== false, fit, position } };
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
                    const element = eme.player(node, kind);
                    eme.opened(node, element);
                    entry.element = element;
                    media = await mediaStream(info.url, file, signal, element);
                    // Under the frame (the copy's hole shows it): no native
                    // controls, which would show over the page's own and can't
                    // be pressed (clicks are the frame's). The player
                    // (Watch, video-player.js) has controls of its own. Still
                    // focusable (a video without controls isn't), for its keys
                    // (Shift+N skips it).
                    media.controls = false;
                    media.tabIndex = 0;
                }
                entry.element = media;
                signal.throwIfAborted();
                loadingUntilReady(media, loading, () => entry.play, signal);
                let lastMetadata;
                const reportMetadata = () => {
                    const meta = { w: media.videoWidth || 0, h: media.videoHeight || 0,
                        duration: Number.isFinite(media.duration) ? media.duration : 0, readyState: media.readyState };
                    if (lastMetadata?.readyState === meta.readyState && lastMetadata.duration === meta.duration &&
                        lastMetadata.w === meta.w && lastMetadata.h === meta.h) return;
                    lastMetadata = meta;
                    entry.length = meta.duration;
                    sized?.(key, meta.w && meta.h ? meta.w / meta.h : 0, meta);
                };
                for (const type of ["loadedmetadata", "loadeddata", "canplay", "canplaythrough", "waiting", "durationchange", "resize", "emptied"]) {
                    media.addEventListener(type, reportMetadata, { signal });
                }
                if (media.readyState > HTMLMediaElement.HAVE_NOTHING) reportMetadata();
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
                    // (A plain Blob's file, played whole: no buffers to say.)
                    if (entry.stream?.source) {
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
                for (const type of ["playing", "pause", "ended", "seeked"]) media.addEventListener(type, () => report(), { signal });
                media.addEventListener("timeupdate", () => { if (performance.now() - toldAt >= 1000) report(); }, { signal });
                media.muted = !!muted;
                media.loop = entry.loop;
                if (kind === "video" && typeof poster === "string" && /^https?:\/\//i.test(poster) && picture) {
                    picture(poster).then((blob) => {
                        if (!signal.aborted) media.poster = entry.poster = URL.createObjectURL(blob);
                    }, () => {});
                }
                Object.assign(media.style, { position: "absolute", background: "#000", zIndex: "1", display: "none", pointerEvents: "none" });
                passScrolling(media, signal);
                media.addEventListener("playing", () => {
                    if (entry.poster) { URL.revokeObjectURL(entry.poster); entry.poster = ""; }
                    media.removeAttribute("poster");
                }, { signal });
                // Its state, for the menu's list of players.
                for (const type of ["play", "playing", "pause", "ended", "emptied"]) media.addEventListener(type, told, { signal });
                // Shift+N, as video sites' "next video": skipped.
                media.addEventListener("keydown", (e) => {
                    if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "n") {
                        e.preventDefault();
                        skip(key);
                    }
                }, { signal });
                if (kind === "audio") {
                    // A sound's player is its control strip, nothing under the
                    // page's own chrome to keep: laid over its box, its native
                    // controls pressed there (there's no Watch for sound).
                    media.controls = true;
                    media.style.pointerEvents = "auto";
                    overlayHere().append(media);
                } else {
                    underlayHere().append(media);
                }
                place(entry.placement);
                // Played by the person (its own controls, the player's): its
                // page may play it from then on, autoplay paused or not.
                media.addEventListener("play", () => {
                    if (entry.hidden) {
                        entry.hidden = false;
                        place(entry.placement);
                    }
                    if (!ours.has(media)) entry.chosen = true;
                }, { signal });
                if (entry.play) pageStarts(key, entry);
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
        // hide removes an ended video's overlay while keeping its player
        // available; a later play or opening it in the /go player restores it.
        hide(key) {
            const player = players.get(key);
            if (!player || player.kind !== "video" || !player.element) return;
            player.hidden = true;
            player.element.style.display = "none";
            if (player.loading?.box) player.loading.box.hidden = true;
            told();
        },
        // mark outlines a player's box in the copy (menu hover/focus).
        mark(key) {
            for (const [k, p] of players) {
                if (p.loading?.box && !p.watching) {
                    p.loading.box.style.outline = k === key ? "3px solid #8ab4f8" : "";
                    p.loading.box.style.outlineOffset = k === key ? "-3px" : "";
                }
            }
            marked?.(Number.isSafeInteger(key) ? key : null);
        },
        // list is the page's players, top first, for the menu: each's kind,
        // its address (whole, and short), and how it's doing.
        get autoplaying() { return autoplay; },
        list() {
            const out = [];
            for (const [key, p] of players) {
                if (!p.kind) continue;
                const media = p.element;
                const loading = p.loading?.said;
                const state = p.skipped ? "Skipped" : loading ? loading : !media ? "Loading…" : media.ended ? "Ended" : (media.paused ? "Paused" : "Playing") + (p.watching ? " in the player" : "");
                out.push({ key, kind: p.kind, src: p.stream ? "" : p.src, short: p.stream ? "Streamed by the site's own player" : shortAddress(p.src), state,
                    skippable: !p.skipped && !media?.ended, top: p.placement?.rect?.y ?? 0, shown: !!p.placement?.shown,
                    playing: !!media && !media.paused && !media.ended, ready: !!media, watching: !!p.watching,
                    // (Something to save it with: the menu's Save.)
                    saveable: p.stream ? !!(saveMSE && p.stream.capture?.saveable() || streamsToSave?.().length) : !!(download && p.src) });
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
            if (on && player.hidden) {
                player.hidden = false;
                if (player.placement) place(player.placement);
            }
            if (on && player.skipped) {
                // The page played it again: from its start, skippable again.
                player.skipped = false;
                if (media) media.currentTime = 0;
                told();
            }
            if (media) on ? pageStarts(key, player) : media.pause();
        },
        // blockHosts sets the hosts whose videos aren't played (videoHost):
        // those playing from them stopped, the page told why in their boxes.
        blockHosts(hosts) {
            blockedHosts = new Set((Array.isArray(hosts) ? hosts : []).filter((h) => typeof h === "string").map((h) => h.toLowerCase().replace(/^www\./, "")));
            for (const [key, player] of [...players]) {
                if (!blockedHosts.has(videoHost(player.src))) continue;
                const media = player.element;
                media?.pause();
                played?.(key, { t: Number.isFinite(media?.currentTime) ? media.currentTime : 0, playing: false, ended: false });
                closePlayer(key);
                failed?.(key, HOST_BLOCKED, true);
            }
            told();
        },
        // block stops every player, and plays none from now (its site's
        // videos blocked), or (false) lets them be again.
        block(on) {
            blocked = !!on;
            if (!blocked) return;
            for (const [key, player] of [...players]) {
                const media = player.element;
                media?.pause();
                played?.(key, { t: Number.isFinite(media?.currentTime) ? media.currentTime : 0, playing: false, ended: false });
                closePlayer(key);
                failed?.(key, BLOCKED, true);
            }
            told();
        },
        // autoplay allows the page's starting its players, or (false) pauses
        // them all and stops it doing so, till the person plays one.
        autoplay(on) {
            autoplay = !!on;
            if (!autoplay) {
                for (const player of players.values()) if (!player.chosen) player.element?.pause();
            } else {
                for (const player of players.values()) if (player.play && !player.chosen && player.element?.paused) start(player.element);
            }
            told();
        },
        // chosenAll: the person's own media control pressed (a media key,
        // the lock screen's: gomediasession.go): the page's players are
        // the person's to play from then on, autoplay paused or not.
        chosenAll() {
            for (const player of players.values()) player.chosen = true;
        },
        // toggle plays or pauses a player, as the person's doing.
        toggle(key) {
            const player = players.get(key);
            const media = player?.element;
            if (!media) return;
            player.chosen = true;
            if (media.paused || media.ended) {
                if (player.hidden) {
                    player.hidden = false;
                    if (player.placement) place(player.placement);
                }
                if (player.skipped) media.currentTime = 0;
                player.skipped = false;
                media.play().catch(() => {});
            } else media.pause();
        },
        // watch takes a video into the player (video-player.js), full screen,
        // and gives it back to its box as that's closed.
        watch(key) {
            const player = players.get(key);
            const media = player?.element;
            if (!media || player.kind !== "video" || player.watching) return;
            player.watching = true;
            player.hidden = false;
            if (player.placement) place(player.placement);
            player.chosen = true;
            player.loading?.done();
            const { mseSave, manifests } = saveChoices(player);
            media.style.pointerEvents = "auto";
            player.closeWatch = openPlayer(media, {
                title: player.stream ? "Streamed by the site's own player" : shortAddress(player.src),
                skip: () => skip(key),
                // (Said of a stream whenever one's offered to save, after its
                // keys come too: reoffer.)
                downloadTitle: player.stream ? "Save stream into Downloads" : undefined,
                streams: player.stream ? [...manifests, ...mseSave] : undefined,
                download: !player.stream && download ? (say, opts) => download(player.src, say, opts)
                    : player.stream && mseSave.length === 1 && !manifests.length ? mseSave[0].save : null,
                closed: () => {
                    player.watching = false;
                    player.closeWatch = null;
                    media.style.pointerEvents = "none";
                    if (underlay && media.parentElement !== underlay) underlay.append(media);
                    if (players.get(key) === player) place(player.placement);
                    told();
                },
            });
            if (media.paused) media.play().catch(() => {});
            told();
        },
        // backdrop takes the page's background colour (an rgb() or rgba() of
        // the copy's: anything else is ignored), drawn behind the frame.
        backdrop(color) {
            // Any colour (a page's computed one may be oklch(), lab()…), and
            // only a colour: set as one alone.
            if (typeof color !== "string" || color.length > 200 || !CSS.supports("color", color)) return;
            // (None, its alpha 0, a browser's white: rgba(…, 0), or a / 0.)
            backdropColor = /^transparent$|^rgba\([^)]*,\s*0\)$|\/\s*0\)$/.test(color) ? "#fff" : color;
            if (backdrop) backdrop.style.backgroundColor = backdropColor;
        },
        // saver is what saves a player's video or sound into Downloads (the
        // menu's Save, go.js), as Watch's player offers it: a stream's
        // manifest, else its buffered capture; or its file: {stream, label,
        // save(say, opts)}. Null if none.
        saver(key) {
            const player = players.get(key);
            if (!player) return null;
            if (!player.stream) {
                // Its source a stream's manifest (an HLS <video src>): the
                // stream saved, not the playlist's text.
                const manifest = player.src && streamsToSave?.().find((s) => s.url === player.src);
                if (manifest) return { stream: true, label: manifest.label ?? "", save: manifest.save };
                return download && player.src ? { stream: false, label: "", save: (say, opts) => download(player.src, say, opts) } : null;
            }
            const { mseSave, manifests } = saveChoices(player);
            // (The page's streams perhaps the last place's, the page moved in
            // itself: what this player buffered, if it can be saved, first.)
            const choice = manifests[0]?.staleSince !== undefined && mseSave[0] ? mseSave[0] : manifests[0] ?? mseSave[0];
            return choice ? { stream: true, label: choice.label ?? "", save: choice.save } : null;
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
            eme.stop();
            abort.abort();
            clearTimeout(replaceTimer);
            for (const key of players.keys()) closePlayer(key);
            clearAhead();
            for (const stream of streams.values()) releaseStream(stream);
            streams.clear();
            underlay?.remove();
            overlay?.remove();
            frame.classList.remove("go-underlaid");
            underlay = backdrop = overlay = null;
            backdropColor = "#fff";
            marked?.(null);
        },
    };
}
