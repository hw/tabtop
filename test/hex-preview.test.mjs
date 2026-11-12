import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { hexDump, hexView, createHexRangeSource, decodeAt, selectionAs, parseSearch, patchRuns, encodeValue } from "../tabtopd/hex-view.js";
import { typeOf, limits, binaryChunkSize } from "../tabtopd/preview-model.js";
import { iconSVG } from "../tabtopd/glyphs.js";

test("hex rows preserve offsets, all bytes, ASCII boundaries and final-row alignment", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const rows = hexDump(bytes).split("\n");
    assert.equal(rows.length, 16);
    for (let i = 0; i < rows.length; i++) {
        assert.equal(rows[i].slice(0, 8), (i * 16).toString(16).padStart(8, "0"));
        assert.deepEqual(rows[i].slice(10, 58).trim().split(/\s+/),
            Array.from(bytes.slice(i * 16, i * 16 + 16), b => b.toString(16).padStart(2, "0")));
    }
    assert.match(rows[1], /\|\.{16}\|$/);
    assert.match(rows[2], /\| !"#\$%&'\(\)\*\+,-\.\/\|$/);
    assert.match(rows[7], /\|pqrstuvwxyz\{\|\}~\.\|$/);
    const partial = hexDump(Uint8Array.of(60, 38, 0, 255));
    assert.equal(partial.indexOf("|"), rows[0].indexOf("|"));
    assert.match(partial, /\|<&\.\. {12}\|$/);
    assert.equal(hexDump(new Uint8Array()), "");
    assert.match(hexDump(bytes, 16, 18), /^00000010  10 11/);
});

// The hex view's parts: its bar, the column header, the rows, the inspector.
const parts = (view) => ({ controls: view.children[0], head: view.children[1].children[0].children[0],
    content: view.children[1].children[0].children[1], inspector: view.children[1].children[1] });

function mockNode(tag) {
    const node = {
        tag, tagName: tag.toUpperCase(), children: [], listeners: {}, className: "",
        dataset: {}, style: {},
        classList: {
            tokens() { return new Set((node.className || "").split(/\s+/).filter(Boolean)); },
            contains(name) { return this.tokens().has(name); },
            add(name) { const t = this.tokens(); t.add(name); node.className = [...t].join(" "); },
            remove(name) { const t = this.tokens(); t.delete(name); node.className = [...t].join(" "); },
            toggle(name, on) { if (on) this.add(name); else this.remove(name); },
        },
        append(...children) { this.children.push(...children); },
        replaceChildren(...children) { this.children = children; },
        scrollIntoView() {},
        addEventListener(name, fn) { this.listeners[name] = fn; },
        closest(sel) {
            const classes = sel.split(",").map(s => s.trim().replace(/^\./, ""));
            return classes.some(c => this.classList.contains(c)) ? this : null;
        },
        contains(other) {
            return other === this || this.children.some(child => child === other || child?.contains?.(other));
        },
        querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; },
        querySelectorAll(sel) {
            const out = [];
            const visit = current => {
                if (!current || typeof current === "string") return;
                const cls = current.className || "";
                if (sel.startsWith(".hex-row[") && cls.includes("hex-row") &&
                    current.dataset?.offset === sel.match(/"(\d+)"/)?.[1]) out.push(current);
                else if (sel === ".hex-byte, .hex-char" && (cls.includes("hex-byte") || cls.includes("hex-char"))) out.push(current);
                for (const child of current.children ?? []) visit(child);
            };
            visit(this);
            return out;
        },
        get textContent() {
            if (this._text != null && !this.children.length) return this._text;
            return this.children.map(child => typeof child === "string" ? child : child.textContent).join("");
        },
        set textContent(value) { this._text = value; this.children = []; },
    };
    return node;
}

test("hex view pages split address, hex and ASCII columns with absolute offsets", () => {
    const oldDocument = globalThis.document;
    globalThis.document = { createElement: mockNode };
    try {
        const bytes = new Uint8Array(4097).fill(60);
        const view = hexView(bytes);
        const { controls, head, content } = parts(view);
        assert.equal(head.children[0].children[0].textContent, "Offset");
        assert.equal(head.children[0].children[1].children[15].textContent, "0f");
        const [previous, status, next, previousRange, nextRange] = controls.children;
        assert.deepEqual([previous, next, previousRange, nextRange].map((b) => [b.textContent, b.title]),
            [["<", "Previous bytes"], [">", "Next bytes"], ["−1 MB", "Previous 1 MB"], ["+1 MB", "Next 1 MB"]]);
        // Which bytes, and what's to say, apart: a phone shows only the second.
        assert.deepEqual(status.children.map((c) => c.className), ["hex-range", "hex-sep", "hex-note"]);
        assert.equal(previous.disabled, true);
        assert.equal(next.disabled, false);
        assert.equal(content.children.length, 256);
        assert.equal(content.children[0].children[0].textContent, "00000000");
        assert.equal(content.children[0].children[1].children[0].textContent, "3c");
        assert.equal(content.children[0].children[2].children[0].textContent, "<");
        next.listeners.click();
        assert.equal(content.children[0].children[0].textContent, "00001000");
        assert.equal(content.children[0].children[1].children[0].textContent, "3c");
        assert.equal(content.children[0].children[2].children[0].textContent, "<");
        assert.equal(next.disabled, true);
        assert.match(status.textContent, /4,096/);
        previous.listeners.click();
        assert.equal(content.children[0].children[0].textContent, "00000000");
        assert.equal(previous.disabled, true);
        assert.equal(hexView(new Uint8Array()).textContent, "This file is empty.");
    } finally {
        globalThis.document = oldDocument;
    }
});

test("hex and ASCII drag selection stay in sync", async () => {
    const oldDocument = globalThis.document;
    globalThis.document = { createElement: mockNode, elementFromPoint: () => null };
    try {
        const view = hexView(Uint8Array.of(65, 66, 67, 68, 0));
        const { content } = parts(view);
        const hex = content.children[0].children[1].children;
        const ascii = content.children[0].children[2].children;
        globalThis.document.elementFromPoint = () => ascii[3];
        content.listeners.pointerdown({ button: 0, pointerId: 1, target: hex[1], preventDefault() {} });
        content.listeners.pointermove({ clientX: 0, clientY: 0, target: ascii[3] });
        assert.equal(hex[1].classList.contains("selected"), true);
        assert.equal(hex[2].classList.contains("selected"), true);
        assert.equal(hex[3].classList.contains("selected"), true);
        assert.equal(ascii[1].classList.contains("selected"), true);
        assert.equal(ascii[2].classList.contains("selected"), true);
        assert.equal(ascii[3].classList.contains("selected"), true);
        assert.equal(hex[0].classList.contains("selected"), false);
        assert.equal(ascii[0].classList.contains("selected"), false);
        content.listeners.pointerup({});
        await view.jump(0, 2);
        const hexAfter = content.children[0].children[1].children;
        const asciiAfter = content.children[0].children[2].children;
        assert.equal(hexAfter[0].classList.contains("selected"), true);
        assert.equal(asciiAfter[0].classList.contains("selected"), true);
        assert.equal(hexAfter[1].classList.contains("selected"), true);
        assert.equal(asciiAfter[1].classList.contains("selected"), true);
        assert.equal(hexAfter[2].classList.contains("selected"), false);
    } finally {
        globalThis.document = oldDocument;
    }
});

