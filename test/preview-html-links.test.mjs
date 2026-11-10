import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
const env = { URL };
runInNewContext(readFileSync(new URL("../tabtopd/preview-html-links.js", import.meta.url), "utf8"), env);
const { reference, anchorHref, sourceURL } = env.TabTopHTMLLinks;
const node = attrs => ({ getAttribute: key => attrs[key] ?? null });
const root = (urls, ids, meta = []) => ({ querySelectorAll: selector => selector.startsWith("base[") ? meta : selector === "a[href]" ? urls.map(href => node({ href })) : ids.map(id => node({ id })) });

test("saved-page declared targets resolve from unambiguous document self-links", () => {
    const base = "https://www.gartner.com/doc/reprints?id=example";
    const source = sourceURL(root([base + "#one", base + "#two"], ["one", "two"]), "<!-- saved from url=(0014)about:internet -->");
    assert.equal(source, base);
    assert.equal(anchorHref(node({ "data-ga-content-link": "/document/code/123?ref=test" }), source), "https://www.gartner.com/document/code/123?ref=test");
    assert.equal(anchorHref(node({ "data-href": "https://example.test/read" }), null), "https://example.test/read");
    assert.equal(anchorHref(node({ "data-href": "//example.test/read" }), null), "https://example.test/read");
});
test("ambiguous source hints and executable data destinations do not become links", () => {
    const links = ["https://a.test/page#one", "https://a.test/page#two", "https://b.test/page#one", "https://b.test/page#two"];
    assert.equal(sourceURL(root(links, ["one", "two"]), ""), null);
    assert.equal(sourceURL(root([links[0]], ["one"]), ""), null);
    for (const value of ["javascript:alert(1)", "data:text/html,unsafe", "file:///etc/passwd", "/document/code/123"]) assert.equal(anchorHref(node({ "data-ga-content-link": value }), null), null);
});
test("HTML URL whitespace is normalized while ordinary local links stay local", () => {
    assert.equal(reference(" \nhttps://exam\tple.test/logo.png\r "), "https://example.test/logo.png");
    assert.equal(anchorHref(node({ href: " \thttps://example.test/read\n " }), null), "https://example.test/read");
    assert.equal(anchorHref(node({ href: "next.html#heading" }), "https://example.test/read"), "next.html#heading");
    assert.equal(anchorHref(node({ href: "javascript:alert(1)" }), null), null);
});
