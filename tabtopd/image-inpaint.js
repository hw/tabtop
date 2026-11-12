// Masked MI-GAN inpainting. Marks are vectors in current image coordinates;
// only the bounded repair area is rasterized and sent to a dedicated worker.
import { el } from "./preview-dom.js";
import { maskBounds, drawMaskMarks, newMaskMark, extendMaskMark, enclosedFill, maskSVGShape, glyphCaption, brushControls, imageMaskPoint } from "./image-mask.js";
import { iconSVG } from "./glyphs.js";

const MAX_PATCH_PIXELS = 16e6, MAX_INPUT_SIDE = 1024;
let nextMask = 0;
const canvasOf = (width, height) => Object.assign(document.createElement("canvas"), { width, height });

export function repairBounds(marks, width, height) {
    const { left, top, right, bottom } = maskBounds(marks, width, height);
    const pad = Math.max(32, Math.min(128, Math.ceil(Math.max(right - left, bottom - top) / 2)));
    const x = Math.max(0, Math.floor(left - pad)), y = Math.max(0, Math.floor(top - pad));
    return { x, y, width: Math.min(width, Math.ceil(right + pad)) - x, height: Math.min(height, Math.ceil(bottom + pad)) - y };
}

export const drawRepairMask = drawMaskMarks;

// Keep input alpha and every unmarked RGB byte; the model only supplies RGB.
export function mergeRepair(original, filled, mask) {
    if (original.length !== filled.length || original.length !== mask.length) throw new Error("Invalid inpainting result");
    const out = new Uint8ClampedArray(original);
    for (let i = 0; i < out.length; i += 4) {
        const a = mask[i + 3] / 255;
        if (a) for (let c = 0; c < 3; c++) out[i + c] = Math.round(original[i + c] * (1 - a) + filled[i + c] * a);
    }
    return out;
}

export class Inpainter {
    worker = null;
    pending = null;
    run(rgba, mask, width, height) {
        if (this.pending) return Promise.reject(new Error("Inpainting is already running"));
        return new Promise((resolve, reject) => {
            this.pending = { resolve, reject, timer: setTimeout(() => this.cancel("Inpainting took too long. Try a smaller area."), 120000) };
            try {
                this.worker ??= new Worker(new URL("./image-inpaint-worker.js", import.meta.url));
                this.worker.onmessage = ({ data }) => {
                    if (data.error) { this.cancel(`Inpainting failed: ${data.error}`); return; }
                    if (!(data.rgba instanceof Uint8ClampedArray) || data.rgba.length !== width * height * 4) { this.cancel("Invalid inpainting result"); return; }
                    const pending = this.pending; this.pending = null;
                    clearTimeout(pending.timer); pending.resolve(data.rgba);
                };
                this.worker.onerror = (event) => { event.preventDefault(); this.cancel("Inpainting couldn't load. Try again."); };
                this.worker.onmessageerror = () => this.cancel("Unreadable inpainting result");
                this.worker.postMessage({ rgba, mask, width, height }, [rgba.buffer, mask.buffer]);
            } catch (err) { this.cancel(err.message); }
        });
    }
    cancel(message = "Inpainting cancelled.") {
        this.worker?.terminate(); this.worker = null;
        if (this.pending) {
            clearTimeout(this.pending.timer); this.pending.reject(new Error(message)); this.pending = null;
        }
    }
}

// The same bounded repair pipeline serves individual images and PDF batches.
export async function inpaintPatch(base, marks, painter) {
    const bounds = repairBounds(marks, base.width, base.height);
    if (bounds.width * bounds.height > MAX_PATCH_PIXELS) throw new Error("Choose a smaller repair area (under 16 megapixels with context).");
    const repairMask = canvasOf(bounds.width, bounds.height), maskCtx = repairMask.getContext("2d", { willReadFrequently: true });
    maskCtx.translate(-bounds.x, -bounds.y); drawRepairMask(maskCtx, marks);
    const originalMask = maskCtx.getImageData(0, 0, bounds.width, bounds.height);
    if (!originalMask.data.some((value, i) => i % 4 === 3 && value > 0)) throw new Error("The mask is empty. Paint over what to remove.");
    const ratio = Math.min(1, MAX_INPUT_SIDE / Math.max(bounds.width, bounds.height));
    const width = Math.max(1, Math.round(bounds.width * ratio)), height = Math.max(1, Math.round(bounds.height * ratio));
    const sample = canvasOf(width, height), ctx = sample.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(base, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, width, height);
    const rgba = ctx.getImageData(0, 0, width, height).data;
    ctx.clearRect(0, 0, width, height); ctx.drawImage(repairMask, 0, 0, width, height);
    const sampledMask = ctx.getImageData(0, 0, width, height).data;
    const binary = new Uint8Array(width * height);
    for (let i = 0; i < binary.length; i++) binary[i] = sampledMask[i * 4 + 3] ? 0 : 255;
    if (!binary.includes(0)) throw new Error("Use a larger brush for this repair area.");
    const filled = await painter.run(rgba, binary, width, height);
    ctx.putImageData(new ImageData(filled, width, height), 0, 0);
    const result = canvasOf(bounds.width, bounds.height), resultCtx = result.getContext("2d", { willReadFrequently: true });
    resultCtx.drawImage(base, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);
    const original = resultCtx.getImageData(0, 0, bounds.width, bounds.height);
    resultCtx.clearRect(0, 0, bounds.width, bounds.height); resultCtx.drawImage(sample, 0, 0, bounds.width, bounds.height);
    const scaled = resultCtx.getImageData(0, 0, bounds.width, bounds.height);
    original.data.set(mergeRepair(original.data, scaled.data, originalMask.data));
    resultCtx.putImageData(original, 0, 0);
    return { ...bounds, canvas: result };
}

