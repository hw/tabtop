import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

// Load the real module at different deployment URLs without network access.
// Keeping import.meta.url intact exercises its production namespace rule.
const source = readFileSync(new URL("../tabtopd/session-state.js", import.meta.url), "utf8");
const storedSource = readFileSync(new URL("../tabtopd/stored.js", import.meta.url), "utf8");
const hooks = registerHooks({
    resolve(specifier, context, next) {
        return specifier.startsWith("https://tabtop.test/") ? { shortCircuit: true, url: specifier } : next(specifier, context);
    },
    load(url, context, next) {
        if (!url.startsWith("https://tabtop.test/")) return next(url, context);
        return { shortCircuit: true, format: "module", source: url.endsWith("/stored.js") ? storedSource : source };
    },
});
let root, a, b;
try {
    [root, a, b] = await Promise.all(["/", "/a/", "/teams/b/"].map((base) => import(`https://tabtop.test${base}tabtop/session-state.js`)));
} finally { hooks.deregister(); }

const storage = new Map();
globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
};
beforeEach(() => storage.clear());

const first = { id: "first", secret: "first-secret" };
const second = { id: "second", secret: "second-secret" };

test("root and nested deployments keep independent sessions on one origin", () => {
    assert.equal(root.SESSION_KEY, "tabtop_session:/");
    assert.equal(a.SESSION_KEY, "tabtop_session:/a/");
    assert.equal(b.SESSION_KEY, "tabtop_session:/teams/b/");
    root.saveSession({ id: "root", secret: "root-secret" });
    a.saveSession(first);
    b.saveSession(second);
    assert.equal(root.storedSession().id, "root");
    assert.deepEqual(a.storedSession(), first);
    assert.deepEqual(b.storedSession(), second);
    a.forgetSession();
    assert.equal(a.storedSession(), null);
    assert.deepEqual(b.storedSession(), second);
    assert.equal(root.storedSession().id, "root");
});

test("a stale connection cannot forget a newer login or another deployment", () => {
    a.saveSession(first);
    a.saveSession(second);
    b.saveSession(first);
    a.forgetSession(first);
    assert.deepEqual(a.storedSession(), second);
    a.forgetSession(second);
    assert.equal(a.storedSession(), null);
    assert.deepEqual(b.storedSession(), first);
});

test("ambiguous legacy sessions are not assigned to any deployment", () => {
    localStorage.setItem("tabtop_session", JSON.stringify(first));
    for (const instance of [root, a, b]) { assert.equal(instance.storedSession(), null); }
    assert.equal(localStorage.getItem("tabtop_session"), JSON.stringify(first));
});
