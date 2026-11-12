// Shared batch operations use the same masks and local models as image editing.
import { Inpainter, inpaintPatch } from "./image-inpaint.js";
import { BackgroundRemover, adjustedMask, objectMask, needsFound } from "./image-background.js";
import { transform } from "./image-view.js";
import { validShape } from "./image-draw.js";
import { validPlacement } from "./image-place.js";
import { validFill } from "./image-fill.js";
import { scanGeometry } from "./image-scan.js";

export const MAX_BATCH_PAGES = 200, MAX_BATCH_BYTES = 256 * 1024 * 1024;
export function pageRange(text, count) {
    const pages = new Set();
    for (const part of text.split(",")) {
        const match = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
        if (!match) throw new Error("Use page numbers or ranges, such as 1-3, 5.");
        const first = Number(match[1]), last = Number(match[2] ?? match[1]);
        if (first < 1 || last < first || last > count || !Number.isSafeInteger(last)) throw new Error(`Choose pages from 1 to ${count}, in ascending ranges.`);
        if (last - first >= MAX_BATCH_PAGES) throw new Error(`Choose at most ${MAX_BATCH_PAGES} pages at a time.`);
        for (let n = first; n <= last; n++) {
            pages.add(n);
            if (pages.size > MAX_BATCH_PAGES) throw new Error(`Choose at most ${MAX_BATCH_PAGES} pages at a time.`);
        }
    }
    return [...pages].sort((a,b) => a-b);
}

// Transform whole marks, including filled spans and brush radii, so the same
// normalized region is used on pages with different sizes or aspect ratios.
export function scaleRecipe(recipe, width, height) {
    if (!(recipe.width > 0 && recipe.height > 0 && width > 0 && height > 0)) throw new Error("Invalid mask dimensions.");
    const sx = width / recipe.width, sy = height / recipe.height;
    const scale = mark => ({ ...structuredClone(mark), scale: [(mark.scale?.[0] ?? 1) * sx, (mark.scale?.[1] ?? 1) * sy] });
    const out = { ...recipe, width, height };
    if (recipe.kind === "scan") {
        const fit = ([x, y]) => [x * sx, y * sy];
        out.settings = { ...recipe.settings, corners: recipe.settings.corners.map(fit) };
        if (recipe.settings.folds) out.settings.folds = recipe.settings.folds.map(f => f.map(fit));
        if (recipe.settings.curves) out.settings.curves = recipe.settings.curves.map(p => p ? fit(p) : null);
        scanGeometry(width, height, out.settings);
    } else if (recipe.kind === "inpaint") out.marks = recipe.marks.map(scale);
    else if (recipe.kind === "background") {
        out.strokes = (recipe.strokes ?? []).map(scale);
        if (recipe.objects?.length) out.objects = recipe.objects.map(scale);
        out.selection = recipe.selection ? { ...recipe.selection, x: recipe.selection.x * sx, y: recipe.selection.y * sy,
            width: recipe.selection.width * sx, height: recipe.selection.height * sy } : null;
    } else if (recipe.kind === "crop") {
        const left = Math.max(0, Math.min(width - 1, Math.round(recipe.rect.x * sx)));
        const top = Math.max(0, Math.min(height - 1, Math.round(recipe.rect.y * sy)));
        const right = Math.max(left + 1, Math.min(width, Math.round((recipe.rect.x + recipe.rect.width) * sx)));
        const bottom = Math.max(top + 1, Math.min(height, Math.round((recipe.rect.y + recipe.rect.height) * sy)));
        out.rect = { x: left, y: top, width: right - left, height: bottom - top };
    } else if (recipe.kind === "fill") {
        // The same share of the page; its colours there are its own.
        out.points = recipe.points.map(([x, y]) => [x * sx, y * sy]);
        if (recipe.selection) out.selection = { ...recipe.selection, x: recipe.selection.x * sx, y: recipe.selection.y * sy,
            width: recipe.selection.width * sx, height: recipe.selection.height * sy };
    } else if (recipe.kind === "paste") {
        out.rect = { x: recipe.rect.x * sx, y: recipe.rect.y * sy, width: recipe.rect.width * sx, height: recipe.rect.height * sy };
    } else if (recipe.kind === "draw") {
        // The same share of the page; an outline as thick, for its size.
        if (recipe.rect) out.rect = { x: recipe.rect.x * sx, y: recipe.rect.y * sy, width: recipe.rect.width * sx, height: recipe.rect.height * sy };
        if (recipe.strokes) out.strokes = recipe.strokes.map((s) => s.map((v, i) => v * (i % 2 ? sy : sx)));
        if (Number.isFinite(recipe.line)) out.line = Math.max(1, recipe.line * Math.sqrt(sx * sy));
    } else if (recipe.kind === "resize") out.size = [Math.max(1, Math.round(recipe.size[0] * sx)), Math.max(1, Math.round(recipe.size[1] * sy))];
    else if (recipe.kind !== "transform" || !["left", "right", "h", "v"].includes(recipe.operation)) throw new Error("Unknown image operation.");
    return out;
}

