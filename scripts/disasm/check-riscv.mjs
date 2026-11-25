// Exercise RISC-V's disassembler and assembler (tabtopd/riscv-asm.js)
// through the worker, as part of the image build: what's shown for bytes;
// that it's what Capstone, which showed RISC-V before, shows (a Capstone
// built with RISC-V for this alone, not served), but for the differences
// listed below; and that every line shown, typed back, assembles to bytes
// shown as that line again, which Capstone reads the same.
// node check-riscv.mjs <riscv-asm.js> <disasm-worker.js> <directory of that Capstone>
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { hex, line, runWorker } from "./worker-harness.mjs";
import { gzipSync } from "node:zlib";

const [scriptFile, workerFile, referenceDirectory] = process.argv.slice(2);
if (!scriptFile || !workerFile || !referenceDirectory) throw new Error("usage: node check-riscv.mjs <riscv-asm.js> <disasm-worker.js> <reference Capstone directory>");
const script = readFileSync(scriptFile, "utf8");
let imports = 0;
const { post, self } = runWorker(workerFile, (self) => ({
    importScripts(path) {
        // (What it has the same as MIPS's, beside it, first.)
        if (path === "./asm-common.js") return runInNewContext(readFileSync(resolve(dirname(scriptFile), "asm-common.js"), "utf8"), { self });
        assert.equal(path, "./riscv-asm.js");
        imports++;
        runInNewContext(script, { self });
    },
    fetch: async (path) => { throw new Error(`RISC-V fetched ${path}`); },
}));
const ask = async (mode, bytes, address = 0x1000, max = 512) => {
    const reply = await post({ mode, bytes: Uint8Array.from(bytes), address, max });
    assert.equal(reply.error, undefined, `${mode}: ${reply.error}`);
    return reply.lines;
};
const assemble = (mode, text, address = 0x1000, was = []) => post({ mode, assemble: text, address, was: [...was] });
const MODES = [["riscv32", 32], ["riscv64", 64]];

