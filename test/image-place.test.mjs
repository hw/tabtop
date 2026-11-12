import { test } from "node:test";
import assert from "node:assert/strict";
import { drawPlacement, validPlacement, pastedPicture } from "../tabtopd/image-place.js";

test("a placed picture is drawn where it's placed, as see-through as asked", () => {
    const calls = [];
    const ctx = new Proxy({}, { get: (_, key) => (...args) => calls.push([key, ...args]), set: (_, key, value) => { calls.push([`=${String(key)}`, value]); return true; } });
    const image = { picture: true };
    drawPlacement(ctx, { rect: { x: 5, y: 6, width: 70, height: 80 }, opacity: 0.5 }, image);
    assert.deepEqual(calls.find(c => c[0] === "drawImage"), ["drawImage", image, 5, 6, 70, 80]);
    assert.ok(calls.some(c => c[0] === "=globalAlpha" && c[1] === 0.5));
    calls.length = 0;
    drawPlacement(ctx, { rect: { x: 0, y: 0, width: 0.5, height: 10 }, opacity: 1 }, image);
    assert.equal(calls.length, 0, "nothing for an area too small to see");
});

test("placements are checked", () => {
    const ok = { rect: { x: -5, y: 0, width: 1, height: 1 }, opacity: 1 };
    assert.equal(validPlacement(ok), ok);
    for (const bad of [{ opacity: 0 }, { opacity: 1.5 }, { opacity: NaN }, { rect: { x: 0, y: 0, width: -1, height: 1 } }, { rect: null }]) {
        assert.throws(() => validPlacement({ ...ok, ...bad }), /can be placed/);
    }
});

test("the picture pasted is the clipboard's image file, if there is one", () => {
    const png = { type: "image/png" }, text = { type: "text/plain" };
    assert.equal(pastedPicture({ clipboardData: { files: [text, png], items: [] } }), png);
    assert.equal(pastedPicture({ clipboardData: { files: [], items: [{ kind: "file", type: "image/jpeg", getAsFile: () => "jpeg" }] } }), "jpeg");
    assert.equal(pastedPicture({ clipboardData: { files: [text], items: [{ kind: "string", type: "text/plain" }] } }), null);
    assert.equal(pastedPicture({}), null);
});
