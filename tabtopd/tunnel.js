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
// tabtopd serves this file with "./noble/" changed to the versioned path
// it serves the noble files under (see e2e.go), so browsers can cache them
// for good; as written, it runs from a directory with noble/ beside it.

import { chacha20poly1305 } from "./noble/ciphers/chacha.js";

const VERSION = 3;
const HELLO_LOGIN = 1;
const HELLO_SESSION = 2;
const LABEL = "tabtop tunnel v3";
const DSI = "CPace255";
const CI = "tabtop login";
const DATA = 0;
const TEXT = 1;
const CLOSE_LOGIN = 4001;  // no such session: log in
const CONNECT_TIMEOUT = 20000;  // ms for the WebSocket to open
export const SESSION_KEY = "tabtop_session";  // its key in localStorage

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function tunnelURL() {
    const url = new URL("../tunnel", import.meta.url);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url;
}

// bytes views an ArrayBuffer, typed array or array of numbers as bytes.
function bytes(p) {
    if (p instanceof ArrayBuffer) {
        return new Uint8Array(p);
    }
    if (ArrayBuffer.isView(p)) {
        return new Uint8Array(p.buffer, p.byteOffset, p.byteLength);
    }
    return Uint8Array.from(p);
}

function concat(...parts) {
    const views = parts.map(bytes);
    const out = new Uint8Array(views.reduce((n, v) => n + v.length, 0));
    let i = 0;
    for (const v of views) {
        out.set(v, i);
        i += v.length;
    }
    return out;
}

function nonce(n) {
    const iv = new Uint8Array(12);
    new DataView(iv.buffer).setBigUint64(4, BigInt(n));
    return iv;
}

function equal(a, b) {
    let diff = a.length ^ b.length;
    for (let i = 0; i < a.length && i < b.length; i++) {
        diff |= a[i] ^ b[i];
    }
    return diff === 0;
}

// CPace (see cpace.go) -------------------------------------------------

const P = 2n ** 255n - 19n;
const A = 486662n;

function modpow(b, e) {
    let r = 1n;
    b %= P;
    for (; e > 0n; e >>= 1n, b = b * b % P) {
        if (e & 1n) {
            r = r * b % P;
        }
    }
    return r;
}

const mod = (x) => ((x % P) + P) % P;

// elligator2 maps a field element to a Curve25519 u-coordinate (RFC 9380
// section 6.7.1, Z = 2).
export function elligator2(r) {
    let tv1 = mod(2n * r * r);
    if (tv1 === P - 1n) {
        tv1 = 0n;
    }
    const x1 = mod(-A * modpow(tv1 + 1n, P - 2n));
    const gx1 = mod(((x1 + A) * x1 + 1n) * x1);
    const l = modpow(gx1, (P - 1n) / 2n);
    return l === 0n || l === 1n ? x1 : mod(-x1 - A);
}

// lv is CPace's prepend_len: a LEB128 length, then the data.
function lv(...parts) {
    const out = [];
    for (const p of parts) {
        for (let n = p.length; ; n >>>= 7) {
            out.push(n > 0x7f ? (n & 0x7f) | 0x80 : n);
            if (n <= 0x7f) {
                break;
            }
        }
        out.push(...p);
    }
    return Uint8Array.from(out);
}

function leToBig(b) {
    let x = 0n;
    for (let i = b.length - 1; i >= 0; i--) {
        x = (x << 8n) | BigInt(b[i]);
    }
    return x;
}

function bigToLE(x) {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++, x >>= 8n) {
        out[i] = Number(x & 0xffn);
    }
    return out;
}

export async function cpaceGenerator(c, prs, sid) {
    const p = encoder.encode(prs);
    const dsi = encoder.encode(DSI);
    const zpad = new Uint8Array(Math.max(0, 128 - lv(p).length - lv(dsi).length - 1));
    const le = (await c.sha512(lv(dsi, p, zpad, encoder.encode(CI), sid))).slice(0, 32);
    le[31] &= 0x7f;
    return bigToLE(elligator2(leToBig(le) % P));
}

