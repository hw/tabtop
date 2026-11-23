// The page's <style> elements whose rules its script put in (styled-
// components, Emotion: insertRule, no text), in its own world: asked
// (a message, {__tabtop: "sheets"}) by the agent (goagent.js), whose own
// view of a sheet's rules doesn't follow the page's (Moli's: its world's
// list of a sheet's rules stays as it first read it), each whose count of
// rules has changed since it was last told is told, in an event on the
// element, "__tabtop_sheet" ({count, text}: its rules as text).
//
// Those in shadow roots too (a component's own <style>, filled by script):
// the roots attachShadow made, kept as it makes them (goshadow.js's, run
// after this, calls through it, so closed ones are kept too; a root from
// the page's HTML once its element takes it up). Not looked for by every
// element's shadowRoot read: see goshadow.js. The event's composed, so it
// reaches the agent, which takes it for the element it's from.
//
// It's the page's to see and change, like anything in its world: what it
// says only touches its own copy's styles, which the copy processes as it
// does any.
(() => {
    const told = new WeakMap();  // style element -> how many rules it was told with
    const roots = [], kept = new WeakSet();  // the roots made: WeakRefs, and which they are
    const proto = globalThis.Element?.prototype, attach = proto?.attachShadow;
    if (typeof attach === "function" && typeof WeakRef === "function") {
        Object.defineProperty(proto, "attachShadow", { configurable: true, writable: true, value: {
            attachShadow(init) {
                const root = Reflect.apply(attach, this, [init]);
                if (root && !kept.has(root)) {
                    kept.add(root);
                    roots.push(new WeakRef(root));
                }
                return root;
            },
        }.attachShadow });
    }
    function tell(el) {
        if (el.textContent.trim()) return;  // its text says it
        let rules;
        try { rules = el.sheet?.cssRules; } catch { return; }
        if (!rules || told.get(el) === rules.length) return;
        told.set(el, rules.length);
        let text = "";
        for (const rule of rules) {
            text += rule.cssText + "\n";
            if (text.length > 4 << 20) break;
        }
        el.dispatchEvent(new CustomEvent("__tabtop_sheet", { composed: true, detail: JSON.stringify({ count: rules.length, text }) }));
    }
    window.addEventListener("message", (e) => {
        if (e.data?.__tabtop !== "sheets") return;
        for (const el of document.querySelectorAll("style")) tell(el);
        // The roots', those still about (a root gone, forgotten).
        for (let i = 0; i < roots.length; i++) {
            const root = roots[i].deref();
            if (!root) {
                roots.splice(i--, 1);
                continue;
            }
            for (const el of root.querySelectorAll("style")) if (el.isConnected) tell(el);
        }
    });
})();
