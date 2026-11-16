#!/usr/bin/env node
// Assemble the TabTop desktop (+ tunnel) local client as plaintext JSON for
// tabtopd to embed (bootstrap.client.json). tabtopd reseals it daily with a
// fresh passcode for /auth/pack.
//
//   node scripts/bootstrap/build-full-client.mjs
//   node scripts/bootstrap/build-full-client.mjs --pass 'OOB_PASS' --out tabtopd/bootstrap.pack.json
//
// Versions match the Dockerfile's novnc / noble stages. Plaintext is JSON:
//   { "format": "tabtop-client/v1", "name": "desktop", "files": { "path": "text"|{"base64":"..."} } }
import {
	createWriteStream,
	mkdirSync,
	readFileSync,
	writeFileSync,
	cpSync,
	rmSync,
	existsSync,
	readdirSync,
	statSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { execFileSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import { Readable } from "node:stream";
import { buildFileLauncherHTML } from "./file-launcher.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../..");
const tabtopd = join(repoRoot, "tabtopd");

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
	const a = process.argv[i];
	if (a === "--pass" || a === "--out" || a === "--work" || a === "--novnc-version" || a === "--name" || a === "--plain-out") {
		args.set(a.slice(2), process.argv[++i]);
	} else if (a === "--skip-fetch") {
		args.set("skip-fetch", true);
	} else {
		throw new Error(`unknown arg ${a}`);
	}
}
const pass = args.get("pass");
const outPath = args.get("out") || (pass ? join(tabtopd, "bootstrap.pack.json") : "");
if (outPath && !pass) throw new Error("need --pass to write a sealed pack (--out)");
const work = args.get("work") || join(__dirname, ".client-build");
const novncVersion = args.get("novnc-version") || "1.7.0";
const clientName = args.get("name") || "desktop";

const NOBLE = {
	ciphers: { ver: "2.4.0", sha: "4a398bcc280c8742d474f9162f6d3c153e52ab1078e8ab592b4720410fb3c3e9" },
	curves: { ver: "2.4.0", sha: "55279c71b0201d6c0e58d0206d15825359e02a3932f326ba7b7909ac2d334aa9" },
	hashes: { ver: "2.4.0", sha: "e1946149b780017b2564fcc092cb01c04e1d7f20627d0296c17da8868f4436dc" },
};
const nobleFiles = [
	"ciphers/chacha.js", "ciphers/_arx.js", "ciphers/_poly1305.js", "ciphers/utils.js",
	"curves/ed25519.js", "curves/utils.js",
	"curves/abstract/curve.js", "curves/abstract/edwards.js", "curves/abstract/fft.js",
	"curves/abstract/frost.js", "curves/abstract/hash-to-curve.js", "curves/abstract/modular.js",
	"curves/abstract/montgomery.js", "curves/abstract/oprf.js",
	"hashes/sha2.js", "hashes/_md.js", "hashes/_u64.js", "hashes/hkdf.js", "hashes/hmac.js", "hashes/utils.js",
];

const desktopFiles = [
	"novnc.js", "desktop-base.css", "desktop-notices.css",
	"audio.js", "mic-worklet.js", "media-stream.js", "video-stream.js",
	"media-source.js", "stream-worker.js",
	"download.js", "download-sw.js",
	"tunnel.js", "tunnel-crypto.js", "tunnel-protocol.js",
	"session.js", "session-state.js", "stored.js", "login-ui.js", "glyphs.js", "preview-dom.js",
	"remote-auth-view.js", "third-party/qrcodegen.js",
	"reconnect.js", "expiry.js", "requests.js",
];