async function loginKeys(c, sid, k, ya, yb) {
    const isk = await c.sha512(concat(lv(encoder.encode(DSI + "_ISK"), sid, k), lv(ya, [], yb, [])));
    return c.hkdf(isk, new Uint8Array(), "tabtop login v3 keys", 128);
}

// The handshakes' primitives, from WebCrypto or noble. Each backend has
// keygen() -> { secret, pub }; scalarMult(secret, u), which is X25519 and
// throws on an all-zero result; sha256 and sha512; and hkdf(ikm, salt,
// info, bytes) with SHA-256. All return promises of Uint8Arrays.

const webCrypto = (subtle) => ({
    name: "webcrypto",
    async keygen() {
        const pair = await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
        return { secret: pair.privateKey, pub: new Uint8Array(await subtle.exportKey("raw", pair.publicKey)) };
    },
    async scalarMult(secret, u) {
        const pub = await subtle.importKey("raw", u, { name: "X25519" }, false, []);
        return new Uint8Array(await subtle.deriveBits({ name: "X25519", public: pub }, secret, 256));
    },
    sha256: async (b) => new Uint8Array(await subtle.digest("SHA-256", b)),
    sha512: async (b) => new Uint8Array(await subtle.digest("SHA-512", b)),
    async hkdf(ikm, salt, info, bytes) {
        const key = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
        return new Uint8Array(await subtle.deriveBits(
            { name: "HKDF", hash: "SHA-256", salt, info: encoder.encode(info) }, key, bytes * 8));
    },
});

async function nobleCrypto() {
    const [{ x25519 }, { hkdf }, { sha256, sha512 }] = await Promise.all([
        import("./noble/curves/ed25519.js"),
        import("./noble/hashes/hkdf.js"),
        import("./noble/hashes/sha2.js"),
    ]);
    return {
        name: "noble",
        async keygen() {
            const { secretKey, publicKey } = x25519.keygen();
            return { secret: secretKey, pub: publicKey };
        },
        scalarMult: async (secret, u) => x25519.scalarMult(secret, u),
        sha256: async (b) => sha256(b),
        sha512: async (b) => sha512(b),
        hkdf: async (ikm, salt, info, bytes) => hkdf(sha256, ikm, salt, encoder.encode(info), bytes),
    };
}

let backend = null;

