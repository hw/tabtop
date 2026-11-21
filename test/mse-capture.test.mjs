import assert from "node:assert/strict";
import { test } from "node:test";
import { createCapture, mp4Encrypted, splitMp4, MSE_CAPTURE_LIMIT, MSE_SPILL_SOFT } from "../tabtopd/mse-capture.js";

function box(type, body = new Uint8Array(0)) {
    const out = new Uint8Array(8 + body.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, out.length);
    out[4] = type.charCodeAt(0);
    out[5] = type.charCodeAt(1);
    out[6] = type.charCodeAt(2);
    out[7] = type.charCodeAt(3);
    out.set(body, 8);
    return out;
}

function concat(...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}

test("splitMp4 separates init from media fragments", () => {
    const data = concat(box("ftyp"), box("moov"), box("moof"), box("mdat", Uint8Array.of(1, 2)), box("moof"), box("mdat", Uint8Array.of(3)));
    const split = splitMp4(data);
    assert.ok(split.init);
    assert.equal(split.parts.length, 2);
    assert.equal(split.parts[0][4], "m".charCodeAt(0));
});

test("splitMp4 keeps a progressive file whole", () => {
    const data = concat(box("ftyp"), box("moov"), box("mdat", Uint8Array.of(9)));
    const split = splitMp4(data);
    assert.deepEqual(split.progressive, data);
});

test("mp4Encrypted finds encv and senc", () => {
    assert.equal(mp4Encrypted(concat(box("ftyp"), box("moov"))), false);
    assert.equal(mp4Encrypted(box("encv")), true);
    assert.equal(mp4Encrypted(box("moof", box("traf", box("senc")))), true);
});

test("createCapture spills clear fMP4 parts and frees local bytes", async () => {
    const spilled = [];
    const cap = createCapture({
        spill: async (ev) => { spilled.push({ kind: ev.kind, track: ev.track, n: ev.bytes.length }); },
    });
    const partBody = new Uint8Array(100);
    const data = concat(box("ftyp"), box("moov"), box("moof"), box("mdat", partBody), box("moof"), box("mdat", partBody));
    cap.add(0, 'video/mp4; codecs="avc1.42c00c"');
    cap.append(0, data.subarray(0, 10));
    cap.append(0, data.subarray(10));
    await cap.flush();
    assert.equal(cap.saveable(), true);
    assert.ok(spilled.some((s) => s.kind === "init"));
    assert.ok(spilled.filter((s) => s.kind === "part").length >= 1);
    assert.ok(cap.bytes < data.length);
});

test("createCapture spills progressive bytes", async () => {
    const spilled = [];
    const cap = createCapture({
        spill: async (ev) => { spilled.push(ev.kind); },
    });
    const data = concat(box("ftyp"), box("moov"), box("mdat", Uint8Array.of(9, 8, 7)));
    cap.append(0, data);
    await cap.flush();
    assert.deepEqual(spilled, ["progressive"]);
    assert.equal(cap.saveable(), true);
    assert.equal(cap.bytes, 0);
});

test("createCapture refuses encrypted and webm", async () => {
    const enc = createCapture({ spill: async () => {} });
    enc.append(0, box("encv"));
    assert.equal(enc.saveable(), false);

    const webm = createCapture({ spill: async () => {} });
    webm.add(0, "video/webm; codecs=\"vp9\"");
    webm.append(0, concat(box("ftyp"), box("moov"), box("moof"), box("mdat")));
    await webm.flush();
    assert.equal(webm.saveable(), false);
});

test("createCapture hard cap stops accepting when spill lags", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const cap = createCapture({
        spill: async () => { await gate; },
    });
    // Build one large complete progressive blob under the hard cap, then more.
    const chunk = box("mdat", new Uint8Array(MSE_SPILL_SOFT));
    const header = concat(box("ftyp"), box("moov"));
    cap.append(0, header);
    cap.append(0, chunk);
    // Spill is in flight (blocked); fill past the hard cap with another append.
    const filler = new Uint8Array(MSE_CAPTURE_LIMIT);
    cap.append(0, filler);
    assert.equal(cap.full, true);
    release();
    await cap.flush();
});

test("markSaved clears saveable until more spills", async () => {
    const cap = createCapture({ spill: async () => {} });
    const data = concat(box("ftyp"), box("moov"), box("moof"), box("mdat", Uint8Array.of(1)));
    cap.append(0, data);
    await cap.flush();
    assert.equal(cap.saveable(), true);
    cap.markSaved();
    assert.equal(cap.saveable(), false);
});
