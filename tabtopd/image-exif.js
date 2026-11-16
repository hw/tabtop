// Bounded TIFF/EXIF inspection and typed field edits.
// Unknown entries, maker-note offsets, thumbnails and orientation stay put.
export const exifFields = [
    ["description", "Description", "Image", 0x010e], ["artist", "Artist", "Image", 0x013b],
    ["copyright", "Copyright", "Image", 0x8298], ["make", "Camera make", "Image", 0x010f],
    ["model", "Camera model", "Image", 0x0110], ["software", "Software", "Image", 0x0131],
    ["modified", "Date modified", "Image", 0x0132], ["taken", "Date taken", "EXIF", 0x9003],
    ["digitized", "Date digitized", "EXIF", 0x9004], ["lensMake", "Lens make", "EXIF", 0xa433],
    ["lensModel", "Lens model", "EXIF", 0xa434],
].map(([key, label, group, tag]) => ({ key, label, group, tag, date: [0x0132, 0x9003, 0x9004].includes(tag) }));
const names = new Map(exifFields.map(f => [`${f.group}:${f.tag}`, f.label]));
for (const [tag, name] of [[0x0100,"Width"],[0x0101,"Height"],[0x0112,"Orientation"],[0x011a,"X resolution"],[0x011b,"Y resolution"],[0x0128,"Resolution unit"]]) names.set(`Image:${tag}`, name);
for (const [tag, name] of [[0x829a,"Exposure time"],[0x829d,"F number"],[0x8827,"ISO speed"],[0x9201,"Shutter speed"],[0x9202,"Aperture"],[0x9204,"Exposure bias"],[0x9207,"Metering mode"],[0x9209,"Flash"],[0x920a,"Focal length"],[0x927c,"Maker note"],[0x9286,"User comment"],[0xa001,"Color space"],[0xa002,"Pixel width"],[0xa003,"Pixel height"],[0xa405,"35mm focal length"],[0xa431,"Camera serial number"],[0xa435,"Lens serial number"]]) names.set(`EXIF:${tag}`, name);
for (const [tag, name] of [[0,"GPS version"],[1,"Latitude reference"],[2,"Latitude"],[3,"Longitude reference"],[4,"Longitude"],[5,"Altitude reference"],[6,"Altitude"],[7,"GPS time"],[18,"Map datum"],[29,"GPS date"]]) names.set(`GPS:${tag}`, name);
const sizes = { 1:1, 2:1, 3:2, 4:4, 5:8, 6:1, 7:1, 8:2, 9:4, 10:8, 11:4, 12:8 };
export const exifTypeNames = { 1:"Byte", 2:"Text (ASCII)", 3:"Unsigned short", 4:"Unsigned long", 5:"Unsigned fraction", 6:"Signed byte", 7:"Binary (hex)", 8:"Signed short", 9:"Signed long", 10:"Signed fraction", 11:"Float", 12:"Double" };
export const managedExifTags = new Set([0x8769,0x8825,0xa005,0x0201,0x0202,0x0111,0x0117]);
export const exifCatalog = [...names].map(([id,label]) => { const [group,tag] = id.split(":"); const n=Number(tag); return {group,tag:n,label,type:exifFields.some(f=>f.group===group&&f.tag===n) ? 2 : group==="GPS" ? [1,3,18,29].includes(n)?2:[2,4,6,7].includes(n)?5:1 : [0x829a,0x829d,0x9202,0x920a,0x011a,0x011b].includes(n)?5:[0x9201,0x9204].includes(n)?10:[0x927c,0x9286].includes(n)?7:[0xa431,0xa435].includes(n)?2:[0x0100,0x0101,0xa002,0xa003].includes(n)?4:3 }; });
const pointers = new Map([[0x8769,"EXIF"],[0x8825,"GPS"],[0xa005,"Interop"]]);
const MAX_BYTES = 1024 * 1024, MAX_ENTRIES = 2048;

