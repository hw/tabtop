// The offline client's page (scripts/bootstrap/file-launcher.mjs): one
// script, which "</script>" in the files it holds can't end early; and
// the client the bootstrap pack holds (tabtopd/bootstrap.client.json),
// complete: every module it imports is in it, and the desktop's stylesheet.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { buildFileLauncherHTML } from "../scripts/bootstrap/file-launcher.mjs";

test("the launcher page: one script, however many </script> its files have", () => {
    const html = buildFileLauncherHTML({
        "vnc.html": '<html><head></head><body><script>var a = "</script>";</script><script type="module" src="app/ui.js"></script></body></html>',
        "app/ui.js": 'export const s = "</script><!--";',
    });
    // Its own script, and that alone: nothing in it ends it.
    assert.equal(html.match(/<\/script>/gi).length, 1);
    assert.equal(html.match(/<script>/gi).length, 1);
    // And the script compiles (only compiled here, not run).
    const script = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
    assert.doesNotThrow(() => new Script(script));
    assert.match(html, /id="server"/);
});

test("the pack's client is complete: its pages, their imports, workers and files", () => {
    const { format, files } = JSON.parse(readFileSync(new URL("../tabtopd/bootstrap.client.json", import.meta.url), "utf8"));
    assert.equal(format, "tabtop-pack/v1");
    const paths = new Set(Object.keys(files));
    for (const p of ["tabtop.html", "vnc.html", "tabtop/novnc.js", "tabtop/nav.js", "tabtop/desktop.css",
        "tty/index.html", "tty/tty.js", "tty/ghostty-web.js", "fs/index.html", "tabtop/files.js",
        "components/index.html", "components/components.js"]) assert.ok(paths.has(p), p);
    // The terminal's fonts, by the names its page has for them.
    for (const m of files["tty/index.html"].matchAll(/url\("([^"]+)"\)/g)) assert.ok(paths.has("tty/" + m[1]), m[1]);
    // One place for the gateway's manifest of assets (offline_assets.go).
    assert.equal(files["tabtop.html"].split("/*tabtop-offline-assets*/null").length, 2);
    // The disassemblers whose files are left out, turned off (until the
    // gateway's manifest says which are on).
    for (const f of ["tabtop/hex-view.js", "tabtop/disasm-worker.js"]) assert.match(files[f], /const DISASM_OFF = \["x86", "capstone", "arm64", "riscv", "mips"\];/);
    // Every static import there; and every module, worker or file named
    // dynamically (import(), new URL(…, import.meta.url), importScripts())
    // there too, but for the viewers left out, which never load from the
    // server (see the launcher's policy), and the server's own addresses.
    const left = /^tabtop\/(three|pdfjs|highlight|preview|kaitai|disasm|demangle|background|segment|inpaint|stream)(\/|$)|^tabtop\/(md|pdf|epub)-frame\.html$|^tabtop\/((x86|riscv|mips)-asm|asm-common)\.js$|^session$/;
    const at = (path, spec) => {
        const parts = (path.slice(0, path.lastIndexOf("/") + 1) + spec.split(/[?#]/)[0]).split("/"), out = [];
        for (const p of parts) if (p === "..") out.pop(); else if (p && p !== ".") out.push(p);
        return out.join("/");
    };
    const missing = [];
    for (const [path, body] of Object.entries(files)) {
        if (!/\.m?js$/.test(path) || typeof body !== "string") continue;
        const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
        for (const m of code.matchAll(/\b(?:import|export)\s*(?:[\w$*\s{},]*?\s*from\s*)?(["'])(\.{1,2}\/[^"'\n]+)\1/g)) {
            if (!paths.has(at(path, m[2]))) missing.push(`${path} imports ${m[2]}`);
        }
        for (const m of code.matchAll(/\bimport\s*\(\s*(["'])(\.{1,2}\/[^"'\n]+)\1\s*\)|\bnew\s+URL\s*\(\s*(["'])(\.{1,2}\/[^"'\n]+)\3\s*,\s*import\.meta\.url|\bimportScripts\s*\(\s*(["'])(\.{1,2}\/[^"'\n]+)\5/g)) {
            const spec = m[2] ?? m[4] ?? m[6];
            if (!paths.has(at(path, spec)) && !left.test(at(path, spec))) missing.push(`${path} names ${spec}`);
        }
    }
    assert.deepEqual(missing, []);
});

test("the pack's TabTop scripts are tabtopd's as they are now (rebuild it: node scripts/bootstrap/build-full-client.mjs)", () => {
    // (A file minified, by the SHA-256 of what it was: see the build's
    // minified; one that isn't, by its text.)
    const { files, minified = {} } = JSON.parse(readFileSync(new URL("../tabtopd/bootstrap.client.json", import.meta.url), "utf8"));
    const stale = [];
    for (const [path, body] of Object.entries(files)) {
        const own = path === "tty/tty.js" ? "tty.js" : path.startsWith("go/") && path.endsWith(".js") ? path.slice(3)
            : path === "go/index.html" ? "go.html"
            : path.startsWith("tabtop/") && !path.startsWith("tabtop/noble/") && path.endsWith(".js") ? path.slice(7) : null;
        if (!own || path === "tabtop/desktop.css") continue;
        const off = /hex-view|disasm-worker/.test(own);
        const source = readFileSync(new URL(`../tabtopd/${own}`, import.meta.url), "utf8")
            .replace("const DISASM_OFF = [];", off ? 'const DISASM_OFF = ["x86", "capstone", "arm64", "riscv", "mips"];' : "const DISASM_OFF = [];");
        if (Object.hasOwn(minified, path) ? createHash("sha256").update(source).digest("hex") !== minified[path] : source !== body) stale.push(path);
    }
    assert.deepEqual(stale, []);
});

test("the launcher: pages chosen by ?page=, linked to each other, the server reached only by the tunnel", () => {
    const html = buildFileLauncherHTML({ "vnc.html": "<html><head></head><body></body></html>", "tty/index.html": "<!doctype html><meta charset=utf-8><body>", "fs/index.html": "<!doctype html><body>" });
    for (const page of ["vnc.html", "tty/index.html", "fs/index.html"]) assert.ok(html.includes(JSON.stringify(page)), page);
    assert.match(html, /default-src 'none'/);
    assert.match(html, /connect-src blob: data: \$\{ws\} \$\{poll\} \$\{poll\}\//);
    assert.match(html, /tabtopOffline/);
});

test("the sealed HTML alone selects the offline connection factory", () => {
    const { files } = JSON.parse(readFileSync(new URL("../tabtopd/bootstrap.client.json", import.meta.url), "utf8"));
    assert.match(files["tabtop.html"], /globalThis\.tabtopOffline\?\.connect\(/);
    assert.match(files["tabtop.html"], /class OfflineConnection/);
    assert.doesNotMatch(files["tabtop/tunnel-protocol.js"], /tabtopOffline/);
});
