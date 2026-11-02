import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const protocolURL = new URL("../tabtopd/tunnel-protocol.js", import.meta.url).href;
// Derivation stages can trigger a close while the real protocol awaits them.
// Cryptographic correctness is covered by the Go/JavaScript interop tests.
const cryptoStub = `
export const concat = (...parts) => Uint8Array.from(parts.flatMap(p => [...p]));
export const bytes = x => x, nonce = () => new Uint8Array(12), equal = () => false;
export const loginKeys = () => {}, cpaceGenerator = () => {}, elligator2 = () => {};
export const chacha20poly1305 = () => ({ encrypt: x => x, decrypt: x => x });
export async function cryptoBackend() { return {
    keygen: async () => ({ secret: new Uint8Array(32), pub: new Uint8Array(32) }),
    scalarMult: async () => { await globalThis.derivationStage('scalarMult'); return new Uint8Array(32); },
    sha256: async () => { await globalThis.derivationStage('sha256'); return new Uint8Array(32); },
    hkdf: async () => { await globalThis.derivationStage('hkdf'); return new Uint8Array(64); },
}; }
`;
const hooks = registerHooks({
    resolve(specifier, context, next) {
        if (context.parentURL === protocolURL && specifier === "./tunnel-crypto.js") {
            return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(cryptoStub) };
        }
        return next(specifier, context);
    },
});
let Tunnel, TunnelError, login, request;
try { ({ Tunnel, TunnelError, login, request } = await import(protocolURL)); } finally { hooks.deregister(); }

let socket;
let holdHandshake = false;
let onSend = () => {};
class FakeSocket {
    static OPEN = 1;
    constructor() {
        socket = this;
        this.readyState = 0;
        this.sent = 0;
        queueMicrotask(() => { this.readyState = 1; this.onopen?.({}); });
    }
    send() {
        onSend();
        if (holdHandshake) { this.sent++; return; }
        if (++this.sent === 1) {
            queueMicrotask(() => this.onmessage?.({ data: new Uint8Array([3, ...new Uint8Array(32)]).buffer }));
        }
    }
    end(event) { this.readyState = 3; this.onclose?.(event); }
    close() { this.end({ code: 1000, reason: "" }); }
}
globalThis.WebSocket = FakeSocket;
beforeEach(() => {
    socket = null;
    holdHandshake = false;
    onSend = () => {};
    globalThis.derivationStage = async () => {};
});
const session = { id: "session", secret: btoa("secret") };

for (const stage of ["scalarMult", "sha256", "hkdf"]) {
    for (const event of [{ code: 1006, reason: "" }, { code: 4001, reason: "Log in first." }]) {
        test(`close during ${stage} settles opening and retains close code ${event.code}`, { timeout: 1000 }, async () => {
            globalThis.derivationStage = async (current) => {
                if (current === stage) { socket.end(event); }
            };
            await assert.rejects(Tunnel.open({ type: "list" }, session, "ws://tabtop.test/tunnel"), (err) => {
                assert.ok(err instanceof TunnelError);
                assert.equal(err.login, event.code === 4001);
                assert.equal(err.lost, event.code === 1006);
                return true;
            });
            assert.equal(socket.sent, 1, "no request sent on a closed socket");
        });
    }
}

test("a close after handler transfer still settles a waiting reader once", { timeout: 1000 }, async () => {
    const t = new Tunnel();
    let closes = 0;
    t.onclose = () => closes++;
    await t._connect("ws://tabtop.test/tunnel", session);
    const waiting = t.next();
    socket.end({ code: 1006, reason: "" });
    socket.end({ code: 1006, reason: "" });
    assert.equal(await waiting, null);
    assert.equal(t.closed, true);
    assert.equal(closes, 1);
});

test("a cancelled login closes its pending exchange", { timeout: 1000 }, async () => {
    const abort = new AbortController();
    holdHandshake = true;
    onSend = () => abort.abort();
    await assert.rejects(login("credential", "ws://tabtop.test/tunnel", { signal: abort.signal }));
    assert.equal(socket.readyState, 3);
});

test("cancelling during login key generation never opens a socket", async () => {
    const abort = new AbortController();
    globalThis.derivationStage = async () => abort.abort();
    await assert.rejects(login("credential", "ws://tabtop.test/tunnel", { signal: abort.signal }), { name: "AbortError" });
    assert.equal(socket, null);
});

test("one-off requests can use a captured session after storage is cleared", async (t) => {
    let closed = 0;
    t.mock.method(Tunnel, "open", async (req, captured) => {
        assert.deepEqual(req, { type: "logout" });
        assert.equal(captured, session);
        return { reply: { ok: true }, close: () => closed++ };
    });
    assert.deepEqual(await request({ type: "logout" }, session), { ok: true });
    assert.equal(closed, 1);
});
