// Exercise ARM64's WebAssembly (fARM64; see arm64-asm) through the worker,
// as part of the image build: what's shown for bytes; and that lines as a
// person types them, and lines as the disassembly shows them, from random
// words, assemble to what's shown as that line again (or, for some, can't
// be; never as another). fARM64 is then both what assembles and what
// reads it back: so each is also read by a Capstone built with ARM64 for
// this alone (not served), which is to read the same.
// node check-arm64.mjs <asset directory> <disasm-worker.js> <directory of that Capstone>
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { hex, line, runWorker } from "./worker-harness.mjs";
import { gzipSync } from "node:zlib";

const [directory, workerFile, referenceDirectory] = process.argv.slice(2);
if (!directory || !workerFile || !referenceDirectory) throw new Error("usage: node check-arm64.mjs <asset directory> <disasm-worker.js> <reference Capstone directory>");
const wasm = readFileSync(resolve(directory, "arm64-asm.wasm"));
let fetches = 0;
const { post, scope: worker } = runWorker(workerFile, () => ({
    importScripts() { throw new Error("the ARM64 path loaded another's scripts"); },
    fetch: async (path) => {
        assert.equal(path, "./disasm/arm64-asm.wasm");
        fetches++;
        return { ok: true, arrayBuffer: async () => wasm };
    },
}));
const ask = async (bytes, address = 0x1000, max = 512) => {
    const reply = await post({ mode: "arm64", bytes: Uint8Array.from(bytes), address, max });
    assert.equal(reply.error, undefined, reply.error);
    return reply.lines;
};
const assemble = (text, address = 0x1000, was = []) => post({ mode: "arm64", assemble: text, address, was: [...was] });
const disassemble = async (bytes, address = 0x1000) => (await ask(bytes, address, 1))[0];
// The other reader: Capstone's text for a word, or "" where it has none
// that can be gone by.
const reference = await createRequire(import.meta.url)(resolve(referenceDirectory, "capstone.js"))({ wasmBinary: readFileSync(resolve(referenceDirectory, "capstone.wasm")) });
const capstone = new reference.Capstone(reference.ARCH_ARM64, reference.MODE_ARM);
const referenceText = (bytes, address = 0x1000) => {
    try {
        const [insn] = capstone.disasm([...bytes], address);
        const text = insn ? [insn.mnemonic, insn.op_str].filter(Boolean).join(" ") : "";
        // (A prefetch it has no name for, it writes with nothing there: prfm , [x0].)
        return /^\S+ ,/.test(text) ? "" : text;
    } catch {
        return "";
    }
};
const sameText = (a, b) => worker.sameLine(worker.lineTokens(a), worker.lineTokens(b));

