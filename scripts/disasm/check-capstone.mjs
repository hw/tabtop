// Exercise the actual subset WASM through the worker, as part of the image
// build. node check-capstone.mjs <asset directory> <disasm-worker.js>
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { line, runWorker } from "./worker-harness.mjs";

const [directory, workerFile] = process.argv.slice(2);
if (!directory || !workerFile) throw new Error("usage: node check-capstone.mjs <asset directory> <disasm-worker.js>");
const wasm = readFileSync(resolve(directory, "capstone.wasm"));
const factory = createRequire(import.meta.url)(resolve(directory, "capstone.js"));
let fetches = 0, loads = 0;
const { post } = runWorker(workerFile, () => ({
    importScripts() { throw new Error("the ARM32 path loaded other scripts"); },
    fetch: async (path) => {
        assert.equal(path, "./disasm/capstone.wasm");
        fetches++;
        return { ok: true, arrayBuffer: async () => wasm };
    },
}), { MCapstone: async (options) => { loads++; return factory(options); } });
const ask = async (mode, bytes, address = 0x1000, max = 512) => {
    const reply = await post({ mode, bytes: Uint8Array.from(bytes), address, max });
    assert.equal(reply.error, undefined, `${mode}: ${reply.error}`);
    return reply.lines;
};
assert.deepEqual(await ask("arm32", [0x00, 0x00, 0xa0, 0xe3, 0x1e, 0xff, 0x2f, 0xe1]), [
    line(0x1000, 4, "mov r0, #0"), line(0x1004, 4, "bx lr"),
]);
assert.deepEqual(await ask("thumb", [0x08, 0xbf, 0x01, 0x20, 0x00, 0xf0, 0x00, 0xf8, 0x70, 0x47]), [
    line(0x1000, 2, "it eq"), line(0x1002, 2, "moveq r0, #1"),
    line(0x1004, 4, "bl #0x1008", [0x1008]), line(0x1008, 2, "bx lr"),
]);
// A new question has its own Thumb IT state.
assert.deepEqual(await ask("thumb", [0x01, 0x20]), [line(0x1000, 2, "movs r0, #1")]);
for (const [mode, bytes, text] of [
    ["arm32", [0x02, 0, 0, 0xea], "b #0x1010"],
    ["thumb", [0x06, 0xe0], "b #0x1010"],
]) assert.deepEqual(await ask(mode, bytes), [line(0x1000, bytes.length, text, [0x1010])]);
assert.deepEqual(await ask("arm32", [0xfe, 0xff, 0xff, 0xea]), [line(0x1000, 4, "b #0x1000", [0x1000])]);
// An immediate that isn't a branch's is no destination.
assert.deepEqual((await ask("arm32", [0x01, 0x0a, 0xa0, 0xe3]))[0].targets, []);
// Invalid words advance, with no bytes lost; a short tail stays visible.
assert.deepEqual(await ask("arm32", [0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0xa0, 0xe3, 0xaa]), [
    line(0x1000, 4, "(bad)"), line(0x1004, 4, "mov r0, #0"), line(0x1008, 1, "(bad)"),
]);
for (const mode of ["arm32", "thumb"]) {
    assert.deepEqual(await ask(mode, []), []);
    assert.deepEqual(await ask(mode, [0xaa]), [line(0x1000, 1, "(bad)")]);
}
assert.deepEqual(await ask("thumb", [0x00, 0xf0]), [line(0x1000, 2, "(bad)")]);
assert.equal((await ask("arm32", [0x00, 0x00, 0xa0, 0xe3, 0x1e, 0xff, 0x2f, 0xe1], 0x1000, 1)).length, 1);
assert.equal((await ask("arm32", [0x00, 0x00, 0xa0, 0xe3], 0x1001))[0].offset, 0x1001);
assert.equal(fetches, 1);
assert.equal(loads, 1);
const lib = await factory({ wasmBinary: wasm });
assert.ok(lib.support(lib.ARCH_ARM));
// ARM64 is fARM64's (see check-arm64.mjs), RISC-V riscv-asm.js's (check-riscv.mjs), MIPS mips-asm.js's (check-mips.mjs).
for (const arch of [lib.ARCH_ARM64, lib.ARCH_RISCV, lib.ARCH_MIPS]) assert.equal(lib.support(arch), 0);
assert.equal(lib.support(lib.ARCH_X86), 0);
let raw = 0, gz = 0;
for (const file of ["capstone.js", "capstone.wasm"]) {
    const bytes = readFileSync(resolve(directory, file));
    raw += bytes.length;
    gz += gzipSync(bytes).length;
}
console.log(`Capstone ARM32/Thumb: checked; ${raw} bytes raw, ${gz} bytes gzip (JS + WASM)`);
