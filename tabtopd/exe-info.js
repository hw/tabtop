// What an executable says of itself, for the hex view: an ELF's (a Linux
// program, a .so, a .o), a PE's (a Windows .exe or .dll) or a Mach-O's (a
// macOS or iOS program, .dylib or .o; one of those in a universal file)
// sections, where each is loaded, and its symbols; told by how the file
// begins, not by its name. readExecutable reads the tables it needs, wherever they are in the
// file (the symbols are mostly at its end), no more than MAX_READ bytes of
// them; a file that isn't one, or whose tables don't hold together, is null,
// and everything in it is taken as possibly wrong: each count and offset is
// checked against the file, and what's too much is left out (see truncated).
//
// {format: "ELF", "PE" or "Mach-O", bits, little, machine, kind, mode, entry,
//  relocatable, sections: [{name, offset, size, address, memSize, flags}],
//  symbols: [{name, address, size, kind}], truncated}; and, of a universal
// file, slices: [{machine, offset, size}] and slice, the number of the one
// this is of.
// offset and size are of the section's bytes in the file (size 0: it has
// none, as .bss); address is where it's loaded, or null (not loaded, or
// past what a number holds exactly); mode is the hex view's instruction set
// for the machine, if it has it. symbols are in order of address: kind is
// "func", "object", "import" (a PE's slot for another file's function),
// "got" (an ELF's), "plt" (the stub that jumps through one) or "". In a
// relocatable file (a .o), nothing is loaded anywhere: addresses there are
// file offsets.

const MAX_READ = 24_000_000, MAX_WORK = 2 * MAX_READ, MAX_PART = 1_000_000, BLOCK = 250_000, READS_AT_ONCE = 4, MAX_SECTIONS = 4096, MAX_SYMBOLS = 200_000, MAX_TABLE = 8_000_000;
// (A C++ or Rust name, with its types in it, can be thousands of letters.)
const MAX_NAME = 4096, MAX_LETTERS = 32_000_000;

class NotOne extends Error {}
const fail = (why) => { throw new NotOne(why); };

// Reads of the file, counted: get(begin, length) is those bytes. The file
// is read in blocks, each once, so the many small things in a table (an
// import's name, say) are one read, not one each; a range outside the
// file, or past what's allowed in all, isn't read.
//
// sink() is where a reader's symbols are kept: add(name, address, size,
// kind) keeps one that has a name and an address a number holds exactly,
// once; past MAX_SYMBOLS of them, or MAX_LETTERS of names (many symbols can
// each take a long one), no more, and full() says so. apart(work, failed)
// does a table's reading so that one that doesn't hold together (a count or
// an offset that's outside the file, or bytes cut short) is given up alone,
// with failed() called: the tables before it, and the sections, stay.
function sink() {
    const symbols = [], seen = new Set();
    let letters = 0, over = false;
    return {
        symbols,
        full: () => over,
        add(name, address, size, kind) {
            if (!name || !(address >= 0) || !Number.isSafeInteger(address)) return;
            const key = `${address} ${name}`;
            if (seen.has(key)) return;
            if (symbols.length >= MAX_SYMBOLS || (letters += name.length) > MAX_LETTERS) { over = true; return; }
            seen.add(key);
            symbols.push({ name, address, size: size >= 0 ? size : 0, kind });
        },
    };
}
async function apart(work, failed) {
    try {
        await work();
    } catch (err) {
        if (!(err instanceof NotOne || err instanceof RangeError)) throw err;
        failed();
    }
}
// Where ARM64's adrp at `here` points: the 4 KB page so many pages (its 21
// signed bits) from here's own.
function adrpPage(adrp, here) {
    const pages = ((adrp >> 5 & 0x7ffff) << 2 | adrp >>> 29 & 3) << 11 >> 11;
    return here - here % 4096 + pages * 4096;
}
function reader(read, size) {
    const blocks = new Map(); // a block's number to the promise of its bytes
    let spent = 0;
    // The blocks from first to last that aren't read yet: those beside each
    // other as one read (of no more than MAX_PART), a few reads at a time,
    // so a table of megabytes isn't a wait for each quarter of one in turn.
    const fetch = async (first, last) => {
        const runs = [];
        for (let n = first; n <= last; n++) {
            if (blocks.has(n)) continue;
            const run = runs.at(-1);
            if (run && run.at(-1) === n - 1 && run.length < MAX_PART / BLOCK) run.push(n);
            else runs.push([n]);
        }
        for (let from = 0; from < runs.length; from += READS_AT_ONCE) {
            await Promise.all(runs.slice(from, from + READS_AT_ONCE).map((run) => {
                const begin = run[0] * BLOCK, end = Math.min((run.at(-1) + 1) * BLOCK, size);
                if ((spent += end - begin) > MAX_READ) fail("too much to read");
                const whole = Promise.resolve(read(begin, end)).then((part) => (part instanceof Uint8Array && part.length === end - begin ? part : fail("a short read")));
                run.forEach((n, i) => {
                    const one = whole.then((part) => part.subarray(i * BLOCK, (i + 1) * BLOCK));
                    // (One that fails is seen by whoever waits for it; not as a failure no one handled.)
                    one.catch(() => {});
                    blocks.set(n, one);
                });
                return whole;
            }));
        }
    };
    // (What's given out is counted too, as a file can point at one table
    // from many places, to be gone through again from each.)
    let given = 0;
    return async (begin, length) => {
        if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(length) || begin < 0 || length < 0 || begin + length > size) fail("outside the file");
        if ((given += length) > MAX_WORK) fail("too much to go through");
        const out = new Uint8Array(length);
        if (!length) return out;
        await fetch(Math.floor(begin / BLOCK), Math.floor((begin + length - 1) / BLOCK));
        for (let at = begin; at < begin + length;) {
            const n = Math.floor(at / BLOCK), from = at - n * BLOCK, take = Math.min(BLOCK - from, begin + length - at);
            out.set((await blocks.get(n)).subarray(from, from + take), at - begin);
            at += take;
        }
        return out;
    };
}

