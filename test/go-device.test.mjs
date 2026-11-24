import assert from "node:assert/strict";
import { test } from "node:test";
import { viewerDevices, sendPasteImage } from "../tabtopd/go-device.js";

function fixture() {
    const box = new EventTarget(), allow = new EventTarget(), refuse = new EventTarget(), text = {};
    box.querySelector = key => ({ p: text, ".allow": allow, ".refuse": refuse })[key];
    allow.focus = refuse.focus = () => {};
    const sent = [], ctx = { gen: 3, socket: { send: data => sent.push(JSON.parse(data)) } };
    const video = new EventTarget();
    const devices = viewerDevices(box, () => ctx, id => id === 7 ? video : null);
    const ask = (kind, fields = {}) => devices.ask({ kind, gen: 3, ask: kind, origin: "https://visited.example", ...fields });
    return { ask, box, allow, refuse, text, sent, ctx, video, devices };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test("share and location use an origin-labelled approval, and navigation drops a late location", async t => {
    const f = fixture();
    let shared, position;
    Object.defineProperties(navigator, {
        share: { configurable: true, value: async data => { shared = data; } },
        geolocation: { configurable: true, value: { getCurrentPosition: cb => { position = cb; } } },
    });
    t.after(() => { delete navigator.share; delete navigator.geolocation; f.devices.reset(); });
    f.ask("share", { data: { text: "hello" } });
    assert.match(f.text.textContent, /https:\/\/visited\.example/);
    assert.equal(shared, undefined);
    f.allow.dispatchEvent(new Event("click"));
    await tick();
    assert.deepEqual(shared, { text: "hello" });
    assert.equal(f.sent.at(-1).accept, true);
    f.ask("location");
    f.refuse.dispatchEvent(new Event("click"));
    assert.equal(f.sent.at(-1).value, "NotAllowedError");
    assert.equal(position, undefined);
    f.ask("location");
    f.allow.dispatchEvent(new Event("click"));
    position({ timestamp: 123, coords: { latitude: 0, longitude: 15, accuracy: 4 } });
    await tick();
    assert.equal(JSON.parse(f.sent.at(-1).value).coords.latitude, 0);
    f.ask("location");
    f.allow.dispatchEvent(new Event("click"));
    f.ctx.gen++;
    f.devices.reset();
    position({ timestamp: 124, coords: { latitude: 8 } });
    await tick();
    assert.equal(f.sent.length, 3);
});

test("PiP maps the page node to the live video and forwards native resize and leave", async t => {
    const f = fixture(), win = Object.assign(new EventTarget(), { width: 320, height: 180 });
    globalThis.document = { pictureInPictureElement: null };
    t.after(() => { f.devices.reset(); delete globalThis.document; });
    f.video.requestPictureInPicture = async () => { document.pictureInPictureElement = f.video; return win; };
    f.ask("pip", { node: 99 });
    assert.equal(f.sent.at(-1).value, "InvalidStateError");
    f.ask("pip", { node: 7 });
    f.allow.dispatchEvent(new Event("click"));
    await tick();
    assert.equal(f.sent.at(-1).fx, 320);
    win.width = 500;
    win.dispatchEvent(new Event("resize"));
    assert.equal(f.sent.at(-1).kind, "pip-resize");
    assert.equal(f.sent.at(-1).fx, 500);
    document.pictureInPictureElement = null;
    f.video.dispatchEvent(new Event("leavepictureinpicture"));
    assert.equal(f.sent.at(-1).kind, "pip-left");
});

test("PNG transfer preserves bytes and frame identity across bounded tunnel messages", async () => {
    const f = fixture(), bytes = Uint8Array.from({ length: 95003 }, (_, i) => i % 251);
    const msg = { gen: 3, id: 5, frame: 3, route: [5], docs: [0], fdoc: 8, png: new Blob([bytes], { type: "image/png" }) };
    await sendPasteImage(msg, () => f.ctx, assert.fail);
    assert.deepEqual(f.sent[0].route, [5]);
    assert.equal(f.sent[0].count, bytes.length);
    assert.equal(f.sent.at(-1).type, "end");
    const chunks = f.sent.slice(1, -1);
    assert.ok(chunks.length >= 3 && chunks.every(m => m.text === f.sent[0].text && JSON.stringify(m).length < 65536));
    assert.deepEqual(Buffer.from(chunks.map(m => m.value).join(""), "base64"), Buffer.from(bytes));
    f.sent.length = 0;
    f.ctx.gen++;
    await sendPasteImage(msg, () => f.ctx, assert.fail);
    assert.equal(f.sent.length, 0);
});

test("a followed position: asked, its first the answer, the rest as they come; stopped by the page, or a reset", async t => {
    const f = fixture();
    let found, failed;
    const cleared = [];
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
        watchPosition: (cb, err) => { found = cb; failed = err; return 42; },
        clearWatch: id => cleared.push(id),
    } });
    t.after(() => { delete navigator.geolocation; f.devices.reset(); });
    f.ask("location-watch", { options: {} });
    assert.match(f.text.textContent, /follow your location/);
    assert.equal(found, undefined, "followed before it's allowed");
    f.allow.dispatchEvent(new Event("click"));
    await tick();
    found({ timestamp: 1, coords: { latitude: 1, longitude: 2, accuracy: 3 } });
    await tick();
    assert.equal(f.sent.at(-1).accept, true);
    assert.equal(JSON.parse(f.sent.at(-1).value).coords.latitude, 1);
    // Sooner than 250 ms: held, the newest sent when it may be.
    found({ timestamp: 2, coords: { latitude: 5, longitude: 2, accuracy: 3 } });
    found({ timestamp: 3, coords: { latitude: 6, longitude: 2, accuracy: 3 } });
    assert.equal(f.sent.at(-1).accept, true, "sent at once, sooner than 250 ms");
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(f.sent.at(-1).kind, "location-update");
    assert.equal(JSON.parse(f.sent.at(-1).value).coords.latitude, 6);
    assert.equal(f.sent.filter(m => m.kind === "location-update").length, 1, "the one held between sent too");
    failed({ code: 3 });
    assert.deepEqual([f.sent.at(-1).kind, f.sent.at(-1).value], ["location-error", "TimeoutError"]);
    // Stopped by the page: no more sent.
    f.ask("location-stop");
    await tick();
    assert.deepEqual(cleared, [42]);
    assert.equal(f.sent.at(-1).accept, true);
    const sent = f.sent.length;
    found({ timestamp: 3, coords: { latitude: 9, longitude: 2, accuracy: 3 } });
    assert.equal(f.sent.length, sent, "a position sent after its stop");
    // Followed again, then the page left (a reset): cleared.
    f.ask("location-watch", { options: {} });
    f.allow.dispatchEvent(new Event("click"));
    await tick();
    found({ timestamp: 4, coords: { latitude: 1, longitude: 2, accuracy: 3 } });
    await tick();
    f.devices.reset();
    assert.deepEqual(cleared, [42, 42]);
});

