// Bounded line diff, independent of DOM. Newline bytes remain part of each
// token: CRLF, LF and a missing final newline must never compare as identical.
export const MAX_DIFF_BYTES = 2_000_000;
export const MAX_DIFF_LINES = 50_000;
const MAX_WORK = 500_000;

export function textDocument(text) {
    if (new TextEncoder().encode(text).length > MAX_DIFF_BYTES) throw new Error("Each text file must be at most 2 MB.");
    // NUL marks binary data; other control characters (a log's ANSI
    // colours, a form feed) are text's.
    if (text.includes("\0")) throw new Error("This file contains binary data; choose a UTF-8 text file.");
    const bom = text.startsWith("\ufeff");
    if (bom) text = text.slice(1);
    const lines = [];
    // Stop while tokenizing, before a newline-heavy input allocates millions
    // of strings that would only be rejected afterwards.
    for (const match of text.matchAll(/[^\r\n]*(?:\r\n|[\r\n]|$)/g)) {
        if (!match[0]) continue;
        if (lines.length === MAX_DIFF_LINES) throw new Error("Each text file must have at most 50,000 lines.");
        lines.push(match[0]);
    }
    const endings = new Set(lines.map(line => line.endsWith("\r\n") ? "CRLF" : line.endsWith("\n") ? "LF" : line.endsWith("\r") ? "CR" : "").filter(Boolean));
    return { lines, bom, endings: [...endings].join(" / ") || "No line endings", finalNewline: /[\r\n]$/.test(text) };
}
export const lineText = (line) => line.replace(/(?:\r\n|[\r\n])$/, "");

// Myers' shortest edit script. Store only each active diagonal, with a hard
// bound on both trace storage and comparisons. A large edit becomes one
// explicitly labelled block instead of freezing or exhausting the browser.
function middleDiff(a, b, maxWork) {
    const trace = [];
    let previous = new Map([[1, 0]]), work = 0;
    for (let d = 0; d <= a.length + b.length; d++) {
        const current = new Map();
        for (let k = -d; k <= d; k += 2) {
            if (++work > maxWork) return null;
            let x = k === -d || k !== d && (previous.get(k - 1) ?? -Infinity) < (previous.get(k + 1) ?? -Infinity)
                ? previous.get(k + 1) ?? 0 : (previous.get(k - 1) ?? 0) + 1;
            let y = x - k;
            while (x < a.length && y < b.length && a[x] === b[y]) {
                if (++work > maxWork) return null;
                x++; y++;
            }
            current.set(k, x);
            if (x >= a.length && y >= b.length) {
                trace.push(current);
                const edits = [];
                x = a.length; y = b.length;
                for (let depth = d; depth > 0; depth--) {
                    const old = trace[depth - 1], diagonal = x - y;
                    const from = diagonal === -depth || diagonal !== depth && (old.get(diagonal - 1) ?? -Infinity) < (old.get(diagonal + 1) ?? -Infinity)
                        ? diagonal + 1 : diagonal - 1;
                    const px = old.get(from) ?? 0, py = px - from;
                    while (x > px && y > py) { edits.push("same"); x--; y--; }
                    if (x === px) { edits.push("add"); y--; } else { edits.push("remove"); x--; }
                }
                while (x > 0 && y > 0) { edits.push("same"); x--; y--; }
                return edits.reverse();
            }
        }
        trace.push(current);
        previous = current;
    }
    return null;
}

export function compareText(leftText, rightText, { maxWork = MAX_WORK } = {}) {
    const left = textDocument(leftText), right = textDocument(rightText);
    const a = left.lines, b = right.lines;
    let prefix = 0, suffix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
    while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix++;
    const aa = a.slice(prefix, a.length - suffix), bb = b.slice(prefix, b.length - suffix);
    let edits = !aa.length ? Array(bb.length).fill("add") : !bb.length ? Array(aa.length).fill("remove") : middleDiff(aa, bb, maxWork);
    const approximate = edits === null;
    if (approximate) edits = [...Array(aa.length).fill("remove"), ...Array(bb.length).fill("add")];
    const rows = [], changes = [];
    let ai = 0, bi = 0, removed = 0, added = 0;
    const same = () => rows.push({ a: ai++, b: bi++, change: -1 });
    for (let i = 0; i < prefix; i++) same();
    for (let i = 0; i < edits.length;) {
        if (edits[i] === "same") { same(); i++; continue; }
        const fromA = ai, fromB = bi;
        while (i < edits.length && edits[i] !== "same") {
            if (edits[i++] === "remove") { ai++; removed++; } else { bi++; added++; }
        }
        const change = changes.length;
        changes.push(rows.length);
        for (let j = 0; j < Math.max(ai - fromA, bi - fromB); j++) rows.push({
            a: fromA + j < ai ? fromA + j : -1, b: fromB + j < bi ? fromB + j : -1, change,
        });
    }
    for (let i = 0; i < suffix; i++) same();
    return { left, right, rows, changes, removed, added, approximate, identical: leftText === rightText };
}
