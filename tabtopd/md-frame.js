// A Markdown preview's frame, served by tabtopd as md-frame.html. The files
// page shows it sandboxed, without allow-same-origin, so it runs at an
// origin of its own: nothing in it can read the site's session, or reach
// the page that holds it, whose only way in is the messages below. Its CSP
// lets it load scripts only from the site, and pictures only as blob: and
// data: URLs, so a document can't fetch anything from elsewhere, nor tell
// anyone it was opened.
//
// The page sends {type: "render", html, fragment}: the file as HTML, made
// and cleaned by tabtopd (see markdown.go), and a heading to scroll to, if
// any; it may send it again, as text being edited changes. This puts it
// in, adds a list of its contents if it has a few headings, then renders
// what it marked: math with KaTeX, as MathML, which browsers draw themselves;
// Mermaid diagrams, as SVG; and code blocks' colours, with highlight.js.
// Each is loaded only if the document has one. Pictures beside the file
// are asked of the page, {type: "image", id, src}, which fetches them
// through the tunnel and answers {id, bytes, mime} or {id, error}; others
// are left out. {type: "theme", theme} shows it light or dark ("" for as
// the system is). A link to another file, by a relative path, is passed to
// the page, {type: "open", href}, which shows that file instead. Once it's
// With format: "html", raw HTML is rebuilt from a formatting allowlist;
// scripts, forms, embeds, stylesheets and event handlers are discarded.
// Once done, it tells the page {type: "rendered", report}, what it rendered and
// what it couldn't.

"use strict";