test("hex selection: rows by address, Shift extends, Escape clears, Ctrl+C copies as the column chosen in", async () => {
    const oldDocument = globalThis.document;
    const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    let copied = null;
    globalThis.document = { createElement: mockNode, elementFromPoint: () => null };
    Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async (t) => { copied = t; } } }, configurable: true });
    try {
        const bytes = Uint8Array.from({ length: 40 }, (_, i) => 65 + i);
        const view = hexView(bytes);
        const status = view.children[0].children[1];
        const { content } = parts(view);
        const row = (i) => content.children[i];
        const cells = (i, column) => row(i).children[column === "ascii" ? 2 : 1].children;
        const selectedHex = () => content.querySelectorAll(".hex-byte, .hex-char").filter((c) => c.classList.contains("hex-byte") && c.classList.contains("selected")).map((c) => Number(c.dataset.offset));
        const key = (key, more = {}) => {
            let prevented = false, stopped = false;
            content.listeners.keydown({ key, ctrlKey: false, metaKey: false, altKey: false, ...more, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
            return { prevented, stopped };
        };
        // An address: its row of 16.
        const address = row(1).children[0];
        address.closest = (sel) => (sel === ".hex-addr" ? address : sel === ".hex-row" ? row(1) : null);
        content.listeners.pointerdown({ button: 0, target: address, preventDefault() {} });
        assert.deepEqual(selectedHex(), Array.from({ length: 16 }, (_, i) => 16 + i));
        assert.match(status.textContent, /^Bytes 0–39 of 40 · 16 bytes selected \(0x10–0x1f\)$/);
        // Dragged up the offsets, to row 0: both rows; to row 2, the last
        // row's bytes there are (to 0x27).
        const address0 = row(0).children[0];
        address0.closest = (sel) => (sel === ".hex-addr" ? address0 : sel === ".hex-row" ? row(0) : null);
        content.listeners.pointermove({ clientX: 0, clientY: 0, target: address0 });
        assert.deepEqual(selectedHex(), Array.from({ length: 32 }, (_, i) => i));
        const address2 = row(2).children[0];
        address2.closest = (sel) => (sel === ".hex-addr" ? address2 : sel === ".hex-row" ? row(2) : null);
        content.listeners.pointermove({ clientX: 0, clientY: 0, target: address2 });
        assert.deepEqual(selectedHex(), Array.from({ length: 24 }, (_, i) => 16 + i));
        content.listeners.pointerup({});
        content.listeners.pointerdown({ button: 0, target: address, preventDefault() {} });
        content.listeners.pointerup({});
        // A byte in the ASCII column, then Shift with another: from the first.
        content.listeners.pointerdown({ button: 0, pointerId: 1, target: cells(0, "ascii")[2], preventDefault() {} });
        content.listeners.pointerup({});
        content.listeners.pointerdown({ button: 0, pointerId: 1, shiftKey: true, target: cells(0, "ascii")[5], preventDefault() {} });
        content.listeners.pointerup({});
        assert.deepEqual(selectedHex(), [2, 3, 4, 5]);
        assert.equal(key("c", { ctrlKey: true }).prevented, true);
        await new Promise((r) => setTimeout(r));
        assert.equal(copied, "CDEF");
        assert.match(status.textContent, /Copied 4 bytes as text\.$/);
        // From the hex column: copied as hex.
        content.listeners.pointerdown({ button: 0, pointerId: 1, target: cells(0, "hex")[0], preventDefault() {} });
        content.listeners.pointerup({});
        content.listeners.pointerdown({ button: 0, pointerId: 1, shiftKey: true, target: cells(0, "hex")[2], preventDefault() {} });
        content.listeners.pointerup({});
        key("c", { metaKey: true });
        await new Promise((r) => setTimeout(r));
        assert.equal(copied, "41 42 43");
        // Escape: cleared, and kept from the preview; again, left to it.
        assert.deepEqual(key("Escape"), { prevented: true, stopped: true });
        assert.deepEqual(selectedHex(), []);
        assert.equal(status.textContent, "Bytes 0–39 of 40");
        assert.deepEqual(key("Escape"), { prevented: false, stopped: false });
    } finally {
        globalThis.document = oldDocument;
        if (oldNavigator) Object.defineProperty(globalThis, "navigator", oldNavigator);
    }
});