// Fields of bytes: u64 is a number where it's exact, or NaN.
function fields(bytes, little) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
        u8: (at) => view.getUint8(at),
        u16: (at) => view.getUint16(at, little),
        u32: (at) => view.getUint32(at, little),
        u64: (at) => { const v = view.getBigUint64(at, little); return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : NaN; },
    };
}

// The text at `at` in a table of names, each ended by a 0.
const decoder = new TextDecoder("utf-8", { fatal: false });
function nameAt(table, at) {
    if (!(at >= 0 && at < table.length)) return "";
    let end = at;
    while (end < table.length && end - at < MAX_NAME && table[end]) end++;
    return decoder.decode(table.subarray(at, end));
}

const ELF_MACHINES = { 3: "x86", 62: "x86-64", 40: "ARM", 183: "ARM64", 8: "MIPS", 243: "RISC-V", 20: "PowerPC", 21: "PowerPC64", 22: "S/390", 2: "SPARC", 43: "SPARC64", 258: "LoongArch" };
// (A program that can be loaded anywhere says it's a shared object, as a .so does.)
const ELF_KINDS = { 1: "relocatable object", 2: "executable", 3: "shared object or position-independent executable", 4: "core dump" };
// The relocations that fill a slot with a function's or an object's
// address (JUMP_SLOT, GLOB_DAT), by machine.
const SLOT_RELOCATIONS = { 62: [7, 6], 3: [7, 6], 183: [1026, 1025], 40: [22, 21], 243: [5] };

