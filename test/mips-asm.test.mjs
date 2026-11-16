// MIPS's disassembler and assembler (tabtopd/mips-asm.js), by itself: what
// the image build checks against Capstone (scripts/disasm/check-mips.mjs)
// is, here, held to itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const context = {};
new Function("self", readFileSync(new URL("../tabtopd/mips-asm.js", import.meta.url), "utf8"))(context);
const { mips } = context;
const hex = (bytes) => Buffer.from(bytes).toString("hex");
const shown = (bytes, mode = "mips32-be", address = 0x1000) => mips.disassemble(Uint8Array.from(Buffer.from(bytes, "hex")), address, mode, 512).lines.map((l) => l.text);

test("a line as typed: its name and operands, without its comment", () => {
    assert.deepEqual(mips.parseLine("  ADDIU  $v0 , $Zero,0x10 ; more"), { name: "addiu", operands: ["$v0", "$zero", "0x10"] });
    assert.deepEqual(mips.parseLine("lw $a1, 8 ( $sp ) # there"), { name: "lw", operands: ["$a1", "8($sp)"] });
    assert.deepEqual(mips.parseLine("copy_s.b $v0, $w1[3] // one"), { name: "copy_s.b", operands: ["$v0", "$w1[3]"] });
    assert.deepEqual(mips.parseLine("nop"), { name: "nop", operands: [] });
});

test("four bytes an instruction, in either byte order, by the names each has; what isn't one is (bad)", () => {
    assert.deepEqual(shown("10000003" + "00000000" + "24020001" + "03e00008"), ["b 0x1010", "nop", "addiu $v0, $zero, 1", "jr $ra"]);
    assert.deepEqual(shown("03000010" + "00000000" + "01000224" + "0800e003", "mips32-le"), ["b 0x1010", "nop", "addiu $v0, $zero, 1", "jr $ra"]);
    assert.deepEqual(shown("02002025" + "02002021" + "00041080" + "8c850000" + "8c85fff0"), ["move $a0, $s0", "move $a0, $s0", "sll $v0, $a0, 2", "lw $a1, ($a0)", "lw $a1, -0x10($a0)"]);
    assert.deepEqual(shown("7c00003f" + "0000"), ["(bad)", "(bad)"]);
    assert.deepEqual(mips.disassemble(Uint8Array.of(0x0c, 0, 4, 4), 0x1000, "mips32-be", 1).lines, [{ offset: 0x1000, length: 4, text: "jal 0x1010", targets: [0x1010] }]);
    // To before the start: where, as 64 bits wrap, and nowhere to go; a jump is within its 256 MB.
    assert.deepEqual(mips.disassemble(Uint8Array.of(0x10, 0, 0xff, 0xfd), 0, "mips32-be", 1).lines, [{ offset: 0, length: 4, text: "b 0xfffffffffffffff8", targets: [] }]);
    assert.deepEqual(shown("08000004", "mips32-be", 0x30000000), ["j 0x30000010"]);
});