// What's shown: a branch's operand is where it goes, a link; through a
// register, nowhere known. Compressed instructions are two bytes.
for (const [mode] of MODES) {
    assert.deepEqual(await ask(mode, [0x13, 0, 0, 0, 0x13, 0x05, 0x15, 0, 0x01, 0, 0x05, 0x05, 0x67, 0x80, 0, 0]), [
        line(0x1000, 4, "nop"), line(0x1004, 4, "addi a0, a0, 1"), line(0x1008, 2, "c.nop"), line(0x100a, 2, "c.addi a0, 1"), line(0x100c, 4, "ret"),
    ]);
    assert.deepEqual(await ask(mode, [0xef, 0, 0, 0x01, 0x63, 0x08, 0xb5, 0, 0x63, 0x18, 0x05, 0, 0x19, 0xc1, 0xe7, 0x80, 0, 0]), [
        line(0x1000, 4, "jal 0x1010", [0x1010]), line(0x1004, 4, "beq a0, a1, 0x1014", [0x1014]), line(0x1008, 4, "bnez a0, 0x1018", [0x1018]),
        line(0x100c, 2, "c.beqz a0, 0x1012", [0x1012]), line(0x100e, 4, "jalr ra"),
    ]);
    // Back, and from past 4 GB; an immediate that isn't a branch's stays as it is.
    assert.deepEqual(await ask(mode, [0xef, 0xf0, 0x9f, 0xff]), [line(0x1000, 4, "jal 0xff8", [0xff8])]);
    assert.deepEqual(await ask(mode, [0xef, 0, 0, 0x01], 0x100000000), [line(0x100000000, 4, "jal 0x100000010", [0x100000010])]);
    assert.deepEqual(await ask(mode, [0x37, 0x55, 0x34, 0x12]), [line(0x1000, 4, "lui a0, 0x12345")]);
    assert.deepEqual(await ask(mode, [0x13, 0x01, 0x01, 0xff, 0x03, 0x25, 0x81, 0x00]), [line(0x1000, 4, "addi sp, sp, -0x10"), line(0x1004, 4, "lw a0, 8(sp)")]);
    // To before the file's start: written as where (as 64 bits wrap), and no link.
    assert.deepEqual(await ask(mode, [0xef, 0xf0, 0x9f, 0xff], 0), [line(0, 4, "jal 0xfffffffffffffff8")]);
    // jalr's number is from a register, not an address.
    assert.deepEqual(await ask(mode, [0x67, 0x85, 0x45, 0x00]), [line(0x1000, 4, "jalr a0, a1, 4")]);
    // An invalid halfword advances by two; a short tail stays visible.
    assert.deepEqual(await ask(mode, [0xff, 0xff, 0x01, 0, 0x13]), [line(0x1000, 2, "(bad)"), line(0x1002, 2, "c.nop"), line(0x1004, 1, "(bad)")]);
    assert.deepEqual(await ask(mode, [0x01, 0, 0x13, 0, 0]), [line(0x1000, 2, "c.nop"), line(0x1002, 2, "(bad)"), line(0x1004, 1, "(bad)")]);
    assert.deepEqual(await ask(mode, []), []);
    assert.deepEqual(await ask(mode, [0xaa]), [line(0x1000, 1, "(bad)")]);
    // No more than asked for; from an odd offset; as many as a view asks for.
    assert.deepEqual(await ask(mode, [0x01, 0, 0x01, 0], 0x1000, 1), [line(0x1000, 2, "c.nop")]);
    assert.equal((await ask(mode, [0x13, 0, 0, 0], 0x1001))[0].offset, 0x1001);
    assert.equal((await ask(mode, new Uint8Array(4096 + 15).fill(0x01).map((b, i) => (i % 2 ? 0 : b)))).length, 512);
}
// What only one of them has.
assert.equal((await ask("riscv64", [0x03, 0x35, 0x81, 0]))[0].text, "ld a0, 8(sp)");
assert.equal((await ask("riscv32", [0x03, 0x35, 0x81, 0]))[0].text, "(bad)");
assert.equal((await ask("riscv32", [0x01, 0x20]))[0].text, "c.jal 0x1000");
assert.equal((await ask("riscv64", [0x05, 0x25]))[0].text, "c.addiw a0, 1");
// The floating point's rounding, written unless it's as frm says; control
// registers by name, or by number.
assert.equal((await ask("riscv64", [0x53, 0x85, 0xc5, 0x00, 0x53, 0xf5, 0xc5, 0x00]))[0].text, "fadd.s fa0, fa1, fa2, rne");
assert.equal((await ask("riscv64", [0x53, 0xf5, 0xc5, 0x00]))[0].text, "fadd.s fa0, fa1, fa2");
assert.equal((await ask("riscv64", [0x73, 0x25, 0x00, 0x30, 0x73, 0x25, 0x00, 0x7c]))[1].text, "csrr a0, 0x7c0");
assert.equal((await ask("riscv64", [0x73, 0x25, 0x00, 0x30]))[0].text, "csrr a0, mstatus");

