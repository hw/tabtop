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
// It's the page's to see and change, like anything in its world: what it
// does with that only touches its own copy.
(() => {
    const SEND = "__tabtop_media";
    document.addEventListener(SEND, (e) => {
        const el = e.target;
        if (!(el instanceof HTMLMediaElement)) return;
        let d;
        try { d = JSON.parse(e.detail); } catch { return; }
        const num = (v, max) => (Number.isFinite(v) && v >= 0 && v <= max ? v : 0);
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
