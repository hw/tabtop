import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

const source = readFileSync(new URL("../tabtopd/nav.js", import.meta.url), "utf8");
const tunnelStub = `export const storedSession=()=>globalThis.navState.session;
    export const forgetSession=(old)=>{ if (!old || globalThis.navState.session?.id===old.id) globalThis.navState.session=null; };
    export const request=(...args)=>globalThis.navState.request(...args);`;
const hooks = registerHooks({
    resolve(specifier, context, next) {
        if (specifier.startsWith("https://nav.test/")) { return { shortCircuit: true, url: specifier }; }
        if (context.parentURL?.startsWith("https://nav.test/") && specifier === "./tunnel.js") {
            return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(tunnelStub) };
        }
        if (context.parentURL?.startsWith("https://nav.test/") && specifier === "./glyphs.js") {
            return { shortCircuit: true, url: new URL("../tabtopd/glyphs.js", import.meta.url).href };
        }
        return next(specifier, context);
    },
    load(url, context, next) {
        const served = url.includes("/files-only/") ? source.replace("{ desktop: true, terminal: true, files: true }", '{"desktop":false,"terminal":false,"files":true}') : source;
        return url.startsWith("https://nav.test/") ? { shortCircuit: true, format: "module", source: served } : next(url, context);
    },
});
let root, a, b, filesOnly;
try { [root, a, b, filesOnly] = await Promise.all(["/", "/a/", "/teams/b/", "/files-only/"].map((base) => import(`https://nav.test${base}tabtop/nav.js`))); }
finally { hooks.deregister(); }

let reloads, opened, requests, pending, original;
beforeEach(() => {
    reloads = 0;
    opened = [];
    requests = [];
    original = { id: "old", secret: "secret" };
    pending = Promise.withResolvers();
    globalThis.navState = { session: original, request: (...args) => { requests.push(args); return pending.promise; } };
    globalThis.location = { reload: () => reloads++ };
    globalThis.window = { name: "", open: (url, target) => { opened.push({ url, target }); return { focus() {} }; } };
    globalThis.fetch = async () => ({ ok: true });
    globalThis.document = { createElement: (tag) => ({ tag, children: [], setAttribute() {}, addEventListener() {}, append(...items) { this.children.push(...items); } }) };
});

test("logout removes local credentials immediately and revokes the captured session", async () => {
    const result = a.logOut();
    assert.equal(navState.session, null);
    assert.deepEqual(requests, [[{ type: "logout" }, original]]);
    assert.equal(reloads, 0);
    assert.equal(a.logOut(), result, "duplicate clicks share one revocation");
    assert.equal(requests.length, 1);
    pending.resolve({ ok: true });
    await result;
    assert.equal(reloads, 1);
});

test("a stalled server cannot delay local logout beyond three seconds", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const result = a.logOut();
    assert.equal(navState.session, null);
    t.mock.timers.tick(2999);
    await Promise.resolve();
    assert.equal(reloads, 0);
    t.mock.timers.tick(1);
    await result;
    assert.equal(reloads, 1);
    pending.reject(new Error("late network failure"));
    await Promise.resolve();
    assert.equal(reloads, 1);
});

test("failed revocation and an absent session both still reload", async () => {
    const result = a.logOut();
    pending.reject(new Error("offline"));
    await result;
    assert.equal(navState.session, null);
    assert.equal(reloads, 1);
    await a.logOut();
    assert.equal(requests.length, 1, "no request needs a missing session");
    assert.equal(reloads, 2);
});

test("logout everywhere uses the same immediate local logout and bounded wait", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const result = a.logOut({ everywhere: true });
    assert.equal(navState.session, null);
    assert.deepEqual(requests, [[{ type: "logout-all" }, original]]);
    t.mock.timers.tick(3000);
    await result;
    assert.equal(reloads, 1);
});

test("root and nested deployments have distinct tab names and matching targets", () => {
    const names = new Set();
    for (const instance of [root, a, b]) {
        instance.nameTab("terminal");
        const name = window.name;
        names.add(name);
        instance.openPage("terminal");
        assert.equal(opened.at(-1).target, name);
        assert.equal(opened.at(-1).url, instance.pages.find((p) => p.id === "terminal").href);
        const nav = instance.navBar("files");
        const link = nav.children.find((n) => n.href === instance.pages.find((p) => p.id === "desktop").href);
        instance.nameTab("desktop");
        assert.equal(link.target, window.name, "ordinary links use the same deployment scope");
    }
    assert.equal(names.size, 3);
});

test("disabled features are absent from navigation and cannot open tabs", () => {
    assert.deepEqual(filesOnly.pages.map(p => p.id), ["files"]);
    const nav = filesOnly.navBar("files");
    assert.equal(nav.children.length, 2, "only Files and logout remain");
    filesOnly.openPage("desktop");
    filesOnly.openPage("terminal");
    assert.equal(opened.length, 0);
});
