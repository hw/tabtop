// A PDF preview's frame, served by tabtopd as pdf-frame.html. The files page
// shows it sandboxed, without allow-same-origin, so it runs at an origin of
// its own: nothing in it, pdf.js or the PDF, can read the site's session or
// reach the page that holds it, whose only way in is the messages below. Its
// CSP lets it load scripts only from the site, fetch only the site's files
// (pdf.js's fonts and character maps), and show nothing but what it draws.
//
// The page sends {type: "open", size, initial}: how long the file is, and
// its first bytes. Then pdf.js asks for the parts it needs, as it needs
// them, {type: "range", id, begin, end}, and the page fetches each through
// the tunnel and answers {id, bytes} or {id, error}: so only as much of the
// file as is read comes over, and the frame never has more than that. PDF
// scripts never run: pdf.js is loaded without its scripting sandbox, which
// isn't served.
//
// Pages are drawn as they come into view, fitted to the width, and those far
// out of view let go again, so a long PDF doesn't take the memory of all its
// pages. Each drawn page has its text over it, unseen, as pdf.js's text layer
// places it, so it can be selected and copied. Links in a page work: to the
// web, in a new tab; within the PDF, to the page. Find, in the bar (or
// Ctrl+F, which the page passes on as {type: "find"}), looks through the
// text of every page, reading each page's text as it goes: pdf.js reads a
// page's text only with all it holds, its pictures too, so that fetches as
// much of the file as showing every page would. So it stops to ask before
// going on, once it has fetched FIND_BYTES, or found no text at all in the
// first pages (a scanned PDF). It shows each match, highlighted. The
// frame tells the page {type: "rendered", report} as it goes: how many pages,
// which are drawn, with text, what was found, and anything that went wrong.

"use strict";