test("what one width has, the other hasn't; a double is in the even registers in MIPS32", () => {
    assert.deepEqual([shown("64020001", "mips64-be"), shown("64020001", "mips32-be")], [["daddiu $v0, $zero, 1"], ["(bad)"]]);
    assert.deepEqual([shown("46241040", "mips64-be"), shown("46241040", "mips32-be")], [["add.d $f1, $f2, $f4"], ["(bad)"]]);
    assert.throws(() => mips.assemble("daddiu $v0, $zero, 1", 0, "mips32-be"), /: "daddiu" is only in MIPS64\.$/);
    assert.throws(() => mips.assemble("add.d $f1, $f2, $f4", 0, "mips32-be"), /"\$f1" isn't one add\.d can have there/);
});

test("a field put in or taken out: where it begins and its size, past a doubleword's first half too", () => {
    assert.deepEqual(shown("7c8238c4" + "7c8220c0"), ["ins $v0, $a0, 3, 5", "ext $v0, $a0, 3, 5"]);
    assert.deepEqual(shown("7c8250c5" + "7c822202" + "7c8238c6", "mips64-be"), ["dinsm $v0, $a0, 3, 0x28", "dextu $v0, $a0, 0x28, 5", "dinsu $v0, $a0, 0x23, 5"]);
    // One that would end before it begins is none.
    assert.deepEqual(shown("7c8210c4"), ["(bad)"]);
    assert.throws(() => mips.assemble("ins $v0, $a0, 30, 5", 0, "mips32-be"), /"5" isn't one ins can have there/);
});

test("a line assembles to its bytes; another name for it is what's shown; what's there is kept", () => {
    assert.deepEqual(mips.assemble("addiu sp, sp, -32", 0x1000, "mips32-be"), { bytes: [0x27, 0xbd, 0xff, 0xe0], text: "addiu $sp, $sp, -0x20" });
    assert.deepEqual(mips.assemble("addiu $29, $29, -32", 0x1000, "mips32-le"), { bytes: [0xe0, 0xff, 0xbd, 0x27], text: "addiu $sp, $sp, -0x20" });
    assert.deepEqual(mips.assemble("or $a0, $s0, $zero", 0x1000, "mips32-be"), { bytes: [0x02, 0x00, 0x20, 0x25], text: "move $a0, $s0" });
    assert.equal(mips.assemble("lw $a1, 0($a0)", 0x1000, "mips32-be").text, "lw $a1, ($a0)");
    assert.equal(mips.assemble("sw $ra, 28($s8)", 0x1000, "mips32-be").text, "sw $ra, 0x1c($fp)");
    assert.equal(hex(mips.assemble("clz $v0, $a0", 0x1000, "mips32-be").bytes), "70821020");
    assert.equal(hex(mips.assemble("move $a0, $s0", 0x1000, "mips32-be", [0x02, 0x00, 0x20, 0x21]).bytes), "02002021");
    assert.equal(hex(mips.assemble("move $a0, $s0", 0x1000, "mips32-be", [0, 0, 0, 0]).bytes), "02002025");
});

test("a line that isn't one says why", () => {
    for (const [text, why] of [
        ["", /no instruction there/], ["frob $a0", /no instruction called frob/], ["addiu $v0, $zero", /"addiu" takes 3 operands, not 2/], ["nop $a0", /"nop" takes 0 operands, not 1/],
        ["addiu $v0, $zero, 0x8000", /"0x8000" isn't one addiu can have there/], ["addiu $v0, $f0, 1", /"\$f0" isn't what addiu takes second/], ["b 0x1002", /"0x1002" isn't one b can have there/],
        ["beq $a0, $a1, 0x100000", /"0x100000" isn't one beq can have there/], ["j 0x10000000", /"0x10000000" isn't one j can have there/], ["lw $a1, 4($a0", /isn't what lw takes second/],
        ["sll $v0, $a0, 32", /"32" isn't one sll can have there/], ["x".repeat(201), /too long/],
    ]) assert.throws(() => mips.assemble(text, 0x1000, "mips32-be"), why, text);
});

test("random words: every line shown, typed back, is shown the same, and what was there is kept", () => {
    let seed = 0x2545f491;
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
    for (const mode of ["mips32-be", "mips32-le", "mips64-be", "mips64-le"]) {
        let lines = 0;
        const names = new Set();
        for (let k = 0; k < 30000; k++) {
            // (Half with a field or two empty, as instructions have them.)
            const word = (random() & [0xffffffff, 0xfc1fffff, 0xffe0ffff, 0xfffff83f, 0xffff07ff, 0xfc00ffff, 0xffff003f, 0xfc0007ff][k % 8]) >>> 0, address = [0, 0x1000, 0x100000000][k % 3];
            const bytes = Uint8Array.of(word, word >>> 8, word >>> 16, word >>> 24);
            const [line] = mips.disassemble(bytes, address, mode, 1).lines;
            if (line.text === "(bad)") continue;
            lines++;
            names.add(line.text.split(" ")[0]);
            const made = mips.assemble(line.text, address, mode);
            assert.equal(made.text, line.text, `${line.text} (${hex(bytes)})`);
            assert.deepEqual(mips.disassemble(Uint8Array.from(made.bytes), address, mode, 1).lines, [line], `${line.text} (${hex(bytes)}) as ${hex(made.bytes)}`);
            assert.equal(hex(mips.assemble(line.text, address, mode, bytes).bytes), hex(bytes), line.text);
        }
        assert.ok(lines > 10000 && names.size > 200, `${mode}: ${lines} lines of ${names.size} names`);
    }
});
