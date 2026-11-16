import { call, collect, SERVER_DECODED } from "./requests.js";
import { el, maximizeButton } from "./preview-dom.js";
import { iconSVG } from "./glyphs.js";
import { typeOf } from "./preview-model.js";
import { MAX_IMAGE_DIFF_BYTES, imageDiffGeometry } from "./image-diff.js";

export function comparableImages(entries) {
    return entries.length === 2 && entries.every(entry => !entry.dir && typeOf(entry.name)?.kind === "image" && !SERVER_DECODED.has(typeOf(entry.name).type) && (entry.bytes ?? 0) <= MAX_IMAGE_DIFF_BYTES);
}

async function loadImage(side, signal) {
    if (side.blob || side.load) {
        const blob = side.blob ?? await side.load(signal);
        signal.throwIfAborted();
        if (!(blob instanceof Blob)) throw new Error("The image snapshot is unavailable.");
        if (blob.size > MAX_IMAGE_DIFF_BYTES) throw new Error("Each image must be at most 50 MB.");
        return blob;
    }
    const tunnel = await call(side.request ?? { type: "file", path: side.path }, { signal });
    const cancel = () => tunnel.close();
    signal.addEventListener("abort", cancel, { once: true });
    try {
        signal.throwIfAborted();
        if (tunnel.reply.size > MAX_IMAGE_DIFF_BYTES) throw new Error(`${side.name}: each image must be at most 50 MB.`);
        return await collect(tunnel, tunnel.reply.size, () => {}, typeOf(side.name)?.type ?? "application/octet-stream");
    } finally { signal.removeEventListener("abort", cancel); tunnel.close(); }
}

// Native decoding cannot be interrupted everywhere. Reject promptly and close
// a bitmap that finishes after cancellation or timeout instead of retaining it.
function waitForDecode(promise, signal) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (err, bitmap) => {
            if (settled) { bitmap?.close?.(); return; }
            settled = true;
            clearTimeout(timer); signal.removeEventListener("abort", cancel);
            if (err) reject(err); else resolve(bitmap);
        };
        const cancel = () => finish(signal.reason);
        const timer = setTimeout(() => finish(new Error("Image decoding took too long.")), 15000);
        signal.addEventListener("abort", cancel, { once: true });
        promise.then(bitmap => finish(null, bitmap), err => finish(err));
        if (signal.aborted) cancel();
    });
}
async function decodeImage(blob, signal) {
    let bitmap, img, url;
    try {
        signal.throwIfAborted();
        if (blob.type === "image/svg+xml") {
            // SVG is decoded only in an image element, where scripts are inert.
            // createImageBitmap(blob) doesn't support SVG in every browser.
            img = new Image();
            url = URL.createObjectURL(blob); img.src = url;
            await waitForDecode(img.decode(), signal);
            imageDiffGeometry(img.naturalWidth || 300, img.naturalHeight || 150, 1, 1);
        }
        bitmap = await waitForDecode(createImageBitmap(img ?? blob, { imageOrientation: "from-image" }), signal);
        signal.throwIfAborted();
        imageDiffGeometry(bitmap.width, bitmap.height, 1, 1);
        return bitmap;
    } catch (err) { bitmap?.close(); throw err; }
    finally { if (img) img.src = ""; if (url) URL.revokeObjectURL(url); }
}
function compute(a, b, signal) {
    return new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const worker = new Worker(new URL("./image-diff-worker.js", import.meta.url), { type: "module" });
        let settled = false;
        const finish = (err, result) => {
            // A result arriving after a timeout or abort has settled this
            // has nowhere to go: its bitmaps are closed, not left to the
            // garbage collector.
            if (settled) { result?.bitmaps?.forEach(bitmap => bitmap.close()); return; }
            settled = true;
            clearTimeout(timer); signal.removeEventListener("abort", cancel); worker.terminate();
            if (err) { result?.bitmaps?.forEach(bitmap => bitmap.close()); reject(err); } else resolve(result);
        };
        const cancel = () => finish(signal.reason);
        const timer = setTimeout(() => finish(new Error("Image comparison took too long. Try smaller images.")), 15000);
        signal.addEventListener("abort", cancel, { once: true });
        worker.onmessage = ({ data }) => finish(data.error ? new Error(data.error) : null, data.result);
        worker.onerror = event => { event.preventDefault(); finish(new Error("Couldn't run the image comparison worker in this browser.")); };
        try { worker.postMessage({ a, b }, [a, b]); } catch (err) { finish(err); }
    });
}

