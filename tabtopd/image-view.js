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
import { openExif } from "./image-exif-view.js";
import { el } from "./preview-dom.js";
import { glyphs, iconSVG } from "./glyphs.js";
import { humanBytes } from "./file-format.js";
import { knownFrom, metadataOf, stripped, withMetadata, savingQuality } from "./image-meta.js";
import { HEIF_TYPES } from "./image-heif.js";
import { clipSelection, maskPath, newMaskMark, extendMaskMark, enclosedFill, glyphCaption, brushControls, imageMaskPoint } from "./image-mask.js";
import { inpaintTool } from "./image-inpaint.js";
import { drawTool, drawShape } from "./image-draw.js";
import { placeTool, drawPlacement, pastedPicture } from "./image-place.js";
import { resizeTool } from "./image-resize.js";
import { cropTool } from "./image-crop.js";
import { backgroundTool } from "./image-background-tool.js";
import { scanCanvas, scanGeometry, scanTool } from "./image-scan.js";
import { rasterPDF } from "./image-export.js";
import { drawFill } from "./image-fill.js";
import { describeStep } from "./image-batch.js";
import { BackgroundRemover, adjustedMask, mapImagePoint, objectMask } from "./image-background.js";
import { Segmenter, selectionMark, objectBounds } from "./image-segment.js";

