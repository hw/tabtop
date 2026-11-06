import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { deflateSync } from "node:zlib";

const dir = process.env.KAITAI_ASSETS ?? path.resolve("scripts/kaitai/dist");
const built = existsSync(path.join(dir, "formats.json"));
async function parser(id) {
    const catalog = JSON.parse(readFileSync(path.join(dir, "formats.json")));
    const format = catalog.formats.find(f => f.id === id);
    return import(pathToFileURL(path.join(dir, format.module)));
}

test("the 6502 object-expansion reproducer stops during parsing, before building its graph", { skip: !built }, async () => {
    const { Parser, KaitaiStream } = await parser("code_6502");
    const budget = KaitaiStream._previewBudget;
    budget.reset();
    const root = new Parser(new KaitaiStream(new Uint8Array(100000).fill(0xea).buffer));
    assert.throws(() => root._read(), /allocation preview budget/);
    assert.ok(root.operations.length < 20000);
    assert.equal(budget.stats().depth, 0);
    assert.equal(budget.stats().exhausted, true);
    assert.throws(() => budget.step(), /budget/); // A lazy getter cannot resume an exhausted parse.
    budget.reset();
});

test("deep binary records stop at the nesting limit and unwind their budget", { skip: !built }, async () => {
    const { Parser, KaitaiStream } = await parser("bson");
    let doc = Buffer.from([5, 0, 0, 0, 0]);
    for (let i = 0; i < 300; i++) {
        const size = Buffer.alloc(4); size.writeInt32LE(doc.length + 8);
        doc = Buffer.concat([size, Buffer.from([3, 97, 0]), doc, Buffer.from([0])]);
    }
    KaitaiStream._previewBudget.reset();
    const root = new Parser(new KaitaiStream(doc.buffer.slice(doc.byteOffset, doc.byteOffset + doc.byteLength)));
    assert.throws(() => root._read(), /128-level nesting/);
    assert.equal(KaitaiStream._previewBudget.stats().depth, 0);
    KaitaiStream._previewBudget.reset();
});

test("inflation is cumulative across streams and remains exhausted until a new parse", { skip: !built }, async () => {
    const { KaitaiStream } = await parser("png");
    const budget = KaitaiStream._previewBudget;
    budget.reset();
    const five = deflateSync(Buffer.alloc(5 * 1024 * 1024, 65));
    const four = deflateSync(Buffer.alloc(4 * 1024 * 1024, 66));
    assert.equal(KaitaiStream.processZlib(five).length, 5 * 1024 * 1024);
    assert.throws(() => KaitaiStream.processZlib(four), /cumulative 8 MiB/);
    assert.ok(budget.stats().inflated <= 8 * 1024 * 1024);
    assert.throws(() => KaitaiStream.processZlib(deflateSync(Buffer.of(65))), /cumulative 8 MiB/);
    budget.reset();
    assert.equal(KaitaiStream.processZlib(four).length, 4 * 1024 * 1024);
    budget.reset();
});

test("large transforms are charged before allocating and lazy getters share the remaining budget", { skip: !built }, async () => {
    const { Parser, KaitaiStream } = await parser("elf");
    const budget = KaitaiStream._previewBudget;
    budget.reset();
    const bytes = new Uint8Array(10_000_000);
    for (let i = 0; i < 3; i++) assert.equal(KaitaiStream.processXorOne(bytes, 1).length, bytes.length);
    assert.throws(() => KaitaiStream.processXorOne(bytes, 1), /32 MiB/);
    budget.reset();
    const elf = readFileSync("/bin/ls");
    const root = new Parser(new KaitaiStream(elf.buffer.slice(elf.byteOffset, elf.byteOffset + elf.byteLength)));
    root._read();
    const before = budget.stats();
    assert.ok(root.header.sectionHeaders.length > 0);
    const after = budget.stats();
    assert.ok(after.nodes > before.nodes && after.steps > before.steps);
    budget.reset();
});
