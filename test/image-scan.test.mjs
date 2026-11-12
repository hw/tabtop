import { test } from "node:test";
import assert from "node:assert/strict";
import { scanGeometry, scanPixels, scanFolds } from "../tabtopd/image-scan.js";
import { editRecipe } from "../tabtopd/image-view.js";
import { scaleRecipe, describeStep } from "../tabtopd/image-batch.js";

const settings = (w, h, more = {}) => ({ corners: [[0, 0], [w, 0], [w, h], [0, h]], mode: "color", whiten: 0, ink: 0, ...more });
test("an unchanged outline preserves pixels, alpha and dimensions without altering the source", () => {
    const data = Uint8ClampedArray.from([10, 20, 30, 255, 200, 100, 50, 128, 0, 0, 0, 0, 50, 60, 70, 255]);
    const before = data.slice(), result = scanPixels(data, 2, 2, settings(2, 2));
    assert.deepEqual(result, { data, width: 2, height: 2 });
    assert.deepEqual(data, before);
});
test("rectification crops a rectangle exactly and preserves sharp ink against a shaded page", () => {
    const w = 80, h = 100, data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const ink = x > 20 && x < 24 && y > 15 && y < 85;
        const i = (y * w + x) * 4, paper = 150 + Math.round(65 * x / w);
        data.set(ink ? [20, 20, 20, 255] : [paper + 10, paper, paper - 15, 255], i);
    }
    const crop = scanPixels(data, w, h, settings(w, h, { corners: [[10, 10], [70, 10], [70, 90], [10, 90]] }));
    assert.deepEqual([crop.width, crop.height], [60, 80]);
    assert.deepEqual([...crop.data.slice(0, 4)], [...data.slice((10 * w + 10) * 4, (10 * w + 10) * 4 + 4)]);
    const clean = scanPixels(data, w, h, settings(w, h, { mode: "gray", whiten: 100, ink: 8 }));
    for (const x of [10, 65]) {
        const i = (50 * w + x) * 4;
        assert.ok(clean.data[i] > 230);
        assert.equal(clean.data[i], clean.data[i + 1]);
        assert.equal(clean.data[i + 1], clean.data[i + 2]);
    }
    assert.ok(clean.data[(50 * w + 22) * 4] < 15, "thin lettering survives whitening");
    const bw = scanPixels(data, w, h, settings(w, h, { mode: "bw", whiten: 100, ink: 8 }));
    assert.ok([...bw.data].every((v, i) => i % 4 === 3 || v === 0 || v === 255));
});
test("projective mapping reaches all four corners of a trapezoid, with no folds or unsafe allocations", () => {
    const p = [[10, 10], [90, 20], [100, 110], [0, 100]];
    const g = scanGeometry(100, 120, settings(100, 120, { corners: p })), m = g.matrix;
    for (const [i, [u, v]] of [[0, [0, 0]], [1, [1, 0]], [2, [1, 1]], [3, [0, 1]]]) {
        const d = m[6] * u + m[7] * v + 1;
        assert.ok(Math.abs((m[0] * u + m[1] * v + m[2]) / d - p[i][0]) < 1e-8);
        assert.ok(Math.abs((m[3] * u + m[4] * v + m[5]) / d - p[i][1]) < 1e-8);
    }
    assert.throws(() => scanGeometry(100, 120, settings(100, 120, { corners: [p[0], p[2], p[1], p[3]] })), /corners|crossing/);
    assert.throws(() => scanGeometry(100, 120, settings(100, 120, { corners: [[-1, 0], ...p.slice(1)] })), /inside/);
    assert.throws(() => scanGeometry(100, 120, settings(100, 120, { corners: [[0, 0], [1, 0], [1, 1], [0, 1]] })), /larger/);
    assert.throws(() => scanGeometry(10000, 10000, settings(10000, 10000)), /16 megapixels/);
    assert.throws(() => scanGeometry(100, 100, settings(100, 100, { whiten: NaN })), /adjustments/);
});
test("scan geometry is replayable and scales to PDF pages before later operations", () => {
    const scan = settings(100, 200, { corners: [[10, 20], [90, 20], [90, 180], [10, 180]], mode: "gray", whiten: 85, ink: 8 });
    const recipe = editRecipe(100, 200, [{ scan }, "right"]);
    assert.deepEqual(recipe.steps.map(s => [s.kind, s.width, s.height]), [["scan", 100, 200], ["transform", 80, 160]]);
    const doubled = scaleRecipe(recipe.steps[0], 200, 400);
    assert.deepEqual(doubled.settings.corners, [[20, 40], [180, 40], [180, 360], [20, 360]]);
    assert.equal(describeStep(doubled), "Scan document");
    assert.deepEqual(recipe.steps[0].settings, scan);
});

