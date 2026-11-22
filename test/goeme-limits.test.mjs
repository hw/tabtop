// The page's EME shim (tabtopd/goeme.js): its limits on what's asked of
// the viewer at once.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../tabtopd/goeme.js", import.meta.url), "utf8");

function page() {
    const context = vm.createContext({ Promise, Map, WeakMap, Set, Symbol, Error, RangeError, TypeError, JSON, Object, Array, String, Number, Uint8Array, ArrayBuffer, btoa, atob, clearTimeout,
        setTimeout: (f, ms) => { const t = setTimeout(f, ms); t.unref?.(); return t; } });  // (its 30 s time-outs not holding the test)
    vm.runInContext(`
        class EventTarget { addEventListener() {} removeEventListener() {} dispatchEvent() { return true; } }
        class Event { constructor(type) { this.type = type; } }
        class CustomEvent extends Event {}
        class MouseEvent extends Event {}
        class DOMException extends Error { constructor(message, name) { super(message); this.name = name; } }
        class HTMLMediaElement extends EventTarget {}
        globalThis.window = globalThis; globalThis.top = globalThis;
        globalThis.location = { protocol: "https:" };
        globalThis.navigator = {};
        globalThis.document = new EventTarget();
        Object.assign(globalThis, { EventTarget, Event, CustomEvent, MouseEvent, DOMException, HTMLMediaElement });
    `, context);
    vm.runInContext(source, context);
    return context;
}

test("format probes in flight don't use up the room for a player's other EME calls", async () => {
    const ctx = page();
    // A player's probes, not yet answered (the agent hands them over 4 at a time).
    for (let i = 0; i < 40; i++) ctx.navigator.mediaCapabilities.decodingInfo({ type: "media-source" }).catch(() => {});
    let refused = null;
    const access = ctx.navigator.requestMediaKeySystemAccess("com.widevine.alpha", [{}]).catch((e) => { refused = e; });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(refused?.message, undefined, `refused: ${refused?.message}`);
    // Probes still have theirs, past the others' 32.
    for (let i = 0; i < 100; i++) ctx.navigator.mediaCapabilities.decodingInfo({ type: "media-source" }).catch((e) => { refused = e; });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(refused?.message, undefined, `a probe refused: ${refused?.message}`);
    void access;
});

test("other EME calls are still held to 32 at once", async () => {
    const ctx = page();
    const results = [];
    for (let i = 0; i < 33; i++) results.push(ctx.navigator.requestMediaKeySystemAccess("com.widevine.alpha", [{}]).then(() => "ok", (e) => e.message));
    await new Promise((r) => setTimeout(r, 0));
    const settled = await Promise.race([results[32], new Promise((r) => setTimeout(() => r("pending"), 10))]);
    assert.equal(settled, "EME request limit");
});
