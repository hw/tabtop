#!/usr/bin/env node
// Expand a decrypted tabtop-client/v1 JSON tree onto disk.
//
//   node scripts/bootstrap/unpack-client.mjs --in desktop.json --out ./client
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
	const a = process.argv[i];
	if (a === "--in" || a === "--out") args.set(a.slice(2), process.argv[++i]);
	else throw new Error(`unknown arg ${a}`);
}
const inPath = args.get("in");
const outDir = args.get("out") || "client";
if (!inPath) throw new Error("need --in <tabtop-client.json>");

const client = JSON.parse(readFileSync(inPath, "utf8"));
if (client.format !== "tabtop-client/v1" || !client.files) {
	throw new Error("not a tabtop-client/v1 JSON tree");
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
console.error(`wrote ${n} files to ${outDir}/ (entry ${client.entry || "vnc.html"})`);