const FORMATS = {
    "image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WebP", "image/gif": "GIF", "image/avif": "AVIF",
    "image/heic": "HEIC", "image/heif": "HEIF",
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
// (own is the quality it starts at, its own: see savingQuality.)
export function saveIntent({ type, target, quality, kinds, keep, edited, dirty, name, own = Math.round(QUALITY * 100) }) {
    const q = quality;
    if (target !== type) return { how: "copy", target, q, name: copyName(name, target) };
    const strip = kinds.length > 0 && !keep;
    if (!edited && q === own && strip) return { how: "strip", target, q };
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
// note that it can't be shown. shown, if given, is the picture as it's
// shown and edited (a HEIC's, decoded by the server, see heif.go): blob
// stays the file, whose metadata is read and written.
export async function imageView({ file, blob, url, shown = null, saveMetadata = null }) {
    const type = blob?.type || file.type;
    let shownURL = shown ? URL.createObjectURL(shown) : null;
    const pixels = () => shown ?? blob;
    const img = el("img", { src: shownURL ?? url, alt: file.name, draggable: false, className: "image-content" });
    try {
        await img.decode();
    } catch {
        if (shownURL) URL.revokeObjectURL(shownURL);
        return el("p", { className: "error", textContent: "This browser can't show this picture. Download it instead." });
    }
    // Its first bytes say whether it moves, and a JPEG's, what metadata it
    // has; a PNG's or WebP's, only all of it. (Not copied whole if not.)
    let probe = blob ? new Uint8Array(await blob.slice(0, PROBE_BYTES).arrayBuffer()) : new Uint8Array();
    const moving = animated(probe, type);
    if (blob && !knownFrom(probe, type, blob.size)) probe = new Uint8Array(await blob.arrayBuffer());
    let metaKinds = metadataOf(probe, type).kinds;
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
    let exifDialog, metadataURL, viewStopped = false;
    const showExif = () => {
        if (view.classList.contains("editing")) return;
        exifDialog?.close();
        exifDialog = openExif({ name: file.name, blob, save: saveMetadata ? async (next, signal) => {
            await saveMetadata(next, signal);
            signal.throwIfAborted();
            blob = next; file.size = next.size;
            metaKinds = metadataOf(new Uint8Array(await next.arrayBuffer()), type).kinds;
            // A HEIF picture's turn is its own, not its EXIF's: as it was.
            if (HEIF_TYPES.has(type)) { if (!viewStopped) showInfo(); return; }
            // Orientation is editable metadata: refresh the decoded image so
            // the preview immediately follows its new display orientation.
            const nextURL = URL.createObjectURL(next);
            if (metadataURL) URL.revokeObjectURL(metadataURL);
            metadataURL = nextURL; img.src = nextURL;
            try {
                await img.decode();
                if (!viewStopped) {
                    width = img.naturalWidth || DEFAULT_SIZE[0]; height = img.naturalHeight || DEFAULT_SIZE[1];
                    img.style.width = `${width}px`; img.style.height = `${height}px`;
                    showInfo(); if (fitting) fit(); else place();
                }
            } catch { if (!viewStopped) showInfo(); }
        } : null });
    };
    const editBar = el("span", { className: "image-edit", hidden: true });
    const bar = el("div", { className: "image-bar" },
        el("span", { className: "image-zoom-group", role: "group", ariaLabel: "Zoom" }, zoomOut, zoomLabel, zoomIn), fitButton, actualButton, editBar, info);
    const cropBox = el("div", { className: "image-crop", hidden: true });
    const stage = el("div", { className: "image-stage", tabIndex: 0, ariaLabel: file.name }, img, cropBox);
    const hintBar = el("div", { className: "image-tool-hints", hidden: true });
    const view = el("div", { className: "image-view" }, bar, hintBar, stage);
    view.openExif = blob && (["image/jpeg", "image/png", "image/webp"].includes(type) || HEIF_TYPES.has(type)) ? showExif : null;
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
        cropper?.place();
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
        if (cropper?.painting() || backgroundPointer?.painting() || inpainting?.painting() || drawing?.painting() || placing?.painting() || scanning?.painting()) return;
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
    // Dragged: moved (or, a tool open, the tool's: cropping, a rectangle drawn).
    let drag = null, backgroundPointer = null, inpainting = null, drawing = null, placing = null, resizing = null, cropper = null, scanning = null;
    stage.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        stage.focus({ preventScroll: true });
        try {
            stage.setPointerCapture(e.pointerId);
        } catch { /* (not a pointer the browser has: moves still come) */ }
        const [px, py] = at(e);
        if (inpainting?.down(px, py, e) || backgroundPointer?.down(px, py, e) || drawing?.down(px, py, e) || placing?.down(px, py) || cropper?.down(px, py)) return;
        drag = { px, py, x, y };
    });
    stage.addEventListener("pointermove", (e) => {
        const [px, py] = at(e);
        if (inpainting?.move(px, py) || backgroundPointer?.move(px, py) || drawing?.move(px, py) || placing?.move(px, py) || cropper?.move(px, py)) return;
        if (!drag) return;
        x = drag.x + px - drag.px;
        y = drag.y + py - drag.py;
        fitting = false;
        place();
    });
    const endDrag = (e) => {
        const [px, py] = at(e), cancelled = e.type === "pointercancel";
        cropper?.up(cancelled);
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

    // Editable, a picture that stays still, and isn't too big for a canvas:
    // saved over the file if it's a format canvases write; else as a copy.
    view.editable = !moving && type !== "image/svg+xml" && width * height <= MAX_EDIT_PIXELS && width <= MAX_SIDE && height <= MAX_SIDE;
    view.stop = () => { viewStopped = true; if (metadataURL) URL.revokeObjectURL(metadataURL); if (shownURL) URL.revokeObjectURL(shownURL); exifDialog?.close(); resized.disconnect(); window.removeEventListener("resize", relayout); };
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
            source = await createImageBitmap(pixels(), { imageOrientation: "from-image" });
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
        // The editing tools, which is open: one at most, each opened only
        // while no other is (otherOpen, but its own, which its button
        // closes; background removal and inpainting take each other's
        // place). Saving, or the view stopped, are asked as well.
        const toolsOpen = () => ({ crop: !!cropper?.active(), resize: !!resizing?.active(), background: !!backgroundEdit, inpaint: !!inpainting?.active(),
            draw: !!drawing?.active(), place: !!placing?.active(), scan: !!scanning?.active() });
        const otherOpen = (...mine) => Object.entries(toolsOpen()).some(([tool, open]) => open && !mine.includes(tool));
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
        // Quality: the picture's own, to start (written again at it, it
        // loses no more than it must, nor grows for nothing: savingQuality).
        let own = savingQuality(bytes, type);
        const quality = el("input", { type: "range", className: "image-quality", min: "10", max: "100", step: "1", value: String(own) });
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
            keep: keep.checked, edited: ops.length > 0, dirty: dirty(), name: file.name, own });
        const showOptions = () => {
            const target = format.value, same = target === type;
            qualityLabel.hidden = target === "image/png";
            qualityText.textContent = `${quality.value}%${same && Number(quality.value) === own && type !== "image/png" ? " (as it was)" : ""}`;
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
            if (saving || stopped || otherOpen()) return;
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
        cropper = cropTool({ toolbar: editBar, stage, button: cropButton, box: cropBox, makeButton: button,
            geometry: () => ({ width, height, x, y, scale }), source: () => content,
            canOpen: () => !saving && !otherOpen("crop"), say,
            apply: (rect) => change(rect),
            changed: () => showButtons(),
        });
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
        // Background removal (image-background-tool.js), reading the editor's state as it goes.
        const { removeBackground, backgroundPanel, backgroundSettings, sliders, brushCursor, brushes, magicBox, segmenter, selectionBox, spatialApply, spatialHint, spatialBar, showSpatial, outsideBackground, positionBackground, closeBackground } = backgroundTool({
            get backgroundEdit() { return backgroundEdit; }, set backgroundEdit(v) { backgroundEdit = v; },
            get backgroundFrame() { return backgroundFrame; }, set backgroundFrame(v) { backgroundFrame = v; },
            get backgroundPointer() { return backgroundPointer; }, set backgroundPointer(v) { backgroundPointer = v; },
            get backgroundPreview() { return backgroundPreview; }, set backgroundPreview(v) { backgroundPreview = v; },
            get maskSerial() { return maskSerial; }, set maskSerial(v) { maskSerial = v; },
            get removing() { return removing; }, set removing(v) { removing = v; },
            get bar() { return bar; }, get button() { return button; }, get content() { return content; }, get cropper() { return cropper; },
            get editBar() { return editBar; }, get format() { return format; }, get height() { return height; }, get hintBar() { return hintBar; },
            get inpainting() { return inpainting; }, get ops() { return ops; }, get otherOpen() { return otherOpen; },
            get redraw() { return redraw; }, get remember() { return remember; }, get remover() { return remover; },
            get resizing() { return resizing; }, get saving() { return saving; }, get say() { return say; }, get scale() { return scale; },
            get showButtons() { return showButtons; }, get showOptions() { return showOptions; }, get stage() { return stage; },
            get stopped() { return stopped; }, get toolScope() { return toolScope; }, get view() { return view; }, get width() { return width; },
            get x() { return x; }, get y() { return y; },
        });
        resizing = resizeTool({ toolbar: editBar, button: resizeButton, geometry: () => ({ width, height }), maxSide: MAX_SIDE, maxPixels,
            canOpen: () => !saving && !otherOpen("resize"),
            apply: (size) => change({ resize: size }),
            changed: () => showButtons(),
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
        const toolOpen = () => saving || stopped || otherOpen();
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
            const choosing = masking || otherOpen("background", "inpaint");
            defaultTools.hidden = choosing;
            hintBar.hidden = !masking && !scanning?.active();
            if (choosing) { options.hidePopover(); syncSaveOptions(); }
            for (const control of [rotateLeft, rotateRight, flipH, flipV, cropButton, resizeButton, drawButton, placeButton, scanButton, format, quality, keep, saveOptionsButton, saveOptionsArrow]) control.disabled = saving || choosing;
            removeBackground.disabled = inpaintButton.disabled = saving || otherOpen("background", "inpaint");
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
            cropper?.sync({ saving, removing });
            // Lay out toolbar changes before another pointer event can arrive.
            if (fitting) fit(); else place();
            changed();
        }
        inpainting = inpaintTool({ toolbar: editBar, hints: hintBar, stage, button: inpaintButton,
            geometry: () => ({ width, height, x, y, scale }), source: () => content,
            preview: (patch) => { inpaintPreview = patch ? [...ops, { inpaint: patch, serial: maskSerial + 1 }] : null; redraw(false); },
            apply: (patch, recipe) => { remember(); ops.push({ inpaint: patch, recipe, serial: ++maskSerial }); redraw(false); say("Inpainting applied. Undo to restore it."); },
            changed: showButtons,
        });
        inpaintButton.addEventListener("click", () => {
            if (saving || stopped || otherOpen("background", "inpaint")) return;
            closeBackground(false, false);
            cropper.close(); resizing.close();
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
            if (saving || stopped || otherOpen("place")) return;  // (scanning too: it was let through)
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
            if (saving || stopped || otherOpen("draw")) return;
            if (drawing.active()) drawing.close(); else drawing.open();
        };
        drawButton.addEventListener("click", openDrawing);
        scanning = scanTool({ toolbar: editBar, hints: hintBar, stage, button: scanButton,
            geometry: () => ({ width, height, x, y, scale }), source: () => content,
            apply: (op) => { change(op); say("Document scanned. Undo to restore the photo."); }, changed: () => showButtons(),
        });
        scanButton.addEventListener("click", () => {
            if (saving || stopped || otherOpen("scan")) return;
            try { scanning.open(); } catch (err) { say(err.message, true); }
        });
        rotateLeft.addEventListener("click", () => change("left"));
        rotateRight.addEventListener("click", () => change("right"));
        flipH.addEventListener("click", () => change("h"));
        flipV.addEventListener("click", () => change("v"));
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
            if (cropper.active() || resizing.active()) {
                if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (cropper.active()) cropper.close(); else resizing.close(); }
                else if (cropper.active() && e.key === "Enter") { e.preventDefault(); e.stopPropagation(); cropper.commit(); }
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
                c: () => cropper.toggle(), s: () => resizing.toggle(), d: openDrawing,
                Escape: () => cropper.active() && cropper.close(), Enter: () => cropper.active() && cropper.commit() }[e.key.length === 1 ? e.key.toLowerCase() : e.key];
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
            pending: () => otherOpen(),
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
                } else if (cropper?.active()) {
                    pending = cropper.recipe();
                    if (!pending) return null;
                } else if (resizing?.active()) {
                    pending = resizing.recipe();
                    if (!pending) return null;
                }
                return editRecipe(...sourceSize, ops, pending);
            },
            snapshot: async ({ beforeTool = false } = {}) => {
                if (stopped) throw new Error("This image editor is closed.");
                if (width * height > maxPixels) throw new Error("The edited page exceeds the pixel limit.");
                if (!beforeTool && otherOpen()) throw new Error("Apply or cancel the current tool first.");
                const canvas = beforeTool ? transform(source, sourceSize[0], sourceSize[1], ops).canvas : content;
                const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
                if (beforeTool) canvas.width = canvas.height = 0;
                if (!blob) throw new Error("The edited page couldn't be encoded.");
                return blob;
            },
            saving: () => saving,
            // (A format that can't be written over: its copy can be, unchanged.)
            canSave: () => !saving && !otherOpen() && (intent().how !== null || !WRITABLE.has(type) && !copied),
            save: async () => {
                const it = intent();
                const how = it.how ?? (!WRITABLE.has(type) && !copied ? "copy" : null);
                if (saving || stopped || otherOpen() || !how) return;
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
                        own = savingQuality(bytes, type);
                        quality.value = String(own);
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
                cropper?.stop();
                cropper = null;
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
