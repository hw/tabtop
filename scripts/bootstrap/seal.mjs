#!/usr/bin/env node
// Seal a UTF-8 payload for the local decoder (PBKDF2-SHA-256 + AES-GCM).
//
//   node seal.mjs --pass 'YOUR_OOB_PASS' --in payload.demo.html --out decode.html
//   node seal.mjs --pass 'YOUR_OOB_PASS' --in payload.demo.html --pack demo.pack
//   node seal.mjs --pass 'x' --text 'hello'          # prints PACK= base64 line
import { readFileSync, writeFileSync } from "node:fs";
import { webcrypto } from "node:crypto";

const subtle = webcrypto.subtle;
const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--pass" || a === "--in" || a === "--out" || a === "--text" || a === "--template" || a === "--pack") {
        args.set(a.slice(2), process.argv[++i]);
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
const pack = b64(new TextEncoder().encode(JSON.stringify(packObj)));

console.error(`plaintext sha256: ${Buffer.from(await subtle.digest("SHA-256", plain)).toString("hex")}`);
console.error(`PACK length: ${pack.length} chars`);

if (args.has("pack")) {
    const packPath = args.get("pack");
    writeFileSync(packPath, pack + "\n");
    const packHash = Buffer.from(await subtle.digest("SHA-256", Buffer.from(pack + "\n"))).toString("hex");
    console.error(`wrote ${packPath}`);
    console.error(`pack sha256 (give this out-of-band with the passcode): ${packHash}`);
}

if (!args.has("out") && !args.has("template") && !args.has("pack")) {
    console.log(pack);
    process.exit(0);
}

if (args.has("out") || args.has("template")) {
    const templatePath = args.get("template") || new URL("./decode.template.html", import.meta.url);
    const outPath = args.get("out") || new URL("./decode.html", import.meta.url);
    let html = readFileSync(templatePath, "utf8");
    if (!html.includes("/*PACK*/")) throw new Error("template needs /*PACK*/ placeholder");
    html = html.replace("/*PACK*/", () => pack);
    writeFileSync(outPath, html);
    const fileHash = Buffer.from(await subtle.digest("SHA-256", Buffer.from(html))).toString("hex");
    console.error(`wrote ${outPath}`);
    console.error(`decoder sha256 (give this out-of-band with the passcode): ${fileHash}`);
}