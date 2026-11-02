import { test } from "node:test";
import assert from "node:assert/strict";
import { runTransfer } from "../tabtopd/transfer.js";

const deferred = () => {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
};

test("completed transfers release resources once and report progress", async () => {
    const abort = new AbortController();
    const updates = [];
    let closed = 0;
    const result = await runTransfer({ signal: abort.signal, progress: (n) => updates.push(n), run: async ({ own, progress }) => {
        own(() => closed++);
        progress(10);
        return "saved";
    } });
    assert.deepEqual(result, { state: "succeeded", value: "saved" });
    abort.abort();
    assert.equal(closed, 1);
    assert.deepEqual(updates, [10]);
});

test("cancellation closes a pending transfer and suppresses failure and retry", async () => {
    const abort = new AbortController();
    const pending = deferred();
    let closed = 0;
    const result = runTransfer({ signal: abort.signal, retry: () => assert.fail("retry"), progress: () => assert.fail("progress after abort"), run: async ({ own, progress }) => {
        own(() => closed++);
        await pending.promise;
        progress(1);
        throw new Error("connection lost");
    } });
    abort.abort();
    assert.equal(closed, 1);
    pending.resolve();
    assert.deepEqual(await result, { state: "cancelled" });
    assert.equal(closed, 1);
});

test("a connection acquired after cancellation is immediately closed", async () => {
    const abort = new AbortController();
    const opening = deferred();
    let closed = 0;
    const result = runTransfer({ signal: abort.signal, run: async ({ own }) => {
        await opening.promise;
        own(() => closed++);
        assert.fail("must not start the protocol after cancellation");
    } });
    abort.abort();
    opening.resolve();
    assert.deepEqual(await result, { state: "cancelled" });
    assert.equal(closed, 1);
});

test("failed attempts clean up and offer a fresh retry; pre-cancelled attempts do not start", async () => {
    const abort = new AbortController();
    let attempts = 0;
    let closed = 0;
    const attempt = () => runTransfer({ signal: abort.signal, retry: attempt, run: async ({ own }) => {
        own(() => closed++);
        if (++attempts === 1) { throw new Error("offline"); }
        return "saved";
    } });
    const failed = await attempt();
    assert.equal(failed.state, "failed");
    assert.equal(failed.error.message, "offline");
    assert.equal(closed, 1);
    assert.equal((await failed.retry()).state, "succeeded");
    assert.equal(closed, 2);
    abort.abort();
    assert.equal((await attempt()).state, "cancelled");
    assert.equal(attempts, 2);
});
