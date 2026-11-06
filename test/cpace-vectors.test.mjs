// The page's CPace (tunnel-crypto.js) against draft-irtf-cfrg-cpace-21's
// test vectors for X25519 with SHA-512 (appendix B.1), with SHA-512 from
// Node: the generator and the ISK are the page's own code. X25519 is
// WebCrypto's or noble's; TestTunnelInteropWithJS checks those with noble.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createHash } from "node:crypto";

const target = new URL("../tabtopd/tunnel-crypto.js", import.meta.url).href;
const hooks = registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL === target && specifier === "./noble/ciphers/chacha.js") {
        return { shortCircuit: true, url: "data:text/javascript,export const chacha20poly1305 = () => {};" };
    }
    return next(specifier, context);
} });
let cpaceGenerator, cpaceISK;
try { ({ cpaceGenerator, cpaceISK } = await import(target)); } finally { hooks.deregister(); }

const c = { sha512: async (b) => new Uint8Array(createHash("sha512").update(b).digest()) };
const unhex = (s) => Uint8Array.from(Buffer.from(s, "hex"));
const hex = (b) => Buffer.from(b).toString("hex");
const enc = (s) => new TextEncoder().encode(s);

const sid = unhex("7e4b4791d6a8ef019b936c79fb7f2c57");
const Ya = unhex("1d13c89278cdadd826f6d8d7f887701430f8380ddc17611cdd6dc989ce0c9f32");
const Yb = unhex("248cccf6d5cdc3646f0ad593f9e6cef4e69d4945f8372e623512ecea32185623");
const K = unhex("5b067effbdc0b2a0e1d907b21ebb25cfedb96a852179a847c37e43ee71322c6b");

test("generator", async () => {
    const g = await cpaceGenerator(c, "Password", sid, "\x0bA_initiator\x0bB_responder");
    assert.equal(hex(g), "d04bf6d41f6a289632a2e929fa29bebd51092512a7829fdde7d314b62f05a73f");
});

test("ISK_IR", async () => {
    const isk = await cpaceISK(c, sid, K, Ya, Yb, enc("ADa"), enc("ADb"));
    assert.equal(hex(isk),
        "6e19b875f7a561d6b3ca3dbb9ef42ac55de3e717881018204b8922b4" +
        "d5e53bb2aa82c300bea7b65d2b671da71922ddf6472301b79bc270ad" +
        "fa8bf413285f2263");
});
