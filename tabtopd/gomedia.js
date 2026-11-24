// The page's audio and video elements, in its own world, told what the
// person's browser found of their files (see go-media.js): the engines
// (Moli, Obscura, Lightpanda) have no media pipeline of their own, so a
// page asking a video its size or length gets 0, and its player script
// lays it out at its guess (YouTube: 16:9, its Shorts being 9:16). The
// agent (goagent.js) hands what the person's player found, as JSON, in an
// event on the element, "__tabtop_media" ({w, h, duration}); this has the
// element say it, and fires the events a browser's does as it learns it.
// An engine that has found it itself is left as it is.
//
// How the person's player plays comes the same way ({play: {t, playing,
// ended}}, as it starts, stops or ends, and once a second): the element's
// currentTime (going on as it plays), paused and ended say it, with the
// events a browser's fires (play, playing, pause, ended, timeupdate). A
// player script goes by them: YouTube's Shorts shows the next video's
// player only once its element is playing. Its next file forgets it.
//
// It's the page's to see and change, like anything in its world: what it
// does with that only touches its own copy.
//
// Listened for on the window, not the document: a frame's first page of
// its parent's origin can be given the window its first (about:blank)
// document had, which this was run in, and its document is another
// (measured in Moli: a stream in such a frame never opened).
(() => {
    const SEND = "__tabtop_media";
    const num = (v, max) => (Number.isFinite(v) && v >= 0 && v <= max ? v : 0);
    const plays = new WeakMap();  // element -> {t, at, playing, ended}: as the person's player last said
    const proto = HTMLMediaElement.prototype;
    // Its file, as a browser picks it: its own src if it has one (empty:
    // none), else its first <source> with one that isn't empty.
    const sourceOf = (el) => el.hasAttribute("src") ? el.getAttribute("src") || null : el.querySelector(':scope > source[src]:not([src=""])')?.getAttribute("src") ?? null;
    const playback = (el) => {
        const state = plays.get(el);
        return state && state.source === sourceOf(el) ? state : null;
    };
    const native = {};
    for (const name of ["currentTime", "paused", "ended"]) native[name] = Object.getOwnPropertyDescriptor(proto, name);
    const timeOf = (el, p) => {
        const t = p.playing ? p.t + (performance.now() - p.at) / 1000 : p.t;
        const d = el.duration;
        return Number.isFinite(d) && d > 0 ? Math.min(t, d) : t;
    };
    const fire = (el, ...types) => { for (const type of types) el.dispatchEvent(new Event(type)); };
    for (const [name, get, set] of [
        ["currentTime", (el, p) => timeOf(el, p), (el, p, v) => {
            p.t = num(Number(v), 1e7);
            p.at = performance.now();
            fire(el, "seeking", "seeked", "timeupdate");
        }],
        ["paused", (el, p) => !p.playing],
        ["ended", (el, p) => p.ended],
    ]) {
        const was = native[name];
        if (!was?.get) continue;
        Object.defineProperty(proto, name, {
            ...was,
            get: { [name]() { const p = playback(this); return p ? get(this, p) : was.get.call(this); } }[name],
            ...(was.set ? { set: { [name](v) { const p = playback(this); if (p && set) set(this, p, v); else was.set.call(this, v); } }[name] } : {}),
        });
    }
    // timeupdate as a browser's, a few times a second, while one plays.
    const playing = new Set();
    let ticking = 0;
    const tick = () => {
        for (const el of playing) {
            if (!el.isConnected || !playback(el)?.playing) playing.delete(el);
            else fire(el, "timeupdate");
        }
        if (!playing.size) {
            clearInterval(ticking);
            ticking = 0;
        }
    };
    // held: paused by the page, the person's player's "playing" not taken
    // till it says it's paused (the agent's telling it to stop is on its
    // way; a report of before would flip the page back to playing), for 2 s
    // at most. The page's play() (stubbed, below) lets it go at once.
    const held = new WeakMap(); // element -> since (ms)
    const hold = (el) => held.set(el, performance.now());
    window.addEventListener("__tabtop_media_hold", (e) => {
        const el = (e.composedPath?.()[0] ?? e.target);  // (in a shadow root too)
        if (!(el instanceof HTMLMediaElement)) return;
        e.stopImmediatePropagation();
        if (e.detail === "release") held.delete(el);
        else hold(el);
    }, true);
    function played(el, d) {
        const since = held.get(el);
        if (since !== undefined) {
            if (d.playing && performance.now() - since < 2000) return;
            held.delete(el);
        }
        const was = playback(el);
        const now = { source: sourceOf(el), t: num(d.t, 1e7), at: performance.now(), playing: !!d.playing, ended: !!d.ended };
        plays.set(el, now);
        if (now.playing && !was?.playing) fire(el, "play", "playing");
        if (!now.playing && was?.playing) fire(el, "pause");
        if (now.ended && !was?.ended) fire(el, "ended");
        fire(el, "timeupdate");
        if (now.playing) {
            playing.add(el);
            ticking ||= setInterval(tick, 250);
        } else {
            playing.delete(el);
        }
    }
    // The page's pause(): say paused at once (Shorts' UI reads it), and fire
    // pause so the agent stops the person's player. A remoted stream's element
    // never played natively (MSE's play is stubbed below), so the engine's
    // pause would be a no-op and never tell the agent.
    const nativePause = proto.pause;
    proto.pause = function pause() {
        const p = playback(this);
        if (p?.playing) {
            played(this, { t: timeOf(this, p), playing: false, ended: false });
            hold(this);
        }
        return nativePause.call(this);
    };
    // The page's play(): what it paused, it wants playing again: the
    // person's player's reports taken at once, not held (a native file's
    // element's too; the stream's stub below says so itself).
    const nativePlay = proto.play;
    proto.play = function play() {
        held.delete(this);
        return nativePlay.apply(this, arguments);
    };
    window.addEventListener(SEND, (e) => {
        const el = (e.composedPath?.()[0] ?? e.target);  // (in a shadow root too)
        if (!(el instanceof HTMLMediaElement)) return;
        let d;
        try { d = JSON.parse(e.detail); } catch { return; }
        if (d?.play && typeof d.play === "object") {
            played(el, d.play);
            return;
        }
        plays.delete(el);  // a file of its own: how the last played isn't this one's
        const w = num(d?.w, 16384), h = num(d?.h, 16384), duration = num(d?.duration, 1e7);
        if (el instanceof HTMLVideoElement && (!w || !h)) return;
        // The engine's own, if it has them (and they weren't said here
        // before, for an earlier file): not ours to say.
        if (!Object.getOwnPropertyDescriptor(el, "readyState") && el.readyState > 0 && (el.duration > 0 || el.videoWidth > 0)) return;
        const said = { duration, readyState: 4, networkState: 1 };
        if (el instanceof HTMLVideoElement) Object.assign(said, { videoWidth: w, videoHeight: h });
        for (const [name, value] of Object.entries(said)) {
            try { Object.defineProperty(el, name, { configurable: true, get: () => value }); } catch { /* as it is */ }
        }
        const events = ["loadedmetadata", "durationchange", "loadeddata", "canplay", "canplaythrough"];
        if (el instanceof HTMLVideoElement) events.splice(1, 0, "resize");
        for (const type of events) el.dispatchEvent(new Event(type));
    }, true);
})();