// describeStep is a step of a recipe (see editRecipe) in words, for the
// operations list: its geometry relative to the page it was made on, as
// it's applied to other pages.
export function describeStep(step) {
    const percent = (part, whole) => `${Math.round(part / whole * 100)}%`;
    switch (step?.kind) {
    case "scan":
        return "Scan document";
    case "transform":
        return { left: "Rotate left", right: "Rotate right", h: "Flip horizontally", v: "Flip vertically" }[step.operation] ?? "Transform";
    case "crop":
        return `Crop to ${percent(step.rect.width, step.width)} × ${percent(step.rect.height, step.height)}`;
    case "resize": {
        const x = percent(step.size[0], step.width), y = percent(step.size[1], step.height);
        return x === y ? `Resize to ${x}` : `Resize to ${x} × ${y}`;
    }
    case "inpaint": {
        const n = step.marks?.length ?? 0;
        return `Inpaint ${n} ${n === 1 ? "mark" : "marks"}`;
    }
    case "background": {
        const n = step.objects?.filter(o => !o.erase).length ?? 0;
        return n ? `Remove background, keeping ${n} ${n === 1 ? "object" : "objects"}` : "Remove background";
    }
    case "fill": {
        const n = step.points?.length ?? 0;
        const within = { circle: "a circle", object: "an object" }[step.selection?.shape] ?? "a rectangle";
        return `Fill ${n} ${n === 1 ? "area" : "areas"} ${step.color}${step.selection ? ` within ${within}` : ""}`;
    }
    case "paste":
        return `Place a picture over ${percent(step.rect.width, step.width)} × ${percent(step.rect.height, step.height)}`;
    case "draw": {
        if (step.shape === "pen") {
            const n = step.strokes?.length ?? 0;
            return `${step.mode === "highlight" ? "Highlight" : "Pen"} ${n} ${n === 1 ? "stroke" : "strokes"} ${step.color}`;
        }
        const how = { outline: "Outline", highlight: "Highlight" }[step.mode] ?? "Fill";
        return `${how} ${step.shape === "circle" ? "circle" : "rectangle"} ${step.color}`;
    }
    }
    return "Edit";
}

// stepsFor is the steps of operations ([{step, done}], done a Set of the
// pages that have it) that page n hasn't had yet, in order.
export function stepsFor(operations, n) {
    return operations.filter(op => !op.done.has(n)).map(op => op.step);
}

// pageList is pages (numbers) as a short list: "1–3, 5".
export function pageList(pages) {
    const sorted = [...pages].sort((a, b) => a - b), parts = [];
    for (let i = 0; i < sorted.length;) {
        let j = i;
        while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
        parts.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]));
        i = j + 1;
    }
    return parts.join(", ");
}

export function pngBlob(canvas) {
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("The page couldn't be encoded.")), "image/png"));
}

export function batchProcessor() {
    const painter = new Inpainter(), background = new BackgroundRemover();
    const cancel = () => { painter.cancel(); background.cancel(); };
    return { cancel, async apply(blob, recipe, signal) {
        signal.throwIfAborted();
        const image = await createImageBitmap(blob);
        let current = image;
        const pasted = []; // pictures placed, closed once done
        signal.addEventListener("abort", cancel, { once: true });
        try {
            signal.throwIfAborted();
            if (image.width * image.height > 16e6) throw new Error("The page exceeds 16 megapixels. Choose a lower resolution.");
            for (const step of recipe.kind === "sequence" ? recipe.steps : [recipe]) {
                signal.throwIfAborted();
                const scaled = scaleRecipe(step, current.width, current.height);
                let op;
                if (scaled.kind === "scan") op = { scan: scaled.settings };
                else if (scaled.kind === "inpaint") op = { inpaint: await inpaintPatch(current, scaled.marks, painter) };
                else if (scaled.kind === "background") {
                    // Objects picked with magic select are kept where they were; else U2NetP finds the foreground.
                    // (Objects removed and added back: to and from what U2NetP finds there.)
                    const found = needsFound(scaled.objects) ? await background.remove(current) : null;
                    const mask = scaled.objects?.length ? objectMask(scaled.objects, current.width, current.height, found) : found;
                    op = { background: adjustedMask(mask, scaled.settings), selection: scaled.selection, strokes: scaled.strokes };
                }
                else if (scaled.kind === "crop") op = scaled.rect;
                else if (scaled.kind === "fill") op = { fill: validFill({ points: scaled.points, color: scaled.color, tolerance: scaled.tolerance, selection: scaled.selection ?? null }) };
                else if (scaled.kind === "paste") {
                    if (!(scaled.blob instanceof Blob)) throw new Error("The placed picture is missing.");
                    const placed = await createImageBitmap(scaled.blob, { imageOrientation: "from-image" });
                    pasted.push(placed);
                    op = { paste: { ...validPlacement({ rect: scaled.rect, opacity: scaled.opacity }), image: placed } };
                }
                else if (scaled.kind === "draw") {
                    const { kind: _, width: __, height: ___, ...draw } = scaled;
                    op = { draw: validShape(draw) };
                }
                else if (scaled.kind === "resize") {
                    if (scaled.size[0] * scaled.size[1] > 16e6 || Math.max(...scaled.size) > 16384) throw new Error("The resized page exceeds the batch pixel limit.");
                    op = { resize: scaled.size };
                } else op = scaled.operation;
                signal.throwIfAborted();
                const canvas = transform(current, current.width, current.height, [op]).canvas;
                if (current !== image) current.width = current.height = 0;
                current = canvas;
            }
            const canvas = current === image ? transform(image, image.width, image.height, []).canvas : current;
            const result = await pngBlob(canvas);
            if (current === image) canvas.width = canvas.height = 0;
            signal.throwIfAborted();
            return result;
        } finally {
            if (current !== image) current.width = current.height = 0;
            image.close(); for (const placed of pasted) placed.close();
            signal.removeEventListener("abort", cancel);
        }
    } };
}