test("unknown previews explicitly select text or hex, enforce limits and close transfers", async () => {
    const source = readFileSync(new URL("../tabtopd/preview-loaders.js", import.meta.url), "utf8")
        .replace(/^import .*;\n/gm, "").replace("export async function loadPreview", "async function loadPreview");
    let size = 3, closed = 0, collected = 0, content = Uint8Array.of(65, 0, 255);
    const requests = [];
    const env = { typeOf, limits, binaryChunkSize, TextDecoder, Blob, join: (d, n) => `${d}/${n}`,
        call: async req => { requests.push(req); return { reply: { size, mtime: 1, length: Math.min(size, req.length ?? size) }, close() { closed++; } }; },
        collect: async (_t, _size, _progress, type) => { collected++; return new Blob([content], { type }); } };
    runInNewContext(`${source}\nglobalThis.loadPreview = loadPreview;`, env);
    await assert.rejects(env.loadPreview("folder", "sample.unknown"), /isn't supported/);
    for (const mode of ["text", "hex"]) {
        const result = await env.loadPreview("folder", "sample.unknown", { mode });
        assert.equal(result.file.kind, "hex");
        assert.equal(result.file.textAvailable, false);
        assert.equal(result.blob.size, 3);
        assert.deepEqual(requests.at(-1).path, "folder/sample.unknown");
    }
    assert.equal(closed, 2);
    // Too big for its own preview (or text): hex, from its first part,
    // the first transfer closed unread.
    size = limits.text + 1;
    for (const [name, mode] of [["sample.txt", "text"], ["installer.sh", null]]) {
        const big = await env.loadPreview("folder", name, { mode });
        assert.equal(big.file.kind, "hex", name);
        assert.equal(big.file.truncated, true);
        assert.equal(requests.at(-2).length, undefined);
        assert.equal(requests.at(-1).offset, 0);
        assert.equal(requests.at(-1).length, binaryChunkSize);
    }
    assert.equal(collected, 4);
    assert.equal(closed, 6);
    size = 3;
    assert.equal((await env.loadPreview("folder", "sample.unknown", { mode: "auto" })).file.kind, "hex");
    for (const text of ["", "hello\n", "こんにちは\n"]) {
        content = new TextEncoder().encode(text); size = content.length;
        const loaded = await env.loadPreview("folder", "sample.unknown", { mode: "auto" });
        assert.equal(loaded.file.kind, "text");
        assert.equal(loaded.file.textAvailable, true);
        const hex = await env.loadPreview("folder", "sample.unknown", { mode: "hex" });
        assert.equal(hex.file.kind, "hex");
        assert.equal(hex.file.textAvailable, true);
    }
    size = 50_000_000;
    content = new TextEncoder().encode("partial text");
    const partial = await env.loadPreview("folder", "large.unknown", { mode: "auto" });
    assert.equal(partial.file.size, size);
    assert.equal(partial.file.previewSize, 10_000_000);
    assert.equal(partial.file.truncated, true);
    assert.equal(partial.file.kind, "text");
    assert.equal(partial.file.textAvailable, true);
    assert.equal(requests.at(-2).offset, 0);
    assert.equal(requests.at(-2).length, binaryChunkSize);
    assert.equal(requests.at(-1).offset, binaryChunkSize);
    assert.equal(requests.at(-1).length, 10_000_000 - binaryChunkSize);
    assert.equal(requests.at(-1).if_mtime, 1);
    assert.equal(requests.at(-1).if_size, size);
    const collectText = env.collect;
    env.collect = async () => new Blob([requests.at(-1).offset ? Uint8Array.of(0) : "readable header"]);
    const binaryTail = await env.loadPreview("folder", "large.unknown", { mode: "auto" });
    assert.equal(binaryTail.file.kind, "hex");
    assert.equal(binaryTail.file.textAvailable, false);
    env.collect = collectText;
    content = Uint8Array.of(0xe2, 0x82); // A UTF-8 character split at the preview boundary.
    assert.equal((await env.loadPreview("folder", "large.unknown", { mode: "hex" })).file.textAvailable, true);
    size = 50_000_000; content = Uint8Array.of(0, 0, 0);
    const binaryRequest = requests.length;
    const largeBinary = await env.loadPreview("folder", "large.unknown", { mode: "auto" });
    assert.equal(largeBinary.file.kind, "hex");
    assert.equal(largeBinary.file.previewSize, binaryChunkSize);
    assert.equal(requests.length, binaryRequest + 1);
    assert.equal(requests.at(-1).length, binaryChunkSize);
    const largeKnown = await env.loadPreview("folder", "large.pdf", { mode: "hex" });
    assert.equal(largeKnown.file.kind, "hex");
    assert.equal(largeKnown.file.previewSize, binaryChunkSize);
    content = Uint8Array.of(0xff, 0xfe); size = 2;
    assert.equal((await env.loadPreview("folder", "sample.unknown", { mode: "auto" })).file.kind, "hex");
});


test("hex byte ranges are aligned, bounded, version-reader driven and correctly labelled", async () => {
    const first = new Uint8Array(binaryChunkSize).fill(65);
    const calls = [];
    const source = createHexRangeSource(first, 2 * binaryChunkSize + 17, async (begin, end) => {
        calls.push([begin, end]); return new Uint8Array(end - begin).fill(begin / binaryChunkSize + 65).buffer;
    });
    assert.equal((await source.read(12)).bytes, first);
    assert.equal(calls.length, 0);
    const second = await source.read(binaryChunkSize + 5);
    assert.deepEqual(calls[0], [binaryChunkSize, 2 * binaryChunkSize]);
    assert.match(hexDump(second.bytes, 0, 1, second.begin), /^000f4240  42/);
    await source.read(binaryChunkSize + 4096);
    assert.equal(calls.length, 1);
    const last = await source.read(2 * binaryChunkSize + 16);
    assert.equal(last.bytes.length, 17);
    assert.deepEqual(calls.at(-1), [2 * binaryChunkSize, 2 * binaryChunkSize + 17]);
    await assert.rejects(source.read(2 * binaryChunkSize + 17), /outside/);
});

test("cancelled and out-of-order hex requests cannot replace the current range", async () => {
    const pending = [];
    const source = createHexRangeSource(new Uint8Array(binaryChunkSize), 4 * binaryChunkSize,
        (begin, end) => new Promise(resolve => pending.push({ begin, end, resolve })));
    const controller = new AbortController();
    const cancelled = source.read(binaryChunkSize, { signal: controller.signal });
    controller.abort();
    pending[0].resolve(new ArrayBuffer(binaryChunkSize));
    await assert.rejects(cancelled, { name: "AbortError" });
    assert.ok(source.cached(0));
    const stale = source.read(binaryChunkSize);
    const latest = source.read(2 * binaryChunkSize);
    pending[2].resolve(new ArrayBuffer(binaryChunkSize)); await latest;
    pending[1].resolve(new ArrayBuffer(binaryChunkSize));
    await assert.rejects(stale, { name: "AbortError" });
    assert.ok(source.cached(2 * binaryChunkSize));
    assert.equal(source.cached(binaryChunkSize), null);
    const bad = createHexRangeSource(new Uint8Array(binaryChunkSize), 2 * binaryChunkSize, async () => new ArrayBuffer(1));
    await assert.rejects(bad.read(binaryChunkSize), /Incomplete/);
});

test("bytes decode as int16 to float64, both ways round, as far as there are bytes", () => {
    const row = (bytes, type) => decodeAt(bytes).find((r) => r.type === type);
    assert.deepEqual(row(Uint8Array.of(0xff, 0xfe), "int16"), { type: "int16", be: "-2", le: "-257" });
    assert.deepEqual(row(Uint8Array.of(0xff, 0xfe), "uint16"), { type: "uint16", be: "65534", le: "65279" });
    assert.deepEqual(row(Uint8Array.of(0xff, 0xfe), "int32"), { type: "int32", be: null, le: null });
    assert.deepEqual(row(Uint8Array.of(0x3f, 0x80, 0, 0), "float32"), { type: "float32", be: "1", le: "4.60060299e-41" });
    assert.equal(row(Uint8Array.of(0xc0, 0, 0, 0), "int32").be, "-1073741824");
    assert.equal(row(Uint8Array.of(0x7f, 0xc0, 0, 0), "float32").be, "NaN");
    const pi = Uint8Array.of(0x40, 0x09, 0x21, 0xfb, 0x54, 0x44, 0x2d, 0x18);
    assert.equal(row(pi, "float64").be, "3.141592653589793");
    assert.equal(row(pi, "uint64").be, "4614256656552045848");
    const ones = new Uint8Array(8).fill(0xff);
    assert.deepEqual([row(ones, "uint64").le, row(ones, "int64").le, row(ones, "float64").le], ["18446744073709551615", "-1", "NaN"]);
    // From a subarray's own start, not its buffer's.
    assert.equal(row(Uint8Array.of(9, 9, 1, 0).subarray(2), "uint16").le, "1");
    assert.deepEqual(decodeAt(new Uint8Array()).map((r) => r.be), Array(11).fill(null));
    // Raw: the bytes as one hex number, as many as there are, up to 8.
    assert.deepEqual(row(pi, "raw"), { type: "raw", be: "0x400921fb54442d18", le: "0x182d4454fb210940" });
    assert.deepEqual(row(Uint8Array.of(1, 2), "raw"), { type: "raw", be: "0x0102", le: "0x0201" });
    // A byte: the same either way round.
    assert.deepEqual(row(Uint8Array.of(0xff), "int8"), { type: "int8", be: "-1", le: "-1" });
    assert.deepEqual(row(Uint8Array.of(0xff), "uint8"), { type: "uint8", be: "255", le: "255" });
    assert.deepEqual(decodeAt(Uint8Array.of(0x80)).map((r) => r.type).slice(0, 3), ["raw", "int8", "uint8"]);
});

test("the data inspector shows the selection's values, copies each, and its buttons copy the selection", async () => {
    const bytes = Uint8Array.of(0x48, 0x69, 0x00, 0xff);
    assert.equal(selectionAs("hex", bytes, 16), "48 69 00 ff");
    assert.equal(selectionAs("ascii", bytes, 16), "Hi..");
    assert.equal(selectionAs("base64", bytes, 16), "SGkA/w==");
    assert.equal(selectionAs("offset", bytes, 16), "0x10-0x13");
    assert.equal(selectionAs("offset", bytes.subarray(0, 1), 255), "0xff");
    // As chosen in Copy as …: case, separator and prefix.
    assert.equal(selectionAs("hex", bytes, 16, { upper: true, separator: ", ", prefix: "0x" }), "0x48, 0x69, 0x00, 0xFF");
    assert.equal(selectionAs("hex", bytes, 16, { separator: "" }), "486900ff");
    assert.equal(selectionAs("hex", bytes, 16, { separator: "\n", prefix: "\\x" }), "\\x48\n\\x69\n\\x00\n\\xff");
    const big = Uint8Array.from({ length: 100000 }, (_, i) => i * 7);
    assert.equal(selectionAs("base64", big, 0), Buffer.from(big).toString("base64"));

    const oldDocument = globalThis.document;
    const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    let copied = null;
    const appended = [];
    globalThis.document = { createElement: (tag) => Object.assign(mockNode(tag), tag === "dialog" ? { showModal() {}, close() { this.closed = true; } } : {}),
        elementFromPoint: () => null, body: { append: (n) => appended.push(n) } };
    Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async (t) => { copied = t; } } }, configurable: true });
    try {
        const view = hexView(Uint8Array.from({ length: 40 }, (_, i) => 65 + i));
        const { controls, content, inspector } = parts(view);
        const status = controls.children[1];
        // The toggle: in the bar (unless placed elsewhere), with it shown.
        assert.equal(view.inspectorToggle, controls.children.at(-1));
        assert.equal(inspector.hidden, false);
        const [tabs, head, table, actions] = inspector.children;
        const [at, endian] = head.children;
        const button = (kind) => actions.children.find((b) => b.className === `hex-copy-${kind}`);
        const valueRow = (type) => table.children[0].children.find((tr) => tr.children[0].textContent === type);
        // i: 1 big-endian, 2 little-endian, as the switch is set to read.
        const order = (i) => endian.children.find((b) => b.className === `hex-endian-${i === 1 ? "be" : "le"}`).listeners.click();
        const value = (type, i) => { order(i); return valueRow(type).children[1].children[0].children[0].textContent; };
        const copyGlyph = (type, i) => { order(i); return valueRow(type).children[1].children[0].children.at(-1); };
        // Little-endian, to start with.
        assert.equal(endian.children[0].getAttribute?.("aria-pressed") ?? "true", "true");
        assert.equal(at.textContent, "Select bytes to see what they read as.");
        assert.equal(button("hex").disabled, true);
        const hex = content.children[1].children[1].children;
        content.listeners.pointerdown({ button: 0, pointerId: 1, target: hex[0], preventDefault() {} });
        content.listeners.pointerup({});
        content.listeners.pointerdown({ button: 0, pointerId: 1, shiftKey: true, target: hex[2], preventDefault() {} });
        content.listeners.pointerup({});
        // From 0x10: Q R S T U V W X.
        assert.equal(at.textContent, "From 0x10, little-endian");
        assert.equal(value("uint16", 1), String(0x5152));
        assert.equal(value("uint16", 2), String(0x5251));
        assert.equal(value("int32", 1), String(0x51525354));
        assert.equal(value("uint64", 2), String(0x5857565554535251n));
        copyGlyph("int32", 1).listeners.click();
        await new Promise((r) => setTimeout(r));
        assert.equal(copied, String(0x51525354));
        assert.match(status.textContent, /Copied int32 \(big-endian\) 1364349780\.$/);
        for (const [kind, want, said] of [["hex", "51 52 53", /Copied 3 bytes as hex\.$/], ["ascii", "QRS", /Copied 3 bytes as text\.$/],
            ["offset", "0x10-0x12", /Copied its offset\.$/], ["base64", "UVJT", /Copied 3 bytes as Base64\.$/]]) {
            button(kind).listeners.click();
            await new Promise((r) => setTimeout(r));
            assert.equal(copied, want, kind);
            assert.match(status.textContent, said);
        }
        // Near the end, the wider types have no bytes enough: "—".
        const last = content.children[2].children[1].children;
        content.listeners.pointerdown({ button: 0, pointerId: 1, target: last[5], preventDefault() {} });
        content.listeners.pointerup({});
        assert.equal(at.textContent, "From 0x25, big-endian");
        assert.equal(value("int16", 1), String(0x6667));
        assert.equal(value("int32", 1), "—");
        assert.equal(copyGlyph("int32", 1).hidden, true);
        content.listeners.keydown({ key: "Escape", preventDefault() {}, stopPropagation() {} });
        assert.equal(button("hex").disabled, true);
        assert.equal(at.textContent, "Select bytes to see what they read as.");
        // Hidden with the toggle, and shown again.
        view.inspectorToggle.listeners.click();
        assert.equal(inspector.hidden, true);
        assert.equal(view.inspectorToggle.title, "Show the data inspector");
        view.inspectorToggle.listeners.click();
        assert.equal(inspector.hidden, false);
    } finally {
        globalThis.document = oldDocument;
        if (oldNavigator) Object.defineProperty(globalThis, "navigator", oldNavigator);
    }
});