// The other reader: Capstone's, as the worker showed RISC-V with it.
const reference = await createRequire(import.meta.url)(resolve(referenceDirectory, "capstone.js"))({ wasmBinary: readFileSync(resolve(referenceDirectory, "capstone.wasm")) });
assert.ok(reference.support(reference.ARCH_RISCV));
const readers = new Map(MODES.map(([mode, xlen]) => {
    const reader = new reference.Capstone(reference.ARCH_RISCV, (xlen === 64 ? reference.MODE_RISCV64 : reference.MODE_RISCV32) | reference.MODE_RISCVC);
    reader.option(reference.OPT_DETAIL, reference.OPT_ON);
    reader.option(reference.OPT_SKIPDATA, reference.OPT_ON);
    return [mode, reader];
}));
// Its first line of bytes, {length, text, targets}: where it goes is how
// far, in its text, and the worker wrote the address there instead, if it
// was one a file can have.
function capstoneLine(mode, bytes, address) {
    let first = null;
    readers.get(mode).disasm_iter(bytes, address, (insn) => {
        if (insn.id === 0) first = { length: insn.size, text: "(bad)", targets: [] };
        else {
            const { groups = [], op = [] } = insn.detail;
            const text = [insn.mnemonic, insn.op_str].filter(Boolean).join(" ");
            const branch = groups.some((g) => [reference.GRP_JUMP, reference.GRP_CALL, reference.GRP_BRANCH_RELATIVE].includes(g));
            const last = op.at(-1);
            const to = branch && last?.type === reference.OP_IMM ? BigInt(last.imm) + BigInt(insn.address) : null;
            const linked = to != null && to >= 0n && to <= BigInt(Number.MAX_SAFE_INTEGER);
            first = { length: insn.size, text: linked ? text.replace(/(^|[ ,])(-?(?:0x[0-9a-f]+|\d+))$/, (_, before) => `${before}0x${to.toString(16)}`) : text, targets: linked ? [Number(to)] : [] };
        }
        return false;
    });
    return first ?? { length: bytes.length, text: "(bad)", targets: [] };
}
const written = (v) => (v < 0n ? "-" : "") + ((v < 0n ? -v : v) > 9n ? `0x${(v < 0n ? -v : v).toString(16)}` : `${v < 0n ? -v : v}`);
const valueOf = (sign, digits) => (sign ? -BigInt(digits) : BigInt(digits));
// Where what's shown isn't as Capstone had it, each by its name; how many
// words each took is said at the end, and one that took none is an error.
const DIFFERENCES = {
    // A control register with no name is a number as the others are: in hex from ten.
    "an unnamed control register in hex": (l) => {
        const text = l.text.replace(/^(csr\w+ (?:\w+, )?)(\d\d+)(,|$)/, (_, before, number, after) => `${before}0x${Number(number).toString(16)}${after}`);
        return text === l.text ? null : { ...l, text };
    },
    // Capstone has pmpaddr13 and pmpaddr14 as each other.
    "pmpaddr13 and pmpaddr14 the right way round": (l) => (/pmpaddr1[34]/.test(l.text) ? { ...l, text: l.text.replace(/pmpaddr1[34]/, (name) => (name === "pmpaddr13" ? "pmpaddr14" : "pmpaddr13")) } : null),
    // jalr's number is added to a register: Capstone took it for an address.
    "jalr's offset not an address": (l, at) => {
        const m = /^(jalr \w+, \w+, )(-?)(0x[0-9a-f]+|\d+)$/.exec(l.text);
        if (!m) return null;
        return { ...l, text: m[1] + written(valueOf(m[2], m[3]) - (l.targets.length ? BigInt(at) : 0n)), targets: [] };
    },
    // A branch to before the start (or past what a file can be) is still
    // written as where, as 64 bits wrap, with no link: not as how far.
    "a branch out of the file written as where": (l, at) => {
        const m = /^((?:c\.)?(?:j|jal|b\w+)(?: .*[ ,]| ))(-?)(0x[0-9a-f]+|\d+)$/.exec(l.text);
        return !m || l.targets.length ? null : { ...l, text: `${m[1]}0x${BigInt.asUintN(64, BigInt(at) + valueOf(m[2], m[3])).toString(16)}` };
    },
    // c.lui of nothing isn't an instruction (it's kept for other uses): Capstone showed one.
    "no c.lui of 0": (l) => (/^c\.lui \w+, 0$/.test(l.text) ? { length: 2, text: "(bad)", targets: [] } : null),
    // RV32 has no shift by 32 or more: Capstone showed one.
    "no RV32 shift by more than 31": (l, at, xlen) => (xlen === 32 && /^(c\.)?s(ll|rl|ra)i /.test(l.text) && Number(l.text.split(", ").pop()) > 31 ? { length: 2, text: "(bad)", targets: [] } : null),
};
const differed = new Map(Object.keys(DIFFERENCES).map((name) => [name, 0]));
function expected(mode, xlen, bytes, address) {
    let l = capstoneLine(mode, bytes, address);
    for (const [name, rule] of Object.entries(DIFFERENCES)) {
        const other = rule(l, address, xlen);
        if (!other) continue;
        differed.set(name, differed.get(name) + 1);
        l = other;
    }
    // What isn't an instruction is as long as its first bytes say one there
    // is (four, for low bits 11 that aren't 11111: one of an extension that
    // isn't read), so the half of it isn't read as another: Capstone gave
    // two bytes of it.
    if (l.text === "(bad)" && bytes.length >= 4 && (bytes[0] & 3) === 3 && (bytes[0] & 0x1f) !== 0x1f) l = { ...l, length: 4 };
    return l;
}

