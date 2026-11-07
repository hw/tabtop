import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { pictureLoader } from "../tabtopd/preview-pictures.js";
import { typeOf, resolvePath } from "../tabtopd/preview-model.js";

function epubFixture({ collect: customCollect } = {}) {
    const replies = [], requests = [], tunnels = [];
    let listener, collections = 0;
    const frame = { setAttribute() {}, dataset: {}, contentWindow: {
        postMessage(message, _origin, transfer) { replies.push({ message, transfer }); },
    } };
    const env = { URL, Number, Map, Blob, ArrayBuffer, AbortController, typeOf, resolvePath,
        el: () => frame, createRangedFileReader: () => () => {}, validFileRange: () => true,
        readingTheme: () => "", bookPlace: () => null, setBookPlace() {}, previewLink() {},
        pictureLoader: options => pictureLoader({ ...options, maxBytes: 64 }),
        window: { addEventListener: (_, fn) => { listener = fn; }, removeEventListener() { listener = null; } },
        call: async request => {
            requests.push(request);
            const tunnel = { reply: request.item.endsWith(".png")
                ? { size: 20, mime: "image/png" } : { html: "<p>Chapter</p>" }, closed: false,
                close() { this.closed = true; } };
            tunnels.push(tunnel);
            return tunnel;
        },
        collect: async tunnel => { collections++; return customCollect ? customCollect(tunnel) : { arrayBuffer: async () => new ArrayBuffer(20) }; },
    };
    const source = readFileSync(new URL("../tabtopd/preview-frames.js", import.meta.url), "utf8")
        .replace(/^import .*;\n/gm, "").replace(/^export /gm, "")
        .replaceAll("import.meta.url", '"https://tabtop.test/tabtop/preview-frames.js"');
    runInNewContext(source + "\nglobalThis.epubFrame = epubFrame;", env);
    env.epubFrame("book.epub", { size: 100, mtime: "version", book: { title: "Book" } });
    let id = 0;
    const send = async data => {
        const request = ++id;
        await listener({ source: frame.contentWindow, data: { id: request, ...data } });
        return replies.find(r => r.message.id === request);
    };
    return { frame, requests, tunnels, send, collections: () => collections };
}

test("EPUB repeated pictures share a source read but each spends the chapter budget", async () => {
    const f = epubFixture();
    await f.send({ type: "chapter", item: "one.xhtml", render: 1 });
    for (let n = 0; n < 3; n++) {
        const reply = await f.send({ type: "image", src: "images/100%#pic.png", render: 1 });
        assert.equal(reply.message.bytes.byteLength, 20);
        assert.equal(reply.transfer[0], reply.message.bytes);
    }
    assert.match((await f.send({ type: "image", src: "images/100%#pic.png", render: 1 })).message.error, /limit/i);
    assert.equal(f.collections(), 1);
    assert.equal(f.requests.filter(r => r.item.endsWith(".png")).length, 1);
    await f.send({ type: "chapter", item: "two.xhtml", render: 2 });
    assert.match((await f.send({ type: "image", src: "images/100%#pic.png", render: 1 })).message.error, /replaced/i);
    assert.ok((await f.send({ type: "image", src: "images/100%#pic.png", render: 2 })).message.bytes);
    assert.equal(f.collections(), 2);
    f.frame.stop();
});

test("changing an EPUB chapter cancels its pending pictures before they are delivered", async () => {
    let finish;
    const f = epubFixture({ collect: () => new Promise(resolve => { finish = resolve; }) });
    await f.send({ type: "chapter", item: "one.xhtml", render: 1 });
    const pending = f.send({ type: "image", src: "picture.png", render: 1 });
    while (!finish) await Promise.resolve();
    const tunnel = f.tunnels.at(-1);
    await f.send({ type: "chapter", item: "two.xhtml", render: 2 });
    assert.equal(tunnel.closed, true);
    finish({ arrayBuffer: async () => new ArrayBuffer(20) });
    const reply = await pending;
    assert.match(reply.message.error, /replaced/i);
    assert.equal(reply.message.bytes, undefined);
    f.frame.stop();
});