async function fetchTo(url, dest) {
	mkdirSync(dirname(dest), { recursive: true });
	const res = await fetch(url);
	if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
	await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

async function sha256File(path) {
	const buf = readFileSync(path);
	const dig = await webcrypto.subtle.digest("SHA-256", buf);
	return Buffer.from(dig).toString("hex");
}

async function ensureNovnc(dir) {
	const stamp = join(dir, `.novnc-${novncVersion}`);
	if (existsSync(stamp) && existsSync(join(dir, "vnc.html"))) return;
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const tar = join(work, `novnc-${novncVersion}.tar.gz`);
	const url = `https://github.com/novnc/noVNC/archive/refs/tags/v${novncVersion}.tar.gz`;
	console.error(`fetch ${url}`);
	await fetchTo(url, tar);
	execFileSync("tar", [
		"-xzf", tar, "-C", dir, "--strip-components=1",
		`noVNC-${novncVersion}/app`, `noVNC-${novncVersion}/core`, `noVNC-${novncVersion}/vendor`,
		`noVNC-${novncVersion}/vnc.html`, `noVNC-${novncVersion}/vnc_lite.html`,
		`noVNC-${novncVersion}/defaults.json`, `noVNC-${novncVersion}/mandatory.json`,
		`noVNC-${novncVersion}/package.json`, `noVNC-${novncVersion}/LICENSE.txt`,
	]);
	let html = readFileSync(join(dir, "vnc.html"), "utf8");
	if (!html.includes('src="tabtop/audio.js"')) {
		html = html.replace("</head>", '    <script type="module" src="tabtop/audio.js"></script>\n</head>');
	}
	if (!html.includes('src="tabtop/novnc.js"')) {
		html = html.replace('<script type="module"', '<script type="module" src="tabtop/novnc.js"></script>\n    <script type="module"');
	}
	writeFileSync(join(dir, "vnc.html"), html);
	let ui = readFileSync(join(dir, "app/ui.js"), "utf8");
	ui = ui.replace(/^(\s*)url\.href,$/m, "$1window.tabtopChannel ? window.tabtopChannel() : url.href,");
	writeFileSync(join(dir, "app/ui.js"), ui);
	writeFileSync(stamp, "ok\n");
}

async function ensureNoble(dir) {
	const stamp = join(dir, ".noble-ok");
	if (existsSync(stamp)) return;
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const src = join(work, "noble-src");
	rmSync(src, { recursive: true, force: true });
	mkdirSync(src, { recursive: true });
	for (const [name, meta] of Object.entries(NOBLE)) {
		const tar = join(work, `${name}-${meta.ver}.tgz`);
		const url = `https://registry.npmjs.org/@noble/${name}/-/${name}-${meta.ver}.tgz`;
		console.error(`fetch ${url}`);
		await fetchTo(url, tar);
		const hex = await sha256File(tar);
		if (hex !== meta.sha) throw new Error(`${name} sha256 ${hex}, want ${meta.sha}`);
		mkdirSync(join(src, name), { recursive: true });
		execFileSync("tar", ["-xzf", tar, "-C", join(src, name), "--strip-components=1"]);
	}
	for (const f of nobleFiles) {
		const dest = join(dir, f);
		mkdirSync(dirname(dest), { recursive: true });
		cpSync(join(src, f), dest);
	}
	for (const lic of ["ciphers", "curves", "hashes"]) {
		cpSync(join(src, lic, "LICENSE"), join(dir, `LICENSE.noble-${lic}`));
	}
	execFileSync("sed", ["-i", "s#from '@noble/hashes/#from '../hashes/#", ...["ed25519.js", "utils.js"].map((f) => join(dir, "curves", f))]);
	const abs = nobleFiles.filter((f) => f.startsWith("curves/abstract/")).map((f) => join(dir, f));
	if (abs.length) execFileSync("sed", ["-i", "s#from '@noble/hashes/#from '../../hashes/#", ...abs]);
	writeFileSync(stamp, "ok\n");
}

function collectFiles(root) {
	const out = {};
	const walk = (dir) => {
		for (const ent of readdirSync(dir).sort()) {
			if (ent.startsWith(".")) continue;
			const p = join(dir, ent);
			const s = statSync(p);
			if (s.isDirectory()) {
				walk(p);
				continue;
			}
			if (!s.isFile()) continue;
			const rel = relative(root, p).split("\\").join("/");
			const buf = readFileSync(p);
			const text = buf.toString("utf8");
			if (Buffer.from(text, "utf8").equals(buf) && !/\.(png|jpe?g|gif|webp|wasm|bin)$/i.test(rel)) {
				out[rel] = text;
			} else {
				out[rel] = { base64: buf.toString("base64") };
			}
		}
	};
	walk(root);
	return out;
}

async function seal(plainBytes, passcode) {
	const subtle = webcrypto.subtle;
	const salt = webcrypto.getRandomValues(new Uint8Array(16));
	const iv = webcrypto.getRandomValues(new Uint8Array(12));
	const baseKey = await subtle.importKey("raw", new TextEncoder().encode(passcode), "PBKDF2", false, ["deriveKey"]);
	const key = await subtle.deriveKey(
		{ name: "PBKDF2", salt, iterations: 210_000, hash: "SHA-256" },
		baseKey,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt"],
	);
	const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key, plainBytes));
	const b64 = (u8) => Buffer.from(u8).toString("base64");
	return {
		v: 1,
		kdf: "PBKDF2-SHA256",
		iter: 210000,
		salt: b64(salt),
		iv: b64(iv),
		ct: b64(ct),
	};
}

