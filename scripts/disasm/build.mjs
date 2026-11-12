// Makes iced-x86's npm build, which is for Node (it reads its WebAssembly
// with require("fs") as it loads), loadable in a browser worker with
// importScripts: its exports kept to itself, and its WebAssembly started by
// self.icedInit(bytes), which resolves to them. Its documentation comments,
// about two fifths of it, are left out: whole lines of them only, so none
// in a string is touched. Then checks it disassembles as it should, so a
// new version that's built differently fails the build rather than the hex
// view.
//
// With x86-asm.js (tabtopd's assembler), checks that too: lines as a person
// types them, and lines as the disassembly shows them, from random bytes,
// assemble to what decodes back to the same.
//
// node build.mjs <iced-x86 package dir> <output dir> [x86-asm.js]
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const [from, to, assemblerFile] = process.argv.slice(2);
if (!from || !to) throw new Error("usage: node build.mjs <iced-x86 package dir> <output dir>");
const source = readFileSync(join(from, "iced_x86.js"), "utf8");

// What loads the WebAssembly in Node, as wasm-bindgen writes it.
const nodeLoad = /\nconst wasmPath = [^\n]*\nconst wasmBytes = require\('fs'\)\.readFileSync\(wasmPath\);\nconst wasmModule = new WebAssembly\.Module\(wasmBytes\);\nlet wasmInstance = new WebAssembly\.Instance\(wasmModule, __wbg_get_imports\(\)\);\nlet wasm = wasmInstance\.exports;\nwasm\.__wbindgen_start\(\);\s*$/;
if (!nodeLoad.test(source)) throw new Error("iced_x86.js doesn't end as expected: its loading has changed");
const browser = source.replace(nodeLoad, `
let wasm;
self.icedInit = async (bytes) => {
    const { instance } = await WebAssembly.instantiate(bytes, __wbg_get_imports());
    wasm = instance.exports;
    wasm.__wbindgen_start();
    return exports;
};
`);
// Comments that are whole lines: /** … */ blocks, starting a line and
// ending one, and // lines.
const code = browser.replace(/^[ \t]*\/\*\*[\s\S]*?\*\/[ \t]*\n/gm, "").replace(/^[ \t]*\/\/.*\n/gm, "");
// Nothing else of Node's.
if (/\brequire\s*\(|\b__dirname\b|\bprocess\./.test(code)) throw new Error("iced_x86.js uses Node's modules elsewhere too");

const out = `// iced-x86 (MIT; see LICENSE.iced), made loadable in a worker by build.mjs.
(() => {
"use strict";
const exports = {};
${code}
})();
`;
mkdirSync(to, { recursive: true });
writeFileSync(join(to, "iced.js"), out);
copyFileSync(join(from, "iced_x86_bg.wasm"), join(to, "iced_x86_bg.wasm"));
copyFileSync(join(from, "LICENSE.txt"), join(to, "LICENSE.iced"));

// As the worker uses it: a few instructions, and one that isn't.
const self = {};
new Function("self", out)(self);
const iced = await self.icedInit(readFileSync(join(to, "iced_x86_bg.wasm")));
const disassemble = (bitness, bytes, ip) => {
    const decoder = new iced.Decoder(bitness, Uint8Array.from(bytes), iced.DecoderOptions.None);
    decoder.ip = BigInt(ip);
    const formatter = new iced.Formatter(iced.FormatterSyntax.Intel);
    const lines = [];
    while (decoder.canDecode) {
        const insn = decoder.decode();
        lines.push(`${insn.ip.toString(16)} ${insn.length} ${insn.isInvalid ? "(bad)" : formatter.format(insn)}`);
        insn.free();
    }
    decoder.free();
    formatter.free();
    return lines;
};
assert.deepEqual(disassemble(64, [0x55, 0x48, 0x89, 0xe5, 0xc3], 0x1000), ["1000 1 push rbp", "1001 3 mov rbp,rsp", "1004 1 ret"]);
assert.deepEqual(disassemble(32, [0x89, 0xe5], 0), ["0 2 mov ebp,esp"]);
assert.equal(disassemble(64, [0x06], 0)[0], "0 1 (bad)");
console.log(`iced-x86 for the browser: ${(out.length / 1024).toFixed(0)} KB of script, checked`);

if (assemblerFile) {
    new Function("self", readFileSync(assemblerFile, "utf8"))(self);
    const { assemble } = self.makeAssembler(iced);
    const hex = (bytes) => Buffer.from(bytes).toString("hex");
    const lines = [
        [64, 0x1000, "push rbp", "55"], [64, 0x1000, "mov rbp, rsp", "4889e5"], [64, 0x1000, "jz 0x1010", "740e"],
        [64, 0x1000, "call 0x2000", "e8fb0f0000"], [64, 0x1000, "mov dword ptr [rbp-4], 0", "c745fc00000000"],
        [64, 0x1000, "lea rsi,[rip+0x10]", "488d3510000000"], [64, 0x1000, "mov rax,[abs 0x10]", "488b042510000000"],
        [64, 0x1000, "rep stosb", "f3aa"], [64, 0x1000, "fld qword [rax]", "dd00"], [64, 0x1000, "mov al, 'A'", "b041"],
        [64, 0x1000, "vaddps zmm1{k1}{z}, zmm2, dword bcst [rax]", "62f16cd95808"], [64, 0x1000, "vaddps zmm0, zmm1, zmm2, {rn-sae}", "62f1741858c2"],
        [64, 0x1000, "vpgatherdd xmm0,[rax+xmm1*4],xmm2", "c4e269900488"], [32, 0x1000, "jmp far 0x10:0x2000", "ea002000001000"],
        [16, 0x100, "mov ax, [bx+si+4]", "8b4004"], [16, 0x100, "int 21h", "cd21"],
        // [addr]: RIP-relative, but through fs (the stack guard), or over an
        // absolute one, absolute.
        [64, 0x1000, "mov eax,[0x10]", "8b050af0ffff"], [64, 0x1000, "mov rax,qword ptr fs:[28h]", "64488b042528000000"],
        [64, 0x1000, "mov ecx,[10h]", "8b0c2510000000", "8b042510000000"],
    ];
    for (const [bitness, at, text, want, was] of lines)
        assert.equal(hex(assemble(text, at, bitness, was ? Buffer.from(was, "hex") : null).bytes), want, text);
    for (const [bitness, text] of [[64, "inc [rax]"], [64, "foo eax"], [64, "jmp short 0x2000"], [64, "mov eax, rbx"], [64, "aaa"]])
        assert.throws(() => assemble(text, 0x1000, bitness), Error, text);
    // Random bytes, as each mode decodes them: whatever's shown assembles
    // to what's shown again (or, rarely, can't be; never another).
    const formatter = new iced.Formatter(iced.FormatterSyntax.Intel);
    formatter.usePseudoOps = false; // as disasm-worker.js shows them
    let seed = 1;
    const random = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
    const leads = [[], [0x62], [0xc4], [0xc5], [0x0f], [0x66, 0x0f], [0xf3, 0x0f], [0xf2, 0x0f], [0xd8], [0xdc], [0xde], [0xdd], [0x0f, 0x38], [0x0f, 0x3a], [0x8f]];
    for (const bitness of [64, 32, 16]) {
        let shown = 0, assembled = 0;
        for (let t = 0; t < 6000; t++) {
            const b = new Uint8Array(15);
            b.set(leads[t % leads.length]);
            for (let i = leads[t % leads.length].length; i < 15; i++) b[i] = random() * 256 | 0;
            const decoder = new iced.Decoder(bitness, b, iced.DecoderOptions.None);
            decoder.ip = 0x4000n;
            const insn = decoder.decode();
            // As shown, and whether its address is RIP-relative, which the
            // text doesn't say; with the bytes it was, as the hex view asks.
            const text = insn.isInvalid ? null : formatter.format(insn);
            const ripRelative = !insn.isInvalid && insn.isIpRelMemoryOperand, was = b.slice(0, insn.length);
            insn.free();
            decoder.free();
            if (text == null) continue;
            shown++;
            let result;
            try { result = assemble(text, 0x4000, bitness, was); } catch { continue; }
            const again = new iced.Decoder(bitness, result.bytes, iced.DecoderOptions.None);
            again.ip = 0x4000n;
            const back = again.decode();
            const text2 = formatter.format(back), ripRelative2 = back.isIpRelMemoryOperand;
            back.free();
            again.free();
            assert.ok((text2 === text || text2.replace(" short ", " ") === text) && ripRelative2 === ripRelative,
                `${bitness}-bit ${text}${ripRelative ? " (RIP-relative)" : ""} came back as ${text2}${ripRelative2 ? " (RIP-relative)" : ""}`);
            assembled++;
        }
        assert.ok(assembled >= shown * 0.99, `${bitness}-bit: ${assembled} of ${shown} assembled`);
    }
    console.log("x86-asm.js: checked");
}
