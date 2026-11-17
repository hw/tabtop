#!/usr/bin/env node
// Seal a UTF-8 payload for the local decoder (PBKDF2-SHA-256 + AES-GCM).
// Pack is JSON matching /auth/pack; decoder HTML is built with build-decoder.mjs.
//
//   node seal.mjs --pass 'YOUR_OOB_PASS' --in payload.demo.html --pack demo.pack.json
//   node seal.mjs --pass 'x' --text 'hello' --pack -   # prints pack JSON
import { readFileSync, writeFileSync } from "node:fs";
import { webcrypto } from "node:crypto";

const subtle = webcrypto.subtle;
const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
	const a = process.argv[i];
	if (a === "--pass" || a === "--in" || a === "--text" || a === "--pack") {
		args.set(a.slice(2), process.argv[++i]);
	} else if (a === "--out" || a === "--template") {
		throw new Error(`${a} is no longer supported; pack is a separate download (use --pack). Build the decoder with build-decoder.mjs.`);
	} else {
		throw new Error(`unknown arg ${a}`);
	}
}
const pass = args.get("pass");
if (!pass) throw new Error("need --pass");

const plain = args.has("text")
	? new TextEncoder().encode(args.get("text"))
	: readFileSync(args.get("in") || new URL("./payload.demo.html", import.meta.url));

const salt = webcrypto.getRandomValues(new Uint8Array(16));
const iv = webcrypto.getRandomValues(new Uint8Array(12));
const baseKey = await subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
const key = await subtle.deriveKey(
	{ name: "PBKDF2", salt, iterations: 210_000, hash: "SHA-256" },
	baseKey,
	{ name: "AES-GCM", length: 256 },
	false,
	["encrypt"],
);
const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
const b64 = (u8) => Buffer.from(u8).toString("base64");
const packObj = {
	v: 1,
	kdf: "PBKDF2-SHA256",
	iter: 210000,
	salt: b64(salt),
	iv: b64(iv),
	ct: b64(ct),
};
const packText = JSON.stringify(packObj) + "\n";

console.error(`plaintext sha256: ${Buffer.from(await subtle.digest("SHA-256", plain)).toString("hex")}`);
console.error(`pack length: ${packText.length} chars`);

if (args.has("pack")) {
	const packPath = args.get("pack");
	if (packPath === "-") {
		process.stdout.write(packText);
	} else {
		writeFileSync(packPath, packText);
		const packHash = Buffer.from(await subtle.digest("SHA-256", Buffer.from(packText))).toString("hex");
		console.error(`wrote ${packPath}`);
		console.error(`pack sha256 (give this out-of-band with the passcode): ${packHash}`);
	}
} else {
	process.stdout.write(packText);
}
