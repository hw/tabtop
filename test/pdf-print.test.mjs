import { test } from "node:test";
import assert from "node:assert/strict";
import { pdfPrintBlob } from "../tabtopd/pdf-print.js";

test("pdfPrintBlob concatenates the start and later ranges in order", async () => {
    const start = Uint8Array.from([1, 2, 3, 4]);
    const reads = [];
    const blob = await pdfPrintBlob("doc.pdf", { size: 9, start, mtime: "1" }, {
        partSize: 2,
        read: async (_path, _file, begin, endAt) => {
            reads.push([begin, endAt]);
            const all = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]);
            return all.slice(begin, endAt).buffer;
        },
    });
    assert.deepEqual(reads, [[4, 6], [6, 8], [8, 9]]);
    assert.equal(blob.type, "application/pdf");
    assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("pdfPrintBlob uses a local start buffer without further reads", async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    let reads = 0;
    const blob = await pdfPrintBlob("local.pdf", { size: 3, start: bytes, local: true }, {
        read: async () => { reads++; return new ArrayBuffer(0); },
    });
    assert.equal(reads, 0);
    assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [9, 8, 7]);
});
