import test from "node:test";
import assert from "node:assert/strict";
import { OfflineConnection } from "../scripts/bootstrap/offline-connection.mjs";

function nextEvent(connection, name) {
    return new Promise((resolve) => { connection[name] = resolve; });
}

test("an oversized streaming poll response is canceled without retrying", { timeout: 5000 }, async (t) => {
    let polls = 0, chunks = 0, canceled = false;
    const chunk = new Uint8Array(128 * 1024).fill(32);
    const connection = new OfflineConnection("wss://example.com/session", {
        preferPolling: true,
        fetch: async (address, { method }) => {
            if (method === "DELETE") return new Response(null, { status: 204 });
            if (new URL(address).pathname === "/session/poll") {
                return Response.json({ token: "token", tunnelId: "t", connectionId: "c", rotateAfterMs: 45000, fragments: true }, { status: 201 });
            }
            polls++;
            return new Response(new ReadableStream({
                pull(controller) {
                    if (++chunks > 5) controller.close();
                    else controller.enqueue(chunk);
                },
                cancel() { canceled = true; },
            }));
        },
    });
    t.after(() => connection.close());
    assert.equal((await nextEvent(connection, "onclose")).code, 1006);
    assert.equal(polls, 1);
    assert.ok(canceled);
});

test("unfinished polling replies have a fragment count limit", { timeout: 5000 }, async (t) => {
    let polls = 0;
    const messages = Array(256).fill("eA==");
    const more = Array(256).fill(true);
    const connection = new OfflineConnection("wss://example.com/session", {
        preferPolling: true,
        fetch: async (address, { method }) => {
            if (method === "DELETE") return new Response(null, { status: 204 });
            const url = new URL(address);
            if (url.pathname === "/session/poll") {
                return Response.json({ token: "token", tunnelId: "t", connectionId: "c", rotateAfterMs: 45000, fragments: true }, { status: 201 });
            }
            const first = polls * messages.length + 1;
            assert.equal(url.searchParams.get("after"), String(first - 1));
            if (++polls > 4) return Response.json({ close: { code: 1000 } });
            return Response.json({ first, messages, more });
        },
    });
    t.after(() => connection.close());
    connection.onmessage = () => assert.fail("an incomplete message was delivered");
    assert.equal((await nextEvent(connection, "onclose")).code, 1006);
    assert.equal(polls, 4);
});

test("older polling gateways can still deliver a large unfragmented reply", { timeout: 5000 }, async (t) => {
    const raw = Buffer.alloc(384 * 1024, 5);
    const connection = new OfflineConnection("wss://example.com/session", {
        preferPolling: true,
        fetch: async (address, { method, signal }) => {
            if (method === "DELETE") return new Response(null, { status: 204 });
            const url = new URL(address);
            if (url.pathname === "/session/poll") {
                return Response.json({ token: "token", tunnelId: "t", connectionId: "c", rotateAfterMs: 45000 }, { status: 201 });
            }
            if (url.searchParams.get("after") === "0") {
                return Response.json({ first: 1, messages: [raw.toString("base64")] });
            }
            return new Promise((resolve) => {
                signal.addEventListener("abort", () => resolve(new Response(null, { status: 204 })), { once: true });
            });
        },
    });
    t.after(() => connection.close());
    const event = await Promise.race([nextEvent(connection, "onmessage"), nextEvent(connection, "onclose")]);
    assert.deepEqual(Buffer.from(event.data), raw);
});

test("the offline connection uses a healthy WebSocket without making HTTP requests", async (t) => {
    const native = WebSocket;
    t.after(() => { globalThis.WebSocket = native; });
    const sent = [];
    let socket;
    globalThis.WebSocket = class {
        constructor(url) {
            this.url = url;
            socket = this;
            queueMicrotask(() => this.onopen?.(new Event("open")));
        }
        send(data) { sent.push([...data]); }
        close() { queueMicrotask(() => this.onclose?.({ code: 1000, reason: "", wasClean: true })); }
    };
    const connection = new OfflineConnection("wss://example.com/desk/session", {
        fetch: () => assert.fail("a healthy WebSocket should carry the tunnel"),
    });
    await nextEvent(connection, "onopen");
    assert.equal(socket.url, "wss://example.com/desk/session");
    assert.equal(connection.readyState, 1);
    connection.send(new Uint8Array([1, 2]));
    assert.deepEqual(sent, [[1, 2]]);
    const message = nextEvent(connection, "onmessage");
    socket.onmessage({ data: new Uint8Array([3]).buffer });
    assert.deepEqual([...new Uint8Array((await message).data)], [3]);
    const closed = nextEvent(connection, "onclose");
    connection.close();
    assert.equal((await closed).code, 1000);
});

