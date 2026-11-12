// Magic select: MobileSAM finds the object at a click, or in a box, and
// it's marked as a mask would be. The picture is analysed once (its longest
// side made 1024 pixels, as the model wants), in a worker; each click is
// then quick. What's selected becomes a fill mark (rows of pixels) at that
// size, scaled to the picture, so the overlay, undo and PDF batches treat it
// as any other mark.

export const SAM_SIDE = 1024;
const TIMEOUT = 180000;

// samSize is the size the picture's analysed at: its longest side 1024
// pixels, larger or smaller, in proportion.
export function samSize(width, height) {
    if (!(width > 0 && height > 0)) throw new Error("There's no picture to select in.");
    const scale = SAM_SIDE / Math.max(width, height);
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
}

// samPrompt is the decoder's points and their labels, for a click at point
// (1: in the object) or a box ([x, y, width, height]: 2 and 3, its corners),
// in the picture's pixels, made the analysed size's. A click is followed by
// a padding point (-1), as the model was exported to expect without a box.
export function samPrompt({ point, box }, scale) {
    const at = ([x, y]) => [x * scale, y * scale];
    if (box) {
        const [x, y, w, h] = box;
        return { coords: Float32Array.from([...at([x, y]), ...at([x + w, y + h])]), labels: Float32Array.from([2, 3]) };
    }
    if (!point) throw new Error("Click an object, or drag a box round it.");
    return { coords: Float32Array.from([...at(point), 0, 0]), labels: Float32Array.from([1, -1]) };
}

// grow widens mask (1 where selected, width × height) by radius pixels each
// way: what's removed then takes in the object's edge, which the model's
// outline hugs.
export function grow(mask, width, height, radius) {
    if (radius < 1) return mask;
    const across = new Uint8Array(mask.length), out = new Uint8Array(mask.length);
    for (let y = 0; y < height; y++) {
        let last = -Infinity;
        for (let x = 0; x < width; x++) { if (mask[y * width + x]) last = x; if (x - last <= radius) across[y * width + x] = 1; }
        last = Infinity;
        for (let x = width - 1; x >= 0; x--) { if (mask[y * width + x]) last = x; if (last - x <= radius) across[y * width + x] = 1; }
    }
    for (let x = 0; x < width; x++) {
        let last = -Infinity;
        for (let y = 0; y < height; y++) { if (across[y * width + x]) last = y; if (y - last <= radius) out[y * width + x] = 1; }
        last = Infinity;
        for (let y = height - 1; y >= 0; y--) { if (across[y * width + x]) last = y; if (last - y <= radius) out[y * width + x] = 1; }
    }
    return out;
}

// selectionMark is mask (1 where selected, at the analysed size) as a fill
// mark over the picture (pictureWidth × pictureHeight), or null if nothing's
// selected. Erasing, it takes the object out of what's marked.
export function selectionMark(mask, width, height, pictureWidth, pictureHeight, erase = false) {
    if (mask.length !== width * height) throw new Error("Invalid selection mask.");
    const spans = [];
    let left = width, top = height, right = -1, bottom = -1;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (!mask[y * width + x]) continue;
            const start = x;
            while (x + 1 < width && mask[y * width + x + 1]) x++;
            spans.push([y, start, x]);
            left = Math.min(left, start); right = Math.max(right, x); top = Math.min(top, y); bottom = y;
        }
    }
    if (!spans.length) return null;
    return {
        fill: { x: 0, y: 0, spans, bounds: { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } },
        scale: [pictureWidth / width, pictureHeight / height], erase,
    };
}

// objectSelection is mask (1 where selected, at the analysed size) as the
// paint bucket's selection over the picture (pictureWidth × pictureHeight):
// its bounds there, and the object's rows of pixels within them, which
// scale with them; or null if nothing's selected.
export function objectSelection(mask, width, height, pictureWidth, pictureHeight) {
    const mark = selectionMark(mask, width, height, pictureWidth, pictureHeight);
    if (!mark) return null;
    const { bounds: b, spans } = mark.fill, [sx, sy] = mark.scale;
    return { shape: "object", x: b.x * sx, y: b.y * sy, width: b.width * sx, height: b.height * sy,
        mask: { width: b.width, height: b.height, spans: spans.map(([y, left, right]) => [y - b.y, left - b.x, right - b.x]) } };
}