test("files shared: asked once they've all come, shared as named; one that doesn't come, a data error", async t => {
    const box = new EventTarget(), allow = new EventTarget(), refuse = new EventTarget(), text = {};
    box.querySelector = key => ({ p: text, ".allow": allow, ".refuse": refuse })[key];
    allow.focus = refuse.focus = () => {};
    const sent = [], ctx = { gen: 3, socket: { send: data => sent.push(JSON.parse(data)) } };
    const files = new Map([[11, new File(["hello"], "page-said.txt", { type: "text/plain" })]]);
    const devices = viewerDevices(box, () => ctx, () => null, async id => files.get(id) ?? null);
    let shared;
    Object.defineProperty(navigator, "share", { configurable: true, value: async data => { shared = data; } });
    Object.defineProperty(navigator, "canShare", { configurable: true, value: data => (data.files ?? []).every(f => f instanceof File) });
    t.after(() => { delete navigator.share; delete navigator.canShare; devices.reset(); });
    box.hidden = true;
    devices.ask({ kind: "share", gen: 3, ask: "s1", origin: "https://visited.example", data: { title: "Notes" }, files: [{ stream: 11, name: "note.txt", type: "text/plain", size: 5 }] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(box.hidden, false, "not asked once its file came");
    assert.match(text.textContent, /share sheet with note\.txt/);
    allow.dispatchEvent(new Event("click"));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(shared.title, "Notes");
    assert.equal(shared.files[0].name, "note.txt", "not shared as the server named it");
    assert.equal(await shared.files[0].text(), "hello");
    assert.equal(sent.at(-1).accept, true);
    devices.ask({ kind: "share", gen: 3, ask: "s2", origin: "https://visited.example", data: {}, files: [{ stream: 99, name: "gone.txt", type: "", size: 1 }] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.at(-1).value, "DataError");
});
