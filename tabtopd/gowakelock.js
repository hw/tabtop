// The page's screen wake lock (navigator.wakeLock), in its own world, for an
// engine that has none (Moli 1.1.27, measured: no navigator.wakeLock).
// Asked for, it's asked of the server through the agent (goagent.js,
// gowakelock.go: a secure top page's, after the person's own input there),
// which answers: allowed, the person's browser holds a wake lock of its own
// (go.js) while any of the page's sentinels is held; refused, the page's
// told so (NotAllowedError). Released by the page, its sentinel's let go;
// lost (the person's browser couldn't keep it, or the page went), every
// sentinel's released, the page told ("release").
//
// A frame's (of the page's origin too) is refused: only the top page's
// is asked for. As in browsers, none on an insecure page.
(() => {
    if (!isSecureContext || "wakeLock" in navigator) return;
    const tell = (detail) => {
        try { tabtopTell(document, "__tabtop_wakelock", detail); } catch { /* told nothing */ }
    };
    const held = new Map();  // id -> sentinel
    const key = {};  // what its classes' constructors take: theirs alone
    const state = new WeakMap();  // sentinel -> {id, released}
    const handlers = new WeakMap();  // sentinel -> its onrelease
    function letGo(s) {
        const st = state.get(s);
        if (!st || st.released) return false;
        st.released = true;
        held.delete(st.id);
        s.dispatchEvent(new Event("release"));
        return true;
    }
    class WakeLockSentinel extends EventTarget {
        constructor(k, id) {
            if (k !== key) throw new TypeError("Illegal constructor");
            super();
            state.set(this, { id, released: false });
        }
        get released() { return state.get(this)?.released ?? true; }
        get type() { return "screen"; }
        get onrelease() { return handlers.get(this) ?? null; }
        set onrelease(f) {
            const was = handlers.get(this);
            if (was) this.removeEventListener("release", was);
            handlers.delete(this);
            if (typeof f === "function") {
                handlers.set(this, f);
                this.addEventListener("release", f);
            }
        }
        release() {
            const st = state.get(this);
            if (st && letGo(this)) tell({ on: false, id: st.id });
            return Promise.resolve();
        }
        get [Symbol.toStringTag]() { return "WakeLockSentinel"; }
    }
    const denied = () => new DOMException("Wake Lock permission request denied", "NotAllowedError");
    // The server's answer ({id, ok}), or its lock lost ({lost: true}).
    const ask = tabtopAsker("__tabtop_wakelock_answer", (d, resolve, reject) => {
        if (!d.ok) return reject(denied());
        const s = new WakeLockSentinel(key, d.id);
        held.set(d.id, s);
        resolve(s);
    }, (d) => {
        if (d?.lost) for (const s of [...held.values()]) letGo(s);
    });
    class WakeLock {
        constructor(k) {
            if (k !== key) throw new TypeError("Illegal constructor");
        }
        request(type = "screen") {
            if (type !== "screen") return Promise.reject(new TypeError(`Failed to execute 'request' on 'WakeLock': The provided value '${String(type)}' is not a valid enum value of type WakeLockType.`));
            if (!tabtopIsTop) return Promise.reject(new DOMException("Access to Screen Wake Lock features is disallowed by permissions policy", "NotAllowedError"));
            if (document.visibilityState !== "visible") return Promise.reject(new DOMException("The requesting page is not visible", "NotAllowedError"));
            return ask((id) => tell({ on: true, id }), 10_000, (resolve, reject) => reject(denied()));
        }
        get [Symbol.toStringTag]() { return "WakeLock"; }
    }
    const lock = new WakeLock(key);
    Object.defineProperty(Navigator.prototype, "wakeLock", { configurable: true, enumerable: true, get() { return lock; } });
    for (const [name, C] of [["WakeLock", WakeLock], ["WakeLockSentinel", WakeLockSentinel]]) {
        Object.defineProperty(globalThis, name, { value: C, writable: true, configurable: true, enumerable: false });
    }
})();
