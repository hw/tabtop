import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { programMap, readExecutable } from "../tabtopd/exe-info.js";

// A file's bytes, read as the hex view reads them; reads are counted.
const reading = (bytes) => {
    const read = async (begin, end) => { read.calls++; read.bytes += end - begin; return Uint8Array.from(bytes.subarray(begin, end)); };
    read.calls = read.bytes = 0;
    return read;
};
const parse = (bytes) => readExecutable(reading(bytes), bytes.length);

// A table of names, each ended by a 0: at(name) is where it is.
function names(...list) {
    const at = new Map([["", 0]]), parts = [0];
    for (const name of list) {
        at.set(name, parts.length);
        parts.push(...new TextEncoder().encode(name), 0);
    }
    return { bytes: Uint8Array.from(parts), at: (name) => at.get(name) };
}
// Numbers, written one after another: [value, bytes] each.
function packed(little, ...items) {
    const out = new Uint8Array(items.reduce((n, [, size]) => n + size, 0)), view = new DataView(out.buffer);
    let at = 0;
    for (const [value, size] of items) {
        if (size === 1) view.setUint8(at, value);
        else if (size === 2) view.setUint16(at, value, little);
        else if (size === 4) view.setUint32(at, value, little);
        else view.setBigUint64(at, BigInt(value), little);
        at += size;
    }
    return out;
}

// An ELF of these sections ({name, type, flags, address, data or size (of
// one with no bytes), link, entsize}), each after the last, then their
// names and their headers.
function elf({ wide = true, little = true, machine = 62, type = 2, entry = 0, sections }) {
    const word = wide ? 8 : 4, all = [{ name: "", type: 0 }, ...sections, { name: ".shstrtab", type: 3 }];
    const table = names(...all.map((s) => s.name).filter(Boolean));
    all.at(-1).data = table.bytes;
    let at = wide ? 64 : 52;
    for (const s of all.slice(1)) {
        s.offset = at;
        at += s.data?.length ?? 0;
    }
    // (same: the bytes of another, pointed at again.)
    for (const s of all) if (s.same) Object.assign(s, { offset: all.find((o) => o.name === s.same && o.data).offset, size: all.find((o) => o.name === s.same && o.data).data.length });
    const headers = all.map((s) => packed(little, ...(wide
        ? [[table.at(s.name), 4], [s.type, 4], [s.flags ?? 0, 8], [s.address ?? 0, 8], [s.offset ?? 0, 8], [s.data?.length ?? s.size ?? 0, 8], [s.link ?? 0, 4], [0, 4], [1, 8], [s.entsize ?? 0, 8]]
        : [[table.at(s.name), 4], [s.type, 4], [s.flags ?? 0, 4], [s.address ?? 0, 4], [s.offset ?? 0, 4], [s.data?.length ?? s.size ?? 0, 4], [s.link ?? 0, 4], [0, 4], [1, 4], [s.entsize ?? 0, 4]])));
    const head = packed(little, [0x7f, 1], [0x45, 1], [0x4c, 1], [0x46, 1], [wide ? 2 : 1, 1], [little ? 1 : 2, 1], [1, 1], [0, 1], [0, 8],
        [type, 2], [machine, 2], [1, 4], [entry, word], [0, word], [at, word], [0, 4], [wide ? 64 : 52, 2], [0, 2], [0, 2], [wide ? 64 : 40, 2], [all.length, 2], [all.length - 1, 2]);
    const out = new Uint8Array(at + headers.length * (wide ? 64 : 40));
    out.set(head);
    for (const s of all.slice(1)) if (s.data) out.set(s.data, s.offset);
    headers.forEach((h, i) => out.set(h, at + i * h.length));
    return out;
}
const symbol = (wide, little, name, info, section, value, size) => (wide
    ? packed(little, [name, 4], [info, 1], [0, 1], [section, 2], [value, 8], [size, 8]) : packed(little, [name, 4], [value, 4], [size, 4], [info, 1], [0, 1], [section, 2]));
const joined = (...parts) => Uint8Array.from(parts.flatMap((p) => [...p]));

// A small x86-64 program: code, a stub that jumps through a slot the loader
// fills with puts, data with no bytes in the file, and its symbols.
function program() {
    const strings = names("main", "helper", "counter", "$x", "t.c", "extern"), dynamic = names("puts");
    // endbr64; bnd jmp [rip+disp], to the slot at 0x403000 from 0x40110b; nop
    const stub = joined([0xf3, 0x0f, 0x1e, 0xfa, 0xf2, 0xff, 0x25], packed(true, [0x403000 - 0x40110b, 4]), [0x0f, 0x1f, 0x44, 0, 0]);
    return elf({ entry: 0x401000, sections: [
        { name: ".text", type: 1, flags: 6, address: 0x401000, data: new Uint8Array(32).fill(0x90) },
        { name: ".plt.sec", type: 1, flags: 6, address: 0x401100, data: stub, entsize: 16 },
        { name: ".got.plt", type: 1, flags: 3, address: 0x403000, data: new Uint8Array(8) },
        { name: ".bss", type: 8, flags: 3, address: 0x404000, size: 0x20 },
        { name: ".dynsym", type: 11, flags: 2, address: 0x400200, link: 6, entsize: 24, data: joined(symbol(true, true, 0, 0, 0, 0, 0), symbol(true, true, dynamic.at("puts"), 0x12, 0, 0, 0)) },
        { name: ".dynstr", type: 3, flags: 2, address: 0x400300, data: dynamic.bytes },
        { name: ".rela.plt", type: 4, flags: 2, address: 0x400400, link: 5, entsize: 24, data: packed(true, [0x403000, 8], [7, 4], [1, 4], [0, 8]) },
        { name: ".symtab", type: 2, link: 9, entsize: 24, data: joined(symbol(true, true, 0, 0, 0, 0, 0),
            symbol(true, true, strings.at("t.c"), 4, 0xfff1, 0, 0), symbol(true, true, 0, 3, 1, 0x401000, 0),
            symbol(true, true, strings.at("helper"), 0x02, 1, 0x401010, 8), symbol(true, true, strings.at("$x"), 0, 1, 0x401000, 0),
            symbol(true, true, strings.at("main"), 0x12, 1, 0x401000, 0x10), symbol(true, true, strings.at("counter"), 0x11, 4, 0x404000, 4),
            symbol(true, true, strings.at("extern"), 0x12, 0, 0, 0)) },
        { name: ".strtab", type: 3, data: strings.bytes },
    ] });
}