test("search patterns: hex with ? for any digit or byte, or ASCII as UTF-8", () => {
    const hex = (p) => { const { value, mask } = parseSearch(p, "hex"); return [Buffer.from(value).toString("hex"), Buffer.from(mask).toString("hex")]; };
    assert.deepEqual(hex("4d 5a ?? 00"), ["4d5a0000", "ffff00ff"]);
    assert.deepEqual(hex("4D5A ? 00"), ["4d5a0000", "ffff00ff"]);
    assert.deepEqual(hex("4? ?f"), ["400f", "f00f"]);
    assert.deepEqual(hex("0xff 0x0A"), ["ff0a", "ffff"]);
    assert.deepEqual([...parseSearch("Hé", "ascii").value], [0x48, 0xc3, 0xa9]);
    for (const [bad, said] of [["4d 5", /pairs/], ["zz", /digits/], ["?? ?", /isn't \?/], ["", /Type/], ["00".repeat(257), /256/]]) {
        assert.throws(() => parseSearch(bad, "hex"), said, bad);
    }
    assert.throws(() => parseSearch("", "ascii"), /Type/);
    assert.deepEqual(patchRuns(new Map([[5, 0xab], [3, 1], [4, 2], [9, 0]])), [{ offset: 3, hex: "0102ab" }, { offset: 9, hex: "00" }]);
});

test("editing: hex digits change a byte a half at a time, ASCII the whole, Ctrl+Z undoes, Save sends runs, Done discards", async () => {
    const oldDocument = globalThis.document;
    globalThis.document = { createElement: mockNode, elementFromPoint: () => null };
    try {
        const bytes = Uint8Array.from({ length: 40 }, (_, i) => 65 + i);
        const view = hexView(bytes);
        const { content, inspector } = parts(view);
        const cell = (at, column = "hex") => content.children[Math.floor(at / 16)].children[column === "ascii" ? 2 : 1].children[at % 16];
        const key = (k, more = {}) => content.listeners.keydown({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...more, preventDefault() {}, stopPropagation() {} });
        let sent = null, told = null, fail = null, sentBytes = null;
        const editing = view.startEditing({
            save: async (runs, ifBytes) => { if (fail) throw new Error(fail); sent = runs; sentBytes = ifBytes; return { mtime: "2", size: 40 }; },
            saved: async (runs, reply) => { told = reply; },
        });
        await new Promise((r) => setTimeout(r));
        assert.equal(editing.dirty(), false);
        assert.equal(cell(0).classList.contains("caret"), true);
        // Hex: "f" then "0" makes the first byte f0, and moves on.
        key("f");
        assert.equal(cell(0).textContent, "f1");
        assert.equal(cell(0).classList.contains("caret-low"), true);
        key("0");
        await new Promise((r) => setTimeout(r));
        assert.equal(cell(0).textContent, "f0");
        assert.equal(cell(0, "ascii").textContent, ".");
        assert.equal(cell(0).classList.contains("edited"), true);
        assert.equal(cell(1).classList.contains("caret"), true);
        assert.equal(editing.dirty(), true);
        // The inspector reads the change: from byte 0, uint16 f0 42.
        key("ArrowLeft");
        await new Promise((r) => setTimeout(r));
        inspector.children[1].children[1].children.find((b) => b.className === "hex-endian-be").listeners.click();
        assert.equal(inspector.children[2].children[0].children.find((tr) => tr.children[0].textContent === "uint16").children[1].children[0].children[0].textContent, String(0xf042));
        inspector.children[1].children[1].children.find((b) => b.className === "hex-endian-le").listeners.click();
        key("ArrowRight");
        await new Promise((r) => setTimeout(r));
        // ASCII: Tab over, type "zz": bytes 1 and 2.
        key("Tab");
        key("z");
        await new Promise((r) => setTimeout(r));
        key("z");
        await new Promise((r) => setTimeout(r));
        assert.equal(cell(1, "ascii").textContent, "z");
        assert.equal(cell(2).textContent, "7a");
        // Down a row, and typing there: byte 19.
        key("ArrowDown");
        await new Promise((r) => setTimeout(r));
        key("Tab");
        key("0");
        key("0");
        await new Promise((r) => setTimeout(r));
        assert.equal(cell(19).textContent, "00");
        // Undo the last: 19 back, and the caret on it.
        key("z", { ctrlKey: true });
        await new Promise((r) => setTimeout(r));
        key("z", { ctrlKey: true });
        await new Promise((r) => setTimeout(r));
        assert.equal(cell(19).textContent, (65 + 19).toString(16));
        assert.equal(cell(19).classList.contains("edited"), false);
        // Typed back to what it was: not a change.
        assert.equal(cell(19).classList.contains("caret"), true);
        // Save: the runs, in order; then nothing pending, and what was read
        // (the first range, which Kaitai shares) changed too.
        fail = "the disk is full";
        await editing.save();
        assert.equal(sent, null);
        assert.equal(editing.dirty(), true);
        fail = null;
        await editing.save();
        assert.deepEqual(sent, [{ offset: 0, hex: "f07a7a" }]);
        // With the bytes it had there ("ABC"), to be checked still to be.
        assert.deepEqual([...sentBytes], [0x41, 0x42, 0x43]);
        assert.deepEqual(told, { mtime: "2", size: 40 });
        assert.equal(editing.dirty(), false);
        assert.deepEqual([...bytes.subarray(0, 3)], [0xf0, 0x7a, 0x7a]);
        assert.equal(cell(0).classList.contains("edited"), false);
        // Another change, then Done: discarded, the saved ones kept.
        key("ArrowUp");
        await new Promise((r) => setTimeout(r));
        key("9");
        assert.equal(editing.dirty(), true);
        editing.stop();
        assert.equal(editing.dirty(), false);
        assert.equal(cell(0).textContent, "f0");
        assert.equal(content.classList.contains("editing"), false);
        // Not editing, typing changes nothing.
        key("1");
        assert.equal(cell(0).textContent, "f0");
    } finally {
        globalThis.document = oldDocument;
    }
});

test("editing during a save: what's typed meanwhile stays, undoable, put back is a change; stopped meanwhile, the preview's still told", async () => {
    const oldDocument = globalThis.document;
    globalThis.document = { createElement: mockNode, elementFromPoint: () => null };
    try {
        const view = hexView(Uint8Array.from({ length: 40 }, (_, i) => 65 + i));
        const { content } = parts(view);
        const cell = (at) => content.children[Math.floor(at / 16)].children[1].children[at % 16];
        const key = (k, more = {}) => content.listeners.keydown({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...more, preventDefault() {}, stopPropagation() {} });
        const tick = () => new Promise((r) => setTimeout(r));
        let finish = null, told = 0;
        const start = () => view.startEditing({
            save: () => new Promise((r) => { finish = () => r({ mtime: "2", size: 40 }); }),
            saved: () => { told++; },
        });
        let editing = start();
        await tick();
        // Byte 0 to 00, byte 1 to 00; saving.
        key("0"); key("0"); await tick();
        key("0"); key("0"); await tick();
        const saving = editing.save();
        // Meanwhile: byte 0 back to what the file had (41), byte 2 to 00.
        key("ArrowLeft"); await tick();
        key("ArrowLeft"); await tick();
        key("4"); key("1"); await tick();
        key("ArrowRight"); await tick();
        key("0"); key("0"); await tick();
        finish();
        await saving;
        assert.equal(told, 1);
        // 0 is 41 still, now a change from what's saved; 1 saved; 2 pending.
        assert.equal(cell(0).textContent, "41");
        assert.equal(cell(0).classList.contains("edited"), true);
        assert.equal(cell(1).classList.contains("edited"), false);
        assert.equal(cell(2).classList.contains("edited"), true);
        // What was typed meanwhile undoes (a digit at a time): 2, then 0
        // back to what's saved (00).
        key("z", { ctrlKey: true }); await tick();
        key("z", { ctrlKey: true }); await tick();
        assert.equal(cell(2).textContent, "43");
        assert.equal(cell(2).classList.contains("edited"), false);
        key("z", { ctrlKey: true }); await tick();
        key("z", { ctrlKey: true }); await tick();
        assert.equal(cell(0).textContent, "00");
        assert.equal(cell(0).classList.contains("edited"), false);
        // The saved change itself doesn't undo.
        key("z", { ctrlKey: true }); await tick();
        assert.equal(cell(1).textContent, "00");
        // Stopped while saving: the preview's still told the new version.
        key("ArrowRight"); await tick();
        key("ArrowRight"); await tick();
        key("7"); key("7"); await tick();
        const second = editing.save();
        editing.stop();
        finish();
        await second;
        assert.equal(told, 2);
        assert.equal(cell(2).textContent, "77");
        assert.equal(cell(2).classList.contains("edited"), false);
    } finally {
        globalThis.document = oldDocument;
    }
});

test("find asks search a stretch at a time, from the selection, and selects what it finds", async () => {
    const oldDocument = globalThis.document;
    globalThis.document = { createElement: mockNode, elementFromPoint: () => null };
    try {
        const asked = [];
        const view = hexView(new Uint8Array(64), {
            search: async (q) => {
                asked.push(q);
                if (q.backward) return { found: -1, next: -1 };
                return q.offset < 20 ? { found: -1, next: 20 } : { found: 33, next: -1 };
            },
        });
        const { controls, content } = parts(view);
        const status = controls.children[1];
        const form = controls.children.find((c) => c.className === "hex-find");
        const [mode, input] = form.children;
        assert.equal(form.hidden, false);
        input.value = "de ?? be";
        form.listeners.submit({ preventDefault() {} });
        await new Promise((r) => setTimeout(r, 10));
        assert.deepEqual(asked.map((q) => [q.pattern, q.mask, q.offset, q.backward]), [["de00be", "ff00ff", 0, false], ["de00be", "ff00ff", 20, false]]);
        const selected = content.querySelectorAll(".hex-byte, .hex-char").filter((c) => c.classList.contains("hex-byte") && c.classList.contains("selected")).map((c) => Number(c.dataset.offset));
        assert.deepEqual(selected, [33, 34, 35]);
        assert.match(status.textContent, /Found at 0x21\.$/);
        // Back from there: from 32, and not found.
        form.children[2].listeners.click();
        await new Promise((r) => setTimeout(r, 10));
        assert.deepEqual([asked.at(-1).offset, asked.at(-1).backward], [32, true]);
        assert.match(status.textContent, /Not found before there\.$/);
        // No search to ask: no form.
        assert.equal(parts(hexView(new Uint8Array(4))).controls.children.find((c) => c.className === "hex-find").hidden, true);
        // Hex or ASCII: a glyph, a drawn 0x or Aa; ASCII looks for the text's bytes.
        assert.deepEqual([mode.dataset.mode, mode.innerHTML === iconSVG("find-hex"), input.placeholder], ["hex", true, "4d 5a ?? 00"]);
        mode.listeners.click();
        assert.deepEqual([mode.dataset.mode, mode.innerHTML === iconSVG("find-ascii"), input.placeholder], ["ascii", true, "text"]);
        input.value = "AB";
        form.listeners.submit({ preventDefault() {} });
        await new Promise((r) => setTimeout(r, 10));
        assert.deepEqual([asked.at(-1).pattern, asked.at(-1).mask], ["4142", "ffff"]);
        mode.listeners.click();
        assert.equal(mode.dataset.mode, "hex");
    } finally {
        globalThis.document = oldDocument;
    }
});

test("the inspector disassembles the selection (or from a byte), as chosen, once it settles", async () => {
    const oldDocument = globalThis.document;
    globalThis.document = { createElement: mockNode, elementFromPoint: () => null };
    try {
        const asked = [];
        let failing = null;
        const disassemble = async (bytes, address, bitness, max) => {
            asked.push({ bytes: [...bytes], address, bitness, max });
            if (failing) throw new Error(failing);
            return [{ offset: address, length: 1, text: "push rbp" }, { offset: address + 1, length: 3, text: "mov rbp,rsp" }, { offset: address + 4, length: 1, text: "(bad)" }, ...extra];
        };
        let extra = [];
        const code = Uint8Array.from({ length: 100 }, (_, i) => i);
        const view = hexView(code, { disassemble });
        const { content, inspector } = parts(view);
        const disasm = inspector.children.at(-1);
        const [lines, note] = disasm.children;
        // Values | Disassembly, and the instruction set at their right.
        const [tabGroup, bitness] = inspector.children[0].children;
        const [valuesTab, disasmTab] = tabGroup.children;
        assert.equal(inspector.dataset.tab, "values");
        disasmTab.listeners.click();
        const hex = (row) => content.children[row].children[1].children;
        const settle = () => new Promise((r) => setTimeout(r, 200));
        // Bytes 2 to 6 selected: those five, from 2.
        content.listeners.pointerdown({ button: 0, pointerId: 1, target: hex(0)[2], preventDefault() {} });
        content.listeners.pointerup({});
        content.listeners.pointerdown({ button: 0, pointerId: 1, shiftKey: true, target: hex(0)[6], preventDefault() {} });
        content.listeners.pointerup({});
        await settle();
        assert.deepEqual(asked.at(-1), { bytes: [2, 3, 4, 5, 6], address: 2, bitness: "x86-64", max: 512 });
        assert.equal(lines.children.length, 3);
        const [at, raw, text] = lines.children[1].children;
        assert.deepEqual([at.textContent, raw.textContent, text.textContent], ["00000003", "03 04 05", "mov rbp,rsp"]);
        assert.equal(lines.children[2].className, "hex-disasm-line bad");
        assert.equal(note.textContent, "");
        // One byte: the 64 from it.
        content.listeners.pointerdown({ button: 0, pointerId: 1, target: hex(1)[0], preventDefault() {} });
        content.listeners.pointerup({});
        await settle();
        assert.equal(asked.at(-1).address, 16);
        assert.equal(asked.at(-1).bytes.length, 64);
        assert.match(note.textContent, /^The 64 bytes from 0x10; select bytes/);
        // 32-bit, asked again; the same, not.
        const count = asked.length;
        bitness.value = "x86-32";
        bitness.listeners.change();
        await settle();
        assert.equal(asked.length, count + 1);
        assert.equal(asked.at(-1).bitness, "x86-32");
        // On Values: not asked; failing: said.
        valuesTab.listeners.click();
        content.listeners.pointerdown({ button: 0, pointerId: 1, target: hex(2)[0], preventDefault() {} });
        content.listeners.pointerup({});
        await settle();
        assert.equal(asked.length, count + 1);
        failing = "the disassembler isn't available here";
        disasmTab.listeners.click();
        await settle();
        assert.equal(lines.children.length, 0);
        assert.equal(note.textContent, "the disassembler isn't available here");
        // On Values, not asked; Disassembly asks.
        failing = null;
        valuesTab.listeners.click();
        assert.equal(inspector.dataset.tab, "values");
        const before = asked.length;
        content.listeners.pointerdown({ button: 0, pointerId: 1, target: hex(3)[0], preventDefault() {} });
        content.listeners.pointerup({});
        await settle();
        assert.equal(asked.length, before);
        disasmTab.listeners.click();
        await settle();
        assert.deepEqual([inspector.dataset.tab, asked.length, asked.at(-1).address], ["disasm", before + 1, 48]);
        // Where an instruction goes, a link there, its code then shown; a
        // number that's not where it goes, or past the file's end, not.
        extra = [{ offset: 53, length: 2, text: "jmp short 0050h", targets: [0x50] }, { offset: 55, length: 2, text: "mov al,50h", targets: [] },
            { offset: 57, length: 5, text: "call 0000000000001000h", targets: [0x1000] }];
        bitness.value = "x86-16";
        bitness.listeners.change();
        await settle();
        const texts = lines.children.slice(3).map((li) => li.children[2]);
        assert.deepEqual(texts.map((t) => t.textContent), ["jmp short 0050h", "mov al,50h", "call 0000000000001000h"]);
        assert.deepEqual(texts.map((t) => t.children.filter((c) => c.className === "hex-disasm-target").length), [1, 0, 0]);
        const link = texts[0].children[1];
        assert.deepEqual([link.textContent, link.value], ["0050h", "80"]);
        lines.listeners.click({ target: link });
        await settle();
        assert.equal(asked.at(-1).address, 80);
        assert.match(note.textContent, /^The 20 bytes from 0x50;/);
        valuesTab.listeners.click();
        assert.equal(inspector.dataset.tab, "values");
    } finally {
        globalThis.document = oldDocument;
    }
});

test("values encode as their type, either way round, within its range", () => {
    const h = (type, text, little = false) => Buffer.from(encodeValue(type, text, little)).toString("hex");
    assert.equal(h("int32", "5", true), "05000000");
    assert.equal(h("int32", "-1"), "ffffffff");
    assert.equal(h("uint16", "0x1234"), "1234");
    assert.equal(h("uint16", "0x1234", true), "3412");
    assert.equal(h("int16", "-32768"), "8000");
    assert.equal(h("int8", "-1"), "ff");
    assert.equal(h("int8", "-128", true), "80");
    // Hex is the bytes' value, signed or not: 0xff is an int8's -1.
    assert.equal(h("int8", "0xff"), "ff");
    assert.equal(h("int8", "0x80"), "80");
    assert.equal(h("uint8", "0XFF"), "ff");
    assert.equal(h("int16", "0xfffe", true), "feff");
    assert.equal(h("int32", "0xffffffff"), "ffffffff");
    assert.equal(h("int32", "0x7fffffff", true), "ffffff7f");
    assert.equal(h("int64", "0x8000000000000000"), "8000000000000000");
    assert.equal(h("uint64", "0xffffffffffffffff", true), "ffffffffffffffff");
    assert.equal(h("int16", "-0x10"), "fff0");
    // With a sign, hex is the number, made negative with -: -0x7f is -127.
    assert.equal(h("int8", "-0x7F"), "81");
    assert.equal(h("int8", "-0x80"), "80");
    assert.equal(h("int8", "+0x7f"), "7f");
    assert.equal(h("int32", "-0x1", true), "ffffffff");
    assert.equal(h("int64", "-0x8000000000000000"), "8000000000000000");
    assert.throws(() => encodeValue("int8", "+0xff", false), /from -128 to 127/);
    // Raw: hex, as many bytes as there's room for, either way round.
    assert.deepEqual([...encodeValue("raw", "0x0102", false, 4)], [0, 0, 1, 2]);
    assert.deepEqual([...encodeValue("raw", "0102", true, 4)], [2, 1, 0, 0]);
    assert.deepEqual([...encodeValue("raw", "ffffffffffffffff", false)], Array(8).fill(255));
    assert.throws(() => encodeValue("raw", "0x10000", false, 2), /Raw is 2 bytes here, up to 0xffff\./);
    assert.throws(() => encodeValue("raw", "12g", false), /hex digits/);
    assert.throws(() => encodeValue("int8", "-0x81", false), /from -128 to 127/);
    assert.equal(h("uint8", "0xff"), "ff");
    assert.throws(() => encodeValue("int8", "128", false), / An int8 is from -128 to 127, or in hex 0x0 to 0xff\.$/);
    assert.throws(() => encodeValue("uint8", "256", false), / A uint8 is from 0 to 255\.$/);
    assert.equal(h("uint64", "18446744073709551615", true), "ffffffffffffffff");
    assert.equal(h("int64", "-2"), "fffffffffffffffe");
    assert.equal(h("float32", "1.5"), "3fc00000");
    assert.equal(h("float64", "-2.5e-3", true), Buffer.from(new Float64Array([-2.5e-3]).buffer).toString("hex"));
    assert.equal(h("float64", "NaN"), "7ff8000000000000");
    assert.equal(h("float32", "-Infinity"), "ff800000");
    for (const [type, text, said] of [["uint16", "65536", / A uint16 is from 0 to 65535\.$/], ["int16", "-32769", / An int16 is from -32768 to 32767, or in hex 0x0 to 0xffff\.$/], ["int8", "0x100", /0x0 to 0xff\.$/], ["int8", "-0x81", /from -128/],
        ["int32", "1.5", /whole number/], ["uint32", "-1", /from 0/], ["float32", "abc", / A float32 is a number/], ["int32", " ", /Type a value/],
        ["uint64", "18446744073709551616", /from 0 to 18446744073709551615/]]) {
        assert.throws(() => encodeValue(type, text, false), said, `${type} ${text}`);
    }
});

test("editing, a value typed in the inspector writes its bytes at the selection, undone at once", async () => {
    const oldDocument = globalThis.document;
    globalThis.document = { createElement: mockNode, elementFromPoint: () => null };
    try {
        const view = hexView(Uint8Array.from({ length: 32 }, (_, i) => i), { disassemble: async () => [] });
        const { content, inspector } = parts(view);
        const cell = (at) => content.children[Math.floor(at / 16)].children[1].children[at % 16];
        // i: 1 big-endian, 2 little-endian, as the switch is set to read.
        const box = (type, i) => {
            inspector.children[1].children[1].children.find((b) => b.className === `hex-endian-${i === 1 ? "be" : "le"}`).listeners.click();
            return inspector.children[2].children[0].children.find((tr) => tr.children[0].textContent === type).children[1].children[0].children[1];
        };
        const key = (k, more = {}) => content.listeners.keydown({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...more, preventDefault() {}, stopPropagation() {} });
        // Not editing: a box does nothing.
        content.listeners.pointerdown({ button: 0, pointerId: 1, target: cell(4), preventDefault() {} });
        content.listeners.pointerup({});
        box("int32", 2).value = "5";
        box("int32", 2).listeners.change();
        assert.equal(cell(4).textContent, "04");
        const editing = view.startEditing({ save: async () => ({}) });
        await new Promise((r) => setTimeout(r));
        assert.equal(inspector.classList.contains("editing"), true);
        content.listeners.pointerdown({ button: 0, pointerId: 1, target: cell(4), preventDefault() {} });
        content.listeners.pointerup({});
        // int32, little-endian, 5: bytes 4-7 are 05 00 00 00.
        box("int32", 2).value = "5";
        box("int32", 2).listeners.keydown({ key: "Enter", preventDefault() {}, stopPropagation() {} });
        assert.deepEqual([4, 5, 6, 7].map((at) => cell(at).textContent), ["05", "00", "00", "00"]);
        assert.equal(cell(6).classList.contains("edited"), true);
        assert.equal(box("int32", 2).value, "5");
        assert.equal(editing.dirty(), true);
        // uint16, big-endian, 0x1234, over two of them.
        box("uint16", 1).value = "0x1234";
        box("uint16", 1).listeners.change();
        assert.deepEqual([4, 5, 6].map((at) => cell(at).textContent), ["12", "34", "00"]);
        // Ctrl+Z: the uint16, both bytes, then the int32, all four.
        key("z", { ctrlKey: true });
        assert.deepEqual([4, 5, 6, 7].map((at) => cell(at).textContent), ["05", "00", "00", "00"]);
        key("z", { ctrlKey: true });
        await new Promise((r) => setTimeout(r));
        assert.deepEqual([4, 5, 6, 7].map((at) => cell(at).textContent), ["04", "05", "06", "07"]);
        assert.equal(editing.dirty(), false);
        // int8, -1: byte 4 alone is ff; undone.
        box("int8", 2).value = "-1";
        box("int8", 2).listeners.change();
        assert.deepEqual([4, 5].map((at) => cell(at).textContent), ["ff", "05"]);
        key("z", { ctrlKey: true });
        await new Promise((r) => setTimeout(r));
        assert.equal(cell(4).textContent, "04");
        // Not a value of its type: nothing changes.
        box("int16", 1).value = "40000";
        box("int16", 1).listeners.change();
        assert.equal(cell(4).textContent, "04");
        assert.equal(editing.dirty(), false);
        // Near the end, a type wider than the bytes left: no box.
        content.listeners.pointerdown({ button: 0, pointerId: 1, target: cell(30), preventDefault() {} });
        content.listeners.pointerup({});
        assert.equal(box("int32", 1).disabled, true);
        assert.equal(box("int16", 1).disabled, false);
        editing.stop();
        assert.equal(inspector.classList.contains("editing"), false);
    } finally {
        globalThis.document = oldDocument;
    }
});

test("editing, an instruction typed over one in the disassembly writes its bytes, padded with nops, undone at once", async () => {
    const oldDocument = globalThis.document;
    globalThis.document = { createElement: mockNode, elementFromPoint: () => null };
    try {
        // push rbp; mov rbp,rsp; ret; nop at 0-5, as a disassembler says.
        const code = Uint8Array.from([0x55, 0x48, 0x89, 0xe5, 0xc3, 0x90, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        const disassemble = async () => [{ offset: 0, length: 1, text: "push rbp" }, { offset: 1, length: 3, text: "mov rbp,rsp" },
            { offset: 4, length: 1, text: "ret" }, { offset: 5, length: 1, text: "nop" }];
        const asked = [];
        const assemble = async (text, address, bitness, was) => {
            asked.push({ text, address, bitness, was: [...was] });
            if (text === "nop") return { bytes: Uint8Array.of(0x90), text: "nop" };
            if (text === "mov eax,1") return { bytes: Uint8Array.of(0xb8, 1, 0, 0, 0), text: "mov eax,1" };
            throw new Error(`"${text}" isn't an x86 instruction.`);
        };
        const view = hexView(code, { disassemble, assemble });
        const { controls, content, inspector } = parts(view);
        const disasm = inspector.children.at(-1);
        const lines = disasm.children[0];
        inspector.children[0].children[0].children[1].listeners.click();
        const cell = (at) => content.children[0].children[1].children[at];
        const bytes = (from, to) => Array.from({ length: to - from }, (_, i) => cell(from + i).textContent).join(" ");
        const settle = () => new Promise((r) => setTimeout(r, 200));
        const status = () => controls.children.find((c) => c.classList.contains("edit-status")).textContent;
        content.listeners.pointerdown({ button: 0, pointerId: 1, target: cell(0), preventDefault() {} });
        content.listeners.pointerup({});
        content.listeners.pointerdown({ button: 0, pointerId: 1, shiftKey: true, target: cell(5), preventDefault() {} });
        content.listeners.pointerup({});
        await settle();
        // Not editing: a click opens nothing.
        lines.listeners.click({ target: lines.children[1] });
        assert.equal(lines.children[1].children[2].className, "hex-disasm-text");
        const editing = view.startEditing({ save: async () => ({}) });
        await settle();
        assert.equal(disasm.classList.contains("editable"), true);
        const open = (i) => {
            lines.listeners.click({ target: lines.children[i] });
            // The offset, then the box, over the bytes' room and the instruction's.
            assert.equal(lines.children[i].children.length, 2);
            return lines.children[i].children[1];
        };
        const enter = async (input, text) => {
            input.value = text;
            input.listeners.keydown({ key: "Enter", preventDefault() {}, stopPropagation() {} });
            await settle();
        };
        // nop over mov rbp,rsp (3 bytes): 90, then two nops.
        let input = open(1);
        assert.deepEqual([input.className, input.value], ["hex-disasm-input", "mov rbp,rsp"]);
        await enter(input, "nop");
        assert.deepEqual(asked.at(-1), { text: "nop", address: 1, bitness: 64, was: [0x48, 0x89, 0xe5] });
        assert.equal(bytes(0, 6), "55 90 90 90 c3 90");
        assert.equal(status(), "Set 0x1 to nop, with 2 nops after it.");
        assert.equal(editing.dirty(), true);
        // Ctrl+Z: all three at once.
        content.listeners.keydown({ key: "z", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, preventDefault() {}, stopPropagation() {} });
        await settle();
        assert.equal(bytes(0, 6), "55 48 89 e5 c3 90");
        // Longer, over ret: five bytes, from 1 to 5, no nops.
        await enter(open(1), "mov eax,1");
        assert.equal(bytes(0, 7), "55 b8 01 00 00 00 00");
        assert.equal(status(), "Set 0x1 to mov eax,1, over the 2 instructions after it.");
        content.listeners.keydown({ key: "z", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, preventDefault() {}, stopPropagation() {} });
        await settle();
        // Not an instruction: said, and the box stays to correct it.
        input = open(2);
        await enter(input, "bogus");
        assert.equal(status(), "\"bogus\" isn't an x86 instruction.");
        assert.equal(lines.children[2].children[1], input);
        assert.equal(bytes(0, 6), "55 48 89 e5 c3 90");
        // Escape: put back as it was; unchanged, Enter does nothing either.
        input.listeners.keydown({ key: "Escape", preventDefault() {}, stopPropagation() {} });
        assert.equal(lines.children[2].children[2].className, "hex-disasm-text");
        const count = asked.length;
        await enter(open(0), "push rbp");
        assert.equal(asked.length, count);
        assert.equal(lines.children[0].children[2].className, "hex-disasm-text");
        // Done: nothing to click.
        editing.stop();
        await settle();
        assert.equal(disasm.classList.contains("editable"), false);
    } finally {
        globalThis.document = oldDocument;
    }
});

test("instruction sets migrate old preferences, persist ARM/MIPS choices, and guard pending mode changes", async () => {
    const oldDocument = globalThis.document, oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const kept = new Map([["tabtop.hex-disasm", JSON.stringify({ tab: "values", bitness: 32 })]]);
    globalThis.document = { createElement: mockNode, elementFromPoint: () => null };
    Object.defineProperty(globalThis, "localStorage", { value: { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, v) }, configurable: true });
    const pending = [];
    let assembled = 0, view;
    try {
        view = hexView(new Uint8Array(32), {
            disassemble: (bytes, address, mode) => new Promise((resolve) => pending.push({ mode, resolve })),
            assemble: async () => { assembled++; throw new Error("ARM must not assemble"); },
        });
        const { content, inspector } = parts(view);
        const [tabs, mode] = inspector.children[0].children;
        const disasm = inspector.children.at(-1), lines = disasm.children[0];
        assert.equal(mode.value, "x86-32");
        assert.deepEqual(mode.children.map((o) => o.value), ["x86-64", "x86-32", "x86-16", "arm64", "arm32", "thumb", "mips32-le", "mips32-be", "mips64-le", "mips64-be"]);
        view.startEditing({ save: async () => ({}) });
        content.listeners.pointerdown({ button: 0, pointerId: 1, target: content.children[0].children[1].children[0], preventDefault() {} });
        content.listeners.pointerup({});
        tabs.children[1].listeners.click();
        const settle = () => new Promise((r) => setTimeout(r, 200));
        await settle();
        assert.equal(pending[0].mode, "x86-32");
        mode.value = "arm64";
        mode.listeners.change();
        // An old response arriving during the debounce must not appear.
        pending[0].resolve([{ offset: 0, length: 1, text: "old x86" }]);
        await Promise.resolve();
        assert.equal(lines.children.length, 0);
        await settle();
        pending[1].resolve([{ offset: 0, length: 4, text: "b #0x10", targets: [16] }]);
        await Promise.resolve();
        assert.equal(lines.children[0].children[2].textContent, "b #0x10");
        assert.equal(lines.children[0].children[2].children[1].className, "hex-disasm-target");
        assert.equal(disasm.classList.contains("editable"), false);
        lines.listeners.click({ target: lines.children[0] });
        assert.equal(lines.children[0].children.length, 3);
        assert.equal(assembled, 0);
        for (const next of ["thumb", "mips64-be"]) {
            mode.value = next;
            mode.listeners.change();
            await settle();
            assert.equal(pending.at(-1).mode, next);
            pending.at(-1).resolve([{ offset: 0, length: 4, text: "nop" }]);
            await Promise.resolve();
            assert.equal(disasm.classList.contains("editable"), false);
        }
        assert.deepEqual(JSON.parse(kept.get("tabtop.hex-disasm")), { tab: "disasm", mode: "mips64-be" });
        const reopened = hexView(new Uint8Array(4), { disassemble: async () => [] });
        assert.equal(parts(reopened).inspector.children[0].children[1].value, "mips64-be");
        reopened.stop();
    } finally {
        view?.stop();
        globalThis.document = oldDocument;
        if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage);
        else delete globalThis.localStorage;
    }
});

test("the byte order chosen is remembered, and the inspector starts with it", () => {
    const oldDocument = globalThis.document, oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const kept = new Map([["tabtop.hex-endian", "be"]]);
    globalThis.document = { createElement: mockNode, elementFromPoint: () => null };
    Object.defineProperty(globalThis, "localStorage", { value: { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, v) }, configurable: true });
    try {
        const view = hexView(Uint8Array.of(1, 2, 3, 4), { disassemble: async () => [] });
        const { content, inspector } = parts(view);
        const [at, endian] = inspector.children[1].children;
        const int16 = () => inspector.children[2].children[0].children.find((tr) => tr.children[0].textContent === "int16").children[1].children[0].children[0].textContent;
        content.listeners.pointerdown({ button: 0, pointerId: 1, target: content.children[0].children[1].children[0], preventDefault() {} });
        content.listeners.pointerup({});
        assert.equal(at.textContent, "From 0x0, big-endian");
        assert.equal(int16(), String(0x0102));
        endian.children.find((b) => b.className === "hex-endian-le").listeners.click();
        assert.equal(kept.get("tabtop.hex-endian"), "le");
        assert.equal(at.textContent, "From 0x0, little-endian");
        assert.equal(int16(), String(0x0201));
    } finally {
        globalThis.document = oldDocument;
        if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage);
        else delete globalThis.localStorage;
    }
});

