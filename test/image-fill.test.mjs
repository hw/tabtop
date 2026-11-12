import { test } from "node:test";
import assert from "node:assert/strict";
import { floodFill, validFill, inSelection } from "../tabtopd/image-fill.js";

// pixels is a width × height picture, each pixel colour(x, y) → [r, g, b, a].
function pixels(width, height, colour) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(colour(x, y), (y * width + x) * 4);
    return data;
}
const at = (data, width, x, y) => [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
const RED = [255, 0, 0, 255];

test("the area joined to the point, of its colour, is filled; not across a line, nor corner to corner", () => {
    // White, with a black line down x = 5.
    const w = 10, h = 4, data = pixels(w, h, (x) => x === 5 ? [0, 0, 0, 255] : [255, 255, 255, 255]);
    const n = floodFill(data, w, h, { points: [[1.5, 1.5]], color: "#ff0000", tolerance: 0, selection: null });
    assert.equal(n, 5 * 4);
    assert.deepEqual(at(data, w, 0, 0), RED);
    assert.deepEqual(at(data, w, 4, 3), RED);
    assert.deepEqual(at(data, w, 5, 0), [0, 0, 0, 255]);
    assert.deepEqual(at(data, w, 6, 0), [255, 255, 255, 255]);
    const diagonal = pixels(3, 3, (x, y) => x === y ? [255, 255, 255, 255] : [0, 0, 0, 255]);
    assert.equal(floodFill(diagonal, 3, 3, { points: [[0, 0]], color: "#ff0000", tolerance: 0, selection: null }), 1, "corners don't join");
});

test("tolerance takes in colours near the one clicked, alpha too, and each point fills in turn", () => {
    const w = 4, h = 1, data = pixels(w, h, (x) => [[100, 100, 100, 255], [110, 100, 100, 255], [140, 100, 100, 255], [100, 100, 100, 200]][x]);
    assert.equal(floodFill(data.slice(), w, h, { points: [[0, 0]], color: "#00ff00", tolerance: 0, selection: null }), 1);
    assert.equal(floodFill(data.slice(), w, h, { points: [[0, 0]], color: "#00ff00", tolerance: 5, selection: null }), 2);
    assert.equal(floodFill(data.slice(), w, h, { points: [[0, 0]], color: "#00ff00", tolerance: 20, selection: null }), 3, "alpha 200 is 55 away");
    assert.equal(floodFill(data.slice(), w, h, { points: [[0, 0]], color: "#00ff00", tolerance: 100, selection: null }), 4);
    const both = data.slice();
    assert.equal(floodFill(both, w, h, { points: [[0, 0], [3, 0]], color: "#00ff00", tolerance: 0, selection: null }), 2);
    assert.deepEqual(at(both, w, 3, 0), [0, 255, 0, 255], "filled made opaque");
});

test("a fill stays within its selection; one from outside it fills nothing", () => {
    const w = 10, h = 10, white = () => [255, 255, 255, 255];
    let data = pixels(w, h, white);
    assert.equal(floodFill(data, w, h, { points: [[3, 3]], color: "#ff0000", tolerance: 0, selection: { shape: "rect", x: 2, y: 2, width: 4, height: 3 } }), 12);
    assert.deepEqual(at(data, w, 1, 3), [255, 255, 255, 255]);
    data = pixels(w, h, white);
    assert.equal(floodFill(data, w, h, { points: [[0, 0]], color: "#ff0000", tolerance: 0, selection: { shape: "rect", x: 2, y: 2, width: 4, height: 3 } }), 0);
    data = pixels(w, h, white);
    const n = floodFill(data, w, h, { points: [[5, 5]], color: "#ff0000", tolerance: 0, selection: { shape: "circle", x: 0, y: 0, width: 10, height: 10 } });
    assert.ok(n > 60 && n < 100, `${n} pixels in a circle`);
    assert.deepEqual(at(data, w, 0, 0), [255, 255, 255, 255], "the corner's outside the circle");
    assert.equal(inSelection({ shape: "circle", x: 0, y: 0, width: 0, height: 4 })(0, 0), false);
});

test("fills are checked", () => {
    const ok = { points: [[1, 2]], color: "#123abc", tolerance: 50, selection: null };
    assert.equal(validFill(ok), ok);
    for (const bad of [{ points: [] }, { points: [[1]] }, { points: [[1, NaN]] }, { points: Array.from({ length: 101 }, () => [0, 0]) },
        { color: "red" }, { tolerance: -1 }, { tolerance: 101 }, { selection: { shape: "star", x: 0, y: 0, width: 1, height: 1 } },
        { selection: { shape: "rect", x: 0, y: 0, width: -1, height: 1 } }]) {
        assert.throws(() => validFill({ ...ok, ...bad }), /can be done/);
    }
});


test("inverted rectangle and circle selections fill the complement and retain excluded pixels", () => {
    for (const shape of ["rect", "circle"]) {
        const s = { shape, x: 2, y: 2, width: 4, height: 4 }, normal = inSelection(s), inverse = inSelection({ ...s, inverted: true });
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) assert.notEqual(normal(x, y), inverse(x, y));
        const data = pixels(8, 8, () => [255, 255, 255, 255]);
        const filled = floodFill(data, 8, 8, { points: [[0, 0]], color: "#000000", tolerance: 0, selection: { ...s, inverted: true } });
        assert.ok(filled > 40);
        assert.deepEqual([...data.slice((3 * 8 + 3) * 4, (3 * 8 + 3) * 4 + 4)], [255, 255, 255, 255]);
        assert.deepEqual([...data.slice(0, 4)], [0, 0, 0, 255]);
    }
});