test("an ELF: its sections, where each is loaded, and its symbols, the stubs and slots of what it calls among them", async () => {
    const bytes = program(), info = await parse(bytes);
    assert.deepEqual({ ...info, sections: undefined, symbols: undefined }, { format: "ELF", bits: 64, little: true, machine: "x86-64", kind: "executable", mode: "x86-64",
        entry: 0x401000, relocatable: false, sections: undefined, symbols: undefined, truncated: false });
    const section = (name) => info.sections.find((s) => s.name === name);
    assert.deepEqual(section(".text"), { name: ".text", offset: 64, size: 32, address: 0x401000, memSize: 32, flags: "r-x" });
    assert.deepEqual(section(".got.plt"), { name: ".got.plt", offset: 64 + 32 + 16, size: 8, address: 0x403000, memSize: 8, flags: "rw-" });
    // No bytes in the file; not loaded.
    assert.deepEqual([section(".bss").size, section(".bss").memSize, section(".bss").address], [0, 0x20, 0x404000]);
    assert.equal(section(".symtab").address, null);
    assert.deepEqual(info.sections.map((s) => s.offset), info.sections.map((s) => s.offset).sort((a, b) => a - b));
    // Not another file's (extern), a section's, a source file's, or a mark ($x).
    assert.deepEqual(info.symbols, [
        { name: "main", address: 0x401000, size: 0x10, kind: "func" }, { name: "helper", address: 0x401010, size: 8, kind: "func" },
        { name: "puts@plt", address: 0x401100, size: 16, kind: "plt" }, { name: "puts@got", address: 0x403000, size: 8, kind: "got" },
        { name: "counter", address: 0x404000, size: 4, kind: "object" },
    ]);
    const map = programMap(info);
    assert.equal(map.addressOf(64), 0x401000);
    assert.equal(map.addressOf(64 + 31), 0x40101f);
    assert.equal(map.addressOf(0), null); // the header isn't a section's
    assert.equal(map.addressOf(section(".symtab").offset), null); // not loaded
    assert.equal(map.offsetOf(0x401008), 72);
    assert.equal(map.offsetOf(0x404000), null); // .bss: loaded, but not from the file
    assert.equal(map.offsetOf(0x500000), null);
    assert.equal(map.sectionAt(64 + 32).name, ".plt.sec");
    assert.equal(map.sectionOf(0x404010).name, ".bss");
    assert.equal(map.sectionAt(0), null);
    const at = (address) => { const s = map.symbolAt(address); return s && `${s.name}+${s.delta}`; };
    assert.deepEqual([0x401000, 0x401004, 0x40100f, 0x401010, 0x401017, 0x401018, 0x401100, 0x40110f, 0x404002, 0x404004, 0x400000].map(at),
        ["main+0", "main+4", "main+15", "helper+0", "helper+7", null, "puts@plt+0", "puts@plt+15", "counter+2", null, null]);
});

test("ELF of the other width and byte order; a relocatable one's addresses are file offsets; ARM's Thumb bit", async () => {
    const strings = names("start", "thumb_fn");
    const mips = await parse(elf({ wide: false, little: false, machine: 8, entry: 0x400000, sections: [
        { name: ".text", type: 1, flags: 6, address: 0x400000, data: new Uint8Array(16) },
        { name: ".symtab", type: 2, link: 3, entsize: 16, data: joined(symbol(false, false, 0, 0, 0, 0, 0), symbol(false, false, strings.at("start"), 0x12, 1, 0x400004, 8)) },
        { name: ".strtab", type: 3, data: strings.bytes },
    ] }));
    assert.deepEqual([mips.bits, mips.little, mips.machine, mips.mode, mips.entry], [32, false, "MIPS", "mips32-be", 0x400000]);
    assert.deepEqual(mips.sections[0], { name: ".text", offset: 52, size: 16, address: 0x400000, memSize: 16, flags: "r-x" });
    assert.deepEqual(mips.symbols, [{ name: "start", address: 0x400004, size: 8, kind: "func" }]);
    // A .o: nothing's loaded anywhere, and a symbol is so far into its section.
    const object = await parse(elf({ type: 1, sections: [
        { name: ".text", type: 1, flags: 6, data: new Uint8Array(16) },
        { name: ".symtab", type: 2, link: 3, entsize: 24, data: joined(symbol(true, true, 0, 0, 0, 0, 0), symbol(true, true, strings.at("start"), 0x12, 1, 4, 8)) },
        { name: ".strtab", type: 3, data: strings.bytes },
    ] }));
    assert.deepEqual([object.kind, object.relocatable, object.entry], ["relocatable object", true, null]);
    assert.deepEqual(object.symbols, [{ name: "start", address: 64 + 4, size: 8, kind: "func" }]);
    assert.equal(programMap(object).addressOf(70), 70);
    const arm = await parse(elf({ wide: false, machine: 40, entry: 0x8001, sections: [
        { name: ".text", type: 1, flags: 6, address: 0x8000, data: new Uint8Array(16) },
        { name: ".symtab", type: 2, link: 3, entsize: 16, data: joined(symbol(false, true, 0, 0, 0, 0, 0), symbol(false, true, strings.at("thumb_fn"), 0x12, 1, 0x8005, 4)) },
        { name: ".strtab", type: 3, data: strings.bytes },
    ] }));
    assert.deepEqual([arm.mode, arm.entry, arm.symbols[0].address], ["thumb", 0x8000, 0x8004]);
    // A 64-bit address past what a number holds exactly isn't one to go by.
    const high = await parse(elf({ sections: [{ name: ".text", type: 1, flags: 6, address: 0xffffffff80000000n, data: new Uint8Array(16) }] }));
    assert.equal(high.sections[0].address, null);
});

