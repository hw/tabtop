// Disassembles x86, ARM, MIPS and RISC-V for the hex view's data inspector:
// x86 with iced-x86, ARM64 with fARM64 (see scripts/disasm/arm64-asm), ARM32
// and Thumb with Capstone.js (all WebAssembly; see scripts/disasm), RISC-V
// with riscv-asm.js and MIPS with mips-asm.js (tabtop's own, scripts beside
// this one), each fetched when first asked for; and assembles a line of
// x86 (see x86-asm.js), ARM64, RISC-V or MIPS code, to edit it in place.
// tabtopd serves this with each library's place (under ./disasm/ here)
// made the path its files are served under, each library's its own, and a
// CSP that lets it run WebAssembly, which the page itself can't.
//
// Asked {id, bytes, address, mode, max}: the bytes (4096, and up to 15 more
// so that the last instruction is whole), the file offset of the first,
// the instruction set, and the most instructions; it answers {id,
// lines: [{offset, length, text, targets}]}, "(bad)" for bytes that aren't
// an instruction, targets the addresses it names (where it jumps or calls
// to, or the memory it reads by address alone), or {id, error}.
//
// Asked {id, assemble: text, address, bitness or mode, was}: the line, where
// it's to go, and the bytes there now; it answers {id, bytes, text}: its
// bytes, and how it's shown; or {id, error}, saying why it can't be.
"use strict";

// The disassemblers this server has turned off (WEB_DISASM_DISABLE): of
// "x86", "arm64", "capstone", "riscv" and "mips". tabtopd fills this in as it serves the
// script, and doesn't serve their files; the page doesn't offer them, and
// one asked for all the same is refused here.
const DISASM_OFF = [];

// Loaded once; but a load that failed (the network, say) is forgotten, so
// the next question tries again rather than failing for good.
let iced = null, capstone = null, assembler = null;
const load = () => iced ??= Promise.resolve().then(() => {
    // Each only if it isn't here: one may have loaded when the other failed.
    if (!self.icedInit) importScripts("./disasm/iced.js");
    if (!self.makeAssembler) importScripts("./x86-asm.js");
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
    if (!r.ok) throw new Error("the ARM32 disassembler isn't available here");
    return r.arrayBuffer();
}).then((wasmBinary) => self.MCapstone({ wasmBinary })).catch((err) => {
    capstone = null;
    throw err;
});

// RISC-V's disassembler and assembler (riscv-asm.js): a script, with no
// WebAssembly to fetch. One that failed to load is asked for again.
// (What it and MIPS's have the same, asm-common.js, is loaded before either.)
const loadRiscv = async () => {
    if (!self.asmCommon) importScripts("./asm-common.js");
    if (!self.riscv) importScripts("./riscv-asm.js");
    return self.riscv;
};
const riscvXlen = (mode) => ({ riscv32: 32, riscv64: 64 }[mode]);
// MIPS's (mips-asm.js), likewise; it takes the mode as it's named.
const loadMips = async () => {
    if (!self.asmCommon) importScripts("./asm-common.js");
    if (!self.mips) importScripts("./mips-asm.js");
    return self.mips;
};
const mipsModes = new Set(["mips32-le", "mips32-be", "mips64-le", "mips64-be"]);

// A WebAssembly module of tabtop's own (see scripts/disasm), with nothing
// imported, fetched (asked: the fetch of it) when first asked for: load()
// is what it exports, and reply(x, given, call, said) what it replies to
// given (bytes; see wasm-reply's lib.rs), asked with call(where they are,
// how many), throwing said if it stops. One that failed to load, or that
// stopped (a trap leaves it unusable), is loaded again when next asked.
function ownModule(asked, missing) {
    let loading = null;
    return {
        load: () => loading ??= asked().then((r) => {
            if (!r.ok) throw new Error(missing);
            return r.arrayBuffer();
        }).then((bytes) => WebAssembly.instantiate(bytes, {})).then(({ instance }) => instance.exports).catch((err) => {
            loading = null;
            throw err;
        }),
        reply(x, given, call, said) {
            try {
                const at = x.alloc(given.length);
                new Uint8Array(x.memory.buffer, at, given.length).set(given);
                const length = call(at, given.length);
                return new Uint8Array(x.memory.buffer, x.reply(), length).slice();
            } catch {
                loading = null;
                throw new Error(said);
            }
        },
    };
}
// ARM64's disassembler and assembler, one module (see its lib.rs for what's called).
const { load: loadArm64, reply: arm64Reply } = ownModule(() => fetch("./disasm/arm64-asm.wasm"), "the ARM64 disassembler isn't available here");

