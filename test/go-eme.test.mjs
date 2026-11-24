import assert from "node:assert/strict";
import { test } from "node:test";
import { encryptedMedia } from "../tabtopd/go-eme.js";

test("EME uses a temporary viewer session and binds its keys to the element used for playback", async (t) => {
    const session = new EventTarget();
    let finish;
    session.closed = new Promise(resolve => { finish = resolve; });
    session.sessionId = "native-session";
    session.expiration = NaN;
    session.keyStatuses = new Map();
    const license = Uint8Array.of(3, 4, 5);
    session.generateRequest = async (type, bytes) => {
        assert.equal(type, "keyids");
        assert.deepEqual(bytes, Uint8Array.of(1, 2));
        session.dispatchEvent(Object.assign(new Event("message"), { messageType: "license-request", message: bytes.buffer }));
    };
    session.update = async bytes => {
        assert.deepEqual(bytes, license);
        session.keyStatuses.set(Uint8Array.of(42).buffer, "usable");
        session.dispatchEvent(new Event("keystatuseschange"));
    };
    session.close = async () => finish("closed-by-application");
    const keys = { createSession(type) { assert.equal(type, "temporary"); return session; } };
    const video = new EventTarget();
    video.setMediaKeys = async value => { video.mediaKeys = value; };
    // Node supplies EventTarget, while the key system and media element belong
    // to the viewer. Record the exact configuration passed across that boundary.
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => video } });
    t.after(() => {
        if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
        else delete globalThis.document;
        delete navigator.requestMediaKeySystemAccess;
        delete navigator.mediaCapabilities;
    });
    navigator.requestMediaKeySystemAccess = async (system, configs) => {
        assert.equal(system, "com.example.test");
        const [config] = configs;
        assert.deepEqual(config, { sessionTypes: ["temporary"], persistentState: "not-allowed", distinctiveIdentifier: "not-allowed" });
        return { getConfiguration: () => config, createMediaKeys: async () => keys };
    };
    let resolve, request = 0;
    const events = [];
    const relay = encryptedMedia((message, node) => {
        if (message.request) resolve(message);
        else events.push({ message, node });
    }, () => true);
    t.after(() => relay.stop());
    const call = (op, fields) => new Promise(r => {
        resolve = r;
        relay.receive([{ op, request: ++request, ...fields }]);
    });

    const system = "com.example.test";
    assert.equal((await call("access", { system, configs: [{ persistentState: "required" }] })).name, "NotSupportedError");
    const access = (await call("access", { system, configs: [{}] })).value.handle;
    const config = { type: "media-source", video: { contentType: 'video/mp4; codecs="avc1.42E01E"', width: 640, height: 360, bitrate: 350000, framerate: 30 },
        keySystemConfiguration: { keySystem: system, initDataType: "cenc" } };
    let decodingKeys = 0;
    navigator.mediaCapabilities = { async decodingInfo(actual) {
        assert.deepEqual(actual, { ...config, keySystemConfiguration: { ...config.keySystemConfiguration,
            persistentState: "not-allowed", distinctiveIdentifier: "not-allowed", sessionTypes: ["temporary"] } });
        return { supported: true, smooth: false, powerEfficient: true, keySystemAccess: { keySystem: system,
            getConfiguration: () => ({ initDataTypes: ["cenc"] }), createMediaKeys: async () => { decodingKeys++; return keys; } } };
    } };
    const info = (await call("decoding", { config })).value;
    assert.deepEqual(info, { supported: true, smooth: false, powerEfficient: true,
        access: { system, handle: request, config: { initDataTypes: ["cenc"] } } });
    assert.equal((await call("decoding", { config: { ...config, keySystemConfiguration: { ...config.keySystemConfiguration, persistentState: "required" } } })).value.supported, false);
    assert.ok((await call("keys", { access })).value);
    const handle = (await call("keys", { access: info.access.handle })).value;
    assert.equal(decodingKeys, 1);
    assert.equal((await call("attach", { node: 17, keys: handle, kind: "video" })).error, undefined);
    assert.equal(video.mediaKeys, keys);
    assert.equal(relay.player(17, "video"), video);
    relay.opened(17, video);
    video.dispatchEvent(Object.assign(new Event("encrypted"), { initDataType: "cenc", initData: Uint8Array.of(1).buffer }));
    assert.deepEqual(events.shift(), { message: { event: "encrypted", type: "cenc", data: "AQ==" }, node: 17 });
    assert.equal((await call("session", { keys: handle, session: 11 })).error, undefined);
    assert.equal((await call("generate", { session: 11, type: "keyids", data: "AQI=" })).value, "native-session");
    assert.equal(events.shift().message.data, "AQI=");
    await call("update", { session: 11, data: "AwQF" });
    assert.deepEqual(events.shift().message.statuses, [["Kg==", "usable"]]);
    await call("close", { session: 11 });
    assert.equal(events.shift().message.reason, "closed-by-application");
    assert.equal((await call("update", { session: 11, data: "" })).name, "InvalidStateError");
});