// A PE32+ (or PE32) with code, and data holding what it takes from another
// file (its imports) and gives (its exports).
function pe({ wide = true, dll = false, arm64 = false } = {}) {
    const little = true, base = wide ? 0x140000000 : 0x400000;
    // .rdata, at RVA 0x2000, file offset 0x400.
    const data = new Uint8Array(0x200), view = new DataView(data.buffer), rva = (at) => 0x2000 + at;
    const text = (at, value) => { data.set(new TextEncoder().encode(value), at); return rva(at); };
    // Imports: one descriptor for KERNEL32.dll (Sleep, and number 7), then none.
    data.set(packed(little, [rva(0x40), 4], [0, 4], [0, 4], [text(0x100, "KERNEL32.dll"), 4], [rva(0x60), 4]), 0);
    text(0x112, "Sleep"); // after its 2-byte hint at 0x110
    for (const at of [0x40, 0x60]) {
        if (wide) { view.setBigUint64(at, BigInt(rva(0x110)), true); view.setBigUint64(at + 8, 0x8000000000000007n, true); }
        else { view.setUint32(at, rva(0x110), true); view.setUint32(at + 4, 0x80000007, true); }
    }
    // Exports: twice at RVA 0x1010 and thrice at 0x1020, by name; one by
    // number alone at 0x1030; and one that's another file's (a forwarder).
    data.set(packed(little, [0, 4], [0, 4], [0, 4], [text(0x180, "lib.dll"), 4], [1, 4], [4, 4], [3, 4], [rva(0xa8), 4], [rva(0xb8), 4], [rva(0xc4), 4]), 0x80);
    data.set(packed(little, [0x1020, 4], [0x1010, 4], [0x1030, 4], [text(0x1a0, "other.fn"), 4]), 0xa8);
    data.set(packed(little, [text(0x190, "forwarded"), 4], [text(0x188, "thrice"), 4], [text(0x1c0, "twice"), 4]), 0xb8);
    data.set(packed(little, [3, 2], [0, 2], [1, 2]), 0xc4);
    const optional = joined(packed(little, [wide ? 0x20b : 0x10b, 2], [0, 2], [0x200, 4], [0x200, 4], [0, 4], [0x1000, 4], [0x1000, 4]),
        wide ? packed(little, [base, 8]) : packed(little, [0x2000, 4], [base, 4]),
        packed(little, [0x1000, 4], [0x200, 4]), new Uint8Array(wide ? 68 : 52), packed(little, [16, 4]),
        // The export directory (0x80 to 0x200, so the forwarder's name is in it), the import directory, 14 that aren't there.
        packed(little, [rva(0x80), 4], [0x180, 4], [rva(0), 4], [40, 4]), new Uint8Array(14 * 8));
    const section = (name, virtualSize, at, rawSize, offset, bits) => joined(new TextEncoder().encode(name.padEnd(8, "\0")),
        packed(little, [virtualSize, 4], [at, 4], [rawSize, 4], [offset, 4], [0, 4], [0, 4], [0, 4], [bits, 4]));
    const head = new Uint8Array(64);
    head.set([0x4d, 0x5a]);
    new DataView(head.buffer).setUint32(0x3c, 64, true);
    const out = new Uint8Array(0x600);
    out.set(joined(head, packed(little, [0x4550, 4], [arm64 ? 0xaa64 : wide ? 0x8664 : 0x14c, 2], [3, 2], [0, 4], [0, 4], [0, 4], [optional.length, 2], [dll ? 0x2022 : 0x22, 2]), optional,
        section(".text", 0x40, 0x1000, 0x200, 0x200, 0x60000020), section(".rdata", 0x200, 0x2000, 0x200, 0x400, 0x40000040), section(".bss", 0x80, 0x3000, 0, 0, 0xc0000080)));
    out.set(data, 0x400);
    // Code, at RVA 0x1000: a nop; two stubs, each a jump through an import's
    // slot (Sleep's, then number 7's, 8 or 4 bytes after); and, after a pop,
    // the same jump as a function's last instruction, which isn't a stub.
    const width = wide ? 8 : 4, jump = (at, slot) => [0xff, 0x25, ...packed(little, [(wide ? slot - (at + 6) : base + slot) >>> 0, 4])];
    out.set([0x90, ...jump(0x1001, 0x2060), ...jump(0x1007, 0x2060 + width), 0x5d, ...jump(0x100e, 0x2060)], 0x200);
    // ARM64's instead: a nop; a stub (adrp x16, the slots' page, one on;
    // ldr x16, [x16, #0x60]; br x16); and the same ending in blr x16, a
    // call from a function's own code, which isn't one.
    if (arm64) {
        out.fill(0, 0x200, 0x240);
        out.set(packed(little, [0xd503201f, 4], [0xb0000010, 4], [0xf9400210 | 0x60 / 8 << 10, 4], [0xd61f0200, 4], [0xb0000010, 4], [0xf9400210 | 0x68 / 8 << 10, 4], [0xd63f0200, 4]), 0x200);
    }
    return out;
}

