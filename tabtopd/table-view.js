// CSV and TSV previews on the files page (see preview.js): the file as a
// table, its first row as the headings (or not, as chosen), sorted by a
// column with a click on its heading, and filtered by text in any column,
// or one. Fields are read as RFC 4180 has them: in double quotes, they can
// hold the delimiter, line breaks, and "" for a quote. The delimiter is a
// tab for .tsv; for .csv, it's whichever of , ; tab | splits the first
// records most evenly (or what an Excel "sep=" first line says). What's in
// the file is only ever shown as text.

import { glyphs, iconSVG } from "./glyphs.js";
import { storeJSON, storedJSON } from "./stored.js";

// How many rows are shown at once, then more (fewer, with many columns),
// and the most columns shown.
const CHUNK = 1000;
const MAX_COLUMNS = 500;
const DELIMITERS = [",", ";", "\t", "|"];

// parseCSV reads text as records of fields split by delimiter: {rows,
// unclosed}, unclosed the line a quote is opened on and never closed, if
// one is (the rest of the file is then that field). Blank lines are left
// out; a line of "" isn't blank: it's a record of one empty field.
export function parseCSV(text, delimiter = ",") {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    let hadQuotes = false;  // whether the record being read has a quoted field
    let afterQuote = false;
    let malformed = false;
    let newline = null;
    let quoteLine = 0;
    let line = 1;
    let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    const n = text.length;
    const endRow = () => {
        row.push(field);
        field = "";
        if (row.length > 1 || row[0] !== "" || hadQuotes) {
            rows.push(row);
        }
        row = [];
        hadQuotes = false;
        afterQuote = false;
    };
    while (i < n) {
        const c = text[i];
        if (quoted) {
            if (c === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i += 2;
                    continue;
                }
                quoted = false;
                afterQuote = true;
                i++;
                continue;
            }
            if (c === "\n") {
                line++;
            }
            field += c;
            i++;
            continue;
        }
        if (c === '"' && field === "" && !afterQuote) {
            quoted = true;
            hadQuotes = true;
            quoteLine = line;
            i++;
        } else if (c === delimiter) {
            row.push(field);
            field = "";
            afterQuote = false;
            i++;
        } else if (c === "\n" || c === "\r") {
            newline ??= c === "\r" && text[i + 1] === "\n" ? "\r\n" : c;
            endRow();
            line++;
            i += c === "\r" && text[i + 1] === "\n" ? 2 : 1;
        } else {
            // A quote within a field that didn't start with one is just a
            // quote, as spreadsheets take it.
            if (c === '"' || afterQuote) {
                malformed = true;
            }
            field += c;
            i++;
        }
    }
    if (field !== "" || row.length || hadQuotes) {
        endRow();
    }
    return { rows, unclosed: quoted ? quoteLine : 0, malformed, newline };
}

