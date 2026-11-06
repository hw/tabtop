import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { parameterValues } from "../tabtopd/kaitai-view.js";

const dir = process.env.KAITAI_ASSETS ?? path.resolve("scripts/kaitai/dist");
const built = existsSync(path.join(dir, "formats.json"));

test("Kaitai parameters validate integers, booleans and byte buffers", () => {
    const params = [{ id: "count", type: "u1" }, { id: "little", type: "bool" }, { id: "header", type: "bytes_with_io" }];
    const inputs = [{ value: "0xff" }, { value: "true" }, { value: "00 ff 20" }];
    assert.deepEqual(parameterValues(params, inputs), [255, true, { bytes: [0, 255, 32] }]);
    for (const value of ["", "-1", "256", "1.5", "Infinity"]) {
        assert.throws(() => parameterValues([params[0]], [{ value }]), /valid u1/);
    }
    assert.throws(() => parameterValues([params[2]], [{ value: "fff" }]), /byte pairs/);
});

test("all bundled gallery parsers import and expose their shared runtime", { skip: !built }, async () => {
    const catalog = JSON.parse(readFileSync(path.join(dir, "formats.json")));
    assert.equal(catalog.formats.length, 191);
    let runtime;
    for (const format of catalog.formats) {
        assert.match(format.module, /^parsers\/[a-z0-9_]+-[A-Z0-9]+\.js$/);
        const module = await import(pathToFileURL(path.join(dir, format.module)));
        assert.equal(typeof module.Parser, "function", format.id);
        runtime ??= module.KaitaiStream;
        assert.equal(module.KaitaiStream, runtime, format.id);
    }
});

test("worker decodes fields, lazily follows sections, and preserves original byte ranges", { skip: !built }, async () => {
    const catalog = JSON.parse(readFileSync(path.join(dir, "formats.json")));
    const messages = [];
    const oldSelf = globalThis.self, oldFetch = globalThis.fetch;
    globalThis.self = { postMessage: m => messages.push(m) };
    globalThis.fetch = async url => ({ ok: true, json: async () => JSON.parse(readFileSync(new URL(url))) });
    try {
        await import("../tabtopd/kaitai-worker.js");
        const parse = async (id, bytes, params = [], size = bytes.length) => {
            const format = catalog.formats.find(f => f.id === id);
            await self.onmessage({ data: { request: 1, type: "parse", format: id, params, size,
                bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
                module: pathToFileURL(path.join(dir, format.module)).href,
                schemas: pathToFileURL(path.join(dir, "schemas.json")).href } });
            const result = messages.at(-1);
            assert.equal(result.error, undefined);
            return result;
        };
        const bytes = readFileSync("/bin/ls");
        const result = await parse("elf", bytes);
        assert.equal(result.warning, "");
        const bits = result.children.find(n => n.label === "bits");
        assert.match(bits.value, /b64/);
        assert.deepEqual(bits.range, { begin: 4, end: 5 });
        assert.equal(bits.path, "elf.bits");
        assert.equal(bits.type, "u1");
        assert.equal(bits.numericHex, "0x2");
        assert.equal(bits.enumName, "Elf.Bits");
        assert.match(bits.doc, /word size/);
        const header = result.children.find(n => n.label === "header");
        assert.equal(header.expandable, true);
        await self.onmessage({ data: { request: 2, type: "expand", id: header.id } });
        const fields = messages.at(-1).children;
        const machine = fields.find(n => n.label === "machine");
        assert.equal(machine.path, "elf.header.machine");
        assert.equal(machine.type, "u2");
        assert.equal(machine.byteOrder, "Little endian");
        const sections = fields.find(n => n.label === "sectionHeaders");
        assert.ok(sections);
        await self.onmessage({ data: { request: 3, type: "expand", id: sections.id } });
        const table = messages.at(-1);
        assert.equal(table.error, undefined);
        assert.ok(table.children.length > 0);
        assert.equal(table.children[0].path, "elf.header.sectionHeaders[0]");
        assert.equal(table.node.label, "sectionHeaders");
        assert.ok(table.node.range.begin > 0);
        const bad = await parse("elf", Uint8Array.of(0, 0, 0, 0));
        assert.match(bad.warning, /Decoding stopped/);
        assert.equal(bad.status.kind, "format-mismatch");
        const truncated = await parse("elf", bytes.subarray(0, 20));
        assert.equal(truncated.status.kind, "truncated");
        assert.ok(truncated.children.some(n => n.label === "bits" && n.value.includes("b64")));
        const prefix = Buffer.alloc(1_000_000); bytes.copy(prefix);
        prefix.writeBigUInt64LE(1_500_000n, 40); // ELF64's section table is outside the decode prefix.
        const partial = await parse("elf", prefix, [], 2_000_000);
        assert.equal(partial.status.kind, "prefix");
        await self.onmessage({ data: { request: 4, type: "expand", id: partial.children.find(n => n.label === "header").id } });
        const sectionNode = messages.at(-1).children.find(n => n.label === "sectionHeaders");
        await self.onmessage({ data: { request: 5, type: "expand", id: sectionNode.id } });
        const outside = messages.at(-1);
        assert.equal(outside.status.kind, "outside-preview");
        assert.equal(outside.status.offset, 1_500_000);
        assert.equal(outside.node.path, "elf.header.sectionHeaders");
        assert.equal(outside.node.state, "incomplete");
        const budget = await parse("code_6502", new Uint8Array(100000).fill(0xea));
        assert.equal(budget.status.kind, "budget");
        assert.ok(budget.children.some(n => n.label === "operations"));
        const bcd = await parse("bcd", Uint8Array.of(0x12, 0x34), [4, 4, false]);
        assert.equal(bcd.warning, "");
        await self.onmessage({ data: { request: 10, type: "parse", bytes: new ArrayBuffer(1_000_001) } });
        assert.match(messages.at(-1).error, /first 1 MB/);
    } finally { globalThis.self = oldSelf; globalThis.fetch = oldFetch; }
});