for (const wide of [true, false]) {
    test(`a PE32${wide ? "+" : ""}: its sections, its imports' slots and its exports`, async () => {
        const info = await parse(pe({ wide, dll: true })), base = wide ? 0x140000000 : 0x400000, width = wide ? 8 : 4;
        assert.deepEqual({ ...info, sections: undefined, symbols: undefined }, { format: "PE", bits: wide ? 64 : 32, little: true, machine: wide ? "x86-64" : "x86", kind: "DLL",
            mode: wide ? "x86-64" : "x86-32", entry: base + 0x1000, relocatable: false, sections: undefined, symbols: undefined, truncated: false });
        assert.deepEqual(info.sections, [
            { name: ".bss", offset: 0, size: 0, address: base + 0x3000, memSize: 0x80, flags: "rw-" },
            // (Its bytes in the file that are loaded: 0x40 of the 0x200 there.)
            { name: ".text", offset: 0x200, size: 0x40, address: base + 0x1000, memSize: 0x40, flags: "r-x" },
            { name: ".rdata", offset: 0x400, size: 0x200, address: base + 0x2000, memSize: 0x200, flags: "r--" },
        ]);
        assert.deepEqual(info.symbols, [
            // The stubs that jump through the imports' slots, named as what they go to.
            { name: "Sleep", address: base + 0x1001, size: 6, kind: "plt" }, { name: "KERNEL32!#7", address: base + 0x1007, size: 6, kind: "plt" },
            { name: "twice", address: base + 0x1010, size: 0, kind: "func" }, { name: "thrice", address: base + 0x1020, size: 0, kind: "func" },
            { name: "#3", address: base + 0x1030, size: 0, kind: "func" },
            { name: "KERNEL32!Sleep", address: base + 0x2060, size: width, kind: "import" }, { name: "KERNEL32!#7", address: base + 0x2060 + width, size: width, kind: "import" },
        ]);
        const map = programMap(info);
        assert.equal(map.addressOf(0x210), base + 0x1010);
        assert.equal(map.offsetOf(base + 0x2060), 0x460);
        assert.equal(map.offsetOf(base + 0x3000), null);
        // No sizes: in a symbol by being after it, in its section.
        assert.equal(map.symbolAt(base + 0x1018).name, "twice");
        assert.equal(map.symbolAt(base + 0x1009).name, "KERNEL32!#7");
        // (Past the second stub's six bytes: the jump at a function's end, which has no name.)
        assert.equal(map.symbolAt(base + 0x100e), null);
        assert.equal((await parse(pe({ wide }))).kind, "executable");
    });
}

test("an ARM64 PE's stubs are named as the functions they jump to", async () => {
    const info = await parse(pe({ arm64: true })), base = 0x140000000;
    assert.deepEqual([info.machine, info.mode, info.bits], ["ARM64", "arm64", 64]);
    // The stub (12 bytes, from its adrp); not the call through the next slot.
    assert.deepEqual(info.symbols.filter((s) => s.kind === "plt"), [{ name: "Sleep", address: base + 0x1004, size: 12, kind: "plt" }]);
    assert.deepEqual(info.symbols.filter((s) => s.kind === "import").map((s) => [s.name, s.address]), [["KERNEL32!Sleep", base + 0x2060], ["KERNEL32!#7", base + 0x2068]]);
    const map = programMap(info);
    assert.deepEqual([map.symbolAt(base + 0x1004).name, map.symbolAt(base + 0x100c).delta, map.symbolAt(base + 0x1010)?.name], ["Sleep", 8, "twice"]);
});