// Write the records in their original order, quoting fields that need it.
// An empty one-field record must be quoted, or it would become a blank line.
export function writeCSV(rows, { delimiter = ",", newline = "\n", finalNewline = false, bom = false, sep = false } = {}) {
    // Quote other candidate separators too, so reopening a one-column CSV
    // doesn't mistake an edited value such as "a;b" for two columns.
    const separators = [...new Set([delimiter, ...DELIMITERS])];
    const records = rows.map((row) => row.map((value) =>
        separators.some((d) => value.includes(d)) || /["\r\n]/.test(value) || value.startsWith("\ufeff")
            || /^sep=/.test(value) || row.length === 1 && value === ""
            ? `"${value.replaceAll('"', '""')}"` : value).join(delimiter));
    return (bom ? "\ufeff" : "") + (sep ? `sep=${delimiter}${newline}` : "") + records.join(newline)
        + (finalNewline && records.length ? newline : "");
}

// sniffCSV is how text, a CSV file, is split: {delimiter, text}, without an
// Excel "sep=" line, if it starts with one.
export function sniffCSV(text) {
    const sep = /^﻿?sep=(.)\r?\n/.exec(text);
    if (sep) {
        return { delimiter: sep[1], text: text.slice(sep[0].length) };
    }
    // The first records, each way: the one giving the most fields, the
    // same in each, wins; failing that, the most fields.
    const sample = text.slice(0, 64 * 1024);
    let best = { delimiter: ",", score: -1 };
    for (const d of DELIMITERS) {
        const { rows } = parseCSV(sample, d);
        const first = rows.slice(0, 20);
        if (first.length > 1 && sample.length === 64 * 1024) {
            first.pop(); // perhaps cut short
        }
        const counts = first.map((r) => r.length);
        if (!counts.length || Math.max(...counts) < 2) {
            continue;
        }
        const even = counts.every((c) => c === counts[0]);
        const score = (even ? 1e6 : 0) + Math.min(...counts) * 1000 + Math.max(...counts);
        if (score > best.score) {
            best = { delimiter: d, score };
        }
    }
    return { delimiter: best.delimiter, text };
}

const NUMERIC = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

// numberKey is the number s (as NUMERIC has it) exactly, as JavaScript's
// numbers can't hold it (IDs past 2^53, many decimal places): its sign
// (-1, 0 or 1), where its point is (as a power of ten, a BigInt), and its
// digits, from the first that isn't 0 to the last that isn't. The number
// is sign × 0.digits × 10^point.
export function numberKey(s) {
    const m = /^([-+]?)(\d*)(?:\.(\d*))?(?:[eE]([-+]?\d+))?$/.exec(s);
    const whole = m[2];
    const all = whole + (m[3] ?? "");
    const lead = all.length - all.replace(/^0+/, "").length;
    const digits = all.slice(lead).replace(/0+$/, "");
    if (!digits) {
        return { sign: 0, point: 0n, digits: "" };
    }
    return { sign: m[1] === "-" ? -1 : 1, point: BigInt(whole.length - lead) + BigInt(m[4] ?? 0), digits };
}

// compareNumbers orders numberKeys by the numbers they are.
export function compareNumbers(a, b) {
    if (a.sign !== b.sign) {
        return a.sign - b.sign;
    }
    if (a.sign === 0) {
        return 0;
    }
    // The same sign: the bigger point is the bigger number, then the
    // digits, compared as written (none is 0 at either end).
    let c = a.point === b.point ? 0 : a.point > b.point ? 1 : -1;
    if (!c) {
        c = a.digits === b.digits ? 0 : a.digits > b.digits ? 1 : -1;
    }
    return c * a.sign;
}

// sortRows returns the order of rows by column, ascending (dir 1) or
// descending (-1): as numbers, if every cell with something in it is one,
// else as text, numbers in it by their value; empty cells last either way;
// rows alike keep their order.
export function sortRows(rows, column, dir, type = columnType(rows, column)) {
    const cells = rows.map((r) => (r[column] ?? "").trim());
    const numeric = type === "number";
    // Dates, by when (one written without a time, at its day's start).
    const values = numeric ? cells.map((c) => (c === "" ? null : numberKey(c)))
        : type === "date" ? cells.map((c) => (c === "" ? null : dateMs(c))) : cells;
    const order = rows.map((_, i) => i);
    order.sort((a, b) => {
        const x = values[a];
        const y = values[b];
        const xEmpty = x === null || x === "";
        const yEmpty = y === null || y === "";
        if (xEmpty || yEmpty) {
            return xEmpty === yEmpty ? a - b : xEmpty ? 1 : -1;
        }
        const c = numeric ? compareNumbers(x, y) : type === "date" ? Math.sign(x - y) : collator.compare(x, y);
        return c ? c * dir : a - b;
    });
    return order;
}

// A date, as ISO 8601 writes one: 2026-11-05, perhaps with a time (and a
// zone). Other ways of writing dates are left as text: 05/11/2026 could
// be the fifth of November or the eleventh of May.
export const DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const dateMs = (s) => Date.parse(s.length === 10 ? `${s}T00:00:00` : s.replace(" ", "T"));

// isDate reports whether s is a date as DATE writes one, and one there is:
// not the 13th month, the 30th of February, or 24:30.
export function isDate(s) {
    if (!DATE.test(s)) {
        return false;
    }
    const [y, m, d] = [Number(s.slice(0, 4)), Number(s.slice(5, 7)), Number(s.slice(8, 10))];
    const day = new Date(Date.UTC(y, m - 1, d));
    if (day.getUTCFullYear() !== y || day.getUTCMonth() !== m - 1 || day.getUTCDate() !== d) {
        return false;
    }
    if (s.length > 10) {
        const [hh, mm, ss = "0"] = s.slice(11, 19).split(":");
        if (Number(hh) > 23 || Number(mm) > 59 || Number(ss) > 59) {
            return false;
        }
    }
    return !Number.isNaN(dateMs(s));
}

// columnType is what column holds, in rows: "number" if every cell with
// something in it is a number, "date" if every one is a date (see DATE),
// else "text".
export function columnType(rows, column) {
    let any = false;
    let numbers = true;
    let dates = true;
    for (const r of rows) {
        const c = (r[column] ?? "").trim();
        if (c === "") {
            continue;
        }
        any = true;
        numbers &&= NUMERIC.test(c);
        dates &&= isDate(c);
        if (!numbers && !dates) {
            return "text";
        }
    }
    return !any ? "text" : numbers ? "number" : dates ? "date" : "text";
}

// The ways a column can be filtered, by its type: {op: label}. Numbers
// use maths operators; text includes the inverse of each match. A column
// may have several conditions at once (all must match), for ranges.
export const FILTER_OPS = {
    number: { "=": "=", "≠": "≠", "≥": "≥", "≤": "≤", "<": "<", ">": ">" },
    date: { "<": "before", ">": "after", "=": "on" },
    text: {
        contains: "contains", starts: "starts with", ends: "ends with",
        "!contains": "does not contain", "!starts": "does not start with", "!ends": "does not end with",
    },
};

// What a column of each type holds, said.
export const FILTER_KIND_NAMES = { number: "numbers", date: "dates", text: "text" };

// filterValueOK reports whether value can filter a column of type: a
// number, or a date, for those.
export function filterValueOK(type, value) {
    const v = value.trim();
    return type === "number" ? NUMERIC.test(v) : type === "date" ? isDate(v) : v !== "";
}

// openFilterPopup shows pop, in view, under at (a column's ▽ button): the
// conditions on a column of kind ("number", "date" or "text") named title,
// from current ([{op, value}]), to change, add to and remove. Filter
// checks them and gives onApply what's asked ([] for nothing), Clear gives
// it []; either closes it, as Escape does (back to at).
export function openFilterPopup({ pop, view, at, title, kind, current = [], onApply }) {
    const ops = FILTER_OPS[kind];
    const firstOp = Object.keys(ops)[0];
    const draft = current.map((f) => ({ ...f }));
    if (!draft.length) draft.push({ op: firstOp, value: "" });
    const list = el("div", { className: "filter-list" });
    const why = el("p", { className: "hint filter-why" });
    const apply = el("button", { type: "button", className: "primary", textContent: "Filter" });
    const clear = el("button", { type: "button", textContent: "Clear", disabled: !current.length });
    const add = el("button", { type: "button", className: "filter-add", textContent: "Add condition" });
    const read = () => [...list.querySelectorAll(".filter-row")].map((row) => ({
        op: row.querySelector("select.filter-op").value, value: row.querySelector("input.filter-value").value }));
    const close = (next) => {
        pop.hidden = true;
        if (next) onApply(next);
        else if (at.isConnected) at.focus();
    };
    const dismiss = el("button", { type: "button", className: "filter-close glyph", title: "Close filters", ariaLabel: "Close filters" });
    dismiss.innerHTML = iconSVG("close-circle");
    dismiss.addEventListener("click", () => close(null));
    const paint = () => {
        list.replaceChildren(...draft.map((f, i) => {
            const op = el("select", { className: "filter-op" });
            op.setAttribute("aria-label", `How ${title} is to be`);
            for (const [k, label] of Object.entries(ops)) op.append(el("option", { value: k, textContent: label }));
            op.value = f.op in ops ? f.op : firstOp;
            const value = el("input", { type: "text", className: "filter-value", value: f.value, spellcheck: false, autocomplete: "off",
                placeholder: kind === "number" ? "a number" : kind === "date" ? "YYYY-MM-DD" : "text" });
            value.setAttribute("aria-label", "What it's compared with");
            const remove = el("button", { type: "button", className: "filter-remove", textContent: "×", title: "Remove this condition",
                disabled: draft.length === 1 });
            remove.setAttribute("aria-label", "Remove this condition");
            remove.addEventListener("click", () => {
                draft.splice(0, draft.length, ...read());
                draft.splice(i, 1);
                if (!draft.length) draft.push({ op: firstOp, value: "" });
                paint();
            });
            return el("div", { className: "filter-row" }, op, value, remove);
        }));
    };
    add.addEventListener("click", () => {
        draft.splice(0, draft.length, ...read(), { op: firstOp, value: "" });
        paint();
        list.querySelector(".filter-row:last-child input.filter-value")?.focus();
    });
    apply.addEventListener("click", () => {
        const next = [];
        for (const [i, f] of read().entries()) {
            if (kind === "text" ? f.value === "" : f.value.trim() === "") continue;
            if (!filterValueOK(kind, f.value)) {
                why.textContent = kind === "number" ? "That's not a number." : kind === "date"
                    ? "A date is written YYYY-MM-DD (and a time, if you like)." : "Give some text.";
                list.querySelectorAll("input.filter-value")[i]?.focus();
                return;
            }
            // (Text as typed, spaces and all; a number or date, trimmed.)
            next.push({ op: f.op, value: kind === "text" ? f.value : f.value.trim() });
        }
        close(next);
    });
    clear.addEventListener("click", () => close([]));
    paint();
    pop.replaceChildren(dismiss, el("p", { className: "filter-title", textContent: `${title} (${FILTER_KIND_NAMES[kind]})` }),
        list, add, why, el("div", { className: "buttons" }, clear, apply));
    pop.onkeydown = (e) => {
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close(null);
        } else if (e.key === "Enter" && e.target.classList?.contains("filter-value")) {
            e.preventDefault();
            apply.click();
        }
    };
    pop.hidden = false;
    const box = view.getBoundingClientRect();
    const r = at.getBoundingClientRect();
    pop.style.top = `${r.bottom - box.top + 4}px`;
    pop.style.left = `${Math.max(8, Math.min(r.left - box.left, box.width - pop.offsetWidth - 8))}px`;
    list.querySelector("input.filter-value")?.focus();
}

