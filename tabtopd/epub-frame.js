// An EPUB book's frame, served by tabtopd as epub-frame.html. The files
// page shows it sandboxed, without allow-same-origin, so it runs at an
// origin of its own: nothing in it can read the site's session, or reach
// the page that holds it, whose only way in is the messages below. Its CSP
// lets it load scripts only from the site, and pictures only as blob: and
// data: URLs,
// so a book can't fetch anything, nor tell anyone it was opened.
//
// The page sends {type: "open", book, start}: the book as tabtopd reads it
// (see epubBook in epub.go), and where it was left, if it was, {item,
// fraction, size}. Then this asks the page for a chapter at a time,
// {type: "chapter", id, item}, answered {id, html} or {id, error}: its HTML,
// cleaned by tabtopd, with links and pictures as paths in the book. The
// text is shown at once, with any pictures it holds itself (as data:
// URIs), and then its other pictures, as they come, a few at a time: {type: "image", id, src}, answered {id, bytes, mime} or {id,
// error}. As it's read, it tells the page where it is, {type: "at", item,
// fraction, size}, to start there next time, and {type: "rendered",
// report}: what's shown, and anything that went wrong.

"use strict";

(async () => {
    const { glyphs } = await import(new URL("./glyphs.js", document.currentScript.src).href);
    const page = window.parent;
    let externalMode = "none";
    // A chapter's links and pictures are paths in the book, as relative
    // URLs; read against this, they're its path.
    const BOOK = "https://book.invalid/";
    const PICTURES_AT_ONCE = 4;
    const MAX_PICTURES = 100;  // in a chapter
    const SIZES = [80, 90, 100, 115, 130, 150, 175];  // text sizes, in %

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
        } else if (m.type === "open" && m.book && Array.isArray(m.book.spine) && m.book.spine.length && !book) {
            externalMode = ["proxy", "direct"].includes(m.externalMode) ? m.externalMode : "none";
            open(m.book, m.start && typeof m.start === "object" ? m.start : {});
        } else if (m.type === "restore" && book && m.location) {
            const at = m.location;
            if (Number.isInteger(at.size) && at.size >= 0 && at.size < SIZES.length) {
                size = at.size;
                doc.style.fontSize = `${SIZES[size]}%`;
            }
            go(at.item, "", at.fraction, false);
        } else if (m.type === "theme") {
            // Light or dark, as chosen in the preview, else as the system is.
            if (m.theme === "light" || m.theme === "dark") {
                document.documentElement.dataset.theme = m.theme;
            } else {
                delete document.documentElement.dataset.theme;
            }
        }
    });

    const bar = document.getElementById("bar");
    const contents = document.getElementById("contents");
    const doc = document.getElementById("doc");
    const ends = document.getElementById("ends");
    const report = { stage: "waiting", chapters: 0, chapter: 0, item: "", toc: 0, pictures: 0, errors: [] };
    const tell = () => page.postMessage({ type: "rendered", report: { ...report } }, "*");

    function el(tag, props = {}, ...children) {
        const e = Object.assign(document.createElement(tag), props);
        e.append(...children);
        return e;
    }
    function button(text, label, onClick) {
        const b = el("button", { type: "button", textContent: text, title: label });
        b.setAttribute("aria-label", label);
        b.addEventListener("click", onClick);
        return b;
    }
    const note = (text, error = false) => el("p", { className: error ? "note error" : "note", textContent: text });

    // The book; the chapter shown, as its path, and where it is in the
    // spine (or, for one not in it, where the last one shown was); the text
    // size, as an index in SIZES; and the pictures' blob: URLs, to let go
    // of when the chapter is left.
    let book = null;
    let item = "";
    let at = 0;
    let size = SIZES.indexOf(100);
    let urls = [];
    // Each chapter shown is numbered, so one asked for later wins.
    let going = 0;
    let navigation = 0;

    const toc = [];  // {label, item, frag, level, entry}
    const prev = button(glyphs.previous, "The previous chapter (←)", () => step(-1));
    const next = button(glyphs.next, "The next chapter (→)", () => step(1));
    const where = el("span", { className: "where" });

    function open(b, start) {
        book = b;
        if (typeof b.language === "string" && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(b.language)) {
            document.documentElement.lang = b.language;
        }
        if (Number.isInteger(start.size) && start.size >= 0 && start.size < SIZES.length) {
            size = start.size;
        }
        buildContents();
        bar.replaceChildren(button(glyphs.contents, "Contents", () => showContents(contents.hidden)), prev, where, next,
            button(glyphs.fontSmaller, "Smaller text", () => resize(-1)), button(glyphs.fontLarger, "Larger text", () => resize(1)));
        doc.style.fontSize = `${SIZES[size]}%`;
        report.chapters = b.spine.length;
        report.toc = toc.length;
        const first = typeof start.item === "string" && (b.spine.includes(start.item) ||
            start.kind === "epub" && start.item.length > 0 && start.item.length < 1000) ? start.item : b.spine[0];
        const fraction = Number.isFinite(start.fraction) ? Math.min(1, Math.max(0, start.fraction)) : 0;
        go(first, "", first === start.item ? fraction : 0, false);
    }

    // buildContents lists the book's contents, or, if it has none, its
    // chapters, by number.
    function buildContents() {
        const entries = Array.isArray(book.toc) && book.toc.length ? book.toc
            : book.spine.map((s, i) => ({ label: `Part ${i + 1}`, item: s, frag: "", level: 1 }));
        const list = el("ol");
        for (const e of entries) {
            if (typeof e.label !== "string" || typeof e.item !== "string") {
                continue;
            }
            const entry = button(e.label, e.label, () => {
                showContents(false);
                go(e.item, typeof e.frag === "string" ? e.frag : "");
            });
            entry.style.paddingInlineStart = `${0.75 + (Math.min(6, Math.max(1, e.level | 0)) - 1) * 1}rem`;
            list.append(el("li", {}, entry));
            toc.push({ ...e, entry });
        }
        const head = el("div", { className: "book" }, el("strong", { textContent: book.title || "Untitled" }));
        if (book.creator) {
            head.append(el("span", { textContent: book.creator }));
        }
        contents.replaceChildren(head, list);
    }

    function showContents(show) {
        contents.hidden = !show;
        if (show) {
            (contents.querySelector("[aria-current]") ?? contents.querySelector("button"))?.focus();
        }
    }
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !contents.hidden) {
            e.preventDefault();
            showContents(false);
        } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !e.altKey && !e.ctrlKey && !e.metaKey && book) {
            // In a book whose pages turn right to left, → goes back.
            e.preventDefault();
            step((e.key === "ArrowLeft") !== !!book.rtl ? -1 : 1);
        }
    });

    function step(by) {
        const n = at + by;
        if (book && n >= 0 && n < book.spine.length) {
            go(book.spine[n]);
        }
    }

    function resize(by) {
        size = Math.min(SIZES.length - 1, Math.max(0, size + by));
        const fraction = scrolled();
        doc.style.fontSize = `${SIZES[size]}%`;
        scrollToFraction(fraction);
        tellWhere();
    }

    // The label of the contents' entry for the chapter shown, if it has one.
    const labelOf = (chapter) => toc.find((e) => e.item === chapter)?.label ?? "";

    // go shows the chapter (a path in the book), at the element with the
    // ID frag, or fraction of the way down.
    async function go(chapter, frag = "", fraction = 0, record = true) {
        const visit = ++navigation;
        const location = { item, fraction: scrolled(), size };
        const remember = () => page.postMessage({ type: "navigate", location }, "*");
        if (chapter === item && report.stage === "shown") {
            const before = scrollY;
            frag ? scrollToId(frag) : scrollToFraction(fraction);
            if (record && before !== scrollY) remember();
            tellWhere(true);
            return;
        }
        if (record && report.stage === "shown") remember();
        const me = ++going;
        report.stage = "loading";
        doc.setAttribute("aria-busy", "true");
        const got = await ask({ type: "chapter", item: chapter, render: me });
        if (me !== going) {
            return;
        }
        doc.removeAttribute("aria-busy");
        for (const u of urls) {
            URL.revokeObjectURL(u);
        }
        urls = [];
        item = chapter;
        const i = book.spine.indexOf(chapter);
        if (i >= 0) {
            at = i;
        }
        report.item = chapter;
        report.chapter = at + 1;
        if (typeof got.html !== "string") {
            doc.replaceChildren(note(`This part of the book can't be shown: ${got.error ?? "it couldn't be read"}`, true));
            report.stage = "failed";
            report.errors.push(`${chapter}: ${got.error}`);
            showWhere();
            tell();
            return;
        }
        // Parsed in a template, where pictures don't load: each is fetched
        // from the book, once the text is shown.
        const t = document.createElement("template");
        t.innerHTML = got.html;
        // Pictures in the chapter itself, as data: URIs, are shown as they
        // are; the others are fetched.
        const pictures = [...t.content.querySelectorAll("img")].filter((img) => !/^data:image\//.test(img.getAttribute("src") ?? ""));
        page.postMessage({ type: "external-resources", count: pictures.filter(img => /^(https?:|\/\/)/i.test(img.getAttribute("src") ?? "")).length }, "*");
        for (const img of pictures) {
            img.dataset.src = img.getAttribute("src") ?? "";
            img.removeAttribute("src");
            img.classList.add("waiting");
        }
        for (const a of t.content.querySelectorAll("a[href]")) {
            if (/^(https?:|mailto:)/i.test(a.getAttribute("href"))) {
                a.target = "_blank";
                a.rel = "noopener noreferrer";
            }
        }
        doc.replaceChildren(t.content);
        if (book.fixed && at === 0 && !doc.querySelector(".note.fixed")) {
            doc.prepend(el("p", { className: "note fixed",
                textContent: "This book is laid out by the page, as comics and picture books are, which isn't shown here: it may look wrong." }));
        }
        report.stage = "shown";
        report.pictures = 0;
        showWhere();
        if (frag) {
            scrollToId(frag);
        } else {
            scrollToFraction(fraction);
        }
        tellWhere(true);
        tell();
        showEnds();
        await fillPictures(pictures, me);
        showEnds();
        if (me === going && visit === navigation) {
            // Pictures move what's below them: back to where it was asked.
            if (frag) {
                scrollToId(frag);
            } else if (fraction && Math.abs(scrollY - restoredY) < 4) {
                scrollToFraction(fraction);
            }
            tell();
        }
    }

    // fillPictures fetches the chapter's pictures, a few at a time.
    async function fillPictures(pictures, me) {
        let n = 0;
        const one = async () => {
            while (n < pictures.length && me === going) {
                const i = n++;
                const img = pictures[i];
                if (i >= MAX_PICTURES) {
                    img.replaceWith(note(`${img.alt || "A picture"}: not shown, as this part has so many`));
                    continue;
                }
                const remote = /^(https?:|\/\/)/i.test(img.dataset.src);
                const src = remote ? img.dataset.src : itemOf(img.dataset.src);
                const got = remote && externalMode === "none" ? { error: "External resources are blocked." } : src ? await ask({ type: "image", src, render: me }) : { error: "not in the book" };
                if (me !== going) {
                    return;
                }
                if (got.url && externalMode === "direct") {
                    img.referrerPolicy = "no-referrer";
                    img.src = got.url;
                    img.classList.remove("waiting");
                    report.pictures++;
                } else if (got.bytes instanceof ArrayBuffer) {
                    const u = URL.createObjectURL(new Blob([got.bytes], { type: got.mime }));
                    urls.push(u);
                    img.src = u;
                    img.classList.remove("waiting");
                    report.pictures++;
                } else {
                    img.replaceWith(note(`${img.alt || "A picture"}: ${got.error ?? "it can't be shown"}`, true));
                    report.errors.push(`${src}: ${got.error}`);
                }
            }
        };
        await Promise.all(Array.from({ length: PICTURES_AT_ONCE }, one));
    }

    // itemOf is the path in the book a chapter's link or picture names, or
    // "" if it's not one.
    function itemOf(href) {
        try {
            const u = new URL(href, BOOK);
            return u.origin === new URL(BOOK).origin ? decodeURIComponent(u.pathname.slice(1)) : "";
        } catch {
            return "";
        }
    }

    // Links: external destinations are confirmed by the parent; book links
    // go to the chapter and the place in it. The frame itself goes nowhere.
    doc.addEventListener("click", (e) => {
        const a = e.target.closest("a[href]");
        if (!a) return;
        e.preventDefault();
        const href = a.getAttribute("href");
        if (/^(https?:|mailto:)/i.test(href)) {
            page.postMessage({ type: "external", href }, "*");
            return;
        }
        const chapter = itemOf(a.getAttribute("href"));
        if (chapter) {
            let frag = "";
            try {
                frag = decodeURIComponent(new URL(a.getAttribute("href"), BOOK).hash.slice(1));
            } catch {
                // No place, then: the chapter's start.
            }
            go(chapter, frag);
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
        const target = document.getElementById(id);
        if (target && doc.contains(target)) {
            target.scrollIntoView();
            scrollBy(0, -bar.offsetHeight);
        }
    }

    const room = () => Math.max(1, document.documentElement.scrollHeight - innerHeight);
    const scrolled = () => Math.min(1, scrollY / room());
    // Where it was put last, to tell if it's been scrolled since.
    let restoredY = 0;
    const scrollToFraction = (f) => {
        scrollTo(0, f * room());
        restoredY = scrollY;
    };

    // Where it is, as it's read, for the page to start there next time.
    let telling;
    // As it's scrolled, once it stops; at once, with now, as a chapter's
    // shown, so a change of chapter is never lost to what comes next.
    function tellWhere(now = false) {
        clearTimeout(telling);
        const tellNow = () => {
            if (item) {
                page.postMessage({ type: "at", item, fraction: Math.round(scrolled() * 1e4) / 1e4, size }, "*");
            }
        };
        if (now === true) {
            tellNow();
        } else {
            telling = setTimeout(tellNow, 400);
        }
    }
    addEventListener("scroll", tellWhere, { passive: true });

    function showWhere() {
        const label = labelOf(item);
        where.textContent = `Chapter ${at + 1} of ${book.spine.length}${label ? ` · ${label}` : ""}`;
        where.title = label;
        prev.disabled = at <= 0;
        next.disabled = at >= book.spine.length - 1;
        for (const e of toc) {
            e.entry.toggleAttribute("aria-current", e.item === item);
        }
        ends.replaceChildren(
            ...(at > 0 ? [button(`${glyphs.previous} ${labelOf(book.spine[at - 1]) || "Previous"}`, "The previous chapter", () => step(-1))] : []),
            ...(at < book.spine.length - 1 ? [button(`${labelOf(book.spine[at + 1]) || "Next"} ${glyphs.next}`, "The next chapter", () => step(1))] : []));
        showEnds();
    }

    // showEnds shows the bar of the chapters before and after, at the
    // frame's foot, once the chapter's read to its end (or it's too short
    // to scroll), and hides it again further up.
    function showEnds() {
        const atEnd = scrollY + innerHeight >= document.documentElement.scrollHeight - 24;
        ends.classList.toggle("shown", atEnd && ends.childElementCount > 0 && report.stage === "shown");
    }
    addEventListener("scroll", showEnds, { passive: true });
    // Resized (the preview filling the window, say), the text flows again:
    // back to as far through the chapter as it was, as read before.
    let readTo = 0;
    addEventListener("scroll", () => {
        readTo = scrolled();
    }, { passive: true });
    addEventListener("resize", () => {
        if (report.stage === "shown") {
            scrollToFraction(readTo);
        }
        showEnds();
    });

    // Its CSP's mode, as its address chose it, for the page to check.
    page.postMessage({ type: "ready", external: new URLSearchParams(location.search).get("external") === "direct" ? "direct" : "" }, "*");
})();
