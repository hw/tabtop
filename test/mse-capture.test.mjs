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
    // A progressive stream with a gap can't be saved.
    assert.equal(cap.saveable(), false);
});

test("a save taking the session clears saveable until more spills", async () => {
    const cap = createCapture({ spill: async () => {} });
    const data = concat(box("ftyp"), box("moov"), box("moof"), box("mdat", Uint8Array.of(1)));
    cap.append(0, data);
    await cap.flush();
    assert.equal(cap.saveable(), true);
    cap.sessionTaken();  // (the save started with its session)
    cap.markSaved();
    assert.equal(cap.saveable(), false);
});

test("styp stays with its media and each fragment keeps its append offset", async () => {
    const events = [];
    const cap = createCapture({ spill: ev => events.push(ev) });
    const init = concat(box("ftyp"), box("moov"));
    const part = concat(box("styp"), box("moof"), box("mdat", Uint8Array.of(1)));
    const split = splitMp4(concat(init, part, part));
    assert.deepEqual(split.parts, [part, part]);
    cap.append(0, init);
    cap.append(0, part.subarray(0, 12), -95443);
    cap.append(0, part.subarray(12), -95443);
    cap.append(0, part, -1, 10, 20);
    await cap.seal();
    const parts = events.filter(ev => ev.kind === "part");
    assert.deepEqual(parts.map(ev => [ev.offset, ev.windowStart, ev.windowEnd]), [[-95443, 0, Infinity], [-1, 10, 20]]);
    assert.deepEqual(parts.map(ev => ev.bytes), [part, part]);
});

test("a WebM audio buffer blocks a video-only save even after MP4 data was staged", async () => {
    const cap = createCapture();
    cap.add(0, "video/mp4");
    cap.append(0, concat(box("ftyp"), box("moov"), box("moof"), box("mdat")));
    await cap.flush();
    cap.add(1, 'audio/webm; codecs="opus"');
    assert.equal(cap.saveable(), false);
    await assert.rejects(cap.seal(), /unsupported track format/);
});

test("seal propagates the staging error when a final part fails", async () => {
    const cap = createCapture({ spill({kind}) {
        if (kind === "part") throw new Error("disk unavailable");
    } });
    cap.append(0, concat(box("ftyp"), box("moov"), box("moof"), box("mdat")));
    await assert.rejects(cap.seal(), /disk unavailable/);
});

test("an append too big to hold is dropped, and what follows is taken again", async () => {
    const spilled = [];
    const cap = createCapture({ spill: async (ev) => { spilled.push(ev.kind); } });
    const frag = (n) => concat(box("moof"), box("mdat", new Uint8Array(n)));
    cap.append(0, concat(box("ftyp"), box("moov"), frag(1 << 20)));  // (under the soft limit: no spill)
    cap.append(0, frag(MSE_CAPTURE_LIMIT));  // over the cap: dropped
    await new Promise((r) => setTimeout(r, 10));
    const before = cap.bytes;
    cap.append(0, frag(1000));
    assert.equal(cap.full, false, "still full, nothing spilling");
    assert.ok(cap.bytes > before, "the next fragment dropped too");
});

test("mp4Encrypted finds an encrypted sample entry in stsd (no pssh, no senc)", () => {
    // stsd: version and flags, an entry count, then its entries.
    const stsd = box("stsd", concat(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]), box("encv", new Uint8Array(78))));
    const moov = box("moov", box("trak", box("mdia", box("minf", box("stbl", stsd)))));
    assert.equal(mp4Encrypted(concat(box("ftyp"), moov)), true);
    const clear = box("moov", box("trak", box("mdia", box("minf", box("stbl", box("stsd", concat(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]), box("avc1", new Uint8Array(78)))))))));
    assert.equal(mp4Encrypted(concat(box("ftyp"), clear)), false);
});