// cellMatches reports whether cell, in a column of type, is as filter
// {op, value} asks: numbers compared exactly (see compareNumbers); dates by
// the day, for a date without a time, else to the moment; text ignoring
// case (including the !… inverses).
export function cellMatches(cell, { op, value }, type) {
    const c = cell.trim();
    const v = value.trim();
    let order;
    if (type === "number") {
        if (c === "" || !NUMERIC.test(c)) {
            return false;
        }
        order = compareNumbers(numberKey(c), numberKey(v));
    } else if (type === "date") {
        if (!isDate(c)) {
            return false;
        }
        if (v.length === 10) {
            const day = c.slice(0, 10);
            order = day === v ? 0 : day < v ? -1 : 1;
        } else {
            const a = dateMs(c);
            const b = dateMs(v);
            if (Number.isNaN(a) || Number.isNaN(b)) {
                return false;
            }
            order = Math.sign(a - b);
        }
    } else {
        const a = cell.toLowerCase();
        const b = value.toLowerCase();
        const hit = op === "starts" || op === "!starts" ? a.startsWith(b)
            : op === "ends" || op === "!ends" ? a.endsWith(b)
            : a.includes(b);
        return op.startsWith("!") ? !hit : hit;
    }
    return op === "<" ? order < 0 : op === ">" ? order > 0 : op === "≠" ? order !== 0
        : op === "≤" ? order <= 0 : op === "≥" ? order >= 0 : order === 0;
}

