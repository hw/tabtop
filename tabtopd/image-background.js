import { drawMaskMarks } from "./image-mask.js";
import { samSize } from "./image-segment.js";
export { brushPath } from "./image-mask.js";

// needsFound is whether objects (marks picked with magic select) edit
// U2NetP's cutout, rather than starting afresh ("keep all objects" does).
export const needsFound = (objects) => !objects?.some((o) => o.only);

// objectMask is the cutout as objects picked with magic select (marks over
// a width × height picture) leave it: found (U2NetP's), then each in turn,
// removing an object (erase) or adding it back; one marked only clears
// what's kept before it. It's at most 1024 pixels across, as the
// selections were made at, and scaled up as U2NetP's is.
export function objectMask(objects, width, height, found = null) {
    const size = samSize(width, height);
    const canvas = Object.assign(document.createElement("canvas"), { width: size.width, height: size.height });
    const ctx = canvas.getContext("2d");
    if (found) ctx.drawImage(found, 0, 0, size.width, size.height);
    ctx.scale(size.width / width, size.height / height);
    for (const mark of objects) {
        if (mark.only) { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, size.width, size.height); ctx.restore(); }
        drawMaskMarks(ctx, [mark]);
    }
    return canvas;
}

// Adjust the original soft mask, rather than repeatedly processing a previous
// adjustment. Grow/shrink uses a separable max/min filter; its radius is a
// percentage of mask size, so the control scales with the picture.
export function adjustAlpha(alpha, width, height, { threshold = 50, softness = 100, grow = 0 } = {}) {
    const out = new Uint8ClampedArray(alpha.length);
    const edge = threshold / 100, span = softness / 100;
    for (let i = 0; i < alpha.length; i++) {
        const value = alpha[i] / 255;
        out[i] = span === 0 ? (value >= edge ? 255 : 0) : Math.round(Math.max(0, Math.min(1, (value - edge) / span + .5)) * 255);
    }
    if (!grow) return out;
    const rx = Math.round(Math.abs(grow) * width / 100), ry = Math.round(Math.abs(grow) * height / 100);
    const horizontal = new Uint8ClampedArray(out.length), result = new Uint8ClampedArray(out.length);
    const combine = grow > 0 ? Math.max : Math.min;
    const initial = grow > 0 ? 0 : 255;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        let value = initial;
        for (let xx = Math.max(0, x - rx); xx <= Math.min(width - 1, x + rx); xx++) value = combine(value, out[y * width + xx]);
        horizontal[y * width + x] = value;
    }
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        let value = initial;
        for (let yy = Math.max(0, y - ry); yy <= Math.min(height - 1, y + ry); yy++) value = combine(value, horizontal[yy * width + x]);
        result[y * width + x] = value;
    }
    return result;
}

export function adjustedMask(mask, settings) {
    const { width, height } = mask;
    const original = mask.getContext("2d").getImageData(0, 0, width, height);
    const alpha = new Uint8ClampedArray(width * height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = original.data[i * 4 + 3];
    const adjusted = adjustAlpha(alpha, width, height, settings);
    for (let i = 0; i < alpha.length; i++) original.data[i * 4 + 3] = adjusted[i];
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").putImageData(original, 0, 0);
    return canvas;
}

// Map between the mask's image coordinates and the current edit, including
// crops/resizes/quarter turns made after background removal. Boundaries use
// continuous pixel coordinates, so this also maps selection rectangles.
export function mapImagePoint(point, width, height, ops, inverse = false) {
    const steps = ops.map((op) => {
        const step = { op, width, height };
        if (op.resize) [width, height] = op.resize;
        else if (op === "left" || op === "right") [width, height] = [height, width];
        else if (typeof op === "object" && !op.background && !op.inpaint) { width = op.width; height = op.height; }
        return step;
    });
    let [x, y] = point;
    for (const { op, width: w, height: h } of inverse ? steps.reverse() : steps) {
        if (op.background || op.inpaint) continue;
        if (op.resize) {
            x *= inverse ? w / op.resize[0] : op.resize[0] / w;
            y *= inverse ? h / op.resize[1] : op.resize[1] / h;
        } else if (op === "right") [x, y] = inverse ? [y, h - x] : [h - y, x];
        else if (op === "left") [x, y] = inverse ? [w - y, x] : [y, w - x];
        else if (op === "h") x = w - x;
        else if (op === "v") y = h - y;
        else { x += (inverse ? 1 : -1) * op.x; y += (inverse ? 1 : -1) * op.y; }
    }
    return [x, y];
}

// One worker per editor, reused until it's closed. Termination cancels both
// model loading and inference, including when the preview is left mid-flight.
export class BackgroundRemover {
    worker = null;
    pending = null;

    remove(source) {
        if (this.pending) return Promise.reject(new Error("Background removal is already running"));
        const sample = document.createElement("canvas");
        sample.width = sample.height = 320;
        const ctx = sample.getContext("2d", { willReadFrequently: true });
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(source, 0, 0, 320, 320);
        const rgba = ctx.getImageData(0, 0, 320, 320).data;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => this.cancel("Background removal took too long. Try again."), 120000);
            this.pending = { resolve, reject, timer };
            try {
                if (!this.worker) {
                    this.worker = new Worker(new URL("./image-background-worker.js", import.meta.url));
                }
                this.worker.onmessage = ({ data }) => {
                    if (data.error) { this.cancel(`Background removal failed: ${data.error}`); return; }
                    if (!(data.alpha instanceof Uint8ClampedArray) || data.alpha.length !== 320 * 320) {
                        this.cancel("Background removal returned an invalid mask.");
                        return;
                    }
                    const pixels = ctx.createImageData(320, 320);
                    for (let i = 0; i < data.alpha.length; i++) pixels.data[i * 4 + 3] = data.alpha[i];
                    ctx.putImageData(pixels, 0, 0);
                    const pending = this.pending;
                    this.pending = null;
                    clearTimeout(pending.timer);
                    pending.resolve(sample);
                };
                this.worker.onerror = (event) => {
                    event.preventDefault();
                    this.cancel("Background removal couldn't load. Try again.");
                };
                this.worker.onmessageerror = () => this.cancel("Background removal returned an unreadable result.");
                this.worker.postMessage({ rgba }, [rgba.buffer]);
            } catch (err) {
                this.cancel(err.message);
            }
        });
    }

    cancel(message = "Background removal cancelled.") {
        this.worker?.terminate();
        this.worker = null;
        if (this.pending) {
            clearTimeout(this.pending.timer);
            this.pending.reject(new Error(message));
            this.pending = null;
        }
    }
}
