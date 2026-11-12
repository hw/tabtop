import { test } from "node:test";
import assert from "node:assert/strict";
import { scanGeometry, scanPixels, scanFolds, scanPoint, scanGuidePoint, scanBends } from "../tabtopd/image-scan.js";
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
    // Fold handles change the mapping, not the four-corner page dimensions.
    assert.deepEqual([page.width, page.height], [80, 110]);
    const row = (img, y) => Array.from({ length: img.width - 4 }, (_, i) => [...img.data.slice((y * img.width + i + 2) * 4, (y * img.width + i + 2) * 4 + 3)]);
    // Each panel's colour runs right across its rows: none of the black beside the narrow fold.
    for (const [y, colour] of [[20, colours[0]], [38, colours[0]], [42, colours[1]], [60, colours[1]], [95, colours[2]]])
        assert.ok(row(page, y).every(c => c.every((v, j) => Math.abs(v - colour[j]) < 40)), `row ${y}`);
    // Four corners alone take in the black beside the folds.
    const flat = scanPixels(data, w, h, settings(w, h, { corners }));
    assert.ok(row(flat, 38).some(c => c.every(v => v < 40)));
});

test("the continuous mapping reaches all eight handles and agrees along every fold", () => {
    const corners = [[100, 20], [220, 60], [290, 380], [20, 330]], folds = scanFolds(corners);
    folds[0][0][0] -= 10; folds[0][1][1] += 20;
    folds[1][0][0] += 15; folds[1][1][0] -= 10;
    const geometry = scanGeometry(300, 400, settings(300, 400, { corners, folds }));
    const near = (a, b, tolerance = 1e-7) => assert.ok(distance(a, b) < tolerance, `${a} differs from ${b}`);
    const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    for (const [uv, point] of [[[0, 0], corners[0]], [[1, 0], corners[1]], [[1, 1], corners[2]], [[0, 1], corners[3]]]) near(scanPoint(geometry, ...uv), point);
    for (let i = 0; i < folds.length; i++) {
        const v = geometry.panels[i].end;
        near(scanPoint(geometry, 0, v), folds[i][0]);
        near(scanPoint(geometry, 1, v), folds[i][1]);
        for (let x = 0; x <= 20; x++) near(scanPoint(geometry, x / 20, v - 1e-9), scanPoint(geometry, x / 20, v + 1e-9), 1e-4);
    }
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

test("default eight-point handles preserve the four-corner scan under strong perspective", () => {
    const w = 300, h = 400, corners = [[100, 20], [220, 60], [290, 380], [20, 330]];
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([x % 251, y % 251, (x + y) % 251, 255], (y * w + x) * 4);
    const flat = scanPixels(data, w, h, settings(w, h, { corners }));
    const eight = scanPixels(data, w, h, settings(w, h, { corners, folds: scanFolds(corners) }));
    assert.deepEqual([eight.width, eight.height], [flat.width, flat.height]);
    assert.deepEqual(eight.data, flat.data, "activating unmoved fold handles must not warp the page");
});

test("a coordinate gradient stays continuous across moved folds, without horizontal jumps", () => {
    const w = 240, h = 320, corners = [[10, 10], [190, 30], [180, 290], [20, 280]];
    const folds = scanFolds(corners);
    folds[0][0][0] += 12; folds[0][1][1] += 15;
    const options = settings(w, h, { corners, folds }), geometry = scanGeometry(w, h, options);
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([x, y * .7, 0, 255], (y * w + x) * 4);
    const page = scanPixels(data, w, h, options);
    for (const part of geometry.panels.slice(1)) {
        const seam = Math.round(part.top), x = Math.floor(page.width / 2);
        const before = ((seam - 1) * page.width + x) * 4, after = (seam * page.width + x) * 4;
        const jump = Math.max(Math.abs(page.data[before] - page.data[after]), Math.abs(page.data[before + 1] - page.data[after + 1]));
        assert.ok(jump <= 3, `fold at row ${seam} has a ${jump}-level discontinuity`);
    }
});

test("smooth default guides preserve the four-corner image exactly under perspective", () => {
    const w = 300, h = 400, corners = [[100, 20], [220, 60], [290, 380], [20, 330]];
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < data.length; i++) data[i] = i % 4 === 3 ? 255 : i % 251;
    const plain = scanPixels(data, w, h, settings(w, h, { corners }));
    const curved = scanPixels(data, w, h, settings(w, h, { corners, folds: scanFolds(corners), surface: "smooth" }));
    assert.deepEqual(curved, plain);
    const bends = scanBends(corners);
    const explicit = scanPixels(data, w, h, settings(w, h, { corners, folds: scanFolds(corners), curves: bends, surface: "smooth" }));
    assert.deepEqual(explicit, plain);
});

test("bowed rules become straight rows, and smooth guide joins have matching slopes", () => {
    const w = 240, h = 180, options = settings(w, h, {
        surface: "smooth", folds: [[[0, 60], [w, 60]], [[0, 120], [w, 120]]], curves: [[120, 83], [120, 130]],
    });
    const data = new Uint8ClampedArray(w * h * 4).fill(255);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const u = (x + .5) / w, bow = 4 * u * (1 - u);
        if (Math.abs(y + .5 - (60 + 23 * bow)) < 2 || Math.abs(y + .5 - (120 + 10 * bow)) < 2)
            data.set([0, 0, 0, 255], (y * w + x) * 4);
    }
    const result = scanPixels(data, w, h, options), g = scanGeometry(w, h, options);
    for (const y of [60, 120]) for (let x = 3; x < w - 3; x++) assert.ok(result.data[(y * w + x) * 4] < 30, `rule at ${x}, ${y} is not straight`);
    assert.deepEqual(scanGuidePoint(g, 0, .5), [120, 83]);
    assert.deepEqual(scanGuidePoint(g, 1, .5), [120, 130]);
    for (const v of [1 / 3, 2 / 3]) for (const u of [.1, .5, .9]) {
        const e = 1e-5, a = scanPoint(g, u, v - e), b = scanPoint(g, u, v), c = scanPoint(g, u, v + e);
        const before = b.map((x, i) => (x - a[i]) / e), after = c.map((x, i) => (x - b[i]) / e);
        assert.ok(Math.hypot(before[0] - after[0], before[1] - after[1]) < .1, `slope jumps at ${u}, ${v}`);
    }
});