test("an unsigned value the same as the signed one above it is dimmed, not hidden", () => {
    const oldDocument = globalThis.document;
    globalThis.document = { createElement: mockNode, elementFromPoint: () => null };
    try {
        // 7f ff: int8 127 = uint8 127; int16 big-endian 32767 = uint16; little-endian -129 and 65407.
        const view = hexView(Uint8Array.of(0x7f, 0xff, 0, 0), { disassemble: async () => [] });
        const { content, inspector } = parts(view);
        const rows = () => inspector.children[2].children[0].children;
        const value = (type) => rows().find((tr) => tr.children[0].textContent === type).children[1].children[0].children[0];
        const select = (at) => {
            content.listeners.pointerdown({ button: 0, pointerId: 1, target: content.children[0].children[1].children[at], preventDefault() {} });
            content.listeners.pointerup({});
        };
        select(0);
        assert.equal(rows().length, 11);
        // Raw, first: the bytes there (here, four), as the order reads them.
        assert.equal(value("raw").textContent, "0x0000ff7f");
        assert.equal(rows()[0].children[0].textContent, "raw");
        assert.equal(value("uint8").classList.contains("same"), true);
        assert.equal(value("uint8").title, "127, the same as int8");
        assert.equal(value("int8").classList.contains("same"), false);
        // Little-endian: ff7f, negative as int16, so uint16 differs.
        assert.equal(value("uint16").classList.contains("same"), false);
        inspector.children[1].children[1].children.find((b) => b.className === "hex-endian-be").listeners.click();
        assert.equal(value("uint16").classList.contains("same"), true);
        assert.equal(value("raw").textContent, "0x7fff0000");
        // From ff: uint8 255, int8 -1: not dimmed; still eleven rows.
        select(1);
        assert.equal(value("uint8").classList.contains("same"), false);
        assert.equal(value("uint8").textContent, "255");
        assert.equal(rows().length, 11);
    } finally {
        globalThis.document = oldDocument;
    }
});

