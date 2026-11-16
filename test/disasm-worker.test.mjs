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

test("the disassembler worker: an assembler that failed to load is loaded when next asked", async () => {
    const source = readFileSync(new URL("../tabtopd/disasm-worker.js", import.meta.url), "utf8");
    const posted = [], imports = [];
    let up = false;
    const self = { postMessage: (m) => posted.push(m) };
    const lib = {};
    runInNewContext(source, {
        self, Uint8Array,
        importScripts: (...paths) => {
            for (const path of paths) {
                imports.push(path);
                if (path === "./disasm/iced.js") self.icedInit = async () => lib;
                else if (!up) throw new Error("NetworkError: x86-asm.js");
                else self.makeAssembler = (given) => ({ assemble: (text) => ({ bytes: Uint8Array.of(0x90), text: `${text}${given === lib ? "" : "?"}` }) });
            }
        },
        fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }),
    });
    const ask = async (id) => {
        await self.onmessage({ data: { id, assemble: "nop", address: 0, bitness: 64, was: [] } });
        return posted.find((m) => m.id === id);
    };
    assert.match((await ask(1)).error, /NetworkError/);
    up = true;
    // iced.js is there already: only the assembler is loaded again.
    assert.deepEqual(JSON.parse(JSON.stringify(await ask(2))), { id: 2, bytes: [0x90], text: "nop" });
    assert.deepEqual(imports, ["./disasm/iced.js", "./x86-asm.js", "./x86-asm.js"]);
});

test("ARM32/Thumb initialization is shared, lazy, and retried independently of x86", async () => {
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
    await Promise.all([ask(1, "arm32"), ask(2, "thumb")]);
    assert.equal(attempts, 1);
    assert.equal(fetched.length, 1);
    assert.ok(posted.every((m) => m.error === "initialization failed"));
    await Promise.all([ask(3, "arm32"), ask(4, "thumb"), ask(5, "arm32")]);
    // (ARM64, RISC-V and MIPS aren't Capstone's: see below.)
    assert.equal(attempts, 2);
    assert.equal(fetched.length, 2);
    assert.ok(posted.slice(2).every((m) => m.lines.length === 1 && m.lines[0].text === "(bad)"));
    assert.deepEqual(imports, ["./disasm/capstone.js"]);
    assert.ok(fetched.every((p) => p === "./disasm/capstone.wasm"));
});

test("invalid requests and view-only instruction sets' assembly fail before loading a decoder", async () => {
    const source = readFileSync(new URL("../tabtopd/disasm-worker.js", import.meta.url), "utf8");
    let answer;
    const self = { postMessage: (m) => { answer = m; } };
    const unexpected = () => { throw new Error("unexpected library load"); };
    runInNewContext(source, { self, Uint8Array, importScripts: unexpected, fetch: unexpected });
    const valid = { id: 1, mode: "arm64", address: 0, bytes: new Uint8Array(4), max: 1 };
    for (const change of [
        { mode: "unknown" }, { address: -1 }, { address: Number.MAX_SAFE_INTEGER }, { bytes: new Uint8Array(4096 + 16) },
        { bytes: [0, 0, 0, 0] }, { max: 0 }, { max: 513 },
    ]) {
        await self.onmessage({ data: { ...valid, ...change } });
        assert.match(answer.error, /unknown instruction set|invalid /);
    }
    for (const mode of ["arm32", "thumb"]) {
        await self.onmessage({ data: { ...valid, mode, assemble: "nop" } });
        assert.match(answer.error, /editing is only available for x86, ARM64, RISC-V and MIPS/);
    }
});

