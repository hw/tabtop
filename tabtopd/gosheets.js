// The page's <style> elements whose rules its script put in (styled-
// components, Emotion: insertRule, no text), in its own world: asked
// (a message, {__tabtop: "sheets"}) by the agent (goagent.js), whose own
// view of a sheet's rules doesn't follow the page's (Moli's: its world's
// list of a sheet's rules stays as it first read it), each whose count of
// rules has changed since it was last told is told, in an event on the
// element, "__tabtop_sheet" ({count, text}: its rules as text).
//
// It's the page's to see and change, like anything in its world: what it
// says only touches its own copy's styles, which the copy processes as it
// does any.
(() => {
    const told = new WeakMap();  // style element -> how many rules it was told with
    window.addEventListener("message", (e) => {
        if (e.data?.__tabtop !== "sheets") return;
        for (const el of document.querySelectorAll("style")) {
            if (el.textContent.trim()) continue;  // its text says it
            let rules;
            try { rules = el.sheet?.cssRules; } catch { continue; }
            if (!rules || told.get(el) === rules.length) continue;
            told.set(el, rules.length);
            let text = "";
            for (const rule of rules) {
                text += rule.cssText + "\n";
                if (text.length > 4 << 20) break;
            }
            el.dispatchEvent(new CustomEvent("__tabtop_sheet", { composed: true, detail: JSON.stringify({ count: rules.length, text }) }));
        }
    });
})();
