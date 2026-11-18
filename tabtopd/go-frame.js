// The remote browser's frame, served by tabtopd as go-frame.html (see
// gopage.go). The /go page shows it sandboxed with allow-scripts only, so it
// runs at an origin of its own: nothing in it can read the site's session
// or reach the page that holds it, whose only way in is the messages below.
// Its CSP lets it run only this script, and load pictures and fonts only as
// blob: and data: URLs, and connect nowhere: whatever a web page's snapshot
// holds, this frame can't fetch anything from the web, nor tell anyone it
// was opened. Those are what keep a page in; what follows is what makes it
// look right.
//
// The page sends {type: "render", gen, url, base, doc, again}: a snapshot
// of a document the engine on the server loaded and ran (see goroute.go),
// its nodes as {i, t, n, v, a, c}. This rebuilds it here from an allowlist:
// elements that load or run something (frames, objects, embeds, scripts,
// base, meta) are left out, video, audio and canvas shown as a note, and
// attributes that run script (on…) or load (src, srcset, href, style's
// url()s) are dropped or pointed at pictures, stylesheets and fonts the page
// fetches through the server: {type: "resource", id, kind, url}, answered
// {type: "resource", id, blob} or {id, error}. Once shown, it tells the
// page {type: "rendered", gen, report}. Then {type: "changes", gen, ops}
// change it in place (see goagent.js for what they are), through the same
// allowlist; one that names a node it doesn't know has it ask for the whole
// document again, {type: "resync", gen}.
//
// What the person does is done in the engine, where the page's scripts
// see it: clicks, typing, keys and forms sent go to the page as
// {type: "event", gen, kind, id, ...}, by the engine's ids. Links are kept,
// but go nowhere here; a click on one is the engine's to follow.

"use strict";