test("editing: a byte changed, then another part of the file shown: undone or saved from there, as it was", async () => {
    const oldDocument = globalThis.document;
    globalThis.document = { createElement: mockNode, elementFromPoint: () => null };
    try {
        const size = 2_000_000;
        const file = Uint8Array.from({ length: size }, (_, i) => i % 251);
        const view = hexView(file.slice(0, binaryChunkSize), { size,
            readRange: async (begin, end) => file.slice(begin, end).buffer });
        const { content } = parts(view);
        const key = (k, more = {}) => content.listeners.keydown({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...more, preventDefault() {}, stopPropagation() {} });
        const tick = () => new Promise((r) => setTimeout(r, 10));
        let sent = null;
        const editing = view.startEditing({ save: async (runs) => { sent = runs; return { mtime: "2", size }; } });
        await tick();
        // A character typed: one change, undone at once.
        key("Tab"); key("A"); await tick();
        assert.equal(editing.dirty(), true);
        // Away, in the second megabyte: undone from there, it's as it was.
        await view.jump(1_500_000); await tick();
        key("z", { ctrlKey: true }); await tick();
        assert.equal(editing.dirty(), false, "undone from another range, the byte is the file's again");
        // Changed again, and saved from away: what was typed is sent.
        await view.jump(0, 1, "ascii"); await tick();
        key("B"); await tick();
        await view.jump(1_500_000); await tick();
        await editing.save();
        assert.deepEqual(sent, [{ offset: 0, hex: "42" }]);
        assert.equal(editing.dirty(), false);
    } finally {
        globalThis.document = oldDocument;
    }
});

