import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { resolvePath, typeOf } from "../tabtopd/preview-model.js";
import { createRangedFileReader } from "../tabtopd/ranged-file.js";
import { pictureLoader } from "../tabtopd/preview-pictures.js";
const env = { URL, resolvePath, typeOf, pictureLoader, AbortController };
const source = readFileSync(new URL("../tabtopd/preview-resources.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replace(/^export /gm, "");
runInNewContext(source + "\nglobalThis.address = resourceAddress;", env);

test("resource addresses use stylesheet redirect bases and confine local paths", () => {
    assert.equal(env.address("../font.woff2", "https://example.test/css/final.css", "").url, "https://example.test/font.woff2");
    assert.equal(env.address("../font.woff2", "local:book/css/main.css", "other").url, "book/font.woff2");
    assert.equal(env.address("//example.test/font.woff2", "", "").url, "https://example.test/font.woff2");
    assert.equal(env.address(" \nhttps://example.test/font.woff2\t ", "", "").url, "https://example.test/font.woff2");
    for (const src of ["file:///etc/passwd", "javascript:alert(1)", "https://user:secret@example.test/font", "../../../escape.css"]) assert.equal(env.address(src, "", "book"), null);
});

test("remote media range reads carry snapshot metadata and reject changed media", async () => {
    const sent = [];
    let closed = 0, changed = false;
    const read = createRangedFileReader({
        call: async request => { sent.push(request); return { reply: { mime: "video/mp4", total_size: changed ? 999 : 1000, validator: '"one"' }, close() { closed++; } }; },
        collect: async (_t, size) => new Blob([new Uint8Array(size)]),
    });
    const file = { remote: true, type: "video/mp4", size: 1000, mtime: '"one"' };
    assert.equal((await read("https://example.test/movie.mp4", file, 100, 120, { maxBytes: 1024 })).byteLength, 20);
    assert.deepEqual(sent[0], { type: "preview-resource", resource: "media", url: "https://example.test/movie.mp4", offset: 100, length: 20, if_mtime: '"one"', if_size: 1000 });
    changed = true;
    await assert.rejects(read("https://example.test/movie.mp4", file, 100, 120, { maxBytes: 1024 }), /changed/);
    assert.equal(closed, 2);
    await assert.rejects(read("https://example.test/movie.mp4", file, 0, 1001, { maxBytes: 1024 }), /not a part/);
    assert.equal(sent.length, 2);
});
