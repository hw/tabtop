import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { hexDump, hexView, createHexRangeSource } from "../tabtopd/hex-view.js";
import { typeOf, limits, binaryChunkSize } from "../tabtopd/preview-model.js";

test("hex rows preserve offsets, all bytes, ASCII boundaries and final-row alignment", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const rows = hexDump(bytes).split("\n");
    assert.equal(rows.length, 16);
    for (let i = 0; i < rows.length; i++) {
        assert.equal(rows[i].slice(0, 8), (i * 16).toString(16).padStart(8, "0"));
        assert.deepEqual(rows[i].slice(10, 58).trim().split(/\s+/),
            Array.from(bytes.slice(i * 16, i * 16 + 16), b => b.toString(16).padStart(2, "0")));
    }
    assert.match(rows[1], /\|\.{16}\|$/);
    assert.match(rows[2], /\| !"#\$%&'\(\)\*\+,-\.\/\|$/);
    assert.match(rows[7], /\|pqrstuvwxyz\{\|\}~\.\|$/);
    const partial = hexDump(Uint8Array.of(60, 38, 0, 255));
    assert.equal(partial.indexOf("|"), rows[0].indexOf("|"));
    assert.match(partial, /\|<&\.\. {12}\|$/);
    assert.equal(hexDump(new Uint8Array()), "");
    assert.match(hexDump(bytes, 16, 18), /^00000010  10 11/);
});

test("hex view pages retain absolute offsets and render bytes as inert text", () => {
    const oldDocument = globalThis.document;
    globalThis.document = { createElement: tag => ({ tag, children: [], listeners: {},
        append(...children) { this.children.push(...children); },
        addEventListener(name, fn) { this.listeners[name] = fn; } }) };
    try {
        const bytes = new Uint8Array(4097).fill(60);
        const view = hexView(bytes);
        const [controls, content] = view.children;
        const [previous, status, next] = controls.children;
        assert.equal(previous.disabled, true);
        assert.equal(next.disabled, false);
        assert.equal(content.textContent.split("\n").length, 256);
        next.listeners.click();
        assert.match(content.textContent, /^00001000  3c/);
        assert.match(content.textContent, /\|< {15}\|$/);
        assert.equal(content.innerHTML, undefined);
        assert.equal(next.disabled, true);
        assert.match(status.textContent, /4,096/);
        previous.listeners.click();
        assert.match(content.textContent, /^00000000/);
        assert.equal(previous.disabled, true);
        assert.equal(hexView(new Uint8Array()).textContent, "This file is empty.");
    } finally {
        globalThis.document = oldDocument;
    }
});

