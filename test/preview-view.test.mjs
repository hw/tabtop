import { test } from "node:test";
import assert from "node:assert/strict";
import { previewView } from "../tabtopd/preview-view.js";

test("preview handles release their resources once and don't restore stopped views", () => {
    const calls = [];
    const element = { stop() { calls.push("stop"); }, restore(at) { calls.push(at); }, update(html) { calls.push(html); } };
    const view = previewView(element);
    assert.equal(view.element, element);
    view.restore({ top: 50 });
    view.update("new HTML");
    view.stop(); view.stop();
    view.restore({ top: 100 }); view.update("stale HTML");
    assert.deepEqual(calls, [{ top: 50 }, "new HTML", "stop"]);
});

test("plain content gets the same controller lifecycle without frame methods", () => {
    const element = {};
    const view = previewView(element);
    assert.equal(view.element, element);
    assert.equal(view.restore, undefined);
    view.stop(); view.stop();
});