(() => {
    // Where tabtopd serves the libraries (it rewrites these paths).
    const LIBS = "./preview/";
    const HIGHLIGHT = "./highlight/";
    const MORE_LANGUAGES = ["dockerfile", "dos", "latex", "nginx", "powershell", "scala"];
    const page = window.parent;

    let requestedPosition = null;
    let rendering = false;
    const position = () => ({ top: scrollY, left: scrollX });
    const waiting = new Map();
    let lastId = 0;
    function ask(message) {
        return new Promise((resolve) => {
            const id = ++lastId;
            waiting.set(id, resolve);
            page.postMessage({ ...message, id }, "*");
        });
    }

    window.addEventListener("message", (e) => {
        if (e.source !== page || !e.data || typeof e.data !== "object") {
            return;
        }
        const m = e.data;
        if (m.id && waiting.has(m.id)) {
            waiting.get(m.id)(m);
            waiting.delete(m.id);
        } else if (m.type === "render" && typeof m.html === "string") {
            requestedPosition = m.location ?? requestedPosition;
            render(m.html, typeof m.fragment === "string" ? m.fragment : "", m.format === "html");
        } else if (m.type === "restore" && m.location) {
            requestedPosition = m.location;
            scrollTo(m.location.left, m.location.top);
            if (!rendering) requestedPosition = null;
        } else if (m.type === "theme") {
            setTheme(m.theme);
        }
    });

    // Links: headings scroll here; external destinations are confirmed by
    // the parent; relative file links go to the parent to be previewed.
    document.addEventListener("click", (e) => {
        const a = e.target.closest("a[href]");
        const href = a?.getAttribute("href") ?? "";
        if (!a) return;
        e.preventDefault();
        if (/^(https?:|mailto:)/i.test(href)) {
            page.postMessage({ type: "external", href }, "*");
            return;
        }
        if (href.startsWith("#")) {
            const location = position();
            scrollToId(href.slice(1));
            if (scrollY !== location.top || scrollX !== location.left) {
                page.postMessage({ type: "navigate", location }, "*");
            }
        } else if (!/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) {
            page.postMessage({ type: "open", href, location: position() }, "*");
        }
    });

    document.addEventListener("auxclick", (e) => {
        const href = e.target.closest("a[href]")?.getAttribute("href") ?? "";
        if (e.button === 1 && /^(https?:|mailto:)/i.test(href)) {
            e.preventDefault();
            page.postMessage({ type: "external", href }, "*");
        }
    });

    function scrollToId(id) {
        try {
            document.getElementById(decodeURIComponent(id))?.scrollIntoView();
        } catch {
            // Not a heading's.
        }
    }

    // contents adds a list of doc's headings to its top, folded away, if it
    // has a few.
    function contents(doc) {
        const headings = [...doc.querySelectorAll("h1[id], h2[id], h3[id]")];
        if (headings.length < 3) {
            return;
        }
        const top = Math.min(...headings.map((h) => Number(h.tagName[1])));
        const list = document.createElement("ul");
        for (const h of headings) {
            const a = Object.assign(document.createElement("a"), { href: "#" + encodeURIComponent(h.id), textContent: h.textContent });
            const li = document.createElement("li");
            li.style.marginLeft = `${(Number(h.tagName[1]) - top) * 1.2}em`;
            li.append(a);
            list.append(li);
        }
        const box = Object.assign(document.createElement("details"), { className: "toc" });
        box.append(Object.assign(document.createElement("summary"), { textContent: `Contents (${headings.length})` }), list);
        const front = doc.querySelector(":scope > details.front-matter");
        front ? front.after(box) : doc.prepend(box);
    }

    let diagramCount = 0;

    const loaded = new Map();
    function load(src) {
        if (!loaded.has(src)) {
            loaded.set(src, new Promise((resolve, reject) => {
                const s = Object.assign(document.createElement("script"), { src });
                s.onload = resolve;
                s.onerror = () => reject(new Error(`couldn't load ${src.split("/").pop()}`));
                document.head.append(s);
            }));
        }
        return loaded.get(src);
    }

    function note(text, error = false) {
        return Object.assign(document.createElement("span"), { className: error ? "note error" : "note", textContent: text });
    }

    // Light or dark, as chosen in the preview, else as the system is; its
    // diagrams drawn again to match.
    const dark = () => document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark"
        : matchMedia("(prefers-color-scheme: dark)").matches;
    let shownHTML = null;
    let shownAsHTML = false;
    function setTheme(theme) {
        const was = dark();
        if (theme === "light" || theme === "dark") {
            document.documentElement.dataset.theme = theme;
        } else {
            delete document.documentElement.dataset.theme;
        }
        if (dark() !== was && shownHTML !== null && document.querySelector("#doc .diagram")) {
            render(shownHTML, "", shownAsHTML);
        }
    }

    // HTML is parsed in an inert template, then rebuilt from a small allowlist.
    // No original element is inserted into the live document: scripts, event
    // handlers, embedded documents, forms, network styles and custom elements
    // never become active. Images are handed to the normal tunnel loader.
    const HTML_TAGS = new Set(("a abbr address article aside b bdi bdo blockquote br caption cite code col colgroup dd del details dfn div dl dt em " +
        "figcaption figure footer h1 h2 h3 h4 h5 h6 header hr i img ins kbd li main mark nav ol p pre q rp rt ruby s samp section small " +
        "span strong sub summary sup table tbody td tfoot th thead time tr u ul var wbr").split(" "));
    const DROP_TAGS = new Set(("script style link meta base iframe frame frameset object embed applet form input textarea select button option " +
        "audio video source track canvas svg math noscript template title").split(" "));
    const HTML_STYLES = new Set(("color background-color font-family font-size font-style font-weight font-variant line-height letter-spacing " +
        "text-align text-decoration text-indent text-transform vertical-align white-space word-break overflow-wrap " +
        "width max-width min-width height max-height margin margin-top margin-right margin-bottom margin-left " +
        "padding padding-top padding-right padding-bottom padding-left border border-width border-style border-color border-collapse " +
        "border-spacing border-radius table-layout list-style-type").split(" "));
    // Raw HTML is reconstructed from inert nodes, unlike server-rendered
    // Markdown/EPUB. See docs/preview-security.md before changing this policy.
    function cleanHTML(html) {
        const template = document.createElement("template");
        template.innerHTML = html;
        const out = document.createDocumentFragment();
        const work = [{ node: template.content.firstChild, parent: out, depth: 0 }];
        let count = 0;
        let truncated = false;
        while (work.length) {
            const { node, parent, depth } = work.pop();
            if (!node) continue;
            if (++count > 50000) { truncated = true; break; }
            work.push({ node: node.nextSibling, parent, depth });
            if (node.nodeType === Node.TEXT_NODE) {
                parent.append(document.createTextNode(node.textContent));
                continue;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            const tag = node.localName;
            if (node.namespaceURI !== "http://www.w3.org/1999/xhtml" || DROP_TAGS.has(tag)) continue;
            if (depth > 128) { truncated = true; continue; }
            let target = parent;
            if (HTML_TAGS.has(tag)) {
                target = document.createElement(tag);
                parent.append(target);
                for (const attr of ["id", "title", "lang", "dir"]) {
                    const value = node.getAttribute(attr);
                    if (value !== null && value.length <= 1000) target.setAttribute(attr, value);
                }
                if (tag === "a") {
                    const href = node.getAttribute("href");
                    try {
                        if (href !== null && ["http:", "https:", "mailto:"].includes(new URL(href, "https://preview.invalid/").protocol)) {
                            target.setAttribute("href", href.startsWith("//") ? "https:" + href : href);
                        }
                    } catch { /* An invalid link remains plain text. */ }
                }
                if (tag === "img") {
                    for (const attr of ["src", "alt"]) {
                        if (node.hasAttribute(attr)) if (attr === "src") target.dataset.previewSrc = node.getAttribute(attr);
                        else target.setAttribute(attr, node.getAttribute(attr));
                    }
                }
                for (const attr of ["width", "height", "colspan", "rowspan"]) {
                    const value = node.getAttribute(attr);
                    if (/^\d{1,4}$/.test(value ?? "") && Number(value) > 0 && Number(value) <= (attr.endsWith("span") ? 100 : 4000)) {
                        target.setAttribute(attr, value);
                    }
                }
                if (tag === "details" && node.hasAttribute("open")) target.setAttribute("open", "");
                for (const property of HTML_STYLES) {
                    const value = node.style.getPropertyValue(property);
                    // Only simple formatting and color functions. Never URLs,
                    // CSS escapes, variables, generated content or layout overlays.
                    if (value && value.length <= 200 && !/[\\@\x00-\x1f]|(?:url|expression)\s*\(/i.test(value) &&
                        !/[a-z-]+\s*\(/i.test(value.replace(/(?:rgb|rgba|hsl|hsla)\([^()]*\)/gi, ""))) {
                        target.style.setProperty(property, value);
                    }
                }
            }
            work.push({ node: node.firstChild, parent: target, depth: depth + 1 });
        }
        if (truncated) out.append(note("This HTML document is too complex to show in full. View its source or download it."));
        return out;
    }

    // Renders are numbered: one begun later (the text edited again) makes
    // those before it stale, and what they make is dropped, not shown over
    // it. The pictures shown, as blob: URLs, are let go once they're not.
    let renders = 0;
    let shownURLs = [];

    async function render(html, fragment, htmlMode = false) {
        const me = ++renders;
        rendering = true;
        shownHTML = html;
        shownAsHTML = htmlMode;
        const urls = [];
        // Rendered again (as it's edited), it keeps where it was scrolled.
        const scrolled = position();
        const doc = document.createElement("main");
        doc.id = "doc";
        if (htmlMode) {
            doc.append(cleanHTML(html));
        } else {
            doc.innerHTML = html;
        }
        const report = { math: 0, diagrams: 0, code: 0, images: 0, remote: 0, contents: 0, errors: [] };
        for (const a of doc.querySelectorAll("a[href]")) {
            if (/^(https?:|mailto:)/i.test(a.getAttribute("href"))) {
                a.target = "_blank";
                a.rel = "noopener noreferrer";
            }
        }
        if (!htmlMode) contents(doc);
        report.contents = doc.querySelectorAll(".toc li").length;
        report.frontMatter = !!doc.querySelector(":scope > details.front-matter");

        // Pictures: beside the file, through the page; data: as they are;
        // from the web, not at all.
        for (const img of doc.querySelectorAll("img")) {
            const src = img.dataset.previewSrc ?? img.getAttribute("src") ?? "";
            delete img.dataset.previewSrc;
            if (/^data:image\//i.test(src)) {
                img.src = src;
                continue;
            }
            if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) {
                img.replaceWith(note(`Picture from the web, not loaded: ${img.alt || src}`));
                report.remote++;
                continue;
            }
            img.removeAttribute("src");
            const got = await ask({ type: "image", src });
            if (got.bytes) {
                img.src = URL.createObjectURL(new Blob([got.bytes], { type: got.mime }));
                urls.push(img.src);
                report.images++;
            } else {
                img.replaceWith(note(`${img.alt || src}: ${got.error ?? "not found"}`, true));
            }
        }

        const math = doc.querySelectorAll(".math");
        if (math.length) {
            try {
                await load(LIBS + "katex.min.js");
                for (const el of math) {
                    katex.render(el.textContent, el, { displayMode: el.classList.contains("display"), output: "mathml",
                        throwOnError: false, trust: false, maxSize: 50, maxExpand: 1000 });
                    report.math++;
                }
            } catch (err) {
                report.errors.push(`math: ${err.message}`);
            }
        }

        const code = doc.querySelectorAll("pre > code[class^='language-']");
        if (code.length) {
            try {
                await load(HIGHLIGHT + "classic/highlight.min.js");
                await Promise.all(MORE_LANGUAGES.map((l) => load(`${HIGHLIGHT}classic/languages/${l}.min.js`).catch(() => {})));
                for (const el of code) {
                    const lang = el.className.slice("language-".length);
                    if (hljs.getLanguage(lang)) {
                        el.textContent = el.textContent;  // only text, as hljs expects
                        hljs.highlightElement(el);
                        report.code++;
                    }
                }
            } catch (err) {
                report.errors.push(`code: ${err.message}`);
            }
        }

        const diagrams = doc.querySelectorAll("pre.mermaid");
        if (diagrams.length) {
            try {
                await load(LIBS + "mermaid.min.js");
                mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark() ? "dark" : "default" });
                for (const el of diagrams) {
                    try {
                        const { svg } = await mermaid.render(`diagram-${++diagramCount}`, el.textContent);
                        const box = Object.assign(document.createElement("div"), { className: "diagram" });
                        box.innerHTML = svg;
                        el.replaceWith(box);
                        report.diagrams++;
                    } catch (err) {
                        el.classList.add("failed");
                        el.before(note(`This diagram can't be drawn: ${err.message ?? err}`, true));
                        report.errors.push(`diagram: ${err.message ?? err}`);
                    }
                }
            } catch (err) {
                report.errors.push(`diagrams: ${err.message}`);
            }
        }

        if (me !== renders) {
            for (const u of urls) {
                URL.revokeObjectURL(u);
            }
            return;
        }
        document.getElementById("doc").replaceWith(doc);
        for (const u of shownURLs) {
            URL.revokeObjectURL(u);
        }
        shownURLs = urls;
        if (requestedPosition) {
            scrollTo(requestedPosition.left, requestedPosition.top);
            requestedPosition = null;
        } else if (fragment) {
            scrollToId(fragment);
        } else {
            scrollTo(scrolled.left, scrolled.top);
        }
        rendering = false;
        report.scrolled = Math.round(scrollY);
        page.postMessage({ type: "rendered", report }, "*");
    }

    page.postMessage({ type: "ready" }, "*");
})();
