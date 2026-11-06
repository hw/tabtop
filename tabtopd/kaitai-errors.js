// Serializable diagnostics. Offsets are supplied by the bounded stream runtime;
// never infer an original-file offset for decompressed or parameter streams.
export function decodeStatus(error, { fileSize, prefixSize }) {
    const details = `${error.name ?? "Error"}: ${String(error.message ?? error).slice(0, 1000)}`;
    if (error.code === "KAITAI_BUDGET" || error.name === "KaitaiBudgetError") {
        return { kind: "budget", title: "Decode limit reached", message: "Showing the fields decoded before the resource limit was reached. Raw hex is still available.", details };
    }
    if (/^Validation/.test(error.name ?? "")) {
        return { kind: "format-mismatch", title: "Format validation failed", message: "The data does not satisfy the selected format. It may be a different format or contain invalid fields.", details };
    }
    const read = error.previewRead;
    if (error.name === "EOFError" || read?.reason === "eof") {
        const valid = n => Number.isSafeInteger(n) && n >= 0;
        const offset = read?.file && valid(read.offset) && valid(read.available) && valid(read.requested)
            ? read.offset + Math.min(read.available, read.requested) : null;
        const requiredEnd = offset === null ? null : read.offset + read.requested;
        const length = offset === null ? null : Math.max(0, read.requested - read.available);
        const required = offset !== null && valid(offset) && valid(requiredEnd) ? { offset, length } : {};
        if (offset !== null && fileSize > prefixSize && offset >= prefixSize && requiredEnd <= fileSize &&
            read.streamOffset === 0 && read.streamSize === prefixSize) {
            return { kind: "outside-preview", title: "Data outside the decoded prefix", message: "This field needs bytes beyond the first 1 MB. Jump to those bytes in hex; Kaitai remains limited to the prefix.", ...required, details };
        }
        return { kind: "truncated", title: "Unexpected end of data", message: read && !read.file
            ? "A decoded payload or parameter stream ended before this field could be read."
            : read && (read.streamOffset !== 0 || read.streamSize !== prefixSize)
                ? "A bounded section ended before this field could be read. The section may be truncated or invalid."
                : "The selected format needs more bytes than this file contains. The file may be truncated or the format may not match.", ...required, details };
    }
    return { kind: "error", title: "Unable to decode this field", message: "The decoder stopped on invalid or unsupported data. Previously decoded fields and raw hex remain available.", details };
}
