// The encrypted tunnel's browser side, served by tabtopd (see tunnel.go for
// the protocol). The desktop, terminal, files and audio all travel through
// it, so a proxy that terminates TLS and reads traffic sees only
// ciphertext. Logging in runs CPace with the password + TOTP code, which
// never crosses the wire; the session it yields keys every later tunnel.
// Messages are encrypted with ChaCha20-Poly1305 from @noble/ciphers, since
// browsers don't have it built in. The handshakes' X25519, SHA-2 and HKDF
// come from WebCrypto where the browser offers it (over HTTPS or on
// localhost, in Chrome 133+, Firefox 130+ or Safari 17+), and otherwise
// from @noble/curves and @noble/hashes, loaded only then (see
// cryptoBackend). Both give the same bytes.
//
// Crypto primitives and versioned noble imports live in tunnel-crypto.js.

import { chacha20poly1305, bytes, concat, nonce, equal, loginKeys, cpaceGenerator, cryptoBackend } from "./tunnel-crypto.js";
export { elligator2, cpaceGenerator, cryptoBackend } from "./tunnel-crypto.js";

const VERSION = 3;
const HELLO_LOGIN = 1;
const HELLO_SESSION = 2;
const LABEL = "tabtop tunnel v3";
const DATA = 0;
const TEXT = 1;
const CLOSE_LOGIN = 4001;  // no such session: log in
const CONNECT_TIMEOUT = 20000;  // ms for the WebSocket to open
import { storedSession } from "./session-state.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function tunnelURL() {
    const url = new URL("../tunnel", import.meta.url);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url;
}

// The connection -----------------------------------------------------

export class TunnelError extends Error {
    constructor(message, login = false, lost = false) {
        super(message);
        this.login = login;  // the session is missing or over: log in again
        this.lost = lost;    // the server couldn't be reached, or went, without saying why: try again later
    }
}

// Socket is a WebSocket whose binary messages can be awaited in turn, for
// the handshakes.
class Socket {
    constructor(url) {
        this.ws = new WebSocket(url);
        this.ws.binaryType = "arraybuffer";
        this.queue = [];
        this.waiters = [];
        this.closeEvent = null;
        // opened fails if the socket closes, or takes too long, before it
        // opens: refused, unreachable, or blocked on the way.
        let fail;
        this.opened = new Promise((resolve, reject) => {
            this.ws.onopen = resolve;
            fail = reject;
        });
        this.opened.catch(() => {});
        const timer = setTimeout(() => {
            fail(new TunnelError("Can't reach the server.", false, true));
            this.ws.close();
        }, CONNECT_TIMEOUT);
        this.opened.then(() => clearTimeout(timer), () => clearTimeout(timer));
        this.ws.onmessage = (e) => this._push(new Uint8Array(e.data));
        this.ws.onclose = (e) => {
            fail(new TunnelError(e.reason || "Can't reach the server.", false, !e.reason));
            this.closeEvent = e;
            while (this.waiters.length) {
                this.waiters.shift()(null);
            }
            this.onclose?.(e);
        };
    }

    _push(m) {
        const w = this.waiters.shift();
        if (w) {
            w(m);
        } else {
            this.queue.push(m);
        }
    }

    // next returns the next message, or throws the reason it closed.
    async next() {
        const m = this.queue.length ? this.queue.shift()
            : this.closeEvent ? null : await new Promise((resolve) => this.waiters.push(resolve));
        if (!m) {
            const e = this.closeEvent;
            const login = e?.code === CLOSE_LOGIN;
            throw new TunnelError(e?.reason || "Can't reach the server.", login, !e?.reason && !login);
        }
        return m;
    }

    async send(b) {
        await this.opened;
        this.ws.send(b);
    }
}

// login runs CPace with the credential and returns the new session.
export async function login(credential, url = tunnelURL(), { signal } = {}) {
    signal?.throwIfAborted();
    const c = await cryptoBackend();
    const { secret: y } = await c.keygen();
    const sid = crypto.getRandomValues(new Uint8Array(16));
    const ya = await c.scalarMult(y, await cpaceGenerator(c, credential, sid));
    signal?.throwIfAborted();
    const s = new Socket(url);
    const abort = () => s.ws.close();
    signal?.addEventListener("abort", abort, { once: true });
    try {
        signal?.throwIfAborted();
        await s.send(concat([VERSION, HELLO_LOGIN], sid, ya));
        const reply = await s.next();
        if (reply[0] !== VERSION || (reply.length - 1) % 32 !== 0) {
            throw new TunnelError("The server's reply is malformed.");
        }
        const keys = [];
        for (let i = 1; i < reply.length; i += 32) {
            const yb = reply.slice(i, i + 32);
            let k;
            try {
                k = await c.scalarMult(y, yb);
            } catch {
                k = crypto.getRandomValues(new Uint8Array(32));  // can't match
            }
            keys.push(await loginKeys(c, sid, k, ya, yb));
        }
        await s.send(concat(...keys.map((k) => k.slice(64, 96))));
        const confirm = await s.next();
        const ks = keys.find((k) => equal(confirm.slice(1), k.slice(96)));
        if (confirm[0] !== VERSION || !ks) {
            throw new TunnelError("The server couldn't prove it knows the code.");
        }
        const recv = chacha20poly1305(ks.slice(32, 64), nonce(0));
        const pt = recv.decrypt(await s.next());
        const res = JSON.parse(decoder.decode(pt.slice(1)));
        signal?.throwIfAborted();
        return { id: res.session, secret: res.secret, expires: res.expires, ip: res.ip, logins: res.logins || [] };
    } finally {
        signal?.removeEventListener("abort", abort);
        s.ws.close();
    }
}