test("a disassembler the server has turned off is refused, before anything of it is loaded", async () => {
    // As tabtopd serves it with WEB_DISASM_DISABLE=x86,capstone,riscv,mips.
    const source = readFileSync(new URL("../tabtopd/disasm-worker.js", import.meta.url), "utf8").replace("const DISASM_OFF = [];", 'const DISASM_OFF = ["x86","capstone","riscv","mips"];');
    let answer;
    const fetched = [];
    const self = { postMessage: (m) => { answer = m; } };
    const unexpected = () => { throw new Error("unexpected library load"); };
    runInNewContext(source, { self, Uint8Array, BigInt, TextEncoder, TextDecoder, importScripts: unexpected,
        WebAssembly: { instantiate: async () => ({ instance: { exports: { memory: { buffer: new ArrayBuffer(64) }, alloc: () => 0, reply: () => 0, disassemble: () => 0 } } }) },
        fetch: async (path) => { fetched.push(path); return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) }; } });
    for (const message of [{ mode: "x86-64" }, { bitness: 32 }, { mode: "x86-64", assemble: "nop", bytes: undefined }, { mode: "arm32" }, { mode: "thumb" }, { mode: "mips64-be" }, { mode: "riscv32" }, { mode: "riscv64", assemble: "nop", bytes: undefined }, { mode: "mips32-le", assemble: "nop", bytes: undefined }]) {
        await self.onmessage({ data: { id: 1, address: 0, bytes: new Uint8Array(4), max: 1, ...message } });
        assert.match(answer.error, /turned off on this server/, JSON.stringify(message));
    }
    assert.deepEqual(fetched, []);
    // The one that's on still answers.
    await self.onmessage({ data: { id: 2, mode: "arm64", address: 0, bytes: new Uint8Array(0), max: 1 } });
    assert.deepEqual(JSON.parse(JSON.stringify(answer)), { id: 2, lines: [] });
    assert.deepEqual(fetched, ["./disasm/arm64-asm.wasm"]);
});

