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
            get: { [name]() { const p = plays.get(this); return p ? get(this, p) : was.get.call(this); } }[name],
            ...(was.set ? { set: { [name](v) { const p = plays.get(this); if (p && set) set(this, p, v); else was.set.call(this, v); } }[name] } : {}),
        });
    }
    // timeupdate as a browser's, a few times a second, while one plays.
    const playing = new Set();
    let ticking = 0;
    const tick = () => {
        for (const el of playing) {
            if (!el.isConnected || !plays.get(el)?.playing) playing.delete(el);
            else fire(el, "timeupdate");
        }
        if (!playing.size) {
            clearInterval(ticking);
            ticking = 0;
        }
    };
    function played(el, d) {
        const was = plays.get(el);
        const now = { t: num(d.t, 1e7), at: performance.now(), playing: !!d.playing, ended: !!d.ended };
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
