// Disassembles x86 code for the hex view's data inspector (see hex-view.js),
// with iced-x86 (WebAssembly; see scripts/disasm/build.mjs), fetched when
// first asked for; and assembles a line of it, to edit code in place (see
// x86-asm.js). tabtopd serves this with "./disasm/" made the path the
// library is served under, and a CSP that lets it run WebAssembly, which
// the page itself can't.
//
// Asked {id, bytes, address, bitness, max}: the bytes, the file offset of
// the first, 64, 32 or 16, and the most instructions; it answers {id,
// lines: [{offset, length, text, targets}]}, "(bad)" for bytes that aren't
// an instruction, targets the addresses it names (where it jumps or calls
// to, or the memory it reads by address alone), or {id, error}.
//
// Asked {id, assemble: text, address, bitness, was}: the line, where it's
// to go, and the bytes there now; it answers {id, bytes, text}: its bytes,
// and how it's shown; or {id, error}, saying why it can't be.
"use strict";
importScripts("./disasm/iced.js", "./x86-asm.js");

// Loaded once; but a load that failed (the network, say) is forgotten, so
// the next question tries again rather than failing for good.
let iced = null, assembler = null;
const load = () => iced ??= fetch("./disasm/iced_x86_bg.wasm")
    .then((r) => {
        if (!r.ok) throw new Error("the disassembler isn't available here");
        return r.arrayBuffer();
    })
    .then((bytes) => self.icedInit(bytes))
    .catch((err) => {
        iced = null;
        throw err;
    });

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
        const lib = await load();
        if (typeof data.assemble === "string") {
            assembler ??= self.makeAssembler(lib);
            const { bytes, text } = assembler.assemble(data.assemble, data.address, data.bitness, data.was);
            self.postMessage({ id, bytes: Array.from(bytes), text });
        } else {
            self.postMessage({ id, ...disassemble(lib, data) });
        }
    } catch (err) {
        self.postMessage({ id, error: err?.message ?? String(err) });
    }
};
