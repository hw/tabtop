// Disassembles x86, ARM and MIPS for the hex view's data inspector,
// with iced-x86 and Capstone.js (WebAssembly; see scripts/disasm), fetched when
// first asked for; and assembles a line of it, to edit code in place (see
// x86-asm.js). tabtopd serves this with "./disasm/" made the path the
// library is served under, and a CSP that lets it run WebAssembly, which
// the page itself can't.
//
// Asked {id, bytes, address, mode, max}: the bytes, the file offset of
// the first, the instruction set, and the most instructions; it answers {id,
// lines: [{offset, length, text, targets}]}, "(bad)" for bytes that aren't
// an instruction, targets the addresses it names (where it jumps or calls
// to, or the memory it reads by address alone), or {id, error}.
//
// Asked {id, assemble: text, address, bitness, was}: the line, where it's
// to go, and the bytes there now; it answers {id, bytes, text}: its bytes,
// and how it's shown; or {id, error}, saying why it can't be.
"use strict";

// Loaded once; but a load that failed (the network, say) is forgotten, so
// the next question tries again rather than failing for good.
let iced = null, capstone = null, assembler = null;
const load = () => iced ??= Promise.resolve().then(() => {
    if (!self.icedInit) importScripts("./disasm/iced.js", "./x86-asm.js");
    return fetch("./disasm/iced_x86_bg.wasm");
})
    .then((r) => {
        if (!r.ok) throw new Error("the disassembler isn't available here");
        return r.arrayBuffer();
    })
    .then((bytes) => self.icedInit(bytes))
    .catch((err) => {
        iced = null;
        throw err;
    });

const loadCapstone = () => capstone ??= Promise.resolve().then(() => {
    if (!self.MCapstone) importScripts("./disasm/capstone.js");
    return fetch("./disasm/capstone.wasm");
}).then((r) => {
    if (!r.ok) throw new Error("the ARM/MIPS disassembler isn't available here");
    return r.arrayBuffer();
}).then((wasmBinary) => self.MCapstone({ wasmBinary })).catch((err) => {
    capstone = null;
    throw err;
});

const armModes = new Set(["arm64", "arm32", "thumb", "mips32-le", "mips32-be", "mips64-le", "mips64-be"]);

// Only actual destinations, not arbitrary immediates such as TBZ's bit
// number. Register-indirect branches have no statically known target.
function capstoneTargets(lib, insn, mode) {
    const { groups = [], op = [] } = insn.detail;
    const branch = groups.some((g) => [lib.GRP_JUMP, lib.GRP_CALL, lib.GRP_BRANCH_RELATIVE].includes(g));
    const address = mode === "arm64" && [lib.ARM64_INS_ADR, lib.ARM64_INS_ADRP].includes(insn.id);
    if (!branch && !address) return [];
    const last = op.at(-1);
    if (last?.type !== lib.OP_IMM) return [];
    let value = BigInt(last.imm);
    if (mode === "arm32" || mode === "thumb" || mode.startsWith("mips32")) value = BigInt.asUintN(32, value);
    return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? [Number(value)] : [];
}

function disassembleCapstone(lib, { bytes, address, mode, max }) {
    const mips = mode.startsWith("mips");
    const arch = mips ? lib.ARCH_MIPS : mode === "arm64" ? lib.ARCH_ARM64 : lib.ARCH_ARM;
    const flags = mips ? ((mode.startsWith("mips64") ? lib.MODE_MIPS64 : lib.MODE_MIPS32)
        | (mode.endsWith("-be") ? lib.MODE_BIG_ENDIAN : lib.MODE_LITTLE_ENDIAN)) >>> 0
        : mode === "thumb" ? lib.MODE_THUMB : lib.MODE_ARM;
    const decoder = new lib.Capstone(arch, flags);
    const lines = [];
    let consumed = 0;
    try {
        decoder.option(lib.OPT_DETAIL, lib.OPT_ON);
        decoder.option(lib.OPT_SKIPDATA, lib.OPT_ON);
        decoder.disasm_iter(bytes, address, (insn) => {
            const offset = Number(insn.address), length = insn.size;
            const bad = insn.id === 0;
            lines.push({ offset, length, text: bad ? "(bad)" : [insn.mnemonic, insn.op_str].filter(Boolean).join(" "),
                targets: bad ? [] : capstoneTargets(lib, insn, mode) });
            consumed += length;
            return lines.length < max;
        });
        // Skip-data can't consume a short final word/halfword. Keep every
        // selected byte visible, including an incomplete Thumb-2 instruction.
        if (consumed < bytes.length && lines.length < max) {
            lines.push({ offset: address + consumed, length: bytes.length - consumed, text: "(bad)", targets: [] });
        }
        return { lines };
    } finally {
        decoder.close();
    }
}

