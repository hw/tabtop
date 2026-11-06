import assert from "node:assert/strict";
import test from "node:test";

import { checkJSON, formatJSON, FormatTooBig, JSONError, MAX_DEPTH, parseJSON, parseJSONLines, searchJSON } from "../tabtopd/json-view.js";
import { cellMatches, columnStats, isDate, columnType, compareNumbers, filterColumns, filterRows, filterValueOK, numberKey, parseCSV, sniffCSV, sortRows,
    statText, writeCSV } from "../tabtopd/table-view.js";

test("CSV writing preserves values, ragged rows and quoted empty records", () => {
    const rows = [["name", "note"], ["a,b", 'said "hi"\r\nnext'], [""], ["one"], ["", ""]];
    for (const delimiter of [",", ";", "\t", "|"]) {
        const out = writeCSV(rows, { delimiter, newline: "\r\n", finalNewline: true, bom: true });
        assert.ok(out.startsWith("\ufeff"));
        assert.ok(out.endsWith("\r\n"));
        assert.deepEqual(parseCSV(out, delimiter).rows, rows);
    }
    assert.equal(writeCSV([["a", "b"]], { delimiter: ";", sep: true }), "sep=;\na;b");
    assert.equal(writeCSV([["a"]]), "a");
    assert.equal(parseCSV('"first\nfield",x\r\nnext,row\r\n').newline, "\r\n", "record endings, not quoted newlines");
    for (const value of ["a;b", "a|b", "a\tb", "a,b"]) {
        const sniffed = sniffCSV(writeCSV([[value]], { finalNewline: true }));
        assert.deepEqual(parseCSV(sniffed.text, sniffed.delimiter).rows, [[value]], "edited separators remain in one cell");
    }
    for (const value of ["sep=:", "sep= ", "sep=;"]) {
        const rows = [[value], ["Alice"]];
        for (const bom of [false, true]) {
            const sniffed = sniffCSV(writeCSV(rows, { finalNewline: true, bom }));
            assert.deepEqual(parseCSV(sniffed.text, sniffed.delimiter).rows, rows, "a value isn't a delimiter directive");
        }
    }
    const literalBOM = [["\ufeffaccount", "balance"], ["Alice", "11"]];
    for (const bom of [false, true]) {
        const saved = writeCSV(literalBOM, { bom, finalNewline: true });
        const decoded = new TextDecoder().decode(new TextEncoder().encode(saved));
        assert.deepEqual(parseCSV(decoded).rows, literalBOM, "a cell's U+FEFF is not consumed as the file BOM");
    }
});

test("CSV editing can distinguish malformed quoting from valid quoted fields", () => {
    for (const src of ['a,b\n"open', 'a,b\nplain"quote,x', 'a,b\n"closed"extra,x', '"""""']) {
        const result = parseCSV(src);
        assert.ok(result.unclosed || result.malformed, src);
    }
    for (const src of ['""', '"a","b"\r\n', '"a""b",c', '"line\nnext",x']) {
        const result = parseCSV(src);
        assert.equal(result.unclosed, 0, src);
        assert.equal(result.malformed, false, src);
    }
});

test("CSV: quoted fields, doubled quotes, line breaks in quotes, CRLF and a BOM", () => {
    const { rows, unclosed } = parseCSV('﻿name,note\r\n"Smith, J","said ""hi""\r\nthen left"\r\nplain,\r\n\r\n,last\n');
    assert.deepEqual(rows, [["name", "note"], ["Smith, J", 'said "hi"\r\nthen left'], ["plain", ""], ["", "last"]]);
    assert.equal(unclosed, 0);
});

test("CSV: a quote opened and never closed is said, by its line", () => {
    const { rows, unclosed } = parseCSV('a,b\n1,"open\n2,3\n');
    assert.equal(unclosed, 2);
    assert.deepEqual(rows[1], ["1", "open\n2,3\n"]);
});

test("CSV: ragged rows, and a quote inside a field taken as it is", () => {
    assert.deepEqual(parseCSV('a,b,c\n1\n2,x"y,3,4').rows, [["a", "b", "c"], ["1"], ["2", 'x"y', "3", "4"]]);
});

