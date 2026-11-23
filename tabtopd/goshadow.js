// Shadow roots for /go's copy (goagent.js reads them, as their host's
// own): run in the page's world before its scripts.
//
// A closed shadow root (attachShadow({mode: "closed"})) can't be read but
// by what made it: it's made open, so the agent's world (whose own
// prototypes these aren't) reads it as any other, and the page's world is
// told it's closed as it asked: its host's shadowRoot is null, its mode
// "closed". (What it can still tell: an event's composedPath() from
// outside has the nodes in it; a slot in it is an element's assignedSlot.)
//
// Each shadow root attached to an element in the document says so (the
// event __tabtop_shadow, from the root itself, through every root it's in):
// the agent is given it so (Moli's world for the agent keeps an element's
// shadowRoot as it first read it), for a host it's sent already to be sent
// its root. (A host not yet in the document is sent with it, its root and
// all, once it's put there.) A root made from the page's HTML (declarative:
// <template shadowrootmode>) is read by the agent with its host.
//
// Adopted stylesheets (constructed ones, which no node holds) are read here
// too, as the agent's world doesn't see them: each root's (or the
// document's) rules, as text, are told in the event __tabtop_adopted from
// its host (or the document), a moment after they're adopted or changed,
// and all again when the agent asks ({__tabtop: "adopted"}, a message).
// (Told so, not as asked by an event: told within the agent's own event,
// or from a root, Moli has its world lose the host's shadowRoot.)
//
// It's the page's to see and change, like anything in its world: what it
// says only touches its own copy's styles, which the copy processes as it
// does any.
(() => {
    const proto = globalThis.Element?.prototype, Root = globalThis.ShadowRoot;
    const attach = proto?.attachShadow;
    if (typeof attach !== "function" || !Root) return;
    const closed = new WeakSet();
    const own = (o, name) => Object.getOwnPropertyDescriptor(o, name);
    const rootOf = own(proto, "shadowRoot")?.get, modeOf = own(Root.prototype, "mode")?.get;
    const hostOf = own(Root.prototype, "host")?.get, connected = own(Node.prototype, "isConnected")?.get;
    const Ev = CustomEvent, dispatch = EventTarget.prototype.dispatchEvent;
    const say = (target, type, detail) => {
        try { Reflect.apply(dispatch, target, [new Ev(type, { bubbles: true, composed: true, detail })]); } catch { /* not said */ }
    };
    const known = new Set();  // the roots attached (or asked about), whose adopted stylesheets are looked at
    Object.defineProperty(proto, "attachShadow", { configurable: true, writable: true, value: {
        attachShadow(init) {
            const shut = init !== null && typeof init === "object" && init.mode === "closed";
            const root = Reflect.apply(attach, this, [shut ? { ...init, mode: "open" } : init]);
            if (shut) closed.add(root);
            known.add(root);
            // (Said once what's making it is done: from the root while its
            // host's being made a custom element, Moli undoes that.)
            const host = this;
            queueMicrotask(() => { if (connected?.call(host)) say(root, "__tabtop_shadow", null); });
            return root;
        },
    }.attachShadow });
    if (rootOf) Object.defineProperty(proto, "shadowRoot", { configurable: true, enumerable: true, get: {
        get shadowRoot() {
            const root = Reflect.apply(rootOf, this, []);
            return root && closed.has(root) ? null : root;
        },
    }.__lookupGetter__("shadowRoot") });
    if (modeOf) Object.defineProperty(Root.prototype, "mode", { configurable: true, enumerable: true, get: {
        get mode() {
            return closed.has(this) ? "closed" : Reflect.apply(modeOf, this, []);
        },
    }.__lookupGetter__("mode") });

    // Adopted stylesheets: their rules as text (each sheet's kept while
    // it's unchanged: a version each, counted by what changes it), and what
    // was last told of each root's.
    const texts = new WeakMap(), told = new WeakMap(), sheetIDs = new WeakMap(), versions = new WeakMap();
    let nextSheet = 1;
    const sheetsOf = (root) => { try { return root.adoptedStyleSheets ?? []; } catch { return []; } };
    function print(root) {
        let p = "";
        for (const sheet of sheetsOf(root)) {
            if (!sheetIDs.has(sheet)) sheetIDs.set(sheet, nextSheet++);
            let count = 0;
            try { count = sheet.cssRules.length; } catch { /* none */ }
            p += sheetIDs.get(sheet) + "." + (versions.get(sheet) ?? 0) + "/" + count + " ";
        }
        return p;
    }
    function text(root) {
        let out = "";
        for (const sheet of sheetsOf(root)) {
            let rules;
            try { rules = sheet.cssRules; } catch { continue; }
            const v = (versions.get(sheet) ?? 0) + "/" + rules.length, was = texts.get(sheet);
            let t = was?.v === v ? was.text : null;
            if (t === null) {
                t = "";
                for (const rule of rules) {
                    t += rule.cssText + "\n";
                    if (t.length > 1 << 20) break;
                }
                texts.set(sheet, { v, text: t });
            }
            out += t;
            if (out.length > 1 << 20) break;
        }
        return out;
    }
    const dirty = new Set();
    let soon = false;
    function later(root) {
        dirty.add(root);
        if (!soon) {
            soon = true;
            setTimeout(flush, 0);
        }
    }
    function flush() {
        soon = false;
        for (const root of dirty) {
            const host = root === document ? document : hostOf?.call(root);
            if (!host || host !== document && !connected?.call(host)) { known.delete(root); continue; }
            const p = print(root);
            if (told.get(root) === p) continue;
            told.set(root, p);
            say(host, "__tabtop_adopted", text(root));
        }
        dirty.clear();
    }
    // What adopts or changes them: a root's (or the document's) list set,
    // a sheet's rules replaced, put in or taken out.
    for (const P of [Root.prototype, Document.prototype]) {
        const d = own(P, "adoptedStyleSheets");
        if (!d?.set) continue;
        Object.defineProperty(P, "adoptedStyleSheets", { configurable: true, enumerable: true, get: d.get, set: {
            set adoptedStyleSheets(list) {
                Reflect.apply(d.set, this, [list]);
                if (this instanceof Root) known.add(this);
                later(this);
            },
        }.__lookupSetter__("adoptedStyleSheets") });
    }
    const Sheet = globalThis.CSSStyleSheet?.prototype;
    for (const name of ["replaceSync", "replace", "insertRule", "deleteRule", "addRule", "removeRule"]) {
        const f = Sheet && own(Sheet, name)?.value;
        if (typeof f !== "function") continue;
        Object.defineProperty(Sheet, name, { configurable: true, writable: true, value: { [name](...args) {
            const r = Reflect.apply(f, this, args);
            versions.set(this, (versions.get(this) ?? 0) + 1);
            for (const root of [document, ...known]) later(root);
            if (r && typeof r.then === "function") r.then(() => { for (const root of [document, ...known]) later(root); }, () => {});
            return r;
        } }[name] });
    }
    // All of them again, asked (the agent made anew, or reading the page
    // anew): those of the roots attached, or given adopted stylesheets.
    // (Not looked for, by every element's shadowRoot: read before Moli's
    // made an element's root from its HTML (a declarative one), it stays
    // null for the page, which then attaches another, which Moli refuses.)
    window.addEventListener("message", (e) => {
        if (e.data?.__tabtop !== "adopted") return;
        for (const root of [document, ...known]) {
            told.delete(root);
            later(root);
        }
    });
})();
