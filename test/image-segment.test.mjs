import { test } from "node:test";
import assert from "node:assert/strict";
import { samSize, samPrompt, grow, selectionMark, objectSelection, objectBounds } from "../tabtopd/image-segment.js";
import { floodFill, validFill } from "../tabtopd/image-fill.js";
import { maskBounds } from "../tabtopd/image-mask.js";
import { scaleRecipe, describeStep } from "../tabtopd/image-batch.js";

test("pictures are analysed with their longest side 1024 pixels, larger or smaller", () => {
    assert.deepEqual(samSize(2048, 1536), { width: 1024, height: 768, scale: .5 });
    assert.deepEqual(samSize(300, 400), { width: 768, height: 1024, scale: 1024 / 400 });
    assert.throws(() => samSize(0, 10), /no picture/);
});

test("a click is a point and a padding point; a box is its two corners", () => {
    const click = samPrompt({ point: [100, 50] }, .5);
    assert.deepEqual([...click.coords], [50, 25, 0, 0]);
    assert.deepEqual([...click.labels], [1, -1]);
    const box = samPrompt({ box: [10, 20, 100, 60] }, 2);
    assert.deepEqual([...box.coords], [20, 40, 220, 160]);
    assert.deepEqual([...box.labels], [2, 3]);
    assert.throws(() => samPrompt({}, 1), /Click an object/);
});

test("a selection grows past its outline, in every direction", () => {
    const w = 7, h = 7, mask = new Uint8Array(w * h);
    mask[3 * w + 3] = 1;
    const grown = grow(mask, w, h, 2);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
        assert.equal(grown[y * w + x], Math.abs(x - 3) <= 2 && Math.abs(y - 3) <= 2 ? 1 : 0, `${x},${y}`);
    assert.equal(grow(mask, w, h, 0), mask);
});

test("a selection becomes a fill mark over the picture, its rows of pixels scaled to it", () => {
    // At the analysed size (4 × 2), the picture being 8 × 4.
    const mask = Uint8Array.from([0, 1, 1, 0, 1, 1, 0, 1]);
    const mark = selectionMark(mask, 4, 2, 8, 4);
    assert.deepEqual(mark.fill.spans, [[0, 1, 2], [1, 0, 1], [1, 3, 3]]);
    assert.deepEqual(mark.fill.bounds, { x: 0, y: 0, width: 4, height: 2 });
    assert.deepEqual(mark.scale, [2, 2]);
    assert.equal(mark.erase, false);
    // As any mark is: its bounds in the picture's pixels, and scaled to other pages.
    assert.deepEqual(maskBounds([mark], 8, 4), { left: 0, top: 0, right: 8, bottom: 4 });
    const page = scaleRecipe({ kind: "inpaint", width: 8, height: 4, marks: [mark] }, 16, 8);
    assert.deepEqual(page.marks[0].scale, [4, 4]);
    assert.equal(selectionMark(new Uint8Array(8), 4, 2, 8, 4), null);
    assert.equal(selectionMark(mask, 4, 2, 8, 4, true).erase, true);
    assert.throws(() => selectionMark(mask, 3, 2, 8, 4), /Invalid/);
});

test("objects kept in background removal are scaled to other pages, and said", () => {
    const mark = selectionMark(Uint8Array.from([0, 1, 1, 0, 1, 1, 0, 1]), 4, 2, 8, 4);
    const step = { kind: "background", width: 8, height: 4, settings: { threshold: 50, softness: 100, grow: 0 }, selection: null, strokes: [], objects: [mark, { ...mark, erase: true }] };
    assert.deepEqual(scaleRecipe(step, 16, 8).objects.map(o => o.scale), [[4, 4], [4, 4]]);
    assert.equal(describeStep(step), "Remove background, keeping 1 object");
    assert.equal(describeStep({ ...step, objects: undefined }), "Remove background");
    assert.ok(!scaleRecipe({ ...step, objects: [] }, 16, 8).objects?.length);
});

