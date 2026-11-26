// TestOfflinePollInterop connects the sealed client's transport and protocol
// to the real Go HTTP handler over stdin/stdout, so the upgrade can fail
// without a proxy or a listening TCP socket.
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { runInNewContext, runInThisContext } from "node:vm";
import { setTimeout as delay } from "node:timers/promises";

const [dir, credential] = process.argv.slice(2);
const { files } = JSON.parse(readFileSync("bootstrap.client.json", "utf8"));
const html = files["tabtop.html"];
const invocation = html.slice(html.indexOf('})({"text":') + 3, html.lastIndexOf("</script>")).trimEnd().slice(0, -2);
const [{ text }] = runInThisContext("[" + invocation + "]");
writeFileSync(join(dir, "package.json"), '{"type":"module"}');
for (const [path, body] of Object.entries(text)) {
    if (!/^tabtop\/.*\.js$/.test(path)) continue;
    const file = join(dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
}

let next = 0, upgrades = 0;
const requests = new Map();
const input = createInterface({ input: process.stdin });
const write = (data) => process.stdout.write(JSON.stringify(data) + "\n");
input.on("line", (line) => {
    const res = JSON.parse(line);
    requests.get(res.id)?.(res);
});
const fetch = (url, { method, headers, body, signal }) => new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const id = ++next;
    const abort = () => {
        requests.delete(id);
        write({ id, cancel: true });
        reject(signal.reason);
    };
    requests.set(id, ({ status, body }) => {
        signal?.removeEventListener("abort", abort);
        requests.delete(id);
        resolve(new Response(status === 204 ? null : Buffer.from(body, "base64"), { status }));
    });
    signal?.addEventListener("abort", abort, { once: true });
    write({ id, method, url, headers, body: body ? Buffer.from(body).toString("base64") : "" });
});

globalThis.WebSocket = class {
    static OPEN = 1;
    constructor() {
        upgrades++;
        queueMicrotask(() => this.onerror?.(new Event("error")));
    }
    close() {}
};

let submit;
const rendered = Promise.withResolvers();
const fields = {
    err: { set textContent(message) { rendered.reject(new Error(message)); } },
    form: { addEventListener(type, fn) { if (type === "submit") submit = fn; } },
    go: {},
    server: {},
};
const launcher = {
    document: {
        getElementById: (id) => fields[id],
        open() {},
        write(html) { rendered.resolve(html); },
        close() {},
    },
    location: new URL("file:///tmp/tabtop.html?page=files"),
    Worker: class {},
    fetch, WebSocket, crypto, console, URL, URLSearchParams, Blob, Response, TextEncoder, TextDecoder,
    Event, DOMException, AbortController, AbortSignal, atob, btoa, queueMicrotask, setTimeout, clearTimeout,
};
launcher.window = launcher;
runInNewContext(html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>")), launcher);
fields.server.value = "https://localhost/desk/";
submit({ preventDefault() {} });
assert.match(await rendered.promise, /connect-src blob: data: wss:\/\/localhost https:\/\/localhost\/desk\/session\/poll https:\/\/localhost\/desk\/session\/poll\//);
await assert.rejects(launcher.fetch("https://localhost/desk/session/poll"), /isn't in the offline client/);
globalThis.tabtopOffline = launcher.tabtopOffline;
const url = "wss://localhost/desk/session";
const { login, Tunnel } = await import(pathToFileURL(join(dir, "tabtop/tunnel-protocol.js")));
try {
    const session = await login(credential, url);
    const tunnel = await Tunnel.open({ type: "file", path: "interop.bin" }, session, url);
    const hash = createHash("sha256");
    for (let chunk; (chunk = await tunnel.nextChunk());) {
        hash.update(Buffer.from(chunk));
        await delay(12);
    }
    write({ digest: hash.digest("hex"), upgrades });
} finally {
    input.close();
    process.stdin.pause();
}
