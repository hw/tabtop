// The files page's service worker, served by tabtopd (see e2e.go). It
// turns a file the page is fetching through the encrypted tunnel into an
// ordinary browser download, written to disk as it arrives instead of being
// held in memory first. It also serves audio/media ranges to a controlled files
// page, asking that page for bounded encrypted-tunnel reads.
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

// A new token for each worker lifetime lets the page retire orphaned ports.
const MEDIA_INSTANCE = crypto.randomUUID();

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
    const scope = new URL("./stream/", self.location.href);
    if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
    const relative = url.pathname.slice(scope.pathname.length);
    const media = /^(media|video)\/([0-9a-f-]{36})$/.exec(relative);
    if (url.origin === scope.origin && url.pathname.startsWith(scope.pathname) && media) {
        e.respondWith(mediaResponse(e, media[2], media[1] === "video"));
        return;
    }
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


// Single HTTP byte ranges. End is exclusive internally, inclusive on the wire.
function mediaRange(header, size) {
    if (header === null) return { begin: 0, end: size, status: 200 };
    const match = /^bytes=(\d*)-(\d*)$/.exec(header);
    if (!match || (!match[1] && !match[2]) || size === 0) return null;
    const start = match[1] ? Number(match[1]) : null;
    const last = match[2] ? Number(match[2]) : null;
    if (start !== null && (!Number.isSafeInteger(start) || start >= size) ||
        last !== null && !Number.isSafeInteger(last)) return null;
    if (start === null) return last > 0 ? { begin: Math.max(0, size - last), end: size, status: 206 } : null;
    if (last !== null && last < start) return null;
    return { begin: start, end: last === null ? size : Math.min(size, last + 1), status: 206 };
}

async function mediaResponse(event, id, legacyVideo = false) {
    if (!["GET", "HEAD"].includes(event.request.method)) return new Response(null, { status: 405 });
    const client = await self.clients.get(event.clientId);
    if (!client) return new Response(null, { status: 404 });
    const { port1: port, port2 } = new MessageChannel();
    let waiting = null;
    let timer = null;
    let closed = false;
    const receive = () => new Promise((resolve, reject) => {
        waiting = { resolve, reject };
        timer = setTimeout(() => {
            waiting = null;
            reject(new Error("media range stalled"));
        }, STALL);
    });
    port.onmessage = ({ data: m }) => {
        if (!waiting) return;
        clearTimeout(timer);
        const w = waiting;
        waiting = null;
        if (m?.error) w.reject(new Error(m.error));
        else w.resolve(m);
    };
    const stop = () => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        waiting?.reject(new Error("media request cancelled"));
        waiting = null;
        port.postMessage({ cancel: true });
        port.close();
    };
    try {
        const metadata = receive();
        client.postMessage({ type: legacyVideo ? "video-range" : "media-range", id, instance: MEDIA_INSTANCE }, [port2]);
        const { size, type } = await metadata;
        if (!Number.isSafeInteger(size) || size < 0 || !/^(video\/(mp4|webm|quicktime|ogg|x-matroska)|audio\/(mpeg|mp4|aac|ogg|wav|flac))$/.test(type)) throw new Error("invalid media metadata");
        const at = mediaRange(event.request.headers.get("Range"), size);
        const headers = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
        if (!at) {
            stop();
            return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
        }
        headers["Content-Length"] = String(at.end - at.begin);
        if (at.status === 206) headers["Content-Range"] = `bytes ${at.begin}-${at.end - 1}/${size}`;
        if (event.request.method === "HEAD" || at.begin === at.end) {
            stop();
            return new Response(null, { status: at.status, headers });
        }
        let offset = at.begin;
        const body = new ReadableStream({
            async pull(controller) {
                try {
                    const end = Math.min(at.end, offset + (1 << 20));
                    const reply = receive();
                    port.postMessage({ begin: offset, end });
                    const { bytes } = await reply;
                    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== end - offset) throw new Error("media range ended early");
                    controller.enqueue(new Uint8Array(bytes));
                    offset = end;
                    if (offset === at.end) { controller.close(); stop(); }
                } catch (err) {
                    controller.error(err);
                    stop();
                }
            },
            cancel: stop,
        }, { highWaterMark: 0 });
        return new Response(body, { status: at.status, headers });
    } catch {
        stop();
        return new Response(null, { status: 503 });
    }
}