export function openImageDiff({ a, b, initialMode = "side" }) {
    const focus = document.activeElement, controller = new AbortController(), { signal } = controller;
    const sources = [], canvases = [], viewports = [], figures = [], controls = [];
    const closeButton = el("button", { type: "button", className: "image-diff-close close-glyph", title: "Close (Esc)", ariaLabel: "Close" });
    closeButton.innerHTML = iconSVG("close-circle");
    const summary = el("p", { className: "image-diff-summary", textContent: "Loading images…" });
    summary.setAttribute("role", "status");
    const modes = el("div", { className: "image-diff-modes" });
    modes.setAttribute("role", "group"); modes.setAttribute("aria-label", "Image comparison view");
    const button = (text, className, action) => {
        const result = el("button", { type: "button", className, textContent: text, disabled: true });
        controls.push(result); result.addEventListener("click", action); return result;
    };
    let ready = false, stopped = false, result, mode = initialMode, zoom = 1, fitting = true, center = { x: 0, y: 0 };
    const modeButtons = new Map();
    for (const [key, label] of [["side", "Side by side"], ["slider", "Slider"], ["delta", "Delta"], ["all", "All"], ["a", "A"], ["b", "B"]]) {
        const control = button(label, "image-diff-mode", () => setMode(key));
        if (["side", "slider", "delta"].includes(key)) {
            control.textContent = ""; control.innerHTML = iconSVG(key === "side" ? "compare" : key === "slider" ? "compare-slider" : "delta");
            control.title = label; control.setAttribute("aria-label", label); control.classList.add("glyph");
        }
        control.dataset.mode = key; control.setAttribute("aria-pressed", String(key === mode));
        modeButtons.set(key, control); modes.append(control);
    }
    const zoomLabel = el("output", { className: "image-diff-zoom" });
    const zoomControls = el("div", { className: "image-diff-zoom-tools" },
        button("−", "image-diff-zoom-out", () => setZoom(zoom / 1.25)),
        zoomLabel, button("+", "image-diff-zoom-in", () => setZoom(zoom * 1.25)),
        button("Fit", "image-diff-fit", () => { fitting = true; fit(); }),
        button("100%", "image-diff-actual", () => setZoom(1)));
    zoomControls.querySelector("button").setAttribute("aria-label", "Zoom out");
    zoomControls.querySelector(".image-diff-zoom-in").setAttribute("aria-label", "Zoom in");
    for (const [selector, icon, label] of [[".image-diff-zoom-out", "zoom-out", "Zoom out"], [".image-diff-zoom-in", "zoom-in", "Zoom in"], [".image-diff-fit", "fit-page", "Fit"], [".image-diff-actual", "actual-size", "100%"]]) {
        const control = zoomControls.querySelector(selector);
        control.textContent = ""; control.innerHTML = iconSVG(icon); control.classList.add("glyph");
        control.title = label; control.setAttribute("aria-label", label);
    }
    let reveal = 50, swapped = false;
    const sliderB = el("canvas", { className: "image-diff-slider-b" });
    const overlay = el("canvas", { className: "image-diff-overlay", hidden: true });
    const divider = el("button", { type: "button", className: "image-diff-divider", title: "Drag to reveal A or B; arrow keys adjust", ariaLabel: "Reveal A and B" });
    divider.setAttribute("role", "slider"); divider.setAttribute("aria-valuemin", "0"); divider.setAttribute("aria-valuemax", "100");
    const updateReveal = value => {
        reveal = Math.max(0, Math.min(100, value));
        sliderB.style.clipPath = `inset(0 0 0 ${reveal}%)`;
        divider.style.left = `${reveal}%`;
        divider.setAttribute("aria-valuenow", String(Math.round(reveal)));
        divider.setAttribute("aria-valuetext", `${Math.round(reveal)}% ${swapped ? "B" : "A"}, ${Math.round(100 - reveal)}% ${swapped ? "A" : "B"}`);
    };
    let dragging = false;
    divider.addEventListener("pointerdown", event => { if (event.button !== 0) return; event.stopPropagation(); event.preventDefault(); divider.focus(); dragging = true; divider.setPointerCapture(event.pointerId); });
    divider.addEventListener("pointermove", event => {
        if (!dragging) return;
        const bounds = sliderB.parentElement.getBoundingClientRect();
        updateReveal(100 * (event.clientX - bounds.left) / bounds.width);
    });
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) divider.addEventListener(name, () => { dragging = false; });
    divider.addEventListener("keydown", event => {
        const value = event.key === "Home" ? 0 : event.key === "End" ? 100 : event.key === "ArrowLeft" ? reveal - (event.shiftKey ? 10 : 1) : event.key === "ArrowRight" ? reveal + (event.shiftKey ? 10 : 1) : null;
        if (value === null) return; event.preventDefault(); event.stopPropagation(); updateReveal(value);
    });
    const overlayToggle = button("", "image-diff-overlay-toggle glyph", () => {
        overlay.hidden = !overlay.hidden; overlayToggle.setAttribute("aria-pressed", String(!overlay.hidden));
    });
    overlayToggle.innerHTML = iconSVG("delta"); overlayToggle.title = "Show differences"; overlayToggle.setAttribute("aria-label", "Show differences"); overlayToggle.setAttribute("aria-pressed", "false");
    const opacity = el("input", { type: "range", min: "0", max: "100", value: "60", disabled: true, ariaLabel: "Difference overlay opacity" });
    controls.push(opacity); overlay.style.opacity = ".6";
    opacity.addEventListener("input", () => { overlay.style.opacity = String(Number(opacity.value) / 100); });
    const sliderTools = el("div", { className: "image-diff-slider-tools", hidden: true }, overlayToggle, el("label", {}, "Opacity", opacity));
    const swap = button("⇄", "image-diff-swap glyph", () => {
        swapped = !swapped;
        figures[0].style.order = swapped ? "1" : "0"; figures[1].style.order = swapped ? "0" : "1";
        refreshSlider(); updateReveal(reveal);
    });
    swap.title = "Swap sides"; swap.setAttribute("aria-label", "Swap sides");
    const gain = el("input", { type: "range", min: "1", max: "16", step: "1", value: "1", disabled: true, className: "image-diff-gain" });
    gain.setAttribute("aria-label", "Delta gain"); controls.push(gain);
    const gainLabel = el("output", { textContent: "1×" });
    gain.addEventListener("input", () => { gainLabel.value = `${gain.value}×`; canvases[2].style.filter = `brightness(${gain.value})`; });
    const panes = el("div", { className: "image-diff-panes" });
    for (const [i, label] of [a.label ?? a.path ?? a.name, b.label ?? b.path ?? b.name, "Pixel difference", "A / B — drag the divider"].entries()) {
        const name = ["A", "B", "Delta", "Slider"][i];
        const canvas = el("canvas", { className: "image-diff-canvas", ariaLabel: `${name}: ${label}`, width: 0, height: 0 });
        const stage = i === 3 ? el("div", { className: "image-diff-slider-stage" }, canvas, sliderB, overlay, divider) : canvas;
        const viewport = el("div", { className: "image-diff-viewport", tabIndex: 0 }, stage);
        viewport.setAttribute("aria-label", `Pan ${name}`);
        const details = el("small", { className: "image-diff-dimensions", textContent: "Loading…" });
        const figure = el("figure", { className: "image-diff-pane" }, el("figcaption", {}, el("strong", { textContent: `${name} — ${label}`, title: label }), details), viewport);
        figure.dataset.side = ["a", "b", "delta", "slider"][i];
        figure.style.order = String(i);
        canvases.push(canvas); viewports.push(viewport); figures.push(figure); panes.append(figure);
        viewport.addEventListener("scroll", () => {
            if (!ready || figure.hidden) return;
            center = {
                x: canvas.clientWidth <= viewport.clientWidth ? result.width / 2 : (viewport.scrollLeft + viewport.clientWidth / 2) / zoom,
                y: canvas.clientHeight <= viewport.clientHeight ? result.height / 2 : (viewport.scrollTop + viewport.clientHeight / 2) / zoom,
            };
            syncScroll(viewport);
        });
        let drag;
        viewport.addEventListener("pointerdown", event => {
            if (!ready || event.button !== 0 || event.pointerType !== "mouse") return;
            event.preventDefault(); viewport.focus(); viewport.setPointerCapture(event.pointerId);
            drag = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
        });
        viewport.addEventListener("pointermove", event => {
            if (!drag) return;
            viewport.scrollLeft = drag.left + drag.x - event.clientX;
            viewport.scrollTop = drag.top + drag.y - event.clientY;
        });
        const endDrag = () => { drag = null; };
        viewport.addEventListener("pointerup", endDrag); viewport.addEventListener("pointercancel", endDrag);
        viewport.addEventListener("wheel", event => {
            if (ready && event.ctrlKey) { event.preventDefault(); setZoom(zoom * (event.deltaY < 0 ? 1.25 : 1 / 1.25)); }
        }, { passive: false });
    }
    const dialog = el("dialog", { className: "image-diff", ariaLabel: "Compare images" },
        el("div", { className: "image-diff-head" }, el("strong", { textContent: "Compare images" }), closeButton),
        el("div", { className: "image-diff-tools" }, modes, swap, zoomControls, sliderTools, el("label", { className: "image-diff-gain-control" }, "Delta gain", gain, gainLabel)),
        panes, summary, el("p", { className: "image-diff-legend", textContent: "Black = unchanged · Brighter = different · Magenta = present in only one image. Top-left alignment, no resizing. Animation uses a still frame." }));
    closeButton.before(maximizeButton(dialog, "image-diff-maximize"));
    function refreshSlider() {
        if (!result) return;
        for (const [target, source] of [[canvases[3], canvases[swapped ? 1 : 0]], [sliderB, canvases[swapped ? 0 : 1]]]) {
            target.width = result.width; target.height = result.height;
            target.getContext("2d").drawImage(source, 0, 0);
        }
        const left = swapped ? b : a, right = swapped ? a : b;
        figures[3].querySelector("strong").textContent = `${left.label ?? left.path ?? left.name} ↔ ${right.label ?? right.path ?? right.name}`;
        figures[3].querySelector("small").textContent = `Left: ${swapped ? "B" : "A"} · Right: ${swapped ? "A" : "B"}`;
    }
    function syncScroll(source) {
        for (const [i, viewport] of viewports.entries()) {
            if (viewport === source || figures[i].hidden) continue;
            const left = Math.max(0, center.x * zoom - viewport.clientWidth / 2), top = Math.max(0, center.y * zoom - viewport.clientHeight / 2);
            if (Math.abs(viewport.scrollLeft - left) > 1) viewport.scrollLeft = left;
            if (Math.abs(viewport.scrollTop - top) > 1) viewport.scrollTop = top;
        }
    }
    function applyZoom() {
        for (const canvas of [...canvases, sliderB, overlay]) { canvas.style.width = `${result.width * zoom}px`; canvas.style.height = `${result.height * zoom}px`; }
        const stage = sliderB.parentElement;
        stage.style.width = `${result.width * zoom}px`; stage.style.height = `${result.height * zoom}px`;
        zoomLabel.value = `${Math.round(zoom * 100)}%`;
        syncScroll();
    }
    function setZoom(value) { if (!ready) return; fitting = false; zoom = Math.max(.01, Math.min(32, value)); applyZoom(); }
    function fit() {
        if (!ready) return;
        const visible = viewports.filter((_, i) => !figures[i].hidden);
        zoom = Math.max(.01, Math.min(1, ...visible.map(viewport => Math.min(Math.max(1, viewport.clientWidth - 16) / result.width, Math.max(1, viewport.clientHeight - 16) / result.height))));
        center = { x: result.width / 2, y: result.height / 2 }; applyZoom();
    }
    function setMode(value) {
        mode = value;
        for (const [key, control] of modeButtons) control.setAttribute("aria-pressed", String(key === mode));
        figures.forEach(figure => { figure.hidden = mode === "all" ? figure.dataset.side === "slider" : mode === "side" ? !["a", "b"].includes(figure.dataset.side) : figure.dataset.side !== mode; });
        panes.classList.toggle("single", !["all", "side"].includes(mode));
        panes.classList.toggle("two", mode === "side");
        sliderTools.hidden = mode !== "slider";
        gain.closest("label").hidden = mode !== "delta" && mode !== "all";
        if (ready) { if (fitting) fit(); else applyZoom(); }
    }
    const resize = new ResizeObserver(() => { if (fitting) fit(); else if (ready) syncScroll(); });
    resize.observe(panes);
    const stop = () => {
        if (stopped) return;
        stopped = true; controller.abort(); resize.disconnect(); sources.forEach(bitmap => bitmap?.close());
        for (const canvas of [...canvases, sliderB, overlay]) { canvas.width = 0; canvas.height = 0; }
        if (dialog.open) dialog.close(); dialog.remove();
        if (focus?.isConnected) focus.focus({ preventScroll: true });
    };
    closeButton.addEventListener("click", stop); dialog.addEventListener("close", stop);
    dialog.addEventListener("cancel", event => { event.preventDefault(); stop(); });
    dialog.addEventListener("keydown", event => {
        if (!ready || event.ctrlKey || event.metaKey || event.altKey || event.target.matches("input")) return;
        const key = event.key.toLowerCase();
        if (["a", "b", "d"].includes(key)) setMode(key === "d" ? "delta" : key);
        else if (key === "0") { fitting = true; fit(); }
        else if (key === "1") setZoom(1);
        else if (key === "+" || key === "=") setZoom(zoom * 1.25);
        else if (key === "-") setZoom(zoom / 1.25);
        else return;
        event.preventDefault();
    });
    updateReveal(reveal); setMode(mode);
    document.body.append(dialog); dialog.showModal();
    void (async () => {
        try {
            await Promise.all([a, b].map(async (side, i) => {
                try { sources[i] = await decodeImage(await loadImage(side, signal), signal); }
                catch (err) { throw new Error(`${side.name}: ${err.message}`); }
            }));
            signal.throwIfAborted(); summary.textContent = "Comparing pixels…";
            result = await compute(sources[0], sources[1], signal);
            try {
                signal.throwIfAborted();
                result.bitmaps.forEach((bitmap, i) => {
                    const canvas = i === 3 ? overlay : canvases[i]; canvas.width = result.width; canvas.height = result.height;
                    const context = canvas.getContext("bitmaprenderer");
                    if (context) context.transferFromImageBitmap(bitmap);
                    else {
                        const fallback = canvas.getContext("2d");
                        if (!fallback) throw new Error("This browser can't display the comparison.");
                        fallback.drawImage(bitmap, 0, 0);
                    }
                });
            } finally { result.bitmaps.forEach(bitmap => bitmap.close()); }
            figures[0].querySelector("small").textContent = `${result.aWidth}×${result.aHeight}`;
            figures[1].querySelector("small").textContent = `${result.bWidth}×${result.bHeight}`;
            figures[2].querySelector("small").textContent = `${result.width}×${result.height} · Maximum delta ${result.maxDelta}/255`;
            summary.textContent = result.changed ? `${result.changed.toLocaleString()} of ${result.pixels.toLocaleString()} pixels differ (${(100 * result.changed / result.pixels).toFixed(2)}%).` : "Images have identical decoded pixels.";
            if (result.aWidth !== result.bWidth || result.aHeight !== result.bHeight) summary.textContent += " Dimensions differ; extra areas are marked magenta.";
            refreshSlider(); controls.forEach(control => { control.disabled = false; }); ready = true; fit();
        } catch (err) {
            if (signal.aborted) return;
            controller.abort(); sources.forEach(bitmap => bitmap?.close());
            summary.classList.add("error"); summary.textContent = `Can't compare images: ${err.message}`;
        }
    })();
    return { close: stop };
}
