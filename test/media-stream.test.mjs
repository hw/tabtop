import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { MessageChannel } from "node:worker_threads";
import { FILE_TYPES } from "../tabtopd/file-types.js";
import { createMediaSource } from "../tabtopd/media-source.js";
import { createWorkerRegistration } from "../tabtopd/stream-worker.js";

const source = readFileSync(new URL("../tabtopd/download-sw.js", import.meta.url), "utf8");
// The worker remains a classic script for existing registrations. Execute its
// exact source and exercise its public fetch event, without exposing internals.
function worker(client) {
    const listeners = {};
    const env = { self: { addEventListener(type, fn) { listeners[type] = fn; },
        location: { href: "https://test/tabtop/download-sw.js" }, clients: { get: async () => client } },
        Request, Response, ReadableStream, MessageChannel, ArrayBuffer, Uint8Array, URL, crypto, setTimeout, clearTimeout };
    env.importScripts = (file) => {
        assert.equal(file, "./file-types-worker.js");
        runInNewContext(readFileSync(new URL("../tabtopd/file-types-worker.js", import.meta.url), "utf8"), env);
    };
    runInNewContext(source, env);
    return { mediaResponse(event, _id, legacy = false) {
        let response;
        const request = new Request(`https://test/tabtop/stream/${legacy ? "video" : "media"}/00000000-0000-0000-0000-000000000001`,
            { method: event.request.method, headers: event.request.headers });
        listeners.fetch({ ...event, request, respondWith(value) { response = value; } });
        assert.ok(response, "worker must handle its media URL");
        return response;
    } };
}

function metadataClient(size, type = "video/mp4") {
    return { postMessage(_, [port]) {
        port.on("message", (m) => { if (m.cancel) port.close(); });
        port.postMessage({ size, type });
    } };
}

test("media fetches handle open, closed, suffix and invalid ranges", async () => {
    const cases = [
        [null, 100, [0, 100, 200]], ["bytes=0-9", 100, [0, 10, 206]],
        ["bytes=20-", 100, [20, 100, 206]], ["bytes=-10", 100, [90, 100, 206]],
        ["bytes=-200", 100, [0, 100, 206]], ["bytes=90-999", 100, [90, 100, 206]],
        [null, 0, [0, 0, 200]],
    ];
    for (const [header, size, [begin, end, status]] of cases) {
        const headers = header === null ? {} : { Range: header };
        const response = await worker(metadataClient(size)).mediaResponse({ clientId: "owner", request: new Request("https://test/", { headers }) });
        assert.equal(response.status, status);
        assert.equal(response.headers.get("Content-Length"), String(end - begin));
        if (status === 206) assert.equal(response.headers.get("Content-Range"), `bytes ${begin}-${end - 1}/${size}`);
        await response.body?.cancel();
    }
    for (const [header, size] of ["bytes=100-", "bytes=20-10", "bytes=-0", "bytes=-", "bytes=0-1,3-4", "items=0-10", "bytes=9007199254740992-", "bytes=1-9007199254740992"].map((h) => [h, 100]).concat([["bytes=0-", 0]])) {
        const response = await worker(metadataClient(size)).mediaResponse({ clientId: "owner", request: new Request("https://test/", { headers: { Range: header } }) });
        assert.equal(response.status, 416, header);
    }
});

test("video responses pull bounded, exact ranges and return HTTP range metadata", async () => {
    const pulls = [];
    let cancelled;
    const ended = new Promise((resolve) => { cancelled = resolve; });
    const size = 4 << 20;
    const client = { postMessage(message, [port]) {
        assert.equal(message.type, "media-range");
        port.on("message", (m) => {
            if (m.cancel) { port.close(); cancelled(); return; }
            pulls.push([m.begin, m.end]);
            const bytes = new Uint8Array(m.end - m.begin).fill(42).buffer;
            port.postMessage({ bytes }, [bytes]);
        });
        port.postMessage({ size, type: "video/mp4" });
    } };
    const { mediaResponse } = worker(client);
    const response = await mediaResponse({ clientId: "owner", request: new Request("https://test/stream/video/id", { headers: { Range: "bytes=1024-2098175" } }) }, "id");
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("Content-Range"), `bytes 1024-2098175/${size}`);
    assert.equal(response.headers.get("Content-Length"), String(2 << 20));
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(pulls.length, 0, "no range is fetched until the browser reads");
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.equal(bytes.length, 2 << 20);
    assert.ok(bytes.every((b) => b === 42));
    assert.deepEqual(pulls, [[1024, 1049600], [1049600, 2098176]]);
    await ended;
});

test("cancelling a video body closes its page channel without reading ahead", async () => {
    let cancelled;
    const ended = new Promise((resolve) => { cancelled = resolve; });
    const client = { postMessage(_, [port]) {
        port.on("message", (m) => {
            if (m.cancel) { port.close(); cancelled(); }
            else assert.fail("cancelled body must not fetch video bytes");
        });
        port.postMessage({ size: 1234, type: "video/webm" });
    } };
    const response = await worker(client).mediaResponse({ clientId: "owner", request: new Request("https://test/video") }, "id");
    await response.body.cancel();
    await ended;
});