test("EME: a page probing many formats can still get keys (old accesses and keys make room)", async (t) => {
    const video = new EventTarget();
    video.setMediaKeys = async (value) => { video.mediaKeys = value; };
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => video } });
    t.after(() => {
        if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
        else delete globalThis.document;
        delete navigator.requestMediaKeySystemAccess;
        delete navigator.mediaCapabilities;
    });
    const system = "com.example.test";
    const access = () => ({ keySystem: system, getConfiguration: () => ({}), createMediaKeys: async () => ({ createSession: () => Object.assign(new EventTarget(), { closed: new Promise(() => {}), close: async () => {} }) }) });
    navigator.requestMediaKeySystemAccess = async () => access();
    navigator.mediaCapabilities = { async decodingInfo() { return { supported: true, smooth: true, powerEfficient: true, keySystemAccess: access() }; } };
    let resolve, request = 0;
    const relay = encryptedMedia((message) => { if (message.request) resolve(message); }, () => true);
    t.after(() => relay.stop());
    const call = (op, fields) => new Promise((r) => { resolve = r; relay.receive([{ op, request: ++request, ...fields }]); });
    const config = { type: "media-source", video: { contentType: 'video/mp4; codecs="avc1.42E01E"', width: 640, height: 360, bitrate: 1, framerate: 30 },
        keySystemConfiguration: { keySystem: system, initDataType: "cenc" } };
    // Shaka probing its variants, episode after episode: 40 probes, and keys made for some.
    let lastKeys = 0;
    for (let i = 0; i < 40; i++) {
        const probe = await call("decoding", { config });
        assert.equal(probe.error, undefined, `probe ${i}: ${probe.error}`);
        if (i % 5 === 0) {
            const made = await call("keys", { access: probe.value.access.handle });
            assert.equal(made.error, undefined, `keys ${i}: ${made.error}`);
            lastKeys = made.value;
        }
    }
    // Keys in use (attached to a player) are kept.
    assert.equal((await call("attach", { node: 5, keys: lastKeys, kind: "video" })).error, undefined);
    for (let i = 0; i < 40; i++) {
        const made = await call("keys", { access: (await call("access", { system, configs: [{}] })).value.handle });
        assert.equal(made.error, undefined);
    }
    assert.equal((await call("session", { keys: lastKeys, session: 1 })).error, undefined, "keys attached to a player were let go");
});

test("EME: a page making a player per item (never detaching keys) can still attach them; open players keep theirs", async (t) => {
    const made = [];
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => {
        const el = new EventTarget();
        el.setMediaKeys = async (value) => { el.mediaKeys = value; };
        made.push(el);
        return el;
    } } });
    t.after(() => {
        if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
        else delete globalThis.document;
        delete navigator.requestMediaKeySystemAccess;
    });
    const system = "com.example.test";
    navigator.requestMediaKeySystemAccess = async () => ({ keySystem: system, getConfiguration: () => ({}), createMediaKeys: async () => ({}) });
    let resolve, request = 0;
    const relay = encryptedMedia((message) => { if (message.request) resolve(message); }, () => true);
    t.after(() => relay.stop());
    const call = (op, fields) => new Promise((r) => { resolve = r; relay.receive([{ op, request: ++request, ...fields }]); });
    const access = (await call("access", { system, configs: [{}] })).value.handle;
    const keys = (await call("keys", { access })).value;
    // One player stays open throughout.
    const kept = relay.player(1, "video");
    relay.opened(1, kept);
    assert.equal((await call("attach", { node: 1, keys, kind: "video" })).error, undefined);
    // A feed: each item's own <video>, keys set, played, scrolled past.
    for (let node = 2; node <= 60; node++) {
        const el = relay.player(node, "video");
        relay.opened(node, el);
        const r = await call("attach", { node, keys, kind: "video" });
        assert.equal(r.error, undefined, `player ${node}: ${r.error}`);
        relay.closed(node, el);
    }
    assert.equal(relay.player(1, "video"), kept, "the open player's element (with its keys) let go");
    assert.equal(kept.mediaKeys !== undefined, true);
});

