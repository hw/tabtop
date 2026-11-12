// Assembles a line of x86 code, as the hex view's disassembly shows it
// (iced-x86's Intel syntax: see disasm-worker.js), into its bytes, for
// editing code in place. iced-x86 has an encoder but no assembler: this
// reads the line, then tries each encoding iced knows by that name whose
// operands fit, encodes it with iced, and keeps the shortest one that
// decodes back to the same instruction.
//
// A classic script: in the worker, self.makeAssembler(iced) makes
// {assemble(text, address, bitness, was)}; parseLine is also there, for
// tests, needing no iced. Addresses are what the disassembly shows (file
// offsets): branch targets are absolute, as shown, and so is [addr] in
// 64-bit code, which is RIP-relative there, unless it's through fs or gs,
// or what was there was absolute, or it's [abs addr].
"use strict";
(function (root) {
    // Memory operand sizes, as "byte ptr".
    const SIZES = { byte: 1, word: 2, dword: 4, fword: 6, qword: 8, mmword: 8, tbyte: 10, tword: 10, xmmword: 16, oword: 16, ymmword: 32, zmmword: 64 };
    const PREFIXES = new Set(["lock", "rep", "repe", "repz", "repne", "repnz", "xacquire", "xrelease", "bnd", "notrack", "data16", "data32", "data64"]);
    const SEGMENTS = new Set(["es", "cs", "ss", "ds", "fs", "gs"]);
    // Other names of the same condition, as other assemblers write them.
    const CONDITIONS = { z: "e", nz: "ne", c: "b", nae: "b", nc: "ae", nb: "ae", na: "be", nbe: "a", pe: "p", po: "np", nge: "l", nl: "ge", ng: "le", nle: "g" };

    // A number: 0x1f, 1Fh (as shown; a digit first), decimal, or up to 8
    // characters in quotes ('A', 'MZ': the first the lowest byte); BigInt.
    function parseNumber(text) {
        const q = /^'([\x20-\x7e]{1,8})'$/.exec(text.trim());
        if (q && !q[1].includes("'")) return [...q[1]].reduceRight((v, c) => (v << 8n) | BigInt(c.charCodeAt(0)), 0n);
        const m = /^([+-]?)\s*(?:0x([0-9a-f]+)|([0-9][0-9a-f]*)h|([0-9]+))$/i.exec(text.trim());
        if (!m) return null;
        const v = m[2] != null ? BigInt("0x" + m[2]) : m[3] != null ? BigInt("0x" + m[3]) : BigInt(m[4]);
        return m[1] === "-" ? -v : v;
    }

    // Splits at commas outside brackets and braces.
    function splitOperands(text) {
        const out = [];
        let depth = 0, from = 0;
        for (let i = 0; i < text.length; i++) {
            const c = text[i];
            if (c === "[" || c === "{" || c === "(") depth++;
            else if (c === "]" || c === "}" || c === ")") depth--;
            else if (c === "," && depth === 0) {
                out.push(text.slice(from, i));
                from = i + 1;
            }
        }
        out.push(text.slice(from));
        return out.map((s) => s.trim());
    }

    // What's in brackets: base + index*scale + displacement, any order.
    function parseAddress(text, register) {
        const mem = { base: null, index: null, scale: 1, disp: 0n, abs: false, rel: false };
        let body = text.trim();
        const keyword = /^(abs|rel)\s+/.exec(body);
        if (keyword) {
            mem[keyword[1]] = true;
            body = body.slice(keyword[0].length);
        }
        const terms = body.replace(/\s+/g, "").match(/[+-]?[^+-]+/g);
        if (!terms) throw new Error(`"[${text}]" isn't an address.`);
        for (const term of terms) {
            const sign = term[0] === "-" ? -1n : 1n;
            const t = term.replace(/^[+-]/, "");
            const scaled = /^([a-z][a-z0-9]*)\*([0-9]+)$/.exec(t), scaledFirst = /^([0-9]+)\*([a-z][a-z0-9]*)$/.exec(t);
            if (scaled || scaledFirst) {
                const [reg, scale] = scaled ? [scaled[1], scaled[2]] : [scaledFirst[2], scaledFirst[1]];
                const r = register(reg);
                if (r == null || sign < 0n || mem.index != null || !["1", "2", "4", "8"].includes(scale)) throw new Error(`"${term}" can't be in an address.`);
                mem.index = r;
                mem.scale = Number(scale);
                continue;
            }
            const r = register(t);
            if (r != null) {
                if (sign < 0n) throw new Error(`A register can't be taken away in an address.`);
                if (mem.base == null) mem.base = r;
                else if (mem.index == null) mem.index = r;
                else throw new Error(`"[${text}]" has too many registers.`);
                continue;
            }
            const n = parseNumber(t);
            if (n == null) throw new Error(`"${t}" isn't a register or a number.`);
            mem.disp += sign * n;
        }
        return mem;
    }

    // One operand: a register, a number, memory ([...], with its size,
    // segment and broadcast), or a far pointer (sel:off).
    function parseOperand(text, register) {
        const op = { decorations: [] };
        let t = text.replace(/\{([^}]*)\}/g, (_, d) => { op.decorations.push(d.trim()); return ""; }).trim();
        if (!t) return { kind: "none", decorations: op.decorations };
        const r = register(t.replace(/\s+/g, ""));
        if (r != null) return { kind: "reg", reg: r, decorations: op.decorations };
        const n = parseNumber(t);
        if (n != null) return { kind: "imm", value: n, decorations: op.decorations };
        const far = /^([^:[\]]+):([^:[\]]+)$/.exec(t);
        if (far && !SEGMENTS.has(far[1].trim())) {
            const sel = parseNumber(far[1]), off = parseNumber(far[2]);
            if (sel != null && off != null) return { kind: "far", sel, off, decorations: op.decorations };
        }
        const m = /^(?:([a-z]+)\s+(?:(ptr|bcst)\s+)?)?(?:([a-z]{2})\s*:\s*)?\[(.*)\]$/.exec(t);
        if (m) {
            let size = null, bcst = false;
            if (m[1]) {
                if (!(m[1] in SIZES)) throw new Error(`"${m[1]}" isn't a size (byte, word, dword, qword…).`);
                size = SIZES[m[1]];
                bcst = m[2] === "bcst";
            }
            let seg = null;
            if (m[3]) {
                if (!SEGMENTS.has(m[3])) throw new Error(`"${m[3]}" isn't a segment register.`);
                seg = register(m[3]);
            }
            return { kind: "mem", size, bcst, seg, ...parseAddress(m[4], register), decorations: op.decorations };
        }
        throw new Error(`"${text.trim()}" isn't an operand.`);
    }

    // A line: prefixes, the mnemonic, a branch's short/near/far, and its
    // operands.
    function parseLine(text, register) {
        // Lowercase, but for what's in quotes; a comment after ; left out.
        let rest = String(text).replace(/'[^']*'|[^']+/g, (m) => (m[0] === "'" ? m : m.toLowerCase())).replace(/;[^']*$/, "").trim();
        const prefixes = [];
        let word;
        while ((word = /^([a-z][a-z0-9]*)\b\s*/.exec(rest)) && PREFIXES.has(word[1]) && rest.slice(word[0].length).trim()) {
            prefixes.push(word[1]);
            rest = rest.slice(word[0].length);
        }
        const mn = /^([a-z][a-z0-9_]*)\s*/.exec(rest);
        if (!mn) throw new Error(rest ? `"${rest}" isn't an instruction.` : "Type an instruction.");
        let mnemonic = mn[1];
        rest = rest.slice(mn[0].length);
        let branch = null;
        const kw = /^(short|near|far)\b\s*/.exec(rest);
        if (kw) {
            branch = kw[1];
            rest = rest.slice(kw[0].length);
        }
        let operands = rest ? splitOperands(rest).map((o) => parseOperand(o, register)) : [];
        // Decorations on their own ({rn-sae}), as operands, go with the rest.
        const loose = operands.filter((o) => o.kind === "none").flatMap((o) => o.decorations);
        operands = operands.filter((o) => o.kind !== "none");
        const decorations = [...loose, ...operands.flatMap((o) => o.decorations)];
        // imul r,imm: imul r,r,imm, as iced shows it.
        if (mnemonic === "imul" && operands.length === 2 && operands[0].kind === "reg" && operands[1].kind === "imm")
            operands = [operands[0], operands[0], operands[1]];
        // jmp far off,sel, as iced shows it.
        if (branch === "far" && operands.length === 2 && operands.every((o) => o.kind === "imm"))
            operands = [{ kind: "far", off: operands[0].value, sel: operands[1].value, decorations: [] }];
        return { prefixes, mnemonic, branch, operands, decorations };
    }

    // The other names a conditional mnemonic goes by (jz for je...).
    function aliases(mnemonic) {
        for (const head of ["j", "set", "cmov"]) {
            if (mnemonic.startsWith(head) && CONDITIONS[mnemonic.slice(head.length)])
                return [head + CONDITIONS[mnemonic.slice(head.length)]];
        }
        if (mnemonic === "xlatb") return ["xlat"];
        if (mnemonic === "sal") return ["shl"];
        return [];
    }

    function makeAssembler(I) {
        const K = I.OpCodeOperandKind, OK = I.OpKind, R = I.Register;
        // As the disassembly shows it: cmpss xmm0,xmm1,4, not cmpneqss.
        const formatter = new I.Formatter(I.FormatterSyntax.Intel);
        formatter.usePseudoOps = false;
        // Names, as the formatter shows them (and r8b... too), to registers;
        // registers to their kind (r8, r16... xmm, st...).
        const names = new Map(), kinds = new Map(), widths = new Map();
        for (const [name, value] of Object.entries(R)) {
            if (typeof value !== "number" || value === R.None || /^DontUse/.test(name)) continue;
            const kind = I.RegisterExt.isGPR8(value) ? "r8" : I.RegisterExt.isGPR16(value) ? "r16" : I.RegisterExt.isGPR32(value) ? "r32"
                : I.RegisterExt.isGPR64(value) ? "r64" : I.RegisterExt.isSegmentRegister(value) ? "seg" : I.RegisterExt.isK(value) ? "k"
                : I.RegisterExt.isMM(value) ? "mm" : I.RegisterExt.isXMM(value) ? "xmm" : I.RegisterExt.isYMM(value) ? "ymm"
                : I.RegisterExt.isZMM(value) ? "zmm" : I.RegisterExt.isCR(value) ? "cr" : I.RegisterExt.isDR(value) ? "dr"
                : I.RegisterExt.isTR(value) ? "tr" : I.RegisterExt.isBND(value) ? "bnd" : I.RegisterExt.isST(value) ? "st"
                : I.RegisterExt.isTMM(value) ? "tmm" : I.RegisterExt.isIP(value) ? "ip" : null;
            if (!kind) continue;
            kinds.set(value, kind);
            widths.set(value, { r16: 16, r32: 32, r64: 64, ip: value === R.RIP ? 64 : 32 }[kind] ?? 0);
            names.set(formatter.formatRegister(value).toLowerCase(), value);
            names.set(name.toLowerCase(), value);
        }
        for (let n = 8; n <= 15; n++) names.set(`r${n}b`, R[`R${n}L`]);
        for (let n = 0; n <= 7; n++) names.set(`st(${n})`, R.ST0 + n);
        names.set("st", R.ST0);
        const register = (name) => names.get(name);

        // Each encoding iced has, by the name it's shown under: its operand
        // kinds, where it's available, and what it can take.
        let index = null;
        const build = () => {
            index = new Map();
            const ins = new I.Instruction();
            for (const code of Object.values(I.Code)) {
                if (typeof code !== "number" || code === I.Code.INVALID) continue;
                let o;
                try { o = I.CodeExt.opCode(code); } catch { continue; }
                try {
                    if (!o.isInstruction || o.decoderOption !== 0 || o.encoding === I.EncodingKind.MVEX) continue;
                    const entry = {
                        code, kinds: Array.from({ length: o.opCount }, (_, i) => K[o.opKind(i)]),
                        modes: { 16: o.mode16, 32: o.mode32, 64: o.mode64 }, encoding: o.encoding, operandSize: o.operandSize,
                        size: I.MemorySizeExt.size(o.memorySize), bcstSize: o.canBroadcast ? I.MemorySizeExt.size(o.broadcastMemorySize) : 0,
                        lock: o.canUseLockPrefix, rep: o.canUseRepPrefix, repne: o.canUseRepnePrefix, bnd: o.canUseBndPrefix,
                        notrack: o.canUseNotrackPrefix, xacquire: o.canUseXacquirePrefix, xrelease: o.canUseXreleasePrefix,
                        mask: o.canUseOpMaskRegister, zero: o.canUseZeroingMasking, rc: o.canUseRoundingControl, sae: o.canSuppressAllExceptions,
                    };
                    ins.code = code;
                    for (const name of new Set([formatter.formatMnemonic(ins, I.FormatMnemonicOptions.NoPrefixes).toLowerCase(), I.Mnemonic[o.mnemonic].toLowerCase()])) {
                        if (!index.has(name)) index.set(name, []);
                        index.get(name).push(entry);
                    }
                } finally {
                    o.free();
                }
            }
            ins.free();
        };

        const IMPLICIT = new Set(["seg_rSI", "es_rDI", "seg_rDI", "seg_rBX_al"]);
        // Operand kinds a line may leave out: a string instruction's (lodsb),
        // and the x87 stack's (fadd st(1), faddp).
        const omittable = (kind, kindsOf, given) => IMPLICIT.has(kind) || kind === "st0"
            || (["al", "ax", "eax", "rax"].includes(kind) && kindsOf.some((k) => IMPLICIT.has(k)))
            || (kind === "sti_opcode" && given === 0);
        // Ways the operands given go with an encoding's kinds, in order, some
        // kinds left out; a shown st that isn't one of them (fstp m64,st) too.
        // Each with how many were left out or passed over: fewer is closer
        // to what was typed (fmul st(1),st isn't fmul st,st(1)).
        function* alignments(kindsOf, ops, x87) {
            const walk = function* (k, o, map, missed) {
                if (k === kindsOf.length) {
                    const extra = ops.slice(o);
                    if (extra.every((op) => x87 && op.kind === "reg" && op.reg === R.ST0)) yield { map, missed: missed + extra.length };
                    return;
                }
                if (o < ops.length) yield* walk(k + 1, o + 1, [...map, o], missed);
                if (omittable(kindsOf[k], kindsOf, ops.length)) yield* walk(k + 1, o, [...map, -1], missed + 1);
                if (x87 && o < ops.length && ops[o].kind === "reg" && ops[o].reg === R.ST0) yield* walk(k, o + 1, map, missed + 1);
            };
            yield* walk(0, 0, [], 0);
        }

        const fitsSigned = (v, bits) => v >= -(1n << BigInt(bits - 1)) && v < (1n << BigInt(bits - 1));
        // In range as a value of so many bits, either signed or not.
        const fitsEither = (v, bits) => v >= -(1n << BigInt(bits - 1)) && v < (1n << BigInt(bits));
        // A value of so many bits, sign-extended from 8.
        const sex8 = (v, bits) => fitsEither(v, bits) && fitsSigned(BigInt.asIntN(bits, v), 8);
        const IMMEDIATES = {
            imm8: [(v) => fitsEither(v, 8), OK.Immediate8], imm8_const_1: [(v) => v === 1n, OK.Immediate8],
            imm8sex16: [(v) => sex8(v, 16), OK.Immediate8to16], imm8sex32: [(v) => sex8(v, 32), OK.Immediate8to32],
            imm8sex64: [(v) => sex8(v, 64), OK.Immediate8to64], imm16: [(v) => fitsEither(v, 16), OK.Immediate16],
            imm32: [(v) => fitsEither(v, 32), OK.Immediate32], imm32sex64: [(v) => fitsEither(v, 64) && fitsSigned(BigInt.asIntN(64, v), 32), OK.Immediate32to64],
            imm64: [(v) => fitsEither(v, 64), OK.Immediate64], imm4_m2z: [(v) => v >= 0n && v <= 3n, OK.Immediate8],
        };
        const REGISTER_KIND = /^(r8|r16|r32|r64|seg|k|kp1|mm|xmm|xmmp3|ymm|zmm|zmmp3|tmm|cr|dr|tr|bnd|sti)_(reg|rm|opcode|vvvv|reg_mem|is4|is5|or_mem|or_mem_mpx)$/;
        const FIXED = { es: R.ES, cs: R.CS, ss: R.SS, ds: R.DS, fs: R.FS, gs: R.GS, al: R.AL, cl: R.CL, ax: R.AX, dx: R.DX, eax: R.EAX, rax: R.RAX, st0: R.ST0 };
        const BP = new Set([R.BP, R.EBP, R.RBP, R.R13, R.R13D]);
        const addressWidth = (mem, bitness) => (mem.base != null ? widths.get(mem.base) : 0) || (mem.index != null && ["r16", "r32", "r64"].includes(kinds.get(mem.index)) ? widths.get(mem.index) : 0) || bitness;

        // Sets operand i of ins to op, as kind wants; false if it doesn't fit.
        function setOperand(ins, i, kind, op, ctx) {
            const { bitness, entry, line } = ctx;
            if (op == null) {
                // Left out: a string instruction's memory, at its usual place.
                const w = bitness;
                if (kind === "es_rDI") ins.setOpKind(i, { 16: OK.MemoryESDI, 32: OK.MemoryESEDI, 64: OK.MemoryESRDI }[w]);
                else if (kind === "seg_rSI") ins.setOpKind(i, { 16: OK.MemorySegSI, 32: OK.MemorySegESI, 64: OK.MemorySegRSI }[w]);
                else if (kind === "seg_rDI") ins.setOpKind(i, { 16: OK.MemorySegDI, 32: OK.MemorySegEDI, 64: OK.MemorySegRDI }[w]);
                else if (kind === "seg_rBX_al") return setXlat(ins, i, { 16: R.BX, 32: R.EBX, 64: R.RBX }[w], null);
                else if (kind === "sti_opcode") { ins.setOpKind(i, OK.Register); ins.setOpRegister(i, R.ST1); }
                else if (kind in FIXED) { ins.setOpKind(i, OK.Register); ins.setOpRegister(i, FIXED[kind]); }
                else return false;
                return true;
            }
            if (kind in FIXED) {
                if (op.kind !== "reg" || op.reg !== FIXED[kind]) return false;
                ins.setOpKind(i, OK.Register);
                ins.setOpRegister(i, op.reg);
                return true;
            }
            const rk = REGISTER_KIND.exec(kind);
            if (rk && op.kind === "reg") {
                const want = { kp1: "k", xmmp3: "xmm", zmmp3: "zmm", sti: "st" }[rk[1]] ?? rk[1];
                if (kinds.get(op.reg) !== want) return false;
                ins.setOpKind(i, OK.Register);
                ins.setOpRegister(i, op.reg);
                return true;
            }
            if (op.kind === "mem" && (kind === "mem" || kind === "mem_mpx" || kind === "mem_mib" || kind === "sibmem" || kind === "mem_offs"
                || kind.startsWith("mem_vsib") || (rk && rk[2].startsWith("or_mem")))) return setMemory(ins, i, kind, op, ctx);
            if (IMPLICIT.has(kind) && op.kind === "mem") {
                const width = widths.get(op.base);
                const base = { seg_rSI: [R.SI, R.ESI, R.RSI], es_rDI: [R.DI, R.EDI, R.RDI], seg_rDI: [R.DI, R.EDI, R.RDI], seg_rBX_al: [R.BX, R.EBX, R.RBX] }[kind];
                if (!base.includes(op.base) || op.disp !== 0n || op.size != null) return false;
                if (kind === "seg_rBX_al") return (op.index == null || op.index === R.AL) && setXlat(ins, i, op.base, op.seg);
                if (op.index != null || (kind === "es_rDI" && op.seg != null && op.seg !== R.ES)) return false;
                const w = { 16: 0, 32: 1, 64: 2 }[width];
                ins.setOpKind(i, { es_rDI: [OK.MemoryESDI, OK.MemoryESEDI, OK.MemoryESRDI], seg_rSI: [OK.MemorySegSI, OK.MemorySegESI, OK.MemorySegRSI], seg_rDI: [OK.MemorySegDI, OK.MemorySegEDI, OK.MemorySegRDI] }[kind][w]);
                if (op.seg != null && kind !== "es_rDI") ins.segmentPrefix = op.seg;
                return true;
            }
            if (kind in IMMEDIATES && op.kind === "imm") {
                const [fits, opKind] = IMMEDIATES[kind];
                if (!fits(op.value)) return false;
                // A second 8-bit immediate (enter, extrq) is the 2nd.
                const second = kind === "imm8" && entry.kinds.slice(0, i).some((k) => k === "imm8" || k === "imm16");
                ins.setOpKind(i, second ? OK.Immediate8_2nd : opKind);
                ins.setImmediateU64(i, BigInt.asUintN(64, op.value));
                return true;
            }
            const near = /^(br|xbegin_|brdisp_)(16|32|64)?_?([124])$/.exec(kind);
            if (near && op.kind === "imm") {
                const short = near[3] === "1";
                if ((line.branch === "short" && !short) || (line.branch === "near" && short) || line.branch === "far") return false;
                const width = near[2] ? Number(near[2]) : near[1] === "xbegin_" ? bitness : near[3] === "2" ? 16 : 32;
                if (!fitsEither(op.value, width)) return false;
                const target = BigInt.asUintN(width, op.value);
                if (width === 16) { ins.setOpKind(i, OK.NearBranch16); ins.nearBranch16 = Number(target); }
                else if (width === 32) { ins.setOpKind(i, OK.NearBranch32); ins.nearBranch32 = Number(target); }
                else { ins.setOpKind(i, OK.NearBranch64); ins.nearBranch64 = target; }
                return true;
            }
            if ((kind === "farbr2_2" || kind === "farbr4_2") && op.kind === "far") {
                const width = kind === "farbr2_2" ? 16 : 32;
                if (!fitsEither(op.off, width) || !fitsEither(op.sel, 16)) return false;
                ins.setOpKind(i, width === 16 ? OK.FarBranch16 : OK.FarBranch32);
                if (width === 16) ins.farBranch16 = Number(BigInt.asUintN(16, op.off));
                else ins.farBranch32 = Number(BigInt.asUintN(32, op.off));
                ins.farBranchSelector = Number(BigInt.asUintN(16, op.sel));
                return true;
            }
            return false;
        }

        function setXlat(ins, i, base, seg) {
            ins.setOpKind(i, OK.Memory);
            ins.memoryBase = base;
            ins.memoryIndex = R.AL;
            ins.memoryIndexScale = 1;
            ins.memoryDisplacementU64 = 0n;
            ins.memoryDisplSize = 0;
            if (seg != null) ins.segmentPrefix = seg;
            return true;
        }

        function setMemory(ins, i, kind, op, { bitness, entry, ripTarget }) {
            // Its size, if given, the encoding's (or its broadcast element's).
            const wanted = op.bcst || op.decorations.some((d) => /^1to\d+$/.test(d)) ? entry.bcstSize : entry.size;
            if (op.bcst || op.decorations.some((d) => /^1to\d+$/.test(d))) {
                if (!entry.bcstSize) return false;
                ins.isBroadcast = true;
            }
            if (op.size != null && wanted && op.size !== wanted) return false;
            const indexKind = op.index != null ? kinds.get(op.index) : null;
            const vsib = /^mem_vsib(32|64)([xyz])$/.exec(kind);
            if (vsib ? indexKind !== { x: "xmm", y: "ymm", z: "zmm" }[vsib[2]] : indexKind != null && !["r16", "r32", "r64"].includes(indexKind)) return false;
            if (op.base != null && !["r16", "r32", "r64", "ip"].includes(kinds.get(op.base))) return false;
            const absolute = op.base == null && op.index == null;
            if (kind === "mem_offs" && (!absolute || (bitness === 64 && !op.abs))) return false;
            const width = addressWidth(op, bitness);
            ins.setOpKind(i, OK.Memory);
            if (op.seg != null) ins.segmentPrefix = op.seg;
            if (op.base === R.RIP || op.base === R.EIP || (absolute && bitness === 64 && !op.abs && kind !== "mem_offs")) {
                // RIP-relative: the address it's to, worked out once the
                // instruction's length is known (ripTarget), or as given.
                if (op.index != null) return false;
                const rip = op.base ?? R.RIP;
                ins.memoryBase = rip;
                const target = op.base == null ? op.disp : ripTarget(op.disp);
                ins.memoryDisplacementU64 = BigInt.asUintN(rip === R.RIP ? 64 : 32, target);
                ins.memoryDisplSize = rip === R.RIP ? 8 : 4;
                return true;
            }
            if (op.base != null) ins.memoryBase = op.base;
            if (op.index != null) {
                ins.memoryIndex = op.index;
                ins.memoryIndexScale = op.scale;
            }
            if (!fitsEither(op.disp, width)) return false;
            const disp = BigInt.asUintN(width, op.disp);
            ins.memoryDisplacementU64 = disp;
            ins.memoryDisplSize = absolute ? width / 8
                : op.disp === 0n && !BP.has(op.base) ? 0
                : fitsSigned(BigInt.asIntN(width, disp), 8) ? 1 : width / 8;
            return true;
        }

        // Prefixes and EVEX decorations; false if the encoding can't take one.
        function setExtras(ins, line, entry) {
            for (const p of line.prefixes) {
                if (p === "lock" && entry.lock) ins.hasLockPrefix = true;
                else if ((p === "rep" || p === "repe" || p === "repz") && entry.rep) ins.hasRepePrefix = true;
                else if ((p === "repne" || p === "repnz") && entry.repne) ins.hasRepnePrefix = true;
                else if (p === "bnd" && entry.bnd) ins.hasRepnePrefix = true;
                else if (p === "xacquire" && entry.xacquire) ins.hasXacquirePrefix = true;
                else if (p === "xrelease" && entry.xrelease) ins.hasXreleasePrefix = true;
                else if (p === "notrack" && entry.notrack) ins.segmentPrefix = R.DS;
                else if (p.startsWith("data")) continue; // chose the encodings (see assemble)
                else return false;
            }
            for (const d of line.decorations) {
                const k = names.get(d);
                if (k != null && kinds.get(k) === "k") {
                    if (!entry.mask || k === R.K0) return false;
                    ins.opMask = k;
                } else if (d === "z") {
                    if (!entry.zero) return false;
                    ins.zeroingMasking = true;
                } else if (/^r[nduz]e?-sae$/.test(d)) {
                    if (!entry.rc) return false;
                    ins.roundingControl = { n: I.RoundingControl.RoundToNearest, d: I.RoundingControl.RoundDown, u: I.RoundingControl.RoundUp, z: I.RoundingControl.RoundTowardZero }[d[1]];
                } else if (d === "sae") {
                    if (!entry.sae) return false;
                    ins.suppressAllExceptions = true;
                } else if (!/^1to\d+$/.test(d)) {
                    return false;
                }
            }
            return true;
        }

        // One encoding, the operands as mapped: its bytes and how it's
        // shown, or null.
        function tryEncoding(entry, map, line, address, bitness, ripTarget) {
            const ins = new I.Instruction();
            const encoder = new I.Encoder(bitness);
            try {
                ins.code = entry.code;
                // As decoded: how a segment override is shown depends on it.
                ins.codeSize = { 16: I.CodeSize.Code16, 32: I.CodeSize.Code32, 64: I.CodeSize.Code64 }[bitness];
                const ctx = { bitness, entry, line, ripTarget };
                for (let i = 0; i < entry.kinds.length; i++) {
                    if (!setOperand(ins, i, entry.kinds[i], map[i] < 0 ? null : line.operands[map[i]], ctx)) return null;
                }
                if (!setExtras(ins, line, entry)) return null;
                const shown = formatter.format(ins);
                // data16 jmp...: an operand size that isn't the code's own,
                // only when asked for.
                const data = /^(?:[a-z]+ )*?(data(?:16|32|64)) /.exec(shown);
                if (data && !line.prefixes.includes(data[1])) return null;
                encoder.encode(ins, BigInt(address));
                const bytes = encoder.takeBuffer();
                // It decodes as what was meant, or it isn't kept.
                const decoder = new I.Decoder(bitness, bytes, I.DecoderOptions.None);
                decoder.ip = BigInt(address);
                const back = decoder.decode();
                try {
                    const same = !back.isInvalid && back.length === bytes.length && back.code === entry.code && formatter.format(back) === shown;
                    return same ? { bytes, shown, entry } : null;
                } finally {
                    back.free();
                    decoder.free();
                }
            } catch {
                return null;
            } finally {
                encoder.free();
                ins.free();
            }
        }

        const ENCODING_RANK = { [I.EncodingKind.Legacy]: 0, [I.EncodingKind.VEX]: 1, [I.EncodingKind.XOP]: 2, [I.EncodingKind.EVEX]: 3 };

        // text at address (a file offset), in 16-, 32- or 64-bit code; was,
        // the bytes there (their instruction kept when it's as short): {bytes,
        // text}, or it throws, saying why.
        function assemble(text, address, bitness, was = null) {
            if (![16, 32, 64].includes(bitness)) throw new Error("Not a bitness.");
            if (!index) build();
            const line = parseLine(text, register);
            const name = line.branch === "far" ? `${line.mnemonic} far` : line.mnemonic;
            const lookup = (n) => index.get(n) ?? (line.branch === "far" ? index.get(n.replace(/ far$/, "")) : undefined);
            let entries = lookup(name);
            for (const alias of entries ? [] : aliases(line.mnemonic)) {
                entries = lookup(line.branch === "far" ? `${alias} far` : alias);
                if (entries) break;
            }
            if (!entries) throw new Error(`"${line.mnemonic}" isn't an x86 instruction.`);
            entries = entries.filter((e) => e.modes[bitness]);
            if (!entries.length) throw new Error(`"${line.mnemonic}" isn't an instruction in ${bitness}-bit code.`);
            // data16 (32, 64): the encoding with that operand size, as iced
            // shows one that isn't the usual size for the code.
            const data = line.prefixes.find((p) => p.startsWith("data"));
            if (data) entries = entries.filter((e) => e.operandSize === Number(data.slice(4)));
            // What was there: its encoding, and whether its address was
            // absolute (no base, no index, not RIP-relative).
            let wasCode = null, wasAbsolute = false;
            if (was?.length) {
                const d = new I.Decoder(bitness, Uint8Array.from(was), I.DecoderOptions.None);
                d.ip = BigInt(address);
                const w = d.decode();
                if (!w.isInvalid) {
                    wasCode = w.code;
                    wasAbsolute = Array.from({ length: w.opCount }, (_, i) => w.opKind(i)).includes(OK.Memory)
                        && w.memoryBase === R.None && w.memoryIndex === R.None;
                }
                w.free();
                d.free();
            }
            const x87 = line.mnemonic.startsWith("f");
            const found = [];
            // In 64-bit code, [addr] is RIP-relative, or absolute where that
            // can't reach it; absolute, always, through fs or gs (thread-local,
            // as fs:[28h]) or where what was there was absolute; [abs addr]
            // is, and [rel addr] never.
            let lines = [line];
            const bare = (o) => o.kind === "mem" && o.base == null && o.index == null && !o.abs && !o.rel;
            if (bitness === 64 && line.operands.some(bare)) {
                const absolute = { ...line, operands: line.operands.map((o) => (bare(o) ? { ...o, abs: true } : o)) };
                const mustBe = wasAbsolute || line.operands.some((o) => bare(o) && (o.seg === R.FS || o.seg === R.GS));
                lines = mustBe ? [absolute] : [line, absolute];
            }
            for (const entry of entries) for (const line of lines) {
                for (const { map, missed } of alignments(entry.kinds, line.operands, x87)) {
                    // [rip+n]: n from the next instruction, so its length first.
                    let result = tryEncoding(entry, map, line, address, bitness, (d) => BigInt(address) + d);
                    if (result && line.operands.some((o) => o.kind === "mem" && (o.base === R.RIP || o.base === R.EIP))) {
                        const length = BigInt(result.bytes.length);
                        result = tryEncoding(entry, map, line, address, bitness, (d) => BigInt(address) + length + d);
                    }
                    if (result) found.push({ ...result, missed });
                }
            }
            if (!found.length && line.branch === "short" && entries.some((e) => e.kinds.some((k) => /^br\d+_1$/.test(k))))
                throw new Error("That's too far for a short jump (127 bytes on, or 128 back, at most).");
            if (!found.length) throw new Error(`Those operands don't go with ${line.mnemonic} in ${bitness}-bit code.`);
            // The closest to the operands as typed.
            const closest = Math.min(...found.map((f) => f.missed));
            found.splice(0, found.length, ...found.filter((f) => f.missed === closest));
            // Shown as typed (fsubr st(0),st, not st,st(0)): preferred.
            const typed = String(text).toLowerCase().replace(/\s+/g, "");
            const asTyped = (f) => f.shown.replace(/\s+/g, "") === typed;
            // Memory without a size, and more than one size it could be: one
            // shown as typed, or the instruction there before; or say which,
            // if there's a name for each (a nop's size doesn't matter, nor
            // which of fldenv's two, 14 or 28 bytes).
            const sizesOf = (list) => new Set(list.map((f) => f.entry.size).filter((s) => s));
            if (line.operands.some((o) => o.kind === "mem" && o.size == null) && line.mnemonic !== "nop" && sizesOf(found).size > 1) {
                const narrowed = [found.filter(asTyped), found.filter((f) => f.entry.code === wasCode)].find((l) => l.length && sizesOf(l).size <= 1);
                const sizes = sizesOf(found);
                if (narrowed) found.splice(0, found.length, ...narrowed);
                else if ([...sizes].every((n) => Object.values(SIZES).includes(n))) {
                    const said = Object.entries(SIZES).filter(([n, s]) => sizes.has(s) && !["mmword", "tword", "oword"].includes(n)).map(([n]) => `${n} ptr`);
                    throw new Error(`Say how big the memory is: ${said.join(", ")}.`);
                }
            }
            // Shortest; then as typed, or as what was there before; then
            // legacy, VEX, then EVEX encoding.
            found.sort((a, b) => a.bytes.length - b.bytes.length
                || asTyped(b) - asTyped(a)
                || (b.entry.code === wasCode) - (a.entry.code === wasCode)
                || (ENCODING_RANK[a.entry.encoding] ?? 9) - (ENCODING_RANK[b.entry.encoding] ?? 9)
                || a.entry.code - b.entry.code);
            return { bytes: found[0].bytes, text: found[0].shown };
        }

        return { assemble, register };
    }

    root.makeAssembler = makeAssembler;
    root.x86Parse = { parseLine, parseNumber, aliases };
})(typeof self !== "undefined" ? self : globalThis);
