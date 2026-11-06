// JSON previews on the files page (see preview.js): a JSON file shown as a
// tree, folded and unfolded a level at a time, with a search through its
// keys and values; and, for editing, a check that it's still JSON, and a
// way to lay it out (formatJSON). JSON Lines files (.jsonl, .ndjson) are a
// value a line, shown as a list of them, each checked on its own.
//
// It's read by its own parser, not JSON.parse, which would round numbers
// too big for JavaScript's (as long IDs are) and lose how each was written
// (1.0 becomes 1); here each number and string is kept as it's written, and
// formatting changes only the space between them. An object's members are
// kept as a list, so keys repeated, or named __proto__, are kept too. What's
// in the file is only ever shown as text.

import { glyphs, iconSVG } from "./glyphs.js";

// The deepest a value may be nested: deeper, and it's shown as text, saying
// so, rather than overflowing the stack.
export const MAX_DEPTH = 1000;
// How many of a value's members or items are shown at once, then more;
// and the most rows made to start, unfolding the second level only while
// they're within it.
const CHUNK = 500;
const FIRST_ROWS = 2000;
// How many rows either side of a match are made to show it, among those
// not made yet.
const AROUND = 50;
// The most matches a search finds.
const MAX_MATCHES = 10000;

// JSONError is a reason the text isn't JSON, and where: line and column,
// from 1.
export class JSONError extends Error {
    constructor(message, offset, text) {
        let line = 1;
        let lineStart = 0;
        for (let i = 0; i < offset && i < text.length; i++) {
            if (text.charCodeAt(i) === 10) {
                line++;
                lineStart = i + 1;
            }
        }
        const column = offset - lineStart + 1;
        super(`${message}, on line ${line}, column ${column}`);
        Object.assign(this, { line, column, offset, reason: message });
    }
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

// parseJSON reads text as JSON, into nodes: {t: "object", members: [[key,
// node]]}, {t: "array", items}, {t: "string", raw}, {t: "number", raw}, or
// {t: "true" | "false" | "null"}, keys and strings as written, quotes and
// escapes and all. It throws a JSONError if the text isn't JSON.
export function parseJSON(text, { maxDepth = MAX_DEPTH } = {}) {
    let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    const n = text.length;
    const fail = (message, at = i) => {
        throw new JSONError(message, at, text);
    };
    const space = () => {
        for (; i < n; i++) {
            const c = text.charCodeAt(i);
            if (c !== 32 && c !== 9 && c !== 10 && c !== 13) {
                break;
            }
        }
    };
    const what = (c) => (c === undefined ? "the end" : c === "\n" ? "a line break" : `“${c}”`);
    const string = () => {
        const start = i++;
        while (i < n) {
            const c = text.charCodeAt(i);
            if (c === 34) {
                i++;
                return text.slice(start, i);
            }
            if (c === 92) {
                const e = text[i + 1];
                if (e === "u") {
                    if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
                        fail("a \\u escape needs four hex digits");
                    }
                    i += 6;
                } else if (e !== undefined && '"\\/bfnrt'.includes(e)) {
                    i += 2;
                } else {
                    fail(`${e === undefined ? "a \\" : `\\${e}`} isn't an escape JSON has`);
                }
                continue;
            }
            if (c < 32) {
                fail("a string can't hold a line break or tab as it is (it needs \\n or \\t)");
            }
            i++;
        }
        return fail("a string isn't closed", start);
    };
    const value = (depth) => {
        space();
        const c = text[i];
        if (c === "{" || c === "[") {
            if (depth >= maxDepth) {
                fail(`it's nested more than ${maxDepth} deep`);
            }
            const close = c === "{" ? "}" : "]";
            i++;
            space();
            const node = c === "{" ? { t: "object", members: [] } : { t: "array", items: [] };
            if (text[i] === close) {
                i++;
                return node;
            }
            for (;;) {
                if (c === "{") {
                    space();
                    if (text[i] !== '"') {
                        fail(`a key, in double quotes, should be here, not ${what(text[i])}`);
                    }
                    const key = string();
                    space();
                    if (text[i] !== ":") {
                        fail(`a “:” should follow the key, not ${what(text[i])}`);
                    }
                    i++;
                    node.members.push([key, value(depth + 1)]);
                } else {
                    node.items.push(value(depth + 1));
                }
                space();
                if (text[i] === ",") {
                    i++;
                    continue;
                }
                if (text[i] === close) {
                    i++;
                    return node;
                }
                fail(`a “,” or “${close}” should be here, not ${what(text[i])}`);
            }
        }
        if (c === '"') {
            return { t: "string", raw: string() };
        }
        if (c === "-" || (c >= "0" && c <= "9")) {
            NUMBER.lastIndex = i;
            const m = NUMBER.exec(text);
            if (!m) {
                fail("that's not a number JSON has");
            }
            i += m[0].length;
            return { t: "number", raw: m[0] };
        }
        for (const word of ["true", "false", "null"]) {
            if (text.startsWith(word, i)) {
                i += word.length;
                return { t: word };
            }
        }
        return fail(c === undefined ? "it ends where a value should be" : `a value should be here, not ${what(c)}`);
    };
    const root = value(0);
    space();
    if (i < n) {
        fail(`there's more after the end, starting with ${what(text[i])}`);
    }
    return root;
}

