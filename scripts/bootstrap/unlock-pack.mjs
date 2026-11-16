#!/usr/bin/env node
// Decrypt a /bootstrap/pack JSON object and expand the client onto disk.
// No browser required (uses Node's WebCrypto).
//
//   node scripts/bootstrap/unlock-pack.mjs --pass 'OOB_PASS' --pack tabtop-client.pack.json --out ./client
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
const outDir = args.get("out") || "client";
if (!pass) throw new Error("need --pass");
if (!packPath) throw new Error("need --pack <tabtop-client.pack.json>");

const text = readFileSync(packPath, "utf8").replace(/^\uFEFF/, "").trim();
let pack;
if (text.startsWith("{")) {
	pack = JSON.parse(text);
} else {
	pack = JSON.parse(Buffer.from(text.replace(/\s+/g, ""), "base64").toString("utf8"));
}
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

if (args.has("plain-out")) {
	writeFileSync(args.get("plain-out"), plain);
	console.error(`wrote plaintext ${args.get("plain-out")} (${plain.length} bytes)`);
}

const client = JSON.parse(plain.toString("utf8"));
if (client.format !== "tabtop-client/v1" || !client.files) {
	throw new Error("plaintext is not a tabtop-client/v1 tree (refusing to unpack)");
}

let n = 0;
for (const [rel, body] of Object.entries(client.files)) {
	const dest = join(outDir, rel);
	mkdirSync(dirname(dest), { recursive: true });
	if (body && typeof body === "object" && typeof body.base64 === "string") {
		writeFileSync(dest, Buffer.from(body.base64, "base64"));
	} else {
		writeFileSync(dest, String(body), "utf8");
	}
	n++;
}
console.error(`unlocked ${client.name || "client"}: ${n} files → ${outDir}/`);
console.error(`entry: ${join(outDir, client.entry || "vnc.html")}`);
console.error(`plaintext sha256: ${Buffer.from(await subtle.digest("SHA-256", plain)).toString("hex")}`);
