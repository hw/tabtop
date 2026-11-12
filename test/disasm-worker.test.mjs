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
    runInNewContext(source, { self, Uint8Array, importScripts() {}, fetch: async () => {
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

test("ARM/MIPS initialization is shared, lazy, and retried independently of x86", async () => {
    const source = readFileSync(new URL("../tabtopd/disasm-worker.js", import.meta.url), "utf8");
    const posted = [], imports = [], fetched = [];
    let attempts = 0;
    const self = { postMessage: (m) => posted.push(m) };
    const lib = {
        Capstone: function() { this.option = () => {}; this.disasm_iter = () => {}; this.close = () => {}; },
    };
    runInNewContext(source, {
        self, Uint8Array,
        importScripts: (...paths) => {
            imports.push(...paths);
            self.MCapstone = async () => {
                if (++attempts === 1) throw new Error("initialization failed");
                return lib;
            };
        },
        fetch: async (path) => { fetched.push(path); return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) }; },
    });
    const ask = (id, mode) => self.onmessage({ data: { id, mode, bytes: new Uint8Array(1), address: 0, max: 1 } });
    assert.equal(imports.length, 0);
    await Promise.all([ask(1, "arm64"), ask(2, "thumb")]);
    assert.equal(attempts, 1);
    assert.equal(fetched.length, 1);
    assert.ok(posted.every((m) => m.error === "initialization failed"));
    await Promise.all([ask(3, "arm32"), ask(4, "mips32-le")]);
    assert.equal(attempts, 2);
    assert.equal(fetched.length, 2);
    assert.ok(posted.slice(2).every((m) => m.lines.length === 1 && m.lines[0].text === "(bad)"));
    assert.deepEqual(imports, ["./disasm/capstone.js"]);
    assert.ok(fetched.every((p) => p === "./disasm/capstone.wasm"));
});

test("invalid requests and ARM/MIPS assembly fail before loading a decoder", async () => {
    const source = readFileSync(new URL("../tabtopd/disasm-worker.js", import.meta.url), "utf8");
    let answer;
    const self = { postMessage: (m) => { answer = m; } };
    const unexpected = () => { throw new Error("unexpected library load"); };
    runInNewContext(source, { self, Uint8Array, importScripts: unexpected, fetch: unexpected });
    const valid = { id: 1, mode: "arm64", address: 0, bytes: new Uint8Array(4), max: 1 };
    for (const change of [
        { mode: "unknown" }, { address: -1 }, { address: Number.MAX_SAFE_INTEGER }, { bytes: new Uint8Array(4097) },
        { bytes: [0, 0, 0, 0] }, { max: 0 }, { max: 513 },
    ]) {
        await self.onmessage({ data: { ...valid, ...change } });
        assert.match(answer.error, /unknown instruction set|invalid /);
    }
    for (const mode of ["arm64", "arm32", "thumb", "mips32-le", "mips64-be"]) {
        await self.onmessage({ data: { ...valid, mode, assemble: "nop" } });
        assert.match(answer.error, /editing is only available for x86/);
    }
});