// As typed: in either case, numbers in hex or not, registers by number
// too, a comment; addresses as shown.
for (const [mode, text, want, address] of [
    ["riscv64", "nop", "13000000"], ["riscv64", "ret", "67800000"], ["riscv64", "ADDI A0, A0, 1", "13051500"], ["riscv64", "addi x10,x10,0x1", "13051500"],
    ["riscv64", "addi sp, sp, -16", "130101ff"], ["riscv64", "addi sp, sp, -0x10 ; room", "130101ff"], ["riscv64", "mv a0, a1", "13850500"], ["riscv64", "li a0, 1", null],
    ["riscv64", "ld a0, 8(sp)", "03358100"], ["riscv64", "sd ra, 0x18(sp)", "233c1100"], ["riscv64", "lw a0, (a1)", "03a50500"], ["riscv64", "lui a0, 0x12345", "37553412"],
    ["riscv64", "jal 0x1010", "ef000001"], ["riscv64", "j 0xff8", "6ff09fff"], ["riscv64", "beq a0, a1, 0x1014", "630ab500"], ["riscv64", "bnez a0, 0x1008", "63140500"],
    ["riscv64", "jalr ra", "e7800000"], ["riscv64", "jalr a0, a1, 4", "67854500"], ["riscv64", "csrr a0, mstatus", "73250030"], ["riscv64", "csrr a0, 0x7c0", "7325007c"],
    ["riscv64", "csrw 1984, a0", "7310057c"], ["riscv64", "ecall", "73000000"], ["riscv64", "fadd.s fa0, fa1, fa2", "53f5c500"], ["riscv64", "fadd.s fa0, fa1, fa2, rne", "5385c500"],
    ["riscv64", "fmv.s fa0, fa1", "5385b520"], ["riscv64", "fld fa0, 8(sp)", "07358100"], ["riscv64", "amoadd.w a0, a1, (a2)", "2f25b600"], ["riscv64", "lr.d.aq a0, (a1)", "2fb50514"],
    ["riscv64", "addiw a0, a0, 1", "1b051500"], ["riscv64", "slli a0, a0, 63", "1315f503"], ["riscv64", "fence", "0f00f00f"], ["riscv64", "fence iorw, rw", "0f00300f"],
    ["riscv64", "c.nop", "0100"], ["riscv64", "c.addi a0, 1", "0505"], ["riscv64", "c.li a0, -1", "7d55"], ["riscv64", "c.mv a0, a1", "2e85"], ["riscv64", "c.jr ra", "8280"],
    ["riscv64", "c.j 0x1010", "01a8"], ["riscv64", "c.beqz a0, 0x1012", "09c9"], ["riscv64", "c.ldsp ra, 8(sp)", "a260"], ["riscv64", "c.sdsp ra, 8(sp)", "06e4"],
    ["riscv64", "c.addi16sp sp, -0x20", "3d71"], ["riscv64", "c.addi4spn a0, sp, 8", "2800"], ["riscv64", "c.lui a0, 0xfffff", "7d75"], ["riscv64", "c.addiw a0, 1", "0525"],
    ["riscv32", "c.jal 0x1010", "0128"], ["riscv32", "slli a0, a0, 31", "1315f501"], ["riscv32", "c.flw fa0, 4(a0)", "4861"],
    ["riscv64", "jal 0x100000010", "ef000001", 0x100000000], ["riscv64", "j 0xfffffffffffffff8", "6ff09fff", 0], ["riscv64", "beq s0, fp, 0x1000", "63008400"],
]) {
    const got = await assemble(mode, text, address);
    if (want == null) {
        assert.equal(typeof got.error, "string", text);
        continue;
    }
    assert.equal(got.error, undefined, `${text}: ${got.error}`);
    assert.equal(hex(got.bytes), want, text);
    // And Capstone reads those bytes as what the line is then shown as.
    assert.equal(expected(mode, mode === "riscv32" ? 32 : 64, Uint8Array.from(got.bytes), address ?? 0x1000).text, got.text, `${text}: Capstone reads ${hex(got.bytes)} otherwise`);
}
// Another name for it is what's shown; what isn't one says why.
assert.equal((await assemble("riscv64", "addi a0, a1, 0")).text, "mv a0, a1");
assert.equal((await assemble("riscv64", "jalr zero, ra, 0")).text, "ret");
for (const [mode, text] of [["riscv64", ""], ["riscv64", "foo a0"], ["riscv64", "addi a0, a0"], ["riscv64", "addi a0, a0, 0x800"], ["riscv64", "addi a0, q0, 1"], ["riscv64", "addi a0, a0, a0"],
    ["riscv64", "jal 0x1001"], ["riscv64", "jal 0x200000"], ["riscv64", "beq a0, a1, 0x3000"], ["riscv64", "ld a0, 8(sp"], ["riscv64", "ld a0, 8(fa0)"], ["riscv64", "slli a0, a0, 64"],
    ["riscv32", "slli a0, a0, 32"], ["riscv32", "c.slli a0, 32"], ["riscv32", "ld a0, 8(sp)"], ["riscv32", "addiw a0, a0, 1"], ["riscv64", "c.jal 0x1010"], ["riscv32", "c.jal 0x1800"], ["riscv64", "c.lw a0, 4(sp)"],
    ["riscv64", "c.addi zero, 1"], ["riscv64", "c.lw a0, 3(a1)"], ["riscv64", "fadd.s fa0, fa1, fa2, up"], ["riscv64", "csrr a0, 0x1000"], ["riscv64", "lui a0, 0x100000"],
    ["riscv64", "c.lui a0, 0x20"], ["riscv64", "x".repeat(300)]])
    assert.equal(typeof (await assemble(mode, text)).error, "string", `${mode}: ${text}`);