test("a lost receive can recover after the server finishes its previous poll", { timeout: 5000 }, async (t) => {
    let reads = 0;
    const connection = new OfflineConnection("wss://example.com/session", {
        preferPolling: true,
        fetch: async (address, { method, signal }) => {
            if (method === "DELETE") return new Response(null, { status: 204 });
            if (new URL(address).pathname === "/session/poll") {
                return Response.json({ token: "token", tunnelId: "t", connectionId: "c", rotateAfterMs: 45000 }, { status: 201 });
            }
            switch (++reads) {
                case 1: throw new TypeError("receive response lost");
                case 2:
                case 3: return new Response(null, { status: 429 });
                case 4: return Response.json({ first: 1, messages: ["eA=="] });
                default:
                    return new Promise((resolve) => {
                        signal.addEventListener("abort", () => resolve(new Response(null, { status: 204 })), { once: true });
                    });
            }
        },
    });
    t.after(() => connection.close());
    const event = await Promise.race([nextEvent(connection, "onmessage"), nextEvent(connection, "onclose")]);
    assert.deepEqual([...new Uint8Array(event.data)], [120]);
    assert.equal(connection.readyState, 1);
});

test("a lost send can be retried while the original request is busy", { timeout: 5000 }, async (t) => {
    let writes = 0;
    const accepted = Promise.withResolvers();
    const connection = new OfflineConnection("wss://example.com/session", {
        preferPolling: true,
        fetch: async (address, { method, body, signal }) => {
            const url = new URL(address);
            if (method === "DELETE") return new Response(null, { status: 204 });
            if (url.pathname === "/session/poll") {
                return Response.json({ token: "token", tunnelId: "t", connectionId: "c", rotateAfterMs: 45000 }, { status: 201 });
            }
            if (method === "GET") {
                return new Promise((resolve) => {
                    signal.addEventListener("abort", () => resolve(new Response(null, { status: 204 })), { once: true });
                });
            }
            assert.equal(url.searchParams.get("seq"), "1");
            assert.deepEqual([...body], [0, 0, 0, 1, 9]);
            if (++writes === 1) throw new TypeError("send response lost");
            if (writes < 4) return new Response(null, { status: 429 });
            accepted.resolve(true);
            return Response.json({ accepted: 1 });
        },
    });
    t.after(() => connection.close());
    const closed = nextEvent(connection, "onclose");
    await nextEvent(connection, "onopen");
    connection.send(new Uint8Array([9]));
    assert.equal(await Promise.race([accepted.promise, closed]), true);
    assert.equal(connection.readyState, 1);
});

test("a committed rotation is recovered after the standby poll expired", { timeout: 5000 }, async (t) => {
    let promoted = false, confirmations = 0, switches = 0, delivered = false;
    const connection = new OfflineConnection("wss://example.com/session", {
        preferPolling: true,
        fetch: async (address, { method, signal }) => {
            const url = new URL(address);
            const path = url.pathname;
            if (method === "DELETE") return new Response(null, { status: 204 });
            if (path === "/session/poll") {
                return Response.json({ token: "token", tunnelId: "t", connectionId: "old", rotateAfterMs: 10 }, { status: 201 });
            }
            if (path.endsWith("/connections")) return Response.json({ connectionId: "next" });
            if (url.searchParams.has("wait")) {
                confirmations++;
                return promoted ? Response.json({ active: true }) : new Response(null, { status: 204 });
            }
            if (path.endsWith("/switch")) {
                assert.ok(confirmations, "the standby poll ran before the switch");
                promoted = true;
                switches++;
                throw new TypeError("switch response lost after promotion");
            }
            if (path.endsWith("/next") && !delivered) {
                delivered = true;
                return Response.json({ first: 1, messages: ["cg=="] });
            }
            return new Promise((resolve) => {
                signal.addEventListener("abort", () => resolve(new Response(null, { status: 204 })), { once: true });
            });
        },
    });
    t.after(() => connection.close());
    const event = await Promise.race([nextEvent(connection, "onmessage"), nextEvent(connection, "onclose")]);
    assert.deepEqual([...new Uint8Array(event.data)], [114]);
    assert.equal(switches, 3);
    assert.equal(confirmations, 2);
    assert.equal(connection.readyState, 1);
});

