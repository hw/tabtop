// The picture preview: zoom (the wheel, at the pointer; + and -), drag to
// pan, fit and actual size (0 and 1; a double click, either); what it is
// (its size in pixels, format, bytes, and whether it's animated); and,
// where a picture can be had through, a checkerboard. Phone photos stand
// as their EXIF orientation says, as browsers show them.
//
// Editing (see startEditing): rotated, flipped, cropped and resized, each
// change made again from the picture as it was (so nothing is lost by
// changes undone); saved over the file in its own format, re-encoded, with
// its metadata or without (or, changed in no other way, without it,
// losslessly: see image-meta.js); or as a copy, in another format.
import { el } from "./preview-dom.js";
import { glyphs, iconSVG } from "./glyphs.js";
import { humanBytes } from "./file-format.js";
import { knownFrom, metadataOf, stripped, withMetadata } from "./image-meta.js";
import { clipSelection, maskPath, newMaskMark, extendMaskMark, enclosedFill, glyphCaption, brushControls, imageMaskPoint } from "./image-mask.js";
import { inpaintTool } from "./image-inpaint.js";
import { drawTool, drawShape } from "./image-draw.js";
import { placeTool, drawPlacement, pastedPicture } from "./image-place.js";
import { scanCanvas, scanGeometry, scanTool } from "./image-scan.js";
import { rasterPDF } from "./image-export.js";
import { drawFill } from "./image-fill.js";
import { describeStep } from "./image-batch.js";
import { BackgroundRemover, adjustedMask, mapImagePoint, objectMask } from "./image-background.js";
import { Segmenter, selectionMark, objectBounds } from "./image-segment.js";

const FORMATS = {
    "image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WebP", "image/gif": "GIF", "image/avif": "AVIF",
    "image/bmp": "BMP", "image/x-icon": "ICO", "image/vnd.microsoft.icon": "ICO", "image/svg+xml": "SVG", "application/pdf": "PDF",
};
// What Save writes, in the format it was: what browsers' canvases encode.
const WRITABLE = new Set(["image/jpeg", "image/png", "image/webp"]);
const QUALITY = 0.92;            // a JPEG's or WebP's, written
const MAX_EDIT_PIXELS = 100e6;   // what a canvas can hold, safely, everywhere
const MAX_SIDE = 16384;
const MIN_ZOOM = 0.01, MAX_ZOOM = 32, STEP = 1.25;
// (A picture with no size of its own, an SVG without one: as browsers do.)
const DEFAULT_SIZE = [300, 150];
// How much of a picture is read for whether it moves and what metadata
// it has, where that can say (see knownFrom).
const PROBE_BYTES = 1 << 20;

const ascii = (bytes, at, s) => [...s].every((c, i) => bytes[at + i] === c.charCodeAt(0));
const find = (bytes, s, from = 0, to = bytes.length) => {
    for (let i = from; i + s.length <= to; i++) if (ascii(bytes, i, s)) return i;
    return -1;
};

// animated reports whether a picture, by its first bytes, moves: a GIF
// that loops (NETSCAPE2.0), an APNG (acTL before its image data), or an
// animated WebP (VP8X's animation flag).
export function animated(bytes, type) {
    if (type === "image/gif") return find(bytes, "NETSCAPE2.0") >= 0;
    if (type === "image/png") {
        const idat = find(bytes, "IDAT");
        return find(bytes, "acTL", 8, idat < 0 ? bytes.length : idat) >= 0;
    }
    if (type === "image/webp") return ascii(bytes, 12, "VP8X") && (bytes[20] & 0x02) !== 0;
    return false;
}

// describe is what the picture is: "1920×1080 · JPEG · 2.1 MB", whether
// it's animated, and what metadata it has ("EXIF, XMP").
export function describe({ width, height, type, size, moving, meta = [] }) {
    return [`${width.toLocaleString()}×${height.toLocaleString()}`, FORMATS[type] ?? type?.replace(/^image\//, "").toUpperCase(),
        size != null ? humanBytes(size) : "", moving ? "animated" : "", meta.join(", ")].filter(Boolean).join(" · ");
}

// transform is the picture source (an image, a bitmap or a canvas, width
// by height) with ops applied in turn, on a canvas: rotations ("left",
// "right"), flips ("h", "v"), crops ({x, y, width, height}), resizes
// ({resize: [width, height]}), shapes drawn ({draw}, see drawShape) and
// pictures placed ({paste}, see drawPlacement) and areas filled ({fill},
// see image-fill.js),
// each of the picture as it is by then.
export function transform(source, width, height, ops) {
    let cur = source, w = width, h = height;
    const canvasOf = (nw, nh) => {
        const canvas = document.createElement("canvas");
        canvas.width = nw;
        canvas.height = nh;
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingQuality = "high";
        return [canvas, ctx];
    };
    // (None: a copy, so it's a canvas all the same.)
    for (const op of ops.length ? ops : [{ x: 0, y: 0, width, height }]) {
        if (op.scan) {
            cur = scanCanvas(cur, op.scan); w = cur.width; h = cur.height;
            continue;
        }
        if (op.inpaint) {
            const [canvas, ctx] = canvasOf(w, h);
            ctx.drawImage(cur, 0, 0, w, h);
            ctx.clearRect(op.inpaint.x, op.inpaint.y, op.inpaint.width, op.inpaint.height);
            ctx.drawImage(op.inpaint.canvas, op.inpaint.x, op.inpaint.y);
            cur = canvas;
            continue;
        }
        if (op.fill) {
            const [canvas, ctx] = canvasOf(w, h);
            ctx.drawImage(cur, 0, 0, w, h);
            drawFill(ctx, op.fill, w, h);
            cur = canvas;
            continue;
        }
        if (op.paste) {
            const [canvas, ctx] = canvasOf(w, h);
            ctx.drawImage(cur, 0, 0, w, h);
            drawPlacement(ctx, op.paste, op.paste.image);
            cur = canvas;
            continue;
        }
        if (op.draw) {
            const [canvas, ctx] = canvasOf(w, h);
            ctx.drawImage(cur, 0, 0, w, h);
            drawShape(ctx, op.draw);
            cur = canvas;
            continue;
        }
        if (op.background) {
            const [canvas, ctx] = canvasOf(w, h);
            ctx.drawImage(cur, 0, 0, w, h);
            ctx.save();
            clipSelection(ctx, op.selection, w, h);
            ctx.globalCompositeOperation = "destination-in";
            ctx.drawImage(op.background, 0, 0, w, h);
            for (const stroke of op.strokes ?? []) {
                maskPath(ctx, stroke);
                if (stroke.mode === "erase") {
                    ctx.globalCompositeOperation = "destination-out";
                    ctx.fill();
                } else {
                    ctx.save();
                    ctx.clip();
                    ctx.globalCompositeOperation = "copy";
                    ctx.drawImage(cur, 0, 0, w, h);
                    ctx.restore();
                }
            }
            ctx.restore();
            [cur, w, h] = [canvas, w, h];
            continue;
        }
        if (op.resize) {
            const [tw, th] = op.resize;
            // Made much smaller by halves first: at once, it would lose
            // what falls between the pixels it samples.
            while (w / 2 >= tw && h / 2 >= th) {
                const [canvas, ctx] = canvasOf(Math.ceil(w / 2), Math.ceil(h / 2));
                ctx.drawImage(cur, 0, 0, canvas.width, canvas.height);
                [cur, w, h] = [canvas, canvas.width, canvas.height];
            }
            const [canvas, ctx] = canvasOf(tw, th);
            ctx.drawImage(cur, 0, 0, tw, th);
            [cur, w, h] = [canvas, tw, th];
            continue;
        }
        const crop = typeof op === "object";
        const turn = op === "left" || op === "right";
        const nw = crop ? op.width : turn ? h : w, nh = crop ? op.height : turn ? w : h;
        const [canvas, ctx] = canvasOf(nw, nh);
        if (crop) ctx.drawImage(cur, op.x, op.y, op.width, op.height, 0, 0, nw, nh);
        else {
            if (op === "right") ctx.setTransform(0, 1, -1, 0, nw, 0);
            else if (op === "left") ctx.setTransform(0, -1, 1, 0, 0, nh);
            else if (op === "h") ctx.setTransform(-1, 0, 0, 1, nw, 0);
            else ctx.setTransform(1, 0, 0, -1, 0, nh);
            ctx.drawImage(cur, 0, 0, w, h);
        }
        [cur, w, h] = [canvas, nw, nh];
    }
    return { canvas: cur, width: w, height: h };
}

// Replayable vectors and geometry, rather than model output pixels. Every
// step records its own input size so later masks stay in the coordinate
// system created by preceding rotations, crops, and resizes.
export function editRecipe(width, height, ops, pending = null) {
    const recipe = { kind: "sequence", width, height, steps: [], committed: 0 };
    for (const op of ops) {
        let step;
        if (typeof op === "string") {
            step = { kind: "transform", operation: op, width, height };
            if (op === "left" || op === "right") [width, height] = [height, width];
        } else if (op.scan) {
            step = { kind: "scan", width, height, settings: structuredClone(op.scan) };
            const size = scanGeometry(width, height, op.scan); width = size.width; height = size.height;
        } else if (op.inpaint) {
            if (!op.recipe) return null; // Don't substitute a broad repair for a missing mask.
            step = op.recipe;
        } else if (op.background) {
            step = { kind: "background", width, height, settings: op.settings, selection: op.selection, strokes: op.strokes ?? [], ...(op.objects?.length ? { objects: op.objects } : {}) };
        } else if (op.draw) {
            step = { kind: "draw", width, height, ...structuredClone(op.draw) };
        } else if (op.fill) {
            step = { kind: "fill", width, height, ...structuredClone(op.fill) };
        } else if (op.paste) {
            // (The picture as its file: what other pages are given.)
            step = { kind: "paste", width, height, rect: { ...op.paste.rect }, opacity: op.paste.opacity, blob: op.paste.blob };
        } else if (op.resize) {
            step = { kind: "resize", width, height, size: op.resize };
            [width, height] = op.resize;
        } else {
            step = { kind: "crop", width, height, rect: { x: op.x, y: op.y, width: op.width, height: op.height } };
            width = op.width; height = op.height;
        }
        recipe.steps.push(step);
    }
    recipe.committed = recipe.steps.length;
    if (pending) recipe.steps.push(pending);
    return recipe.steps.length ? recipe : null;
}

// copyName is name for a copy of it as type: its extension changed.
export function copyName(name, type) {
    const ext = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "application/pdf": ".pdf" }[type];
    const dot = name.lastIndexOf(".");
    return (dot > 0 ? name.slice(0, dot) : name) + ext;
}

