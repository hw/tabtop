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
//   __tabtop.into(id)    scrolls an element into view (only as far as needed),
//                        for real input at it: "ok", or "gone"
//   __tabtop.point(json) where in the window real input at {id, fx, fy}
//                        (fractions across and down the element) lands on
//                        it, as JSON {x, y}, or "" if it can't (not laid
//                        out, or covered here): run after layout's refreshed
//   __tabtop.keyTo(id, sel) gives the element keys go to the focus, if it
//                        isn't the document itself (the page's own focus
//                        stays), and in rich text the copy's selection (sel:
//                        [anchor, offset, focus, offset], nodes by number):
//                        "field" if it's a one-line field, "editable" if
//                        it's rich text (contenteditable), "ok", or "gone"
//   __tabtop.io(json)    what the person's browser saw of elements the page
//                        observes, [{o, i, hit, ratio}], handed to the page
//                        (see goobserve.js)
//
// Changes are watched with a MutationObserver here, and tabtopd asks for
// them often (polling: a CDP binding to signal by stops Moli following links
// within a page); ops are {o: "c", i, c} (a node's children, those
// already numbered as {i, r: 1}), {o: "a", i, n, v} (an attribute, v null if
// removed), {o: "t", i, v} (text), {o: "v", i, v} (a form field's value,
// changed by script), {o: "m", i, v} (an audio or video element started
// playing, v "true", or stopped). Snapshots and batches carry the page's
// IntersectionObserver targets too, io: [{op: "+", o, i, m, t, r}] (its
// observer's number, the element's, rootMargin, thresholds, root element
// or 0) and {op: "-", o, i}; a snapshot, all of them.
//
// An element's shadow root (an open one; a closed one too, made open by
// goshadow.js, the page told it's closed) comes with it, s: {i, t: 11, c,
// ss}: its nodes numbered as the document's, its adopted stylesheets ss, a
// number for their text (each text said once, in the snapshot's document
// node's css, or a batch's, {number: text}: many roots adopt the same; ss
// said again, {o: "ss", i: root, ss}, as they change); one attached once
// its host's been sent, as {o: "s", i: host, s}. The document's own adopted
// stylesheets are a <style> of their own at its head's end ({t: 1, n:
// "style", a: ["data-go-adopted", ""]}, its text said again as they
// change). Changes in a shadow root are said as the document's are ({o:
// "c", i: root, c} for its children).
//
// With rich text
// (contenteditable) focused, a batch says where its caret is, sel: [anchor,
// offset, focus, offset] (nodes by number), for the copy to put it there.
//
// Rich text is edited by the engine, as typed (goinput.go's keys and
// edits); what a browser does with an edit the page didn't take itself,
// and Moli doesn't (a deletion, a new paragraph or line), is done here
// (editDefault).
(() => {
    const w = globalThis;
    if (!w.__tabtop) {
        // at is what an event's for: its target, in a shadow root too (the
        // page's hooks' events are composed: their target, here at the
        // document, would be the outermost host).
        const at = (e) => e.composedPath?.()[0] ?? e.target;
        const ids = new WeakMap();   // node -> id
        const byId = new Map();      // id -> WeakRef(node)
        let next = 1;
        let seq = 0;
        const dropped = new Set(["script", "noscript", "template"]);
        let parents = new Set(), attrs = new Map(), texts = new Set();
        // The document's address, as location has it: Obscura's
        // document.URL keeps the address it loaded at, without a fragment
        // followed since (location's is right in both).
        const here = () => location.href;
        const watched = new Map();   // fields acted on -> the value last reported
        // What the page asked by alert, confirm and prompt, with an engine
        // that answered it itself (godialogs.js): sent with the next batch.
        let asked = [];
        document.addEventListener("__tabtop_dialog", (e) => {
            let d;
            try { d = JSON.parse(e.detail); } catch { return; }
            if (asked.length < 16 && d && typeof d.kind === "string" && typeof d.message === "string") asked.push({ kind: d.kind, message: d.message.slice(0, 2000) });
        });
        // Where the page scrolled its elements itself (goobserve.js), for
        // the copy to scroll so: the newest of each, with the next batch.
        let scrollsOut = new Map();  // element -> {x, y} or {into}
        // Not this world's own scrolling (an engine whose worlds share what
        // the page's script changed, Obscura's, says it as the page's).
        let ownScrolling = false;
        const ownScroll = (f) => {
            ownScrolling = true;
            try { return f(); } finally { ownScrolling = false; }
        };
        document.addEventListener("__tabtop_scroll", (e) => {
            if (ownScrolling) return;
            let d;
            try { d = JSON.parse(e.detail); } catch { return; }
            const el = at(e);
            if (!(el instanceof Element) || !d || (scrollsOut.size >= 64 && !scrollsOut.has(el))) return;
            const where = ["start", "center", "end", "nearest"];
            if (Array.isArray(d.into) && where.includes(d.into[0]) && where.includes(d.into[1])) scrollsOut.set(el, { into: d.into });
            else if (Number.isFinite(d.x) && Number.isFinite(d.y)) scrollsOut.set(el, { x: d.x, y: d.y });
        }, true);
        // Players the page started or stopped since the last batch (media
        // events don't bubble: caught on their way down).
        let played = new Map();
        // Not those said of how the person's player plays (gomedia.js fires
        // them as it's told, within the telling): the page's doing only.
        let tellingPlay = false;
        for (const type of ["play", "pause", "ended", "emptied"]) {
            document.addEventListener(type, (e) => {
                // Trust the event: gomedia.js may still mirror the person's
                // player as playing when the page has just paused (MSE stub),
                // and reading paused then would keep the underlaid player on.
                if (!tellingPlay && e.target instanceof HTMLMediaElement && played.size < 256) played.set(e.target, type === "play");
            }, true);
        }
        let lastURL = "";

        // The page's observed elements, held by element until it's one the
        // shown copy has (numbered: numbering one would make later batches
        // name a node never sent).
        const ioTargets = new Map();  // element -> Map(observer -> {m, t, root})
        const ioRoots = new Map();    // observer -> its root element
        let ioSent = new Set();       // "o:i" the shown copy observes
        let ioOut = [];               // what's to go with the next batch
        const ioLast = new Map();     // "o:i" -> what was last handed over
        document.addEventListener("__tabtop_io", (e) => {
            let d;
            try { d = JSON.parse(e.detail); } catch { return; }
            const el = at(e);
            if (!d || !Number.isSafeInteger(d.o) || !(el instanceof Element)) return;
            if (d.op === "r") {
                ioRoots.set(d.o, el);
            } else if (d.op === "+") {
                if (!ioTargets.has(el)) {
                    if (ioTargets.size >= 5000) return;
                    ioTargets.set(el, new Map());
                }
                // A ResizeObserver's (s, its box) or an IntersectionObserver's.
                ioTargets.get(el).set(d.o, typeof d.s === "string" ? { s: d.s.slice(0, 32) }
                    : { m: String(d.m), t: Array.isArray(d.t) ? d.t : [0], root: d.r ? ioRoots.get(d.o) ?? null : null });
            } else if (d.op === "-") {
                ioTargets.get(el)?.delete(d.o);
                if (ioTargets.get(el)?.size === 0) ioTargets.delete(el);
                if (known(el)) {
                    const key = d.o + ":" + ids.get(el);
                    ioLast.delete(key);
                    if (ioSent.delete(key)) ioOut.push({ op: "-", o: d.o, i: ids.get(el) });
                }
            }
        }, true);
        // ioNew adds to ioOut what's observed of elements now shown.
        function ioNew() {
            for (const [el, regs] of ioTargets) {
                if (!el.isConnected || !known(el)) continue;
                const i = ids.get(el);
                for (const [o, r] of regs) {
                    const key = o + ":" + i;
                    if (ioSent.has(key) || (r.root && !(r.root.isConnected && known(r.root)))) continue;
                    ioSent.add(key);
                    ioOut.push(r.s ? { op: "+", o, i, s: r.s } : { op: "+", o, i, m: r.m, t: r.t, r: r.root ? ids.get(r.root) : 0 });
                }
            }
        }
        function into(id) {
            const el = node(id);
            if (!el) return "gone";
            watch(el);  // as it was: what the input changes is sent
            if (el.nodeType === 1) ownScroll(() => el.scrollIntoView({ block: "nearest", inline: "nearest" }));
            return "ok";
        }
        function point(json) {
            const a = JSON.parse(json);
            const el = node(a.id);
            if (!el || el.nodeType !== 1) return "";
            const r = el.getBoundingClientRect();
            if (!(r.width > 0 && r.height > 0)) return "";
            const on = (x, y) => {
                if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
                const hit = document.elementFromPoint(x, y);
                return !!hit && (hit === el || el.contains(hit));
            };
            const f = (v) => Math.min(1, Math.max(0, Number(v) || 0));
            // Where the person pointed within it, kept just inside it; or its
            // middle, if something else is there.
            for (const [fx, fy] of [[f(a.fx), f(a.fy)], [0.5, 0.5]]) {
                const x = r.left + Math.min(r.width - 0.5, Math.max(0.5, fx * r.width));
                const y = r.top + Math.min(r.height - 0.5, Math.max(0.5, fy * r.height));
                if (on(x, y)) return JSON.stringify({ x, y });
            }
            return "";
        }
        // frameOwner says, of an iframe tabtopd found as a frame's owner,
        // its number if the copy has it (not numbering it: that would make
        // later batches name a node never sent) and whether its page is
        // read here (same origin) or must be read in a world of its own.
        function frameOwner(el) {
            let readable = false;
            try { readable = !!el.contentDocument; } catch { /* another origin's */ }
            return JSON.stringify({ id: known(el) ? ids.get(el) : 0, readable });
        }
        function keyTo(id, sel) {
            const el = node(id);
            if (!el) return "gone";
            watch(el);
            if (el.nodeType === 1 && el !== document.body && el !== document.documentElement && document.activeElement !== el) el.focus?.();
            // Rich text: edited where the copy's caret is.
            if (editable(el)) {
                select(sel);
                return "editable";
            }
            // A one-line field: Enter there sends its form (given as typed).
            const field = el.localName === "input" && !/^(button|submit|reset|checkbox|radio|file|image|range|color)$/i.test(el.type);
            return field ? "field" : "ok";
        }

        // --- Rich text (contenteditable) -----------------------------------
        //
        // editable is whether el is rich text, edited as a browser edits it:
        // contenteditable (not a field, which has its value).
        function editable(el) {
            if (el?.nodeType !== 1 || /^(input|textarea|select)$/.test(el.localName)) return false;
            if (typeof el.isContentEditable === "boolean") return el.isContentEditable;
            return editMode(el) !== "false";
        }
        // editMode is how el is edited, by its contenteditable or the nearest
        // one's over it: "true" (rich text: true, or empty), "plaintext-only"
        // (its text only, no styles), or "false" (none). A value that's none
        // of these is its parent's (as missing), as HTML has it.
        function editMode(el) {
            for (let at = el; at?.nodeType === 1; at = at.parentElement) {
                const v = at.getAttribute("contenteditable");
                if (v === null) continue;
                const mode = v.toLowerCase();
                if (mode === "" || mode === "true") return "true";
                if (mode === "plaintext-only" || mode === "false") return mode;
            }
            return "false";
        }
        // (Its text only: no paragraphs made, nothing pasted styled.)
        const plainText = (el) => editMode(el) === "plaintext-only";
        // select puts the selection where the copy's is: [anchor, offset,
        // focus, offset], nodes by number (an offset past a node's end, its
        // end). Nodes not known, or not in rich text: left as it is.
        function select(sel) {
            if (!Array.isArray(sel) || sel.length !== 4) return;
            const a = node(sel[0]), f = node(sel[2]);
            const holds = (n) => editable(n.nodeType === 1 ? n : n.parentElement);
            if (!a || !f || !holds(a) || !holds(f)) return;
            const end = (n, at) => Math.max(0, Math.min(Number(at) || 0, n.nodeType === 3 ? n.data.length : n.childNodes.length));
            try { selectionOf(a).setBaseAndExtent(a, end(a, sel[1]), f, end(f, sel[3])); } catch { /* left as it was */ }
        }
        // selectionOf is the selection a node's in: its shadow root's, if
        // it's in one (the document's says its host), else its document's.
        function selectionOf(n) {
            const root = n.getRootNode?.();
            return root?.nodeType === 11 && typeof root.getSelection === "function" ? root.getSelection() : n.ownerDocument.getSelection();
        }
        // deepActive is what has the focus, in a shadow root too (the
        // document's activeElement is its host).
        function deepActive() {
            let a = document.activeElement;
            for (let root = a && shadowOf(a); root?.activeElement; root = shadowOf(a)) a = root.activeElement;
            return a;
        }
        // caret is where the selection is, as [anchor, offset, focus,
        // offset] by number, in rich text focused; or null.
        function caret() {
            const active = deepActive();
            if (!editable(active)) return null;
            const s = selectionOf(active);
            if (!s?.anchorNode || !s.focusNode || !known(s.anchorNode) || !known(s.focusNode)) return null;
            return [ids.get(s.anchorNode), s.anchorOffset, ids.get(s.focusNode), s.focusOffset];
        }

        // What a browser does itself with these edits, and Moli doesn't
        // (its deletion deletes nothing; its new paragraph is a "\n" in the
        // text): done here, the page not having taken the edit.
        const editDefaults = new Set(["deleteContentBackward", "deleteContentForward", "deleteWordBackward", "deleteWordForward", "insertParagraph", "insertLineBreak"]);
        const blockNames = /^(p|div|li|h[1-6]|blockquote|pre|dd|dt|section|article)$/;
        // blockOf is the block (a paragraph, a list's item) n is in, within
        // host (not host itself); or null.
        function blockOf(n, host) {
            for (let at = n.nodeType === 1 ? n : n.parentNode; at && at !== host; at = at.parentNode) {
                if (at.nodeType === 1 && blockNames.test(at.localName)) return at;
            }
            return null;
        }
        // filled keeps a block that's lost all its text a line high, as a
        // browser does (a <br>).
        function filled(el) {
            if (el && !el.textContent && !el.querySelector?.("br, img")) el.append(el.ownerDocument.createElement("br"));
        }
        // textNear is the nearest text before (or after) a point (n,
        // offset) within host, and where in it: {t, at}; or null.
        function textNear(n, offset, host, back) {
            if (n.nodeType === 3 && (back ? offset > 0 : offset < n.data.length)) return { t: n, at: offset };
            const walk = host.ownerDocument.createTreeWalker(host, NodeFilter.SHOW_TEXT);
            const child = n.nodeType === 1 ? n.childNodes[offset] : null;
            // Whether text t comes before the point.
            const before = (t) => n.nodeType === 3 ? !!(n.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_PRECEDING)
                : child ? !!(child.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_PRECEDING)
                    : n.contains(t) || !!(n.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_PRECEDING);
            let found = null;
            for (let t = walk.nextNode(); t; t = walk.nextNode()) {
                if (!t.data.length || t === n) continue;
                if (back && before(t)) found = t;
                if (!back && !before(t)) return { t, at: 0 };
            }
            return found && { t: found, at: found.data.length };
        }
        // rangeOf is the selection's range: Moli's, in an embedded page,
        // has one (rangeCount) it won't give (getRangeAt throws), so made
        // from its ends.
        function rangeOf(s) {
            if (!s?.rangeCount) return null;
            try { return s.getRangeAt(0); } catch { /* made, below */ }
            if (!s.anchorNode || !s.focusNode) return null;
            const r = s.anchorNode.ownerDocument.createRange();
            r.setStart(s.anchorNode, s.anchorOffset);
            r.setEnd(s.focusNode, s.focusOffset);
            if (r.collapsed && (s.anchorNode !== s.focusNode || s.anchorOffset !== s.focusOffset)) {
                r.setStart(s.focusNode, s.focusOffset);  // (made backwards)
                r.setEnd(s.anchorNode, s.anchorOffset);
            }
            return r;
        }
        // editDefault does an edit as a browser would, at the selection in
        // host: true if it did (or there was nothing to do).
        // (The host's own document's: an embedded page's, read by this agent,
        // has its own selection.)
        function editDefault(host, type, data) {
            if (type === "insertParagraph" && plainText(host)) type = "insertLineBreak";
            const doc = host.ownerDocument, s = selectionOf(host);
            const r = rangeOf(s);
            if (!r || !host.contains(r.startContainer)) return false;
            if (type === "insertText") {
                r.deleteContents();
                let t = r.startContainer, at = r.startOffset;
                if (t.nodeType === 3) t.insertData(at, data);
                else {
                    const text = doc.createTextNode(data);
                    r.insertNode(text);
                    t = text, at = 0;
                }
                s.setBaseAndExtent(t, at + data.length, t, at + data.length);
                return true;
            }
            if (type.startsWith("delete")) {
                const back = type.endsWith("Backward"), word = type.startsWith("deleteWord");
                if (r.collapsed) {
                    // At a paragraph's edge: it and the one before (or
                    // after) made one.
                    const block = blockOf(r.startContainer, host);
                    if (block && !textNear(r.startContainer, r.startOffset, block, back)) {
                        const other = back ? block.previousElementSibling : block.nextElementSibling;
                        if (!other) return true;  // the first (or last): nothing
                        if (blockNames.test(other.localName)) {
                            const [first, second] = back ? [other, block] : [block, other];
                            if (!first.textContent) first.replaceChildren();  // (its <br>)
                            if (!second.textContent) second.replaceChildren();
                            const at = first.childNodes.length;
                            while (second.firstChild) first.append(second.firstChild);
                            second.remove();
                            filled(first);
                            s.setBaseAndExtent(first, at, first, at);
                            return true;
                        }
                    }
                    const near = textNear(r.startContainer, r.startOffset, host, back);
                    if (!near) return true;  // at the start (or end): nothing
                    const text = near.t.data;
                    let at = near.at, to = near.at;
                    if (word) {
                        const m = back ? /\S*\s*$/.exec(text.slice(0, at)) : /^\s*\S*/.exec(text.slice(at));
                        if (back) at -= m[0].length || 1; else to += m[0].length || 1;
                    } else if (back) at -= /[\uDC00-\uDFFF]/.test(text[at - 1] ?? "") && at > 1 ? 2 : 1;
                    else to += /[\uD800-\uDBFF]/.test(text[at] ?? "") ? 2 : 1;
                    r.setStart(near.t, Math.max(0, at));
                    r.setEnd(near.t, Math.min(text.length, to));
                }
                const block = blockOf(r.startContainer, host);
                r.deleteContents();
                s.setBaseAndExtent(r.startContainer, r.startOffset, r.startContainer, r.startOffset);
                filled(block ?? host);
                return true;
            }
            if (type === "insertLineBreak") {
                r.deleteContents();
                const br = doc.createElement("br");
                r.insertNode(br);
                // At its line's end, a second, for the new line to show.
                let next = br.nextSibling;
                while (next && next.nodeType === 3 && !next.data.length) next = next.nextSibling;
                if (!next) br.after(doc.createElement("br"));
                s.setBaseAndExtent(br.parentNode, [...br.parentNode.childNodes].indexOf(br) + 1, br.parentNode, [...br.parentNode.childNodes].indexOf(br) + 1);
                return true;
            }
            if (type === "insertParagraph") {
                r.deleteContents();
                const block = blockOf(r.startContainer, host);
                const box = block ?? host;
                // What follows the caret in its block goes to a new one.
                const rest = doc.createRange();
                rest.setStart(r.startContainer, r.startOffset);
                rest.setEnd(box, box.childNodes.length);
                const moved = rest.extractContents();
                const name = !block ? "div" : /^h[1-6]$/.test(block.localName) ? "p" : block.localName;
                const next = doc.createElement(name);
                next.append(moved);
                if (block) block.after(next); else host.append(next);
                filled(box);
                filled(next);
                s.setBaseAndExtent(next, 0, next, 0);
                return true;
            }
            return false;
        }
        // pasted is a paste's HTML as a browser puts it in rich text: its
        // text, and of its markup only what styles or orders it (bold,
        // italics, links to web pages, paragraphs, lists, headings, quotes,
        // code), none of its attributes but a link's address. (A fragment of
        // host's document.)
        const pastedTags = /^(b|strong|i|em|u|s|strike|del|ins|sub|sup|mark|code|kbd|a|p|div|br|ul|ol|li|h[1-6]|blockquote|pre|span|hr)$/;
        function pasted(host, html) {
            const doc = host.ownerDocument;
            const box = doc.createElement("template");
            box.innerHTML = html;
            const out = doc.createDocumentFragment();
            const copy = (from, to) => {
                for (const n of from.childNodes) {
                    if (n.nodeType === 3) to.append(doc.createTextNode(n.data));
                    else if (n.nodeType !== 1) continue;
                    else if (/^(script|style|template|noscript|iframe|object|embed|svg|math|head|title|meta|link)$/.test(n.localName)) continue;
                    else if (!pastedTags.test(n.localName)) copy(n, to);  // its text, not it
                    else {
                        const el = doc.createElement(n.localName);
                        const href = n.localName === "a" ? n.getAttribute("href") : null;
                        if (href && /^https?:\/\//i.test(href.trim())) el.setAttribute("href", href.trim());
                        copy(n, el);
                        to.append(el);
                    }
                }
            };
            copy(box.content ?? box, out);
            return out;
        }
        // An edit the engine's input made (its beforeinput, trusted) that
        // the page let be: done as a browser does, not as Moli would.
        // (Moli says a word's deletion, Ctrl+Backspace, as a character's:
        // the key it came of says which.)
        let lastKey = null;
        window.addEventListener("keydown", (e) => { if (e.isTrusted) lastKey = e; }, true);
        window.addEventListener("beforeinput", (e) => {
            if (!e.isTrusted || e.defaultPrevented || !editDefaults.has(e.inputType)) return;
            const target = at(e);  // (in a shadow root too: here, e.target is its host)
            const host = target?.nodeType === 1 ? target : null;
            if (!editable(host)) return;
            e.preventDefault();
            let type = e.inputType;
            if (/^deleteContent/.test(type) && (lastKey?.ctrlKey || lastKey?.altKey) && /^(Backspace|Delete)$/.test(lastKey.key)) type = type.replace("Content", "Word");
            if (editDefault(host, type, e.data ?? "")) {
                host.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: type }));
            }
        });
        // editScripted does an edit by script (an embedded page's, whose
        // input can't be the engine's): its beforeinput, and then, unless
        // the page takes it, the edit and its input event.
        function editScripted(host, type, data) {
            const go = host.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: type, data: type.startsWith("insert") && type !== "insertParagraph" && type !== "insertLineBreak" ? data : null }));
            if (go && editDefault(host, type, data)) host.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: type, data }));
        }
        // editOfKey is the edit a key makes in rich text: [inputType, data].
        function editOfKey(a) {
            const key = String(a.key || "");
            if (key === "Enter") return [a.shift ? "insertLineBreak" : "insertParagraph", ""];
            if (key === "Backspace") return [a.ctrl || a.alt ? "deleteWordBackward" : "deleteContentBackward", ""];
            if (key === "Delete") return [a.ctrl || a.alt ? "deleteWordForward" : "deleteContentForward", ""];
            if ([...key].length === 1 && !a.ctrl && !a.meta) return ["insertText", key];
            return null;
        }
        // scripted does, for an engine that doesn't (Obscura), what a
        // browser does with input besides its events (goinput.go asks):
        //   {kind: "activate", id, key}  "click" if the key (" " or
        //       "Enter") presses the focused element, to be clicked there
        //   {kind: "tab", back}  the focus moved on, as Tab does
        //   {kind: "pointer", type, x, y, button, buttons}  the pointer
        //       event a mouse event makes, at x, y (the engine's window)
        //   {kind: "contextmenu", x, y}  a right click's menu event
        let pointerAt = null;
        let pressedAt = null;  // what the mouse was pressed on (byElement)
        // moveTo has the pointer go from where it was to el, as browsers do:
        // out of the last, into this, leaving and entering each element
        // left or entered, not just the one under it; the mouse's own
        // events too if all (an engine that gives none of them).
        function moveTo(el, init, all) {
            if (el === pointerAt) return;
            const chain = (e) => { const c = []; for (let n = e; n; n = n.parentElement) c.push(n); return c; };
            const before = pointerAt?.isConnected ? chain(pointerAt) : [], after = chain(el);
            const left = before.filter((n) => !after.includes(n)), entered = after.filter((n) => !before.includes(n)).reverse();
            const still = { ...init, bubbles: false };
            if (pointerAt?.isConnected) {
                pointerAt.dispatchEvent(new PointerEvent("pointerout", init));
                if (all) pointerAt.dispatchEvent(new MouseEvent("mouseout", init));
            }
            for (const n of left) {
                n.dispatchEvent(new PointerEvent("pointerleave", still));
                n.dispatchEvent(new MouseEvent("mouseleave", still));
            }
            el.dispatchEvent(new PointerEvent("pointerover", init));
            if (all) el.dispatchEvent(new MouseEvent("mouseover", init));
            for (const n of entered) {
                n.dispatchEvent(new PointerEvent("pointerenter", still));
                if (all || n !== el) n.dispatchEvent(new MouseEvent("mouseenter", still));
            }
            pointerAt = el;
        }
        function scripted(json) {
            let a;
            try { a = JSON.parse(json); } catch { return "bad"; }
            const at = (x, y) => document.elementFromPoint(Number(x) || 0, Number(y) || 0);
            const mouseInit = (x, y, extra) => ({ bubbles: true, cancelable: true, composed: true, view: window, clientX: Number(x) || 0, clientY: Number(y) || 0, ...extra });
            switch (a.kind) {
                case "activate": {
                    // The element the key was given to (keyTo focused it):
                    // not document.activeElement, which an engine may give
                    // as the page's world's (Lightpanda), not this one's.
                    const el = node(a.id);
                    if (!el || el.nodeType !== 1) return "";
                    const t = (el.type || "").toLowerCase(), name = el.localName;
                    const button = name === "button" || name === "input" && /^(button|submit|reset|image)$/.test(t);
                    const byKey = a.key === " " ? button || name === "summary" || name === "input" && /^(checkbox|radio)$/.test(t)
                        : a.key === "Enter" ? button || name === "summary" || name === "a" && el.hasAttribute("href") : false;
                    return byKey && !el.disabled ? "click" : "";
                }
                case "tab": {
                    const all = [...document.querySelectorAll("a[href], area[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable]")]
                        .filter((e) => !e.disabled && e.type !== "hidden" && e.tabIndex >= 0 && e.getClientRects().length > 0
                            // Rich text, by its contenteditable alone: its editing host (not
                            // one within another's, nor one that's false), as a browser's.
                            && (!e.matches("[contenteditable]") || e.hasAttribute("tabindex") || e.matches("a[href], area[href], button, input, select, textarea, summary, iframe")
                                || editable(e) && !editable(e.parentElement)));
                    // Positive tab indices first, in order; then the rest, as they come.
                    const order = [...all.filter((e) => e.tabIndex > 0).sort((x, y) => x.tabIndex - y.tabIndex), ...all.filter((e) => e.tabIndex === 0)];
                    if (!order.length) return "none";
                    const i = order.indexOf(document.activeElement);
                    const to = a.back ? order[i <= 0 ? order.length - 1 : i - 1] : order[i < 0 || i === order.length - 1 ? 0 : i + 1];
                    to.focus();
                    return "ok";
                }
                case "pointer": {
                    const el = at(a.x, a.y);
                    if (!el) return "none";
                    const init = mouseInit(a.x, a.y, { pointerId: 1, pointerType: "mouse", isPrimary: true, button: Number(a.button) || 0, buttons: Number(a.buttons) || 0 });
                    // (Obscura gives mouseover, mouseout and the mouseenter of
                    // the element under the pointer itself.)
                    if (a.type === "pointermove") moveTo(el, init, false);
                    if (/^pointer(move|down|up)$/.test(a.type)) el.dispatchEvent(new PointerEvent(a.type, init));
                    return "ok";
                }
                case "contextmenu": {
                    const el = at(a.x, a.y);
                    el?.dispatchEvent(new MouseEvent("contextmenu", mouseInit(a.x, a.y, { button: 2, buttons: 0 })));
                    return "ok";
                }
                case "mouse": {
                    // The mouse given to the element the person pointed at,
                    // where within it (fractions), for an engine whose own
                    // places aren't to be trusted (byElement: Lightpanda).
                    const el = node(a.id);
                    if (!el || el.nodeType !== 1) return "gone";
                    const r = el.getBoundingClientRect();
                    const x = r.left + Math.min(1, Math.max(0, Number(a.fx) || 0)) * r.width, y = r.top + Math.min(1, Math.max(0, Number(a.fy) || 0)) * r.height;
                    const button = Number(a.button) || 0;
                    const keys = { shiftKey: !!a.shift, ctrlKey: !!a.ctrl, altKey: !!a.alt, metaKey: !!a.meta };
                    const init = mouseInit(x, y, { button, buttons: Number(a.buttons) || 0, detail: Number(a.count) || 0, ...keys });
                    const pinit = { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true };
                    switch (a.type) {
                        case "move":
                            moveTo(el, pinit, true);
                            el.dispatchEvent(new PointerEvent("pointermove", pinit));
                            el.dispatchEvent(new MouseEvent("mousemove", init));
                            return "ok";
                        case "down":
                            moveTo(el, pinit, true);
                            pressedAt = el;
                            el.dispatchEvent(new PointerEvent("pointerdown", pinit));
                            if (el.dispatchEvent(new MouseEvent("mousedown", init))) {
                                el.closest?.("a[href], area[href], button, input, select, textarea, summary, [tabindex], [contenteditable]")?.focus?.();
                            }
                            return "ok";
                        case "up": {
                            moveTo(el, pinit, true);
                            el.dispatchEvent(new PointerEvent("pointerup", pinit));
                            el.dispatchEvent(new MouseEvent("mouseup", init));
                            const was = pressedAt;
                            pressedAt = null;
                            // A click if let go where it was pressed (or within).
                            if (!was || !(was === el || was.contains(el) || el.contains(was))) return "ok";
                            if (button === 0) {
                                if (typeof el.click === "function") el.click();
                                else el.dispatchEvent(new MouseEvent("click", init));
                                if (Number(a.count) === 2) el.dispatchEvent(new MouseEvent("dblclick", init));
                            } else {
                                if (button === 2) el.dispatchEvent(new MouseEvent("contextmenu", init));
                                el.dispatchEvent(new MouseEvent("auxclick", init));
                            }
                            return "ok";
                        }
                        case "click":  // a key that presses what has the focus
                            if (typeof el.click === "function") el.click();
                            return "ok";
                        case "cancel":
                            pressedAt = null;
                            return "ok";
                        case "wheel": {
                            moveTo(el, pinit, true);
                            const dx = Number(a.dx) || 0, dy = Number(a.dy) || 0;
                            if (!el.dispatchEvent(new WheelEvent("wheel", { ...init, deltaX: dx, deltaY: dy, deltaMode: 0 }))) return "ok";
                            // Scrolled: the nearest that can be, or the page.
                            for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
                                const st = getComputedStyle(n);
                                if (/(auto|scroll)/.test(st.overflowY + st.overflowX) && (n.scrollHeight > n.clientHeight || n.scrollWidth > n.clientWidth)) {
                                    ownScroll(() => n.scrollBy(dx, dy));
                                    return "ok";
                                }
                            }
                            window.scrollBy(dx, dy);
                            return "ok";
                        }
                    }
                    return "unknown";
                }
            }
            return "unknown";
        }
        function io(json) {
            let list;
            try { list = JSON.parse(json); } catch { return "bad"; }
            for (const e of Array.isArray(list) ? list : []) {
                const el = node(e?.i);
                const key = e?.o + ":" + e?.i;
                if (!el || !ioSent.has(key)) continue;
                const z = Array.isArray(e.z) ? e.z.map(Number) : undefined;  // sizes, for a ResizeObserver
                const now = z ? z.join() : (e.hit ? "1" : "0") + ":" + Number(e.ratio).toFixed(3);
                if (ioLast.get(key) === now) continue;  // as it was: not again
                ioLast.set(key, now);
                el.dispatchEvent(new CustomEvent("__tabtop_io_entry", { composed: true, detail: JSON.stringify({ o: e.o, hit: !!e.hit, ratio: Number(e.ratio) || 0, b: e.b, r: e.r, rb: e.rb, z }) }));
            }
            return "ok";
        }

        // setMediaKeys may precede insertion of the video. Reserve its
        // number without marking it as already serialized to the frame.
        const reservedMedia = new WeakMap();
        const known = (n) => ids.has(n);
        function id(n) {
            let i = ids.get(n);
            if (!i) {
                i = reservedMedia.get(n) ?? next++;
                reservedMedia.delete(n);
                ids.set(n, i);
                byId.set(i, new WeakRef(n));
            }
            return i;
        }
        function node(i) {
            const n = byId.get(i)?.deref();
            return n && n.isConnected ? n : null;
        }

        const canvasReplies = new WeakMap();
        const dirtyCanvases = new Set();
        const canvasLater = new Set();
        const canvasWhole = new Set();  // of those, the ones to be read whole (left out of a whole read)
        // WebGL canvases sent (their logs), to say which have left the
        // document: the server counts a page's WebGL canvases (goGLStreamsMax).
        // WebGL canvases taken out of the page (said gone: the server's let
        // their stream go), to be read whole if they're put back.
        const glAway = new Set();
        const glSent = new Map();  // canvas -> its number  // WebGL canvases left out of a batch, for the next
        let canvasReads = 0, canvasReadBytes = 0;
        let canvasGLReadBytes = 0, canvasGLSnapshotBytes = 0;
        // A canvas here or in a same-origin frame read here (frameKids): a
        // frame's elements aren't this world's HTMLCanvasElement.
        const frameOwners = new WeakMap();  // a frame's document -> its iframe
        const isCanvas = (el) => el instanceof HTMLCanvasElement || el?.nodeType === 1 && el.localName === "canvas" && frameOwners.has(el.ownerDocument);
        // framePath is the iframes (outermost first) a canvas is within, by
        // number, for the copy to find it in its frame's copy; null if one
        // isn't known.
        function framePath(el) {
            const path = [];
            for (let d = el.ownerDocument; d !== document; d = frameOwners.get(d)?.ownerDocument) {
                const owner = d && frameOwners.get(d);
                if (!owner || !known(owner) || path.length >= 4) return null;
                path.unshift(ids.get(owner));
            }
            return path;
        }
        // tell sends a canvas one of the page hooks' events (gogl.js,
        // gocanvas.js). A same-origin frame's, by way of this page's gogl.js
        // (__tabtop_frame_canvas, on its iframe): Moli doesn't take this
        // world's events to a frame's page, and the reply comes back the
        // same way (frameCanvasReply). One frame deep.
        const frameCanvases = (doc) => Reflect.apply(Document.prototype.querySelectorAll, doc, ["canvas"]);
        function tell(el, type, detail) {
            const doc = el.ownerDocument;
            if (doc === document) return Reflect.apply(EventTarget.prototype.dispatchEvent, el, [new CustomEvent(type, { bubbles: true, composed: true, detail })]);
            const owner = frameOwners.get(doc);
            if (owner?.ownerDocument !== document) return;
            const index = Array.prototype.indexOf.call(frameCanvases(doc), el);
            if (index >= 0) Reflect.apply(EventTarget.prototype.dispatchEvent, owner, [new CustomEvent("__tabtop_frame_canvas", { bubbles: true, composed: true, detail: JSON.stringify({ index, type, detail }) })]);
        }
        // What the page's gogl.js passes back from a frame's canvas: its
        // reply to a read, or that it was drawn on.
        function frameCanvas(event, f) {
            const owner = at(event);
            if (!(owner instanceof HTMLIFrameElement) || typeof event.detail !== "string" || event.detail.length > (4 << 20) + 256) return;
            try {
                const m = JSON.parse(event.detail);
                let doc;
                try { doc = owner.contentDocument; } catch { return; }
                const el = doc && frameOwners.get(doc) === owner && Number.isInteger(m?.index) ? frameCanvases(doc)[m.index] : null;
                if (el) f(el, m);
            } catch { /* malformed or forged */ }
        }
        document.addEventListener("__tabtop_frame_canvas_reply", (event) => frameCanvas(event, (el, m) => typeof m.reply === "string" && canvasReply({ target: el, detail: m.reply })), true);
        document.addEventListener("__tabtop_frame_canvas_dirty", (event) => frameCanvas(event, (el) => canvasDirty({ target: el })), true);
        function canvasReply(event) {
            const el = at(event);
            if (!isCanvas(el) || typeof event.detail !== "string" || event.detail.length > (4 << 20) + 64) return;
            try {
                const result = JSON.parse(event.detail);
                if (typeof result?.p === "string" && result.p.length <= (1 << 20)) canvasReplies.set(el, { p: result.p });
                else if (glLogValid(result?.gl)) canvasReplies.set(el, { gl: { v: result.gl.v, w: result.gl.w, h: result.gl.h, r: result.gl.r === true, version: result.gl.version, attributes: result.gl.attributes } });
                else if (["unsupported", "tainted", "large"].includes(result?.e)) canvasReplies.set(el, { e: result.e });
            } catch { /* malformed or forged canvas notification */ }
        }
        document.addEventListener("__tabtop_canvas_pixels", canvasReply, true);
        // glLogValid says whether a hook's reply carries a WebGL log, as one
        // goes on to the server and the viewer (gogl.js's capture protocol):
        // {v: the calls, JSON; w, h; r: whole; version; attributes}.
        function glLogValid(gl) {
            return !!gl && typeof gl === "object" && typeof gl.v === "string" && gl.v.length <= (4 << 20) && Number.isInteger(gl.w) && Number.isInteger(gl.h) && [1, 2].includes(gl.version)
                && Number.isInteger(gl.attributes) && gl.attributes >= 0 && gl.attributes <= 63 && gl.w > 0 && gl.h > 0 && gl.w <= 4096 && gl.h <= 4096;
        }
        function canvasDirty(event) {
            const el = at(event);
            if (isCanvas(el) && known(el) && el.isConnected && dirtyCanvases.size < 64) dirtyCanvases.add(el);
        }
        document.addEventListener("__tabtop_canvas_dirty", canvasDirty, true);
        document.addEventListener("__tabtop_webgl_dirty", canvasDirty, true);
        // canvasPixels reads a canvas: a WebGL one's command log (whole, with
        // full; else what's new since the last read) or a 2D one's PNG. A
        // WebGL log that doesn't fit this batch is given back to the page's
        // hook (gogl.js) to be read again, and, with later, comes next batch.
        // What a batch's canvases may come to: in another site's frame
        // (goframes.go: its whole document read within 2 MB), less.
        // (A frame's read again without them, its whole too much for the
        // limit: goframes.go sets __tabtopFrameCanvasCap to 0 for that read.)
        const canvasCapNow = () => globalThis.__tabtopFrameWorld !== true ? 4 << 20
            : Number.isInteger(globalThis.__tabtopFrameCanvasCap) ? globalThis.__tabtopFrameCanvasCap : 1 << 20;
        function canvasPixels(el, full = false) {
            if (!isCanvas(el)) return { e: "unsupported" };
            if (++canvasReads > 32) {
                // Past what's read at once: read later (with the changes
                // after), not left unavailable, as one drawn once never asks;
                // whole, if it was to be (canvasWhole).
                canvasLater.add(el);
                if (full) canvasWhole.add(el);
                return full ? { e: "large" } : { later: true };
            }
            canvasReplies.delete(el);
            try {
                tell(el, "__tabtop_webgl_capture", full ? "full" : "delta");
                const reply = canvasReplies.get(el), gl = reply?.gl;
                if (gl) {
                    const actualFull = full || gl.r === true;
                    // A batch's WebGL logs: 3 MB of updates, 4 MB of whole
                    // ones; the first of either up to 4 MB (a log's most),
                    // so one never waits for good. (A frame's: a quarter.)
                    const spent = actualFull ? canvasGLSnapshotBytes : canvasGLReadBytes;
                    const canvasCap = canvasCapNow();
                    if (spent + gl.v.length > (actualFull ? canvasCap : canvasCap * 3 / 4) && !(spent === 0 && gl.v.length <= canvasCap)) {
                        // Given back to gogl.js (whole, if it was), and read
                        // with the next changes; a whole one shown unavailable
                        // till then, so read whole then too (canvasWhole).
                        tell(el, "__tabtop_webgl_undo", actualFull ? "full" : "delta");
                        canvasLater.add(el);
                        if (full) canvasWhole.add(el);
                        return full ? { e: "large" } : { later: true };
                    }
                    canvasGLReadBytes += gl.v.length;
                    if (actualFull) canvasGLSnapshotBytes += gl.v.length;
                    if (known(el)) glSent.set(el, ids.get(el));
                    return reply;
                }
                if (reply?.e) return reply;
                tell(el, "__tabtop_canvas_capture", null);
            } catch { return { e: "unsupported" }; }
            const result = canvasReplies.get(el) ?? { e: "unsupported" };
            if (result.p) {
                canvasReadBytes += result.p.length;
                const canvasCap = canvasCapNow();
                if (canvasReadBytes > canvasCap) {
                    if (full && result.p.length <= canvasCap * 3 / 4) canvasLater.add(el);  // (with the changes after)
                    return { e: "large" };
                }
            }
            return result;
        }

        let count = 0;
        const frames = new Map();
        // framePrintChanged: whether a frame's markup changed since it was
        // last read, looked at once a second at most. For an engine whose
        // observers miss what changes in another window's document
        // (Obscura): this world's observer can't be the frame's own (see
        // frameKids), and nothing of this world is handed to the frame's.
        function framePrint(child) {
            try { return String(child?.documentElement?.outerHTML ?? ""); } catch { return ""; }
        }
        function framePrintChanged(state) {
            if (!state.observer || performance.now() - state.printed < 1000) return false;
            state.printed = performance.now();
            const print = framePrint(state.child);
            const changed = print !== state.print;
            state.print = print;
            return changed;
        }
        function frameKids(el, depth) {
            let child;
            try { child = el.contentDocument; } catch { /* inaccessible origin */ }
            const prev = frames.get(el);
            if (prev?.child !== child) prev?.observer?.disconnect();
            if (!child || !child.documentElement) {
                frames.set(el, { child, depth });
                return [];
            }
            const state = { child, depth, dirty: false };
            // Its canvases are read by way of the page's gogl.js, which sends
            // their replies and drawing on the iframe (tell, frameCanvas):
            // nothing of this world's is handed to the frame's document,
            // whose methods are the page's to replace.
            frameOwners.set(child, el);
            // This world's own MutationObserver, never the frame's: in both
            // engines a frame's window here is the page's own, and a page
            // can replace its constructor and be handed this callback (and
            // through it, this world's Function: the agent's to run).
            state.observer = new MutationObserver(() => { state.dirty = true; });
            prev?.observer?.disconnect();
            state.observer.observe(child, { subtree: true, childList: true, attributes: true, characterData: true });
            frames.set(el, state);
            state.print = framePrint(child);  // as it is when read
            state.printed = performance.now();
            return [{ i: id(child), t: 9, b: child.baseURI, c: kids(child, depth + 1) }];
        }
        // Media children are represented by one player in the viewer. Send
        // its selected URL even when only a child source's attribute changed.
        const mediaURLs = new WeakMap();
        // As a browser picks its file: its own src if it has one (empty:
        // nothing to play), else its first <source> with one that isn't
        // empty (a placeholder <source src=""> passed over). As gomedia.js's.
        const mediaURL = (el) => el.hasAttribute("src") ? el.getAttribute("src") || null : el.querySelector(':scope > source[src]:not([src=""])')?.getAttribute("src") ?? null;
        // What the copy's src says: the element's own if it has one ("":
        // empty, its <source>s not to be looked at), else its <source>'s,
        // else none (null: the copy looks at its <source>s, as it's sent them).
        const mediaSrc = (el) => el.hasAttribute("src") ? el.getAttribute("src") : mediaURL(el);

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
            if (n instanceof HTMLMediaElement) {
                const url = mediaSrc(n);
                set("src", url);
                mediaURLs.set(n, url);
            } else if (name === "input") {
                if (/^(checkbox|radio)$/i.test(n.type)) set("checked", n.checked ? "" : null);
                else if (!/^(file|image|submit|reset|button)$/i.test(n.type)) set("value", n.value);
            } else if (name === "option") {
                set("selected", n.selected ? "" : null);
            }
            const out = { i: id(n), t: 1, n: name };
            if (a.length) out.a = a;
            if (name === "canvas") {
                const pixels = canvasPixels(n, true);
                if (pixels.p) out.p = pixels.p;
                if (pixels.gl) out.gl = pixels.gl;
                if (pixels.e) out.pe = pixels.e;
            }
            let c;
            if (name === "style" && n.namespaceURI === "http://www.w3.org/1999/xhtml" && !n.textContent.trim()) {
                // Rules put in by script (styled-components, Emotion: in
                // production, insertRule, no text): what the copy gets is
                // what's in the sheet, as a text node of its own, which
                // changes says again as rules come and go.
                const r = rulesOf(n);
                if (r) {
                    c = [{ i: r.id, t: 3, v: r.text }];
                    out.c = c;
                    return out;
                }
            }
            if (name === "iframe") {
                // Include same-origin descendants of readable iframe
                // documents too. Their iframe owners still belong to this
                // agent's node-number space, which the server needs to route
                // a deeper cross-origin frame through its parent document.
                c = depth < 600 && (frames.has(n) || frames.size < 64) ? frameKids(n, depth) : [];
            } else {
                c = name === "textarea" ? [{ i: id(n.firstChild || n), t: 3, v: n.value }] : depth < 600 ? kids(n, depth) : [];
                if (n === n.ownerDocument?.head) {
                    const sheets = adoptedNode(n.ownerDocument);
                    if (sheets) c.push(sheets);
                }
            }
            if (c.length) out.c = c;
            const root = shadowOf(n);
            if (root && depth < 600) out.s = serShadow(root, depth + 1);
            return out;
        }

        // --- Shadow roots ------------------------------------------------
        //
        // shadowOf is el's shadow root, if it's one this world can read (an
        // open one; a closed one goshadow.js made open). (Duck-typed: an
        // embedded page's nodes may be its own world's, not this one's.)
        // (Moli's world for this agent keeps an element's shadowRoot as it
        // first read it: one attached since is had from goshadow.js's event,
        // from the root.)
        // (Nor is a root's host to be had from it, read so: each root's
        // host is kept as it was found.)
        const hostRoots = new WeakMap();  // host -> its root
        const rootHosts = new WeakMap();  // root -> its host
        const hostOf = (root) => rootHosts.get(root) ?? root.host;
        function shadowOf(el) {
            let root = hostRoots.get(el) ?? null;
            if (!root) {
                try { root = el.shadowRoot; } catch { return null; }
                if (!root || root.nodeType !== 11 || root.host !== el) return null;
                hostRoots.set(el, root);
                rootHosts.set(root, el);
            }
            return root;
        }
        const watching = { subtree: true, childList: true, attributes: true, characterData: true };
        // The shadow roots sent (to look at their adopted stylesheets each
        // read), and the hosts given a shadow root since (goshadow.js).
        const roots = new Set();
        const shadowsNew = new Set();
        document.addEventListener("__tabtop_shadow", (e) => {
            // (From the root: its path, the root then its host.)
            const path = e.composedPath?.() ?? [], root = path[0], host = path[1];
            if (root?.nodeType !== 11 || host?.nodeType !== 1) return;
            hostRoots.set(host, root);
            rootHosts.set(root, host);
            if (shadowsNew.size < 4096) shadowsNew.add(host);
        }, true);
        function serShadow(root, depth) {
            // Watched as its document is: the page's own by this world's
            // observer; an embedded page's by its frame's (whose changes are
            // its document read again).
            const doc = hostOf(root).ownerDocument;
            if (doc === document) observer.observe(root, watching);
            else for (const f of frames.values()) if (f.child === doc) f.observer?.observe(root, watching);
            roots.add(root);
            const ss = cssRef(adoptedText(root));
            rootCss.set(hostOf(root), ss);
            const out = { i: id(root), t: 11, c: kids(root, depth) };
            if (ss) out.ss = ss;
            return out;
        }
        // A shadow root's adopted stylesheets, by a number for their text,
        // each text said once (cssOut, with what's sent next) while the copy
        // has it (cssSent: till the document's read again).
        const cssIDs = new Map();  // text -> its number
        let cssSent = new Set(), cssOut = {};
        const rootCss = new WeakMap();  // a root's host -> the number its root was said to adopt
        function cssRef(text) {
            if (!text) return 0;
            let n = cssIDs.get(text);
            if (!n) cssIDs.set(text, n = cssIDs.size + 1);
            if (!cssSent.has(n)) {
                cssSent.add(n);
                cssOut[n] = text;
            }
            return n;
        }
        function cssTaken() {
            const out = cssOut;
            cssOut = {};
            return Object.keys(out).length ? out : null;
        }
        // Adopted stylesheets (constructed ones: Lit's, a design system's),
        // which no node holds: as a <style> of their own, under numbers of
        // their own (stand-ins kept with the root), their text the rules'.
        const adopted = new Map();  // a root's host (or the document) -> {el, txt, text}
        const keyOf = (root) => root.nodeType === 11 ? hostOf(root) : root;
        const sheetTexts = new WeakMap();  // CSSStyleSheet -> {count, text}
        // What goshadow.js, in the page's world, says of adopted
        // stylesheets (which this world doesn't see in Moli), by the root's
        // host (or the document), as they're adopted or change, and all
        // again when asked; those told since the last read; and whether
        // it's there to say.
        const told = new WeakMap(), toldNow = new Set();
        let helped = false;
        document.addEventListener("__tabtop_adopted", (e) => {
            const at = e.composedPath?.()[0];
            if (!at || typeof e.detail !== "string") return;
            helped = true;
            told.set(at, e.detail);
            if (toldNow.size < 4096) toldNow.add(at);
        }, true);
        const askAdopted = () => window.postMessage({ __tabtop: "adopted" }, "*");
        let adoptedChecked = 0;
        askAdopted();
        function sheetText(sheet) {
            let rules;
            try { rules = sheet.cssRules; } catch { return ""; }
            const was = sheetTexts.get(sheet);
            if (was && was.count === rules.length) return was.text;
            let text = "";
            for (const rule of rules) {
                text += rule.cssText + "\n";
                if (text.length > 1 << 20) break;
            }
            sheetTexts.set(sheet, { count: rules.length, text });
            return text;
        }
        function adoptedText(root) {
            const key = keyOf(root);
            if (told.has(key)) return told.get(key);
            if (helped) return "";  // (not adopted, or not told yet: told, it's said then)
            // (No page's world to say: read here.)
            let sheets;
            try { sheets = root.adoptedStyleSheets; } catch { return ""; }
            if (!sheets?.length) return "";
            let text = "";
            for (const sheet of sheets) {
                text += sheetText(sheet);
                if (text.length > 1 << 20) break;
            }
            return text;
        }
        function adoptedNode(root) {
            const text = adoptedText(root);
            let a = adopted.get(keyOf(root));
            if (!text && !a) return null;
            if (!a) adopted.set(keyOf(root), a = { el: {}, txt: {}, text });
            a.text = text;
            return { i: id(a.el), t: 1, n: "style", a: ["data-go-adopted", ""], c: [{ i: id(a.txt), t: 3, v: text }] };
        }
        // The children a head's said to have, with its document's adopted
        // stylesheets' <style> at their end.
        function withSheets(p, c) {
            const a = p === p.ownerDocument?.head ? adopted.get(p.ownerDocument) : null;
            if (a) c.push({ i: ids.get(a.el), r: 1 });
            return c;
        }
        // A <style> with rules but no text: its rules as text, under a number
        // of its own for the copy's text node (a stand-in object, kept as
        // long as the element), and how many rules there were when said.
        const ruled = new Map();  // style element -> {id, count, text, told}
        let sheetsAsked = 0;
        document.addEventListener("__tabtop_sheet", (e) => {
            const r = ruled.get(at(e));
            if (!r) return;
            let d;
            try { d = JSON.parse(e.detail); } catch { return; }
            if (Number.isSafeInteger(d?.count) && typeof d?.text === "string") r.told = { count: d.count, text: d.text.slice(0, 4 << 20) };
        }, true);
        function rulesOf(el) {
            let rules;
            try { rules = el.sheet?.cssRules; } catch { return null; }
            const was = ruled.get(el);
            if (!rules || (!rules.length && !was)) {
                if (!was && el.isConnected) ruled.set(el, { stand: {}, id: 0, count: 0, text: "" });  // watched for rules to come
                return null;
            }
            let text = "";
            for (const rule of rules) {
                text += rule.cssText + "\n";
                if (text.length > 4 << 20) break;  // a sheet that big is the page's own problem
            }
            const r = was ?? { stand: {}, id: 0, count: 0, text: "" };
            if (!r.id) r.id = id(r.stand);
            // What the page's world last told, if it's told since: this
            // world's own read is right only the first time (Moli).
            if (was?.count && was.count !== rules.length) return was;
            r.count = rules.length;
            r.text = text;
            ruled.set(el, r);
            return r;
        }
        function kids(n, depth) {
            const c = [];
            for (let k = n.firstChild; k; k = k.nextSibling) {
                const s = ser(k, depth + 1);
                if (s) c.push(s);
            }
            return c;
        }

        // Records naming nodes of another world (the page's: Lightpanda
        // gives them when the page's script made the change) aren't this
        // world's to number, nor to touch (their prototypes are the
        // page's): the document is read again whole instead.
        let foreign = false;
        const observer = new MutationObserver((records) => {
            for (const r of records) {
                if (!(r.target instanceof Node)) { foreign = true; continue; }
                if (r.type === "childList") parents.add(r.target);
                else if (r.type === "characterData") texts.add(r.target);
                else if (r.type === "attributes") {
                    if (!attrs.has(r.target)) attrs.set(r.target, new Set());
                    attrs.get(r.target).add(r.attributeName);
                    if (r.target instanceof HTMLCanvasElement && (r.attributeName === "width" || r.attributeName === "height") && dirtyCanvases.size < 64) dirtyCanvases.add(r.target);
                }
            }
        });

        function snapshot() {
            count = 0;
            canvasReads = 0;
            canvasReadBytes = 0;
            canvasGLReadBytes = 0;
            canvasGLSnapshotBytes = 0;
            dirtyCanvases.clear();
            canvasLater.clear();
            canvasWhole.clear();
            glSent.clear();
            glAway.clear();
            for (const frame of frames.values()) frame.observer?.disconnect();
            frames.clear();
            observer.disconnect();
            observer.takeRecords();
            roots.clear();
            shadowsNew.clear();
            cssSent = new Set();
            cssOut = {};
            askAdopted();  // (told again: what's read now has them, each changes after)
            parents = new Set(); attrs = new Map(); texts = new Set();
            seq = 0;
            const doc = ser(document, 0);
            const css = cssTaken();
            if (css) doc.css = css;
            observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
            lastURL = here();
            // What's playing already: said with the first batch; and what the
            // page started or stopped that wasn't said yet (the page read
            // again, the copy having asked, between its play() and the batch
            // that would have said it: its stream's player, paused till told,
            // would wait for good).
            const unsaid = played;
            played = new Map();
            for (const m of document.querySelectorAll("video, audio")) if (!m.paused && !m.ended) played.set(m, true);
            for (const [m, playing] of unsaid) played.set(m, playing);
            // All of what's observed, for the copy built from this.
            ioSent = new Set();
            ioOut = [];
            ioLast.clear();
            ioNew();
            const ioAll = ioOut;
            ioOut = [];
            // Where the window's scrolled (as the copy last scrolled it): a
            // copy built afresh (a tab taken back) starts there.
            const at = [Math.round(scrollX) || 0, Math.round(scrollY) || 0];
            return JSON.stringify({ url: here(), base: document.baseURI, title: document.title, type: document.contentType, doc, io: ioAll, at });
        }

        let emeNode = 0, emeBatch = [];
        document.addEventListener("__tabtop_eme_element", e => {
            const el = e.relatedTarget;
            emeNode = 0;
            if (!(el instanceof HTMLMediaElement)) return;
            emeNode = ids.get(el) ?? reservedMedia.get(el);
            if (!emeNode) {
                emeNode = next++;
                reservedMedia.set(el, emeNode);
            }
        });
        document.addEventListener("__tabtop_eme_command", e => {
            if (typeof e.detail === "string" && e.detail.length <= 49152 && emeBatch.length < 4) {
                try { emeBatch.push({ ...JSON.parse(e.detail), node: emeNode }); } catch { /* malformed command */ }
            }
            emeNode = 0;
        });

        let streamBatch = null;
        document.addEventListener("__tabtop_stream", (e) => {
            if (typeof e.detail !== "string" || e.detail.length > (1 << 20)) return;
            try { streamBatch = JSON.parse(e.detail); } catch { /* malformed batch */ }
        });

        function changes() {
            for (const r of observer.takeRecords()) {
                if (!(r.target instanceof Node)) { foreign = true; continue; }
                if (r.type === "childList") parents.add(r.target);
                else if (r.type === "characterData") texts.add(r.target);
                else if (r.type === "attributes") {
                    if (!attrs.has(r.target)) attrs.set(r.target, new Set());
                    attrs.get(r.target).add(r.attributeName);
                }
            }
            if (foreign) {
                foreign = false;
                parents = new Set(); attrs = new Map(); texts = new Set();
                seq++;
                return JSON.stringify({ seq, url: here(), title: document.title, again: true });
            }
            const ops = [];
            count = 0;
            canvasReads = 0;
            canvasReadBytes = 0;
            canvasGLReadBytes = 0;
            canvasGLSnapshotBytes = 0;
            // Only nodes numbered before now: new ones come whole, inside
            // their parent's children.
            const before = next;
            const old = (n) => known(n) && ids.get(n) < before;
            // (A frame's in the page's document, or in a frame's of it that's
            // still there: a same-origin frame's own frames are read too.)
            // (Asked as each is come to: a frame read again in this loop has
            // its own frames' document anew.)
            const live = (doc) => doc === document || [...frames.values()].some((f) => f.child === doc);
            for (const [el, state] of frames) {
                if (!el.isConnected || !live(el.ownerDocument)) {
                    state.observer?.disconnect();
                    frames.delete(el);
                    continue;
                }
                let child;
                try { child = el.contentDocument; } catch { /* inaccessible origin */ }
                if (child !== state.child || state.dirty || state.observer?.takeRecords().length ||
                    !state.observer && child?.documentElement || framePrintChanged(state)) {
                    // A frame in a frame: the page's own frame it's in read
                    // again, whole (its copy holds this one's).
                    let top = el;
                    while (top.ownerDocument !== document) {
                        const up = [...frames].find(([, f]) => f.child === top.ownerDocument)?.[0];
                        if (!up) break;
                        top = up;
                    }
                    if (top !== el) {
                        if (top.ownerDocument === document && frames.has(top)) {
                            ops.push({ o: "c", i: id(top), c: frameKids(top, frames.get(top).depth) });
                        }
                        continue;
                    }
                    const c = frameKids(el, state.depth);
                    // A frame this world can't read (another origin's) is read
                    // in a world of its own (goframes.go), which sends it: an
                    // empty one here would blank it in between.
                    if (child) ops.push({ o: "c", i: id(el), c });
                }
            }
            // Shadow roots attached since their host was sent (goshadow.js
            // says which): sent whole.
            for (const host of shadowsNew) {
                const root = shadowOf(host);
                if (root && !roots.has(root) && host.isConnected && old(host) && host.ownerDocument === document) {
                    ops.push({ o: "s", i: ids.get(host), s: serShadow(root, 0) });
                }
            }
            shadowsNew.clear();
            // Adopted stylesheets changed (no mutation says so): their
            // <style>'s text again, or, first had, the root's children with
            // it. The page's world says which changed, asked; else each is
            // read here.
            for (const root of roots) if (!hostOf(root).isConnected) roots.delete(root);
            const changedSheets = new Map();  // root -> text
            // (A sheet pushed onto a list, which nothing says: looked for
            // once a second, by the page's world, told as it's found.)
            if (helped && performance.now() - adoptedChecked > 1000) {
                adoptedChecked = performance.now();
                window.postMessage({ __tabtop: "adopted-check" }, "*");
            }
            if (helped) {
                for (const key of toldNow) {
                    const root = key === document ? document : shadowOf(key);
                    if (root) changedSheets.set(root, told.get(key));
                }
                toldNow.clear();
            } else {
                for (const root of [document, ...roots]) changedSheets.set(root, adoptedText(root));
            }
            for (const [root, text] of changedSheets) {
                if (root !== document) {
                    // A shadow root's: the number it adopts said, if it's changed.
                    const host = hostOf(root);
                    if (host.ownerDocument !== document || !roots.has(root) || !old(root)) continue;  // (an embedded page's: read again whole)
                    const ss = cssRef(text);
                    if (ss !== (rootCss.get(host) ?? 0)) {
                        rootCss.set(host, ss);
                        ops.push({ o: "ss", i: ids.get(root), ss });
                    }
                    continue;
                }
                const a = adopted.get(keyOf(root));
                if (a && known(a.txt)) {
                    if (text !== a.text) {
                        a.text = text;
                        ops.push({ o: "t", i: ids.get(a.txt), v: text });
                    }
                } else if (text) {
                    const parent = root === document ? document.head : root;
                    if (parent && old(parent)) parents.add(parent);  // (said with its children, below)
                }
            }
            const changedMedia = new Set();
            for (const p of parents) {
                if (p instanceof HTMLMediaElement) { changedMedia.add(p); continue; }
                if (p.localName === "iframe") continue; // its rendered children come from its document
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
                // The document's adopted stylesheets' <style>, the head's: as
                // it was, or (first had) new.
                if (p === document.head && adopted.has(document)) withSheets(p, c);
                else if (p === document.head) {
                    const sheets = adoptedNode(document);
                    if (sheets) c.push(sheets);
                }
                ops.push({ o: "c", i: ids.get(p), c });
            }
            for (const [n, names] of attrs) {
                if (n.localName === "source" && names.has("src") && n.parentElement instanceof HTMLMediaElement) changedMedia.add(n.parentElement);
                // A player's children (its sources, tracks) aren't drawn: the
                // copy has one player for them, told their address above. An
                // op of theirs would name a node it hasn't, and ask it all again.
                if (n.parentElement instanceof HTMLMediaElement) continue;
                if (!n.isConnected || !old(n)) continue;
                for (const name of names) {
                    if (/^on/i.test(name)) continue;
                    if (name === "src" && n instanceof HTMLMediaElement) { changedMedia.add(n); continue; }
                    ops.push({ o: "a", i: ids.get(n), n: name, v: n.getAttribute(name) });
                }
            }
            for (const el of changedMedia) {
                if (!el.isConnected || !old(el)) continue;
                const url = mediaSrc(el);
                if (url === mediaURLs.get(el)) continue;
                mediaURLs.set(el, url);
                ops.push({ o: "a", i: id(el), n: "src", v: url });
            }
            for (const n of texts) {
                if (n.isConnected && old(n)) ops.push({ o: "t", i: ids.get(n), v: n.data });
            }
            // Rules put in or taken out of a <style> by script: no mutation
            // says so. The page's world says, asked (gosheets.js): this
            // world's view of a sheet's rules doesn't follow the page's.
            for (const [el, r] of ruled) {
                if (!el.isConnected || el.textContent.trim()) { ruled.delete(el); continue; }  // gone, or said by its text now
                if (!r.told) continue;
                const { count, text } = r.told;
                r.told = null;
                if (count === r.count && text === r.text) continue;
                r.count = count;
                r.text = text;
                if (!r.id) {
                    // Watched with no rules: its children are said again, the
                    // stand-in among them.
                    r.id = id(r.stand);
                    if (old(el)) ops.push({ o: "c", i: ids.get(el), c: [{ i: r.id, t: 3, v: text }] });
                    continue;
                }
                ops.push({ o: "t", i: r.id, v: text });
            }
            if (ruled.size && performance.now() - sheetsAsked > 1000) {
                sheetsAsked = performance.now();
                window.postMessage({ __tabtop: "sheets" }, "*");  // posted: see the io-sync below
            }
            for (const [n, playing] of played) {
                if (n.isConnected && known(n)) ops.push({ o: "m", i: ids.get(n), v: String(playing) });
            }
            played = new Map();
            for (const [n, last] of watched) {
                if (!n.isConnected) { watched.delete(n); continue; }
                const v = n.type === "checkbox" || n.type === "radio" ? String(n.checked) : n.value;
                if (v !== last) {
                    watched.set(n, v);
                    ops.push({ o: "v", i: ids.get(n), v });
                }
            }
            let canvasFrames = 0;
            // Put back: whole (its stream's gone), drawn again or not.
            for (const el of glAway) {
                if (!el.isConnected || !known(el)) continue;
                glAway.delete(el);
                canvasWhole.add(el);
                if (dirtyCanvases.size < 64) dirtyCanvases.add(el);
            }
            for (const el of canvasLater) if (dirtyCanvases.size < 64) dirtyCanvases.add(el);
            canvasLater.clear();
            for (const el of dirtyCanvases) {
                if (canvasFrames >= 3 || canvasReadBytes >= (3 << 20)) break;
                dirtyCanvases.delete(el);
                if (!el.isConnected || !known(el)) continue;
                const path = framePath(el);
                if (!path) continue;
                const pixels = canvasPixels(el, canvasWhole.delete(el));
                const where = path.length ? { path } : {};
                if (pixels.later) canvasLater.add(el);
                else if (pixels.gl) ops.push({ o: "g", i: ids.get(el), gl: pixels.gl, ...where });
                else ops.push({ o: "p", i: ids.get(el), v: pixels.p ?? "", pe: pixels.e ?? "", ...where });
                canvasFrames++;
            }
            parents = new Set(); attrs = new Map(); texts = new Set();
            const moved = here() !== lastURL;
            lastURL = here();
            ioNew();
            const ioNow = ioOut;
            ioOut = [];
            const askedNow = asked;
            asked = [];
            const scrollsNow = [];
            for (const [el, what] of scrollsOut) if (el.isConnected && known(el)) scrollsNow.push({ i: ids.get(el), ...what });
            scrollsOut = new Map();
            streamBatch = null;
            document.dispatchEvent(new Event("__tabtop_read_stream"));
            const streams = Array.isArray(streamBatch) ? streamBatch : [];
            emeBatch = [];
            emeNode = 0;
            document.dispatchEvent(new Event("__tabtop_read_eme"));
            const eme = emeBatch;
            if (!eme.length && !ops.length && !streams.length && !moved && !ioNow.length && !askedNow.length && !scrollsNow.length) return "";
            const sel = ops.length ? caret() : null;
            seq++;
            const glGone = [];
            for (const [el, i] of glSent) {
                if (el.isConnected) continue;
                glSent.delete(el);
                glGone.push(i);
                if (glAway.size >= 64) glAway.delete(glAway.values().next().value);
                glAway.add(el);
            }
            const css = cssTaken();
            return JSON.stringify({ seq, url: here(), title: document.title, ops, io: ioNow, asked: askedNow, scrolls: scrollsNow, streams, eme, ...(glGone.length ? { glGone } : {}), ...(sel ? { sel } : {}), ...(css ? { css } : {}) });
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
            // The setter itself, as a framework that wraps value expects:
            // the element's class's, or the nearest along its prototypes
            // (Obscura has none on HTMLSelectElement's); else assigned.
            let setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
            for (let p = proto; !setter && p; p = Object.getPrototypeOf(p)) setter = Object.getOwnPropertyDescriptor(p, "value")?.set;
            if (setter) setter.call(el, v);
            else el.value = v;
        }

        function act(json) {
            const a = JSON.parse(json);
            if (a.kind === "eme-reply") {
                const target = a.id ? node(a.id) : document;
                target?.dispatchEvent(new CustomEvent("__tabtop_eme_reply", { detail: a.value, bubbles: true }));
                return "ok";
            }
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
                    // Rich text: the key's edit too, unless the page takes it.
                    if (a.edit && editable(el)) {
                        select(a.sel);
                        const go = el.dispatchEvent(new KeyboardEvent("keydown", init));
                        if (go && init.key.length === 1) el.dispatchEvent(new KeyboardEvent("keypress", init));
                        const edit = go && editOfKey(a);
                        if (edit) editScripted(el, edit[0], edit[1]);
                        el.dispatchEvent(new KeyboardEvent("keyup", init));
                        return "ok";
                    }
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
                case "edit": {
                    // An edit in rich text that wasn't a key (a phone's
                    // keyboard, an IME's word, a paste), by script: an
                    // embedded page's (goinput.go gives the top page's as
                    // input). A paste is offered to the page as one first:
                    // "insert" if it's to be put in as typed (it wasn't taken).
                    if (!editable(el)) return "not editable";
                    el.focus?.();
                    select(a.sel);
                    const type = String(a.inputType || ""), data = String(a.value ?? "");
                    if (type === "insertFromPaste") {
                        // Its HTML (a: its text styled) too: the page's to take,
                        // or put in, styled, as a browser would (rich text, not
                        // plaintext-only, whose paste is its text alone).
                        const html = typeof a.html === "string" ? a.html : "";
                        let dt = null;
                        try {
                            dt = new DataTransfer();
                            dt.setData("text/plain", data);
                            if (html) dt.setData("text/html", html);
                        } catch { dt = null; }
                        const taken = dt && !el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
                        if (taken) return "ok";
                        if (html && !plainText(el)) {
                            const s = selectionOf(el), r = rangeOf(s);
                            if (r && el.contains(r.startContainer) && el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertFromPaste", dataTransfer: dt }))) {
                                r.deleteContents();
                                const frag = pasted(el, html), last = frag.lastChild;
                                r.insertNode(frag);
                                if (last) {
                                    const after = el.ownerDocument.createRange();
                                    after.setStartAfter(last);
                                    s.setBaseAndExtent(after.startContainer, after.startOffset, after.startContainer, after.startOffset);
                                }
                                el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste" }));
                            }
                            return "ok";
                        }
                        if (a.edit) return "insert";  // (the top page's: put in as input)
                        const lines = data.split(/\r\n|\r|\n/);
                        lines.forEach((line, i) => {
                            if (i) editScripted(el, "insertLineBreak", "");
                            if (line) editScripted(el, "insertText", line);
                        });
                        return "ok";
                    }
                    if (!/^(insert|delete)/.test(type)) return "not an edit";
                    editScripted(el, type, data);
                    return "ok";
                }
                case "media-meta": {
                    // What the person's player found of this element's file
                    // (its size, its length), for the page to be told
                    // (gomedia.js, in its world): numbers only.
                    if (!(el instanceof HTMLMediaElement)) return "not media";
                    let d;
                    try { d = JSON.parse(a.value); } catch { return "bad"; }
                    const num = (v) => (Number.isFinite(v) ? v : 0);
                    const what = d?.play && typeof d.play === "object"
                        ? { play: { t: num(d.play.t), playing: !!d.play.playing, ended: !!d.play.ended } }  // how it plays
                        : { w: num(d?.w), h: num(d?.h), duration: num(d?.duration) };
                    if (what.play && Number.isSafeInteger(d.play.stream)) {
                        const ranges = (list) => Array.isArray(list) ? list.slice(0, 16).map((r) => [num(r?.[0]), num(r?.[1])]) : [];
                        Object.assign(what.play, { stream: d.play.stream, buffered: ranges(d.play.buffered),
                            buffers: Array.isArray(d.play.buffers) ? d.play.buffers.slice(0, 8).map(ranges) : [] });
                        if (Number.isSafeInteger(d.play.ack)) what.play.ack = d.play.ack;
                    }
                    tellingPlay = !!what.play;
                    try {
                        el.dispatchEvent(new CustomEvent("__tabtop_media", { composed: true, detail: JSON.stringify(what) }));
                    } finally {
                        tellingPlay = false;
                    }
                    return "ok";
                }
                case "scroll": {
                    // Where the person scrolled it to (the page's own
                    // smooth scrolling not used: it's there already). The
                    // engine doesn't say it scrolled (it fires scroll events
                    // as it renders, which it doesn't): said here, as a
                    // browser does, if it moved.
                    const x = Number(a.x) || 0, y = Number(a.y) || 0;
                    if (el === document.documentElement || el === document.body) {
                        const was = [scrollX, scrollY];
                        window.scrollTo({ left: x, top: y, behavior: "instant" });
                        if (scrollX !== was[0] || scrollY !== was[1]) document.dispatchEvent(new Event("scroll", { bubbles: true }));
                    } else if (el.nodeType === 1) {
                        // Set, not scrolled to: an engine's scrolling goes by
                        // its own layout (Moli's can have a box 20 pixels
                        // high that's 6000 here, and keeps it from moving),
                        // and the page reads where it is from this. Said
                        // each time: it's where the person scrolled it.
                        ownScroll(() => {
                            el.scrollLeft = x;
                            el.scrollTop = y;
                        });
                        el.dispatchEvent(new CustomEvent("__tabtop_scrolled", { composed: true, detail: JSON.stringify({ x, y }) }));  // goobserve.js
                        el.dispatchEvent(new Event("scroll"));
                    }
                    return "ok";
                }
            }
            return "unknown";
        }

        w.__tabtop = { snapshot, changes, act, io, into, point, keyTo, frameOwner, scripted };
        // What the page observed before this world was made (as it loaded),
        // asked for again: posted, not dispatched. An event from this world
        // handled in the page's, as the page loads, leaves part of it
        // undone in Moli (measured: dbs.com.sg's React never fills in some
        // of its text); a message comes in a task of the page's own.
        window.postMessage({ __tabtop: "io-sync" }, "*");
    }
    return w.__tabtop.snapshot();
})()