// Keep the site's streaming code in the engine. Its SourceBuffer commands
// travel with document changes and run against the viewer's native MSE API.
// ManagedMediaSource is the same relay, with startstreaming/endstreaming
// driven by how far the person's player is buffered (HLS.js / dash.js).
(() => {
    const prefix = "blob:tabtop-media/";
    const queue = [];
    // A stream's number, from a random start: an embedded page's streams
    // go with the page's (goframestreams.go), and one document's can't be
    // told from another's by number alone.
    let queued = 0, next = (() => {
        try { return crypto.getRandomValues(new Uint32Array(1))[0] >>> 2; } catch { return Math.floor(Math.random() * 2 ** 30); }
    })();
    // Told on the topmost document of this one's origin it can reach, whose
    // agent reads it (a frame of the page's origin is read by the page's).
    const reader = () => {
        let w = window;
        try {
            while (w.parent !== w) {
                void w.parent.document;
                w = w.parent;
            }
        } catch { /* this origin's topmost */ }
        return w.document;
    };
    const limit = 16 << 20;
    const nativeURL = URL.createObjectURL;
    const nativeRevoke = URL.revokeObjectURL;
    const positions = new Map();
    const STREAM_LOW = 2;   // seconds ahead: ask the page for more
    const STREAM_HIGH = 5;  // seconds ahead: enough for now

    function enqueue(source, command) {
        const size = command.data?.length || 0;
        if (source.failed || source.readyState === "closed") return;
        if (queued + size > limit || queue.length >= 512) {
            source.failed = true;
            if (queue.length < 544) queue.push({ stream: source.id, op: "error" });
            return;
        }
        queue.push({ stream: source.id, ...command });
        queued += size;
    }

    let listening = null;
    const listen = () => {
        const d = reader();
        if (listening === d) return;
        listening = d;
        d.addEventListener("__tabtop_read_stream", readOut);
    };
    // A plain Blob's object URL played by a video or audio element (a site
    // that fetches its file whole, then plays it from memory): its bytes
    // relayed as a stream of its own ("file", its parts, "fileend"), the
    // agent told the stream's address stands for the page's URL, for the
    // copy's box (go-media.js gathers it, 256 MB at most, and plays it whole).
    const FILE_MAX = 256 << 20, FILE_AHEAD = 8 << 20, FILE_PART = 49152;
    const blobs = new Map();        // the page's blob: URL -> its Blob
    const blobStreams = new Map();  // blob: URL -> its stream's number
    const pumps = new Set();
    // relayFile sends a Blob's bytes as a stream of its own (extra: what
    // the "file" op says besides, a download's name); its number.
    function relayFile(blob, extra = {}) {
        const id = ++next;
        if (blob.size > FILE_MAX || queue.length >= 512) {
            queue.push({ stream: id, op: "error" });
        } else {
            queue.push({ stream: id, op: "file", mime: blob.type, value: blob.size, ...extra });
            let at = 0, busy = false;
            const pump = async () => {
                if (busy) return;
                busy = true;
                try {
                    while (at < blob.size && queued < FILE_AHEAD && queue.length < 480) {
                        const part = new Uint8Array(await blob.slice(at, at + FILE_PART).arrayBuffer());
                        if (!part.length) break;
                        at += part.length;
                        const data = btoa(String.fromCharCode(...part));
                        queue.push({ stream: id, op: "chunk", data });
                        queued += data.length;
                    }
                    if (at >= blob.size) {
                        queue.push({ stream: id, op: "fileend" });
                        pumps.delete(pump);
                    }
                } catch {
                    queue.push({ stream: id, op: "error" });
                    pumps.delete(pump);
                } finally {
                    busy = false;
                }
            };
            pumps.add(pump);
            pump();
        }
        return id;
    }
    function relayBlob(url) {
        const blob = blobs.get(url);
        if (!blob) return;
        let id = blobStreams.get(url);
        if (!id) {
            id = relayFile(blob);
            blobStreams.set(url, id);
        }
        try { reader().dispatchEvent(new CustomEvent("__tabtop_blob", { detail: JSON.stringify({ url, stream: id }) })); } catch { /* told nothing */ }
    }
    // A file the page makes to be downloaded (an export button's: a link
    // with download to a blob: or data: address, clicked, or click()'d as
    // it's made, and its address let go at once): read as it's clicked,
    // its bytes relayed as a file stream marked a download, with its name,
    // for the person's browser to save into Downloads (go-media.js, go.js).
    // The engine downloads nothing itself (its click's default prevented).
    const isDownload = (a) => a?.localName === "a" && a.hasAttribute?.("download") && /^(?:blob|data):/i.test(a.href ?? "");
    function download(a) {
        const said = String(a.getAttribute("download") ?? "").trim();
        fetch(a.href).then((r) => r.blob()).then((blob) => {
            relayFile(blob, { download: (said || "download").slice(0, 255) });
            watch();
        }, () => { /* not readable: nothing */ });
    }
    // A file the page shares (navigator.share({files}): godevice.js asks,
    // in this world): relayed as a file stream marked shared, with its
    // name; its number said back.
    window.addEventListener("__tabtop_share_file", (e) => {
        const d = e.detail;
        if (!(d?.file instanceof Blob) || typeof d.name !== "string" || d.stream !== undefined) return;
        d.stream = relayFile(d.file, { share: d.name.slice(0, 255) });
        watch();
    });
    const nativeClick = globalThis.HTMLAnchorElement?.prototype.click;
    let clicking = null;
    if (nativeClick) {
        Object.defineProperty(HTMLAnchorElement.prototype, "click", { configurable: true, writable: true, enumerable: true, value: function click() {
            if (!isDownload(this)) return nativeClick.call(this);
            // Its click event, as a browser's (the page's handlers may
            // cancel it), then its download.
            clicking = this;
            let go = true;
            try { go = this.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, view: window })); } finally { clicking = null; }
            if (go) download(this);
        } });
    }
    window.addEventListener("click", (e) => {
        if (e.defaultPrevented) return;
        const a = e.composedPath?.().find(isDownload);
        if (!a || a === clicking) return;
        e.preventDefault();
        download(a);
    });
    // The agent, once there, asks which are streams (one in a frame is made
    // after its page has played one): said again.
    window.addEventListener("message", (e) => {
        if (e.data?.__tabtop !== "blobs") return;
        for (const [url, stream] of blobStreams) {
            try { reader().dispatchEvent(new CustomEvent("__tabtop_blob", { detail: JSON.stringify({ url, stream }) })); } catch { /* told nothing */ }
        }
    });
    function readOut() {
        const batch = [];
        let size = 0;
        while (queue.length && batch.length < 64 && size < (768 << 10)) {
            const command = queue.shift();
            size += command.data?.length || 0;
            batch.push(command);
        }
        queued -= size;
        if (batch.length) reader().dispatchEvent(new CustomEvent("__tabtop_stream", { detail: JSON.stringify(batch) }));
        for (const pump of pumps) pump();  // a file's next parts, as these go
    }
    listen();

    const timeRanges = (ranges = []) => ({
        length: ranges.length,
        start(i) { if (!ranges[i]) throw new DOMException("Invalid range index", "IndexSizeError"); return ranges[i][0]; },
        end(i) { if (!ranges[i]) throw new DOMException("Invalid range index", "IndexSizeError"); return ranges[i][1]; },
    });

    class RelayBuffer extends EventTarget {
        updating = false;
        mode = "segments";
        timestampOffset = 0;
        appendWindowStart = 0;
        appendWindowEnd = Infinity;
        get buffered() { return timeRanges(this.ranges); }
        constructor(source, index) {
            super();
            this.source = source;
            this.index = index;
        }
        update() {
            this.updating = true;
            enqueue(this.source, { op: "ack", buffer: this.index });
            setTimeout(() => this.dispatchEvent(new Event("updatestart")), 0);
        }
        finish() {
            if (!this.updating) return;
            this.updating = false;
            this.dispatchEvent(new Event("update"));
            this.dispatchEvent(new Event("updateend"));
        }
        appendBuffer(input) {
            if (this.updating) throw new DOMException("SourceBuffer is updating", "InvalidStateError");
            const bytes = ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
            const buffer = this.index;
            enqueue(this.source, { op: "config", buffer, mode: this.mode, offset: this.timestampOffset,
                start: this.appendWindowStart, end: Number.isFinite(this.appendWindowEnd) ? this.appendWindowEnd : null });
            for (let at = 0; at < bytes.length && !this.source.failed; at += 49152) {
                const data = btoa(String.fromCharCode(...bytes.subarray(at, at + 49152)));
                enqueue(this.source, { op: "append", buffer, data });
            }
            this.update();
        }
        remove(start, end) {
            if (this.updating) throw new DOMException("SourceBuffer is updating", "InvalidStateError");
            enqueue(this.source, { op: "remove", buffer: this.index, start, end });
            this.update();
        }
        abort() { enqueue(this.source, { op: "abort", buffer: this.index }); }
        changeType(mime) { enqueue(this.source, { op: "type", buffer: this.index, mime }); }
    }

    class RelaySource extends EventTarget {
        id = ++next;
        readyState = "closed";
        sourceBuffers = [];
        activeSourceBuffers = this.sourceBuffers;
        length = NaN;
        nextBuffer = 0;
        managed = false;
        streaming = false;
        static isTypeSupported(mime) { return /^(audio|video)\/(mp4|webm)(?:;|$)/i.test(mime); }
        get duration() { return this.length; }
        set duration(value) {
            this.length = value;
            enqueue(this, { op: "duration", value: Number.isFinite(value) ? value : null });
        }
        addSourceBuffer(mime) {
            listen();
            if (!RelaySource.isTypeSupported(mime)) throw new DOMException("Unsupported media type", "NotSupportedError");
            const index = this.nextBuffer++;
            const buffer = new RelayBuffer(this, index);
            this.sourceBuffers.push(buffer);
            enqueue(this, { op: "add", buffer: index, mime });
            return buffer;
        }
        removeSourceBuffer(buffer) {
            const at = this.sourceBuffers.indexOf(buffer);
            if (at < 0) throw new DOMException("Unknown SourceBuffer", "NotFoundError");
            this.sourceBuffers.splice(at, 1);
            enqueue(this, { op: "drop", buffer: buffer.index });
        }
        endOfStream() {
            this.readyState = "ended";
            this.setStreaming(false);
            enqueue(this, { op: "end" });
            this.dispatchEvent(new Event("sourceended"));
        }
        setStreaming(on) {
            if (!this.managed || this.streaming === !!on) return;
            this.streaming = !!on;
            this.dispatchEvent(new Event(on ? "startstreaming" : "endstreaming"));
        }
    }

    // Same remoting as MediaSource, with managed streaming signals for HLS.js.
    class RelayManagedSource extends RelaySource {
        managed = true;
        static isTypeSupported(mime) { return RelaySource.isTypeSupported(mime); }
    }

    // EventTarget subclasses do not inherit the Web IDL on* properties
    // that a site's player can use in place of addEventListener.
    for (const [prototype, events] of [
        [RelaySource.prototype, ["sourceopen", "sourceended", "sourceclose"]],
        [RelayManagedSource.prototype, ["sourceopen", "sourceended", "sourceclose", "startstreaming", "endstreaming"]],
        [RelayBuffer.prototype, ["updatestart", "update", "updateend", "error", "abort", "bufferedchange"]],
    ]) {
        for (const type of events) {
            const handlers = new WeakMap();
            Object.defineProperty(prototype, "on" + type, {
                configurable: true,
                get() { return handlers.get(this) ?? null; },
                set(handler) {
                    const previous = handlers.get(this);
                    if (previous) this.removeEventListener(type, previous);
                    if (typeof handler === "function") {
                        handlers.set(this, handler);
                        this.addEventListener(type, handler);
                    } else {
                        handlers.delete(this);
                    }
                },
            });
        }
    }
    globalThis.MediaSource = RelaySource;
    globalThis.SourceBuffer = RelayBuffer;
    // Always our relay (never native, never undefined): dash.js constructs
    // after only an `in` check; HLS.js prefers this over MediaSource.
    try {
        Object.defineProperty(globalThis, "ManagedMediaSource", { configurable: true, enumerable: false, writable: true, value: RelayManagedSource });
    } catch {
        try { globalThis.ManagedMediaSource = RelayManagedSource; } catch { /* read-only native */ }
    }
    URL.createObjectURL = function (value) {
        if (!(value instanceof RelaySource)) {
            const url = nativeURL.call(this, value);
            // A Blob that may be played: kept by its URL, relayed if it is.
            if (value instanceof Blob && !/^(?:image|text|font)\//i.test(value.type) && value.size > 0) {
                blobs.set(url, value);
                if (blobs.size > 64) blobs.delete(blobs.keys().next().value);
                watch();
            }
            return url;
        }
        watch();
        const url = prefix + value.id;
        positions.set(url, value);
        if (positions.size > 32) positions.delete(positions.keys().next().value);
        return url;
    };
    URL.revokeObjectURL = function (url) {
        if (String(url).startsWith(prefix)) positions.delete(String(url));
        else {
            blobs.delete(String(url));  // (one relayed goes on: the player has it)
            nativeRevoke.call(this, url);
        }
    };

    const attached = new WeakMap();
    // (As a browser picks it: its own src if it has one, empty or not;
    // else its first <source> with one that isn't empty. As goagent.js's.)
    const sourceURL = (el) => el.hasAttribute("src") ? el.getAttribute("src") || null : el.querySelector(':scope > source[src]:not([src=""])')?.getAttribute("src") ?? null;
    const nativeBuffered = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "buffered");
    if (nativeBuffered?.get && nativeBuffered.configurable) {
        Object.defineProperty(HTMLMediaElement.prototype, "buffered", { ...nativeBuffered, get() {
            const source = attached.get(this);
            return source && sourceURL(this) === prefix + source.id ? timeRanges(source.ranges) : nativeBuffered.get.call(this);
        } });
    }
    const aheadOf = (ranges, t) => {
        const list = Array.isArray(ranges) ? ranges : [];
        for (const r of list) {
            const a = Number(r?.[0]), b = Number(r?.[1]);
            if (Number.isFinite(a) && Number.isFinite(b) && a <= t + 0.5 && b > t) return b - t;
        }
        return 0;
    };
    window.addEventListener("__tabtop_media", (e) => {
        const at = (e.composedPath?.()[0] ?? e.target);
        const source = attached.get(at);
        if (!source || sourceURL(at) !== prefix + source.id) return;
        let play;
        try { play = JSON.parse(e.detail)?.play; } catch { return; }
        if (play?.stream !== source.id) return;
        source.ranges = play.buffered;
        for (const buffer of source.sourceBuffers) {
            const prev = buffer.ranges;
            buffer.ranges = play.buffers[buffer.index];
            if (play.ack === buffer.index) buffer.finish();
            // HLS.js ManagedMediaSource path watches bufferedchange.
            if (source.managed && prev !== buffer.ranges) {
                const ev = new Event("bufferedchange");
                ev.addedRanges = [];
                ev.removedRanges = [];
                buffer.dispatchEvent(ev);
            }
        }
        if (source.managed && source.readyState === "open") {
            const ahead = aheadOf(play.buffered, Number(play.t) || 0);
            if (ahead < STREAM_LOW) source.setStreaming(true);
            else if (ahead > STREAM_HIGH) source.setStreaming(false);
        }
    }, true);
    function attach(el) {
        const url = sourceURL(el);
        if (url && blobs.has(url)) return relayBlob(url);
        const old = attached.get(el);
        if (old && url === prefix + old.id) return;
        if (old) {
            attached.delete(el);
            old.readyState = "closed";
            old.setStreaming(false);
            old.dispatchEvent(new Event("sourceclose"));
        }
        const source = positions.get(url);
        if (!source || source.readyState !== "closed") return;
        attached.set(el, source);
        source.readyState = "open";
        setTimeout(() => {
            if (attached.get(el) !== source || source.readyState !== "open") return;
            source.dispatchEvent(new Event("sourceopen"));
            // Ask the page for media at once (ManagedMediaSource / HLS.js).
            source.setStreaming(true);
        }, 0);
    }
    const observer = new MutationObserver((records) => {
        for (const record of records) {
            if (record.target instanceof HTMLMediaElement) attach(record.target);
            if (record.target.localName === "source" && record.target.parentElement instanceof HTMLMediaElement) attach(record.target.parentElement);
            for (const node of record.addedNodes) {
                if (node instanceof HTMLMediaElement) attach(node);
                node.querySelectorAll?.("video, audio").forEach(attach);
            }
        }
    });
    // The document now (see above: the window's may have changed since).
    let watching = null;
    const watch = () => {
        if (watching === document) return;
        watching = document;
        observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });
        listen();
    };
    watch();

    window.addEventListener("error", (e) => {
        if (e.target instanceof HTMLMediaElement && sourceURL(e.target)?.startsWith(prefix)) e.stopImmediatePropagation();
    }, true);
    const load = HTMLMediaElement.prototype.load;
    HTMLMediaElement.prototype.load = function () {
        attach(this);
        if (!sourceURL(this)?.startsWith(prefix)) return load.call(this);
    };
    // asked: played by the page (its play(), here) and not paused since.
    const asked = new WeakSet();
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
        if (!sourceURL(this)?.startsWith(prefix)) return play.call(this);
        attach(this);
        asked.add(this);
        this.dispatchEvent(new CustomEvent("__tabtop_media_hold", { composed: true, detail: "release" }));
        this.dispatchEvent(new Event("play"));
        return Promise.resolve();
    };
    // play() above never starts the engine's element, so its pause() is a
    // no-op and fires nothing. When remoted playback already says playing,
    // the pause wrapper above handles it; otherwise still fire pause so the
    // agent stops the person's player (Shorts' pause before media-meta lands).
    // Played by the page, and paused before the person's player said it
    // plays: pause fired (once; a task later, as a browser's), so the agent
    // stops that player, and its reports till then aren't taken (hold).
    // Already paused and not asked to play since: nothing, as a browser.
    const pause = HTMLMediaElement.prototype.pause;
    HTMLMediaElement.prototype.pause = function () {
        if (!sourceURL(this)?.startsWith(prefix)) return pause.call(this);
        const wanted = asked.delete(this);
        if (!this.paused) return pause.call(this);
        if (!wanted) return;
        this.dispatchEvent(new CustomEvent("__tabtop_media_hold", { composed: true }));
        // (Not if the page's played it again since: its play's event, fired
        // at once, came first, and a pause after it would stop the person's
        // player the page wants playing. YouTube's Shorts stops a reel, then
        // plays it, within a task.)
        setTimeout(() => { if (!asked.has(this)) this.dispatchEvent(new Event("pause")); }, 0);
    };
})();
