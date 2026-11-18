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
//   "__tabtop_io_sync" the agent, when it starts, asks for all of them again
//                      (a page observes as it loads, before the agent's there)
//   "__tabtop_io_entry" the agent hands back what the person's browser saw,
//                      {o, hit, ratio}, on the element; callbacks are called
//                      with entries later, from a task of their own, as
//                      browsers do
//
// It's the page's to see and change, like anything in its world: what it
// does with that only touches its own copy.
(() => {
    const SEND = "__tabtop_io", ENTRY = "__tabtop_io_entry", SYNC = "__tabtop_io_sync";
    const MAX_TARGETS = 5000;  // at once, all observers together
    const state = new WeakMap();  // observer -> its state
    const byId = new Map();       // observer's number -> observer
    let next = 0;
    let targets = 0;

    const tell = (el, what) => {
        try {
            el.dispatchEvent(new CustomEvent(SEND, { detail: JSON.stringify(what) }));
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
        if (s.element) tell(s.element, { op: "r", o: s.id });
        tell(target, { op: "+", o: s.id, m: s.margin, t: s.thresholds, r: !!s.element });
    }

    document.addEventListener(SYNC, () => {
        for (const o of byId.values()) {
            const s = state.get(o);
            for (const t of s.targets) announce(s, t);
        }
    }, true);

    document.addEventListener(ENTRY, (e) => {
        let d;
        try { d = JSON.parse(e.detail); } catch { return; }
        const o = byId.get(d?.o);
        const s = o && state.get(o);
        const target = e.target;
        if (!s || !s.targets.has(target)) return;
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

    for (const [name, value] of [["IntersectionObserver", IntersectionObserver], ["IntersectionObserverEntry", IntersectionObserverEntry]]) {
        Object.defineProperty(window, name, { value, writable: true, configurable: true, enumerable: false });
    }
})();
