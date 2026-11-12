import { copyText, el } from "./preview-dom.js";
import { binaryChunkSize } from "./preview-model.js";
import { iconSVG } from "./glyphs.js";
import { store, stored, storeJSON, storedJSON } from "./stored.js";

const PAGE_BYTES = 4096;
const pageStart = offset => Math.floor(offset / binaryChunkSize) * binaryChunkSize + Math.floor(offset % binaryChunkSize / PAGE_BYTES) * PAGE_BYTES;

// Hold one fetched range; the caller separately retains the first range for Kaitai.
// Requests carry a version in readRange, and stale/cancelled reads never replace cache.
export function createHexRangeSource(initial, size, readRange) {
    if (!Number.isSafeInteger(size) || size < initial.length || size < 0 || initial.length > binaryChunkSize) throw new Error("Invalid binary file size");
    let cached = { begin: 0, bytes: initial }, generation = 0;
    const contains = offset => offset >= cached.begin && offset < cached.begin + cached.bytes.length;
    return {
        cached(offset) { return contains(offset) ? cached : null; },
        async read(offset, { signal } = {}) {
            signal?.throwIfAborted();
            if (!Number.isSafeInteger(offset) || offset < 0 || offset >= size) throw new Error("Offset is outside the file");
            if (contains(offset)) return cached;
            if (!readRange) throw new Error("This range is unavailable");
            const mine = ++generation;
            const begin = Math.floor(offset / binaryChunkSize) * binaryChunkSize, end = Math.min(begin + binaryChunkSize, size);
            const buffer = await readRange(begin, end, { signal });
            signal?.throwIfAborted();
            if (mine !== generation) throw new DOMException("Read cancelled", "AbortError");
            if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== end - begin) throw new Error("Incomplete binary range");
            cached = { begin, bytes: new Uint8Array(buffer) };
            return cached;
        },
    };
}

// Fixed-width rows keep ASCII aligned, including at nonzero file offsets.
export function hexDump(bytes, start = 0, end = bytes.length, base = 0) {
    const rows = [];
    for (let offset = start; offset < Math.min(end, bytes.length); offset += 16) {
        const row = bytes.subarray(offset, Math.min(offset + 16, end));
        const hex = Array.from(row, hexByte);
        const left = hex.slice(0, 8).join(" ").padEnd(23);
        const right = hex.slice(8).join(" ").padEnd(23);
        const ascii = Array.from(row, byte => byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : ".").join("");
        rows.push(`${(base + offset).toString(16).padStart(8, "0")}  ${left}  ${right}  |${ascii.padEnd(16)}|`);
    }
    return rows.join("\n");
}

// hexByte is byte as two lower-case hex digits; hexBytes, bytes as them,
// joined by separator.
const hexByte = (byte) => byte.toString(16).padStart(2, "0");
const hexBytes = (bytes, separator = "") => Array.from(bytes, hexByte).join(separator);

function printable(byte) {
    return byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : ".";
}

// The types decodeAt reads, each [name, bytes it takes, DataView getter]. A
// byte reads the same either way round; DataView ignores its byte order.
// raw is up to 8 bytes (as many as there are) as one hex number.
const DECODED = [["raw", 1, null], ["int8", 1, "getInt8"], ["uint8", 1, "getUint8"], ["int16", 2, "getInt16"], ["uint16", 2, "getUint16"], ["int32", 4, "getInt32"], ["uint32", 4, "getUint32"],
    ["int64", 8, "getBigInt64"], ["uint64", 8, "getBigUint64"], ["float32", 4, "getFloat32"], ["float64", 8, "getFloat64"]];

// decodeAt is what bytes (from their start) read as, each type both ways
// round: [{type, be, le}], be and le as text, or null if there aren't
// bytes enough for that type.
export function decodeAt(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    // float32 to the 9 digits that tell any two apart; others as they are.
    const text = (type, v) => type === "float32" && Number.isFinite(v) ? String(Number(v.toPrecision(9))) : String(v);
    const raw = Array.from(bytes.subarray(0, 8), hexByte);
    return DECODED.map(([type, n, get]) => type === "raw" ? {
        type,
        be: raw.length ? "0x" + raw.join("") : null,
        le: raw.length ? "0x" + raw.toReversed().join("") : null,
    } : {
        type,
        be: bytes.length >= n ? text(type, view[get](0, false)) : null,
        le: bytes.length >= n ? text(type, view[get](0, true)) : null,
    });
}

// encodeValue is text, a value of type (one of decodeAt's), as its bytes,
// little-endian with little: integers in decimal, within the type's range,
// or 0x hex, the bytes' value (so 0xff is an int8's -1, as 0x80 is -128),
// or, with a sign, the number (-0x7f, -127; +0xff, too big for an int8);
// floats as numbers, NaN, or (-)Infinity; raw, hex, 0x or not, as a number
// of room bytes (up to 8), zeros before it. It throws, saying why, for text
// that isn't one.
export function encodeValue(type, text, little, room = 8) {
    const row = DECODED.find(([name]) => name === type);
    if (!row) throw new Error("Not a type.");
    if (type === "raw") {
        const digits = text.trim().replace(/^0x/i, "").replace(/[\s_]/g, "");
        if (!/^[0-9a-f]+$/i.test(digits)) throw new Error("Raw is hex digits, such as 0x0102 or ff00.");
        const v = BigInt("0x" + digits);
        if (v >> BigInt(room * 8)) throw new Error(`Raw is ${room} byte${room === 1 ? "" : "s"} here, up to 0x${"ff".repeat(room)}.`);
        const out = Uint8Array.from({ length: room }, (_, i) => Number((v >> BigInt(8 * (room - 1 - i))) & 0xffn));
        return little ? out.reverse() : out;
    }
    const [, n, get] = row;
    const view = new DataView(new ArrayBuffer(n));
    const set = get.replace(/^get/, "set");
    text = text.trim();
    if (!text) throw new Error("Type a value.");
    const a = /^int/.test(type) ? `An ${type}` : `A ${type}`;
    if (type.startsWith("float")) {
        const v = /^[-+]?(?:infinity|inf)$/i.test(text) ? (text.startsWith("-") ? -Infinity : Infinity) : /^nan$/i.test(text) ? NaN
            : /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(text) ? Number(text) : null;
        if (v === null) throw new Error(`${a} is a number, such as 1.5 or -2e10, or NaN or Infinity.`);
        view[set](0, v, little);
    } else {
        const negative = text.startsWith("-");
        const digits = negative || text.startsWith("+") ? text.slice(1) : text;
        if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(digits)) throw new Error(`${a} is a whole number, in decimal or 0x hex.`);
        let v = negative ? -BigInt(digits) : BigInt(digits);
        const bits = BigInt(n * 8);
        const signed = !type.startsWith("u");
        const [lo, hi] = signed ? [-(1n << (bits - 1n)), (1n << (bits - 1n)) - 1n] : [0n, (1n << bits) - 1n];
        const top = (1n << bits) - 1n;
        // Hex, signed, without a sign: the bytes' value, up to all ones
        // (0xff), as it reads. With one (-0x7f, +0x7f), the number itself.
        if (signed && digits === text && /^0x/i.test(digits) && v > hi && v <= top) v = BigInt.asIntN(n * 8, v);
        if (v < lo || v > hi) throw new Error(`${a} is from ${lo} to ${hi}${signed ? `, or in hex 0x0 to 0x${top.toString(16)}` : ""}.`);
        view[set](0, n === 8 ? v : Number(v), little);
    }
    return new Uint8Array(view.buffer);
}

// selectionAs is the bytes (at offset) as copied: "hex", space-separated
// pairs, or as format says ({upper, separator, prefix}: "0xFF, 0x00"
// is {upper: true, separator: ", ", prefix: "0x"}); "ascii", their
// characters, with "." for those that don't print; "base64"; or "offset",
// where they are, as 0x10 or 0x10-0x2f.
export function selectionAs(kind, bytes, offset, format = {}) {
    switch (kind) {
    case "offset": {
        const last = offset + bytes.length - 1;
        return bytes.length > 1 ? `0x${offset.toString(16)}-0x${last.toString(16)}` : `0x${offset.toString(16)}`;
    }
    case "ascii": return Array.from(bytes, printable).join("");
    case "base64": {
        let binary = "";
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(binary);
    }
    default: {
        const { upper = false, separator = " ", prefix = "" } = format;
        return Array.from(bytes, b => {
            const pair = hexByte(b);
            return prefix + (upper ? pair.toUpperCase() : pair);
        }).join(separator);
    }
    }
}

