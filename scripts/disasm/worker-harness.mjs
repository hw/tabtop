// disasm-worker.js run as a browser runs a worker, for the check-*.mjs
// scripts the image build runs: what they have in common.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// runWorker runs workerFile in a context of its own: its self (with what
// own adds to it: a loader the worker calls, say), and the globals
// globals(self) gives (its fetch and importScripts, each as the check
// allows). post sends the worker a message, numbered, and gives its reply
// to that message; scope is the context it ran in, with what it defined at
// its top level.
export function runWorker(workerFile, globals, own = {}) {
    let reply, next = 0;
    const self = { ...own, postMessage: (message) => { reply = JSON.parse(JSON.stringify(message)); } };
    const scope = { self, Uint8Array, BigInt, WebAssembly, TextEncoder, TextDecoder, ...globals(self) };
    runInNewContext(readFileSync(workerFile, "utf8"), scope);
    const post = async (data) => {
        const id = ++next;
        await self.onmessage({ data: { id, ...data } });
        assert.equal(reply.id, id);
        return reply;
    };
    return { self, post, scope };
}

// line is a line of disassembly as the worker gives it.
export const line = (offset, length, text, targets = []) => ({ offset, length, text, targets });

// hex is bytes as hex digits.
export const hex = (bytes) => Buffer.from(bytes).toString("hex");