// parseJSONLines reads text as JSON Lines: a value on each line, blank
// lines aside. It resolves to [{line, node}] and [{line, error}].
export function parseJSONLines(text) {
    const lines = [];
    const errors = [];
    text.split(/\r?\n/).forEach((s, i) => {
        if (s.trim()) {
            try {
                lines.push({ line: i + 1, node: parseJSON(s) });
            } catch (err) {
                if (!(err instanceof JSONError)) {
                    throw err;
                }
                errors.push({ line: i + 1, error: err.reason });
            }
        }
    });
    return { lines, errors };
}

// The most characters formatJSON makes: indenting deep nesting can make
// far more than the text it lays out.
export const MAX_FORMATTED = 16e6;

// FormatTooBig is why formatJSON stopped: laid out, the JSON would be more
// than it makes.
export class FormatTooBig extends Error {
    constructor(max) {
        super(`laid out, it would be more than ${Math.round(max / 1e6)} million characters, too big to edit here`);
    }
}

// formatJSON lays node out, a member or item a line, indented two spaces
// a level; all else as it was written. It throws FormatTooBig rather than
// make more than max characters.
export function formatJSON(node, max = MAX_FORMATTED) {
    const parts = [];
    let size = 0;
    const out = {
        push(...s) {
            for (const p of s) {
                size += p.length;
                parts.push(p);
            }
            if (size > max) {
                throw new FormatTooBig(max);
            }
        },
    };
    const write = (node, depth) => {
        const pad = "  ".repeat(depth + 1);
        if (node.t === "object" || node.t === "array") {
            const list = node.t === "object" ? node.members : node.items;
            const [open, close] = node.t === "object" ? ["{", "}"] : ["[", "]"];
            if (!list.length) {
                out.push(open, close);
                return;
            }
            out.push(open, "\n");
            list.forEach((m, i) => {
                out.push(pad);
                if (node.t === "object") {
                    out.push(m[0], ": ");
                    write(m[1], depth + 1);
                } else {
                    write(m, depth + 1);
                }
                out.push(i < list.length - 1 ? ",\n" : "\n");
            });
            out.push("  ".repeat(depth), close);
        } else {
            out.push(node.raw ?? node.t);
        }
    };
    write(node, 0);
    return parts.join("");
}

// checkJSON is why text isn't JSON (or JSON Lines, with lines), or "".
export function checkJSON(text, lines = false) {
    if (lines) {
        const { errors } = parseJSONLines(text);
        return errors.length ? `line ${errors[0].line}: ${errors[0].error}${errors.length > 1 ? ` (and ${errors.length - 1} more lines)` : ""}` : "";
    }
    try {
        parseJSON(text);
        return "";
    } catch (err) {
        if (err instanceof JSONError) {
            return err.message;
        }
        throw err;
    }
}

// text is what a string or key, as written, says.
const text = (raw) => JSON.parse(raw);

