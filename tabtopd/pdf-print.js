// Fetch a PDF for printing and open the browser print dialog. Used by the
// PDF preview's Print control (see preview-frames.js).

// Printing a PDF fetches the whole file first. Ask before this many bytes.
export const PDF_PRINT_WARN = 32 << 20;
export const PDF_PRINT_PART = 16 << 20;

// pdfPrintBlob reads the whole PDF at path/file into a Blob for printing.
// read(path, file, begin, end, opts) must return an ArrayBuffer of that range.
export async function pdfPrintBlob(path, file, { signal, onProgress, partSize = PDF_PRINT_PART, read } = {}) {
    if (!file.local && typeof read !== "function") throw new Error("a range reader is required");
    const chunks = [];
    let got = 0;
    const push = (bytes) => {
        chunks.push(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes);
        got += bytes.byteLength;
        onProgress?.(got, file.size);
    };
    const start = file.start instanceof ArrayBuffer ? new Uint8Array(file.start) : file.start;
    if (file.local) {
        signal?.throwIfAborted();
        push(start.byteLength === file.size ? start : start.slice(0, file.size));
        return new Blob(chunks, { type: "application/pdf" });
    }
    if (start?.byteLength) push(start);
    for (let begin = start?.byteLength ?? 0; begin < file.size; begin += partSize) {
        signal?.throwIfAborted();
        const end = Math.min(begin + partSize, file.size);
        push(await read(path, file, begin, end, { maxBytes: partSize, signal }));
    }
    return new Blob(chunks, { type: "application/pdf" });
}

// openPrintDialog opens blob in a temporary window/iframe and asks the
// browser to print it. Returns false if nothing could be opened.
export function openPrintDialog(blob, { open = window.open.bind(window), body = document.body } = {}) {
    const url = URL.createObjectURL(blob);
    let released = false;
    const release = () => { if (!released) { released = true; URL.revokeObjectURL(url); } };
    const w = open(url, "_blank", "noopener,noreferrer");
    if (w) {
        let printed = false;
        const finish = () => { try { w.close(); } catch { /* closed */ } release(); };
        const run = () => {
            if (printed) return;
            printed = true;
            try { w.print(); } catch { /* some browsers refuse until load */ }
            setTimeout(finish, 1500);
        };
        try { w.addEventListener("load", run, { once: true }); } catch { /* PDF viewers */ }
        setTimeout(run, 800);
        return true;
    }
    // Pop-ups blocked: fall back to a hidden iframe in this page.
    const frame = document.createElement("iframe");
    frame.title = "Print";
    frame.hidden = true;
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
    frame.src = url;
    const finish = () => { frame.remove(); release(); };
    frame.addEventListener("load", () => {
        try { frame.contentWindow?.print(); } catch { /* blocked */ }
        setTimeout(finish, 1500);
    }, { once: true });
    body.append(frame);
    return true;
}
