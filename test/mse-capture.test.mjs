import assert from "node:assert/strict";
import { test } from "node:test";
import { createCapture, mp4Encrypted, splitMp4, webmClusters, webmInit, MSE_CAPTURE_LIMIT, MSE_SPILL_SOFT } from "../tabtopd/mse-capture.js";

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

test("createCapture refuses encrypted, and a WebM track that isn't WebM", async () => {
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

// An EBML element: its ID's bytes, its payload (a size of one byte, or
// unknown: all ones).
function el(id, payload = new Uint8Array(0), unknown = false) {
    const idBytes = [];
    for (let v = id; v; v = Math.floor(v / 256)) idBytes.unshift(v & 0xff);
    const size = unknown ? [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff] : [0x40 | (payload.length >> 8), payload.length & 0xff];
    return concat(Uint8Array.from(idBytes), Uint8Array.from(size), payload);
}
const webmHead = (extra = new Uint8Array(0)) => concat(
    el(0x1A45DFA3, el(0x4282, new TextEncoder().encode("webm"))),
    // The Segment's start (its size unknown, as a live stream's), Info, Tracks.
    Uint8Array.of(0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff),
    el(0x1549A966, el(0x2AD7B1, Uint8Array.of(0x0f, 0x42, 0x40))),
    el(0x1654AE6B, el(0xAE, concat(el(0xD7, Uint8Array.of(1)), el(0x83, Uint8Array.of(1)), extra))));
const cluster = (t, unknown = false) => el(0x1F43B675, concat(el(0xE7, Uint8Array.of(t)), el(0xA3, Uint8Array.of(0x81, 0, 0, 0x80, 1, 2, 3))), unknown);

test("webmInit and webmClusters split a WebM stream: its init, then clusters, known in size or not", () => {
    const head = webmHead();
    assert.deepEqual(webmInit(head), { end: head.length });
    assert.deepEqual(webmInit(head.subarray(0, head.length - 2)), {});
    const known = cluster(0), unknown = cluster(1, true);
    const data = concat(known, unknown, cluster(2));
    const split = webmClusters(data, false);
    assert.deepEqual(split.ranges, [[0, known.length], [known.length, known.length + unknown.length], [known.length + unknown.length, data.length]]);
    // An unknown-sized one last: only at the end (forced).
    const tail = concat(known, unknown);
    assert.equal(webmClusters(tail, false).ranges.length, 1);
    assert.equal(webmClusters(tail, true).ranges.length, 2);
    // Another init: said where.
    const again = concat(known, head);
    assert.equal(webmClusters(again, false).newInit, known.length);
    assert.deepEqual(webmInit(webmHead(el(0x6D80, el(0x6240, el(0x5035))))), { encrypted: true });
    assert.deepEqual(webmInit(webmHead(el(0x6D80, el(0x6240, el(0x5034))))), { encoded: true });
});

test("createCapture spills a WebM stream's init and clusters, and saves it", async () => {
    const spilled = [];
    const cap = createCapture({ spill: async (ev) => { spilled.push({ kind: ev.kind, n: ev.bytes.length }); } });
    cap.add(0, 'video/webm; codecs="vp8"');
    const head = webmHead();
    cap.append(0, head);
    cap.append(0, cluster(0));
    cap.append(0, cluster(1, true));
    // The same init again (a seek, the player starting over): let go.
    cap.append(0, head);
    cap.append(0, cluster(2));
    await cap.flush();
    assert.equal(cap.saveable(), true);
    assert.deepEqual(spilled.map((s) => s.kind), ["init", "part", "part", "part"]);
    assert.equal(spilled[0].n, head.length);
    await cap.seal();
});

test("createCapture doesn't save an encrypted WebM stream, nor one appended at an offset", async () => {
    const enc = createCapture({ spill: async () => {} });
    enc.add(0, 'video/webm; codecs="vp9"');
    enc.append(0, concat(webmHead(el(0x6D80, el(0x6240, el(0x5035)))), cluster(0)));
    await enc.flush();
    assert.equal(enc.encrypted, true);
    assert.equal(enc.saveable(), false);

    const offset = createCapture({ spill: async () => {} });
    offset.add(0, 'audio/webm; codecs="opus"');
    offset.append(0, webmHead());
    offset.append(0, cluster(0), 10);
    offset.append(0, cluster(1), 10);
    await offset.flush();
    assert.equal(offset.saveable(), false);
    await assert.rejects(offset.seal(), /missed/);
});

// An encrypted stream (EME). A Clear Key player's is spilled encrypted and
// saved decrypted by the server, once its keys have come; one whose keys a
// CDM keeps never is. (go-media.js tells the capture: expectKeys, markKeys.)
const KID = "a7e61c373e219033c21091fa607bf3b8", KEY = "76a6c65c5ea762046bd749a2e632ccbb";
const encInit = () => {
    const stsd = box("stsd", concat(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]), box("encv", new Uint8Array(78))));
    return concat(box("ftyp"), box("moov", box("trak", box("mdia", box("minf", box("stbl", stsd))))));
};
const encPart = () => concat(box("moof", box("traf", box("senc"))), box("mdat", Uint8Array.of(1, 2, 3)));
const keyFrame = (ev) => JSON.parse(new TextDecoder().decode(ev.bytes));

