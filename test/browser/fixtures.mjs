import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";

// zipFile is a zip of [name, content] entries, stored, as an EPUB's
// mimetype must be (and the rest may be).
export function zipFile(entries) {
    const parts = [];
    const central = [];
    let at = 0;
    for (const [name, content] of entries) {
        const data = Buffer.from(content);
        const nameBytes = Buffer.from(name);
        const head = Buffer.alloc(30);
        head.writeUInt32LE(0x04034b50, 0);
        head.writeUInt16LE(20, 4);
        head.writeUInt32LE(crc32(data), 14);
        head.writeUInt32LE(data.length, 18);
        head.writeUInt32LE(data.length, 22);
        head.writeUInt16LE(nameBytes.length, 26);
        const entry = Buffer.alloc(46);
        entry.writeUInt32LE(0x02014b50, 0);
        entry.writeUInt16LE(20, 4);
        entry.writeUInt16LE(20, 6);
        entry.writeUInt32LE(crc32(data), 16);
        entry.writeUInt32LE(data.length, 20);
        entry.writeUInt32LE(data.length, 24);
        entry.writeUInt16LE(nameBytes.length, 28);
        entry.writeUInt32LE(at, 42);
        parts.push(head, nameBytes, data);
        central.push(entry, nameBytes);
        at += head.length + nameBytes.length + data.length;
    }
    const dir = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(dir.length, 12);
    end.writeUInt32LE(at, 16);
    return Buffer.concat([...parts, dir, end]);
}

// pngSquare is a size×size PNG, blue.
export function pngSquare(size) {
    return pngPicture(size, size);
}
function pngPicture(width, height) {
    const chunk = (type, data) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(body));
        return Buffer.concat([len, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;  // bits
    ihdr[9] = 2;  // RGB
    const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [40, 90, 200]).flat())]);
    const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", pixels), chunk("IEND", Buffer.alloc(0))]);
}


// A reusable source fixture, independent of any padded-video test result.
export function videoFixture(work) {
    const file = `${work}/video-source.mp4`;
    if (!existsSync(file)) execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=12", "-t", "30", "-c:v", "libx264", "-preset", "ultrafast", "-g", "12", "-crf", "24", "-pix_fmt", "yuv420p", "-movflags", "+faststart", file]);
    return file;
}