async function readELF(get, head, size) {
    const wide = head[4] === 2, little = head[5] === 1;
    if (![1, 2].includes(head[4]) || ![1, 2].includes(head[5])) fail("not an ELF class");
    const f = fields(await get(0, wide ? 64 : 52), little);
    const word = wide ? f.u64 : f.u32;
    const type = f.u16(16), machine = f.u16(18), entry = word(24);
    const [phoff, shoff, phentsize, phnum, shentsize] = wide
        ? [f.u64(32), f.u64(40), f.u16(54), f.u16(56), f.u16(58)] : [f.u32(28), f.u32(32), f.u16(42), f.u16(44), f.u16(46)];
    let shnum = f.u16(wide ? 60 : 48), shstrndx = f.u16(wide ? 62 : 50);
    const relocatable = type === 1;
    let truncated = false;

    // Section headers; a count or a names' index too big for its field is
    // in the first header.
    const headerSize = wide ? 64 : 40;
    const raw = [];
    // (A table of them that isn't all in the file, as a download cut short
    // leaves it, is none: what's loaded is then read from the segments, below.)
    if (shoff > 0 && shoff < size && shentsize >= headerSize) await apart(async () => {
        if (shnum === 0 || shstrndx === 0xffff) {
            const first = fields(await get(shoff, headerSize), little);
            if (shnum === 0) shnum = wide ? first.u64(32) : first.u32(20);
            if (shstrndx === 0xffff) shstrndx = first.u32(wide ? 40 : 24);
        }
        if (!(shnum >= 0)) fail("a section count");
        if (shnum > MAX_SECTIONS) { shnum = MAX_SECTIONS; truncated = true; }
        const table = await get(shoff, shnum * shentsize);
        for (let i = 0; i < shnum; i++) {
            const s = fields(table.subarray(i * shentsize, i * shentsize + headerSize), little);
            raw.push(wide ? { name: s.u32(0), type: s.u32(4), flags: s.u64(8), address: s.u64(16), offset: s.u64(24), size: s.u64(32), link: s.u32(40), entsize: s.u64(56) }
                : { name: s.u32(0), type: s.u32(4), flags: s.u32(8), address: s.u32(12), offset: s.u32(16), size: s.u32(20), link: s.u32(24), entsize: s.u32(36) });
        }
    }, () => { raw.length = 0; truncated = true; });
    // A section's bytes, if they're in the file and no more than most.
    const inFile = (s) => s && s.type !== 8 && s.offset >= 0 && s.size >= 0 && s.offset + s.size <= size;
    // (Past what's read or gone through of any file: none of it, and said.)
    const bytesOf = async (s, most = MAX_TABLE) => {
        if (!inFile(s)) return new Uint8Array(0);
        if (s.size > most) truncated = true;
        try {
            return await get(s.offset, Math.min(s.size, most));
        } catch (err) {
            if (!(err instanceof NotOne)) throw err;
            truncated = true;
            return new Uint8Array(0);
        }
    };
    const names = shstrndx < raw.length && raw[shstrndx].type === 3 ? await bytesOf(raw[shstrndx], MAX_PART) : new Uint8Array(0);
    const sections = [];
    for (const s of raw) {
        if (s.type === 0) { sections.push(null); continue; }
        const loaded = (s.flags & 2) !== 0 && !relocatable, has = s.type !== 8 && inFile(s);
        sections.push({
            name: nameAt(names, s.name), offset: has ? s.offset : Math.min(s.offset >= 0 ? s.offset : size, size), size: has ? s.size : 0,
            address: relocatable ? (has ? s.offset : null) : loaded && s.address >= 0 ? s.address : null,
            memSize: s.size >= 0 ? s.size : 0,
            flags: `${s.flags & 2 ? "r" : "-"}${s.flags & 1 ? "w" : "-"}${s.flags & 4 ? "x" : "-"}`,
        });
    }
    // None (stripped of them): the segments that are loaded, instead.
    if (!raw.length && phoff > 0 && phoff < size && phentsize >= (wide ? 56 : 32) && phnum > 0) {
        const table = await get(phoff, phnum * phentsize);
        for (let i = 0; i < phnum; i++) {
            const p = fields(table.subarray(i * phentsize, (i + 1) * phentsize), little);
            if (p.u32(0) !== 1) continue;
            const [bits, offset, address, fileSize, memSize] = wide ? [p.u32(4), p.u64(8), p.u64(16), p.u64(32), p.u64(40)] : [p.u32(24), p.u32(4), p.u32(8), p.u32(16), p.u32(20)];
            if (!(offset >= 0 && fileSize >= 0 && offset + fileSize <= size)) continue;
            sections.push({ name: `LOAD ${sections.length}`, offset, size: fileSize, address: address >= 0 ? address : null, memSize: memSize >= 0 ? memSize : fileSize,
                flags: `${bits & 4 ? "r" : "-"}${bits & 2 ? "w" : "-"}${bits & 1 ? "x" : "-"}` });
        }
    }

    // Symbols: .symtab's and .dynsym's that are somewhere (not another
    // file's, a section's or a source file's name, or ARM's and RISC-V's
    // marks of where code and data begin).
    const { symbols, add, full } = sink();
    const entrySize = wide ? 24 : 16;
    const dynamicNames = new Map(); // a symbol table's section index to its names by number, for relocations
    for (let index = 0; index < raw.length; index++) {
        const s = raw[index];
        if (s.type !== 2 && s.type !== 11) continue;
        if (full()) break;
        const strings = raw[s.link]?.type === 3 ? await bytesOf(raw[s.link]) : new Uint8Array(0);
        const table = await bytesOf(s);
        const byNumber = [];
        for (let at = 0; at + entrySize <= table.length; at += entrySize) {
            const e = fields(table.subarray(at, at + entrySize), little);
            const [name, info, section, value, length] = wide ? [e.u32(0), e.u8(4), e.u16(6), e.u64(8), e.u64(16)] : [e.u32(0), e.u8(12), e.u16(14), e.u32(4), e.u32(8)];
            const text = nameAt(strings, name), kind = info & 0xf;
            if (s.type === 11) byNumber.push(text);
            if (!section || section >= 0xff00 || ![0, 1, 2, 10].includes(kind) || /^\$[xdat](\.|$)|^\.L/.test(text)) continue;
            // (ARM marks a Thumb function in its address's low bit.)
            const address = relocatable ? (inFile(raw[section]) ? raw[section].offset + value : NaN) : machine === 40 && kind === 2 ? value - value % 2 : value;
            add(text, address, length, kind === 2 || kind === 10 ? "func" : kind === 1 ? "object" : "");
        }
        if (s.type === 11) dynamicNames.set(index, byNumber);
    }
    // The slots the loader fills with other files' functions and objects
    // (printf@got), from the relocations that say which is whose.
    const slots = new Map();
    const wanted = SLOT_RELOCATIONS[machine];
    if (wanted && !relocatable) {
        for (const s of raw) {
            if ((s.type !== 4 && s.type !== 9) || !dynamicNames.has(s.link)) continue;
            const each = wide ? (s.type === 4 ? 24 : 16) : (s.type === 4 ? 12 : 8);
            const table = await bytesOf(s);
            for (let at = 0; at + each <= table.length; at += each) {
                const e = fields(table.subarray(at, at + each), little);
                const where = wide ? e.u64(0) : e.u32(0);
                const [number, kind] = wide ? [little ? e.u32(12) : e.u32(8), little ? e.u32(8) : e.u32(12)] : [e.u32(4) >>> 8, e.u32(4) & 0xff];
                const name = dynamicNames.get(s.link)[number];
                if (!name || !wanted.includes(kind) || !(where >= 0)) continue;
                slots.set(where, name);
                add(`${name}@got`, where, wide ? 8 : 4, "got");
            }
        }
    }
    // The stubs that jump through those slots (printf@plt), which calls to
    // other files' functions go to: x86-64's jmp [rip+…] and ARM64's adrp
    // x16, ldr x17, by where each reads its slot from.
    if (slots.size && (machine === 62 || machine === 183) && little) {
        for (let i = 0; i < raw.length; i++) {
            const s = raw[i], section = sections[i];
            if (!section || !/^\.plt(\.|$)/.test(section.name) || section.address == null || !(s.flags & 4) || section.size > MAX_PART) continue;
            const code = await bytesOf(s, MAX_PART), view = new DataView(code.buffer, code.byteOffset, code.byteLength);
            if (machine === 62) {
                // A stub is 8 or 16 bytes, at a multiple of 8: its jmp
                // (ff 25), after a bnd (f2) and an endbr64 where there are;
                // 16 with those, or where the jmp is followed by the push
                // (68) and jmp (e9) that have the loader find the function
                // the first time, as .plt's are.
                for (let at = 0; at + 6 <= code.length; at++) {
                    if (code[at] !== 0xff || code[at + 1] !== 0x25) continue;
                    const name = slots.get(section.address + at + 6 + view.getInt32(at + 2, true));
                    let begin = at > 0 && code[at - 1] === 0xf2 ? at - 1 : at;
                    if (begin >= 4 && view.getUint32(begin - 4, true) === 0xfa1e0ff3) begin -= 4;
                    const lazy = begin === at && code[at + 6] === 0x68 && code[at + 11] === 0xe9;
                    if (name && (section.address + begin) % 8 === 0) add(`${name}@plt`, section.address + begin, lazy || at + 6 - begin > 8 ? 16 : 8, "plt");
                    at += 5;
                }
            } else {
                for (let at = 0; at + 8 <= code.length; at += 4) {
                    const adrp = view.getUint32(at, true), ldr = view.getUint32(at + 4, true);
                    // adrp x16, page; ldr x17, [x16, #offset]
                    if ((adrp & 0x9f00001f) >>> 0 !== 0x90000010 || (ldr & 0xffc003ff) >>> 0 !== 0xf9400211) continue;
                    const here = section.address + at;
                    const name = slots.get(adrpPage(adrp, here) + (ldr >>> 10 & 0xfff) * 8);
                    // (Under BTI, the stub begins one instruction before: bti c.)
                    if (name) add(`${name}@plt`, at >= 4 && view.getUint32(at - 4, true) === 0xd503245f ? here - 4 : here, 16, "plt");
                }
            }
        }
    }
    // (ARM's entry is Thumb code if its low bit is set.)
    const mode = { 62: "x86-64", 3: "x86-32", 183: little ? "arm64" : null, 40: little ? (entry % 2 === 1 ? "thumb" : "arm32") : null,
        8: `mips${wide ? 64 : 32}-${little ? "le" : "be"}`, 243: little ? `riscv${wide ? 64 : 32}` : null }[machine] ?? null;
    return {
        format: "ELF", bits: wide ? 64 : 32, little, machine: ELF_MACHINES[machine] ?? `machine ${machine}`, kind: ELF_KINDS[type] ?? `type ${type}`, mode,
        entry: relocatable || !(entry > 0) ? null : machine === 40 ? entry - entry % 2 : entry, relocatable,
        sections: sections.filter(Boolean), symbols, truncated: truncated || full(),
    };
}

