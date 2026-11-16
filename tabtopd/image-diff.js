// Pixel comparisons use visible (premultiplied) RGB and alpha. Hidden RGB in
// fully transparent pixels is irrelevant; differences in alpha remain visible.
export const MAX_IMAGE_DIFF_BYTES = 50_000_000;
export const MAX_IMAGE_DIFF_PIXELS = 16_000_000;
export const MAX_IMAGE_DIFF_SIDE = 8192;

export function imageDiffGeometry(aWidth, aHeight, bWidth, bHeight) {
    for (const side of [aWidth, aHeight, bWidth, bHeight]) {
        if (!Number.isSafeInteger(side) || side < 1 || side > MAX_IMAGE_DIFF_SIDE) throw new Error("Images must be between 1 and 8,192 pixels on each side.");
    }
    const width = Math.max(aWidth, bWidth), height = Math.max(aHeight, bHeight);
    if (width * height > MAX_IMAGE_DIFF_PIXELS) throw new Error("The comparison canvas must be at most 16 megapixels. Images are never resized for comparison.");
    const pixels = aWidth * aHeight + bWidth * bHeight - Math.min(aWidth, bWidth) * Math.min(aHeight, bHeight);
    return { width, height, pixels };
}

// Each input is a horizontal RGBA strip on the common canvas. The separate
// source bounds distinguish absent pixels from pixels that are transparent.
export function imageDelta(a, b, { aWidth, aHeight, bWidth, bHeight, startY = 0 }) {
    const { width, height } = imageDiffGeometry(aWidth, aHeight, bWidth, bHeight);
    const rows = a.length / (width * 4);
    if (!(a instanceof Uint8ClampedArray) || !(b instanceof Uint8ClampedArray) || b.length !== a.length ||
        !Number.isSafeInteger(rows) || rows < 1 || !Number.isSafeInteger(startY) || startY < 0 || startY + rows > height) throw new Error("Invalid image comparison pixels.");
    const data = new Uint8ClampedArray(a.length);
    let changed = 0, maxDelta = 0;
    for (let y = 0, i = 0; y < rows; y++) for (let x = 0; x < width; x++, i += 4) {
        const inA = x < aWidth && startY + y < aHeight;
        const inB = x < bWidth && startY + y < bHeight;
        data[i + 3] = 255;
        if (inA !== inB) { data[i] = 255; data[i + 2] = 255; changed++; maxDelta = 255; continue; }
        if (!inA) continue;
        const alpha = Math.abs(a[i + 3] - b[i + 3]);
        let delta = alpha;
        for (let c = 0; c < 3; c++) {
            const difference = Math.abs(a[i + c] * a[i + 3] - b[i + c] * b[i + 3]) / 255;
            data[i + c] = Math.ceil(Math.max(alpha, difference));
            delta = Math.max(delta, difference);
        }
        if (delta > 0) changed++;
        maxDelta = Math.max(maxDelta, Math.ceil(delta));
    }
    return { data, changed, maxDelta };
}

// Convert opaque delta pixels into transparent highlights without changing
// the exact delta canvas or its differing-pixel count.
export function imageDeltaOverlay(delta) {
    const overlay = new Uint8ClampedArray(delta.length);
    for (let i = 0; i < delta.length; i += 4) {
        const changed = delta[i] || delta[i + 1] || delta[i + 2];
        if (!changed) continue;
        const missing = delta[i] === 255 && delta[i + 1] === 0 && delta[i + 2] === 255;
        overlay[i] = 255; overlay[i + 1] = missing ? 0 : 80; overlay[i + 2] = missing ? 255 : 0;
        overlay[i + 3] = 255;
    }
    return overlay;
}