// Another instruction set's line isn't assembled as RISC-V's.
assert.match((await post({ mode: "arm32", assemble: "nop", address: 0 })).error, /only available for x86, ARM64, RISC-V and MIPS/);
// More than one way to encode it (a c.nop that hints): what's there is kept.
assert.equal(hex((await assemble("riscv64", "c.nop", 0x1000, [0x05, 0x00])).bytes), "0500");
assert.equal(hex((await assemble("riscv64", "c.nop", 0x1000, [0x13, 0, 0, 0])).bytes), "0100");

// Every halfword, and words of every opcode and function, with registers
// and numbers as they fall: shown as Capstone showed them, but for the
// differences above; and each line shown, assembled, is its own bytes
// again, which Capstone reads as that line. (Straight through the script:
// it's what the worker calls.)
let seed = 0x9e3779b9;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
const register = () => { const r = random() % 100; return r < 30 ? 0 : r < 40 ? 1 : r < 48 ? 2 : r < 55 ? 10 : random() & 31; };
const little = (w) => [w & 255, (w >>> 8) & 255, (w >>> 16) & 255, w >>> 24];
function* words() {
    for (let h = 0; h < 65536; h++) yield [[h & 255, h >>> 8], 0x1000];
    for (let opcode = 0; opcode < 32; opcode++) for (let f3 = 0; f3 < 8; f3++) for (let f7 = 0; f7 < 128; f7++) for (let k = 0; k < 3; k++)
        yield [little(((f7 << 25) | (register() << 20) | (register() << 15) | (f3 << 12) | (register() << 7) | (opcode << 2) | 3) >>> 0), 0x1000];
    // Every control register; every floating-point operation and rounding;
    // every atomic and fence.
    for (let csr = 0; csr < 4096; csr++) for (let f3 = 0; f3 < 8; f3++) for (const [rd, rs1] of [[0, 0], [10, 0], [0, 11], [10, 11]])
        yield [little(((csr << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | 0x73) >>> 0), 0x1000];
    for (let f7 = 0; f7 < 128; f7++) for (let rs2 = 0; rs2 < 32; rs2++) for (let rm = 0; rm < 8; rm++)
        yield [little(((f7 << 25) | (rs2 << 20) | (register() << 15) | (rm << 12) | (register() << 7) | 0x53) >>> 0), 0x1000];
    for (let high = 0; high < 4096; high++) for (let f3 = 0; f3 < 8; f3++) for (const opcode of [0x0f, 0x2f])
        yield [little(((high << 20) | (register() << 15) | (f3 << 12) | (register() << 7) | opcode) >>> 0), 0x1000];
    for (let k = 0; k < 60000; k++) yield [little((random() | 3) >>> 0), 0x1000];
    // Branches from the start, the end of what a file can be, and between.
    for (const address of [0, 2, 0xfffff000, 0x100000000, Number.MAX_SAFE_INTEGER - 255, 0x1001]) {
        for (let h = 1; h < 65536; h += 4) if ((h >>> 13) === 1 || (h >>> 13) >= 5) yield [[h & 255, h >>> 8], address];
        for (let k = 0; k < 4000; k++) yield [little(((random() & ~0x7f) | [0x6f, 0x63, 0x67, 0x17, 0x37][k % 5]) >>> 0), address];
    }
}
const { riscv } = self;
const same = (a, b) => a.length === b.length && a.text === b.text && a.targets.join() === b.targets.join();
const said = (l) => `${l.text} (${l.length} bytes${l.targets.length ? `, to ${l.targets.map((t) => `0x${t.toString(16)}`).join()}` : ""})`;
const counts = {};
for (const [mode, xlen] of MODES) {
    let checked = 0, shown = 0, exact = 0;
    const names = new Set(), other = new Set();
    for (const [bytes, address] of words()) {
        const at = Uint8Array.from(bytes);
        const [got] = riscv.disassemble(at, address, xlen, 1).lines;
        const want = expected(mode, xlen, at, address);
        assert.ok(same(got, want), `${mode}, ${hex(bytes)} at 0x${address.toString(16)}: shown as ${said(got)}; Capstone has ${said(want)}`);
        checked++;
        if (got.text === "(bad)") continue;
        shown++;
        names.add(got.text.split(" ")[0]);
        const word = at.subarray(0, got.length);
        const made = riscv.assemble(got.text, address, xlen);
        assert.equal(made.text, got.text, `${mode}: ${got.text} (${hex(word)}) assembled to ${hex(made.bytes)}, shown as ${made.text}`);
        const [back] = riscv.disassemble(Uint8Array.from(made.bytes), address, xlen, 1).lines;
        assert.ok(same(back, got) && made.bytes.length === got.length, `${mode}: ${got.text} (${hex(word)}) came back as ${said(back)} (${hex(made.bytes)})`);
        if (hex(made.bytes) === hex(word)) exact++;
        else {
            other.add(got.text.split(" ")[0]);
            // Not the bytes it was: then Capstone too reads them as the line.
            const again = expected(mode, xlen, Uint8Array.from(made.bytes), address);
            assert.ok(same(again, got), `${mode}: ${got.text} (${hex(word)}) assembled to ${hex(made.bytes)}, which Capstone reads as ${said(again)}`);
        }
        // What's there is kept, where it's a way to write the line.
        assert.equal(hex(riscv.assemble(got.text, address, xlen, word).bytes), hex(word), `${mode}: ${got.text} isn't kept as ${hex(word)}`);
    }
    // Only a c.nop that hints is written otherwise than it was.
    assert.deepEqual([...other], ["c.nop"], `${mode}: assembled to other bytes: ${[...other].join(", ")}`);
    counts[mode] = { checked, shown, exact, names: names.size };
}
// Runs of bytes, of any length, from any offset: the same lines, a (bad)
// advancing by two, and the odd byte at the end kept.
let runs = 0;
for (const [mode, xlen] of MODES) {
    for (let k = 0; k < 600; k++) {
        const length = 1 + random() % 96, address = 0x1000 + random() % 4;
        const bytes = Uint8Array.from({ length }, () => (random() % 3 ? random() : [0x13, 0x01, 0x63, 0x6f, 0xef][random() % 5]) & 255);
        const want = [];
        for (let at = 0; at < length;) {
            const l = length - at < 2 ? { length: 1, text: "(bad)", targets: [] } : expected(mode, xlen, bytes.subarray(at), address + at);
            // (Capstone gives the whole of a tail it can't read: here, two bytes of it, then the one.)
            if (l.text === "(bad)" && l.length !== 4) l.length = Math.min(2, length - at);
            want.push(line(address + at, l.length, l.text, l.targets));
            at += l.length;
        }
        assert.deepEqual(await ask(mode, bytes, address), want, `${mode}: ${hex(bytes)} at 0x${address.toString(16)}`);
        runs++;
    }
}
for (const [name, count] of differed) assert.ok(count > 0, `nothing differed from Capstone by "${name}": is it still to be listed?`);
assert.equal(imports, 1);
const bytes = Buffer.from(script);
console.log(`RISC-V (riscv-asm.js): checked; ${MODES.map(([mode]) => `${mode}: ${counts[mode].shown} of ${counts[mode].checked} words shown (${counts[mode].names} names), as Capstone shows them, `
    + `and all assembled back (${counts[mode].exact} to the same bytes, the rest hints of c.nop)`).join("; ")}; ${runs} runs of bytes; `
    + `apart from Capstone by design: ${[...differed].map(([name, count]) => `${name} (${count})`).join(", ")}; ${bytes.length} bytes raw, ${gzipSync(bytes).length} bytes gzip`);
