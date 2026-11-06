import { el } from "./preview-dom.js";
import { binaryChunkSize } from "./preview-model.js";

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
        const hex = Array.from(row, byte => byte.toString(16).padStart(2, "0"));
        const left = hex.slice(0, 8).join(" ").padEnd(23);
        const right = hex.slice(8).join(" ").padEnd(23);
        const ascii = Array.from(row, byte => byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : ".").join("");
        rows.push(`${(base + offset).toString(16).padStart(8, "0")}  ${left}  ${right}  |${ascii.padEnd(16)}|`);
    }
    return rows.join("\n");
}

export function hexView(bytes, { size = bytes.length, readRange = null } = {}) {
    if (!size) return el("p", { className: "hint", textContent: "This file is empty." });
    const source = createHexRangeSource(bytes, size, readRange);
    let start = 0, selected = null, controller = null, revision = 0, stopped = false;
    const content = el("pre", { className: "hex-dump", tabIndex: 0, ariaLabel: "Hexadecimal bytes and printable ASCII" });
    const status = el("span", { className: "hint", role: "status" });
    const previous = el("button", { type: "button", textContent: "Previous bytes" });
    const next = el("button", { type: "button", textContent: "Next bytes" });
    const previousRange = el("button", { type: "button", textContent: "Previous 1 MB", className: "hex-previous-range" });
    const nextRange = el("button", { type: "button", textContent: "Next 1 MB", className: "hex-next-range" });
    const offsetInput = el("input", { type: "text", inputMode: "numeric", placeholder: "Byte offset or 0x…", ariaLabel: "Byte offset" });
    const jumpForm = el("form", { className: "hex-jump" }, offsetInput, el("button", { type: "submit", textContent: "Go" }));
    const buttons = () => {
        previous.disabled = start === 0;
        next.disabled = Math.min(start + PAGE_BYTES, (Math.floor(start / binaryChunkSize) + 1) * binaryChunkSize) >= size;
        previousRange.disabled = start < binaryChunkSize;
        nextRange.disabled = (Math.floor(start / binaryChunkSize) + 1) * binaryChunkSize >= size;
    };
    const paint = (offset, range) => {
        start = offset;
        const end = Math.min(start + PAGE_BYTES, range.begin + range.bytes.length, size);
        content.textContent = hexDump(range.bytes, start - range.begin, end - range.begin, range.begin);
        if (selected) {
            content.replaceChildren();
            for (let at = start; at < end; at += 16) {
                const row = el("span", { className: "hex-row" }); row.dataset.offset = at;
                row.append(`${at.toString(16).padStart(8, "0")}  `);
                for (let i = at; i < at + 16; i++) {
                    if (i === at + 8) row.append(" ");
                    const cell = i < end ? range.bytes[i - range.begin].toString(16).padStart(2, "0") : "  ";
                    row.append(el(i >= selected.begin && i < selected.end ? "mark" : "span", { textContent: cell }));
                    if (i < at + 15) row.append(" ");
                }
                row.append("  |");
                for (let i = at; i < at + 16; i++) {
                    const byte = range.bytes[i - range.begin];
                    const char = i < end ? byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : "." : " ";
                    row.append(el(i >= selected.begin && i < selected.end ? "mark" : "span", { textContent: char }));
                }
                row.append("|\n"); content.append(row);
            }
        }
        content.scrollTop = content.scrollLeft = 0;
        status.textContent = `Bytes ${start.toLocaleString()}–${(end - 1).toLocaleString()} of ${size.toLocaleString()}`;
        buttons();
    };
    const show = offset => {
        if (stopped) return Promise.resolve();
        const mine = ++revision;
        controller?.abort(); controller = null;
        const cached = source.cached(offset);
        if (cached) { paint(offset, cached); return Promise.resolve(); }
        controller = new AbortController();
        status.textContent = "Loading byte range…";
        previous.disabled = next.disabled = previousRange.disabled = nextRange.disabled = true;
        return source.read(offset, { signal: controller.signal }).then(range => {
            if (!stopped && mine === revision) paint(offset, range);
        }).catch(err => {
            if (!stopped && mine === revision && err.name !== "AbortError") { status.textContent = `Couldn't read this range: ${err.message}`; buttons(); }
        });
    };
    previous.addEventListener("click", () => show(pageStart(Math.max(0, start - 1))));
    next.addEventListener("click", () => show(Math.min(start + PAGE_BYTES, (Math.floor(start / binaryChunkSize) + 1) * binaryChunkSize, size - 1)));
    previousRange.addEventListener("click", () => show(Math.max(0, (Math.floor(start / binaryChunkSize) - 1) * binaryChunkSize)));
    nextRange.addEventListener("click", () => show((Math.floor(start / binaryChunkSize) + 1) * binaryChunkSize));
    const view = el("div", { className: "hex-view" },
        el("div", { className: "hex-controls", role: "group", ariaLabel: "Byte navigation" }, previous, status, next, previousRange, nextRange, jumpForm), content);
    view.jump = (begin, end = Math.min(begin + 1, size)) => {
        if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || begin >= size || end < begin || end > size) return Promise.resolve();
        selected = { begin, end };
        return show(pageStart(begin)).then(() => {
            if (!stopped) content.querySelector(`[data-offset="${Math.floor(begin / 16) * 16}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
        });
    };
    jumpForm.addEventListener("submit", event => {
        event.preventDefault();
        const text = offsetInput.value.trim(), offset = Number(text);
        if (!text || !Number.isSafeInteger(offset) || offset < 0 || offset >= size) { offsetInput.setCustomValidity("Enter a byte offset within this file."); offsetInput.reportValidity(); return; }
        offsetInput.setCustomValidity(""); view.jump(offset);
    });
    offsetInput.addEventListener("input", () => offsetInput.setCustomValidity(""));
    view.stop = () => { stopped = true; revision++; controller?.abort(); };
    show(0);
    return view;
}
