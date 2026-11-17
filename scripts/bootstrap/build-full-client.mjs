#!/usr/bin/env node
// Assemble the TabTop desktop (+ tunnel) offline client as a tabtop-pack/v1
// tree for tabtopd to embed (bootstrap.client.json). tabtopd seals only
// tabtop.html from that tree (after ASSETS injection) daily with a fresh
// passcode for /auth/pack.
//
//   node scripts/bootstrap/build-full-client.mjs
//   node scripts/bootstrap/build-full-client.mjs --pass 'OOB_PASS' --out tabtopd/bootstrap.pack.json
//
// Versions match the Dockerfile's novnc / noble stages. Embed tree is JSON:
//   { "format": "tabtop-pack/v1", "name": "desktop", "files": { "path": "text"|{"base64":"..."} } }
// Optional --out seals tabtop.html bytes, not the whole tree.
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
import { dirname, join, relative, sep } from "node:path";
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

// The terminal's files, as the Dockerfile's terminal stage makes them (its
// versions and checksums read from there): ghostty-web's module and the
// stub it imports, and JetBrains Mono Nerd Font (NL Mono), regular and
// bold, as WOFF2 where woff2_compress or Python's fontTools can make it,
// else as the TrueType it comes as (tty/index.html is told which).
const dockerArg = (name) => {
	const m = new RegExp(`^ARG ${name}=(\\S+)$`, "m").exec(readFileSync(join(repoRoot, "Dockerfile"), "utf8"));
	if (!m) throw new Error(`the Dockerfile has no ARG ${name}`);
	return m[1];
};
const GHOSTTY_STUB = "__vite-browser-external-2447137e.js";
async function ensureTerminal(dir) {
	const ghostty = dockerArg("GHOSTTY_WEB_VERSION"), fonts = dockerArg("NERD_FONTS_VERSION");
	const stamp = join(dir, `.terminal-${ghostty}-${fonts}`);
	if (existsSync(stamp)) return;
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const fetchChecked = async (url, dest, sha) => {
		if (!existsSync(dest) || await sha256File(dest) !== sha) {
			console.error(`fetch ${url}`);
			await fetchTo(url, dest);
		}
		const hex = await sha256File(dest);
		if (hex !== sha) throw new Error(`${url}: sha256 ${hex}, want ${sha}`);
	};
	const tgz = join(work, `ghostty-web-${ghostty}.tgz`);
	await fetchChecked(`https://registry.npmjs.org/ghostty-web/-/ghostty-web-${ghostty}.tgz`, tgz, dockerArg("GHOSTTY_WEB_SHA256"));
	const src = join(work, "ghostty-src");
	rmSync(src, { recursive: true, force: true });
	mkdirSync(src, { recursive: true });
	execFileSync("tar", ["-xzf", tgz, "-C", src, "--strip-components=1"]);
	if (!readFileSync(join(src, "dist/ghostty-web.js"), "utf8").includes(GHOSTTY_STUB)) throw new Error(`ghostty-web ${ghostty} no longer imports ${GHOSTTY_STUB}`);
	for (const f of ["ghostty-web.js", GHOSTTY_STUB]) cpSync(join(src, "dist", f), join(dir, f));
	cpSync(join(src, "LICENSE"), join(dir, "LICENSE.ghostty-web"));
	const xz = join(work, `JetBrainsMono-${fonts}.tar.xz`);
	await fetchChecked(`https://github.com/ryanoasis/nerd-fonts/releases/download/${fonts}/JetBrainsMono.tar.xz`, xz, dockerArg("NERD_FONT_SHA256"));
	const fontSrc = join(work, "font-src");
	rmSync(fontSrc, { recursive: true, force: true });
	mkdirSync(fontSrc, { recursive: true });
	execFileSync("tar", ["-xJf", xz, "-C", fontSrc, "JetBrainsMonoNLNerdFontMono-Regular.ttf", "JetBrainsMonoNLNerdFontMono-Bold.ttf", "OFL.txt"]);
	cpSync(join(fontSrc, "OFL.txt"), join(dir, "LICENSE.jetbrains-mono-nerd-font"));
	for (const w of ["Regular", "Bold"]) {
		const ttf = join(fontSrc, `JetBrainsMonoNLNerdFontMono-${w}.ttf`), woff2 = join(dir, `JetBrainsMonoNerdFont-${w}.woff2`);
		try {
			execFileSync("woff2_compress", [ttf], { stdio: "ignore" });
			cpSync(ttf.replace(/\.ttf$/, ".woff2"), woff2);
		} catch {
			try {
				execFileSync("python3", ["-I", "-c", "import sys; from fontTools.ttLib import woff2; woff2.compress(sys.argv[1], sys.argv[2])", ttf, woff2], { stdio: "ignore" });
			} catch {
				console.error(`no woff2_compress or fontTools: the terminal's ${w} font is TrueType`);
				cpSync(ttf, join(dir, `JetBrainsMonoNerdFont-${w}.ttf`));
			}
		}
	}
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
const terminalDir = join(work, "terminal");
if (!args.has("skip-fetch")) {
	await ensureNovnc(novncDir);
	await ensureNoble(nobleDir);
	await ensureTerminal(terminalDir);
} else if (!existsSync(join(novncDir, "vnc.html")) || !existsSync(nobleDir) || !existsSync(join(terminalDir, "ghostty-web.js"))) {
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
// The desktop's stylesheet, as the gateway serves it at tabtop/desktop.css
// (styles.go's desktopCSS): novnc.js links it; the client has it itself.
writeFileSync(join(stage, "tabtop", "desktop.css"),
	["desktop-base.css", "transfers.css", "desktop-notices.css"].map((f) => readFileSync(join(tabtopd, f), "utf8")).join(""));

// The terminal (tty/), as the gateway serves it at /tty/: its page, with
// its fonts' names as they are here, its script, and ghostty-web's.
mkdirSync(join(stage, "tty"), { recursive: true });
{
	let page = readFileSync(join(tabtopd, "tty.html"), "utf8");
	for (const w of ["Regular", "Bold"]) {
		if (existsSync(join(terminalDir, `JetBrainsMonoNerdFont-${w}.ttf`))) {
			page = page.replace(`url("JetBrainsMonoNerdFont-${w}.woff2") format("woff2")`, `url("JetBrainsMonoNerdFont-${w}.ttf") format("truetype")`);
		}
	}
	writeFileSync(join(stage, "tty", "index.html"), page);
	cpSync(join(tabtopd, "tty.js"), join(stage, "tty", "tty.js"));
	copyTree(terminalDir, join(stage, "tty"));
}
// The files page (fs/), as the gateway serves it at /fs/ (filesPage, with
// styles.go's pageHead).
mkdirSync(join(stage, "fs"), { recursive: true });
writeFileSync(join(stage, "fs", "index.html"), '<!doctype html><html lang="en"><meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<style>' +
	["files.css", "transfers.css", "highlight.css"].map((f) => readFileSync(join(tabtopd, f), "utf8")).join("") +
	'</style>\n<title>Downloads</title><body>\n<p>Loading…</p>\n<script type="module" src="../tabtop/files.js"></script>');
writeFileSync(join(stage, "tabtop", "files.js"), readFileSync(join(tabtopd, "files.js")));
// The previews' frames (the Markdown and HTML one, the book's, the PDF's),
// as the gateway serves them (page_assets.go's mdFrameHTML, epub.go's
// epubFrameHTML, pdf.go's pdfFrameHTML; TestOfflineFrames checks they're
// the same), and their scripts: the offline client builds each frame from
// them (file-launcher.mjs's frameHTML).
{
	const head = (title, css) => '<!doctype html><html lang="en"><meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
		`<title>${title}</title>\n<style>` + css.map((f) => readFileSync(join(tabtopd, f), "utf8")).join("") + "</style>\n";
	const frames = {
		"md-frame.html": head("Markdown", ["md-frame.css", "highlight.css"]) + '<main id="doc"></main>\n<script src="third-party/css-tree.js"></script><script src="preview-css.js"></script><script src="preview-html-links.js"></script><script src="preview-html-resources.js"></script><script src="md-frame.js"></script>\n',
		"epub-frame.html": head("Book", ["epub-frame.css"]) + '<div id="bar"></div><nav id="contents" hidden aria-label="Contents"></nav><main id="doc"></main><nav id="ends" aria-label="Chapters"></nav>\n<script src="epub-frame.js"></script>\n',
		"pdf-frame.html": head("PDF", ["pdf-frame.css"]) + '<div id="bar"></div><main id="pages"></main>\n<script src="pdf-frame.js"></script>\n',
	};
	for (const [name, html] of Object.entries(frames)) {
		writeFileSync(join(stage, "tabtop", name), html);
		for (const m of html.matchAll(/<script src="([^"]+)"><\/script>/g)) {
			mkdirSync(dirname(join(stage, "tabtop", m[1])), { recursive: true });
			cpSync(join(tabtopd, m[1]), join(stage, "tabtop", m[1]));
		}
	}
	for (const f of ["third-party/css-tree.LICENSE", "third-party/mdn-data.LICENSE", "third-party/source-map-js.LICENSE"]) cpSync(join(tabtopd, f), join(stage, "tabtop", f));
}

// The offline client's own page (components/): the viewers it fetches when
// needed, and what of them this browser keeps (see components.js).
mkdirSync(join(stage, "components"), { recursive: true });
writeFileSync(join(stage, "components", "index.html"), '<!doctype html><html lang="en"><meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<style>' +
	["files.css", "transfers.css"].map((f) => readFileSync(join(tabtopd, f), "utf8")).join("") +
	'.components-summary { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; } .components-table td { vertical-align: top; } .components-table td.act { white-space: nowrap; } .components-table td.act button + button { margin-left: .4rem; }' +
	'</style>\n<title>Offline components</title><body>\n<p>Loading…</p>\n<script type="module" src="components.js"></script>');
cpSync(join(__dirname, "components.js"), join(stage, "components", "components.js"));

// What the client's modules import, and what those import, all of it in
// the tree: TabTop's own modules (tabtop/…) brought from tabtopd as they're
// needed (desktopFiles names where it starts, not all it needs); any other
// that's missing fails the build, rather than a client that can't start.
// So are the workers, worklets and other files they name by new URL(…,
// import.meta.url) or importScripts(), and what they import dynamically;
// but those may be missing where they're a viewer's that the offline
// client leaves out (left), which it shows it hasn't (see preview-model.js's
// offlineOff) and never loads from the server (see file-launcher.mjs's csp).
const left = /^(three|pdfjs|highlight|preview|kaitai|disasm|demangle|background|segment|inpaint|stream)(\/|$)|^(md|pdf|epub)-frame\.html$|^((x86|riscv|mips)-asm|asm-common)\.js$/;
{
	const walkJS = (d) => readdirSync(d).flatMap((n) => {
		const p = join(d, n);
		return statSync(p).isDirectory() ? walkJS(p) : /\.m?js$/.test(n) ? [p] : [];
	});
	const importsOf = (code) => {
		// (Not what's in comments: "import … from" in a doc comment isn't one.)
		const bare = code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
		const out = [];
		for (const m of bare.matchAll(/\b(?:import|export)\s*(?:[\w$*\s{},]*?\s*from\s*)?(["'])([^"'\n]+)\1/g)) out.push({ spec: m[2], must: true });
		for (const m of bare.matchAll(/\bimport\s*\(\s*(["'])([^"'\n]+)\1\s*\)|\bnew\s+URL\s*\(\s*(["'])([^"'\n]+)\3\s*,\s*import\.meta\.url|\bimportScripts\s*\(\s*(["'])([^"'\n]+)\5/g)) {
			out.push({ spec: m[2] ?? m[4] ?? m[6], must: false });
		}
		return out.filter(({ spec }) => /^\.{1,2}\//.test(spec));
	};
	const queue = walkJS(stage), seen = new Set(queue), missing = [], leftOut = new Set();
	while (queue.length) {
		const file = queue.pop();
		for (const { spec, must } of importsOf(readFileSync(file, "utf8"))) {
			const target = join(dirname(file), spec.split(/[?#]/)[0]);
			if (existsSync(target)) continue;
			const rel = relative(join(stage, "tabtop"), target).split(sep).join("/");
			const own = join(tabtopd, rel);
			if (!must && left.test(rel)) leftOut.add(rel.replace(/\/.*/, (m) => "/"));
			else if (!rel.startsWith("..") && existsSync(own) && statSync(own).isFile()) {
				mkdirSync(dirname(target), { recursive: true });
				writeFileSync(target, readFileSync(own));
				if (/\.m?js$/.test(target) && !seen.has(target)) { seen.add(target); queue.push(target); }
			}
			// (The server's own addresses, above the client's files: the
			// tunnel's, new URL("../session", import.meta.url).)
			else if (!must && rel.startsWith("../") && !/\.\w+$/.test(rel)) continue;
			else missing.push(`${relative(stage, file)} ${must ? "imports" : "names"} ${spec}`);
		}
	}
	if (missing.length) throw new Error(`the client imports what isn't in it:\n  ${missing.join("\n  ")}`);
	console.error(`left out of the offline client: ${[...leftOut].sort().join(" ")}`);
}

// The disassemblers, all left out (x86's, ARM's and ARM64's files, and
// RISC-V's and MIPS's scripts), turned off as the gateway turns off those
// it hasn't (page_assets.go's disasmOffJS).
for (const f of ["hex-view.js", "disasm-worker.js"]) {
	const path = join(stage, "tabtop", f);
	if (!existsSync(path)) continue;
	const js = readFileSync(path, "utf8");
	if (!js.includes("const DISASM_OFF = [];")) throw new Error(`${f} no longer has "const DISASM_OFF = [];"`);
	writeFileSync(path, js.replace("const DISASM_OFF = [];", 'const DISASM_OFF = ["x86", "capstone", "arm64", "riscv", "mips"];'));
}

writeFileSync(join(stage, "README-OFFLINE-CLIENT.txt"), `TabTop offline client (${clientName})

Open tabtop.html (double-click: it runs as a file, its scripts from your
disk), enter the address you open TabTop at, and connect. (vnc.html can't
run as a file itself: browsers won't load modules from one file into
another; tabtop.html holds the whole tree, and loads it from blob: URLs.)

It has the desktop (vnc.html), the terminal (tty/), the files page (fs/),
and its own page of components (components/), which link to each other:
tabtop.html?page=terminal, ?page=files and ?page=components.
Syntax colouring, the disassemblers, Kaitai, the 3D viewer, pdf.js, KaTeX
and Mermaid, and the AI image tools are fetched through the tunnel when
first needed, checked against the SHA-256 the gateway wrote into
tabtop.html when it sealed the pack, and kept in the browser. The
previews' frames (Markdown and HTML, EPUB, PDF) are built from the
client's own files. Nothing else is loaded from the server: only the
tunnel connects to it.

Files under tabtop/ are the gateway's scripts; tabtop/noble/ is the crypto
the tunnel needs; tty/ has ghostty-web and JetBrains Mono Nerd Font (their
licences beside them). noVNC's app/, core/, and vendor/ are upstream.
`);

const files = collectFiles(stage);
console.error("building tabtop.html (file:// launcher)…");
const tabtopHTML = buildFileLauncherHTML(files);
files["tabtop.html"] = tabtopHTML;
const plaintextObj = {
	format: "tabtop-pack/v1",
	name: clientName,
	created: new Date().toISOString(),
	files,
};
const tree = Buffer.from(JSON.stringify(plaintextObj), "utf8");
const htmlBytes = Buffer.from(tabtopHTML, "utf8");
console.error(`tree: ${Object.keys(files).length} files, ${tree.length} bytes`);
console.error(`tabtop.html: ${htmlBytes.length} bytes (what /auth/pack seals)`);
console.error(`tabtop.html sha256: ${Buffer.from(await webcrypto.subtle.digest("SHA-256", htmlBytes)).toString("hex")}`);

// tabtopd embeds the tree and seals only tabtop.html daily with a fresh passcode.
const clientPath = args.get("plain-out") || join(tabtopd, "bootstrap.client.json");
mkdirSync(dirname(clientPath), { recursive: true });
writeFileSync(clientPath, tree);
console.error(`wrote ${clientPath} (${tree.length} bytes)`);

if (outPath) {
	const pack = await seal(htmlBytes, pass);
	const packText = JSON.stringify(pack) + "\n";
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, packText);
	const packHash = Buffer.from(await webcrypto.subtle.digest("SHA-256", Buffer.from(packText))).toString("hex");
	console.error(`wrote ${outPath} (${packText.length} bytes)`);
	console.error(`pack sha256 (give OOB with the passcode): ${packHash}`);
} else {
	console.error("skip sealed pack (tabtopd reseals tabtop.html from bootstrap.client.json daily)");
}
