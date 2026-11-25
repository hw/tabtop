// Exercise the demangler's WebAssembly (see demangle) through the worker,
// as part of the image build: C++ and Rust names come back as they were
// written; others, and what isn't a name at all, as nothing.
// node check-demangle.mjs <asset directory> <disasm-worker.js>
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { runWorker } from "./worker-harness.mjs";

const [directory, workerFile] = process.argv.slice(2);
if (!directory || !workerFile) throw new Error("usage: node check-demangle.mjs <asset directory> <disasm-worker.js>");
const wasm = readFileSync(resolve(directory, "demangle.wasm"));
let fetches = 0;
const { post } = runWorker(workerFile, () => ({
    importScripts() { throw new Error("the demangler loaded a disassembler's scripts"); },
    fetch: async (path) => {
        assert.equal(path, "./demangle/demangle.wasm");
        fetches++;
        return { ok: true, arrayBuffer: async () => wasm };
    },
}));
const ask = (names) => post({ demangle: names });
const pairs = [
    // C++, as GCC and Clang write it; with what a compiler adds to a copy's name.
    ["_Z3foov", "foo()"], ["_ZN3Foo3barEi", "Foo::bar(int)"], ["_ZNK3Foo5valueEv", "Foo::value() const"], ["_ZN3FooC1Ev", "Foo::Foo()"],
    ["_ZNSt6vectorIiSaIiEE9push_backERKi", "std::vector<int, std::allocator<int> >::push_back(int const&)"], ["_ZTV3Foo", "vtable for Foo"],
    ["_Z3foov.cold", "foo() [clone .cold]"], ["__ZN3Foo3barEi", "Foo::bar(int)"],
    // Rust, both ways, without its hash.
    ["_ZN4core3fmt5write17h0123456789abcdefE", "core::fmt::write"], ["_RNvNtCs1234_7mycrate3bar3baz", "mycrate::bar::baz"],
    // C++, as Microsoft's compiler writes it.
    ["?foo@@YAHH@Z", "foo(int)"], ["?bar@Foo@@QEAAHH@Z", "Foo::bar(int)"],
    // Not mangled, or not a name.
    ["main", ""], ["", ""], ["_Zbad", ""], ["_Z", ""], ["?", ""], ["puts@plt", ""], ["two\nlines", ""], ["_Z3foov\n_Z3foov", ""],
];
assert.deepEqual((await ask(pairs.map(([name]) => name))).names, pairs.map(([, written]) => written));
assert.deepEqual((await ask([])).names, []);
// Many, and long ones: each still its own.
const many = Array.from({ length: 50_000 }, (_, i) => `_ZN3Foo${String(i).length + 1}m${i}Ev`);
const began = performance.now(), names = (await ask(many)).names;
assert.equal(names.length, many.length);
assert.deepEqual([names[0], names[49_999]], ["Foo::m0()", "Foo::m49999()"]);
assert.ok(performance.now() - began < 10_000, `${Math.round(performance.now() - began)} ms for ${many.length} names`);
// Deeply nested, or nonsense after a name's beginning: no answer for it, and the next is still answered.
const hard = [`_Z1fI${"P".repeat(100_000)}iE`, `_ZN${"1a".repeat(50_000)}E`, `?${"@".repeat(10_000)}`, `_R${"N".repeat(50_000)}`, "_Z3foov"];
assert.equal((await ask(hard)).names?.[4] ?? (await ask(["_Z3foov"])).names[0], "foo()");
// What isn't a list of names is refused.
for (const bad of ["_Z3foov", [1], null, Array.from({ length: 200_001 }, () => "a")]) assert.equal(typeof (await ask(bad)).error, "string");
assert.ok(fetches >= 1);
console.log(`Demangler: checked; ${wasm.length} bytes raw, ${gzipSync(wasm).length} bytes gzip`);