// saveIntent is what Save will do with a picture of type, as the Save-as
// row asks: target (a type) at quality (a percentage), kinds of metadata
// it has (see metadataOf), keep ticked or not, edited (pixels changed) or
// not, and dirty (anything changed, from what's saved) or not. It's {how,
// target, q} and: "copy" (another format, a copy beside it, with its
// name, from name), "strip" (only metadata removed, losslessly), "encode"
// (written again, with kept: its metadata kept), or null (nothing to do).
export function saveIntent({ type, target, quality, kinds, keep, edited, dirty, name }) {
    const q = quality;
    if (target !== type) return { how: "copy", target, q, name: copyName(name, target) };
    const strip = kinds.length > 0 && !keep;
    if (!edited && q === Math.round(QUALITY * 100) && strip) return { how: "strip", target, q };
    if (!dirty) return { how: null, target, q };
    return { how: "encode", target, q, kept: kinds.length > 0 && target !== "image/webp" && keep };
}

// savePlan is what Save will do (it, see saveIntent), said, of a picture
// of type with kinds of metadata and its EXIF orientation.
export function savePlan(it, { type, kinds, orientation }) {
    const what = kinds.join(", ");
    const at = (t) => (t === "image/png" ? "" : ` at ${it.q}%`);
    return it.how === "copy" ? `Save writes a copy as ${it.name} (${FORMATS[it.target]}${at(it.target)}), without metadata; this file stays as it is.`
        : it.how === "strip" ? `Save removes its ${what}, losslessly${orientation !== 1 ? " (keeping only which way up it stands)" : ""}.`
        : it.how === "encode" ? `Save writes it again as ${FORMATS[type]}${at(type)}, ${it.kept ? `keeping its ${what}` : "without metadata"}.`
        : WRITABLE.has(type) ? "" : `${FORMATS[type] ?? "This format"} can't be written here: Save writes a copy.`;
}