test("editing, an instruction longer than those listed after it: the next one, past the list, is filled out with nops too", async () => {
    const oldDocument = globalThis.document;
    globalThis.document = { createElement: mockNode, elementFromPoint: () => null };
    try {
        // push rbp; mov rbp,rsp listed (the selection, 0-3); then, unlisted,
        // ret at 4 and a 4-byte add at 5-8.
        const code = Uint8Array.from([0x55, 0x48, 0x89, 0xe5, 0xc3, 0x48, 0x83, 0xc0, 0x01, 0, 0, 0, 0, 0, 0, 0]);
        const asked = [];
        const disassemble = async (bytes, begin) => {
            asked.push(begin);
            return begin === 0 ? [{ offset: 0, length: 1, text: "push rbp" }, { offset: 1, length: 3, text: "mov rbp,rsp" }]
                : [{ offset: 4, length: 1, text: "ret" }, { offset: 5, length: 4, text: "add rax,1" }];
        };
        const assemble = async () => ({ bytes: Uint8Array.of(0xb8, 1, 0, 0, 0), text: "mov eax,1" });
        const view = hexView(code, { disassemble, assemble });
        const { content, inspector } = parts(view);
        const lines = inspector.children.at(-1).children[0];
        inspector.children[0].children[0].children[1].listeners.click();
        const cell = (at) => content.children[0].children[1].children[at];
        const settle = () => new Promise((r) => setTimeout(r, 200));
        content.listeners.pointerdown({ button: 0, pointerId: 1, target: cell(0), preventDefault() {} });
        content.listeners.pointerup({});
        content.listeners.pointerdown({ button: 0, pointerId: 1, shiftKey: true, target: cell(3), preventDefault() {} });
        content.listeners.pointerup({});
        await settle();
        view.startEditing({ save: async () => ({}) });
        await settle();
        lines.listeners.click({ target: lines.children[1] });
        const input = lines.children[1].children[1];
        input.value = "mov eax,1";
        input.listeners.keydown({ key: "Enter", preventDefault() {}, stopPropagation() {} });
        await settle();
        // 1-5 the new one; 6-8, the rest of the add it ends inside, nops.
        const bytes = Array.from({ length: 10 }, (_, i) => cell(i).textContent).join(" ");
        assert.equal(bytes, "55 b8 01 00 00 00 90 90 90 00");
        assert.ok(asked.includes(4), "the bytes past the list were disassembled");
    } finally {
        globalThis.document = oldDocument;
    }
});