test("plain HTTP video fallback works without secure-context crypto or service workers", async () => {
    let requested;
    let closed = 0;
    let revoked = null;
    const env = {
        mediaWorker: async () => null,
        call: async (req) => { requested = req; return { close: () => closed++ }; },
        collect: async () => new Blob(["video"]),
        document: { createElement: (tag) => ({ tagName: tag.toUpperCase(), dataset: {}, addEventListener() {}, removeEventListener() {}, pause() {}, load() {}, removeAttribute(key) { delete this[key]; } }) },
        navigator: {},
        URL: { createObjectURL: () => "blob:buffered", revokeObjectURL: (value) => { revoked = value; } },
    };
    const mediaStream = createMediaSource({ getWorker: env.mediaWorker, call: env.call, collect: env.collect, document: env.document, urlAPI: env.URL });
    const media = await mediaStream("clip.mp4", { size: 5, mtime: "version", type: "video/mp4" });
    assert.equal(media.src, "blob:buffered");
    assert.equal(media.dataset.streamed, "false");
    assert.equal(requested.if_mtime, "version");
    assert.equal(requested.if_size, 5);
    assert.equal(closed, 1);
    media.stop();
    assert.equal(media.src, undefined);
    assert.equal(revoked, "blob:buffered");
    const sound = await mediaStream("sound.mp3", { size: 5, mtime: "version", type: "audio/mpeg" });
    assert.equal(sound.tagName, "AUDIO");
    assert.equal(sound.dataset.streamed, "false");
    sound.stop();
    requested = null;
    await assert.rejects(mediaStream("large.mp4", { size: 200e6 + 1, type: "video/mp4" }), /streaming requires HTTPS/);
    await assert.rejects(mediaStream("large.mp3", { size: 5e9, type: "audio/mpeg" }), /streaming requires HTTPS/);
    assert.equal(requested, null, "large audio and video must not be buffered on plain HTTP");
});


test("Matroska is served with its own MIME type and byte-range headers", async () => {
    let cancelled;
    const ended = new Promise((resolve) => { cancelled = resolve; });
    const client = { postMessage(_, [port]) {
        port.on("message", (m) => {
            if (m.cancel) { port.close(); cancelled(); }
            else {
                const bytes = new Uint8Array(m.end - m.begin).buffer;
                port.postMessage({ bytes }, [bytes]);
            }
        });
        port.postMessage({ size: 1234, type: "video/x-matroska" });
    } };
    const response = await worker(client).mediaResponse({ clientId: "owner", request: new Request("https://test/video", { headers: { Range: "bytes=100-199" } }) }, "id");
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("Content-Type"), "video/x-matroska");
    assert.equal(response.headers.get("Content-Range"), "bytes 100-199/1234");
    assert.equal((await response.arrayBuffer()).byteLength, 100);
    await ended;
});

test("audio formats retain their MIME type and range response headers", async () => {
    for (const type of new Set(Object.values(FILE_TYPES).filter((type) => type.kind === "audio").map((type) => type.mime))) {
        let cancelled;
        const ended = new Promise((resolve) => { cancelled = resolve; });
        const client = { postMessage(message, [port]) {
            assert.equal(message.type, "media-range");
            port.on("message", (m) => {
                if (m.cancel) { port.close(); cancelled(); return; }
                const bytes = new Uint8Array(m.end - m.begin).buffer;
                port.postMessage({ bytes }, [bytes]);
            });
            port.postMessage({ size: 1000, type });
        } };
        const response = await worker(client).mediaResponse({ clientId: "owner", request: new Request("https://test/media", { headers: { Range: "bytes=10-29" } }) }, "id");
        assert.equal(response.status, 206, type);
        assert.equal(response.headers.get("Content-Type"), type);
        assert.equal(response.headers.get("Content-Range"), "bytes 10-29/1000");
        assert.equal((await response.arrayBuffer()).byteLength, 20);
        await ended;
    }
});

test("older video previews keep their message protocol after worker upgrades", async () => {
    let cancelled;
    const ended = new Promise((resolve) => { cancelled = resolve; });
    const client = { postMessage(message, [port]) {
        assert.equal(message.type, "video-range");
        port.on("message", (m) => { if (m.cancel) { port.close(); cancelled(); } });
        port.postMessage({ size: 1000, type: "video/mp4" });
    } };
    const response = await worker(client).mediaResponse({ clientId: "owner", request: new Request("https://test/video", { method: "HEAD" }) }, "id", true);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Length"), "1000");
    await ended;
});

