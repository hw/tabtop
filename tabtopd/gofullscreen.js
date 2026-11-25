// The page's fullscreen (Element.requestFullscreen, document.exitFullscreen
// and their webkit names), in its own world, for an engine that has none
// (Moli 1.1.27, measured: no requestFullscreen, fullscreenEnabled false).
// Asked for, it's asked of the server through the agent (goagent.js,
// gofullscreen.go: only after the person's own input, as a browser's is),
// which answers: allowed, the element is laid out over the whole window,
// as a browser's fullscreen element is, and the person's browser shows the
// page alone, over its screen (go.js); refused, the page's told so. Left
// here or there, it's left in both, the page told (fullscreenchange).
//
// What a browser's top layer does isn't done: a fixed element in an
// ancestor that's transformed is laid out in that ancestor, and the page's
// :fullscreen rules don't match (its element is [data-tabtop-fullscreen]).
(() => {
    const ATTR = "data-tabtop-fullscreen";
    const STYLE = `[${ATTR}] { position: fixed !important; inset: 0 !important; margin: 0 !important; box-sizing: border-box !important; min-width: 0 !important; max-width: none !important; min-height: 0 !important; max-height: none !important; width: 100% !important; height: 100% !important; transform: none !important; z-index: 2147483647 !important; }
video[${ATTR}], img[${ATTR}], canvas[${ATTR}] { object-fit: contain !important; background: #000 !important; }
iframe[${ATTR}] { border: 0 !important; }`;
    const reader = () => tabtopTop().document;  // (gopage-prelude.js)
    const tell = (detail) => {
        try { tabtopTell(reader(), "__tabtop_fullscreen", detail); } catch { /* told nothing */ }
    };
    let current = null, style = null, hosts = [];
    // The style, put in doc (this one's, or a same-origin parent's).
    const styleIn = (doc) => {
        const st = doc.createElement("style");
        st.textContent = STYLE;
        st.setAttribute("data-tabtop", "");
        (doc.head ?? doc.documentElement).append(st);
        return st;
    };
    // The iframes this document is in, of its origin (another's are the
    // server's to lay over their windows: gofullscreen.go), laid over theirs.
    function hold(on) {
        for (const h of hosts) {
            h.el.removeAttribute(ATTR);
            h.style.remove();
        }
        hosts = [];
        if (!on) return;
        let w = window;
        try {
            while (w.frameElement) {
                const el = w.frameElement;
                hosts.push({ el, style: styleIn(el.ownerDocument) });
                el.setAttribute(ATTR, "");
                w = w.parent;
            }
        } catch { /* another origin's: as far as this one's */ }
    }
    const waiting = new Map();
    let listening = null;
    const listen = () => {
        if (listening === reader()) return;
        listening = reader();
        // The server's answer to a request ({id, ok}), or the person's
        // leaving it ({exit: true}).
        reader().addEventListener("__tabtop_fullscreen_answer", (e) => {
            let d;
            try { d = JSON.parse(e.detail); } catch { return; }
            if (d?.exit) return leave(false);
            const w = d && waiting.get(d.id);
            if (!w) return;
            waiting.delete(d.id);
            clearTimeout(w.timer);
            if (d.ok && w.el.isConnected) {
                show(w.el);
                w.resolve();
            } else {
                for (const type of ["fullscreenerror", "webkitfullscreenerror"]) w.el.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
                w.reject(new TypeError("Permissions check failed"));
            }
        });
    };
    const changed = (el) => {
        const at = el?.isConnected ? el : document;
        for (const type of ["fullscreenchange", "webkitfullscreenchange"]) at.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
    };
    function show(el) {
        if (current === el) return;
        if (current) current.removeAttribute(ATTR);
        current = el;
        if (!style?.isConnected) style = styleIn(document);
        el.setAttribute(ATTR, "");
        hold(true);
        changed(el);
    }
    // leave: the page's element let go (tellServer: the page's own doing,
    // the person's browser to leave its fullscreen too).
    function leave(tellServer) {
        const el = current;
        if (!el) return;
        current = null;
        el.removeAttribute(ATTR);
        style?.remove();
        hold(false);
        if (tellServer) tell({ on: false });
        changed(el);
    }
    // An element leaving the document leaves fullscreen, as a browser's.
    // (Watched once it's asked for: the document then, as a frame's first
    // page can have the window its about:blank had, gomedia.js.)
    const gone = new MutationObserver(() => { if (current && !current.isConnected) leave(true); });
    let watching = null;

    function request() {
        const el = this;
        listen();
        if (watching !== document) {
            watching = document;
            gone.observe(document, { childList: true, subtree: true });
        }
        if (!(el instanceof Element) || !el.isConnected) return Promise.reject(new TypeError("Element is not connected"));
        if (current === el) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const id = tabtopID();
            const timer = setTimeout(() => { waiting.delete(id); reject(new TypeError("Permissions check failed")); }, 10_000);
            waiting.set(id, { el, resolve, reject, timer });
            tell({ on: true, id });
        });
    }
    function exit() {
        if (!current) return Promise.reject(new TypeError("Document not active"));
        leave(true);
        return Promise.resolve();
    }
    const define = (on, name, value) => Object.defineProperty(on, name, { value, writable: true, enumerable: true, configurable: true });
    const getter = (on, name, get) => Object.defineProperty(on, name, { get, enumerable: true, configurable: true });
    const E = Element.prototype, D = Document.prototype;
    for (const name of ["requestFullscreen", "webkitRequestFullscreen", "webkitRequestFullScreen"]) define(E, name, function (options) { return request.call(this, options); });
    for (const name of ["exitFullscreen", "webkitExitFullscreen", "webkitCancelFullScreen"]) define(D, name, function () { return exit(); });
    for (const name of ["fullscreenElement", "webkitFullscreenElement", "webkitCurrentFullScreenElement"]) getter(D, name, function () { return this === document ? current : null; });
    for (const name of ["fullscreenEnabled", "webkitFullscreenEnabled"]) getter(D, name, function () { return true; });
    for (const name of ["fullscreen", "webkitIsFullScreen"]) getter(D, name, function () { return this === document && !!current; });
    if (globalThis.ShadowRoot) getter(ShadowRoot.prototype, "fullscreenElement", function () { return current && this.contains(current) ? current : null; });
    // A video's own (Safari's, which some players use).
    const V = globalThis.HTMLVideoElement?.prototype;
    if (V) {
        define(V, "webkitEnterFullscreen", function () { request.call(this).catch(() => {}); });
        define(V, "webkitExitFullscreen", function () { if (current === this) exit(); });
        getter(V, "webkitSupportsFullscreen", function () { return true; });
        getter(V, "webkitDisplayingFullscreen", function () { return current === this; });
    }
    // on…: as the page may set them.
    for (const on of [D, E]) {
        for (const type of ["fullscreenchange", "fullscreenerror"]) {
            const handlers = new WeakMap();
            Object.defineProperty(on, "on" + type, {
                get() { return handlers.get(this)?.f ?? null; },
                set(f) {
                    const was = handlers.get(this);
                    if (was) this.removeEventListener(type, was.call);
                    if (typeof f !== "function") return void handlers.delete(this);
                    const h = { f, call: (e) => f.call(this, e) };
                    handlers.set(this, h);
                    this.addEventListener(type, h.call);
                },
                enumerable: true, configurable: true,
            });
        }
    }
})();
