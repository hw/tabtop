#!/usr/bin/env node
// Write tabtopd/bootstrap.html (and decode.html, beside this) from
// decode.template.html. The page decrypts with the browser's WebCrypto
// only: there's no JavaScript fallback inlined in it.
//
//   node scripts/bootstrap/build-decoder.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(dir, "decode.template.html"), "utf8");
const outProto = join(dir, "decode.html");
const outEmbed = join(dir, "../../tabtopd/bootstrap.html");
writeFileSync(outProto, html);
writeFileSync(outEmbed, html);
console.error(`wrote ${outProto} and ${outEmbed} (${html.length} bytes)`);