// How Copy as … last copied hex in this browser (see selectionAs).
const COPY_FORMAT_KEY = "tabtop.hex-copy-format";
const SEPARATORS = [[" ", "Space"], ["", "None"], [",", "Comma"], [", ", "Comma and space"], [":", "Colon"], ["-", "Dash"], ["\n", "New line"]];
function copyFormatWanted() {
    const f = storedJSON(COPY_FORMAT_KEY, {});
    return {
        upper: f.upper === true,
        separator: SEPARATORS.some(([v]) => v === f.separator) ? f.separator : " ",
        prefix: typeof f.prefix === "string" ? f.prefix.slice(0, 8) : "",
    };
}
const rememberCopyFormat = (format) => storeJSON(COPY_FORMAT_KEY, format);

// Whether the data inspector is shown, as last chosen in this browser.
const INSPECTOR_KEY = "tabtop.hex-inspector";
const inspectorWanted = () => stored(INSPECTOR_KEY) !== "hidden";
const rememberInspector = (shown) => store(INSPECTOR_KEY, shown ? "shown" : "hidden");

// parseSearch is what to look for, as typed in mode "hex" or "ascii":
// {value, mask}, bytes and which bits of them matter. In hex, bytes are
// pairs of digits, spaced or not, and ? matches any digit: "4?" any of
// 0x40-0x4f, and "?" alone, or "??", any byte. ASCII is matched as UTF-8.
export function parseSearch(text, mode) {
    let value, mask;
    if (mode === "ascii") {
        value = new TextEncoder().encode(text);
        mask = new Uint8Array(value.length).fill(0xff);
    } else {
        const digits = text.trim().split(/\s+/).filter(Boolean).map((t) => (t === "?" ? "??" : t.replace(/^0x/i, ""))).join("");
        if (!/^[0-9a-f?]*$/i.test(digits)) throw new Error("Hex is digits 0-9 and a-f, and ? for any.");
        if (digits.length % 2) throw new Error("Hex bytes are pairs of digits: one is missing.");
        value = new Uint8Array(digits.length / 2);
        mask = new Uint8Array(digits.length / 2);
        for (let i = 0; i < value.length; i++) {
            for (const [shift, ch] of [[4, digits[2 * i]], [0, digits[2 * i + 1]]]) {
                if (ch !== "?") {
                    value[i] |= parseInt(ch, 16) << shift;
                    mask[i] |= 0xf << shift;
                }
            }
        }
        if (value.length && mask.every((m) => m === 0)) throw new Error("Search for at least one hex digit that isn't ?.");
    }
    if (!value.length) throw new Error("Type what to search for.");
    if (value.length > 256) throw new Error("Search for at most 256 bytes.");
    return { value, mask };
}

// patchRuns is the bytes changed (a Map, offset to byte) as runs of
// neighbours, in order, for a file-patch request: [{offset, hex}].
export function patchRuns(changed) {
    const runs = [];
    for (const at of [...changed.keys()].sort((a, b) => a - b)) {
        const last = runs.at(-1);
        const pair = hexByte(changed.get(at));
        if (last && last.offset + last.hex.length / 2 === at) last.hex += pair;
        else runs.push({ offset: at, hex: pair });
    }
    return runs;
}

// The disassembly in the inspector: of the selection, up to so many bytes
// and instructions, or, with a byte selected, the bytes from it.
const DISASM_BYTES = 4096, DISASM_WINDOW = 64, DISASM_LINES = 512;
const DISASM_KEY = "tabtop.hex-disasm";
function disasmWanted() {
    const v = storedJSON(DISASM_KEY, {});
    return { tab: v.tab === "disasm" ? "disasm" : "values", bitness: [16, 32, 64].includes(v.bitness) ? v.bitness : 64 };
}
const rememberDisasm = (tab, bitness) => storeJSON(DISASM_KEY, { tab, bitness });

// workerCall asks disasm-worker.js, made when first asked, and shared by
// every hex view on the page: message resolves to its answer, or rejects
// with what it says (err.said) or that it couldn't be loaded.
function workerClient() {
    let worker = null, next = 0;
    const waiting = new Map();
    const failed = (message) => {
        for (const w of waiting.values()) w.reject(new Error(message));
        waiting.clear();
        worker?.terminate();
        worker = null;
    };
    return (message, transfer = []) => new Promise((resolve, reject) => {
        if (typeof Worker !== "function") {
            reject(new Error("This browser can't disassemble here."));
            return;
        }
        if (!worker) {
            worker = new Worker(new URL("./disasm-worker.js", import.meta.url));
            worker.onmessage = ({ data }) => {
                const w = waiting.get(data.id);
                if (!w) return;
                waiting.delete(data.id);
                if (data.error) w.reject(Object.assign(new Error(data.error), { said: true }));
                else w.resolve(data);
            };
            worker.onerror = (event) => {
                event.preventDefault?.();
                failed("The disassembler couldn't be loaded.");
            };
        }
        const id = ++next;
        waiting.set(id, { resolve, reject });
        worker.postMessage({ ...message, id }, transfer);
    });
}
const workerCall = workerClient();
// (bytes, address, bitness, max) resolves to [{offset, length, text}].
const sharedDisassembler = (bytes, address, bitness, max) => workerCall({ bytes, address, bitness, max }, [bytes.buffer]).then(
    (data) => data.lines,
    (err) => { throw err.said ? new Error(`It couldn't be disassembled: ${err.message}.`) : err; });
// (text, address, bitness, was) resolves to {bytes, text}: the line's bytes
// at address, and how it's shown (see x86-asm.js); was, the bytes there.
const sharedAssembler = (text, address, bitness, was) => workerCall({ assemble: text, address, bitness, was: Array.from(was ?? []) }).then(
    (data) => ({ bytes: Uint8Array.from(data.bytes), text: data.text }),
    (err) => { throw err.said ? new Error(err.message.replace(/^./, (c) => c.toUpperCase())) : err; });

// The most bytes one save changes (see maxPatchBytes in hex_edit.go).
const MAX_PATCH = 256 << 10;
// And in at most so many runs of bytes side by side (maxPatchRuns).
const MAX_RUNS = 10000;

// The byte order the inspector reads in, as last chosen in this browser:
// "le" (little-endian, as x86 and most files today), unless "be".
const ENDIAN_KEY = "tabtop.hex-endian";
const endianWanted = () => (stored(ENDIAN_KEY) === "be" ? "be" : "le");
const rememberEndian = (order) => store(ENDIAN_KEY, order);
const orderName = (order) => (order === "be" ? "big-endian" : "little-endian");

// The most bytes Ctrl+C copies: one fetched range's worth.
const MAX_COPY = binaryChunkSize;

// toClipboard is whether text went on the clipboard (see copyText).
const toClipboard = (text) => copyText(text).then(() => true, () => false);

// The column header: Offset, each byte's place in a row, and ASCII, laid
// out as a row is, so they line up.
function hexHead() {
    const hex = el("span", { className: "hex-bytes" });
    for (let i = 0; i < 16; i++) hex.append(el("span", { className: "hex-byte", textContent: hexByte(i) }));
    return el("div", { className: "hex-head", ariaHidden: "true" },
        el("div", { className: "hex-row" }, el("span", { className: "hex-addr", textContent: "Offset" }), hex,
            el("span", { className: "hex-ascii", textContent: "ASCII" })));
}

