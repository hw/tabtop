import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeStatus } from "../tabtopd/kaitai-errors.js";

const context = { fileSize: 2_000_000, prefixSize: 1_000_000 };
const eof = (read) => ({ name: "EOFError", message: "missing bytes", previewRead: { reason: "eof", file: true,
    offset: 999_998, available: 2, requested: 4, streamOffset: 0, streamSize: 1_000_000, ...read } });

test("missing prefix bytes include the first required offset and exact missing length", () => {
    const result = decodeStatus(eof(), context);
    assert.equal(result.kind, "outside-preview");
    assert.equal(result.offset, 1_000_000);
    assert.equal(result.length, 2);
    assert.equal(decodeStatus(eof({ offset: 1_500_000, available: 0 }), context).offset, 1_500_000);
});

test("file truncation, bounded sections and transformed buffers aren't mistaken for prefix limits", () => {
    assert.equal(decodeStatus(eof(), { ...context, fileSize: 1_000_000 }).kind, "truncated");
    assert.equal(decodeStatus(eof({ offset: 1_999_999, available: 0 }), context).kind, "truncated");
    assert.equal(decodeStatus(eof({ offset: 100, available: 0, streamSize: 100 }), context).kind, "truncated");
    const decoded = decodeStatus(eof({ file: false }), context);
    assert.equal(decoded.kind, "truncated");
    assert.equal(decoded.offset, undefined);
    assert.match(decoded.message, /decoded payload/);
    assert.equal(decodeStatus(eof({ offset: NaN }), context).offset, undefined);
});

test("validation failures and exhausted budgets have distinct, bounded diagnostics", () => {
    assert.equal(decodeStatus({ name: "ValidationNotEqualError", message: "wrong magic" }, context).kind, "format-mismatch");
    assert.equal(decodeStatus({ name: "Error", code: "KAITAI_BUDGET", message: "allocation limit" }, context).kind, "budget");
    const unknown = decodeStatus(new Error("x".repeat(10000)), context);
    assert.equal(unknown.kind, "error");
    assert.ok(unknown.details.length < 1100);
});