test("CSV: the delimiter, found by the real parser", () => {
    // Semicolons, with commas inside quotes: not commas.
    assert.equal(sniffCSV('name;place\n"Smith, J";"Paris, FR"\n"Doe, A";"Rome, IT"\n').delimiter, ";");
    assert.equal(sniffCSV("a\tb\tc\n1\t2\t3\n").delimiter, "\t");
    assert.equal(sniffCSV("a|b\n1|2\n").delimiter, "|");
    assert.equal(sniffCSV("a,b\n1,2\n").delimiter, ",");
    assert.equal(sniffCSV("just one column\nhere\n").delimiter, ",");
    const excel = sniffCSV("sep=;\na;b\n1;2\n");
    assert.equal(excel.delimiter, ";");
    assert.equal(excel.text, "a;b\n1;2\n");
});

test("CSV: sorting numbers as numbers, text naturally, empty cells last, stably", () => {
    const rows = [["10"], [""], ["9"], ["-2.5"], ["1e2"], ["9"]];
    assert.deepEqual(sortRows(rows, 0, 1), [3, 2, 5, 0, 4, 1]);
    assert.deepEqual(sortRows(rows, 0, -1), [4, 0, 2, 5, 3, 1]);
    const text = [["file10"], ["File2"], [""], ["file1"]];
    assert.deepEqual(sortRows(text, 0, 1), [3, 1, 0, 2]);
    assert.deepEqual(sortRows(text, 0, -1), [0, 1, 3, 2]);
    // A column with some text in it sorts as text.
    assert.deepEqual(sortRows([["10"], ["9"], ["n/a"]], 0, 1), [1, 0, 2]);
});

test("CSV: filtering, in any column or one, ignoring case", () => {
    const rows = [["Apple", "red"], ["Banana", "yellow"], ["cherry", "Red"]];
    assert.deepEqual(filterRows(rows, [0, 1, 2], "RED"), [0, 2]);
    assert.deepEqual(filterRows(rows, [2, 1, 0], "red", 0), []);
    assert.deepEqual(filterRows(rows, [2, 1, 0], "an", 0), [1]);
    assert.deepEqual(filterRows(rows, [2, 1, 0], " "), [2, 1, 0]);
});

const strip = (s) => s.replace(/"(?:[^"\\]|\\.)*"|\s+/g, (m) => (m.startsWith('"') ? m : ""));

test("JSON: numbers and strings kept as written, through formatting", () => {
    const src = '{"id":12345678901234567890,"x":1.0,"e":1E+2,"s":"a\\u00e9\\n\\/","neg":-0,"list":[true,false,null,[],{}]}';
    const node = parseJSON(src);
    const out = formatJSON(node);
    assert.equal(strip(out), strip(src));
    assert.match(out, /"id": 12345678901234567890,/);
    assert.match(out, /"x": 1\.0,/);
    assert.match(out, /"s": "a\\u00e9\\n\\\/"/);
    assert.equal(formatJSON(parseJSON(out)), out, "formatting twice changes nothing");
    assert.equal(out, `{
  "id": 12345678901234567890,
  "x": 1.0,
  "e": 1E+2,
  "s": "a\\u00e9\\n\\/",
  "neg": -0,
  "list": [
    true,
    false,
    null,
    [],
    {}
  ]
}`);
});

test("JSON: repeated keys and __proto__ kept", () => {
    const node = parseJSON('{"__proto__": {"polluted": true}, "a": 1, "a": 2}');
    assert.deepEqual(node.members.map(([k]) => k), ['"__proto__"', '"a"', '"a"']);
    assert.equal({}.polluted, undefined);
    assert.equal(strip(formatJSON(node)), '{"__proto__":{"polluted":true},"a":1,"a":2}');
});

test("JSON: what's wrong, and where", () => {
    const cases = [
        ['{"a": 1,\n  "b": }', 2, 8, "a value should be here"],
        ['{"a" 1}', 1, 6, "“:” should follow"],
        ["[1, 2", 1, 6, "“,” or “]”"],
        ['{"a": "x\ny"}', 1, 9, "line break"],
        ["{'a': 1}", 1, 2, "double quotes"],
        ['["\\x"]', 1, 3, "isn't an escape"],
        ["[01]", 1, 3, "“,” or “]”"],
        ["{} x", 1, 4, "more after the end"],
        ["", 1, 1, "ends where a value"],
        ['"open', 1, 1, "isn't closed"],
    ];
    for (const [src, line, column, reason] of cases) {
        assert.throws(() => parseJSON(src), (err) => err instanceof JSONError && err.line === line && err.column === column && err.message.includes(reason),
            `${JSON.stringify(src)}`);
    }
    assert.equal(checkJSON('{"a": [1, 2]}'), "");
    assert.match(checkJSON("// a comment\n{}"), /line 1, column 1/);
});

