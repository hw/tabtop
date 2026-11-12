// Document rectification and paper cleanup. All geometry and tone changes
// operate on the original pixels; no text is recognized or regenerated.
import { el } from "./preview-dom.js";
import { choiceMenu } from "./image-mask.js";
import { iconSVG } from "./glyphs.js";

const MAX_PIXELS = 16e6, MAX_SIDE = 8192, MAX_FOLDS = 6;
const CURVE_STEPS = 64;
const FOLD_ERROR = "The curves fold over or squeeze the page too tightly. Reduce the bend or move the guides apart.";
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Whether corners go clockwise round a convex outline: crossed or concave
// ones would fold the projective transform.
function convex(p) {
    for (let i = 0; i < 4; i++) {
        const a = p[i], b = p[(i + 1) % 4], c = p[(i + 2) % 4];
        if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) <= .01) return false;
    }
    return true;
}

// The projective transform taking the unit square onto corners a, b, c, d.
function homography([a, b, c, d]) {
    const dx1 = b[0] - c[0], dx2 = d[0] - c[0], dx3 = a[0] - b[0] + c[0] - d[0];
    const dy1 = b[1] - c[1], dy2 = d[1] - c[1], dy3 = a[1] - b[1] + c[1] - d[1];
    const det = dx1 * dy2 - dx2 * dy1;
    const g = (dx3 * dy2 - dx2 * dy3) / det, k = (dx1 * dy3 - dx3 * dy1) / det;
    return [b[0] - a[0] + g * b[0], d[0] - a[0] + k * d[0], a[0],
        b[1] - a[1] + g * b[1], d[1] - a[1] + k * d[1], a[1], g, k];
}

// Undo the corners' perspective before interpreting the extra side points.
// In this coordinate system the page corners are (0,0), (1,0), (1,1), (0,1).
function unproject(m, [x, y]) {
    const a = m[0] - x * m[6], b = m[1] - x * m[7], c = x - m[2];
    const d = m[3] - y * m[6], e = m[4] - y * m[7], f = y - m[5], det = a * e - b * d;
    return [(c * e - b * f) / det, (a * f - c * d) / det];
}

// A continuous mesh in the rectified page, then the common camera mapping.
// Adjacent strips share the entire boundary's parameterization, not only its
// endpoints. Independent homographies disagree between those endpoints.
function mapPanel(part, u, v) {
    const m = part.matrix, offsets = part.offsets;
    if (offsets) {
        const t = (v - part.start) / (part.end - part.start);
        const du = (1 - t) * ((1 - u) * offsets[0][0] + u * offsets[1][0]) + t * ((1 - u) * offsets[3][0] + u * offsets[2][0]);
        const dv = (1 - t) * ((1 - u) * offsets[0][1] + u * offsets[1][1]) + t * ((1 - u) * offsets[3][1] + u * offsets[2][1]);
        u += du; v += dv;
    }
    const den = m[6] * u + m[7] * v + 1;
    return [(m[0] * u + m[1] * v + m[2]) / den, (m[3] * u + m[4] * v + m[5]) / den];
}

export function scanPoint(geometry, u, v) {
    const index = geometry.panels.findIndex(p => v < p.end), i = index < 0 ? geometry.panels.length - 1 : index;
    const part = geometry.panels[i];
    if (geometry.surface) return surfacePoint(part, surfaceProfile(geometry.surface, u)[i], u, v);
    return mapPanel(part, u, v);
}

function project(m, [u, v]) {
    const den = m[6] * u + m[7] * v + 1;
    return [(m[0] * u + m[1] * v + m[2]) / den, (m[3] * u + m[4] * v + m[5]) / den];
}

// Curve points are points on the guide, not off-page Bezier handles.
function curveAt(curve, t) {
    if (t === 0 || t === .5 || t === 1) return curve.points[t * 2];
    const i = t <= .5 ? 0 : 1, z = (t - i / 2) * 2;
    return [0, 1].map(k => {
        const a = curve.points[i][k], b = curve.points[i + 1][k];
        const ma = curve.tangents[k][i] / 2, mb = curve.tangents[k][i + 1] / 2;
        return ((2 * a - 2 * b + ma + mb) * z + (-3 * a + 3 * b - 2 * ma - mb)) * z * z + ma * z + a;
    });
}

function curveRow(left, right, middle, width, height, bounds) {
    const control = middle.map((v, k) => 2 * v - (left[k] + right[k]) / 2);
    if (control[0] <= left[0] || control[0] >= right[0]) throw new Error("Keep each guide's middle point between its side points.");
    const points = [left, middle, right], lengths = [0];
    const tangents = [0, 1].map(k => [2 * (control[k] - left[k]), right[k] - left[k], 2 * (right[k] - control[k])]);
    boundTangents([0, .5, 1], points, tangents, bounds);
    const curve = { points, lengths, tangents, straight: Math.abs(middle[0] - (left[0] + right[0]) / 2) < 1e-12 && Math.abs(middle[1] - (left[1] + right[1]) / 2) < 1e-12 };
    let previous = left;
    for (let i = 1; i <= CURVE_STEPS; i++) {
        const point = curveAt(curve, i / CURVE_STEPS);
        lengths.push(lengths.at(-1) + Math.hypot((point[0] - previous[0]) * width, (point[1] - previous[1]) * height)); previous = point;
    }
    return curve;
}

