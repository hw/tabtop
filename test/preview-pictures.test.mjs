import { test } from "node:test";
import assert from "node:assert/strict";
import { pictureLoader } from "../tabtopd/preview-pictures.js";
import { resolvePath } from "../tabtopd/preview-model.js";

function fixture(options = {}) {
    const reads = [];
    const loader = pictureLoader({
        resolve: src => resolvePath("", src.split("#")[0]),
        load: async (path, reserve) => {
            reads.push(path);
            if (!reserve(20)) return { error: "cache budget" };
            return { bytes: new ArrayBuffer(20), mime: "image/png" };
        }, ...options,
    });
    return { loader, reads };
}

test("each repeated image spends the byte budget, while aliases share a read", async () => {
    const { loader, reads } = fixture({ maxBytes: 64 });
    for (const src of ["picture.png", "./picture.png#one", "picture.png#two"]) {
        assert.equal((await loader.read(src)).bytes.byteLength, 20);
    }
    for (let n = 0; n < 500; n++) assert.match((await loader.read("picture.png")).error, /limit/i);
    assert.deepEqual(reads, ["picture.png"]);
    loader.stop();
});

test("small repeated images count toward the image limit too", async () => {
    const { loader, reads } = fixture({ maxPictures: 3 });
    for (let n = 0; n < 3; n++) assert.ok((await loader.read("picture.png")).bytes);
    assert.match((await loader.read("picture.png")).error, /limit/i);
    assert.equal(reads.length, 1);
});

test("concurrent different pictures reserve aggregate cache space before loading", async () => {
    const { loader } = fixture({ maxBytes: 64 });
    const results = await Promise.all(Array.from({ length: 100 }, (_, i) => loader.read(`${i}.png`)));
    assert.equal(results.filter(r => r.bytes).length, 3);
    assert.equal(results.filter(r => r.error).length, 97);
});

test("replacing a render aborts old reads and suppresses their results", async () => {
    let finish, signal;
    const { loader } = fixture({ load: async (_path, reserve, currentSignal) => {
        signal = currentSignal;
        assert.ok(reserve(20));
        return await new Promise(resolve => { finish = resolve; });
    } });
    const reading = loader.read("picture.png");
    await Promise.resolve();
    loader.stop();
    assert.equal(signal.aborted, true);
    finish({ bytes: new ArrayBuffer(20) });
    assert.match((await reading).error, /closed/i);
    assert.match((await loader.read("new.png")).error, /closed/i);
});
