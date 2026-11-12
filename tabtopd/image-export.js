// Browser-native image archives and raster PDFs. No PDF scripts, links, or
// original objects are copied into the new PDF; each page is a JPEG image.
import { crc32 } from "./image-meta.js";

const encoder = new TextEncoder();
// blobCRC is blob's CRC-32, read a MiB at a time.
async function blobCRC(blob, signal) {
    let crc = 0;
    for (let offset = 0; offset < blob.size; offset += 1024 * 1024) {
        signal?.throwIfAborted();
        crc = crc32(new Uint8Array(await blob.slice(offset, offset + 1024 * 1024).arrayBuffer()), crc);
    }
    return crc;
}
function record(length, fields) {
    const bytes = new Uint8Array(length), view = new DataView(bytes.buffer);
    for (const [at, value, size = 4] of fields) size === 2 ? view.setUint16(at, value, true) : view.setUint32(at, value, true);
    return bytes;
}
export async function imageZIP(entries, signal) {
    if (!entries.length || entries.length > 65535) throw new Error("Choose pages to export.");
    const data = [], central = [];
    let offset = 0, directorySize = 0;
    for (const { name, blob } of entries) {
        const filename = encoder.encode(name), crc = await blobCRC(blob, signal);
        if (blob.size > 0xffffffff || offset + blob.size > 0xffffffff || filename.length > 65535) throw new Error("The image ZIP is too large.");
        const local = record(30, [[0,0x04034b50],[4,20,2],[6,0x800,2],[12,0x21,2],[14,crc],[18,blob.size],[22,blob.size],[26,filename.length,2]]);
        const header = record(46, [[0,0x02014b50],[4,20,2],[6,20,2],[8,0x800,2],[14,0x21,2],[16,crc],[20,blob.size],[24,blob.size],[28,filename.length,2],[42,offset]]);
        data.push(local, filename, blob); central.push(header, filename);
        offset += local.length + filename.length + blob.size;
        directorySize += header.length + filename.length;
    }
    const end = record(22, [[0,0x06054b50],[8,entries.length,2],[10,entries.length,2],[12,directorySize],[16,offset]]);
    signal?.throwIfAborted();
    return new Blob([...data, ...central, end], { type: "application/zip" });
}

export function rasterPDF(pages) {
    if (!pages.length) throw new Error("Choose pages to export.");
    const parts = [], offsets = [0];
    let length = 0;
    const append = part => { const data = typeof part === "string" ? encoder.encode(part) : part; parts.push(data); length += data.size ?? data.byteLength; };
    const object = (id, value, stream) => {
        offsets[id] = length;
        append(`${id} 0 obj\n${value}`);
        if (stream) { append(`\nstream\n`); append(stream); append("\nendstream"); }
        append("\nendobj\n");
    };
    append("%PDF-1.7\n%\u00e2\u00e3\u00cf\u00d3\n");
    object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    object(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${3+i*3} 0 R`).join(" ")}] >>`);
    pages.forEach(({ blob, width, height, widthPt, heightPt }, i) => {
        if (blob.type !== "image/jpeg" || ![width,height,widthPt,heightPt].every(n => Number.isFinite(n) && n > 0)) throw new Error("Invalid PDF page image.");
        const id = 3 + i * 3, w = widthPt.toFixed(4), h = heightPt.toFixed(4);
        object(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${id+2} 0 R >> >> /Contents ${id+1} 0 R >>`);
        const commands = encoder.encode(`q\n${w} 0 0 ${h} 0 0 cm\n/Im0 Do\nQ\n`);
        object(id+1, `<< /Length ${commands.length} >>`, commands);
        object(id+2, `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${blob.size} >>`, blob);
    });
    const xref = length;
    append(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
    for (let id = 1; id < offsets.length; id++) append(`${String(offsets[id]).padStart(10,"0")} 00000 n \n`);
    append(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(parts, { type: "application/pdf" });
}

export async function encodePage(blob, type, quality = .92) {
    const image = await createImageBitmap(blob);
    try {
        const canvas = Object.assign(document.createElement("canvas"), { width: image.width, height: image.height });
        const ctx = canvas.getContext("2d");
        if (type === "image/jpeg") { ctx.fillStyle = "white"; ctx.fillRect(0,0,canvas.width,canvas.height); }
        ctx.drawImage(image,0,0);
        const encoded = await new Promise(resolve => canvas.toBlob(resolve,type,quality));
        if (!encoded || encoded.type !== type) throw new Error("This browser couldn't encode the chosen image format.");
        canvas.width = canvas.height = 0;
        return { blob: encoded, width: image.width, height: image.height };
    } finally { image.close(); }
}