// Limit shared tangents so every cubic Bezier control lies within the
// picture's inverse-projected half planes. Its convex hull then contains
// the entire curve, without clamping pixels or moving the user's points.
function boundTangents(rows, points, tangents, bounds) {
    points.forEach((point, i) => {
        let limit = 1;
        for (const h of [i ? (rows[i - 1] - rows[i]) / 3 : 0, i + 1 < rows.length ? (rows[i + 1] - rows[i]) / 3 : 0]) {
            for (const [a, b, c] of bounds) {
                const base = Math.max(0, a * point[0] + b * point[1] + c);
                const delta = h * (a * tangents[0][i] + b * tangents[1][i]);
                if (delta < -1e-12) limit = Math.min(limit, base / -delta);
            }
        }
        tangents[0][i] *= limit; tangents[1][i] *= limit;
    });
}

// Equal steps along the guide's arc reduce horizontal stretching near a bow.
function alongCurve(curve, u) {
    if (curve.straight) return curve.points[0].map((v, k) => v + u * (curve.points[2][k] - v));
    const target = u * curve.lengths.at(-1);
    let low = 0, high = CURVE_STEPS;
    while (low + 1 < high) { const mid = (low + high) >> 1; if (curve.lengths[mid] <= target) low = mid; else high = mid; }
    const span = curve.lengths[high] - curve.lengths[low];
    return curveAt(curve, (low + (span ? (target - curve.lengths[low]) / span : 0)) / CURVE_STEPS);
}

// Shape-preserving cubic Hermite interpolation. Shared derivatives give a
// smooth join, and monotone source Y positions cannot overshoot each other.
function slopes(rows, values) {
    const h = rows.slice(1).map((v, i) => v - rows[i]);
    const d = h.map((v, i) => (values[i + 1] - values[i]) / v);
    if (d.length === 1) return [d[0], d[0]];
    const end = (a, b, da, db) => {
        let m = ((2 * a + b) * da - a * db) / (a + b);
        if (Math.sign(m) !== Math.sign(da)) m = 0;
        else if (Math.sign(da) !== Math.sign(db) && Math.abs(m) > Math.abs(3 * da)) m = 3 * da;
        return m;
    };
    const out = [end(h[0], h[1], d[0], d[1])];
    for (let i = 1; i < values.length - 1; i++) {
        if (d[i - 1] * d[i] <= 0) out.push(0);
        else { const a = 2 * h[i] + h[i - 1], b = h[i] + 2 * h[i - 1]; out.push((a + b) / (a / d[i - 1] + b / d[i])); }
    }
    out.push(end(h.at(-1), h.at(-2), d.at(-1), d.at(-2)));
    return out;
}

function surfaceProfile(surface, u) {
    const points = surface.curves.map(curve => alongCurve(curve, u));
    const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    for (let i = 1; i < ys.length; i++) if (ys[i] <= ys[i - 1] + 1e-8) throw new Error("Curved guides cross. Move them apart or reduce the bend.");
    const mx = slopes(surface.rows, xs), my = slopes(surface.rows, ys);
    boundTangents(surface.rows, points, [mx, my], surface.bounds);
    const coefficient = (a, b, ma, mb, h, origin, identity) => [2 * a - 2 * b + h * (ma + mb), -3 * a + 3 * b - h * (2 * ma + mb), h * ma - identity, a - origin]
        .map(v => Math.abs(v) < 1e-12 ? 0 : v);
    return surface.rows.slice(1).map((end, i) => {
        const start = surface.rows[i], h = end - start;
        return [...coefficient(xs[i], xs[i + 1], mx[i], mx[i + 1], h, u, 0), ...coefficient(ys[i], ys[i + 1], my[i], my[i + 1], h, start, h)];
    });
}

function rectifiedPoint(part, coefficients, u, v) {
    const t = (v - part.start) / (part.end - part.start), c = coefficients;
    return [u + ((c[0] * t + c[1]) * t + c[2]) * t + c[3], v + ((c[4] * t + c[5]) * t + c[6]) * t + c[7]];
}

function surfacePoint(part, coefficients, u, v) {
    return project(part.matrix, rectifiedPoint(part, coefficients, u, v));
}

export function scanGuidePoint(geometry, index, t) {
    return project(geometry.matrix, curveAt(geometry.surface.curves[index + 1], t));
}

// The initial bend follows the perspective-corrected midpoint of the sides.
export function scanBends(corners, folds = scanFolds(corners)) {
    const m = homography(corners);
    return folds.map(([left, right]) => {
        if (!convex(corners)) return left.map((v, k) => (v + right[k]) / 2);
        const a = unproject(m, left), b = unproject(m, right);
        return project(m, a.map((v, k) => (v + b[k]) / 2));
    });
}

