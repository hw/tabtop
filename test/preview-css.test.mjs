import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const env = {};
runInNewContext(readFileSync(new URL("../tabtopd/third-party/css-tree.js", import.meta.url), "utf8"), env);
runInNewContext(readFileSync(new URL("../tabtopd/preview-css.js", import.meta.url), "utf8"), env);
function processor(files = {}) {
    const loads = [], errors = [], external = [];
    return { loads, errors, external, css: env.TabTopCSS.cssProcessor({
        load: async (src, base, kind, text) => {
            const url = new URL(src, base || "https://example.test/").href;
            loads.push({ url, kind });
            if (text) { if (!(url in files)) throw new Error("missing CSS"); return { text: files[url], base: url }; }
            return "blob:rewritten-" + loads.length;
        }, external: (...args) => external.push(args), error: message => errors.push(message),
    }) };
}
test("CSS imports, font files and backgrounds resolve through the broker", async () => {
    const p = processor({ "https://example.test/css/nested.css": '@font-face{font-family:Remote;src:url(../fonts/test.woff2) format("woff2")} .copy{color:rgb(1,2,3)}' });
    const result = await p.css.stylesheet('@import "nested.css"; body{background-image:url(../pic.png);font-family:Remote} .copy{font-weight:600}', "https://example.test/css/main.css");
    assert.deepEqual(p.loads.map(l => [l.url, l.kind]), [["https://example.test/css/nested.css", "css"], ["https://example.test/fonts/test.woff2", "font"], ["https://example.test/pic.png", "image"]]);
    assert.match(result, /@font-face/);
    assert.match(result, /blob:rewritten-/);
    assert.doesNotMatch(result, /https:|@import/);
    assert.match(result, /:where\(#doc\)/);
    assert.equal(p.errors.length, 0);
});
test("CSS cannot escape its content scope or hide URLs in opaque functions", async () => {
    const p = processor();
    const result = await p.css.stylesheet('#doc + #bar{display:none}body + #bar{display:none} @unknown url(https://evil.test/){x:y} .copy{position:fixed;background:image-set("https://evil.test/a" 1x);color:red}');
    assert.match(result, /:where\(#doc\) #doc\+#bar/);
    assert.doesNotMatch(result, /fixed|evil|image-set/);
    assert.equal(p.loads.length, 0);
    assert.match(result, /color:red/);
});
test("CSS import cycles and deep imports terminate within the configured budget", async () => {
    const p = processor({ "https://example.test/a.css": '@import "b.css";.a{color:red}', "https://example.test/b.css": '@import "a.css";.b{color:blue}' });
    const result = await p.css.stylesheet('@import "a.css"');
    assert.ok(p.loads.length <= 3);
    assert.match(result, /color:red/);
    await assert.rejects(p.css.stylesheet("x".repeat(512 * 1024 + 1)), /limit/);
});

test("custom properties and var fallbacks have their URLs rewritten before CSS is applied", async () => {
    const p = processor();
    const result = await p.css.stylesheet(':root{--image:url(https://example.test/bg.png);--Ink:rgb(1,2,3)}.copy{background-image:var(--image);color:var(--Ink)}');
    assert.match(result, /--image:url\(blob:rewritten-/);
    assert.match(result, /background-image:var\(--image\)/);
    assert.doesNotMatch(result, /https:/);
    assert.equal(p.loads.length, 1);
    assert.match(result, /--Ink:rgb/);
});

test("malformed import blocks are discarded without loading or generating raw CSS", async () => {
    const p = processor();
    const result = await p.css.stylesheet('@import url("https://evil.test/style.css") {#bar{display:none}} .copy{color:red}');
    assert.equal(p.loads.length, 0);
    assert.doesNotMatch(result, /evil|#bar|@import/);
    assert.match(result, /color:red/);
});

test("empty and inline styles do not consume the fetched stylesheet quota", async () => {
    const p = processor();
    for (let i = 0; i < 80; i++) await p.css.stylesheet(i % 2 ? "" : "  \n");
    for (let i = 0; i < 40; i++) assert.match(await p.css.stylesheet(`.item${i}{color:red}`), /color:red/);
    assert.equal(p.errors.length, 0);
    for (let i = 0; i < 16; i++) await p.css.stylesheet("", "https://example.test/sheet.css", [], 0, true);
    await assert.rejects(p.css.stylesheet("", "https://example.test/extra.css", [], 0, true), /import limit/);
});
test("qualified imports preserve layers, supports conditions and media in order", async () => {
    const sheet = ".copy{color:red}";
    for (const [qualifier, expected] of [
        ["layer(theme)", /@layer theme\{/], ["layer", /@layer\{/],
        ["layer(theme.base)", /@layer theme\.base\{/],
        ["supports(display:grid)", /@supports \(display:grid\)\{/],
        ["supports(not (display:grid))", /@supports not \(display:grid\)\{/],
        ["layer(theme) supports(display:grid) screen", /@layer theme\{@supports \(display:grid\)\{@media screen\{/],
    ]) {
        const p = processor({ "https://example.test/theme.css": sheet });
        const result = await p.css.stylesheet(`@import "theme.css" ${qualifier};`);
        assert.match(result, expected, qualifier);
        assert.match(result, /color:red/, qualifier);
        assert.equal(p.errors.length, 0, qualifier);
    }
    const p = processor({ "https://example.test/theme.css": sheet });
    assert.match(await p.css.stylesheet('@layer first,second;@import "theme.css" layer(second);'), /^@layer first,second;@layer second\{/);
});
test("inline styles retain cumulative byte and work limits", async () => {
    const p = processor();
    const sheet = " ".repeat(512 * 1024 - 20) + "p{color:red}";
    for (let i = 0; i < 4; i++) await p.css.stylesheet(sheet);
    await assert.rejects(p.css.inline("color:red;".repeat(30)), /preview limit/);
});
