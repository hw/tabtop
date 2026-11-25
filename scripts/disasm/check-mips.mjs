// Exercise MIPS's disassembler and assembler (tabtopd/mips-asm.js) through
// the worker, as part of the image build: what's shown for bytes; that it's
// what Capstone, which showed MIPS before, shows (a Capstone built with
// MIPS for this alone, not served), but for the differences listed below;
// and that every line shown, typed back, assembles to bytes shown as that
// line again, which Capstone reads the same.
// node check-mips.mjs <mips-asm.js> <disasm-worker.js> <directory of that Capstone>
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { hex, line, runWorker } from "./worker-harness.mjs";
import { gzipSync } from "node:zlib";

const [scriptFile, workerFile, referenceDirectory] = process.argv.slice(2);
if (!scriptFile || !workerFile || !referenceDirectory) throw new Error("usage: node check-mips.mjs <mips-asm.js> <disasm-worker.js> <reference Capstone directory>");
const script = readFileSync(scriptFile, "utf8");
let imports = 0;
const { post, self } = runWorker(workerFile, (self) => ({
    importScripts(path) {
        // (What it has the same as RISC-V's, beside it, first.)
        if (path === "./asm-common.js") return runInNewContext(readFileSync(resolve(dirname(scriptFile), "asm-common.js"), "utf8"), { self });
        assert.equal(path, "./mips-asm.js");
        imports++;
        runInNewContext(script, { self });
    },
    fetch: async (path) => { throw new Error(`MIPS fetched ${path}`); },
}));
const ask = async (mode, bytes, address = 0x1000, max = 512) => {
    const reply = await post({ mode, bytes: Uint8Array.from(bytes), address, max });
    assert.equal(reply.error, undefined, `${mode}: ${reply.error}`);
    return reply.lines;
};
const assemble = (mode, text, address = 0x1000, was = []) => post({ mode, assemble: text, address, was: [...was] });
const MODES = ["mips32-le", "mips32-be", "mips64-le", "mips64-be"];
const xlenOf = (mode) => (mode.startsWith("mips64") ? 64 : 32), little = (mode) => mode.endsWith("-le");
// A word's bytes in a mode's order.
const inOrder = (mode, word) => (little(mode) ? [0, 8, 16, 24] : [24, 16, 8, 0]).map((shift) => (word >>> shift) & 255);

// What's shown, in each width and byte order: a branch's and a jump's
// operand is where it goes, a link; through a register, nowhere known.
for (const mode of MODES) {
    const bytes = (...words) => words.flatMap((word) => inOrder(mode, word));
    assert.deepEqual(await ask(mode, bytes(0x10000003, 0, 0x24020001)), [
        line(0x1000, 4, "b 0x1010", [0x1010]), line(0x1004, 4, "nop"), line(0x1008, 4, "addiu $v0, $zero, 1"),
    ]);
    assert.deepEqual(await ask(mode, bytes(0x0c000404)), [line(0x1000, 4, "jal 0x1010", [0x1010])]);
    assert.deepEqual(await ask(mode, bytes(0x0320f809, 0x03e00008)), [line(0x1000, 4, "jalr $t9"), line(0x1004, 4, "jr $ra")]);
    assert.deepEqual(await ask(mode, bytes(0x1000fffe)), [line(0x1000, 4, "b 0xffc", [0xffc])]);
    assert.deepEqual(await ask(mode, bytes(0x8fbf001c, 0x27bdffe0, 0x8c850000)), [line(0x1000, 4, "lw $ra, 0x1c($sp)"), line(0x1004, 4, "addiu $sp, $sp, -0x20"), line(0x1008, 4, "lw $a1, ($a0)")]);
    // From past 4 GB, in MIPS32 too: where it goes isn't cut to 32 bits.
    assert.deepEqual(await ask(mode, bytes(0x10000003), 0x100000000), [line(0x100000000, 4, "b 0x100000010", [0x100000010])]);
    // To before the file's start: written as where (as 64 bits wrap), and no link.
    assert.deepEqual(await ask(mode, bytes(0x1000fffd), 0), [line(0, 4, "b 0xfffffffffffffff8")]);
    // What isn't an instruction advances by four; a short tail stays visible.
    assert.deepEqual(await ask(mode, [...bytes(0x7c00003f, 0), 0xaa]), [line(0x1000, 4, "(bad)"), line(0x1004, 4, "nop"), line(0x1008, 1, "(bad)")]);
    assert.deepEqual(await ask(mode, []), []);
    assert.deepEqual(await ask(mode, [0, 0, 0]), [line(0x1000, 3, "(bad)")]);
    // No more than asked for; from an odd offset; as many as a view asks for.
    assert.equal((await ask(mode, bytes(0, 0), 0x1000, 1)).length, 1);
    assert.equal((await ask(mode, bytes(0), 0x1001))[0].offset, 0x1001);
    assert.equal((await ask(mode, new Uint8Array(4096 + 15))).length, 512);
    // What only MIPS64 has.
    assert.equal((await ask(mode, bytes(0x64020001)))[0].text, xlenOf(mode) === 64 ? "daddiu $v0, $zero, 1" : "(bad)");
}
// The extensions Capstone showed: floating point, DSP, MSA; Octeon's in MIPS64.
assert.deepEqual((await ask("mips32-be", [0x46, 0x20, 0x10, 0x00, 0x7c, 0x64, 0x12, 0x10, 0x78, 0x03, 0x10, 0x4e])).map((l) => l.text),
    ["add.d $f0, $f2, $f0", "addu.ph $v0, $v1, $a0", "addv.b $w1, $w2, $w3"]);