// A profile is cubic in the vertical coordinate, so its Jacobian is a
// degree-five polynomial. Bernstein bounds and subdivision check the whole
// strip, including narrow reversals between the old mesh's sampled rows.
function validJacobianControls(part, profile, before, after, du) {
    const h = part.end - part.start;
    const dx = [1 + (after[3] - before[3]) / du, (after[2] - before[2]) / du,
        (after[1] - before[1]) / du, (after[0] - before[0]) / du];
    const dy = [(after[7] - before[7]) / du, (after[6] - before[6]) / du,
        (after[5] - before[5]) / du, (after[4] - before[4]) / du];
    const tx = [profile[2], 2 * profile[1], 3 * profile[0]];
    const ty = [profile[6] + h, 2 * profile[5], 3 * profile[4]];
    const power = Array(6).fill(0);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) power[i + j] += (dx[i] * ty[j] - dy[i] * tx[j]) / h;
    const choose = (n, k) => { let v = 1; for (let i = 1; i <= k; i++) v = v * (n - i + 1) / i; return v; };
    const controls = power.map((_, k) => power.slice(0, k + 1).reduce((sum, v, i) => sum + v * choose(k, i) / choose(5, i), 0));
    return nonnegativeBezier(controls) ? controls : null;
}

function nonnegativeBezier(values, depth = 0) {
    // A zero derivative at a guide is allowed; an inverted region is not.
    const tolerance = 1e-7;
    if (values.some(v => !Number.isFinite(v)) || values[0] < -tolerance || values.at(-1) < -tolerance) return false;
    if (Math.min(...values) >= -tolerance) return true;
    if (depth === 16) return false;
    const left = [values[0]], right = [values.at(-1)];
    while (values.length > 1) {
        values = values.slice(1).map((v, i) => (values[i] + v) / 2);
        left.push(values[0]); right.unshift(values.at(-1));
    }
    return nonnegativeBezier(left, depth + 1) && nonnegativeBezier(right, depth + 1);
}

function validateJacobian(geometry) {
    const n = CURVE_STEPS;
    // Arc-length inversion is piecewise: inspect both sides of every lookup
    // boundary as well as interval midpoints. Never difference across a kink.
    const columns = new Set(Array.from({ length: n + 1 }, (_, i) => i / n));
    for (const curve of geometry.surface.curves) if (!curve.straight)
        for (const length of curve.lengths) columns.add(length / curve.lengths.at(-1));
    const sorted = [...columns].sort((a, b) => a - b);
    const inspect = (left, right, depth = 0) => {
        const mid = (left + right) / 2, step = Math.min(1e-5, (right - left) / 4);
        if (step < 1e-10) return;
        const samples = [[left, left, left + step], [mid, mid - step, mid + step], [right, right - step, right]].map(([u, a, b]) => {
            const profile = surfaceProfile(geometry.surface, u), before = surfaceProfile(geometry.surface, a), after = surfaceProfile(geometry.surface, b);
            return geometry.panels.map((part, k) => {
                const controls = validJacobianControls(part, profile[k], before[k], after[k], b - a);
                if (!controls) throw new Error(FOLD_ERROR);
                return controls;
            });
        });
        // Tangent limiting and monotone slopes also change within lookup
        // intervals. Refine wherever the Jacobian varies nonlinearly in U.
        const curved = samples[1].some((controls, k) => controls.some((v, j) =>
            Math.abs(v - (samples[0][k][j] + samples[2][k][j]) / 2) > .001 * Math.max(1, Math.abs(v), Math.abs(samples[0][k][j]), Math.abs(samples[2][k][j]))));
        if (curved && depth < 8) { inspect(left, mid, depth + 1); inspect(mid, right, depth + 1); }
    };
    for (let i = 1; i < sorted.length; i++) inspect(sorted[i - 1], sorted[i]);
}

function validateSurface(geometry, width, height) {
    validateJacobian(geometry);
    const n = CURVE_STEPS, profiles = Array.from({ length: n + 1 }, (_, i) => surfaceProfile(geometry.surface, i / n));
    for (let k = 0; k < geometry.panels.length; k++) {
        const part = geometry.panels[k];
        let previous = null;
        for (let y = 0; y <= 24; y++) {
            const v = part.start + (part.end - part.start) * y / 24;
            const row = profiles.map((profile, x) => rectifiedPoint(part, profile[k], x / n, v));
            for (const p of row) {
                const source = project(geometry.matrix, p);
                if (!source.every(Number.isFinite) || source[0] < -.01 || source[0] > width + .01 || source[1] < -.01 || source[1] > height + .01)
                    throw new Error("Keep the curved paper outline inside the picture.");
            }
            if (previous) for (let x = 0; x < n; x++) {
                const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
                const area = (part.end - part.start) / (24 * n);
                // Permit strong but valid compression; reject collapsed or reversed cells.
                if (cross(previous[x], previous[x + 1], row[x]) < area * 1e-6 || cross(previous[x + 1], row[x + 1], row[x]) < area * 1e-6)
                    throw new Error(FOLD_ERROR);
            }
            previous = row;
        }
    }
}

