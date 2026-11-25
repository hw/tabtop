// The page's clipboard, in its own world, for an engine whose clipboard is
// its own (Moli 1.1.27, measured: navigator.clipboard.writeText resolves,
// into a clipboard nobody sees; document.execCommand("copy") is false and
// fires no copy event): what the page copies is told to the agent
// (goagent.js), which sends it on (gobrowser.go: only within
// goChooserAfterInput of the person's own input) for the person's browser
// to put on their clipboard (go.js); what it reads (readText, read) is
// asked of the person, each time, and given back here, or refused.
//
// Told on the topmost document of this one's origin it can reach: the one
// whose agent reads it (a same-origin frame's is read by its parent's).
// It's the page's to see and change, like anything in its world: what it
// says it copied is what it could have copied.
(() => {
    const MAX = 1 << 20;  // characters copied (gobrowser.go's goCopyMax)
    const IMAGE_MAX = 8 << 20;  // a PNG's bytes (goclipboard.go's goCopyImageMax)
    const reader = () => tabtopTop().document;  // (gopage-prelude.js)
    const tell = (type, detail) => {
        try { tabtopTell(reader(), type, detail); } catch { /* told nothing */ }
    };
    // What's copied: its text, and its picture or its HTML (rich text, as
    // a copy of what's selected in a page is), each if it has one.
    const copied = (text, image, html) => {
        const out = image ? { text: text === undefined ? undefined : String(text).slice(0, MAX), image } : { text: String(text ?? "").slice(0, MAX) };
        if (typeof html === "string" && html) out.html = html.slice(0, MAX);
        tell("__tabtop_copy", out);
    };
    const denied = () => new DOMException("Read permission denied.", "NotAllowedError");
    // A PNG's bytes as base64 (for the agent: text only between worlds).
    const base64 = (blob) => new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
    });
    const fromBase64 = (b64, type) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], { type });
    };

    // Reads asked for, by their own id, answered (__tabtop_pasted: the
    // text, or none) through the agent.
    const waiting = new Map();
    let listening = null;
    function ask(images) {
        if (listening !== reader()) {
            listening = reader();
            listening.addEventListener("__tabtop_pasted", (e) => {
                let d;
                try { d = JSON.parse(e.detail); } catch { return; }
                const w = d && waiting.get(d.id);
                if (!w) return;
                waiting.delete(d.id);
                clearTimeout(w.timer);
                if (typeof d.text === "string" || typeof d.image === "string") w.resolve({ text: typeof d.text === "string" ? d.text : null, image: typeof d.image === "string" ? d.image : null, html: typeof d.html === "string" && d.html ? d.html : null });
                else w.reject(denied());
            });
        }
        return new Promise((resolve, reject) => {
            const id = tabtopID();
            // (Not answered: the person didn't say, or the page went.)
            const timer = setTimeout(() => { waiting.delete(id); reject(denied()); }, 120_000);
            waiting.set(id, { resolve, reject, timer });
            tell("__tabtop_paste_ask", images ? { id, images: true } : { id });
        });
    }

    const define = (on, name, value) => Object.defineProperty(on, name, { value, writable: true, enumerable: true, configurable: true });
    const C = globalThis.Clipboard?.prototype;
    if (C) {
        define(C, "writeText", function writeText(text) {
            if (!arguments.length) return Promise.reject(new TypeError("Failed to execute 'writeText' on 'Clipboard': 1 argument required, but only 0 present."));
            copied(text);
            return Promise.resolve();
        });
        // An item's text, its picture (a PNG, as browsers write) and its
        // HTML, put on the clipboard together; any other type refused, as
        // browsers do.
        define(C, "write", async function write(items) {
            const item = [...(items ?? [])][0];
            if (!item?.types) return;
            for (const type of item.types) {
                if (type !== "text/plain" && type !== "image/png" && type !== "text/html") {
                    throw new DOMException(`Type ${type} not supported on write.`, "NotAllowedError");
                }
            }
            let text, image, html;
            if (item.types.includes("text/plain")) {
                const blob = await item.getType("text/plain");
                text = typeof blob === "string" ? blob : await blob.text();
            }
            if (item.types.includes("text/html")) {
                const blob = await item.getType("text/html");
                html = typeof blob === "string" ? blob : await blob.text();
            }
            if (item.types.includes("image/png")) {
                const blob = await item.getType("image/png");
                if (!(blob instanceof Blob)) throw new DOMException("The image isn't a Blob.", "DataError");
                if (blob.size > IMAGE_MAX) throw new DOMException("The image is too large to copy.", "DataError");
                const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
                if (![137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => head[i] === b)) throw new DOMException("Failed to decode the image.", "DataError");
                image = await base64(blob);
            }
            if (image) copied(text, image, html);
            else if (text !== undefined || html) copied(text, undefined, html);
        });
        define(C, "readText", function readText() { return ask().then((got) => got.text ?? ""); });
        // What's on the clipboard, as items: its picture (PNG), its HTML
        // and its text.
        define(C, "read", function read() {
            return ask(true).then((got) => {
                const types = {};
                if (got.image) types["image/png"] = fromBase64(got.image, "image/png");
                if (got.html) types["text/html"] = new Blob([got.html], { type: "text/html" });
                if (got.text) types["text/plain"] = new Blob([got.text], { type: "text/plain" });
                return Object.keys(types).length ? [new ClipboardItem(types)] : [];
            });
        });
    }

    // execCommand("copy") and ("cut"): as a browser does them, the page's
    // copy (or cut) event first, its handler's data if it took it, else
    // what's selected (a field's selection, or the document's).
    const exec = Document.prototype.execCommand;
    const fields = /^(?:text|search|url|tel|email|password|number)$/;
    const field = (el) => el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && fields.test(el.type));
    // selectedHTML is what's selected in the document, as HTML (not a
    // field's: that's text alone).
    function selectedHTML(el) {
        if (field(el)) return "";
        const sel = document.getSelection();
        if (!sel?.rangeCount || sel.isCollapsed) return "";
        const box = document.createElement("div");
        for (let i = 0; i < sel.rangeCount; i++) box.append(sel.getRangeAt(i).cloneContents());
        return box.innerHTML;
    }
    function selected(el) {
        const of = (f) => { try { return f.value.slice(f.selectionStart ?? 0, f.selectionEnd ?? 0); } catch { return ""; } };
        if (field(el)) return of(el);
        const text = String(document.getSelection() ?? "");
        if (text) return text;
        // A field selected (select()) without the focus given it, as a
        // copy button's hidden textarea can be.
        for (const f of document.querySelectorAll("textarea, input")) {
            if (field(f) && f.type !== "password" && (f.selectionEnd ?? 0) > (f.selectionStart ?? 0)) return of(f);
        }
        return "";
    }
    if (typeof exec === "function") define(Document.prototype, "execCommand", function execCommand(command) {
        const what = String(command).toLowerCase();
        if ((what !== "copy" && what !== "cut") || this !== document) return exec.apply(this, arguments);
        let el = document.activeElement;
        if (el instanceof HTMLInputElement && el.type === "password") return false;  // (as browsers keep them)
        const sel = document.getSelection();
        const at = field(el) ? el : (sel?.focusNode?.nodeType === 1 ? sel.focusNode : sel?.focusNode?.parentElement) ?? document.body ?? document.documentElement;
        let data = null;
        try { data = new DataTransfer(); } catch { /* none */ }
        let ev;
        try { ev = new ClipboardEvent(what, { bubbles: true, cancelable: true, composed: true, clipboardData: data }); } catch {
            ev = new Event(what, { bubbles: true, cancelable: true, composed: true });
        }
        const take = at.dispatchEvent(ev);
        if (!take) {
            const given = ev.clipboardData ?? data;
            const got = given?.getData("text/plain") ?? "", html = given?.getData("text/html") ?? "";
            if (got || html) copied(got, undefined, html);
            return true;
        }
        const text = selected(el);
        if (text) copied(text, undefined, selectedHTML(el));
        // A cut takes the selection out, where it can be edited.
        if (what === "cut" && text) {
            if (field(el) && !el.readOnly && !el.disabled) {
                el.setRangeText("", el.selectionStart, el.selectionEnd, "end");
                el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteByCut" }));
            } else if (sel && sel.rangeCount && at.isContentEditable) {
                sel.deleteFromDocument();
                at.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteByCut" }));
            }
        }
        return true;
    });
    // A canvas's picture as a Blob (toBlob), which this engine lacks
    // (Moli 1.1.27: its toDataURL draws, measured), as a page copying a
    // picture makes it.
    const Canvas = globalThis.HTMLCanvasElement?.prototype;
    if (Canvas && typeof Canvas.toBlob !== "function" && typeof Canvas.toDataURL === "function") {
        define(Canvas, "toBlob", function toBlob(callback, type, quality) {
            if (typeof callback !== "function") throw new TypeError("Failed to execute 'toBlob' on 'HTMLCanvasElement': The callback provided as parameter 1 is not a function.");
            const url = Canvas.toDataURL.call(this, type, quality);  // (throws, as toBlob, for a tainted canvas)
            setTimeout(() => {
                const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url);
                callback(m && m[2] ? fromBase64(m[3], m[1] || "image/png") : null);
            }, 0);
        });
    }
    // (Said supported: pages ask before they use it.)
    const supported = Document.prototype.queryCommandSupported;
    if (typeof supported === "function") define(Document.prototype, "queryCommandSupported", function queryCommandSupported(command) {
        const what = String(command).toLowerCase();
        return what === "copy" || what === "cut" ? true : supported.apply(this, arguments);
    });
})();