// hexView shows bytes, the first of a file of size bytes, reading the rest
// with readRange(begin, end, {signal}); search({pattern, mask, offset,
// backward, signal}) looks in the file (see tunnelFileSearch), if given;
// disassemble and assemble, x86 code (see sharedDisassembler, and
// sharedAssembler, for editing it). The element returned has jump(begin,
// end), stop(), and startEditing.
export function hexView(bytes, { size = bytes.length, readRange = null, search = null, disassemble = sharedDisassembler, assemble = sharedAssembler } = {}) {
    if (!size) return el("p", { className: "hint", textContent: "This file is empty." });
    const source = createHexRangeSource(bytes, size, readRange);
    // selected: {begin, end, from}, from the column it was chosen in ("hex"
    // or "ascii"), which Ctrl+C copies as; drag: the byte a drag started
    // at, its column, and where the pointer is.
    let start = 0, shownEnd = 0, selected = null, drag = null, controller = null, revision = 0, stopped = false, lastRange = null;
    // Bytes changed and not saved yet, and those saved since this was
    // shown (reads may come from a copy older than the save): offset to
    // byte, over what's read. editor: while editing (see startEditing).
    const pending = new Map(), saved = new Map();
    let editor = null;
    const byteOf = (at, range = lastRange) => pending.get(at) ?? saved.get(at) ?? range.bytes[at - range.begin];
    // The bytes from begin to end, in range, as they are now.
    const bytesFrom = (range, begin, end) => {
        const out = range.bytes.slice(begin - range.begin, end - range.begin);
        for (const map of [saved, pending]) {
            if (!map.size) continue;
            if (map.size < out.length) {
                for (const [at, v] of map) if (at >= begin && at < end && (map === pending || !pending.has(at))) out[at - begin] = v;
            } else {
                for (let at = begin; at < end; at++) if (map.has(at) && (map === pending || !pending.has(at))) out[at - begin] = map.get(at);
            }
        }
        return out;
    };
    const content = el("div", { className: "hex-dump", tabIndex: 0, ariaLabel: "Hexadecimal bytes and printable ASCII" });
    const head = hexHead();
    // The status: which bytes are shown, and what's to say (a selection, a
    // search's result, a copy), apart, so a phone can leave out the first.
    const statusRange = el("span", { className: "hex-range" });
    const statusSep = el("span", { className: "hex-sep" });
    const statusNote = el("span", { className: "hex-note" });
    const status = el("span", { className: "hint hex-status", role: "status" }, statusRange, statusSep, statusNote);
    const setStatus = (text) => {
        const w = where();
        let range = "", note = text;
        if (lastRange && text.startsWith(w)) {
            range = w;
            note = text.slice(w.length).replace(/^ · /, "");
        }
        statusRange.textContent = range;
        statusSep.textContent = range && note ? " · " : "";
        statusNote.textContent = note;
    };
    const navButton = (label, title, className) => {
        const b = el("button", { type: "button", textContent: label, title, className });
        b.setAttribute?.("aria-label", title);
        return b;
    };
    const previous = navButton("<", "Previous bytes", "hex-previous");
    const next = navButton(">", "Next bytes", "hex-next");
    const previousRange = navButton("−1 MB", "Previous 1 MB", "hex-previous-range");
    const nextRange = navButton("+1 MB", "Next 1 MB", "hex-next-range");
    const offsetInput = el("input", { type: "text", inputMode: "numeric", placeholder: "Offset or 0x…", ariaLabel: "Byte offset" });
    const jumpForm = el("form", { className: "hex-jump" }, offsetInput, el("button", { type: "submit", textContent: "Go" }));
    const buttons = () => {
        previous.disabled = start === 0;
        next.disabled = Math.min(start + PAGE_BYTES, (Math.floor(start / binaryChunkSize) + 1) * binaryChunkSize) >= size;
        previousRange.disabled = start < binaryChunkSize;
        nextRange.disabled = (Math.floor(start / binaryChunkSize) + 1) * binaryChunkSize >= size;
    };
    const where = () => `Bytes ${start.toLocaleString()}–${(shownEnd - 1).toLocaleString()} of ${size.toLocaleString()}`;
    const selectionText = () => {
        if (!selected) return "";
        const n = selected.end - selected.begin;
        const hex = (v) => "0x" + v.toString(16);
        return ` · ${n.toLocaleString()} byte${n === 1 ? "" : "s"} selected (${hex(selected.begin)}${n > 1 ? `–${hex(selected.end - 1)}` : ""})`;
    };
    // The data inspector: what the bytes from the selection's start read
    // as, each type both ways round, with a glyph to copy each value, and
    // the selection copied as hex, ASCII, its offset or Base64. Made once;
    // a selection only changes its text, so nothing beside it moves.
    let decoded = []; // [{type, be, le}], as shown
    let changes = 0; // bumped with each byte changed, so it's read again
    let inspected = null; // what it shows: the selection's start, and the range read
    const copied = (button, said) => {
        button.innerHTML = iconSVG("check");
        setTimeout(() => { if (button.isConnected !== false) button.innerHTML = iconSVG("copy"); }, 1000);
        setStatus(where() + selectionText() + ` · Copied ${said}.`);
    };
    // Each type's value, as the byte order chosen (endian) reads it.
    let endian = endianWanted();
    const valueCell = (row) => {
        const type = DECODED[row][0];
        const name = () => `${type} (${orderName(endian)})`;
        const text = el("span", { className: "hex-inspector-value" });
        const button = el("button", { type: "button", className: "hex-inspector-copy", hidden: true });
        button.innerHTML = iconSVG("copy");
        button.addEventListener("click", () => {
            const v = decoded[row]?.[endian];
            if (v == null) return;
            const said = `${name()} ${v}`;
            toClipboard(v).then(ok => ok ? copied(button, said) : (setStatus(where() + selectionText() + " · Couldn't copy.")));
        });
        // Editing, a box to type the value in: Enter (or leaving it) writes
        // it, Escape puts it back.
        const input = el("input", { type: "text", className: "hex-inspector-input", spellcheck: false, autocomplete: "off" });
        const apply = () => {
            if (!editor) return;
            const was = decoded[row]?.[endian];
            if (was == null || input.value.trim() === was) return;
            let value;
            try {
                value = encodeValue(type, input.value, endian === "le", (was.length - 2) / 2);
            } catch (err) {
                input.setCustomValidity?.(err.message);
                input.reportValidity?.();
                return;
            }
            input.setCustomValidity?.("");
            setValue(value, `${name()} at 0x${selected.begin.toString(16)} to ${input.value.trim()}`);
            // As it reads now (0x1234 as 4660, say), though it's being typed in.
            input.value = decoded[row]?.[endian] ?? input.value;
        };
        input.addEventListener("keydown", event => {
            if (event.key === "Enter") {
                event.preventDefault();
                apply();
            } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                input.value = decoded[row]?.[endian] ?? "";
                input.setCustomValidity?.("");
            }
        });
        input.addEventListener("change", apply);
        input.addEventListener("input", () => input.setCustomValidity?.(""));
        return { cell: el("td", {}, el("div", { className: "hex-inspector-cell" }, text, input, button)), text, button, input, name };
    };
    const valueCells = DECODED.map((_, row) => valueCell(row));
    // LE | BE: which way round the values are read.
    const endianButtons = [["le", "LE"], ["be", "BE"]].map(([order, label]) => {
        const b = el("button", { type: "button", className: `hex-endian-${order}`, textContent: label, title: `Read the values ${orderName(order)}` });
        b.addEventListener("click", () => {
            if (endian === order) return;
            endian = order;
            rememberEndian(order);
            showEndian();
            inspected = null;
            updateInspector();
        });
        return b;
    });
    const showEndian = () => {
        for (const b of endianButtons) b.setAttribute?.("aria-pressed", String(b.className.endsWith(endian)));
    };
    showEndian();
    const endianGroup = el("span", { className: "hex-endian", role: "group", ariaLabel: "Byte order" }, ...endianButtons);
    const inspectorAt = el("p", { className: "hint hex-inspector-at" });
    const copyActions = [["hex", "Hex"], ["ascii", "ASCII"], ["offset", "Offset"], ["base64", "Base64"]].map(([kind, label]) => {
        const b = el("button", { type: "button", className: `hex-copy-${kind}`, textContent: label, disabled: true,
            title: `Copy the selected bytes as ${{ hex: "hex", ascii: "ASCII text", offset: "their offset range", base64: "Base64" }[kind]}` });
        b.addEventListener("click", () => copyAs(kind));
        return b;
    });
    // Copy as …: hex as chosen in a box over the page, its case, what's
    // between the bytes and what's before each; remembered.
    const copyMore = el("button", { type: "button", className: "hex-copy-more", textContent: "…", disabled: true,
        title: "Copy the selected bytes as hex, as you choose", ariaLabel: "Copy as hex, as you choose", ariaHasPopup: "dialog" });
    copyActions.push(copyMore);
    const format = copyFormatWanted();
    const formatCase = el("select", { className: "hex-copy-case" },
        el("option", { value: "lower", textContent: "Lower (ff)" }), el("option", { value: "upper", textContent: "Upper (FF)" }));
    const formatSeparator = el("select", { className: "hex-copy-separator" },
        ...SEPARATORS.map(([value, label], i) => el("option", { value: String(i), textContent: label })));
    const formatPrefix = el("input", { type: "text", className: "hex-copy-prefix", maxLength: 8, placeholder: "e.g. 0x",
        spellcheck: false, autocomplete: "off" });
    const formatSample = el("code", { className: "hex-copy-sample" });
    const formatCopy = el("button", { type: "submit", className: "primary", textContent: "Copy" });
    const formatCancel = el("button", { type: "button", textContent: "Cancel" });
    const formatForm = el("form", { method: "dialog" },
        el("p", { textContent: "Copy as hex" }),
        el("label", { className: "field" }, el("span", { textContent: "Case" }), formatCase),
        el("label", { className: "field" }, el("span", { textContent: "Separator" }), formatSeparator),
        el("label", { className: "field" }, el("span", { textContent: "Prefix" }), formatPrefix),
        el("p", { className: "hint" }, "Like ", formatSample),
        el("div", { className: "buttons" }, formatCancel, formatCopy));
    const formatDialog = el("dialog", { className: "hex-copy-format", ariaLabel: "Copy as hex" }, formatForm);
    const formatChosen = () => ({
        upper: formatCase.value === "upper",
        separator: SEPARATORS[Number(formatSeparator.value)]?.[0] ?? " ",
        prefix: formatPrefix.value,
    });
    const showSample = () => {
        const n = selected ? Math.min(4, selected.end - selected.begin) : 4;
        const at = selected && lastRange ? Math.max(selected.begin, lastRange.begin) : 0;
        const have = selected && lastRange ? bytesFrom(lastRange, at, Math.min(at + n, lastRange.begin + lastRange.bytes.length)) : null;
        const sample = have?.length ? have : Uint8Array.of(0x4d, 0x5a, 0x90, 0x00).subarray(0, n);
        const more = selected && selected.end - selected.begin > sample.length;
        const text = selectionAs("hex", sample, 0, formatChosen()).replaceAll("\n", "↵");
        formatSample.textContent = text + (more ? "…" : "");
    };
    for (const input of [formatCase, formatSeparator]) input.addEventListener("change", showSample);
    formatPrefix.addEventListener("input", showSample);
    formatCancel.addEventListener("click", () => formatDialog.close?.());
    formatForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const chosen = formatChosen();
        Object.assign(format, chosen);
        rememberCopyFormat(chosen);
        // Copied while the box is still up, so a copy the old way can be
        // made from it; then closed.
        copyAs("hex", chosen).finally(() => formatDialog.close?.());
    });
    formatDialog.addEventListener("close", () => content.focus?.());
    copyMore.addEventListener("click", () => {
        if (!selected) return;
        formatCase.value = format.upper ? "upper" : "lower";
        formatSeparator.value = String(Math.max(0, SEPARATORS.findIndex(([v]) => v === format.separator)));
        formatPrefix.value = format.prefix;
        showSample();
        if (!formatDialog.isConnected) (content.closest?.("dialog") ?? document.body)?.append(formatDialog);
        formatDialog.showModal?.();
        formatCopy.focus?.();
    });
    // Disassembly: the selection's bytes as x86 instructions, a line each.
    const disasmPrefs = disasmWanted();
    const disasmBitness = el("select", { className: "hex-disasm-bitness", ariaLabel: "Instruction set" },
        ...[[64, "x86-64"], [32, "x86 (32-bit)"], [16, "x86 (16-bit)"]].map(([value, label]) => el("option", { value: String(value), textContent: label })));
    disasmBitness.value = String(disasmPrefs.bitness);
    const disasmLines = el("ol", { className: "hex-disasm-lines" });
    const disasmNote = el("p", { className: "hint hex-disasm-note" });
    const disasm = el("div", { className: "hex-disasm" }, disasmLines, disasmNote);
    let disasmTimer = null, disasmAsked = 0, disasmKey = null;
    // An instruction's text, the addresses in it that it goes to or names
    // (targets), and are in the file, links to them: 018Ch, as iced shows
    // hex, or 0x18c.
    const withTargets = (text, targets = []) => {
        const out = [];
        let last = 0;
        for (const m of text.matchAll(/\b(?:[0-9][0-9a-f]*h|0x[0-9a-f]+)\b/gi)) {
            const v = Number(BigInt("0x" + m[0].replace(/^0x|h$/gi, "")));
            if (!targets.includes(v) || v >= size) continue;
            out.push(text.slice(last, m.index), el("button", { type: "button", className: "hex-disasm-target", textContent: m[0],
                title: `Go to 0x${v.toString(16)}`, value: String(v) }));
            last = m.index + m[0].length;
        }
        out.push(text.slice(last));
        return out.filter((p) => p !== "");
    };
    const runDisasm = async () => {
        if (!selected || !lastRange) {
            disasmKey = null;
            disasmLines.replaceChildren();
            disasmNote.textContent = "Select bytes to disassemble them.";
            return;
        }
        const n = selected.end - selected.begin, begin = selected.begin;
        const loaded = lastRange.begin + lastRange.bytes.length;
        if (begin < lastRange.begin || begin >= loaded) {
            disasmKey = null;
            disasmLines.replaceChildren();
            disasmNote.textContent = "Those bytes aren't loaded here.";
            return;
        }
        const end = Math.min(n > 1 ? selected.end : begin + DISASM_WINDOW, begin + DISASM_BYTES, loaded, size);
        const bitness = Number(disasmBitness.value);
        const key = `${begin}-${end}-${bitness}#${changes}${editor ? "e" : ""}`;
        if (key === disasmKey) return;
        disasmKey = key;
        const mine = ++disasmAsked;
        const code = bytesFrom(lastRange, begin, end);
        const hexOfRun = (offset, length) => hexBytes(code.subarray(offset - begin, offset - begin + length), " ");
        try {
            const lines = await disassemble(code.slice(), begin, bitness, DISASM_LINES);
            if (mine !== disasmAsked) return;
            asmEdit = null;
            const rows = lines.map((line) => {
                const { offset, length, text } = line;
                const parts = [el("span", { className: "hex-disasm-at", textContent: offset.toString(16).padStart(8, "0") }),
                    el("span", { className: "hex-disasm-bytes", textContent: hexOfRun(offset, length), title: hexOfRun(offset, length) }),
                    el("span", { className: "hex-disasm-text", title: text }, ...withTargets(text, line.targets))];
                const li = el("li", { className: text === "(bad)" ? "hex-disasm-line bad" : "hex-disasm-line", title: editor ? "Click to change this instruction" : "" }, ...parts);
                return { li, line, parts };
            });
            disasmShown = { rows, lines, bitness };
            disasm.classList.toggle("editable", !!editor);
            disasmLines.replaceChildren(...rows.map((r) => r.li));
            disasmNote.textContent = [lines.length >= DISASM_LINES ? `The first ${DISASM_LINES} instructions.`
                : n <= 1 ? `The ${end - begin} bytes from 0x${begin.toString(16)}; select bytes to disassemble just those.`
                : end < selected.end ? `The first ${(end - begin).toLocaleString()} bytes of the selection.` : "",
                editor && lines.length ? "Click an instruction to change it." : ""].filter(Boolean).join(" ");
        } catch (err) {
            if (mine !== disasmAsked) return;
            disasmLines.replaceChildren();
            disasmNote.textContent = err.message;
        }
    };
    // Editing, an instruction clicked: a box with it, to type another over
    // it. Enter assembles it (see sharedAssembler) and writes its bytes
    // there, as one change, to undo at once: one shorter is followed by
    // nops to the next; one longer goes over the next (listed or not), the
    // last of those that it ends inside filled out with nops, so what's
    // after still reads as it did. Escape (or leaving it) puts it back.
    let disasmShown = null; // {rows: [{li, line, parts}], lines, bitness}, as listed
    let asmEdit = null; // {row, line, input, busy}
    const closeAsm = () => {
        if (!asmEdit) return;
        const { row } = asmEdit;
        asmEdit = null;
        row.li.replaceChildren(...row.parts);
        row.li.classList.remove("changing");
    };
    const openAsm = (li) => {
        const row = disasmShown?.rows.find((r) => r.li === li);
        if (!editor || !row || asmEdit?.row === row) return;
        closeAsm();
        const { line } = row;
        const input = el("input", { type: "text", className: "hex-disasm-input", value: line.text === "(bad)" ? "" : line.text,
            spellcheck: false, autocomplete: "off", ariaLabel: `Instruction at 0x${line.offset.toString(16)}` });
        asmEdit = { row, line, input, busy: false };
        // The box takes the bytes' room too: on a phone, there's little.
        li.replaceChildren(row.parts[0], input);
        li.classList.add("changing");
        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                submitAsm();
            } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                closeAsm();
                // Back to the bytes (Ctrl+S, Ctrl+Z), as after Enter.
                content.focus?.({ preventScroll: true });
            }
        });
        input.addEventListener("input", () => input.setCustomValidity?.(""));
        input.addEventListener("blur", () => { if (asmEdit?.input === input && !asmEdit.busy) closeAsm(); });
        input.focus?.();
        input.select?.();
    };
    const submitAsm = async () => {
        const edit = asmEdit;
        if (!edit || edit.busy || !editor) return;
        const { line, input } = edit;
        const text = input.value.trim();
        if (!text || text === line.text) {
            closeAsm();
            return;
        }
        const { lines, bitness } = disasmShown;
        const at = line.offset, was = changes;
        edit.busy = true;
        let result, following = lines;
        try {
            result = await assemble(text, at, bitness, bytesFrom(lastRange, at, at + line.length));
            // Longer than what's listed after it: the instructions it goes
            // over, past the list, found too, so the last is filled out
            // with nops like the rest.
            const listedEnd = Math.max(...lines.map((l) => l.offset + l.length));
            if (at + result.bytes.length > listedEnd) {
                const loaded = Math.min(lastRange.begin + lastRange.bytes.length, size);
                if (at + result.bytes.length > loaded) throw new Error("The bytes after it aren't loaded here, so it can't go over them.");
                const more = await disassemble(bytesFrom(lastRange, listedEnd, Math.min(listedEnd + 64, loaded)), listedEnd, bitness, 16);
                following = [...lines, ...more];
            }
        } catch (err) {
            if (asmEdit !== edit) return;
            edit.busy = false;
            input.setCustomValidity?.(err.message);
            input.reportValidity?.();
            sayEdit(err.message, true);
            input.focus?.();
            return;
        }
        // Gone: nothing to do. The bytes changed meanwhile: not written.
        if (asmEdit !== edit || !editor) return;
        edit.busy = false;
        if (changes !== was) {
            // Left meanwhile (its blur ignored, as it was busy): closed.
            if (globalThis.document && globalThis.document.activeElement !== input) {
                closeAsm();
                sayEdit("The bytes changed while that was being assembled, so it wasn't written.", true);
                return;
            }
            const why = "The bytes changed while that was being assembled: press Enter to try again.";
            input.setCustomValidity?.(why);
            input.reportValidity?.();
            sayEdit(why, true);
            return;
        }
        const n = result.bytes.length;
        let end = at + Math.max(n, line.length);
        const over = following.filter((l) => l.offset > at && l.offset < at + n);
        for (const l of over) end = Math.max(end, l.offset + l.length);
        const run = new Uint8Array(end - at).fill(0x90);
        run.set(result.bytes);
        const nops = run.length - n, plural = (k, word) => `${k} ${word}${k === 1 ? "" : "s"}`;
        const said = `0x${at.toString(16)} to ${result.text}` + (over.length ? `, over the ${plural(over.length, "instruction")} after it` : "")
            + (nops ? `, with ${plural(nops, "nop")} after it` : "");
        if (!writeRun(at, run, said)) {
            input.setCustomValidity?.(editStatus.textContent);
            input.reportValidity?.();
            return;
        }
        // Back to the bytes, for Ctrl+Z (the box goes as the list is redrawn).
        content.focus?.({ preventScroll: true });
        // The selection taken on to the end of what was written.
        if (selected && selected.end - selected.begin > 1 && end > selected.end) selectThrough(selected.begin, end - 1, selected.from);
    };
    disasmLines.addEventListener("click", (event) => {
        // An address in it: there, its code shown.
        const target = event.target?.closest?.(".hex-disasm-target");
        if (target) {
            closeAsm();
            view.jump(Number(target.value));
            return;
        }
        const li = event.target?.closest?.(".hex-disasm-line");
        if (li && !event.target.closest?.(".hex-disasm-input")) openAsm(li);
    });
    // After the selection settles, if it's to be seen; the lines there stay
    // till new ones come.
    const updateDisasm = () => {
        clearTimeout(disasmTimer);
        if (inspector.hidden || inspector.dataset.tab !== "disasm") return;
        disasmTimer = setTimeout(runDisasm, 150);
    };
    disasmBitness.addEventListener("change", () => { rememberDisasm(inspector.dataset.tab, Number(disasmBitness.value)); updateDisasm(); });
    // The panel shows the values or the disassembly, a tab each, the one
    // given all of its height (the instruction set chosen at the right of
    // the tabs); which, remembered.
    const tabButtons = [["values", "Values"], ["disasm", "Disassembly"]].map(([tab, label]) => {
        const b = el("button", { type: "button", className: `hex-inspector-tab-${tab}`, textContent: label });
        b.addEventListener("click", () => showTab(tab));
        return b;
    });
    const inspectorTabs = el("div", { className: "hex-inspector-tabs" },
        el("span", { className: "hex-inspector-tab-group", role: "group", ariaLabel: "Show" }, ...tabButtons), disasmBitness);
    const showTab = (tab, remember = true) => {
        inspector.dataset.tab = tab;
        tabButtons.forEach((b, i) => b.setAttribute?.("aria-pressed", String((i === 0) === (tab === "values"))));
        if (remember) rememberDisasm(tab, Number(disasmBitness.value));
        updateDisasm();
    };
    const inspector = el("aside", { className: "hex-inspector", ariaLabel: "Data inspector", hidden: !inspectorWanted() },
        inspectorTabs,
        el("div", { className: "hex-inspector-head" }, inspectorAt, endianGroup),
        el("table", { className: "hex-inspector-values" },
            el("tbody", {}, ...DECODED.map(([type], row) => el("tr", {}, el("th", { scope: "row", textContent: type }), valueCells[row].cell)))),
        el("div", { className: "hex-inspector-actions" }, el("span", { className: "hint", textContent: "Copy as" }), ...copyActions),
        disasm);
    showTab(disasmPrefs.tab, false);
    const updateInspector = () => {
        updateDisasm();
        for (const b of copyActions) if (b.disabled !== !selected) b.disabled = !selected;
        const key = selected && lastRange ? `${selected.begin}@${lastRange.begin}#${changes}` : "";
        if (key === inspected) return;
        inspected = key;
        const from = selected && lastRange ? selected.begin - lastRange.begin : -1;
        const bytes = from >= 0 && from < lastRange.bytes.length ? bytesFrom(lastRange, selected.begin, Math.min(selected.begin + 8, lastRange.begin + lastRange.bytes.length)) : null;
        decoded = bytes ? decodeAt(bytes) : [];
        inspectorAt.textContent = !selected ? "Select bytes to see what they read as."
            : bytes ? `From 0x${selected.begin.toString(16)}, ${orderName(endian)}` : "Those bytes aren't loaded here.";
        valueCells.forEach((c, row) => {
            const v = decoded[row]?.[endian] ?? null;
            // An unsigned reading the same as the signed one above it (its
            // top bit clear) is dimmed, not hidden, so nothing moves.
            const type = DECODED[row][0];
            const same = v != null && type.startsWith("uint") && decoded[row - 1]?.[endian] === v;
            c.text.textContent = v ?? (bytes ? "—" : "");
            c.text.title = same ? `${v}, the same as ${DECODED[row - 1][0]}` : v ?? "";
            c.text.classList.toggle("same", same);
            // (Not while it's being typed in.)
            if (globalThis.document?.activeElement !== c.input) c.input.value = v ?? "";
            c.input.disabled = v == null;
            c.input.setAttribute?.("aria-label", c.name());
            c.button.hidden = v == null;
            if (v != null) c.button.setAttribute?.("aria-label", `Copy ${c.name()} ${v}`);
        });
    };
    const toggle = el("button", { type: "button", className: "hex-inspector-toggle glyph" });
    toggle.innerHTML = iconSVG("inspector");
    const showToggle = () => {
        const shown = !inspector.hidden;
        toggle.setAttribute?.("aria-pressed", String(shown));
        toggle.title = shown ? "Hide the data inspector" : "Show the data inspector";
        toggle.setAttribute?.("aria-label", toggle.title);
    };
    toggle.addEventListener("click", () => {
        inspector.hidden = !inspector.hidden;
        rememberInspector(!inspector.hidden);
        showToggle();
        updateDisasm();
    });
    showToggle();
    // The page's cells, by offset from its start: [hex, ascii] each. Only
    // those whose state changes are touched, so a drag redraws a row or two,
    // not the page. marked: the range marked now.
    let cells = [], marked = null;
    const applySelection = () => {
        const lo = (r) => r ? Math.max(r.begin, start) - start : 0;
        const hi = (r) => r ? Math.min(r.end, shownEnd) - start : 0;
        const from = Math.min(marked ? lo(marked) : Infinity, selected ? lo(selected) : Infinity);
        const to = Math.max(marked ? hi(marked) : -Infinity, selected ? hi(selected) : -Infinity);
        for (let i = Math.max(0, from); i < Math.min(cells.length, to); i++) {
            const on = !!selected && i >= lo(selected) && i < hi(selected);
            const was = !!marked && i >= lo(marked) && i < hi(marked);
            if (on !== was) for (const cell of cells[i]) cell.classList.toggle("selected", on);
        }
        marked = selected ? { begin: selected.begin, end: selected.end } : null;
        updateInspector();
        if (content.dataset.selecting !== (selected?.from ?? "")) content.dataset.selecting = selected?.from ?? "";
        const text = where() + selectionText();
        if (lastRange && status.textContent !== text) setStatus(text);
    };
    const paint = (offset, range) => {
        start = offset;
        const end = Math.min(start + PAGE_BYTES, range.begin + range.bytes.length, size);
        shownEnd = end;
        lastRange = range;
        cells = [];
        caretCells = [];
        marked = null;
        content.replaceChildren();
        for (let at = start; at < end; at += 16) {
            const rowEnd = Math.min(at + 16, end);
            const addr = el("span", { className: "hex-addr", textContent: at.toString(16).padStart(8, "0") });
            const hex = el("span", { className: "hex-bytes" });
            const ascii = el("span", { className: "hex-ascii" });
            for (let i = at; i < at + 16; i++) {
                if (i < rowEnd) {
                    const byte = byteOf(i, range);
                    const hexCell = el("span", { className: pending.has(i) ? "hex-byte edited" : "hex-byte", textContent: hexByte(byte) });
                    hexCell.dataset.offset = String(i);
                    hex.append(hexCell);
                    const asciiCell = el("span", { className: pending.has(i) ? "hex-char edited" : "hex-char", textContent: printable(byte) });
                    asciiCell.dataset.offset = String(i);
                    ascii.append(asciiCell);
                    cells.push([hexCell, asciiCell]);
                } else {
                    hex.append(el("span", { className: "hex-byte is-pad", textContent: "  " }));
                    ascii.append(el("span", { className: "hex-char is-pad", textContent: " " }));
                }
            }
            const row = el("div", { className: "hex-row" }, addr, hex, ascii);
            row.dataset.offset = String(at);
            content.append(row);
        }
        content.scrollTop = content.scrollLeft = 0;
        head.scrollLeft = 0;
        applySelection();
        showCaret();
        buttons();
    };
    const show = offset => {
        if (stopped) return Promise.resolve();
        const mine = ++revision;
        controller?.abort(); controller = null;
        const cached = source.cached(offset);
        if (cached) { paint(offset, cached); return Promise.resolve(); }
        controller = new AbortController();
        setStatus("Loading byte range…");
        previous.disabled = next.disabled = previousRange.disabled = nextRange.disabled = true;
        return source.read(offset, { signal: controller.signal }).then(range => {
            if (!stopped && mine === revision) paint(offset, range);
        }).catch(err => {
            if (!stopped && mine === revision && err.name !== "AbortError") { setStatus(`Couldn't read this range: ${err.message}`); buttons(); }
        });
    };
    const byteAt = node => {
        const cell = node?.closest?.(".hex-byte, .hex-char");
        if (!cell || !content.contains(cell) || cell.classList.contains("is-pad")) return null;
        const at = Number(cell.dataset.offset);
        return Number.isSafeInteger(at) ? at : null;
    };
    // The byte at a point, in the column a drag started in: past a row's
    // end, between bytes, or above or below what's shown, the nearest one.
    const byteNear = (column, x, y) => {
        const rows = content.querySelectorAll(".hex-row");
        if (!rows.length || !rows[0].getBoundingClientRect) return null;
        const first = rows[0].getBoundingClientRect();
        const height = rows.length > 1 ? rows[1].getBoundingClientRect().top - first.top : first.height;
        const index = Math.max(0, Math.min(rows.length - 1, Math.floor((y - first.top) / (height || 1))));
        const cells = rows[index].querySelectorAll(column === "ascii" ? ".hex-char" : ".hex-byte");
        let col = 0;
        for (let i = 0; i < cells.length; i++) {
            if (cells[i].getBoundingClientRect().left <= x) col = i;
        }
        return Math.max(start, Math.min(shownEnd - 1, Number(rows[index].dataset.offset) + col));
    };
    const selectThrough = (anchor, at, from) => {
        const begin = Math.min(anchor, at), end = Math.max(anchor, at) + 1;
        if (selected && selected.begin === begin && selected.end === end && selected.from === from) return;
        selected = { begin, end, from };
        applySelection();
    };
    // From the offset column, whole rows: from the row (or rows) it began
    // on through the one at.
    const selectRows = (at) => {
        const row = at - at % 16;
        if (row >= drag.anchor) selectThrough(drag.anchor, Math.min(row + 15, shownEnd - 1), drag.column);
        else selectThrough(drag.anchorEnd, row, drag.column);
    };
    const dragTo = (x, y, target) => {
        if (!drag) return;
        let at = byteAt(target);
        if (at == null && drag.rows) {
            const row = Number(target?.closest?.(".hex-addr")?.closest(".hex-row")?.dataset.offset);
            if (Number.isSafeInteger(row)) at = row;
        }
        if (at == null) at = byteNear(drag.column, x, y);
        if (at == null) return;
        if (drag.rows) selectRows(at);
        else selectThrough(drag.anchor, at, drag.column);
    };
    // Held above or below the dump, it scrolls, and the selection follows.
    const scrollStep = () => {
        if (!drag || drag.frame == null) return;
        const box = content.getBoundingClientRect();
        const over = drag.y < box.top ? drag.y - box.top : drag.y > box.bottom ? drag.y - box.bottom : 0;
        if (!over) { drag.frame = null; return; }
        content.scrollTop += Math.max(-40, Math.min(40, over));
        dragTo(drag.x, Math.max(box.top + 1, Math.min(box.bottom - 1, drag.y)), null);
        drag.frame = requestAnimationFrame(scrollStep);
    };
    content.addEventListener("pointerdown", event => {
        if (event.button !== 0) return;
        const address = event.target?.closest?.(".hex-addr");
        if (address) {
            // An address: its row; dragged, the rows to where it's let go;
            // with Shift, from the selection.
            const row = Number(address.closest(".hex-row")?.dataset.offset);
            if (!Number.isSafeInteger(row)) return;
            event.preventDefault();
            content.focus?.({ preventScroll: true });
            const last = Math.min(row + 16, shownEnd) - 1;
            const [anchor, anchorEnd] = !event.shiftKey || !selected ? [row, last]
                : row < selected.begin ? [selected.end - 1, selected.end - 1] : [selected.begin, selected.begin];
            drag = { anchor, anchorEnd, rows: true, column: selected?.from ?? "hex", x: event.clientX, y: event.clientY, frame: null };
            selectRows(row);
            content.setPointerCapture?.(event.pointerId);
            return;
        }
        const at = byteAt(event.target);
        if (at == null) return;
        event.preventDefault();
        content.focus?.({ preventScroll: true });
        const column = event.target.closest(".hex-char") ? "ascii" : "hex";
        // Shift: from the selection's start, as text selection extends.
        const anchor = event.shiftKey && selected ? (at < selected.begin ? selected.end - 1 : selected.begin) : at;
        drag = { anchor, column, x: event.clientX, y: event.clientY, frame: null };
        selectThrough(anchor, at, column);
        if (editor) {
            caret = { at, column, low: false };
            showCaret();
        }
        content.setPointerCapture?.(event.pointerId);
    });
    content.addEventListener("pointermove", event => {
        if (!drag) return;
        drag.x = event.clientX; drag.y = event.clientY;
        dragTo(event.clientX, event.clientY, document.elementFromPoint?.(event.clientX, event.clientY) ?? event.target);
        if (drag.frame == null && typeof requestAnimationFrame === "function" && content.getBoundingClientRect) {
            const box = content.getBoundingClientRect();
            if (event.clientY < box.top || event.clientY > box.bottom) drag.frame = requestAnimationFrame(scrollStep);
        }
    });
    const endDrag = () => {
        if (drag?.frame != null) cancelAnimationFrame(drag.frame);
        drag = null;
    };
    content.addEventListener("pointerup", endDrag);
    content.addEventListener("pointercancel", endDrag);
    content.addEventListener("lostpointercapture", endDrag);
    content.addEventListener("scroll", () => { head.scrollLeft = content.scrollLeft; });
    // Copy, as kind (see selectionAs): the bytes loaded here, or, for an
    // offset, where the whole selection is.
    const copyAs = (kind, format) => {
        if (!selected || !lastRange) return Promise.resolve();
        const range = lastRange;
        let begin = selected.begin, end = selected.end, bytes = null;
        if (kind !== "offset") {
            begin = Math.max(selected.begin, range.begin);
            end = Math.min(selected.end, range.begin + range.bytes.length, begin + MAX_COPY);
            if (end <= begin) { setStatus(where() + " · Those bytes aren't loaded here, so they can't be copied."); return Promise.resolve(); }
            bytes = bytesFrom(range, begin, end);
        }
        const text = selectionAs(kind, bytes ?? { length: end - begin }, begin, format);
        const n = end - begin, short = n < selected.end - selected.begin;
        const as = { hex: "hex", ascii: "text", base64: "Base64", offset: "its offset" }[kind];
        return toClipboard(text).then(ok => {
            setStatus(where() + selectionText() +
                (!ok ? " · Couldn't copy." : kind === "offset" ? " · Copied its offset." : ` · Copied ${n.toLocaleString()} byte${n === 1 ? "" : "s"} as ${as}${short ? " (those loaded here)" : ""}.`));
        });
    };
    // Editing (see view.startEditing): a caret on a byte, in a column.
    // Hex digits typed change its byte a half at a time, and characters
    // typed in the ASCII column the whole of it; a byte is never inserted
    // or removed. Arrows move it (by a row, up and down), Tab to the other
    // column, Backspace back; Ctrl+Z undoes.
    let caret = null; // {at, column, low}: low, the second hex digit's next
    let caretCells = [];
    // {at, value, group}: the byte's value before (so undoing is right
    // across a save); a value set in the inspector is one group.
    const undo = [];
    let undoGroup = 0;
    const editStatus = el("span", { className: "edit-status", hidden: true });
    const sayEdit = (text, error = false) => {
        editStatus.textContent = text;
        editStatus.classList.toggle("error", error);
        if (text) setStatus(where() + selectionText() + ` · ${text}`);
    };
    function showCaret() {
        for (const c of caretCells) c.classList.remove("caret", "caret-low");
        caretCells = [];
        if (!editor || !caret || caret.at < start || caret.at >= shownEnd || !cells[caret.at - start]) return;
        const cell = cells[caret.at - start][caret.column === "ascii" ? 1 : 0];
        cell.classList.add("caret");
        if (caret.low) cell.classList.add("caret-low");
        caretCells = [cell];
        cell.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    }
    const placeCaret = (at, column = caret?.column ?? "hex") => {
        at = Math.max(0, Math.min(size - 1, at));
        caret = { at, column, low: false };
        const go = at < start || at >= shownEnd ? show(pageStart(at)) : Promise.resolve();
        return go.then(() => {
            if (!editor || caret?.at !== at) return;
            selectThrough(at, at, column);
            showCaret();
        });
    };
    // A byte changed, here and in the inspector, without the page drawn
    // again: only its two cells.
    const redrawByte = at => {
        changes++;
        if (at >= start && at < shownEnd && cells[at - start]) {
            const v = byteOf(at), on = pending.has(at);
            const [h, a] = cells[at - start];
            h.textContent = hexByte(v);
            a.textContent = printable(v);
            h.classList.toggle("edited", on);
            a.classList.toggle("edited", on);
        }
        updateInspector();
        editor?.changed?.();
    };
    // The file's bytes, as they were before they were first changed here:
    // kept, as a byte changed may be undone, or saved, with another part
    // of the file shown. (Once saved, saved has it as it is.)
    const origin = new Map();
    const fileByte = at => saved.get(at) ?? origin.get(at) ?? lastRange.bytes[at - lastRange.begin];
    // The runs of pending bytes side by side, as a save sends them: kept
    // count of as bytes are made pending or not.
    let runs = 0;
    const runsAdding = at => (pending.has(at - 1) && pending.has(at + 1) ? -1 : pending.has(at - 1) || pending.has(at + 1) ? 0 : 1);
    const setPending = (at, value) => {
        if (!pending.has(at)) runs += runsAdding(at);
        pending.set(at, value);
    };
    const dropPending = at => {
        if (!pending.delete(at)) return;
        runs -= runsAdding(at);
    };
    // putByte makes at value: pending, unless that's what the file has.
    const putByte = (at, value) => {
        if (value === fileByte(at)) dropPending(at);
        else setPending(at, value);
        redrawByte(at);
    };
    const tooMuch = (fresh, newRuns) => {
        if (pending.size + fresh > MAX_PATCH) {
            sayEdit(`At most ${MAX_PATCH / 1024} KB can be changed in one save: save, then carry on.`, true);
            return true;
        }
        if (runs + newRuns > MAX_RUNS) {
            sayEdit(`At most ${MAX_RUNS.toLocaleString()} separate stretches of bytes can be changed in one save: save, then carry on.`, true);
            return true;
        }
        return false;
    };
    const setByte = (at, value, group = ++undoGroup) => {
        if (byteOf(at) === value) return true;
        if (!origin.has(at) && !saved.has(at)) origin.set(at, lastRange.bytes[at - lastRange.begin]);
        if (!pending.has(at) && tooMuch(1, Math.max(0, runsAdding(at)))) return false;
        undo.push({ at, value: byteOf(at), group });
        putByte(at, value);
        return true;
    };
    // writeRun writes bytes at begin, as one change, to undo at once; false
    // (and says why) if they can't be.
    const writeRun = (begin, bytes, said) => {
        if (!editor || !lastRange) return false;
        const loaded = Math.min(lastRange.begin + lastRange.bytes.length, size);
        if (begin < lastRange.begin || begin + bytes.length > loaded) {
            sayEdit(`There aren't ${bytes.length} bytes here for that.`, true);
            return false;
        }
        let fresh = 0;
        for (let i = 0; i < bytes.length; i++) if (!pending.has(begin + i)) fresh++;
        // (Side by side, they make one run more at most.)
        if (tooMuch(fresh, fresh ? 1 : 0)) return false;
        const group = ++undoGroup;
        for (let i = 0; i < bytes.length; i++) setByte(begin + i, bytes[i], group);
        sayEdit(`Set ${said}.`);
        return true;
    };
    // setValue writes bytes (a value from the inspector) at the selection's start.
    const setValue = (bytes, said) => {
        if (selected) writeRun(selected.begin, bytes, said);
    };
    const editKey = event => {
        const key = event.key;
        if ((event.ctrlKey || event.metaKey) && !event.altKey && key.toLowerCase() === "z" && !event.shiftKey) {
            event.preventDefault();
            const last = undo.at(-1);
            if (!last) return true;
            // The whole of the last change: a byte, or a value's bytes.
            let first = last.at;
            while (undo.length && undo.at(-1).group === last.group) {
                const u = undo.pop();
                putByte(u.at, u.value);
                first = Math.min(first, u.at);
            }
            placeCaret(first);
            return true;
        }
        if (event.ctrlKey || event.metaKey || event.altKey || !caret) return false;
        const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -16, ArrowDown: 16, Backspace: -1 };
        if (key in moves) {
            event.preventDefault();
            placeCaret(caret.at + moves[key]);
            return true;
        }
        if (key === "Tab") {
            event.preventDefault();
            caret = { ...caret, column: caret.column === "ascii" ? "hex" : "ascii", low: false };
            selectThrough(caret.at, caret.at, caret.column);
            showCaret();
            return true;
        }
        // Typing only on the page shown (a move to another may be coming).
        if (caret.at < start || caret.at >= shownEnd) return false;
        if (caret.column === "hex" && /^[0-9a-f]$/i.test(key)) {
            event.preventDefault();
            const d = parseInt(key, 16), v = byteOf(caret.at);
            if (!setByte(caret.at, caret.low ? (v & 0xf0) | d : (d << 4) | (v & 0x0f))) return true;
            if (caret.low && caret.at < size - 1) placeCaret(caret.at + 1);
            else {
                caret = { ...caret, low: !caret.low };
                showCaret();
            }
            return true;
        }
        if (caret.column === "ascii" && key.length === 1 && key.charCodeAt(0) >= 32 && key.charCodeAt(0) <= 126) {
            event.preventDefault();
            if (setByte(caret.at, key.charCodeAt(0)) && caret.at < size - 1) placeCaret(caret.at + 1);
            return true;
        }
        return false;
    };

    // Find: bytes, as hex (? for any digit) or ASCII, in the saved file,
    // from the selection on (or back), a stretch at a time.
    // Hex or ASCII: a button, its glyph a drawn 0x or Aa, the same width either way.
    const findMode = el("button", { type: "button", className: "hex-find-mode" });
    const setFindMode = (mode) => {
        findMode.dataset.mode = mode;
        findMode.innerHTML = iconSVG(mode === "ascii" ? "find-ascii" : "find-hex");
        findMode.title = mode === "ascii" ? "Search as ASCII text (click for hex)" : "Search as hex bytes (click for ASCII text)";
        findMode.setAttribute?.("aria-label", mode === "ascii" ? "Search as ASCII" : "Search as hex");
        findInput.placeholder = mode === "ascii" ? "text" : "4d 5a ?? 00";
        findInput.setCustomValidity?.("");
    };
    const findInput = el("input", { type: "search", className: "hex-find-input", placeholder: "4d 5a ?? 00", ariaLabel: "Find bytes",
        spellcheck: false, autocomplete: "off" });
    const findPrevious = el("button", { type: "button", className: "hex-find-previous", textContent: "‹", title: "Find the one before (Shift+Enter)", ariaLabel: "Find previous" });
    const findNext = el("button", { type: "submit", className: "hex-find-next", textContent: "›", title: "Find the next (Enter)", ariaLabel: "Find next" });
    const findForm = el("form", { className: "hex-find", hidden: !search, role: "search" }, findMode, findInput, findPrevious, findNext);
    let finding = null;
    const find = async backward => {
        let pattern;
        try {
            pattern = parseSearch(findInput.value, findMode.dataset.mode);
        } catch (err) {
            findInput.setCustomValidity?.(err.message);
            findInput.reportValidity?.();
            return;
        }
        findInput.setCustomValidity?.("");
        finding?.abort();
        const abort = finding = new AbortController();
        let from = selected ? (backward ? selected.begin - 1 : selected.begin + 1) : backward ? shownEnd - 1 : start;
        const note = pending.size ? " (in the saved file)" : "";
        const notFound = () => { setStatus(where() + selectionText() + ` · Not found ${backward ? "before" : "after"} there${note}.`); };
        if (from < 0 || from >= size) { notFound(); return; }
        setStatus("Searching…");
        try {
            for (;;) {
                const reply = await search({ pattern: hexBytes(pattern.value), mask: hexBytes(pattern.mask), offset: from, backward, signal: abort.signal });
                if (abort !== finding || stopped) return;
                if (reply.found >= 0) {
                    await view.jump(reply.found, Math.min(reply.found + pattern.value.length, size), findMode.dataset.mode === "ascii" ? "ascii" : "hex");
                    setStatus(where() + selectionText() + ` · Found at 0x${reply.found.toString(16)}${note}.`);
                    return;
                }
                if (reply.next < 0) { notFound(); return; }
                from = reply.next;
                setStatus(`Searching… ${Math.round((backward ? size - from : from) / size * 100)}%`);
            }
        } catch (err) {
            if (abort === finding && err.name !== "AbortError") setStatus(where() + selectionText() + ` · Couldn't search: ${err.message}`);
        } finally {
            if (abort === finding) finding = null;
        }
    };
    findForm.addEventListener("submit", event => { event.preventDefault(); find(false); });
    findPrevious.addEventListener("click", () => find(true));
    findInput.addEventListener("keydown", event => {
        if (event.key === "Enter" && event.shiftKey) { event.preventDefault(); find(true); }
    });
    findInput.addEventListener("input", () => findInput.setCustomValidity?.(""));
    findMode.addEventListener("click", () => setFindMode(findMode.dataset.mode === "ascii" ? "hex" : "ascii"));
    setFindMode("hex");

    // Ctrl+C: the selection as the column it was chosen in shows it, hex
    // or characters; Escape: no selection (and a second, the preview goes).
    // Editing, the keys edit first.
    content.addEventListener("keydown", event => {
        if (editor && editKey(event)) return;
        if (event.key === "Escape" && selected) {
            event.preventDefault();
            event.stopPropagation();
            selected = null;
            applySelection();
            return;
        }
        if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "c" || !selected) return;
        event.preventDefault();
        copyAs(selected.from === "ascii" ? "ascii" : "hex");
    });
    previous.addEventListener("click", () => show(pageStart(Math.max(0, start - 1))));
    next.addEventListener("click", () => show(Math.min(start + PAGE_BYTES, (Math.floor(start / binaryChunkSize) + 1) * binaryChunkSize, size - 1)));
    previousRange.addEventListener("click", () => show(Math.max(0, (Math.floor(start / binaryChunkSize) - 1) * binaryChunkSize)));
    nextRange.addEventListener("click", () => show((Math.floor(start / binaryChunkSize) + 1) * binaryChunkSize));
    // The toggle is in the bar, unless where it's shown puts it elsewhere
    // (the Kaitai view, beside Interpret as: see view.inspectorToggle).
    const view = el("div", { className: "hex-view" },
        el("div", { className: "hex-controls", role: "group", ariaLabel: "Byte navigation" }, previous, status, next, previousRange, nextRange, jumpForm, findForm, editStatus, toggle),
        el("div", { className: "hex-main" }, el("div", { className: "hex-pane" }, head, content), inspector));
    view.inspectorToggle = toggle;
    view.jump = (begin, end = Math.min(begin + 1, size), from = selected?.from ?? "hex") => {
        if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || begin >= size || end < begin || end > size) return Promise.resolve();
        endDrag();
        selected = { begin, end, from };
        if (editor) caret = { at: begin, column: from, low: false };
        return show(pageStart(begin)).then(() => {
            if (stopped) return;
            content.querySelector(`.hex-row[data-offset="${Math.floor(begin / 16) * 16}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
            showCaret();
        });
    };
    // startEditing: bytes changed in place, as typed (see editKey), until
    // stop(); save() writes them with save(runs) (see patchRuns), which
    // resolves once they're written, then tells saved(runs, reply). changed()
    // is told of each change. It returns what the preview's editing needs.
    view.startEditing = ({ save, saved: onSaved, changed } = {}) => {
        editor = { save, onSaved, changed, saving: false };
        content.classList.add("editing");
        inspector.classList.add("editing");
        sayEdit("");
        placeCaret(selected?.begin ?? start, selected?.from ?? "hex");
        content.focus?.({ preventScroll: true });
        updateDisasm(); // its instructions, to click to change
        return {
            dirty: () => pending.size > 0,
            saving: () => !!editor?.saving,
            canSave: () => pending.size > 0 && !editor?.saving,
            save: async () => {
                if (!editor || editor.saving || !pending.size) return;
                // This editing's, even if stopped meanwhile: the file's
                // new version must still reach the preview.
                const ed = editor;
                const changing = new Map(pending), runs = patchRuns(changing);
                // What the file had there, and the last change made before.
                const was = new Map(Array.from(changing.keys(), at => [at, fileByte(at)]));
                const savedGroup = undoGroup;
                let settle;
                ed.settled = new Promise((resolve) => { settle = resolve; });
                ed.saving = true;
                sayEdit("Saving…");
                ed.changed?.();
                try {
                    // And the bytes the file had there, in the runs' order, so
                    // it can be checked still to have them.
                    const before = Uint8Array.from([...changing.keys()].sort((a, b) => a - b), at => was.get(at));
                    const reply = await ed.save(runs, before);
                    for (const [at, v] of changing) {
                        saved.set(at, v);
                        // The first range, which a Kaitai format reads.
                        if (at < bytes.length) bytes[at] = v;
                        if (editor !== ed) continue;
                        // Typed meanwhile: what's pending now is from
                        // what's saved. Put back as it was, it's a change.
                        if (pending.get(at) === v) dropPending(at);
                        else if (!pending.has(at) && was.get(at) !== v) setPending(at, was.get(at));
                    }
                    // What was saved can't be undone; what was typed meanwhile can.
                    if (editor === ed) undo.splice(0, undo.length, ...undo.filter(u => u.group > savedGroup));
                    for (const at of changing.keys()) redrawByte(at);
                    await ed.onSaved?.(runs, reply);
                    sayEdit(`Saved ${changing.size.toLocaleString()} byte${changing.size === 1 ? "" : "s"}.`);
                } catch (err) {
                    sayEdit(`Not saved: ${err.message}`, true);
                } finally {
                    ed.saving = false;
                    settle();
                    editor?.changed?.();
                }
            },
            // Once the save going (if one is) is over, whatever came of it.
            settled: () => editor?.settled,
            stop: () => {
                editor = null;
                caret = null;
                undo.length = 0;
                closeAsm();
                updateDisasm();
                const had = pending.size > 0;
                pending.clear();
                runs = 0;
                content.classList.remove("editing");
                inspector.classList.remove("editing");
                sayEdit("");
                showCaret();
                if (had && lastRange) {
                    const top = content.scrollTop;
                    changes++;
                    paint(start, lastRange);
                    content.scrollTop = top;
                }
            },
        };
    };
    jumpForm.addEventListener("submit", event => {
        event.preventDefault();
        const text = offsetInput.value.trim(), offset = Number(text);
        if (!text || !Number.isSafeInteger(offset) || offset < 0 || offset >= size) { offsetInput.setCustomValidity("Enter a byte offset within this file."); offsetInput.reportValidity(); return; }
        offsetInput.setCustomValidity(""); view.jump(offset);
    });
    offsetInput.addEventListener("input", () => offsetInput.setCustomValidity(""));
    view.stop = () => { stopped = true; revision++; controller?.abort(); finding?.abort(); clearTimeout(disasmTimer); disasmAsked++; formatDialog.close?.(); formatDialog.remove?.(); };
    show(0);
    return view;
}