// A folded paper (a letter folded to fit an envelope, say) lies in flat
// panels, one above another. Each fold is a
// straight line across it, from a point on its left side to one on its
// right: [left, right], top to bottom. scanPanels is the panels' corners
// (clockwise from top left), top to bottom.
export function scanPanels(corners, folds = []) {
    const lefts = [corners[0], ...folds.map(f => f[0]), corners[3]];
    const rights = [corners[1], ...folds.map(f => f[1]), corners[2]];
    return lefts.slice(1).map((left, i) => [lefts[i], rights[i], rights[i + 1], left]);
}

// scanFolds is where n folds, evenly spaced down the paper in the corners'
// perspective, would be: where their points start.
export function scanFolds(corners, n = 2) {
    const m = homography(corners), flat = convex(corners) && m.every(Number.isFinite);
    const at = (u, v) => flat
        ? [(m[0] * u + m[1] * v + m[2]) / (m[6] * u + m[7] * v + 1), (m[3] * u + m[4] * v + m[5]) / (m[6] * u + m[7] * v + 1)]
        // Corners that fold it: (only to place the points) between them.
        : [0, 1].map(i => (1 - v) * corners[u ? 1 : 0][i] + v * corners[u ? 2 : 3][i]);
    return Array.from({ length: n }, (_, i) => [at(0, (i + 1) / (n + 1)), at(1, (i + 1) / (n + 1))]);
}

const isPoint = (a, width, height) => Array.isArray(a) && a.length === 2 && a.every(Number.isFinite) && a[0] >= 0 && a[0] <= width && a[1] >= 0 && a[1] <= height;
export function scanGeometry(width, height, settings) {
    const p = settings?.corners, folds = settings?.folds ?? [];
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_PIXELS)
        throw new Error("Resize the picture to under 16 megapixels before scanning.");
    if (!Array.isArray(p) || p.length !== 4 || p.some(a => !isPoint(a, width, height))) throw new Error("Place all four corners inside the picture.");
    if (!Array.isArray(folds) || folds.length > MAX_FOLDS || folds.some(f => !Array.isArray(f) || f.length !== 2 || f.some(a => !isPoint(a, width, height))))
        throw new Error("Place every fold point inside the picture.");
    if (settings.surface != null && !["smooth", "crease"].includes(settings.surface)) throw new Error("Choose curved paper or sharp folds.");
    if (settings.curves != null && (!Array.isArray(settings.curves) || settings.curves.length !== folds.length || settings.curves.some(p => p != null && !isPoint(p, width, height))))
        throw new Error("Place every curve point inside the picture.");
    // Clockwise on screen: top left, top right, bottom right, bottom left.
    const panels = scanPanels(p, folds);
    if (!convex(p)) throw new Error("Keep the corners in order around the paper without crossing the edges.");
    if (folds.length && !panels.every(convex)) throw new Error("Keep the corners and fold points in order down each side, without crossing.");
    let area = 0;
    for (const q of panels) for (let i = 0; i < 4; i++) area += q[i][0] * q[(i + 1) % 4][1] - q[(i + 1) % 4][0] * q[i][1];
    if (area < 8) throw new Error("Select a larger document area.");
    // Keep the four-corner page size stable when a fold handle is activated.
    // Image-space fold widths/heights are foreshortened by perspective, so
    // averaging them changes aspect ratio and stretches unrelated content.
    const w = Math.max(2, Math.round((distance(p[0], p[1]) + distance(p[3], p[2])) / 2));
    const h = Math.max(2, Math.round((distance(p[0], p[3]) + distance(p[1], p[2])) / 2));
    const matrix = homography(p);
    const across = [[[0, 0], [1, 0]], ...folds.map(f => f.map(point => unproject(matrix, point))), [[0, 1], [1, 1]]];
    if (across.some(f => f.some(point => !point.every(Number.isFinite)))) throw new Error("The fold points cannot be mapped onto the page.");
    const rows = across.map(([left, right]) => (left[1] + right[1]) / 2);
    for (let i = 1; i < across.length; i++) {
        if (across[i].some((point, side) => point[1] <= across[i - 1][side][1] + 1e-8))
            throw new Error("Keep the fold points between the corners and in order down each side.");
    }
    const zero = value => Math.abs(value) < 1e-12 ? 0 : value;
    const parts = across.slice(1).map((bottom, i) => {
        const start = rows[i], end = rows[i + 1];
        const offsets = [across[i][0], across[i][1], bottom[1], bottom[0]].map(([x, y], corner) =>
            [zero(x - (corner === 1 || corner === 2 ? 1 : 0)), zero(y - (corner < 2 ? start : end))]);
        return { matrix, top: start * h, height: (end - start) * h, start, end,
            offsets: offsets.every(point => point.every(v => v === 0)) ? null : offsets };
    });
    if (w * h > MAX_PIXELS || Math.max(w, h) > MAX_SIDE) throw new Error("The scanned page exceeds 16 megapixels or 8192 pixels per side.");
    if (!["color", "gray", "bw"].includes(settings.mode) || !Number.isFinite(settings.whiten) || settings.whiten < 0 || settings.whiten > 100
        || !Number.isFinite(settings.ink) || settings.ink < 0 || settings.ink > 40) throw new Error("Invalid scan adjustments.");
    const geometry = { width: w, height: h, matrix, panels: parts };
    if (settings.surface === "smooth") {
        const m = matrix;
        const bounds = [[m[0], m[1], m[2]], [width * m[6] - m[0], width * m[7] - m[1], width - m[2]],
            [m[3], m[4], m[5]], [height * m[6] - m[3], height * m[7] - m[4], height - m[5]], [m[6], m[7], 1 - 1e-9]];
        const curves = across.map(([left, right], i) => {
            const point = i > 0 && i < across.length - 1 ? settings.curves?.[i - 1] : null;
            return curveRow(left, right, point ? unproject(matrix, point) : left.map((v, k) => (v + right[k]) / 2), w, h, bounds);
        });
        geometry.surface = { rows, curves, bounds };
        validateSurface(geometry, width, height);
    }
    return geometry;
}