test("JSON: nested too deep, said rather than overflowing", () => {
    assert.throws(() => parseJSON("[".repeat(100000)), (err) => err instanceof JSONError && err.message.includes(`more than ${MAX_DEPTH} deep`));
    const deep = "[".repeat(MAX_DEPTH) + "]".repeat(MAX_DEPTH);
    assert.equal(formatJSON(parseJSON(deep)).length > 0, true);
    assert.equal(searchJSON(parseJSON(deep), "x").length, 0);
});

test("JSON Lines: each line on its own", () => {
    const { lines, errors } = parseJSONLines('{"a":1}\n\n[2]\nnot json\r\n"s"\n');
    assert.deepEqual(lines.map((l) => l.line), [1, 3, 5]);
    assert.deepEqual(errors.map((e) => e.line), [4]);
    assert.match(checkJSON('{"a":1}\nnope\nnah\n', true), /^line 2: .*\(and 1 more lines\)$/);
    assert.equal(checkJSON('{"a":1}\n[2]\n', true), "");
});

test("JSON: searching keys and values, in order, with the way to each", () => {
    const root = parseJSON('{"name": "Ann", "pets": [{"name": "Rex", "kind": "dog"}, {"kind": "Cat", "nameless": true}], "n": 42}');
    const found = searchJSON(root, "NAME");
    assert.deepEqual(found, [
        { path: [0], key: true },
        { path: [1, 0, 0], key: true },
        { path: [1, 1, 1], key: true },
    ]);
    assert.deepEqual(searchJSON(root, "cat"), [{ path: [1, 1, 0], key: false }]);
    assert.deepEqual(searchJSON(root, "42"), [{ path: [2], key: false }]);
    assert.deepEqual(searchJSON(root, "true"), [{ path: [1, 1, 1], key: false }]);
    assert.deepEqual(searchJSON(root, "  "), []);
    // At most 10,000.
    const many = parseJSON(`[${Array.from({ length: 20000 }, () => '"x"').join(",")}]`);
    assert.equal(searchJSON(many, "x").length, 10000);
});

test("JSON: laying out stops at its limit rather than taking all the memory", () => {
    // Each level indents more: 1,000 levels of a few items each lays out
    // to far more than it is.
    const deep = '[1,2,3,'.repeat(999) + "[]" + "]".repeat(999);
    assert.ok(deep.length < 10000);
    assert.throws(() => formatJSON(parseJSON(deep), 1e6), FormatTooBig);
    assert.ok(formatJSON(parseJSON(deep)).length > 1e6);
});

test("CSV: a quoted empty field is a record, not a blank line", () => {
    assert.deepEqual(parseCSV('value\n""\nnext\n').rows, [["value"], [""], ["next"]]);
    assert.deepEqual(parseCSV('""').rows, [[""]]);
    assert.deepEqual(parseCSV('""\r\n').rows, [[""]]);
    assert.deepEqual(parseCSV('a\n\n""\n\nb').rows, [["a"], [""], ["b"]]);
});

test("CSV: numbers sorted exactly, past what JavaScript's numbers hold", () => {
    const ids = [["9007199254740993"], ["9007199254740992"], ["123456789012345678901234567890"], ["-9007199254740993"], ["-9007199254740992"]];
    assert.deepEqual(sortRows(ids, 0, 1).map((i) => ids[i][0]),
        ["-9007199254740993", "-9007199254740992", "9007199254740992", "9007199254740993", "123456789012345678901234567890"]);
    // Decimals, exponents, signs, zeros and leading zeros, against what
    // they are; numbers alike keep their order.
    const values = ["0.30000000000000001", "0.3", "3e-1", "-0", "0", "+0.0", ".5", "5e-1", "1e400", "-1e400", "007", "6.99999999999999999",
        "1E2", "99.9999999999999999", "-0.001", "-1e-3"];
    const rows = values.map((v) => [v]);
    assert.deepEqual(sortRows(rows, 0, 1).map((i) => values[i]),
        ["-1e400", "-0.001", "-1e-3", "-0", "0", "+0.0", "0.3", "3e-1", "0.30000000000000001", ".5", "5e-1", "6.99999999999999999", "007",
            "99.9999999999999999", "1E2", "1e400"]);
    assert.equal(compareNumbers(numberKey("10"), numberKey("9")), 1);
    assert.equal(compareNumbers(numberKey("-10"), numberKey("-9")), -1);
    assert.equal(compareNumbers(numberKey("1.50"), numberKey("1.5")), 0);
});

