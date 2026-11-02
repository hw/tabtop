import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const target = new URL("../tabtopd/login-ui.js", import.meta.url).href;
const hooks = registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL === target && specifier === "./tunnel-protocol.js") {
        return { shortCircuit: true, url: "data:text/javascript,export const login=(...args)=>globalThis.tryLogin(...args);" };
    }
    if (context.parentURL === target && specifier === "./session-state.js") {
        return { shortCircuit: true, url: "data:text/javascript,export const saveSession=s=>globalThis.savedSessions.push(s);" };
    }
    return next(specifier, context);
} });
let loginForm;
try { ({ loginForm } = await import(target)); } finally { hooks.deregister(); }

let nodes, pending, signal;
beforeEach(() => {
    nodes = [];
    const make = (tag) => {
        const n = { tag, style: {}, listeners: {}, append() {}, focus() {}, remove() { this.removed = true; },
            setAttribute() {}, addEventListener(type, fn) { this.listeners[type] = fn; } };
        nodes.push(n);
        return n;
    };
    globalThis.document = { createElement: make, body: make("body") };
    globalThis.savedSessions = [];
    pending = Promise.withResolvers();
    globalThis.tryLogin = (credential, url, options) => { signal = options.signal; return pending.promise; };
});
const submit = () => {
    nodes.find((n) => n.tag === "input").value = "credential";
    return nodes.find((n) => n.tag === "form").listeners.submit({ preventDefault() {} });
};
const success = { id: "new", secret: "secret", ip: "192.0.2.1", logins: [{ ok: false, ip: "192.0.2.2", time: "2026-01-01" }] };

test("cancelling an in-flight renewal aborts it and ignores a late success", async () => {
    const result = loginForm("Renew", true);
    const submitting = submit();
    nodes.find((n) => n.textContent === "Cancel").listeners.click();
    assert.equal(await result, null);
    assert.equal(signal.aborted, true);
    pending.resolve(success); // Even a non-cooperating transport cannot save it.
    await submitting;
    assert.deepEqual(savedSessions, []);
    assert.equal(nodes.some((n) => n.id === "tabtop_login_summary"), false);
});

test("cancelled renewals ignore a late failure without showing an error", async () => {
    const result = loginForm("Renew", true);
    const submitting = submit();
    nodes.find((n) => n.textContent === "Cancel").listeners.click();
    pending.reject(new Error("connection closed"));
    await submitting;
    assert.equal(await result, null);
    assert.deepEqual(savedSessions, []);
    assert.equal(nodes.some((n) => n.textContent === "connection closed"), false);
});

test("a completed renewal still stores and returns its new session", async () => {
    const result = loginForm("Renew", true);
    const submitting = submit();
    pending.resolve(success);
    await submitting;
    assert.deepEqual(await result, { id: "new", secret: "secret" });
    assert.deepEqual(savedSessions, [{ id: "new", secret: "secret" }]);
});