// A small background field: enlarge bright paper regions to bridge ink,
// then smooth. The full-size output never needs full-size filter buffers.
function paperField(data, width, height) {
    const scale = Math.min(1, 192 / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
    const field = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        for (const [u, v] of [[.2, .2], [.8, .2], [.5, .5], [.2, .8], [.8, .8]]) {
            const i = (Math.min(height - 1, Math.floor((y + v) * height / h)) * width + Math.min(width - 1, Math.floor((x + u) * width / w))) * 4;
            const at = (y * w + x) * 3;
            for (let c = 0; c < 3; c++) field[at + c] = Math.max(field[at + c], data[i + c] * data[i + 3] / 255 + 255 - data[i + 3]);
        }
    }
    let src = field;
    for (const [horizontal, radius, maximum] of [[true, 3, true], [false, 3, true], [true, 6, false], [false, 6, false]]) {
        const out = new Float32Array(field.length);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
            let value = 0;
            for (let k = -radius; k <= radius; k++) {
                const xx = horizontal ? Math.max(0, Math.min(w - 1, x + k)) : x;
                const yy = horizontal ? y : Math.max(0, Math.min(h - 1, y + k));
                const sample = src[(yy * w + xx) * 3 + c];
                value = maximum ? Math.max(value, sample) : value + sample;
            }
            out[(y * w + x) * 3 + c] = maximum ? value : value / (radius * 2 + 1);
        }
        src = out;
    }
    return { data: src, width: w, height: h };
}

export function scanPixels(rgba, width, height, settings) {
    const size = scanGeometry(width, height, settings);
    if (rgba.length !== width * height * 4) throw new Error("Invalid scan pixels.");
    const out = new Uint8ClampedArray(size.width * size.height * 4);
    // Profiles are computed once per column, rather than fitting splines for
    // every pixel. Full-resolution and preview use the same normalized map.
    const profiles = size.surface ? Array.from({ length: size.width }, (_, x) => surfaceProfile(size.surface, (x + .5) / size.width)) : null;
    let panel = 0;
    for (let y = 0; y < size.height; y++) {
        const v = (y + .5) / size.height;
        while (v >= size.panels[panel].end) panel++;
        const part = size.panels[panel];
        for (let x = 0; x < size.width; x++) {
            const point = profiles ? surfacePoint(part, profiles[x][panel], (x + .5) / size.width, v) : mapPanel(part, (x + .5) / size.width, v);
            const sx = Math.max(0, Math.min(width - 1, point[0] - .5));
            const sy = Math.max(0, Math.min(height - 1, point[1] - .5));
            const left = Math.floor(sx), top = Math.floor(sy), fx = sx - left, fy = sy - top, at = (y * size.width + x) * 4;
            let alpha = 0;
            const color = [0, 0, 0];
            for (const [xx, yy, weight] of [[left, top, (1 - fx) * (1 - fy)], [Math.min(width - 1, left + 1), top, fx * (1 - fy)],
                [left, Math.min(height - 1, top + 1), (1 - fx) * fy], [Math.min(width - 1, left + 1), Math.min(height - 1, top + 1), fx * fy]]) {
                const i = (yy * width + xx) * 4, a = rgba[i + 3] * weight;
                alpha += a;
                for (let c = 0; c < 3; c++) color[c] += rgba[i + c] * a;
            }
            for (let c = 0; c < 3; c++) out[at + c] = alpha ? color[c] / alpha : 0;
            out[at + 3] = alpha;
        }
    }
    const field = settings.whiten ? paperField(out, size.width, size.height) : null;
    const blend = settings.whiten / 100, black = settings.ink * 2.55;
    for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) {
        const at = (y * size.width + x) * 4;
        const f = field ? (Math.min(field.height - 1, Math.floor(y * field.height / size.height)) * field.width + Math.min(field.width - 1, Math.floor(x * field.width / size.width))) * 3 : 0;
        const color = [0, 1, 2].map(c => {
            const value = out[at + c], paper = field ? Math.max(32, field.data[f + c]) : 255;
            const cleaned = value * (1 - blend) + Math.min(255, value * 255 / paper) * blend;
            return Math.max(0, Math.min(255, (cleaned - black) * 255 / (255 - black)));
        });
        const gray = .2126 * color[0] + .7152 * color[1] + .0722 * color[2];
        for (let c = 0; c < 3; c++) out[at + c] = settings.mode === "color" ? color[c] : settings.mode === "bw" ? (gray >= 160 ? 255 : 0) : gray;
    }
    return { data: out, width: size.width, height: size.height };
}