// imageView shows the picture file, held in blob at url; it resolves once
// it's decoded, to the view (with .editable and .startEditing), or to a
// note that it can't be shown.
export async function imageView({ file, blob, url }) {
    const type = blob?.type || file.type;
    const img = el("img", { src: url, alt: file.name, draggable: false, className: "image-content" });
    try {
        await img.decode();
    } catch {
        return el("p", { className: "error", textContent: "This browser can't show this picture. Download it instead." });
    }
    // Its first bytes say whether it moves, and a JPEG's, what metadata it
    // has; a PNG's or WebP's, only all of it. (Not copied whole if not.)
    let probe = blob ? new Uint8Array(await blob.slice(0, PROBE_BYTES).arrayBuffer()) : new Uint8Array();
    const moving = animated(probe, type);
    if (blob && !knownFrom(probe, type, blob.size)) probe = new Uint8Array(await blob.arrayBuffer());
    const metaKinds = metadataOf(probe, type).kinds;
    probe = null;
    let width = img.naturalWidth || DEFAULT_SIZE[0], height = img.naturalHeight || DEFAULT_SIZE[1];
    img.style.width = `${width}px`;
    img.style.height = `${height}px`;

    const button = (icon, label, className = "") => {
        const b = el("button", { type: "button", className: `glyph ${className}`.trim(), title: label });
        b.innerHTML = iconSVG(icon);
        b.setAttribute("aria-label", label);
        return b;
    };
    const zoomOut = button("zoom-out", "Zoom out (-)", "image-zoom-out");
    const zoomIn = button("zoom-in", "Zoom in (+)", "image-zoom-in");
    const zoomLabel = el("span", { className: "image-zoom hint", role: "status" });
    const fitButton = button("fit-page", "Fit it in the window (0)", "image-fit");
    const actualButton = button("actual-size", "Actual size: a pixel for a pixel (1)", "image-actual");
    const info = el("span", { className: "hint image-info" });
    const editBar = el("span", { className: "image-edit", hidden: true });
    const bar = el("div", { className: "image-bar" },
        el("span", { className: "image-zoom-group", role: "group", ariaLabel: "Zoom" }, zoomOut, zoomLabel, zoomIn), fitButton, actualButton, editBar, info);
    const cropBox = el("div", { className: "image-crop", hidden: true });
    const stage = el("div", { className: "image-stage", tabIndex: 0, ariaLabel: file.name }, img, cropBox);
    const hintBar = el("div", { className: "image-tool-hints", hidden: true });
    const view = el("div", { className: "image-view" }, bar, hintBar, stage);
    const showInfo = () => { info.textContent = describe({ width, height, type, size: file.size, moving, meta: view.classList?.contains("editing") ? [] : metaKinds }); };
    showInfo();

    // What's shown (the picture, or while editing, a canvas of it as
    // changed), at scale, its top left at x, y in the stage; fitted, it
    // stays fitted as the window changes.
    let content = img, scale = 1, x = 0, y = 0, fitting = true;
    const size = () => [stage.clientWidth || 1, stage.clientHeight || 1];
    const fitScale = () => {
        const [sw, sh] = size();
        return Math.min(1, sw / width, sh / height);
    };
    const keepIn = () => {
        const [sw, sh] = size();
        const dw = width * scale, dh = height * scale;
        x = dw <= sw ? (sw - dw) / 2 : Math.min(0, Math.max(sw - dw, x));
        y = dh <= sh ? (sh - dh) / 2 : Math.min(0, Math.max(sh - dh, y));
    };
    const place = () => {
        keepIn();
        content.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
        content.classList.toggle("pixelated", scale >= 3);
        zoomLabel.textContent = `${Math.round(scale * 100)}%`;
        const [sw, sh] = size();
        stage.classList.toggle("pannable", width * scale > sw + 0.5 || height * scale > sh + 0.5);
        showCrop();
        backgroundPointer?.place();
        inpainting?.place();
        drawing?.place();
        placing?.place();
        scanning?.place();
    };
    const fit = () => {
        fitting = true;
        scale = fitScale();
        place();
    };
    const zoomTo = (s, px = size()[0] / 2, py = size()[1] / 2) => {
        s = Math.max(Math.min(MIN_ZOOM, fitScale()), Math.min(MAX_ZOOM, s));
        x = px - (px - x) * (s / scale);
        y = py - (py - y) * (s / scale);
        scale = s;
        fitting = false;
        place();
    };
    const at = (e) => {
        const r = stage.getBoundingClientRect();
        return [e.clientX - r.left, e.clientY - r.top];
    };
    zoomIn.addEventListener("click", () => zoomTo(scale * STEP));
    zoomOut.addEventListener("click", () => zoomTo(scale / STEP));
    fitButton.addEventListener("click", fit);
    actualButton.addEventListener("click", () => zoomTo(1));
    stage.addEventListener("wheel", (e) => {
        e.preventDefault();
        const [px, py] = at(e);
        // (A line's or a page's worth, as a mouse wheel's notch gives.)
        const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
        zoomTo(scale * Math.exp(-dy * 0.002), px, py);
    }, { passive: false });
    stage.addEventListener("dblclick", (e) => {
        if (cropping || backgroundPointer?.painting() || inpainting?.painting() || drawing?.painting() || placing?.painting() || scanning?.painting()) return;
        const [px, py] = at(e);
        if (fitting || Math.abs(scale - fitScale()) < 1e-3) zoomTo(1, px, py);
        else fit();
    });
    stage.addEventListener("keydown", (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const act = { "+": () => zoomTo(scale * STEP), "=": () => zoomTo(scale * STEP), "-": () => zoomTo(scale / STEP), "0": fit, "1": () => zoomTo(1) }[e.key];
        if (act) {
            e.preventDefault();
            act();
        }
    });
    // Dragged: moved (or, cropping, a rectangle drawn).
    let drag = null, backgroundPointer = null, inpainting = null, drawing = null, placing = null, scanning = null;
    stage.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        stage.focus({ preventScroll: true });
        try {
            stage.setPointerCapture(e.pointerId);
        } catch { /* (not a pointer the browser has: moves still come) */ }
        const [px, py] = at(e);
        if (inpainting?.down(px, py, e) || backgroundPointer?.down(px, py, e) || drawing?.down(px, py, e) || placing?.down(px, py)) return;
        if (cropping && cropPick?.on()) { drag = { cropMagic: true, at: [px, py], from: toPicture(px, py), previous: crop }; return; }
        drag = cropping ? { crop: true, from: toPicture(px, py) } : { px, py, x, y };
        if (cropping) {
            crop = { ...drag.from, width: 0, height: 0 };
            showCrop();
        }
    });
    stage.addEventListener("pointermove", (e) => {
        const [px, py] = at(e);
        if (inpainting?.move(px, py) || backgroundPointer?.move(px, py) || drawing?.move(px, py) || placing?.move(px, py)) return;
        if (!drag) return;
        if (drag.cropMagic) {
            // A box round the object, shown as the crop is till it's found.
            drag.dragged ||= Math.hypot(px - drag.at[0], py - drag.at[1]) >= 5;
            if (!drag.dragged) return;
            const [cx, cy] = toPicture(px, py), [fx, fy] = drag.from;
            crop = { x: Math.min(fx, cx), y: Math.min(fy, cy), width: Math.abs(cx - fx), height: Math.abs(cy - fy) };
            showCrop();
            return;
        }
        if (drag.crop) {
            const [cx, cy] = toPicture(px, py);
            const [fx, fy] = drag.from;
            crop = { x: Math.min(fx, cx), y: Math.min(fy, cy), width: Math.abs(cx - fx), height: Math.abs(cy - fy) };
            showCrop();
            cropChanged?.();
        } else {
            x = drag.x + px - drag.px;
            y = drag.y + py - drag.py;
            fitting = false;
            place();
        }
    });
    const endDrag = (e) => {
        const [px, py] = at(e), cancelled = e.type === "pointercancel";
        if (drag?.cropMagic) cropPick?.up(drag, cancelled);
        drag = null; backgroundPointer?.up(cancelled, px, py); inpainting?.up(cancelled, px, py); drawing?.up(cancelled, px, py); placing?.up(cancelled, px, py);
    };
    stage.addEventListener("pointerleave", () => backgroundPointer?.leave());
    stage.addEventListener("pointerup", endDrag);
    stage.addEventListener("pointercancel", endDrag);
    // Laid out again as the stage's size changes. The window's resizing is
    // caught too: a size the observer last reported isn't reported again,
    // though what's shown may have been placed for one in between (redrawn
    // while the window was narrower), and would stay placed for that.
    const relayout = () => (fitting ? fit() : place());
    const resized = new ResizeObserver(relayout);
    resized.observe(stage);
    window.addEventListener("resize", relayout);

    // Cropping: a rectangle, in the picture's pixels, drawn over it.
    let cropping = false, crop = null, cropChanged = null;
    // Cropping to an object found with magic select (see startEditing).
    let cropPick = null;
    const toPicture = (px, py) => [Math.round(Math.max(0, Math.min(width, (px - x) / scale))),
        Math.round(Math.max(0, Math.min(height, (py - y) / scale)))];
    function showCrop() {
        cropBox.hidden = !cropping || !crop;
        if (cropBox.hidden) return;
        Object.assign(cropBox.style, { left: `${x + crop.x * scale}px`, top: `${y + crop.y * scale}px`,
            width: `${crop.width * scale}px`, height: `${crop.height * scale}px` });
        cropBox.dataset.size = `${crop.width}×${crop.height}`;
    }

    // Editable, a picture that stays still, and isn't too big for a canvas:
    // saved over the file if it's a format canvases write; else as a copy.
    view.editable = !moving && type !== "image/svg+xml" && width * height <= MAX_EDIT_PIXELS && width <= MAX_SIDE && height <= MAX_SIDE;
    view.stop = () => { resized.disconnect(); window.removeEventListener("resize", relayout); };
    fit();
    requestAnimationFrame(() => (fitting ? fit() : place()));

    // startEditing: rotated, flipped, cropped and resized (Ctrl+Z undoes
    // the last change), until stop(); and as Save is to write it: in which
    // format, at what quality, with its metadata or without. save() writes
    // it with save(blob), over the file, or in another format, as a copy
    // beside it with saveCopy(blob, name), which resolves to {name}. It
    // resolves to what the preview's editing needs.
    view.startEditing = async ({ save, saveCopy, changed = () => {}, maxPixels = MAX_EDIT_PIXELS, toolScope = null }) => {
        if (!view.editable) return null;
        let source, bytes;
        try {
            bytes = new Uint8Array(await blob.arrayBuffer());
            source = await createImageBitmap(blob, { imageOrientation: "from-image" });
        } catch {
            return null;
        }
        let sourceSize = [source.width, source.height];
        let meta = metadataOf(bytes, type);
        // ops: the changes made, in order. history: what ops were before
        // each change (Undo goes back to the last); future: what they were
        // before each undone (Redo goes forward to the last), till another
        // change is made.
        const ops = [], history = [], future = [];
        const remember = () => { history.push(ops.slice()); future.length = 0; };
        let backgroundEdit = null, backgroundPreview = null, backgroundFrame = null, inpaintPreview = null;
        let saving = false, copied = false, removing = false, stopped = false, maskSerial = 0;
        const remover = new BackgroundRemover();
        const status = el("span", { className: "edit-status hint" });
        const defaultTools = el("span", { className: "image-edit-default" });
        editBar.append(defaultTools);
        const say = (text, error = false) => {
            status.textContent = text;
            status.classList.toggle("error", error);
        };

        // Save as: the format (as it is, or another, as a copy), quality,
        // and its metadata kept or not; and what Save will do, said.
        const format = el("select", { className: "image-format" });
        format.setAttribute("aria-label", "Save as");
        if (WRITABLE.has(type)) format.append(el("option", { value: type, textContent: `${FORMATS[type]} (as it is)` }));
        for (const t of WRITABLE) if (t !== type) format.append(el("option", { value: t, textContent: `${FORMATS[t]} (a copy)` }));
        format.append(el("option", { value: "application/pdf", textContent: "PDF (a copy)" }));
        const quality = el("input", { type: "range", className: "image-quality", min: "10", max: "100", step: "1", value: String(Math.round(QUALITY * 100)) });
        quality.setAttribute("aria-label", "Quality");
        const qualityText = el("span", { className: "hint image-quality-value" });
        const qualityLabel = el("label", { className: "image-quality-label" }, "Quality ", quality, qualityText);
        const keep = el("input", { type: "checkbox", className: "image-keep-meta", checked: true });
        const keepLabel = el("label", { className: "check image-keep-meta-label" }, keep, "Keep metadata");
        const plan = el("span", { className: "hint image-plan" });
        const options = el("div", { className: "mask-brush-options image-save-options", role: "dialog", ariaLabel: "Save options" }, el("label", {}, "Save as ", format), qualityLabel, keepLabel, plan);
        options.setAttribute("popover", "auto");
        const saveOptionsButton = button("save-options", "Save options", "image-save-options-toggle");
        const saveOptionsArrow = el("button", { type: "button", className: "mask-size-toggle image-save-options-more", textContent: glyphs.chevronDown, title: "Save options", ariaLabel: "Save options" });
        const saveOptionsGroup = el("span", { className: "mask-paint-group image-save-options-group" }, saveOptionsButton, saveOptionsArrow, options);
        for (const control of [saveOptionsButton, saveOptionsArrow]) {
            control.setAttribute("aria-haspopup", "dialog");
            control.setAttribute("aria-expanded", "false");
        }
        const syncSaveOptions = () => {
            for (const control of [saveOptionsButton, saveOptionsArrow]) control.setAttribute("aria-expanded", String(options.matches(":popover-open")));
        };
        const positionSaveOptions = () => {
            if (!options.matches(":popover-open")) return;
            const rect = saveOptionsArrow.getBoundingClientRect(), box = options.getBoundingClientRect();
            options.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - box.width - 8))}px`;
            options.style.top = `${Math.max(8, Math.min(rect.bottom + 4, innerHeight - box.height - 8))}px`;
        };
        for (const control of [saveOptionsButton, saveOptionsArrow]) {
            control.popoverTargetElement = options;
            control.popoverTargetAction = "toggle";
            control.addEventListener("click", () => queueMicrotask(() => { syncSaveOptions(); positionSaveOptions(); }));
        }
        options.addEventListener("toggle", () => { syncSaveOptions(); positionSaveOptions(); });
        options.addEventListener("keydown", (event) => {
            if (event.key === "Escape") { event.preventDefault(); options.hidePopover(); syncSaveOptions(); saveOptionsArrow.focus(); }
            event.stopPropagation();
        });
        window.addEventListener("resize", positionSaveOptions);

        const state = () => JSON.stringify({ ops: ops.map((op) => op.background ? { mask: op.serial } : op.inpaint ? { inpaint: op.serial } : op.paste ? { paste: op.serial, rect: op.paste.rect, opacity: op.paste.opacity } : op), format: format.value, quality: quality.value, keep: keep.checked });
        let savedState = "";
        const dirty = () => state() !== savedState;
        // What Save will do: {how: "strip" | "encode" | "copy" | null, …}.
        const intent = () => saveIntent({ type, target: format.value, quality: Number(quality.value), kinds: meta.kinds,
            keep: keep.checked, edited: ops.length > 0, dirty: dirty(), name: file.name });
        const showOptions = () => {
            const target = format.value, same = target === type;
            qualityLabel.hidden = target === "image/png";
            qualityText.textContent = `${quality.value}%`;
            keepLabel.hidden = !same || !meta.kinds.length;
            keep.title = target === "image/webp" ? "A WebP's metadata is kept only if it isn't written again (re-encoded)" : "";
            plan.textContent = savePlan(intent(), { type, kinds: meta.kinds, orientation: meta.orientation });
            showButtons();
            positionSaveOptions();
        };
        format.addEventListener("change", showOptions);
        quality.addEventListener("input", showOptions);
        keep.addEventListener("change", showOptions);

        const redraw = (refit = true) => {
            const made = transform(source, sourceSize[0], sourceSize[1], inpaintPreview ?? backgroundPreview ?? ops);
            const canvas = made.canvas;
            canvas.className = "image-content";
            canvas.setAttribute("role", "img");
            canvas.setAttribute("aria-label", file.name);
            content.replaceWith(canvas);
            content = canvas;
            width = made.width;
            height = made.height;
            showInfo();
            if (refit) fit();
            else place();
            showOptions();
        };
        const change = (op) => {
            if (saving || backgroundEdit || inpainting?.active() || drawing?.active() || placing?.active() || scanning?.active() || cropping || !resizePanel.hidden || stopped) return;
            remember();
            ops.push(op);
            redraw();
            say("");
        };
        const rotateLeft = button("rotate-left", "Rotate left (L)", "image-rotate-left");
        const rotateRight = button("rotate-right", "Rotate right (R)", "image-rotate-right");
        const flipH = button("flip-h", "Flip left to right (H)", "image-flip-h");
        const flipV = button("flip-v", "Flip top to bottom (V)", "image-flip-v");
        const cropButton = button("crop", "Crop: drag over what to keep (C)", "image-crop-start");
        cropButton.setAttribute("aria-pressed", "false");
        const applyCrop = el("button", { type: "button", className: "image-crop-apply", textContent: "Apply", ariaLabel: "Apply crop", disabled: true });
        const cancelCrop = el("button", { type: "button", className: "image-crop-cancel", textContent: "Cancel" });
        const cropMagic = button("magic-select", "Crop to an object: click it, or drag a box round it", "image-crop-magic");
        cropMagic.setAttribute("aria-pressed", "false");
        const cropAll = button("magic-all", "Crop to all the objects magic select finds", "image-crop-magic-all");
        const cropTools = el("span", { className: "image-crop-tools", hidden: true }, el("span", { className: "image-magic-group" }, cropMagic, cropAll), applyCrop, cancelCrop);
        // Magic select, for cropping: the picture's analysed once (cropAnalysed:
        // the canvas it was), when the wand's first used.
        const cropSegmenter = new Segmenter();
        let cropMagicOn = false, cropAnalysed = null, cropBusy = false, cropToken = 0;
        const cropTask = async (doing, task) => {
            const token = ++cropToken, canvas = content;
            cropBusy = true; say(doing); showButtons();
            try {
                const current = () => cropping && token === cropToken;
                if (cropAnalysed !== canvas) {
                    await cropSegmenter.analyse(canvas);
                    if (!current()) return;
                    cropAnalysed = canvas;
                }
                await task(current);
            } catch (err) {
                if (cropping && token === cropToken) say(err.message, true);
            } finally { if (token === cropToken) { cropBusy = false; showButtons(); } }
        };
        // cropTo crops to what mask selects, found as doing says.
        const cropTo = (mask, what) => {
            const { width: w, height: h } = cropSegmenter.size, found = mask && objectBounds(mask, w, h, width, height);
            if (!found || found.width < 1 || found.height < 1) { say("Nothing found there. Try a box round the object."); return; }
            crop = found; showCrop(); showButtons();
            say(`Cropped to ${what}: Apply to keep it.`);
        };
        const pickCrop = (prompt) => cropTask("Finding the object…", async (current) => {
            const mask = await cropSegmenter.select(prompt);
            if (current()) cropTo(mask, "the object");
        });
        cropMagic.addEventListener("click", () => {
            if (!cropping || cropBusy) return;
            cropMagicOn = !cropMagicOn;
            cropMagic.setAttribute("aria-pressed", String(cropMagicOn));
            stage.classList.toggle("crop-magic", cropMagicOn);
            if (cropMagicOn) cropTask("Analysing the picture for magic select…", async () => say("Click an object to crop to it, or drag a box round it."));
            else say("");
            stage.focus({ preventScroll: true });
        });
        cropAll.addEventListener("click", () => {
            if (!cropping || cropBusy) return;
            cropTask("Finding every object… (this takes a while)", async (current) => {
                const { mask, count } = await cropSegmenter.findAll();
                if (!current()) return;
                if (!count) { say("No objects found. Click one with the wand, or drag a box round it."); return; }
                cropTo(mask, `${count} ${count === 1 ? "object" : "objects"}`);
            });
        });
        cropPick = {
            on: () => cropMagicOn,
            up(gesture, cancelled) {
                const box = crop;
                if (gesture.dragged || cancelled) { crop = gesture.previous; showCrop(); }
                if (cancelled || cropBusy || cropAnalysed !== content) return;
                if (!gesture.dragged) pickCrop({ point: gesture.from });
                else if (box?.width >= 1 && box?.height >= 1) pickCrop({ box: [box.x, box.y, box.width, box.height] });
            },
        };
        editBar.append(cropTools);
        // Resize: to a width and height (kept in proportion), or a share of it.
        const resizeButton = button("resize", "Resize: make it smaller or bigger (S)", "image-resize-start");
        const scanButton = button("scan-document", "Scan document: flatten and clean a photographed page", "image-scan-start");
        scanButton.setAttribute("aria-pressed", "false");
        const inpaintButton = button("inpaint", "Inpaint: remove a logo or object", "image-inpaint-start");
        const placeButton = button("paste-image", "Place a picture over this one, from a file (or paste one: Ctrl+V)", "image-place-start");
        placeButton.setAttribute("aria-pressed", "false");
        const placeFile = el("input", { type: "file", accept: "image/*", className: "image-place-file", hidden: true });
        const drawButton = button("draw-shape", "Draw: rectangles, circles, a pen, a highlighter and a paint bucket (D)", "image-draw-start");
        drawButton.setAttribute("aria-pressed", "false");
        const removeBackground = button("remove-background", "Remove background", "image-remove-background");
        removeBackground.setAttribute("aria-haspopup", "dialog");
        removeBackground.setAttribute("aria-expanded", "false");
        const backgroundPanel = el("div", { className: "mask-brush-options image-background-panel", role: "dialog", ariaLabel: "Background removal adjustments" });
        backgroundPanel.setAttribute("popover", "auto");
        const backgroundNote = el("p", { className: "hint image-background-note", role: "status" });
        const sliders = [
            ["threshold", "Threshold", 0, 100, 1, 50, "Higher removes more; lower keeps more."],
            ["softness", "Edge softness", 0, 100, 1, 100, "Higher blends the cutout edge; zero makes a hard cutoff."],
            ["grow", "Shrink / grow", -5, 5, .25, 0, "Negative shrinks the foreground; positive grows it."],
        ].map(([key, title, min, max, step, value, help]) => {
            const input = el("input", { type: "range", className: `image-background-${key}`, min, max, step, value, ariaLabel: title });
            const output = el("output", { className: "image-background-value" });
            const label = el("label", {}, el("span", { textContent: title }), input, output, el("small", { className: "hint", textContent: help }));
            return { key, input, output, label, initial: value };
        });
        const backgroundSettings = () => Object.fromEntries(sliders.map(({ key, input }) => [key, Number(input.value)]));
        backgroundPanel.append(...sliders.map(({ label }) => label), backgroundNote);
        view.append(backgroundPanel);
        let backgroundMode = "pan", gesture = null;
        const selectionBox = el("div", { className: "image-background-selection", hidden: true, ariaHidden: "true" });
        // Magic select: the objects clicked are what's kept, in place of
        // U2NetP's foreground. The picture's analysed once, when it's chosen.
        const segmenter = new Segmenter();
        const magicBox = el("div", { className: "image-background-magic-box", hidden: true, ariaHidden: "true" });
        stage.append(magicBox);
        let magicBusy = false, magicDoing = "";
        // Magic select: Select area, its shape an object.
        const magicMode = () => backgroundMode === "select" && brushes.shape.value === "object";
        const brushCursor = el("div", { className: "image-background-cursor", hidden: true, ariaHidden: "true" });
        stage.append(selectionBox, brushCursor);
        const modes = [["pan", "Pan"], ["select", "Select area"], ["erase", "Erase"], ["restore", "Restore"], ["fill", "Flood fill enclosed area"]].map(([mode, title]) => {
            const icon = { pan: "pan", select: "select-area", erase: "paint-brush", restore: "restore", fill: "flood-fill" }[mode];
            const control = button(icon, title, `image-background-mode-${mode}`);
            control.setAttribute("aria-pressed", "false");
            control.addEventListener("click", () => setBackgroundMode(mode));
            return { mode, title, control };
        });
        const invertSelection = button("invert-selection", "Invert selection", "image-background-invert");
        invertSelection.setAttribute("aria-pressed", "false");
        const wholeImage = button("select-all", "Apply removal to the whole image", "image-background-whole");
        const allObjects = button("magic-all", "Keep all objects: only the objects magic select finds, in place of the cutout", "image-background-magic-all");
        const brushes = brushControls(modes.find(({ mode }) => mode === "erase").control, {
            prefix: "image-background", sizeClass: "image-background-brush-size", selectionButton: modes.find(({ mode }) => mode === "select").control, onShape: () => setBackgroundMode("select"),
            magic: "click an object to remove it, or drag a box round it; Shift-click adds one back",
        });
        const brushSize = brushes.size;
        const undoStroke = glyphCaption(button("undo", "Undo stroke", "image-background-undo-stroke"), "Undo");
        const settingsButton = button("save-options", "Background removal adjustments", "image-background-settings");
        const spatialApply = button("check", "Apply background removal", "image-background-spatial-apply");
        const spatialCancel = button("close-circle", "Cancel background removal", "image-background-spatial-cancel");
        const spatialHint = el("span", { className: "hint image-background-spatial-hint", role: "status" });
        const spatialBar = el("div", { className: "image-background-spatial", hidden: true },
            ...modes.flatMap(({ mode, control }) => mode === "erase" ? [brushes.group] : mode === "select" ? [brushes.selectionGroup, el("span", { className: "image-magic-group" }, allObjects)] : [control]), wholeImage,
            invertSelection, undoStroke,
            settingsButton, spatialApply, spatialCancel);
        editBar.append(spatialBar);
        hintBar.append(spatialHint);
        const maskPoint = (point, inverse = true) => mapImagePoint(point, ...backgroundEdit.imageSize, backgroundEdit.trailing, inverse);
        const imagePoint = (px, py) => [(px - x) / scale, (py - y) / scale];
        const insideImage = ([px, py]) => px >= 0 && py >= 0 && px <= width && py <= height;
        const rectOf = ([ax, ay], [bx, by]) => ({ x: Math.min(ax, bx), y: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) });
        const showSelection = () => {
            const selection = backgroundEdit?.selection;
            selectionBox.hidden = !selection || !selection.width || !selection.height;
            if (selectionBox.hidden) return;
            const a = maskPoint([selection.x, selection.y], false);
            const b = maskPoint([selection.x + selection.width, selection.y + selection.height], false);
            const rect = rectOf(a, b);
            const left = Math.max(0, rect.x), top = Math.max(0, rect.y);
            const right = Math.min(width, rect.x + rect.width), bottom = Math.min(height, rect.y + rect.height);
            selectionBox.hidden = right <= left || bottom <= top;
            Object.assign(selectionBox.style, { left: `${x + left * scale}px`, top: `${y + top * scale}px`, width: `${(right - left) * scale}px`, height: `${(bottom - top) * scale}px` });
            selectionBox.style.borderRadius = selection.shape === "circle" ? "50%" : "0";
            selectionBox.style.clipPath = "none";
            if (selection.shape === "circle") {
                Object.assign(selectionBox.style, { left: `${x + rect.x * scale}px`, top: `${y + rect.y * scale}px`, width: `${rect.width * scale}px`, height: `${rect.height * scale}px`,
                    clipPath: `inset(${Math.max(0, -rect.y) * scale}px ${Math.max(0, rect.x + rect.width - width) * scale}px ${Math.max(0, rect.y + rect.height - height) * scale}px ${Math.max(0, -rect.x) * scale}px)` });
            }
            selectionBox.dataset.size = `${Math.round(right - left)}×${Math.round(bottom - top)}${selection.inverted ? " (outside)" : ""}`;
        };
        const showSpatial = () => {
            spatialBar.hidden = !backgroundEdit;
            spatialHint.hidden = !backgroundEdit;
            for (const { mode, control } of modes) {
                control.disabled = !backgroundEdit?.rawMask || removing || magicBusy;
                control.setAttribute("aria-pressed", String(mode === backgroundMode));
            }
            wholeImage.disabled = !backgroundEdit?.rawMask || removing;
            allObjects.hidden = !magicMode();
            allObjects.disabled = !backgroundEdit?.analysed || removing || magicBusy;
            invertSelection.disabled = wholeImage.disabled || !backgroundEdit?.selection || backgroundEdit.selection.width < 1 || backgroundEdit.selection.height < 1;
            invertSelection.setAttribute("aria-pressed", String(!!backgroundEdit?.selection?.inverted));
            brushes.update(!backgroundEdit?.rawMask || removing || magicBusy);
            undoStroke.disabled = !backgroundEdit?.added.length || removing || magicBusy;
            stage.classList.toggle("background-selecting", !!backgroundEdit && backgroundMode === "select" && !magicMode());
            stage.classList.toggle("background-brushing", !!backgroundEdit && ["erase", "restore"].includes(backgroundMode));
            spatialHint.classList.toggle("error", backgroundNote.classList.contains("error"));
            spatialHint.textContent = backgroundNote.classList.contains("error") ? backgroundNote.textContent
                : removing ? "Removing background…"
                : magicMode() ? (magicBusy ? (backgroundEdit?.analysed ? magicDoing : "Analysing the picture for magic select…")
                    : "Click an object to remove it, or drag a box round it; Shift-click (or Shift-drag) one to add it back.")
                : backgroundMode === "fill" ? "Draw a closed outline with Erase, then click inside to fill it."
                : backgroundMode === "select" && brushes.shape.value === "circle" ? "Circle: drag from its centre to its edge."
                : backgroundMode === "select" ? (backgroundEdit?.selection ? "Drag a rectangle: only this area changes." : "Background removal affects the whole image. Drag a rectangle to limit it to that area.")
                : backgroundMode === "erase" ? `Paint to make pixels transparent ${backgroundEdit?.selection ? (backgroundEdit.selection.inverted ? "outside the outlined area" : "inside the selected area") : "in the image"}.`
                : backgroundMode === "restore" ? `Paint to restore the original pixels ${backgroundEdit?.selection ? (backgroundEdit.selection.inverted ? "outside the outlined area" : "inside the selected area") : "in the image"}.`
                : backgroundEdit?.selection ? (backgroundEdit.selection.inverted ? "Background removal affects everything outside the outlined area." : "Background removal is limited to the outlined area.") : "Background removal affects the whole image.";
            showSelection();
        };
        const hideBackgroundControls = () => {
            backgroundPanel.hidePopover();
            removeBackground.setAttribute("aria-expanded", "false");
            settingsButton.setAttribute("aria-expanded", "false");
        };
        const showBackgroundControls = () => {
            backgroundPanel.showPopover();
            positionBackground();
            removeBackground.setAttribute("aria-expanded", "true");
            settingsButton.setAttribute("aria-expanded", "true");
        };
        const scheduleBackground = () => {
            cancelAnimationFrame(backgroundFrame);
            backgroundFrame = requestAnimationFrame(previewBackground);
        };
        function setBackgroundMode(mode) {
            if (!backgroundEdit?.rawMask || removing || magicBusy) return;
            backgroundPointer.up(true);
            backgroundMode = mode;
            // (An error here is magic select's: U2NetP's leaves no cutout to work on.)
            backgroundNote.classList.remove("error");
            backgroundNote.textContent = "Adjust the preview, then Apply.";
            // (No area selected is the whole image: one's made only by dragging.)
            hideBackgroundControls();
            brushCursor.hidden = true;
            previewBackground();
            stage.focus({ preventScroll: true });
            if (magicMode()) analyseForMagic();
        }
        // The mask is the objects picked, if any; else U2NetP's.
        const useObjects = () => {
            const edit = backgroundEdit;
            edit.rawMask = edit.objects.length ? objectMask(edit.objects, ...edit.imageSize, edit.found) : edit.found;
        };
        // magicTask runs one magic select step for edit, if it's still the one open.
        const magicTask = async (edit, task, doing = "Selecting…") => {
            magicBusy = true; magicDoing = doing; showSpatial(); showButtons();
            try {
                await task();
            } catch (err) {
                if (!stopped && backgroundEdit === edit) { backgroundNote.textContent = err.message; backgroundNote.classList.add("error"); say(err.message, true); }
            } finally {
                if (!stopped && backgroundEdit === edit) { magicBusy = false; showSpatial(); showButtons(); }
            }
        };
        const analyseForMagic = () => {
            const edit = backgroundEdit;
            if (!edit || edit.analysed || magicBusy) return;
            backgroundNote.classList.remove("error");
            magicTask(edit, async () => {
                await segmenter.analyse(edit.source);
                if (backgroundEdit === edit) edit.analysed = true;
            });
        };
        const pickObject = (prompt, erase) => {
            const edit = backgroundEdit;
            if (!edit?.analysed || magicBusy) return;
            backgroundNote.classList.remove("error");
            magicTask(edit, async () => {
                const mask = await segmenter.select(prompt);
                if (backgroundEdit !== edit) return;
                const { width: w, height: h } = segmenter.size;
                const mark = selectionMark(mask, w, h, ...edit.imageSize, erase);
                if (!mark) { say("Nothing found there. Try a click nearer the object's middle, or a box round it."); return; }
                edit.objects.push(mark); edit.added.push(mark);
                useObjects(); previewBackground();
                say(erase ? "Object removed. Apply to keep the change." : "Object added back. Apply to keep the change.");
            });
        };
        invertSelection.addEventListener("click", () => {
            if (invertSelection.disabled) return;
            backgroundEdit.selection = { ...backgroundEdit.selection, inverted: !backgroundEdit.selection.inverted };
            previewBackground();
        });
        wholeImage.addEventListener("click", () => {
            if (!backgroundEdit?.rawMask) return;
            backgroundEdit.selection = null;
            setBackgroundMode("pan");
        });
        brushSize.addEventListener("input", () => { brushCursor.hidden = true; });
        allObjects.addEventListener("click", () => {
            const edit = backgroundEdit;
            if (!edit?.analysed || magicBusy) return;
            backgroundNote.classList.remove("error");
            say("Finding every object… (this takes a while)");
            magicTask(edit, async () => {
                const { mask, count } = await segmenter.findAll();
                if (backgroundEdit !== edit) return;
                const { width: w, height: h } = segmenter.size;
                const mark = count ? selectionMark(mask, w, h, ...edit.imageSize) : null;
                if (!mark) { say("No objects found. Click one, or drag a box round it."); return; }
                mark.only = true; // (only these kept: what's found replaces the cutout)
                edit.objects.push(mark); edit.added.push(mark);
                useObjects(); previewBackground();
                say(`Kept ${count} ${count === 1 ? "object" : "objects"}. Click any to remove it.`);
            }, "Finding every object… (this takes a while)");
        });
        // Undo takes back the last stroke, fill or object picked.
        undoStroke.addEventListener("click", () => {
            const edit = backgroundEdit, last = edit?.added.pop();
            if (!last) return;
            for (const list of [edit.strokes, edit.objects]) { const i = list.lastIndexOf(last); if (i >= 0) list.splice(i, 1); }
            useObjects(); previewBackground();
        });
        settingsButton.setAttribute("aria-haspopup", "dialog");
        settingsButton.setAttribute("aria-expanded", "false");
        settingsButton.popoverTargetElement = backgroundPanel;
        settingsButton.popoverTargetAction = "toggle";
        const syncBackgroundControls = () => {
            const expanded = String(backgroundPanel.matches(":popover-open"));
            settingsButton.setAttribute("aria-expanded", expanded);
            removeBackground.setAttribute("aria-expanded", expanded);
        };
        settingsButton.addEventListener("click", () => queueMicrotask(() => { syncBackgroundControls(); positionBackground(); }));
        backgroundPanel.addEventListener("toggle", () => { syncBackgroundControls(); positionBackground(); });
        spatialApply.addEventListener("click", () => closeBackground(true));
        spatialCancel.addEventListener("click", () => closeBackground());
        spatialBar.addEventListener("keydown", (event) => {
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeBackground(); }
        });
        backgroundPointer = {
            painting: () => !!backgroundEdit && backgroundMode !== "pan",
            place: showSelection,
            down(px, py, event) {
                if (!backgroundEdit?.rawMask || removing || backgroundMode === "pan") return false;
                const point = imagePoint(px, py);
                if (magicMode()) {
                    if (!backgroundEdit.analysed) analyseForMagic(); // (it failed: again)
                    else if (!magicBusy) gesture = { magic: true, from: maskPoint(imageMaskPoint(px, py, { x, y, width, height, scale }, 6)), at: [px, py], erase: !(event?.shiftKey || event?.altKey) }; // (a click removes; Shift adds back)
                    return true;
                }
                const rectangle = backgroundMode === "select" && brushes.shape.value === "rectangle";
                if (!rectangle && !insideImage(point)) return true;
                const mapped = maskPoint(rectangle ? imageMaskPoint(px, py, { x, y, width, height, scale }, 6) : point);
                if (backgroundMode === "select") {
                    const mark = newMaskMark(brushes.shape.value, mapped, 0);
                    gesture = { from: mapped, previous: backgroundEdit.selection, selectionMark: mark };
                    backgroundEdit.selection = mark.circle ? { shape: "circle", x: mapped[0], y: mapped[1], width: 0, height: 0 } : mark.rect;
                } else {
                    const adjacent = maskPoint([point[0] + Number(brushSize.value) / 2, point[1]]);
                    if (backgroundMode === "fill") {
                        try {
                            const marks = backgroundEdit.strokes.map((stroke) => ({ ...stroke, erase: stroke.mode === "restore" }));
                            const fill = enclosedFill(marks, ...backgroundEdit.imageSize, mapped);
                            if (fill) { const stroke = { ...fill, mode: "erase" }; backgroundEdit.strokes.push(stroke); backgroundEdit.added.push(stroke); previewBackground(); say("Area filled. Apply to keep it."); }
                            else say("That area is already erased.");
                        } catch (err) { say(err.message, true); }
                        return true;
                    }
                    const stroke = newMaskMark("brush", mapped, Math.hypot(adjacent[0] - mapped[0], adjacent[1] - mapped[1]));
                    stroke.mode = backgroundMode;
                    backgroundEdit.strokes.push(stroke); backgroundEdit.added.push(stroke);
                    gesture = { stroke, from: mapped };
                }
                scheduleBackground();
                return true;
            },
            move(px, py) {
                if (!backgroundEdit?.rawMask || removing || backgroundMode === "pan") return false;
                const point = imagePoint(px, py);
                brushCursor.hidden = !["erase", "restore"].includes(backgroundMode) || !insideImage(point);
                if (!brushCursor.hidden) {
                    const diameter = Number(brushSize.value) * scale;
                    Object.assign(brushCursor.style, { left: `${px - diameter / 2}px`, top: `${py - diameter / 2}px`, width: `${diameter}px`, height: `${diameter}px` });
                }
                if (!gesture) return true;
                if (gesture.magic) {
                    gesture.dragged ||= Math.hypot(px - gesture.at[0], py - gesture.at[1]) >= 5;
                    const [ax, ay] = gesture.at;
                    magicBox.hidden = !gesture.dragged;
                    Object.assign(magicBox.style, { left: `${Math.min(ax, px)}px`, top: `${Math.min(ay, py)}px`, width: `${Math.abs(px - ax)}px`, height: `${Math.abs(py - ay)}px` });
                    return true;
                }
                const rectangle = !!gesture.selectionMark?.rect;
                const mapped = maskPoint(imageMaskPoint(px, py, { x, y, width, height, scale }, rectangle ? 6 : 0));
                if (gesture.stroke) extendMaskMark(gesture.stroke, gesture.from, mapped);
                else {
                    extendMaskMark(gesture.selectionMark, gesture.from, mapped);
                    const mark = gesture.selectionMark;
                    backgroundEdit.selection = mark.circle ? { shape: "circle", x: mark.circle.cx - mark.circle.r, y: mark.circle.cy - mark.circle.r, width: mark.circle.r * 2, height: mark.circle.r * 2 } : mark.rect;
                }
                scheduleBackground();
                return true;
            },
            up(cancelled, px, py) {
                if (gesture?.magic) {
                    const { from, erase } = gesture;
                    if (!cancelled && Number.isFinite(px) && Number.isFinite(py)) backgroundPointer.move(px, py);
                    const dragged = gesture.dragged;
                    gesture = null; magicBox.hidden = true;
                    if (cancelled || !backgroundEdit) return;
                    if (!dragged) { pickObject({ point: from }, erase); return; }
                    const to = maskPoint(imageMaskPoint(px, py, { x, y, width, height, scale }, 6)), box = rectOf(from, to);
                    if (box.width >= 1 && box.height >= 1) pickObject({ box: [box.x, box.y, box.width, box.height] }, erase);
                    return;
                }
                if (!gesture) return;
                if (!cancelled && Number.isFinite(px) && Number.isFinite(py)) backgroundPointer.move(px, py);
                if (cancelled && backgroundEdit) {
                    if (gesture.stroke) { backgroundEdit.strokes.pop(); backgroundEdit.added.pop(); }
                    else backgroundEdit.selection = gesture.previous;
                } else if (backgroundEdit && gesture.selectionMark) {
                    // A click, not a drag, leaves the area as it was.
                    const s = backgroundEdit.selection;
                    if (!s || s.width < 1 || s.height < 1) backgroundEdit.selection = gesture.previous;
                }
                gesture = null;
                if (backgroundEdit) {
                    cancelAnimationFrame(backgroundFrame);
                    previewBackground();
                }
            },
            leave() { brushCursor.hidden = true; },
        };
        // The picture and spatial toolbar are part of this editing session;
        // interacting with them must not dismiss the adjustment preview.
        const outsideBackground = (event) => {
            if (backgroundEdit && ![backgroundPanel, spatialBar, stage, bar, hintBar, toolScope].some((node) => node?.contains(event.target))) closeBackground(false, false);
        };
        document.addEventListener("pointerdown", outsideBackground, true);

        const positionBackground = () => {
            if (!backgroundPanel.matches(":popover-open")) return;
            const rect = settingsButton.getBoundingClientRect();
            const panel = backgroundPanel.getBoundingClientRect();
            backgroundPanel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - panel.width - 8))}px`;
            backgroundPanel.style.top = `${Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - panel.height - 8))}px`;
        };
        const previewBackground = () => {
            for (const { key, input, output } of sliders) output.textContent = `${key === "grow" && Number(input.value) > 0 ? "+" : ""}${input.value}%`;
            if (!backgroundEdit?.rawMask) return;
            const { rawMask, index } = backgroundEdit;
            backgroundPreview = ops.slice();
            const op = { background: adjustedMask(rawMask, backgroundSettings()), rawMask, settings: backgroundSettings(), serial: maskSerial + 1,
                imageSize: backgroundEdit.imageSize, selection: backgroundEdit.selection, strokes: backgroundEdit.strokes, objects: backgroundEdit.objects.slice() };
            if (index < 0) backgroundPreview.push(op);
            else backgroundPreview[index] = op;
            redraw(false);
        };
        const closeBackground = (apply = false, focus = true) => {
            if (!backgroundEdit) return;
            cancelAnimationFrame(backgroundFrame);
            if (apply && backgroundEdit.rawMask) {
                previewBackground(); // include a slider event whose animation frame hasn't run yet
                const previous = ops[backgroundEdit.index];
                const details = (op) => JSON.stringify([op?.settings, op?.selection ?? null, op?.strokes ?? [], op?.objects ?? []]);
                const candidate = backgroundPreview[backgroundEdit.index < 0 ? backgroundPreview.length - 1 : backgroundEdit.index];
                if (!previous || details(previous) !== details(candidate)) {
                    remember();
                    ops.splice(0, ops.length, ...backgroundPreview);
                    maskSerial++;
                }
                if (format.value === "image/jpeg") format.value = "image/png";
            }
            gesture = null;
            backgroundMode = "pan";
            brushes.close();
            brushCursor.hidden = selectionBox.hidden = true;
            backgroundEdit = backgroundPreview = null;
            remover.cancel(); segmenter.cancel();
            removing = magicBusy = false; magicBox.hidden = true;
            hideBackgroundControls();
            redraw(false);
            say(apply ? "Background removed. Undo to restore it." : "Background removal cancelled.");
            if (focus) removeBackground.focus({ preventScroll: true });
        };
        for (const { input } of sliders) input.addEventListener("input", () => {
            cancelAnimationFrame(backgroundFrame);
            backgroundFrame = requestAnimationFrame(previewBackground);
        });
        backgroundPanel.addEventListener("keydown", (event) => {
            // Editing shortcuts and the preview dialog must not consume slider keys.
            if (event.key === "Escape") { event.preventDefault(); hideBackgroundControls(); settingsButton.focus(); }
            event.stopPropagation();
        });
        removeBackground.addEventListener("click", async () => {
            if (backgroundEdit) {
                if (backgroundPanel.matches(":popover-open")) hideBackgroundControls();
                else showBackgroundControls();
                return;
            }
            if (saving || cropping || drawing?.active() || placing?.active() || scanning?.active() || !resizePanel.hidden || stopped) return;
            inpainting?.close();
            setCropping(false);
            setResizing(false);
            // Each activation edits the current image. Replacing an earlier
            // operation would restore its removed pixels outside a new selection.
            // (source: the picture as it is now, for magic select; found: U2NetP's mask;
            // added: strokes, fills and objects, in order, for Undo.)
            const edit = backgroundEdit = { index: -1, rawMask: null, found: null, source: content, analysed: false,
                imageSize: [width, height], trailing: [], selection: null, strokes: [], objects: [], added: [] };
            // It starts with Select area, a rectangle: none drawn yet, the whole image.
            backgroundMode = "select"; brushes.shape.value = "rectangle";
            for (const { input, initial } of sliders) input.value = initial;
            removing = !edit.rawMask;
            backgroundNote.textContent = removing ? "Removing background…" : "Adjust the preview, then Apply.";
            backgroundNote.classList.remove("error");
            showButtons();
            previewBackground();
            hideBackgroundControls();
            stage.focus({ preventScroll: true });
            if (!removing) return;
            say("Removing background…");
            try {
                edit.rawMask = edit.found = await remover.remove(content);
                if (stopped || backgroundEdit !== edit) return;
                previewBackground();
                backgroundNote.textContent = "Adjust the preview, then Apply.";
                say("");
            } catch (err) {
                if (!stopped && backgroundEdit === edit) {
                    backgroundNote.textContent = err.message;
                    backgroundNote.classList.add("error");
                    say(err.message, true);
                }
            } finally {
                if (!stopped && backgroundEdit === edit) {
                    removing = false;
                    showOptions();
                }
            }
        });
        window.addEventListener("resize", positionBackground);
        resizeButton.setAttribute("aria-pressed", "false");
        const newWidth = el("input", { type: "number", className: "image-resize-width", min: "1", max: String(MAX_SIDE), step: "1" });
        const newHeight = el("input", { type: "number", className: "image-resize-height", min: "1", max: String(MAX_SIDE), step: "1" });
        const percent = el("input", { type: "number", className: "image-resize-percent", min: "1", max: "1000", step: "1", value: "100" });
        newWidth.setAttribute("aria-label", "Width, in pixels");
        newHeight.setAttribute("aria-label", "Height, in pixels");
        percent.setAttribute("aria-label", "Size, as a percentage");
        const applyResize = el("button", { type: "button", className: "image-resize-apply", textContent: "Apply", ariaLabel: "Apply resize" });
        const cancelResize = el("button", { type: "button", className: "image-resize-cancel", textContent: "Cancel" });
        const resizePanel = el("span", { className: "image-resize", hidden: true }, newWidth, "×", newHeight, "px, or ", percent, "% ", applyResize, cancelResize);
        editBar.append(resizePanel);
        const wanted = () => [Math.round(Number(newWidth.value)), Math.round(Number(newHeight.value))];
        const resizeOK = () => {
            const [w, h] = wanted();
            return w >= 1 && h >= 1 && w <= MAX_SIDE && h <= MAX_SIDE && w * h <= maxPixels && (w !== width || h !== height);
        };
        const setSize = (w) => {
            newWidth.value = String(Math.max(1, Math.round(w)));
            newHeight.value = String(Math.max(1, Math.round(w * height / width)));
            applyResize.disabled = !resizeOK();
        };
        newWidth.addEventListener("input", () => { setSize(Number(newWidth.value) || 0); percent.value = String(Math.round(Number(newWidth.value) / width * 100)); });
        newHeight.addEventListener("input", () => {
            const h = Number(newHeight.value) || 0;
            newWidth.value = String(Math.max(1, Math.round(h * width / height)));
            percent.value = String(Math.round(h / height * 100));
            applyResize.disabled = !resizeOK();
        });
        percent.addEventListener("input", () => setSize(width * (Number(percent.value) || 0) / 100));
        const setResizing = (on) => {
            if (on && (saving || cropping || drawing?.active() || placing?.active() || scanning?.active() || backgroundEdit || inpainting?.active())) return;
            resizePanel.hidden = !on;
            resizeButton.setAttribute("aria-pressed", String(on));
            showButtons();
            if (on) {
                percent.value = "100";
                setSize(width);
                newWidth.select?.();
                newWidth.focus?.();
            }
        };
        resizeButton.addEventListener("click", () => setResizing(resizePanel.hidden));
        cancelResize.addEventListener("click", () => setResizing(false));
        applyResize.addEventListener("click", () => {
            if (!resizeOK()) return;
            const size = wanted();
            setResizing(false);
            change({ resize: size });
        });
        resizePanel.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); applyResize.click(); }
            else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setResizing(false); }
            e.stopPropagation();
        });
        const undo = glyphCaption(button("undo", "Undo the last change (Ctrl+Z)", "image-undo"), "Undo");
        undo.disabled = true;
        const redo = glyphCaption(button("redo", "Redo what was undone (Ctrl+Shift+Z)", "image-redo"), "Redo");
        redo.disabled = true;
        // History: every state, from the original, to go back or forward to.
        const historyButton = button("history", "History: go back to any step", "image-history-toggle");
        historyButton.setAttribute("aria-haspopup", "dialog");
        historyButton.setAttribute("aria-expanded", "false");
        const historyList = el("ol", { className: "image-history-list" });
        const historyPanel = el("div", { className: "image-history", role: "dialog", ariaLabel: "History" }, el("strong", { textContent: "History" }), historyList);
        historyPanel.setAttribute("popover", "auto");
        historyButton.popoverTargetElement = historyPanel;
        historyButton.popoverTargetAction = "toggle";
        const historyGroup = el("span", { className: "image-history-group" }, historyButton, historyPanel);
        const positionHistory = () => {
            if (!historyPanel.matches(":popover-open")) return;
            const rect = historyButton.getBoundingClientRect(), box = historyPanel.getBoundingClientRect();
            historyPanel.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - box.width - 8))}px`;
            historyPanel.style.top = `${Math.max(8, Math.min(rect.bottom + 4, innerHeight - box.height - 8))}px`;
        };
        historyPanel.addEventListener("toggle", () => {
            const open = historyPanel.matches(":popover-open");
            historyButton.setAttribute("aria-expanded", String(open));
            if (open) { showHistory(); positionHistory(); }
        });
        historyPanel.addEventListener("keydown", (event) => {
            if (event.key === "Escape") { event.preventDefault(); historyPanel.hidePopover(); historyButton.focus(); }
            event.stopPropagation();
        });
        const toolOpen = () => saving || !!backgroundEdit || !!inpainting?.active() || !!(drawing?.active() || placing?.active() || scanning?.active()) || cropping || !resizePanel.hidden || stopped;
        // states: the original, each change since, and those undone.
        const states = () => [...history, ops.slice(), ...future.slice().reverse()];
        // stateName is what made state i of all, from the one before it.
        const stateName = (all, i) => {
            if (i === 0) return "Original";
            const before = all[i - 1], after = all[i];
            let j = 0;
            while (j < before.length && j < after.length && before[j] === after[j]) j++;
            if (j >= after.length) return "Removed a step";
            const step = editRecipe(...sourceSize, after)?.steps[j];
            const name = step ? describeStep(step) : "Edit";
            return j < before.length ? `${name} (changed)` : name;
        };
        function showHistory() {
            const all = states(), at = history.length;
            historyList.replaceChildren(...all.map((_, i) => {
                const item = el("button", { type: "button", className: "image-history-step", textContent: stateName(all, i),
                    title: i < at ? "Go back to this" : i > at ? "Redo up to this" : "Shown now" });
                if (i === at) item.setAttribute("aria-current", "step");
                item.addEventListener("click", () => goTo(i));
                return el("li", { className: i > at ? "undone" : "" }, item);
            }));
        }
        // goTo shows state i of all (see states), as it was: those before
        // it undo to, those after it redo to.
        const goTo = (i) => {
            if (toolOpen()) return;
            const all = states();
            if (!Number.isInteger(i) || i < 0 || i >= all.length || i === history.length) return;
            history.splice(0, history.length, ...all.slice(0, i));
            future.splice(0, future.length, ...all.slice(i + 1).reverse());
            ops.splice(0, ops.length, ...all[i]);
            redraw();
            say("");
        };
        function showButtons() {
            const masking = !!backgroundEdit || !!inpainting?.active();
            const choosing = masking || cropping || !!(drawing?.active() || placing?.active() || scanning?.active()) || !resizePanel.hidden;
            defaultTools.hidden = choosing;
            hintBar.hidden = !masking && !scanning?.active();
            if (choosing) { options.hidePopover(); syncSaveOptions(); }
            for (const control of [rotateLeft, rotateRight, flipH, flipV, cropButton, resizeButton, drawButton, placeButton, scanButton, format, quality, keep, saveOptionsButton, saveOptionsArrow]) control.disabled = saving || choosing;
            removeBackground.disabled = inpaintButton.disabled = saving || cropping || !!(drawing?.active() || placing?.active() || scanning?.active()) || !resizePanel.hidden;
            inpaintButton.setAttribute("aria-pressed", String(!!inpainting?.active()));
            undo.disabled = !history.length || saving || choosing;
            redo.disabled = !future.length || saving || choosing;
            historyButton.disabled = saving || choosing || !history.length && !future.length;
            if (historyButton.disabled) historyPanel.hidePopover();
            else if (historyPanel.matches(":popover-open")) { showHistory(); positionHistory(); }
            for (const { input } of sliders) input.disabled = !backgroundEdit?.rawMask || removing;
            const selected = backgroundEdit?.selection;
            spatialApply.disabled = !backgroundEdit?.rawMask || removing || !!selected && (selected.width < 1 || selected.height < 1);
            showSpatial();
            applyCrop.disabled = saving || removing || cropBusy || !crop || crop.width < 1 || crop.height < 1;
            cropMagic.disabled = cropAll.disabled = saving || cropBusy;
            // Lay out toolbar changes before another pointer event can arrive.
            if (fitting) fit(); else place();
            changed();
        }
        const setCropping = (on) => {
            if (on && (saving || !resizePanel.hidden || backgroundEdit || inpainting?.active() || drawing?.active() || placing?.active() || scanning?.active())) return;
            cropping = on;
            crop = null;
            if (!on) {
                cropToken++; cropBusy = cropMagicOn = false; cropAnalysed = null; cropSegmenter.cancel();
                cropMagic.setAttribute("aria-pressed", "false"); stage.classList.remove("crop-magic");
            }
            cropButton.setAttribute("aria-pressed", String(on));
            cropTools.hidden = !on;
            stage.classList.toggle("cropping", on);
            showCrop();
            showButtons();
        };
        inpainting = inpaintTool({ toolbar: editBar, hints: hintBar, stage, button: inpaintButton,
            geometry: () => ({ width, height, x, y, scale }), source: () => content,
            preview: (patch) => { inpaintPreview = patch ? [...ops, { inpaint: patch, serial: maskSerial + 1 }] : null; redraw(false); },
            apply: (patch, recipe) => { remember(); ops.push({ inpaint: patch, recipe, serial: ++maskSerial }); redraw(false); say("Inpainting applied. Undo to restore it."); },
            changed: showButtons,
        });
        inpaintButton.addEventListener("click", () => {
            if (saving || cropping || drawing?.active() || placing?.active() || scanning?.active() || !resizePanel.hidden || stopped) return;
            closeBackground(false, false);
            setCropping(false); setResizing(false);
            inpainting.open(); showButtons();
        });
        drawing = drawTool({ toolbar: editBar, stage, button: drawButton,
            geometry: () => ({ width, height, x, y, scale }), source: () => content,
            apply: (op) => { change(op); say("Shape drawn. Undo to remove it."); },
            changed: () => showButtons(),
        });
        placing = placeTool({ toolbar: editBar, stage, button: placeButton,
            geometry: () => ({ width, height, x, y, scale }),
            apply: (op) => { op.serial = ++maskSerial; change(op); say("Picture placed. Undo to remove it."); },
            changed: () => showButtons(),
        });
        // A picture to place: from a file chosen, or pasted (while no other
        // tool's open; while placing, the one placed is replaced).
        const placePicture = async (file) => {
            if (saving || cropping || !resizePanel.hidden || backgroundEdit || inpainting?.active() || drawing?.active() || stopped) return;
            try { await placing.open(file); } catch (err) { say(err.message, true); }
        };
        placeButton.addEventListener("click", () => { if (!placeButton.disabled) placeFile.click(); });
        placeFile.addEventListener("change", () => {
            const file = placeFile.files?.[0];
            placeFile.value = "";
            if (file) placePicture(file);
        });
        const pasted = (event) => {
            const file = pastedPicture(event);
            if (!file || stopped) return;
            event.preventDefault();
            placePicture(file);
        };
        view.addEventListener("paste", pasted);
        const openDrawing = () => {
            if (saving || cropping || !resizePanel.hidden || backgroundEdit || inpainting?.active() || placing?.active() || scanning?.active() || stopped) return;
            if (drawing.active()) drawing.close(); else drawing.open();
        };
        drawButton.addEventListener("click", openDrawing);
        scanning = scanTool({ toolbar: editBar, hints: hintBar, stage, button: scanButton,
            geometry: () => ({ width, height, x, y, scale }), source: () => content,
            apply: (op) => { change(op); say("Document scanned. Undo to restore the photo."); }, changed: () => showButtons(),
        });
        scanButton.addEventListener("click", () => {
            if (saving || cropping || !resizePanel.hidden || backgroundEdit || inpainting?.active() || drawing?.active() || placing?.active() || stopped) return;
            try { scanning.open(); } catch (err) { say(err.message, true); }
        });
        cropChanged = showButtons;
        rotateLeft.addEventListener("click", () => change("left"));
        rotateRight.addEventListener("click", () => change("right"));
        flipH.addEventListener("click", () => change("h"));
        flipV.addEventListener("click", () => change("v"));
        cropButton.addEventListener("click", () => setCropping(!cropping));
        cancelCrop.addEventListener("click", () => setCropping(false));
        applyCrop.addEventListener("click", () => {
            if (applyCrop.disabled) return;
            const c = crop;
            setCropping(false);
            change({ x: c.x, y: c.y, width: c.width, height: c.height });
        });
        const undoLast = () => goTo(history.length - 1);
        const redoNext = () => goTo(history.length + 1);
        undo.addEventListener("click", undoLast);
        redo.addEventListener("click", redoNext);
        const keys = (e) => {
            if (scanning?.active()) {
                if (e.key === "Escape" || e.key === "Enter") { e.preventDefault(); e.stopPropagation(); if (e.key === "Escape") scanning.close(); else scanning.commit(); }
                return;
            }
            if (inpainting?.active()) {
                if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "a") {
                    e.preventDefault(); e.stopPropagation(); inpainting.selectAll();
                }
                if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); inpainting.close(); }
                return;
            }
            if (backgroundEdit) {
                if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeBackground(); }
                return;
            }
            if (placing?.active()) {
                const act = { Escape: () => placing.close(), Enter: () => placing.commit() }[e.key];
                if (act && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); act(); }
                return;
            }
            if (drawing?.active()) {
                const act = { Escape: () => drawing.close(), Enter: () => drawing.commit(), i: () => drawing.pick(), p: () => drawing.pen(), b: () => drawing.bucket() }[e.key.length === 1 ? e.key.toLowerCase() : e.key];
                if (act && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); act(); }
                return;
            }
            if (cropping || !resizePanel.hidden) {
                if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (cropping) setCropping(false); else setResizing(false); }
                else if (cropping && e.key === "Enter") { e.preventDefault(); e.stopPropagation(); applyCrop.click(); }
                return;
            }
            if (saving) return;
            if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key.toLowerCase() === "z" || e.key.toLowerCase() === "y")) {
                e.preventDefault();
                if (e.key.toLowerCase() === "y" || e.shiftKey) redoNext(); else undoLast();
                return;
            }
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            const act = { l: () => change("left"), r: () => change("right"), h: () => change("h"), v: () => change("v"),
                c: () => setCropping(!cropping), s: () => setResizing(resizePanel.hidden), d: openDrawing,
                Escape: () => cropping && setCropping(false), Enter: () => cropping && applyCrop.click() }[e.key.length === 1 ? e.key.toLowerCase() : e.key];
            if (act) {
                e.preventDefault();
                e.stopPropagation();
                act();
            }
        };
        stage.addEventListener("keydown", keys);
        defaultTools.replaceChildren(rotateLeft, rotateRight, flipH, flipV, cropButton, resizeButton, scanButton, drawButton, placeButton, placeFile, removeBackground, inpaintButton, undo, redo, historyGroup, saveOptionsGroup, status);
        editBar.hidden = false;
        view.classList.add("editing");
        if (!WRITABLE.has(type)) format.value = "image/png";
        savedState = state();
        redraw();
        stage.focus({ preventScroll: true });

        const encode = (target, q) => new Promise((resolve) => content.toBlob(resolve, target, target === "image/png" ? undefined : q / 100));
        return {
            dirty,
            pending: () => !!backgroundEdit || !!inpainting?.active() || !!(drawing?.active() || placing?.active() || scanning?.active()) || cropping || !resizePanel.hidden,
            batchRecipe: () => {
                let pending = null;
                if (scanning?.active()) {
                    pending = scanning.recipe(); if (!pending) return null;
                } else if (inpainting?.active()) {
                    pending = inpainting.recipe();
                    if (!pending) return null;
                } else if (backgroundEdit) {
                    if (!backgroundEdit.rawMask || removing || spatialApply.disabled) return null;
                    pending = { kind: "background", width, height, settings: backgroundSettings(),
                        selection: backgroundEdit.selection, strokes: backgroundEdit.strokes, ...(backgroundEdit.objects.length ? { objects: backgroundEdit.objects } : {}) };
                } else if (drawing?.active()) {
                    pending = drawing.recipe();
                    if (!pending) return null;
                } else if (placing?.active()) {
                    pending = placing.recipe();
                    if (!pending) return null;
                } else if (cropping) {
                    if (applyCrop.disabled) return null;
                    pending = { kind: "crop", width, height, rect: { ...crop } };
                } else if (!resizePanel.hidden) {
                    if (!resizeOK()) return null;
                    pending = { kind: "resize", width, height, size: wanted() };
                }
                return editRecipe(...sourceSize, ops, pending);
            },
            snapshot: async ({ beforeTool = false } = {}) => {
                if (stopped) throw new Error("This image editor is closed.");
                if (width * height > maxPixels) throw new Error("The edited page exceeds the pixel limit.");
                if (!beforeTool && (backgroundEdit || inpainting?.active() || drawing?.active() || placing?.active() || scanning?.active() || cropping || !resizePanel.hidden)) throw new Error("Apply or cancel the current tool first.");
                const canvas = beforeTool ? transform(source, sourceSize[0], sourceSize[1], ops).canvas : content;
                const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
                if (beforeTool) canvas.width = canvas.height = 0;
                if (!blob) throw new Error("The edited page couldn't be encoded.");
                return blob;
            },
            saving: () => saving,
            // (A format that can't be written over: its copy can be, unchanged.)
            canSave: () => !saving && !backgroundEdit && !inpainting?.active() && !drawing?.active() && !placing?.active() && !scanning?.active() && !cropping && resizePanel.hidden && (intent().how !== null || !WRITABLE.has(type) && !copied),
            save: async () => {
                const it = intent();
                const how = it.how ?? (!WRITABLE.has(type) && !copied ? "copy" : null);
                if (saving || backgroundEdit || inpainting?.active() || drawing?.active() || placing?.active() || scanning?.active() || cropping || !resizePanel.hidden || stopped || !how) return;
                saving = true;
                showButtons();
                say("Saving…");
                try {
                    let out;
                    if (how === "strip") {
                        const s = stripped(bytes, type, meta.orientation);
                        if (s) out = new Blob([s], { type });
                    }
                    if (!out) {
                        const target = how === "copy" ? format.value : type;
                        let made;
                        if (target === "application/pdf") {
                            // Flatten transparency onto paper before JPEG encoding.
                            const page = Object.assign(document.createElement("canvas"), { width, height });
                            const ctx = page.getContext("2d"); ctx.fillStyle = "white"; ctx.fillRect(0, 0, width, height); ctx.drawImage(content, 0, 0);
                            const jpeg = await new Promise(resolve => page.toBlob(resolve, "image/jpeg", it.q / 100));
                            page.width = page.height = 0;
                            if (!jpeg) throw new Error("The scanned page couldn't be encoded.");
                            made = rasterPDF([{ blob: jpeg, width, height, widthPt: width * 72 / 150, heightPt: height * 72 / 150 }]);
                        } else made = await encode(target, it.q);
                        if (!made || made.type !== target) throw new Error(`this browser can't write ${FORMATS[target]} pictures`);
                        out = how === "encode" && it.kept ? new Blob([withMetadata(new Uint8Array(await made.arrayBuffer()), bytes, type, content.width, content.height)], { type }) : made;
                    }
                    if (how === "copy") {
                        const name = copyName(file.name, format.value);
                        const reply = await saveCopy(out, name);
                        copied = true;
                        savedState = state();
                        say(`Saved a copy as ${reply?.name ?? name}: ${describe({ width, height, type: out.type, size: out.size })}.`);
                    } else {
                        await save(out);
                        // What's saved is now what it was: changes from here.
                        source.close?.();
                        bytes = new Uint8Array(await out.arrayBuffer());
                        source = await createImageBitmap(out, { imageOrientation: "from-image" });
                        sourceSize = [source.width, source.height];
                        meta = metadataOf(bytes, type);
                        ops.length = history.length = future.length = 0;
                        blob = out;
                        file.size = out.size;
                        keep.checked = true;
                        quality.value = String(Math.round(QUALITY * 100));
                        savedState = state();
                        redraw();
                        say(`Saved: ${describe({ width, height, type, size: out.size })}${meta.kinds.length ? ` · ${meta.kinds.join(", ")}` : ""}.`);
                    }
                } catch (err) {
                    say(`Not saved: ${err.message}`, true);
                } finally {
                    saving = false;
                    showOptions();
                }
            },
            stop: () => {
                closeBackground(false, false);
                inpainting?.stop();
                inpainting = null;
                drawing?.stop();
                drawing = null;
                placing?.stop();
                placing = null;
                view.removeEventListener("paste", pasted);
                stopped = true;
                cancelAnimationFrame(backgroundFrame);
                remover.cancel(); segmenter.cancel();
                magicBox.remove();
                window.removeEventListener("resize", positionBackground);
                window.removeEventListener("resize", positionSaveOptions);
                options.hidePopover();
                historyPanel.hidePopover();
                document.removeEventListener("pointerdown", outsideBackground, true);
                backgroundPointer = null;
                scanning?.stop(); scanning = null;
                selectionBox.remove();
                brushCursor.remove();
                brushes.stop();
                spatialBar.remove();
                spatialHint.remove();
                backgroundPanel.remove();
                setCropping(false);
                cropChanged = cropPick = null; cropSegmenter.cancel();
                stage.removeEventListener("keydown", keys);
                editBar.hidden = true;
                editBar.replaceChildren();
                view.classList.remove("editing");
                source.close?.();
            },
        };
    };
    return view;
}
