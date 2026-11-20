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
(() => {
    const SEND = "__tabtop_media";
    const num = (v, max) => (Number.isFinite(v) && v >= 0 && v <= max ? v : 0);
    const plays = new WeakMap();  // element -> {t, at, playing, ended}: as the person's player last said
    const proto = HTMLMediaElement.prototype;
    const sourceOf = (el) => el.getAttribute("src") ?? el.querySelector("source[src]")?.getAttribute("src");
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
    function played(el, d) {
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
        }
    }
    document.addEventListener(SEND, (e) => {
        const el = e.target;
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
(() => {
    const prefix = "blob:tabtop-media/";
    const queue = [];
    let queued = 0, next = 0;
    const limit = 16 << 20;
    const nativeURL = URL.createObjectURL;
    const nativeRevoke = URL.revokeObjectURL;
    const positions = new Map();

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

    document.addEventListener("__tabtop_read_stream", () => {
        const batch = [];
        let size = 0;
        while (queue.length && batch.length < 64 && size < (768 << 10)) {
            const command = queue.shift();
            size += command.data?.length || 0;
            batch.push(command);
        }
        queued -= size;
        if (batch.length) document.dispatchEvent(new CustomEvent("__tabtop_stream", { detail: JSON.stringify(batch) }));
    });

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
        static isTypeSupported(mime) { return /^(audio|video)\/(mp4|webm)(?:;|$)/i.test(mime); }
        get duration() { return this.length; }
        set duration(value) {
            this.length = value;
            enqueue(this, { op: "duration", value: Number.isFinite(value) ? value : null });
        }
        addSourceBuffer(mime) {
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
            enqueue(this, { op: "end" });
            this.dispatchEvent(new Event("sourceended"));
        }
    }

    // EventTarget subclasses do not inherit the Web IDL on* properties
    // that a site's player can use in place of addEventListener.
    for (const [prototype, events] of [
        [RelaySource.prototype, ["sourceopen", "sourceended", "sourceclose"]],
        [RelayBuffer.prototype, ["updatestart", "update", "updateend", "error", "abort"]],
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
    URL.createObjectURL = function (value) {
        if (!(value instanceof RelaySource)) return nativeURL.call(this, value);
        const url = prefix + value.id;
        positions.set(url, value);
        if (positions.size > 32) positions.delete(positions.keys().next().value);
        return url;
    };
    URL.revokeObjectURL = function (url) {
        if (String(url).startsWith(prefix)) positions.delete(String(url));
        else nativeRevoke.call(this, url);
    };

    const attached = new WeakMap();
    const nativeBuffered = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "buffered");
    if (nativeBuffered?.get && nativeBuffered.configurable) {
        Object.defineProperty(HTMLMediaElement.prototype, "buffered", { ...nativeBuffered, get() {
            const source = attached.get(this);
            return this.getAttribute("src") === prefix + source?.id ? timeRanges(source.ranges) : nativeBuffered.get.call(this);
        } });
    }
    document.addEventListener("__tabtop_media", (e) => {
        const source = attached.get(e.target);
        if (!source || e.target.getAttribute("src") !== prefix + source.id) return;
        let play;
        try { play = JSON.parse(e.detail)?.play; } catch { return; }
        if (play?.stream !== source.id) return;
        source.ranges = play.buffered;
        for (const buffer of source.sourceBuffers) {
            buffer.ranges = play.buffers[buffer.index];
            if (play.ack === buffer.index) buffer.finish();
        }
    }, true);
    function attach(el) {
        const source = positions.get(el.getAttribute("src"));
        if (!source || source.readyState !== "closed") return;
        attached.set(el, source);
        source.readyState = "open";
        setTimeout(() => source.dispatchEvent(new Event("sourceopen")), 0);
    }
    new MutationObserver((records) => {
        for (const record of records) {
            if (record.type === "attributes" && record.target instanceof HTMLMediaElement) attach(record.target);
            for (const node of record.addedNodes) {
                if (node instanceof HTMLMediaElement) attach(node);
                node.querySelectorAll?.("video, audio").forEach(attach);
            }
        }
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });

    document.addEventListener("error", (e) => {
        if (e.target instanceof HTMLMediaElement && e.target.getAttribute("src")?.startsWith(prefix)) e.stopImmediatePropagation();
    }, true);
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
        if (!this.getAttribute("src")?.startsWith(prefix)) return play.call(this);
        attach(this);
        this.dispatchEvent(new Event("play"));
        return Promise.resolve();
    };
})();