export function scanCanvas(source, settings) {
    scanGeometry(source.width, source.height, settings);
    const input = Object.assign(document.createElement("canvas"), { width: source.width, height: source.height });
    const ctx = input.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(source, 0, 0);
    const image = scanPixels(ctx.getImageData(0, 0, source.width, source.height).data, source.width, source.height, settings);
    input.width = image.width; input.height = image.height;
    ctx.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
    return input;
}

export function scanTool({ toolbar, hints, stage, button, geometry, source, apply, changed }) {
    let active = false, corners = [], moved = [], bends = [], currentGeometry = null, base = null, frame = null, gesture = null, previewing = false;
    const control = (icon, label, cls, action) => {
        const b = el("button", { type: "button", className: `glyph ${cls}`, title: label, ariaLabel: label });
        b.innerHTML = iconSVG(icon); b.addEventListener("click", action); return b;
    };
    const cornerView = control("scan-corners", "Adjust document corners", "image-scan-corners", () => { previewing = false; refresh(); });
    const preview = control("scan-preview", "Preview scanned document", "image-scan-preview", () => { previewing = true; refresh(); });
    const mode = el("select", { className: "image-scan-mode", ariaLabel: "Scan color mode" },
        ...[["gray", "Grayscale"], ["color", "Color"], ["bw", "Black & white"]].map(([value, textContent]) => el("option", { value, textContent })));
    mode.value = "gray";
    const surface = choiceMenu({ className: "image-scan-surface", label: "Paper shape", button: preview, choices: [
        { key: "smooth", title: "Curved paper", icon: "scan-preview", className: "image-scan-surface-smooth" },
        { key: "crease", title: "Sharp folds", icon: "scan-corners", className: "image-scan-surface-crease" },
    ], onChoose: key => { surface.set(key); previewing = false; refresh(); preview.focus(); } });
    surface.set("smooth");
    const whiten = el("input", { type: "range", min: 0, max: 100, value: 85, className: "image-scan-whiten", ariaLabel: "Paper whitening" });
    const ink = el("input", { type: "range", min: 0, max: 40, value: 8, className: "image-scan-ink", ariaLabel: "Ink strength" });
    const settings = el("div", { className: "mask-brush-options image-scan-options", role: "dialog", ariaLabel: "Scan adjustments" },
        el("label", {}, "Finish ", mode), el("label", {}, "Paper whitening ", whiten), el("label", {}, "Ink strength ", ink));
    settings.setAttribute("popover", "auto");
    const adjust = control("save-options", "Scan adjustments", "image-scan-settings", () => {});
    adjust.popoverTargetElement = settings; adjust.popoverTargetAction = "toggle";
    adjust.setAttribute("aria-haspopup", "dialog"); adjust.setAttribute("aria-expanded", "false");
    const positionSettings = () => {
        adjust.setAttribute("aria-expanded", String(settings.matches(":popover-open")));
        if (!settings.matches(":popover-open")) return;
        const r = adjust.getBoundingClientRect(), box = settings.getBoundingClientRect();
        settings.style.left = `${Math.max(8, Math.min(r.left, innerWidth - box.width - 8))}px`;
        settings.style.top = `${Math.max(8, Math.min(r.bottom + 4, innerHeight - box.height - 8))}px`;
    };
    settings.addEventListener("toggle", positionSettings);
    window.addEventListener("resize", positionSettings);
    settings.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); settings.hidePopover(); adjust.focus(); } e.stopPropagation(); });
    for (const input of [mode, whiten, ink]) input.addEventListener("input", () => { previewing = true; refresh(); });
    const accept = control("check", "Apply document scan", "image-scan-apply", () => tool.commit());
    const cancel = control("close-circle", "Cancel document scan", "image-scan-cancel", () => tool.close());
    const bar = el("div", { className: "image-scan-tools", hidden: true }, cornerView, surface.group, adjust, accept, cancel, settings);
    const note = el("span", { className: "hint image-scan-note", role: "status", hidden: true });
    toolbar.append(bar); hints.append(note);
    const ns = "http://www.w3.org/2000/svg", outline = document.createElementNS(ns, "svg"), polygon = document.createElementNS(ns, "polygon"), foldLines = document.createElementNS(ns, "path");
    outline.setAttribute("class", "image-scan-outline"); outline.setAttribute("aria-hidden", "true"); foldLines.setAttribute("class", "image-scan-fold-lines"); outline.append(polygon, foldLines); outline.style.display = "none";
    const output = el("canvas", { className: "image-scan-result", hidden: true, ariaLabel: "Scanned document preview", role: "img" });
    // Four points down each side: the corners (0-3), then the two folds'
    // left and right points (4-7). A fold point follows the corners, evenly
    // spaced, until it's moved itself (moved[i - 4]).
    const folds = () => scanFolds(corners).map((fold, f) => fold.map((p, side) => moved[f * 2 + side] ?? p));
    const params = () => ({ corners: corners.map(p => [...p]), surface: surface.value,
        ...(surface.value === "smooth" || moved.some(Boolean) ? { folds: folds() } : {}),
        ...(surface.value === "smooth" && bends.some(Boolean) ? { curves: [0, 1].map(i => bends[i] ? [...bends[i]] : null) } : {}),
        mode: mode.value, whiten: Number(whiten.value), ink: Number(ink.value) });
    const names = ["Top left document corner", "Top right document corner", "Bottom right document corner", "Bottom left document corner",
        "Upper guide, left side", "Upper guide, right side", "Lower guide, left side", "Lower guide, right side", "Upper guide curvature", "Lower guide curvature"];
    const pointOf = i => i < 4 ? corners[i] : i < 8 ? folds()[(i - 4) >> 1][(i - 4) & 1] : bends[i - 8] ?? scanBends(corners, folds())[i - 8];
    const moveTo = (i, [x, y]) => {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        const p = [x, y];
        if (i < 4) corners[i] = p; else if (i < 8) moved[i - 4] = p; else bends[i - 8] = p;
    };
    const handles = names.map((name, i) => {
        const b = el("button", { type: "button", className: i >= 8 ? "image-scan-curve-point" : `image-scan-corner${i < 4 ? "" : " image-scan-fold"}`, textContent: i < 4 ? String(i + 1) : i >= 8 ? "◇" : "", ariaLabel: name, hidden: true });
        b.addEventListener("pointerdown", e => {
            if (e.button !== 0) return;
            e.preventDefault(); e.stopPropagation(); b.focus(); b.setPointerCapture(e.pointerId);
            gesture = { i, corners: corners.map(p => [...p]), moved: [...moved], bends: [...bends], id: e.pointerId };
        });
        b.addEventListener("pointermove", e => {
            if (!gesture || gesture.i !== i || gesture.id !== e.pointerId) return;
            e.stopPropagation(); const g = geometry(), r = stage.getBoundingClientRect();
            moveTo(i, [(e.clientX - r.left - g.x) / g.scale, (e.clientY - r.top - g.y) / g.scale]);
            refresh();
        });
        const end = e => { e.stopPropagation(); if (gesture?.i === i) { if (e.type === "pointercancel") ({ corners, moved, bends } = gesture); gesture = null; refresh(); } };
        b.addEventListener("pointerup", end); b.addEventListener("pointercancel", end);
        b.addEventListener("keydown", e => {
            const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
            if (!d) return; e.preventDefault(); e.stopPropagation();
            const step = e.shiftKey ? 10 : 1;
            const p = pointOf(i); moveTo(i, [p[0] + d[0] * step, p[1] + d[1] * step]); refresh();
        });
        return b;
    });
    stage.append(outline, output, ...handles);
    function place() {
        if (!active) return;
        const g = geometry();
        Object.assign(outline.style, { left: `${g.x}px`, top: `${g.y}px`, width: `${g.width * g.scale}px`, height: `${g.height * g.scale}px` });
        outline.setAttribute("viewBox", `0 0 ${g.width} ${g.height}`); const across = folds();
        if (currentGeometry?.surface) {
            const boundary = [];
            for (let i = 0; i <= 40; i++) boundary.push(scanPoint(currentGeometry, i / 40, 0));
            for (let i = 1; i <= 80; i++) boundary.push(scanPoint(currentGeometry, 1, i / 80));
            for (let i = 1; i <= 40; i++) boundary.push(scanPoint(currentGeometry, 1 - i / 40, 1));
            for (let i = 1; i < 80; i++) boundary.push(scanPoint(currentGeometry, 0, 1 - i / 80));
            polygon.setAttribute("points", boundary.map(p => p.join(",")).join(" "));
            foldLines.setAttribute("d", across.map((_, k) => Array.from({ length: CURVE_STEPS + 1 }, (_, i) => `${i ? "L" : "M"}${scanGuidePoint(currentGeometry, k, i / CURVE_STEPS).join(",")}`).join("")).join(""));
        } else {
            polygon.setAttribute("points", [corners[0], corners[1], ...across.map(f => f[1]), corners[2], corners[3], ...across.map(f => f[0]).reverse()].map(p => p.join(",")).join(" "));
            foldLines.setAttribute("d", across.map(([a, b]) => `M${a.join(",")}L${b.join(",")}`).join(""));
        }
        handles.forEach((b, i) => {
            const [x, y] = pointOf(i), outside = !isPoint([x, y], base.width, base.height);
            Object.assign(b.style, { left: `${g.x + x * g.scale}px`, top: `${g.y + y * g.scale}px` });
            b.classList.toggle("outside", outside); b.setAttribute("aria-invalid", String(outside));
            b.title = `${names[i]}: ${Math.round(x)}, ${Math.round(y)}${outside ? " (outside picture)" : ""}; drag or use arrow keys${i >= 8 ? "; follow a bowed table rule or text baseline" : ""}`;
        });
        if (!output.hidden) {
            const s = Math.min(g.width * g.scale / output.width, g.height * g.scale / output.height);
            Object.assign(output.style, { left: `${g.x + (g.width * g.scale - output.width * s) / 2}px`, top: `${g.y + (g.height * g.scale - output.height * s) / 2}px`, width: `${output.width * s}px`, height: `${output.height * s}px` });
        }
    }
    function refresh() {
        if (!active) return;
        let valid = true;
        try { currentGeometry = scanGeometry(base.width, base.height, params()); note.textContent = previewing ? "Preview: adjust the finish, or return to Corners. Apply keeps the scan."
            : surface.value === "smooth" ? "Place the corners on the paper and the side points along its edges. Bend each guide with its middle diamond to follow a bowed table rule or text line. Arrow keys fine-tune a point; Shift moves 10 pixels."
                : "Place corners and side points on the sharp folds. Switch to Curved paper for bowed pages. Arrow keys fine-tune a point; Shift moves 10 pixels."; }
        catch (err) { currentGeometry = null; valid = false; note.textContent = err.message; }
        accept.disabled = preview.disabled = !valid; note.classList.toggle("error", !valid);
        cornerView.setAttribute("aria-pressed", String(!previewing)); preview.setAttribute("aria-pressed", String(previewing));
        outline.style.display = previewing ? "none" : "block"; handles.forEach((b, i) => { b.hidden = previewing || i >= 8 && surface.value !== "smooth"; });
        base.style.visibility = previewing && valid ? "hidden" : "";
        cancelAnimationFrame(frame); output.hidden = true;
        if (previewing && valid) frame = requestAnimationFrame(() => {
            frame = null;
            try {
                const s = Math.min(1, 900 / Math.max(base.width, base.height));
                const sample = Object.assign(document.createElement("canvas"), { width: Math.max(2, Math.round(base.width * s)), height: Math.max(2, Math.round(base.height * s)) });
                sample.getContext("2d").drawImage(base, 0, 0, sample.width, sample.height);
                const p = params(), fit = ([x, y]) => [x * sample.width / base.width, y * sample.height / base.height];
                p.corners = p.corners.map(fit); if (p.folds) p.folds = p.folds.map(f => f.map(fit));
                if (p.curves) p.curves = p.curves.map(p => p ? fit(p) : null);
                const result = scanCanvas(sample, p); output.width = result.width; output.height = result.height; output.getContext("2d").drawImage(result, 0, 0); output.hidden = false; place();
            } catch (err) { note.textContent = err.message; accept.disabled = true; base.style.visibility = ""; }
        });
        place(); changed();
    }
    const tool = {
        active: () => active, painting: () => active, place,
        recipe: () => active && !accept.disabled ? { kind: "scan", width: base.width, height: base.height, settings: params() } : null,
        open() {
            base = source(); scanGeometry(base.width, base.height, { corners: [[0, 0], [base.width, 0], [base.width, base.height], [0, base.height]], mode: "gray", whiten: 85, ink: 8 });
            corners = [[.03, .03], [.97, .03], [.97, .97], [.03, .97]].map(([x, y]) => [x * base.width, y * base.height]);
            moved = []; bends = []; surface.set("smooth");
            mode.value = "gray"; whiten.value = "85"; ink.value = "8";
            active = true; previewing = false; bar.hidden = note.hidden = false; button.setAttribute("aria-pressed", "true"); refresh(); handles[0].focus({ preventScroll: true });
        },
        close() {
            active = false; gesture = null; cancelAnimationFrame(frame); frame = null; settings.hidePopover(); surface.close();
            if (base) base.style.visibility = "";
            outline.style.display = "none"; output.hidden = true; handles.forEach(b => { b.hidden = true; });
            output.width = output.height = 0; bar.hidden = note.hidden = true; button.setAttribute("aria-pressed", "false"); base = null; changed();
        },
        commit() { if (active && !accept.disabled) { const op = { scan: params() }; tool.close(); apply(op); } },
        stop() { tool.close(); surface.stop(); window.removeEventListener("resize", positionSettings); bar.remove(); note.remove(); outline.remove(); output.remove(); handles.forEach(b => b.remove()); },
    };
    bar.addEventListener("keydown", e => {
        if (e.target.matches("input, select")) return;
        if (e.key === "Enter" && e.target.closest("button")) return;
        if (e.key === "Escape" || e.key === "Enter") {
            e.preventDefault(); e.stopPropagation();
            if (e.key === "Escape") tool.close(); else tool.commit();
        }
    });
    return tool;
}