// objectBounds is the smallest whole-pixel rectangle of the picture
// (pictureWidth × pictureHeight) holding what mask selects, or null.
export function objectBounds(mask, width, height, pictureWidth, pictureHeight) {
    const mark = selectionMark(mask, width, height, pictureWidth, pictureHeight);
    if (!mark) return null;
    const { bounds: b } = mark.fill, [sx, sy] = mark.scale;
    const left = Math.max(0, Math.floor(b.x * sx)), top = Math.max(0, Math.floor(b.y * sy));
    const right = Math.min(pictureWidth, Math.ceil((b.x + b.width) * sx)), bottom = Math.min(pictureHeight, Math.ceil((b.y + b.height) * sy));
    return { x: left, y: top, width: right - left, height: bottom - top };
}

// One worker per editor: it keeps the picture's analysis between clicks,
// until it's closed or given another picture.
export class Segmenter {
    worker = null;
    pending = null;
    size = null;

    #ask(message, transfer, check) {
        if (this.pending) return Promise.reject(new Error("Magic select is busy."));
        return new Promise((resolve, reject) => {
            this.pending = { resolve, reject, timer: setTimeout(() => this.cancel("Magic select took too long. Try again."), TIMEOUT) };
            try {
                this.worker ??= new Worker(new URL("./image-segment-worker.js", import.meta.url));
                this.worker.onmessage = ({ data }) => {
                    if (data.error) { this.cancel(`Magic select failed: ${data.error}`); return; }
                    const problem = check(data);
                    if (problem) { this.cancel(problem); return; }
                    const pending = this.pending;
                    this.pending = null;
                    clearTimeout(pending.timer);
                    pending.resolve(data);
                };
                this.worker.onerror = (event) => { event.preventDefault(); this.cancel("Magic select couldn't load. Try again."); };
                this.worker.onmessageerror = () => this.cancel("Magic select returned an unreadable result.");
                this.worker.postMessage(message, transfer);
            } catch (err) { this.cancel(err.message); }
        });
    }

    // analyse has the worker analyse source (a canvas or image).
    async analyse(source) {
        const size = samSize(source.width, source.height);
        const sample = Object.assign(document.createElement("canvas"), { width: size.width, height: size.height });
        const ctx = sample.getContext("2d", { willReadFrequently: true });
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(source, 0, 0, size.width, size.height);
        const rgba = ctx.getImageData(0, 0, size.width, size.height).data;
        this.size = null;
        await this.#ask({ encode: { rgba, width: size.width, height: size.height } }, [rgba.buffer], (data) => data.encoded ? "" : "Magic select couldn't analyse the picture.");
        this.size = size;
        return size;
    }

    // select is the mask (1 where selected, at the analysed size) for a
    // prompt: {point} or {box}, in the picture's pixels.
    async select(prompt) {
        if (!this.size) throw new Error("The picture hasn't been analysed yet.");
        const { width, height, scale } = this.size, { coords, labels } = samPrompt(prompt, scale);
        const data = await this.#ask({ decode: { coords, labels } }, [coords.buffer, labels.buffer],
            (d) => d.mask instanceof Uint8Array && d.mask.length === width * height ? "" : "Magic select returned an invalid mask.");
        return data.mask;
    }

    // findAll is every object found in the picture, all in one mask (1
    // where selected, at the analysed size), and how many there are.
    async findAll() {
        if (!this.size) throw new Error("The picture hasn't been analysed yet.");
        const { width, height } = this.size;
        const data = await this.#ask({ everything: true }, [],
            (d) => d.mask instanceof Uint8Array && d.mask.length === width * height && Number.isInteger(d.count) ? "" : "Magic select returned an invalid mask.");
        return { mask: data.mask, count: data.count };
    }

    cancel(message = "Magic select cancelled.") {
        this.worker?.terminate();
        this.worker = null;
        this.size = null;
        if (this.pending) {
            clearTimeout(this.pending.timer);
            this.pending.reject(new Error(message));
            this.pending = null;
        }
    }
}
