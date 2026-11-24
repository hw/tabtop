// The page's navigator.vibrate, in its own world, for an engine whose does
// nothing (Moli 1.1.27, measured: a function that returns false, for 0
// too). The pattern, as the Vibration API reads it, is said to the agent
// (goagent.js), which passes the latest on to the server (govibrate.go):
// after the person's own input in the page, it's this device's to feel
// (go.js). A cancel (0, []) always is.
//
// As in browsers: false from another origin's frame (Chrome's rule), and a
// pattern of more than 99 entries cut to 99, each at most 10 s.
(() => {
    const MAX_ENTRIES = 99, MAX_MS = 10_000;
    const reader = () => {
        let w = window;
        try {
            while (w.parent !== w) {
                void w.parent.document;
                w = w.parent;
            }
        } catch { /* this origin's topmost */ }
        return w;
    };
    // An unsigned long, as WebIDL converts one (NaN and the infinities 0).
    const ulong = (v) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return 0;
        const t = Math.trunc(n) % 2 ** 32;
        return t < 0 ? t + 2 ** 32 : t;
    };
    function vibrate(pattern) {
        // (unsigned long or sequence<unsigned long>: an object that's
        // iterable is a sequence, its entries each an unsigned long.)
        let list;
        if (pattern !== null && typeof pattern === "object" && typeof pattern[Symbol.iterator] === "function") {
            list = [];
            for (const v of pattern) {
                if (typeof v === "symbol") throw new TypeError("Failed to execute 'vibrate' on 'Navigator': a vibration pattern entry can't be a Symbol.");
                list.push(ulong(v));
            }
        } else {
            if (typeof pattern === "symbol") throw new TypeError("Failed to execute 'vibrate' on 'Navigator': a vibration pattern can't be a Symbol.");
            list = [ulong(pattern)];
        }
        list = list.slice(0, MAX_ENTRIES).map((v) => Math.min(v, MAX_MS));
        // A frame of another origin than its top's: not felt (Chrome's
        // rule), and false.
        const top = reader();
        if (top.parent !== top) return false;
        if (document.visibilityState === "hidden") return false;
        try {
            top.document.dispatchEvent(new CustomEvent("__tabtop_vibrate", { detail: JSON.stringify(list) }));
        } catch {
            return false;
        }
        return true;
    }
    Object.defineProperty(Navigator.prototype, "vibrate", {
        value: { vibrate(pattern) { return vibrate(pattern); } }.vibrate,
        writable: true, enumerable: true, configurable: true,
    });
})();
