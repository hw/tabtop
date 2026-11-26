#!/usr/bin/env node
// Build tabtop.html: one HTML file that runs the TabTop desktop client
// opened as a file (file://), its scripts and the rest from inside it, not
// the network (the offline client; see docs/encryption.md).
//
// A browser won't load modules, nor much else, from one local file into
// another; so the page holds the whole tree, and when started:
//   - asks which TabTop server to connect to (remembered in this browser),
//     whose address the client's own code otherwise takes from where its
//     scripts came from (import.meta.url): each module's is that server's
//     address of it, as if served from there;
//   - makes a blob: URL of each file, its modules' imports (and workers,
//     and new URL(…, import.meta.url)), stylesheets' url()s and the page's
//     src= and href= made to name those; the modules by an import map;
//   - writes the client's page into this same document (not another,
//     which would end the blob: URLs this one made), and answers its
//     fetch()es of the tree's files from the tree: the desktop (vnc.html),
//     or, with ?page=terminal or ?page=files, the terminal (tty/index.html)
//     or the files page (fs/index.html), where the pages link to each other
//     (see nav.js's tabtopOffline), each in a tab of its own;
//   - gives the page a Content-Security-Policy that lets it reach the
//     server only by the encrypted tunnel: nothing is loaded from the
//     server;
//   - builds the previews' sandboxed frames (Markdown and HTML, EPUB, PDF)
//     itself, from the tree (frameHTML);
//   - fetches the viewers the gateway's manifest (ASSETS) lists through
//     the tunnel when they're first needed, syntax colouring, the
//     disassemblers, Kaitai, three.js, pdf.js, KaTeX and Mermaid, and the AI
//     image tools' ONNX Runtime and models, and keeps them in IndexedDB: each checked
//     against the SHA-256 the manifest has, there and when kept, as the
//     manifest was written into this file when the pack was sealed.
// The gateway accepts the tunnel from a page opened as a file only with
// WEB_OFFLINE_CLIENT=1 (-offline-client).
//
//   import { buildFileLauncherHTML } from "./file-launcher.mjs";
//   node scripts/bootstrap/file-launcher.mjs --from-dir <tree> [--out tabtop.html]

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { OfflineConnection } from "./offline-connection.mjs";

