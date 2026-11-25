// The page's notifications, in its own world, for an engine that has
// Notification but shows nothing (Moli 1.1.27, measured: permission
// "default" on https, "denied" on http; requestPermission resolves
// "default", asking nobody; a notification made is never seen).
//
// Called with the sites' answers kept ({site: "allow" | "block"}: the
// server's, gonotify.go, registered anew as they change), so the page
// knows its permission from its first script, as a browser's does. Asked
// for (requestPermission), the agent asks the server, which asks the person
// (only soon after their own input in the page, as browsers ask); shown, it's
// passed on to the person's browser (go.js) with the site named; its show,
// click and close told back here as the page's events.
//
// Only a secure page's, and the top page's origin's (an embedded page of
// another origin's is denied, as browsers do now): told on the topmost
// document of this one's origin it can reach, whose agent reads it.
(answers => {
    const Native = globalThis.Notification;
    const reader = () => {
        let w = window;
        try {
            while (w.parent !== w) {
                void w.parent.document;  // (another origin's: throws)
                w = w.parent;
            }
        } catch { return null; }  // (an embedded page of another origin)
        return w.document;
    };
    const host = location.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    // The site's answer kept: its name's, or the longest naming a domain
    // over it (as the server keeps them, by site).
    function kept() {
        let best = "", answer = "";
        for (const [site, a] of Object.entries(answers ?? {})) {
            if ((host === site || host.endsWith("." + site)) && site.length > best.length) [best, answer] = [site, a];
        }
        return answer === "allow" ? "granted" : answer === "block" ? "denied" : "default";
    }
    let state = !isSecureContext || !reader() ? "denied" : kept();
    // Told when the agent asks (__tabtop_read, each time it reads
    // the page): one asked for, or shown, as the page loads, before the
    // agent's there to hear it, isn't lost.
    let outbox = [];
    const tell = (type, detail) => {
        listen();
        if (outbox.length < 64) outbox.push([type, JSON.stringify(detail)]);
    };
    const newID = () => Array.from(crypto.getRandomValues(new Uint32Array(2)), (n) => n.toString(36)).join("");

    // Answers, and the notifications' events, from the agent.
    const shown = new Map();  // id -> the page's Notification
    let asking = null;        // {id, promise, resolve}
    let listening = null;
    function listen() {
        const doc = reader();
        if (!doc || listening === doc) return;
        listening = doc;
        doc.addEventListener("__tabtop_read", () => {
            const now = outbox;
            outbox = [];
            for (const [type, detail] of now) {
                try { doc.dispatchEvent(new CustomEvent(type, { detail })); } catch { /* told nothing */ }
            }
        });
        doc.addEventListener("__tabtop_notify_event", (e) => {
            let d;
            try { d = JSON.parse(e.detail); } catch { return; }
            if (typeof d?.state === "string" && ["granted", "denied", "default"].includes(d.state)) {
                // An answer: to this page's ask, or said anew (Site controls).
                if (state !== d.state && isSecureContext) state = d.state;
                if (asking && (d.ask === asking.id || d.ask === undefined)) {
                    clearTimeout(asking.timer);
                    asking.resolve(state);
                    asking = null;
                }
                return;
            }
            const n = typeof d?.id === "string" && shown.get(d.id);
            if (!n || !["show", "click", "close", "error"].includes(d.type)) return;
            if (d.type === "close" || d.type === "error") shown.delete(d.id);
            n.dispatchEvent(new Event(d.type, { cancelable: d.type === "click" }));
        });
    }

    const handlers = new WeakMap();
    const handler = (proto, type) => Object.defineProperty(proto, "on" + type, {
        configurable: true, enumerable: true,
        get() { return handlers.get(this)?.[type] ?? null; },
        set(f) {
            const own = handlers.get(this) ?? {};
            handlers.set(this, own);
            if (own[type]) this.removeEventListener(type, own[type]);
            own[type] = typeof f === "function" ? f : null;
            if (own[type]) this.addEventListener(type, own[type]);
        },
    });
    const fields = new WeakMap();
    const str = (v, max) => (v === undefined || v === null ? "" : String(v)).slice(0, max);
    // A picture's address, as the page reads it back (absolute): an http(s)
    // one of 2,048 characters at most, or a data: picture of 1.5 MB.
    const pic = (v) => {
        if (v === undefined || v === null || v === "") return "";
        try {
            const u = new URL(String(v), document.baseURI);
            if (/^https?:$/.test(u.protocol)) return u.href.length <= 2048 ? u.href : "";
            return u.protocol === "data:" && u.href.length <= 1_500_000 ? u.href : "";
        } catch { return ""; }
    };

    class Notification extends EventTarget {
        constructor(title, options = {}) {
            if (!arguments.length) throw new TypeError("Failed to construct 'Notification': 1 argument required, but only 0 present.");
            super();
            options = options ?? {};
            if (Array.isArray(options.actions) && options.actions.length) {
                throw new TypeError("Failed to construct 'Notification': Actions are only supported for persistent notifications shown using ServiceWorkerRegistration.showNotification().");
            }
            const id = newID();
            const f = {
                id, title: str(title, 1000), body: str(options.body, 4000), tag: str(options.tag, 256),
                icon: pic(options.icon), image: pic(options.image), badge: pic(options.badge),
                dir: ["ltr", "rtl"].includes(options.dir) ? options.dir : "auto", lang: str(options.lang, 64),
                silent: options.silent === undefined || options.silent === null ? null : !!options.silent,
                requireInteraction: !!options.requireInteraction, renotify: !!options.renotify,
                data: options.data ?? null, timestamp: Number.isFinite(options.timestamp) ? options.timestamp : Date.now(),
                vibrate: [], actions: [],
            };
            fields.set(this, f);
            if (state !== "granted") {
                // Not allowed: an error, as a browser says it (after the page's
                // handlers are set).
                setTimeout(() => this.dispatchEvent(new Event("error")), 0);
                return;
            }
            listen();
            shown.set(id, this);
            // (Its pictures by address: the server fetches them, as the
            // page's are; the person's browser fetches nothing of the page's.)
            tell("__tabtop_notify", { id, title: f.title, body: f.body, tag: f.tag, silent: !!f.silent, requireInteraction: f.requireInteraction, renotify: f.renotify, dir: f.dir, lang: f.lang,
                icon: f.icon, image: f.image, badge: f.badge });
        }
        close() {
            const f = fields.get(this);
            if (!f || !shown.has(f.id)) return;
            tell("__tabtop_notify_close", { id: f.id });
        }
        static get permission() { return state; }
        static get maxActions() { return Native?.maxActions ?? 2; }
        static requestPermission(callback) {
            const done = (s) => {
                if (typeof callback === "function") {
                    try { callback(s); } catch (err) { setTimeout(() => { throw err; }); }
                }
                return s;
            };
            if (state !== "default") return Promise.resolve(state).then(done);
            if (!asking) {
                listen();
                const id = newID();
                let resolve;
                const promise = new Promise((r) => { resolve = r; });
                // (Not answered: the person didn't say, or the page went.)
                const timer = setTimeout(() => { if (asking?.id === id) { asking = null; resolve(state); } }, 120_000);
                asking = { id, promise, resolve, timer };
                tell("__tabtop_notify_ask", { id });
            }
            return asking.promise.then(done);
        }
        get [Symbol.toStringTag]() { return "Notification"; }
    }
    for (const name of ["title", "body", "tag", "icon", "image", "badge", "dir", "lang", "silent", "requireInteraction", "renotify", "data", "timestamp", "vibrate", "actions"]) {
        Object.defineProperty(Notification.prototype, name, { configurable: true, enumerable: true, get() { return fields.get(this)?.[name]; } });
    }
    for (const type of ["show", "click", "close", "error"]) handler(Notification.prototype, type);
    listen();  // (told its permission as it changes, from the start)
    Object.defineProperty(globalThis, "Notification", { value: Notification, writable: true, configurable: true, enumerable: false });

    // navigator.permissions says what Notification.permission does.
    const P = globalThis.Permissions?.prototype;
    const nativeQuery = P?.query;
    if (typeof nativeQuery === "function") {
        Object.defineProperty(P, "query", {
            configurable: true, writable: true, enumerable: true,
            value: { query(descriptor) {
                const result = nativeQuery.apply(this, arguments);
                if (descriptor?.name !== "notifications") return result;
                const said = () => (state === "granted" ? "granted" : state === "denied" ? "denied" : "prompt");
                return result.then((status) => {
                    try { Object.defineProperty(status, "state", { configurable: true, get: said }); } catch { /* as it is */ }
                    return status;
                }, () => ({ state: said(), name: "notifications", onchange: null, addEventListener() {}, removeEventListener() {} }));
            } }.query,
        });
    }
})
