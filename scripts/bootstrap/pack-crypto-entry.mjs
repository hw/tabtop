// Entry for pack-crypto.iife.js (noble PBKDF2 + AES-GCM). Regenerate with:
//   npm install --no-save esbuild @noble/ciphers@2.4.0 @noble/hashes@2.4.0
//   npx esbuild pack-crypto-entry.mjs --bundle --format=iife --global-name=TabTopPackCrypto --outfile=pack-crypto.iife.js
import { gcm } from "@noble/ciphers/aes.js";
import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";

/** PBKDF2-SHA-256 + AES-256-GCM decrypt (same params as seal / WebCrypto). */
export function decryptPack(pass, salt, iterations, iv, ct) {
	const key = pbkdf2(sha256, pass, salt, { c: iterations, dkLen: 32 });
	return gcm(key, iv).decrypt(ct);
}

export function sha256Hex(data) {
	const dig = sha256(data instanceof Uint8Array ? data : new Uint8Array(data));
	return [...dig].map((b) => b.toString(16).padStart(2, "0")).join("");
}
