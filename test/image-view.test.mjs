import { test } from "node:test";
import assert from "node:assert/strict";
import { animated, describe, saveIntent, savePlan, editRecipe } from "../tabtopd/image-view.js";

const bytes = (...parts) => Uint8Array.from(parts.flatMap((p) => typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p));

test("animated pictures: a looping GIF, an APNG, an animated WebP; not their still kinds", () => {
    assert.equal(animated(bytes("GIF89a", [0, 0, 0, 0], "!\xff\x0bNETSCAPE2.0"), "image/gif"), true);
    assert.equal(animated(bytes("GIF89a", [0, 0, 0, 0, 0x2c]), "image/gif"), false);
    const png = (...chunks) => bytes([0x89], "PNG\r\n\x1a\n", ...chunks.flatMap((c) => [[0, 0, 0, 0], c, [0, 0, 0, 0]]));
    assert.equal(animated(png("IHDR", "acTL", "IDAT"), "image/png"), true);
    assert.equal(animated(png("IHDR", "IDAT", "acTL"), "image/png"), false, "an acTL after the image data isn't an APNG's");
    const webp = (flags) => bytes("RIFF", [0, 0, 0, 0], "WEBPVP8X", [10, 0, 0, 0], [flags]);
    assert.equal(animated(webp(0x02), "image/webp"), true);
    assert.equal(animated(webp(0x10), "image/webp"), false);
    assert.equal(animated(bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 "), "image/webp"), false);
    assert.equal(animated(bytes([0xff, 0xd8]), "image/jpeg"), false);
});

test("what a picture is: its size in pixels, format, bytes, and whether it moves", () => {
    assert.equal(describe({ width: 1920, height: 1080, type: "image/jpeg", size: 2_200_000 }), "1,920×1,080 · JPEG · 2.1 MB");
    assert.equal(describe({ width: 16, height: 16, type: "image/gif", size: 900, moving: true }), "16×16 · GIF · 900 B · animated");
    assert.equal(describe({ width: 300, height: 150, type: "image/svg+xml" }), "300×150 · SVG");
});

test("what Save will do, and says it will: copy, strip losslessly, write again (keeping metadata or not), or nothing", () => {
    const base = { type: "image/jpeg", target: "image/jpeg", quality: 92, kinds: ["EXIF", "XMP"], keep: true, edited: false, dirty: false, name: "a.jpeg" };
    const plan = (o) => savePlan(saveIntent({ ...base, ...o }), { type: o.type ?? base.type, kinds: o.kinds ?? base.kinds, orientation: o.orientation ?? 1 });
    assert.equal(saveIntent(base).how, null);
    assert.equal(plan({}), "");
    assert.deepEqual(saveIntent({ ...base, target: "image/png" }), { how: "copy", target: "image/png", q: 92, name: "a.png" });
    assert.match(plan({ target: "image/webp", quality: 80 }), /copy as a\.webp \(WebP at 80%\), without metadata/);
    // Only the metadata unticked: removed losslessly; with anything else, written again.
    assert.equal(saveIntent({ ...base, keep: false, dirty: true }).how, "strip");
    assert.match(plan({ keep: false, dirty: true, orientation: 6 }), /removes its EXIF, XMP, losslessly \(keeping only which way up/);
    assert.deepEqual(saveIntent({ ...base, keep: false, dirty: true, edited: true }), { how: "encode", target: "image/jpeg", q: 92, kept: false });
    assert.match(plan({ edited: true, dirty: true, quality: 70 }), /again as JPEG at 70%, keeping its EXIF, XMP/);
    // A WebP's metadata isn't kept written again; nor is there any to keep.
    assert.equal(saveIntent({ ...base, type: "image/webp", target: "image/webp", edited: true, dirty: true }).kept, false);
    assert.equal(saveIntent({ ...base, kinds: [], edited: true, dirty: true }).kept, false);
    // A format that can't be written: Save makes a copy.
    assert.match(savePlan({ how: null, q: 92 }, { type: "image/gif", kinds: [], orientation: 1 }), /GIF can't be written here/);
});

test("a shape drawn is a step of the recipe, at the size it was drawn on", () => {
    const draw = { shape: "rect", mode: "fill", color: "#ff0000", rect: { x: 1, y: 2, width: 3, height: 4 } };
    const recipe = editRecipe(100, 50, ["left", { draw }]);
    assert.deepEqual(recipe.steps[1], { kind: "draw", width: 50, height: 100, ...draw });
    assert.notEqual(recipe.steps[1].rect, draw.rect);
    assert.equal(recipe.committed, 2);
});

test("a picture placed is a step of the recipe, kept as its file", () => {
    const blob = new Blob(["x"]), paste = { rect: { x: 1, y: 2, width: 3, height: 4 }, opacity: 0.5, blob, image: {} };
    const step = editRecipe(10, 20, [{ paste }]).steps[0];
    assert.deepEqual(step, { kind: "paste", width: 10, height: 20, rect: paste.rect, opacity: 0.5, blob });
    assert.equal(step.blob, blob);
    assert.equal("image" in step, false);
});

test("an area filled is a step of the recipe", () => {
    const fill = { points: [[1, 2]], color: "#00ff00", tolerance: 10, selection: null };
    assert.deepEqual(editRecipe(10, 20, [{ fill }]).steps[0], { kind: "fill", width: 10, height: 20, ...fill });
});
