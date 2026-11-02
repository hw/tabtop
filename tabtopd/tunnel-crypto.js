import { chacha20poly1305 } from "./noble/ciphers/chacha.js";
export { chacha20poly1305 };
const DSI = "CPace255";
const CI = "tabtop login";
const encoder = new TextEncoder();

// bytes views an ArrayBuffer, typed array or array of numbers as bytes.
export function bytes(p) {
    if (p instanceof ArrayBuffer) {
        return new Uint8Array(p);
    }
    if (ArrayBuffer.isView(p)) {
        return new Uint8Array(p.buffer, p.byteOffset, p.byteLength);
    }
    return Uint8Array.from(p);
}

export function concat(...parts) {
    const views = parts.map(bytes);
    const out = new Uint8Array(views.reduce((n, v) => n + v.length, 0));
    let i = 0;
    for (const v of views) {
        out.set(v, i);
        i += v.length;
    }
    return out;
}

export function nonce(n) {
    const iv = new Uint8Array(12);
    new DataView(iv.buffer).setBigUint64(4, BigInt(n));
    return iv;
}

export function equal(a, b) {
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

export async function loginKeys(c, sid, k, ya, yb) {
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
