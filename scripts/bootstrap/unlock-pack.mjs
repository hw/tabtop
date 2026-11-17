#!/usr/bin/env node
// Decrypt a /auth/pack JSON object. Plaintext is tabtop.html (UTF-8).
// No browser required (uses Node's WebCrypto).
//
//   node scripts/bootstrap/unlock-pack.mjs --pass 'OOB_PASS' --pack tabtop-client.pack.json --out ./client
//   node scripts/bootstrap/unlock-pack.mjs --pass 'OOB_PASS' --pack tabtop-client.pack.json --plain-out tabtop.html
//
// To expand the full build tree (bootstrap.client.json), use unpack-client.mjs.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { webcrypto } from "node:crypto";

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
	const a = process.argv[i];
	if (a === "--pass" || a === "--pack" || a === "--out" || a === "--plain-out") {
		args.set(a.slice(2), process.argv[++i]);
	} else {
		throw new Error(`unknown arg ${a}`);
	}
}
const pass = args.get("pass")?.trim();
const packPath = args.get("pack");
if (!pass) throw new Error("need --pass");
if (!packPath) throw new Error("need --pack <tabtop-client.pack.json>");

const text = readFileSync(packPath, "utf8").replace(/^\uFEFF/, "").trim();
if (!text.startsWith("{")) throw new Error("pack file must be JSON from /auth/pack");
const pack = JSON.parse(text);
if (pack.v !== 1 || pack.kdf !== "PBKDF2-SHA256" || pack.iter !== 210000) {
	throw new Error("unsupported pack version or parameters");
}

const subtle = webcrypto.subtle;
const salt = Buffer.from(pack.salt, "base64");
const iv = Buffer.from(pack.iv, "base64");
const ct = Buffer.from(pack.ct, "base64");
const baseKey = await subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
const key = await subtle.deriveKey(
	{ name: "PBKDF2", salt, iterations: pack.iter, hash: "SHA-256" },
	baseKey,
	{ name: "AES-GCM", length: 256 },
	false,
	["decrypt"],
);
let plain;
try {
	plain = Buffer.from(await subtle.decrypt({ name: "AES-GCM", iv }, key, ct));
} catch {
	throw new Error("decrypt failed (wrong passcode or tampered/truncated pack)");
}

const head = plain.toString("utf8", 0, Math.min(plain.length, 64)).trimStart().toLowerCase();
if (!head.startsWith("<!doctype html") && !head.startsWith("<html")) {
	throw new Error("plaintext isn't tabtop.html (old tree packs aren't supported; use unpack-client.mjs on bootstrap.client.json)");
}

const outFile = args.get("plain-out") || join(args.get("out") || ".", "tabtop.html");
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, plain);
console.error(`wrote ${outFile} (${plain.length} bytes)`);
console.error(`plaintext sha256: ${Buffer.from(await subtle.digest("SHA-256", plain)).toString("hex")}`);
