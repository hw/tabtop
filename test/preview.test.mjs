import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// Classification needs no browser or tunnel. Stub only the preview's transport
// import, so these checks exercise the real exported classifier.
const previewURL = new URL("../tabtopd/preview.js", import.meta.url).href;
const hooks = registerHooks({
    resolve(specifier, context, next) {
        if (context.parentURL === previewURL && specifier === "./requests.js") {
            return { shortCircuit: true, url: "data:text/javascript,export const call = () => { throw new Error('transport not expected'); }; export const collect = call, saveBlob = call;" };
        }
        return next(specifier, context);
    },
});
let previewable;
try { ({ previewable } = await import(previewURL)); } finally { hooks.deregister(); }

test("inherited property names are ordinary unsupported extensions", () => {
    for (const name of ["report.constructor", "report.__proto__", "report.CONSTRUCTOR"]) {
        assert.equal(previewable(name, 1), false);
    }
});

test("known preview types retain their size limits and case handling", () => {
    assert.equal(previewable("photo.PNG", 50e6), true);
    assert.equal(previewable("photo.png", 50e6 + 1), false);
    assert.equal(previewable("notes.txt", 2e6), true);
    assert.equal(previewable("notes.txt", 2e6 + 1), false);
    assert.equal(previewable("README", 10), true);
    assert.equal(previewable("archive.zip", 10), false);
});