// filterColumns returns the indexes, of those in order, of rows every
// filter lets through. filters is a Map of column → [{op, value}, …]
// (several conditions on one column all apply); types the columns' types.
export function filterColumns(rows, order, filters, types) {
    if (!filters.size) {
        return order;
    }
    return order.filter((i) => {
        for (const [c, list] of filters) {
            for (const f of list) {
                if (!cellMatches(rows[i][c] ?? "", f, types[c])) {
                    return false;
                }
            }
        }
        return true;
    });
}

// The statistics a column can show, by type, with what they're called.
export const STATS = [
    ["sum", "Sum", ["number"]], ["mean", "Average", ["number"]], ["median", "Median", ["number"]],
    ["min", "Min", ["number", "date"]], ["max", "Max", ["number", "date"]], ["sd", "Std Dev", ["number"]],
    ["empty", "Empty", ["number", "date", "text"]], ["unique", "Unique", ["number", "date", "text"]],
];

// columnStats is the statistics of column, a column of type, over the rows
// in order: {empty, unique}, and for numbers, {sum, mean, median, min, max,
// sd} (sd the sample's standard deviation, as spreadsheets' STDEV), and for
// dates, {min, max}. Min and max are cells as written; the rest numbers
// (sum and mean as JavaScript's can hold them).
export function columnStats(rows, order, column, type) {
    let empty = 0;
    const seen = new Set();
    const cells = [];
    for (const i of order) {
        const c = (rows[i][column] ?? "").trim();
        if (c === "") {
            empty++;
        } else {
            seen.add(c);
            cells.push(c);
        }
    }
    const out = { empty, unique: seen.size };
    if (!cells.length || type === "text") {
        return out;
    }
    if (type === "date") {
        let min = cells[0];
        let max = cells[0];
        for (const c of cells) {
            if (dateMs(c) < dateMs(min)) {
                min = c;
            }
            if (dateMs(c) > dateMs(max)) {
                max = c;
            }
        }
        return { ...out, min, max };
    }
    const keys = cells.map((c) => [c, numberKey(c)]).sort((a, b) => compareNumbers(a[1], b[1]));
    const nums = cells.map(Number);
    const n = nums.length;
    let sum = 0;
    for (const x of nums) {
        sum += x;
    }
    const mean = sum / n;
    let squares = 0;
    for (const x of nums) {
        squares += (x - mean) ** 2;
    }
    const sorted = keys.map(([c]) => Number(c));
    const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
    return { ...out, sum, mean, median, min: keys[0][0], max: keys[n - 1][0], sd: n > 1 ? Math.sqrt(squares / (n - 1)) : 0 };
}

// statText is a statistic as shown: a cell as written, or a number to
// twelve figures.
export function statText(v) {
    if (typeof v === "string") {
        return v;
    }
    if (typeof v !== "number" || !Number.isFinite(v)) {
        return "";
    }
    return String(Number(v.toPrecision(12)));
}

// filterRows returns the indexes, of those in order, of rows with query
// in them, ignoring case: in column, or, if it's -1, in any.
export function filterRows(rows, order, query, column = -1) {
    const q = query.trim().toLowerCase();
    if (!q) {
        return order;
    }
    return order.filter((i) => (column < 0 ? rows[i] : [rows[i][column] ?? ""]).some((c) => c.toLowerCase().includes(q)));
}

function el(tag, props = {}, ...kids) {
    const e = Object.assign(document.createElement(tag), props);
    for (const k of kids) {
        e.append(k);
    }
    return e;
}

// The delimiters that can be chosen, by name.
const NAMED = [[",", "Comma"], [";", "Semicolon"], ["\t", "Tab"], ["|", "Pipe"], [" ", "Space"]];
const nameOf = (d) => NAMED.find(([c]) => c === d)?.[1] ?? `“${d}”`;