test("ARM64 assembly: of the words it could be, the one read back as the line, what's there kept; a trap loads it again", async () => {
    const source = readFileSync(new URL("../tabtopd/disasm-worker.js", import.meta.url), "utf8");
    let answer, loads = 0, trap = false;
    const self = { postMessage: (m) => { answer = JSON.parse(JSON.stringify(m)); } };
    // An assembler that answers every line with three words, which it
    // shows as these.
    const reads = { "1,0,0,0": "sub x0, x1, #0x10", "2,0,0,0": "add x0, x1, #0x10", "3,0,0,0": "add x0, x1, #16" };
    const memory = { buffer: new ArrayBuffer(256) };
    const put = (reply) => { new Uint8Array(memory.buffer, 100).set(reply); return reply.length; };
    const exports = { memory, alloc: () => 0, reply: () => 100, assemble: (address, at, length) => {
        if (trap) throw new Error("unreachable");
        const text = new TextDecoder().decode(new Uint8Array(memory.buffer, at, length));
        return put(text.startsWith("bogus") ? [1, ...new TextEncoder().encode("\"bogus\" isn't an ARM64 instruction.")] : [0, 1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0]);
    }, disassemble: (address, at, length) => put(new TextEncoder().encode(`${reads[[...new Uint8Array(memory.buffer, at, length)].join()]}\t\n`)) };
    runInNewContext(source, {
        self, Uint8Array, BigInt, TextEncoder, TextDecoder,
        WebAssembly: { instantiate: async () => { loads++; return { instance: { exports } }; } },
        importScripts: () => { throw new Error("ARM64 has no scripts to load"); },
        fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }),
    });
    const ask = async (text, was = []) => { await self.onmessage({ data: { id: 1, mode: "arm64", assemble: text, address: 0x1000, was } }); return answer; };
    // Written another way (no #, decimal, a comment): the same line; the first that reads so.
    assert.deepEqual(await ask("ADD x0,x1, 16 ; sixteen"), { id: 1, bytes: [2, 0, 0, 0], text: "add x0, x1, #0x10" });
    // What's there is one of them: kept.
    assert.deepEqual(await ask("add x0, x1, #0x10", [3, 0, 0, 0]), { id: 1, bytes: [3, 0, 0, 0], text: "add x0, x1, #16" });
    // None reads as the line; a line the assembler can't read: why.
    assert.match((await ask("add x0, x1, #0x11")).error, /can't be assembled here/);
    assert.match((await ask("bogus x0")).error, /isn't an ARM64 instruction/);
    assert.equal(loads, 1);
    // It stops: said; asked again, it's loaded again.
    trap = true;
    assert.match((await ask("add x0, x1, #0x10")).error, /couldn't be assembled/);
    trap = false;
    assert.equal((await ask("add x0, x1, #0x10")).text, "add x0, x1, #0x10");
    assert.equal(loads, 2);
});

test("ARM64 disassembly: its own module's lines, a short tail kept; a load that failed, or a trap, and it's loaded again", async () => {
    const source = readFileSync(new URL("../tabtopd/disasm-worker.js", import.meta.url), "utf8");
    let answer, loads = 0, trap = false, up = false;
    const fetched = [], asked = [];
    const self = { postMessage: (m) => { answer = JSON.parse(JSON.stringify(m)); } };
    const memory = { buffer: new ArrayBuffer(256) };
    // One that shows each whole word (no more than max) by its first byte.
    const shows = { 1: "b 0x1010\t1010", 2: "nop\t", 3: "", 4: "b 0xfffffffffffffffc\tfffffffffffffffc" };
    const exports = { memory, alloc: () => 0, reply: () => 100, disassemble: (address, at, length, max) => {
        if (trap) throw new Error("unreachable");
        asked.push({ address, length, max });
        const bytes = new Uint8Array(memory.buffer, at, length), lines = [];
        for (let i = 0; i + 4 <= length && lines.length < max; i += 4) lines.push(`${shows[bytes[i]]}\n`);
        const reply = new TextEncoder().encode(lines.join(""));
        new Uint8Array(memory.buffer, 100).set(reply);
        return reply.length;
    } };
    runInNewContext(source, {
        self, Uint8Array, BigInt, TextEncoder, TextDecoder,
        WebAssembly: { instantiate: async () => { loads++; return { instance: { exports } }; } },
        importScripts: () => { throw new Error("ARM64 has no scripts to load"); },
        fetch: async (path) => { fetched.push(path); return { ok: up, arrayBuffer: async () => new ArrayBuffer(0) }; },
    });
    const ask = async (bytes, max = 512, address = 0x1000) => { await self.onmessage({ data: { id: 1, mode: "arm64", bytes: Uint8Array.from(bytes), address, max } }); return answer; };
    assert.match((await ask([2, 0, 0, 0])).error, /ARM64 disassembler isn't available/);
    up = true;
    const line = (offset, length, text, targets = []) => ({ offset, length, text, targets });
    assert.deepEqual(await ask([1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 4, 0, 0, 0, 9, 9]), { id: 1, lines: [
        line(0x1000, 4, "b 0x1010", [0x1010]), line(0x1004, 4, "nop"), line(0x1008, 4, "(bad)"),
        // An address that's no file offset isn't one to go to.
        line(0x100c, 4, "b 0xfffffffffffffffc"), line(0x1010, 2, "(bad)"),
    ] });
    assert.deepEqual(asked.at(-1), { address: 0x1000n, length: 18, max: 512 });
    // No more than asked for: the tail isn't one more.
    assert.deepEqual((await ask([2, 0, 0, 0, 2, 0, 0, 0, 9], 2)).lines, [line(0x1000, 4, "nop"), line(0x1004, 4, "nop")]);
    assert.deepEqual((await ask([2, 0, 0, 0, 2, 0, 0, 0, 9], 1)).lines, [line(0x1000, 4, "nop")]);
    assert.deepEqual((await ask([9, 9, 9])).lines, [line(0x1000, 3, "(bad)")]);
    assert.deepEqual((await ask([])).lines, []);
    assert.deepEqual(fetched, ["./disasm/arm64-asm.wasm", "./disasm/arm64-asm.wasm"]);
    assert.equal(loads, 1);
    trap = true;
    assert.match((await ask([2, 0, 0, 0])).error, /couldn't be disassembled/);
    trap = false;
    assert.deepEqual((await ask([2, 0, 0, 0])).lines, [line(0x1000, 4, "nop")]);
    assert.equal(loads, 2);
});

test("names to demangle: a line each to its own module and back, whichever disassemblers are off; loaded again after a failure or a trap", async () => {
    // (As served with every disassembler turned off.)
    const source = readFileSync(new URL("../tabtopd/disasm-worker.js", import.meta.url), "utf8").replace("const DISASM_OFF = [];", 'const DISASM_OFF = ["x86","arm64","capstone","riscv"];');
    let answer, loads = 0, trap = false, up = false;
    const fetched = [], given = [];
    const self = { postMessage: (m) => { answer = JSON.parse(JSON.stringify(m)); } };
    const memory = { buffer: new ArrayBuffer(4096) };
    // One that answers each line that begins _Z with it in capitals, and others with nothing.
    const exports = { memory, alloc: () => 0, reply: () => 2048, demangle: (at, length) => {
        if (trap) throw new Error("unreachable");
        const lines = new TextDecoder().decode(new Uint8Array(memory.buffer, at, length)).split("\n");
        given.push(lines);
        const reply = new TextEncoder().encode(lines.map((l) => (l.startsWith("_Z") ? l.toUpperCase() : "")).join("\n"));
        new Uint8Array(memory.buffer, 2048).set(reply);
        return reply.length;
    } };
    runInNewContext(source, {
        self, Uint8Array, BigInt, TextEncoder, TextDecoder,
        WebAssembly: { instantiate: async () => { loads++; return { instance: { exports } }; } },
        importScripts: () => { throw new Error("the demangler has no scripts to load"); },
        fetch: async (path) => { fetched.push(path); return { ok: up, arrayBuffer: async () => new ArrayBuffer(0) }; },
    });
    const ask = async (names) => { await self.onmessage({ data: { id: 7, demangle: names } }); return answer; };
    assert.match((await ask(["_Zfoo"])).error, /demangler isn't available/);
    up = true;
    assert.deepEqual(await ask(["_Zfoo", "main", "", "_Zbar"]), { id: 7, names: ["_ZFOO", "", "", "_ZBAR"] });
    // A name with a line's end in it isn't given (it would put the rest out of step).
    assert.deepEqual((await ask(["_Za\n_Zb", "_Zc"])).names, ["", "_ZC"]);
    assert.deepEqual(given.at(-1), ["", "_Zc"]);
    // None: nothing's asked of it.
    const before = given.length;
    assert.deepEqual((await ask([])).names, []);
    assert.equal(given.length, before);
    for (const bad of ["_Zfoo", [1], null, {}]) assert.match((await ask(bad)).error, /invalid names/);
    assert.deepEqual(fetched, ["./demangle/demangle.wasm", "./demangle/demangle.wasm"]);
    assert.equal(loads, 1);
    trap = true;
    assert.match((await ask(["_Zfoo"])).error, /couldn't be read/);
    trap = false;
    assert.deepEqual((await ask(["_Zfoo"])).names, ["_ZFOO"]);
    assert.equal(loads, 2);
});

test("RISC-V is tabtop's own script: loaded when first asked, with nothing fetched; it disassembles and assembles", async () => {
    const source = readFileSync(new URL("../tabtopd/disasm-worker.js", import.meta.url), "utf8");
    const script = readFileSync(new URL("../tabtopd/riscv-asm.js", import.meta.url), "utf8");
    let answer, up = false;
    const imports = [];
    const self = { postMessage: (m) => { answer = JSON.parse(JSON.stringify(m)); } };
    runInNewContext(source, {
        self, Uint8Array, BigInt,
        importScripts: (path) => {
            imports.push(path);
            if (!up) throw new Error("NetworkError: riscv-asm.js");
            runInNewContext(script, { self });
        },
        fetch: () => { throw new Error("RISC-V fetched something"); },
    });
    const ask = (message) => self.onmessage({ data: { id: 1, address: 0x1000, ...message } });
    assert.deepEqual(imports, []);
    // One that failed to load is asked for again.
    await ask({ mode: "riscv64", bytes: Uint8Array.of(0x13, 0, 0, 0), max: 4 });
    assert.match(answer.error, /NetworkError/);
    up = true;
    await ask({ mode: "riscv64", bytes: Uint8Array.of(0x13, 0, 0, 0, 0x01, 0, 0xef, 0, 0, 0x01, 0xff), max: 8 });
    assert.deepEqual(answer.lines, [
        { offset: 0x1000, length: 4, text: "nop", targets: [] }, { offset: 0x1004, length: 2, text: "c.nop", targets: [] },
        { offset: 0x1006, length: 4, text: "jal 0x1016", targets: [0x1016] }, { offset: 0x100a, length: 1, text: "(bad)", targets: [] },
    ]);
    // What only RV64 has isn't RV32's.
    await ask({ mode: "riscv32", bytes: Uint8Array.of(0x03, 0x35, 0x81, 0), max: 1 });
    assert.equal(answer.lines[0].text, "(bad)");
    await ask({ mode: "riscv64", assemble: "ADDI a0, x10, 0x1 ; one more", was: [0, 0, 0, 0] });
    assert.deepEqual(answer, { id: 1, bytes: [0x13, 0x05, 0x15, 0x00], text: "addi a0, a0, 1" });
    await ask({ mode: "riscv64", assemble: "c.j 0x1010" });
    assert.deepEqual(answer, { id: 1, bytes: [0x01, 0xa8], text: "c.j 0x1010" });
    await ask({ mode: "riscv32", assemble: "ld a0, 8(sp)" });
    assert.match(answer.error, /^"ld" is only in RV64\.$/);
    await ask({ mode: "riscv64", assemble: "addi a0, a0, 0x1000" });
    assert.match(answer.error, /^"0x1000" isn't one addi can have there\.$/);
    assert.deepEqual(imports, ["./riscv-asm.js", "./riscv-asm.js"]);
});

test("MIPS is tabtop's own script too: loaded when first asked, with nothing fetched; it disassembles and assembles in each byte order", async () => {
    const source = readFileSync(new URL("../tabtopd/disasm-worker.js", import.meta.url), "utf8");
    const script = readFileSync(new URL("../tabtopd/mips-asm.js", import.meta.url), "utf8");
    let answer, up = false;
    const imports = [];
    const self = { postMessage: (m) => { answer = JSON.parse(JSON.stringify(m)); } };
    runInNewContext(source, {
        self, Uint8Array, BigInt,
        importScripts: (path) => {
            imports.push(path);
            if (!up) throw new Error("NetworkError: mips-asm.js");
            runInNewContext(script, { self });
        },
        fetch: () => { throw new Error("MIPS fetched something"); },
    });
    const ask = (message) => self.onmessage({ data: { id: 1, address: 0x1000, ...message } });
    // One that failed to load is asked for again.
    await ask({ mode: "mips32-be", bytes: Uint8Array.of(0, 0, 0, 0), max: 4 });
    assert.match(answer.error, /NetworkError/);
    up = true;
    await ask({ mode: "mips32-be", bytes: Uint8Array.of(0x10, 0, 0, 3, 0, 0, 0, 0, 0x24, 0x02, 0, 1, 0xaa), max: 8 });
    assert.deepEqual(answer.lines, [
        { offset: 0x1000, length: 4, text: "b 0x1010", targets: [0x1010] }, { offset: 0x1004, length: 4, text: "nop", targets: [] },
        { offset: 0x1008, length: 4, text: "addiu $v0, $zero, 1", targets: [] }, { offset: 0x100c, length: 1, text: "(bad)", targets: [] },
    ]);
    await ask({ mode: "mips64-le", bytes: Uint8Array.of(3, 0, 0, 0x10, 1, 0, 2, 0x64), max: 8 });
    assert.deepEqual(answer.lines.map((l) => l.text), ["b 0x1010", "daddiu $v0, $zero, 1"]);
    // What only MIPS64 has isn't MIPS32's.
    await ask({ mode: "mips32-le", bytes: Uint8Array.of(1, 0, 2, 0x64), max: 1 });
    assert.equal(answer.lines[0].text, "(bad)");
    await ask({ mode: "mips32-le", assemble: "ADDIU v0, $0, 0x1 ; one", was: [0, 0, 0, 0] });
    assert.deepEqual(answer, { id: 1, bytes: [0x01, 0x00, 0x02, 0x24], text: "addiu $v0, $zero, 1" });
    await ask({ mode: "mips32-be", assemble: "jal 0x1010" });
    assert.deepEqual(answer, { id: 1, bytes: [0x0c, 0x00, 0x04, 0x04], text: "jal 0x1010" });
    await ask({ mode: "mips32-be", assemble: "daddiu $v0, $zero, 1" });
    assert.match(answer.error, /^"daddiu" is only in MIPS64\.$/);
    await ask({ mode: "mips32-be", assemble: "addiu $v0, $zero, 0x8000" });
    assert.match(answer.error, /^"0x8000" isn't one addiu can have there\.$/);
    assert.deepEqual(imports, ["./mips-asm.js", "./mips-asm.js"]);
});