// A Mach-O: its header, its load commands (a segment each for code and
// data, with their sections; the symbols; the numbers of the symbols that
// stubs and slots are for; where it starts), then the sections' bytes and
// those tables. Code: 16 bytes and two 12-byte stubs; data: two pointers'
// slots, and 32 bytes that aren't in the file.
function macho({ wide = true, little = true, machine = 0x0100000c, type = 2 } = {}) {
    const word = wide ? 8 : 4, text = new TextEncoder();
    const name16 = (name) => text.encode(name.padEnd(16, "\0"));
    const strings = names("_main", "_helper", "_puts", "_exit", "debug", "_zeroed");
    const nlist = (name, kind, section, value) => packed(little, [strings.at(name), 4], [kind, 1], [section, 1], [0, 2], [value, word]);
    // _main and _helper in the code; _puts and _exit, another file's; a debugger's; _zeroed in the data that isn't in the file.
    const table = (base) => joined(nlist("_main", 0x0f, 1, base + 0), nlist("_helper", 0x0e, 1, base + 8), nlist("_puts", 0x01, 0, 0), nlist("_exit", 0x01, 0, 0),
        nlist("debug", 0x24, 1, base + 4), nlist("_zeroed", 0x0f, 4, dataBase + 0x100));
    // The stubs are for _puts and _exit; the slots, for _puts and one of its own (no symbol's).
    const indirect = packed(little, [2, 4], [3, 4], [2, 4], [0x80000000, 4]);
    const headSize = wide ? 32 : 28, segmentSize = wide ? 72 : 56, sectionSize = wide ? 80 : 68;
    const commandsSize = 2 * segmentSize + 4 * sectionSize + segmentSize + 24 + 80 + 24;
    const codeAt = headSize + commandsSize, stubsAt = codeAt + 16, gotAt = stubsAt + 24, linkAt = gotAt + 2 * word;
    const textBase = wide ? 0x100000000 : 0x1000, dataBase = textBase + 0x4000;
    const section = (name, segment, address, size, offset, kind, first = 0, second = 0) => joined(name16(name), name16(segment),
        packed(little, [address, word], [size, word], [offset, 4], [0, 4], [0, 4], [0, 4], [kind, 4], [first, 4], [second, 4], ...(wide ? [[0, 4]] : [])));
    const segment = (name, address, memSize, offset, fileSize, protection, count) => joined(packed(little, [wide ? 0x19 : 1, 4], [segmentSize + count * sectionSize, 4]), name16(name),
        packed(little, [address, word], [memSize, word], [offset, word], [fileSize, word], [7, 4], [protection, 4], [count, 4], [0, 4]));
    const symbolsAt = linkAt, stringsAt = symbolsAt + 6 * (wide ? 16 : 12), indirectAt = stringsAt + strings.bytes.length;
    return joined(
        packed(little, [wide ? 0xfeedfacf : 0xfeedface, 4], [machine, 4], [0, 4], [type, 4], [6, 4], [commandsSize, 4], [0, 4], ...(wide ? [[0, 4]] : [])),
        segment("__TEXT", textBase, 0x4000, 0, gotAt, 5, 2),
        section("__text", "__TEXT", textBase + codeAt, 16, codeAt, 0x80000400), section("__stubs", "__TEXT", textBase + stubsAt, 24, stubsAt, 0x80000408, 0, 12),
        segment("__DATA", dataBase, 0x4000, gotAt, 2 * word, 3, 2),
        section("__got", "__DATA", dataBase, 2 * word, gotAt, 6, 2), section("__bss", "__DATA", dataBase + 0x100, 32, 0, 1),
        segment("__LINKEDIT", dataBase + 0x4000, 0x4000, linkAt, indirectAt + 16 - linkAt, 1, 0),
        packed(little, [2, 4], [24, 4], [symbolsAt, 4], [6, 4], [stringsAt, 4], [strings.bytes.length, 4]),
        packed(little, [0xb, 4], [80, 4], ...Array.from({ length: 12 }, () => [0, 4]), [indirectAt, 4], [4, 4], ...Array.from({ length: 4 }, () => [0, 4])),
        packed(little, [0x80000028, 4], [24, 4], [codeAt, 8], [0, 8]),
        new Uint8Array(16).fill(0xd5), new Uint8Array(24).fill(0x16), new Uint8Array(2 * word),
        table(textBase + codeAt), strings.bytes, indirect);
}
// A universal file of these Mach-Os, one after another: its header (always
// big-endian) says which machine each is for, and where.
function universal(...slices) {
    let at = 8 + 20 * slices.length;
    const entries = slices.map((s) => { const entry = packed(false, [new DataView(s.buffer).getUint32(4, s[0] !== 0xfe), 4], [0, 4], [at, 4], [s.length, 4], [0, 4]); at += s.length; return entry; });
    return joined(packed(false, [0xcafebabe, 4], [slices.length, 4]), ...entries, ...slices);
}

