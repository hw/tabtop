"use strict";
(() => {
    const web = src => /^(https?:|\/\/)/i.test(src ?? "");
    let mediaElements = [], activeGeneration = 0;
    let rectanglesPending = false;
    function rectangles() {
        rectanglesPending = false;
        const positions = mediaElements.map(element => {
            const r = element.getBoundingClientRect();
            return { id: Number(element.dataset.mediaId), rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
        });
        if (positions.length) parent.postMessage({ type: "media-positions", render: activeGeneration, positions }, "*");
    }
    function schedule() {
        if (!rectanglesPending) { rectanglesPending = true; requestAnimationFrame(rectangles); }
    }
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const resize = new ResizeObserver(schedule);
    resize.observe(document.documentElement);

    // An embedded (data:) picture or font in CSS, used as it is: a picture
    // as its data: URL (the frame allows those), a font as a blob: URL
    // (the frame allows only those). Nothing's fetched, so it isn't
    // external. Not a stylesheet: @import data: isn't followed.
    const pictureTypes = /^image\/(png|jpeg|gif|webp|avif|bmp|svg\+xml|x-icon|vnd\.microsoft\.icon)$/;
    function dataBytes(payload, base64) {
        if (base64) {
            const binary = atob(decodeURIComponent(payload).replace(/\s+/g, ""));
            return Uint8Array.from(binary, c => c.charCodeAt(0));
        }
        const out = [], encoder = new TextEncoder();
        for (let i = 0; i < payload.length; i++) {
            if (payload[i] === "%" && /^[0-9a-f]{2}$/i.test(payload.slice(i + 1, i + 3))) { out.push(parseInt(payload.slice(i + 1, i + 3), 16)); i += 2; }
            else out.push(...encoder.encode(payload[i]));
        }
        return Uint8Array.from(out);
    }
    function dataResource(src, kind, text) {
        const m = /^data:([^,;]*)((?:;[^,;]*)*),(.*)$/is.exec(src.trim());
        if (!m || text || !["image", "font"].includes(kind)) throw new Error("Embedded resource not supported.");
        const mime = m[1].trim().toLowerCase(), base64 = /;base64\s*$/i.test(m[2]);
        if (kind === "image") {
            if (!pictureTypes.test(mime)) throw new Error("Embedded picture type not supported.");
            return { url: src.trim() };
        }
        let bytes;
        try { bytes = dataBytes(m[3], base64); } catch { throw new Error("Embedded font could not be read."); }
        return { bytes, mime: /^font\/[a-z0-9.+-]+$/.test(mime) ? mime : "application/octet-stream" };
    }

    async function process(doc, { mode, ask, render, alive, report }) {
        activeGeneration = render;
        mediaElements = [];
        let externalCount = 0;
        const seen = new Set();
        const external = (src, base = "") => {
            if (/^\s*data:/i.test(src ?? "") || !web(src) && !web(base)) return;
            const key = base + "|" + src;
            if (!seen.has(key)) {
                seen.add(key); externalCount++;
                parent.postMessage({ type: "external-resources", count: externalCount }, "*");
            }
        };
        const errors = message => { if (report.errors.length < 20) report.errors.push(message); };
        const urls = [];
        const loaded = new Map(), fonts = new Set();
        let stylesheets = 0;
        const loadOnce = async (src, base, kind, text = false) => {
            if (/^\s*data:/i.test(src)) {
                const got = dataResource(src, kind, text);
                if (got.url) return got.url;
                const url = URL.createObjectURL(new Blob([got.bytes], { type: got.mime }));
                urls.push(url);
                return url;
            }
            const got = await ask({ type: "resource", src, base, kind, render });
            if (!alive()) throw new Error("Preview replaced.");
            if (got.error) throw new Error(got.error);
            if (got.url) return text ? { text: "", base: got.url, direct: true } : got.url;
            if (!(got.bytes instanceof ArrayBuffer)) throw new Error("Resource could not be read.");
            if (text) return { text: new TextDecoder().decode(got.bytes), base: got.base };
            const url = URL.createObjectURL(new Blob([got.bytes], { type: got.mime }));
            urls.push(url);
            return url;
        };
        const load = (src, base, kind, text = false) => {
            const key = JSON.stringify([src, base, kind, text]);
            if (!loaded.has(key)) {
                if (kind === "css" && text && ++stylesheets > 16) return Promise.reject(new Error("Stylesheet fetch limit reached (16 files)."));
                if (kind === "font" && !fonts.has(key)) {
                    if (fonts.size >= 8) return Promise.reject(new Error("Font preview limit reached (8 font files)."));
                    fonts.add(key);
                }
                loaded.set(key, loadOnce(src, base, kind, text));
            }
            return loaded.get(key);
        };
        const processor = TabTopCSS.cssProcessor({ load, external, error: errors, alive });
        const styles = [...doc.querySelectorAll("[data-preview-stylesheet], [data-preview-css]")].filter(item => {
            if (item.dataset.previewDisabled !== "true") return true;
            item.remove(); return false;
        });
        // Reveal the glyph before any network operation can block rendering.
        for (const item of styles) if (item.dataset.previewStylesheet) external(item.dataset.previewStylesheet);
        for (const media of doc.querySelectorAll("audio[data-preview-media], video[data-preview-media]")) external(media.dataset.previewMedia);
        for (const img of doc.querySelectorAll("img")) external(img.dataset.previewSrc ?? img.getAttribute("src"));
        // A stylesheet's pieces (see cssProcessor's rules), a <style> each.
        const addStyle = (pieces, before) => {
            for (const text of pieces) {
                if (!text) continue;
                const style = document.createElement("style");
                style.dataset.previewProcessed = "true";
                style.media = before.dataset.previewStyleMedia ?? "";
                style.textContent = text;
                before.before(style);
            }
        };
        for (const item of styles) {
            try {
                let text = item.dataset.previewCss ?? "", base = "";
                const source = item.dataset.previewStylesheet;
                if (source) {
                    if (web(source) && mode === "none") { item.remove(); continue; }
                    if (web(source) && mode === "direct") {
                        // Direct uses normal browser stylesheet/font loading.
                        const got = await ask({ type: "resource", src: source, kind: "css", render });
                        if (got.url && alive()) {
                            const link = document.createElement("link");
                            link.rel = "stylesheet"; link.media = item.dataset.previewStyleMedia ?? ""; link.href = got.url; link.referrerPolicy = "no-referrer";
                            item.before(link);
                        }
                        item.remove(); continue;
                    }
                    const got = await load(source, "", "css", true);
                    text = got.text; base = got.base;
                }
                addStyle(await processor.stylesheet(text, base, base ? [base] : [], 0, !!source), item);
            } catch (err) { errors(err.message); }
            item.remove();
        }
        for (const element of doc.querySelectorAll("[data-preview-inline-css]")) {
            try { element.style.cssText = await processor.inline(element.dataset.previewInlineCss); }
            catch (err) { errors(err.message); }
            delete element.dataset.previewInlineCss;
        }
        let mediaId = 0;
        const pendingMedia = [];
        const mediaNote = (media, text) => {
            const note = document.createElement("span");
            note.className = "note"; note.textContent = text;
            media.replaceWith(note);
        };
        // A player with nothing it can play isn't left empty.
        for (const media of doc.querySelectorAll("audio:not([data-preview-media]), video:not([data-preview-media])")) mediaNote(media, "Media with no source that can be played.");
        for (const media of doc.querySelectorAll("audio[data-preview-media], video[data-preview-media]")) {
            const src = media.dataset.previewMedia;
            delete media.dataset.previewMedia;
            // From the web, as the mode says; beside the file, played by
            // the page in any mode (as Proxy's are); anything else, not.
            const remote = web(src), local = !remote && !!src && !/^[a-z][a-z0-9+.-]*:/i.test(src);
            if (!remote && !local) { mediaNote(media, "Media source not supported."); continue; }
            if (remote && mode === "none") { mediaNote(media, "External media, not loaded."); continue; }
            if (remote && mode === "direct") {
                const got = await ask({ type: "media-direct", src, render });
                if (!alive()) return { urls, mounted() {} };
                if (got.url) { media.controls = true; media.preload = "metadata"; media.src = got.url; media.setAttribute("referrerpolicy", "no-referrer"); }
                else { const text = got.error ?? "External media couldn't be loaded."; errors(text); mediaNote(media, text); }
                continue;
            }
            if (mediaId >= 8) { media.replaceWith(document.createTextNode("Media preview limit reached.")); continue; }
            const placeholder = document.createElement("div");
            placeholder.dataset.mediaId = String(++mediaId);
            placeholder.setAttribute("aria-label", `${media.localName} player`);
            placeholder.style.setProperty("height", media.localName === "audio" ? "54px" : "260px", "important");
            placeholder.style.setProperty("width", "100%", "important");
            placeholder.style.setProperty("position", "relative", "important");
            placeholder.textContent = "Loading media…";
            const kind = media.localName;
            media.replaceWith(placeholder);
            mediaElements.push(placeholder);
            pendingMedia.push({ src, kind, mediaId, placeholder });
        }
        return {
            urls,
            async mounted() {
                rectangles();
                for (const { src, kind, mediaId, placeholder } of pendingMedia) {
                    if (!alive()) return;
                    const rect = placeholder.getBoundingClientRect();
                    const got = await ask({ type: "media", src, kind, mediaId, render, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
                    if (!alive()) return;
                    placeholder.textContent = got.error ?? "";
                    if (got.error) errors(got.error);
                    schedule();
                }
            },
        };
    }
    globalThis.TabTopHTMLResources = { process };
})();