test("an object found is the paint bucket's selection: its outline, over its bounds", () => {
    // At the analysed size, 4 × 4: an L of three pixels; the picture is 8 × 8.
    const mask = new Uint8Array(16);
    mask[1 * 4 + 1] = mask[2 * 4 + 1] = mask[2 * 4 + 2] = 1;
    const selection = objectSelection(mask, 4, 4, 8, 8);
    assert.deepEqual(selection, { shape: "object", x: 2, y: 2, width: 4, height: 4, mask: { width: 2, height: 2, spans: [[0, 0, 0], [1, 0, 1]] } });
    // A fill over a plain picture stays in the L: 3 of its 4 quarters of the box.
    const data = new Uint8ClampedArray(8 * 8 * 4).fill(255);
    const fill = { points: [[3, 3]], color: "#ff0000", tolerance: 0, selection };
    assert.equal(floodFill(data, 8, 8, fill), 12);
    assert.deepEqual([...data.slice((5 * 8 + 5) * 4, (5 * 8 + 5) * 4 + 3)], [255, 0, 0]);
    assert.deepEqual([...data.slice((3 * 8 + 5) * 4, (3 * 8 + 5) * 4 + 3)], [255, 255, 255], "the L's missing corner");
    // Inverted: everywhere else.
    const outside = new Uint8ClampedArray(8 * 8 * 4).fill(255);
    assert.equal(floodFill(outside, 8, 8, { ...fill, points: [[0, 0]], selection: { ...selection, inverted: true } }), 64 - 12);
    // Scaled to another page with its bounds, and said.
    const page = scaleRecipe({ kind: "fill", width: 8, height: 8, ...fill }, 16, 16);
    assert.deepEqual([page.selection.x, page.selection.width, page.selection.mask.width], [4, 8, 2]);
    assert.equal(describeStep({ kind: "fill", ...fill }), "Fill 1 area #ff0000 within an object");
    assert.equal(objectSelection(new Uint8Array(16), 4, 4, 8, 8), null);
});
test("an object's outline must fit its own size", () => {
    const fill = (mask) => ({ points: [[1, 1]], color: "#000000", tolerance: 0, selection: { shape: "object", x: 0, y: 0, width: 4, height: 4, mask } });
    assert.throws(() => validFill(fill({ width: 2, height: 2, spans: [[2, 0, 0]] })), /fill/);
    assert.throws(() => validFill(fill({ width: 2, height: 2, spans: [[0, 1, 0]] })), /fill/);
    assert.throws(() => validFill(fill({ width: 0, height: 2, spans: [] })), /fill/);
    assert.throws(() => validFill(fill(undefined)), /fill/);
    assert.ok(validFill(fill({ width: 2, height: 2, spans: [[1, 0, 1]] })));
});
test("a crop to an object is its bounds, in whole pixels of the picture", () => {
    const mask = new Uint8Array(16);
    mask[1 * 4 + 1] = mask[2 * 4 + 2] = 1;
    assert.deepEqual(objectBounds(mask, 4, 4, 10, 10), { x: 2, y: 2, width: 6, height: 6 });
    assert.equal(objectBounds(new Uint8Array(16), 4, 4, 10, 10), null);
});

test("removed and added-back objects edit U2NetP's cutout; Keep all objects replaces it", async () => {
    const { needsFound } = await import("../tabtopd/image-background.js");
    const mark = selectionMark(Uint8Array.from([1, 0, 0, 0]), 2, 2, 4, 4);
    assert.equal(needsFound([{ ...mark, erase: true }, mark]), true);
    assert.equal(needsFound([{ ...mark, only: true }, { ...mark, erase: true }]), false);
    assert.equal(needsFound(undefined), true);
    const step = { kind: "background", width: 4, height: 4, settings: {}, strokes: [], objects: [{ ...mark, only: true }] };
    assert.equal(scaleRecipe(step, 8, 8).objects[0].only, true);
});