export function inpaintTool({ toolbar, hints, stage, button, geometry, source, preview, apply, changed }) {
    let active = false, busy = false, base = null, marks = [], mode = "paint", gesture = null, patch = null, generation = 0, frame = null;
    const painter = new Inpainter();
    const makeButton = (icon, title, cls, fn) => {
        const b = el("button", { type: "button", className: `glyph ${cls}`, title, ariaLabel: title });
        b.innerHTML = iconSVG(icon);
        b.addEventListener("click", fn);
        return b;
    };
    const note = el("span", { className: "hint image-inpaint-note", role: "status", hidden: true });
    const tools = [ ["select", "Select area"], ["paint", "Paint mask"], ["erase", "Subtract mask"], ["fill", "Flood fill enclosed area"], ["pan", "Pan"] ].map(([key, title]) => {
        const icon = { select: "select-area", paint: "paint-brush", erase: "erase", fill: "flood-fill", pan: "pan" }[key];
        const control = makeButton(icon, title, `image-inpaint-${key}`, () => { mode = key; brushes.close(); invalidate(); stage.focus({ preventScroll: true }); });
        return { key, control };
    });
    const selectAll = () => {
        if (!active || busy) return;
        gesture = null;
        marks.push({ rect: { x: 0, y: 0, width: base.width, height: base.height } });
        invalidate(); draw();
        note.textContent = "Entire image masked. Subtract mask to keep areas for context.";
        stage.focus({ preventScroll: true });
    };
    const all = makeButton("select-all", "Mask entire image (Ctrl+A / ⌘A)", "image-inpaint-all", selectAll);
    const brushes = brushControls(tools.find(({ key }) => key === "paint").control, {
        prefix: "image-inpaint", sizeClass: "image-inpaint-size", selectionButton: tools.find(({ key }) => key === "select").control,
        onShape: () => { gesture = null; mode = "select"; invalidate(); stage.focus({ preventScroll: true }); },
    });
    const size = brushes.size;
    const undo = glyphCaption(makeButton("undo", "Undo mark", "image-inpaint-undo", () => { marks.pop(); invalidate(); }));
    const reset = makeButton("clear-mask", "Clear mask", "image-inpaint-reset", () => { marks = []; invalidate(); });
    const run = makeButton("inpaint", "Inpaint", "image-inpaint-run", () => perform());
    const accept = makeButton("check", "Apply", "image-inpaint-apply", () => {
        if (patch && !busy) {
            const result = patch, recipe = { kind: "inpaint", width: base.width, height: base.height, marks: structuredClone(marks) };
            close(); apply(result, recipe);
        }
    });
    const cancel = makeButton("close-circle", "Cancel", "image-inpaint-cancel", () => close());
    const bar = el("div", { className: "image-inpaint-tools", hidden: true }, ...tools.map(({ key, control }) => key === "paint" ? brushes.group : key === "select" ? brushes.selectionGroup : control), all,
        undo, reset, run, accept, cancel);
    toolbar.append(bar);
    hints.append(note);
    const ns = "http://www.w3.org/2000/svg";
    const svg = (name, props = {}) => {
        const node = document.createElementNS(ns, name);
        for (const [key, value] of Object.entries(props)) node.setAttribute(key, value);
        return node;
    };
    const id = `inpaint-mask-${++nextMask}`, overlay = svg("svg", { class: "image-inpaint-overlay", "aria-hidden": "true" });
    // SVG masks default to x/y=-10%. With an explicit image-sized width and
    // height, that clips the last 10% of the preview on the right and bottom.
    const defs = svg("defs"), mask = svg("mask", { id, x: 0, y: 0, maskUnits: "userSpaceOnUse", "mask-type": "luminance" });
    const tint = svg("rect", { fill: "#facc15", opacity: ".5", mask: `url(#${id})` });
    defs.append(mask); overlay.append(defs, tint); stage.append(overlay);
    const update = () => {
        bar.hidden = !active;
        note.hidden = !active;
        overlay.style.display = active && !patch ? "block" : "none";
        stage.classList.toggle("inpaint-marking", active && mode !== "pan" && !busy);
        button.setAttribute("aria-pressed", String(active));
        for (const { key, control } of tools) { control.disabled = busy; control.setAttribute("aria-pressed", String(mode === key)); }
        brushes.update(busy);
        all.disabled = busy;
        undo.disabled = reset.disabled = busy || !marks.length;
        run.disabled = busy || !marks.length || !!patch;
        accept.disabled = busy || !patch;
        changed();
    };
    const draw = () => {
        frame = null;
        if (!active) return;
        const { width, height, x, y, scale } = geometry();
        Object.assign(overlay.style, { left: `${x}px`, top: `${y}px`, width: `${width * scale}px`, height: `${height * scale}px` });
        overlay.setAttribute("viewBox", `0 0 ${width} ${height}`);
        mask.setAttribute("width", width); mask.setAttribute("height", height);
        tint.setAttribute("width", width); tint.setAttribute("height", height);
        mask.replaceChildren(svg("rect", { width, height, fill: "black" }));
        for (const mark of marks) {
            const fill = mark.erase ? "black" : "white";
            const [tag, props] = maskSVGShape(mark);
            mask.append(svg(tag, { fill, stroke: props.fill === "none" ? fill : "none", ...props }));
        }
    };
    const invalidate = () => {
        if (patch) { patch = null; preview(null); }
        note.textContent = mode === "fill" ? "Draw a closed outline with the brush, then click inside it to fill the mask."
            : brushes.shape.value === "circle" && mode === "select" ? "Circle: drag from its centre to its edge. Yellow shows what will change."
            : "Mark the logo or object, then Inpaint. Yellow shows what will change.";
        note.classList.remove("error");
        if (frame === null) frame = requestAnimationFrame(draw);
        update();
    };
    const close = () => {
        generation++; active = busy = false; gesture = null; patch = null; marks = [];
        painter.cancel(); brushes.close(); cancelAnimationFrame(frame); frame = null; preview(null); base = null; update();
    };
    const perform = async () => {
        if (!active || busy || !marks.length) return;
        const token = ++generation;
        try {
            busy = true; update(); note.textContent = "Inpainting…";
            const result = await inpaintPatch(base, marks, painter);
            if (!active || generation !== token) return;
            patch = result; preview(patch);
            note.textContent = "Preview ready. Apply to keep it, or edit the mask to try again.";
        } catch (err) {
            if (active && generation === token) { note.textContent = err.message; note.classList.add("error"); }
        } finally { if (active && generation === token) { busy = false; update(); } }
    };
    const pointAt = (px, py, rectangle = false) => imageMaskPoint(px, py, geometry(), rectangle ? 6 : 0);
    const tool = {
        active: () => active, busy: () => busy,
        recipe: () => active && !busy && marks.some(mark => !mark.erase)
            ? { kind: "inpaint", width: base.width, height: base.height, marks } : null,
        selectAll,
        open() { if (active) { close(); return; } active = true; base = source(); mode = "paint"; brushes.shape.value = "rectangle"; invalidate(); draw(); stage.focus({ preventScroll: true }); },
        close,
        painting: () => active && mode !== "pan",
        place: () => { if (active) draw(); },
        down(px, py) {
            if (!active || busy || mode === "pan") return false;
            const { x, y, width, height, scale } = geometry();
            const rectangle = mode === "select" && brushes.shape.value === "rectangle";
            // Rectangles may start in the surrounding stage and extend past
            // the image edges; pointAt clamps both ends to the image bounds.
            if (!rectangle && (px < x || py < y || px > x + width * scale || py > y + height * scale)) return true;
            const point = pointAt(px, py, rectangle);
            if (mode === "fill") {
                try {
                    const fill = enclosedFill(marks, width, height, point);
                    if (fill) { marks.push(fill); invalidate(); draw(); }
                    else note.textContent = "That area is already masked.";
                } catch (err) { note.textContent = err.message; note.classList.add("error"); }
                return true;
            }
            const mark = newMaskMark(mode === "select" ? brushes.shape.value : "brush", point, Number(size.value) / 2, mode === "erase");
            marks.push(mark); gesture = { mark, from: point }; invalidate(); return true;
        },
        move(px, py) {
            if (!active || busy || mode === "pan") return false;
            if (gesture) {
                const { mark, from } = gesture, point = pointAt(px, py, !!mark.rect);
                extendMaskMark(mark, from, point);
                invalidate();
            }
            return true;
        },
        up(cancelled, px, py) {
            if (!gesture) return;
            if (cancelled) marks.pop();
            else if (Number.isFinite(px) && Number.isFinite(py)) extendMaskMark(gesture.mark, gesture.from, pointAt(px, py, !!gesture.mark.rect));
            gesture = null; invalidate(); draw();
        },
        stop() { if (active) close(); painter.cancel(); brushes.stop(); cancelAnimationFrame(frame); bar.remove(); note.remove(); overlay.remove(); },
    };
    bar.addEventListener("keydown", (event) => {
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "a") {
            event.preventDefault(); event.stopPropagation(); selectAll();
        }
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    });
    return tool;
}
