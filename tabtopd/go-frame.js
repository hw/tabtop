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
// elements that load or run something (objects, embeds, scripts, base,
// meta) are left out, an iframe's page drawn as a view-only copy in a box
// (embeddedFrame), video, audio and canvas shown as a note, and
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
    const placeholders = { canvas: "A drawing made by script" };
    // Elements drawn as a box of their own, and the attribute their box has,
    // which the page's rules for them are rewritten to.
    const drawnAs = { iframe: "data-go-iframe", video: "data-go-video", audio: "data-go-audio" };
    // Attributes dropped wherever they are: they run script, load or
    // navigate somewhere, or steal focus or input.
    const droppedAttributes = new Set(["srcdoc", "action", "formaction", "ping", "http-equiv", "nonce", "integrity",
        "target", "download", "autofocus", "background", "poster", "lowsrc", "dynsrc", "data", "codebase", "archive",
        "classid", "manifest", "is", "sizes", "imagesrcset", "imagesizes", "attributionsrc", "popovertarget"]);
    // Per page: resources fetched at once, stylesheets imported, bytes of
    // CSS processed, and how long to wait for stylesheets before showing.
    // Requests for resources at once: they go over the tab's own tunnel,
    // and the server fetches at most a few at a time itself.
    const MAX_FETCHING = 24;
    const MAX_SHEETS = 64;
    const MAX_CSS = 32 << 20;
    // How long a page is held back for its stylesheets before it's shown
    // anyway: a page shown before its styles would show unstyled, then jump.
    const STYLE_WAIT = 12000;
    // Then, held back (the page before staying in view) until it settles:
    // no change for SETTLE_QUIET while the engine has nothing loading, or
    // SETTLE_MAX after its styles came, at most. A page that builds itself
    // with script (YouTube's skeleton, then its content) is shown built.
    const SETTLE_QUIET = 300, SETTLE_MAX = 4000;
    // A batch that adds stylesheets: what it adds hidden until they've come,
    // FRESH_WAIT at most.
    const FRESH_WAIT = 2000;

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
            tellLayout();
        } else if (m.type === "resource" && waiting.has(m.id)) {
            const done = waiting.get(m.id);
            waiting.delete(m.id);
            done(m);
        } else if (m.type === "render" && Number.isSafeInteger(m.gen) && m.doc && typeof m.doc === "object") {
            render(m).catch((err) => tell({ type: "rendered", gen: m.gen, report: { error: String(err?.message || err) } }));
        } else if (m.type === "changes") {
            apply(m);
        } else if (m.type === "net" && Number.isSafeInteger(m.gen)) {
            netGen = m.gen;
            netBusy = !!m.busy;
        } else if (m.type === "media-scroll" && [m.x, m.y, m.dx, m.dy].every(Number.isFinite)) {
            scrollUnder(m);
        } else if (m.type === "media-state" && Number.isSafeInteger(m.key)) {
            const box = media.get(m.key)?.box;
            if (box && typeof m.error === "string") box.textContent = m.error;
            // The video's own proportions, which its box takes.
            if (box && Number.isFinite(m.ratio) && m.ratio > 0.05 && m.ratio < 20) {
                mediaOf.get(box).size.aspectRatio = String(m.ratio);
                mediaStyle(box);
            }
            // Its size and length, for the page in the engine, which has no
            // media of its own (gomedia.js): to the element the box is for.
            const engineId = box && doc?.ids.get(box);
            const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
            if (engineId && m.meta && typeof m.meta === "object") {
                send("media-meta", engineId, { value: JSON.stringify({ w: num(m.meta.w), h: num(m.meta.h), duration: num(m.meta.duration) }) });
            }
            // How it plays, likewise.
            if (engineId && m.play && typeof m.play === "object") {
                const play = { t: num(m.play.t), playing: !!m.play.playing, ended: !!m.play.ended };
                if (Number.isSafeInteger(m.play.stream)) {
                    const ranges = (list) => Array.isArray(list) ? list.slice(0, 16).map((r) => [num(r?.[0]), num(r?.[1])]) : [];
                    Object.assign(play, { stream: m.play.stream, buffered: ranges(m.play.buffered),
                        buffers: Array.isArray(m.play.buffers) ? m.play.buffers.slice(0, 8).map(ranges) : [] });
                    if (Number.isSafeInteger(m.play.ack)) play.ack = m.play.ack;
                }
                send("media-meta", engineId, { value: JSON.stringify({ play }) });
            }
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
    // kind + url -> Promise of a blob: URL, kept for the tab's pages (most
    // recently used last; the oldest revoked past MAX_BLOBS), so a site's
    // pages share their pictures, fonts, and stylesheets made with them.
    const blobs = new Map();
    const blobSizes = new Map();  // kind + url -> its bytes, once come
    let blobBytes = 0;
    const MAX_BLOBS = 1500, MAX_BLOB_BYTES = 256 << 20;
    // href -> Promise of a stylesheet as rewritten (its addresses those
    // blobs'), for the tab's pages: a site's pages parse each once. Cleared
    // when a blob it may use is revoked.
    const sheets = new Map();
    let sheetChars = 0;
    const MAX_SHEET_CHARS = 32 << 20;
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
        let got = blobs.get(key);
        if (got) {
            blobs.delete(key);
            blobs.set(key, got);  // most recently used
            return got;
        }
        got = resource(kind, url).then((blob) => {
            if (blobs.get(key) === got) {
                blobSizes.set(key, blob.size);
                blobBytes += blob.size;
                trimBlobs(key);
            }
            return URL.createObjectURL(blob);
        });
        got.catch(() => blobs.get(key) === got && blobs.delete(key));  // tried again next time
        blobs.set(key, got);
        trimBlobs(key);
        return got;
    }

    // trimBlobs drops the oldest blobs (but keep) past the limits, and the
    // stylesheets that may use them.
    function trimBlobs(keep) {
        while ((blobs.size > MAX_BLOBS || blobBytes > MAX_BLOB_BYTES) && blobs.size > 1) {
            const [oldest, url] = blobs.entries().next().value;
            if (oldest === keep) break;
            blobs.delete(oldest);
            blobBytes -= blobSizes.get(oldest) ?? 0;
            blobSizes.delete(oldest);
            url.then(URL.revokeObjectURL, () => {});
            sheets.clear();
            sheetChars = 0;
        }
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

    // --- Fonts: the one a browser would use, when its text uses it --------
    //
    // A @font-face keeps the first of its sources in a format this browser
    // takes (WOFF2, WOFF, TrueType, OpenType; not EOT nor SVG fonts), with
    // the local() ones before it; the others go, as a browser wouldn't fetch
    // them. That one is an address this frame's policy refuses
    // (https://f<n>.font.invalid/): the browser loads a face only when
    // text in its family, style and characters (unicode-range) is shown,
    // and the face it couldn't load is said (the font set's loadingerror;
    // not the refusals, which come for every face as its rule is read).
    // That face is found by its descriptors, as this browser has them, and
    // its font fetched and added with them (FontFace). Faces nothing uses
    // (another script's characters, a weight not used, a font the page
    // never shows) are never fetched, and the page isn't held back for any.
    let fontId = 0;
    let fontGen = 0;  // the document the faces being read are for
    const fontFaces = new Map();  // n -> {url, family, descriptors, gen, face}
    const FONT_FORMATS = ["woff2", "woff", "truetype", "opentype", "collection", "woff2-variations", "woff-variations", "truetype-variations", "opentype-variations"];
    const FONT_DESCRIPTORS = { "font-style": "style", "font-weight": "weight", "font-stretch": "stretch", "unicode-range": "unicodeRange",
        "font-feature-settings": "featureSettings", "font-variation-settings": "variationSettings", "font-display": "display",
        "ascent-override": "ascentOverride", "descent-override": "descentOverride", "line-gap-override": "lineGapOverride", "size-adjust": "sizeAdjust" };
    const faceKey = (face) => [face.family.replace(/^["']|["']$/g, ""), face.style, face.weight, face.stretch, face.unicodeRange, face.featureSettings].join("|");
    document.fonts.addEventListener("loadingerror", (e) => {
        for (const failed of e.fontfaces ?? []) {
            const key = faceKey(failed);
            // The newest of that face (a page's own, as it's read again).
            let n = 0, f = null;
            for (const [i, x] of fontFaces) if (x.key === key && !x.face && i > n) [n, f] = [i, x];
            if (f && !f.asked) ask(n, f);
        }
    });
    function ask(n, f) {
        f.asked = true;
        load("font", f.url).then((blobURL) => {
            if (fontFaces.get(n) !== f) return;  // its page gone
            const face = new FontFace(f.family, `url("${blobURL}")`, f.descriptors);
            f.face = face;
            document.fonts.add(face);
            return face.load();
        }).catch(() => { /* left to the page's fallback, as a font that fails is */ });
    }
    // fontsFor keeps the faces of the document shown (gen) and drops the rest.
    function fontsFor(gen) {
        for (const [n, f] of fontFaces) {
            if (f.gen === gen) continue;
            if (f.face) document.fonts.delete(f.face);
            fontFaces.delete(n);
        }
    }
    // fontFace rewrites a @font-face's src to its one source (above).
    function fontFace(css, rule, base) {
        const decls = rule.block?.children;
        if (!decls) return;
        let family = "", src = null;
        const descriptors = {}, srcs = [];
        decls.forEach((d, item) => {
            if (d.type !== "Declaration") return;
            const name = d.property.toLowerCase();
            if (name === "font-family") family = css.generate(d.value).trim().replace(/^(["'])(.*)\1$/s, "$2");
            else if (name === "src") srcs.push({ d, item });
            else if (FONT_DESCRIPTORS[name]) descriptors[FONT_DESCRIPTORS[name]] = css.generate(d.value).trim();
        });
        src = srcs.at(-1)?.d;
        if (!src || !family) return;
        for (const { item } of srcs.slice(0, -1)) decls.remove(item);  // overridden (the last is a browser's), not left to load
        // Its sources, between commas: url() [format()] [tech()], or local().
        const items = [[]];
        src.value.children?.forEach((k) => {
            if (k.type === "Operator" && k.value === ",") items.push([]);
            else items[items.length - 1].push(k);
        });
        const kept = [];
        let chosen = null;
        for (const item of items) {
            const url = item.find((k) => k.type === "Url");
            if (!url) {
                if (item.some((k) => k.type === "Function" && k.name.toLowerCase() === "local")) kept.push(item.map((k) => css.generate(k)).join(" "));
                continue;
            }
            const format = item.find((k) => k.type === "Function" && k.name.toLowerCase() === "format");
            const said = format ? css.generate(format).toLowerCase().replace(/^format\(\s*["']?|["']?\s*\)$/g, "") : "";
            const ok = format ? FONT_FORMATS.includes(said) : !/\.(eot|svg)([?#]|$)/i.test(url.value);
            const address = ok && web(url.value, base);
            if (!address) continue;
            // Its descriptors as this browser has them, to know it by.
            let key;
            try { key = faceKey(new FontFace(family, "url(data:,)", descriptors)); } catch { return; }  // descriptors it won't take: as it was
            const n = ++fontId;
            fontFaces.set(n, { url: address, family, descriptors, gen: fontGen, key });
            chosen = `url("https://f${n}.font.invalid/")` + (format ? " " + css.generate(format) : "");
            break;
        }
        src.value = css.parse((chosen ? [...kept, chosen] : kept.length ? kept : [`url("data:,")`]).join(", "), { context: "value" });
    }

    async function stylesheet(text, base, budget, alive, depth = 0, chain = []) {
        const css = globalThis.csstree;
        budget.charge(text);
        const ast = css.parse(text, { positions: false, parseValue: true, parseCustomProperty: true });
        const imports = [];
        const loads = [];
        const never = [];  // selectors that can't match a document: {item, list}
        const faces = [];  // @font-face rules (fontFace)
        let font = 0;
        css.walk(ast, {
            enter(node, item, list) {
                if (node.type === "Selector" && list && node.children.some((k, i, all) => k.type === "TypeSelector" && k.name.toLowerCase() === "html" &&
                    all.toArray().slice(0, all.toArray().indexOf(k)).some((p) => p.type === "Combinator"))) {
                    // An html with something before it (* html, *+html: old
                    // Internet Explorer's hacks) is never in a document: its
                    // root has no parent nor sibling. An embedded page's copy
                    // has its html in a box (embeddedFrame), where it would.
                    never.push({ item, list });
                } else if (node.type === "TypeSelector" && drawnAs[node.name.toLowerCase()] && list) {
                    // An iframe, video or audio is drawn as a box of its own
                    // (embeddedFrame, mediaBox): the page's rules for them
                    // are for it.
                    list.replace(item, list.createItem({ type: "AttributeSelector", name: { type: "Identifier", name: drawnAs[node.name.toLowerCase()] }, matcher: null, value: null, flags: null }));
                } else if (node.type === "Atrule" && node.name.toLowerCase() === "import" && list) {
                    imports.push({ node, item, list });
                } else if (node.type === "Atrule" && node.name.toLowerCase() === "font-face") {
                    font++;
                    faces.push(node);
                } else if (node.type === "Url") {
                    if (!font) loads.push({ node, kind: "image" });  // a font's, when it's used (fontFace)
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
        for (const rule of faces) {
            try { fontFace(css, rule, base); } catch { /* left as it was: its fonts refused */ }
        }
        for (const { item, list } of never) list.remove(item);
        if (never.length) {
            // A rule left with no selector is no rule.
            const empty = [];
            css.walk(ast, { visit: "Rule", enter(node, item, list) { if (node.prelude?.type === "SelectorList" && node.prelude.children.isEmpty && list) empty.push({ item, list }); } });
            for (const { item, list } of empty) list.remove(item);
        }
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
    const frameRoots = new WeakMap();
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
            const p = inlineStyle(value, d.base, d.budget, alive(d)).then((css) => {
                if (!alive(d)()) return;
                if (mediaOf.has(el)) {
                    mediaOf.get(el).style = css;
                    mediaStyle(el);
                } else {
                    el.setAttribute("style", css);
                }
            });
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

    function renderFrame(d, el, kids, docOf = 0) {
        const { viewport } = frameRoots.get(el);
        const frame = Array.isArray(kids) && kids.find((k) => k?.t === 9);
        if (!frame) {
            viewport.replaceChildren();
            viewport.textContent = "Embedded page unavailable";
            return;
        }
        // What has the focus in the copy keeps it, read again (as typing
        // there makes it be): its caret, and what's typed that hasn't been
        // sent, which goes on to the new copy's field.
        // Only for the same document: another (the frame went elsewhere)
        // numbers its nodes anew, and what was typed for one isn't the
        // other's. What wasn't sent of it is dropped.
        const fr = frameRoots.get(el), was = fr.child, focused = el.shadowRoot?.activeElement;
        const same = fr.docOf === docOf && was?.base === web(frame?.b, "about:blank");
        if (!same && focused && pending.has(focused)) {
            clearTimeout(pending.get(focused));
            pending.delete(focused);
        }
        fr.docOf = docOf;
        const keep = same && was && focused && was.ids.get(focused) ? {
            i: was.ids.get(focused), old: focused, value: pending.has(focused) ? focused.value : undefined,
            caret: textLike(focused) ? [focused.selectionStart, focused.selectionEnd] : null,
        } : null;
        const content = document.createElement("div");
        const child = newDoc({ gen: d.gen, base: frame.b, url: d.base });
        frameRoots.get(el).child = child;  // its nodes, by the frame's own numbers (whereAt)
        child.top = d.top ?? d;  // its boxes are its page's
        child.budget = d.budget;
        child.report = d.report;
        children(child, content, frame.c, HTML);
        d.waits.push(...child.waits);
        viewport.replaceChildren(content);
        const now = keep && child.nodes.get(keep.i);
        if (now?.nodeType === 1) {
            if (keep.value !== undefined && textLike(now)) {
                now.value = keep.value;
                clearTimeout(pending.get(keep.old));
                pending.delete(keep.old);
                pending.set(now, setTimeout(() => flush(now), 150));
            }
            now.focus({ preventScroll: true });
            if (keep.caret) try { now.setSelectionRange(...keep.caret); } catch { /* no caret */ }
        }
    }

    function embeddedFrame(d, n) {
        // A shadow tree contains the embedded styles. There is no local
        // browsing context and the copied content does not receive input.
        const el = document.createElement("span");
        el.setAttribute("data-go-iframe", "");  // what the page's iframe rules apply to
        const shadow = el.attachShadow({ mode: "open" });
        const style = document.createElement("style");
        style.textContent = ":host { display:inline-block; vertical-align:bottom; width:300px; height:150px; max-width:100%; border:2px inset } div[part=viewport] { width:100%; height:100%; overflow:auto; contain:strict } " + MEDIA_DEFAULTS;
        const viewport = document.createElement("div");
        viewport.setAttribute("part", "viewport");
        shadow.append(style, viewport);
        frameRoots.set(el, { viewport });
        for (const name of ["id", "class", "title", "style"]) {
            const value = attrOf(n, name);
            if (value) attribute(d, el, HTML, "span", name, value);
        }
        // As an iframe: no scroll bars if it says so, no border if it says
        // so. Still scrolled by wheel and finger: the copy's layout may
        // run past where the engine's fits (what's past it would be lost).
        if (/^no$/i.test(attrOf(n, "scrolling") ?? "")) style.textContent += "div[part=viewport] { scrollbar-width:none }";
        if ((attrOf(n, "frameborder") ?? "").trim() === "0") style.textContent += ":host { border:none }";
        for (const name of ["width", "height"]) {
            const value = attrOf(n, name);
            if (/^\d{1,5}%?$/.test(value)) {
                style.textContent += `:host { ${name}:${value.endsWith("%") ? value : value + "px"} }`;
            }
        }
        own(d, n.i, el);
        renderFrame(d, el, n.c);
        return el;
    }

    // --- Audio and video ---------------------------------------------------
    //
    // Played by the page above, not here (this frame has no media): a box
    // where the player was, which the page lays a native player over,
    // playing the file the page had, read through the server
    // (go-media.js). The page says if it can't; this keeps telling it where
    // the boxes are.

    let media = new Map();  // key -> {box, kind, src, ...}, of the document shown
    // The boxes' sizes but for the page's own rules (which win: :where has
    // no weight), as a browser's players' are.
    const MEDIA_DEFAULTS = ":where([data-go-video]) { display: inline-block; width: var(--tabtop-media-width, 300px); height: var(--tabtop-media-height, auto); aspect-ratio: var(--tabtop-media-ratio, 16 / 9); object-fit: contain; } " +
        ":where([data-go-audio]) { display: inline-block; width: var(--tabtop-media-width, 300px); height: var(--tabtop-media-height, 54px); } " +
        ":where([data-go-video], [data-go-audio]) { box-sizing: border-box; padding: 8px; overflow: hidden; background: #111; color: #ccc; font: 13px system-ui, sans-serif; } " +
        "[data-go-wait] { visibility: hidden !important; }";
    let mediaKey = 0;
    const mediaOf = new WeakMap();  // a box -> {tag, key, src, poster, muted, loop, play}: the page's player's
    const mediaVisibility = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            const m = media.get(mediaOf.get(entry.target)?.key);
            if (m?.box === entry.target) m.intersection = entry;
        }
        mediaLater();
    }, { root: document, threshold: Array.from({ length: 101 }, (_, i) => i / 100) });
    const mediaSizes = new ResizeObserver(mediaLater);
    let mediaSoon = false;
    function forgetMedia(key) {
        const m = media.get(key);
        if (!m) return;
        mediaVisibility.unobserve(m.box);
        mediaSizes.unobserve(m.box);
        media.delete(key);
    }
    // A fresh snapshot of the same document replaces the boxes. Keep the
    // native buffers of an active stream and move its player to the new box.
    function keepRelayedPlayers(previous, next) {
        if (!previous || previous.gen !== next.gen) return;
        const active = new Map();
        for (const [key, entry] of media) {
            if (entry.top === previous && entry.asked && entry.src.startsWith("blob:tabtop-media/")) {
                active.set(entry.src, { key, entry });
            }
        }
        for (const [key, entry] of media) {
            if (entry.top !== next) continue;
            const kept = active.get(entry.src);
            if (!kept || kept.entry.kind !== entry.kind) continue;
            active.delete(entry.src);
            forgetMedia(key);
            mediaVisibility.unobserve(kept.entry.box);
            mediaSizes.unobserve(kept.entry.box);
            entry.box.textContent = kept.entry.box.textContent;
            mediaOf.get(entry.box).key = kept.key;
            media.set(kept.key, { ...entry, asked: true, play: kept.entry.play });
            mediaVisibility.observe(entry.box);
            mediaSizes.observe(entry.box);
        }
    }
    function mediaStyle(box) {
        const { size, style } = mediaOf.get(box);
        box.style.cssText = style;
        box.style.setProperty("--tabtop-media-width", size.width || "initial");
        box.style.setProperty("--tabtop-media-height", size.height || "initial");
        box.style.setProperty("--tabtop-media-ratio", size.aspectRatio || "initial");
        mediaLater();
    }
    function mediaBox(d, n, tag) {
        const box = document.createElement("div");
        box.setAttribute(drawnAs[tag], "");
        for (const name of ["id", "class", "title", "style"]) {
            const value = attrOf(n, name);
            if (value) attribute(d, box, HTML, "div", name, value);
        }
        const dimension = (name) => {
            const value = attrOf(n, name);
            return /^\d{1,5}$/.test(value) ? value + "px" : "";
        };
        // Its height from its width, as a video's is, until its own
        // proportions are known (the page says, below).
        const w = Number(attrOf(n, "width")), h = Number(attrOf(n, "height"));
        own(d, n.i, box);
        const info = {
            tag, key: 0, src: attrOf(n, "src") || null, poster: tag === "video" ? attrOf(n, "poster") : "",
            muted: hasAttr(n, "muted"), loop: hasAttr(n, "loop"), play: hasAttr(n, "autoplay"),
            size: { width: dimension("width"), height: dimension("height"), aspectRatio: tag === "video" ? (w > 0 && h > 0 ? `${w} / ${h}` : "16 / 9") : "" },
            style: "",
        };
        mediaOf.set(box, info);
        mediaStyle(box);
        mediaSource(d, box, info.src || firstSource(n.c));
        return box;
    }
    // Its own file, or else its first source's.
    function firstSource(kids) {
        for (const k of Array.isArray(kids) ? kids : []) {
            if (k?.t === 1 && String(k.n).toLowerCase() === "source" && attrOf(k, "src")) return attrOf(k, "src");
        }
        return "";
    }
    // mediaSource has a box play src: a player of its own, the one it had
    // (if any) stopped. A feed that plays one player after another changes
    // its file as it goes.
    function mediaSource(d, box, src) {
        const info = mediaOf.get(box);
        if (!info) return;
        if (info.key) forgetMedia(info.key);  // its player stops (keep, in the page)
        info.key = 0;
        const what = info.tag === "video" ? "video" : "sound";
        if (/^blob:/i.test(src) && !/^blob:tabtop-media\/[1-9]\d*$/.test(src)) {
            // Fed by the page's own player (Media Source): nothing a player
            // here could read.
            box.textContent = `This ${what} is streamed by the site's own player, which can't play here.`;
            leave(d, info.tag);
            mediaLater();
            return;
        }
        const url = /^blob:tabtop-media\/[1-9]\d*$/.test(src) ? src : src && web(src, d.base);
        if (!url) {
            box.textContent = `A ${what} with nothing to play.`;
            mediaLater();
            return;
        }
        box.textContent = `Loading the ${what}…`;
        const key = info.key = ++mediaKey;
        const poster = info.tag === "video" ? web(info.poster, d.base) : null;
        // Of the document it's in once shown (an embedded page's box, of its
        // page's): not asked for, nor dropped, before that.
        media.set(key, { top: d.top ?? d, box, kind: info.tag, src: url, poster, muted: info.muted, loop: info.loop, play: info.play, asked: false });
        mediaVisibility.observe(box);
        mediaSizes.observe(box);
        mediaLater();
    }
    // mediaChanged follows what the page changed of a player (op, a batch's)
    // to its box: true if it was the box's, not the page's element's.
    function mediaChanged(d, box, op) {
        const info = mediaOf.get(box);
        if (!info) return false;
        if (op.o === "c") {
            // Its sources: its children aren't drawn.
            if (!info.src) mediaSource(d, box, firstSource(op.c));
            return true;
        }
        if (op.o === "m") {
            info.play = op.v === true;
            const m = media.get(info.key);
            if (!m) return true;
            m.play = info.play;
            if (m.asked && doc && m.top === doc) tell({ type: "media-play", gen: doc.gen, key: info.key, play: m.play });
            return true;
        }
        if (op.o !== "a") return false;
        const name = String(op.n).toLowerCase(), v = op.v === null ? null : String(op.v);
        switch (name) {
            case "style":
                if (v !== null) return false;
                info.style = "";
                mediaStyle(box);
                return true;
            case "width": case "height":
                info.size[name] = /^\d{1,5}$/.test(v ?? "") ? v + "px" : "";
                mediaStyle(box);
                return true;
            case "src":
                // A relayed source already has live native buffers. A
                // repeated assignment must not destroy that connection.
                if (v === info.src && v?.startsWith("blob:tabtop-media/")) return true;
                info.src = v;
                mediaSource(d, box, v ?? "");
                return true;
            case "poster":
                info.poster = v ?? "";
                return true;
            case "muted": case "loop":
                info[name] = v !== null;
                return true;
            case "autoplay":
                info.play = v !== null;
                return true;
        }
        return false;
    }
    // Match the browser's clipping, including the containing block of an
    // absolutely positioned video. Keep the clip relative to the box while
    // it moves between intersection callbacks.
    function mediaClip(rect, entry) {
        if (!entry?.isIntersecting) return null;
        const box = entry.boundingClientRect, visible = entry.intersectionRect;
        const x = Math.max(0, rect.left + visible.left - box.left);
        const y = Math.max(0, rect.top + visible.top - box.top);
        const right = Math.min(innerWidth, rect.right - (box.right - visible.right));
        const bottom = Math.min(innerHeight, rect.bottom - (box.bottom - visible.bottom));
        return { x, y, width: right - x, height: bottom - y };
    }
    // windowClip is what of rect is in the window, if enough to show.
    function windowClip(rect) {
        const x = Math.max(0, rect.x), y = Math.max(0, rect.y);
        const right = Math.min(innerWidth, rect.x + rect.width), bottom = Math.min(innerHeight, rect.y + rect.height);
        return right - x >= 8 && bottom - y >= 8 ? { x, y, width: right - x, height: bottom - y } : null;
    }
    // mediaLater asks the page for players for new boxes, and tells it where
    // the boxes are, after this task (the box laid out).
    function mediaLater() {
        if (mediaSoon) return;
        mediaSoon = true;
        requestAnimationFrame(() => {
            mediaSoon = false;
            if (!doc) return;
            const positions = [];
            const opening = [];
            for (const [key, m] of media) {
                if (m.top !== doc) continue;  // a document being built
                if (!m.box.isConnected) {
                    forgetMedia(key);
                    continue;
                }
                const r = m.box.getBoundingClientRect();
                const rect = { x: r.x, y: r.y, width: r.width, height: r.height };
                const geometry = `${innerWidth}:${innerHeight}:${r.width}:${r.height}`;
                if (geometry !== m.geometry) {
                    m.geometry = geometry;
                    m.intersection = null;
                    mediaVisibility.unobserve(m.box);
                    mediaVisibility.observe(m.box);
                }
                // An unset intersection is waiting for a fresh measurement.
                // Keep an open player alive through the layout transition:
                // one shown stays shown, on its box where it is now, cut to
                // the window till it's measured (else it blinks out as the
                // window turns, or a keyboard comes up).
                if (!m.intersection) {
                    const clip = m.asked && m.shown ? windowClip(rect) : null;
                    if (clip) positions.push({ key, rect, clip, shown: true, fit: m.fit, position: m.position });
                    else if (m.asked) positions.push({ key, rect, shown: false });
                    continue;
                }
                const clip = mediaClip(r, m.intersection);
                const { objectFit: fit, objectPosition: position, visibility } = getComputedStyle(m.box);
                // In view, or played by the page, it's played (hidden too, as
                // a browser's is: a page may show a player, and move it to
                // where it's seen, only once its video plays, YouTube's
                // Shorts as it goes to the next); laid over its box when shown.
                const inView = clip !== null && clip.width >= 8 && clip.height >= 8;
                const shown = visibility === "visible" && inView;
                const relayed = m.src.startsWith("blob:tabtop-media/");
                if (m.kind === "video" && !inView && !m.play && !relayed) {
                    if (m.asked) m.box.textContent = "";
                    m.asked = false;
                    continue;
                }
                const at = { key, rect, clip, shown, fit, position };
                if (!m.asked && (inView || m.play || relayed)) {
                    m.asked = true;
                    opening.push({ ...at, type: "media", gen: doc.gen, kind: m.kind, src: m.src, poster: m.poster, muted: m.muted, loop: m.loop, play: m.play });
                }
                if (m.asked) positions.push(at);
                Object.assign(m, { shown: m.asked && shown, fit, position });
            }
            tell({ type: "media-positions", gen: doc.gen, positions });
            for (const message of opening) tell(message);
        });
    }
    window.addEventListener("scroll", mediaLater, { passive: true, capture: true });
    window.addEventListener("resize", mediaLater);
    // Observers of the document's root: watching each page's, as each
    // replaces the last (see render).
    const rootWatchers = new Set();
    function watchRoot(observer) {
        if (observer) rootWatchers.add(observer);
        for (const o of observer ? [observer] : rootWatchers) {
            o.disconnect();
            if (document.documentElement) o.observe(document.documentElement);
        }
    }
    watchRoot(new ResizeObserver(mediaLater));

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
        if (ns === HTML && tag === "iframe") return embeddedFrame(d, n);
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
        if (ns === HTML && (tag === "video" || tag === "audio")) return mediaBox(d, n, tag);
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
            let made = sheets.get(href);
            const cached = !!made;
            if (made) {
                sheets.delete(href);
                sheets.set(href, made);  // most recently used
            } else {
                // Rewritten for the tab, as this page reads it: what it
                // imports counts against this page's budget as it's read,
                // and it stops if the page goes. Kept only if it was read
                // whole (one stopped part way isn't the stylesheet).
                const own = cssBudget();
                const budget = {
                    charge(text) { own.charge(text); d.budget.charge(text); },
                    sheet() { own.sheet(); d.budget.sheet(); },
                };
                let cut = false;
                const live = () => alive(d)() || !(cut = true);
                made = (async () => stylesheet(await (await resource("css", href)).text(), href, budget, live))();
                sheets.set(href, made);
                made.then((css) => {
                    if (sheets.get(href) !== made) return;
                    if (cut) {
                        sheets.delete(href);
                        return;
                    }
                    sheetChars += css.length;
                    while (sheetChars > MAX_SHEET_CHARS && sheets.size > 1) {
                        const [oldest, old] = sheets.entries().next().value;
                        sheets.delete(oldest);
                        old.then((c) => (sheetChars -= c.length), () => {});
                    }
                }, () => sheets.get(href) === made && sheets.delete(href));
            }
            const fresh = !cached;
            const css = await made;
            if (!fresh) d.budget.charge(css);  // read before: counted now
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

    // keptFocus is what has the focus in d, to give back once it's read
    // again (giveFocus): its number, its caret, and its value if what's
    // typed in it hasn't been sent yet (else the page's, as read: a page
    // may clear a field itself).
    function keptFocus(d) {
        const el = document.activeElement;
        const id = d && el ? d.ids.get(el) : undefined;
        if (!id) return null;
        const kept = { id };
        if (textLike(el)) {
            if (pending.has(el)) kept.value = el.value;
            try { kept.caret = [el.selectionStart, el.selectionEnd]; } catch { /* no caret */ }
        }
        return kept;
    }
    function giveFocus(d, kept) {
        const el = d.nodes.get(kept.id);
        if (!el || el.nodeType !== 1) return;
        if (kept.value !== undefined && textLike(el)) el.value = kept.value;
        el.focus({ preventScroll: true });
        if (kept.caret) try { el.setSelectionRange(...kept.caret); } catch { /* no caret */ }
    }

    function render(m) {
        current = m.gen;
        fontGen = m.gen;
        const d = newDoc(m);
        building = d;
        lastChange = performance.now();


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
            // Settled: no change for a moment, with nothing loading; its
            // changes so far are in it, and their stylesheets come.
            const styled = performance.now();
            while (!m.again && performance.now() - styled < SETTLE_MAX) {
                const quiet = performance.now() - lastChange >= SETTLE_QUIET;
                if (quiet && !(netBusy && netGen === d.gen) && !d.waits.length) break;
                if (d.waits.length) {
                    const waits = d.waits;
                    d.waits = [];
                    await Promise.race([Promise.allSettled(waits), new Promise((resolve) => setTimeout(resolve, FRESH_WAIT))]);
                } else {
                    await new Promise((resolve) => setTimeout(resolve, 100));
                }
                if (!alive(d)()) return;
            }
            d.waits = [];
            // The same document read again: what has the focus here keeps
            // it, with its caret and what's typed in it that the engine
            // hasn't had yet (an engine whose changes come as whole reads,
            // Lightpanda, reads a page again as the person types).
            const focused = m.again ? keptFocus(doc) : null;
            // (Document.replaceChildren refuses a second element even as
            // it replaces the first.)
            document.documentElement ? document.documentElement.replaceWith(root) : document.append(root);
            watchRoot();
            const defaults = document.createElement("style");
            defaults.textContent = MEDIA_DEFAULTS;
            (root.querySelector("head") ?? root).prepend(defaults);
            unobserveAll(doc);
            if (m.again) keepRelayedPlayers(doc, d);
            // The same document still shown here (read again): it keeps its
            // place; a copy built afresh (a tab taken back after a reload)
            // starts where the page in the engine is scrolled.
            const kept = doc?.gen === d.gen;
            doc = d;
            fontsFor(d.gen);  // the last page's faces gone
            // Boxes of this document only (the page stops the others').
            for (const [key, m] of media) if (m.top !== d && m.top.gen <= d.gen || m.top === d && !m.box.isConnected) forgetMedia(key);
            mediaLater();
            observeAll(d, m.io);
            if (d.ioLater) {
                observeAll(d, d.ioLater);  // observed as it was built
                d.ioLater = null;
            }
            if (m.again) {
                const engineAt = Array.isArray(m.at) && m.at.length === 2 && m.at.every((v) => Number.isFinite(v) && v >= 0) ? m.at : null;
                if (!kept && engineAt) scrollTo(engineAt[0], engineAt[1]);
                else scrollTo(at.x, at.y);  // the same document, read again
                if (focused) giveFocus(d, focused);
            } else {
                const hash = d.url ? new URL(d.url).hash.slice(1) : "";
                hash ? scrollToFragment(hash) : scrollTo(0, 0);
            }
            tell({ type: "rendered", gen: d.gen, report: d.report });
            if (building === d) building = null;
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
                    const was = rec.size && d.sized?.get(el);
                    if (was) {
                        was.os.delete(x.o);
                        if (!was.os.size) d.sized.delete(el);
                    }
                    ioCount--;
                }
                continue;
            }
            if (x.op !== "+" || ioCount >= MAX_IO) continue;
            if (!rec && typeof x.s === "string") {
                // A ResizeObserver's: its sizes here go back (see sized).
                rec = { observer: new ResizeObserver((entries) => sized(d, entries.map((e) => e.target))), ids: new WeakMap(), size: true };
                d.io.set(x.o, rec);
            }
            if (rec?.size) {
                if (rec.ids.has(el)) continue;
                rec.ids.set(el, x.i);
                rec.observer.observe(el);
                const was = (d.sized ??= new Map()).get(el);
                if (was) {
                    was.os.add(x.o);
                    was.last = "";  // the new observer's told too
                } else {
                    d.sized.set(el, { i: x.i, os: new Set([x.o]), last: "" });
                }
                ioCount++;
                continue;
            }
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
    // An element the page watches the size of: its sizes here (the
    // engine's layout isn't this one), when they change: on this browser's
    // ResizeObserver, and after changes or scrolling (what's in it grown,
    // which no ResizeObserver tells).
    const MAX_SIZED_CHECK = 500;
    function sizesOf(el) {
        const cs = getComputedStyle(el);
        const pad = (a, b) => (parseFloat(cs[a]) || 0) + (parseFloat(cs[b]) || 0);
        const border = (a, b) => (parseFloat(cs[a]) || 0) + (parseFloat(cs[b]) || 0);
        const r = el.getBoundingClientRect();
        const ow = el.offsetWidth ?? r.width, oh = el.offsetHeight ?? r.height;
        const round = (v) => Math.max(0, Math.round(v * 100) / 100);
        const cw = ow - pad("paddingLeft", "paddingRight") - border("borderLeftWidth", "borderRightWidth");
        const ch = oh - pad("paddingTop", "paddingBottom") - border("borderTopWidth", "borderBottomWidth");
        return [el.clientWidth, el.clientHeight, el.scrollWidth, el.scrollHeight, ow, oh, cw, ch].map(round);
    }
    function sized(d, elements) {
        if (d !== doc) return;
        for (const el of elements) {
            const rec = d.sized?.get(el);
            if (!rec || !el.isConnected) continue;
            const z = sizesOf(el);
            const key = z.join();
            if (key === rec.last) continue;
            rec.last = key;
            for (const o of rec.os) ioSeen.push({ o, i: rec.i, z });
        }
        if (ioTimer || !ioSeen.length) return;
        ioTimer = setTimeout(() => {
            ioTimer = 0;
            const list = ioSeen;
            ioSeen = [];
            if (doc === d && list.length) tell({ type: "io", gen: d.gen, entries: list });
        }, 100);
    }
    let sizedTimer = 0;
    function sizedSoon() {
        if (sizedTimer || !doc?.sized?.size) return;
        sizedTimer = setTimeout(() => {
            sizedTimer = 0;
            const d = doc;
            if (!d?.sized) return;
            sized(d, [...d.sized.keys()].slice(0, MAX_SIZED_CHECK));
        }, 200);
    }
    // Where the page scrolled its elements itself: scrolled so here (the
    // engine's layout isn't this one), and where that ends up goes back as
    // the person's scrolling does (see the scroll listener).
    // Where it is goes back even if it didn't move (a browser's page hears
    // its scrolling; the engine's didn't move it, or not there), but not a
    // place the engine was last told: a page asking again for where this
    // can't go isn't answered again and again.
    let pageScrolled = -Infinity;
    const toldAt = new WeakMap();  // element -> where the engine was last told it is
    const scrollOf = (el) => (el === document.documentElement ? { x: scrollX, y: scrollY } : { x: el.scrollLeft, y: el.scrollTop });
    function tellScrolled(el) {
        const id = doc?.ids.get(el);
        if (!id) return;
        const at = scrollOf(el), x = Math.round(at.x), y = Math.round(at.y);
        if (toldAt.get(el) === x + "," + y) return;
        toldAt.set(el, x + "," + y);
        send("scroll", id, { sx: x, sy: y });
    }
    function scrollAsked(d, list) {
        if (!Array.isArray(list)) return;
        const asked = [];
        for (const s of list.slice(0, 64)) {
            const el = d.nodes.get(s?.i);
            if (el?.nodeType !== 1 || !el.isConnected) continue;
            pageScrolled = performance.now();
            if (Array.isArray(s.into)) {
                const [block, inline] = s.into.map(String);
                try { el.scrollIntoView({ block, inline }); } catch { /* not a place */ }
                // What it scrolled: its scrolling ancestors.
                for (let p = el.parentElement; p; p = p.parentElement) {
                    if (p === document.documentElement || p.scrollHeight > p.clientHeight || p.scrollWidth > p.clientWidth) asked.push(p);
                }
            } else if (Number.isFinite(s.x) && Number.isFinite(s.y)) {
                const top = el === document.documentElement || el === document.body;
                if (top) scrollTo({ left: s.x, top: s.y, behavior: "instant" });
                else el.scrollTo({ left: s.x, top: s.y, behavior: "instant" });
                // The engine's page has it where it asked.
                toldAt.set(top ? document.documentElement : el, Math.round(s.x) + "," + Math.round(s.y));
                asked.push(top ? document.documentElement : el);
            }
        }
        // Once it's there (a smooth scroll goes on, and says so itself).
        if (asked.length) setTimeout(() => { if (doc === d) for (const el of asked) tellScrolled(el); }, 50);
    }
    function unobserveAll(d) {
        for (const rec of d?.io.values() ?? []) rec.observer.disconnect();
        d?.io.clear();
        d?.sized?.clear();
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
    // Changes that come while a document is being built (its stylesheets
    // waited for) are its: kept, and applied once it's shown, in order.
    // Dropped, the next would name nodes this copy never had, and the whole
    // page would be read again.
    let building = null;
    let lastChange = 0;   // when the page being built last changed
    let netBusy = false;  // the engine has something loading for it
    let netGen = 0;
    // Batches for the page shown are drawn together, once a frame: a page
    // that sends many in a moment isn't drawn in each of its states.
    let batches = [];
    let batchesSoon = false;
    function apply(m) {
        if (building && m.gen === building.gen) {
            // To the page being built, out of view, as it comes.
            lastChange = performance.now();
            applyTo(building, m);
            return;
        }
        batches.push(m);
        if (batchesSoon) return;
        batchesSoon = true;
        requestAnimationFrame(() => {
            batchesSoon = false;
            const list = batches;
            batches = [];
            const d = doc;
            if (!d) return;
            d.fresh = [];
            for (const b of list) if (b.gen === d.gen) applyTo(d, b);
            hideUntilStyled(d, d.fresh);
            d.fresh = null;
        });
    }
    // hideUntilStyled keeps what a batch added out of sight until the
    // stylesheets it brought have come (FRESH_WAIT at most), so it isn't
    // seen unstyled.
    function hideUntilStyled(d, fresh) {
        const waits = d.waits;
        d.waits = [];
        if (!waits.length || !fresh.length) return;
        for (const el of fresh) el.setAttribute("data-go-wait", "");
        Promise.race([Promise.allSettled(waits), new Promise((resolve) => setTimeout(resolve, FRESH_WAIT))])
            .then(() => { for (const el of fresh) el.removeAttribute("data-go-wait"); });
    }
    function applyTo(d, m) {
        if (!d || m.gen !== d.gen) return;
        if (d === doc) {
            sizedSoon();  // what it changes may change watched sizes
            // and whether a player shows (a page hides one as it moves it to
            // the next video, by its style or an ancestor's): looked at again.
            if (media.size) mediaLater();
        }
        // (A batch may bring only what the page observes: no changes.)
        for (const op of Array.isArray(m.ops) ? m.ops : []) {
            if (!op || typeof op !== "object") continue;
            const target = d.nodes.get(op.i);
            if (target === undefined) return resync(d);
            if (op.o === "t" && d.styleOf.has(op.i)) {
                d.styleText.set(op.i, String(op.v ?? ""));
                restyle(d, d.styleOf.get(op.i));
                continue;
            }
            if (target === null) continue;  // left out
            if (target.nodeType === 1 && mediaChanged(d, target, op)) continue;
            switch (op.o) {
                case "c":
                    if (frameRoots.has(target)) {
                        // An embedded page read in a world of its own: which
                        // document it is (its world, the server's word).
                        renderFrame(d, target, op.c, Number.isSafeInteger(op.f) ? op.f : 0);
                        break;
                    }
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
        // Stylesheets of what was added: waited for by the page being built,
        // or (hideUntilStyled) by what the batch added to the page shown.
        if (d !== building && !d.fresh) d.waits = [];
        // What the page observes, seen once it's shown: observed out of
        // view, an element's first report (not in view) would be dropped,
        // and one that's still not in view once shown never reported.
        if (d === building) (d.ioLater ??= []).push(...(Array.isArray(m.io) ? m.io : []));
        else observeAll(d, m.io);
        if (d === doc) scrollAsked(d, m.scrolls);
        mediaLater();  // boxes added, gone or moved
        if (typeof m.title === "string") tell({ type: "title", gen: d.gen, title: m.title });
    }

    // reconcile makes parent's children the ones listed, building those new
    // and moving those already shown, leaving any in place in place.
    function reconcile(d, parent, kids) {
        if (!Array.isArray(kids)) return true;
        if (frameRoots.has(parent)) {
            renderFrame(d, parent, kids);
            return true;
        }
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
                if (n?.nodeType === 1 && d.fresh) d.fresh.push(n);
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

    function hasAttr(n, name) {
        const attrs = Array.isArray(n.a) ? n.a : [];
        for (let i = 0; i + 1 < attrs.length; i += 2) if (typeof attrs[i] === "string" && attrs[i].toLowerCase() === name) return true;
        return false;
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
    // targetOf is what node is to the engine: its number in the page (id),
    // or, in an embedded page's copy, its number there (frame) with its
    // iframe's (id); and the node numbered. An event's own target is the
    // first of its path (one in a copy is retargeted to the copy's box).
    const real = (e) => e.composedPath?.()[0] ?? e.target;
    function targetOf(node) {
        const root = node?.getRootNode?.();
        if (root instanceof ShadowRoot) {
            const fr = frameRoots.get(root.host), host = doc?.ids.get(root.host);
            for (let n = node; n && n !== root && fr?.child && host; n = n.parentNode) {
                const i = fr.child.ids.get(n);
                if (i) return { id: host, frame: i, fdoc: fr.docOf ?? 0, node: n };
            }
            return null;
        }
        const at = idOf(node);
        return at && { ...at, frame: 0 };
    }
    function send(kind, id, extra = {}) {
        if (!doc || current !== doc.gen) return;
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
        const at = targetOf(field);
        if (at) send("input", at.id, { value: field.value, frame: at.frame, fdoc: at.fdoc });
    }
    function flushAll(within) {
        for (const field of [...pending.keys()]) if (!within || within.contains(field)) flush(field);
    }
    const textLike = (el) => el.localName === "textarea" || el.localName === "input"
        && !/^(checkbox|radio|file|image|submit|reset|button|range|color|date|datetime-local|month|time|week)$/i.test(el.type);

    // The layout's size (the frame's but for its scroll bars), told the page
    // above as it changes: the engine's window is made it (see go.js's view).
    let laidOut = "";
    function tellLayout() {
        const w = document.documentElement.clientWidth, h = document.documentElement.clientHeight;
        if (!token || !w || !h || laidOut === w + "x" + h) return;
        laidOut = w + "x" + h;
        tell({ type: "layout", w, h });
    }
    watchRoot(new ResizeObserver(tellLayout));

    // The frame made shorter (a device's keyboard come up): the field being
    // typed in kept in view.
    window.addEventListener("resize", () => {
        const a = document.activeElement;
        if (a?.nodeType === 1 && textLike(a)) a.scrollIntoView({ block: "nearest" });
    });

    let lastClick = 0;
    let labelled = null;  // the field of the label clicked last
    let lastEnter = 0;
    let lastActivation = 0;  // an Enter or Space given to the engine as a key

    // --- The mouse: given to the engine as input (see goinput.go) -----------
    //
    // Each event names the element under the pointer and where within it, as
    // fractions across and down: places here aren't the engine's. The engine
    // makes the click from the press and release, as a browser does.
    const mods = (e) => ({ shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey });
    const where = (e) => whereAt(e.clientX, e.clientY);
    function whereAt(cx, cy) {
        // What's under the pointer, not the event's target: a button pressed
        // keeps the mouse (its release, and moves while dragging, are its,
        // wherever they are).
        const under = document.elementFromPoint(cx, cy);
        if (!under) return null;  // outside the frame
        const at = idOf(under);
        if (!at || at.node.nodeType !== 1) return null;
        const f = (v, size) => (size > 0 ? Math.min(1, Math.max(0, v / size)) : 0.5);
        const place = (n) => {
            const r = n.getBoundingClientRect();
            return { fx: Math.round(f(cx - r.left, r.width) * 1000) / 1000, fy: Math.round(f(cy - r.top, r.height) * 1000) / 1000 };
        };
        // Over an embedded page's copy: its element, by its page's own
        // number (frame), with its iframe's (id): the engine gives it to the
        // page in the frame there, by script (its places there needn't be
        // these: the frame's size and scroll differ).
        const fr = frameRoots.get(at.node);
        if (fr) {
            const inner = at.node.shadowRoot?.elementFromPoint?.(cx, cy);
            for (let n = inner; n && fr.child; n = n.parentNode) {
                const i = fr.child.ids.get(n);
                if (i && n.nodeType === 1) return { id: at.id, frame: i, fdoc: fr.docOf ?? 0, ...place(n) };
            }
            return null;
        }
        return { id: at.id, ...place(at.node) };
    }
    let held = 0;  // buttons pressed here, not yet released
    let pressedAt = null;
    document.addEventListener("mousedown", (e) => {
        if (!e.isTrusted || fromTouch(e)) return;
        const w = where(e);
        if (!w) return;
        flushAll();
        lastClick = performance.now();
        held |= 1 << e.button;
        pressedAt = w;
        send("mouse", w.id, { phase: "down", frame: w.frame, fdoc: w.fdoc, fx: w.fx, fy: w.fy, button: e.button, buttons: e.buttons, count: e.detail || 1, ...mods(e) });
    }, true);
    document.addEventListener("mouseup", (e) => {
        if (!e.isTrusted || fromTouch(e) || !(held & (1 << e.button))) return;
        held &= ~(1 << e.button);
        const w = where(e);
        lastClick = performance.now();
        // Let go outside the frame: let go, away from what was pressed (no
        // click).
        if (!w) send("mouse", 0, { phase: "cancel", button: e.button });
        else send("mouse", w.id, { phase: "up", frame: w.frame, fdoc: w.fdoc, fx: w.fx, fy: w.fy, button: e.button, buttons: e.buttons, count: e.detail || 1, ...mods(e) });
    }, true);
    // Let go outside the frame, or the window left: nothing stays pressed.
    const cancel = () => {
        if (!held || !doc) return;
        held = 0;
        send("mouse", 0, { phase: "cancel" });
    };
    window.addEventListener("blur", cancel);
    document.addEventListener("mousemove", (e) => {
        if (held && !e.buttons) cancel();
    }, true);
    // Moves and the wheel: the newest every 50 ms at most (the wheel's
    // turns added up), as pages follow the pointer, not every pixel.
    let move = null, wheel = null, touchMove = null, pointerTimer = 0;
    function pointerSoon() {
        if (pointerTimer) return;
        pointerTimer = setTimeout(() => {
            pointerTimer = 0;
            if (move) send("mouse", move.id, move);
            if (wheel) send("mouse", wheel.id, wheel);
            if (touchMove) send("touch", touchMove.points[0].id, touchMove);
            if (dragOver) send("drag", dragOver.id, dragOver);
            move = wheel = touchMove = dragOver = null;
        }, 50);
    }

    // --- Touch: given to the engine as touch input (see goinput.go) -------
    //
    // Each finger as the element under it and where within it, as the
    // mouse's; moves as the mouse's, the newest every 50 ms. The engine
    // makes a tap's click itself (and a swipe's none), so the mouse events
    // this browser makes from a touch aren't sent too. Swiping scrolls the
    // copy here, as before, and where it's scrolled to goes as the person's
    // scrolling does.
    // A finger over an embedded page's copy isn't a touch there (the engine
    // finds a touch's place by the iframe, and the frame's places aren't
    // these): a tap is a press and release on what's under it, by the
    // agent in the frame, as the mouse's are; a swipe scrolls the copy.
    let lastTouch = -Infinity;
    let touchFrom = null, touchMoved = false, touchSent = false, frameTap = null;
    const fromTouch = (e) => e.sourceCapabilities?.firesTouchEvents || performance.now() - lastTouch < 1000;
    function fingers(list) {
        const out = [];
        for (const t of list) {
            const w = whereAt(t.clientX, t.clientY);
            // (Where it is on the screen too: it's moved by that, see goinput.go.)
            if (w && !w.frame) out.push({ id: w.id, fx: w.fx, fy: w.fy, t: t.identifier & 0xffff, cx: Math.round(t.clientX * 10) / 10, cy: Math.round(t.clientY * 10) / 10 });  // a frame's place isn't its iframe's
            if (out.length >= 10) break;
        }
        return out;
    }
    function touchNow(phase, points, e) {
        if (touchMove) {
            send("touch", touchMove.points[0].id, touchMove);
            touchMove = null;
        }
        send("touch", points[0]?.id ?? 0, { phase, points, tap: !touchMoved, ...mods(e) });
    }
    document.addEventListener("touchstart", (e) => {
        if (!e.isTrusted) return;
        lastTouch = performance.now();
        if (e.touches.length === 1) {
            touchFrom = { x: e.touches[0].clientX, y: e.touches[0].clientY };
            touchMoved = false;
            frameTap = null;
            const w = whereAt(touchFrom.x, touchFrom.y);
            if (w?.frame) {
                frameTap = w;
                flushAll();
                return;
            }
        } else if (frameTap) {
            frameTap = null;  // more fingers: not a tap
            return;
        }
        const points = fingers(e.touches);
        if (!points.length) return;  // over nothing the engine has
        flushAll();
        touchNow("start", points, e);
        touchSent = true;
    }, { capture: true, passive: true });
    document.addEventListener("touchmove", (e) => {
        if (!e.isTrusted || !touchSent) return;
        lastTouch = performance.now();
        const t = e.touches[0];
        if (t && touchFrom && Math.hypot(t.clientX - touchFrom.x, t.clientY - touchFrom.y) > 10) touchMoved = true;
        const points = fingers(e.touches);
        if (!points.length) return;
        touchMove = { phase: "move", points, ...mods(e) };
        pointerSoon();
    }, { capture: true, passive: true });
    const tapInFrame = (e) => {
        const w = frameTap;
        frameTap = null;
        lastTouch = performance.now();  // the mouse events this browser makes of it aren't sent
        if (e.type !== "touchend" || e.touches.length) return;
        const t = e.changedTouches[0];
        if (touchMoved || !t || Math.hypot(t.clientX - touchFrom.x, t.clientY - touchFrom.y) > 10) return;
        lastClick = performance.now();
        const at = { frame: w.frame, fdoc: w.fdoc, fx: w.fx, fy: w.fy, button: 0, count: 1, ...mods(e) };
        send("mouse", w.id, { phase: "move", ...at, buttons: 0 });
        send("mouse", w.id, { phase: "down", ...at, buttons: 1 });
        send("mouse", w.id, { phase: "up", ...at, buttons: 0 });
    };
    document.addEventListener("touchmove", (e) => {
        const t = e.touches[0];
        if (frameTap && e.isTrusted && t && Math.hypot(t.clientX - touchFrom.x, t.clientY - touchFrom.y) > 10) touchMoved = true;
    }, { capture: true, passive: true });
    const touchEnd = (e) => {
        if (e.isTrusted && frameTap) return tapInFrame(e);
        if (!e.isTrusted || !touchSent) return;
        lastTouch = performance.now();
        const points = fingers(e.touches);
        if (e.touches.length && points.length) {
            touchNow("move", points, e);  // a finger lifted, others still down
            return;
        }
        // Where the last finger was let go: a flick quicker than its moves
        // are sent, still a swipe, not a tap (and the engine given where it
        // ended).
        const last = e.changedTouches?.[0];
        if (last && touchFrom && Math.hypot(last.clientX - touchFrom.x, last.clientY - touchFrom.y) > 10) {
            touchMoved = true;
            const ended = fingers([last]);
            if (ended.length) touchNow("move", ended, e);
        }
        touchNow(e.type === "touchcancel" ? "cancel" : "end", [], e);
        touchSent = false;
    };
    document.addEventListener("touchend", touchEnd, { capture: true, passive: true });
    document.addEventListener("touchcancel", touchEnd, { capture: true, passive: true });

    // --- Drag and drop -----------------------------------------------------
    //
    // A drag within the page is the engine's: it drags as a browser does,
    // from the mouse it's given (a draggable element, a sortable list). This
    // browser's own drag of the copy (an element, a picture, a link) would
    // take the mouse's moves and release, so it isn't started.
    document.addEventListener("dragstart", (e) => {
        if (e.isTrusted) e.preventDefault();
    }, true);
    // What's dragged in from outside (text, a link, from another window) is
    // given to the engine's page under it, and dropped there: its kinds as
    // it's dragged over (a browser shows no more till the drop), what it
    // is when dropped. Files aren't (the remote browser takes no files).
    const DRAG_TYPES = ["text/plain", "text/uri-list", "text/html"];
    const MAX_DROP = 32 << 10;  // within a message the server takes (goClientMessage)
    let dragOver = null;
    const dragTypes = (dt) => [...(dt?.types ?? [])].filter((t) => DRAG_TYPES.includes(t));
    for (const type of ["dragenter", "dragover"]) {
        document.addEventListener(type, (e) => {
            if (!e.isTrusted) return;
            e.preventDefault();  // it may be dropped (the engine's page says if it's taken)
            if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
            const w = where(e);
            if (!w) return;
            if (w.frame) {  // an embedded page's: not given (its places aren't the iframe's)
                if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
                if (dragOver) send("drag", 0, { phase: "cancel" });
                dragOver = null;
                return;
            }
            dragOver = { phase: "over", id: w.id, fx: w.fx, fy: w.fy, items: dragTypes(e.dataTransfer).map((t) => ({ type: t, data: "" })), ...mods(e) };
            pointerSoon();
        }, true);
    }
    document.addEventListener("dragleave", (e) => {
        if (!e.isTrusted || e.relatedTarget) return;  // left the frame, not one element for another
        dragOver = null;
        send("drag", 0, { phase: "cancel" });
    }, true);
    document.addEventListener("drop", (e) => {
        if (!e.isTrusted) return;
        e.preventDefault();  // not opened here
        dragOver = null;
        const dt = e.dataTransfer;
        if (dt?.files?.length) tell({ type: "drop-files", gen: doc?.gen });
        const w = where(e);
        if (!w || w.frame) {
            send("drag", 0, { phase: "cancel" });
            return;
        }
        let room = MAX_DROP;
        const items = [];
        for (const t of dragTypes(dt)) {
            const data = String(dt.getData(t) ?? "").slice(0, room);
            room -= data.length;
            items.push({ type: t, data });
        }
        if (!items.length) {
            send("drag", 0, { phase: "cancel" });
            return;
        }
        send("drag", w.id, { phase: "drop", fx: w.fx, fy: w.fy, items, ...mods(e) });
    }, true);
    document.addEventListener("mousemove", (e) => {
        if (!e.isTrusted || fromTouch(e)) return;
        const w = where(e);
        if (!w) return;
        move = { phase: "move", id: w.id, frame: w.frame, fdoc: w.fdoc, fx: w.fx, fy: w.fy, buttons: e.buttons, ...mods(e) };
        pointerSoon();
    }, true);
    document.addEventListener("wheel", (e) => {
        if (!e.isTrusted) return;
        const w = where(e);
        if (!w) return;
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1;
        wheel = { phase: "wheel", id: w.id, frame: w.frame, fdoc: w.fdoc, fx: w.fx, fy: w.fy, dx: (wheel?.frame === w.frame ? wheel?.dx ?? 0 : 0) + e.deltaX * unit, dy: (wheel?.frame === w.frame ? wheel?.dy ?? 0 : 0) + e.deltaY * unit, buttons: e.buttons, ...mods(e) };
        pointerSoon();
    }, { capture: true, passive: true });

    // scrollUnder does a wheel turn, or a finger's drag, done over a player
    // laid over a box here (go-media.js): the page under it scrolls, the
    // nearest that can, as the person's (given to the engine as their
    // scrolling is); a wheel goes to the engine as a wheel too.
    // A drag passed on is one scroll, as a finger's is: a box that snaps
    // (a feed's, a video to a screen) doesn't snap at each part of it, but
    // once it ends, on in the way it went, as a swipe goes on (or back, if
    // it hardly went).
    let dragging = null;  // {el, snap, dx, dy}
    function dragEnd() {
        const d = dragging;
        dragging = null;
        if (!d) return;
        d.el.style.scrollSnapType = d.snap;
        const on = (v) => (Math.abs(v) > 40 ? Math.sign(v) : 0);
        (d.el === document.documentElement ? window : d.el).scrollBy({ left: on(d.dx), top: on(d.dy), behavior: "smooth" });
    }
    function scrollUnder(m) {
        lastInput = performance.now();
        if (m.how === "drag-end") return dragEnd();
        const at = document.elementFromPoint(m.x, m.y);
        let scroller = null;
        for (let n = at; n && n !== document.documentElement; n = n.parentElement) {
            const st = getComputedStyle(n);
            if ((/(auto|scroll)/.test(st.overflowY) && n.scrollHeight > n.clientHeight) || (/(auto|scroll)/.test(st.overflowX) && n.scrollWidth > n.clientWidth)) {
                scroller = n;
                break;
            }
        }
        if (m.how === "drag") {
            const el = scroller ?? document.documentElement;
            if (dragging?.el !== el) {
                dragEnd();
                dragging = { el, snap: el.style.scrollSnapType, dx: 0, dy: 0 };
                el.style.scrollSnapType = "none";
            }
            dragging.dx += m.dx;
            dragging.dy += m.dy;
        }
        (scroller ?? window).scrollBy(m.dx, m.dy);
        if (m.how === "wheel") {
            const w = whereAt(m.x, m.y);
            if (w) {
                wheel = { phase: "wheel", id: w.id, fx: w.fx, fy: w.fy, dx: (wheel?.dx ?? 0) + m.dx, dy: (wheel?.dy ?? 0) + m.dy, buttons: 0 };
                pointerSoon();
            }
        }
    }

    // --- Scrolling: where the person scrolled to, given to the engine --------
    //
    // A swipe, a fling, a scrollbar dragged, a key: none is a wheel the
    // engine is given, yet a page (a feed that plays the video scrolled to)
    // goes by where it's scrolled. The newest place of each element scrolled
    // by the person, every 100 ms at most; not the copy's own scrolling (a
    // page shown at its top).
    let lastInput = -Infinity;
    for (const type of ["pointerdown", "touchstart", "touchmove", "wheel", "keydown"]) {
        document.addEventListener(type, (e) => { if (e.isTrusted) lastInput = performance.now(); }, { capture: true, passive: true });
    }
    const scrolled = new Map();  // element -> its place
    let scrollTimer = 0;
    document.addEventListener("scroll", (e) => {
        if (!e.isTrusted || !doc || (performance.now() - lastInput > 3000 && performance.now() - pageScrolled > 3000)) return;
        const el = e.target === document ? document.documentElement : e.target;
        if (el?.nodeType !== 1) return;
        scrolled.set(el, el === document.documentElement ? { x: scrollX, y: scrollY } : { x: el.scrollLeft, y: el.scrollTop });
        sizedSoon();
        if (scrollTimer) return;
        scrollTimer = setTimeout(() => {
            scrollTimer = 0;
            for (const el of scrolled.keys()) tellScrolled(el);
            scrolled.clear();
        }, 100);
    }, { capture: true, passive: true });

    document.addEventListener("click", (e) => {
        if (!e.isTrusted || e.button !== 0) return;
        const link = linkOf(e.target);
        // The page being replaced, held in view until the next settles: it
        // takes nothing (the engine has moved on; see send).
        if (doc && current !== doc.gen) {
            if (link || e.target.closest?.("a[href]")) e.preventDefault();
            return;
        }
        const at = idOf(e.target);
        if (link || e.target.closest?.("a[href='#']")) e.preventDefault();
        // A click by the mouse: the engine made its own, from the press and
        // release. One by a key it was given (Enter, Space): from that key.
        // Any other (a click by assistive software, say): by script, below.
        const byMouse = e.detail > 0 || e.pointerType === "mouse";
        const byKey = performance.now() - lastActivation < 300;
        if (at && (byMouse || byKey)) {
            if (link) followFragment(link);
            return;
        }
        // A click on a label clicks its field too: that's one click, the
        // label's (the engine's label clicks its own field).
        if (e.target === labelled && performance.now() - lastClick < 100) return;
        lastClick = performance.now();
        labelled = e.target.closest?.("label")?.control ?? null;
        if (link) followFragment(link);
        if (at) {
            flushAll();
            send("click", at.id);
        } else if (link) {
            tell({ type: "navigate", url: link });
        }
    }, true);
    // A link within the page scrolls here at once; the engine follows it too.
    function followFragment(link) {
        const to = new URL(link);
        const here = doc?.url ? new URL(doc.url) : null;
        if (here && to.hash && to.origin + to.pathname + to.search === here.origin + here.pathname + here.search) {
            scrollToFragment(to.hash.slice(1));
        }
    }
    document.addEventListener("auxclick", (e) => {
        const link = linkOf(e.target);
        if (link && e.button === 1) {
            e.preventDefault();
            tell({ type: "navigate", url: link });
        }
    }, true);
    document.addEventListener("input", (e) => {
        const el = real(e);
        if (!e.isTrusted || !textLike(el) || !targetOf(el)) return;
        clearTimeout(pending.get(el));
        pending.set(el, setTimeout(() => flush(el), 150));
    }, true);
    document.addEventListener("change", (e) => {
        const el = real(e);
        const at = targetOf(el);
        // (Boxes are ticked by their clicks; text by its typing.)
        if (!e.isTrusted || !at || at.node !== el || textLike(el) || el.type === "checkbox" || el.type === "radio") return;
        send("change", at.id, { value: String(el.value ?? ""), frame: at.frame, fdoc: at.fdoc });
    }, true);
    // Keys: given to the engine as keys, every one, to what has the focus
    // here (the engine gives it the focus first). What's typed is typed here
    // and sent as the field's value; the engine's keys type nothing, but do
    // what else keys do (Enter sends a form, Space presses a button).
    function keyEvent(e, type) {
        if (!e.isTrusted || e.isComposing || e.key === "Process" || e.key === "Dead") return;
        const at = targetOf(real(e));
        if (!at) return;
        flush(at.node);  // what was typed, before the key that may use it
        if (type === "down" && (e.key === "Enter" || e.key === " ")) lastActivation = performance.now();
        if (type === "down" && e.key === "Enter") lastEnter = performance.now();
        send("key", at.id, { phase: type, frame: at.frame, fdoc: at.fdoc, key: e.key, code: e.code, keyCode: e.keyCode, location: e.location, repeat: e.repeat, ...mods(e) });
    }
    document.addEventListener("keydown", (e) => keyEvent(e, "down"), true);
    document.addEventListener("keyup", (e) => keyEvent(e, "up"), true);
    // What has the focus here has it there, for the keys that follow.
    document.addEventListener("focusin", (e) => {
        if (!e.isTrusted) return;
        const n = real(e), at = targetOf(n);
        if (at && at.node === n && n.nodeType === 1) send("focus", at.id, { frame: at.frame, fdoc: at.fdoc });
    }, true);
    // Forms aren't sent from here (form-action 'none'): the engine sends
    // them. Enter in a field sends its form there already, with its key.
    document.addEventListener("submit", (e) => {
        e.preventDefault();
        // Sent by a click on its button, or Enter in a field: the engine
        // sends it, from those, already.
        if (performance.now() - lastEnter < 200 || performance.now() - lastClick < 200) return;
        const form = targetOf(real(e));
        if (!form) return;
        flushAll(real(e));
        const by = e.submitter ? targetOf(e.submitter) : null;
        send("submit", form.id, { submitter: (form.frame ? by?.frame : by?.id) || 0, frame: form.frame, fdoc: form.fdoc });
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
