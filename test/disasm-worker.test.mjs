import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

test("the disassembler worker: a failed load of its WebAssembly is tried again, not kept", async () => {
    const source = readFileSync(new URL("../tabtopd/disasm-worker.js", import.meta.url), "utf8");
    const posted = [];
    let fetches = 0, up = false;
    const self = { postMessage: (m) => posted.push(m) };
    self.icedInit = async () => { throw new Error("only the load is checked"); };
    runInNewContext(source, { self, importScripts() {}, fetch: async () => {
        fetches++;
        if (!up) throw new TypeError("Failed to fetch");
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
    } });
    const ask = async (id) => {
        await self.onmessage({ data: { id, bytes: new Uint8Array(1), address: 0, bitness: 64, max: 1 } });
        return posted.find((m) => m.id === id);
    };
    assert.match((await ask(1)).error, /Failed to fetch/);
    up = true;
    // Asked again: fetched again (and got as far as the library), not the old failure.
    assert.doesNotMatch((await ask(2)).error ?? "", /Failed to fetch/);
    assert.equal(fetches, 2);
});
