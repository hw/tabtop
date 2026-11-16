#!/usr/bin/env node
// Assemble tabtopd/bootstrap.html from decode.template.html + pack-crypto.iife.js.
//
//   node scripts/bootstrap/build-decoder.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(join(dir, "decode.template.html"), "utf8");
const crypto = readFileSync(join(dir, "pack-crypto.iife.js"), "utf8");
if (!template.includes("/*PACK_CRYPTO_FALLBACK*/")) {
	throw new Error("decode.template.html needs /*PACK_CRYPTO_FALLBACK*/");
}
const html = template.replace("/*PACK_CRYPTO_FALLBACK*/", () => crypto);
const outProto = join(dir, "decode.html");
const outEmbed = join(dir, "../../tabtopd/bootstrap.html");
writeFileSync(outProto, html);
writeFileSync(outEmbed, html);
console.error(`wrote ${outProto} and ${outEmbed} (${html.length} bytes)`);