export function readExif(input) {
    if (!input) return { fields: {}, rows: [], directories: [], bytes: null, little: true };
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.length < 8 || bytes.length > MAX_BYTES) throw new Error("The EXIF block is incomplete or exceeds 1 MB.");
    const little = bytes[0] === 0x49 && bytes[1] === 0x49;
    if (!little && !(bytes[0] === 0x4d && bytes[1] === 0x4d)) throw new Error("Invalid EXIF byte order.");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const check = (at, length) => { if (!Number.isSafeInteger(at) || at < 8 || length > bytes.length - at) throw new Error("EXIF points outside its block."); };
    const u16 = at => view.getUint16(at, little), u32 = at => view.getUint32(at, little);
    if (u16(2) !== 42) throw new Error("Unsupported EXIF TIFF header.");
    const directories = [], rows = [], fields = {}, seen = new Set();
    let total = 0;
    const visit = (at, group, depth = 0) => {
        if (!at) return;
        if (seen.has(at) || depth > 5) throw new Error("EXIF contains a repeated or deeply nested directory.");
        seen.add(at); check(at, 2);
        const count = u16(at); total += count;
        if (total > MAX_ENTRIES) throw new Error("EXIF contains too many entries.");
        check(at, 2 + count * 12 + 4);
        const directory = { at, group, entries: [], next: u32(at + 2 + count * 12) }; directories.push(directory);
        for (let i = 0; i < count; i++) {
            const entryAt = at + 2 + i * 12, tag = u16(entryAt), type = u16(entryAt + 2), count = u32(entryAt + 4);
            if (!sizes[type]) throw new Error("An EXIF field has an unsupported TIFF type.");
            const size = sizes[type] * count, valueAt = size <= 4 ? entryAt + 8 : u32(entryAt + 8);
            check(valueAt, size);
            const raw = bytes.subarray(valueAt, valueAt + size);
            const values = [];
            if (type !== 2 && type !== 7) for (let k = 0; k < Math.min(count, 32); k++) {
                const p = valueAt + k * sizes[type];
                const value = type === 1 ? view.getUint8(p) : type === 3 ? u16(p) : type === 4 ? u32(p)
                    : type === 5 || type === 10 ? `${type === 5 ? u32(p) : view.getInt32(p,little)}/${type === 5 ? u32(p+4) : view.getInt32(p+4,little)}`
                    : type === 6 ? view.getInt8(p) : type === 8 ? view.getInt16(p,little) : type === 9 ? view.getInt32(p,little)
                    : type === 11 ? view.getFloat32(p,little) : view.getFloat64(p,little);
                values.push(value);
            }
            let value = type === 2 ? new TextDecoder().decode(raw.subarray(0, 4096)).replace(/\0+$/, "")
                : type === 7 ? `${count} bytes` : values.join(", ") + (count > 32 ? "…" : "");
            if (group === "EXIF" && tag === 0x9286 && type === 7 && raw.length >= 8) {
                const prefix = String.fromCharCode(...raw.subarray(0, 8));
                if (prefix.startsWith("ASCII")) value = new TextDecoder().decode(raw.subarray(8, 4104)).replace(/\0+$/, "");
                else if (prefix.startsWith("UNICODE")) value = new TextDecoder(little ? "utf-16le" : "utf-16be").decode(raw.subarray(8, 4104)).replace(/\0+$/, "");
            }
            const entry = { at: entryAt, tag, type, count, size, valueAt, value };
            directory.entries.push(entry);
            if (!pointers.has(tag)) rows.push({ group, tag, type, count, entry, name: names.get(`${group}:${tag}`) ?? `Tag 0x${tag.toString(16).padStart(4,"0")}`, value });
            const field = exifFields.find(f => f.group === group && f.tag === tag);
            if (field && type === 2) fields[field.key] = value;
        }
        for (const entry of directory.entries) if (pointers.has(entry.tag)) {
            if (entry.type !== 4 || entry.count !== 1) throw new Error("Invalid EXIF directory pointer.");
            entry.directory = visit(u32(entry.valueAt), pointers.get(entry.tag), depth + 1);
        }
        if (directory.next) directory.nextDirectory = visit(directory.next, group === "Image" ? "Thumbnail" : `${group} (next)`, depth + 1);
        return directory;
    };
    visit(u32(4), "Image");
    return { fields, rows, directories, bytes, little };
}