test("no folds gives the four-corner scan; fold points start evenly spaced in perspective", () => {
    const w = 60, h = 80, data = new Uint8ClampedArray(w * h * 4).map((_, i) => (i * 37) % 251);
    const corners = [[5, 4], [55, 8], [58, 76], [2, 70]];
    assert.deepEqual(scanPixels(data, w, h, settings(w, h, { corners, folds: [] })), scanPixels(data, w, h, settings(w, h, { corners })));
    assert.deepEqual(scanFolds([[0, 0], [30, 0], [30, 90], [0, 90]]), [[[0, 30], [30, 30]], [[0, 60], [30, 60]]]);
    // Folds where the corners' perspective puts them change next to nothing.
    const folded = scanPixels(data, w, h, settings(w, h, { corners, folds: scanFolds(corners) }));
    const flat = scanPixels(data, w, h, settings(w, h, { corners }));
    assert.equal(folded.width, flat.width);
    assert.ok(Math.abs(folded.height - flat.height) <= 1);
});
test("a letter folded in three comes out as one flat page", () => {
    // Three panels, each its own shape: red narrowing to its fold, green
    // widening from it, and blue; on black.
    const w = 100, h = 130, data = new Uint8ClampedArray(w * h * 4);
    const panels = [[[10, 10], [90, 10], [80, 50], [20, 50]], [[20, 50], [80, 50], [90, 90], [10, 90]], [[10, 90], [90, 90], [90, 120], [10, 120]]];
    const inside = (q, x, y) => q.every((a, i) => { const b = q[(i + 1) % 4]; return (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) >= 0; });
    const colours = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const k = panels.findIndex(q => inside(q, x + .5, y + .5));
        data.set(k < 0 ? [0, 0, 0, 255] : [...colours[k], 255], (y * w + x) * 4);
    }
    const corners = [[10, 10], [90, 10], [90, 120], [10, 120]], folds = [[[20, 50], [80, 50]], [[10, 90], [90, 90]]];
    const page = scanPixels(data, w, h, settings(w, h, { corners, folds }));
    // As tall as each panel's sides: 41, 41 and 30.
    assert.deepEqual([page.width, page.height], [75, 112]);
    const row = (img, y) => Array.from({ length: img.width - 4 }, (_, i) => [...img.data.slice((y * img.width + i + 2) * 4, (y * img.width + i + 2) * 4 + 3)]);
    // Each panel's colour runs right across its rows: none of the black beside the narrow fold.
    for (const [y, colour] of [[20, colours[0]], [38, colours[0]], [42, colours[1]], [60, colours[1]], [95, colours[2]]])
        assert.ok(row(page, y).every(c => c.every((v, j) => Math.abs(v - colour[j]) < 40)), `row ${y}`);
    // Four corners alone take in the black beside the folds.
    const flat = scanPixels(data, w, h, settings(w, h, { corners }));
    assert.ok(row(flat, 38).some(c => c.every(v => v < 40)));
});
test("folds are checked, and scaled to other pages", () => {
    const corners = [[10, 10], [90, 10], [90, 90], [10, 90]];
    assert.throws(() => scanGeometry(100, 100, settings(100, 100, { corners, folds: [[[10, 40], [120, 40]]] })), /fold point inside/);
    assert.throws(() => scanGeometry(100, 100, settings(100, 100, { corners, folds: [[[10, 60], [90, 60]], [[10, 30], [90, 30]]] })), /order/);
    assert.throws(() => scanGeometry(100, 100, settings(100, 100, { corners, folds: [[[10, 40]]] })), /fold point/);
    assert.throws(() => scanGeometry(100, 100, settings(100, 100, { corners, folds: Array(7).fill([[10, 40], [90, 40]]) })), /fold point/);
    // A fold may bulge the outline out, as a folded paper's does.
    assert.equal(scanGeometry(100, 100, settings(100, 100, { corners, folds: [[[2, 50], [98, 50]]] })).panels.length, 2);
    const scan = settings(100, 100, { corners, folds: [[[10, 40], [90, 40]], [[10, 70], [90, 70]]] });
    const doubled = scaleRecipe({ kind: "scan", width: 100, height: 100, settings: scan }, 200, 300);
    assert.deepEqual(doubled.settings.folds, [[[20, 120], [180, 120]], [[20, 210], [180, 210]]]);
});