test("a Mach-O: its sections by segment, where each is loaded, its symbols, and the stubs and slots of what it calls", async () => {
    const bytes = macho(), info = await parse(bytes), base = 0x100000000;
    const code = 32 + 2 * 72 + 4 * 80 + 72 + 24 + 80 + 24;
    assert.deepEqual({ ...info, sections: undefined, symbols: undefined }, { format: "Mach-O", bits: 64, little: true, machine: "ARM64", kind: "executable", mode: "arm64",
        entry: base + code, relocatable: false, sections: undefined, symbols: undefined, truncated: false });
    assert.deepEqual(info.sections, [
        // (No bytes in the file.)
        { name: "__DATA,__bss", offset: 0, size: 0, address: base + 0x4100, memSize: 32, flags: "rw-" },
        { name: "__TEXT,__text", offset: code, size: 16, address: base + code, memSize: 16, flags: "r-x" },
        { name: "__TEXT,__stubs", offset: code + 16, size: 24, address: base + code + 16, memSize: 24, flags: "r-x" },
        { name: "__DATA,__got", offset: code + 40, size: 16, address: base + 0x4000, memSize: 16, flags: "rw-" },
        // A segment with no sections of its own, whole.
        { name: "__LINKEDIT", offset: code + 56, size: bytes.length - code - 56, address: base + 0x8000, memSize: 0x4000, flags: "r--" },
    ]);
    // Not another file's (_puts, _exit) or a debugger's; a stub by the name of what it's for, a slot as its @got.
    assert.deepEqual(info.symbols, [
        { name: "_main", address: base + code, size: 0, kind: "func" }, { name: "_helper", address: base + code + 8, size: 0, kind: "func" },
        { name: "_puts", address: base + code + 16, size: 12, kind: "plt" }, { name: "_exit", address: base + code + 28, size: 12, kind: "plt" },
        { name: "_puts@got", address: base + 0x4000, size: 8, kind: "got" }, { name: "_zeroed", address: base + 0x4100, size: 0, kind: "object" },
    ]);
    const map = programMap(info);
    assert.equal(map.offsetOf(base + 0x4008), code + 48);
    assert.equal(map.addressOf(code + 20), base + code + 20);
    assert.deepEqual([map.symbolAt(base + code + 30).name, map.symbolAt(base + code + 12).name, map.symbolAt(base + 0x4008)], ["_exit", "_helper", null]);
    // The other width and byte order (as an old PowerPC program's).
    const old = await parse(macho({ wide: false, little: false, machine: 18 }));
    assert.deepEqual([old.bits, old.little, old.machine, old.mode, old.entry], [32, false, "PowerPC", null, 0x1000 + 28 + 2 * 56 + 4 * 68 + 56 + 128]);
    assert.deepEqual(old.symbols.map((s) => s.name), ["_main", "_helper", "_puts", "_exit", "_puts@got", "_zeroed"]);
    assert.equal(old.symbols[4].size, 4);
    assert.equal((await parse(macho({ type: 6 }))).kind, "dynamic library");
    // A load command that says it's no length at all (which would never end): not one.
    const endless = bytes.slice();
    new DataView(endless.buffer).setUint32(32 + 4, 0, true);
    assert.equal(await parse(endless), null);
    // A stub section that says its stubs are no length: none named, the rest as it was.
    const stubless = bytes.slice();
    new DataView(stubless.buffer).setUint32(32 + 72 + 80 + 72, 0, true);
    assert.deepEqual((await parse(stubless)).symbols.map((s) => s.name), ["_main", "_helper", "_puts@got", "_zeroed"]);
});

test("a universal file: the slice asked for, its offsets the file's; a Java class, which begins the same, isn't one", async () => {
    const arm = macho(), intel = macho({ machine: 0x01000007 }), bytes = universal(intel, arm);
    const first = await parse(bytes), second = await readExecutable(reading(bytes), bytes.length, { slice: 1 });
    const slices = [{ machine: "x86-64", offset: 48, size: intel.length }, { machine: "ARM64", offset: 48 + intel.length, size: arm.length }];
    assert.deepEqual([first.slices, first.slice, first.machine, first.mode], [slices, 0, "x86-64", "x86-64"]);
    assert.deepEqual([second.slices, second.slice, second.machine, second.mode], [slices, 1, "ARM64", "arm64"]);
    // Each as it is alone, but where it is in this file; its addresses are its own.
    const alone = await parse(arm);
    assert.deepEqual(second.sections.map((s) => [s.name, s.offset, s.size, s.address]), alone.sections.map((s) => [s.name, s.offset + 48 + intel.length, s.size, s.address]));
    assert.deepEqual(second.symbols, alone.symbols);
    assert.equal(second.entry, alone.entry);
    assert.equal(programMap(second).offsetOf(alone.entry), programMap(alone).offsetOf(alone.entry) + 48 + intel.length);
    // A slice that isn't there: the first.
    assert.equal((await readExecutable(reading(bytes), bytes.length, { slice: 7 })).slice, 0);
    // A Java class file: cafebabe, then its version, where a universal file's count of slices is.
    const java = new Uint8Array(4096);
    java.set([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 0x34, 0, 0x20, 0x0a, 0, 6, 0, 0x12]);
    assert.equal(await parse(java), null);
    // One that lists a slice outside the file, or one that isn't a Mach-O.
    const outside = bytes.slice();
    new DataView(outside.buffer).setUint32(8 + 20 + 12, bytes.length, false);
    assert.equal(await parse(outside), null);
    const other = bytes.slice();
    other[48] = 0;
    assert.equal(await parse(other), null);
});

test("one table that doesn't hold together is given up alone: the rest of what was read stays", async () => {
    // A PE whose export directory is said to begin 20 bytes before the file's end (it's 40 long).
    const cut = pe({ dll: true }), view = new DataView(cut.buffer);
    view.setUint32(64 + 24 + 112, 0x2000 + 0x200 - 20, true);
    const info = await parse(cut);
    assert.deepEqual([info.sections.length, info.truncated], [3, true]);
    // Its imports, and the stubs for them, are still read; its exports aren't.
    assert.deepEqual(info.symbols.map((s) => s.name), ["Sleep", "KERNEL32!#7", "KERNEL32!Sleep", "KERNEL32!#7"]);
    // A Mach-O whose last load command (where it starts) says it's 4 bytes
    // long: the commands before it stand.
    const whole = macho(), bad = whole.slice(), code = 32 + 2 * 72 + 4 * 80 + 72 + 24 + 80 + 24;
    new DataView(bad.buffer).setUint32(code - 24 + 4, 4, true);
    const most = await parse(bad), all = await parse(whole);
    assert.deepEqual([most.sections, most.symbols, most.truncated, most.entry], [all.sections, all.symbols, true, null]);
});