// Append replacement directories, retaining offsets into the original block.
// Clear replaced values and retired directories so removed data is gone.
export function editExif(input, changes = {}, { removeGPS = false, edits = [] } = {}) {
    const model = readExif(input), little = model.little;
    const original = model.bytes ?? Uint8Array.of(0x49,0x49,42,0,0,0,0,0);
    // Shared/overlapping ranges cannot be cleared without damaging another
    // field. Such blocks can be inspected, but are refused for edits.
    const ranges = [{ start: 0, end: 8 }];
    for (const dir of model.directories) {
        ranges.push({ start: dir.at, end: dir.at + 2 + dir.entries.length * 12 + 4 });
        for (const e of dir.entries) if (e.size > 4) ranges.push({ start: e.valueAt, end: e.valueAt + e.size });
    }
    // Thumbnail pixel payloads are pointed to by scalar TIFF fields rather
    // than stored as their values; protect them from clearing too.
    if (model.bytes) {
        const v = new DataView(original.buffer, original.byteOffset, original.byteLength);
        const unsigned = entry => {
            if (![3,4].includes(entry.type) || entry.count > MAX_ENTRIES) throw new Error("Unsupported EXIF thumbnail layout.");
            return Array.from({ length: entry.count }, (_,i) => entry.type === 3 ? v.getUint16(entry.valueAt+i*2,little) : v.getUint32(entry.valueAt+i*4,little));
        };
        for (const dir of model.directories) {
            for (const [offsetTag, sizeTag] of [[0x0201,0x0202],[0x0111,0x0117]]) {
                const offsets = dir.entries.find(e => e.tag === offsetTag), counts = dir.entries.find(e => e.tag === sizeTag);
                if (!offsets && !counts) continue;
                if (!offsets || !counts) throw new Error("Incomplete EXIF thumbnail layout.");
                const starts = unsigned(offsets), lengths = unsigned(counts);
                if (starts.length !== lengths.length) throw new Error("Incomplete EXIF thumbnail layout.");
                starts.forEach((start,i) => {
                    const end = start + lengths[i];
                    if (start < 8 || end > original.length) throw new Error("EXIF thumbnail points outside its block.");
                    if (end > start) ranges.push({ start, end });
                });
            }
        }
    }
    ranges.sort((a,b) => a.start - b.start);
    for (let i = 1; i < ranges.length; i++) if (ranges[i].start < ranges[i-1].end) throw new Error("Overlapping EXIF values cannot be edited safely.");
    const parts = [original.slice()]; let length = original.length;
    const align = () => { if (length % 2) { parts.push(new Uint8Array(1)); length++; } };
    const append = bytes => { align(); if (length+bytes.length>MAX_BYTES) throw new Error("The edited EXIF block exceeds 1 MB."); const at = length; parts.push(bytes); length += bytes.length; return at; };
    const dv = buffer => new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const pointer = (tag, at) => { const b = new Uint8Array(12), v = dv(b); v.setUint16(0,tag,little); v.setUint16(2,4,little); v.setUint32(4,1,little); v.setUint32(8,at,little); return b; };
    const dirs = new Map();
    for (const dir of model.directories) {
        if (dirs.has(dir.group)) throw new Error("Duplicate EXIF directories cannot be edited.");
        dirs.set(dir.group, dir);
    }
    const replacements = new Map();
    const setReplacement = (group, tag, entry) => {
        const list = replacements.get(group) ?? new Map(); replacements.set(group,list);
        if (list.has(tag)) throw new Error("A field can only be changed once.");
        list.set(tag,entry);
    };
    const encodeEntry = (tag,type,value,format) => {
        const encoded = encodeExifValue(type,value,little,format), b = new Uint8Array(12), v = dv(b);
        v.setUint16(0,tag,little); v.setUint16(2,type,little); v.setUint32(4,encoded.length/sizes[type],little);
        if (encoded.length <= 4) b.set(encoded,8); else v.setUint32(8,append(encoded),little);
        return b;
    };
    for (const [key, value] of Object.entries(changes)) {
        const field = exifFields.find(f => f.key === key);
        if (!field) throw new Error("Unknown editable EXIF field.");
        if (typeof value !== "string" || value.length > 1024 || /[^\x20-\x7e]/.test(value)) throw new Error(`${field.label}: use up to 1,024 ASCII characters.`);
        if (field.date && value && !validDate(value)) throw new Error(`${field.label}: use YYYY:MM:DD HH:MM:SS, with a valid date.`);
        setReplacement(field.group,field.tag,value ? encodeEntry(field.tag,2,value) : null);
    }
    if (edits.length > MAX_ENTRIES) throw new Error("Too many EXIF edits.");
    for (const change of edits) {
        const {group,tag,type,value,remove,format} = change;
        if (!dirs.has(group) && !["Image","EXIF","GPS","Interop"].includes(group)) throw new Error("Unknown EXIF group.");
        if (!Number.isInteger(tag) || tag < 0 || tag > 65535) throw new Error("Tag must be between 0x0000 and 0xffff.");
        if (managedExifTags.has(tag)) throw new Error("Directory and thumbnail links are maintained automatically.");
        const field = exifFields.find(f => f.group === group && f.tag === tag);
        if (!remove && field?.date && !validDate(value)) throw new Error(`${field.label}: use YYYY:MM:DD HH:MM:SS, with a valid date.`);
        if (!remove && group === "Image" && tag === 0x0112 && !/^[1-8]$/.test(value.trim())) throw new Error("Orientation must be from 1 to 8.");
        setReplacement(group,tag,remove ? null : encodeEntry(tag,type,value,format));
    }
    if (removeGPS && replacements.has("GPS")) throw new Error("GPS fields cannot be changed while removing the GPS group.");
    // Adding an Interop directory also creates its EXIF parent.
    if (replacements.has("Interop") && !replacements.has("EXIF")) replacements.set("EXIF",new Map());
    const clearValue = e => { parts[0].fill(0, e.valueAt, e.valueAt + e.size); };
    const discarded = new Set();
    const discard = dir => {
        if (!dir || discarded.has(dir)) return;
        discarded.add(dir);
        for (const e of dir.entries) { clearValue(e); if (e.directory) discard(e.directory); }
        discard(dir.nextDirectory);
        parts[0].fill(0,dir.at,dir.at + 2 + dir.entries.length*12 + 4);
    };
    if (removeGPS) discard(dirs.get("GPS"));
    const needsRebuild = dir => dir && (replacements.has(dir.group) || dir.entries.some(e => e.directory && (discarded.has(e.directory) || needsRebuild(e.directory))) || needsRebuild(dir.nextDirectory));
    const built = new Map();
    const rebuild = group => {
        if (built.has(group)) return built.get(group);
        const dir = dirs.get(group), replace = replacements.get(group) ?? new Map(), entries = new Map();
        if (group !== "Image" && dir && !needsRebuild(dir)) return dir.at;
        for (const e of dir?.entries ?? []) {
            if (entries.has(e.tag)) throw new Error("Duplicate EXIF tags cannot be edited.");
            entries.set(e.tag,original.slice(e.at,e.at+12));
            if (replace.has(e.tag)) clearValue(e);
            if (e.directory) {
                if (discarded.has(e.directory)) entries.delete(e.tag);
                else entries.set(e.tag,pointer(e.tag,rebuild(e.directory.group)));
            }
        }
        for (const [tag,bytes] of replace) { if (bytes) entries.set(tag,bytes); else entries.delete(tag); }
        for (const [tag,child] of pointers) {
            if ((group === "Image" && ["EXIF","GPS"].includes(child) || group === "EXIF" && child === "Interop") && replacements.has(child) && !(removeGPS && child === "GPS")) entries.set(tag,pointer(tag,rebuild(child)));
        }
        if (group === "Image" && removeGPS) entries.delete(0x8825);
        const next = dir?.nextDirectory && !discarded.has(dir.nextDirectory) ? rebuild(dir.nextDirectory.group) : 0;
        if (dir) parts[0].fill(0,dir.at,dir.at + 2 + dir.entries.length*12 + 4);
        const b = new Uint8Array(2 + entries.size*12 + 4), v = dv(b);
        v.setUint16(0,entries.size,little);
        [...entries].sort((a,b)=>a[0]-b[0]).forEach(([,entry],i)=>b.set(entry,2+i*12));
        v.setUint32(b.length-4,next,little);
        const at = append(b); built.set(group,at); return at;
    };
    const root = rebuild("Image"); dv(parts[0]).setUint32(4,root,little);
    if (length > MAX_BYTES) throw new Error("The edited EXIF block exceeds 1 MB.");
    const out = new Uint8Array(length); let at = 0;
    for (const part of parts) { out.set(part,at); at += part.length; }
    readExif(out); // The resulting directory graph must still be valid.
    return out;
}
export function validDate(value) {
    if (!/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return false;
    const [year,month,day,hour,minute,second] = value.split(/[: ]/).map(Number);
    const date = new Date(0); date.setUTCFullYear(year,month-1,day); date.setUTCHours(hour,minute,second,0);
    return date.getUTCFullYear()===year && date.getUTCMonth()===month-1 && date.getUTCDate()===day && hour<24 && minute<60 && second<60;
}

// The full editable value is separate from the bounded display summary.
export function exifEditValue(model, row) {
    const e = row.entry, raw = model.bytes.subarray(e.valueAt,e.valueAt+e.size);
    if (e.type === 2) return {value:new TextDecoder().decode(raw).replace(/\0+$/, ""),format:"value"};
    if (e.type === 7) {
        if (row.group === "EXIF" && row.tag === 0x9286 && raw.length >= 8) {
            const prefix = String.fromCharCode(...raw.subarray(0,8));
            if (prefix.startsWith("ASCII") || prefix.startsWith("UNICODE")) return {value:new TextDecoder(prefix.startsWith("ASCII")?"utf-8":model.little?"utf-16le":"utf-16be").decode(raw.subarray(8)).replace(/\0+$/,""),format:"comment"};
        }
        return {value:Array.from(raw,b=>b.toString(16).padStart(2,"0")).join(" "),format:"hex"};
    }
    const v = new DataView(raw.buffer,raw.byteOffset,raw.byteLength), little=model.little, values=[];
    for (let at=0;at<raw.length;at+=sizes[e.type]) {
        const type=e.type;
        values.push(type===1?v.getUint8(at):type===3?v.getUint16(at,little):type===4?v.getUint32(at,little):type===6?v.getInt8(at):type===8?v.getInt16(at,little):type===9?v.getInt32(at,little):type===11?v.getFloat32(at,little):type===12?v.getFloat64(at,little):`${type===5?v.getUint32(at,little):v.getInt32(at,little)}/${type===5?v.getUint32(at+4,little):v.getInt32(at+4,little)}`);
    }
    return {value:values.join(", "),format:"value"};
}
export function encodeExifValue(type,value,little=true,format="value") {
    if (!Number.isInteger(type) || !Object.hasOwn(sizes,type) || typeof value!=="string" || value.length>MAX_BYTES*3) throw new Error("Invalid EXIF type or oversized value.");
    if (type===2) {
        if (/[^\x20-\x7e]/.test(value)) throw new Error("ASCII fields accept printable ASCII characters.");
        return new TextEncoder().encode(value+"\0");
    }
    if (type===7 && format==="comment") {
        const data=new Uint8Array(8+(value.length+1)*2), v=new DataView(data.buffer);
        data.set(new TextEncoder().encode("UNICODE\0"));
        for (let i=0;i<value.length;i++) v.setUint16(8+i*2,value.charCodeAt(i),little);
        return data;
    }
    if (type===7) {
        const hex=value.replace(/\s/g,"");
        if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) throw new Error("Binary fields use pairs of hexadecimal digits, such as 01 ff 20.");
        return Uint8Array.from(hex.match(/../g)??[],b=>parseInt(b,16));
    }
    const values=value.trim()?value.trim().replace(/\s*\/\s*/g,"/").split(/[,\s]+/):[];
    if (!values.length || values.length>MAX_BYTES/sizes[type]) throw new Error("Enter at least one number; separate multiple values with commas.");
    const out=new Uint8Array(values.length*sizes[type]), v=new DataView(out.buffer);
    const integer=(s,min,max)=>{const n=Number(s);if(!Number.isInteger(n)||n<min||n>max)throw new Error(`Value must be an integer from ${min} to ${max}.`);return n;};
    values.forEach((s,i)=>{
        const at=i*sizes[type];
        if (type===5 || type===10) {
            let [a,b]=s.split("/");
            if (b===undefined) {
                const n=Number(a);if(!Number.isFinite(n))throw new Error("Enter a fraction or decimal number.");
                const limit=type===5?4294967295:2147483647, target=Math.abs(n);
                let h0=0,h1=1,k0=1,k1=0,x=target,best=null;
                for(let step=0;step<32;step++) {
                    const whole=Math.floor(x),h=whole*h1+h0,k=whole*k1+k0;
                    if(h>limit || k>limit)break;
                    best=[h,k];
                    if(Math.abs(h/k-target)<=target*1e-12 || x===whole)break;
                    [h0,h1,k0,k1]=[h1,h,k1,k];x=1/(x-whole);
                }
                if(!best || Math.abs(best[0]/best[1]-target)>target*1e-12)throw new Error("This decimal cannot be represented by a 32-bit EXIF fraction.");
                a=String((n<0?-1:1)*best[0]);b=String(best[1]);
            }
            if (a==="" || b==="")throw new Error("A fraction needs a numerator and denominator.");
            if (s.split("/").length>2)throw new Error("Enter a fraction such as 1/125.");
            const min=type===5?0:-2147483648,max=type===5?4294967295:2147483647;
            const numerator=integer(a,min,max),denominator=integer(b,min,max);if(!denominator)throw new Error("A fraction's denominator cannot be zero.");
            if(type===5){v.setUint32(at,numerator,little);v.setUint32(at+4,denominator,little);}else{v.setInt32(at,numerator,little);v.setInt32(at+4,denominator,little);}return;
        }
        const spec={1:["setUint8",0,255],3:["setUint16",0,65535],4:["setUint32",0,4294967295],6:["setInt8",-128,127],8:["setInt16",-32768,32767],9:["setInt32",-2147483648,2147483647]}[type];
        if(spec) v[spec[0]](at,integer(s,spec[1],spec[2]),little);
        else { const n=Number(s);if(!Number.isFinite(n) || type===11 && !Number.isFinite(Math.fround(n)))throw new Error("Enter a finite number.");v[type===11?"setFloat32":"setFloat64"](at,n,little); }
    });
    return out;
}
