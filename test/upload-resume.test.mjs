// uploadFile carries on by itself after a lost connection, from what the
// server kept, and fails at once for anything else.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const target = new URL("../tabtopd/requests.js", import.meta.url).href;
const stub = `
export class TunnelError extends Error {
    constructor(message, login = false, lost = false) { super(message); this.login = login; this.lost = lost; }
}
export const session = async () => ({ id: "s" }), forgetSession = () => {};
export class Tunnel { static open(req) { return globalThis.openTunnel(req); } }
`;
const hooks = registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL === target && specifier === "./tunnel.js") {
        return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(stub) };
    }
    return next(specifier, context);
} });
let uploadFile;
try { ({ uploadFile } = await import(target)); } finally { hooks.deregister(); }

const CHUNK = 256 * 1024;
const file = () => new File([new Uint8Array(2 * CHUNK + 100)], "big.bin");
const fast = { delays: [0] };

// fakeTunnel answers an upload: reply first, then acknowledges chunks as
// they come, and after acks of them either ends with done (a text message)
// or closes as lost (closeReason "", as when the connection drops).
function fakeTunnel(reply, acks, done) {
    const queue = [];
    let waiter = null, sentChunks = 0;
    const push = (m) => (waiter ? (waiter(m), (waiter = null)) : queue.push(m));
    const t = {
        reply, closeReason: "", closeLogin: false, sent: [],
        sendData(b) {
            t.sent.push(b.length);
            if (++sentChunks <= acks) { push({ data: new Uint8Array() }); }
            if (sentChunks === acks) { push(done ? { text: JSON.stringify(done) } : null); }
        },
        sendText() {},
        next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => (waiter = r))),
        close() {},
    };
    if (acks === 0) { push(done ? { text: JSON.stringify(done) } : null); }
    return t;
}

let requests;
beforeEach(() => { requests = []; });

test("resumes after a lost connection from what the server has", async () => {
    const f = file();
    const script = [
        (req) => fakeTunnel({ id: "u1" }, 1, null),                   // one chunk, then lost
        () => { throw Object.assign(new Error("Can't reach the server."), { lost: true }); },  // still down
        (req) => fakeTunnel({ id: "u1", offset: CHUNK }, 2, { name: "big.bin" }),
    ];
    globalThis.openTunnel = async (req) => { requests.push(req); return script[requests.length - 1](req); };
    const notes = [];
    const res = await uploadFile(f, (bytes, note) => notes.push([bytes, note]), "", new AbortController().signal, false, fast);
    assert.equal(res.name, "big.bin");
    assert.equal(requests.length, 3);
    assert.equal(requests[0].resume, undefined);
    assert.equal(requests[2].resume, "u1");
    assert.ok(notes.some(([b, n]) => n && b === CHUNK), "says it's reconnecting, at what it had sent");
    assert.deepEqual(notes.at(-1), [f.size, undefined]);
});

test("a server error isn't retried", async () => {
    globalThis.openTunnel = async (req) => {
        requests.push(req);
        throw Object.assign(new Error("No room for it."), { lost: false });
    };
    await assert.rejects(uploadFile(file(), () => {}, "", new AbortController().signal, false, fast), /No room/);
    assert.equal(requests.length, 1);
});

test("a closed connection with a reason isn't retried", async () => {
    globalThis.openTunnel = async (req) => {
        requests.push(req);
        const t = fakeTunnel({ id: "u2" }, 0, null);
        t.closeReason = "Logged out.";
        return t;
    };
    await assert.rejects(uploadFile(file(), () => {}, "", new AbortController().signal, false, fast), /Logged out/);
    assert.equal(requests.length, 1);
});

test("gives up once it gets nowhere for giveUp", async () => {
    globalThis.openTunnel = async (req) => {
        requests.push(req);
        throw Object.assign(new Error("Can't reach the server."), { lost: true });
    };
    await assert.rejects(uploadFile(file(), () => {}, "", new AbortController().signal, false, { delays: [0.01], giveUp: 50 }),
        /Can't reach/);
    assert.ok(requests.length > 1, "tried again before giving up");
});

test("cancelling while it waits to reconnect stops it", async () => {
    const ac = new AbortController();
    globalThis.openTunnel = async (req) => {
        requests.push(req);
        setTimeout(() => ac.abort(new Error("cancelled")), 10);
        throw Object.assign(new Error("Can't reach the server."), { lost: true });
    };
    await assert.rejects(uploadFile(file(), () => {}, "", ac.signal, false, { delays: [60] }), /cancelled/);
    assert.equal(requests.length, 1);
});