// tableView shows text, a CSV file (a TSV one, if tab), as a table, split
// as found (see sniffCSV), or as chosen.
export function tableView(text, { tab = false, editable = false, changed = () => {},
    delimiter: chosenDelimiter = null, headings: chosenHeadings = null } = {}) {
    const sniffed = tab ? { delimiter: "\t", text } : sniffCSV(text);
    // The file as split: its rows, how many fields the longest has, and how
    // many of those are shown, and rows at a time.
    let all = [];
    let unclosed = 0;
    let widest = 0;
    let columns = 0;
    let chunk = CHUNK;
    let headings = false;
    let sortColumn = -1;
    let sortDir = 0;
    let shown = 0;
    let order = [];
    let malformed = false;
    let delimiter = sniffed.delimiter;
    let baseline = "";
    let active = null;
    let redrawing;
    let focusCell = null;
    const writing = {
        newline: text.match(/\r\n|\r|\n/)?.[0] ?? "\n",
        finalNewline: /[\r\n]$/.test(text), bom: text.startsWith("\ufeff"),
        sep: !tab && /^\ufeff?sep=.\r?\n/.test(text),
    };

    let types = [];                  // each column's type (see columnType)
    const widths = new Map();        // by column: its width, in pixels, as dragged (see resizer)
    const filters = new Map();       // by column: [{op, value}, …] (see cellMatches)
    const filterCount = () => [...filters.values()].reduce((n, list) => n + list.length, 0);
    const stats = statsChoice();     // {on, shown: [key]}, as last chosen

    const split = el("select", { className: "table-delimiter" });
    split.setAttribute("aria-label", "Split the fields by");
    split.append(el("option", { value: "", textContent: `Auto: ${nameOf(sniffed.delimiter)}` }),
        ...NAMED.map(([d, name]) => el("option", { value: d, textContent: name })));
    if (chosenDelimiter && chosenDelimiter !== sniffed.delimiter) {
        split.value = chosenDelimiter;
    }
    const filter = el("input", { type: "search", className: "table-filter", placeholder: "Filter rows" });
    filter.setAttribute("aria-label", "Show only rows with this in them");
    const which = el("select", { className: "table-column" });
    which.setAttribute("aria-label", "In which column");
    const firstRow = el("input", { type: "checkbox" });
    const statsOn = el("input", { type: "checkbox", className: "table-stats-on", checked: stats.on });
    const count = el("span", { className: "hint table-count" });
    count.setAttribute("aria-live", "polite");
    const clearFilters = el("button", { type: "button", className: "table-clear-filters", textContent: "Clear filters", hidden: true });
    const summary = el("div", { className: "table-summary" }, count,
        el("label", { className: "check" }, firstRow, "First row is headings"),
        el("label", { className: "check" }, statsOn, "Statistics"));
    const bar = el("div", { className: "table-bar" }, el("label", { className: "split" }, "Split by ", split), filter, which,
        clearFilters, summary);
    // Which statistics are shown, while they are.
    const statsBar = el("div", { className: "table-stats-choice", hidden: !stats.on });
    for (const [key, label] of STATS) {
        const box = el("input", { type: "checkbox", checked: stats.shown.includes(key) });
        box.addEventListener("change", () => {
            stats.shown = STATS.map(([k]) => k).filter((k) => k === key ? box.checked : stats.shown.includes(k));
            keepStatsChoice(stats);
            showStats();
        });
        statsBar.append(el("label", { className: "check" }, box, label));
    }
    const notes = el("div", { className: "table-notes" });
    const thead = el("thead");
    const tbody = el("tbody");
    const more = el("button", { type: "button", className: "table-more", hidden: true });
    const pop = el("div", { className: "table-filter-pop", hidden: true });
    // Columns' widths, as dragged: a rule for each, for this table alone.
    const widthRules = el("style");
    const id = `t${++tables}`;
    const view = el("div", { className: "table-view" }, bar, statsBar, notes,
        el("div", { className: "table-scroll" }, el("table", {}, thead, tbody), more), pop, widthRules);
    view.dataset.table = id;
    view.options = () => ({ delimiter, headings });
    view.snapshot = () => {
        active?.finish(false);
        return { text: writeCSV(all, { ...writing, delimiter }), rows: JSON.stringify(all) };
    };
    view.dirty = () => JSON.stringify(all) !== baseline || !!active && active.box.value !== active.was;
    view.markSaved = (snapshot) => { baseline = snapshot.rows; changed(); };
    view.stop = () => { active?.finish(true); clearTimeout(redrawing); clearTimeout(typing); };
    const canEdit = () => editable && !unclosed && !malformed;
    view.canEdit = canEdit;
    const showWidths = () => {
        widthRules.textContent = [...widths].map(([c, w]) => widthRule(id, c, w)).join("\n");
    };

    // load splits the file by delimiter, and shows it from the start.
    const load = (splitBy) => {
        delimiter = splitBy;
        const parsed = parseCSV(sniffed.text, delimiter);
        ({ rows: all, unclosed, malformed } = parsed);
        writing.newline = parsed.newline ?? writing.newline;
        baseline = JSON.stringify(all);
        bodyRows = null;
        // (Counted, not spread into Math.max: a file can have more rows, or
        // a row more fields, than a call can take arguments.)
        widest = 0;
        for (const r of all) {
            widest = Math.max(widest, r.length);
        }
        columns = Math.min(widest, MAX_COLUMNS);
        widths.clear();
        showWidths();
        chunk = Math.max(50, Math.min(CHUNK, Math.floor(50000 / Math.max(1, columns))));
        // Headings, if there's more than one row and the first has no
        // numbers in it, as data would.
        headings = chosenHeadings ?? (all.length > 1 && !all[0].some((c) => NUMERIC.test(c.trim())));
        firstRow.checked = headings;
        notes.replaceChildren();
        if (editable) {
            split.disabled = true;
            notes.append(el("p", { className: canEdit() ? "hint" : "error", textContent: canEdit()
                ? "Double-click a cell or press Enter to edit. Enter commits, Shift Enter adds a line, Escape cancels. Save writes the file."
                : "This CSV has malformed quoting. Edit its raw text before editing cells." }));
        }
        if (widest > columns) {
            notes.append(el("p", { className: "hint", textContent: `Only the first ${MAX_COLUMNS} of its ${widest.toLocaleString()} columns are shown.` }));
        }
        if (unclosed) {
            notes.append(el("p", { className: "error", textContent:
                `A quote opened on line ${unclosed} isn't closed, so everything after it is in one field.` }));
        }
        restart();
    };
    // restart shows the rows split anew (or the headings taken anew): their
    // columns' types worked out again, unsorted and unfiltered.
    const restart = () => {
        active?.finish(false);
        bodyRows = null;
        statsFor = null;
        const rows = body();
        types = Array.from({ length: columns }, (_, c) => columnType(rows, c));
        sortColumn = -1;
        sortDir = 0;
        which.value = "-1";
        filters.clear();
        pop.hidden = true;
        update();
    };

    // resizer is the handle at the right of column c's heading (see
    // resizeHandle).
    const resizer = (c) => resizeHandle(name(c), {
        width: (th) => widths.get(c) ?? th.getBoundingClientRect().width,
        set: (w) => { widths.set(c, Math.round(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, w)))); showWidths(); },
        fit: () => { widths.delete(c); showWidths(); },
    });

    // The rows, without the headings if the first is: made once for each
    // split and choice of headings, not each time they're shown.
    let bodyRows = null;
    const body = () => (bodyRows ??= headings ? all.slice(1) : all);
    // The statistics, of the rows as filtered: worked out again only when
    // which rows are shown changes, not when they're sorted.
    let statsFor = null;
    let statsOf = null;
    const name = (c) => (headings && all[0][c]?.trim() ? all[0][c] : `Column ${c + 1}`);
    const heads = () => {
        const chosen = which.value || "-1";
        which.replaceChildren(el("option", { value: "-1", textContent: "In any column" }),
            ...Array.from({ length: columns }, (_, c) => el("option", { value: String(c), textContent: `In ${name(c)}` })));
        which.value = chosen;
        // The corner: how many rows are shown, of how many.
        const total = body().length;
        const corner = el("th", { className: "row-number corner" }, el("span", { className: "rows-shown",
            textContent: order.length === total ? `${total.toLocaleString()} ${total === 1 ? "row" : "rows"}`
                : `${order.length.toLocaleString()} of ${total.toLocaleString()}` }));
        corner.title = order.length === total ? "Rows shown: all of them" : `Rows shown: ${order.length.toLocaleString()} of ${total.toLocaleString()}, as filtered`;
        const tr = el("tr", { className: "heads" }, corner);
        for (let c = 0; c < columns; c++) {
            const sorted = c === sortColumn;
            const label = el("button", { type: "button", className: "col-name", textContent: name(c), title: `${name(c)} (${FILTER_KIND_NAMES[types[c]]}): sort by it` });
            label.addEventListener("click", () => sortBy(c));
            const sort = el("button", { type: "button", className: "col-sort glyph", textContent: sorted ? (sortDir > 0 ? glyphs.up : glyphs.down) : glyphs.sort,
                title: sorted ? `Sorted by ${name(c)}, ${sortDir > 0 ? "up" : "down"}: click to change` : `Sort by ${name(c)}` });
            sort.setAttribute("aria-label", sort.title);
            sort.addEventListener("click", () => sortBy(c));
            const fs = filters.get(c);
            const how = fs?.length ? fs.map((f) => `${FILTER_OPS[types[c]][f.op]} ${f.value}`).join(" and ") : "";
            const funnel = el("button", { type: "button", className: `col-filter glyph${fs?.length ? " active" : ""}`,
                title: fs?.length ? `${name(c)} ${how}: click to change` : `Filter by ${name(c)}` });
            funnel.innerHTML = iconSVG("filter");
            funnel.setAttribute("aria-label", funnel.title);
            funnel.addEventListener("click", () => openFilter(c, funnel));
            const th = el("th", { className: `type-${types[c]}` }, el("div", { className: "col-head" }, label, sort, funnel), resizer(c));
            th.setAttribute("aria-sort", sorted ? (sortDir > 0 ? "ascending" : "descending") : "none");
            tr.append(th);
        }
        thead.replaceChildren(tr);
        showStats();
    };

    // showStats shows the statistics chosen, of the rows shown, as rows
    // under the headings.
    const showStats = () => {
        statsBar.hidden = !stats.on;
        for (const r of thead.querySelectorAll("tr.stats")) {
            r.remove();
        }
        if (!stats.on || !stats.shown.length) {
            return;
        }
        if (order.length * columns > MAX_STATS_CELLS) {
            thead.append(el("tr", { className: "stats" }, el("th", { className: "row-number", textContent: "" }),
                el("td", { colSpan: columns, className: "hint", textContent: "Too many rows to count: filter them, to see statistics." })));
            return;
        }
        const rows = body();
        const key = JSON.stringify([filter.value, which.value, [...filters], order.length]);
        if (statsFor !== key) {
            statsFor = key;
            statsOf = Array.from({ length: columns }, (_, c) => columnStats(rows, order, c, types[c]));
        }
        const of = statsOf;
        for (const [key, label, kinds] of STATS) {
            if (!stats.shown.includes(key)) {
                continue;
            }
            const tr = el("tr", { className: `stats stat-${key}` }, el("th", { className: "row-number", textContent: label,
                title: `${label}, of the ${order.length.toLocaleString()} ${order.length === 1 ? "row" : "rows"} shown` }));
            for (let c = 0; c < columns; c++) {
                tr.append(el("td", { className: `type-${types[c]}`, textContent: kinds.includes(types[c]) ? statText(of[c][key]) : "" }));
            }
            thead.append(tr);
        }
    };

    // openFilter shows, by the button at, the filters of column c, to
    // change: one or more conditions for its type (all must match).
    const openFilter = (c, at) => openFilterPopup({ pop, view, at, title: name(c), kind: types[c], current: filters.get(c),
        onApply: (next) => {
            if (next.length) filters.set(c, next);
            else filters.delete(c);
            update();
        } });
    // A click elsewhere closes it.
    view.addEventListener("click", (e) => {
        if (!pop.hidden && !pop.contains(e.target) && !e.target.closest("button.col-filter")) {
            pop.hidden = true;
        }
    });

    // sortBy sorts by column c: ascending, then descending, then as it is.
    const sortBy = (c) => {
        if (c !== sortColumn) {
            sortColumn = c;
            sortDir = 1;
        } else if (sortDir === 1) {
            sortDir = -1;
        } else {
            sortColumn = -1;
            sortDir = 0;
        }
        update();
    };

    // update orders and filters the rows, and shows the first of them.
    const update = ({ keepRows = false } = {}) => {
        active?.finish(false);
        clearTimeout(redrawing);
        const visible = keepRows ? Math.max(chunk, shown) : chunk;
        const rows = body();
        const sorted = sortDir ? sortRows(rows, sortColumn, sortDir, types[sortColumn]) : rows.map((_, i) => i);
        order = filterColumns(rows, filterRows(rows, sorted, filter.value, Number(which.value || -1)), filters, types);
        heads();
        tbody.replaceChildren();
        shown = 0;
        showMore(visible);
        if (focusCell) {
            const { row, c } = focusCell;
            const i = rows.indexOf(row);
            (tbody.querySelector(`[data-row="${i}"][data-column="${c}"]`) ?? filter).focus();
            focusCell = null;
        }
        const total = rows.length;
        count.textContent = `${order.length === total ? total.toLocaleString() : `${order.length.toLocaleString()} of ${total.toLocaleString()}`} ` +
            `${total === 1 ? "row" : "rows"} × ${columns} ${columns === 1 ? "column" : "columns"}`;
        const n = filterCount();
        clearFilters.hidden = !n;
        clearFilters.textContent = n === 1 ? "Clear the filter" : `Clear ${n} filters`;
    };
    // The row array is the record itself, independent of sorting/filtering.
    const editCell = (cell, row, c) => {
        if (!canEdit() || active) {
            return;
        }
        const was = row[c];
        const box = el("textarea", { className: "table-cell-editor", value: was, spellcheck: false });
        const initial = box.value; // textarea line endings are normalized by the browser
        box.setAttribute("aria-label", `Edit ${name(c)}`);
        const finish = (cancel) => {
            if (active?.box !== box) {
                return;
            }
            active = null;
            const value = cancel || box.value === initial ? was : box.value;
            cell.textContent = value;
            if (value !== was) {
                row[c] = value;
                const type = columnType(body(), c);
                if (types[c] !== type) {
                    filters.delete(c);
                }
                types[c] = type;
                statsFor = null;
                // Let a click on a sort/filter control finish before replacing it.
                clearTimeout(redrawing);
                redrawing = setTimeout(() => update({ keepRows: true }), 0);
            }
            changed();
        };
        active = { box, was: initial, finish };
        box.addEventListener("input", changed);
        box.addEventListener("blur", () => finish(false));
        box.addEventListener("keydown", (e) => {
            if (e.isComposing) {
                return;
            }
            if (e.key === "Escape" || e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                e.stopPropagation();
                finish(e.key === "Escape");
                cell.focus();
                if (row[c] !== was) {
                    focusCell = { row, c };
                }
            } else if (e.key === "Tab") {
                const cells = [...tbody.querySelectorAll("td.editable-cell")];
                const next = cells[cells.indexOf(cell) + (e.shiftKey ? -1 : 1)];
                if (next) {
                    e.preventDefault();
                    const target = { row: body()[Number(next.dataset.row)], c: Number(next.dataset.column) };
                    finish(false);
                    if (row[c] !== was) {
                        focusCell = target;
                    } else {
                        next.focus();
                    }
                }
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
                e.preventDefault();
                finish(false);
                // The editor's outer Ctrl S handler saves the committed value.
            }
        });
        cell.replaceChildren(box);
        box.focus();
        box.select();
    };
    const showMore = (amount = chunk) => {
        const rows = body();
        const offset = headings ? 2 : 1;  // record numbers, from 1, headings counted
        const to = Math.min(order.length, shown + amount);
        const made = document.createDocumentFragment();
        for (let k = shown; k < to; k++) {
            const i = order[k];
            const tr = el("tr", {}, el("td", { className: "row-number", textContent: String(i + offset) }));
            for (let c = 0; c < columns; c++) {
                const cell = el("td", { className: `type-${types[c]}`, textContent: rows[i][c] ?? "" });
                // Ragged rows retain their field count: only existing cells edit.
                if (canEdit() && c < rows[i].length) {
                    cell.tabIndex = 0;
                    cell.dataset.row = String(i);
                    cell.dataset.column = String(c);
                    cell.classList.add("editable-cell");
                    cell.addEventListener("dblclick", () => editCell(cell, rows[i], c));
                    cell.addEventListener("keydown", (e) => {
                        if (e.target === cell && e.key === "Enter") {
                            e.preventDefault();
                            editCell(cell, rows[i], c);
                        }
                    });
                }
                tr.append(cell);
            }
            made.append(tr);
        }
        tbody.append(made);
        shown = to;
        more.hidden = shown >= order.length;
        more.textContent = `Show ${Math.min(chunk, order.length - shown).toLocaleString()} more of ${order.length.toLocaleString()}`;
    };
    more.addEventListener("click", () => showMore());
    let typing;
    filter.addEventListener("input", () => {
        clearTimeout(typing);
        typing = setTimeout(update, 200);
    });
    which.addEventListener("change", update);
    firstRow.addEventListener("change", () => {
        headings = firstRow.checked;
        restart();
    });
    statsOn.addEventListener("change", () => {
        stats.on = statsOn.checked;
        keepStatsChoice(stats);
        showStats();
    });
    clearFilters.addEventListener("click", () => {
        filters.clear();
        update();
    });
    split.addEventListener("change", () => load(split.value || sniffed.delimiter));
    load(chosenDelimiter ?? sniffed.delimiter);
    if (!all.length && !editable) {
        return el("p", { className: "hint", textContent: "This file has no rows." });
    }
    return view;
}