// launcher is the page's script, run in the browser with the tree
// ({text, bin}: files by path, as text or base64). Written here as a
// function, and given to the page as its source.
function launcher(tree, OfflineConnection) {
    "use strict";
    const { text, bin } = tree;
    const $ = (id) => document.getElementById(id);
    const SERVER_KEY = "tabtop-local-server";
    const PREFIX = "tabtop-local/";
    // Each page, by the id nav.js has for it, and what the files page has
    // no viewer for here (see preview-model.js's offlineOff).
    // (components, the offline client's own: see components.js.)
    const PAGES = { desktop: "vnc.html", terminal: "tty/index.html", files: "fs/index.html", go: "go/index.html", components: "components/index.html" };
    // (3D, unless the gateway's manifest has three.js: see ASSETS.)
    let OFF = ["model", "pdf", "epub", "markdown", "html"];
    const asked = new URLSearchParams(location.search).get("page");

    const fail = (e) => {
        console.error(e);
        $("err").hidden = false;
        $("err").textContent = String(e?.message || e);
        $("go").disabled = false;
    };
    const has = (path) => Object.hasOwn(text, path) || Object.hasOwn(bin, path);
    const bytesOf = (path) => {
        if (Object.hasOwn(text, path)) return new TextEncoder().encode(text[path]);
        if (!Object.hasOwn(bin, path)) return null;
        const s = atob(bin[path]), out = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
        return out;
    };
    const textOf = (path) => (Object.hasOwn(text, path) ? text[path] : new TextDecoder().decode(bytesOf(path)));
    const TYPES = { css: "text/css", html: "text/html", htm: "text/html", json: "application/json", svg: "image/svg+xml", png: "image/png",
        jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2",
        ttf: "font/ttf", js: "text/javascript", mjs: "text/javascript", wasm: "application/wasm", txt: "text/plain" };
    const typeOf = (path) => TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";
    const isJS = (path) => /\.m?js$/i.test(path);
    // resolve is spec, as from the file at path from, a path in the tree
    // (without its query or fragment); or null for one elsewhere (a URL).
    const resolve = (from, spec) => {
        if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(spec) || spec.startsWith("#")) return null;
        spec = spec.split(/[?#]/)[0];
        const parts = (spec.startsWith("/") ? spec : from.slice(0, from.lastIndexOf("/") + 1) + spec).split("/");
        const out = [];
        for (const p of parts) {
            if (!p || p === ".") continue;
            if (p === "..") out.pop();
            else out.push(p);
        }
        return out.join("/");
    };
    let base = "";            // the server's address, its client's root (as vnc.html is at)

    // The files this client may fetch from the server when it first needs
    // them (the viewers it doesn't carry): each one's SHA-256 and size, and
    // the disassemblers that are off, written in by the gateway when it
    // seals the pack (offline_assets.go), so they're what the passcode
    // unlocked. null (a pack sealed without it): none is fetched.
    const ASSETS = /*tabtop-offline-assets*/null;
    const known = (path) => !!path && !!ASSETS?.files && Object.hasOwn(ASSETS.files, path);
    const DB = "tabtop-offline-assets";
    // The store: by SHA-256, so another version of a file is another entry.
    // Every page opened as a file shares this browser's storage, so what's
    // read from it is checked again each time, as what's fetched is.
    const store = (mode, act) => new Promise((ok, no) => {
        const open = indexedDB.open(DB, 1);
        open.onupgradeneeded = () => open.result.createObjectStore("files");
        open.onerror = () => no(open.error);
        open.onsuccess = () => {
            const tx = open.result.transaction("files", mode), q = act(tx.objectStore("files"));
            tx.oncomplete = () => { open.result.close(); ok(q?.result); };
            tx.onerror = tx.onabort = () => { open.result.close(); no(tx.error); };
        };
    });
    const hexOf = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const matches = async (path, bytes) => {
        const want = ASSETS.files[path];
        return bytes instanceof Uint8Array && bytes.length === want.size && hexOf(await crypto.subtle.digest("SHA-256", bytes)) === want.sha256;
    };
    const loading = new Map();  // sha256: the bytes, coming
    // asset resolves to the bytes of the file at path (one of ASSETS'): kept
    // here, else fetched through the tunnel; either way, only if they're
    // the ones the pack has the hash of.
    const asset = (path) => {
        if (!known(path)) return Promise.reject(new Error(`${path} isn't one this offline client can fetch`));
        const { sha256 } = ASSETS.files[path];
        if (!loading.has(sha256)) {
            loading.set(sha256, (async () => {
                let bytes = null;
                try { bytes = await store("readonly", (s) => s.get(sha256)); } catch { /* none kept */ }
                if (bytes && await matches(path, bytes)) return bytes;
                const { call, collect } = await import(PREFIX + "tabtop/requests.js");
                const t = await call({ type: "asset", path });
                try {
                    bytes = new Uint8Array(await (await collect(t, t.reply.size, () => {})).arrayBuffer());
                } finally {
                    t.close();
                }
                if (!await matches(path, bytes)) {
                    throw new Error(`the server's ${path} isn't the one this offline client was sealed with: download the pack again`);
                }
                await store("readwrite", (s) => s.put(bytes, sha256)).catch(() => {});
                return bytes;
            })().catch((e) => {
                loading.delete(sha256);
                throw e;
            }));
        }
        return loading.get(sha256);
    };
    // The bytes of the file at path: the tree's, or a fetched one's.
    const anyFile = (path) => (has(path) ? Promise.resolve(bytesOf(path)) : asset(path));
    const toDataURL = (bytes, type) => {
        let s = "";
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return `data:${type};base64,${btoa(s)}`;
    };
    // moduleURL is a URL to import the fetched module at path by: its own
    // imports (of others fetched) named by theirs; blob: on the page, data:
    // in a worker (which won't import a page's blob: URLs).
    const modules = new Map();
    const moduleURL = (path, kind, seen = []) => {
        const key = kind + ":" + path;
        if (seen.includes(path)) return Promise.reject(new Error(`${path} imports itself`));
        if (!modules.has(key)) {
            modules.set(key, (async () => {
                let code = new TextDecoder().decode(await asset(path));
                const specs = [...new Set([...code.matchAll(/\b(?:import|export)\s*(?:[\w$*\s{},]*?\s*from\s*)?(["'])(\.{1,2}\/[^"'\n]+)\1/g)].map((m) => m[2]))];
                const named = {};
                for (const spec of specs) {
                    const dep = resolve(path, spec);
                    if (!known(dep)) throw new Error(`${path} imports ${spec}, which isn't here`);
                    named[spec] = await moduleURL(dep, kind, [...seen, path]);
                }
                // (And its import.meta.url, the server's address of it, as
                // a module of the tree's has: data: is no URL to resolve
                // others against. Fetched, that's answered from here.)
                code = code.replace(/(\b(?:import|export)\s*(?:[\w$*\s{},]*?\s*from\s*)?)(["'])(\.{1,2}\/[^"'\n]+)\2/g, (m, pre, q, spec) => pre + JSON.stringify(named[spec]))
                    .replace(/\bimport\.meta\.url\b/g, JSON.stringify(base + path));
                const bytes = new TextEncoder().encode(code);
                return kind === "data" ? toDataURL(bytes, "text/javascript") : URL.createObjectURL(new Blob([bytes], { type: "text/javascript" }));
            })().catch((e) => {
                modules.delete(key);
                throw e;
            }));
        }
        return modules.get(key);
    };
    // A dynamic import() in the tree's modules whose path is in ASSETS (or
    // starts as one of them does): importFrom(the module's path)(spec).
    const importFrom = (from) => (spec) => {
        const path = resolve(from, String(spec));
        return known(path) ? moduleURL(path, "blob").then((url) => import(url)) : import(spec);
    };
    const assetPrefix = (path) => !!path && !!ASSETS?.files && Object.keys(ASSETS.files).some((p) => p.startsWith(path));
    // The gateway's list of disassemblers that are off, in place of the
    // pack's (all of them, for a pack without ASSETS).
    const disasmOff = (code) => (ASSETS ? code.replace(/const DISASM_OFF = \[[^\]]*\];/, `const DISASM_OFF = ${JSON.stringify(ASSETS.disasmOff ?? [])};`) : code);
    // A worker's first lines: it's sent a port (see the page's Worker), by
    // which it asks the page for files by path (the tree's, or fetched
    // ones), and with them: fetch() of those; tabtopImportScripts(url),
    // which loads a script as importScripts would; tabtopImport(url), which
    // imports a module (and those it imports) as import() would.
    const prelude = (path) => `(() => {
const at = ${JSON.stringify(path)}, base = ${JSON.stringify(base)}, files = new Set(${JSON.stringify(ASSETS ? Object.keys(ASSETS.files) : [])});
const resolve = ${resolve.toString()};
const pathOf = (url) => { url = String(url); if (url.startsWith(base)) return resolve("", url.slice(base.length)); return /^[a-z][a-z0-9+.-]*:/i.test(url) ? null : resolve(at, url); };
let port, n = 0; const asked = new Map(), ready = new Promise((ok) => {
  const first = (e) => { if (!e.data || !e.data.tabtopFiles) return; e.stopImmediatePropagation(); removeEventListener("message", first); port = e.ports[0];
    port.onmessage = ({ data }) => { const p = asked.get(data.id); asked.delete(data.id); data.error ? p.no(new Error(data.error)) : p.ok(data.bytes); }; ok(); };
  addEventListener("message", first);
});
const ask = (path, kind) => ready.then(() => new Promise((ok, no) => { const id = ++n; asked.set(id, { ok, no }); port.postMessage({ id, path, kind }); }));
const realFetch = self.fetch.bind(self);
self.fetch = (input, init) => { const raw = typeof input === "string" ? input : input && input.url; const p = typeof raw === "string" ? pathOf(raw) : null;
  return p && files.has(p) ? ask(p, "bytes").then((b) => new Response(b, { status: 200, headers: { "Content-Type": /\.wasm$/.test(p) ? "application/wasm" : "application/octet-stream" } })) : realFetch(input, init); };
self.tabtopImportScripts = async (...urls) => { for (const u of urls) { const p = pathOf(u); importScripts(p ? await ask(p, "script") : u); } };
self.tabtopImport = (url) => { const p = pathOf(url); return p && files.has(p) ? ask(p, "module").then((u) => import(u)) : import(url); };
self.tabtopModuleURL = (url) => { const p = pathOf(url); return p && files.has(p) ? ask(p, "module") : Promise.reject(new Error(url + " isn't one this offline client can fetch")); };
})();
`;
    const workerURLs = new Set();
    // frameHTML is a preview's frame (md-frame.html, epub-frame.html or
    // pdf-frame.html, as the gateway serves them), for an iframe's srcdoc:
    // the frame can't load the tree's files from its blob: URLs (it's at an
    // origin of its own, sandboxed as the gateway's is), so its scripts are
    // written in it (and glyphs.js, made a classic script). First in it: its
    // policy, which lets it load nothing at all, and run only the scripts
    // written in it and those it injects (md-frame.js: KaTeX, Mermaid,
    // highlight.js's classic build), each by its SHA-256 (the latter's from
    // ASSETS): nothing a document shown in it could add. (The PDF's frame
    // also runs pdf.js, as modules from blob: URLs it makes itself, and its
    // worker from a data: URL.) Then tabtopFrame, by which it asks this page
    // for the files it needs (see frameFile), and which answers its
    // fetch()es of tabtopFrame.base. The frames are made as the page starts
    // (prepareFrames), their hashes taking a moment to work out.
    const FRAME_BASE = "https://tabtop.offline/tabtop/";
    const INJECTED = { "tabtop/md-frame.html": /^tabtop\/(preview\/[^/]+\.js|highlight\/classic\/.+\.js)$/ };
    const framePrelude = () => `window.tabtopFrame = (() => {
const page = window.parent, asked = new Map(), base = ${JSON.stringify(FRAME_BASE)}; let n = 0;
addEventListener("message", (e) => { const m = e.data; if (e.source !== page || !m || m.type !== "tabtop-offline-file") return;
  e.stopImmediatePropagation(); const a = asked.get(m.id); if (!a) return; asked.delete(m.id); m.error ? a.no(new Error(m.error)) : a.ok(m.answer); });
const ask = (path) => new Promise((ok, no) => { const id = ++n; asked.set(id, { ok, no }); page.postMessage({ type: "tabtop-offline-file", id, path }, "*"); });
const at = (src) => String(src).replace(/^\\.\\//, "").replace(base, "");
const text = (bytes) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
const realFetch = window.fetch.bind(window);
window.fetch = (input, init) => { const u = String(typeof input === "string" ? input : input && input.url ? input.url : input);
  return u.startsWith(base) ? ask(at(u)).then((b) => new Response(b, { status: 200, headers: { "Content-Type": /\\.wasm$/.test(u) ? "application/wasm" : "application/octet-stream" } })) : realFetch(input, init); };
return Object.freeze({ base,
  glyphs: typeof __tabtopModules === "undefined" ? undefined : __tabtopModules["tabtop/glyphs.js"],
  // A module (pdf.js's), from a blob: URL of this frame's; its import.meta.url where it's fetched from here.
  moduleURL: async (path) => { const p = at(path); const code = text(await ask(p)).replace(/\\bimport\\.meta\\.url\\b/g, JSON.stringify(base + p));
    return URL.createObjectURL(new Blob([code], { type: "text/javascript" })); },
  // A script, run as written (allowed by its hash: see the policy).
  script: async (src) => { const s = document.createElement("script"); s.textContent = text(await ask(at(src))); document.head.append(s); s.remove(); } });
})();`;
    // (A script's text as it's written in a page, and as the page will have
    // it, line ends made \n as the parser makes them: what its hash is of.)
    const scriptText = (code) => code.replace(/\r\n?/g, "\n").replace(/\0/g, "�").replace(/<\/script/gi, "<\\/script");
    const hashOf = async (t) => {
        const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)));
        return `'sha256-${btoa(String.fromCharCode(...d))}'`;
    };
    const frames = new Map();
    const prepareFrames = async () => {
        for (const source of ["md-frame.html", "epub-frame.html", "pdf-frame.html", "go-frame.html"]) {
            const path = "tabtop/" + source, pdf = source === "pdf-frame.html";
            if (!has(path)) continue;
            const first = [...(source !== "md-frame.html" && has("tabtop/glyphs.js") ? [bundle("tabtop/glyphs.js")] : []), framePrelude()].map(scriptText);
            const written = [...first];
            const body = textOf(path).replace(/<script src="([^"]+)"><\/script>/g, (m, src) => {
                const p = resolve(path, src);
                if (!has(p)) return "";
                const t = scriptText(textOf(p));
                written.push(t);
                return `<script>${t}</script>`;
            });
            const hashes = await Promise.all(written.map(hashOf));
            for (const [p, f] of Object.entries(ASSETS?.files ?? {})) {
                if (INJECTED[path]?.test(p)) hashes.push(`'sha256-${btoa(String.fromCharCode(...f.sha256.match(/../g).map((h) => parseInt(h, 16))))}'`);
            }
            const csp = ["default-src 'none'", `script-src ${hashes.join(" ")}${pdf ? " blob: 'wasm-unsafe-eval'" : ""}`,
                `worker-src ${pdf ? "data: blob:" : "'none'"}`, "style-src 'unsafe-inline'", "img-src blob: data:", "media-src blob:",
                "font-src blob: data:", "base-uri 'none'", "form-action 'none'"].join("; ");
            const top = `<meta http-equiv="Content-Security-Policy" content="${csp}">` + first.map((t) => `<script>${t}</script>`).join("");
            frames.set(path, /<meta charset="utf-8">/i.test(body) ? body.replace(/<meta charset="utf-8">/i, (h) => h + top) : top + body);
        }
    };
    const frameHTML = (source) => frames.get("tabtop/" + source) ?? null;
    // frameFile answers a frame's question (see framePrelude) for a file
    // ASSETS lists, under tabtop/: its bytes.
    const frameFile = async (path) => {
        const p = "tabtop/" + String(path);
        if (!known(p)) throw new Error(`${path} isn't one this offline client can fetch`);
        return (await asset(p)).slice();
    };
    // What the components page (components.js) shows and does: the files
    // ASSETS lists ({path, sha256, size}; null without it); each one's
    // state here ("kept", checked; "damaged", kept but not as listed;
    // "missing"), and what's kept that isn't listed (from an older pack);
    // fetching one (and keeping it); and forgetting one, by its SHA-256.
    const components = Object.freeze({
        files: () => (ASSETS ? Object.entries(ASSETS.files).map(([path, f]) => ({ path, sha256: f.sha256, size: f.size })) : null),
        disasmOff: () => [...(ASSETS?.disasmOff ?? [])],
        check: async () => {
            const kept = new Map();
            try {
                const [keys, values] = await Promise.all([store("readonly", (s) => s.getAllKeys()), store("readonly", (s) => s.getAll())]);
                keys.forEach((k, i) => kept.set(k, values[i]));
            } catch { /* nothing kept */ }
            const state = {}, listed = new Set();
            for (const [path, f] of Object.entries(ASSETS?.files ?? {})) {
                listed.add(f.sha256);
                state[path] = !kept.has(f.sha256) ? "missing" : await matches(path, kept.get(f.sha256)) ? "kept" : "damaged";
            }
            const unlisted = [...kept].filter(([k]) => !listed.has(k)).map(([sha256, v]) => ({ sha256, size: v?.length ?? v?.byteLength ?? 0 }));
            return { state, unlisted };
        },
        fetch: (path) => asset(path).then((bytes) => bytes.length),
        forget: async (sha256) => {
            loading.delete(sha256);
            await store("readwrite", (s) => s.delete(sha256));
        },
    });
    const urls = new Map();   // mode and path: its blob: URL
    // urlOf is the blob: URL of the file at path (its own rewritten as each
    // kind needs), or null if it isn't in the tree (or, a worker's, can't
    // be made). mode is how a script is to be run: "page", a module of the
    // page's (its imports by the import map); "classic", a classic worker's
    // or one it imports (importScripts); "bundle", a module worker's, made
    // a classic one (see bundle).
    // A worker's own script (entry) starts with its prelude.
    const urlOf = (path, mode = "page", entry = false) => {
        if (!path || !has(path)) return null;
        const key = (isJS(path) ? mode + (entry ? "-worker" : "") + ":" : "") + path;
        if (urls.has(key)) return urls.get(key);
        urls.set(key, null); // (one that names itself: its own URL, not made forever)
        let body = bytesOf(path);
        try {
            if (isJS(path)) {
                body = mode === "bundle" ? bundle(path) : rewriteJS(textOf(path), path, mode);
                // (After its "use strict", if it starts with one, which
                // must stay first to count.)
                if (entry) body = body.replace(/^(\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*\s*(["'])use strict\2;?)?/, (m) => m + "\n" + prelude(path));
            }
            else if (/\.css$/i.test(path)) body = rewriteCSS(textOf(path), path);
        } catch (e) {
            console.error(`${path}: ${e.message}`);
            return null;
        }
        const url = URL.createObjectURL(new Blob([body], { type: typeOf(path) }));
        urls.set(key, url);
        if (entry) workerURLs.add(url);
        return url;
    };
    // A module's imports, by the import map's names for them; its workers'
    // and other new URL(…, import.meta.url)s, and a classic worker's
    // importScripts()es, as blob: URLs; and what's left of import.meta.url,
    // the server's address of it (which the page can't load from: see csp).
    const rewriteJS = (code, path, mode = "page") => {
        const named = (spec) => {
            const p = resolve(path, spec);
            if (p === null || !has(p)) return JSON.stringify(spec);
            return JSON.stringify(isJS(p) && mode === "page" ? PREFIX + p : urlOf(p, mode));
        };
        // (A dynamic import of a fetched file, or of one of a folder of
        // them, by a literal or what it starts with: importFrom; in a
        // worker, any is tabtopImport, see prelude.)
        code = disasmOff(code).replace(/\bimport\s*\(\s*(["'])(\.{1,2}\/[^"'\n]*)\1(\s*[)+])/g, (m, q, spec, end) => {
            const p = resolve(path, spec);
            if (mode !== "page") return m;
            if (has(p) || !(end.trim() === ")" ? known(p) : assetPrefix(p))) return m;
            return `globalThis.tabtopOffline.importFrom(${JSON.stringify(path)})(${q}${spec}${q}${end}`;
        });
        return code
            .replace(/(\b(?:import|export)\s*(?:[\w$*\s{},]*?\s*from\s*)?)(["'])([^"'\n]+)\2/g, (m, pre, q, spec) => pre + named(spec))
            .replace(/\bimport\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g, (m, q, spec) => "import(" + named(spec) + ")")
            .replace(/\bimport\s*\((?!\s*["'](?:blob|data):)/g, (m) => (mode === "page" ? m : "self.tabtopImport("))
            .replace(/(\bnew\s+(?:Shared)?Worker\s*\(\s*|\.addModule\s*\(\s*)?new\s+URL\s*\(\s*(["'])([^"'\n]+)\2\s*,\s*import\.meta\.url\s*\)(\s*,\s*\{\s*type\s*:\s*(["'])module\5\s*\})?/g, (m, ctor, q, spec, moduleWorker) => {
                const p = resolve(path, spec);
                // An audio worklet's module: a data: URL (Chrome won't load
                // one from a page's blob: URLs when it's opened as a file).
                if (ctor && /addModule/.test(ctor)) {
                    if (!p || !has(p)) return m;
                    const code = new TextEncoder().encode(rewriteJS(textOf(p), p, "classic"));
                    let bin = "";
                    for (let i = 0; i < code.length; i += 0x8000) bin += String.fromCharCode(...code.subarray(i, i + 0x8000));
                    return ctor + "new URL(" + JSON.stringify("data:text/javascript;base64," + btoa(bin)) + ")";
                }
                const u = urlOf(p, !ctor ? "page" : moduleWorker ? "bundle" : "classic", !!ctor);
                return u ? (ctor ?? "") + "new URL(" + JSON.stringify(u) + ")" : m;
            })
            .replace(/\bimportScripts\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g, (m, q, spec) => {
                const u = urlOf(resolve(path, spec), "classic");
                return u ? "importScripts(" + JSON.stringify(u) + ")" : m;
            })
            .replace(/\bimport\.meta\.url\b/g, JSON.stringify(base + path));
    };
    // bundle is the module worker at entry, and the modules it imports, as
    // one classic worker's script: a page opened as a file can't start a
    // module worker (Chrome refuses one from its blob: URLs). Each module
    // becomes a function of its own, run once, in the order they import
    // each other, that returns what it exports; its imports, consts of
    // those. It knows the forms TabTop's workers' modules have: import {…},
    // * as, a default, or for itself, from a path; and export of a
    // function, class, const, let or var, or export {…}. Anything else
    // (export default, export … from, a cycle) is refused: the worker
    // isn't made, and the page says it couldn't start.
    const bundle = (entry) => {
        const ref = (p) => `__tabtopModules[${JSON.stringify(p)}]`;
        const order = [], state = new Map();
        const importRe = /\bimport\s+(?:(\{[^}]*\})|\*\s+as\s+([\w$]+)|([\w$]+))\s+from\s*(["'])([^"'\n]+)\4\s*;?|\bimport\s*(["'])([^"'\n]+)\6\s*;?/g;
        const visit = (p) => {
            if (state.get(p) === 2) return;
            if (state.get(p) === 1) throw new Error("its modules import each other in a cycle");
            if (!has(p) || !isJS(p)) throw new Error(`it imports ${p}, which isn't here`);
            state.set(p, 1);
            for (const m of textOf(p).matchAll(importRe)) visit(resolve(p, m[5] ?? m[7]));
            state.set(p, 2);
            order.push(p);
        };
        visit(entry);
        const modules = order.map((p) => {
            const names = [];
            let code = textOf(p).replace(importRe, (m, braces, ns, def, q, spec, q2, bare) => {
                const r = ref(resolve(p, spec ?? bare));
                if (braces) return `const ${braces.replace(/\s+as\s+/g, ": ")} = ${r};`;
                if (ns) return `const ${ns} = ${r};`;
                return def ? `const ${def} = ${r}.default;` : "";
            });
            code = code.replace(/\bexport\s+((?:async\s+)?function\s*\*?\s*([\w$]+)|class\s+([\w$]+)|(?:const|let|var)\s+([\w$]+))/g, (m, decl, fn, cls, v) => {
                names.push([fn ?? cls ?? v, fn ?? cls ?? v]);
                return decl;
            });
            code = code.replace(/\bexport\s*\{([^}]*)\}\s*;?/g, (m, list) => {
                for (const item of list.split(",").map((s) => s.trim()).filter(Boolean)) {
                    const [local, as = local] = item.split(/\s+as\s+/);
                    names.push([local, as]);
                }
                return "";
            });
            if (/\bexport\b\s*(default\b|\*|\{|[\w$]+\s+from\b)/.test(code)) throw new Error(`${p} exports in a way a worker here can't have`);
            code = rewriteJS(code, p, "classic");
            const exported = names.map(([local, as]) => `get ${JSON.stringify(as)}() { return ${local}; }`).join(", ");
            return `${ref(p)} = (() => {\n${code}\n;return { ${exported} };\n})();\n`;
        });
        return `"use strict";\nconst __tabtopModules = {};\n${modules.join("")}`;
    };
    const rewriteCSS = (css, path) => css
        .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g, (m, q, spec) => { const u = urlOf(resolve(path, spec.trim())); return u ? `url("${u}")` : m; })
        .replace(/@import\s+(["'])([^"']+)\1/g, (m, q, spec) => { const u = urlOf(resolve(path, spec)); return u ? `@import "${u}"` : m; });
    // The page (the file at entry): its inline modules' imports; its
    // scripts (modules by the import map); its <style>s' url()s; every
    // other src= and href= naming a file in the tree. And, first in it,
    // its policy (csp) and the import map.
    const rewriteHTML = (html, entry, imports, csp) => {
        let out = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (m, attrs, body) => {
            if (/\bsrc\s*=/i.test(attrs)) {
                const p = resolve(entry, /\bsrc\s*=\s*(["'])([^"']*)\1/i.exec(attrs)?.[2] ?? "");
                if (!p || !has(p)) return m;
                if (/\btype\s*=\s*(["'])module\1/i.test(attrs)) return `<script type="module">import ${JSON.stringify(PREFIX + p)};</script>`;
                return m.replace(/\bsrc\s*=\s*(["'])[^"']*\1/i, `src="${urlOf(p)}"`);
            }
            return /\btype\s*=\s*(["'])module\1/i.test(attrs) ? `<script${attrs}>${rewriteJS(body, entry)}</script>` : m;
        });
        out = out.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, open, css, close) => open + rewriteCSS(css, entry) + close);
        out = out.replace(/(<(?!script\b)[a-z][\w-]*\b[^<>]*?\s(?:src|href)\s*=\s*)(["'])([^"'<>]*)\2/gi, (m, pre, q, ref) => {
            const u = urlOf(resolve(entry, ref));
            return u ? pre + q + u + q : m;
        });
        // (Inline JSON: "<" escaped, so a "</script>" in it can't end the script.)
        const first = `<meta http-equiv="Content-Security-Policy" content="${csp.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">` +
            `<script type="importmap">${JSON.stringify({ imports }).replace(/</g, "\\u003c")}</script>`;
        // Before anything else the page has: in its <head>, or (a page
        // without one) after its character set, or its doctype.
        for (const at of [/<head\b[^>]*>/i, /<meta\s+charset\s*=[^>]*>/i, /<!doctype[^>]*>/i]) {
            if (at.test(out)) return out.replace(at, (h) => h + first);
        }
        return first + out;
    };
    // csp is the page's policy: its scripts, styles and the rest only from
    // the tree (blob: URLs) or itself, and the network only the server's
    // WebSocket and its polling fallback.
    const cspFor = (server) => {
        const ws = (server.protocol === "https:" ? "wss://" : "ws://") + server.host;
        const poll = new URL("session/poll", server).href.replace(/;/g, "%3B").replace(/,/g, "%2C");
        return [
            "default-src 'none'",
            "script-src blob: data: 'unsafe-inline' 'wasm-unsafe-eval'",
            "style-src blob: 'unsafe-inline'",
            "img-src blob: data:", "media-src blob: data:", "font-src blob: data:",
            `connect-src blob: data: ${ws} ${poll} ${poll}/`,
            "worker-src blob: data:", "frame-src blob:", "child-src blob:",
            "object-src 'none'", "base-uri 'none'", "form-action 'none'",
        ].join("; ");
    };

    const start = async () => {
        $("err").hidden = true;
        let server;
        try {
            server = new URL($("server").value.trim());
        } catch {
            return fail(new Error("Enter the address you open TabTop at, as https://example.com/ or https://example.com/tabtop/."));
        }
        const local = ["localhost", "127.0.0.1", "[::1]"].includes(server.hostname);
        if (server.protocol !== "https:" && !(server.protocol === "http:" && local)) return fail(new Error("Use an https:// address (http:// only for localhost)."));
        if (server.username || server.password) return fail(new Error("Leave the user name and password out of the address."));
        // (A name, or an IP address: nothing else, as it's written into the
        // page's policy.)
        if (!/^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:\d+)?$/i.test(server.host)) return fail(new Error("That isn't a server's address."));
        server.search = server.hash = "";
        // (A path's last part without a dot is a folder: .../tabtop is .../tabtop/.)
        if (!server.pathname.endsWith("/")) server.pathname = /\.[^/]*$/.test(server.pathname) ? server.pathname.replace(/[^/]*$/, "") : server.pathname + "/";
        base = server.href;
        try { localStorage.setItem(SERVER_KEY, base); } catch { /* not remembered: asked again */ }
        $("go").disabled = true;
        const page = Object.hasOwn(PAGES, asked ?? "") && has(PAGES[asked]) ? asked : "desktop";
        // (Markdown, HTML and EPUB in frames this file has; 3D and PDF with
        // the gateway's three.js and pdf.js.)
        OFF = OFF.filter((kind) => !(kind === "model" ? known("tabtop/three/three.module.js") : kind === "pdf" ? known("tabtop/pdfjs/pdf.min.mjs")
            : kind === "epub" ? has("tabtop/epub-frame.html") : has("tabtop/md-frame.html")));
        try {
            const imports = {};
            for (const path of [...Object.keys(text), ...Object.keys(bin)]) if (isJS(path)) imports[PREFIX + path] = urlOf(path);
            // fetch()es of the tree's files (by path, by this file's place, or
            // by the server's address of them): from the tree, never the network.
            // (One from the server that isn't in the tree is refused here
            // too, not only by the policy.)
            const entry = PAGES[page];
            const real = window.fetch.bind(window), here = location.href.replace(/[?#].*$/, "").replace(/[^/]*$/, "");
            const pollURL = new URL("session/poll", base);
            const fetchPoll = (input, init) => {
                const url = new URL(input);
                if (url.origin !== pollURL.origin || (url.pathname !== pollURL.pathname &&
                    !url.pathname.startsWith(pollURL.pathname + "/"))) {
                    return Promise.reject(new TypeError("Invalid offline transport URL"));
                }
                return real(url, { ...init, credentials: "omit", cache: "no-store", redirect: "error" });
            };
            window.fetch = (input, init) => {
                const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
                if (typeof raw === "string") {
                    const server = raw.startsWith(base);
                    const rel = server ? raw.slice(base.length) : raw.startsWith(here) ? raw.slice(here.length)
                        : /^[a-z][a-z0-9+.-]*:/i.test(raw) ? null : raw;
                    const path = rel === null ? null : resolve(server ? "" : entry, rel);
                    if (path && has(path)) return Promise.resolve(new Response(bytesOf(path), { status: 200, headers: { "Content-Type": typeOf(path) } }));
                    if (known(path)) return asset(path).then((bytes) => new Response(bytes, { status: 200, headers: { "Content-Type": typeOf(path) } }));
                    if (server) return Promise.reject(new TypeError(`${rel || "/"} isn't in the offline client`));
                }
                return real(input, init);
            };
            // The page's links to the others (see nav.js): this file, with
            // ?page=; the desktop's connecting as it opens, as the server's
            // link to it has it do.
            const thisFile = location.href.replace(/[?#].*$/, "");
            // A worker of the tree's is given a port, by which it asks this
            // page for files (see prelude): the tree's, and fetched ones.
            const RealWorker = window.Worker;
            window.Worker = class extends RealWorker {
                constructor(url, options) {
                    super(url, options);
                    if (!workerURLs.has(String(url))) return;
                    const { port1, port2 } = new MessageChannel();
                    port1.onmessage = async ({ data: { id, path, kind } }) => {
                        try {
                            const answer = kind === "module" ? await moduleURL(path, "data")
                                : kind === "script" ? toDataURL(await anyFile(path), "text/javascript") : (await anyFile(path)).slice();
                            port1.postMessage({ id, bytes: answer });
                        } catch (e) {
                            port1.postMessage({ id, error: String(e?.message || e) });
                        }
                    };
                    this.postMessage({ tabtopFiles: true }, [port2]);
                }
            };
            let upgradeLost = false;
            window.tabtopOffline = Object.freeze({
                page, off: OFF, importFrom, components, frameHTML, frameFile,
                connect: (url) => {
                    const preferPolling = upgradeLost;
                    upgradeLost = false;
                    return new OfflineConnection(url, {
                        fetch: fetchPoll, preferPolling, onUpgradeLost: () => { upgradeLost = true; },
                    });
                },
                has: (id) => Object.hasOwn(PAGES, id) && has(PAGES[id]),
                href: (id) => `${thisFile}?page=${encodeURIComponent(id)}${id === "desktop" ? "&autoconnect=1" : ""}`,
            });
            const html = rewriteHTML(textOf(entry), entry, imports, cspFor(server));
            await prepareFrames();
            document.open();
            document.write(html);
            document.close();
        } catch (e) {
            fail(e);
        }
    };
    let remembered = "";
    try { remembered = localStorage.getItem(SERVER_KEY) ?? ""; } catch { /* none remembered */ }
    $("server").value = remembered;
    $("form").addEventListener("submit", (e) => { e.preventDefault(); start(); });
    $("go").disabled = false;
    // Opened by another page of the client's (?page=), which handed it the
    // session (see session-state.js's handOffSession): straight to it, at
    // the server it's connected to. Otherwise (this page opened by you, or
    // by another local file), it asks first.
    // (Once this page is loaded: written while it's still being read,
    // the client's page would be added to it, not take its place.)
    let handed = false;
    try { handed = !!sessionStorage.getItem("tabtop-offline-session"); } catch { /* none */ }
    if (asked !== null && remembered && handed) {
        if (document.readyState === "complete") start();
        else addEventListener("load", () => start(), { once: true });
    }
}

/** @param {Record<string, string | { base64: string } | Uint8Array>} files */
export function buildFileLauncherHTML(files) {
    const text = {}, bin = {};
    for (const [path, body] of Object.entries(files)) {
        const rel = path.replace(/^\/+/, "").replace(/\\/g, "/");
        if (!rel || rel === "tabtop.html") continue;
        if (typeof body === "string") text[rel] = body;
        else if (body && typeof body === "object" && typeof body.base64 === "string") bin[rel] = body.base64;
        else if (body instanceof Uint8Array) bin[rel] = Buffer.from(body).toString("base64");
        else text[rel] = String(body ?? "");
    }
    if (!text["vnc.html"]) throw new Error("client tree is missing vnc.html");
    for (const page of ["tty/index.html", "fs/index.html"]) if (Object.hasOwn(files, page) && typeof text[page] !== "string") throw new Error(`${page} isn't text`);
    // Substitute the connection factory only in the sealed HTML's copy.
    // The gateway and the unpacked client tree keep the native constructor.
    const protocol = "tabtop/tunnel-protocol.js";
    if (text[protocol]) {
        const constructor = /new WebSocket\(([\w$]+)\)/g;
        if ([...text[protocol].matchAll(constructor)].length !== 1) throw new Error("offline tunnel factory site changed");
        text[protocol] = text[protocol].replace(constructor, "(globalThis.tabtopOffline?.connect($1) ?? $&)");
    }
    // The tree, as a script's JSON: "<" escaped, as the files have "</script>"
    // in them, which would end the script they're in; and the launcher's own
    // "</script>"s written "<\/script>" (the same string, not the end).
    const tree = JSON.stringify({ text, bin }).replace(/</g, "\\u003c");
    // (And its own "<script"s, in its strings and patterns, written
    // "\x3Cscript", the same in them: so the page has the one script.)
    const script = `(${launcher.toString().replace(/<script/g, "\\x3Cscript")})(${tree}, ${OfflineConnection});`.replace(/<\/script/gi, "<\\/script");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TabTop</title>
<style>
  body { font: 15px/1.45 system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; padding: 0 1rem; color: #1c1c1e; }
  form { display: flex; flex-flow: row nowrap; gap: .5rem; align-items: stretch; }
  input { box-sizing: border-box; flex: 1 1 auto; min-width: 0; font: inherit; padding: .5rem .6rem; border: 1px solid #aaa; border-radius: 8px; }
  button { flex: 0 0 auto; font: inherit; padding: .5rem 1rem; border-radius: 8px; border: 1px solid #1a73e8; background: #1a73e8; color: #fff; cursor: pointer; white-space: nowrap; }
  button:disabled { opacity: .5; cursor: default; }
  #err { color: #b00020; white-space: pre-wrap; }
</style>
</head>
<body>
<form id="form">
<input id="server" type="url" placeholder="TabTop server address" aria-label="TabTop server address" required autocomplete="url" spellcheck="false">
<button id="go" type="submit" disabled>Connect</button>
</form>
<p id="err" hidden></p>
<script>
${script}
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
    const out = args.get("out") || "tabtop.html";
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
                files[rel] = Buffer.from(asText, "utf8").equals(buf) && !/\.(png|jpe?g|gif|webp|ico|woff2?|wasm)$/i.test(rel) ? asText : { base64: buf.toString("base64") };
            }
        }
    };
    walk(dir);
    writeFileSync(out, buildFileLauncherHTML(files));
    console.error(`wrote ${out}`);
}