const PE_MACHINES = { 0x14c: "x86", 0x8664: "x86-64", 0xaa64: "ARM64", 0x1c0: "ARM", 0x1c2: "ARM", 0x1c4: "ARM", 0x200: "Itanium", 0x5064: "RISC-V", 0x5032: "RISC-V" };

async function readPE(get, head, size) {
    const at = fields(head, true).u32(0x3c);
    const coff = fields(await get(at, 24), true);
    if (coff.u32(0) !== 0x4550) fail("no PE header");
    const machine = coff.u16(4), symbolsAt = coff.u32(12), symbolCount = coff.u32(16), optionalSize = coff.u16(20), characteristics = coff.u16(22);
    let count = coff.u16(6), truncated = false;
    if (optionalSize < 96) fail("no optional header");
    const optional = fields(await get(at + 24, optionalSize), true);
    const magic = optional.u16(0), wide = magic === 0x20b;
    if ((magic !== 0x10b && !wide) || optionalSize < (wide ? 112 : 96)) fail("not a PE32 or PE32+");
    const base = wide ? optional.u64(24) : optional.u32(28), entryRVA = optional.u32(16);
    const directories = Math.min(optional.u32(wide ? 108 : 92), 16, Math.floor((optionalSize - (wide ? 112 : 96)) / 8));
    const directory = (n) => n < directories ? [optional.u32((wide ? 112 : 96) + 8 * n), optional.u32((wide ? 112 : 96) + 8 * n + 4)] : [0, 0];
    if (count > MAX_SECTIONS) { count = MAX_SECTIONS; truncated = true; }
    const table = await get(at + 24 + optionalSize, count * 40);
    // The names past 8 letters (/123) and the symbols' are in the table of
    // names after the symbols (a compiler's, such as MinGW's or Go's).
    let strings = new Uint8Array(0);
    const stringsAt = symbolsAt + symbolCount * 18;
    if (symbolsAt > 0 && stringsAt + 4 <= size) {
        const length = fields(await get(stringsAt, 4), true).u32(0);
        if (length > 4 && stringsAt + length <= size) {
            if (length > MAX_TABLE) truncated = true;
            strings = await get(stringsAt, Math.min(length, MAX_TABLE));
        }
    }
    const raw = [], sections = [];
    for (let i = 0; i < count; i++) {
        const s = fields(table.subarray(i * 40, i * 40 + 40), true);
        let name = nameAt(table.subarray(i * 40, i * 40 + 8), 0);
        if (/^\/\d+$/.test(name)) name = nameAt(strings, Number(name.slice(1))) || name;
        const [virtualSize, rva, rawSize, offset, bits] = [s.u32(8), s.u32(12), s.u32(16), s.u32(20), s.u32(36)];
        const has = offset > 0 && rawSize > 0 && offset + rawSize <= size;
        raw.push({ rva, span: Math.max(virtualSize, has ? rawSize : 0), offset, rawSize: has ? rawSize : 0 });
        sections.push({ name, offset: has ? offset : Math.min(offset, size), size: has ? Math.min(rawSize, virtualSize || rawSize) : 0,
            address: base >= 0 && Number.isSafeInteger(base + rva) ? base + rva : null, memSize: virtualSize || rawSize,
            flags: `${bits & 0x40000000 ? "r" : "-"}${bits & 0x80000000 ? "w" : "-"}${bits & 0x20000000 ? "x" : "-"}` });
    }
    // Where in the file an address from the image's start (an RVA) is.
    const offsetOf = (rva) => {
        for (const s of raw) if (rva >= s.rva && rva - s.rva < s.rawSize) return s.offset + rva - s.rva;
        return NaN;
    };
    const atRVA = async (rva, length) => {
        const offset = offsetOf(rva);
        if (!(offset >= 0)) fail("an address outside the sections");
        return get(offset, Math.min(length, size - offset));
    };
    // The name at an address: a little of it read first, which most names
    // fit in, and as much as a name can be only if that isn't all of it (a
    // program can take thousands of functions from others, each by name).
    const textAtRVA = async (rva) => {
        const few = await atRVA(rva, 64);
        return few.length < 64 || few.includes(0) ? nameAt(few, 0) : nameAt(await atRVA(rva, MAX_NAME), 0);
    };
    const { symbols, add, full } = sink();
    // Each table is read apart: one that doesn't hold together leaves the
    // others, and the sections, as they are.
    const part = (work) => apart(work, () => { truncated = true; });
    // What it gives others: its exports (one that's only another file's
    // name, a forwarder, isn't code here).
    const [exportsRVA, exportsSize] = directory(0);
    if (exportsRVA) await part(async () => {
        const e = fields(await atRVA(exportsRVA, 40), true);
        const [ordinalBase, functions, named, functionsRVA, namesRVA, ordinalsRVA] = [e.u32(16), e.u32(20), e.u32(24), e.u32(28), e.u32(32), e.u32(36)];
        if (functions > MAX_SYMBOLS || named > MAX_SYMBOLS) fail("too many exports");
        const addresses = fields(await atRVA(functionsRVA, functions * 4), true);
        const nameOf = new Map();
        if (named) {
            const nameRVAs = fields(await atRVA(namesRVA, named * 4), true), ordinals = fields(await atRVA(ordinalsRVA, named * 2), true);
            // The names are one after another, mostly: read as one piece.
            let low = Infinity, high = 0;
            for (let i = 0; i < named; i++) { const rva = nameRVAs.u32(i * 4); low = Math.min(low, rva); high = Math.max(high, rva); }
            const span = Math.min(high - low + MAX_NAME, MAX_TABLE);
            const text = await atRVA(low, span);
            for (let i = 0; i < named; i++) nameOf.set(ordinals.u16(i * 2), nameAt(text, nameRVAs.u32(i * 4) - low));
        }
        for (let i = 0; i < functions; i++) {
            const rva = addresses.u32(i * 4);
            if (!rva || (rva >= exportsRVA && rva < exportsRVA + exportsSize)) continue;
            add(nameOf.get(i) || `#${ordinalBase + i}`, base + rva, 0, "func");
        }
    });
    // What it takes from others: each import's slot, which the loader
    // fills with the function's address, and calls read.
    const slots = new Map(); // a slot's address to the function's name
    const [importsRVA] = directory(1);
    if (importsRVA) await part(async () => {
        const width = wide ? 8 : 4;
        for (let n = 0; n < 4096; n++) {
            const d = fields(await atRVA(importsRVA + n * 20, 20), true);
            const [lookupRVA, nameRVA, slotsRVA] = [d.u32(0), d.u32(12), d.u32(16)];
            if (!nameRVA && !slotsRVA) break;
            const library = (await textAtRVA(nameRVA)).replace(/\.dll$/i, "");
            // Its list, to the entry that ends it, read some at a time (as
            // many as one file gives another, and more, at most).
            for (let i = 0, list = null, f = null; i < 16384 && !full(); i++) {
                const k = i % 512;
                if (!k) {
                    list = await atRVA((lookupRVA || slotsRVA) + i * width, 512 * width);
                    f = fields(list, true);
                }
                if ((k + 1) * width > list.length) break;
                const low = f.u32(k * width), high = wide ? f.u32(k * width + 4) : 0;
                if (!low && !high) break;
                const byNumber = wide ? (high & 0x80000000) !== 0 : (low & 0x80000000) !== 0;
                const name = byNumber ? `#${low & 0xffff}` : await textAtRVA((low & 0x7fffffff) + 2);
                add(`${library}!${name}`, base + slotsRVA + i * width, width, "import");
                if (name) slots.set(base + slotsRVA + i * width, byNumber ? `${library}!${name}` : name);
            }
        }
    });
    // The stubs that jump through those slots, which calls to another
    // file's function go to where the compiler makes them (MinGW's do; a
    // stripped program has no other name for them): x86's jmp [slot] and
    // x86-64's jmp [rip+…], six bytes, named as the function (Sleep, for
    // the slot KERNEL32!Sleep). Looked for in the code that's in the file,
    // no more of it than of any table.
    if (slots.size && (machine === 0x8664 || machine === 0x14c || machine === 0xaa64)) await part(async () => {
        let left = MAX_TABLE;
        for (let i = 0; i < raw.length && left > 0; i++) {
            const s = sections[i];
            if (s.flags[2] !== "x" || !s.size || s.address == null) continue;
            const code = await get(s.offset, Math.min(s.size, left)), view = new DataView(code.buffer, code.byteOffset, code.byteLength);
            left -= code.length;
            // A stub stands alone: after padding (nop, int3), a ret, or the
            // stub before it. The same jump at a function's end (after its
            // pops, or with a REX prefix) is that function's, going on to
            // another: not something of that name.
            if (machine === 0xaa64) {
                // ARM64's: adrp x16, page; ldr x16, [x16, #offset]; br x16.
                // (x16 is the register kept for such stubs, so the three
                // together aren't taken for a function's own.)
                for (let at = (4 - s.address % 4) % 4; at + 12 <= code.length; at += 4) {
                    const adrp = view.getUint32(at, true), ldr = view.getUint32(at + 4, true);
                    if ((adrp & 0x9f00001f) >>> 0 !== 0x90000010 || (ldr & 0xffc003ff) >>> 0 !== 0xf9400210 || view.getUint32(at + 8, true) !== 0xd61f0200) continue;
                    const here = s.address + at;
                    const name = slots.get(adrpPage(adrp, here) + (ldr >>> 10 & 0xfff) * 8);
                    if (name) add(name, here, 12, "plt");
                }
                continue;
            }
            let after = 0;
            for (let at = 0; at + 6 <= code.length; at++) {
                if (code[at] !== 0xff || code[at + 1] !== 0x25) continue;
                const name = slots.get(wide ? s.address + at + 6 + view.getInt32(at + 2, true) : view.getUint32(at + 2, true));
                if (!name) continue;
                if (at === after || [0x90, 0xcc, 0xc3].includes(code[at - 1])) {
                    add(name, s.address + at, 6, "plt");
                    after = at + 6;
                }
                at += 5;
            }
        }
    });
    // A compiler's own table of symbols, where it's left in.
    if (symbolsAt > 0 && symbolCount > 0 && symbolsAt + symbolCount * 18 <= size) await part(async () => {
        if (symbolCount * 18 > MAX_TABLE) truncated = true;
        const list = await get(symbolsAt, Math.min(symbolCount * 18, MAX_TABLE - MAX_TABLE % 18)), f = fields(list, true);
        for (let i = 0; (i + 1) * 18 <= list.length; i++) {
            const [value, section, type, storage, extra] = [f.u32(i * 18 + 8), f.u16(i * 18 + 12), f.u16(i * 18 + 14), f.u8(i * 18 + 16), f.u8(i * 18 + 17)];
            const name = f.u32(i * 18) === 0 ? nameAt(strings, f.u32(i * 18 + 4)) : nameAt(list.subarray(i * 18, i * 18 + 8), 0);
            i += extra;
            // Those in a section, seen from outside it or a function: not a section's own name.
            if (!section || section > raw.length || (storage !== 2 && !(storage === 3 && type === 0x20)) || /^\.[a-z]/.test(name)) continue;
            add(name, base + raw[section - 1].rva + value, 0, type === 0x20 ? "func" : "");
        }
    });
    const mode = { 0x8664: "x86-64", 0x14c: "x86-32", 0xaa64: "arm64", 0x1c0: "arm32", 0x1c2: "thumb", 0x1c4: "thumb" }[machine] ?? null;
    return {
        format: "PE", bits: wide ? 64 : 32, little: true, machine: PE_MACHINES[machine] ?? `machine 0x${machine.toString(16)}`,
        kind: characteristics & 0x2000 ? "DLL" : "executable", mode,
        entry: entryRVA && Number.isSafeInteger(base + entryRVA) ? base + entryRVA : null, relocatable: false, sections, symbols, truncated: truncated || full(),
    };
}

