// Flood fill, as a paint bucket does: from each point clicked, the pixels
// joined to it (side by side, not only corner to corner) whose colour is
// within a tolerance of its colour, filled with one colour; within a
// selection (a rectangle or circle), if there's one. What's filled is a
// step ({fill}): replayed by transform, against the colours of the picture
// as it is by then, and as a recipe's "fill" step, on other pages too.

export const MAX_FILL_POINTS = 100;
const COLOR = /^#[0-9a-f]{6}$/i;

// validFill is fill ({points, color, tolerance, selection}) if it can be
// done, else it throws: a recipe's may come from elsewhere.
export function validFill(fill) {
    const bad = () => { throw new Error("Not a fill that can be done."); };
    const points = fill?.points, s = fill?.selection;
    if (!Array.isArray(points) || !points.length || points.length > MAX_FILL_POINTS ||
        !points.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))) bad();
    if (!COLOR.test(fill.color ?? "") || !(Number.isFinite(fill.tolerance) && fill.tolerance >= 0 && fill.tolerance <= 100)) bad();
    if (s != null && (!["rect", "circle"].includes(s.shape) || ![s.x, s.y, s.width, s.height].every(Number.isFinite) || s.width < 0 || s.height < 0
        || s.inverted != null && typeof s.inverted !== "boolean")) bad();
    return fill;
}

// inSelection is whether the pixel at x, y (its centre) is in selection
// (none: everywhere).
export function inSelection(selection) {
    if (!selection) return () => true;
    const { shape, x, y, width, height } = selection;
    if (shape === "circle") {
        const rx = width / 2, ry = height / 2, cx = x + rx, cy = y + ry;
        if (rx <= 0 || ry <= 0) return () => !!selection.inverted;
        return (px, py) => (((px + 0.5 - cx) / rx) ** 2 + ((py + 0.5 - cy) / ry) ** 2 <= 1) !== !!selection.inverted;
    }
    return (px, py) => (px + 0.5 >= x && px + 0.5 < x + width && py + 0.5 >= y && py + 0.5 < y + height) !== !!selection.inverted;
}

const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

// floodFill fills data (RGBA pixels, width × height) as fill says, from
// each of its points in turn, and is how many pixels it filled. A colour's
// within tolerance (a share of 100) of another if each of its channels,
// alpha too, is. What's filled is made opaque.
export function floodFill(data, width, height, fill) {
    const { points, color, tolerance, selection } = validFill(fill);
    const limit = Math.round(tolerance / 100 * 255), inside = inSelection(selection);
    const [fr, fg, fb] = rgbOf(color);
    const seen = new Uint8Array(width * height);
    let filled = 0;
    for (const [fx, fy] of points) {
        const sx = Math.floor(fx), sy = Math.floor(fy);
        if (sx < 0 || sy < 0 || sx >= width || sy >= height || !inside(sx, sy)) continue;
        seen.fill(0);
        const at = (sy * width + sx) * 4;
        const tr = data[at], tg = data[at + 1], tb = data[at + 2], ta = data[at + 3];
        const ok = (x, y) => {
            const p = y * width + x, i = p * 4;
            return !seen[p] && Math.abs(data[i] - tr) <= limit && Math.abs(data[i + 1] - tg) <= limit &&
                Math.abs(data[i + 2] - tb) <= limit && Math.abs(data[i + 3] - ta) <= limit && inside(x, y);
        };
        // A row's run at a time, and the runs above and below it next.
        const stack = [sx, sy];
        while (stack.length) {
            const y = stack.pop(), x = stack.pop();
            if (!ok(x, y)) continue;
            let left = x, right = x;
            while (left > 0 && ok(left - 1, y)) left--;
            while (right < width - 1 && ok(right + 1, y)) right++;
            for (let px = left; px <= right; px++) {
                const p = y * width + px, i = p * 4;
                seen[p] = 1;
                data[i] = fr; data[i + 1] = fg; data[i + 2] = fb; data[i + 3] = 255;
                filled++;
            }
            for (const ny of [y - 1, y + 1]) {
                if (ny < 0 || ny >= height) continue;
                let run = false;
                for (let px = left; px <= right; px++) {
                    if (ok(px, ny)) {
                        if (!run) { stack.push(px, ny); run = true; }
                    } else run = false;
                }
            }
        }
    }
    return filled;
}

// drawFill does fill on ctx's canvas, width × height.
export function drawFill(ctx, fill, width, height) {
    const image = ctx.getImageData(0, 0, width, height);
    if (floodFill(image.data, width, height, fill)) ctx.putImageData(image, 0, 0);
}
