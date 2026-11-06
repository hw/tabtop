import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const target = new URL("../tabtopd/tunnel.js", import.meta.url).href;
const stubs = {
    "./tunnel-protocol.js": `export class Tunnel { static open(...args) { return globalThis.openTunnel(...args); } }
        export class TunnelError extends Error {}
        export const login=()=>{}, tunnelURL=()=>{}, request=()=>{};`,
    "./session.js": `export const SESSION_KEY='test';
        export const storedSession=()=>({id:'stored'}), session=()=>globalThis.getSession(), forgetSession=()=>globalThis.forgot++;
        export const renewSession=()=>{};`,
    "./tunnel-crypto.js": `export const elligator2=()=>{}, cpaceGenerator=()=>{}, cpaceISK=()=>{}, cryptoBackend=()=>{};`,
};
const hooks = registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL === target && stubs[specifier]) {
        return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(stubs[specifier]) };
    }
    return next(specifier, context);
} });
let TunnelSocket;
try { ({ TunnelSocket } = await import(target)); } finally { hooks.deregister(); }

let opening, session, calls, sessionCalls;
const flush = () => new Promise((resolve) => setImmediate(resolve));
beforeEach(() => {
    opening = Promise.withResolvers();
    session = Promise.withResolvers();
    calls = sessionCalls = globalThis.forgot = 0;
    globalThis.openTunnel = () => { calls++; return opening.promise; };
    globalThis.getSession = () => { sessionCalls++; return session.promise; };
});
function observe(socket) {
    const events = [];
    socket.onopen = () => events.push("open");
    socket.onerror = () => events.push("error");
    socket.onclose = (event) => { events.push("close"); assert.equal(event.login, false); assert.equal(event.lost, false); };
    socket.onmessage = () => events.push("message");
    return events;
}
function tunnel() {
    const read = Promise.withResolvers();
    return { read, closes: 0, reply: {}, next() { return read.promise; }, close() { this.closes++; read.resolve(null); } };
}

test("closing while login is pending emits one asynchronous close and never opens a tunnel", async () => {
    const socket = new TunnelSocket({ type: "tty" }, { title: "Terminal" });
    const events = observe(socket);
    socket.close();
    socket.close();
    assert.deepEqual(events, []);
    await flush();
    assert.deepEqual(events, ["close"]);
    session.resolve({ id: "late-login" });
    await flush();
    assert.equal(calls, 0);
    assert.deepEqual(events, ["close"]);
});

test("a tunnel opening after cancellation is cleaned up without a second event", async () => {
    const socket = new TunnelSocket({ type: "tty" });
    const events = observe(socket);
    socket.close();
    await flush();
    assert.deepEqual(events, ["close"]);
    const t = tunnel();
    opening.resolve(t);
    await flush();
    assert.equal(t.closes, 1);
    assert.deepEqual(events, ["close"]);
});

test("a late authentication failure cannot forget the session or restart login", async () => {
    session.resolve({ id: "old" });
    const socket = new TunnelSocket({ type: "tty" }, { title: "Terminal" });
    const events = observe(socket);
    await flush();
    assert.equal(calls, 1);
    socket.close();
    opening.reject(Object.assign(new Error("session ended"), { login: true }));
    await flush();
    assert.equal(globalThis.forgot, 0);
    assert.equal(sessionCalls, 1);
    assert.deepEqual(events, ["close"]);
});

test("closing an open adapter suppresses queued messages and closes exactly once", async () => {
    const socket = new TunnelSocket({ type: "tty" });
    const events = observe(socket);
    const t = tunnel();
    opening.resolve(t);
    await flush();
    assert.deepEqual(events, ["open"]);
    t.read.resolve({ data: new Uint8Array([1]).buffer });
    socket.close();
    socket.close();
    await flush();
    assert.equal(t.closes, 1);
    assert.deepEqual(events, ["open", "close"]);
});

test("a genuine opening failure still emits error then close", async () => {
    const socket = new TunnelSocket({ type: "tty" });
    const events = [];
    socket.onerror = () => events.push("error");
    socket.onclose = (event) => { events.push("close"); assert.equal(event.lost, true); };
    opening.reject(Object.assign(new Error("offline"), { lost: true }));
    await flush();
    assert.deepEqual(events, ["error", "close"]);
    socket.close();
    await flush();
    assert.deepEqual(events, ["error", "close"]);
});
