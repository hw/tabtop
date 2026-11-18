// The remote browser's agent in the page engine (see goroute.go). tabtopd
// evaluates this in an isolated world of each document: one the page's own
// scripts can't see or change, sharing only the document's nodes with them.
// It installs globalThis.__tabtop once per world and returns its snapshot:
//
//   __tabtop.snapshot()  the document as JSON: {url, base, title, type, doc},
//                        every node numbered (doc's {i, t, n, v, a, c})
//   __tabtop.changes()   what's changed since, as JSON: {seq, url, title, ops},
//                        or "" if nothing; numbered in sequence from the
//                        snapshot, so a missed batch shows
//   __tabtop.act(json)   does what the person did, in the page: a click,
//                        typing, a key, a form sent
//   __tabtop.into(id)    scrolls an element into view (only as far as needed),
//                        for real input at it: "ok", or "gone"
//   __tabtop.point(json) where in the window real input at {id, fx, fy}
//                        (fractions across and down the element) lands on
//                        it, as JSON {x, y}, or "" if it can't (not laid
//                        out, or covered here): run after layout's refreshed
//   __tabtop.keyTo(id)   gives the element keys go to the focus, if it isn't
//                        the document itself (the page's own focus stays):
//                        "field" if it's a one-line field, "ok", or "gone"
//   __tabtop.io(json)    what the person's browser saw of elements the page
//                        observes, [{o, i, hit, ratio}], handed to the page
//                        (see goobserve.js)
//
// Changes are watched with a MutationObserver here, and tabtopd asks for
// them often (polling: a CDP binding to signal by stops Moli following links
// within a page); ops are {o: "c", i, c} (a node's children, those
// already numbered as {i, r: 1}), {o: "a", i, n, v} (an attribute, v null if
// removed), {o: "t", i, v} (text), {o: "v", i, v} (a form field's value,
// changed by script). Snapshots and batches carry the page's
// IntersectionObserver targets too, io: [{op: "+", o, i, m, t, r}] (its
// observer's number, the element's, rootMargin, thresholds, root element
// or 0) and {op: "-", o, i}; a snapshot, all of them.
(() => {
    const w = globalThis;
    if (!w.__tabtop) {
        const ids = new WeakMap();   // node -> id
        const byId = new Map();      // id -> WeakRef(node)
        let next = 1;
        let seq = 0;
        const dropped = new Set(["script", "noscript", "template"]);
        let parents = new Set(), attrs = new Map(), texts = new Set();
        const watched = new Map();   // fields acted on -> the value last reported
        let lastURL = "";

        // The page's observed elements, held by element until it's one the
        // shown copy has (numbered: numbering one would make later batches
        // name a node never sent).
        const ioTargets = new Map();  // element -> Map(observer -> {m, t, root})
        const ioRoots = new Map();    // observer -> its root element
        let ioSent = new Set();       // "o:i" the shown copy observes
        let ioOut = [];               // what's to go with the next batch
        const ioLast = new Map();     // "o:i" -> what was last handed over
        document.addEventListener("__tabtop_io", (e) => {
            let d;
            try { d = JSON.parse(e.detail); } catch { return; }
            const el = e.target;
            if (!d || !Number.isSafeInteger(d.o) || !(el instanceof Element)) return;
            if (d.op === "r") {
                ioRoots.set(d.o, el);
            } else if (d.op === "+") {
                if (!ioTargets.has(el)) {
                    if (ioTargets.size >= 5000) return;
                    ioTargets.set(el, new Map());
                }
                ioTargets.get(el).set(d.o, { m: String(d.m), t: Array.isArray(d.t) ? d.t : [0], root: d.r ? ioRoots.get(d.o) ?? null : null });
            } else if (d.op === "-") {
                ioTargets.get(el)?.delete(d.o);
                if (ioTargets.get(el)?.size === 0) ioTargets.delete(el);
                if (known(el)) {
                    const key = d.o + ":" + ids.get(el);
                    ioLast.delete(key);
                    if (ioSent.delete(key)) ioOut.push({ op: "-", o: d.o, i: ids.get(el) });
                }
            }
        }, true);
        // ioNew adds to ioOut what's observed of elements now shown.
        function ioNew() {
            for (const [el, regs] of ioTargets) {
                if (!el.isConnected || !known(el)) continue;
                const i = ids.get(el);
                for (const [o, r] of regs) {
                    const key = o + ":" + i;
                    if (ioSent.has(key) || (r.root && !(r.root.isConnected && known(r.root)))) continue;
                    ioSent.add(key);
                    ioOut.push({ op: "+", o, i, m: r.m, t: r.t, r: r.root ? ids.get(r.root) : 0 });
                }
            }
        }
        function into(id) {
            const el = node(id);
            if (!el) return "gone";
            watch(el);  // as it was: what the input changes is sent
            if (el.nodeType === 1) el.scrollIntoView({ block: "nearest", inline: "nearest" });
            return "ok";
        }
        function point(json) {
            const a = JSON.parse(json);
            const el = node(a.id);
            if (!el || el.nodeType !== 1) return "";
            const r = el.getBoundingClientRect();
            if (!(r.width > 0 && r.height > 0)) return "";
            const on = (x, y) => {
                if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
                const hit = document.elementFromPoint(x, y);
                return !!hit && (hit === el || el.contains(hit));
            };
            const f = (v) => Math.min(1, Math.max(0, Number(v) || 0));
            // Where the person pointed within it, kept just inside it; or its
            // middle, if something else is there.
            for (const [fx, fy] of [[f(a.fx), f(a.fy)], [0.5, 0.5]]) {
                const x = r.left + Math.min(r.width - 0.5, Math.max(0.5, fx * r.width));
                const y = r.top + Math.min(r.height - 0.5, Math.max(0.5, fy * r.height));
                if (on(x, y)) return JSON.stringify({ x, y });
            }
            return "";
        }
        function keyTo(id) {
            const el = node(id);
            if (!el) return "gone";
            watch(el);
            if (el.nodeType === 1 && el !== document.body && el !== document.documentElement && document.activeElement !== el) el.focus?.();
            // A one-line field: Enter there sends its form (given as typed).
            const field = el.localName === "input" && !/^(button|submit|reset|checkbox|radio|file|image|range|color)$/i.test(el.type);
            return field ? "field" : "ok";
        }
        function io(json) {
            let list;
            try { list = JSON.parse(json); } catch { return "bad"; }
            for (const e of Array.isArray(list) ? list : []) {
                const el = node(e?.i);
                const key = e?.o + ":" + e?.i;
                if (!el || !ioSent.has(key)) continue;
                const now = (e.hit ? "1" : "0") + ":" + Number(e.ratio).toFixed(3);
                if (ioLast.get(key) === now) continue;  // as it was: not again
                ioLast.set(key, now);
                el.dispatchEvent(new CustomEvent("__tabtop_io_entry", { detail: JSON.stringify({ o: e.o, hit: !!e.hit, ratio: Number(e.ratio) || 0, b: e.b, r: e.r, rb: e.rb }) }));
            }
            return "ok";
        }

        const known = (n) => ids.has(n);
        function id(n) {
            let i = ids.get(n);
            if (!i) {
                i = next++;
                ids.set(n, i);
                byId.set(i, new WeakRef(n));
            }
            return i;
        }
        function node(i) {
            const n = byId.get(i)?.deref();
            return n && n.isConnected ? n : null;
        }

        let count = 0;
        function ser(n, depth) {
            if (++count > 400000) throw new Error("too many nodes");
            if (n.nodeType === 3 || n.nodeType === 4) return { i: id(n), t: 3, v: n.data };
            if (n.nodeType === 9 || n.nodeType === 11) return { i: id(n), t: n.nodeType, c: kids(n, depth) };
            if (n.nodeType !== 1) return null;
            const name = n.localName;
            if (dropped.has(name.toLowerCase())) return null;
            const a = [];
            for (const at of n.attributes) if (!/^on/i.test(at.name)) a.push(at.name, at.value);
            const set = (k, v) => {
                for (let j = 0; j < a.length; j += 2) if (a[j] === k) { a.splice(j, 2); break; }
                if (v !== null) a.push(k, v);
            };
            if (name === "input") {
                if (/^(checkbox|radio)$/i.test(n.type)) set("checked", n.checked ? "" : null);
                else if (!/^(file|image|submit|reset|button)$/i.test(n.type)) set("value", n.value);
            } else if (name === "option") {
                set("selected", n.selected ? "" : null);
            }
            const out = { i: id(n), t: 1, n: name };
            if (a.length) out.a = a;
            const c = name === "textarea" ? [{ i: id(n.firstChild || n), t: 3, v: n.value }] : depth < 600 ? kids(n, depth) : [];
            if (c.length) out.c = c;
            return out;
        }
        function kids(n, depth) {
            const c = [];
            for (let k = n.firstChild; k; k = k.nextSibling) {
                const s = ser(k, depth + 1);
                if (s) c.push(s);
            }
            return c;
        }

        const observer = new MutationObserver((records) => {
            for (const r of records) {
                if (r.type === "childList") parents.add(r.target);
                else if (r.type === "characterData") texts.add(r.target);
                else if (r.type === "attributes") {
                    if (!attrs.has(r.target)) attrs.set(r.target, new Set());
                    attrs.get(r.target).add(r.attributeName);
                }
            }
        });

        function snapshot() {
            count = 0;
            observer.disconnect();
            observer.takeRecords();
            parents = new Set(); attrs = new Map(); texts = new Set();
            seq = 0;
            const doc = ser(document, 0);
            observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
            lastURL = document.URL;
            // All of what's observed, for the copy built from this.
            ioSent = new Set();
            ioOut = [];
            ioLast.clear();
            ioNew();
            const ioAll = ioOut;
            ioOut = [];
            return JSON.stringify({ url: document.URL, base: document.baseURI, title: document.title, type: document.contentType, doc, io: ioAll });
        }

        function changes() {
            for (const r of observer.takeRecords()) {
                if (r.type === "childList") parents.add(r.target);
                else if (r.type === "characterData") texts.add(r.target);
                else if (r.type === "attributes") {
                    if (!attrs.has(r.target)) attrs.set(r.target, new Set());
                    attrs.get(r.target).add(r.attributeName);
                }
            }
            const ops = [];
            count = 0;
            // Only nodes numbered before now: new ones come whole, inside
            // their parent's children.
            const before = next;
            const old = (n) => known(n) && ids.get(n) < before;
            for (const p of parents) {
                if (!p.isConnected || !old(p) || p.nodeType === 1 && dropped.has(p.localName.toLowerCase())) continue;
                const c = [];
                for (let k = p.firstChild; k; k = k.nextSibling) {
                    if (old(k)) {
                        if (k.nodeType !== 1 || !dropped.has(k.localName.toLowerCase())) c.push({ i: ids.get(k), r: 1 });
                    } else {
                        const s = ser(k, 0);
                        if (s) c.push(s);
                    }
                }
                ops.push({ o: "c", i: ids.get(p), c });
            }
            for (const [n, names] of attrs) {
                if (!n.isConnected || !old(n)) continue;
                for (const name of names) {
                    if (/^on/i.test(name)) continue;
                    ops.push({ o: "a", i: ids.get(n), n: name, v: n.getAttribute(name) });
                }
            }
            for (const n of texts) {
                if (n.isConnected && old(n)) ops.push({ o: "t", i: ids.get(n), v: n.data });
            }
            for (const [n, last] of watched) {
                if (!n.isConnected) { watched.delete(n); continue; }
                const v = n.type === "checkbox" || n.type === "radio" ? String(n.checked) : n.value;
                if (v !== last) {
                    watched.set(n, v);
                    ops.push({ o: "v", i: ids.get(n), v });
                }
            }
            parents = new Set(); attrs = new Map(); texts = new Set();
            const moved = document.URL !== lastURL;
            lastURL = document.URL;
            ioNew();
            const ioNow = ioOut;
            ioOut = [];
            if (!ops.length && !moved && !ioNow.length) return "";
            seq++;
            return JSON.stringify({ seq, url: document.URL, title: document.title, ops, io: ioNow });
        }

        function watch(el) {
            if (el.localName === "input" || el.localName === "textarea" || el.localName === "select") {
                watched.set(el, el.type === "checkbox" || el.type === "radio" ? String(el.checked) : el.value);
                if (watched.size > 32) watched.delete(watched.keys().next().value);
            }
        }

        function setValue(el, v) {
            if (typeof v !== "string") return;
            const proto = el.localName === "textarea" ? HTMLTextAreaElement.prototype
                : el.localName === "select" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
            // The setter itself, as a framework that wraps value expects.
            Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, v);
        }

        function act(json) {
            const a = JSON.parse(json);
            const el = node(a.id);
            if (!el) return "gone";
            switch (a.kind) {
                case "click": {
                    // A new window here is this tab (see goroute.go).
                    const link = el.closest?.("a[target], area[target]");
                    if (link && link.target && link.target !== "_self") link.removeAttribute("target");
                    watch(el);  // as it was: what the click changes is sent
                    el.focus?.();
                    // An SVG element (a button's icon, say) has no click():
                    // a click event it sends up to its button all the same.
                    if (typeof el.click === "function") el.click();
                    else el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, view: window }));
                    return "ok";
                }
                case "input":
                    el.focus?.();
                    setValue(el, a.value);
                    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
                    watch(el);
                    watched.set(el, a.value);
                    return "ok";
                case "change":
                    if (el.type === "checkbox" || el.type === "radio") el.checked = !!a.checked;
                    else setValue(el, a.value);
                    el.dispatchEvent(new Event("input", { bubbles: true }));
                    el.dispatchEvent(new Event("change", { bubbles: true }));
                    watch(el);
                    return "ok";
                case "key": {
                    const init = { key: String(a.key || ""), code: String(a.code || ""), bubbles: true, cancelable: true,
                        shiftKey: !!a.shift, ctrlKey: !!a.ctrl, altKey: !!a.alt, metaKey: !!a.meta };
                    watch(el);  // as it was: what the key changes (a field cleared once sent) is sent
                    el.focus?.();
                    const go = el.dispatchEvent(new KeyboardEvent("keydown", init));
                    if (go && init.key.length === 1) el.dispatchEvent(new KeyboardEvent("keypress", init));
                    el.dispatchEvent(new KeyboardEvent("keyup", init));
                    // Enter in a field sends its form, as browsers do.
                    if (go && init.key === "Enter" && el.form && el.localName === "input"
                        && !/^(button|submit|reset|checkbox|radio|file|image)$/i.test(el.type)) {
                        el.form.requestSubmit();
                    }
                    return "ok";
                }
                case "submit": {
                    const form = el.localName === "form" ? el : el.form;
                    const by = a.submitter ? node(a.submitter) : null;
                    if (!form) return "gone";
                    form.requestSubmit(by && by.form === form ? by : undefined);
                    return "ok";
                }
                case "focus":
                    el.focus?.();
                    return "ok";
            }
            return "unknown";
        }

        w.__tabtop = { snapshot, changes, act, io, into, point, keyTo };
        // What the page observed before this world was made (as it loaded).
        document.dispatchEvent(new CustomEvent("__tabtop_io_sync"));
    }
    return w.__tabtop.snapshot();
})()
