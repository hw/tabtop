// The page's app badge (the Badging API: navigator.setAppBadge and
// clearAppBadge), in its own world, for an engine that has none (it isn't
// an installed app): what it sets is said to the agent (goagent.js), which
// passes the latest on to the server (gobadge.go), for the person's browser
// to show (go.js): on its tab's title, and its own app badge where it's
// one (an installed TabTop).
//
// As in browsers: a secure page's only; a count, an unsigned long long as
// WebIDL's [EnforceRange] reads one (not a number, or out of range: a
// TypeError), 0 clearing it, none a mark of its own. Set by a frame of the
// top page's origin, the page's; by another origin's, nothing (resolved,
// as a badge that can't be shown is).
(() => {
    if (!globalThis.isSecureContext || typeof Navigator !== "function") return;
    const reader = tabtopTop;  // (gopage-prelude.js)
    const count = (v, what) => {
        const n = Number(v);
        if (!Number.isFinite(n)) throw new TypeError(`Failed to execute '${what}' on 'Navigator': Value is not a finite number.`);
        const t = Math.trunc(n);
        if (t < 0 || t > Number.MAX_SAFE_INTEGER) throw new TypeError(`Failed to execute '${what}' on 'Navigator': Value is outside the 'unsigned long long' value range.`);
        return t;
    };
    const tell = (badge) => {
        const top = reader();
        if (top.parent !== top) return;  // (another origin's frame: not the page's)
        try {
            tabtopTell(top.document, "__tabtop_badge", badge);
        } catch { /* said nothing */ }
    };
    const define = (name, value) => Object.defineProperty(Navigator.prototype, name, { value, writable: true, enumerable: true, configurable: true });
    define("setAppBadge", { setAppBadge(contents) {
        let badge;
        try {
            badge = contents === undefined ? { flag: true } : { count: count(contents, "setAppBadge") };
        } catch (err) {
            return Promise.reject(err);
        }
        tell(badge);
        return Promise.resolve();
    } }.setAppBadge);
    define("clearAppBadge", { clearAppBadge() {
        tell({ count: 0 });
        return Promise.resolve();
    } }.clearAppBadge);
})();