// The names of C++ and Rust symbols as they were written (see
// scripts/disasm/demangle). Asked {id, demangle: [names]}, it answers
// {id, names}: each as it was written, or "" for one that isn't a mangled
// name. Its own, whichever disassemblers are on.
const demangler = ownModule(() => fetch("./demangle/demangle.wasm"), "the demangler isn't available here");
const MAX_DEMANGLED = 200_000;
async function demangle(names) {
    if (!Array.isArray(names) || names.length > MAX_DEMANGLED || names.some((n) => typeof n !== "string")) throw new Error("invalid names");
    if (!names.length) return [];
    const x = await demangler.load();
    // A line each, there and back; one with a line's end in it isn't asked.
    const given = new TextEncoder().encode(names.map((n) => (n.includes("\n") ? "" : n)).join("\n"));
    const lines = new TextDecoder().decode(demangler.reply(x, given, (at, length) => x.demangle(at, length), "Those names couldn't be read.")).split("\n");
    return names.map((_, i) => lines[i] ?? "");
}

// The words text could be at address, each as its 4 bytes, likeliest first;
// it throws what the assembler says of a line it can't read.
function arm64Words(x, text, address) {
    const reply = arm64Reply(x, new TextEncoder().encode(text), (at, length) => x.assemble(BigInt(address), at, length), "That couldn't be assembled.");
    if (reply[0]) throw new Error(new TextDecoder().decode(reply.subarray(1)));
    const words = [];
    for (let i = 1; i + 4 <= reply.length; i += 4) words.push(reply.slice(i, i + 4));
    return words;
}

// Each four bytes as an instruction, with the address it names (where it
// branches to, or what adr, adrp or a load gives by address); fewer than
// four at the end aren't one, and stay shown.
function disassembleArm64(x, { bytes, address, max }) {
    const reply = arm64Reply(x, bytes, (at, length) => x.disassemble(BigInt(address), at, length, max), "That couldn't be disassembled.");
    const lines = new TextDecoder().decode(reply).split("\n").slice(0, -1).map((line, i) => {
        const [text, target] = line.split("\t");
        const to = target ? BigInt(`0x${target}`) : null;
        return { offset: address + 4 * i, length: 4, text: text || "(bad)", targets: to != null && to <= BigInt(Number.MAX_SAFE_INTEGER) ? [Number(to)] : [] };
    });
    const tail = bytes.length % 4;
    if (tail && lines.length < max && lines.length === (bytes.length - tail) / 4) lines.push({ offset: address + bytes.length - tail, length: tail, text: "(bad)", targets: [] });
    return { lines };
}