test("worker replacement reclaims eight orphaned channels while preserving the live request limit", async () => {
    let answer;
    let closedTunnels = 0;
    let startedRead;
    const reading = new Promise((resolve) => { startedRead = resolve; });
    const sw = { scriptURL: "https://test/tabtop/download-sw.js" };
    const env = {
        mediaWorker: async () => sw, crypto: { randomUUID: () => "preview-id" }, URL,
        navigator: { serviceWorker: { addEventListener(_, fn) { answer = fn; }, removeEventListener() {} } },
        document: { createElement: () => ({ dataset: {}, addEventListener() {}, removeEventListener() {}, pause() {}, load() {}, removeAttribute() {} }) },
        call: async () => ({ close() { closedTunnels++; } }),
        collect: () => { startedRead(); return new Promise(() => {}); }, // A read pending when the worker dies.
    };
    const media = await createMediaSource({ getWorker: env.mediaWorker, call: env.call, collect: env.collect, document: env.document, serviceWorker: env.navigator.serviceWorker, randomUUID: env.crypto.randomUUID, baseURL: "https://test/tabtop/media-source.js" })("sound.mp3", { size: 1000, mtime: "v", type: "audio/mpeg" });
    const makePort = () => ({ replies: [], start() {}, close() {}, postMessage(m) { this.replies.push(m); } });
    const connect = (instance) => {
        const port = makePort();
        answer({ data: { type: "media-range", id: "preview-id", instance }, source: sw, ports: [port] });
        return port;
    };
    try {
        const old = Array.from({ length: 8 }, () => connect("old-worker"));
        assert.ok(old.every((p) => p.replies[0].size === 1000));
        // All eight healthy channels must remain usable; don't evict on age.
        assert.equal(connect("old-worker").replies[0].error, "media preview is unavailable");
        void old[0].onmessage({ data: { begin: 0, end: 10 } });
        await reading;
        // No cancel arrives for the old ports when a worker is terminated.
        const resumed = connect("replacement-worker");
        assert.equal(resumed.replies[0].size, 1000);
        assert.equal(closedTunnels, 1, "the old worker's in-flight read was cancelled");
        assert.equal(connect("old-worker").replies[0].error, "worker was replaced", "late messages cannot evict replacement requests");
        await old[1].onmessage({ data: { begin: 0, end: 10 } });
        assert.equal(old[1].replies.length, 1, "orphaned ports no longer fetch bytes");
        for (let n = 1; n < 8; n++) assert.equal(connect("replacement-worker").replies[0].size, 1000);
        assert.equal(connect("replacement-worker").replies[0].error, "media preview is unavailable");
    } finally { media.stop(); }
});

test("media registration retries after slow activation instead of caching failure", async () => {
    let now = 0;
    let registrations = 0;
    const sw = {};
    const reg = { active: null, installing: {}, waiting: null };
    const navigator = { serviceWorker: { controller: null, async register() { registrations++; return reg; } } };
    const get = createWorkerRegistration({ scope: "/fs/", requireController: true, serviceWorker: navigator.serviceWorker,
        now: () => now, delay: async (ms) => { now += ms; } });
    const first = await Promise.all([get(), get()]);
    assert.deepEqual(first, [null, null]);
    assert.equal(registrations, 1, "concurrent callers share activation");
    reg.active = sw; reg.installing = null; navigator.serviceWorker.controller = sw;
    assert.equal(await get(), sw, "activation can succeed after the first timeout");
    assert.equal(registrations, 2);
    assert.equal(await get(), sw);
    assert.equal(registrations, 2, "successful registration stays cached");
});

test("media updates never return an old worker while installing, waiting or claiming control", async () => {
    for (const phase of ["installing", "waiting"]) {
        let now = 0;
        let registrations = 0;
        const oldWorker = { version: "old" };
        const replacement = { version: "new" };
        const reg = { active: oldWorker, installing: null, waiting: null, [phase]: replacement };
        const navigator = { serviceWorker: { controller: oldWorker, async register() { registrations++; return reg; } } };
        const get = createWorkerRegistration({ scope: "/fs/", requireController: true, serviceWorker: navigator.serviceWorker,
            now: () => now, delay: async (ms) => { now += ms; } });
        assert.equal(await get(), null, `${phase}: old active worker must not be returned after timeout`);
        assert.equal(registrations, 1);
        reg[phase] = null;
        reg.active = replacement;
        assert.equal(await get(), null, `${phase}: activation must also claim this page`);
        assert.equal(registrations, 2, "timed-out update was not cached");
        navigator.serviceWorker.controller = replacement;
        assert.equal(await get(), replacement);
        assert.equal(registrations, 3);
        assert.equal(await get(), replacement);
        assert.equal(registrations, 3, "only the ready replacement is cached");
    }
});

test("download registration shares retry policy without requiring page control", async () => {
    const active = {};
    let calls = 0;
    const serviceWorker = { controller: null, async register() {
        if (++calls === 1) throw new Error("temporary registration failure");
        return { active, installing: null, waiting: null };
    } };
    const get = createWorkerRegistration({ scope: "/tabtop/stream/", serviceWorker });
    assert.equal(await get(), null);
    assert.equal(await get(), active, "download navigations don't require a controlled owner page");
    assert.equal(calls, 2);
    assert.equal(await get(), active);
    assert.equal(calls, 2);
});
