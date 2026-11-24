// The page's screen.orientation.lock and unlock, in its own world, for an
// engine whose lock is refused (Moli 1.1.27, measured: NotSupportedError
// "not available on this device"). Asked for while the page is in its own
// fullscreen (gofullscreen.js: allowed after the person's press; a phone's
// browser locks only in fullscreen too), it's asked of the server through
// the agent (goorientation.go), and the person's browser locks its screen
// (go.js), its answer the page's. Its screen turned, the page's
// screen.orientation follows, as the view's way up always does.
(() => {
    const SO = globalThis.ScreenOrientation?.prototype;
    if (!SO) return;
    const TYPES = ["any", "natural", "landscape", "portrait", "portrait-primary", "portrait-secondary", "landscape-primary", "landscape-secondary"];
    const tell = (detail) => {
        try { document.dispatchEvent(new CustomEvent("__tabtop_orientation", { detail: JSON.stringify(detail) })); } catch { /* told nothing */ }
    };
    const waiting = new Map();  // id -> {resolve, reject, timer}
    let listening = false;
    const listen = () => {
        if (listening) return;
        listening = true;
        document.addEventListener("__tabtop_orientation_answer", (e) => {
            let d;
            try { d = JSON.parse(e.detail); } catch { return; }
            const w = d && waiting.get(d.id);
            if (!w) return;
            waiting.delete(d.id);
            clearTimeout(w.timer);
            if (d.ok) return w.resolve();
            const name = ["NotSupportedError", "SecurityError", "AbortError", "NotAllowedError", "InvalidStateError"].includes(d.error) ? d.error : "NotSupportedError";
            w.reject(new DOMException(name === "SecurityError" ? "The page needs to be fullscreen in order to call screen.orientation.lock()." : "screen.orientation.lock() is not available on this device.", name));
        });
    };
    const isTop = (() => { try { return window.top === window; } catch { return false; } })();
    Object.defineProperty(SO, "lock", {
        configurable: true, writable: true, enumerable: true,
        value: { lock(orientation) {
            if (!arguments.length) return Promise.reject(new TypeError("Failed to execute 'lock' on 'ScreenOrientation': 1 argument required, but only 0 present."));
            const type = String(orientation);
            if (!TYPES.includes(type)) return Promise.reject(new TypeError(`Failed to execute 'lock' on 'ScreenOrientation': The provided value '${type}' is not a valid enum value of type OrientationLockType.`));
            if (!isTop || !document.fullscreenElement) return Promise.reject(new DOMException("The page needs to be fullscreen in order to call screen.orientation.lock().", "SecurityError"));
            listen();
            return new Promise((resolve, reject) => {
                const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
                const timer = setTimeout(() => { waiting.delete(id); reject(new DOMException("screen.orientation.lock() is not available on this device.", "NotSupportedError")); }, 10_000);
                waiting.set(id, { resolve, reject, timer });
                tell({ lock: type, id });
            });
        } }.lock,
    });
    Object.defineProperty(SO, "unlock", {
        configurable: true, writable: true, enumerable: true,
        value: { unlock() { if (isTop) tell({ unlock: true }); } }.unlock,
    });
})();