(() => {
    const page = window.parent;
    const HTML = "http://www.w3.org/1999/xhtml";
    const SVG = "http://www.w3.org/2000/svg";
    const MATHML = "http://www.w3.org/1998/Math/MathML";
    const XLINK = "http://www.w3.org/1999/xlink";
    const XML = "http://www.w3.org/XML/1998/namespace";

    // Elements left out, with all inside them: what loads, embeds or runs
    // something, or says something to the browser about the document.
    const dropped = new Set(["script", "noscript", "template", "iframe", "frame", "frameset", "object", "embed", "applet",
        "base", "meta", "portal", "fencedframe", "param", "source", "track", "slot"]);
    // Shown as a note: what plays, or draws from script.
    const placeholders = { video: "A video", audio: "A sound", canvas: "A drawing made by script" };
    // Attributes dropped wherever they are: they run script, load or
    // navigate somewhere, or steal focus or input.
    const droppedAttributes = new Set(["srcdoc", "action", "formaction", "ping", "http-equiv", "nonce", "integrity",
        "target", "download", "autofocus", "background", "poster", "lowsrc", "dynsrc", "data", "codebase", "archive",
        "classid", "manifest", "is", "sizes", "imagesrcset", "imagesizes", "attributionsrc", "popovertarget"]);
    // Per page: resources fetched at once, stylesheets imported, bytes of
    // CSS processed, and how long to wait for stylesheets before showing.
    const MAX_FETCHING = 6;
    const MAX_SHEETS = 64;
    const MAX_CSS = 32 << 20;
    const STYLE_WAIT = 5000;

    let current = 0;  // the generation shown, or being built
    // The page's token, from its first message: sent with each of this
    // frame's, so the page can tell them from any other document's.
    let token = "";
    const tell = (m) => page.postMessage({ ...m, token }, "*");

    // --- Messages ---------------------------------------------------------

    const waiting = new Map();
    let lastId = 0;
    let fetching = 0;
    const queue = [];
    function resource(kind, url) {
        return new Promise((resolve, reject) => {
            const run = () => {
                fetching++;
                const id = ++lastId;
                waiting.set(id, (m) => {
                    fetching--;
                    queue.shift()?.();
                    m.blob instanceof Blob ? resolve(m.blob) : reject(new Error(m.error || "not loaded"));
                });
                tell({ type: "resource", id, kind, url });
            };
            fetching < MAX_FETCHING ? run() : queue.push(run);
        });
    }

    window.addEventListener("message", (e) => {
        if (e.source !== page || !e.data || typeof e.data !== "object") {
            return;
        }
        const m = e.data;
        if (m.type === "hello" && typeof m.token === "string" && !token) {
            token = m.token;
            tell({ type: "ready" });
        } else if (m.type === "resource" && waiting.has(m.id)) {
            const done = waiting.get(m.id);
            waiting.delete(m.id);
            done(m);
        } else if (m.type === "render" && Number.isSafeInteger(m.gen) && m.doc && typeof m.doc === "object") {
            render(m).catch((err) => tell({ type: "rendered", gen: m.gen, report: { error: String(err?.message || err) } }));
        } else if (m.type === "changes") {
            apply(m);
        }
    });

    // --- Addresses -------------------------------------------------------

    // web is src resolved against base, if it's a web address.
    function web(src, base) {
        try {
            const u = new URL(String(src).trim(), base);
            return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
        } catch {
            return null;
        }
    }

    // picture is src as this frame may show it: a data: picture as it is,
    // a web one fetched through the page (a blob: URL), anything else not.
    const blobs = new Map();  // kind + url -> Promise of a blob: URL, per page
    function load(kind, src, base) {
        const s = String(src).trim();
        if (/^data:/i.test(s)) {
            return Promise.resolve(s);
        }
        const url = web(s, base);
        if (!url) {
            return Promise.reject(new Error("not a web address"));
        }
        const key = kind + " " + url;
        if (!blobs.has(key)) {
            blobs.set(key, resource(kind, url).then((blob) => URL.createObjectURL(blob)));
        }
        return blobs.get(key);
    }

    // bestSource picks the srcset candidate nearest this screen's density
    // (or the widest, by width descriptors), else src.
    function bestSource(srcset, src) {
        const candidates = [];
        for (const part of String(srcset || "").split(/,(?=\s*\S)/)) {
            const [url, descriptor = "1x"] = part.trim().split(/\s+/);
            if (!url) continue;
            const n = parseFloat(descriptor);
            candidates.push({ url, w: descriptor.endsWith("w") ? n : 0, x: descriptor.endsWith("x") ? n : 0 });
        }
        if (!candidates.length) return src;
        const dpr = window.devicePixelRatio || 1;
        const byWidth = candidates.filter((c) => c.w);
        if (byWidth.length) {
            const want = (document.documentElement.clientWidth || 1024) * dpr;
            byWidth.sort((a, b) => a.w - b.w);
            return (byWidth.find((c) => c.w >= want) ?? byWidth[byWidth.length - 1]).url;
        }
        const byDensity = candidates.filter((c) => c.x).sort((a, b) => a.x - b.x);
        return (byDensity.find((c) => c.x >= dpr) ?? byDensity[byDensity.length - 1] ?? candidates[0]).url;
    }

    // --- Stylesheets -----------------------------------------------------

    // A page's CSS stays in this frame, which it can't leave and which can
    // load nothing itself; so it's kept as it is, but for what it loads:
    // every url() and image-set() address is fetched through the page (a
    // picture, or a font in @font-face), and @import's sheets fetched and
    // put in their place. A sheet that can't be parsed is left out.
    function cssBudget() {
        let bytes = 0, sheets = 0;
        return {
            charge(text) {
                bytes += text.length;
                if (bytes > MAX_CSS) throw new Error("The page's stylesheets are too large.");
            },
            sheet() {
                if (++sheets > MAX_SHEETS) throw new Error("The page imports too many stylesheets.");
            },
        };
    }

    async function stylesheet(text, base, budget, alive, depth = 0, chain = []) {
        const css = globalThis.csstree;
        budget.charge(text);
        const ast = css.parse(text, { positions: false, parseValue: true, parseCustomProperty: true });
        const imports = [];
        const loads = [];
        let font = 0;
        css.walk(ast, {
            enter(node, item, list) {
                if (node.type === "Atrule" && node.name.toLowerCase() === "import" && list) {
                    imports.push({ node, item, list });
                } else if (node.type === "Atrule" && node.name.toLowerCase() === "font-face") {
                    font++;
                } else if (node.type === "Url") {
                    loads.push({ node, kind: font ? "font" : "image" });
                } else if (node.type === "Function" && /^(-webkit-)?image-set$/i.test(node.name)) {
                    node.children.forEach((child) => {
                        if (child.type === "String") loads.push({ node: child, kind: "image" });
                    });
                }
            },
            leave(node) {
                if (node.type === "Atrule" && node.name.toLowerCase() === "font-face") font--;
            },
        });
        await Promise.all(loads.map(async ({ node, kind }) => {
            try {
                node.value = await load(kind, node.value, base);
            } catch {
                node.value = "data:,";  // nothing, rather than an address
            }
        }));
        let imported = "";
        for (const { node, item, list } of imports) {
            list.remove(item);
            if (!alive() || depth >= 4) continue;
            const first = node.prelude?.children?.first;
            const href = first?.type === "Url" || first?.type === "String" ? first.value : null;
            const url = href && web(href, base);
            if (!url || chain.includes(url)) continue;
            try {
                budget.sheet();
                const text = await (await resource("css", url)).text();
                let sheet = await stylesheet(text, url, budget, alive, depth + 1, [...chain, url]);
                const media = [...node.prelude.children].slice(1).filter((n) => n.type === "MediaQueryList");
                if (media.length) sheet = `@media ${css.generate(media[0])}{${sheet}}`;
                imported += sheet;
            } catch {
                // Left out, as a browser leaves a sheet it can't load.
            }
        }
        return imported + css.generate(ast);
    }

    async function inlineStyle(text, base, budget, alive) {
        if (!/url\(|image-set\(/i.test(text)) {
            return text;  // nothing to load
        }
        const sheet = await stylesheet(`x{${text}}`, base, budget, alive);
        const at = sheet.indexOf("{");
        return at >= 0 ? sheet.slice(at + 1, sheet.lastIndexOf("}")) : "";
    }

    // --- Building ----------------------------------------------------------

    const validName = /^[A-Za-z][A-Za-z0-9._-]*(:[A-Za-z][A-Za-z0-9._-]*)?$/;

    // A document shown: built from a snapshot, then changed by batches. Its
    // nodes are the engine's ids to what was built for them (null for
    // what's left out), so changes and events can find them.
    function newDoc(m) {
        return {
            gen: m.gen,
            base: web(m.base, "about:blank") ?? web(m.url, "about:blank") ?? "about:blank",
            url: web(m.url, "about:blank") ?? "",
            budget: cssBudget(),
            nodes: new Map(),    // engine id -> node built, or null if left out
            ids: new WeakMap(),  // node built -> engine id
            links: new WeakMap(),  // element -> where its link goes
            styleText: new Map(),  // a stylesheet's text node's id -> its text
            styleOf: new Map(),    // a stylesheet's text node's id -> its <style>
            waits: [],
            report: { elements: 0, left: {}, resources: 0, failed: 0 },
            io: new Map(),         // the page's observer's number -> {observer, ids}
        };
    }
    const alive = (d) => () => d.gen === current;
    const leave = (d, what) => { d.report.left[what] = (d.report.left[what] || 0) + 1; };
    const later = (d, promise) => promise.then(() => d.report.resources++, () => d.report.failed++);
    function own(d, id, n) {
        if (!Number.isSafeInteger(id)) return;
        d.nodes.set(id, n);
        if (n) d.ids.set(n, id);
    }

    function attribute(d, el, ns, tag, name, value) {
        const lower = name.toLowerCase();
        if (lower.startsWith("on") || droppedAttributes.has(lower) || !validName.test(name)) {
            if (lower.startsWith("on")) leave(d, "event handlers");
            return;
        }
        if (lower === "style") {
            const p = inlineStyle(value, d.base, d.budget, alive(d)).then((css) => alive(d)() && el.setAttribute("style", css));
            d.waits.push(p);
            later(d, p);
            return;
        }
        if ((lower === "href" || lower === "xlink:href") && (tag === "a" || tag === "area")) {
            const url = web(value, d.base);
            if (url) {
                d.links.set(el, url);
                el.setAttribute("href", "#");
            }
            return;
        }
        if (ns === SVG && (lower === "href" || lower === "xlink:href")) {
            if (tag === "image" || tag === "feimage") {
                later(d, load("image", value, d.base).then((src) => alive(d)() && el.setAttribute("href", src)));
            } else if (value.trim().startsWith("#")) {
                el.setAttribute(name, value);  // this document's own
            }
            return;
        }
        if (ns === HTML && tag === "img" && (lower === "src" || lower === "srcset")) {
            // A picture's source changed after it was shown.
            if (el.isConnected) {
                const src = lower === "srcset" ? bestSource(value, null) : value;
                if (src) later(d, load("image", src, d.base).then((url) => alive(d)() && el.setAttribute("src", url)));
            }
            return;
        }
        if (lower === "src" || lower === "srcset" || lower === "href" || lower === "xlink:href") {
            return;  // pictures are set below; nothing else may load or link
        }
        // An SVG animation may set an attribute when it runs: not a link's.
        if ((tag === "set" || tag.startsWith("animate")) && lower === "attributename" && /href/i.test(value)) {
            el.dataset.goDropped = "";
            return;
        }
        // url() in a presentation attribute may only point within the
        // document (fill="url(#gradient)").
        if (/url\(/i.test(value) && !/^\s*url\(\s*["']?#/i.test(value)) {
            return;
        }
        try {
            if (lower.startsWith("xlink:")) el.setAttributeNS(XLINK, name, value);
            else if (lower.startsWith("xml:")) el.setAttributeNS(XML, name, value);
            else if (!name.includes(":")) el.setAttribute(name, value);
        } catch {
            // A name this browser won't take.
        }
    }

    function element(d, n, ns) {
        const name = n.n;
        if (typeof name !== "string" || !validName.test(name) || name.includes(":")) {
            leave(d, "unknown elements");
            own(d, n.i, null);
            return null;
        }
        const tag = name.toLowerCase();
        if (ns === HTML && tag === "svg") ns = SVG;
        else if (ns === HTML && tag === "math") ns = MATHML;
        if (dropped.has(tag) && !(ns === SVG && tag === "a")) {
            leave(d, tag);
            own(d, n.i, null);
            return null;
        }
        if (ns === HTML && tag === "link") {
            const style = link(d, n);
            own(d, n.i, style);
            return style;
        }
        if (ns === HTML && placeholders[tag]) {
            leave(d, tag);
            const note = document.createElement("div");
            note.textContent = `${placeholders[tag]} isn't shown in the remote browser.`;
            note.style.cssText = "padding:1em;border:1px dashed #888;color:#666;font:14px system-ui,sans-serif";
            own(d, n.i, note);
            return note;
        }
        let el;
        try {
            el = document.createElementNS(ns, name);
        } catch {
            leave(d, "unknown elements");
            own(d, n.i, null);
            return null;
        }
        d.report.elements++;
        const attrs = Array.isArray(n.a) ? n.a : [];
        for (let i = 0; i + 1 < attrs.length; i += 2) {
            if (typeof attrs[i] === "string" && typeof attrs[i + 1] === "string") {
                attribute(d, el, ns, tag, attrs[i], attrs[i + 1]);
            }
        }
        if (el.dataset?.goDropped !== undefined) {
            leave(d, "animations of links");
            own(d, n.i, null);
            return null;
        }
        own(d, n.i, el);
        if (ns === HTML && (tag === "img" || tag === "input" && /^image$/i.test(attrOf(n, "type")))) {
            const src = bestSource(attrOf(n, "srcset"), attrOf(n, "src"));
            if (src) later(d, load("image", src, d.base).then((url) => alive(d)() && el.setAttribute("src", url)));
        }
        if (tag === "style") {
            styleKids(d, el, n.c);
            return el;
        }
        const childNS = ns === SVG && tag === "foreignobject" ? HTML : ns;
        children(d, el, n.c, childNS);
        if (ns === HTML && tag === "form") el.setAttribute("novalidate", "");
        return el;
    }

    // A <style>'s text, kept by its text nodes' ids, processed as one sheet.
    function styleKids(d, el, kids) {
        const ids = [];
        for (const k of Array.isArray(kids) ? kids : []) {
            if (k.r) {
                if (d.styleText.has(k.i)) ids.push(k.i);
            } else if (k.t === 3 && Number.isSafeInteger(k.i)) {
                d.styleText.set(k.i, typeof k.v === "string" ? k.v : "");
                d.styleOf.set(k.i, el);
                own(d, k.i, null);
                ids.push(k.i);
            }
        }
        el.goStyleIds = ids;
        restyle(d, el);
    }
    function restyle(d, el) {
        const text = (el.goStyleIds || []).map((i) => d.styleText.get(i) ?? "").join("");
        const p = stylesheet(text, d.base, d.budget, alive(d)).then((css) => { if (alive(d)()) el.textContent = css; });
        d.waits.push(p);
        later(d, p);
    }

    // A stylesheet link becomes the stylesheet, fetched and processed.
    function link(d, n) {
        const rel = attrOf(n, "rel").toLowerCase().split(/\s+/);
        const href = web(attrOf(n, "href"), d.base);
        if (!rel.includes("stylesheet") || rel.includes("alternate") || !href) {
            return null;
        }
        const style = document.createElement("style");
        const media = attrOf(n, "media");
        if (media) style.media = media;
        const p = (async () => {
            d.budget.sheet();
            const text = await (await resource("css", href)).text();
            const css = await stylesheet(text, href, d.budget, alive(d));
            if (alive(d)()) style.textContent = css;
        })();
        d.waits.push(p);
        later(d, p);
        return style;
    }

    function children(d, el, kids, ns) {
        if (!Array.isArray(kids)) return;
        for (const k of kids) {
            const child = node(d, k, ns);
            if (child) el.append(child);
        }
    }

    function node(d, n, ns) {
        if (!n || typeof n !== "object") return null;
        if (n.t === 3) {
            const t = document.createTextNode(typeof n.v === "string" ? n.v : "");
            own(d, n.i, t);
            return t;
        }
        if (n.t === 1) return element(d, n, ns);
        return null;
    }

    let doc = null;  // the document shown

    function render(m) {
        current = m.gen;
        const d = newDoc(m);
        for (const url of blobs.values()) url.then(URL.revokeObjectURL, () => {});
        blobs.clear();

        // The document's element: its html, or one made around what's there.
        let root = null;
        for (const k of Array.isArray(m.doc.c) ? m.doc.c : []) {
            if (k?.t === 1) {
                root = element(d, k, HTML);
                break;
            }
        }
        if (!root || root.namespaceURI !== HTML || root.localName !== "html") {
            const html = document.createElement("html");
            const body = document.createElement("body");
            if (root) body.append(root);
            html.append(document.createElement("head"), body);
            root = html;
        }

        return (async () => {
            const at = { x: scrollX, y: scrollY };
            await Promise.race([Promise.allSettled(d.waits), new Promise((resolve) => setTimeout(resolve, m.again ? 1000 : STYLE_WAIT))]);
            if (!alive(d)()) return;
            d.waits = [];
            // (Document.replaceChildren refuses a second element even as
            // it replaces the first.)
            document.documentElement ? document.documentElement.replaceWith(root) : document.append(root);
            unobserveAll(doc);
            doc = d;
            observeAll(d, m.io);
            if (m.again) {
                scrollTo(at.x, at.y);  // the same document, read again
            } else {
                const hash = d.url ? new URL(d.url).hash.slice(1) : "";
                hash ? scrollToFragment(hash) : scrollTo(0, 0);
            }
            tell({ type: "rendered", gen: d.gen, report: d.report });
        })();
    }

    // --- What the page observes -------------------------------------------
    //
    // The page's IntersectionObserver (in the engine, see goobserve.js) has
    // this copy's elements observed here, by this browser's own, which sees
    // them as they're laid out and scrolled here; what it sees goes back.

    const MAX_IO = 5000;
    let ioSeen = [];
    let ioTimer = 0;
    let ioCount = 0;
    function observeAll(d, list) {
        if (!Array.isArray(list)) return;
        for (const x of list) {
            if (!x || typeof x !== "object" || !Number.isSafeInteger(x.o) || !Number.isSafeInteger(x.i)) continue;
            const el = d.nodes.get(x.i);
            if (!el || el.nodeType !== 1) continue;
            let rec = d.io.get(x.o);
            if (x.op === "-") {
                if (rec?.ids.has(el)) {
                    rec.observer.unobserve(el);
                    rec.ids.delete(el);
                    ioCount--;
                }
                continue;
            }
            if (x.op !== "+" || ioCount >= MAX_IO) continue;
            if (!rec) {
                const root = x.r ? d.nodes.get(x.r) : null;
                if (x.r && !(root?.nodeType === 1)) continue;
                const o = x.o;
                try {
                    const observer = new IntersectionObserver((entries) => seen(d, o, entries), {
                        root, rootMargin: String(x.m), threshold: Array.isArray(x.t) ? x.t.map(Number) : 0,
                    });
                    rec = { observer, ids: new WeakMap() };
                } catch {
                    continue;  // options this browser won't take
                }
                d.io.set(o, rec);
            }
            if (rec.ids.has(el)) continue;
            rec.ids.set(el, x.i);
            rec.observer.observe(el);
            ioCount++;
        }
    }
    function seen(d, o, entries) {
        const rec = d.io.get(o);
        if (!rec || d !== doc) return;
        for (const e of entries) {
            const i = rec.ids.get(e.target);
            // Its places too, as shown here: a page may go by them (only
            // what has a visible area, say), and the engine's own differ.
            const box = (r) => (r ? [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 10) / 10) : null);
            if (i) ioSeen.push({ o, i, hit: e.isIntersecting, ratio: Math.round(e.intersectionRatio * 1000) / 1000,
                b: box(e.boundingClientRect), r: box(e.intersectionRect), rb: box(e.rootBounds) });
        }
        if (ioTimer) return;
        // Together, a little later: scrolling past many at once is one message.
        ioTimer = setTimeout(() => {
            ioTimer = 0;
            const list = ioSeen;
            ioSeen = [];
            if (doc === d && list.length) tell({ type: "io", gen: d.gen, entries: list });
        }, 100);
    }
    function unobserveAll(d) {
        for (const rec of d?.io.values() ?? []) rec.observer.disconnect();
        d?.io.clear();
        ioCount = 0;
        ioSeen = [];
    }

    // --- Changes -------------------------------------------------------------

    function resync(d) {
        if (d.resyncing) return;
        d.resyncing = true;
        tell({ type: "resync", gen: d.gen });
    }

    // apply applies a batch of changes to the document shown: only the
    // nodes they name change, so what has focus, what's selected and where
    // it's scrolled stay as they are.
    function apply(m) {
        const d = doc;
        if (!d || m.gen !== d.gen || !Array.isArray(m.ops)) return;
        for (const op of m.ops) {
            if (!op || typeof op !== "object") continue;
            const target = d.nodes.get(op.i);
            if (target === undefined) return resync(d);
            if (op.o === "t" && d.styleOf.has(op.i)) {
                d.styleText.set(op.i, String(op.v ?? ""));
                restyle(d, d.styleOf.get(op.i));
                continue;
            }
            if (target === null) continue;  // left out
            switch (op.o) {
                case "c":
                    if (!reconcile(d, target, op.c)) return resync(d);
                    break;
                case "a": {
                    if (target.nodeType !== 1) break;
                    const tag = target.localName.toLowerCase();
                    if (op.v === null) {
                        const lower = String(op.n).toLowerCase();
                        if (lower === "href" && d.links.has(target)) d.links.delete(target);
                        try { target.removeAttribute(op.n); } catch { /* not a name */ }
                    } else {
                        attribute(d, target, target.namespaceURI, tag, String(op.n), String(op.v));
                    }
                    break;
                }
                case "t":
                    if (target.nodeType === 3) target.data = String(op.v ?? "");
                    break;
                case "v":
                    // A field's value set by the page's script (cleared once
                    // sent, say), unless it's being typed in here.
                    if (pending.has(target)) break;
                    if (target.type === "checkbox" || target.type === "radio") target.checked = op.v === "true";
                    else if ("value" in target && target.value !== op.v) target.value = String(op.v ?? "");
                    break;
            }
        }
        // Stylesheets of what was added load as they come.
        d.waits = [];
        observeAll(d, m.io);
        if (typeof m.title === "string") tell({ type: "title", gen: d.gen, title: m.title });
    }

    // reconcile makes parent's children the ones listed, building those new
    // and moving those already shown, leaving any in place in place.
    function reconcile(d, parent, kids) {
        if (!Array.isArray(kids)) return true;
        if (parent.nodeType === 1 && parent.localName === "style") {
            styleKids(d, parent, kids);
            return true;
        }
        const ns = parent.namespaceURI === SVG && parent.localName.toLowerCase() === "foreignobject" ? HTML : (parent.namespaceURI || HTML);
        const want = [];
        for (const k of kids) {
            if (!k || typeof k !== "object") continue;
            if (k.r) {
                const n = d.nodes.get(k.i);
                if (n === undefined) return false;
                if (n) want.push(n);
            } else {
                const n = node(d, k, ns);
                if (n) want.push(n);
            }
        }
        let cur = parent.firstChild;
        for (const n of want) {
            if (n === cur) {
                cur = cur.nextSibling;
                continue;
            }
            parent.insertBefore(n, cur);
        }
        while (cur) {
            const next = cur.nextSibling;
            parent.removeChild(cur);
            cur = next;
        }
        return true;
    }

    function attrOf(n, name) {
        const attrs = Array.isArray(n.a) ? n.a : [];
        for (let i = 0; i + 1 < attrs.length; i += 2) {
            if (typeof attrs[i] === "string" && attrs[i].toLowerCase() === name) return String(attrs[i + 1]);
        }
        return "";
    }

    function scrollToFragment(fragment) {
        let id = fragment;
        try { id = decodeURIComponent(fragment); } catch { /* as it is */ }
        const target = document.getElementById(id) ?? document.getElementsByName(id)[0];
        target ? target.scrollIntoView() : scrollTo(0, 0);
    }

    // --- What the person does ------------------------------------------------

    // Clicks, typing, keys and forms sent are done in the page in the
    // engine, by id (see goagent.js), where its scripts see them; what
    // that changes comes back as changes, or a new page. Here, only what's
    // safe happens by itself: a box ticks, text is typed, the page scrolls.
    function idOf(target) {
        for (let n = target; n && n !== document; n = n.parentNode) {
            const id = doc?.ids.get(n);
            if (id) return { id, node: n };
        }
        return null;
    }
    function send(kind, id, extra = {}) {
        if (!doc) return;
        tell({ type: "event", gen: doc.gen, kind, id, ...extra });
    }

    // Typing is sent a moment after it stops, and at once before a key or a
    // form sent that might use it.
    const pending = new Map();  // field -> timer
    function flush(field) {
        const timer = pending.get(field);
        if (timer === undefined) return;
        clearTimeout(timer);
        pending.delete(field);
        const id = doc?.ids.get(field);
        if (id) send("input", id, { value: field.value });
    }
    function flushAll(within) {
        for (const field of [...pending.keys()]) if (!within || within.contains(field)) flush(field);
    }
    const textLike = (el) => el.localName === "textarea" || el.localName === "input"
        && !/^(checkbox|radio|file|image|submit|reset|button|range|color|date|datetime-local|month|time|week)$/i.test(el.type);

    let lastClick = 0;
    let labelled = null;  // the field of the label clicked last
    let lastEnter = 0;
    document.addEventListener("click", (e) => {
        if (!e.isTrusted || e.button !== 0) return;
        const link = linkOf(e.target);
        const at = idOf(e.target);
        if (link || e.target.closest?.("a[href='#']")) e.preventDefault();
        // A click on a label clicks its field too: that's one click, the
        // label's (the engine's label clicks its own field).
        if (e.target === labelled && performance.now() - lastClick < 100) return;
        lastClick = performance.now();
        labelled = e.target.closest?.("label")?.control ?? null;
        if (link) {
            const to = new URL(link);
            const here = doc?.url ? new URL(doc.url) : null;
            if (here && to.hash && to.origin + to.pathname + to.search === here.origin + here.pathname + here.search) {
                scrollToFragment(to.hash.slice(1));  // the engine follows it too, below
            }
        }
        if (at) {
            flushAll();
            send("click", at.id);
        } else if (link) {
            tell({ type: "navigate", url: link });
        }
    }, true);
    document.addEventListener("auxclick", (e) => {
        const link = linkOf(e.target);
        if (link && e.button === 1) {
            e.preventDefault();
            tell({ type: "navigate", url: link });
        }
    }, true);
    document.addEventListener("input", (e) => {
        const el = e.target;
        if (!e.isTrusted || !textLike(el) || !doc?.ids.get(el)) return;
        clearTimeout(pending.get(el));
        pending.set(el, setTimeout(() => flush(el), 150));
    }, true);
    document.addEventListener("change", (e) => {
        const el = e.target;
        const id = doc?.ids.get(el);
        // (Boxes are ticked by their clicks; text by its typing.)
        if (!e.isTrusted || !id || textLike(el) || el.type === "checkbox" || el.type === "radio") return;
        send("change", id, { value: String(el.value ?? "") });
    }, true);
    const keys = new Set(["Enter", "Escape", "ArrowUp", "ArrowDown", "Tab", "Backspace", "Delete"]);
    document.addEventListener("keydown", (e) => {
        if (!e.isTrusted || !keys.has(e.key) || e.isComposing) return;
        const at = idOf(e.target);
        if (!at) return;
        if (e.key === "Tab" && !textLike(at.node)) return;
        flush(at.node);
        if (e.key === "Enter") lastEnter = performance.now();
        send("key", at.id, { key: e.key, code: e.code, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey });
    }, true);
    // Forms aren't sent from here (form-action 'none'): the engine sends
    // them. Enter in a field sends its form there already, with its key.
    document.addEventListener("submit", (e) => {
        e.preventDefault();
        // Sent by a click on its button, or Enter in a field: the engine
        // sends it, from those, already.
        if (performance.now() - lastEnter < 200 || performance.now() - lastClick < 200) return;
        const form = idOf(e.target);
        if (!form) return;
        flushAll(e.target);
        const by = e.submitter ? doc?.ids.get(e.submitter) : 0;
        send("submit", form.id, { submitter: by || 0 });
    }, true);

    // A link goes nowhere here (its href is "#"); where it goes is kept.
    function linkOf(target) {
        for (let el = target; el && el !== document; el = el.parentNode) {
            if (doc?.links.has(el)) return doc.links.get(el);
        }
        return null;
    }

    page.postMessage({ type: "loaded" }, "*");  // ready for the page's hello
})();
