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
        try { tabtopTell(document, "__tabtop_orientation", detail); } catch { /* told nothing */ }
    };
    const notFullscreen = "The page needs to be fullscreen in order to call screen.orientation.lock().";
    const notAvailable = "screen.orientation.lock() is not available on this device.";
    // The server's answer to a lock ({id, ok, error}).
    const ask = tabtopAsker("__tabtop_orientation_answer", (d, resolve, reject) => {
        if (d.ok) return resolve();
        const name = ["NotSupportedError", "SecurityError", "AbortError", "NotAllowedError", "InvalidStateError"].includes(d.error) ? d.error : "NotSupportedError";
        reject(new DOMException(name === "SecurityError" ? notFullscreen : notAvailable, name));
    });
    Object.defineProperty(SO, "lock", {
        configurable: true, writable: true, enumerable: true,
        value: { lock(orientation) {
            if (!arguments.length) return Promise.reject(new TypeError("Failed to execute 'lock' on 'ScreenOrientation': 1 argument required, but only 0 present."));
            const type = String(orientation);
            if (!TYPES.includes(type)) return Promise.reject(new TypeError(`Failed to execute 'lock' on 'ScreenOrientation': The provided value '${type}' is not a valid enum value of type OrientationLockType.`));
            if (!tabtopIsTop || !document.fullscreenElement) return Promise.reject(new DOMException(notFullscreen, "SecurityError"));
            return ask((id) => tell({ lock: type, id }), 10_000, (resolve, reject) => reject(new DOMException(notAvailable, "NotSupportedError")));
        } }.lock,
    });
    Object.defineProperty(SO, "unlock", {
        configurable: true, writable: true, enumerable: true,
        value: { unlock() { if (tabtopIsTop) tell({ unlock: true }); } }.unlock,
    });
})();
