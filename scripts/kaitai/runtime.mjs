import KaitaiStream from "kaitai-struct/KaitaiStream.js";
import { Inflate } from "pako";

// Shared by all bundled parsers. The budget spans initial parsing AND subsequent
// lazy getters; expanding another field never resets exhausted allowances.
const MAX_NODES = 20000;
const MAX_STEPS = 100000;
const MAX_DEPTH = 128;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_INFLATED = 8 * 1024 * 1024;
let nodes, steps, depth, bytes, inflated, failure;
const fail = message => {
    if (!failure) { failure = new Error(message); failure.name = "KaitaiBudgetError"; failure.code = "KAITAI_BUDGET"; }
    throw failure;
};
const check = () => { if (failure) throw failure; };
const spendBytes = n => {
    check();
    if (!Number.isSafeInteger(n) || n < 0 || n > MAX_BYTES - bytes) fail("Decoded allocations exceed the 32 MiB preview budget");
    bytes += n;
};
const budget = {
    reset() { nodes = steps = depth = bytes = inflated = 0; failure = null; },
    node() { check(); if (++nodes > MAX_NODES) fail("Decoded structure exceeds the 20,000 allocation preview budget"); },
    step() { check(); if (++steps > MAX_STEPS) fail("Decoding exceeds the 100,000 operation preview budget"); },
    enter() { this.step(); if (depth >= MAX_DEPTH) fail("Decoded structure exceeds the 128-level nesting preview budget"); depth++; },
    leave() { depth--; },
    stats() { return { nodes, steps, depth, bytes, inflated, exhausted: !!failure }; },
};
budget.reset();
KaitaiStream._previewBudget = budget;

// Count primitive reads and returned byte views as well as generated objects.
for (const name of Object.getOwnPropertyNames(KaitaiStream.prototype)) {
    const method = Object.getOwnPropertyDescriptor(KaitaiStream.prototype, name).value;
    if (typeof method !== "function" || !/^(?:read|mapUint8Array|seek|isEof)/.test(name)) continue;
    KaitaiStream.prototype[name] = function (...args) {
        budget.step();
        if (/^(?:readBytes|mapUint8Array)/.test(name)) budget.node();
        if (name === "seek") this._previewSeek = Number.isSafeInteger(args[0]) && args[0] > this.size ? args[0] : null;
        try { return method.apply(this, args); }
        catch (error) {
            if (!error.previewRead && (error.name === "EOFError" || /^End of stream/.test(error.message ?? ""))) {
                const position = this._previewSeek ?? this.pos;
                const available = Math.max(0, error.bytesAvail ?? this.size - this.pos);
                error.previewRead = { reason: "eof", file: this._buffer === KaitaiStream._previewInput?.buffer,
                    offset: this.byteOffset + position, requested: error.bytesReq ?? available + 1, available,
                    streamOffset: this.byteOffset, streamSize: this.size };
            }
            throw error;
        }
    };
}
for (const name of ["bytesToStr", "processXorOne", "processXorMany", "processRotateLeft"]) {
    const method = KaitaiStream[name];
    KaitaiStream[name] = function (data, ...args) {
        budget.step();
        spendBytes(data.byteLength * (name === "bytesToStr" ? 2 : 1));
        return method.call(this, data, ...args);
    };
}
KaitaiStream.processZlib = data => {
    budget.step();
    const chunks = [];
    let length = 0;
    const inflater = new Inflate({ chunkSize: 16384 });
    inflater.onData = chunk => {
        budget.node(); budget.step();
        // Cumulative across every stream and lazy expansion, not per member.
        if (chunk.length > MAX_INFLATED - inflated) fail("Decompressed data exceeds the cumulative 8 MiB preview budget");
        inflated += chunk.length;
        spendBytes(chunk.length * 2); // The inflater's chunks and the joined result.
        length += chunk.length;
        chunks.push(chunk);
    };
    inflater.push(data, true);
    if (inflater.err) throw new Error(inflater.msg || "Invalid compressed data");
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
};
export { KaitaiStream };
