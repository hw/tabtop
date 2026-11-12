import { test } from "node:test";
import assert from "node:assert/strict";
import { drawShape, validShape, hexColor } from "../tabtopd/image-draw.js";

// A canvas context that records what's done with it.
function recorder() {
    const calls = [];
    const ctx = new Proxy({ calls }, {
        get: (target, key) => key in target ? target[key] : (...args) => calls.push([key, ...args]),
        set: (target, key, value) => { calls.push([`=${String(key)}`, value]); return true; },
    });
    return { ctx, calls };
}
const rect = { x: 10, y: 20, width: 30, height: 40 };

test("a filled rectangle fills its rectangle, in its colour", () => {
    const { ctx, calls } = recorder();
    drawShape(ctx, { shape: "rect", mode: "fill", color: "#123456", rect });
    assert.deepEqual(calls.find(c => c[0] === "rect"), ["rect", 10, 20, 30, 40]);
    assert.ok(calls.some(c => c[0] === "=fillStyle" && c[1] === "#123456"));
    assert.ok(calls.some(c => c[0] === "fill") && !calls.some(c => c[0] === "stroke"));
});

test("an outline is drawn inside its shape; one too thick for it is filled", () => {
    let { ctx, calls } = recorder();
    drawShape(ctx, { shape: "rect", mode: "outline", color: "#000000", line: 4, rect });
    assert.deepEqual(calls.find(c => c[0] === "rect"), ["rect", 12, 22, 26, 36]);
    assert.ok(calls.some(c => c[0] === "=lineWidth" && c[1] === 4) && calls.some(c => c[0] === "stroke"));
    ({ ctx, calls } = recorder());
    drawShape(ctx, { shape: "circle", mode: "outline", color: "#000000", line: 4, rect });
    assert.deepEqual(calls.find(c => c[0] === "ellipse").slice(1, 5), [25, 40, 13, 18]);
    ({ ctx, calls } = recorder());
    drawShape(ctx, { shape: "circle", mode: "outline", color: "#000000", line: 40, rect });
    assert.deepEqual(calls.find(c => c[0] === "ellipse").slice(1, 5), [25, 40, 15, 20]);
    assert.ok(calls.some(c => c[0] === "fill") && !calls.some(c => c[0] === "stroke"));
});

test("nothing's drawn for an empty shape, and a bad one is refused", () => {
    const { ctx, calls } = recorder();
    drawShape(ctx, { shape: "rect", mode: "fill", color: "#000000", rect: { x: 0, y: 0, width: 0, height: 5 } });
    assert.equal(calls.length, 0);
    for (const bad of [{ shape: "star" }, { color: "red" }, { color: "#00000g" }, { mode: "outline", line: 0 }, { mode: "outline", line: 1e6 },
        { rect: { x: NaN, y: 0, width: 1, height: 1 } }, { rect: { x: 0, y: 0, width: -1, height: 1 } }]) {
        assert.throws(() => validShape({ shape: "rect", mode: "fill", color: "#000000", rect, ...bad }), /can be drawn/);
    }
});

test("a picked colour is written as #rrggbb", () => {
    assert.equal(hexColor([255, 0, 16, 128]), "#ff0010");
    assert.equal(hexColor(new Uint8ClampedArray([1, 2, 3, 4])), "#010203");
});

test("a pen's strokes are one line, a dot for a single point; a highlighter's see-through and multiplied", () => {
    let { ctx, calls } = recorder();
    drawShape(ctx, { shape: "pen", mode: "outline", color: "#0000ff", line: 3, strokes: [[1, 2, 3, 4, 5, 6], [10, 10]] });
    assert.deepEqual(calls.filter(c => ["moveTo", "lineTo"].includes(c[0])), [["moveTo", 1, 2], ["lineTo", 3, 4], ["lineTo", 5, 6], ["moveTo", 10, 10], ["lineTo", 10.01, 10]]);
    assert.equal(calls.filter(c => c[0] === "stroke").length, 1, "one stroke, so crossings aren't darker");
    assert.ok(calls.some(c => c[0] === "=lineCap" && c[1] === "round"));
    assert.ok(!calls.some(c => c[0] === "=globalAlpha"));
    ({ ctx, calls } = recorder());
    drawShape(ctx, { shape: "pen", mode: "highlight", color: "#ffff00", line: 12, strokes: [[1, 2, 3, 4]] });
    assert.ok(calls.some(c => c[0] === "=globalAlpha" && c[1] === 0.4) && calls.some(c => c[0] === "=globalCompositeOperation" && c[1] === "multiply"));
    ({ ctx, calls } = recorder());
    drawShape(ctx, { shape: "rect", mode: "highlight", color: "#ffff00", line: 4, rect });
    assert.ok(calls.some(c => c[0] === "fill") && calls.some(c => c[0] === "=globalAlpha" && c[1] === 0.4));
});

test("a pen's strokes are checked", () => {
    const pen = { shape: "pen", mode: "outline", color: "#000000", line: 2, strokes: [[0, 0, 1, 1]] };
    assert.equal(validShape(pen), pen);
    for (const bad of [{ strokes: [] }, { strokes: [[0]] }, { strokes: [[0, 0, 1]] }, { strokes: [[0, NaN]] }, { strokes: "x" }, { mode: "fill" }, { line: undefined },
        { strokes: Array.from({ length: 501 }, () => [0, 0]) }]) {
        assert.throws(() => validShape({ ...pen, ...bad }), /can be drawn/);
    }
});