assert.equal((await ask("mips64-be", [0xc8, 0x83, 0x00, 0x03]))[0].text, "bbit0 $a0, 3, 0x1010");

// The other reader: Capstone's, as the worker showed MIPS with it.
const reference = await createRequire(import.meta.url)(resolve(referenceDirectory, "capstone.js"))({ wasmBinary: readFileSync(resolve(referenceDirectory, "capstone.wasm")) });
assert.ok(reference.support(reference.ARCH_MIPS));
const readers = new Map(MODES.map((mode) => {
    const reader = new reference.Capstone(reference.ARCH_MIPS, ((xlenOf(mode) === 64 ? reference.MODE_MIPS64 : reference.MODE_MIPS32)
        | (little(mode) ? reference.MODE_LITTLE_ENDIAN : reference.MODE_BIG_ENDIAN)) >>> 0);
    reader.option(reference.OPT_DETAIL, reference.OPT_ON);
    reader.option(reference.OPT_SKIPDATA, reference.OPT_ON);
    return [mode, reader];
}));
// Its line for a word, {text, targets}, as the worker had it: a link where
// it's a jump or a branch (jal by its name: Capstone has it as neither),
// cut to 32 bits in MIPS32.
function capstoneLine(mode, word, address) {
    let first = { text: "(bad)", targets: [] };
    readers.get(mode).disasm_iter(inOrder(mode, word), address, (insn) => {
        if (insn.id !== 0) {
            const { groups = [], op = [] } = insn.detail;
            const branch = groups.some((g) => [reference.GRP_JUMP, reference.GRP_CALL, reference.GRP_BRANCH_RELATIVE].includes(g)) || insn.id === reference.MIPS_INS_JAL;
            const last = op.at(-1);
            let to = branch && last?.type === reference.OP_IMM ? BigInt(last.imm) : null;
            if (to != null && xlenOf(mode) === 32) to = BigInt.asUintN(32, to);
            first = { text: [insn.mnemonic, insn.op_str].filter(Boolean).join(" "), targets: to != null && to >= 0n && to <= BigInt(Number.MAX_SAFE_INTEGER) ? [Number(to)] : [] };
        }
        return false;
    });
    return first;
}
const written = (v) => (v < 0n ? "-" : "") + ((v < 0n ? -v : v) > 9n ? `0x${(v < 0n ? -v : v).toString(16)}` : `${v < 0n ? -v : v}`);
const valueOf = (text) => (text[0] === "-" ? -BigInt(text.slice(1)) : BigInt(text));
const lastNumber = (text) => /(^|[ ,])(-?(?:0x[0-9a-f]+|\d+))$/.exec(text);
// Where what's shown isn't as Capstone had it, each by its name; how many
// words each took is said at the end, and one that took none is an error.
const DIFFERENCES = {
    // A field put in or taken out of a register: where it begins and how
    // long it is. Capstone wrote those past a doubleword's first half 32
    // short, and showed one that would end before it begins.
    "a field's place and size as they are": (l) => {
        const m = /^(ins|dins|dinsm|dinsu|dextm|dextu) (.*), (\S+), (\S+)$/.exec(l.text);
        if (!m) return null;
        const at = valueOf(m[3]) + (/^d(ins|ext)u$/.test(m[1]) ? 32n : 0n), size = valueOf(m[4]) + (/^d(ins|ext)m$/.test(m[1]) ? 32n : 0n);
        if (size < 1n) return { text: "(bad)", targets: [] };
        const text = `${m[1]} ${m[2]}, ${written(at)}, ${written(size)}`;
        return text === l.text ? null : { ...l, text };
    },
    // jalx goes somewhere too: Capstone has it as no jump.
    "jalx's target a link": (l) => (/^jalx /.test(l.text) && !l.targets.length ? { ...l, targets: [Number(valueOf(l.text.split(" ")[1]))] } : null),
    // A branch to before the start is still written as where, as 64 bits
    // wrap, with no link: not as a negative number (linked, in MIPS32, to
    // where that is in 32 bits).
    "a branch to before the file written as where": (l) => {
        const m = /^[bj]/.test(l.text) && lastNumber(l.text);
        return m && m[2][0] === "-" ? { text: `${l.text.slice(0, m.index)}${m[1]}0x${BigInt.asUintN(64, valueOf(m[2])).toString(16)}`, targets: [] } : null;
    },
    // In MIPS32, from past 4 GB in a file: the link is where the text says
    // (none, past what a file can be), not its low 32 bits.
    "a MIPS32 branch's link not cut to 32 bits": (l, xlen) => {
        const m = xlen === 32 && l.targets.length && lastNumber(l.text);
        return m && valueOf(m[2]) >= 2n ** 32n ? { ...l, targets: valueOf(m[2]) <= BigInt(Number.MAX_SAFE_INTEGER) ? [Number(valueOf(m[2]))] : [] } : null;
    },
};
const differed = new Map(Object.keys(DIFFERENCES).map((name) => [name, 0]));
function expected(mode, word, address) {
    let l = capstoneLine(mode, word, address);
    for (const [name, rule] of Object.entries(DIFFERENCES)) {
        const other = rule(l, xlenOf(mode));
        if (!other) continue;
        differed.set(name, differed.get(name) + 1);
        l = other;
    }
    return l;
}
const wordOf = (mode, bytes) => (little(mode) ? bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24) : (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;

// As typed: in either case, with or without $, registers by number too,
// numbers in hex or not, a comment; addresses as shown. Capstone reads
// what's assembled as the line is then shown.
for (const [mode, text, want, address] of [
    ["mips32-be", "nop", "00000000"], ["mips32-le", "addiu $v0, $zero, 1", "01000224"], ["mips32-be", "ADDIU v0, zero, 0x1", "24020001"], ["mips32-be", "addiu $2, $0, 1 ; one", "24020001"],
    ["mips32-be", "addiu $sp, $sp, -32", "27bdffe0"], ["mips32-be", "lw $ra, 0x1c($sp)", "8fbf001c"], ["mips32-be", "lw $a1, ($a0)", "8c850000"], ["mips32-be", "lw $a1, 0($a0)", "8c850000"],
    ["mips32-be", "sw ra, 28(sp)", "afbf001c"], ["mips32-be", "lui $a0, 0x1234", "3c041234"], ["mips32-be", "ori $a0, $a0, 0x5678", "34845678"], ["mips32-be", "move $a0, $s0", "02002025"],
    ["mips32-be", "jr $ra", "03e00008"], ["mips32-be", "jalr $t9", "0320f809"], ["mips32-be", "jal 0x1010", "0c000404"], ["mips32-be", "j 0x2000", "08000800"],
    ["mips32-be", "b 0x1010", "10000003"], ["mips32-be", "beq $a0, $a1, 0x1010", "10850003"], ["mips32-be", "bnez $v0, 0xffc", "1440fffe"], ["mips32-be", "bal 0x1010", "04110003"],
    ["mips32-be", "sll $v0, $a0, 2", "00041080"], ["mips32-be", "syscall", "0000000c"], ["mips32-be", "break 7", "0007000d"], ["mips32-be", "mfc0 $t0, $t4, 0", "40086000"],
    ["mips32-be", "mfc0 $t0, $12, 0", "40086000"], ["mips32-be", "add.s $f0, $f2, $f4", "46041000"], ["mips32-be", "add.d $f0, $f2, $f4", "46241000"], ["mips32-be", "lwc1 $f0, 8($sp)", "c7a00008"],
    ["mips32-be", "bc1t 0x1010", "45010003"], ["mips32-be", "c.eq.s $f0, $f2", "46020032"], ["mips32-be", "ext $v0, $a0, 3, 5", "7c8220c0"], ["mips32-be", "ins $v0, $a0, 3, 5", "7c8238c4"],
    ["mips32-be", "clz $v0, $a0", "70821020"], ["mips32-be", "mul $v0, $a0, $a1", "70851002"], ["mips32-be", "addv.b $w1, $w2, $w3", "7803104e"], ["mips32-be", "ld.w $w1, 8($a0)", "78022062"],
    ["mips32-be", "copy_s.b $v0, $w1[3]", "78830899"], ["mips32-be", "addq.ph $v0, $v1, $a0", "7c641290"], ["mips64-be", "daddiu $sp, $sp, -0x10", "67bdfff0"], ["mips64-be", "ld $ra, 8($sp)", "dfbf0008"],
    ["mips64-be", "dsll $v0, $a0, 4", "00041138"], ["mips64-be", "dins $v0, $a0, 3, 5", "7c8238c7"], ["mips64-be", "dinsm $v0, $a0, 3, 40", "7c8250c5"], ["mips64-be", "dextu $v0, $a0, 40, 5", "7c822202"],
    ["mips64-be", "bbit0 $a0, 3, 0x1010", "c8830003"], ["mips64-le", "jal 0x100001010", "0404000c", 0x100000000], ["mips32-be", "b 0xfffffffffffffff8", "1000fffd", 0],
]) {
    const got = await assemble(mode, text, address);
    assert.equal(got.error, undefined, `${text}: ${got.error}`);
    assert.equal(hex(got.bytes), want, text);
    assert.equal(expected(mode, wordOf(mode, got.bytes), address ?? 0x1000).text, got.text, `${text}: Capstone reads ${hex(got.bytes)} otherwise`);
}
// Another name for it is what's shown; what isn't one says why.
assert.equal((await assemble("mips32-be", "or $a0, $s0, $zero")).text, "move $a0, $s0");
assert.equal((await assemble("mips32-be", "sll $zero, $zero, 0")).text, "nop");
assert.equal((await assemble("mips32-be", "beq $zero, $zero, 0x1010")).text, "b 0x1010");
for (const [mode, text] of [["mips32-be", ""], ["mips32-be", "foo $a0"], ["mips32-be", "addiu $v0, $zero"], ["mips32-be", "addiu $v0, $zero, 0x8000"], ["mips32-be", "addiu $v0, $q0, 1"],
    ["mips32-be", "addiu $v0, $zero, $a0"], ["mips32-be", "b 0x1002"], ["mips32-be", "b 0x100000"], ["mips32-be", "j 0x10000000"], ["mips32-be", "j 0x1002"], ["mips32-be", "lw $a1, 4($a0"],
    ["mips32-be", "lw $a1, 4($f0)"], ["mips32-be", "sll $v0, $a0, 32"], ["mips32-be", "daddiu $sp, $sp, -16"], ["mips32-be", "add.d $f1, $f2, $f4"], ["mips32-be", "ins $v0, $a0, 30, 5"],
    ["mips32-be", "ext $v0, $a0, 3, 0"], ["mips32-be", "li $v0, 1"], ["mips32-be", "bbit0 $a0, 3, 0x1010"], ["mips64-be", "copy_s.b $v0, $w1[16]"], ["mips32-be", "x".repeat(300)]])
    assert.equal(typeof (await assemble(mode, text)).error, "string", `${mode}: ${text}`);
// Another instruction set's line isn't assembled as MIPS's.
assert.match((await post({ mode: "arm32", assemble: "nop", address: 0 })).error, /only available for x86, ARM64, RISC-V and MIPS/);
// More than one way to encode it: what's there is kept; else, the usual one.
assert.equal(hex((await assemble("mips32-be", "move $a0, $s0", 0x1000, [0x02, 0x00, 0x20, 0x21])).bytes), "02002021");
assert.equal(hex((await assemble("mips32-be", "move $a0, $s0", 0x1000, [0, 0, 0, 0])).bytes), "02002025");

// Words of every opcode, with every value of the fields that say which
// instruction one is, and registers and numbers as they fall: shown as
// Capstone showed them, but for the differences above; and each line
// shown, assembled, is shown as that again, which Capstone reads as that
// line. (Straight through the script: it's what the worker calls.)
let seed = 0x9e3779b9;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
function* words() {
    // The opcodes whose function is in the low six bits, and in the ten after the opcode.
    for (const opcode of [0, 0x10, 0x11, 0x12, 0x13, 0x1c, 0x1e, 0x1f]) for (let high = 0; high < 1024; high++) for (let f = 0; f < 64; f++) {
        const word = ((opcode << 26) | (high << 16) | (random() & 0xffc0) | f) >>> 0;
        yield word; yield (word & ~0xf800) >>> 0; yield (word & ~0x07c0) >>> 0; yield (word & ~0xffc0) >>> 0;
    }
    // And in the five after those (DSP's).
    for (const opcode of [0, 0x1c, 0x1f]) for (let f = 0; f < 64; f++) for (let sa = 0; sa < 32; sa++) for (let k = 0; k < 8; k++) {
        const word = ((opcode << 26) | (random() & 0x03fff800) | (sa << 6) | f) >>> 0;
        yield word; yield (word & ~0x03e00000) >>> 0; yield (word & ~0x001f0000) >>> 0; yield (word & ~0x0000f800) >>> 0;
    }
    for (let opcode = 0; opcode < 64; opcode++) for (let rt = 0; rt < 32; rt++) for (let rs = 0; rs < 32; rs++) {
        const word = ((opcode << 26) | (rs << 21) | (rt << 16) | (random() & 0xffff)) >>> 0;
        yield word; yield (word & ~0x7ff) >>> 0; yield (word & ~0xffff) >>> 0;
    }
    for (let k = 0; k < 300000; k++) yield random();
    // And around every instruction the script has: the words one and two
    // of its fixed bits away, which are another instruction, or none. (So
    // one that Capstone shows and the script hasn't isn't missed for
    // being rare.)
    for (const row of script.slice(script.indexOf("const TABLE = `") + 15, script.indexOf("\n`;")).trim().split("\n")) {
        const [, match, mask] = row.split(" ").map((field) => parseInt(field, 16));
        const base = (match | (random() & ~mask)) >>> 0, fixed = Array.from({ length: 32 }, (_, bit) => bit).filter((bit) => mask & (1 << bit));
        yield base;
        for (let i = 0; i < fixed.length; i++) {
            yield (base ^ (1 << fixed[i])) >>> 0;
            for (let j = i + 1; j < fixed.length; j++) yield (base ^ (1 << fixed[i]) ^ (1 << fixed[j])) >>> 0;
        }
    }
}
// Branches from the start, the end of a jump's 256 MB, past 4 GB, and between.
const ADDRESSES = [0x1000, 0x1000, 0x1000, 0x1000, 0x1000, 0, 0x2ffffffc, 0x100000000, 0xfffffffc, Number.MAX_SAFE_INTEGER - 1023];
const { mips } = self;
const same = (a, b) => a.text === b.text && a.targets.join() === b.targets.join();
const said = (l) => `${l.text}${l.targets.length ? ` (to ${l.targets.map((t) => `0x${t.toString(16)}`).join()})` : ""}`;
const MANY_WAYS = new Set(["move", "jr", "sync", "clz", "clo", "dclz", "dclo"]);
const counts = {};
for (const mode of ["mips32-be", "mips64-le"]) {
    let checked = 0, shown = 0, exact = 0;
    const names = new Set(), other = new Set();
    for (const word of words()) {
        const address = ADDRESSES[checked % ADDRESSES.length], bytes = Uint8Array.from(inOrder(mode, word));
        const [got] = mips.disassemble(bytes, address, mode, 1).lines;
        const want = expected(mode, word, address);
        assert.ok(same(got, want), `${mode}, ${hex(bytes)} at 0x${address.toString(16)}: shown as ${said(got)}; Capstone has ${said(want)}`);
        checked++;
        if (got.text === "(bad)") continue;
        shown++;
        const name = got.text.split(" ")[0];
        names.add(name);
        const made = mips.assemble(got.text, address, mode);
        assert.equal(made.text, got.text, `${mode}: ${got.text} (${hex(bytes)}) assembled to ${hex(made.bytes)}, shown as ${made.text}`);
        const [back] = mips.disassemble(Uint8Array.from(made.bytes), address, mode, 1).lines;
        assert.ok(same(back, got), `${mode}: ${got.text} (${hex(bytes)}) came back as ${said(back)} (${hex(made.bytes)})`);
        if (hex(made.bytes) === hex(bytes)) exact++;
        else {
            other.add(name);
            // Not the bytes it was: then Capstone too reads them as the line.
            const again = expected(mode, wordOf(mode, made.bytes), address);
            assert.ok(same(again, got), `${mode}: ${got.text} (${hex(bytes)}) assembled to ${hex(made.bytes)}, which Capstone reads as ${said(again)}`);
        }
        // What's there is kept, where it's a way to write the line.
        assert.equal(hex(mips.assemble(got.text, address, mode, bytes).bytes), hex(bytes), `${mode}: ${got.text} isn't kept as ${hex(bytes)}`);
    }
    // Only those with more than one way to write them come back otherwise.
    for (const name of other) assert.ok(MANY_WAYS.has(name), `${mode}: ${name} assembled to other bytes`);
    counts[mode] = { checked, shown, exact, names: names.size };
}
// Runs of bytes, of any length, from any offset, in each mode: the same
// lines, each word by itself, and the odd bytes at the end kept.
let runs = 0;
for (const mode of MODES) {
    for (let k = 0; k < 300; k++) {
        const length = 1 + random() % 64, address = 0x1000 + random() % 4;
        const bytes = Uint8Array.from({ length }, () => (random() % 4 ? random() : 0) & 255);
        const want = [];
        for (let at = 0; at < length; at += 4) {
            const l = length - at < 4 ? { text: "(bad)", targets: [] } : expected(mode, wordOf(mode, bytes.subarray(at, at + 4)), address + at);
            want.push(line(address + at, Math.min(4, length - at), l.text, l.targets));
        }
        assert.deepEqual(await ask(mode, bytes, address), want, `${mode}: ${hex(bytes)} at 0x${address.toString(16)}`);
        runs++;
    }
}
for (const [name, count] of differed) assert.ok(count > 0, `nothing differed from Capstone by "${name}": is it still to be listed?`);
assert.equal(imports, 1);
const size = Buffer.from(script);
console.log(`MIPS (mips-asm.js): checked; ${Object.entries(counts).map(([mode, c]) => `${mode}: ${c.shown} of ${c.checked} words shown (${c.names} names), as Capstone shows them, `
    + `and all assembled back (${c.exact} to the same bytes, the rest another way to write the same)`).join("; ")}; ${runs} runs of bytes; `
    + `apart from Capstone by design: ${[...differed].map(([name, count]) => `${name} (${count})`).join(", ")}; ${size.length} bytes raw, ${gzipSync(size).length} bytes gzip`);