// What's shown. Addresses are in hex, and links; a number under ten is as it is.
assert.deepEqual(await ask([0x1f, 0x20, 0x03, 0xd5, 0xc0, 0x03, 0x5f, 0xd6]), [line(0x1000, 4, "nop"), line(0x1004, 4, "ret")]);
assert.deepEqual(await ask([0x04, 0, 0, 0x14]), [line(0x1000, 4, "b 0x1010", [0x1010])]);
assert.deepEqual(await ask([0xff, 0xff, 0xff, 0x17]), [line(0x1000, 4, "b 0xffc", [0xffc])]);
assert.deepEqual(await ask([0x02, 0, 0, 0x14], 0), [line(0, 4, "b 0x8", [8])]);
// Before the file's start: no address to go to.
assert.deepEqual(await ask([0xff, 0xff, 0xff, 0x17], 0), [line(0, 4, "b 0xfffffffffffffffc")]);
// TBZ's bit number is a number too, but only where it goes is a destination.
assert.deepEqual(await ask([0x80, 0, 0, 0x36]), [line(0x1000, 4, "tbz w0, #0, 0x1010", [0x1010])]);
assert.deepEqual(await ask([0x80, 0, 0, 0x10]), [line(0x1000, 4, "adr x0, 0x1010", [0x1010])]);
assert.deepEqual(await ask([0x80, 0, 0, 0x90]), [line(0x1000, 4, "adrp x0, 0x11000", [0x11000])]);
assert.deepEqual(await ask([0x80, 0, 0, 0x58]), [line(0x1000, 4, "ldr x0, 0x1010", [0x1010])]);
assert.deepEqual(await ask([0x00, 0x02, 0x80, 0xd2]), [line(0x1000, 4, "mov x0, #0x10")]);
assert.deepEqual(await ask([0xe2, 0x23, 0x00, 0x91, 0xfd, 0x7b, 0xbf, 0xa9]), [line(0x1000, 4, "add x2, sp, #8"), line(0x1004, 4, "stp x29, x30, [sp, #-0x10]!")]);
// The extensions Capstone showed: cryptography, SVE.
assert.deepEqual(await ask([0x00, 0x48, 0x28, 0x4e, 0x00, 0x00, 0xa0, 0x04]), [line(0x1000, 4, "aese v0.16b, v0.16b"), line(0x1004, 4, "add z0.s, z0.s, z0.s")]);
// Invalid words advance, with no bytes lost; a short tail stays visible.
assert.deepEqual(await ask([0xff, 0xff, 0xff, 0xff, 0x1f, 0x20, 0x03, 0xd5, 0xaa]), [line(0x1000, 4, "(bad)"), line(0x1004, 4, "nop"), line(0x1008, 1, "(bad)")]);
assert.deepEqual(await ask([]), []);
assert.deepEqual(await ask([0xaa]), [line(0x1000, 1, "(bad)")]);
assert.deepEqual(await ask([0x1f, 0x20, 0x03, 0xd5, 0xc0, 0x03, 0x5f]), [line(0x1000, 4, "nop"), line(0x1004, 3, "(bad)")]);
// No more than asked for, the tail among them.
assert.deepEqual(await ask([0x1f, 0x20, 0x03, 0xd5, 0xc0, 0x03, 0x5f, 0xd6], 0x1000, 1), [line(0x1000, 4, "nop")]);
assert.deepEqual(await ask([0x1f, 0x20, 0x03, 0xd5, 0xaa], 0x1000, 1), [line(0x1000, 4, "nop")]);
assert.equal((await ask([0x1f, 0x20, 0x03, 0xd5, 0xaa], 0x1000, 2)).length, 2);
// From an odd offset, and past 4 GB.
assert.equal((await ask([0x1f, 0x20, 0x03, 0xd5], 0x1001))[0].offset, 0x1001);
assert.deepEqual(await ask([0x04, 0, 0, 0x14], 0x100000000), [line(0x100000000, 4, "b 0x100000010", [0x100000010])]);
// As many as a view asks for at once.
assert.equal((await ask(new Uint8Array(4096 + 15).fill(0x1f))).length, 512);

// System registers, every one there can be, read and written: by the name
// Capstone has for it (fARM64 has few; the rest are sysreg_names.rs's,
// which list-arm64-sysregs.mjs writes again if this says they differ).
let registers = 0;
for (const [base, pattern] of [[0xd5300000, /^mrs x0, (\S+)$/], [0xd5100000, /^msr (\S+), x0$/]]) {
    for (let from = 0; from < 1 << 15; from += 512) {
        const bytes = new Uint8Array(4 * 512);
        for (let i = 0; i < 512; i++) new DataView(bytes.buffer).setUint32(4 * i, (base | (from + i) << 5) >>> 0, true);
        const lines = await ask(bytes, 0);
        for (let i = 0; i < 512; i++) {
            const other = pattern.exec(referenceText(bytes.subarray(4 * i, 4 * i + 4), 4 * i))?.[1];
            if (!other || /^s\d_\d_c\d+_c\d+_\d$/.test(other)) continue;
            assert.equal(pattern.exec(lines[i].text)?.[1], other, `${lines[i].text} (${hex(bytes.subarray(4 * i, 4 * i + 4))}) isn't ${other}: sysreg_names.rs is to be written again`);
            registers++;
        }
    }
}
assert.ok(registers > 1500, `only ${registers} system registers named`);