function copyTree(src, dest) {
	mkdirSync(dest, { recursive: true });
	cpSync(src, dest, {
		recursive: true,
		filter: (p) => !relative(src, p).split(/[\\/]/).some((part) => part.startsWith(".")),
	});
}

mkdirSync(work, { recursive: true });
const stage = join(work, "stage");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

const novncDir = join(work, "novnc");
const nobleDir = join(work, "noble");
if (!args.has("skip-fetch")) {
	await ensureNovnc(novncDir);
	await ensureNoble(nobleDir);
} else if (!existsSync(join(novncDir, "vnc.html")) || !existsSync(nobleDir)) {
	throw new Error("--skip-fetch needs a prior build in --work");
}

copyTree(novncDir, stage);
mkdirSync(join(stage, "tabtop"), { recursive: true });
for (const f of desktopFiles) {
	const src = join(tabtopd, f);
	if (!existsSync(src)) throw new Error(`missing ${src}`);
	mkdirSync(dirname(join(stage, "tabtop", f)), { recursive: true });
	writeFileSync(join(stage, "tabtop", f), readFileSync(src));
}
copyTree(nobleDir, join(stage, "tabtop", "noble"));

writeFileSync(join(stage, "README-LOCAL-CLIENT.txt"), `TabTop local desktop client (${clientName})

Open tabtop-local.html (double-click / file://). Chrome blocks ES modules in
plain vnc.html on file://; tabtop-local.html embeds the tree and loads it via
blob URLs. Point the gateway at your TabTop server when logging in.

Files under tabtop/ are the gateway's desktop + E2E tunnel scripts; tabtop/noble/
is the crypto the tunnel needs. noVNC's app/, core/, and vendor/ are upstream.
`);

const files = collectFiles(stage);
console.error("building tabtop-local.html (file:// launcher)…");
files["tabtop-local.html"] = buildFileLauncherHTML(files);
const plaintextObj = {
	format: "tabtop-client/v1",
	name: clientName,
	created: new Date().toISOString(),
	entry: "tabtop-local.html",
	files,
};
const plain = Buffer.from(JSON.stringify(plaintextObj), "utf8");
console.error(`plaintext: ${Object.keys(files).length} files, ${plain.length} bytes`);
console.error(`plaintext sha256: ${Buffer.from(await webcrypto.subtle.digest("SHA-256", plain)).toString("hex")}`);

// tabtopd embeds the plaintext and reseals it daily with a fresh passcode.
const clientPath = args.get("plain-out") || join(tabtopd, "bootstrap.client.json");
mkdirSync(dirname(clientPath), { recursive: true });
writeFileSync(clientPath, plain);
console.error(`wrote ${clientPath} (${plain.length} bytes)`);

if (outPath) {
	const pack = await seal(plain, pass);
	const packText = JSON.stringify(pack) + "\n";
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, packText);
	const packHash = Buffer.from(await webcrypto.subtle.digest("SHA-256", Buffer.from(packText))).toString("hex");
	console.error(`wrote ${outPath} (${packText.length} bytes)`);
	console.error(`pack sha256 (give OOB with the passcode): ${packHash}`);
} else {
	console.error("skip sealed pack (tabtopd reseals bootstrap.client.json daily)");
}