test("an x86-64 stub's length: 16 bytes where its jmp is followed by a push and a jmp, 8 where it's alone", async () => {
    const dynamic = names("puts", "exit");
    // .plt's, for puts: jmp [rip+…] to the slot at 0x403000; push 0; jmp back. .plt.got's, for exit: jmp [rip+…] to 0x403008; a 2-byte nop.
    const lazy = joined([0xff, 0x25], packed(true, [0x403000 - 0x401106, 4]), [0x68], packed(true, [0, 4]), [0xe9], packed(true, [0xffffffe0, 4]));
    const alone = joined([0xff, 0x25], packed(true, [0x403008 - 0x401206, 4]), [0x66, 0x90]);
    const info = await parse(elf({ sections: [
        { name: ".plt", type: 1, flags: 6, address: 0x401100, data: lazy, entsize: 16 },
        { name: ".plt.got", type: 1, flags: 6, address: 0x401200, data: alone, entsize: 8 },
        { name: ".got", type: 1, flags: 3, address: 0x403000, data: new Uint8Array(16) },
        { name: ".dynsym", type: 11, flags: 2, link: 5, entsize: 24, data: joined(symbol(true, true, 0, 0, 0, 0, 0), symbol(true, true, dynamic.at("puts"), 0x12, 0, 0, 0), symbol(true, true, dynamic.at("exit"), 0x12, 0, 0, 0)) },
        { name: ".dynstr", type: 3, flags: 2, data: dynamic.bytes },
        { name: ".rela.plt", type: 4, flags: 2, link: 4, entsize: 24, data: joined(packed(true, [0x403000, 8], [7, 4], [1, 4], [0, 8]), packed(true, [0x403008, 8], [6, 4], [2, 4], [0, 8])) },
    ] }));
    assert.deepEqual(info.symbols.filter((s) => s.kind === "plt"), [{ name: "puts@plt", address: 0x401100, size: 16, kind: "plt" }, { name: "exit@plt", address: 0x401200, size: 8, kind: "plt" }]);
    const map = programMap(info);
    // (Its push, 6 bytes in, and its last byte are the stub's.)
    assert.deepEqual([map.symbolAt(0x401106).delta, map.symbolAt(0x40110f).name, map.symbolAt(0x401207).name, map.symbolAt(0x401208)], [6, "puts@plt", "exit@plt", null]);
});

test("a PE that takes thousands of functions from other files has every one read", async () => {
    // 80 libraries, 170 functions of each, in one section at RVA 0x1000: what's
    // taken (a descriptor for each library), each library's list, the names.
    const libraries = 80, each = 170, text = new TextEncoder();
    const descriptors = (libraries + 1) * 20, lists = libraries * (each + 1) * 8, nameSize = 24, libraryName = 16;
    const dataSize = descriptors + lists + libraries * libraryName + libraries * each * nameSize + 2_000_000;
    const bytes = new Uint8Array(0x400 + dataSize), view = new DataView(bytes.buffer), rva = (at) => 0x1000 + at;
    bytes.set(joined([0x4d, 0x5a], new Uint8Array(58), packed(true, [64, 4], [0x4550, 4], [0x8664, 2], [1, 2], [0, 4], [0, 4], [0, 4], [240, 2], [0x22, 2],
        [0x20b, 2], [0, 2], [0, 4], [0, 4], [0, 4], [0x1000, 4], [0, 4], [0x140000000, 8]), new Uint8Array(76), packed(true, [16, 4], [0, 4], [0, 4], [rva(0), 4], [descriptors, 4]), new Uint8Array(14 * 8),
        text.encode(".idata\0\0"), packed(true, [dataSize, 4], [0x1000, 4], [dataSize, 4], [0x400, 4], [0, 4], [0, 4], [0, 4], [0xc0000040, 4])));
    for (let d = 0; d < libraries; d++) {
        const list = descriptors + d * (each + 1) * 8, library = descriptors + lists + d * libraryName;
        bytes.set(text.encode(`LIB${d}.dll`), 0x400 + library);
        bytes.set(packed(true, [rva(list), 4], [0, 4], [0, 4], [rva(library), 4], [rva(list), 4]), 0x400 + d * 20);
        for (let i = 0; i < each; i++) {
            const name = descriptors + lists + libraries * libraryName + (d * each + i) * nameSize;
            bytes.set(text.encode(`Function${d}_${i}`), 0x400 + name + 2);
            view.setBigUint64(0x400 + list + i * 8, BigInt(rva(name)), true);
        }
    }
    const info = await parse(bytes);
    assert.deepEqual([info.symbols.length, info.truncated], [libraries * each, false]);
    assert.deepEqual([info.symbols[0].name, info.symbols.at(-1).name], ["LIB0!Function0_0", "LIB79!Function79_169"]);
});

