// Writes scripts/disasm/arm64-asm/src/sysreg_names.rs: the names of ARM64's
// system registers, which fARM64 has only the commonest of, as a Capstone
// built with ARM64 writes them for every mrs and msr there can be. Run when
// the pinned Capstone changes (the image build's check-arm64.mjs says when
// the list and it differ):
// node list-arm64-sysregs.mjs <directory of that Capstone> > arm64-asm/src/sysreg_names.rs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const [directory] = process.argv.slice(2);
if (!directory) throw new Error("usage: node list-arm64-sysregs.mjs <reference Capstone directory>");
const lib = await createRequire(import.meta.url)(resolve(directory, "capstone.js"))({ wasmBinary: readFileSync(resolve(directory, "capstone.wasm")) });
const capstone = new lib.Capstone(lib.ARCH_ARM64, lib.MODE_ARM);
const generic = /^s[0-3]_[0-7]_c\d+_c\d+_[0-7]$/;
// The register in mrs x0, <it> (read) or msr <it>, x0 (written), for each
// op0 (2 or 3; its low bit), op1, CRn, CRm and op2: the word's bits 19 to 5.
const named = (word, pattern) => {
    let insn;
    try {
        [insn] = capstone.disasm([word & 255, (word >>> 8) & 255, (word >>> 16) & 255, word >>> 24], 0);
    } catch {
        return null;
    }
    const name = pattern.exec(insn ? `${insn.mnemonic} ${insn.op_str}` : "")?.[1];
    return name && !generic.test(name) ? name : null;
};
const lines = [];
for (let key = 0; key < 1 << 15; key++) {
    const read = named((0xd5300000 | key << 5) >>> 0, /^mrs x0, (\S+)$/), written = named((0xd5100000 | key << 5) >>> 0, /^msr (\S+), x0$/);
    if (read && read === written) lines.push(`    (0x${key.toString(16).padStart(4, "0")}, BOTH, "${read}"),`);
    else {
        if (read) lines.push(`    (0x${key.toString(16).padStart(4, "0")}, READ, "${read}"),`);
        if (written) lines.push(`    (0x${key.toString(16).padStart(4, "0")}, WRITTEN, "${written}"),`);
    }
}
console.log(`// Written by scripts/disasm/list-arm64-sysregs.mjs, from what Capstone names:
// not to be changed by hand. Each is a system register's place (the bits 19
// to 5 of an mrs or msr of it: op0's low bit, op1, CRn, CRm, op2), whether
// it's that when read, written or both, and its name; in order of place.
pub(crate) const READ: u8 = 1;
pub(crate) const WRITTEN: u8 = 2;
pub(crate) const BOTH: u8 = READ | WRITTEN;

#[rustfmt::skip]
pub(crate) const NAMES: &[(u16, u8, &str)] = &[
${lines.join("\n")}
];`);
