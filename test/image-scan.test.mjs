import { test } from "node:test";
import assert from "node:assert/strict";
import { scanGeometry, scanPixels, scanHandles, scanOutline } from "../tabtopd/image-scan.js";
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

test("edges left alone give exactly the four-corner scan", () => {
    const w = 60, h = 80, data = new Uint8ClampedArray(w * h * 4).map((_, i) => (i * 37) % 251);
    const corners = [[5, 4], [55, 8], [58, 76], [2, 70]];
    const four = scanPixels(data, w, h, settings(w, h, { corners })), eight = scanPixels(data, w, h, settings(w, h, { corners, edges: [[0, 0], [0, 0], [0, 0], [0, 0]] }));
    assert.deepEqual(eight, four);
    // The middles of the edges are halfway along them in perspective.
    const handles = scanHandles([[0, 0], [40, 0], [40, 20], [0, 20]]);
    assert.deepEqual(handles.slice(4), [[20, 0], [40, 10], [20, 20], [0, 10]]);
});
test("a bowed top edge, bent to follow it, comes out straight", () => {
    // A page whose top edge bows up by 8 pixels in its middle, above a dark band.
    const w = 100, h = 100, data = new Uint8ClampedArray(w * h * 4);
    const top = x => 20 - 8 * 4 * ((x - 10) / 80) * (1 - (x - 10) / 80);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const inPage = x >= 10 && x <= 90 && y >= top(x) && y <= 90, band = inPage && y < top(x) + 6;
        data.set(band ? [0, 0, 0, 255] : inPage ? [255, 255, 255, 255] : [0, 160, 0, 255], (y * w + x) * 4);
    }
    const corners = [[10, 20], [90, 20], [90, 90], [10, 90]];
    const straightened = scanPixels(data, w, h, settings(w, h, { corners, edges: [[0, -8], [0, 0], [0, 0], [0, 0]] }));
    const flat = scanPixels(data, w, h, settings(w, h, { corners }));
    const darkRow = (img, y) => Array.from({ length: img.width - 8 }, (_, i) => img.data[(y * img.width + i + 4) * 4]).every(v => v < 60);
    // Bent: the band runs straight along the top; four corners alone cut it off in the middle.
    assert.ok(darkRow(straightened, 2), "the band follows the bent edge");
    assert.ok(!darkRow(flat, 2), "four corners alone miss the bow");
    assert.ok(straightened.width > flat.width && straightened.height === flat.height, "as wide as the bent edge is long");
});
test("bent edges are checked, outlined, and scaled to other pages", () => {
    const corners = [[10, 10], [90, 10], [90, 90], [10, 90]];
    assert.throws(() => scanGeometry(100, 100, settings(100, 100, { corners, edges: [[0, -20], [0, 0], [0, 0], [0, 0]] })), /inside/);
    assert.throws(() => scanGeometry(100, 100, settings(100, 100, { corners, edges: [[0, 79], [0, 0], [0, -79], [0, 0]] })), /cross/);
    assert.throws(() => scanGeometry(100, 100, settings(100, 100, { corners, edges: [[0, 0]] })), /edges/);
    const outline = scanOutline(corners, [[0, -8], [0, 0], [0, 0], [0, 0]], 4);
    assert.equal(outline.length, 16);
    assert.deepEqual(outline[2], [50, 2]);
    const scan = settings(100, 100, { corners, edges: [[0, -8], [4, 0], [0, 0], [0, 0]] });
    const doubled = scaleRecipe({ kind: "scan", width: 100, height: 100, settings: scan }, 200, 300);
    assert.deepEqual(doubled.settings.edges, [[0, -24], [8, 0], [0, 0], [0, 0]]);
});