test("curved side boundaries meet their handles smoothly and sharp-fold recipes retain their mapping", () => {
    const options = settings(200, 240, { corners: [[20, 10], [180, 10], [180, 230], [20, 230]],
        folds: [[[12, 80], [190, 80]], [[26, 160], [174, 160]]], surface: "smooth" });
    const g = scanGeometry(200, 240, options);
    for (let i = 0; i < 2; i++) {
        const row = g.panels[i].end;
        for (const u of [0, 1]) {
            const point = scanPoint(g, u, row), want = options.folds[i][u];
            assert.ok(Math.hypot(point[0] - want[0], point[1] - want[1]) < 1e-8);
        }
    }
    const legacy = scanGeometry(200, 240, { ...options, surface: undefined });
    const sharp = scanGeometry(200, 240, { ...options, surface: "crease", curves: [[100, 90], [100, 170]] });
    for (const u of [0, .25, .5, 1]) for (const v of [0, .2, .5, .8, 1]) assert.deepEqual(scanPoint(sharp, u, v), scanPoint(legacy, u, v));
});

test("crossed, pinched and malformed curved guides are rejected and batch recipes retain curvature", () => {
    const base = settings(200, 240, { surface: "smooth", folds: [[[0, 80], [200, 80]], [[0, 160], [200, 160]]] });
    assert.throws(() => scanGeometry(200, 240, { ...base, curves: [[100, 190], [100, 130]] }), /cross|fold|squeeze/);
    assert.throws(() => scanGeometry(200, 240, { ...base, curves: [[2, 80], null] }), /middle point/);
    assert.throws(() => scanGeometry(200, 240, { ...base, curves: [[100, 100]] }), /curve point/);
    assert.throws(() => scanGeometry(200, 240, { ...base, curves: [[NaN, 100], null] }), /curve point/);
    const original = { kind: "scan", width: 200, height: 240, settings: { ...base, curves: [[100, 100], null] } };
    const scaled = scaleRecipe(original, 400, 720);
    assert.deepEqual(scaled.settings.curves, [[200, 300], null]);
    assert.equal(scaled.settings.surface, "smooth");
    assert.deepEqual(original.settings.curves, [[100, 100], null]);
});

// The quadratic through these three in-picture points dipped above Y=0
// between them, even though none of the editable handles was outside.
test("in-picture guide points keep inferred curves and the surface inside the picture", () => {
    const options = settings(200, 240, { surface: "smooth",
        folds: [[[0, 10], [200, 150]], [[0, 190], [200, 190]]], curves: [[100, 20], null] });
    const g = scanGeometry(200, 240, options);
    assert.deepEqual(scanGuidePoint(g, 0, .5), [100, 20]);
    for (let i = 0; i <= 100; i++) {
        const guide = scanGuidePoint(g, 0, i / 100);
        assert.ok(guide[0] >= -1e-8 && guide[0] <= 200 + 1e-8 && guide[1] >= -1e-8 && guide[1] <= 240 + 1e-8);
        for (let j = 0; j <= 100; j++) {
            const [x, y] = scanPoint(g, i / 100, j / 100);
            assert.ok(x >= -1e-8 && x <= 200 + 1e-8 && y >= -1e-8 && y <= 240 + 1e-8);
        }
    }
    assert.throws(() => scanGeometry(200, 240, { ...options, curves: [[100, -1], null] }), /curve point/);
});


test("narrow fold-overs between sampled rows are rejected before rendering", () => {
    const options = settings(400, 600, { surface: "smooth",
        corners: [[20, 20], [380, 20], [380, 580], [20, 580]],
        folds: [[[29, 254], [309, 220]], [[24, 344], [373, 335]]],
        curves: [[234, 211], [219, 300]],
    });
    // Previously accepted: the last output columns reversed near row 251,
    // even though every triangle in the coarse validation grid was positive.
    assert.throws(() => scanGeometry(400, 600, options), /fold over/);
    assert.throws(() => scanPixels(new Uint8ClampedArray(400 * 600 * 4), 400, 600, options), /fold over/);
    // Making the guides straight restores a usable scan with these sides.
    assert.doesNotThrow(() => scanGeometry(400, 600, { ...options, curves: undefined }));
});


test("horizontal refinement catches reversals between arc-length columns", () => {
    const options=settings(400,600,{surface:"smooth",corners:[[20,20],[380,20],[380,580],[20,580]],
        folds:[[[51.32431639358401,129.5684726559557],[324.6318786870688,72.80894197290763]],
            [[41.57387837767601,497.0267968904227],[363.15381270833313,377.41027099080384]]],
        curves:[[142.82764986157417,246.3348802854307],[186.98744677007198,410.36129508866]]});
    assert.throws(()=>scanGeometry(400,600,options),/fold over/);
});
