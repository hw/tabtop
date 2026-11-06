import { test } from "node:test";
import assert from "node:assert/strict";
import { previewable, resolvePath, previewLocation, previewWebURL } from "../tabtopd/preview-model.js";

test("links and pictures resolve within Downloads, relative to their folder", () => {
    const cases = [
        ["notes", "setup.md", "notes/setup.md"],
        ["notes", "./img/a.png", "notes/img/a.png"],
        ["notes/deep", "../other.md", "notes/other.md"],
        ["notes", "../../escape.md", null],
        ["", "../x", null],
        ["notes", "/etc/passwd", null],
        ["notes", "My%20File.md?raw=1", "notes/My File.md"],
        ["notes", "%E0%A4%A", null],
        ["notes", "", ""],
        ["", "a//b/./c.md", "a/b/c.md"],
    ];
    for (const [dir, p, want] of cases) {
        assert.equal(resolvePath(dir, p), want, `${dir} + ${p}`);
    }
});

test("inherited property names are ordinary unsupported extensions", () => {
    for (const name of ["report.constructor", "report.__proto__", "report.CONSTRUCTOR"]) {
        assert.equal(previewable(name, 1), false);
    }
});

test("known preview types retain their size limits and case handling", () => {
    assert.equal(previewable("photo.PNG", 50e6), true);
    assert.equal(previewable("photo.png", 50e6 + 1), false);
    assert.equal(previewable("notes.txt", 2e6), true);
    assert.equal(previewable("notes.txt", 2e6 + 1), false);
    assert.equal(previewable("README", 10), true);
    assert.equal(previewable("archive.ZIP", 5e9), true);
    assert.equal(previewable("paper.PDF", 5e9), true);  // read in parts, so any size
    assert.equal(previewable("movie.MP4", 5e9), true);
    assert.equal(previewable("movie.MKV", 5e9), true);
    assert.equal(previewable("sound.mp3", 5e9), true);
    assert.equal(previewable("book.EPUB", 5e9), true);  // read a chapter at a time
});


test("preview history accepts bounded positions and discards extra iframe properties", () => {
    const positions = {
        markdown: { top: 125, left: 0 },
        html: { top: 321, left: 0 },
        epub: { item: "text/chapter.xhtml", fraction: 0.45, size: 2 },
        pdf: { page: 3, offset: 0.3, left: 0, zoom: 1.25, mode: "width" },
    };
    for (const [kind, at] of Object.entries(positions)) {
        assert.deepEqual(previewLocation(kind, { ...at, html: "untrusted" }), { kind, ...at });
        assert.equal(previewLocation(kind, null), null);
    }
    for (const bad of [NaN, Infinity, -1, 1e10]) {
        assert.equal(previewLocation("markdown", { top: bad, left: 0 }), null);
    }
    assert.equal(previewLocation("pdf", { ...positions.pdf, page: 1.5 }), null);
    assert.equal(previewLocation("pdf", { ...positions.pdf, mode: "bad" }), null);
    assert.equal(previewLocation("epub", { ...positions.epub, fraction: 2 }), null);
    assert.equal(previewLocation("epub", { ...positions.epub, size: 7 }), null);
    assert.equal(previewLocation("epub", { ...positions.epub, item: "x".repeat(1000) }), null);
    assert.equal(previewLocation("image", positions.markdown), null);
});


test("preview web links allow only external browser destinations", () => {
    assert.equal(previewWebURL("https://example.com/a?q=1#part"), "https://example.com/a?q=1#part");
    assert.equal(previewWebURL("http://example.com"), "http://example.com/");
    assert.equal(previewWebURL("mailto:reader@example.com"), "mailto:reader@example.com");
    for (const value of [null, {}, "/local", "//example.com", "javascript:alert(1)", "data:text/html,test", "file:///etc/passwd", "https://" + "a".repeat(16384)]) {
        assert.equal(previewWebURL(value), null);
    }
});
