// MIPS for the hex view's disassembly: reads code (MIPS32 and MIPS64, of
// either byte order, with the floating point, DSP and MSA instructions, and
// Octeon's in MIPS64) as lines, and assembles a line, as it's shown, into
// its four bytes, to edit code in place. Both go by one table: an
// instruction is a name, the bits that make it that, and what its operands
// are; so a line that's shown can be typed back, and gives the same bytes.
//
// A classic script, with nothing to load: in the worker (disasm-worker.js),
// self.mips is {disassemble(bytes, address, mode, max), assemble(text,
// address, mode, was)}, mode being "mips32-le", "mips64-be" and so on.
// Addresses are what the disassembly shows (file offsets): where a branch
// or a jump goes is written as the address. What's shown is as Capstone,
// which showed it before, wrote it; scripts/disasm/check-mips.mjs holds it
// to that, and lists where it isn't.
"use strict";
(function (root) {
    const GPR = "zero at v0 v1 a0 a1 a2 a3 t0 t1 t2 t3 t4 t5 t6 t7 s0 s1 s2 s3 s4 s5 s6 s7 t8 t9 k0 k1 gp sp fp ra".split(" ");

    // (How a number is shown and read, a line taken apart, and a name's
    // rows gone through, are RISC-V's assembler's too: see asm-common.js.)
    const { shown, number, small, parseLine, assembleLine } = root.asmCommon;
    const bits = (w, low, width) => (w >>> low) & (2 ** width - 1);
    const at = (v, low, width) => (Number.isInteger(v) && v >= 0 && v < 2 ** width ? (v << low) >>> 0 : null);

    // What an operand is: get, its value in a word (null: no such); put, the
    // bits a value is in a word (null: it can't be that), given the word so
    // far; show, as it's written; read, the value written (null: not one).
    // c is {address}; show adds where it goes to c.targets.
    // A register: $ and its name, or its number; typed with or without $.
    const register = (prefix, names, low, width = 5) => ({
        get: (w) => bits(w, low, width),
        put: (v) => at(v, low, width),
        show: (v) => `$${names ? names[v] : prefix + v}`,
        read: (text) => {
            const name = text.replace(/^\$/, "");
            const named = names ? names.indexOf(name === "s8" ? "fp" : name) : -1;
            const m = named < 0 && (names ? /^(\d+)$/ : new RegExp(`^${prefix}(\\d+)$`)).exec(name);
            return named >= 0 ? named : m && Number(m[1]) < 2 ** width ? Number(m[1]) : null;
        },
    });
    const KINDS = {
        G: (low, width) => register("", GPR, low, width),
        F: (low, width) => register("f", null, low, width),
        W: (low, width) => register("w", null, low, width),
        N: (low, width) => register("", null, low, width),
        A: (low, width) => register("ac", null, low, width),
        C: (low, width) => register("fcc", null, low, width),
        c: (low, width) => register("cc", null, low, width),
        // A double in two 32-bit registers (MIPS32): the even ones.
        E: (low) => {
            const r = register("f", null, low, 5);
            return { ...r, get: (w) => (bits(w, low, 1) ? null : r.get(w)), put: (v) => (v % 2 ? null : r.put(v)) };
        },
        // clz's and clo's: where the count goes, which the word has twice
        // (and, where the two differ, is read as both together).
        Q: (low) => {
            const r = register("", GPR, low, 5);
            return { ...r, get: (w) => r.get(w) | bits(w, 16, 5), put: (v) => (r.put(v) == null ? null : (r.put(v) | at(v, 16, 5)) >>> 0) };
        },
        u: (low, width, shift = 0, add = 0) => ({
            get: (w) => (bits(w, low, width) << shift) + add,
            // (Divided, not shifted: a shift keeps only 32 bits, and a number past them isn't its low ones.)
            put: (v) => (Number.isInteger(v) && (v - add) % (1 << shift) === 0 ? at((v - add) / (1 << shift), low, width) : null),
            show: shown,
            read: small,
        }),
        s: (low, width, shift = 0) => ({
            get: (w) => ((bits(w, low, width) << (32 - width)) >> (32 - width)) * (1 << shift),
            put: (v) => {
                const n = v / (1 << shift);
                return Number.isInteger(n) && n >= -(2 ** (width - 1)) && n < 2 ** (width - 1) ? ((n & (2 ** width - 1)) << low) >>> 0 : null;
            },
            show: shown,
            read: small,
        }),
        // One more than the bits (a field's size); 33 more, and 32 more
        // (the fields of a doubleword past its first half).
        p: (low, width) => KINDS.u(low, width, 0, 1),
        x: (low, width) => KINDS.u(low, width, 0, 33),
        y: (low, width) => KINDS.u(low, width, 0, 32),
        // ins's size: the word has where the field ends (less `add`), after
        // where it begins (the operand before this one).
        z: (add) => ({
            get: (w) => {
                const size = bits(w, 11, 5) + add - bits(w, 6, 5) + 1;
                return size < 1 ? null : size;
            },
            put: (v, w) => (Number.isInteger(v) && v >= 1 ? at(v + bits(w, 6, 5) - 1 - add, 11, 5) : null),
            show: shown,
            read: small,
        }),
        // Where a branch goes: in the word, how many instructions from the
        // next; written, the address, a link if it's one a file can have.
        // One before the start is written as 64 bits wrap, and is none.
        b: (low, width) => ({
            get: (w) => (bits(w, low, width) << (32 - width)) >> (32 - width),
            put: (v) => (Number.isInteger(v) && v >= -(2 ** (width - 1)) && v < 2 ** (width - 1) ? ((v & (2 ** width - 1)) << low) >>> 0 : null),
            show: (v, c) => address(BigInt(c.address) + 4n + BigInt(v) * 4n, c),
            read: (text, c) => {
                const to = number(text);
                if (to == null || to < -(2n ** 63n) || to >= 2n ** 64n) return null;
                const far = BigInt.asIntN(64, to - BigInt(c.address) - 4n);
                return far % 4n || far < -(2n ** 40n) || far > 2n ** 40n ? NaN : Number(far / 4n);
            },
        }),
        // Where a jump goes: the word has its low 28 bits; the rest are
        // those of the instruction after it.
        j: (low, width) => ({
            get: (w) => bits(w, low, width),
            put: (v) => at(v, low, width),
            show: (v, c) => address(((BigInt(c.address) + 4n) & ~0xfffffffn) | (BigInt(v) << 2n), c),
            read: (text, c) => {
                const to = number(text);
                if (to == null) return null;
                return to % 4n || to < 0n || (to & ~0xfffffffn) !== ((BigInt(c.address) + 4n) & ~0xfffffffn) ? NaN : Number((to & 0xfffffffn) >> 2n);
            },
        }),
    };
    function address(to, c) {
        if (to >= 0n && to <= BigInt(Number.MAX_SAFE_INTEGER)) {
            c.targets.push(Number(to));
            return shown(Number(to));
        }
        return `0x${BigInt.asUintN(64, to).toString(16)}`;
    }

    // An operand as a row has it: kinds, each a letter with where its bits
    // are (G16: a register in the five bits from 16; s0.16: a signed number
    // in the 16 from 0; s16.10<3, one of eight times that), among what's
    // written as it is: s0.16(G21), W11[u16.4], $29.
    const KIND = /([GFWNACcEQ])(\d+)(?:\.(\d+))?|([uspxyzbj])(\d+)(?:\.(\d+))?(?:<(\d))?/g;
    const operands = new Map();
    function operand(spec) {
        if (operands.has(spec)) return operands.get(spec);
        const kinds = [];
        let pattern = "^", from = 0;
        const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\$/g, "\\$?");
        for (const m of spec.matchAll(KIND)) {
            pattern += `${literal(spec.slice(from, m.index))}([^()\\[\\]]+)`;
            from = m.index + m[0].length;
            kinds.push(m[1] ? KINDS[m[1]](Number(m[2]), m[3] ? Number(m[3]) : 5) : KINDS[m[4]](Number(m[5]), Number(m[6] ?? 0), Number(m[7] ?? 0)));
        }
        const text = new RegExp(`${pattern}${literal(spec.slice(from))}$`);
        const parts = spec.split(KIND).filter((_, i) => i % 8 === 0);
        const made = {
            get: (w) => {
                const values = kinds.map((k) => k.get(w));
                return values.includes(null) ? null : values;
            },
            // The bits of values in a word, added to it (null: they can't be).
            put: (values, w) => {
                for (let i = 0; i < kinds.length; i++) {
                    const b = kinds[i].put(values[i], w);
                    if (b == null) return null;
                    w = (w | b) >>> 0;
                }
                return w;
            },
            show: (values, c) => parts.map((p, i) => p + (i < kinds.length ? kinds[i].show(values[i], c) : "")).join(""),
            read: (typed, c) => {
                const m = text.exec(typed);
                if (!m) return null;
                const values = kinds.map((k, i) => k.read(m[i + 1], c));
                return values.includes(null) ? null : values;
            },
        };
        operands.set(spec, made);
        return made;
    }

    // The instructions: name, the bits that are it (match, of mask), its
    // operands; then @32 or @64 for one only that width has, and ~ with
    // bits that are ignored (written as 0). The first that a word is, is
    // what it's shown as: they're in order of how much of the word each
    // fixes, so another name for one (move, for or with nothing) is first.
    const TABLE = `
ldxc1 4c000001 fc00f83f F6,G16(G21) @64
luxc1 4c000005 fc00f83f F6,G16(G21) @64
sdxc1 4c000009 fc0007ff F11,G16(G21) @64
suxc1 4c00000d fc0007ff F11,G16(G21) @64
madd.d 4c000021 fc00003f F6,F21,F11,F16 @64
msub.d 4c000029 fc00003f F6,F21,F11,F16 @64
nmadd.d 4c000031 fc00003f F6,F21,F11,F16 @64
nmsub.d 4c000039 fc00003f F6,F21,F11,F16 @64
bc3f 4d000000 ffff0000 b0.16
bc3t 4d010000 ffff0000 b0.16
bc3fl 4d020000 ffff0000 b0.16
bc3tl 4d030000 ffff0000 b0.16
bc3f 4d000000 ffe30000 c18.3,b0.16
bc3t 4d010000 ffe30000 c18.3,b0.16
bc3fl 4d020000 ffe30000 c18.3,b0.16
bc3tl 4d030000 ffe30000 c18.3,b0.16
di 41606000 ffffffff
ei 41606020 ffffffff
nop 00000000 ffffffff
syscall 0000000c ffffffff
break 0000000d ffffffff
ssnop 00000040 ffffffff
ehb 000000c0 ffffffff
pause 00000140 ffffffff
tlbr 42000001 ffffffff
tlbwi 42000002 ffffffff
tlbwr 42000006 ffffffff
tlbp 42000008 ffffffff
eret 42000018 ffffffff
deret 4200001f ffffffff
wait 42000020 ffffffff
sdbbp 7000003f ffffffff
mfhi 00000010 ffff07ff G11
mthi 00000011 fc1fffff G21
mflo 00000012 ffff07ff G11
mtlo 00000013 fc1fffff G21
jr.hb 00000408 fc1fffff G21
jalr 0000f809 fc1fffff G21
jalr.hb 0000fc09 fc1fffff G21
synci 041f0000 fc1fffff (G21)
di 41606000 ffe0ffff G16
ei 41606020 ffe0ffff G16
mtm0 70000008 fc1fffff G21 @64
mtp0 70000009 fc1fffff G21 @64
mtp1 7000000a fc1fffff G21 @64
mtp2 7000000b fc1fffff G21 @64
mtm1 7000000c fc1fffff G21 @64
mtm2 7000000d fc1fffff G21 @64
rdhwr 7c00e83b ffe0ffff G16,$29
jr 00000008 fc1ffffe G21 ~00000001
mfhi 00000010 ff9f07ff G11,A21.2
mthi 00000011 fc1fe7ff G21,A11.2
mflo 00000012 ff9f07ff G11,A21.2
mtlo 00000013 fc1fe7ff G21,A11.2
shilov 7c0006f8 fc1fe7ff A11.2,G21
mthlip 7c0007f8 fc1fe7ff G21,A11.2
sqrt.d 46200004 ffff087f E6,E11 @32
abs.d 46200005 ffff087f E6,E11 @32
mov.d 46200006 ffff087f E6,E11 @32
neg.d 46200007 ffff087f E6,E11 @32
c.f.d 46200030 ffe10fff E11,E16 @32
c.un.d 46200031 ffe10fff E11,E16 @32
c.eq.d 46200032 ffe10fff E11,E16 @32
c.ueq.d 46200033 ffe10fff E11,E16 @32
c.olt.d 46200034 ffe10fff E11,E16 @32
c.ult.d 46200035 ffe10fff E11,E16 @32
c.ole.d 46200036 ffe10fff E11,E16 @32
c.ule.d 46200037 ffe10fff E11,E16 @32
c.sf.d 46200038 ffe10fff E11,E16 @32
c.ngle.d 46200039 ffe10fff E11,E16 @32
c.seq.d 4620003a ffe10fff E11,E16 @32
c.ngl.d 4620003b ffe10fff E11,E16 @32
c.lt.d 4620003c ffe10fff E11,E16 @32
c.nge.d 4620003d ffe10fff E11,E16 @32
c.le.d 4620003e ffe10fff E11,E16 @32
c.ngt.d 4620003f ffe10fff E11,E16 @32
ctcmsa 783e0019 ffff063f N6.3,G11
cfcmsa 787e0019 ffffc03f G6,N11.3
shilo 7c0006b8 fc0fe7ff A11.2,u20.6
mfhc1 44600000 ffe00fff G16,E11 @32
mthc1 44e00000 ffe00fff G16,E11 @32
cvt.d.s 46000021 ffff007f E6,F11 @32
round.w.d 4620000c ffff083f F6,E11 @32
trunc.w.d 4620000d ffff083f F6,E11 @32
ceil.w.d 4620000e ffff083f F6,E11 @32
floor.w.d 4620000f ffff083f F6,E11 @32
cvt.s.d 46200020 ffff083f F6,E11 @32
cvt.w.d 46200024 ffff083f F6,E11 @32
cvt.d.w 46800021 ffff007f E6,F11 @32
move 00000025 fc1f07ff G11,G21
move 00000021 fc1f07ff G11,G21
move 0000002d fc1f07ff G11,G21 @64
jalr 00000009 fc1f07ff G11,G21
break 0000000d fc00ffff u16.10
mult 00000018 fc00ffff G21,G16
multu 00000019 fc00ffff G21,G16
div 0000001a fc00ffff $zero,G21,G16
divu 0000001b fc00ffff $zero,G21,G16
dmult 0000001c fc00ffff G21,G16 @64
dmultu 0000001d fc00ffff G21,G16 @64
ddiv 0000001e fc00ffff $zero,G21,G16 @64
ddivu 0000001f fc00ffff $zero,G21,G16 @64
neg 00000022 ffe007ff G11,G16
negu 00000023 ffe007ff G11,G16
not 00000027 fc1f07ff G11,G21
tge 00000030 fc00ffff G21,G16
tgeu 00000031 fc00ffff G21,G16
tlt 00000032 fc00ffff G21,G16
tltu 00000033 fc00ffff G21,G16
teq 00000034 fc00ffff G21,G16
tne 00000036 fc00ffff G21,G16
jalr.hb 00000409 fc1f07ff G11,G21
mfc1 44000000 ffe007ff G16,F11
dmfc1 44200000 ffe007ff G16,F11
cfc1 44400000 ffe007ff G16,N11
mfhc1 44600000 ffe007ff G16,F11 @64
mtc1 44800000 ffe007ff G16,F11
dmtc1 44a00000 ffe007ff G16,F11
ctc1 44c00000 ffe007ff G16,N11
mthc1 44e00000 ffe007ff G16,F11 @64
sqrt.s 46000004 ffff003f F6,F11
abs.s 46000005 ffff003f F6,F11
mov.s 46000006 ffff003f F6,F11
neg.s 46000007 ffff003f F6,F11
round.l.s 46000008 ffff003f F6,F11 @64
trunc.l.s 46000009 ffff003f F6,F11 @64
ceil.l.s 4600000a ffff003f F6,F11 @64
floor.l.s 4600000b ffff003f F6,F11 @64
round.w.s 4600000c ffff003f F6,F11
trunc.w.s 4600000d ffff003f F6,F11
ceil.w.s 4600000e ffff003f F6,F11
floor.w.s 4600000f ffff003f F6,F11
cvt.d.s 46000021 ffff003f F6,F11 @64
cvt.w.s 46000024 ffff003f F6,F11
cvt.l.s 46000025 ffff003f F6,F11
c.f.s 46000030 ffe007ff F11,F16
c.un.s 46000031 ffe007ff F11,F16
c.eq.s 46000032 ffe007ff F11,F16
c.ueq.s 46000033 ffe007ff F11,F16
c.olt.s 46000034 ffe007ff F11,F16
c.ult.s 46000035 ffe007ff F11,F16
c.ole.s 46000036 ffe007ff F11,F16
c.ule.s 46000037 ffe007ff F11,F16
c.sf.s 46000038 ffe007ff F11,F16
c.ngle.s 46000039 ffe007ff F11,F16
c.seq.s 4600003a ffe007ff F11,F16
c.ngl.s 4600003b ffe007ff F11,F16
c.lt.s 4600003c ffe007ff F11,F16
c.nge.s 4600003d ffe007ff F11,F16
c.le.s 4600003e ffe007ff F11,F16
c.ngt.s 4600003f ffe007ff F11,F16
sqrt.d 46200004 ffff003f F6,F11 @64
abs.d 46200005 ffff003f F6,F11 @64
mov.d 46200006 ffff003f F6,F11 @64
neg.d 46200007 ffff003f F6,F11 @64
round.l.d 46200008 ffff003f F6,F11 @64
trunc.l.d 46200009 ffff003f F6,F11 @64
ceil.l.d 4620000a ffff003f F6,F11 @64
floor.l.d 4620000b ffff003f F6,F11 @64
round.w.d 4620000c ffff003f F6,F11 @64
trunc.w.d 4620000d ffff003f F6,F11 @64
ceil.w.d 4620000e ffff003f F6,F11 @64
floor.w.d 4620000f ffff003f F6,F11 @64
cvt.s.d 46200020 ffff003f F6,F11 @64
cvt.w.d 46200024 ffff003f F6,F11 @64
cvt.l.d 46200025 ffff003f F6,F11
c.f.d 46200030 ffe007ff F11,F16 @64
c.un.d 46200031 ffe007ff F11,F16 @64
c.eq.d 46200032 ffe007ff F11,F16 @64
c.ueq.d 46200033 ffe007ff F11,F16 @64
c.olt.d 46200034 ffe007ff F11,F16 @64
c.ult.d 46200035 ffe007ff F11,F16 @64
c.ole.d 46200036 ffe007ff F11,F16 @64
c.ule.d 46200037 ffe007ff F11,F16 @64
c.sf.d 46200038 ffe007ff F11,F16 @64
c.ngle.d 46200039 ffe007ff F11,F16 @64
c.seq.d 4620003a ffe007ff F11,F16 @64
c.ngl.d 4620003b ffe007ff F11,F16 @64
c.lt.d 4620003c ffe007ff F11,F16 @64
c.nge.d 4620003d ffe007ff F11,F16 @64
c.le.d 4620003e ffe007ff F11,F16 @64
c.ngt.d 4620003f ffe007ff F11,F16 @64
cvt.s.w 46800020 ffff003f F6,F11
cvt.d.w 46800021 ffff003f F6,F11 @64
cvt.s.l 46a00020 ffff003f F6,F11 @64
cvt.d.l 46a00021 ffff003f F6,F11 @64
ldl 68000000 fc00ffff G16,(G21) @64
ldr 6c000000 fc00ffff G16,(G21) @64
madd 70000000 fc00ffff G21,G16
maddu 70000001 fc00ffff G21,G16
msub 70000004 fc00ffff G21,G16
msubu 70000005 fc00ffff G21,G16
pop 7000002c fc1f07ff G11,G21 @64
dpop 7000002d fc1f07ff G11,G21 @64
ld.b 78000020 ffff003f W6,(G11)
ld.h 78000021 ffff003f W6,(G11)
ld.w 78000022 ffff003f W6,(G11)
ld.d 78000023 ffff003f W6,(G11)
st.b 78000024 ffff003f W6,(G11)
st.h 78000025 ffff003f W6,(G11)
st.w 78000026 ffff003f W6,(G11)
st.d 78000027 ffff003f W6,(G11)
move.v 78be0019 ffff003f W6,W11
fill.b 7b00001e ffff003f W6,G11
fill.h 7b01001e ffff003f W6,G11
fill.w 7b02001e ffff003f W6,G11
fill.d 7b03001e ffff003f W6,G11
pcnt.b 7b04001e ffff003f W6,W11
pcnt.h 7b05001e ffff003f W6,W11
pcnt.w 7b06001e ffff003f W6,W11
pcnt.d 7b07001e ffff003f W6,W11
nloc.b 7b08001e ffff003f W6,W11
nloc.h 7b09001e ffff003f W6,W11
nloc.w 7b0a001e ffff003f W6,W11
nloc.d 7b0b001e ffff003f W6,W11
nlzc.b 7b0c001e ffff003f W6,W11
nlzc.h 7b0d001e ffff003f W6,W11
nlzc.w 7b0e001e ffff003f W6,W11
nlzc.d 7b0f001e ffff003f W6,W11
fclass.w 7b20001e ffff003f W6,W11
fclass.d 7b21001e ffff003f W6,W11
ftrunc_s.w 7b22001e ffff003f W6,W11
ftrunc_s.d 7b23001e ffff003f W6,W11
ftrunc_u.w 7b24001e ffff003f W6,W11
ftrunc_u.d 7b25001e ffff003f W6,W11
fsqrt.w 7b26001e ffff003f W6,W11
fsqrt.d 7b27001e ffff003f W6,W11
frsqrt.w 7b28001e ffff003f W6,W11
frsqrt.d 7b29001e ffff003f W6,W11
frcp.w 7b2a001e ffff003f W6,W11
frcp.d 7b2b001e ffff003f W6,W11
frint.w 7b2c001e ffff003f W6,W11
frint.d 7b2d001e ffff003f W6,W11
flog2.w 7b2e001e ffff003f W6,W11
flog2.d 7b2f001e ffff003f W6,W11
fexupl.w 7b30001e ffff003f W6,W11
fexupl.d 7b31001e ffff003f W6,W11
fexupr.w 7b32001e ffff003f W6,W11
fexupr.d 7b33001e ffff003f W6,W11
ffql.w 7b34001e ffff003f W6,W11
ffql.d 7b35001e ffff003f W6,W11
ffqr.w 7b36001e ffff003f W6,W11
ffqr.d 7b37001e ffff003f W6,W11
ftint_s.w 7b38001e ffff003f W6,W11
ftint_s.d 7b39001e ffff003f W6,W11
ftint_u.w 7b3a001e ffff003f W6,W11
ftint_u.d 7b3b001e ffff003f W6,W11
ffint_s.w 7b3c001e ffff003f W6,W11
ffint_s.d 7b3d001e ffff003f W6,W11
ffint_u.w 7b3e001e ffff003f W6,W11
ffint_u.d 7b3f001e ffff003f W6,W11
insv 7c00000c fc00ffff G16,G21
cmpu.eq.qb 7c000011 fc00ffff G21,G16
cmpu.lt.qb 7c000051 fc00ffff G21,G16
absq_s.qb 7c000052 ffe007ff G11,G16
cmpu.le.qb 7c000091 fc00ffff G21,G16
wsbh 7c0000a0 ffe007ff G11,G16
dsbh 7c0000a4 ffe007ff G11,G16 @64
replv.qb 7c0000d2 ffe007ff G11,G16
precequ.ph.qbl 7c000112 ffe007ff G11,G16
precequ.ph.qbr 7c000152 ffe007ff G11,G16
dshd 7c000164 ffe007ff G11,G16 @64
precequ.ph.qbla 7c000192 ffe007ff G11,G16
precequ.ph.qbra 7c0001d2 ffe007ff G11,G16
cmp.eq.ph 7c000211 fc00ffff G21,G16
cmp.lt.ph 7c000251 fc00ffff G21,G16
absq_s.ph 7c000252 ffe007ff G11,G16
cmp.le.ph 7c000291 fc00ffff G21,G16
replv.ph 7c0002d2 ffe007ff G11,G16
preceq.w.phl 7c000312 ffe007ff G11,G16
preceq.w.phr 7c000352 ffe007ff G11,G16
seb 7c000420 ffe007ff G11,G16
absq_s.w 7c000452 ffe007ff G11,G16
raddu.w.qb 7c000510 fc1f07ff G11,G21
seh 7c000620 ffe007ff G11,G16
bitrev 7c0006d2 ffe007ff G11,G16
preceu.ph.qbl 7c000712 ffe007ff G11,G16
preceu.ph.qbr 7c000752 ffe007ff G11,G16
preceu.ph.qbla 7c000792 ffe007ff G11,G16
preceu.ph.qbra 7c0007d2 ffe007ff G11,G16
lb 80000000 fc00ffff G16,(G21)
lh 84000000 fc00ffff G16,(G21)
lwl 88000000 fc00ffff G16,(G21)
lw 8c000000 fc00ffff G16,(G21)
lbu 90000000 fc00ffff G16,(G21)
lhu 94000000 fc00ffff G16,(G21)
lwr 98000000 fc00ffff G16,(G21)
lwu 9c000000 fc00ffff G16,(G21) @64
sb a0000000 fc00ffff G16,(G21)
sh a4000000 fc00ffff G16,(G21)
swl a8000000 fc00ffff G16,(G21)
sw ac000000 fc00ffff G16,(G21)
sdl b0000000 fc00ffff G16,(G21) @64
sdr b4000000 fc00ffff G16,(G21) @64
swr b8000000 fc00ffff G16,(G21)
cache bc000000 fc00ffff u16.5,(G21)
ll c0000000 fc00ffff G16,(G21)
lwc1 c4000000 fc00ffff F16,(G21)
lwc2 c8000000 fc00ffff N16,(G21) @32
pref cc000000 fc00ffff u16.5,(G21)
lld d0000000 fc00ffff G16,(G21) @64
ldc1 d4000000 fc00ffff F16,(G21)
ldc2 d8000000 fc00ffff N16,(G21) @32
ld dc000000 fc00ffff G16,(G21) @64
sc e0000000 fc00ffff G16,(G21)
swc1 e4000000 fc00ffff F16,(G21)
swc2 e8000000 fc00ffff N16,(G21) @32
scd f0000000 fc00ffff G16,(G21) @64
sdc1 f4000000 fc00ffff F16,(G21)
sdc2 f8000000 fc00ffff N16,(G21) @32
sd fc000000 fc00ffff G16,(G21) @64
movf.d 46200011 ffe3087f E6,E11,C18.3 @32
movt.d 46210011 ffe3087f E6,E11,C18.3 @32
sldi.d 78380019 fffe003f W6,W11[u16.1]
splati.d 78780019 fffe003f W6,W11[u16.1]
copy_s.d 78b80019 fffe003f G6,W11[u16.1]
copy_u.d 78f80019 fffe003f G6,W11[u16.1]
insert.d 79380019 fffe003f W6[u16.1],G11
insve.d 79780019 fffe003f W6[u16.1],W11[0]
mult 00000018 fc00e7ff A11.2,G21,G16
multu 00000019 fc00e7ff A11.2,G21,G16
add.d 46200000 ffe1087f E6,E11,E16 @32
sub.d 46200001 ffe1087f E6,E11,E16 @32
mul.d 46200002 ffe1087f E6,E11,E16 @32
div.d 46200003 ffe1087f E6,E11,E16 @32
madd 70000000 fc00e7ff A11.2,G21,G16
maddu 70000001 fc00e7ff A11.2,G21,G16
msub 70000004 fc00e7ff A11.2,G21,G16
msubu 70000005 fc00e7ff A11.2,G21,G16
sldi.w 78300019 fffc003f W6,W11[u16.2]
splati.w 78700019 fffc003f W6,W11[u16.2]
copy_s.w 78b00019 fffc003f G6,W11[u16.2]
copy_u.w 78f00019 fffc003f G6,W11[u16.2]
insert.w 79300019 fffc003f W6[u16.2],G11
insve.w 79700019 fffc003f W6[u16.2],W11[0]
dpa.w.ph 7c000030 fc00e7ff A11.2,G21,G16
extr.w 7c000038 fc00e7ff G16,A11.2,u21.5
dps.w.ph 7c000070 fc00e7ff A11.2,G21,G16
extrv.w 7c000078 fc00e7ff G16,A11.2,G21
mulsa.w.ph 7c0000b0 fc00e7ff A11.2,G21,G16
extp 7c0000b8 fc00e7ff G16,A11.2,u21.5
dpau.h.qbl 7c0000f0 fc00e7ff A11.2,G21,G16
extpv 7c0000f8 fc00e7ff G16,A11.2,G21
dpaq_s.w.ph 7c000130 fc00e7ff A11.2,G21,G16
extr_r.w 7c000138 fc00e7ff G16,A11.2,u21.5
dpsq_s.w.ph 7c000170 fc00e7ff A11.2,G21,G16
extrv_r.w 7c000178 fc00e7ff G16,A11.2,G21
mulsaq_s.w.ph 7c0001b0 fc00e7ff A11.2,G21,G16
extr_rs.w 7c0001b8 fc00e7ff G16,A11.2,u21.5
dpau.h.qbr 7c0001f0 fc00e7ff A11.2,G21,G16
extrv_rs.w 7c0001f8 fc00e7ff G16,A11.2,G21
dpax.w.ph 7c000230 fc00e7ff A11.2,G21,G16
dpsx.w.ph 7c000270 fc00e7ff A11.2,G21,G16
extpdp 7c0002b8 fc00e7ff G16,A11.2,u21.5
dpsu.h.qbl 7c0002f0 fc00e7ff A11.2,G21,G16
extpdpv 7c0002f8 fc00e7ff G16,A11.2,G21
dpaq_sa.l.w 7c000330 fc00e7ff A11.2,G21,G16
dpsq_sa.l.w 7c000370 fc00e7ff A11.2,G21,G16
extr_s.h 7c0003b8 fc00e7ff G16,A11.2,u21.5
dpsu.h.qbr 7c0003f0 fc00e7ff A11.2,G21,G16
extrv_s.h 7c0003f8 fc00e7ff G16,A11.2,G21
maq_sa.w.phl 7c000430 fc00e7ff A11.2,G21,G16
maq_sa.w.phr 7c0004b0 fc00e7ff A11.2,G21,G16
maq_s.w.phl 7c000530 fc00e7ff A11.2,G21,G16
maq_s.w.phr 7c0005b0 fc00e7ff A11.2,G21,G16
dpaqx_s.w.ph 7c000630 fc00e7ff A11.2,G21,G16
dpsqx_s.w.ph 7c000670 fc00e7ff A11.2,G21,G16
dpaqx_sa.w.ph 7c0006b0 fc00e7ff A11.2,G21,G16
dpsqx_sa.w.ph 7c0006f0 fc00e7ff A11.2,G21,G16
movf 00000001 fc0307ff G11,G21,C18.3
movt 00010001 fc0307ff G11,G21,C18.3
mfc0 40000000 ffe007f8 G16,G11,u0.3
dmfc0 40200000 ffe007f8 G16,G11,u0.3 @64
mtc0 40800000 ffe007f8 G16,G11,u0.3
dmtc0 40a00000 ffe007f8 G16,G11,u0.3 @64
movf.s 46000011 ffe3003f F6,F11,C18.3
movt.s 46010011 ffe3003f F6,F11,C18.3
movf.d 46200011 ffe3003f F6,F11,C18.3 @64
movz.d 46200012 ffe0087f E6,E11,G16 @32
movn.d 46200013 ffe0087f E6,E11,G16 @32
movt.d 46210011 ffe3003f F6,F11,C18.3 @64
mfc2 48000000 ffe007f8 G16,G11,u0.3
dmfc2 48200000 ffe007f8 G16,G11,u0.3 @64
mtc2 48800000 ffe007f8 G16,G11,u0.3
dmtc2 48a00000 ffe007f8 G16,G11,u0.3 @64
sldi.h 78200019 fff8003f W6,W11[u16.3]
splati.h 78600019 fff8003f W6,W11[u16.3]
slli.b 78700009 fff8003f W6,W11,u16.3
sat_s.b 7870000a fff8003f W6,W11,u16.3
copy_s.h 78a00019 fff8003f G6,W11[u16.3]
copy_u.h 78e00019 fff8003f G6,W11[u16.3]
srai.b 78f00009 fff8003f W6,W11,u16.3
sat_u.b 78f0000a fff8003f W6,W11,u16.3
insert.h 79200019 fff8003f W6[u16.3],G11
insve.h 79600019 fff8003f W6[u16.3],W11[0]
srli.b 79700009 fff8003f W6,W11,u16.3
srari.b 7970000a fff8003f W6,W11,u16.3
bclri.b 79f00009 fff8003f W6,W11,u16.3
srlri.b 79f0000a fff8003f W6,W11,u16.3
bseti.b 7a700009 fff8003f W6,W11,u16.3
bnegi.b 7af00009 fff8003f W6,W11,u16.3
binsli.b 7b700009 fff8003f W6,W11,u16.3
binsri.b 7bf00009 fff8003f W6,W11,u16.3
ldxc1 4c000001 fc00f87f E6,G16(G21) @32
luxc1 4c000005 fc00f87f E6,G16(G21) @32
sdxc1 4c000009 fc000fff E11,G16(G21) @32
suxc1 4c00000d fc000fff E11,G16(G21) @32
sldi.b 78000019 fff0003f W6,W11[u16.4]
splati.b 78400019 fff0003f W6,W11[u16.4]
slli.h 78600009 fff0003f W6,W11,u16.4
sat_s.h 7860000a fff0003f W6,W11,u16.4
copy_s.b 78800019 fff0003f G6,W11[u16.4]
copy_u.b 78c00019 fff0003f G6,W11[u16.4]
srai.h 78e00009 fff0003f W6,W11,u16.4
sat_u.h 78e0000a fff0003f W6,W11,u16.4
insert.b 79000019 fff0003f W6[u16.4],G11
insve.b 79400019 fff0003f W6[u16.4],W11[0]
srli.h 79600009 fff0003f W6,W11,u16.4
srari.h 7960000a fff0003f W6,W11,u16.4
bclri.h 79e00009 fff0003f W6,W11,u16.4
srlri.h 79e0000a fff0003f W6,W11,u16.4
bseti.h 7a600009 fff0003f W6,W11,u16.4
bnegi.h 7ae00009 fff0003f W6,W11,u16.4
binsli.h 7b600009 fff0003f W6,W11,u16.4
binsri.h 7be00009 fff0003f W6,W11,u16.4
clz 70000020 fc0007ff Q11,G21 ~001f0000
clo 70000021 fc0007ff Q11,G21 ~001f0000
dclz 70000024 fc0007ff Q11,G21 @64 ~001f0000
dclo 70000025 fc0007ff Q11,G21 @64 ~001f0000
sll 00000000 ffe0003f G11,G16,u6.5
srl 00000002 ffe0003f G11,G16,u6.5
sra 00000003 ffe0003f G11,G16,u6.5
sllv 00000004 fc0007ff G11,G16,G21
srlv 00000006 fc0007ff G11,G16,G21
srav 00000007 fc0007ff G11,G16,G21
movz 0000000a fc0007ff G11,G21,G16
movn 0000000b fc0007ff G11,G21,G16
sync 0000000f fc0007ff ~03fff800
dsllv 00000014 fc0007ff G11,G16,G21 @64
dsrlv 00000016 fc0007ff G11,G16,G21 @64
dsrav 00000017 fc0007ff G11,G16,G21 @64
add 00000020 fc0007ff G11,G21,G16
addu 00000021 fc0007ff G11,G21,G16
sub 00000022 fc0007ff G11,G21,G16
subu 00000023 fc0007ff G11,G21,G16
and 00000024 fc0007ff G11,G21,G16
or 00000025 fc0007ff G11,G21,G16
xor 00000026 fc0007ff G11,G21,G16
nor 00000027 fc0007ff G11,G21,G16
slt 0000002a fc0007ff G11,G21,G16
sltu 0000002b fc0007ff G11,G21,G16
dadd 0000002c fc0007ff G11,G21,G16 @64
daddu 0000002d fc0007ff G11,G21,G16 @64
dsub 0000002e fc0007ff G11,G21,G16 @64
dsubu 0000002f fc0007ff G11,G21,G16 @64
dsll 00000038 ffe0003f G11,G16,u6.5 @64
dsrl 0000003a ffe0003f G11,G16,u6.5 @64
dsra 0000003b ffe0003f G11,G16,u6.5 @64
dsll32 0000003c ffe0003f G11,G16,u6.5 @64
dsrl32 0000003e ffe0003f G11,G16,u6.5 @64
dsra32 0000003f ffe0003f G11,G16,u6.5 @64
rotrv 00000046 fc0007ff G11,G16,G21
drotrv 00000056 fc0007ff G11,G16,G21 @64
rotr 00200002 ffe0003f G11,G16,u6.5
drotr 0020003a ffe0003f G11,G16,u6.5 @64
drotr32 0020003e ffe0003f G11,G16,u6.5 @64
add.s 46000000 ffe0003f F6,F11,F16
sub.s 46000001 ffe0003f F6,F11,F16
mul.s 46000002 ffe0003f F6,F11,F16
div.s 46000003 ffe0003f F6,F11,F16
movz.s 46000012 ffe0003f F6,F11,G16
movn.s 46000013 ffe0003f F6,F11,G16
add.d 46200000 ffe0003f F6,F11,F16 @64
sub.d 46200001 ffe0003f F6,F11,F16 @64
mul.d 46200002 ffe0003f F6,F11,F16 @64
div.d 46200003 ffe0003f F6,F11,F16 @64
movz.d 46200012 ffe0003f F6,F11,G16 @64
movn.d 46200013 ffe0003f F6,F11,G16 @64
lwxc1 4c000000 fc00f83f F6,G16(G21)
swxc1 4c000008 fc0007ff F11,G16(G21)
mul 70000002 fc0007ff G11,G21,G16
dmul 70000003 fc0007ff G11,G21,G16 @64
vmulu 7000000f fc0007ff G11,G21,G16 @64
vmm0 70000010 fc0007ff G11,G21,G16 @64
v3mulu 70000011 fc0007ff G11,G21,G16 @64
baddu 70000028 fc0007ff G11,G21,G16 @64
seq 7000002a fc0007ff G11,G21,G16 @64
sne 7000002b fc0007ff G11,G21,G16 @64
addvi.b 78000006 ffe0003f W6,W11,u16.5
ceqi.b 78000007 ffe0003f W6,W11,u16.5
sll.b 7800000d ffe0003f W6,W11,W16
addv.b 7800000e ffe0003f W6,W11,W16
ceq.b 7800000f ffe0003f W6,W11,W16
add_a.b 78000010 ffe0003f W6,W11,W16
subs_s.b 78000011 ffe0003f W6,W11,W16
mulv.b 78000012 ffe0003f W6,W11,W16
sld.b 78000014 ffe0003f W6,W11[G16]
vshf.b 78000015 ffe0003f W6,W11,W16
fcaf.w 7800001a ffe0003f W6,W11,W16
fadd.w 7800001b ffe0003f W6,W11,W16
and.v 7800001e ffe0003f W6,W11,W16
addvi.h 78200006 ffe0003f W6,W11,u16.5
ceqi.h 78200007 ffe0003f W6,W11,u16.5
sll.h 7820000d ffe0003f W6,W11,W16
addv.h 7820000e ffe0003f W6,W11,W16
ceq.h 7820000f ffe0003f W6,W11,W16
add_a.h 78200010 ffe0003f W6,W11,W16
subs_s.h 78200011 ffe0003f W6,W11,W16
mulv.h 78200012 ffe0003f W6,W11,W16
dotp_s.h 78200013 ffe0003f W6,W11,W16
sld.h 78200014 ffe0003f W6,W11[G16]
vshf.h 78200015 ffe0003f W6,W11,W16
fcaf.d 7820001a ffe0003f W6,W11,W16
fadd.d 7820001b ffe0003f W6,W11,W16
or.v 7820001e ffe0003f W6,W11,W16
addvi.w 78400006 ffe0003f W6,W11,u16.5
ceqi.w 78400007 ffe0003f W6,W11,u16.5
slli.w 78400009 ffe0003f W6,W11,u16.5
sat_s.w 7840000a ffe0003f W6,W11,u16.5
sll.w 7840000d ffe0003f W6,W11,W16
addv.w 7840000e ffe0003f W6,W11,W16
ceq.w 7840000f ffe0003f W6,W11,W16
add_a.w 78400010 ffe0003f W6,W11,W16
subs_s.w 78400011 ffe0003f W6,W11,W16
mulv.w 78400012 ffe0003f W6,W11,W16
dotp_s.w 78400013 ffe0003f W6,W11,W16
sld.w 78400014 ffe0003f W6,W11[G16]
vshf.w 78400015 ffe0003f W6,W11,W16
fcun.w 7840001a ffe0003f W6,W11,W16
fsub.w 7840001b ffe0003f W6,W11,W16
fcor.w 7840001c ffe0003f W6,W11,W16
nor.v 7840001e ffe0003f W6,W11,W16
addvi.d 78600006 ffe0003f W6,W11,u16.5
ceqi.d 78600007 ffe0003f W6,W11,u16.5
sll.d 7860000d ffe0003f W6,W11,W16
addv.d 7860000e ffe0003f W6,W11,W16
ceq.d 7860000f ffe0003f W6,W11,W16
add_a.d 78600010 ffe0003f W6,W11,W16
subs_s.d 78600011 ffe0003f W6,W11,W16
mulv.d 78600012 ffe0003f W6,W11,W16
dotp_s.d 78600013 ffe0003f W6,W11,W16
sld.d 78600014 ffe0003f W6,W11[G16]
vshf.d 78600015 ffe0003f W6,W11,W16
fcun.d 7860001a ffe0003f W6,W11,W16
fsub.d 7860001b ffe0003f W6,W11,W16
fcor.d 7860001c ffe0003f W6,W11,W16
xor.v 7860001e ffe0003f W6,W11,W16
subvi.b 78800006 ffe0003f W6,W11,u16.5
sra.b 7880000d ffe0003f W6,W11,W16
subv.b 7880000e ffe0003f W6,W11,W16
adds_a.b 78800010 ffe0003f W6,W11,W16
subs_u.b 78800011 ffe0003f W6,W11,W16
maddv.b 78800012 ffe0003f W6,W11,W16
splat.b 78800014 ffe0003f W6,W11[G16]
srar.b 78800015 ffe0003f W6,W11,W16
fceq.w 7880001a ffe0003f W6,W11,W16
fmul.w 7880001b ffe0003f W6,W11,W16
fcune.w 7880001c ffe0003f W6,W11,W16
bmnz.v 7880001e ffe0003f W6,W11,W16
subvi.h 78a00006 ffe0003f W6,W11,u16.5
sra.h 78a0000d ffe0003f W6,W11,W16
subv.h 78a0000e ffe0003f W6,W11,W16
adds_a.h 78a00010 ffe0003f W6,W11,W16
subs_u.h 78a00011 ffe0003f W6,W11,W16
maddv.h 78a00012 ffe0003f W6,W11,W16
dotp_u.h 78a00013 ffe0003f W6,W11,W16
splat.h 78a00014 ffe0003f W6,W11[G16]
srar.h 78a00015 ffe0003f W6,W11,W16
fceq.d 78a0001a ffe0003f W6,W11,W16
fmul.d 78a0001b ffe0003f W6,W11,W16
fcune.d 78a0001c ffe0003f W6,W11,W16
bmz.v 78a0001e ffe0003f W6,W11,W16
subvi.w 78c00006 ffe0003f W6,W11,u16.5
srai.w 78c00009 ffe0003f W6,W11,u16.5
sat_u.w 78c0000a ffe0003f W6,W11,u16.5
sra.w 78c0000d ffe0003f W6,W11,W16
subv.w 78c0000e ffe0003f W6,W11,W16
adds_a.w 78c00010 ffe0003f W6,W11,W16
subs_u.w 78c00011 ffe0003f W6,W11,W16
maddv.w 78c00012 ffe0003f W6,W11,W16
dotp_u.w 78c00013 ffe0003f W6,W11,W16
splat.w 78c00014 ffe0003f W6,W11[G16]
srar.w 78c00015 ffe0003f W6,W11,W16
fcueq.w 78c0001a ffe0003f W6,W11,W16
fdiv.w 78c0001b ffe0003f W6,W11,W16
fcne.w 78c0001c ffe0003f W6,W11,W16
bsel.v 78c0001e ffe0003f W6,W11,W16
subvi.d 78e00006 ffe0003f W6,W11,u16.5
sra.d 78e0000d ffe0003f W6,W11,W16
subv.d 78e0000e ffe0003f W6,W11,W16
adds_a.d 78e00010 ffe0003f W6,W11,W16
subs_u.d 78e00011 ffe0003f W6,W11,W16
maddv.d 78e00012 ffe0003f W6,W11,W16
dotp_u.d 78e00013 ffe0003f W6,W11,W16
splat.d 78e00014 ffe0003f W6,W11[G16]
srar.d 78e00015 ffe0003f W6,W11,W16
fcueq.d 78e0001a ffe0003f W6,W11,W16
fdiv.d 78e0001b ffe0003f W6,W11,W16
fcne.d 78e0001c ffe0003f W6,W11,W16
maxi_s.b 79000006 ffe0003f W6,W11,u16.5
clti_s.b 79000007 ffe0003f W6,W11,u16.5
srl.b 7900000d ffe0003f W6,W11,W16
max_s.b 7900000e ffe0003f W6,W11,W16
clt_s.b 7900000f ffe0003f W6,W11,W16
adds_s.b 79000010 ffe0003f W6,W11,W16
subsus_u.b 79000011 ffe0003f W6,W11,W16
msubv.b 79000012 ffe0003f W6,W11,W16
pckev.b 79000014 ffe0003f W6,W11,W16
srlr.b 79000015 ffe0003f W6,W11,W16
fclt.w 7900001a ffe0003f W6,W11,W16
fmadd.w 7900001b ffe0003f W6,W11,W16
mul_q.h 7900001c ffe0003f W6,W11,W16
maxi_s.h 79200006 ffe0003f W6,W11,u16.5
clti_s.h 79200007 ffe0003f W6,W11,u16.5
srl.h 7920000d ffe0003f W6,W11,W16
max_s.h 7920000e ffe0003f W6,W11,W16
clt_s.h 7920000f ffe0003f W6,W11,W16
adds_s.h 79200010 ffe0003f W6,W11,W16
subsus_u.h 79200011 ffe0003f W6,W11,W16
msubv.h 79200012 ffe0003f W6,W11,W16
dpadd_s.h 79200013 ffe0003f W6,W11,W16
pckev.h 79200014 ffe0003f W6,W11,W16
srlr.h 79200015 ffe0003f W6,W11,W16
fclt.d 7920001a ffe0003f W6,W11,W16
fmadd.d 7920001b ffe0003f W6,W11,W16
mul_q.w 7920001c ffe0003f W6,W11,W16
maxi_s.w 79400006 ffe0003f W6,W11,u16.5
clti_s.w 79400007 ffe0003f W6,W11,u16.5
srli.w 79400009 ffe0003f W6,W11,u16.5
srari.w 7940000a ffe0003f W6,W11,u16.5
srl.w 7940000d ffe0003f W6,W11,W16
max_s.w 7940000e ffe0003f W6,W11,W16
clt_s.w 7940000f ffe0003f W6,W11,W16
adds_s.w 79400010 ffe0003f W6,W11,W16
subsus_u.w 79400011 ffe0003f W6,W11,W16
msubv.w 79400012 ffe0003f W6,W11,W16
dpadd_s.w 79400013 ffe0003f W6,W11,W16
pckev.w 79400014 ffe0003f W6,W11,W16
srlr.w 79400015 ffe0003f W6,W11,W16
fcult.w 7940001a ffe0003f W6,W11,W16
fmsub.w 7940001b ffe0003f W6,W11,W16
madd_q.h 7940001c ffe0003f W6,W11,W16
maxi_s.d 79600006 ffe0003f W6,W11,u16.5
clti_s.d 79600007 ffe0003f W6,W11,u16.5
srl.d 7960000d ffe0003f W6,W11,W16
max_s.d 7960000e ffe0003f W6,W11,W16
clt_s.d 7960000f ffe0003f W6,W11,W16
adds_s.d 79600010 ffe0003f W6,W11,W16
subsus_u.d 79600011 ffe0003f W6,W11,W16
msubv.d 79600012 ffe0003f W6,W11,W16
dpadd_s.d 79600013 ffe0003f W6,W11,W16
pckev.d 79600014 ffe0003f W6,W11,W16
srlr.d 79600015 ffe0003f W6,W11,W16
fcult.d 7960001a ffe0003f W6,W11,W16
fmsub.d 7960001b ffe0003f W6,W11,W16
madd_q.w 7960001c ffe0003f W6,W11,W16
maxi_u.b 79800006 ffe0003f W6,W11,u16.5
clti_u.b 79800007 ffe0003f W6,W11,u16.5
bclr.b 7980000d ffe0003f W6,W11,W16
max_u.b 7980000e ffe0003f W6,W11,W16
clt_u.b 7980000f ffe0003f W6,W11,W16
adds_u.b 79800010 ffe0003f W6,W11,W16
subsuu_s.b 79800011 ffe0003f W6,W11,W16
pckod.b 79800014 ffe0003f W6,W11,W16
fcle.w 7980001a ffe0003f W6,W11,W16
msub_q.h 7980001c ffe0003f W6,W11,W16
maxi_u.h 79a00006 ffe0003f W6,W11,u16.5
clti_u.h 79a00007 ffe0003f W6,W11,u16.5
bclr.h 79a0000d ffe0003f W6,W11,W16
max_u.h 79a0000e ffe0003f W6,W11,W16
clt_u.h 79a0000f ffe0003f W6,W11,W16
adds_u.h 79a00010 ffe0003f W6,W11,W16
subsuu_s.h 79a00011 ffe0003f W6,W11,W16
dpadd_u.h 79a00013 ffe0003f W6,W11,W16
pckod.h 79a00014 ffe0003f W6,W11,W16
fcle.d 79a0001a ffe0003f W6,W11,W16
msub_q.w 79a0001c ffe0003f W6,W11,W16
maxi_u.w 79c00006 ffe0003f W6,W11,u16.5
clti_u.w 79c00007 ffe0003f W6,W11,u16.5
bclri.w 79c00009 ffe0003f W6,W11,u16.5
srlri.w 79c0000a ffe0003f W6,W11,u16.5
bclr.w 79c0000d ffe0003f W6,W11,W16
max_u.w 79c0000e ffe0003f W6,W11,W16
clt_u.w 79c0000f ffe0003f W6,W11,W16
adds_u.w 79c00010 ffe0003f W6,W11,W16
subsuu_s.w 79c00011 ffe0003f W6,W11,W16
dpadd_u.w 79c00013 ffe0003f W6,W11,W16
pckod.w 79c00014 ffe0003f W6,W11,W16
fcule.w 79c0001a ffe0003f W6,W11,W16
fexp2.w 79c0001b ffe0003f W6,W11,W16
maxi_u.d 79e00006 ffe0003f W6,W11,u16.5
clti_u.d 79e00007 ffe0003f W6,W11,u16.5
bclr.d 79e0000d ffe0003f W6,W11,W16
max_u.d 79e0000e ffe0003f W6,W11,W16
clt_u.d 79e0000f ffe0003f W6,W11,W16
adds_u.d 79e00010 ffe0003f W6,W11,W16
subsuu_s.d 79e00011 ffe0003f W6,W11,W16
dpadd_u.d 79e00013 ffe0003f W6,W11,W16
pckod.d 79e00014 ffe0003f W6,W11,W16
fcule.d 79e0001a ffe0003f W6,W11,W16
fexp2.d 79e0001b ffe0003f W6,W11,W16
mini_s.b 7a000006 ffe0003f W6,W11,u16.5
clei_s.b 7a000007 ffe0003f W6,W11,u16.5
bset.b 7a00000d ffe0003f W6,W11,W16
min_s.b 7a00000e ffe0003f W6,W11,W16
cle_s.b 7a00000f ffe0003f W6,W11,W16
ave_s.b 7a000010 ffe0003f W6,W11,W16
asub_s.b 7a000011 ffe0003f W6,W11,W16
div_s.b 7a000012 ffe0003f W6,W11,W16
ilvl.b 7a000014 ffe0003f W6,W11,W16
fsaf.w 7a00001a ffe0003f W6,W11,W16
fexdo.h 7a00001b ffe0003f W6,W11,W16
mini_s.h 7a200006 ffe0003f W6,W11,u16.5
clei_s.h 7a200007 ffe0003f W6,W11,u16.5
bset.h 7a20000d ffe0003f W6,W11,W16
min_s.h 7a20000e ffe0003f W6,W11,W16
cle_s.h 7a20000f ffe0003f W6,W11,W16
ave_s.h 7a200010 ffe0003f W6,W11,W16
asub_s.h 7a200011 ffe0003f W6,W11,W16
div_s.h 7a200012 ffe0003f W6,W11,W16
dpsub_s.h 7a200013 ffe0003f W6,W11,W16
ilvl.h 7a200014 ffe0003f W6,W11,W16
hadd_s.h 7a200015 ffe0003f W6,W11,W16
fsaf.d 7a20001a ffe0003f W6,W11,W16
fexdo.w 7a20001b ffe0003f W6,W11,W16
mini_s.w 7a400006 ffe0003f W6,W11,u16.5
clei_s.w 7a400007 ffe0003f W6,W11,u16.5
bseti.w 7a400009 ffe0003f W6,W11,u16.5
bset.w 7a40000d ffe0003f W6,W11,W16
min_s.w 7a40000e ffe0003f W6,W11,W16
cle_s.w 7a40000f ffe0003f W6,W11,W16
ave_s.w 7a400010 ffe0003f W6,W11,W16
asub_s.w 7a400011 ffe0003f W6,W11,W16
div_s.w 7a400012 ffe0003f W6,W11,W16
dpsub_s.w 7a400013 ffe0003f W6,W11,W16
ilvl.w 7a400014 ffe0003f W6,W11,W16
hadd_s.w 7a400015 ffe0003f W6,W11,W16
fsun.w 7a40001a ffe0003f W6,W11,W16
fsor.w 7a40001c ffe0003f W6,W11,W16
mini_s.d 7a600006 ffe0003f W6,W11,u16.5
clei_s.d 7a600007 ffe0003f W6,W11,u16.5
bset.d 7a60000d ffe0003f W6,W11,W16
min_s.d 7a60000e ffe0003f W6,W11,W16
cle_s.d 7a60000f ffe0003f W6,W11,W16
ave_s.d 7a600010 ffe0003f W6,W11,W16
asub_s.d 7a600011 ffe0003f W6,W11,W16
div_s.d 7a600012 ffe0003f W6,W11,W16
dpsub_s.d 7a600013 ffe0003f W6,W11,W16
ilvl.d 7a600014 ffe0003f W6,W11,W16
hadd_s.d 7a600015 ffe0003f W6,W11,W16
fsun.d 7a60001a ffe0003f W6,W11,W16
fsor.d 7a60001c ffe0003f W6,W11,W16
mini_u.b 7a800006 ffe0003f W6,W11,u16.5
clei_u.b 7a800007 ffe0003f W6,W11,u16.5
bneg.b 7a80000d ffe0003f W6,W11,W16
min_u.b 7a80000e ffe0003f W6,W11,W16
cle_u.b 7a80000f ffe0003f W6,W11,W16
ave_u.b 7a800010 ffe0003f W6,W11,W16
asub_u.b 7a800011 ffe0003f W6,W11,W16
div_u.b 7a800012 ffe0003f W6,W11,W16
ilvr.b 7a800014 ffe0003f W6,W11,W16
fseq.w 7a80001a ffe0003f W6,W11,W16
ftq.h 7a80001b ffe0003f W6,W11,W16
fsune.w 7a80001c ffe0003f W6,W11,W16
mini_u.h 7aa00006 ffe0003f W6,W11,u16.5
clei_u.h 7aa00007 ffe0003f W6,W11,u16.5
bneg.h 7aa0000d ffe0003f W6,W11,W16
min_u.h 7aa0000e ffe0003f W6,W11,W16
cle_u.h 7aa0000f ffe0003f W6,W11,W16
ave_u.h 7aa00010 ffe0003f W6,W11,W16
asub_u.h 7aa00011 ffe0003f W6,W11,W16
div_u.h 7aa00012 ffe0003f W6,W11,W16
dpsub_u.h 7aa00013 ffe0003f W6,W11,W16
ilvr.h 7aa00014 ffe0003f W6,W11,W16
hadd_u.h 7aa00015 ffe0003f W6,W11,W16
fseq.d 7aa0001a ffe0003f W6,W11,W16
ftq.w 7aa0001b ffe0003f W6,W11,W16
fsune.d 7aa0001c ffe0003f W6,W11,W16
mini_u.w 7ac00006 ffe0003f W6,W11,u16.5
clei_u.w 7ac00007 ffe0003f W6,W11,u16.5
bnegi.w 7ac00009 ffe0003f W6,W11,u16.5
bneg.w 7ac0000d ffe0003f W6,W11,W16
min_u.w 7ac0000e ffe0003f W6,W11,W16
cle_u.w 7ac0000f ffe0003f W6,W11,W16
ave_u.w 7ac00010 ffe0003f W6,W11,W16
asub_u.w 7ac00011 ffe0003f W6,W11,W16
div_u.w 7ac00012 ffe0003f W6,W11,W16
dpsub_u.w 7ac00013 ffe0003f W6,W11,W16
ilvr.w 7ac00014 ffe0003f W6,W11,W16
hadd_u.w 7ac00015 ffe0003f W6,W11,W16
fsueq.w 7ac0001a ffe0003f W6,W11,W16
fsne.w 7ac0001c ffe0003f W6,W11,W16
mini_u.d 7ae00006 ffe0003f W6,W11,u16.5
clei_u.d 7ae00007 ffe0003f W6,W11,u16.5
bneg.d 7ae0000d ffe0003f W6,W11,W16
min_u.d 7ae0000e ffe0003f W6,W11,W16
cle_u.d 7ae0000f ffe0003f W6,W11,W16
ave_u.d 7ae00010 ffe0003f W6,W11,W16
asub_u.d 7ae00011 ffe0003f W6,W11,W16
div_u.d 7ae00012 ffe0003f W6,W11,W16
dpsub_u.d 7ae00013 ffe0003f W6,W11,W16
ilvr.d 7ae00014 ffe0003f W6,W11,W16
hadd_u.d 7ae00015 ffe0003f W6,W11,W16
fsueq.d 7ae0001a ffe0003f W6,W11,W16
fsne.d 7ae0001c ffe0003f W6,W11,W16
ldi.b 7b000007 ffe0003f W6,u11.10
binsl.b 7b00000d ffe0003f W6,W11,W16
max_a.b 7b00000e ffe0003f W6,W11,W16
aver_s.b 7b000010 ffe0003f W6,W11,W16
mod_s.b 7b000012 ffe0003f W6,W11,W16
ilvev.b 7b000014 ffe0003f W6,W11,W16
fslt.w 7b00001a ffe0003f W6,W11,W16
fmin.w 7b00001b ffe0003f W6,W11,W16
mulr_q.h 7b00001c ffe0003f W6,W11,W16
ldi.h 7b200007 ffe0003f W6,u11.10
binsl.h 7b20000d ffe0003f W6,W11,W16
max_a.h 7b20000e ffe0003f W6,W11,W16
aver_s.h 7b200010 ffe0003f W6,W11,W16
mod_s.h 7b200012 ffe0003f W6,W11,W16
ilvev.h 7b200014 ffe0003f W6,W11,W16
hsub_s.h 7b200015 ffe0003f W6,W11,W16
fslt.d 7b20001a ffe0003f W6,W11,W16
fmin.d 7b20001b ffe0003f W6,W11,W16
mulr_q.w 7b20001c ffe0003f W6,W11,W16
ldi.w 7b400007 ffe0003f W6,u11.10
binsli.w 7b400009 ffe0003f W6,W11,u16.5
binsl.w 7b40000d ffe0003f W6,W11,W16
max_a.w 7b40000e ffe0003f W6,W11,W16
aver_s.w 7b400010 ffe0003f W6,W11,W16
mod_s.w 7b400012 ffe0003f W6,W11,W16
ilvev.w 7b400014 ffe0003f W6,W11,W16
hsub_s.w 7b400015 ffe0003f W6,W11,W16
fsult.w 7b40001a ffe0003f W6,W11,W16
fmin_a.w 7b40001b ffe0003f W6,W11,W16
maddr_q.h 7b40001c ffe0003f W6,W11,W16
ldi.d 7b600007 ffe0003f W6,u11.10
binsl.d 7b60000d ffe0003f W6,W11,W16
max_a.d 7b60000e ffe0003f W6,W11,W16
aver_s.d 7b600010 ffe0003f W6,W11,W16
mod_s.d 7b600012 ffe0003f W6,W11,W16
ilvev.d 7b600014 ffe0003f W6,W11,W16
hsub_s.d 7b600015 ffe0003f W6,W11,W16
fsult.d 7b60001a ffe0003f W6,W11,W16
fmin_a.d 7b60001b ffe0003f W6,W11,W16
maddr_q.w 7b60001c ffe0003f W6,W11,W16
binsr.b 7b80000d ffe0003f W6,W11,W16
min_a.b 7b80000e ffe0003f W6,W11,W16
aver_u.b 7b800010 ffe0003f W6,W11,W16
mod_u.b 7b800012 ffe0003f W6,W11,W16
ilvod.b 7b800014 ffe0003f W6,W11,W16
fsle.w 7b80001a ffe0003f W6,W11,W16
fmax.w 7b80001b ffe0003f W6,W11,W16
msubr_q.h 7b80001c ffe0003f W6,W11,W16
binsr.h 7ba0000d ffe0003f W6,W11,W16
min_a.h 7ba0000e ffe0003f W6,W11,W16
aver_u.h 7ba00010 ffe0003f W6,W11,W16
mod_u.h 7ba00012 ffe0003f W6,W11,W16
ilvod.h 7ba00014 ffe0003f W6,W11,W16
hsub_u.h 7ba00015 ffe0003f W6,W11,W16
fsle.d 7ba0001a ffe0003f W6,W11,W16
fmax.d 7ba0001b ffe0003f W6,W11,W16
msubr_q.w 7ba0001c ffe0003f W6,W11,W16
binsri.w 7bc00009 ffe0003f W6,W11,u16.5
binsr.w 7bc0000d ffe0003f W6,W11,W16
min_a.w 7bc0000e ffe0003f W6,W11,W16
aver_u.w 7bc00010 ffe0003f W6,W11,W16
mod_u.w 7bc00012 ffe0003f W6,W11,W16
ilvod.w 7bc00014 ffe0003f W6,W11,W16
hsub_u.w 7bc00015 ffe0003f W6,W11,W16
fsule.w 7bc0001a ffe0003f W6,W11,W16
fmax_a.w 7bc0001b ffe0003f W6,W11,W16
binsr.d 7be0000d ffe0003f W6,W11,W16
min_a.d 7be0000e ffe0003f W6,W11,W16
aver_u.d 7be00010 ffe0003f W6,W11,W16
mod_u.d 7be00012 ffe0003f W6,W11,W16
ilvod.d 7be00014 ffe0003f W6,W11,W16
hsub_u.d 7be00015 ffe0003f W6,W11,W16
fsule.d 7be0001a ffe0003f W6,W11,W16
fmax_a.d 7be0001b ffe0003f W6,W11,W16
lwx 7c00000a fc0007ff G11,G16(G21)
addu.qb 7c000010 fc0007ff G11,G21,G16
shll.qb 7c000013 fc0007ff G11,G16,u21.5
adduh.qb 7c000018 fc0007ff G11,G21,G16
append 7c000031 fc0007ff G16,G21,u11.5
subu.qb 7c000050 fc0007ff G11,G21,G16
shrl.qb 7c000053 fc0007ff G11,G16,u21.5
subuh.qb 7c000058 fc0007ff G11,G21,G16
prepend 7c000071 fc0007ff G16,G21,u11.5
repl.qb 7c000092 fc0007ff G11,u16.10
shllv.qb 7c000093 fc0007ff G11,G16,G21
adduh_r.qb 7c000098 fc0007ff G11,G21,G16
pick.qb 7c0000d1 fc0007ff G11,G21,G16
shrlv.qb 7c0000d3 fc0007ff G11,G16,G21
subuh_r.qb 7c0000d8 fc0007ff G11,G21,G16
lhx 7c00010a fc0007ff G11,G16(G21)
addu_s.qb 7c000110 fc0007ff G11,G21,G16
cmpgu.eq.qb 7c000111 fc0007ff G11,G21,G16
shra.qb 7c000113 fc0007ff G11,G16,u21.5
subu_s.qb 7c000150 fc0007ff G11,G21,G16
cmpgu.lt.qb 7c000151 fc0007ff G11,G21,G16
shra_r.qb 7c000153 fc0007ff G11,G16,u21.5
lbux 7c00018a fc0007ff G11,G16(G21)
muleu_s.ph.qbl 7c000190 fc0007ff G11,G21,G16
cmpgu.le.qb 7c000191 fc0007ff G11,G21,G16
shrav.qb 7c000193 fc0007ff G11,G16,G21
muleu_s.ph.qbr 7c0001d0 fc0007ff G11,G21,G16
shrav_r.qb 7c0001d3 fc0007ff G11,G16,G21
addu.ph 7c000210 fc0007ff G11,G21,G16
shll.ph 7c000213 fc0007ff G11,G16,u21.5
addqh.ph 7c000218 fc0007ff G11,G21,G16
subu.ph 7c000250 fc0007ff G11,G21,G16
shra.ph 7c000253 fc0007ff G11,G16,u21.5
subqh.ph 7c000258 fc0007ff G11,G21,G16
addq.ph 7c000290 fc0007ff G11,G21,G16
repl.ph 7c000292 fc0007ff G11,u16.10
shllv.ph 7c000293 fc0007ff G11,G16,G21
addqh_r.ph 7c000298 fc0007ff G11,G21,G16
subq.ph 7c0002d0 fc0007ff G11,G21,G16
pick.ph 7c0002d1 fc0007ff G11,G21,G16
shrav.ph 7c0002d3 fc0007ff G11,G16,G21
subqh_r.ph 7c0002d8 fc0007ff G11,G21,G16
addu_s.ph 7c000310 fc0007ff G11,G21,G16
precrq.qb.ph 7c000311 fc0007ff G11,G21,G16
shll_s.ph 7c000313 fc0007ff G11,G16,u21.5
mul.ph 7c000318 fc0007ff G11,G21,G16
subu_s.ph 7c000350 fc0007ff G11,G21,G16
precr.qb.ph 7c000351 fc0007ff G11,G21,G16
shra_r.ph 7c000353 fc0007ff G11,G16,u21.5
addq_s.ph 7c000390 fc0007ff G11,G21,G16
packrl.ph 7c000391 fc0007ff G11,G21,G16
shllv_s.ph 7c000393 fc0007ff G11,G16,G21
mul_s.ph 7c000398 fc0007ff G11,G21,G16
subq_s.ph 7c0003d0 fc0007ff G11,G21,G16
precrqu_s.qb.ph 7c0003d1 fc0007ff G11,G21,G16
shrav_r.ph 7c0003d3 fc0007ff G11,G16,G21
addsc 7c000410 fc0007ff G11,G21,G16
addqh.w 7c000418 fc0007ff G11,G21,G16
balign 7c000431 fc0007ff G16,G21,u11.5
addwc 7c000450 fc0007ff G11,G21,G16
subqh.w 7c000458 fc0007ff G11,G21,G16
modsub 7c000490 fc0007ff G11,G21,G16
addqh_r.w 7c000498 fc0007ff G11,G21,G16
rddsp 7c0004b8 fc0007ff G11,u16.10
subqh_r.w 7c0004d8 fc0007ff G11,G21,G16
wrdsp 7c0004f8 fc0007ff G21,u11.10
precrq.ph.w 7c000511 fc0007ff G11,G21,G16
shll_s.w 7c000513 fc0007ff G11,G16,u21.5
precrq_rs.ph.w 7c000551 fc0007ff G11,G21,G16
shra_r.w 7c000553 fc0007ff G11,G16,u21.5
addq_s.w 7c000590 fc0007ff G11,G21,G16
shllv_s.w 7c000593 fc0007ff G11,G16,G21
mulq_s.w 7c000598 fc0007ff G11,G21,G16
subq_s.w 7c0005d0 fc0007ff G11,G21,G16
shrav_r.w 7c0005d3 fc0007ff G11,G16,G21
mulq_rs.w 7c0005d8 fc0007ff G11,G21,G16
cmpgdu.eq.qb 7c000611 fc0007ff G11,G21,G16
cmpgdu.lt.qb 7c000651 fc0007ff G11,G21,G16
shrl.ph 7c000653 fc0007ff G11,G16,u21.5
cmpgdu.le.qb 7c000691 fc0007ff G11,G21,G16
shrlv.ph 7c0006d3 fc0007ff G11,G16,G21
muleq_s.w.phl 7c000710 fc0007ff G11,G21,G16
muleq_s.w.phr 7c000750 fc0007ff G11,G21,G16
mulq_s.ph 7c000790 fc0007ff G11,G21,G16
precr_sra.ph.w 7c000791 fc0007ff G16,G21,u11.5
mulq_rs.ph 7c0007d0 fc0007ff G11,G21,G16
precr_sra_r.ph.w 7c0007d1 fc0007ff G16,G21,u11.5
bc0f 41000000 ffff0000 b0.16
bc0t 41010000 ffff0000 b0.16
bc0fl 41020000 ffff0000 b0.16
bc0tl 41030000 ffff0000 b0.16
bc2f 49000000 ffff0000 b0.16
bc2t 49010000 ffff0000 b0.16
bc2fl 49020000 ffff0000 b0.16
bc2tl 49030000 ffff0000 b0.16
bal 04110000 ffff0000 b0.16
bposge32 041c0000 ffff0000 b0.16
b 10000000 ffff0000 b0.16
bc1f 45000000 ffff0000 b0.16
bc1t 45010000 ffff0000 b0.16
bc1fl 45020000 ffff0000 b0.16
bc1tl 45030000 ffff0000 b0.16
madd.d 4c000021 fc21087f E6,E21,E11,E16 @32
msub.d 4c000029 fc21087f E6,E21,E11,E16 @32
nmadd.d 4c000031 fc21087f E6,E21,E11,E16 @32
nmsub.d 4c000039 fc21087f E6,E21,E11,E16 @32
slli.d 78000009 ffc0003f W6,W11,u16.6
sat_s.d 7800000a ffc0003f W6,W11,u16.6
srai.d 78800009 ffc0003f W6,W11,u16.6
sat_u.d 7880000a ffc0003f W6,W11,u16.6
srli.d 79000009 ffc0003f W6,W11,u16.6
srari.d 7900000a ffc0003f W6,W11,u16.6
bclri.d 79800009 ffc0003f W6,W11,u16.6
srlri.d 7980000a ffc0003f W6,W11,u16.6
bseti.d 7a000009 ffc0003f W6,W11,u16.6
bnegi.d 7a800009 ffc0003f W6,W11,u16.6
binsli.d 7b000009 ffc0003f W6,W11,u16.6
binsri.d 7b800009 ffc0003f W6,W11,u16.6
lsa 00000005 fc00073f G11,G21,G16,p6.2
dlsa 00000015 fc00073f G11,G21,G16,p6.2
andi.b 78000000 ff00003f W6,W11,u16.8
bmnzi.b 78000001 ff00003f W6,W11,u16.8
shf.b 78000002 ff00003f W6,W11,u16.8
ori.b 79000000 ff00003f W6,W11,u16.8
bmzi.b 79000001 ff00003f W6,W11,u16.8
shf.h 79000002 ff00003f W6,W11,u16.8
nori.b 7a000000 ff00003f W6,W11,u16.8
bseli.b 7a000001 ff00003f W6,W11,u16.8
shf.w 7a000002 ff00003f W6,W11,u16.8
xori.b 7b000000 ff00003f W6,W11,u16.8
bc0f 41000000 ffe30000 c18.3,b0.16
bc0t 41010000 ffe30000 c18.3,b0.16
bc0fl 41020000 ffe30000 c18.3,b0.16
bc0tl 41030000 ffe30000 c18.3,b0.16
bc2f 49000000 ffe30000 c18.3,b0.16
bc2t 49010000 ffe30000 c18.3,b0.16
bc2fl 49020000 ffe30000 c18.3,b0.16
bc2tl 49030000 ffe30000 c18.3,b0.16
bc1f 45000000 ffe30000 C18.3,b0.16
bc1t 45010000 ffe30000 C18.3,b0.16
bc1fl 45020000 ffe30000 C18.3,b0.16
bc1tl 45030000 ffe30000 C18.3,b0.16
ins 7c000004 fc00003f G16,G21,u6.5,z0
dins 7c000007 fc00003f G16,G21,u6.5,z0 @64
dinsm 7c000005 fc00003f G16,G21,u6.5,z32 @64
dinsu 7c000006 fc00003f G16,G21,y6.5,z0 @64
dextm 7c000001 fc00003f G16,G21,u6.5,x11.5 @64
dextu 7c000002 fc00003f G16,G21,y6.5,p11.5 @64
syscall 0000000c fc00003f u6.20
break 0000000d fc00003f u16.10,u6.10
sync 0000000f fc00003f u6.5 ~03fff800
tge 00000030 fc00003f G21,G16,u6.10
tgeu 00000031 fc00003f G21,G16,u6.10
tlt 00000032 fc00003f G21,G16,u6.10
tltu 00000033 fc00003f G21,G16,u6.10
teq 00000034 fc00003f G21,G16,u6.10
tne 00000036 fc00003f G21,G16,u6.10
madd.s 4c000020 fc00003f F6,F21,F11,F16
msub.s 4c000028 fc00003f F6,F21,F11,F16
nmadd.s 4c000030 fc00003f F6,F21,F11,F16
nmsub.s 4c000038 fc00003f F6,F21,F11,F16
seqi 7000002e fc00003f G16,G21,u6.10 @64
snei 7000002f fc00003f G16,G21,u6.10 @64
cins 70000032 fc00003f G16,G21,u6.5,u11.5 @64
cins32 70000033 fc00003f G16,G21,u6.5,u11.5 @64
exts 7000003a fc00003f G16,G21,u6.5,u11.5 @64
exts32 7000003b fc00003f G16,G21,u6.5,u11.5 @64
sdbbp 7000003f fc00003f u6.20
ld.b 78000020 fc00003f W6,s16.10(G11)
ld.h 78000021 fc00003f W6,s16.10<1(G11)
ld.w 78000022 fc00003f W6,s16.10<2(G11)
ld.d 78000023 fc00003f W6,s16.10<3(G11)
st.b 78000024 fc00003f W6,s16.10(G11)
st.h 78000025 fc00003f W6,s16.10<1(G11)
st.w 78000026 fc00003f W6,s16.10<2(G11)
st.d 78000027 fc00003f W6,s16.10<3(G11)
ext 7c000000 fc00003f G16,G21,u6.5,p11.5
dext 7c000003 fc00003f G16,G21,u6.5,p11.5 @64
bltz 04000000 fc1f0000 G21,b0.16
bgez 04010000 fc1f0000 G21,b0.16
bltzl 04020000 fc1f0000 G21,b0.16
bgezl 04030000 fc1f0000 G21,b0.16
tgei 04080000 fc1f0000 G21,u0.16
tgeiu 04090000 fc1f0000 G21,u0.16
tlti 040a0000 fc1f0000 G21,u0.16
tltiu 040b0000 fc1f0000 G21,u0.16
teqi 040c0000 fc1f0000 G21,u0.16
tnei 040e0000 fc1f0000 G21,u0.16
bltzal 04100000 fc1f0000 G21,b0.16
bgezal 04110000 fc1f0000 G21,b0.16
bltzall 04120000 fc1f0000 G21,b0.16
bgezall 04130000 fc1f0000 G21,b0.16
synci 041f0000 fc1f0000 s0.16(G21)
beqz 10000000 fc1f0000 G21,b0.16
bnez 14000000 fc1f0000 G21,b0.16
blez 18000000 fc1f0000 G21,b0.16
bgtz 1c000000 fc1f0000 G21,b0.16
lui 3c000000 ffe00000 G16,u0.16
bz.v 45600000 ffe00000 W16,b0.16
bnz.v 45e00000 ffe00000 W16,b0.16
bz.b 47000000 ffe00000 W16,b0.16
bz.h 47200000 ffe00000 W16,b0.16
bz.w 47400000 ffe00000 W16,b0.16
bz.d 47600000 ffe00000 W16,b0.16
bnz.b 47800000 ffe00000 W16,b0.16
bnz.h 47a00000 ffe00000 W16,b0.16
bnz.w 47c00000 ffe00000 W16,b0.16
bnz.d 47e00000 ffe00000 W16,b0.16
blezl 58000000 fc1f0000 G21,b0.16
bgtzl 5c000000 fc1f0000 G21,b0.16
j 08000000 fc000000 j0.26
jal 0c000000 fc000000 j0.26
beq 10000000 fc000000 G21,G16,b0.16
bne 14000000 fc000000 G21,G16,b0.16
addi 20000000 fc000000 G16,G21,s0.16
addiu 24000000 fc000000 G16,G21,s0.16
slti 28000000 fc000000 G16,G21,s0.16
sltiu 2c000000 fc000000 G16,G21,s0.16
andi 30000000 fc000000 G16,G21,u0.16
ori 34000000 fc000000 G16,G21,u0.16
xori 38000000 fc000000 G16,G21,u0.16
beql 50000000 fc000000 G21,G16,b0.16
bnel 54000000 fc000000 G21,G16,b0.16
daddi 60000000 fc000000 G16,G21,s0.16 @64
daddiu 64000000 fc000000 G16,G21,s0.16 @64
ldl 68000000 fc000000 G16,s0.16(G21) @64
ldr 6c000000 fc000000 G16,s0.16(G21) @64
jalx 74000000 fc000000 j0.26
lb 80000000 fc000000 G16,s0.16(G21)
lh 84000000 fc000000 G16,s0.16(G21)
lwl 88000000 fc000000 G16,s0.16(G21)
lw 8c000000 fc000000 G16,s0.16(G21)
lbu 90000000 fc000000 G16,s0.16(G21)
lhu 94000000 fc000000 G16,s0.16(G21)
lwr 98000000 fc000000 G16,s0.16(G21)
lwu 9c000000 fc000000 G16,s0.16(G21) @64
sb a0000000 fc000000 G16,s0.16(G21)
sh a4000000 fc000000 G16,s0.16(G21)
swl a8000000 fc000000 G16,s0.16(G21)
sw ac000000 fc000000 G16,s0.16(G21)
sdl b0000000 fc000000 G16,s0.16(G21) @64
sdr b4000000 fc000000 G16,s0.16(G21) @64
swr b8000000 fc000000 G16,s0.16(G21)
cache bc000000 fc000000 u16.5,s0.16(G21)
ll c0000000 fc000000 G16,s0.16(G21)
lwc1 c4000000 fc000000 F16,s0.16(G21)
bbit0 c8000000 fc000000 G21,u16.5,b0.16 @64
lwc2 c8000000 fc000000 N16,s0.16(G21) @32
pref cc000000 fc000000 u16.5,s0.16(G21)
lld d0000000 fc000000 G16,s0.16(G21) @64
ldc1 d4000000 fc000000 F16,s0.16(G21)
bbit032 d8000000 fc000000 G21,u16.5,b0.16 @64
ldc2 d8000000 fc000000 N16,s0.16(G21) @32
ld dc000000 fc000000 G16,s0.16(G21) @64
sc e0000000 fc000000 G16,s0.16(G21)
swc1 e4000000 fc000000 F16,s0.16(G21)
bbit1 e8000000 fc000000 G21,u16.5,b0.16 @64
swc2 e8000000 fc000000 N16,s0.16(G21) @32
scd f0000000 fc000000 G16,s0.16(G21) @64
sdc1 f4000000 fc000000 F16,s0.16(G21)
bbit132 f8000000 fc000000 G21,u16.5,b0.16 @64
sdc2 f8000000 fc000000 N16,s0.16(G21) @32
sd fc000000 fc000000 G16,s0.16(G21) @64
`;
    const NAMED = new Map(), BY_OPCODE = Array.from({ length: 64 }, () => []);
    for (const line of TABLE.trim().split("\n")) {
        const [name, match, mask, ...rest] = line.split(" ");
        const row = { name, match: parseInt(match, 16), mask: parseInt(mask, 16), operands: [], xlen: 0 };
        for (const field of rest) {
            if (field[0] === "@") row.xlen = Number(field.slice(1));
            else if (field[0] !== "~") row.operands = field.split(",");
        }
        if (!NAMED.has(name)) NAMED.set(name, []);
        NAMED.get(name).push(row);
        BY_OPCODE[row.match >>> 26].push(row);
    }
    const made = (row) => (row.made ??= row.operands.map(operand));

    const modeOf = (mode) => ({ xlen: mode.startsWith("mips64") ? 64 : 32, little: mode.endsWith("-le") });
    const wordAt = (bytes, i, little) => (little ? bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)
        : (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
    const bytesOf = (word, little) => (little ? [0, 8, 16, 24] : [24, 16, 8, 0]).map((shift) => (word >>> shift) & 255);
    // A word as a line, {text, targets}; "(bad)" for one that's none.
    function lineOf(word, address, xlen) {
        for (const row of BY_OPCODE[word >>> 26]) {
            if (((word & row.mask) >>> 0) !== row.match || (row.xlen && row.xlen !== xlen)) continue;
            const kinds = made(row), values = kinds.map((k) => k.get(word));
            if (values.includes(null)) continue;
            const context = { address, targets: [] };
            const text = kinds.map((k, i) => k.show(values[i], context)).join(", ");
            return { text: text ? `${row.name} ${text}` : row.name, targets: context.targets };
        }
        return { text: "(bad)", targets: [] };
    }
    // Each four bytes an instruction; fewer at the end aren't one, and stay.
    function disassemble(bytes, address, mode, max) {
        const { xlen, little } = modeOf(mode), lines = [];
        for (let i = 0; i < bytes.length && lines.length < max; i += 4) {
            const length = Math.min(4, bytes.length - i);
            const line = length < 4 ? { text: "(bad)", targets: [] } : lineOf(wordAt(bytes, i, little), address + i, xlen);
            lines.push({ offset: address + i, length, text: line.text, targets: line.targets });
        }
        return { lines };
    }

    // The line's four bytes at address, and how it's then shown: {bytes,
    // text}. It throws what's wrong with a line that isn't an instruction
    // here (see assembleLine, in asm-common.js). was, the bytes there now:
    // kept, if they're shown as the line is (a word can have bits that
    // aren't shown).
    function assemble(text, address, mode, was) {
        const { xlen, little } = modeOf(mode);
        return assembleLine(text, {
            named: NAMED, xlen, family: "MIPS", kinds: made, context: () => ({ address, targets: [] }),
            put: (kind, values, word) => (values.some(Number.isNaN) ? null : kind.put(values, word)),
            done(row, word) {
                const line = lineOf(word, address, xlen);
                if (line.text === "(bad)") return null;
                const there = was?.length === 4 && lineOf(wordAt(was, 0, little), address, xlen).text === line.text;
                return { bytes: there ? Array.from(was) : bytesOf(word, little), text: line.text };
            },
        });
    }

    root.mips = { disassemble, assemble, parseLine };
})(typeof self !== "undefined" ? self : globalThis);