// As typed: with and without #, in either case, numbers in hex or not,
// the registers' other names, a comment.
for (const [text, want, address] of [
    ["nop", "1f2003d5"], ["ret", "c0035fd6"], ["mov x0, #1", "200080d2"], ["MOV X0, X1", "e00301aa"], ["add x0, x1, x2", "2000028b"],
    ["add x0,x1,#16", "20400091"], ["add x0, x1, 0x10", "20400091"], ["sub sp, sp, #0x20", "ff8300d1"], ["ldr x0, [x1, #8]", "200440f9"],
    ["str x0, [sp, #0x10]", "e00b00f9"], ["stp x29, x30, [sp, #-0x10]!", "fd7bbfa9"], ["ldp fp, lr, [sp], #0x10", "fd7bc1a8"],
    ["ldr x0, [x1, x2, lsl #3]", "207862f8"], ["add x0, sp, w1, uxtw #2", "e04b218b"], ["b 0x1010", "04000014"], ["bl #0x2000", "00040094"],
    ["b.eq 0x1010", "80000054"], ["cbz x0, 0x1010", "800000b4"], ["tbz w0, #0, 0x1010", "80000036"], ["cmp x0, #0", "1f0000f1"],
    ["adrp x0, 0x11000", "80000090"], ["adr x0, 0x1010", "80000010"], ["svc #0", "010000d4"], ["blr x8", "00013fd6"], ["br x16", "00021fd6"],
    ["csel x0, x1, x2, eq", "2000829a"], ["cset x0, eq", "e0179f9a"], ["lsl x0, x1, #2", "20f47ed3"], ["and w0, w1, #0xff", "201c0012"],
    ["mul x0, x1, x2", "207c029b"], ["ldrb w0, [x1]", "20004039"], ["mov w0, wzr", "e0031f2a"], ["movk x0, #1, lsl #16", "2000a0f2"],
    ["mov w0, #0xffffffff", "00008012"], ["mov w0, #-1", "00008012"], ["sub sp, sp, #0x1000", "ff0740d1"], ["sub sp, sp, #1, lsl #12", "ff0740d1"],
    ["b.cs 0x1010", "82000054"], ["cset x0, cc", "e0279f9a"], ["ret x30", "c0035fd6"], ["ret lr", "c0035fd6"], ["ret x1", "20005fd6"],
    ["ldr x0, [x1, w2, sxtw #3]", "20d862f8"], ["add v0.4s, v1.4s, v2.4s", "2084a24e"], ["fmov d0, #1.0", "00106e1e"], ["b 0xffc ; back", "ffffff17"], ["b 0x100000010", "04000014", 0x100000000],
]) {
    const got = await assemble(text, address);
    assert.equal(got.error, undefined, `${text}: ${got.error}`);
    assert.equal(hex(got.bytes), want, text);
    assert.ok(sameText(referenceText(got.bytes, address ?? 0x1000), text), `${text}: Capstone reads ${hex(got.bytes)} as ${referenceText(got.bytes, address ?? 0x1000)}`);
}
// (A number that's more than the 32 bits it's put in isn't cut down to fit.)
for (const text of ["", "foo x0", "add x0, x99, x2", "add x0, x1", "mov x0, w1", "ldr x0, [x1, #8", "b 0x1002", "b 0x10000000000", "add x0, x1, #0x1001",
    "mov w0, #0x100000001", "mov w0, #0x1ffffffff", "and w0, w1, #0x1000000ff", "mov x0, #0x12345678", "cbz w0, 0x100001010", "mrs x0, tpidr_el0",
    "ld1 {v0.16b}, [x0]", "x".repeat(300)])
    assert.equal(typeof (await assemble(text)).error, "string", text);
