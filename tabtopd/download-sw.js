// The files page's service worker, served by tabtopd (see e2e.go). It
// turns a file the page is fetching through the encrypted tunnel into an
// ordinary browser download, written to disk as it arrives instead of being
// held in memory first.
//
// The page sends { id, name, size, port } for each file, and once this
// says { ready } on the port, opens stream/<id>/<name> (in this worker's
// scope) in a hidden frame: not before, since a worker that's stopped
// may get the frame's request first as it starts again. The
// worker answers that request with a stream that asks the page for each
// decrypted chunk in turn over the port, so a slow disk slows the page,
// and through it the server, rather than piling chunks up here or there.
// The response has a Content-Length, and a transfer that ends early is
// reported as an error, so the browser marks the download failed instead
// of keeping a truncated file. A zip's size isn't known (size is null), so
// it has none, and the page says whether it ended whole: { done } if so,
// { error } if not. The browser itself writes to a temporary
// file (.crdownload, .part) and renames it once the response is complete.

const STALL = 60000;  // ms without a chunk before giving up
const pending = new Map();  // id -> { name, size, port }

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("message", (e) => {
    const d = e.data;
    if (d?.type === "download" && d.port) {
        pending.set(d.id, { name: d.name, size: d.size, port: d.port });
        d.port.postMessage({ ready: true });
        // Forget it if the page never opens it.
        setTimeout(() => pending.delete(d.id), STALL);
    }
    // Anything else ("ping") only keeps this worker running.
});

self.addEventListener("fetch", (e) => {
    const url = new URL(e.request.url);
    const scope = new URL(self.registration.scope);
    const [id] = url.pathname.slice(scope.pathname.length).split("/");
    const d = pending.get(id);
    if (!d) {
        return;  // the server answers 404
    }
    pending.delete(id);
    e.respondWith(respond(d));
});

function respond({ name, size, port }) {
    let got = 0;
    let waiting = null;  // { resolve, reject } for the chunk being asked for
    let timer = 0;
    const fail = (message) => {
        waiting?.reject(new Error(message));
        waiting = null;
    };
    port.onmessage = (e) => {
        const m = e.data;
        clearTimeout(timer);
        if (!waiting) {
            return;
        }
        const w = waiting;
        waiting = null;
        if (m.error) {
            w.reject(new Error(m.error));
        } else if (m.done) {
            w.resolve(null);
        } else {
            w.resolve(new Uint8Array(m.data));
        }
    };
    const body = new ReadableStream({
        start() {
            port.postMessage({ started: true });
        },
        async pull(controller) {
            const chunk = await new Promise((resolve, reject) => {
                waiting = { resolve, reject };
                timer = setTimeout(() => fail("stalled"), STALL);
                port.postMessage({ pull: true });
            });
            if (chunk) {
                got += chunk.byteLength;
                if (size !== null && got > size) {
                    throw new Error("more than the file's size");
                }
                controller.enqueue(chunk);
            } else if (size === null || got === size) {
                controller.close();
            } else {
                throw new Error("ended early");
            }
        },
        cancel() {
            // The browser cancelled the download.
            clearTimeout(timer);
            port.postMessage({ cancel: true });
        },
    }, { highWaterMark: 0 });
    const headers = {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": disposition(name),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
    };
    if (size !== null) {
        headers["Content-Length"] = String(size);
    }
    return new Response(body, { headers });
}

// disposition names the file for the download: in full as UTF-8, with a
// plain ASCII fallback for old browsers.
function disposition(name) {
    const ascii = name.replace(/[^\x20-\x7e]|["\\%;]/g, "_") || "download";
    const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
    return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}
