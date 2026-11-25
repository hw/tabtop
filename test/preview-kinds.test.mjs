// Each kind of file file-types.json names is one a preview has a limit
// for (preview-model.js; the loaders and renderers check against those
// as they load), and the view toggle's rules (toggleView).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { limits, toggleView } from "../tabtopd/preview-model.js";

test("every kind of file has a preview limit", () => {
    const types = JSON.parse(readFileSync(new URL("../tabtopd/file-types.json", import.meta.url), "utf8"));
    const kinds = new Set(Object.values(types).map((t) => t.kind));
    for (const kind of kinds) assert.ok(Object.hasOwn(limits, kind), `${kind} has no limit`);
});

test("the view toggle: a database's tables and bytes, a model's drawing and text, text and bytes", () => {
    assert.deepEqual(toggleView({ kind: "sqlite", name: "a.db", sqlite: true }), { hidden: false, to: "hex", icon: "binary", title: "Show binary view", pressed: false });
    assert.deepEqual(toggleView({ kind: "hex", name: "a.db", sqlite: true }), { hidden: false, to: "sqlite", icon: "preview", title: "Show tables", pressed: true });
    assert.deepEqual(toggleView({ kind: "model", name: "part.gcode" }), { hidden: false, to: "text", icon: "syntax", title: "Show text view", pressed: false });
    assert.deepEqual(toggleView({ kind: "model", name: "part.stl" }), { hidden: false, to: "hex", icon: "binary", title: "Show binary view", pressed: false });
    assert.deepEqual(toggleView({ kind: "text", name: "part.obj" }), { hidden: false, to: null, icon: "preview", title: "Show 3D view", pressed: true });
    assert.equal(toggleView({ kind: "text", name: "part.obj", modelUnavailable: true }).hidden, true, "not back to a drawing it can't be");
    assert.deepEqual(toggleView({ kind: "text", name: "notes.xyz" }), { hidden: false, to: "hex", icon: "binary", title: "Show binary view", pressed: false });
    assert.equal(toggleView({ kind: "hex", name: "blob.xyz", textAvailable: false }).hidden, true, "bytes that aren't text");
    assert.equal(toggleView({ kind: "image", name: "a.png" }).hidden, true, "a known type");
});
