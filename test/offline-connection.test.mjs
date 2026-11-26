import test from "node:test";
import assert from "node:assert/strict";
import { OfflineConnection } from "../scripts/bootstrap/offline-connection.mjs";

function nextEvent(connection, name) {
    return new Promise((resolve) => { connection[name] = resolve; });
}

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
