// The remote browser's IntersectionObserver, in the page's own world: tabtopd
// has the engine run this before any of a document's scripts (see
// gobrowser.go). Moli's own observer never reports anything visible; this
// one asks the person's browser, which shows the same elements, as they're
// laid out and scrolled there:
//
//   observe/unobserve  an event on the element, "__tabtop_io" (and on the
//                      observer's root, if it has one) with what's asked as
//                      JSON; the agent (goagent.js), in its isolated world,
//                      hears it and sends it on with the document's changes
//   {__tabtop: "io-sync"} the agent, when it starts, asks for all of them
//                      again, posted (a page observes as it loads, before the
//                      agent's there)
//   "__tabtop_io_entry" the agent hands back what the person's browser saw,
//                      {o, hit, ratio}, on the element; callbacks are called
//                      with entries later, from a task of their own, as
//                      browsers do
//
// Its ResizeObserver too, the same way (the engine's layout isn't the one
// shown: Moli's gives a scroll box 20 pixels where it's 670): what it
// observes is announced as above, with "s" (the box asked for), and the
// person's browser observes it there; what comes back, "z" (the element's
// sizes there), is what its callbacks are given, and what the page reads
// of that element's sizes (clientWidth and the like) from then on.
//
// It's the page's to see and change, like anything in its world: what it
// does with that only touches its own copy.
(() => {
    const SEND = "__tabtop_io", ENTRY = "__tabtop_io_entry";
    const MAX_TARGETS = 5000;  // at once, all observers together
    const state = new WeakMap();  // observer -> its state
    const byId = new Map();       // observer's number -> observer
    let next = 0;
    let targets = 0;

    const tell = (el, what) => {
        try {
            el.dispatchEvent(new CustomEvent(SEND, { composed: true, detail: JSON.stringify(what) }));
        } catch { /* nothing to tell it on */ }
    };

    function thresholds(t) {
        const list = (t === undefined ? [0] : Array.isArray(t) ? t : [t]).map(Number);
        if (list.some((x) => !(x >= 0 && x <= 1))) throw new RangeError("Threshold values must be numbers between 0 and 1.");
        return [...new Set(list)].sort((a, b) => a - b).slice(0, 101);
    }
    function margin(m) {
        const parts = (m === undefined ? "0px" : String(m)).trim().split(/\s+/);
        if (parts.length > 4 || !parts.every((p) => p === "0" || /^-?(\d+(\.\d+)?|\.\d+)(px|%)$/.test(p))) {
            throw new SyntaxError("rootMargin must be specified in pixels or percent.");
        }
        const px = parts.map((p) => (p === "0" ? "0px" : p));
        const [top, right = top, bottom = top, left = right] = px;
        return `${top} ${right} ${bottom} ${left}`;
    }

    const rectOf = (x, y, w, h) => (typeof DOMRectReadOnly === "function" ? new DOMRectReadOnly(x, y, w, h) : { x, y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h });

    class IntersectionObserverEntry {
        constructor(init) {
            for (const k of ["time", "rootBounds", "boundingClientRect", "intersectionRect", "isIntersecting", "intersectionRatio", "target"]) {
                Object.defineProperty(this, k, { value: init[k], enumerable: true });
            }
        }
    }
    // As browsers have it, for pages that test for the feature this way.
    Object.defineProperty(IntersectionObserverEntry.prototype, "intersectionRatio", { get() { return 0; }, configurable: true });
    Object.defineProperty(IntersectionObserverEntry.prototype, "isIntersecting", { get() { return false; }, configurable: true });

    class IntersectionObserver {
        constructor(callback, options = {}) {
            if (typeof callback !== "function") throw new TypeError("IntersectionObserver needs a callback function.");
            const root = options?.root ?? null;
            if (root !== null && !(root instanceof Element) && !(root instanceof Document)) {
                throw new TypeError("root must be an Element or a Document.");
            }
            const s = {
                id: ++next, callback, root, element: root instanceof Element ? root : null,
                margin: margin(options?.rootMargin), thresholds: thresholds(options?.threshold),
                targets: new Set(), queue: [], due: false,
            };
            state.set(this, s);
            byId.set(s.id, this);
        }
        get root() { return state.get(this)?.root ?? null; }
        get rootMargin() { return state.get(this)?.margin ?? "0px 0px 0px 0px"; }
        get thresholds() { return [...(state.get(this)?.thresholds ?? [0])]; }
        observe(target) {
            const s = state.get(this);
            if (!(target instanceof Element)) throw new TypeError("observe needs an Element.");
            if (!s || s.targets.has(target) || targets >= MAX_TARGETS) return;
            s.targets.add(target);
            targets++;
            announce(s, target);
        }
        unobserve(target) {
            const s = state.get(this);
            if (s?.targets.delete(target)) {
                targets--;
                tell(target, { op: "-", o: s.id });
            }
        }
        disconnect() {
            const s = state.get(this);
            if (!s) return;
            for (const t of s.targets) tell(t, { op: "-", o: s.id });
            targets -= s.targets.size;
            s.targets.clear();
            s.queue = [];
        }
        takeRecords() {
            const s = state.get(this);
            if (!s) return [];
            const q = s.queue;
            s.queue = [];
            return q;
        }
    }

    function announce(s, target) {
        if (s.box) {
            tell(target, { op: "+", o: s.id, s: s.box });
            return;
        }
        if (s.element) tell(s.element, { op: "r", o: s.id });
        tell(target, { op: "+", o: s.id, m: s.margin, t: s.thresholds, r: !!s.element });
    }

    // --- Sizes -------------------------------------------------------------

    const sizes = new WeakMap();  // element -> its sizes as shown, [cw, ch, sw, sh, ow, oh, content w, content h]
    const SIZE_OF = [["clientWidth", 0], ["clientHeight", 1], ["scrollWidth", 2], ["scrollHeight", 3]];
    const OFFSET_OF = [["offsetWidth", 4], ["offsetHeight", 5]];
    for (const [proto, list] of [[Element.prototype, SIZE_OF], [HTMLElement.prototype, OFFSET_OF]]) {
        for (const [name, n] of list) {
            const was = Object.getOwnPropertyDescriptor(proto, name);
            if (!was?.get) continue;
            const get = was.get;
            Object.defineProperty(proto, name, {
                ...was,
                get: { [name]() { const z = sizes.get(this); return z ? z[n] : get.call(this); } }[name],
            });
        }
    }
    // Where an element is scrolled, as the person scrolled it there (the
    // agent says, "__tabtop_scrolled", {x, y}, before its scroll event):
    // the engine's own may not go there (Moli's stops where its layout
    // ends). The page scrolling it itself is where it reads it after, and
    // is shown: said to the agent ("__tabtop_scroll": {into: [block,
    // inline]}, or {x, y} where it has the sizes as shown), the person's
    // browser scrolls its copy so, and where that ends up comes back as
    // the person's scrolling does.
    const scrolls = new WeakMap();  // element -> [left, top]
    const native = {};
    for (const name of ["scrollLeft", "scrollTop"]) native[name] = Object.getOwnPropertyDescriptor(Element.prototype, name);
    const nativeOf = (el, name) => Number(native[name]?.get ? native[name].get.call(el) : el[name]) || 0;
    const scrollOf = (el) => scrolls.get(el) ?? [nativeOf(el, "scrollLeft"), nativeOf(el, "scrollTop")];
    const scrolledTo = (el, x, y) => {
        // Within where it can go, as shown, if that's known.
        const z = sizes.get(el), most = (v, n) => (z ? Math.min(v, Math.max(0, z[n + 2] - z[n])) : v);
        const at = [most(Math.max(0, Number(x) || 0), 0), most(Math.max(0, Number(y) || 0), 1)];
        // Not the document's own (the window's): the person's scrolling of
        // that is the engine's own, and read from it.
        if (el === document.documentElement || el === document.body) return;
        scrolls.set(el, at);
        // Shown only where the page's numbers are the person's browser's
        // (it reads this one's sizes from there): a place worked out from
        // the engine's own layout may be nowhere near it there.
        if (!z) return;
        try {
            el.dispatchEvent(new CustomEvent("__tabtop_scroll", { composed: true, detail: JSON.stringify({ x: at[0], y: at[1] }) }));
        } catch { /* nothing to tell it on */ }
    };
    for (const [name, n] of [["scrollLeft", 0], ["scrollTop", 1]]) {
        const was = native[name];
        if (!was?.get || !was.set) continue;
        const { get, set } = was;
        Object.defineProperty(Element.prototype, name, {
            ...was,
            get: { [name]() { const at = scrolls.get(this); return at ? at[n] : get.call(this); } }[name],
            set: { [name](v) {
                set.call(this, v);
                try {
                    const at = [...scrollOf(this)];
                    if (at[n] === (Number(v) || 0)) return;  // where it is already: nothing to do
                    at[n] = v;
                    scrolledTo(this, ...at);
                } catch { /* as set */ }
            } }[name],
        });
    }
    const wrap = (name, after) => {
        const was = Element.prototype[name];
        if (typeof was !== "function") return;
        Object.defineProperty(Element.prototype, name, {
            value: { [name](...args) {
                const r = was.apply(this, args);
                try { after(this, args); } catch { /* the page's call is what counts */ }
                return r;
            } }[name],
            writable: true, configurable: true, enumerable: false,
        });
    };
    const to = (el, args, by) => {
        const [cx, cy] = scrollOf(el);
        const [x0, y0] = by ? [cx, cy] : [0, 0];
        let x, y;
        if (args[0] !== null && typeof args[0] === "object") {
            const o = args[0];
            x = o.left === undefined ? cx : x0 + Number(o.left);
            y = o.top === undefined ? cy : y0 + Number(o.top);
        } else if (args.length >= 2) {
            x = x0 + Number(args[0]);
            y = y0 + Number(args[1]);
        } else {
            return;
        }
        if ((Number(x) || 0) !== cx || (Number(y) || 0) !== cy) scrolledTo(el, x, y);  // not where it is already
    };
    wrap("scrollTo", (el, args) => to(el, args, false));
    wrap("scroll", (el, args) => to(el, args, false));
    wrap("scrollBy", (el, args) => to(el, args, true));
    wrap("scrollIntoView", (el, args) => {
        const a = args[0];
        const block = a === false ? "end" : typeof a === "object" && a ? String(a.block ?? "start") : "start";
        const inline = typeof a === "object" && a ? String(a.inline ?? "nearest") : "nearest";
        try {
            el.dispatchEvent(new CustomEvent("__tabtop_scroll", { composed: true, detail: JSON.stringify({ into: [block, inline] }) }));
        } catch { /* nothing to tell it on */ }
    });
    document.addEventListener("__tabtop_scrolled", (e) => {
        let d;
        try { d = JSON.parse(e.detail); } catch { return; }
        const x = Number(d?.x), y = Number(d?.y);
        const el = (e.composedPath?.()[0] ?? e.target);  // (in a shadow root too: the agent's event is composed)
        if (el instanceof Element && x >= 0 && y >= 0 && x < 1e7 && y < 1e7) scrolls.set(el, [x, y]);
    }, true);
    const sizeOf = (inline, block) => Object.freeze([Object.freeze({ inlineSize: inline, blockSize: block })]);
    class ResizeObserverEntry {
        constructor(target, z) {
            const dpr = devicePixelRatio || 1;
            const init = {
                target, contentRect: rectOf(0, 0, z[6], z[7]),
                contentBoxSize: sizeOf(z[6], z[7]), borderBoxSize: sizeOf(z[4], z[5]),
                devicePixelContentBoxSize: sizeOf(Math.round(z[6] * dpr), Math.round(z[7] * dpr)),
            };
            for (const k of Object.keys(init)) Object.defineProperty(this, k, { value: init[k], enumerable: true });
        }
    }
    class ResizeObserver {
        constructor(callback) {
            if (typeof callback !== "function") throw new TypeError("ResizeObserver needs a callback function.");
            const s = { id: ++next, callback, box: true, targets: new Set(), boxOf: new WeakMap(), last: new WeakMap(), queue: [], due: false };
            state.set(this, s);
            byId.set(s.id, this);
        }
        observe(target, options) {
            const s = state.get(this);
            if (!(target instanceof Element)) throw new TypeError("observe needs an Element.");
            const box = options?.box ?? "content-box";
            if (!["content-box", "border-box", "device-pixel-content-box"].includes(box)) throw new TypeError("box must be a ResizeObserverBoxOptions.");
            if (!s || s.targets.has(target) || targets >= MAX_TARGETS) return;
            s.targets.add(target);
            s.boxOf.set(target, box);
            targets++;
            announce({ ...s, box }, target);
        }
        unobserve(target) {
            const s = state.get(this);
            if (s?.targets.delete(target)) {
                targets--;
                s.last.delete(target);
                tell(target, { op: "-", o: s.id });
            }
        }
        disconnect() {
            const s = state.get(this);
            if (!s) return;
            for (const t of s.targets) tell(t, { op: "-", o: s.id });
            targets -= s.targets.size;
            s.targets.clear();
            s.last = new WeakMap();
            s.queue = [];
        }
    }
    function resized(o, s, target, z) {
        sizes.set(target, z);
        // A callback as a browser's: when the box it watches has a new
        // size (the first time, any). And, at most once a second, when only
        // what's in it has (its scroll size): a page reading that as it
        // adds to it (YouTube's Shorts, a reel's height from it as reels
        // are added) read it before it got here, and this has it read it
        // again; a browser's had it then.
        const box = `${z[4]}x${z[5]}:${z[6]}x${z[7]}`, all = z.join();
        const was = s.last.get(target);
        if (was?.box === box && (was.all === all || performance.now() - was.at < 1000)) return;
        s.last.set(target, { box, all, at: was?.box === box ? performance.now() : was?.at ?? -Infinity });
        s.queue = s.queue.filter((e) => e.target !== target);
        s.queue.push(new ResizeObserverEntry(target, z));
        if (s.due) return;
        s.due = true;
        setTimeout(() => {
            s.due = false;
            const q = s.queue;
            s.queue = [];
            if (q.length && s.targets.size) s.callback.call(o, q, o);
        }, 0);
    }

    // The agent, once there, asks for all of them again (a page observes as
    // it loads, before the agent's there): a message (its source is the
    // agent's world's view of this window, not this one; the page posting it
    // only has its own observed again, which is harmless).
    window.addEventListener("message", (e) => {
        if (e.data?.__tabtop !== "io-sync") return;
        for (const o of byId.values()) {
            const s = state.get(o);
            for (const t of s.targets) announce(s.box ? { ...s, box: s.boxOf.get(t) ?? "content-box" } : s, t);
        }
    });

    document.addEventListener(ENTRY, (e) => {
        let d;
        try { d = JSON.parse(e.detail); } catch { return; }
        const o = byId.get(d?.o);
        const s = o && state.get(o);
        const target = (e.composedPath?.()[0] ?? e.target);  // (in a shadow root too)
        if (!s || !s.targets.has(target)) return;
        if (s.box) {
            const z = Array.isArray(d.z) && d.z.length === 8 && d.z.every((v) => Number.isFinite(v) && v >= 0) ? d.z : null;
            if (z) resized(o, s, target, z);
            return;
        }
        // Places as the person's browser has them (pages go by them: only
        // what has a visible area, say); the engine's own if not sent.
        const given = (r) => (Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) ? rectOf(...r) : null);
        const box = given(d.b) ?? target.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, Number(d.ratio) || 0));
        s.queue.push(new IntersectionObserverEntry({
            time: performance.now(),
            rootBounds: given(d.rb) ?? (s.element ? s.element.getBoundingClientRect() : rectOf(0, 0, innerWidth, innerHeight)),
            boundingClientRect: box,
            intersectionRect: given(d.r) ?? (d.hit ? box : rectOf(0, 0, 0, 0)),
            isIntersecting: !!d.hit,
            intersectionRatio: ratio,
            target,
        }));
        if (s.due) return;
        s.due = true;
        setTimeout(() => {
            s.due = false;
            const q = s.queue;
            s.queue = [];
            if (q.length) s.callback.call(o, q, o);
        }, 0);
    }, true);

    for (const [name, value] of [["IntersectionObserver", IntersectionObserver], ["IntersectionObserverEntry", IntersectionObserverEntry],
        ["ResizeObserver", ResizeObserver], ["ResizeObserverEntry", ResizeObserverEntry]]) {
        Object.defineProperty(window, name, { value, writable: true, configurable: true, enumerable: false });
    }
})();