test("CSV: columns' types", () => {
    const rows = [["1", "2026-11-05", "a", ""], ["-2.5", "2026-01-02T10:00", "", ""], ["", "2025-12-31 23:59:59Z", "3", ""]];
    assert.deepEqual([0, 1, 2, 3].map((c) => columnType(rows, c)), ["number", "date", "text", "text"]);
    assert.equal(columnType([["05/11/2026"]], 0), "text");
    assert.equal(columnType([["1"], ["2026-11-05"]], 0), "text");
});

test("CSV: filtering a column by value, as its type is", () => {
    const n = (cell, op, value) => cellMatches(cell, { op, value }, "number");
    assert.ok(n("10", ">", "9") && n("9", "<", "10") && n("1.50", "=", "1.5") && n("-0", "=", "0"));
    assert.ok(n("9007199254740993", ">", "9007199254740992"), "exactly, past what JavaScript's numbers hold");
    assert.ok(!n("", "<", "5") && !n("", "=", "0"), "an empty cell matches no comparison");
    const d = (cell, op, value) => cellMatches(cell, { op, value }, "date");
    assert.ok(d("2026-11-05T23:59", "=", "2026-11-05"), "by the day, for a date alone");
    assert.ok(d("2026-11-05", "<", "2026-11-06") && d("2026-11-06 00:00", ">", "2026-11-05") && !d("2026-11-05", ">", "2026-11-05"));
    assert.ok(d("2026-11-05T10:00", "<", "2026-11-05T11:00") && !d("2026-11-05T10:00", "=", "2026-11-05T10:01"));
    const t = (cell, op, value) => cellMatches(cell, { op, value }, "text");
    assert.ok(t("Apple pie", "starts", "apple") && t("Apple pie", "ends", "PIE") && t("Apple pie", "contains", "le p"));
    assert.ok(!t("Apple pie", "starts", "pie") && !t("Apple pie", "ends", "apple"));
    assert.ok(filterValueOK("number", " 1e3 ") && !filterValueOK("number", "ten") && filterValueOK("date", "2026-11-05") && !filterValueOK("date", "5/11/2026"));
    // Filters on several columns, all at once.
    const rows = [["a", "1"], ["b", "5"], ["ab", "9"]];
    const filters = new Map([[0, { op: "starts", value: "a" }], [1, { op: ">", value: "2" }]]);
    assert.deepEqual(filterColumns(rows, [0, 1, 2], filters, ["text", "number"]), [2]);
});

test("CSV: a column's statistics", () => {
    const rows = [["3"], [""], ["1"], ["4"], ["1"], ["5"], [""]];
    const s = columnStats(rows, [0, 1, 2, 3, 4, 5, 6], 0, "number");
    assert.deepEqual({ ...s, sd: statText(s.sd) }, { empty: 2, unique: 4, sum: 14, mean: 2.8, median: 3, min: "1", max: "5", sd: "1.78885438200" .replace(/0+$/, "") });
    assert.equal(columnStats(rows, [0, 2], 0, "number").median, 2, "the middle two's mean, for an even count");
    // Of the rows given (as filtered), only.
    assert.equal(columnStats(rows, [3], 0, "number").sum, 4);
    const dates = [["2026-11-05"], ["2025-01-01T10:00"], ["2026-11-05"]];
    assert.deepEqual(columnStats(dates, [0, 1, 2], 0, "date"), { empty: 0, unique: 2, min: "2025-01-01T10:00", max: "2026-11-05" });
    assert.deepEqual(columnStats([["x"], [""], ["x"]], [0, 1, 2], 0, "text"), { empty: 1, unique: 1 });
    assert.equal(statText(0.1 + 0.2), "0.3");
    assert.equal(statText(""), "");
});

test("CSV: dates sorted as dates", () => {
    const rows = [["2026-11-05"], ["2025-12-31T23:00"], [""], ["2026-01-02 08:00"]];
    assert.deepEqual(sortRows(rows, 0, 1), [1, 3, 0, 2]);
});

test("CSV: dates that aren't, aren't", () => {
    for (const bad of ["2026-13-01", "2026-02-30", "2025-02-29", "2026-11-05T24:30", "2026-11-05 10:60", "2026-00-10"]) {
        assert.equal(isDate(bad), false, bad);
        assert.equal(columnType([["2026-11-05"], [bad]], 0), "text", bad);
    }
    for (const good of ["2024-02-29", "2026-11-05", "2026-11-05T23:59:59Z", "2026-11-05 00:00"]) {
        assert.equal(isDate(good), true, good);
    }
});