// Tunnel is one session tunnel. open() makes it and sends the request; then
// next() returns each message from the server in order, as { text } or
// { data } (an ArrayBuffer), or null once it's closed.
export class Tunnel {
    static async open(request, sess = storedSession(), url = tunnelURL()) {
        if (!sess) {
            throw new TunnelError("Log in first.", true);
        }
        const t = new Tunnel();
        await t._connect(url, sess);
        t.sendText(JSON.stringify(request));
        const first = await t.next();
        if (!first || first.text === undefined) {
            throw new TunnelError(t.closeReason || "The connection closed.", t.closeLogin, !t.closeReason && !t.closeLogin);
        }
        const reply = JSON.parse(first.text);
        if (reply.error) {
            t.close();
            throw new TunnelError(reply.error);
        }
        t.reply = reply;
        return t;
    }

    constructor() {
        this.closed = false;
        this.closeReason = "";
        this.closeLogin = false;
        this._queue = [];
        this._waiters = [];
        this._recvN = 0;
        this._sendN = 0;
        this.onclose = null;  // called once, with the close reason
    }

    async _connect(url, sess) {
        const c = await cryptoBackend();
        const { secret: eph, pub } = await c.keygen();
        const id = encoder.encode(sess.id);
        const s = new Socket(url);
        await s.send(concat([VERSION, HELLO_SESSION], pub, id));
        const hello = await s.next();
        if (hello.length !== 33 || hello[0] !== VERSION) {
            s.ws.close();
            throw new TunnelError("The server's handshake is malformed.");
        }
        const serverEph = hello.slice(1);
        let ee;
        try {
            ee = await c.scalarMult(eph, serverEph);
        } catch {
            s.ws.close();
            throw new TunnelError("The server's handshake is malformed.");
        }
        const secret = Uint8Array.from(atob(sess.secret), (c) => c.charCodeAt(0));
        const salt = await c.sha256(concat(encoder.encode(LABEL), pub, serverEph, id));
        const k = await c.hkdf(concat(ee, secret), salt, "tabtop session keys", 64);
        this._sendKey = k.slice(0, 32);
        this._recvKey = k.slice(32);
        this._ws = s.ws;
        openSockets.add(s.ws);
        s.ws.onmessage = (e) => this._recv(e.data);
        s.ws.onclose = (e) => this._closed(e);
        // Socket's old handler may have received a close while the awaits
        // above derived keys. Forward it so next() cannot wait forever.
        if (s.closeEvent) {
            this._closed(s.closeEvent);
        }
    }

    _recv(ct) {
        if (this.closed) {
            return;
        }
        let pt;
        try {
            pt = chacha20poly1305(this._recvKey, nonce(this._recvN++)).decrypt(new Uint8Array(ct));
        } catch {
            this._ws.close();
            this._closed({ reason: "The connection was tampered with." });
            return;
        }
        const body = pt.slice(1).buffer;
        const msg = pt[0] === TEXT ? { text: decoder.decode(body) } : { data: body };
        const w = this._waiters.shift();
        if (w) {
            w(msg);
        } else {
            this._queue.push(msg);
        }
    }

    _closed(e) {
        if (this.closed) {
            return;
        }
        openSockets.delete(this._ws);
        this.closed = true;
        this.closeReason = e.reason || "";
        this.closeLogin = e.code === CLOSE_LOGIN;
        while (this._waiters.length) {
            this._waiters.shift()(null);
        }
        this.onclose?.(this.closeReason);
    }

    next() {
        if (this._queue.length) {
            return Promise.resolve(this._queue.shift());
        }
        if (this.closed) {
            return Promise.resolve(null);
        }
        return new Promise((resolve) => this._waiters.push(resolve));
    }

    // nextChunk returns a file or zip request's next chunk of data, or
    // null once it's closed. Each is acknowledged as it's taken, with an
    // empty data message: the server only sends a few chunks ahead of
    // those, so a slow or paused download doesn't pile up in memory here.
    // A zip ends with {"done":true,...}, kept in this.trailer.
    async nextChunk() {
        for (let m; (m = await this.next());) {
            if (m.data) {
                this.sendData(new Uint8Array());
                return m.data;
            }
            try {
                this.trailer = JSON.parse(m.text);
            } catch {
                // Not one.
            }
        }
        return null;
    }

    _send(kind, body) {
        if (this._ws.readyState !== WebSocket.OPEN) {
            return;
        }
        this._ws.send(chacha20poly1305(this._sendKey, nonce(this._sendN++)).encrypt(concat([kind], body)));
    }

    sendText(s) {
        this._send(TEXT, encoder.encode(s));
    }

    sendData(b) {
        this._send(DATA, b);
    }

    close() {
        this._ws.close();
    }
}

// A page left for another can be kept, still running, for the back
// button; its tunnels would keep its session open. So they're closed when
// the page is hidden, and a page brought back reloads to reconnect.
const openSockets = new Set();
globalThis.addEventListener?.("pagehide", () => {
    for (const ws of openSockets) {
        ws.close();
    }
});
globalThis.addEventListener?.("pageshow", (e) => {
    if (e.persisted) {
        location.reload();
    }
});

// request opens a tunnel for a one-off request and returns the reply.
export async function request(req, sess = storedSession()) {
    const t = await Tunnel.open(req, sess);
    t.close();
    return t.reply;
}
