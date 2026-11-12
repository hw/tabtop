// Exercise the actual subset WASM through the worker, as part of the image
// build. node check-capstone.mjs <asset directory> <disasm-worker.js>
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { gzipSync } from "node:zlib";

const [directory, workerFile] = process.argv.slice(2);
if (!directory || !workerFile) throw new Error("usage: node check-capstone.mjs <asset directory> <disasm-worker.js>");
const wasm = readFileSync(resolve(directory, "capstone.wasm"));
const factory = createRequire(import.meta.url)(resolve(directory, "capstone.js"));
let fetches = 0, loads = 0, result;
const self = {
    MCapstone: async (options) => { loads++; return factory(options); },
    postMessage: (message) => { result = JSON.parse(JSON.stringify(message)); },
};
runInNewContext(readFileSync(workerFile, "utf8"), {
    self, Uint8Array,
    importScripts() { throw new Error("the ARM/MIPS path loaded x86 scripts"); },
    fetch: async (path) => {
        assert.equal(path, "./disasm/capstone.wasm");
        fetches++;
        return { ok: true, arrayBuffer: async () => wasm };
    },
});
let next = 0;
const ask = async (mode, bytes, address = 0x1000, max = 512) => {
    await self.onmessage({ data: { id: ++next, mode, bytes: Uint8Array.from(bytes), address, max } });
    assert.equal(result.id, next);
    assert.equal(result.error, undefined, `${mode}: ${result.error}`);
    return result.lines;
};
const line = (offset, length, text, targets = []) => ({ offset, length, text, targets });
assert.deepEqual(await ask("arm64", [0x1f, 0x20, 0x03, 0xd5, 0xc0, 0x03, 0x5f, 0xd6]), [
    line(0x1000, 4, "nop"), line(0x1004, 4, "ret"),
]);
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
    ["arm64", [0x04, 0, 0, 0x14], "b #0x1010"],
    ["arm32", [0x02, 0, 0, 0xea], "b #0x1010"],
    ["thumb", [0x06, 0xe0], "b #0x1010"],
]) assert.deepEqual(await ask(mode, bytes), [line(0x1000, bytes.length, text, [0x1010])]);
assert.deepEqual(await ask("arm64", [0xff, 0xff, 0xff, 0x17]), [line(0x1000, 4, "b #0xffc", [0xffc])]);
// TBZ's bit number is an immediate too, but only its final operand is a destination.
assert.deepEqual((await ask("arm64", [0x80, 0, 0, 0x36]))[0].targets, [0x1010]);
assert.deepEqual((await ask("arm64", [0x80, 0, 0, 0x10]))[0].targets, [0x1010]); // ADR
assert.deepEqual((await ask("arm64", [0x00, 0x02, 0x80, 0xd2]))[0].targets, []); // MOV immediate
for (const width of [32, 64]) {
    for (const endian of ["le", "be"]) {
        const mode = `mips${width}-${endian}`;
        const words = [[0x10, 0, 0, 3], [0, 0, 0, 0], [0x24, 0x02, 0, 1]];
        const bytes = words.flatMap((word) => endian === "le" ? word.toReversed() : word);
        assert.deepEqual(await ask(mode, bytes), [
            line(0x1000, 4, "b 0x1010", [0x1010]), line(0x1004, 4, "nop"), line(0x1008, 4, "addiu $v0, $zero, 1"),
        ]);
        const daddiu = [0x64, 0x02, 0, 1];
        if (width === 64) assert.equal((await ask(mode, endian === "le" ? daddiu.toReversed() : daddiu))[0].text, "daddiu $v0, $zero, 1");
        const back = [0x10, 0, 0xff, 0xfe];
        assert.deepEqual((await ask(mode, endian === "le" ? back.toReversed() : back))[0].targets, [0xffc]);
    }
}
// Invalid words advance, with no bytes lost; a short tail stays visible.
assert.deepEqual(await ask("arm64", [0xff, 0xff, 0xff, 0xff, 0x1f, 0x20, 0x03, 0xd5, 0xaa]), [
    line(0x1000, 4, "(bad)"), line(0x1004, 4, "nop"), line(0x1008, 1, "(bad)"),
]);
for (const mode of ["arm64", "arm32", "thumb", "mips32-le", "mips32-be", "mips64-le", "mips64-be"]) {
    assert.deepEqual(await ask(mode, []), []);
    assert.deepEqual(await ask(mode, [0xaa]), [line(0x1000, 1, "(bad)")]);
}
assert.deepEqual(await ask("thumb", [0x00, 0xf0]), [line(0x1000, 2, "(bad)")]);
assert.equal((await ask("arm64", [0x1f, 0x20, 0x03, 0xd5, 0xc0, 0x03, 0x5f, 0xd6], 0x1000, 1)).length, 1);
assert.equal((await ask("arm64", [0x1f, 0x20, 0x03, 0xd5], 0x1001))[0].offset, 0x1001);
assert.deepEqual((await ask("arm64", [0x04, 0, 0, 0x14], 0x100000000))[0].targets, [0x100000010]);
assert.equal(fetches, 1);
assert.equal(loads, 1);
const lib = await factory({ wasmBinary: wasm });
assert.ok(lib.support(lib.ARCH_ARM) && lib.support(lib.ARCH_ARM64) && lib.support(lib.ARCH_MIPS));
assert.equal(lib.support(lib.ARCH_X86), 0);
let raw = 0, gz = 0;
for (const file of ["capstone.js", "capstone.wasm"]) {
    const bytes = readFileSync(resolve(directory, file));
    raw += bytes.length;
    gz += gzipSync(bytes).length;
}
console.log(`Capstone ARM/ARM64/MIPS: checked; ${raw} bytes raw, ${gz} bytes gzip (JS + WASM)`);
