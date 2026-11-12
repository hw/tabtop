import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { cellText, columnKind } from "../tabtopd/sqlite-view.js";
import { typeOf, limits, binaryChunkSize, probablyDatabase } from "../tabtopd/preview-model.js";

test("values show as SQLite has them: NULL, exact integers, reals, cut text, blobs", () => {
    assert.deepEqual(cellText(null), { text: "NULL", className: "null" });
    assert.deepEqual(cellText({ i: "-9223372036854775808" }), { text: "-9223372036854775808", className: "type-number" });
    assert.equal(cellText({ r: -1.5 }).text, "-1.5");
    assert.equal(cellText({ r: "+Inf" }).text, "Inf");
    assert.deepEqual(cellText({ t: "" }), { text: "", className: "" });
    const cut = cellText({ t: "abc", cut: true, n: 10000 });
    assert.equal(cut.text, "abc…");
    assert.match(cut.title, /10,000 bytes; the first 3 characters/);
    assert.equal(cellText({ b: "00ff10", n: 3 }).text, "blob, 3 bytes: 00 ff 10");
    assert.equal(cellText({ b: "0000", n: 100000 }).text, "blob, 100,000 bytes: 00 00 …");
    assert.equal(cellText({ b: "", n: 0 }).text, "blob, 0 bytes");
});

test("databases by name, and by their first bytes when the name doesn't say", () => {
    for (const name of ["a.sqlite", "B.SQLITE3", "c.db3"]) assert.equal(typeOf(name)?.kind, "sqlite", name);
    assert.equal(typeOf("x.db"), null);
    assert.equal(probablyDatabase("x.db"), true);
    assert.equal(probablyDatabase("x.dbx"), false);
    assert.equal(limits.sqlite, Number.MAX_SAFE_INTEGER);
});

test("loading: a database's schema; one by its bytes in auto; a misnamed one in hex; the bytes of one in hex can switch back", async () => {
    const source = readFileSync(new URL("../tabtopd/preview-loaders.js", import.meta.url), "utf8")
        .replace(/^import .*;\n/gm, "").replace("export async function loadPreview", "async function loadPreview");
    const magic = new TextEncoder().encode("SQLite format 3\0");
    let content = Uint8Array.from([...magic, 0x10, 0, 1, 1]);
    let database = true, busy = false;
    const requests = [];
    const env = { typeOf, limits, binaryChunkSize, TextDecoder, Blob, join: (d, n) => `${d}/${n}`,
        call: async (req) => {
            requests.push(req);
            if (req.type === "sqlite") {
                if (busy) throw new Error("Other databases are being read; try again in a moment.");
                if (!database) throw Object.assign(new Error("It isn't an SQLite database (or it's encrypted)."), { code: "not-database" });
                return { reply: { size: content.length, mtime: "1", answer: { objects: [{ type: "table", name: "t" }] }, wal: true }, close() {} };
            }
            return { reply: { size: content.length, mtime: "1", length: Math.min(content.length, req.length ?? content.length) }, close() {} };
        },
        collect: async (_t, _size, _progress, type) => new Blob([content], { type }) };
    runInNewContext(`${source}\nglobalThis.loadPreview = loadPreview;`, env);

    const named = await env.loadPreview("d", "data.sqlite");
    assert.equal(named.file.kind, "sqlite");
    assert.equal(named.file.sqlite, true);
    assert.equal(named.file.wal, true);
    assert.equal(named.file.schema.objects[0].name, "t");
    assert.equal(named.blob, null);

    const sniffed = await env.loadPreview("d", "data.db", { mode: "auto" });
    assert.equal(sniffed.file.kind, "sqlite");
    assert.deepEqual(requests.slice(-2).map((r) => r.type), ["file", "sqlite"]);

    // Busy, found by its bytes: those bytes, its tables a click away, not a failure.
    busy = true;
    const kept = await env.loadPreview("d", "data.db", { mode: "auto" });
    assert.equal(kept.file.kind, "hex");
    assert.equal(kept.file.sqlite, true);
    busy = false;

    const bytes = await env.loadPreview("d", "data.sqlite", { mode: "hex" });
    assert.equal(bytes.file.kind, "hex");
    assert.equal(bytes.file.sqlite, true, "its bytes, with its tables a click away");

    // Named a database, starting as one, but SQLite can't read it (damaged):
    // its bytes.
    database = false;
    const damaged = await env.loadPreview("d", "damaged.sqlite");
    assert.equal(damaged.file.kind, "hex");
    // Named a database, but not starting as one: its bytes, the server
    // never asked to open it as a database.
    content = new TextEncoder().encode("plain words, no database");
    const asked = requests.length;
    const misnamed = await env.loadPreview("d", "notes.sqlite");
    assert.equal(misnamed.file.kind, "hex");
    assert.equal(misnamed.file.sqlite, undefined);
    assert.deepEqual(requests.slice(asked).map((r) => r.type), ["file", "file"]);
    assert.equal(requests[asked].length, 16, "only its first bytes, to tell");
    // Not a database by its bytes either: as an unknown file always was.
    const text = await env.loadPreview("d", "notes.db", { mode: "auto" });
    assert.equal(text.file.kind, "text");
    assert.equal(requests.at(-1).type, "file");
    // Other failures are said, not hidden.
    env.call = async () => { throw new Error("Other databases are being read; try again in a moment."); };
    await assert.rejects(env.loadPreview("d", "busy.sqlite"), /Other databases/);
});

test("columns are filtered as their declared types say: numbers, dates, or text", () => {
    for (const t of ["INTEGER", "int", "BIGINT", "REAL", "DOUBLE PRECISION", "FLOAT", "NUMERIC", "DECIMAL(10,2)", "BOOLEAN"]) assert.equal(columnKind(t), "number", t);
    for (const t of ["DATE", "DATETIME", "TIMESTAMP", "time"]) assert.equal(columnKind(t), "date", t);
    for (const t of ["TEXT", "VARCHAR(20)", "CLOB", "BLOB", "", undefined]) assert.equal(columnKind(t), "text", String(t));
});
