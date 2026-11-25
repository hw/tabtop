// The page's media session (navigator.mediaSession, MediaMetadata), in its
// own world, for an engine whose session goes nowhere (it plays nothing
// the person hears: its players are relayed, go-media.js): what the page
// says of what it's playing (its title, artist, album and artwork), whether
// it's playing, where, and which of the person's media controls it answers
// (its action handlers) is said to the agent (goagent.js), which passes the
// latest on to the server (gomediasession.go), for the person's browser to
// show and answer (go.js): its controls (a phone's lock screen, a
// keyboard's media keys) calling the page's handlers here.
//
// As in browsers: an action that isn't one, a position that isn't one,
// refused (TypeError); artwork's addresses resolved against the page's.
// The top page's only, and a frame of its origin's (as its own session is
// the page's); another origin's said nothing.
(() => {
    if (typeof Navigator !== "function") return;
    const reader = tabtopTop;  // (gopage-prelude.js)
    const ACTIONS = ["play", "pause", "seekbackward", "seekforward", "previoustrack", "nexttrack", "skipad", "stop", "seekto",
        "togglemicrophone", "togglecamera", "togglescreenshare", "hangup", "previousslide", "nextslide", "enterpictureinpicture", "voiceactivity"];
    const STATES = ["none", "paused", "playing"];
    const str = (v) => String(v ?? "");

    // MediaMetadata: its fields, artwork's a frozen list of frozen
    // images (src resolved), changed on the session it's set on too.
    const meta = new WeakMap();  // MediaMetadata -> {title, artist, album, artwork, session}
    const image = (i) => {
        if (i === null || typeof i !== "object") throw new TypeError("Failed to read the 'artwork' property from 'MediaMetadataInit': an image isn't an object.");
        if (i.src === undefined) throw new TypeError("Failed to read the 'artwork' property from 'MediaMetadataInit': required member src is undefined.");
        let src;
        try { src = new URL(str(i.src), document.baseURI).href; } catch { throw new TypeError(`Failed to read the 'artwork' property from 'MediaMetadataInit': '${str(i.src)}' can't be resolved.`); }
        return Object.freeze({ src, sizes: str(i.sizes ?? ""), type: str(i.type ?? "") });
    };
    const artwork = (v) => {
        if (v === undefined) return Object.freeze([]);
        if (v === null || typeof v !== "object" || typeof v[Symbol.iterator] !== "function") throw new TypeError("Failed to read the 'artwork' property from 'MediaMetadataInit': The provided value cannot be converted to a sequence.");
        return Object.freeze([...v].map(image));
    };
    class MediaMetadata {
        constructor(init = {}) {
            init = init ?? {};
            meta.set(this, { title: str(init.title ?? ""), artist: str(init.artist ?? ""), album: str(init.album ?? ""), artwork: artwork(init.artwork), session: null });
        }
        get [Symbol.toStringTag]() { return "MediaMetadata"; }
    }
    for (const name of ["title", "artist", "album"]) {
        Object.defineProperty(MediaMetadata.prototype, name, { configurable: true, enumerable: true,
            get() { return meta.get(this)?.[name]; },
            set(v) { const m = meta.get(this); if (!m) return; m[name] = str(v); m.session?.(); } });
    }
    Object.defineProperty(MediaMetadata.prototype, "artwork", { configurable: true, enumerable: true,
        get() { return meta.get(this)?.artwork; },
        set(v) { const m = meta.get(this); if (!m) return; m.artwork = artwork(v); m.session?.(); } });

    // The session: what it says, told once a change has settled (several
    // at once, as a page sets them, said as one).
    let metadata = null, state = "none", position = null, soon = false;
    const handlers = new Map();  // action -> handler
    function said() {
        if (soon) return;
        soon = true;
        queueMicrotask(() => {
            soon = false;
            const top = reader();
            if (top.parent !== top) return;  // (another origin's frame: not the page's)
            const m = metadata && meta.get(metadata);
            try {
                tabtopTell(top.document, "__tabtop_media_session", {
                    metadata: m ? { title: m.title, artist: m.artist, album: m.album, artwork: m.artwork.map((i) => ({ ...i })) } : null,
                    state, actions: [...handlers.keys()], position,
                });
            } catch { /* said nothing */ }
        });
    }
    class MediaSession {
        constructor() { throw new TypeError("Illegal constructor"); }
        get metadata() { return metadata; }
        set metadata(v) {
            if (v !== null && v !== undefined && !meta.has(v)) throw new TypeError("Failed to set the 'metadata' property on 'MediaSession': The provided value is not of type 'MediaMetadata'.");
            if (metadata && meta.get(metadata)?.session === said) meta.get(metadata).session = null;
            metadata = v ?? null;
            if (metadata) meta.get(metadata).session = said;
            said();
        }
        get playbackState() { return state; }
        set playbackState(v) {
            if (!STATES.includes(String(v))) return;  // (an enum's other values ignored, as WebIDL's setters do)
            state = String(v);
            said();
        }
        setActionHandler(action, handler) {
            if (arguments.length < 2) throw new TypeError(`Failed to execute 'setActionHandler' on 'MediaSession': 2 arguments required, but only ${arguments.length} present.`);
            action = String(action);
            if (!ACTIONS.includes(action)) throw new TypeError(`Failed to execute 'setActionHandler' on 'MediaSession': The provided value '${action}' is not a valid enum value of type MediaSessionAction.`);
            if (handler !== null && typeof handler !== "function") throw new TypeError("Failed to execute 'setActionHandler' on 'MediaSession': The callback provided as parameter 2 is not a function.");
            if (handler) handlers.set(action, handler);
            else handlers.delete(action);
            said();
        }
        setPositionState(dict) {
            if (dict === undefined || dict === null || Object.keys(dict).length === 0 && dict.duration === undefined) {
                position = null;
                said();
                return;
            }
            const duration = Number(dict.duration), rate = dict.playbackRate === undefined ? 1 : Number(dict.playbackRate), at = dict.position === undefined ? 0 : Number(dict.position);
            const fail = (why) => { throw new TypeError(`Failed to execute 'setPositionState' on 'MediaSession': ${why}`); };
            if (dict.duration === undefined) fail("The duration must be provided.");
            if (Number.isNaN(duration) || duration < 0) fail("The provided duration cannot be less than zero.");
            if (!Number.isFinite(at) || at < 0) fail("The provided position cannot be less than zero.");
            if (at > duration) fail("The provided position cannot be greater than the duration.");
            if (!Number.isFinite(rate) || rate === 0) fail("The provided playbackRate cannot be equal to zero.");
            position = { duration: Number.isFinite(duration) ? duration : -1, rate, position: at };  // (-1: an endless one, a live stream's)
            said();
        }
        setMicrophoneActive() {}
        setCameraActive() {}
        setScreenshareActive() {}
        get [Symbol.toStringTag]() { return "MediaSession"; }
    }
    const session = Object.create(MediaSession.prototype);

    // The person's control pressed (__tabtop_media_action, from the agent):
    // the page's handler for it called, with its details, as a browser
    // calls it.
    let listening = null;
    function listen() {
        if (listening === reader().document) return;
        listening = reader().document;
        listening.addEventListener("__tabtop_media_action", (e) => {
            let d;
            try { d = JSON.parse(e.detail); } catch { return; }
            const handler = handlers.get(d?.action);
            if (!handler) return;
            const details = { action: d.action };
            if (d.action === "seekto") {
                details.seekTime = Number(d.time) || 0;
                details.fastSeek = d.fast === true;
            } else if ((d.action === "seekbackward" || d.action === "seekforward") && Number.isFinite(d.time) && d.time > 0) {
                details.seekOffset = d.time;
            }
            try { handler.call(session, details); } catch (err) { setTimeout(() => { throw err; }); }
        });
    }
    listen();
    const wrap = (fn) => function () { listen(); return fn.apply(this, arguments); };
    MediaSession.prototype.setActionHandler = wrap(MediaSession.prototype.setActionHandler);

    Object.defineProperty(globalThis, "MediaMetadata", { value: MediaMetadata, writable: true, configurable: true, enumerable: false });
    Object.defineProperty(globalThis, "MediaSession", { value: MediaSession, writable: true, configurable: true, enumerable: false });
    Object.defineProperty(Navigator.prototype, "mediaSession", { configurable: true, enumerable: true, get() { return session; } });
})();