const MACHO_MACHINES = { 7: "x86", 0x01000007: "x86-64", 12: "ARM", 0x0100000c: "ARM64", 0x0200000c: "ARM64 (32-bit pointers)", 18: "PowerPC", 0x01000012: "PowerPC64" };
const MACHO_KINDS = { 1: "relocatable object", 2: "executable", 4: "core dump", 6: "dynamic library", 7: "dynamic linker", 8: "bundle", 10: "debug symbols file", 11: "kernel extension" };
// How a Mach-O begins: feedface (32-bit) or feedfacf (64-bit), in the byte
// order its numbers are in. {wide, little}, or null.
function machoMagic(head, at = 0) {
    const magic = head[at] << 24 | head[at + 1] << 16 | head[at + 2] << 8 | head[at + 3];
    return { [0xfeedface | 0]: { wide: false, little: false }, [0xfeedfacf | 0]: { wide: true, little: false },
        [0xcefaedfe | 0]: { wide: false, little: true }, [0xcffaedfe | 0]: { wide: true, little: true } }[magic] ?? null;
}

// A Mach-O (macOS's and iOS's programs, .dylib libraries and .o files): one
// that's alone in the file, or one of the several a universal file holds
// (a slice, from `start` for `length` bytes; every offset inside it is from
// its own start, and `get` here reads from there, so what's said of the
// file is said once, where a section is made).
async function readMachO(get, start, length) {
    const within = async (offset, count) => {
        if (!(offset >= 0 && count >= 0 && offset + count <= length)) fail("outside the slice");
        return get(start + offset, count);
    };
    const kind = machoMagic(await within(0, 4)) ?? fail("not a Mach-O");
    const { wide, little } = kind, word = wide ? 8 : 4;
    const head = fields(await within(0, wide ? 32 : 28), little);
    const [machine, subtype, type, commands, commandsSize] = [head.u32(4), head.u32(8) & 0xffffff, head.u32(12), head.u32(16), head.u32(20)];
    if (commandsSize > MAX_PART || commands > 65536) fail("too many load commands");
    const table = await within(wide ? 32 : 28, commandsSize);
    let truncated = false;
    const sections = [], raw = [], segments = [];
    let symbolTable = null, indirect = null, entryOffset = null;
    // The load commands, each saying how long it is (one that says less than
    // its own header, or more than is left, ends them).
    for (let at = 0, n = 0; n < commands && at + 8 <= table.length; n++) {
        const c = fields(table.subarray(at), little), command = c.u32(0), commandSize = c.u32(4);
        if (commandSize < 8 || at + commandSize > table.length) { truncated = true; break; }
        const segment = command === (wide ? 0x19 : 1), headed = wide ? 72 : 56, each = wide ? 80 : 68;
        if (segment && commandSize >= headed) {
            const name = nameAt(table.subarray(at + 8, at + 24), 0);
            const [address, memSize, offset, fileSize, protection, count] = wide
                ? [c.u64(24), c.u64(32), c.u64(40), c.u64(48), c.u32(60), c.u32(64)] : [c.u32(24), c.u32(28), c.u32(32), c.u32(36), c.u32(44), c.u32(48)];
            const flags = `${protection & 1 ? "r" : "-"}${protection & 2 ? "w" : "-"}${protection & 4 ? "x" : "-"}`;
            const has = offset >= 0 && fileSize > 0 && offset + fileSize <= length;
            if (has && address >= 0) segments.push({ offset, size: fileSize, address });
            // (No more sections than its command has room for.)
            const held = Math.min(count, Math.floor((commandSize - headed) / each));
            for (let i = 0; i < held; i++) {
                if (raw.length >= MAX_SECTIONS) { truncated = true; break; }
                const s = fields(table.subarray(at + headed + i * each, at + headed + (i + 1) * each), little);
                const [sectionAddress, sectionSize, sectionOffset, bits, first, second] = wide
                    ? [s.u64(32), s.u64(40), s.u32(48), s.u32(64), s.u32(68), s.u32(72)] : [s.u32(32), s.u32(36), s.u32(40), s.u32(56), s.u32(60), s.u32(64)];
                // (Zero-filled: no bytes in the file.)
                const filed = ![1, 12, 18].includes(bits & 0xff) && sectionOffset > 0 && sectionSize > 0 && sectionOffset + sectionSize <= length;
                const section = { name: `${nameAt(table.subarray(at + headed + i * each + 16, at + headed + i * each + 32), 0)},${nameAt(table.subarray(at + headed + i * each, at + headed + i * each + 16), 0)}`,
                    offset: filed ? start + sectionOffset : Math.min(start + sectionOffset, start + length), size: filed ? sectionSize : 0,
                    address: sectionAddress >= 0 ? sectionAddress : null, memSize: sectionSize >= 0 ? sectionSize : 0, flags };
                sections.push(section);
                raw.push({ section, kind: bits & 0xff, code: (bits & 0x80000400) !== 0, first, second, address: sectionAddress, size: sectionSize });
            }
            // One with no sections of its own (__LINKEDIT, where the tables are) is shown whole.
            if (!count && has) sections.push({ name: name || "(unnamed segment)", offset: start + offset, size: fileSize, address: address >= 0 ? address : null, memSize: memSize >= 0 ? memSize : fileSize, flags });
        } else if (command === 2 && commandSize >= 24) symbolTable = { offset: c.u32(8), count: c.u32(12), strings: c.u32(16), stringsSize: c.u32(20) };
        else if (command === 0xb && commandSize >= 64) indirect = { offset: c.u32(56), count: c.u32(60) };
        else if (command === 0x80000028 && commandSize >= 16) entryOffset = c.u64(8);
        at += commandSize;
    }
    // (Cut off before anything was said: nothing to show of it.)
    if (truncated && !sections.length) fail("no load command that holds together");
    // Where in memory an offset in the slice is, by the segment it's in.
    const addressOf = (offset) => {
        for (const s of segments) if (offset >= s.offset && offset - s.offset < s.size) return s.address + offset - s.offset;
        return null;
    };
    const { symbols, add, full } = sink();
    // Each table apart: one that doesn't hold together leaves the sections as they are.
    const part = (work) => apart(work, () => { truncated = true; });
    // Its symbols: those that are somewhere in it (not a debugger's, nor
    // another file's, which have no address here); and every one's name by
    // its number, for the stubs and slots below.
    const named = [];
    if (symbolTable) await part(async () => {
        const each = wide ? 16 : 12;
        let count = symbolTable.count;
        if (count * each > MAX_TABLE) { count = Math.floor(MAX_TABLE / each); truncated = true; }
        if (symbolTable.stringsSize > MAX_TABLE) truncated = true;
        const strings = await within(symbolTable.strings, Math.min(symbolTable.stringsSize, MAX_TABLE));
        const list = await within(symbolTable.offset, count * each);
        for (let i = 0; i < count; i++) {
            const e = fields(list.subarray(i * each, (i + 1) * each), little);
            const [type, section, value] = [e.u8(4), e.u8(5), wide ? e.u64(8) : e.u32(8)];
            const name = nameAt(strings, e.u32(0));
            named.push(name);
            if (type & 0xe0 || (type & 0x0e) !== 0x0e || !section || section > raw.length) continue;
            add(name, value, 0, raw[section - 1].code ? "func" : "object");
        }
    });
    // What it takes from other files: the stubs calls go to, and the slots
    // they jump through or data is reached by. Which symbol each is for is in
    // a table of symbols' numbers (the "indirect" one), from where each such
    // section says; it's there even in a stripped program, and whichever way
    // the slots are filled when it's loaded.
    if (indirect && named.length) await part(async () => {
        if (indirect.count > MAX_TABLE / 4) fail("too many indirect symbols");
        const list = fields(await within(indirect.offset, indirect.count * 4), little);
        // (Each entry of the table is one section's: all the sections' are
        // no more than there are entries. A file whose sections each say
        // the whole table is theirs isn't gone through for each.)
        let left = indirect.count;
        for (const s of raw) {
            // Stubs, each as long as the section says; pointers, each a pointer.
            const each = s.kind === 8 ? s.second : [6, 7, 0x10, 0x14].includes(s.kind) ? word : 0;
            if (!each || !(s.address >= 0) || !(s.size > 0)) continue;
            for (let i = 0; i < Math.floor(s.size / each) && s.first + i < indirect.count; i++) {
                if (left-- <= 0) fail("more stubs and slots than there are indirect symbols");
                // (Not a symbol's number: one of its own, or none.)
                const number = list.u32((s.first + i) * 4);
                if (number & 0xc0000000 || number >= named.length || !named[number]) continue;
                add(s.kind === 8 ? named[number] : `${named[number]}@got`, s.address + i * each, each, s.kind === 8 ? "plt" : "got");
                if (full()) return;
            }
        }
    });
    const arm64e = machine === 0x0100000c && subtype === 2;
    const mode = little ? { 7: "x86-32", 0x01000007: "x86-64", 12: "arm32", 0x0100000c: "arm64", 0x0200000c: "arm64" }[machine] ?? null : null;
    return {
        format: "Mach-O", bits: wide ? 64 : 32, little, machine: (MACHO_MACHINES[machine] ?? `machine ${machine}`) + (arm64e ? " (arm64e)" : ""),
        kind: MACHO_KINDS[type] ?? `type ${type}`, mode, entry: entryOffset == null || !(entryOffset >= 0) ? null : addressOf(entryOffset), relocatable: false,
        sections, symbols, truncated: truncated || full(),
    };
}

