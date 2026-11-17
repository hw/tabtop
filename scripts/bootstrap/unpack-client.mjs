#!/usr/bin/env node
// Expand a decrypted tabtop-pack/v1 JSON tree onto disk.
//
//   node scripts/bootstrap/unpack-client.mjs --in desktop.json --out ./client
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

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
if (client.format !== "tabtop-pack/v1" || !client.files) {
	throw new Error("not a tabtop-pack/v1 JSON tree");
}
let n = 0;
for (const [rel, body] of Object.entries(client.files)) {
	// (Inside outDir only: a pack's "../x" or "/etc/x" isn't written.)
	const dest = resolve(outDir, rel);
	if (!dest.startsWith(resolve(outDir) + sep)) throw new Error(`refusing to write ${JSON.stringify(rel)}: it's outside ${outDir}`);
	mkdirSync(dirname(dest), { recursive: true });
	if (body && typeof body === "object" && typeof body.base64 === "string") {
		writeFileSync(dest, Buffer.from(body.base64, "base64"));
	} else {
		writeFileSync(dest, String(body), "utf8");
	}
	n++;
}
console.error(`wrote ${n} files to ${outDir}/ (open tabtop.html)`);