// cryptoBackend picks the backend once per page: WebCrypto if it can make
// an X25519 key, noble otherwise. useNoble (for tests) forces noble.
export function cryptoBackend({ useNoble = false } = {}) {
    if (useNoble) {
        backend = nobleCrypto();
    }
    backend ??= (async () => {
        const subtle = globalThis.crypto?.subtle;
        if (subtle) {
            try {
                await subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
                return webCrypto(subtle);
            } catch {
                // No X25519 in this browser's WebCrypto.
            }
        }
        return nobleCrypto();
    })();
    return backend;
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
export async function login(credential, url = tunnelURL()) {
    const c = await cryptoBackend();
    const { secret: y } = await c.keygen();
    const sid = crypto.getRandomValues(new Uint8Array(16));
    const ya = await c.scalarMult(y, await cpaceGenerator(c, credential, sid));
    const s = new Socket(url);
    try {
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
        return { id: res.session, secret: res.secret, expires: res.expires, ip: res.ip, logins: res.logins || [] };
    } finally {
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
export async function request(req) {
    const t = await Tunnel.open(req);
    t.close();
    return t.reply;
}

// TunnelSocket looks enough like a WebSocket for noVNC (as its "channel"),
// the terminal and the audio player: it's open once the server has
// accepted the request, and delivers text as strings and data as
// ArrayBuffers. With a title, it shows the login form when there's no
// session, and logs in again when the session is over. Its close event
// has login if the session is over, and lost if the connection failed or
// was lost without the server saying why, as when the network goes. Its
// session is the one it used.
export class TunnelSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;

    constructor(req, { title } = {}) {
        this.readyState = TunnelSocket.CONNECTING;
        this.binaryType = "arraybuffer";
        this.protocol = "";
        this.onopen = this.onmessage = this.onerror = this.onclose = null;
        this._start(req, title);
    }

    async _start(req, title) {
        for (;;) {
            try {
                this.session = title ? await session(title) : storedSession();
                this._t = await Tunnel.open(req, this.session);
                break;
            } catch (e) {
                if (e.login && title) {
                    forgetSession(this.session);
                    continue;
                }
                this._finish(e.message, e.login, e.lost);
                return;
            }
        }
        if (this.readyState === TunnelSocket.CLOSED) {
            this._t.close();  // closed while connecting
            return;
        }
        this.readyState = TunnelSocket.OPEN;
        this._opened = true;
        this.onopen?.(new Event("open"));
        for (let m; (m = await this._t.next());) {
            this.onmessage?.({ data: m.text ?? m.data });
        }
        this._finish(this._t.closeReason, this._t.closeLogin, !this._t.closeReason && !this._t.closeLogin);
    }

    _finish(reason, login = false, lost = false) {
        if (this._done) {
            return;
        }
        this._done = true;
        this.readyState = TunnelSocket.CLOSED;
        if (!this._opened) {
            // A WebSocket that fails to connect reports an error first.
            this.onerror?.(new Event("error"));
        }
        this.onclose?.({ code: 1000, reason, login, lost, wasClean: true });
    }

    send(data) {
        if (this.readyState !== TunnelSocket.OPEN) {
            return;
        }
        if (typeof data === "string") {
            this._t.sendText(data);
        } else {
            this._t.sendData(data);
        }
    }

    close() {
        const wasOpen = this.readyState === TunnelSocket.OPEN;
        this.readyState = TunnelSocket.CLOSED;
        if (wasOpen) {
            this._t.close();
        }
    }
}

// The session from logging in: its id and secret, kept in this browser's
// storage and shared by the desktop, terminal and downloads.
export function storedSession() {
    try {
        const s = JSON.parse(localStorage.getItem(SESSION_KEY));
        return s?.id && s?.secret ? s : null;
    } catch {
        return null;
    }
}

// forgetSession forgets the stored session, or, given one that's over,
// forgets it only if it's still the one stored: not a newer login, from
// this page or another.
export function forgetSession(over) {
    try {
        if (!over || storedSession()?.id === over.id) {
            localStorage.removeItem(SESSION_KEY);
        }
    } catch {
        // Nothing stored.
    }
}

function saveSession(s) {
    try {
        localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    } catch {
        // Not remembered: this page still has it.
    }
}

// Only one login form at a time, however many tunnels are waiting for it.
let pendingLogin = null;

// session returns the stored session, or shows a login form over the page
// and returns the new one.
export async function session(title) {
    const s = storedSession();
    if (s) {
        return s;
    }
    pendingLogin ??= loginForm(title).finally(() => (pendingLogin = null));
    return pendingLogin;
}

// renewSession shows the login form, with a Cancel button, to log in
// again before the session runs out, and resolves to the new session, or
// null if it's cancelled. The old session goes on until it's ended: what
// it has open then reconnects with the new one.
export function renewSession(title) {
    return loginForm(title, true);
}

function loginForm(title, cancellable = false) {
    const box = document.createElement("div");
    Object.assign(box.style, {
        position: "fixed", inset: "0", zIndex: "1000", overflow: "auto", padding: "2rem 1rem",
        font: "15px/1.5 system-ui, sans-serif", color: "#e8e8ea", background: "#1c1c1e",
    });
    const form = document.createElement("form");
    form.id = "tabtop_login";
    form.style.maxWidth = "56rem";
    form.style.margin = "0 auto";
    const h1 = document.createElement("h1");
    h1.textContent = title;
    Object.assign(h1.style, { fontSize: "1.25rem", fontWeight: "600" });
    const error = document.createElement("p");
    error.style.color = "#f28b82";
    const label = document.createElement("label");
    label.append("Password + authenticator code", document.createElement("br"));
    const input = document.createElement("input");
    Object.assign(input, { type: "password", autocomplete: "off", required: true });
    Object.assign(input.style, { font: "inherit", fontSize: "1.25rem", width: "16em", maxWidth: "100%" });
    label.append(input);
    const button = document.createElement("button");
    button.textContent = "Log in";
    const note = document.createElement("p");
    Object.assign(note.style, { opacity: "0.7", fontSize: "13px" });
    note.textContent = "End-to-end encrypted. The code never leaves this page: it's used to agree on keys "
        + "with the desktop. One login covers the desktop, terminal and downloads.";
    const p1 = document.createElement("p");
    p1.append(label);
    const p2 = document.createElement("p");
    p2.append(button);
    form.append(h1, error, p1, p2, note);
    box.append(form);
    document.body.append(box);
    input.focus();

    return new Promise((resolve) => {
        if (cancellable) {
            const cancel = document.createElement("button");
            Object.assign(cancel, { type: "button", textContent: "Cancel" });
            cancel.style.marginLeft = ".5rem";
            cancel.addEventListener("click", () => {
                box.remove();
                resolve(null);
            });
            p2.append(cancel);
        }
        form.addEventListener("submit", async (e) => {
            e.preventDefault();
            button.disabled = true;
            error.textContent = "";
            try {
                const { ip, logins, ...s } = await login(input.value.trim());
                saveSession(s);
                box.remove();
                showLoginSummary(ip, logins);
                resolve(s);
            } catch (err) {
                error.textContent = err.message;
                input.value = "";
                input.focus();
            } finally {
                button.disabled = false;
            }
        });
    });
}

// showLoginSummary shows the logins before this one, so one you didn't
// make stands out: briefly, or until dismissed if there were failed
// attempts or the last login came from another address. A page changed on
// the way could hide it; the files page's list of sessions and the
// gateway's log say the same.
function showLoginSummary(ip, logins) {
    const lastOK = logins.findIndex((l) => l.ok);
    const failed = logins.slice(0, lastOK < 0 ? logins.length : lastOK);
    const prev = logins[lastOK];
    const warn = failed.length > 0 || (prev && prev.ip !== ip);
    const when = (t) => new Date(t).toLocaleString();
    const lines = [prev ? `Previous login: ${when(prev.time)} from ${prev.ip}.`
        : "No earlier login since the server started."];
    if (failed.length) {
        const ips = [...new Set(failed.map((l) => l.ip))].join(", ");
        lines.push(`${failed.length} failed ${failed.length === 1 ? "attempt" : "attempts"} since then, from ${ips}.`);
    }
    lines.push(`This login: from ${ip}.`);
    const box = document.createElement("div");
    box.id = "tabtop_login_summary";
    box.setAttribute("role", "status");
    Object.assign(box.style, {
        // At the top, clear of the files page's transfers at the bottom
        // and the terminal's bar.
        position: "fixed", right: "1rem", top: "2.5rem", left: "1rem", marginLeft: "auto", maxWidth: "26rem",
        zIndex: "1001", padding: ".75rem 1rem", borderRadius: "8px", font: "14px/1.5 system-ui, sans-serif",
        color: "#e8e8ea", background: warn ? "#5c1d1a" : "#2c2c2e", boxShadow: "0 2px 12px rgba(0,0,0,.4)",
    });
    for (const line of lines) {
        const p = document.createElement("p");
        p.style.margin = "0 0 .25rem";
        p.textContent = line;
        box.append(p);
    }
    const close = document.createElement("button");
    close.textContent = "OK";
    close.addEventListener("click", () => box.remove());
    box.append(close);
    document.body.append(box);
    if (!warn) {
        setTimeout(() => box.remove(), 10000);
    }
}