// targets is where insn goes to, or the memory it names by address alone
// (not through a register): numbers, as shown in its text.
function targets({ OpKind, Register }, insn) {
    const out = new Set();
    for (let i = 0; i < insn.opCount; i++) {
        const kind = insn.opKind(i);
        if (kind === OpKind.NearBranch16 || kind === OpKind.NearBranch32 || kind === OpKind.NearBranch64) out.add(insn.nearBranchTarget);
        else if (kind === OpKind.Memory) {
            if (insn.isIpRelMemoryOperand) out.add(insn.ipRelMemoryAddress);
            else if (insn.memoryBase === Register.None && insn.memoryIndex === Register.None) out.add(insn.memoryDisplacementU64);
        }
    }
    return [...out].filter((v) => v <= BigInt(Number.MAX_SAFE_INTEGER)).map(Number);
}

function disassemble(lib, { bytes, address, bitness, max }) {
    const { Decoder, DecoderOptions, Formatter, FormatterSyntax } = lib;
    if (![16, 32, 64].includes(bitness)) throw new Error("not a bitness");
    const decoder = new Decoder(bitness, bytes, DecoderOptions.None);
    const formatter = new Formatter(FormatterSyntax.Intel);
    // What's shown can be typed back (see x86-asm.js): cmpss xmm0,xmm1,4,
    // not the pseudo-op cmpneqss.
    formatter.usePseudoOps = false;
    const lines = [];
    try {
        decoder.ip = BigInt(address);
        while (decoder.canDecode && lines.length < max) {
            const insn = decoder.decode();
            lines.push(insn.isInvalid ? { offset: Number(insn.ip), length: insn.length, text: "(bad)", targets: [] }
                : { offset: Number(insn.ip), length: insn.length, text: formatter.format(insn), targets: targets(lib, insn) });
            insn.free();
        }
    } finally {
        decoder.free();
        formatter.free();
    }
    return { lines };
}

self.onmessage = async ({ data }) => {
    const { id } = data;
    try {
        const mode = data.mode ?? `x86-${data.bitness}`;
        const bitness = { "x86-16": 16, "x86-32": 32, "x86-64": 64 }[mode];
        if (!bitness && !armModes.has(mode)) throw new Error("unknown instruction set");
        if (!Number.isSafeInteger(data.address) || data.address < 0) throw new Error("invalid address");
        if (typeof data.assemble === "string") {
            if (!bitness) throw new Error("instruction editing is only available for x86");
            const lib = await load();
            assembler ??= self.makeAssembler(lib);
            const { bytes, text } = assembler.assemble(data.assemble, data.address, bitness, data.was);
            self.postMessage({ id, bytes: Array.from(bytes), text });
        } else {
            if (!(data.bytes instanceof Uint8Array) || data.bytes.length > 4096 || data.address > Number.MAX_SAFE_INTEGER - data.bytes.length)
                throw new Error("invalid disassembly bytes");
            if (!Number.isInteger(data.max) || data.max < 1 || data.max > 512) throw new Error("invalid instruction limit");
            const lib = await (bitness ? load() : loadCapstone());
            self.postMessage({ id, ...(bitness ? disassemble(lib, { ...data, bitness }) : disassembleCapstone(lib, { ...data, mode })) });
        }
    } catch (err) {
        self.postMessage({ id, error: err?.message ?? String(err) });
    }
};
