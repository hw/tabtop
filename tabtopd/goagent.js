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
//
// Changes are watched with a MutationObserver here, and tabtopd asks for
// them often (polling: a CDP binding to signal by stops Moli following links
// within a page); ops are {o: "c", i, c} (a node's children, those
// already numbered as {i, r: 1}), {o: "a", i, n, v} (an attribute, v null if
// removed), {o: "t", i, v} (text), {o: "v", i, v} (a form field's value,
// changed by script).
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
            return JSON.stringify({ url: document.URL, base: document.baseURI, title: document.title, type: document.contentType, doc });
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
            if (!ops.length && !moved) return "";
            seq++;
            return JSON.stringify({ seq, url: document.URL, title: document.title, ops });
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

        w.__tabtop = { snapshot, changes, act };
    }
    return w.__tabtop.snapshot();
})()
