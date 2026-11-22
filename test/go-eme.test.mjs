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
