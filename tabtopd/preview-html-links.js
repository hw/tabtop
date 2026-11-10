// Saved pages sometimes store destinations as data attributes. Recover only
// declared URLs; never execute their original event handlers or page scripts.
"use strict";
(() => {
    const reference = value => String(value ?? "").replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "").replace(/[\t\r\n]/g, "");
    function webURL(value, base) {
        try {
            const src = reference(value);
            const url = new URL(src.startsWith("//") ? "https:" + src : src, base);
            return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url : null;
        } catch { return null; }
    }
    function sourceURL(root, html) {
        for (const element of root.querySelectorAll('base[href], link[rel~="canonical" i][href], meta[property="og:url" i][content]')) {
            const url = webURL(element.getAttribute("href") ?? element.getAttribute("content"));
            if (url) { url.hash = ""; return url.href; }
        }
        const saved = /<!--\s*saved from url=\(\d+\)(.*?)-->/i.exec(html.slice(0, 4096));
        const original = saved && webURL(saved[1]);
        if (original) { original.hash = ""; return original.href; }
        // Infer a saved document's source only from an unambiguous set of
        // absolute self-links to at least two distinct anchors in that file.
        const ids = new Set([...root.querySelectorAll("[id], a[name]")].flatMap(node => [node.getAttribute("id"), node.getAttribute("name")]).filter(Boolean));
        const candidates = new Map();
        for (const anchor of root.querySelectorAll("a[href]")) {
            const url = webURL(anchor.getAttribute("href"));
            if (!url?.hash) continue;
            let id;
            try { id = decodeURIComponent(url.hash.slice(1)); } catch { continue; }
            if (!ids.has(id)) continue;
            url.hash = "";
            if (!candidates.has(url.href)) candidates.set(url.href, new Set());
            candidates.get(url.href).add(id);
        }
        const matching = [...candidates].filter(([, ids]) => ids.size >= 2);
        return matching.length === 1 ? matching[0][0] : null;
    }
    function anchorHref(node, source) {
        const raw = node.getAttribute("href");
        if (raw !== null && reference(raw) !== "") {
            const href = reference(raw);
            try {
                const url = new URL(href, "https://preview.invalid/");
                return ["http:", "https:", "mailto:"].includes(url.protocol) ? (href.startsWith("//") ? "https:" + href : href) : null;
            } catch { return null; }
        }
        const declared = node.getAttribute("data-href") ?? node.getAttribute("data-ga-content-link");
        if (!declared) return null;
        const url = webURL(declared, source ?? undefined);
        return url?.href ?? null;
    }
    globalThis.TabTopHTMLLinks = { reference, sourceURL, anchorHref };
})();