(async () => {
    // Where tabtopd serves pdf.js (it rewrites this path).
    const PDFJS = new URL("./pdfjs/", document.currentScript.src).href;
    const { glyphs, iconSVG } = await import(new URL("./glyphs.js", document.currentScript.src).href);
    // The most pages kept drawn at once, and how much bigger than the page's
    // width they're drawn at most.
    const KEEP_DRAWN = 12;
    const MAX_ZOOM = 4;
    const page = window.parent;

    let restoreAt = null;
    let restoredY = 0;
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
        } else if (m.type === "open" && Number.isSafeInteger(m.size) && m.initial instanceof ArrayBuffer) {
            restoreAt = m.location ?? restoreAt;
            open(m.size, new Uint8Array(m.initial)).catch(fail);
        } else if (m.type === "restore" && m.location) {
            restoreAt = m.location;
            if (doc && base) restoreLocation();
        } else if (m.type === "find" && doc) {
            findBox.focus();
            findBox.select();
        } else if (m.type === "image-render" && typeof m.id === "string") {
            renderImagePage(m);
        } else if (m.type === "image-cancel" && typeof m.id === "string") {
            const request = imageRenders.get(m.id);
            if (request) { request.cancelled = true; request.task?.cancel(); }
        }
    });

    const bar = document.getElementById("bar");
    const pages = document.getElementById("pages");
    const report = { pages: 0, drawn: [], text: [], links: 0, errors: [] };
    const tell = () => page.postMessage({ type: "rendered", report: { ...report, drawn: [...drawn.keys()].sort((a, b) => a - b),
        text: [...layers.keys()].sort((a, b) => a - b),
        found: { query: find.query, matches: find.matches.length, at: find.at, searched: find.searched, paused: find.paused ? find.why : "",
            page: find.matches[find.at]?.page ?? 0 } } }, "*");

    function note(text, error = false) {
        return Object.assign(document.createElement("p"), { className: error ? "note error" : "note", textContent: text });
    }

    function fail(err) {
        report.errors.push(String(err?.message ?? err));
        pages.replaceChildren(note(`This PDF can't be shown: ${err?.message ?? err}`, true));
        bar.hidden = true;
        tell();
    }

    // loadPDFJS loads pdf.js, and starts its worker from a blob: URL, which
    // a frame at an origin of its own can start (one from the site's URL
    // it can't); failing that, pdf.js does the worker's work in this frame.
    async function loadPDFJS() {
        report.stage = "loading pdf.js";
        tell();
        return import(PDFJS + "pdf.min.mjs");
    }

    // startWorker starts pdf.js's worker from a data: URL, which a frame at
    // an origin of its own can start as a module (one from the site's URL,
    // or a blob: one, it can't), and resolves to it, or null if it can't
    // be. failed is called if it fails once started.
    async function startWorker(failed) {
        try {
            const code = await (await fetch(PDFJS + "pdf.worker.min.mjs")).blob();
            const url = await new Promise((resolve, reject) => {
                const r = new FileReader();
                r.onload = () => resolve(r.result);
                r.onerror = () => reject(r.error);
                r.readAsDataURL(new Blob([code], { type: "text/javascript" }));
            });
            const worker = new Worker(url, { type: "module" });
            worker.addEventListener("error", (e) => failed(e.message || "it didn't start"));
            return worker;
        } catch (err) {
            failed(err.message);
            return null;
        }
    }

    // Pages drawn, by number, as their canvas; their text layers, by number,
    // as {divs, starts}: the layer's element for each of the page's text's
    // items, and where each starts in the page's text (see textOf); the
    // zoom, on top of fitting the width or page; pdf.js; and the PDF.
    const drawn = new Map();
    const layers = new Map();
    let zoom = 1;
    let zoomMode = "width";
    // PDF points are 1/72 inch; CSS pixels are 1/96 inch.
    const ACTUAL_SCALE = 96 / 72;
    let pdfjs = null;
    let doc = null;
    const imageRenders = new Map();
    async function renderImagePage(message) {
        const { id, number, dpi, thumbnail } = message;
        const request = { cancelled: false, task: null };
        let canvas;
        try {
            if (!doc || !Number.isSafeInteger(number) || number < 1 || number > doc.numPages ||
                !Number.isFinite(dpi) || dpi < 36 || dpi > 300 || imageRenders.size >= 2 || imageRenders.has(id)) throw new Error("Invalid or busy page render request.");
            imageRenders.set(id, request);
            const pdfPage = await doc.getPage(number), pointSize = pdfPage.getViewport({ scale: 1 });
            const scale = thumbnail ? Math.min(1, 144 / Math.max(pointSize.width, pointSize.height)) : dpi / 72;
            const viewport = pdfPage.getViewport({ scale });
            const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height);
            if (width * height > 16e6 || Math.max(width,height) > 8192) throw new Error("This page exceeds 16 megapixels. Choose a lower resolution.");
            if (request.cancelled) throw new Error("Page rendering cancelled.");
            canvas = Object.assign(document.createElement("canvas"), { width, height });
            // Print rendering does not wait for animation frames, which are
            // suspended in the hidden frames used for imported documents.
            request.task = pdfPage.render({ canvasContext: canvas.getContext("2d"), viewport, background: "rgb(255,255,255)", intent: "print" });
            await request.task.promise;
            const blob = await new Promise(resolve => canvas.toBlob(resolve,"image/png"));
            if (!blob || request.cancelled) throw new Error("Page rendering cancelled.");
            page.postMessage({ type: "image-rendered", id, blob, width, height, widthPt: pointSize.width, heightPt: pointSize.height }, "*");
        } catch (err) {
            page.postMessage({ type: "image-rendered", id, error: err.message }, "*");
        } finally {
            if (imageRenders.get(id) === request) imageRenders.delete(id);
            if (canvas) canvas.width = canvas.height = 0;
        }
    }
    let received = 0;  // bytes of the file fetched for pdf.js
    // Each layout is numbered: a page being drawn for one before it is
    // dropped, as its box is gone.
    let generation = 0;
    let base = null;  // the first page's size, at scale 1
    let observer = null;

    const scaleFor = (viewport1) => {
        const width = Math.max(1, pages.clientWidth - 16) / viewport1.width;
        const height = Math.max(1, innerHeight - bar.offsetHeight - 24) / viewport1.height;
        const scale = zoomMode === "actual" ? ACTUAL_SCALE : zoomMode === "page" ? Math.min(width, height) : width;
        return Math.min(MAX_ZOOM, scale * zoom);
    };

    async function open(size, initial) {
        received = initial.length;
        const lib = pdfjs = await loadPDFJS();
        // With a worker, or failing that, doing its work in this frame.
        let failed;
        const workerFailed = new Promise((resolve) => (failed = resolve));
        const worker = await startWorker(failed);
        if (worker) {
            lib.GlobalWorkerOptions.workerPort = worker;
            report.worker = "blob";
            const got = await Promise.race([read(lib, size, initial), workerFailed.then((why) => ({ why }))]);
            if (got.doc) {
                return shown(got.doc);
            }
            report.errors.push(`worker: ${got.why}; working without one`);
            got.task?.destroy();
            worker.terminate();
            lib.GlobalWorkerOptions.workerPort = null;
        }
        lib.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.mjs";
        report.worker = "none";
        const { doc: d } = await read(lib, size, initial);
        return shown(d);
    }

    // read opens the PDF, size bytes long, starting with initial, asking
    // the page for the rest as it's needed, and resolves to {doc, task}.
    async function read(lib, size, initial) {
        class TunnelRange extends lib.PDFDataRangeTransport {
            requestDataRange(begin, end) {
                ask({ type: "range", begin, end }).then((r) => {
                    if (r.bytes) {
                        received += r.bytes.byteLength;
                        this.onDataRange(begin, new Uint8Array(r.bytes));
                    } else {
                        task.destroy();
                        fail(new Error(r.error ?? "a part of it couldn't be fetched"));
                    }
                });
            }
        }
        report.stage = "reading the PDF";
        tell();
        const task = lib.getDocument({
            range: new TunnelRange(size, initial.slice()),
            length: size,
            disableAutoFetch: true,
            disableStream: true,
            rangeChunkSize: 256 * 1024,
            cMapUrl: PDFJS + "cmaps/",
            cMapPacked: true,
            standardFontDataUrl: PDFJS + "standard_fonts/",
            wasmUrl: PDFJS + "wasm/",
            iccUrl: PDFJS + "iccs/",
            enableXfa: false,
            isEvalSupported: false,
        });
        return { doc: await task.promise, task };
    }

    async function shown(d) {
        doc = d;
        report.stage = "shown";
        report.pages = doc.numPages;
        base = (await doc.getPage(1)).getViewport({ scale: 1 });
        buildBar();
        layout();
        if (restoreAt) restoreLocation();
        tell();
    }

    // layout puts a box for each page, as big as it will be (each the
    // first page's size till it's drawn), and draws those in view.
    function layout() {
        observer?.disconnect();
        for (const canvas of drawn.values()) {
            canvas.width = canvas.height = 0;
        }
        drawn.clear();
        layers.clear();
        generation++;
        pending.clear();
        const scale = scaleFor(base);
        const boxes = [];
        for (let n = 1; n <= doc.numPages; n++) {
            const box = Object.assign(document.createElement("div"), { className: "page" });
            box.dataset.page = String(n);
            box.style.width = `${Math.floor(base.width * scale)}px`;
            box.style.height = `${Math.floor(base.height * scale)}px`;
            boxes.push(box);
        }
        pages.replaceChildren(...boxes);
        observer = new IntersectionObserver((entries) => {
            for (const e of entries) {
                if (e.isIntersecting) {
                    draw(Number(e.target.dataset.page));
                }
            }
            showWhere();
        }, { rootMargin: "100% 0px" });
        for (const box of boxes) {
            observer.observe(box);
        }
    }

    const pending = new Set();
    async function draw(n) {
        if (drawn.has(n) || pending.has(n)) {
            return;
        }
        pending.add(n);
        const gen = generation;
        try {
            const p = await doc.getPage(n);
            if (gen !== generation) {
                return;
            }
            const viewport = p.getViewport({ scale: scaleFor(p.getViewport({ scale: 1 })) });
            const box = pages.querySelector(`.page[data-page="${n}"]`);
            if (!box) {
                return;
            }
            box.style.width = `${Math.floor(viewport.width)}px`;
            box.style.height = `${Math.floor(viewport.height)}px`;
            box.style.setProperty("--total-scale-factor", String(viewport.scale * (viewport.userUnit ?? 1)));
            const ratio = window.devicePixelRatio || 1;
            const canvas = document.createElement("canvas");
            canvas.width = Math.floor(viewport.width * ratio);
            canvas.height = Math.floor(viewport.height * ratio);
            await p.render({ canvasContext: canvas.getContext("2d"), viewport, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] }).promise;
            const text = await textLayer(n, viewport);
            const linked = await links(p, viewport);
            if (gen !== generation || !box.isConnected) {
                canvas.width = canvas.height = 0;
                return;
            }
            box.replaceChildren(canvas, ...(text ? [text.layer] : []), ...linked);
            drawn.set(n, canvas);
            if (restoreAt?.page === n) {
                if (Math.abs(scrollY - restoredY) < 4) scrollLocation(restoreAt);
                restoreAt = null;
            }
            if (text) {
                layers.set(n, text);
            }
            letGo(n);
            paint();
            if (find.matches[find.at]?.page === n && find.waiting) {
                find.waiting = false;
                scrollToMatch(find.at);
            }
            tell();
        } catch (err) {
            report.errors.push(`page ${n}: ${err?.message ?? err}`);
            tell();
        } finally {
            if (gen === generation) {
                pending.delete(n);
            }
        }
    }

    // letGo clears the pages drawn furthest from n, past KEEP_DRAWN.
    function letGo(n) {
        const far = [...drawn.keys()].sort((a, b) => Math.abs(b - n) - Math.abs(a - n));
        while (drawn.size > KEEP_DRAWN) {
            const m = far.shift();
            const canvas = drawn.get(m);
            canvas.width = canvas.height = 0;
            canvas.parentElement?.replaceChildren();
            drawn.delete(m);
            layers.delete(m);
        }
    }

    // textOf resolves to page n's text, as pdf.js reads it: {content}, for
    // its text layer; and as a string, {text}, its items one after another,
    // with a line break after those that end a line, {starts} saying where
    // each item starts in it. It's read once, and kept.
    const texts = new Map();
    function textOf(n) {
        if (!texts.has(n)) {
            const got = doc.getPage(n).then((p) => p.getTextContent()).then((content) => {
                let text = "";
                const starts = [];
                for (const item of content.items) {
                    if (item.str !== undefined) {
                        starts.push(text.length);
                        text += item.str + (item.hasEOL ? "\n" : "");
                    }
                }
                return { content, text, starts };
            });
            got.catch(() => texts.delete(n));
            texts.set(n, got);
        }
        return texts.get(n);
    }

    // textLayer makes page n's text layer, for viewport: its text, unseen,
    // where it is in the page, to be selected. It resolves to {layer, divs,
    // starts}, or null if the page's text can't be read.
    async function textLayer(n, viewport) {
        try {
            const { content, starts } = await textOf(n);
            const layer = Object.assign(document.createElement("div"), { className: "textLayer" });
            const t = new pdfjs.TextLayer({ textContentSource: content, container: layer, viewport });
            await t.render();
            // Selecting past the text ends at its end, not the page's top.
            layer.append(Object.assign(document.createElement("div"), { className: "endOfContent" }));
            return { layer, divs: t.textDivs, starts };
        } catch (err) {
            report.errors.push(`page ${n}'s text: ${err?.message ?? err}`);
            return null;
        }
    }

    // While text is being selected, pdf.js's layer stretches its end over
    // the page, so dragging between lines doesn't select all after them.
    addEventListener("pointerdown", (e) => e.target.closest?.(".textLayer")?.classList.add("selecting"));
    addEventListener("pointerup", () => {
        for (const layer of pages.querySelectorAll(".textLayer.selecting")) {
            layer.classList.remove("selecting");
        }
    });

    // links makes the page's links, over it: to the web, in a new tab; to a
    // place in the PDF, to its page.
    async function links(p, viewport) {
        const out = [];
        for (const a of await p.getAnnotations({ intent: "display" })) {
            if (a.subtype !== "Link" || !a.rect || (!a.url && !a.dest)) {
                continue;
            }
            const [x1, y1] = viewport.convertToViewportPoint(a.rect[0], a.rect[1]);
            const [x2, y2] = viewport.convertToViewportPoint(a.rect[2], a.rect[3]);
            const link = Object.assign(document.createElement("a"), { className: "link" });
            Object.assign(link.style, { left: `${Math.min(x1, x2)}px`, top: `${Math.min(y1, y2)}px`,
                width: `${Math.abs(x2 - x1)}px`, height: `${Math.abs(y2 - y1)}px` });
            if (a.url && /^(https?:|mailto:)/i.test(a.url)) {
                Object.assign(link, { href: a.url, target: "_blank", rel: "noopener noreferrer", title: a.url });
                const external = (e) => {
                    if (e.type === "auxclick" && e.button !== 1) return;
                    e.preventDefault();
                    page.postMessage({ type: "external", href: a.url }, "*");
                };
                link.addEventListener("click", external);
                link.addEventListener("auxclick", external);
            } else if (a.dest) {
                link.href = "#";
                link.addEventListener("click", (e) => {
                    e.preventDefault();
                    goTo(a.dest);
                });
            } else {
                continue;
            }
            report.links++;
            out.push(link);
        }
        return out;
    }

    async function goTo(dest) {
        try {
            const explicit = typeof dest === "string" ? await doc.getDestination(dest) : dest;
            if (!Array.isArray(explicit)) {
                return;
            }
            const ref = explicit[0];
            const n = (typeof ref === "object" && ref !== null ? await doc.getPageIndex(ref) : ref) + 1;
            if (Number.isSafeInteger(n) && n >= 1 && n <= doc.numPages) jump(n);
        } catch {
            // A destination that isn't there: nothing to go to.
        }
    }

    function location() {
        const top = scrollY + bar.offsetHeight + 12;
        let box = pages.firstElementChild;
        for (const candidate of pages.children) {
            if (candidate.offsetTop > top) break;
            box = candidate;
        }
        return { page: Number(box.dataset.page), offset: Math.min(1, Math.max(0, (top - box.offsetTop) / box.offsetHeight)),
            left: scrollX, zoom, mode: zoomMode };
    }
    function jump(n) {
        const at = location();
        const before = scrollY;
        restoreAt = null;
        goToPage(n);
        if (scrollY !== before) page.postMessage({ type: "navigate", location: at }, "*");
    }
    function restoredJumpY(at) {
        const box = pages.children[at.page - 1];
        return Math.max(0, box.offsetTop + at.offset * box.offsetHeight - bar.offsetHeight - 12);
    }
    function scrollLocation(at) {
        scrollTo(at.left, restoredJumpY(at));
        restoredY = scrollY;
        showWhere();
    }
    function restoreLocation() {
        const at = restoreAt;
        at.page = Math.min(doc.numPages, Math.max(1, at.page));
        if (zoom !== at.zoom || zoomMode !== at.mode) {
            zoom = at.zoom;
            zoomMode = at.mode;
            buildBar();
            layout();
        }
        scrollLocation(at);
        if (drawn.has(at.page)) restoreAt = null;
        else draw(at.page);
    }

    // The bar: which page is in view, and the zoom.
    // Which page is in view: clicked, a box to give one to go to.
    const where = Object.assign(document.createElement("button"), { type: "button", className: "where", title: "Go to a page" });
    const pageBox = Object.assign(document.createElement("input"), { type: "number", className: "go-to", min: 1, step: 1, hidden: true });
    pageBox.setAttribute("aria-label", "The page to go to");
    const askPage = () => {
        if (!doc) {
            return;
        }
        pageBox.max = String(doc.numPages);
        pageBox.value = String(currentPage());
        where.hidden = true;
        pageBox.hidden = false;
        pageBox.focus();
        pageBox.select();
    };
    const stopAsking = () => {
        if (!pageBox.hidden) {
            pageBox.hidden = true;
            where.hidden = false;
        }
    };
    where.addEventListener("click", askPage);
    pageBox.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            const n = Math.round(Number(pageBox.value));
            stopAsking();
            if (Number.isFinite(n) && n >= 1) {
                jump(Math.min(n, doc.numPages));
            }
            where.focus();
        } else if (e.key === "Escape") {
            e.preventDefault();
            stopAsking();
            where.focus();
        }
    });
    pageBox.addEventListener("blur", stopAsking);
    // goToPage shows page n, at the top.
    const goToPage = (n) => {
        const box = pages.querySelector(`.page[data-page="${n}"]`);
        if (box) {
            scrollTo(0, Math.max(0, box.offsetTop - bar.offsetHeight - 12));
        }
        showWhere();
    };
    function buildBar() {
        const button = (text, label, onClick) => {
            const b = Object.assign(document.createElement("button"), { type: "button", textContent: text, title: label });
            b.setAttribute("aria-label", label);
            b.addEventListener("click", onClick);
            return b;
        };
        const rezoom = (z) => {
            restoreAt = null;
            const top = currentPage();
            zoom = Math.min(MAX_ZOOM, Math.max(0.25, z));
            fit.setAttribute("aria-pressed", String(zoomMode === "page" && zoom === 1));
            width.setAttribute("aria-pressed", String(zoomMode === "width" && zoom === 1));
            actual.setAttribute("aria-pressed", String(zoomMode === "actual" && zoom === 1));
            layout();
            goToPage(top);
        };
        const fit = button("", "Fit the page to the window", () => {
            zoomMode = "page";
            rezoom(1);
        });
        fit.className = "fit-page";
        fit.setAttribute("aria-pressed", String(zoomMode === "page" && zoom === 1));
        fit.innerHTML = iconSVG("fit-page");
        const width = button("", "Fit the page to the preview width", () => {
            zoomMode = "width";
            rezoom(1);
        });
        width.className = "fit-width";
        width.setAttribute("aria-pressed", String(zoomMode === "width" && zoom === 1));
        width.innerHTML = iconSVG("fit-width");
        const actual = button("", "100% zoom", () => {
            zoomMode = "actual";
            rezoom(1);
        });
        actual.className = "actual-size";
        actual.setAttribute("aria-pressed", String(zoomMode === "actual" && zoom === 1));
        actual.innerHTML = iconSVG("actual-size");
        const zooming = Object.assign(document.createElement("span"), { className: "group" });
        const zoomOut = button("", "Zoom out", () => rezoom(zoom / 1.25));
        zoomOut.className = "zoom-out";
        zoomOut.innerHTML = iconSVG("zoom-out");
        const zoomIn = button("", "Zoom in", () => rezoom(zoom * 1.25));
        zoomIn.className = "zoom-in";
        zoomIn.innerHTML = iconSVG("zoom-in");
        zooming.append(zoomOut, where, pageBox, zoomIn, width, fit, actual);
        const finding = Object.assign(document.createElement("span"), { className: "group" });
        finding.append(findBox, button(glyphs.up, "Previous match", () => step(-1)), button(glyphs.down, "Next match", () => step(1)), found, keepLooking);
        const images = button("", "Edit or export pages as images", () => page.postMessage({ type: "edit-images", pages: doc.numPages, current: currentPage() }, "*"));
        images.className = "edit-images";
        images.innerHTML = iconSVG("inpaint");
        bar.replaceChildren(zooming, finding, images);
        showWhere();
    }

    function currentPage() {
        // The middle of what's in view, below the bar, as scrollToMatch.
        const mid = scrollY + (innerHeight + bar.offsetHeight) / 2;
        let n = 1;
        for (const box of pages.children) {
            if (box.offsetTop <= mid) {
                n = Number(box.dataset.page);
            }
        }
        return n;
    }

    // Find: the matches of find.query, in order through the PDF, as {page,
    // start, end}, offsets in the page's text (see textOf); which is shown,
    // find.at; and how many pages have been looked through. Each search is
    // numbered, find.run, so one begun stops another.
    // While it's stopped to ask, find.paused goes on, and find.why says why.
    const find = { query: "", run: 0, matches: [], at: -1, searched: 0, waiting: false, paused: null, why: "" };
    const PAGES_AT_ONCE = 4;
    // Finding stops to ask before going on once it has fetched this much of
    // the file, or found no text at all in this many pages, the first.
    const FIND_BYTES = 32 << 20;
    const TEXTLESS_PAGES = 8;
    const mb = (bytes) => `${Math.round(bytes / (1 << 20))} MB`;
    const findBox = Object.assign(document.createElement("input"), { type: "search", className: "find", placeholder: "Find" });
    findBox.setAttribute("aria-label", "Find in the PDF");
    const found = Object.assign(document.createElement("span"), { className: "found" });
    found.setAttribute("aria-live", "polite");
    const keepLooking = Object.assign(document.createElement("button"), { type: "button", className: "keep-looking", textContent: "Keep looking", hidden: true });
    keepLooking.addEventListener("click", () => find.paused?.());
    let typing;
    findBox.addEventListener("input", () => {
        clearTimeout(typing);
        typing = setTimeout(() => search(findBox.value), 300);
    });
    findBox.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            clearTimeout(typing);
            if (findBox.value !== find.query) {
                search(findBox.value);
            } else {
                step(e.shiftKey ? -1 : 1);
            }
        } else if (e.key === "Escape" && findBox.value) {
            e.preventDefault();
            findBox.value = "";
            search("");
        }
    });
    addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "f" && doc) {
            e.preventDefault();
            findBox.focus();
            findBox.select();
        }
    });

    // pattern matches query's words, in order, with any space between,
    // ignoring case.
    function pattern(query) {
        const words = query.trim().split(/\s+/).filter(Boolean);
        return words.length ? new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "giu") : null;
    }

    // first is the index of the first match on page n or after it.
    function first(n) {
        let lo = 0;
        let hi = find.matches.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            find.matches[mid].page < n ? (lo = mid + 1) : (hi = mid);
        }
        return lo;
    }

    // search looks for query through the PDF: from the page in view to the
    // end, then from the start, a few pages at once, and shows the first
    // match from the page in view as soon as it's found.
    async function search(query) {
        const run = ++find.run;
        find.paused?.();  // ends the search waiting, which then stops
        Object.assign(find, { query, matches: [], at: -1, searched: 0, waiting: false, paused: null, why: "" });
        const re = pattern(query);
        paint();
        showFound();
        if (!re) {
            tell();
            return;
        }
        const from = currentPage();
        const fetchedBefore = received;
        let textless = 0;
        let asked = false;
        const order = [];
        for (let n = from; n <= doc.numPages; n++) {
            order.push(n);
        }
        for (let n = 1; n < from; n++) {
            order.push(n);
        }
        for (let i = 0; i < order.length; i += PAGES_AT_ONCE) {
            const batch = order.slice(i, i + PAGES_AT_ONCE);
            const got = await Promise.all(batch.map((n) => textOf(n).catch((err) => {
                report.errors.push(`page ${n}'s text: ${err?.message ?? err}`);
                return null;
            })));
            if (run !== find.run) {
                return;
            }
            batch.forEach((n, j) => {
                if (!got[j]) {
                    return;
                }
                if (!got[j].text.trim()) {
                    textless++;
                }
                const on = [...got[j].text.matchAll(re)].filter((m) => m[0].length).map((m) => ({ page: n, start: m.index, end: m.index + m[0].length }));
                const at = first(n);
                find.matches.splice(at, 0, ...on);
                if (find.at >= at) {
                    find.at += on.length;
                }
            });
            find.searched += batch.length;
            if (find.at < 0 && find.matches.length) {
                find.at = first(from) < find.matches.length ? first(from) : 0;
                show(find.at);
            }
            paint();
            showFound();
            tell();
            const fetched = received - fetchedBefore;
            const why = asked || find.searched >= doc.numPages ? ""
                : fetched > FIND_BYTES ? `Fetched ${mb(fetched)} for ${find.searched} of ${doc.numPages} pages.`
                : textless === find.searched && textless >= TEXTLESS_PAGES ? `No text in the first ${textless} pages: scanned?` : "";
            if (why) {
                // Asked once: then on to the end.
                asked = true;
                await new Promise((resolve) => {
                    find.paused = resolve;
                    find.why = why;
                    showFound();
                    tell();
                });
                if (run !== find.run) {
                    return;
                }
                find.paused = null;
                showFound();
            }
        }
    }

    // step shows the next match, by, or the previous, round the PDF.
    function step(by) {
        const n = find.matches.length;
        if (n) {
            find.at = (find.at + by + n) % n;
            show(find.at);
            paint();
            showFound();
            tell();
        }
    }

    // show scrolls to match i: to it, if its page is drawn; else to its
    // page, and to it once that's drawn.
    function show(i) {
        const m = find.matches[i];
        if (layers.has(m.page)) {
            scrollToMatch(i);
        } else {
            find.waiting = true;
            pages.querySelector(`.page[data-page="${m.page}"]`)?.scrollIntoView();
        }
    }

    function scrollToMatch(i) {
        const r = rangeOf(find.matches[i])?.getBoundingClientRect();
        if (r) {
            scrollBy(0, r.top - (innerHeight + bar.offsetHeight) / 2);
        }
    }

    // rangeOf is a DOM range over match m in its page's text layer, if the
    // page is drawn.
    function rangeOf(m) {
        const t = layers.get(m.page);
        if (!t) {
            return null;
        }
        // item is the index of the item that offset is in.
        const item = (offset) => {
            let lo = 0;
            let hi = t.starts.length - 1;
            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;
                t.starts[mid] <= offset ? (lo = mid) : (hi = mid - 1);
            }
            return lo;
        };
        const node = (i) => t.divs[i]?.isConnected ? t.divs[i].firstChild : null;
        let a = item(m.start);
        let aAt = m.start - t.starts[a];
        while (a < t.divs.length && (!node(a) || aAt >= node(a).length)) {
            a++;
            aAt = 0;
        }
        let b = item(m.end - 1);
        let bAt = Math.min(m.end - t.starts[b], node(b)?.length ?? 0);
        while (b >= 0 && (!node(b) || bAt === 0)) {
            b--;
            bAt = node(b)?.length ?? 0;
        }
        if (a >= t.divs.length || b < 0 || a > b) {
            return null;
        }
        const r = new Range();
        r.setStart(node(a), aAt);
        r.setEnd(node(b), bAt);
        return r;
    }

    // paint highlights the matches on the pages drawn, the one shown apart,
    // where the browser can (with CSS highlights).
    const marks = typeof Highlight === "function" ? CSS.highlights : null;
    function paint() {
        if (!marks) {
            return;
        }
        const all = new Highlight();
        const current = new Highlight();
        for (const n of layers.keys()) {
            for (let i = first(n); i < find.matches.length && find.matches[i].page === n; i++) {
                const r = rangeOf(find.matches[i]);
                if (r) {
                    (i === find.at ? current : all).add(r);
                }
            }
        }
        marks.set("found", all);
        marks.set("found-current", current);
    }

    function showFound() {
        const { query, matches, at, searched, paused } = find;
        const total = doc?.numPages ?? 0;
        const more = searched < total ? "…" : "";
        keepLooking.hidden = !paused;
        found.title = more && !paused ? `Looked through ${searched} of ${total} pages` : "";
        found.textContent = !pattern(query) ? "" : paused ? (matches.length ? `${at + 1} of ${matches.length} so far. ` : "") + find.why
            : matches.length ? `${at + 1} of ${matches.length}${more}` : more ? `Looking… ${searched} of ${total}` : "Not found";
    }

    function showWhere() {
        where.textContent = doc ? `Page ${currentPage()} of ${doc.numPages}` : "";
    }
    addEventListener("scroll", showWhere, { passive: true });
    let resizing;
    addEventListener("resize", () => {
        clearTimeout(resizing);
        // Laid out again for the new window size, at the page it was at (the
        // boxes are as they were till then, so it's still that page).
        resizing = setTimeout(() => {
            if (doc) {
                const top = currentPage();
                layout();
                goToPage(top);
            }
        }, 200);
    });

    page.postMessage({ type: "ready" }, "*");
})();
