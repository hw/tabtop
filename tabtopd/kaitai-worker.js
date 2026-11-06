import { binaryChunkSize } from "./preview-model.js";
import { decodeStatus } from "./kaitai-errors.js";

// The worker receives bytes only. File access and tunnel credentials stay in the page.
let rootBuffer, fileSize, schemas, root, records, nextId, classSchemas, parseIssue;
const PAGE = 100;
const own = (o, k) => o != null && Object.hasOwn(o, k);
const camel = s => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const pascal = s => { const name = camel(s); return name[0]?.toUpperCase() + name.slice(1); };

function schemaAt(id) {
    const [first, ...rest] = id.split("::");
    let node = own(schemas, first) ? schemas[first] : null;
    for (const part of rest) node = own(node?.types, part) ? node.types[part] : null;
    return node;
}
function resolveType(ref, context) {
    if (typeof ref !== "string") return null;
    ref = ref.split("(")[0];
    if (own(schemas, ref)) return schemas[ref];
    if (ref.includes("::") && own(schemas, ref.split("::")[0])) return schemaAt(ref);
    for (let id = context?.id; id; id = id.includes("::") ? id.slice(0, id.lastIndexOf("::")) : "") {
        const found = schemaAt(`${id}::${ref}`);
        if (found) return found;
    }
    return null;
}
function schemaFor(value, hint, parent) {
    if (hint || !value || typeof value !== "object" || Array.isArray(value) || value instanceof Uint8Array) return hint;
    const matches = classSchemas.get(value.constructor?.name) ?? [];
    const local = matches.filter(node => node.id.split("::")[0] === parent?.id.split("::")[0]);
    return local.length === 1 ? local[0] : matches.length === 1 ? matches[0] : null;
}
function enumTable(record) {
    const debugName = record.debug?.enumName;
    if (typeof debugName === "string") {
        const [rootName, ...parts] = debugName.split(".");
        const enumName = parts.pop();
        const rootId = Object.keys(schemas).find(id => pascal(id) === rootName);
        let node = schemas[rootId];
        for (const part of parts) node = Object.values(node?.types ?? {}).find(child => pascal(child.id.split("::").at(-1)) === part);
        const key = Object.keys(node?.enums ?? {}).find(name => pascal(name) === enumName);
        if (key) return { name: debugName, values: node.enums[key] };
    }
    const ref = record.field?.enum;
    if (!ref) return null;
    const parts = ref.split("::"), name = parts.pop();
    let node = parts.length ? resolveType(parts.join("::"), record.ownerSchema) : record.ownerSchema;
    while (node) {
        if (own(node.enums, name)) return { name: `${node.id}::${name}`, values: node.enums[name] };
        const at = node.id.lastIndexOf("::");
        node = at < 0 ? null : schemaAt(node.id.slice(0, at));
    }
    return null;
}
function range(record) {
    const { debug, stream } = record;
    if (!debug || stream?._buffer !== rootBuffer) return null;
    const begin = debug.start + (debug.ioOffset ?? stream.byteOffset ?? 0);
    const end = debug.end + (debug.ioOffset ?? stream.byteOffset ?? 0);
    return Number.isSafeInteger(begin) && Number.isSafeInteger(end) && begin >= 0 && end >= begin && end <= rootBuffer.byteLength
        ? { begin, end } : null;
}
function byteOrder(record) {
    const type = record.field?.type;
    if (typeof type === "string") {
        if (/^[us]1$/.test(type)) return "Not applicable (1 byte)";
        if (/^[usfb]\d+(?:le|be)$/.test(type)) return type.endsWith("le") ? "Little endian" : "Big endian";
        if (!/^[usfb]\d+$/.test(type)) return "";
    } else return "";
    if (typeof record.owner?._is_le === "boolean") return record.owner._is_le ? "Little endian" : "Big endian";
    for (let node = record.ownerSchema; node;) {
        const order = type.startsWith("b") ? node.bitEndian : node.endian;
        if (order === "le" || order === "be") return order === "le" ? "Little endian" : "Big endian";
        const at = node.id.lastIndexOf("::");
        node = at < 0 ? null : schemaAt(node.id.slice(0, at));
    }
    return "";
}
function fieldType(record) {
    const { value, field, schema } = record;
    let type = typeof field?.type === "string" ? field.type : schema?.id;
    if (!type) {
        type = value instanceof Uint8Array ? "bytes" : typeof value === "string" ? "string" :
            typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" :
            field?.value !== undefined ? "computed value" : value?.constructor?.name ?? "Unknown";
    }
    return `${String(type).slice(0, 200)}${Array.isArray(value) ? "[]" : ""}`;
}
function register(record) {
    if (records.size >= 20000) { const error = new Error("Structure exceeds the 20,000 field preview limit"); error.code = "KAITAI_BUDGET"; throw error; }
    const id = ++nextId;
    records.set(id, record);
    return id;
}
function summary(value) {
    if (value === null || value === undefined) return String(value);
    if (value instanceof Uint8Array) {
        const sample = Array.from(value.subarray(0, 24), b => b.toString(16).padStart(2, "0")).join(" ");
        return `${value.length.toLocaleString()} bytes${sample ? `: ${sample}${value.length > 24 ? " …" : ""}` : ""}`;
    }
    if (Array.isArray(value)) return `${value.length.toLocaleString()} items`;
    if (typeof value === "object") return value.constructor?.name ?? "Structure";
    if (typeof value === "string") return JSON.stringify(value.slice(0, 200)) + (value.length > 200 ? " …" : "");
    return typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value) ? `${value} (approximate integer)` : String(value);
}
function describe(id) {
    const record = records.get(id), value = record.value, table = enumTable(record);
    const enumItem = table && (typeof value === "number" || typeof value === "string") && own(table.values, value) ? table.values[value] : null;
    const enumeration = typeof enumItem === "object" && enumItem ? enumItem.id : enumItem;
    const state = record.lazy ? "lazy" : record.issue ? "incomplete" : value === undefined ? "not-decoded" : "decoded";
    return { id, label: record.label, path: record.path, type: fieldType(record), byteOrder: byteOrder(record),
        value: record.lazy ? "Decode on expansion" : value === undefined ? record.issue?.title ?? "Not decoded or not present" : `${summary(value)}${enumeration ? ` (${enumeration})` : ""}`,
        enumName: table?.name ?? "", enumValue: enumeration ?? "", state,
        numericHex: typeof value === "number" && Number.isSafeInteger(value) ? `${value < 0 ? "-" : ""}0x${Math.abs(value).toString(16)}` : "",
        expandable: !!record.lazy || value != null && typeof value === "object" && !(value instanceof Uint8Array),
        range: range(record), doc: String(record.field?.doc ?? record.schema?.doc ?? "").slice(0, 8000),
        decoded: !!record.stream && record.stream._buffer !== rootBuffer };
}
function expand(id, start = 0) {
    const record = records.get(id);
    if (!record) throw new Error("This structure is no longer available");
    if (record.lazy) {
        try { record.value = record.owner[record.key]; }
        catch (error) {
            // Generated getters can leave a partially built object in their cache.
            record.value = record.owner[`_m_${record.key}`];
            record.issue = { ...decodeStatus(error, { fileSize, prefixSize: rootBuffer.byteLength }), path: record.path };
            if (record.value === undefined) {
                record.lazy = false;
                record.debug = record.owner._debug?.[record.key] ?? record.owner._debug?.[`_m_${record.key}`];
                error.node = describe(id); error.decodeStatus = record.issue; throw error;
            }
        }
        record.debug = record.owner._debug?.[record.key] ?? record.owner._debug?.[`_m_${record.key}`];
        record.schema = schemaFor(record.value, record.schema, record.ownerSchema);
        record.lazy = false;
    }
    const { value } = record;
    if (!value || typeof value !== "object" || value instanceof Uint8Array) return { node: describe(id), children: [], more: false, status: record.issue };
    const array = Array.isArray(value);
    const fields = array ? null : record.schema?.fields ?? {};
    const getters = array ? {} : Object.getOwnPropertyDescriptors(Object.getPrototypeOf(value) ?? {});
    const keys = array ? null : [...new Set([...Object.keys(fields), ...Object.keys(value),
        ...Object.keys(getters).filter(k => getters[k].get)])].filter(k => k && !k.startsWith("_") && k !== "constructor");
    const count = array ? value.length : keys.length;
    const children = [];
    for (let index = start; index < Math.min(count, start + PAGE); index++) {
        const key = array ? index : keys[index];
        const field = array ? record.field : fields[key] ?? record.schema?.instances?.[key];
        const lazy = !array && !!getters[key]?.get && !own(value, key);
        const childValue = lazy ? undefined : value[key];
        const debug = array ? record.debug?.arr?.[index] : value._debug?.[key] ?? value._debug?.[`_m_${key}`];
        const hint = array ? record.schema : resolveType(field?.type, record.schema);
        const child = register({ value: childValue, owner: value, key, lazy, debug, label: String(key),
            path: array ? `${record.path}[${key}]` : `${record.path}.${key}`,
            stream: array ? record.stream : value._io ?? record.stream, field,
            schema: schemaFor(childValue, hint, record.schema), ownerSchema: array ? record.ownerSchema : record.schema });
        children.push(describe(child));
    }
    return { node: describe(id), children, more: start + PAGE < count, next: start + PAGE, status: record.issue };
}
self.onmessage = async ({ data }) => {
    const { request, type } = data;
    try {
        if (type === "parse") {
            rootBuffer = data.bytes;
            if (!(rootBuffer instanceof ArrayBuffer) || rootBuffer.byteLength > binaryChunkSize) throw new Error("Kaitai decoding is limited to the first 1 MB");
            fileSize = data.size ?? rootBuffer.byteLength;
            if (!Number.isSafeInteger(fileSize) || fileSize < rootBuffer.byteLength) throw new Error("Invalid file size");
            const [{ Parser, KaitaiStream }, schemaData] = await Promise.all([
                import(data.module), fetch(data.schemas).then(r => { if (!r.ok) throw new Error("Format metadata is unavailable"); return r.json(); })]);
            schemas = schemaData;
            classSchemas = new Map();
            const index = node => {
                const name = pascal(node.id.split("::").at(-1));
                classSchemas.set(name, [...(classSchemas.get(name) ?? []), node]);
                for (const child of Object.values(node.types ?? {})) index(child);
            };
            for (const node of Object.values(schemas)) index(node);
            KaitaiStream._previewBudget.reset();
            KaitaiStream._previewInput = { buffer: rootBuffer, size: fileSize };
            const params = (data.params ?? []).map(p => p && typeof p === "object" && Array.isArray(p.bytes)
                ? (() => { const bytes = Uint8Array.from(p.bytes); return { data: bytes, _io: new KaitaiStream(bytes.buffer) }; })() : p);
            root = new Parser(new KaitaiStream(rootBuffer), undefined, undefined, ...params);
            parseIssue = null;
            try { root._read(); } catch (error) { parseIssue = decodeStatus(error, { fileSize, prefixSize: rootBuffer.byteLength }); }
            records = new Map(); nextId = 0;
            const id = register({ value: root, schema: schemas[data.format], stream: root._io, label: data.format, path: data.format, issue: parseIssue });
            const status = parseIssue ?? { kind: fileSize > rootBuffer.byteLength ? "prefix" : "complete",
                title: fileSize > rootBuffer.byteLength ? "Decoded prefix" : "Decoded",
                message: fileSize > rootBuffer.byteLength ? "Decoded the available prefix. Other sections may lie beyond the first 1 MB." : "Select a field to inspect it and jump to its bytes." };
            self.postMessage({ request, ...expand(id), status, warning: parseIssue ? `Decoding stopped: ${parseIssue.title}. ${parseIssue.message}` : "" });
        } else if (type === "expand") {
            self.postMessage({ request, ...expand(data.id, data.start ?? 0) });
        }
    } catch (error) { self.postMessage({ request, error: String(error.message ?? error).slice(0, 1000),
        status: error.decodeStatus ?? decodeStatus(error, { fileSize, prefixSize: rootBuffer?.byteLength ?? 0 }), node: error.node }); }
};