test("a Clear Key player's encrypted stream is spilled as it plays, is saveable once its keys come, and its keys go to each session's stage", async () => {
    const spilled = [];
    const cap = createCapture({ spill: async (ev) => { spilled.push(ev); } });
    cap.append(0, encInit());
    assert.equal(cap.encrypted, true);
    assert.equal(cap.armed, false);
    cap.append(0, encPart());
    await cap.flush();
    assert.deepEqual(spilled, [], "nothing spilled to a stage while its player's key system isn't known");

    cap.expectKeys();  // (its player attached Clear Key MediaKeys)
    assert.equal(cap.armed, true);
    await cap.flush();
    assert.deepEqual(spilled.map((ev) => [ev.kind, ev.track]), [["init", 0], ["part", 0]], "what it held is spilled, encrypted: its keys are coming");
    assert.equal(cap.keysKnown, false);
    assert.equal(cap.saveable(), false, "not saveable without its keys");

    cap.markKeys({ [KID]: KEY });
    assert.equal(cap.keysKnown, true);
    await cap.flush();
    const key = spilled.filter((ev) => ev.kind === "key");
    assert.equal(key.length, 1, "its key, once");
    assert.deepEqual(keyFrame(key[0]), { kid: KID, key: KEY });
    assert.equal(cap.saveable(), true);
    await cap.seal();
    assert.equal(cap.bytes, 0, "all spilled");

    // A save takes the session: spills go on to a new one's, the key first.
    spilled.length = 0;
    cap.sessionTaken();
    cap.append(0, encPart());
    await cap.flush();
    assert.deepEqual(spilled.map((ev) => ev.kind), ["key", "init", "part"]);
});

test("an encrypted stream whose keys a CDM keeps is spilled nothing, and isn't saveable", async () => {
    const spilled = [];
    const cap = createCapture({ spill: async (ev) => { spilled.push(ev.kind); } });
    cap.append(0, encInit());
    cap.markEncrypted();  // (its element's encrypted event: its player asked for keys)
    cap.append(0, encPart());
    await cap.flush();
    await cap.end();
    assert.deepEqual(spilled, []);
    assert.equal(cap.encrypted, true);
    assert.equal(cap.keysKnown, false);
    assert.equal(cap.saveable(), false);
    await assert.rejects(cap.seal(), /without their keys/);
});

test("with its keys, an encrypted stream still isn't saved as a WebM track, a whole file, or appended in a seek window", async () => {
    const keys = { [KID]: KEY };
    const webm = createCapture({ spill: async () => {} });
    webm.add(0, 'video/webm; codecs="vp9"');
    webm.expectKeys();
    webm.markKeys(keys);
    webm.append(0, concat(webmHead(el(0x6D80, el(0x6240, el(0x5035)))), cluster(0)));
    await webm.flush();
    assert.equal(webm.keysKnown, true);
    assert.equal(webm.saveable(), false);
    await assert.rejects(webm.seal(), /encrypted WebM stream/);

    // A whole encrypted file (its samples in one mdat, not in fragments
    // to decrypt).
    const wholeSpilled = [];
    const whole = createCapture({ spill: async (ev) => { wholeSpilled.push(ev.kind); } });
    whole.expectKeys();
    whole.markKeys(keys);
    whole.append(0, concat(encInit(), box("mdat", Uint8Array.of(9))));
    await whole.flush();
    assert.equal(whole.encrypted, true);
    assert.equal(whole.saveable(), false);
    assert.deepEqual(wholeSpilled, [], "nothing of it staged");
    await assert.rejects(whole.seal(), /whole file/);

    // A player that seeks: what it appends then is within an append window.
    let letGo = 0;
    const seeked = createCapture({ spill: async () => {}, onRestart: () => { letGo++; } });
    seeked.expectKeys();
    seeked.markKeys(keys);
    seeked.append(0, encInit());
    seeked.append(0, encPart());
    await seeked.flush();
    assert.equal(seeked.saveable(), true);
    seeked.append(0, encPart(), 0, 10, 20);
    await seeked.flush();
    assert.equal(seeked.saveable(), false);
    assert.equal(seeked.bytes, 0, "what it held let go");
    assert.equal(letGo, 1, "its stage let go");
    await assert.rejects(seeked.seal(), /seek window/);
});