// children are a container's members, as [label, node, isKey]: an
// object's by key, an array's by index, JSON Lines' by line.
function children(node) {
    if (node.t === "object") {
        return node.members.map(([k, v]) => [text(k), v, true]);
    }
    if (node.t === "array") {
        return node.items.map((v, i) => [String(i), v, false]);
    }
    if (node.t === "lines") {
        return node.lines.map((l) => [`line ${l.line}`, l.node ?? { t: "error", error: l.error }, false]);
    }
    return [];
}
const isContainer = (node) => node.t === "object" || node.t === "array" || node.t === "lines";
const countOf = (node) => (node.t === "object" ? node.members.length : node.t === "array" ? node.items.length : node.t === "lines" ? node.lines.length : 0);

// searchJSON finds query, ignoring case, in root's keys and values, in
// order: [{path, key}], path the indexes of the children leading to it, key
// whether it's the key (else the value) that matches; at most MAX_MATCHES.
export function searchJSON(root, query) {
    const q = query.trim().toLowerCase();
    const found = [];
    if (!q) {
        return found;
    }
    // Depth first, in order, without recursion.
    const stack = [{ node: root, path: [], label: null, isKey: false }];
    while (stack.length && found.length < MAX_MATCHES) {
        const { node, path, label, isKey } = stack.pop();
        if (isKey && label.toLowerCase().includes(q)) {
            found.push({ path, key: true });
        }
        if (!isContainer(node) && node.t !== "error") {
            const shown = node.t === "string" ? text(node.raw) : node.raw ?? node.t;
            if (shown.toLowerCase().includes(q) && found.length < MAX_MATCHES) {
                found.push({ path, key: false });
            }
        }
        const kids = children(node);
        for (let i = kids.length - 1; i >= 0; i--) {
            stack.push({ node: kids[i][1], path: [...path, i], label: kids[i][0], isKey: kids[i][2] });
        }
    }
    return found;
}

function el(tag, props = {}, ...kids) {
    const e = Object.assign(document.createElement(tag), props);
    for (const k of kids) {
        e.append(k);
    }
    return e;
}

// jsonView shows text, JSON (or JSON Lines, with lines), as a tree; or, if
// it isn't, says why, and resolves to null, for it to be shown as text.
export function jsonView(text, { lines = false } = {}) {
    let root;
    const errors = [];
    if (lines) {
        const got = parseJSONLines(text);
        const all = [...got.lines, ...got.errors].sort((a, b) => a.line - b.line);
        root = { t: "lines", lines: all };
        for (const e of got.errors) {
            errors.push(e);
        }
    } else {
        try {
            root = parseJSON(text);
        } catch (err) {
            if (err instanceof JSONError) {
                return { error: `It isn't JSON: ${err.message}.` };
            }
            throw err;
        }
    }
    return { view: new JSONTree(root, errors).element };
}