// A line as its registers, names, numbers and marks, to compare two written
// differently (x0,#0x10 and x0, 16): no spaces, no #, no comment; a name
// that has another as the one that's shown (lr, b.cs); #1, lsl #12 as
// the number it is; and ret's x30, which it has when it names none.
const OTHER_NAMES = { lr: "x30", fp: "x29", ip0: "x16", ip1: "x17", cs: "hs", cc: "lo" };
const isNumber = (token) => /^-?\d/.test(token);
const isFloat = (token) => !/^-?0x/.test(token) && /[.e]/.test(token);
const valueOf = (token) => (token[0] === "-" ? -BigInt(token.slice(1)) : BigInt(token));
function lineTokens(text) {
    const tokens = (text.toLowerCase().split(/;|\/\//)[0]
        .match(/[a-z_.][a-z0-9_.]*|-?(?:0x[0-9a-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)|[^\s#]/g) ?? [])
        .map((t) => OTHER_NAMES[t] ?? t.replace(/\.(cs|cc)$/, (_, c) => `.${OTHER_NAMES[c]}`));
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
        const [comma, lsl, amount] = tokens.slice(i + 1, i + 4);
        if (isNumber(tokens[i]) && !isFloat(tokens[i]) && comma === "," && lsl === "lsl" && isNumber(amount ?? "") && !isFloat(amount)) {
            out.push(`0x${BigInt.asUintN(64, valueOf(tokens[i]) << valueOf(amount)).toString(16)}`);
            i += 3;
        } else out.push(tokens[i]);
    }
    return out.length === 2 && out[0] === "ret" && out[1] === "x30" ? ["ret"] : out;
}
// The same line: its numbers the same values (as 64 bits; as 32, where it's
// a 32-bit register that's set and they're no more than that), whatever
// they're written in.
function sameLine(a, b) {
    if (a.length !== b.length) return false;
    const narrow = /^w(?:\d+|sp|zr)$/.test(a[1] ?? "");
    return a.every((token, i) => {
        const other = b[i];
        if (!isNumber(token) || !isNumber(other)) return token === other;
        if (isFloat(token) || isFloat(other)) return Number(token) === Number(other);
        const [x, y] = [valueOf(token), valueOf(other)];
        const in32 = (v) => v >= -(1n << 31n) && v < (1n << 32n);
        return BigInt.asUintN(64, x) === BigInt.asUintN(64, y) || (narrow && in32(x) && in32(y) && BigInt.asUintN(32, x) === BigInt.asUintN(32, y));
    });
}

// The line's bytes: of the words it could be, one that's shown as the line
// typed; the one there already, if it's among them, as there can be more
// than one way to encode it.
async function assembleArm64({ assemble: text, address, was }) {
    if (text.length > 200) throw new Error("That's too long to be an instruction.");
    const x = await loadArm64();
    const typed = lineTokens(text);
    let found = null;
    for (const bytes of arm64Words(x, text, address)) {
        const line = disassembleArm64(x, { bytes, address, max: 1 }).lines[0];
        if (!line || line.length !== 4 || line.text === "(bad)" || !sameLine(typed, lineTokens(line.text))) continue;
        const there = was?.length === 4 && bytes.every((b, i) => b === was[i]);
        if (!found || there) found = { bytes: Array.from(bytes), text: line.text };
        if (there) break;
    }
    if (!found) throw new Error("That can't be assembled here as it would then be shown.");
    return found;
}

const capstoneModes = new Set(["arm32", "thumb"]);

// Only actual destinations, not arbitrary immediates such as TBZ's bit
// number. Register-indirect branches have no statically known target.
function capstoneTargets(lib, insn) {
    const { groups = [], op = [] } = insn.detail;
    if (!groups.some((g) => [lib.GRP_JUMP, lib.GRP_CALL, lib.GRP_BRANCH_RELATIVE].includes(g))) return [];
    const last = op.at(-1);
    if (last?.type !== lib.OP_IMM) return [];
    return [Number(BigInt.asUintN(32, BigInt(last.imm)))];
}

function disassembleCapstone(lib, { bytes, address, mode, max }) {
    const decoder = new lib.Capstone(lib.ARCH_ARM, mode === "thumb" ? lib.MODE_THUMB : lib.MODE_ARM);
    const lines = [];
    let consumed = 0;
    try {
        decoder.option(lib.OPT_DETAIL, lib.OPT_ON);
        decoder.option(lib.OPT_SKIPDATA, lib.OPT_ON);
        decoder.disasm_iter(bytes, address, (insn) => {
            const offset = Number(insn.address), length = insn.size;
            const bad = insn.id === 0;
            const targets = bad ? [] : capstoneTargets(lib, insn);
            const text = bad ? "(bad)" : [insn.mnemonic, insn.op_str].filter(Boolean).join(" ");
            lines.push({ offset, length, text, targets });
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
function targets(lib, insn, bitness) {
    const { OpKind, Register } = lib;
    const out = new Set();
    for (let i = 0; i < insn.opCount; i++) {
        const kind = insn.opKind(i);
        if (kind === OpKind.NearBranch16 || kind === OpKind.NearBranch32 || kind === OpKind.NearBranch64) out.add(self.x86BranchTarget(lib, insn, bitness));
        else if (kind === OpKind.Memory) {
            if (insn.isIpRelMemoryOperand) out.add(insn.ipRelMemoryAddress);
            else if (insn.memoryBase === Register.None && insn.memoryIndex === Register.None) out.add(insn.memoryDisplacementU64);
        }
    }
    return [...out].filter((v) => v <= BigInt(Number.MAX_SAFE_INTEGER)).map(Number);
}

function disassemble(lib, { bytes, address, bitness, max }) {
    const { Decoder, DecoderOptions } = lib;
    if (![16, 32, 64].includes(bitness)) throw new Error("not a bitness");
    const decoder = new Decoder(bitness, bytes, DecoderOptions.None);
    // Written as the assembler reads it back (see x86-asm.js, whose these
    // are): numbers as 0x1f, a branch's target the file offset it's to.
    const formatter = self.x86Formatter(lib);
    const lines = [];
    try {
        decoder.ip = BigInt(address);
        while (decoder.canDecode && lines.length < max) {
            const insn = decoder.decode();
            lines.push(insn.isInvalid ? { offset: Number(insn.ip), length: insn.length, text: "(bad)", targets: [] }
                : { offset: Number(insn.ip), length: insn.length, text: self.x86Text(lib, formatter, insn, bitness), targets: targets(lib, insn, bitness) });
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
        if (data.demangle !== undefined) {
            self.postMessage({ id, names: await demangle(data.demangle) });
            return;
        }
        const mode = data.mode ?? `x86-${data.bitness}`;
        const bitness = { "x86-16": 16, "x86-32": 32, "x86-64": 64 }[mode];
        const xlen = riscvXlen(mode);
        const mips = mipsModes.has(mode);
        if (!bitness && !xlen && !mips && mode !== "arm64" && !capstoneModes.has(mode)) throw new Error("unknown instruction set");
        if (DISASM_OFF.includes(bitness ? "x86" : xlen ? "riscv" : mips ? "mips" : mode === "arm64" ? "arm64" : "capstone")) throw new Error("this instruction set isn't available on this server (it's turned off, or its files are missing)");
        if (!Number.isSafeInteger(data.address) || data.address < 0) throw new Error("invalid address");
        if (typeof data.assemble === "string") {
            if (mode === "arm64") {
                self.postMessage({ id, ...(await assembleArm64(data)) });
                return;
            }
            if (xlen) {
                self.postMessage({ id, ...(await loadRiscv()).assemble(data.assemble, data.address, xlen, data.was) });
                return;
            }
            if (mips) {
                self.postMessage({ id, ...(await loadMips()).assemble(data.assemble, data.address, mode, data.was) });
                return;
            }
            if (!bitness) throw new Error("instruction editing is only available for x86, ARM64, RISC-V and MIPS");
            const lib = await load();
            assembler ??= self.makeAssembler(lib);
            const { bytes, text } = assembler.assemble(data.assemble, data.address, bitness, data.was);
            // As the disassembly then shows it (a branch's target, past
            // what the code's own addresses reach).
            const shown = bitness < 64 && data.address >= 2 ** bitness
                ? disassemble(lib, { bytes, address: data.address, bitness, max: 1 }).lines[0]?.text ?? text : text;
            self.postMessage({ id, bytes: Array.from(bytes), text: shown });
        } else {
            if (!(data.bytes instanceof Uint8Array) || data.bytes.length > 4096 + 15 || data.address > Number.MAX_SAFE_INTEGER - data.bytes.length)
                throw new Error("invalid disassembly bytes");
            if (!Number.isInteger(data.max) || data.max < 1 || data.max > 512) throw new Error("invalid instruction limit");
            if (xlen) self.postMessage({ id, ...(await loadRiscv()).disassemble(data.bytes, data.address, xlen, data.max) });
            else if (mips) self.postMessage({ id, ...(await loadMips()).disassemble(data.bytes, data.address, mode, data.max) });
            else if (mode === "arm64") self.postMessage({ id, ...disassembleArm64(await loadArm64(), data) });
            else if (bitness) self.postMessage({ id, ...disassemble(await load(), { ...data, bitness }) });
            else self.postMessage({ id, ...disassembleCapstone(await loadCapstone(), { ...data, mode }) });
        }
    } catch (err) {
        self.postMessage({ id, error: err?.message ?? String(err) });
    }
};
