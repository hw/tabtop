// The page's EME shim (tabtopd/goeme.js) in embedded pages: a frame of
// the page's origin tells the page's document, which its agent reads; a
// command leaves a page's queue only once the agent's taken it; and two
// windows telling one agent each get their own answers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../tabtopd/goeme.js", import.meta.url), "utf8");

class MouseEvent extends Event {
    constructor(type, init = {}) { super(type, init); this.relatedTarget = init.relatedTarget ?? null; }
}

// win runs goeme.js in a window whose own document is doc and whose parent
// is parent (a window of the same origin: its document reachable).
function win(doc, parent) {
    const context = vm.createContext({ Promise, Map, WeakMap, WeakSet, Set, Symbol, Error, RangeError, TypeError, JSON, Object, Array, String, Number, Math,
        Uint8Array, ArrayBuffer, btoa, atob, clearTimeout, EventTarget, Event, CustomEvent, MouseEvent,
        setTimeout: (f, ms) => { const t = setTimeout(f, ms); t.unref?.(); return t; } });
    vm.runInContext(`
        class DOMException extends Error { constructor(message, name) { super(message); this.name = name; } }
        class HTMLMediaElement extends EventTarget {}
        globalThis.window = globalThis;
        globalThis.location = { protocol: "https:" };
        globalThis.navigator = {};
        Object.assign(globalThis, { DOMException, HTMLMediaElement });
    `, context);
    context.document = doc;
    context.parent = parent ?? context;
    vm.runInContext(source, context);
    return context;
}

// agent reads doc's commands as the agent does (goagent.js): so many a
// batch, each taken cancelled.
function agent(doc, perBatch = 4) {
    let batch = [];
    doc.addEventListener("__tabtop_eme_command", (e) => {
        if (batch.length >= perBatch) return;
        batch.push(JSON.parse(e.detail));
        e.preventDefault();
    });
    return () => {
        batch = [];
        doc.dispatchEvent(new Event("__tabtop_read_eme"));
        return batch;
    };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("a command the agent doesn't take this batch is kept for the next", async () => {
    const doc = new EventTarget();
    const page = win(doc);
    const read = agent(doc);
    for (let i = 0; i < 6; i++) page.navigator.requestMediaKeySystemAccess("org.w3.clearkey", [{}]).catch(() => {});
    await tick();
    const first = read(), second = read(), third = read();
    assert.equal(first.length, 4);
    assert.equal(second.length, 2);
    assert.equal(third.length, 0);
    assert.equal(new Set([...first, ...second].map((c) => c.request)).size, 6);
});

test("a frame of the page's origin tells the page's document; each window gets its own answers", async () => {
    const top = new EventTarget(), inner = new EventTarget();
    const page = win(top);
    const frame = win(inner, page);
    const read = agent(top);
    const a = page.navigator.requestMediaKeySystemAccess("org.w3.clearkey", [{}]);
    const b = frame.navigator.requestMediaKeySystemAccess("org.w3.clearkey", [{}]);
    await tick();
    const got = read();
    assert.equal(got.length, 2, "both windows' requests, on the page's document");
    assert.notEqual(got[0].request, got[1].request, "their numbers apart");
    // Answered (as the agent does, on the page's document): each its own.
    for (const [i, c] of got.entries()) {
        top.dispatchEvent(new CustomEvent("__tabtop_eme_reply", { detail: JSON.stringify({ request: c.request, value: { system: "org.w3.clearkey", handle: 10 + i, config: { n: i } } }) }));
    }
    const [x, y] = await Promise.all([a, b]);
    assert.deepEqual([x.handle, y.handle].sort(), [10, 11], "each given an answer, not the other's");
});
