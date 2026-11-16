#!/usr/bin/env node
// Build a single HTML file that runs the TabTop desktop client from file://.
// Chrome blocks ES module loads between local files; this page embeds the tree,
// rewrites imports to tabtop-local/… keys, and loads them from blob: URLs via
// an import map.
//
//   import { buildFileLauncherHTML } from "./file-launcher.mjs";

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

function resolvePath(from, spec) {
	if (/^(blob:|data:|https?:|chrome:)/i.test(spec)) return null;
	let path = spec;
	if (spec.startsWith("/")) {
		path = spec.replace(/^\/+/, "");
	} else {
		const base = from.includes("/") ? from.slice(0, from.lastIndexOf("/") + 1) : "";
		const parts = (base + spec).split("/");
		const out = [];
		for (const p of parts) {
			if (!p || p === ".") continue;
			if (p === "..") out.pop();
			else out.push(p);
		}
		path = out.join("/");
	}
	return path.replace(/\\/g, "/");
}

function virt(path) {
	return "tabtop-local/" + path.replace(/^\/+/, "");
}

function rewriteJS(code, fromPath, assetURL) {
	const quote = (spec) => {
		const resolved = resolvePath(fromPath, spec);
		if (!resolved) return JSON.stringify(spec);
		if (/\.(js|mjs)$/i.test(resolved)) return JSON.stringify(virt(resolved));
		const u = assetURL(resolved);
		return JSON.stringify(u || spec);
	};
	let out = code;
	out = out.replace(/(\b(?:import|export)\s*(?:[^'"\n]*?\sfrom\s*)?)(['"])([^'"]+)\2/g, (m, pre, _q, spec) => {
		if (/\bimport\s*\(/i.test(m)) return m;
		return pre + quote(spec);
	});
	out = out.replace(/\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g, (_m, _q, spec) => "import(" + quote(spec) + ")");
	out = out.replace(/new\s+URL\s*\(\s*(['"])([^'"]+)\1\s*,\s*import\.meta\.url\s*\)/g, (m, _q, spec) => {
		const resolved = resolvePath(fromPath, spec);
		if (!resolved) return m;
		if (/\.(js|mjs)$/i.test(resolved)) return JSON.stringify(virt(resolved));
		const u = assetURL(resolved);
		return u ? JSON.stringify(u) : m;
	});
	return out;
}

function mimeOf(path) {
	if (/\.css$/i.test(path)) return "text/css";
	if (/\.html?$/i.test(path)) return "text/html";
	if (/\.json$/i.test(path)) return "application/json";
	if (/\.svg$/i.test(path)) return "image/svg+xml";
	if (/\.png$/i.test(path)) return "image/png";
	if (/\.jpe?g$/i.test(path)) return "image/jpeg";
	if (/\.gif$/i.test(path)) return "image/gif";
	if (/\.ico$/i.test(path)) return "image/x-icon";
	if (/\.woff2?$/i.test(path)) return "font/woff2";
	if (/\.mjs$/i.test(path) || /\.js$/i.test(path)) return "text/javascript";
	return "application/octet-stream";
}

/** @param {Record<string, string | { base64: string } | Uint8Array>} files */
export function buildFileLauncherHTML(files) {
	const text = {};
	const bin = {};
	for (const [path, body] of Object.entries(files)) {
		const rel = path.replace(/^\/+/, "").replace(/\\/g, "/");
		if (!rel || rel === "tabtop-local.html") continue;
		if (typeof body === "string") text[rel] = body;
		else if (body && typeof body === "object" && typeof body.base64 === "string") bin[rel] = body.base64;
		else if (typeof Buffer !== "undefined" && body instanceof Uint8Array) bin[rel] = Buffer.from(body).toString("base64");
		else if (body instanceof Uint8Array) {
			let s = "";
			for (let i = 0; i < body.length; i++) s += String.fromCharCode(body[i]);
			bin[rel] = btoa(s);
		} else text[rel] = String(body ?? "");
	}
	if (!text["vnc.html"]) throw new Error("client tree is missing vnc.html");

	const payload = JSON.stringify({ text, bin });
	// Browser runtime (kept as one template; PAYLOAD injected).
	const runtime = `
const PAYLOAD = ${payload};
const boot = document.getElementById("boot");
const errEl = document.getElementById("err");
function fail(e) {
  console.error(e);
  errEl.hidden = false;
  errEl.textContent = String(e && e.stack || e);
  boot.textContent = "Failed to start.";
}
function b64ToU8(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function resolvePath(from, spec) {
  if (/^(blob:|data:|https?:|chrome:)/i.test(spec)) return null;
  let path = spec;
  if (spec.startsWith("/")) path = spec.replace(/^\\/+/, "");
  else {
    const base = from.includes("/") ? from.slice(0, from.lastIndexOf("/") + 1) : "";
    const parts = (base + spec).split("/");
    const out = [];
    for (const p of parts) {
      if (!p || p === ".") continue;
      if (p === "..") out.pop();
      else out.push(p);
    }
    path = out.join("/");
  }
  return path.replace(/\\\\/g, "/");
}
function virt(path) { return "tabtop-local/" + path.replace(/^\\/+/, ""); }
function mimeOf(path) {
  if (/\\.css$/i.test(path)) return "text/css";
  if (/\\.html?$/i.test(path)) return "text/html";
  if (/\\.json$/i.test(path)) return "application/json";
  if (/\\.svg$/i.test(path)) return "image/svg+xml";
  if (/\\.png$/i.test(path)) return "image/png";
  if (/\\.jpe?g$/i.test(path)) return "image/jpeg";
  if (/\\.gif$/i.test(path)) return "image/gif";
  if (/\\.ico$/i.test(path)) return "image/x-icon";
  if (/\\.woff2?$/i.test(path)) return "font/woff2";
  if (/\\.mjs$/i.test(path) || /\\.js$/i.test(path)) return "text/javascript";
  return "application/octet-stream";
}
const text = { ...PAYLOAD.text };
const bin = { ...PAYLOAD.bin };
const assetURLs = new Map();
function bytesFor(path) {
  if (Object.hasOwn(text, path)) return new TextEncoder().encode(text[path]);
  if (Object.hasOwn(bin, path)) return b64ToU8(bin[path]);
  return null;
}
function ensureAssetURL(path) {
  if (assetURLs.has(path)) return assetURLs.get(path);
  const data = bytesFor(path);
  if (!data) return null;
  const url = URL.createObjectURL(new Blob([data], { type: mimeOf(path) }));
  assetURLs.set(path, url);
  return url;
}
function rewriteJS(code, fromPath) {
  const quote = (spec) => {
    const resolved = resolvePath(fromPath, spec);
    if (!resolved) return JSON.stringify(spec);
    if (/\\.(js|mjs)$/i.test(resolved)) return JSON.stringify(virt(resolved));
    const u = ensureAssetURL(resolved);
    return JSON.stringify(u || spec);
  };
  let out = code;
  out = out.replace(/(\\b(?:import|export)\\s*(?:[^'"\\n]*?\\sfrom\\s*)?)(['"])([^'"]+)\\2/g, (m, pre, q, spec) => {
    if (/\\bimport\\s*\\(/i.test(m)) return m;
    return pre + quote(spec);
  });
  out = out.replace(/\\bimport\\s*\\(\\s*(['"])([^'"]+)\\1\\s*\\)/g, (m, q, spec) => "import(" + quote(spec) + ")");
  out = out.replace(/new\\s+URL\\s*\\(\\s*(['"])([^'"]+)\\1\\s*,\\s*import\\.meta\\.url\\s*\\)/g, (m, q, spec) => {
    const resolved = resolvePath(fromPath, spec);
    if (!resolved) return m;
    if (/\\.(js|mjs)$/i.test(resolved)) return JSON.stringify(virt(resolved));
    const u = ensureAssetURL(resolved);
    return u ? JSON.stringify(u) : m;
  });
  return out;
}
function jsSource(path) {
  if (Object.hasOwn(text, path)) return text[path];
  if (Object.hasOwn(bin, path)) return new TextDecoder().decode(b64ToU8(bin[path]));
  return null;
}
const imports = {};
for (const path of Object.keys({ ...text, ...bin })) {
  if (!/\\.(js|mjs)$/i.test(path)) continue;
  const src = jsSource(path);
  if (src == null) continue;
  const rewritten = rewriteJS(src, path);
  const url = URL.createObjectURL(new Blob([rewritten], { type: "text/javascript" }));
  imports[virt(path)] = url;
}
const importMapTag = "<script type=\\"importmap\\">" + JSON.stringify({ imports }) + "</script>";

const realFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  try {
    const raw = typeof input === "string" ? input : input && input.url;
    if (typeof raw === "string" && !/^(blob:|data:|https?:)/i.test(raw)) {
      const path = resolvePath("", raw.replace(/^\\.\\//, "")) || raw.replace(/^\\.\\//, "");
      const data = bytesFor(path);
      if (data) return Promise.resolve(new Response(data, { status: 200, headers: { "Content-Type": mimeOf(path) } }));
    }
  } catch (_) {}
  return realFetch(input, init);
};

function rewriteHTML(html) {
  let out = html;
  out = out.replace(/<link\\b([^>]*?)href=(['"])([^'"]+)\\2([^>]*)>/gi, (m, pre, q, href, post) => {
    const path = resolvePath("vnc.html", href);
    const u = path && ensureAssetURL(path);
    return u ? "<link" + pre + "href=" + q + u + q + post + ">" : m;
  });
  out = out.replace(/<script\\b([^>]*?)\\bsrc=(['"])([^'"]+)\\2([^>]*)><\\/script>/gi, (m, pre, q, src, post) => {
    const attrs = pre + post;
    const path = resolvePath("vnc.html", src);
    if (!path) return m;
    if (/\\btype\\s*=\\s*(['"])module\\1/i.test(attrs) || /\\btype\\s*=\\s*(['"])module\\1/i.test(m)) {
      return "<script type=\\"module\\">import " + JSON.stringify(virt(path)) + ";</script>";
    }
    const u = ensureAssetURL(path);
    return u ? "<script" + pre + "src=" + q + u + q + post + "></script>" : m;
  });
  out = out.replace(/<script\\b([^>]*)>([\\s\\S]*?)<\\/script>/gi, (m, attrs, body) => {
    if (!/\\btype\\s*=\\s*(['"])module\\1/i.test(attrs)) return m;
    if (/\\bsrc\\s*=/.test(attrs)) return m;
    return "<script" + attrs + ">" + rewriteJS(body, "vnc.html") + "</script>";
  });
  // Import map must appear in this document before any module scripts.
  if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (h) => h + importMapTag);
  else out = importMapTag + out;
  // Persist fetch shim across document.write by injecting it first in <head>.
  const fetchShim = "<script>(function(){var F=window.fetch.bind(window),T=" + JSON.stringify(text) + ",B=" + JSON.stringify(bin) + ";function b64(s){var b=atob(s),o=new Uint8Array(b.length);for(var i=0;i<b.length;i++)o[i]=b.charCodeAt(i);return o;}function bytes(p){if(Object.prototype.hasOwnProperty.call(T,p))return new TextEncoder().encode(T[p]);if(Object.prototype.hasOwnProperty.call(B,p))return b64(B[p]);return null;}window.fetch=function(input,init){try{var raw=typeof input===\\"string\\"?input:input&&input.url;if(typeof raw===\\"string\\"&&!/^(blob:|data:|https?:)/i.test(raw)){var path=raw.replace(/^\\\\.\\\\//,\\"\\").replace(/^\\\\/+/,\\"\\");var data=bytes(path);if(data)return Promise.resolve(new Response(data,{status:200}));}}catch(e){}return F(input,init);};})();</script>";
  if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (h) => h + fetchShim);
  else out = fetchShim + out;
  return out;
}

try {
  boot.textContent = "Loading desktop…";
  const page = rewriteHTML(text["vnc.html"]);
  // Navigate to a blob document so the import map + modules load cleanly on file://.
  location.replace(URL.createObjectURL(new Blob([page], { type: "text/html; charset=utf-8" })));
} catch (e) {
  fail(e);
}
`;

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TabTop local desktop</title>
<style>
  body { font: 15px/1.45 system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; }
  #boot { color: #444; }
  #err { color: #b00020; white-space: pre-wrap; }
</style>
</head>
<body>
<p id="boot">Starting TabTop local desktop (file:// loader)…</p>
<pre id="err" hidden></pre>
<script type="module">
${runtime}
</script>
</body>
</html>
`;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
	const args = new Map();
	for (let i = 2; i < process.argv.length; i++) {
		const a = process.argv[i];
		if (a === "--from-dir" || a === "--out") args.set(a.slice(2), process.argv[++i]);
		else throw new Error(`unknown arg ${a}`);
	}
	const dir = args.get("from-dir");
	const out = args.get("out") || "tabtop-local.html";
	if (!dir) throw new Error("need --from-dir");
	const files = {};
	const walk = (d) => {
		for (const name of readdirSync(d)) {
			const p = join(d, name);
			const st = statSync(p);
			if (st.isDirectory()) walk(p);
			else if (st.isFile()) {
				const rel = relative(dir, p).split("\\").join("/");
				const buf = readFileSync(p);
				const asText = buf.toString("utf8");
				if (Buffer.from(asText, "utf8").equals(buf) && !/\.(png|jpe?g|gif|webp|ico|woff2?|wasm)$/i.test(rel)) {
					files[rel] = asText;
				} else {
					files[rel] = { base64: buf.toString("base64") };
				}
			}
		}
	};
	walk(dir);
	writeFileSync(out, buildFileLauncherHTML(files));
	console.error(`wrote ${out}`);
}