test("unknown previews explicitly select text or hex, enforce limits and close transfers", async () => {
    const source = readFileSync(new URL("../tabtopd/preview-loaders.js", import.meta.url), "utf8")
        .replace(/^import .*;\n/gm, "").replace("export async function loadPreview", "async function loadPreview");
    let size = 3, closed = 0, collected = 0, content = Uint8Array.of(65, 0, 255);
    const requests = [];
    const env = { typeOf, limits, binaryChunkSize, TextDecoder, Blob, join: (d, n) => `${d}/${n}`,
        call: async req => { requests.push(req); return { reply: { size, mtime: 1, length: Math.min(size, req.length ?? size) }, close() { closed++; } }; },
        collect: async (_t, _size, _progress, type) => { collected++; return new Blob([content], { type }); } };
    runInNewContext(`${source}\nglobalThis.loadPreview = loadPreview;`, env);
    await assert.rejects(env.loadPreview("folder", "sample.unknown"), /isn't supported/);
    for (const mode of ["text", "hex"]) {
        const result = await env.loadPreview("folder", "sample.unknown", { mode });
        assert.equal(result.file.kind, "hex");
        assert.equal(result.file.textAvailable, false);
        assert.equal(result.blob.size, 3);
        assert.deepEqual(requests.at(-1).path, "folder/sample.unknown");
    }
    assert.equal(closed, 2);
    size = limits.hex + 1;
    await assert.rejects(env.loadPreview("folder", "sample.txt", { mode: "text" }), /too big/);
    assert.equal(collected, 2);
    assert.equal(closed, 3);
    size = 3;
    assert.equal((await env.loadPreview("folder", "sample.unknown", { mode: "auto" })).file.kind, "hex");
    for (const text of ["", "hello\n", "こんにちは\n"]) {
        content = new TextEncoder().encode(text); size = content.length;
        const loaded = await env.loadPreview("folder", "sample.unknown", { mode: "auto" });
        assert.equal(loaded.file.kind, "text");
        assert.equal(loaded.file.textAvailable, true);
        const hex = await env.loadPreview("folder", "sample.unknown", { mode: "hex" });
        assert.equal(hex.file.kind, "hex");
        assert.equal(hex.file.textAvailable, true);
    }
    size = 50_000_000;
    content = new TextEncoder().encode("partial text");
    const partial = await env.loadPreview("folder", "large.unknown", { mode: "auto" });
    assert.equal(partial.file.size, size);
    assert.equal(partial.file.previewSize, 10_000_000);
    assert.equal(partial.file.truncated, true);
    assert.equal(partial.file.kind, "text");
    assert.equal(partial.file.textAvailable, true);
    assert.equal(requests.at(-2).offset, 0);
    assert.equal(requests.at(-2).length, binaryChunkSize);
    assert.equal(requests.at(-1).offset, binaryChunkSize);
    assert.equal(requests.at(-1).length, 10_000_000 - binaryChunkSize);
    assert.equal(requests.at(-1).if_mtime, 1);
    assert.equal(requests.at(-1).if_size, size);
    const collectText = env.collect;
    env.collect = async () => new Blob([requests.at(-1).offset ? Uint8Array.of(0) : "readable header"]);
    const binaryTail = await env.loadPreview("folder", "large.unknown", { mode: "auto" });
    assert.equal(binaryTail.file.kind, "hex");
    assert.equal(binaryTail.file.textAvailable, false);
    env.collect = collectText;
    content = Uint8Array.of(0xe2, 0x82); // A UTF-8 character split at the preview boundary.
    assert.equal((await env.loadPreview("folder", "large.unknown", { mode: "hex" })).file.textAvailable, true);
    size = 50_000_000; content = Uint8Array.of(0, 0, 0);
    const binaryRequest = requests.length;
    const largeBinary = await env.loadPreview("folder", "large.unknown", { mode: "auto" });
    assert.equal(largeBinary.file.kind, "hex");
    assert.equal(largeBinary.file.previewSize, binaryChunkSize);
    assert.equal(requests.length, binaryRequest + 1);
    assert.equal(requests.at(-1).length, binaryChunkSize);
    const largeKnown = await env.loadPreview("folder", "large.pdf", { mode: "hex" });
    assert.equal(largeKnown.file.kind, "hex");
    assert.equal(largeKnown.file.previewSize, binaryChunkSize);
    content = Uint8Array.of(0xff, 0xfe); size = 2;
    assert.equal((await env.loadPreview("folder", "sample.unknown", { mode: "auto" })).file.kind, "hex");
});


test("hex byte ranges are aligned, bounded, version-reader driven and correctly labelled", async () => {
    const first = new Uint8Array(binaryChunkSize).fill(65);
    const calls = [];
    const source = createHexRangeSource(first, 2 * binaryChunkSize + 17, async (begin, end) => {
        calls.push([begin, end]); return new Uint8Array(end - begin).fill(begin / binaryChunkSize + 65).buffer;
    });
    assert.equal((await source.read(12)).bytes, first);
    assert.equal(calls.length, 0);
    const second = await source.read(binaryChunkSize + 5);
    assert.deepEqual(calls[0], [binaryChunkSize, 2 * binaryChunkSize]);
    assert.match(hexDump(second.bytes, 0, 1, second.begin), /^000f4240  42/);
    await source.read(binaryChunkSize + 4096);
    assert.equal(calls.length, 1);
    const last = await source.read(2 * binaryChunkSize + 16);
    assert.equal(last.bytes.length, 17);
    assert.deepEqual(calls.at(-1), [2 * binaryChunkSize, 2 * binaryChunkSize + 17]);
    await assert.rejects(source.read(2 * binaryChunkSize + 17), /outside/);
});

test("cancelled and out-of-order hex requests cannot replace the current range", async () => {
    const pending = [];
    const source = createHexRangeSource(new Uint8Array(binaryChunkSize), 4 * binaryChunkSize,
        (begin, end) => new Promise(resolve => pending.push({ begin, end, resolve })));
    const controller = new AbortController();
    const cancelled = source.read(binaryChunkSize, { signal: controller.signal });
    controller.abort();
    pending[0].resolve(new ArrayBuffer(binaryChunkSize));
    await assert.rejects(cancelled, { name: "AbortError" });
    assert.ok(source.cached(0));
    const stale = source.read(binaryChunkSize);
    const latest = source.read(2 * binaryChunkSize);
    pending[2].resolve(new ArrayBuffer(binaryChunkSize)); await latest;
    pending[1].resolve(new ArrayBuffer(binaryChunkSize));
    await assert.rejects(stale, { name: "AbortError" });
    assert.ok(source.cached(2 * binaryChunkSize));
    assert.equal(source.cached(binaryChunkSize), null);
    const bad = createHexRangeSource(new Uint8Array(binaryChunkSize), 2 * binaryChunkSize, async () => new ArrayBuffer(1));
    await assert.rejects(bad.read(binaryChunkSize), /Incomplete/);
});