test("offline fallback retries lost responses and rotates while sending and receiving", { timeout: 5000 }, async (t) => {
    const native = WebSocket;
    t.after(() => { globalThis.WebSocket = native; });
    let upgrades = 0;
    globalThis.WebSocket = class {
        constructor() {
            upgrades++;
            queueMicrotask(() => this.onerror?.(new Event("error")));
        }
        close() {}
    };

    const root = "/desk/session/poll";
    const updates = new EventTarget();
    const changed = () => updates.dispatchEvent(new Event("change"));
    const wait = (signal) => new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(signal.reason);
            return;
        }
        const onChange = () => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        };
        const onAbort = () => {
            updates.removeEventListener("change", onChange);
            reject(signal.reason);
        };
        updates.addEventListener("change", onChange, { once: true });
        signal.addEventListener("abort", onAbort, { once: true });
    });
    const accepted = [];
    const released = [];
    const parked = new Set();
    let active = "c1", standby = "", retired = "";
    let created = 0, losses = 0, switches = 0, creates = 0;
    let receiveLost = false, sendLost = false;
    const fetch = async (address, { method, signal, headers, body }) => {
        const url = new URL(address);
        assert.equal(url.origin, "https://example.com");
        const path = url.pathname;
        if (path === root) {
            assert.equal(method, "POST");
            assert.match(JSON.parse(body).requestId, /^[0-9a-f-]{36}$/);
            creates++;
            return Response.json({ tunnelId: "t", token: "token", connectionId: active, rotateAfterMs: 30 }, { status: 201 });
        }
        assert.equal(headers.Authorization, "Bearer token");
        const base = root + "/t/connections";
        assert.ok(path.startsWith(base));
        if (path === base) {
            assert.equal(method, "POST");
            assert.equal(JSON.parse(body).connectionId, active);
            standby ||= "c" + (++created + 1);
            return Response.json({ connectionId: standby }, { status: 201 });
        }
        const [id, action] = path.slice(base.length + 1).split("/");
        if (method === "DELETE") {
            released.push(id);
            changed();
            return new Response(null, { status: 204 });
        }
        if (action === "send") {
            assert.equal(id, active, "send was fenced by the active ID");
            const seq = Number(url.searchParams.get("seq"));
            let n = seq;
            const view = new DataView(body.buffer);
            for (let at = 0; at < body.length; n++) {
                const length = view.getUint32(at);
                const value = [...body.slice(at + 4, at + 4 + length)];
                if (n > accepted.length) {
                    assert.equal(n, accepted.length + 1);
                    accepted.push({ id, value });
                } else {
                    assert.deepEqual(value, accepted[n - 1].value, "retry changed the sent message");
                }
                at += 4 + length;
            }
            changed();
            if (!sendLost) {
                sendLost = true;
                throw new TypeError("simulated lost send acknowledgement");
            }
            return Response.json({ accepted: accepted.length });
        }
        if (action === "switch") {
            const next = JSON.parse(body).connectionId;
            if (id === retired && active === next) {
                losses++;
                return Response.json({ connectionId: active });
            }
            assert.equal(id, active);
            assert.equal(next, standby);
            assert.ok(parked.has(next), "new receive starts before the switch");
            [retired, active, standby] = [active, standby, ""];
            changed();
            if (++switches === 1) throw new TypeError("simulated lost switch response");
            return Response.json({ connectionId: active });
        }
        if (url.searchParams.get("wait") === "active") {
            parked.add(id);
            while (id !== active) await wait(signal);
            return Response.json({ active: true });
        }
        const after = Number(url.searchParams.get("after"));
        while (id === active && accepted.length <= after) await wait(signal);
        if (id !== active) return Response.json({ switched: active });
        if (!receiveLost) {
            receiveLost = true;
            throw new TypeError("simulated lost receive response");
        }
        return Response.json({
            first: after + 1,
            messages: accepted.slice(after).map(({ value }) => Buffer.from(value).toString("base64")),
        });
    };

    const connection = new OfflineConnection("wss://example.com/desk/session", { fetch });
    t.after(() => connection.close());
    await nextEvent(connection, "onopen");
    const received = [];
    connection.onmessage = ({ data }) => {
        received.push([...new Uint8Array(data)]);
        changed();
    };
    const signal = AbortSignal.timeout(3000);
    connection.send(new Uint8Array([1]));
    connection.send(new Uint8Array([2]));
    while (!released.includes("c1") || received.length < 2) await wait(signal);
    connection.send(new Uint8Array([3, 4]));
    while (!released.includes("c2") || received.length < 3) await wait(signal);
    assert.equal(upgrades, 1);
    assert.equal(creates, 1);
    assert.equal(losses, 1);
    assert.deepEqual(accepted.map(({ id }) => id), ["c1", "c1", "c2"]);
    assert.deepEqual(received, [[1], [2], [3, 4]]);
    assert.equal(connection.readyState, 1);
    const closed = nextEvent(connection, "onclose");
    connection.close();
    assert.equal((await closed).code, 1000);
});
