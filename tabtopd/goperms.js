// navigator.permissions.query, in the page's world, saying what /go does
// for each permission, not the engine's "prompt" for every name (Moli
// 1.1.27, measured: "prompt" for all, made-up names too; Chrome 158: e.g.
// clipboard-write, screen-wake-lock and pointer-lock "granted").
//
// - geolocation: "prompt" (asked each time, never kept) for a secure top
//   page where the person's browser has a location (godevice.js says what
//   it has); "denied" elsewhere, as it's refused there.
// - clipboard-read "prompt" (asked each time), clipboard-write "granted"
//   (passed on after the person's input), on a secure page.
// - screen-wake-lock "granted" for a secure top page where the person's
//   browser can keep its screen on (gowakelock.js); pointer-lock
//   "granted" for a top page where it can lock (gopointerlock.js).
// - push: "denied" with userVisibleOnly (no service worker to push to),
//   Chrome's NotSupportedError without.
// - What isn't passed on to the person's browser (camera, microphone, the
//   screen, MIDI, sensors, fonts, other screens...): "denied", so a page
//   doesn't ask for what can't be given.
// - notifications are gonotify.js's; any other name, the engine's.
//
// The engine's own PermissionStatus is given, its state as said here.
(() => {
    const P = globalThis.Permissions?.prototype;
    const nativeQuery = P?.query;
    if (typeof nativeQuery !== "function") return;
    const DENIED = new Set(["camera", "microphone", "display-capture", "keyboard-lock", "midi", "local-fonts", "window-management",
        "idle-detection", "accelerometer", "gyroscope", "magnetometer", "ambient-light-sensor", "bluetooth", "nfc", "speaker-selection",
        "captured-surface-control", "system-wake-lock"]);
    const isTop = (() => { try { return window.top === window; } catch { return false; } })();
    const viewer = () => (isTop && window[Symbol.for("tabtop.viewer")]) || {};
    function stateOf(d) {
        const name = d.name, secure = isSecureContext;
        if (DENIED.has(name)) return "denied";
        switch (name) {
            case "geolocation": return isTop && secure && viewer().location ? "prompt" : "denied";
            case "clipboard-read": return secure ? "prompt" : "denied";
            case "clipboard-write": return secure ? "granted" : "denied";
            case "screen-wake-lock": return isTop && secure && viewer().wakeLock ? "granted" : "denied";
            case "pointer-lock": return isTop && viewer().pointerLock ? "granted" : "denied";
            case "push": return "denied";
        }
        return null;
    }
    Object.defineProperty(P, "query", {
        configurable: true, writable: true, enumerable: true,
        value: { query(descriptor) {
            const name = descriptor?.name;
            if (name === "push" && !descriptor.userVisibleOnly) {
                return Promise.reject(new DOMException("Failed to execute 'query' on 'Permissions': Push Permission without userVisibleOnly:true isn't supported yet.", "NotSupportedError"));
            }
            const result = nativeQuery.apply(this, arguments);
            const said = typeof name === "string" ? stateOf(descriptor) : null;
            if (said === null) return result;
            return Promise.resolve(result).then((status) => {
                try { Object.defineProperty(status, "state", { configurable: true, enumerable: true, get: () => said }); } catch { /* as it is */ }
                return status;
            }, () => ({ state: said, name, onchange: null, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } }));
        } }.query,
    });
})();