test("what isn't a program, or doesn't hold together, is null or what could be read: never an error, nor much read", async () => {
    assert.equal(await parse(new Uint8Array(0)), null);
    assert.equal(await parse(new Uint8Array(4096)), null);
    assert.equal(await parse(Uint8Array.from({ length: 4096 }, (_, i) => "MZ"[i]?.charCodeAt(0) ?? 0)), null); // MZ, and no PE header
    assert.equal(await parse(Uint8Array.from({ length: 64 }, (_, i) => [0x7f, 0x45, 0x4c, 0x46, 9, 9][i] ?? 0)), null); // not a class of ELF
    // A read that fails (the connection, say) is the caller's to see.
    await assert.rejects(readExecutable(async () => { throw new Error("offline"); }, 4096), /offline/);
    let seed = 12345;
    const random = (n) => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
    for (const whole of [program(), pe(), pe({ wide: false }), macho(), macho({ wide: false, little: false, machine: 18 }), universal(macho({ machine: 0x01000007 }), macho())]) {
        // Cut short anywhere.
        for (let length = 0; length < whole.length; length += 7) {
            const info = await parse(whole.subarray(0, length));
            assert.ok(info === null || Array.isArray(info.sections), `cut to ${length}`);
        }
        // Bytes changed anywhere: counts, offsets and sizes that aren't so.
        for (let t = 0; t < 600; t++) {
            const bytes = whole.slice();
            for (let n = 1 + random(4); n > 0; n--) bytes[random(bytes.length)] = [0, 0xff, 0x7f, 0x80, random(256)][random(5)];
            const read = reading(bytes), info = await readExecutable(read, bytes.length);
            assert.ok(info === null || (Array.isArray(info.sections) && Array.isArray(info.symbols)));
            assert.ok(read.bytes <= bytes.length, "no byte read twice");
            for (const s of info?.sections ?? []) assert.ok(s.offset >= 0 && s.size >= 0 && s.offset + s.size <= bytes.length, `a section outside the file: ${JSON.stringify(s)}`);
            if (info) programMap(info).symbolAt(0x401000);
        }
    }
    // A file that says it has more than is read of any: given up on.
    const huge = program(), size = 400_000_000;
    const view = new DataView(huge.buffer);
    const read = async (begin, end) => (begin < huge.length ? Uint8Array.from({ length: end - begin }, (_, i) => huge[begin + i] ?? 0) : new Uint8Array(end - begin));
    // .symtab (the 8th header) made 300 MB long.
    const headers = Number(view.getBigUint64(40, true));
    view.setBigUint64(headers + 8 * 64 + 32, 300_000_000n, true);
    let asked = 0;
    const info = await readExecutable(async (begin, end) => { asked += end - begin; return read(begin, end); }, size);
    assert.ok(asked < 30_000_000, `${asked} bytes read`);
    assert.ok(info === null || info.truncated);
});

test("a table pointed at from thousands of places isn't gone through from each", async () => {
    // 40,000 symbols (a megabyte), and 3,000 headers that each say it's theirs.
    const strings = names("f");
    const table = joined(...Array.from({ length: 40_000 }, (_, i) => symbol(true, true, i ? strings.at("f") : 0, 0x12, 1, 0x401000 + i, 0)));
    const bytes = elf({ sections: [
        { name: ".text", type: 1, flags: 6, address: 0x401000, data: new Uint8Array(16) },
        { name: ".strtab", type: 3, data: strings.bytes },
        { name: ".symtab", type: 2, link: 2, entsize: 24, data: table },
        ...Array.from({ length: 3000 }, () => ({ name: ".symtab", type: 2, link: 2, entsize: 24, same: ".symtab" })),
    ] });
    const read = reading(bytes), began = performance.now();
    const info = await readExecutable(read, bytes.length);
    assert.ok(performance.now() - began < 5000, `${Math.round(performance.now() - began)} ms`);
    assert.ok(read.bytes <= bytes.length);
    // (A megabyte and more of tables: read as a few reads of up to a megabyte, not one for each quarter of one.)
    assert.ok(read.calls <= 3, `${read.calls} reads of a ${bytes.length}-byte file`);
    // What was read before it was given up is kept, and it's said there's more.
    assert.equal(info.symbols.length, 39_999);
    assert.equal(info.truncated, true);
    assert.equal(info.sections.length, 3004);
});

// Against the system's own reading of one of its programs, where it has both.
test("an ELF's sections are as readelf has them", { skip: !existsSync("/bin/ls") || !existsSync("/usr/bin/readelf") }, async () => {
    const bytes = readFileSync("/bin/ls");
    if (bytes[0] !== 0x7f) return;
    const read = reading(bytes), info = await readExecutable(read, bytes.length);
    let checked = 0;
    for (const line of execFileSync("/usr/bin/readelf", ["-SW", "/bin/ls"]).toString().split("\n")) {
        const m = /^\s*\[\s*\d+\]\s+(\.\S+)\s+(\S+)\s+([0-9a-f]+)\s+([0-9a-f]+)\s+([0-9a-f]+)\s+\S+\s+(\S*)/.exec(line);
        if (!m) continue;
        const [, name, type, address, offset, size, flags] = m, s = info.sections.find((x) => x.name === name);
        assert.ok(s, name);
        assert.equal(s.size, type === "NOBITS" ? 0 : parseInt(size, 16), name);
        if (type !== "NOBITS") assert.equal(s.offset, parseInt(offset, 16), name);
        assert.equal(s.address, flags.includes("A") ? parseInt(address, 16) : null, name);
        checked++;
    }
    assert.ok(checked > 10);
    assert.ok(read.bytes <= bytes.length);
    // Cut off partway through its section headers (a download that stopped):
    // what's loaded is read from its segments instead, and it's said there's more.
    const headers = Number(new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(40, true));
    const cut = await parse(bytes.subarray(0, headers + 100));
    assert.ok(cut.sections.length > 0 && cut.sections.every((s) => /^LOAD \d+$/.test(s.name)), JSON.stringify(cut.sections.map((s) => s.name)));
    assert.equal(cut.truncated, true);
    assert.equal(programMap(cut).addressOf(cut.sections[0].offset), cut.sections[0].address);
});
