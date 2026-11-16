// RISC-V for the hex view's disassembly: reads code (RV32 and RV64, with
// the M, A, F, D and C extensions) as lines, and assembles a line, as it's
// shown, into its bytes, to edit code in place. Both go by one table: an
// instruction is a name, the bits that make it that, and what its operands
// are; so a line that's shown can be typed back, and gives the same bytes.
//
// A classic script, with nothing to load: in the worker (disasm-worker.js),
// self.riscv is {disassemble(bytes, address, xlen, max), assemble(text,
// address, xlen, was)}. Addresses are what the disassembly shows (file
// offsets): where a branch goes is written as the address, not how far.
// Compressed instructions have their own names (c.addi), so a line says
// which it is, of two bytes or four. What's shown is as Capstone, which
// showed it before, wrote it; scripts/disasm/check-riscv.mjs holds it to
// that, and lists where it isn't.
"use strict";
(function (root) {
    const X = "zero ra sp gp tp t0 t1 t2 s0 s1 a0 a1 a2 a3 a4 a5 a6 a7 s2 s3 s4 s5 s6 s7 s8 s9 s10 s11 t3 t4 t5 t6".split(" ");
    const F = "ft0 ft1 ft2 ft3 ft4 ft5 ft6 ft7 fs0 fs1 fa0 fa1 fa2 fa3 fa4 fa5 fa6 fa7 fs2 fs3 fs4 fs5 fs6 fs7 fs8 fs9 fs10 fs11 ft8 ft9 ft10 ft11".split(" ");
    const ROUNDING = ["rne", "rtz", "rdn", "rup", "rmm", null, null, "dyn"];

    // Control and status registers, by number.
    const CSR = new Map([
        [0x000, "ustatus"], [0x004, "uie"], [0x005, "utvec"], [0x040, "uscratch"], [0x041, "uepc"], [0x042, "ucause"], [0x043, "utval"], [0x044, "uip"],
        [0x001, "fflags"], [0x002, "frm"], [0x003, "fcsr"], [0xc00, "cycle"], [0xc01, "time"], [0xc02, "instret"], [0xc80, "cycleh"], [0xc81, "timeh"], [0xc82, "instreth"],
        [0x100, "sstatus"], [0x102, "sedeleg"], [0x103, "sideleg"], [0x104, "sie"], [0x105, "stvec"], [0x106, "scounteren"],
        [0x140, "sscratch"], [0x141, "sepc"], [0x142, "scause"], [0x143, "stval"], [0x144, "sip"], [0x180, "satp"],
        [0xf11, "mvendorid"], [0xf12, "marchid"], [0xf13, "mimpid"], [0xf14, "mhartid"],
        [0x300, "mstatus"], [0x301, "misa"], [0x302, "medeleg"], [0x303, "mideleg"], [0x304, "mie"], [0x305, "mtvec"], [0x306, "mcounteren"],
        [0x340, "mscratch"], [0x341, "mepc"], [0x342, "mcause"], [0x343, "mtval"], [0x344, "mip"],
        [0xb00, "mcycle"], [0xb02, "minstret"], [0xb80, "mcycleh"], [0xb82, "minstreth"],
        [0x7a0, "tselect"], [0x7a1, "tdata1"], [0x7a2, "tdata2"], [0x7a3, "tdata3"], [0x7b0, "dcsr"], [0x7b1, "dpc"], [0x7b2, "dscratch"],
    ]);
    for (let i = 0; i < 4; i++) CSR.set(0x3a0 + i, `pmpcfg${i}`);
    for (let i = 0; i < 16; i++) CSR.set(0x3b0 + i, `pmpaddr${i}`);
    for (let i = 3; i < 32; i++) {
        CSR.set(0xc00 + i, `hpmcounter${i}`).set(0xc80 + i, `hpmcounter${i}h`);
        CSR.set(0xb00 + i, `mhpmcounter${i}`).set(0xb80 + i, `mhpmcounter${i}h`).set(0x320 + i, `mhpmevent${i}`);
    }
    const CSR_NUMBER = new Map([...CSR].map(([number, name]) => [name, number]));

    // A number as it's shown: in hex from ten; and read: hex or not, BigInt.
    const shown = (v) => (v < 0 ? "-" : "") + (Math.abs(v) > 9 ? `0x${Math.abs(v).toString(16)}` : `${Math.abs(v)}`);
    function number(text) {
        const m = /^([+-]?)(0x[0-9a-f]+|\d+)$/.exec(text);
        return m ? (m[1] === "-" ? -BigInt(m[2]) : BigInt(m[2])) : null;
    }
    const small = (text) => {
        const v = number(text);
        return v != null && v >= -(2n ** 53n) && v <= 2n ** 53n ? Number(v) : null;
    };

    // What an operand is: get, its value in a word (null: no such); put, the
    // bits a value is in it (null: it can't be that); show, as it's written;
    // read, the value written (null: not one). c is {address, xlen, targets}.
    const field = (low, width, { add = 0, names = null, also = null } = {}) => ({
        get: (w) => {
            const v = ((w >>> low) & ((1 << width) - 1)) + add;
            return names && names[v] == null ? null : v;
        },
        put: (v) => (v >= add && v < add + (1 << width) && (!names || names[v] != null) ? ((v - add) << low) >>> 0 : null),
        show: (v) => (names ? names[v] : shown(v)),
        read: (text) => {
            if (!names) return small(text);
            const at = names.indexOf(text);
            return at >= 0 ? at : also?.(text) ?? null;
        },
    });
    const numbered = (letter, other = {}) => (text) => {
        const m = new RegExp(`^${letter}(\\d|[12]\\d|3[01])$`).exec(text);
        return m ? Number(m[1]) : other[text] ?? null;
    };
    const gpr = (low, width = 5, add = 0) => field(low, width, { add, names: X, also: numbered("x", { fp: 8 }) });
    const fpr = (low, width = 5, add = 0) => field(low, width, { add, names: F, also: numbered("f") });
    // An immediate in pieces, each [where in the word, how many bits, where
    // in the value]; of so many bits in all, signed or not; a multiple of
    // what its lowest piece is.
    const immediate = (pieces, bits, signed) => {
        const low = Math.min(...pieces.map((p) => p[2]));
        return {
            get: (w) => {
                let v = 0;
                for (const [at, width, to] of pieces) v |= ((w >>> at) & ((1 << width) - 1)) << to;
                return signed ? (v << (32 - bits)) >> (32 - bits) : v;
            },
            put: (v) => {
                if (!Number.isInteger(v) || v % (1 << low) || v < (signed ? -(2 ** (bits - 1)) : 0) || v >= 2 ** (signed ? bits - 1 : bits)) return null;
                let w = 0;
                for (const [at, width, to] of pieces) w |= ((v >> to) & ((1 << width) - 1)) << at;
                return w >>> 0;
            },
            show: shown,
            read: small,
        };
    };
    // Where a branch goes: in the word, how far; written, the address,
    // which is a link if it's one a file can have. One before the start is
    // written as it wraps to in 64 bits, and is none.
    const target = (pieces, bits) => {
        const offset = immediate(pieces, bits, true);
        return {
            ...offset,
            show: (v, c) => {
                const to = BigInt(c.address) + BigInt(v);
                if (to >= 0n && to <= BigInt(Number.MAX_SAFE_INTEGER)) c.targets.push(Number(to));
                return `0x${BigInt.asUintN(64, to).toString(16)}`;
            },
            read: (text, c) => {
                const to = number(text);
                if (to == null || to < -(2n ** 63n) || to >= 2n ** 64n) return null;
                const far = BigInt.asIntN(64, to - BigInt(c.address));
                return far >= -(2n ** 31n) && far < 2n ** 31n ? Number(far) : NaN;
            },
        };
    };
    const csr = {
        ...field(20, 12),
        show: (v) => CSR.get(v) ?? shown(v),
        read: (text) => CSR_NUMBER.get(text) ?? small(text),
    };
    // fence's: which of input, output, reads and writes.
    const fenceSet = (low) => ({
        ...field(low, 4),
        show: (v) => [..."iorw"].filter((_, i) => v & (8 >> i)).join("") || "unknown",
        read: (text) => (text === "unknown" ? 0 : /^i?o?r?w?$/.test(text) && text ? [..."iorw"].reduce((v, c, i) => v | (text.includes(c) ? 8 >> i : 0), 0) : null),
    });
    // Two registers that are to be the same one (fmv.s is fsgnj.s of one).
    const both = (a, b) => ({
        get: (w) => (a.get(w) === b.get(w) ? a.get(w) : null),
        put: (v) => (a.put(v) == null ? null : (a.put(v) | b.put(v)) >>> 0),
        show: a.show,
        read: a.read,
    });
    const KINDS = {
        d: gpr(7), s: gpr(15), t: gpr(20), D: fpr(7), S: fpr(15), T: fpr(20), R: fpr(27), B: both(fpr(15), fpr(20)),
        i: immediate([[20, 12, 0]], 12, true), si: immediate([[7, 5, 0], [25, 7, 5]], 12, true),
        u: immediate([[12, 20, 0]], 20, false), sh5: field(20, 5), sh6: field(20, 6), z: field(15, 5),
        b: target([[8, 4, 1], [25, 6, 5], [7, 1, 11], [31, 1, 12]], 13), j: target([[21, 10, 1], [20, 1, 11], [12, 8, 12], [31, 1, 20]], 21),
        c: csr, rm: field(12, 3, { names: ROUNDING }), fp: fenceSet(24), fs: fenceSet(20),
        // Compressed: a register in full, or one of s0 to a5 in three bits.
        cd: gpr(7), ct: gpr(2), cD: fpr(7), cT: fpr(2), "d'": gpr(2, 3, 8), "s'": gpr(7, 3, 8), "D'": fpr(2, 3, 8), "T'": fpr(2, 3, 8),
        sp: { get: () => 2, put: (v) => (v === 2 ? 0 : null), show: () => "sp", read: (text) => (text === "sp" || text === "x2" ? 2 : null) },
        ci: immediate([[2, 5, 0], [12, 1, 5]], 6, true), csh: immediate([[2, 5, 0], [12, 1, 5]], 6, false),
        c4: immediate([[11, 2, 4], [7, 4, 6], [6, 1, 2], [5, 1, 3]], 10, false), c16: immediate([[6, 1, 4], [5, 1, 6], [3, 2, 7], [2, 1, 5], [12, 1, 9]], 10, true),
        cw: immediate([[10, 3, 3], [6, 1, 2], [5, 1, 6]], 7, false), cq: immediate([[10, 3, 3], [5, 2, 6]], 8, false),
        cwsp: immediate([[4, 3, 2], [12, 1, 5], [2, 2, 6]], 8, false), cqsp: immediate([[5, 2, 3], [12, 1, 5], [2, 3, 6]], 9, false),
        cwss: immediate([[9, 4, 2], [7, 2, 6]], 8, false), cqss: immediate([[10, 3, 3], [7, 3, 6]], 9, false),
        cj: target([[3, 3, 1], [11, 1, 4], [2, 1, 5], [7, 1, 6], [6, 1, 7], [9, 2, 8], [8, 1, 10], [12, 1, 11]], 12),
        cb: target([[3, 2, 1], [10, 2, 3], [2, 1, 5], [5, 2, 6], [12, 1, 8]], 9),
        // c.lui's: of 20 bits, as lui's is, the 6 it has carried up through them.
        clui: {
            get: (w) => (((w >>> 2) & 31) | (w & 0x1000 ? 0xfffe0 : 0)),
            put: (v) => (Number.isInteger(v) && (v >>> 0 < 32 || (v >= 0xfffe0 && v <= 0xfffff)) ? (((v & 31) << 2) | (v & 32 ? 0x1000 : 0)) >>> 0 : null),
            show: shown,
            read: small,
        },
    };

    // An operand as a row has it: a kind; with !n, a value it isn't to be;
    // k(r), a number and the register it's from, or (r), a register alone.
    function operand(spec) {
        const memory = /^([^(]*)\((.+)\)$/.exec(spec);
        if (memory) {
            const [far, base] = [memory[1] ? operand(memory[1]) : null, operand(memory[2])];
            return {
                get: (w) => {
                    const [a, b] = [far ? far.get(w) : 0, base.get(w)];
                    return a == null || b == null ? null : [a, b];
                },
                put: ([a, b]) => {
                    const [x, y] = [far ? far.put(a) : 0, base.put(b)];
                    return x == null || y == null ? null : (x | y) >>> 0;
                },
                show: ([a, b], c) => `${far ? far.show(a, c) : ""}(${base.show(b, c)})`,
                read: (text, c) => {
                    const m = /^([^()]*)\(([^()]+)\)$/.exec(text);
                    if (!m || (!far && m[1])) return null;
                    const [a, b] = [far ? far.read(m[1] || "0", c) : 0, base.read(m[2], c)];
                    return a == null || b == null ? null : [a, b];
                },
            };
        }
        const [name, ...never] = spec.split("!");
        const kind = KINDS[name];
        if (!kind) throw new Error(`no operand ${spec}`);
        if (!never.length) return kind;
        const not = never.map(Number);
        return {
            ...kind,
            get: (w) => {
                const v = kind.get(w);
                return not.includes(v) ? null : v;
            },
            put: (v) => (not.includes(v) ? null : kind.put(v)),
        };
    }

    // The instructions, the first that a word is being what it's shown as:
    // so another name for one (mv, for addi with nothing added) is before it.
    // xlen is 32 or 64, for one that only that has.
    const ROWS = [], NAMED = new Map(), LONG = new Map(), SHORT = new Map();
    function row(name, match, mask, operands = "", xlen = 0) {
        const short = (match & 3) !== 3;
        const r = { name, match: match >>> 0, mask: mask >>> 0, operands: operands ? operands.split(",").map(operand) : [], xlen, length: short ? 2 : 4 };
        ROWS.push(r);
        if (!NAMED.has(name)) NAMED.set(name, []);
        NAMED.get(name).push(r);
        const [table, key] = short ? [SHORT, (match & 3) | ((match >>> 13) << 2)] : [LONG, match & 0x7f];
        if (!table.has(key)) table.set(key, []);
        table.get(key).push(r);
    }
    const ALL = 0xffffffff, OP = 0xfe00707f, IMM = 0x707f, RD = 0xf80, RS1 = 0xf8000, RS2 = 0x1f00000;
    const op = (opcode, f3 = 0, f7 = 0) => ((f7 << 25) | (f3 << 12) | opcode) >>> 0;

    row("lui", 0x37, 0x7f, "d,u");
    row("auipc", 0x17, 0x7f, "d,u");
    row("j", 0x6f, 0xfff, "j");
    row("jal", 0xef, 0xfff, "j");
    row("jal", 0x6f, 0x7f, "d,j");
    row("ret", 0x8067, ALL);
    row("jr", 0x67, 0xfff07fff, "s");
    row("jalr", 0xe7, 0xfff07fff, "s");
    row("jalr", 0x67, IMM, "d,s,i");
    for (const [name, f3, zero] of [["beq", 0, "beqz"], ["bne", 1, "bnez"], ["blt", 4, "bltz", "bgtz"], ["bge", 5, "bgez", "blez"], ["bltu", 6], ["bgeu", 7]].map((r) => [r[0], r[1], r.slice(2)])) {
        // With zero: blez and bgtz have it first, and name the other.
        if (zero[1] && name === "bge") row(zero[1], op(0x63, f3), IMM | RS1, "t,b");
        if (zero[0]) row(zero[0], op(0x63, f3), IMM | RS2, "s,b");
        if (zero[1] && name === "blt") row(zero[1], op(0x63, f3), IMM | RS1, "t,b");
        row(name, op(0x63, f3), IMM, "s,t,b");
    }
    for (const [name, f3, xlen] of [["lb", 0], ["lh", 1], ["lw", 2], ["ld", 3, 64], ["lbu", 4], ["lhu", 5], ["lwu", 6, 64]]) row(name, op(0x03, f3), IMM, "d,i(s)", xlen);
    for (const [name, f3, xlen] of [["sb", 0], ["sh", 1], ["sw", 2], ["sd", 3, 64]]) row(name, op(0x23, f3), IMM, "t,si(s)", xlen);
    row("nop", 0x13, ALL);
    row("mv", 0x13, 0xfff0707f, "d,s");
    row("not", 0xfff04013, 0xfff0707f, "d,s");
    row("seqz", 0x00103013, 0xfff0707f, "d,s");
    for (const [name, f3] of [["addi", 0], ["slti", 2], ["sltiu", 3], ["xori", 4], ["ori", 6], ["andi", 7]]) row(name, op(0x13, f3), IMM, "d,s,i");
    for (const [name, f3, f7] of [["slli", 1, 0], ["srli", 5, 0], ["srai", 5, 0x20]]) {
        row(name, op(0x13, f3, f7), OP, "d,s,sh5", 32);
        row(name, op(0x13, f3, f7), 0xfc00707f, "d,s,sh6", 64);
        row(`${name}w`, op(0x1b, f3, f7), OP, "d,s,sh5", 64);
    }
    row("sext.w", 0x1b, 0xfff0707f, "d,s", 64);
    row("addiw", 0x1b, IMM, "d,s,i", 64);
    row("neg", op(0x33, 0, 0x20), OP | RS1, "d,t");
    row("negw", op(0x3b, 0, 0x20), OP | RS1, "d,t", 64);
    row("sltz", op(0x33, 2), OP | RS2, "d,s");
    row("sgtz", op(0x33, 2), OP | RS1, "d,t");
    row("snez", op(0x33, 3), OP | RS1, "d,t");
    for (const [name, f3, f7] of [["add", 0, 0], ["sub", 0, 0x20], ["sll", 1, 0], ["slt", 2, 0], ["sltu", 3, 0], ["xor", 4, 0], ["srl", 5, 0], ["sra", 5, 0x20], ["or", 6, 0], ["and", 7, 0],
        ["mul", 0, 1], ["mulh", 1, 1], ["mulhsu", 2, 1], ["mulhu", 3, 1], ["div", 4, 1], ["divu", 5, 1], ["rem", 6, 1], ["remu", 7, 1]]) row(name, op(0x33, f3, f7), OP, "d,s,t");
    for (const [name, f3, f7] of [["addw", 0, 0], ["subw", 0, 0x20], ["sllw", 1, 0], ["srlw", 5, 0], ["sraw", 5, 0x20],
        ["mulw", 0, 1], ["divw", 4, 1], ["divuw", 5, 1], ["remw", 6, 1], ["remuw", 7, 1]]) row(name, op(0x3b, f3, f7), OP, "d,s,t", 64);
    row("fence.tso", 0x8330000f, ALL);
    row("fence", 0x0ff0000f, ALL);
    row("fence", 0x0f, 0xf00fffff, "fp,fs");
    row("fence.i", 0x100f, ALL);
    for (const [name, word] of [["ecall", 0x73], ["ebreak", 0x100073], ["uret", 0x200073], ["sret", 0x10200073], ["mret", 0x30200073], ["wfi", 0x10500073], ["unimp", 0xc0001073]]) row(name, word, ALL);
    row("sfence.vma", 0x12000073, ALL);
    row("sfence.vma", 0x12000073, 0xfff07fff, "s");
    row("sfence.vma", 0x12000073, 0xfe007fff, "s,t");
    // The floating-point state's, and the counters', by their own names.
    const csrIs = (number) => (number << 20) >>> 0;
    for (const [name, number] of [["frcsr", 3], ["frrm", 2], ["frflags", 1], ["rdinstret", 0xc02], ["rdcycle", 0xc00], ["rdtime", 0xc01], ["rdinstreth", 0xc82], ["rdcycleh", 0xc80], ["rdtimeh", 0xc81]])
        row(name, op(0x73, 2) | csrIs(number), 0xfffff07f, "d");
    for (const [name, number] of [["fscsr", 3], ["fsrm", 2], ["fsflags", 1]]) {
        row(name, op(0x73, 1) | csrIs(number), 0xfff07fff, "s");
        row(name, op(0x73, 1) | csrIs(number), 0xfff0707f, "d,s");
    }
    for (const [name, number] of [["fsrmi", 2], ["fsflagsi", 1]]) {
        row(name, op(0x73, 5) | csrIs(number), 0xfff07fff, "z");
        row(name, op(0x73, 5) | csrIs(number), 0xfff0707f, "d,z");
    }
    row("csrr", op(0x73, 2), IMM | RS1, "d,c");
    for (const [name, f3] of [["csrw", 1], ["csrs", 2], ["csrc", 3]]) row(name, op(0x73, f3), IMM | RD, "c,s");
    for (const [name, f3] of [["csrwi", 5], ["csrsi", 6], ["csrci", 7]]) row(name, op(0x73, f3), IMM | RD, "c,z");
    for (const [name, f3] of [["csrrw", 1], ["csrrs", 2], ["csrrc", 3]]) row(name, op(0x73, f3), IMM, "d,c,s");
    for (const [name, f3] of [["csrrwi", 5], ["csrrsi", 6], ["csrrci", 7]]) row(name, op(0x73, f3), IMM, "d,c,z");
    // Atomics: of a word or (RV64) a doubleword, acquiring and releasing.
    for (const [width, f3, xlen] of [["w", 2, 0], ["d", 3, 64]]) {
        for (const [order, bits] of [["", 0], [".aq", 2], [".rl", 1], [".aqrl", 3]]) {
            row(`lr.${width}${order}`, op(0x2f, f3, (2 << 2) | bits), OP | RS2, "d,(s)", xlen);
            row(`sc.${width}${order}`, op(0x2f, f3, (3 << 2) | bits), OP, "d,t,(s)", xlen);
            for (const [name, f5] of [["amoswap", 1], ["amoadd", 0], ["amoxor", 4], ["amoand", 12], ["amoor", 8], ["amomin", 16], ["amomax", 20], ["amominu", 24], ["amomaxu", 28]])
                row(`${name}.${width}${order}`, op(0x2f, f3, (f5 << 2) | bits), OP, "d,t,(s)", xlen);
        }
    }
    // Floating point, single (.s) and double (.d): rounded as the last
    // operand says, which isn't written when it's as frm has it (dyn).
    const DYN = 0x7000, rounded = (name, match, mask, operands, xlen) => {
        row(name, (match | DYN) >>> 0, (mask | DYN) >>> 0, operands, xlen);
        row(name, match, mask, `${operands},rm`, xlen);
    };
    row("flw", op(0x07, 2), IMM, "D,i(s)");
    row("fld", op(0x07, 3), IMM, "D,i(s)");
    row("fsw", op(0x27, 2), IMM, "T,si(s)");
    row("fsd", op(0x27, 3), IMM, "T,si(s)");
    for (const [precision, bit] of [["s", 0], ["d", 1]]) {
        for (const [name, opcode] of [["fmadd", 0x43], ["fmsub", 0x47], ["fnmsub", 0x4b], ["fnmadd", 0x4f]]) rounded(`${name}.${precision}`, op(opcode, 0, bit), 0x0600007f, "D,S,T,R");
        for (const [name, f7] of [["fadd", 0], ["fsub", 4], ["fmul", 8], ["fdiv", 12]]) rounded(`${name}.${precision}`, op(0x53, 0, f7 | bit), 0xfe00007f, "D,S,T");
        rounded(`fsqrt.${precision}`, op(0x53, 0, 0x2c | bit), 0xfff0007f, "D,S");
        for (const [name, f3] of [["fmv", 0], ["fneg", 1], ["fabs", 2]]) row(`${name}.${precision}`, op(0x53, f3, 0x10 | bit), OP, "D,B");
        for (const [name, f3] of [["fsgnj", 0], ["fsgnjn", 1], ["fsgnjx", 2]]) row(`${name}.${precision}`, op(0x53, f3, 0x10 | bit), OP, "D,S,T");
        for (const [name, f3] of [["fmin", 0], ["fmax", 1]]) row(`${name}.${precision}`, op(0x53, f3, 0x14 | bit), OP, "D,S,T");
        for (const [name, f3] of [["fle", 0], ["flt", 1], ["feq", 2]]) row(`${name}.${precision}`, op(0x53, f3, 0x50 | bit), OP, "d,S,T");
        row(`fclass.${precision}`, op(0x53, 1, 0x70 | bit), OP | RS2, "d,S");
        for (const [integer, rs2, xlen] of [["w", 0, 0], ["wu", 1, 0], ["l", 2, 64], ["lu", 3, 64]]) {
            rounded(`fcvt.${integer}.${precision}`, op(0x53, 0, 0x60 | bit) | (rs2 << 20), 0xfff0007f, "d,S", xlen);
            // To a double from 32 bits is exact: nothing to round.
            if (precision === "d" && rs2 < 2) row(`fcvt.d.${integer}`, op(0x53, 0, 0x69) | (rs2 << 20), OP | RS2, "D,s");
            else rounded(`fcvt.${precision}.${integer}`, op(0x53, 0, 0x68 | bit) | (rs2 << 20), 0xfff0007f, "D,s", xlen);
        }
    }
    rounded("fcvt.s.d", op(0x53, 0, 0x20) | (1 << 20), 0xfff0007f, "D,S");
    row("fcvt.d.s", op(0x53, 0, 0x21), OP | RS2, "D,S");
    row("fmv.x.w", op(0x53, 0, 0x70), OP | RS2, "d,S");
    row("fmv.w.x", op(0x53, 0, 0x78), OP | RS2, "D,s");
    row("fmv.x.d", op(0x53, 0, 0x71), OP | RS2, "d,S", 64);
    row("fmv.d.x", op(0x53, 0, 0x79), OP | RS2, "D,s", 64);

    // Compressed: two bytes, the low two bits not both set.
    const C = 0xe003, c = (quadrant, f3) => (f3 << 13) | quadrant;
    row("c.unimp", 0, 0xffff);
    row("c.addi4spn", c(0, 0), C, "d',sp,c4!0");
    row("c.fld", c(0, 1), C, "D',cq(s')");
    row("c.lw", c(0, 2), C, "d',cw(s')");
    row("c.flw", c(0, 3), C, "D',cw(s')", 32);
    row("c.ld", c(0, 3), C, "d',cq(s')", 64);
    row("c.fsd", c(0, 5), C, "T',cq(s')");
    row("c.sw", c(0, 6), C, "d',cw(s')");
    row("c.fsw", c(0, 7), C, "T',cw(s')", 32);
    row("c.sd", c(0, 7), C, "d',cq(s')", 64);
    // (With a number that isn't nothing, a hint: still c.nop, as Capstone had it.)
    row("c.nop", 1, C | RD | 0x1000);
    row("c.addi", c(1, 0), C, "cd!0,ci");
    row("c.jal", c(1, 1), C, "cj", 32);
    row("c.addiw", c(1, 1), C, "cd!0,ci", 64);
    row("c.li", c(1, 2), C, "cd!0,ci");
    row("c.addi16sp", c(1, 3) | (2 << 7), C | RD, "sp,c16!0");
    row("c.lui", c(1, 3), C, "cd!0!2,clui");
    // A shift's amount is under the register's width: in RV32, five bits.
    for (const [xlen, wide] of [[32, 0x1000], [64, 0]]) {
        row("c.srli", c(1, 4), C | 0xc00 | wide, "s',csh", xlen);
        row("c.srai", c(1, 4) | 0x400, C | 0xc00 | wide, "s',csh", xlen);
        row("c.slli", c(2, 0), C | wide, "cd!0,csh", xlen);
    }
    row("c.andi", c(1, 4) | 0x800, C | 0xc00, "s',ci");
    for (const [name, bits, xlen] of [["c.sub", 0], ["c.xor", 1], ["c.or", 2], ["c.and", 3], ["c.subw", 4, 64], ["c.addw", 5, 64]])
        row(name, c(1, 4) | 0xc00 | ((bits & 4) << 10) | ((bits & 3) << 5), 0xfc63, "s',d'", xlen);
    row("c.j", c(1, 5), C, "cj");
    row("c.beqz", c(1, 6), C, "s',cb");
    row("c.bnez", c(1, 7), C, "s',cb");
    row("c.fldsp", c(2, 1), C, "cD,cqsp(sp)");
    row("c.lwsp", c(2, 2), C, "cd!0,cwsp(sp)");
    row("c.flwsp", c(2, 3), C, "cD,cwsp(sp)", 32);
    row("c.ldsp", c(2, 3), C, "cd!0,cqsp(sp)", 64);
    row("c.jr", c(2, 4), 0xf07f, "cd!0");
    row("c.mv", c(2, 4), 0xf003, "cd!0,ct!0");
    row("c.ebreak", 0x9002, 0xffff);
    row("c.jalr", c(2, 4) | 0x1000, 0xf07f, "cd!0");
    row("c.add", c(2, 4) | 0x1000, 0xf003, "cd!0,ct!0");
    row("c.fsdsp", c(2, 5), C, "cT,cqss(sp)");
    row("c.swsp", c(2, 6), C, "ct,cwss(sp)");
    row("c.fswsp", c(2, 7), C, "cT,cwss(sp)", 32);
    row("c.sdsp", c(2, 7), C, "ct,cqss(sp)", 64);

    // The row a word is, with its operands' values; null if it's none.
    function rowOf(word, short, xlen) {
        const rows = short ? SHORT.get((word & 3) | ((word >>> 13) << 2)) : LONG.get(word & 0x7f);
        for (const r of rows ?? []) {
            if (((word & r.mask) >>> 0) !== r.match || (r.xlen && r.xlen !== xlen)) continue;
            const values = r.operands.map((o) => o.get(word));
            if (values.every((v) => v != null)) return { row: r, values };
        }
        return null;
    }
    // The instruction at `at` in bytes: {length, text, targets}; "(bad)", of
    // two bytes (or the one that's left), for what isn't one.
    function lineAt(bytes, at, address, xlen) {
        const left = bytes.length - at;
        if (left < 2) return { length: left, text: "(bad)", targets: [] };
        const half = bytes[at] | (bytes[at + 1] << 8), short = (half & 3) !== 3;
        if (!short && left < 4) return { length: 2, text: "(bad)", targets: [] };
        const word = short ? half : (half | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
        const found = rowOf(word, short, xlen);
        if (!found) return { length: 2, text: "(bad)", targets: [] };
        const context = { address, xlen, targets: [] };
        const operands = found.row.operands.map((o, i) => o.show(found.values[i], context));
        return { length: found.row.length, text: operands.length ? `${found.row.name} ${operands.join(", ")}` : found.row.name, targets: context.targets };
    }
    function disassemble(bytes, address, xlen, max) {
        const lines = [];
        for (let at = 0; at < bytes.length && lines.length < max;) {
            const line = lineAt(bytes, at, address + at, xlen);
            lines.push({ offset: address + at, length: line.length, text: line.text, targets: line.targets });
            at += line.length;
        }
        return { lines };
    }

    // A line as typed: its name, and its operands, at the commas outside
    // brackets; in small letters, without what's after ; # or //.
    function parseLine(text) {
        const line = text.toLowerCase().split(/[;#]|\/\//)[0].trim().replace(/\s+/g, " ");
        const space = line.indexOf(" ");
        const name = space < 0 ? line : line.slice(0, space), rest = space < 0 ? "" : line.slice(space + 1).replace(/ /g, "");
        const operands = [];
        let depth = 0, from = 0;
        for (let i = 0; i < rest.length; i++) {
            if (rest[i] === "(") depth++;
            else if (rest[i] === ")") depth--;
            else if (rest[i] === "," && depth === 0) {
                operands.push(rest.slice(from, i));
                from = i + 1;
            }
        }
        if (rest) operands.push(rest.slice(from));
        return { name, operands };
    }
    const bytesOf = (word, length) => Array.from({ length }, (_, i) => (word >>> (8 * i)) & 255);
    // The line's bytes at address, and how it's then shown: {bytes, text}.
    // It throws what's wrong with a line that isn't an instruction here
    // (what was typed in quotes where it's first, as the page gives what's
    // said a capital).
    // was, the bytes there now: kept, if they're shown as the line is.
    function assemble(text, address, xlen, was) {
        if (text.length > 200) throw new Error("That's too long to be an instruction.");
        const { name, operands } = parseLine(text);
        if (!name) throw new Error("There's no instruction there.");
        const rows = NAMED.get(name);
        if (!rows) throw new Error(`There's no instruction called ${name}.`);
        const here = rows.filter((r) => !r.xlen || r.xlen === xlen);
        if (!here.length) throw new Error(`"${name}" is only in RV${rows[0].xlen}.`);
        const counted = here.filter((r) => r.operands.length === operands.length);
        if (!counted.length) {
            const counts = [...new Set(here.map((r) => r.operands.length))].sort();
            throw new Error(`"${name}" takes ${counts.join(" or ")} operand${counts.length === 1 && counts[0] === 1 ? "" : "s"}, not ${operands.length}.`);
        }
        let why = null;
        for (const r of counted) {
            const context = { address, xlen, targets: [] };
            let word = r.match, wrong = null;
            for (let i = 0; i < operands.length && !wrong; i++) {
                const value = r.operands[i].read(operands[i], context);
                if (value == null) wrong = `${operands[i] ? `"${operands[i]}"` : "Nothing"} isn't what ${name} takes ${["first", "second", "third", "fourth", "fifth"][i]}.`;
                else {
                    const bits = Number.isNaN(value) ? null : r.operands[i].put(value);
                    if (bits == null) wrong = `"${operands[i]}" isn't one ${name} can have there.`;
                    else word = (word | bits) >>> 0;
                }
            }
            // As it's then read: the same instruction, by this name or another's.
            const line = wrong ? null : lineAt(bytesOf(word, r.length), 0, address, xlen);
            if (!wrong && (line.text === "(bad)" || line.length !== r.length)) wrong = "That isn't an instruction as it would be written.";
            if (wrong) {
                why ??= wrong;
                continue;
            }
            const there = was?.length === r.length ? lineAt(was, 0, address, xlen) : null;
            return { bytes: there && there.text === line.text ? Array.from(was) : bytesOf(word, r.length), text: line.text };
        }
        throw new Error(why);
    }

    root.riscv = { disassemble, assemble, parseLine };
})(typeof self !== "undefined" ? self : globalThis);
