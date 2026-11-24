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
    const isTop = (() => { try { return window.top === window; } catch { return false; } })();
    const tell = (detail) => {
        try { document.dispatchEvent(new CustomEvent("__tabtop_wakelock", { detail: JSON.stringify(detail) })); } catch { /* told nothing */ }
    };
    const held = new Map();  // id -> sentinel
    const waiting = new Map();  // id -> {resolve, reject, timer}
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
        constructor(key, id) {
            if (key !== waiting) throw new TypeError("Illegal constructor");
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
    let listening = false;
    const listen = () => {
        if (listening) return;
        listening = true;
        // The server's answer ({id, ok}), or its lock lost ({lost: true}).
        document.addEventListener("__tabtop_wakelock_answer", (e) => {
            let d;
            try { d = JSON.parse(e.detail); } catch { return; }
            if (d?.lost) {
                for (const s of [...held.values()]) letGo(s);
                return;
            }
            const w = d && waiting.get(d.id);
            if (!w) return;
            waiting.delete(d.id);
            clearTimeout(w.timer);
            if (!d.ok) return w.reject(new DOMException("Wake Lock permission request denied", "NotAllowedError"));
            const s = new WakeLockSentinel(waiting, d.id);
            held.set(d.id, s);
            w.resolve(s);
        });
    };
    class WakeLock {
        constructor(key) {
            if (key !== waiting) throw new TypeError("Illegal constructor");
        }
        request(type = "screen") {
            if (type !== "screen") return Promise.reject(new TypeError(`Failed to execute 'request' on 'WakeLock': The provided value '${String(type)}' is not a valid enum value of type WakeLockType.`));
            if (!isTop) return Promise.reject(new DOMException("Access to Screen Wake Lock features is disallowed by permissions policy", "NotAllowedError"));
            if (document.visibilityState !== "visible") return Promise.reject(new DOMException("The requesting page is not visible", "NotAllowedError"));
            listen();
            return new Promise((resolve, reject) => {
                const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
                const timer = setTimeout(() => { waiting.delete(id); reject(new DOMException("Wake Lock permission request denied", "NotAllowedError")); }, 10_000);
                waiting.set(id, { resolve, reject, timer });
                tell({ on: true, id });
            });
        }
        get [Symbol.toStringTag]() { return "WakeLock"; }
    }
    const lock = new WakeLock(waiting);
    Object.defineProperty(Navigator.prototype, "wakeLock", { configurable: true, enumerable: true, get() { return lock; } });
    for (const [name, C] of [["WakeLock", WakeLock], ["WakeLockSentinel", WakeLockSentinel]]) {
        Object.defineProperty(globalThis, name, { value: C, writable: true, configurable: true, enumerable: false });
    }
})();