// A universal file's slices (a program for each of several machines, one
// after another): [{machine, offset, size}], or null if it isn't one. It
// begins cafebabe, as a Java class does too: it's one only if each slice
// it lists is in the file and begins as a Mach-O.
async function machoSlices(get, head, size) {
    const view = fields(head, false), wide = view.u32(0) === 0xcafebabf, count = view.u32(4), each = wide ? 32 : 20;
    if ((view.u32(0) !== 0xcafebabe && !wide) || !count || count > 64 || 8 + count * each > size) return null;
    const list = fields(await get(8, count * each), false), slices = [];
    for (let i = 0; i < count; i++) {
        const [machine, subtype, offset, length] = [list.u32(i * each), list.u32(i * each + 4) & 0xffffff, wide ? list.u64(i * each + 8) : list.u32(i * each + 8), wide ? list.u64(i * each + 16) : list.u32(i * each + 12)];
        if (!(offset >= 8 + count * each && length >= 28 && offset + length <= size) || !machoMagic(await get(offset, 4))) return null;
        slices.push({ machine: (MACHO_MACHINES[machine] ?? `machine ${machine}`) + (machine === 0x0100000c && subtype === 2 ? " (arm64e)" : ""), offset, size: length });
    }
    return slices;
}

// readExecutable reads what the file of size bytes says of itself, with
// read(begin, end), which gives those bytes as a Uint8Array; null, if it
// isn't an ELF, a PE or a Mach-O that holds together. Of a universal file
// (see machoSlices), what its slice of that number says (the first, if
// not said), with all of them listed in slices, and which it is, in slice.
export async function readExecutable(read, size, { slice = 0 } = {}) {
    if (!(size >= 64)) return null;
    try {
        const get = reader(read, size);
        const head = await get(0, 64);
        const elf = head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46;
        const slices = elf ? null : await machoSlices(get, head, size);
        if (!elf && !slices && !machoMagic(head) && !(head[0] === 0x4d && head[1] === 0x5a)) return null;
        const chosen = slices?.[slice] ?? slices?.[0];
        const info = await (elf ? readELF(get, head, size) : chosen ? readMachO(get, chosen.offset, chosen.size)
            : machoMagic(head) ? readMachO(get, 0, size) : readPE(get, head, size));
        if (slices) Object.assign(info, { slices, slice: slices.indexOf(chosen) });
        info.sections.sort((a, b) => a.offset - b.offset || a.size - b.size);
        // By address; of those at one, a function's name first, then the shorter.
        const rank = { func: 0, plt: 0, object: 1, import: 1, got: 2, "": 3 };
        info.symbols.sort((a, b) => a.address - b.address || rank[a.kind] - rank[b.kind] || a.name.length - b.name.length || (a.name < b.name ? -1 : 1));
        return info;
    } catch (err) {
        // Not one after all (or cut short); anything else is a fault to see.
        if (err instanceof NotOne || err instanceof RangeError) return null;
        throw err;
    }
}

