// The assembler's reading of a line (tabtopd/x86-asm.js), which needs no
// iced-x86; what it assembles to is checked where iced runs, as the image
// is built (scripts/disasm/build.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const context = {};
// A classic script, as the worker loads it: what it makes, on self.
new Function("self", readFileSync(new URL("../tabtopd/x86-asm.js", import.meta.url), "utf8"))(context);
const { parseLine, parseNumber, aliases } = context.x86Parse;
const REGISTERS = ["rax", "rbx", "rcx", "rdi", "rsi", "rbp", "rsp", "eax", "ecx", "al", "ah", "bh", "st", "st(1)", "fs", "es", "zmm0", "zmm1", "k1", "xmm1", "rip"];
const register = (name) => (REGISTERS.includes(name) ? name : undefined);
const plain = (value) => JSON.parse(JSON.stringify(value, (_, v) => (typeof v === "bigint" ? `${v}n` : v)));

test("numbers: 0x, h as the disassembly shows them, decimal, negative, and characters", () => {
    assert.equal(parseNumber("0x1f"), 31n);
    assert.equal(parseNumber("0FFh"), 255n);
    assert.equal(parseNumber("0000000000001012h"), 0x1012n);
    assert.equal(parseNumber("10"), 10n);
    assert.equal(parseNumber("-8"), -8n);
    assert.equal(parseNumber("'A'"), 0x41n);
    assert.equal(parseNumber("'MZ'"), 0x5a4dn);
    assert.equal(parseNumber("ah"), null);
    assert.equal(parseNumber("ffh"), null);
});

test("a line: prefixes, mnemonic, branch size, and operands of each kind", () => {
    assert.deepEqual(plain(parseLine("MOV RAX,[RBX+RCX*8+100h]", register)), {
        prefixes: [], mnemonic: "mov", branch: null, decorations: [], operands: [
            { kind: "reg", reg: "rax", decorations: [] },
            { kind: "mem", size: null, bcst: false, seg: null, base: "rbx", index: "rcx", scale: 8, disp: "256n", abs: false, rel: false, decorations: [] }],
    });
    const rep = parseLine("rep movsb [rdi],[rsi]", register);
    assert.deepEqual([rep.prefixes, rep.mnemonic, rep.operands.map((o) => o.base)], [["rep"], "movsb", ["rdi", "rsi"]]);
    const jump = parseLine("jmp short 0000000000001012h", register);
    assert.deepEqual([jump.branch, plain(jump.operands[0].value)], ["short", "4114n"]);
    const fs = parseLine("mov rax,qword ptr fs:[28h]", register).operands[1];
    assert.deepEqual([fs.size, fs.seg, fs.base, plain(fs.disp)], [8, "fs", null, "40n"]);
    assert.deepEqual(plain(parseLine("mov eax,[rbp-8]", register).operands[1].disp), "-8n");
    assert.equal(parseLine("lea rax,[4*rcx]", register).operands[1].scale, 4);
    assert.equal(parseLine("mov rax,[abs 10h]", register).operands[1].abs, true);
    // EVEX: masks, zeroing, broadcast and rounding, gathered from where they are.
    const evex = parseLine("vaddps zmm0{k1}{z},zmm1,[rax]{1to16},{rn-sae}", register);
    assert.deepEqual([evex.operands.length, evex.decorations], [3, ["rn-sae", "k1", "z", "1to16"]]);
    assert.equal(parseLine("vaddps zmm0,zmm1,dword bcst [rax]", register).operands[2].bcst, true);
    // x87, far pointers (both ways), imul's short form, characters and a comment.
    assert.deepEqual(parseLine("fadd st,st(1)", register).operands.map((o) => o.reg), ["st", "st(1)"]);
    assert.deepEqual(plain(parseLine("jmp far 12345678h,0010h", register).operands), [{ kind: "far", off: "305419896n", sel: "16n", decorations: [] }]);
    assert.deepEqual(plain(parseLine("jmp 10h:2000h", register).operands[0]), { kind: "far", sel: "16n", off: "8192n", decorations: [] });
    assert.deepEqual(parseLine("imul eax,10", register).operands.map((o) => o.kind), ["reg", "reg", "imm"]);
    assert.deepEqual(plain(parseLine("cmp al,';' ; a semicolon", register).operands[1]), { kind: "imm", value: "59n", decorations: [] });
    assert.deepEqual(aliases("jz"), ["je"]);
    assert.deepEqual(aliases("cmovnae"), ["cmovb"]);
});

test("a line that isn't one says why", () => {
    assert.throws(() => parseLine("", register), /Type an instruction/);
    assert.throws(() => parseLine("mov eax,[rax+rbx+rcx]", register), /too many registers/);
    assert.throws(() => parseLine("mov eax,[rax-rbx]", register), /can't be taken away/);
    assert.throws(() => parseLine("mov eax,[rax*3]", register), /can't be in an address/);
    assert.throws(() => parseLine("mov eax,huge ptr [rax]", register), /isn't a size/);
    assert.throws(() => parseLine("mov eax,banana", register), /isn't an operand/);
});