// A Clear Key stream's keys are in its page's license, in the open: they're
// given (onKeys) for the element they're attached to, as the viewer's CDM
// says them usable, so the stream's capture can save it decrypted
// (mse-capture.js). A key the CDM doesn't say usable isn't given; another
// key system's element is told nothing at all (its CDM keeps its keys, and
// nothing of its stream is staged).
test("EME: a Clear Key session's keys are given for its element as they become usable; another key system's never are", { timeout: 20000 }, async (t) => {
    const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
    const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    const bytes = (seed) => Uint8Array.from({ length: 16 }, (_, i) => seed + i);
    const license = (...pairs) => btoa(JSON.stringify({ keys: pairs.map(([kid, key]) => ({ kty: "oct", kid: b64url(kid), k: b64url(key) })), type: "temporary" }));

    // A player (its element), a session whose update takes a license's keys
    // and says each's status, as a CDM does; what onKeys is told.
    const player = async (system, statusesOf) => {
        const video = new EventTarget();
        video.setMediaKeys = async (value) => { video.mediaKeys = value; };
        const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
        Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => video } });
        const originalAccess = navigator.requestMediaKeySystemAccess;
        let statuses = new Map();
        const session = new EventTarget();
        session.closed = new Promise(() => {});
        session.sessionId = "native-session";
        session.expiration = NaN;
        Object.defineProperty(session, "keyStatuses", { get: () => statuses });
        session.close = async () => {};
        session.update = async (data) => {
            statuses = statusesOf(JSON.parse(new TextDecoder().decode(data)));
            session.dispatchEvent(new Event("keystatuseschange"));
        };
        navigator.requestMediaKeySystemAccess = async (asked) => {
            assert.equal(asked, system);
            return { keySystem: system, getConfiguration: () => ({}), createMediaKeys: async () => ({ createSession: (type) => { assert.equal(type, "temporary"); return session; } }) };
        };
        const told = [];
        let resolve, request = 0;
        const relay = encryptedMedia((message) => { if (message.request) resolve(message); }, () => true, (node, keys) => told.push([node, keys]));
        t.after(() => {
            relay.stop();
            if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
            else delete globalThis.document;
            if (originalAccess) Object.defineProperty(navigator, "requestMediaKeySystemAccess", originalAccess);
            else delete navigator.requestMediaKeySystemAccess;
        });
        const call = (op, fields) => new Promise((r) => {
            resolve = r;
            relay.receive([{ op, request: ++request, ...fields }]);
        });
        const access = (await call("access", { system, configs: [{}] })).value.handle;
        const keys = (await call("keys", { access })).value;
        assert.equal((await call("attach", { node: 7, keys, kind: "video" })).error, undefined);
        return {
            told,
            async license(data) {
                const session = ++request;  // (a session's handle, as a page numbers them)
                assert.equal((await call("session", { session, keys })).error, undefined);
                assert.equal((await call("update", { session, data })).error, undefined);
                await new Promise((r) => setImmediate(r));
            },
        };
    };

    // Clear Key: its element's told to expect the keys as they're attached,
    // then given each as its CDM says it usable.
    const [kidA, keyA, kidB, keyB] = [bytes(0xa0), bytes(0x30), bytes(0x50), bytes(0x60)];
    const clear = await player("org.w3.clearkey", (l) => new Map([
        [l.keys[0].kid, "usable"], [l.keys[1]?.kid, "status-pending"],
    ].filter(([kid]) => kid !== undefined).map(([kid, status]) => [Uint8Array.from(Buffer.from(kid, "base64url")).buffer, status])));
    assert.deepEqual(clear.told, [[7, {}]], "its keys are coming");
    await clear.license(license([kidA, keyA]));
    assert.deepEqual(clear.told.at(-1), [7, { [hex(kidA)]: hex(keyA) }]);
    assert.ok(clear.told.every(([node]) => node === 7));
    // A license with a key its CDM doesn't say usable: that one isn't given.
    await clear.license(license([kidA, keyA], [kidB, keyB]));
    assert.deepEqual(clear.told.at(-1), [7, { [hex(kidA)]: hex(keyA) }]);

    // Another key system (a DRM's): the same license's shape, nothing told.
    const other = await player("com.example.test", () => new Map());
    await other.license(license([kidA, keyA]));
    assert.deepEqual(other.told, [], "its element isn't told to expect keys, nor given any");
});