// JSONTree is the tree, built as it's unfolded: each container's children
// are made the first time it's opened, CHUNK at a time.
class JSONTree {
    constructor(root, errors) {
        this.root = root;
        // What's been made, by node: {li, list, shown, rows, open, toggle};
        // and each node's children, once worked out.
        this.made = new Map();
        this.kidsOf = new WeakMap();
        this.matches = [];
        this.at = -1;
        this.search = el("input", { type: "search", className: "json-search", placeholder: "Find keys and values" });
        this.search.setAttribute("aria-label", "Find in the JSON's keys and values");
        this.found = el("span", { className: "hint json-found" });
        this.found.setAttribute("aria-live", "polite");
        const button = (textContent, title, onClick) => {
            const b = el("button", { type: "button", textContent, title });
            b.setAttribute("aria-label", title);
            b.addEventListener("click", onClick);
            return b;
        };
        const fold = button("", "Fold all: fold everything but the top level", () => this.foldAll());
        fold.className = "json-fold-all";
        fold.innerHTML = iconSVG("fold-all");
        const bar = el("div", { className: "json-bar" }, this.search, button(glyphs.up, "Previous match", () => this.step(-1)),
            button(glyphs.down, "Next match", () => this.step(1)), this.found, fold);
        this.tree = el("ul", { className: "json-tree", role: "tree" });
        const top = [bar];
        if (errors.length) {
            top.push(el("p", { className: "error json-errors", textContent:
                `${errors.length.toLocaleString()} ${errors.length === 1 ? "line isn't" : "lines aren't"} JSON: line ${errors[0].line}, ${errors[0].error}${errors.length > 1 ? ", and more" : ""}.` }));
        }
        this.element = el("div", { className: "json-view" }, ...top, el("div", { className: "json-scroll" }, this.tree));
        let typing;
        this.search.addEventListener("input", () => {
            clearTimeout(typing);
            typing = setTimeout(() => this.find(), 250);
        });
        this.search.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                clearTimeout(typing);
                if (this.query !== this.search.value) {
                    this.find();
                } else {
                    this.step(e.shiftKey ? -1 : 1);
                }
            }
        });
        if (isContainer(root)) {
            this.fill(root, this.tree);
            // Two levels open to start, as far as FIRST_ROWS goes: past
            // that, the rest stay folded.
            let room = FIRST_ROWS - this.made.get(root).shown;
            for (const [, child] of this.kids(root).slice(0, CHUNK)) {
                const n = Math.min(countOf(child), CHUNK);
                if (isContainer(child) && countOf(child) <= CHUNK && n <= room) {
                    this.open(child);
                    room -= n;
                }
            }
        } else {
            this.tree.append(this.row(null, root, false));
        }
    }

    // kids are node's children (see children), worked out once.
    kids(node) {
        let k = this.kidsOf.get(node);
        if (!k) {
            k = children(node);
            this.kidsOf.set(node, k);
        }
        return k;
    }

    // A container's children are made in runs, not all at once: list holds
    // the rows made, each kept by its index in the node's rows, and, for
    // each run of those not made yet, a gap, a "Show more" row that makes
    // them, CHUNK at a time. shown counts the rows made.

    // fill makes node's first CHUNK children in list, and a gap for the
    // rest.
    fill(node, list) {
        const n = this.kids(node).length;
        const state = this.made.get(node) ?? {};
        this.made.set(node, state);
        state.rows = [];
        state.shown = 0;
        this.make(node, 0, Math.min(n, CHUNK), list, null);
        if (n > CHUNK) {
            list.append(this.gap(node, CHUNK, n));
        }
    }

    // make makes node's children from to to, in list before the element
    // before (or at its end).
    make(node, from, to, list, before) {
        const kids = this.kids(node);
        const state = this.made.get(node);
        const rows = document.createDocumentFragment();
        for (let i = from; i < to; i++) {
            const li = this.row(kids[i][0], kids[i][1], kids[i][2]);
            state.rows[i] = li;
            rows.append(li);
        }
        state.shown += to - from;
        list.insertBefore(rows, before);
    }

    // gap is the row standing for node's children from to to, not made:
    // its button makes the next CHUNK of them.
    gap(node, from, to) {
        const total = this.kids(node).length;
        const more = el("button", { type: "button" });
        const li = el("li", { className: "more" }, more);
        Object.assign(li, { gapFrom: from, gapTo: to });
        const label = () => {
            const left = li.gapTo - li.gapFrom;
            more.textContent = li.gapTo === total && li.gapFrom === this.made.get(node).shown
                ? `Show ${Math.min(CHUNK, left).toLocaleString()} more of ${total.toLocaleString()}`
                : `Show ${Math.min(CHUNK, left).toLocaleString()} of the ${left.toLocaleString()} not shown here`;
        };
        li.relabel = label;
        more.addEventListener("click", () => {
            const end = Math.min(li.gapTo, li.gapFrom + CHUNK);
            this.make(node, li.gapFrom, end, li.parentNode, li);
            li.gapFrom = end;
            if (li.gapFrom >= li.gapTo) {
                li.remove();
            } else {
                label();
            }
        });
        label();
        return li;
    }

    // reveal makes node's child i, if it's not made, with AROUND rows either
    // side of it, splitting the gap it's in; and returns its row.
    reveal(node, list, i) {
        const state = this.made.get(node);
        if (state.rows[i]) {
            return state.rows[i];
        }
        const gap = [...list.children].find((c) => c.classList.contains("more") && c.gapFrom <= i && i < c.gapTo);
        if (!gap) {
            return null;
        }
        const from = Math.max(gap.gapFrom, i - AROUND);
        const to = Math.min(gap.gapTo, i + AROUND + 1);
        if (from > gap.gapFrom) {
            list.insertBefore(this.gap(node, gap.gapFrom, from), gap);
        }
        this.make(node, from, to, list, gap);
        gap.gapFrom = to;
        if (gap.gapFrom >= gap.gapTo) {
            gap.remove();
        } else {
            gap.relabel();
        }
        return state.rows[i];
    }

    // row is the line for node, by its label (a key, isKey, or an index).
    row(label, node, isKey) {
        const li = el("li", { role: "treeitem" });
        const line = el("div", { className: "json-line" });
        if (label !== null) {
            line.append(el("span", { className: isKey ? "json-key" : "json-index", textContent: label }), el("span", { className: "json-colon", textContent: ": " }));
        }
        if (isContainer(node)) {
            const n = countOf(node);
            const toggle = el("button", { type: "button", className: "json-toggle", textContent: glyphs.chevronRight, disabled: n === 0 });
            toggle.setAttribute("aria-label", n ? "Unfold" : "Empty");
            line.prepend(toggle);
            line.append(el("span", { className: "json-summary", textContent: node.t === "object" ? `{ ${n} ${n === 1 ? "key" : "keys"} }` : `[ ${n} ${n === 1 ? "item" : "items"} ]` }));
            toggle.addEventListener("click", () => (this.made.get(node)?.open ? this.close(node) : this.open(node)));
            li.setAttribute("aria-expanded", "false");
            this.made.set(node, { ...(this.made.get(node) ?? {}), li, toggle, shown: 0, open: false });
        } else {
            line.prepend(el("span", { className: "json-toggle-space" }));
            line.append(node.t === "error"
                ? el("span", { className: "json-error", textContent: `not JSON: ${node.error}` })
                : el("span", { className: `json-${node.t === "true" || node.t === "false" ? "bool" : node.t}`, textContent: node.raw ?? node.t }));
        }
        li.append(line);
        li.jsonNode = node;
        return li;
    }

    open(node) {
        const state = this.made.get(node);
        if (!state?.li || state.open) {
            return;
        }
        if (!state.list) {
            state.list = el("ul", { role: "group" });
            state.li.append(state.list);
            this.fill(node, state.list);
        }
        state.list.hidden = false;
        state.open = true;
        state.toggle.textContent = glyphs.chevronDown;
        state.toggle.setAttribute("aria-label", "Fold");
        state.li.setAttribute("aria-expanded", "true");
    }

    close(node) {
        const state = this.made.get(node);
        if (state?.list) {
            state.list.hidden = true;
        }
        if (state?.toggle) {
            state.open = false;
            state.toggle.textContent = glyphs.chevronRight;
            state.toggle.setAttribute("aria-label", "Unfold");
            state.li.setAttribute("aria-expanded", "false");
        }
    }

    foldAll() {
        for (const [node, state] of this.made) {
            if (node !== this.root && state.open) {
                this.close(node);
            }
        }
    }

    find() {
        this.query = this.search.value;
        this.matches = searchJSON(this.root, this.query);
        this.at = this.matches.length ? 0 : -1;
        this.show();
    }

    step(by) {
        if (this.matches.length) {
            this.at = (this.at + by + this.matches.length) % this.matches.length;
            this.show();
        }
    }

    // show unfolds the way to the match at, makes it if it's not made yet,
    // and scrolls to it.
    show() {
        const n = this.matches.length;
        this.found.textContent = !this.query?.trim() ? "" : n ? `${this.at + 1} of ${n >= MAX_MATCHES ? `${MAX_MATCHES.toLocaleString()}+` : n.toLocaleString()}` : "Not found";
        this.element.querySelector(".json-line.current")?.classList.remove("current");
        for (const e of this.element.querySelectorAll(".hit")) {
            e.classList.remove("hit");
        }
        if (this.at < 0) {
            return;
        }
        const { path, key } = this.matches[this.at];
        let node = this.root;
        let list = this.tree;
        let li = null;
        for (const i of path) {
            if (node !== this.root) {
                this.open(node);
                list = this.made.get(node).list;
            }
            // Made, with a few either side, not all before it.
            li = this.reveal(node, list, i);
            node = this.kids(node)[i][1];
        }
        const line = li?.querySelector(":scope > .json-line") ?? this.tree.querySelector(".json-line");
        if (line) {
            line.classList.add("current");
            line.querySelector(key ? ".json-key" : ".json-string, .json-number, .json-bool, .json-null")?.classList.add("hit");
            line.scrollIntoView({ block: "center" });
        }
    }
}