// Another instruction set's line isn't assembled as ARM64's.
assert.match((await post({ mode: "arm32", assemble: "nop", address: 0 })).error, /only available for x86, ARM64, RISC-V and MIPS/);
// More than one way to encode it: the one that's there is kept.
const twice = [];
let seed = 0x9e3779b9;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 2 ** 32; };
// Random words, as shown: assembled, they're shown as that again; a share
// can't be (what the assembler doesn't read yet); none comes back as another.
// Capstone, where it reads the word at all, is to read what was assembled
// as the line; and shows nearly every word as it's shown here, SME's
// tiles and SVE among them (not all: it writes an SVE number that's
// negative as its bits, and has no name for a prefetch it doesn't know).
let shown = 0, assembled = 0, exact = 0, slowest = 0, both = 0, agreed = 0, missed = 0, read = 0;
const words = new Set(), apart = [];
const refused = new Map();
for (let t = 0; t < 6000; t++) {
    const word = Uint8Array.from({ length: 4 }, () => random() * 256 | 0);
    words.add(hex(word));
    const line = await disassemble(word);
    const other = referenceText(word);
    if (!line || line.text === "(bad)") {
        if (other) missed++;
        continue;
    }
    shown++;
    if (other) {
        both++;
        if (sameText(line.text, other)) agreed++;
        else if (apart.length < 5) apart.push(`${line.text} / ${other}`);
    }
    const began = performance.now();
    const got = await assemble(line.text, 0x1000, word);
    slowest = Math.max(slowest, performance.now() - began);
    if (got.error) {
        const name = line.text.split(" ")[0];
        refused.set(name, (refused.get(name) ?? 0) + 1);
        continue;
    }
    const back = await disassemble(got.bytes);
    assert.equal(back.text, line.text, `${line.text} (${hex(word)}) came back as ${back.text} (${hex(got.bytes)})`);
    const again = referenceText(got.bytes);
    if (again) {
        read++;
        assert.ok(sameText(again, line.text), `${line.text} (${hex(word)}) assembled to ${hex(got.bytes)}, which Capstone reads as ${again}`);
    }
    assembled++;
    if (hex(got.bytes) === hex(word)) exact++;
    else twice.push(line.text);
}
// Kept as it was, wherever what was there is one of the ways (random words
// have encodings no assembler writes: unused bits set).
assert.ok(exact >= assembled * 0.95, `${exact} of ${assembled} kept their bytes; not: ${twice.slice(0, 5).join("; ")}`);
assert.ok(assembled >= shown * 0.6, `${assembled} of ${shown} assembled`);
assert.ok(slowest < 2000, `the slowest line took ${slowest.toFixed(0)} ms`);
const most = [...refused].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, n]) => `${name} ${n}`).join(", ");
assert.ok(words.size > 5900, `only ${words.size} different words`);
assert.equal(missed, 0, `${missed} words Capstone shows aren't shown`);
assert.ok(read >= assembled * 0.8, `Capstone read only ${read} of the ${assembled} assembled`);
assert.ok(agreed >= both * 0.99, `only ${agreed} of ${both} shown as Capstone shows them; not: ${apart.join("; ")}`);
assert.equal(fetches, 1);
console.log(`ARM64 (fARM64): checked; ${shown} of ${words.size} random words shown, ${agreed} of the ${both} Capstone shows too as it shows them (not: ${apart.slice(0, 3).join("; ")}); `
    + `${assembled} assembled (${exact} to the same bytes; ${read} read back by Capstone, all the same), slowest ${slowest.toFixed(0)} ms; `
    + `not assembled: ${most}; ${wasm.length} bytes raw, ${gzipSync(wasm).length} bytes gzip`);