// programMap is how info's addresses and the file's offsets go together:
// addressOf(offset) and offsetOf(address), each null where there's none
// (bytes that aren't loaded; an address with no bytes in the file, as
// .bss's); sectionAt(offset) and sectionOf(address); and symbolAt(address),
// the symbol there or the one it's inside, {name, delta, symbol}, or null.
const DEEP = 1024; // how many symbols around one, each inside the next, are looked through for the one an address is in
export function programMap(info) {
    const filed = info.sections.filter((s) => s.size > 0), mapped = filed.filter((s) => s.address != null);
    const loaded = info.sections.filter((s) => s.address != null && s.memSize > 0);
    // (A section inside another, as a segment's, is the nearer: the later, smaller one.)
    const within = (list, value, from, length) => {
        let found = null;
        for (const s of list) if (value >= s[from] && value - s[from] < s[length] && (!found || s[length] <= found[length])) found = s;
        return found;
    };
    const symbols = info.symbols;
    const sectionOf = (address) => within(loaded, address, "address", "memSize");
    // around[i]: the nearest symbol before symbols[i] that says how long it
    // is and hasn't ended where symbols[i] begins (-1: none): the one it's
    // inside, if any. Found once, going through them in order with those
    // still open kept; so an address past a small symbol that's inside a
    // larger is found in the larger without going back through every
    // symbol between.
    const around = new Int32Array(symbols.length).fill(-1), open = [];
    symbols.forEach((s, i) => {
        while (open.length && symbols[open.at(-1)].address + symbols[open.at(-1)].size <= s.address) open.pop();
        if (open.length) around[i] = open.at(-1);
        if (s.size > 0) open.push(i);
    });
    const inside = (symbol, address) => ({ name: symbol.name, delta: address - symbol.address, symbol });
    return {
        // (One that's loaded, where there is one: the one addressOf goes by,
        // so a place's section and its address are the same section's even
        // where one that isn't loaded lies over it.)
        sectionAt: (offset) => within(mapped, offset, "offset", "size") ?? within(filed, offset, "offset", "size"),
        sectionOf,
        addressOf(offset) {
            const s = within(mapped, offset, "offset", "size");
            return s ? s.address + offset - s.offset : null;
        },
        offsetOf(address) {
            const s = within(mapped, address, "address", "size");
            return s ? s.offset + address - s.address : null;
        },
        symbolAt(address) {
            let low = 0, high = symbols.length;
            while (low < high) {
                const mid = (low + high) >> 1;
                if (symbols[mid].address <= address) low = mid + 1; else high = mid;
            }
            if (!low) return null;
            // The first of those at that address (the best named; see the sort).
            let at = low - 1;
            while (at > 0 && symbols[at - 1].address === symbols[at].address) at--;
            const nearest = symbols[at], delta = address - nearest.address;
            if (delta === 0) return inside(nearest, address);
            // Inside one of those at that address, by its size: the best
            // named of them that it's in, as at its start.
            for (let k = at; k < low; k++) if (symbols[k].size > delta) return inside(symbols[k], address);
            // Inside the nearest, where it gives no size (a PE's and a
            // Mach-O's have none; a label in a function has none either), by
            // being in its section, and not far; and, where it's inside one
            // that says how long it is, no further than that one's end.
            const held = around[at] < 0 || address - symbols[around[at]].address < symbols[around[at]].size;
            if (!nearest.size && held && delta < 65536 && sectionOf(address) && sectionOf(address) === sectionOf(nearest.address)) return inside(nearest, address);
            // Inside one around those: the nearest of them it's in (see around).
            for (let k = around[at], steps = 0; k >= 0 && steps < DEEP; k = around[k], steps++) {
                if (address - symbols[k].address < symbols[k].size) return inside(symbols[k], address);
            }
            return null;
        },
    };
}
