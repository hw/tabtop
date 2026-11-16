// RISC-V's disassembler and assembler (tabtopd/riscv-asm.js), by itself:
// what the image build checks against Capstone (scripts/disasm/check-riscv.mjs)
// is, here, held to itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const context = {};
new Function("self", readFileSync(new URL("../tabtopd/riscv-asm.js", import.meta.url), "utf8"))(context);
const { riscv } = context;
const hex = (bytes) => Buffer.from(bytes).toString("hex");
const shown = (bytes, xlen = 64, address = 0x1000) => riscv.disassemble(Uint8Array.from(bytes), address, xlen, 512).lines.map((l) => l.text);

test("a line as typed: its name and operands, without its comment", () => {
    assert.deepEqual(riscv.parseLine("  ADDI  a0 , A1,0x10 ; more"), { name: "addi", operands: ["a0", "a1", "0x10"] });
    assert.deepEqual(riscv.parseLine("ld a0, 8 ( sp ) # there"), { name: "ld", operands: ["a0", "8(sp)"] });
    assert.deepEqual(riscv.parseLine("ret // back"), { name: "ret", operands: [] });
    assert.deepEqual(riscv.parseLine(""), { name: "", operands: [] });
});

test("instructions of two bytes and four, by the names each has; what isn't one is (bad), two bytes on", () => {
    assert.deepEqual(shown([0x13, 0, 0, 0, 0x01, 0, 0x82, 0x80, 0x67, 0x80, 0, 0]), ["nop", "c.nop", "c.jr ra", "ret"]);
    assert.deepEqual(shown([0x13, 0x85, 0x05, 0x00, 0x13, 0xc5, 0xf5, 0xff, 0x33, 0x05, 0xb0, 0x40]), ["mv a0, a1", "not a0, a1", "neg a0, a1"]);
    assert.deepEqual(shown([0xff, 0xff, 0xff, 0xff, 0x01]), ["(bad)", "(bad)", "(bad)"]);
    assert.deepEqual(riscv.disassemble(Uint8Array.of(0xef, 0xf0, 0x9f, 0xff), 0x1000, 32, 1).lines, [{ offset: 0x1000, length: 4, text: "jal 0xff8", targets: [0xff8] }]);
    // To before the start: where, as 64 bits wrap, and nowhere to go.
    assert.deepEqual(riscv.disassemble(Uint8Array.of(0xfd, 0xbf), 0, 64, 1).lines, [{ offset: 0, length: 2, text: "c.j 0xfffffffffffffffe", targets: [] }]);
});

test("what one width has, the other hasn't", () => {
    assert.deepEqual([shown([0x03, 0x35, 0x81, 0], 64)[0], shown([0x03, 0x35, 0x81, 0], 32)[0]], ["ld a0, 8(sp)", "(bad)"]);
    assert.deepEqual([shown([0x01, 0x28], 32), shown([0x01, 0x28], 64)], [["c.jal 0x1010"], ["c.addiw a6, 0"]]);
    assert.deepEqual([shown([0x13, 0x15, 0x05, 0x02], 64)[0], shown([0x13, 0x15, 0x05, 0x02], 32)[0]], ["slli a0, a0, 0x20", "(bad)"]);
    assert.throws(() => riscv.assemble("addiw a0, a0, 1", 0, 32), /: "addiw" is only in RV64\.$/);
    assert.throws(() => riscv.assemble("c.jal 0x10", 0, 64), /: "c\.jal" is only in RV32\.$/);
});

test("a line assembles to its bytes; another name for it is what's shown; what's there is kept", () => {
    assert.deepEqual(riscv.assemble("addi sp, sp, -16", 0x1000, 64), { bytes: [0x13, 0x01, 0x01, 0xff], text: "addi sp, sp, -0x10" });
    assert.deepEqual(riscv.assemble("addi x10, x11, 0", 0x1000, 64), { bytes: [0x13, 0x85, 0x05, 0x00], text: "mv a0, a1" });
    assert.deepEqual(riscv.assemble("sd ra, (sp)", 0x1000, 64).text, "sd ra, 0(sp)");
    assert.equal(hex(riscv.assemble("beqz a0, 0x1008", 0x1000, 64).bytes), "63040500");
    assert.equal(hex(riscv.assemble("c.nop", 0x1000, 64, [0x05, 0x00]).bytes), "0500");
    assert.equal(hex(riscv.assemble("c.nop", 0x1000, 64, [0x13, 0, 0, 0]).bytes), "0100");
});

test("a line that isn't one says why", () => {
    for (const [text, why] of [
        ["", /no instruction there/], ["frob a0", /no instruction called frob/], ["addi a0, a0", /: "addi" takes 3 operands, not 2\.$/], ["ret a0", /"ret" takes 0 operands, not 1/],
        ["jal a0, a1, a2", /"jal" takes 1 or 2 operands, not 3/], ["addi a0, a0, 0x800", /: "0x800" isn't one addi can have there\.$/], ["addi a0, fa0, 1", /: "fa0" isn't what addi takes second\.$/],
        ["jal 0x1001", /"0x1001" isn't one jal can have there/], ["beq a0, a1, 0x100000", /"0x100000" isn't one beq can have there/], ["c.lw a0, 4(sp)", /"4\(sp\)" isn't one c\.lw can have there/],
        ["c.addi zero, 1", /"zero" isn't one c\.addi can have there/], ["fadd.s fa0, fa1, fa2, up", /"up" isn't what fadd\.s takes fourth/], ["x".repeat(201), /too long/],
    ]) assert.throws(() => riscv.assemble(text, 0x1000, 64), why, text);
});

test("random bytes: every line shown, typed back, is shown the same, and what was there is kept", () => {
    let seed = 0x2545f491;
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
    for (const xlen of [32, 64]) {
        let lines = 0;
        const names = new Set();
        for (let k = 0; k < 40000; k++) {
            const word = random(), address = [0, 0x1000, 0x100000000][k % 3];
            const bytes = Uint8Array.of(word, word >>> 8, word >>> 16, word >>> 24);
            const [line] = riscv.disassemble(bytes, address, xlen, 1).lines;
            if (line.text === "(bad)") continue;
            lines++;
            names.add(line.text.split(" ")[0]);
            const was = bytes.subarray(0, line.length);
            const made = riscv.assemble(line.text, address, xlen);
            assert.equal(made.text, line.text, `${line.text} (${hex(was)})`);
            assert.deepEqual(riscv.disassemble(Uint8Array.from(made.bytes), address, xlen, 1).lines, [line], `${line.text} (${hex(was)}) as ${hex(made.bytes)}`);
            assert.equal(hex(riscv.assemble(line.text, address, xlen, was).bytes), hex(was), line.text);
        }
        assert.ok(lines > 20000 && names.size > 100, `RV${xlen}: ${lines} lines of ${names.size} names`);
    }
});