// Tables made, to tell their columns' widths apart (see showWidths); and
// how narrow and wide a column can be dragged, in pixels.
let tables = 0;
// resizeHandle is the handle at the right of a column's heading, the
// column called label: dragged, it sets the column's width (set); ← and →,
// with it focused, too (from width(th), what it is now); a double click,
// and the column fits what's in it again (fit).
export function resizeHandle(label, { width, set, fit }) {
    const handle = el("span", { className: "col-resize", tabIndex: 0 });
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "vertical");
    handle.setAttribute("aria-label", `Width of ${label}: drag, or ← and →; double-click to fit`);
    handle.title = "Drag to change the column's width; double-click to fit it";
    handle.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const th = handle.closest("th");
        const start = e.clientX;
        const was = th.getBoundingClientRect().width;
        handle.setPointerCapture(e.pointerId);
        handle.classList.add("dragging");
        const move = (m) => set(was + m.clientX - start);
        const up = () => {
            handle.classList.remove("dragging");
            handle.removeEventListener("pointermove", move);
            handle.removeEventListener("pointerup", up);
            handle.removeEventListener("pointercancel", up);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
        handle.addEventListener("pointercancel", up);
    });
    handle.addEventListener("click", (e) => e.stopPropagation());
    handle.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        fit();
    });
    handle.addEventListener("keydown", (e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            e.stopPropagation();
            set(width(handle.closest("th")) + (e.key === "ArrowLeft" ? -20 : 20));
        }
    });
    return handle;
}

// widthRule is the CSS that gives column c (from 0, after the row
// numbers; -1 targets the row-number column) of the table marked
// data-table=id a width of w pixels.
export const widthRule = (id, c, w) =>
    `[data-table="${id}"] tr > :nth-child(${c + 2}) { box-sizing: border-box; width: ${w}px; min-width: ${w}px; max-width: ${w}px; }`;

export const MIN_WIDTH = 40;
export const MAX_WIDTH = 2000;

// Statistics are shown for so many cells (rows shown × columns) at most:
// past that, working them out each time the rows change would hold up the
// page.
const MAX_STATS_CELLS = 3e6;

// Whether statistics are shown, and which, as last chosen in this browser.
const STATS_CHOICE = "tabtop.table-stats";
function statsChoice() {
    const all = STATS.map(([k]) => k);
    const c = storedJSON(STATS_CHOICE);
    if (c && typeof c === "object" && Array.isArray(c.shown)) {
        return { on: !!c.on, shown: all.filter((k) => c.shown.includes(k)) };
    }
    return { on: false, shown: [] };
}
const keepStatsChoice = (c) => storeJSON(STATS_CHOICE, c);
