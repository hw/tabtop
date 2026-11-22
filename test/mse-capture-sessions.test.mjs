// A buffered stream's capture (tabtopd/mse-capture.js) across staging
// sessions: what the server's session gets after a save, a failed save, a
// failed spill, and the player switching quality. The session is modelled as
// the server keeps it (gostreammse.go appendFrame): an init per track first,
// once; then that track's parts.
import assert from "node:assert/strict";
import { test } from "node:test";

const { createCapture } = await import(process.env.MSE_CAPTURE ?? "../tabtopd/mse-capture.js");

function box(type, body = new Uint8Array(0)) {
    const out = new Uint8Array(8 + body.length);
    new DataView(out.buffer).setUint32(0, out.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    return out;
}
const concat = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
};
const init = (tag) => concat(box("ftyp"), box("moov", Uint8Array.of(tag)));
const part = (n) => concat(box("moof"), box("mdat", new Uint8Array(n)));

// A server session, as gostreammse.go keeps one: refusing what it would.
function server() {
    const sessions = [];
    let open = null;
    return {
        sessions,
        drop() { open = null; },  // finalized, forgotten, or its time up
        spill(ev) {
            if (!Number.isInteger(ev.track) || ev.track < 0 || ev.track > 7) throw new Error("invalid stream track");  // (as gostreammse.go)
            if (!open) { open = { tracks: new Map(), refused: null }; sessions.push(open); }
            const tr = open.tracks.get(ev.track);
            if (ev.kind === "init") {
                if (tr) throw new Error("stream init already sent");
                open.tracks.set(ev.track, { init: ev.bytes, parts: [] });
            } else if (ev.kind === "part") {
                if (!tr) { open = null; throw new Error("stream part before init"); }
                if (ev.bytes.length >= 8 && String.fromCharCode(...ev.bytes.subarray(4, 8)) !== "moof") throw new Error("not a part");
                for (let at = 0; at + 8 <= ev.bytes.length;) {
                    const size = new DataView(ev.bytes.buffer, ev.bytes.byteOffset + at).getUint32(0);
                    if (String.fromCharCode(...ev.bytes.subarray(at + 4, at + 8)) === "moov") throw new Error("unexpected initialization segment");
                    at += size;
                }
                tr.parts.push(ev.bytes);
            }
        },
    };
}

test("after a save, the next session gets each track's init before its parts", async () => {
    const srv = server();
    const cap = createCapture({ spill: async (ev) => srv.spill(ev), onRestart: () => srv.drop() });
    cap.add(0, "video/mp4");
    cap.append(0, concat(init(1), part(100), part(100)));
    await cap.flush();
    await cap.seal();
    srv.drop();  // finalized: the server gives the session up
    cap.sessionTaken?.();  // (go.js, as the save starts)
    cap.markSaved();
    cap.append(0, concat(part(100), part(100)));
    await cap.flush();
    assert.equal(srv.sessions.length, 2);
    assert.ok(srv.sessions[1].tracks.get(0)?.init, "the second session has no init");
    assert.ok(srv.sessions[1].tracks.get(0).parts.length >= 1);
    assert.equal(cap.saveable(), true);
});

test("after a failed save, spills go on, to a new session", async () => {
    const srv = server();
    const cap = createCapture({ spill: async (ev) => srv.spill(ev), onRestart: () => srv.drop() });
    cap.add(0, "video/mp4");
    cap.append(0, concat(init(1), part(100)));
    await cap.flush();
    await cap.seal();
    srv.drop();
    cap.saveFailed?.();  // (absent before: the capture stayed sealed)
    for (let i = 0; i < 3; i++) cap.append(0, part(2 << 20));  // past a spill's 4 MiB
    await new Promise((r) => setTimeout(r, 20));
    await cap.flush();
    assert.equal(srv.sessions.length, 2, "nothing spilled after the failed save");
    assert.ok(srv.sessions[1].tracks.get(0)?.init && srv.sessions[1].tracks.get(0).parts.length >= 1);
});

test("a spill the server refused begins a new session, its init first", async () => {
    const srv = server();
    let fail = false;
    const cap = createCapture({ spill: async (ev) => { if (fail) { fail = false; srv.drop(); throw new Error("buffered stream was cancelled"); } srv.spill(ev); }, onRestart: () => srv.drop() });
    cap.add(0, "video/mp4");
    cap.append(0, concat(init(1), part(100)));
    await cap.flush();
    fail = true;
    cap.append(0, part(100));
    await cap.flush();  // refused: its session gone
    cap.append(0, part(100));
    await cap.flush();
    const last = srv.sessions.at(-1);
    assert.equal(srv.sessions.length, 2);
    assert.ok(last.tracks.get(0)?.init, "the new session has no init");
    assert.ok(last.tracks.get(0).parts.length >= 1);
});

test("the player switching quality (a new init) begins a new session with it", async () => {
    const srv = server();
    const cap = createCapture({ spill: async (ev) => srv.spill(ev), onRestart: () => srv.drop() });
    cap.add(0, "video/mp4");
    cap.add(1, "audio/mp4");
    cap.append(0, concat(init(1), part(100)));
    cap.append(1, concat(init(9), part(50)));
    await cap.flush();
    cap.append(0, concat(part(100), init(2), part(100), part(100)));  // 360p, then 1080p's init
    cap.append(1, part(50));
    await cap.flush();
    const last = srv.sessions.at(-1);
    assert.equal(srv.sessions.length, 2);
    assert.equal(last.tracks.get(0)?.init?.at(-1), 2, "the new session has the new init");
    assert.equal(last.tracks.get(1)?.init?.at(-1), 9, "the other track's init sent again");
    assert.ok(last.tracks.get(0).parts.length >= 1);
    assert.equal(cap.saveable(), true);
});

test("appends dropped while the capture is full leave no broken parts", async () => {
    const srv = server();
    let hold = null;
    const cap = createCapture({
        spill: async (ev) => { if (hold) await hold; srv.spill(ev); },
        onRestart: () => srv.drop(),
    });
    cap.add(0, "video/mp4");
    cap.append(0, concat(init(1), part(100)));
    await cap.flush();
    // The upload stalls; playback goes on, its fragments appended in pieces.
    let go;
    hold = new Promise((r) => { go = r; });
    const big = part(3 << 20);
    for (let i = 0; i < 8; i++) {
        cap.append(0, big.subarray(0, 256 << 10));       // a fragment's start…
        cap.append(0, big.subarray(256 << 10));          // …and its rest
    }
    assert.equal(cap.full, true, "never full");
    go();
    hold = null;
    await new Promise((r) => setTimeout(r, 20));
    // Playback goes on: the next fragments in pieces again, then three marked
    // ones (an mdat of 101, 102, 103 bytes), which should all reach the server.
    for (let i = 0; i < 2; i++) {
        cap.append(0, big.subarray(0, 256 << 10));
        cap.append(0, big.subarray(256 << 10));
    }
    for (const n of [101, 102, 103]) cap.append(0, part(n));
    await cap.flush();
    const sizes = srv.sessions.flatMap((ss) => [...ss.tracks.values()].flatMap((tr) => tr.parts.map((p) => p.length)));
    for (const n of [101, 102, 103]) assert.ok(sizes.includes(16 + n), `the part appended after the stall (${n}) never spilled: ${sizes.slice(-6).join(",")}`);
    for (const session of srv.sessions) {
        for (const tr of session.tracks.values()) {
            for (const p of tr.parts) {
                // Each part whole: a moof, then an mdat ending where the part does.
                let at = 0, types = [];
                for (let n = 0; at + 8 <= p.length && n < 64; n++) {
                    const size = new DataView(p.buffer, p.byteOffset + at).getUint32(0);
                    types.push(String.fromCharCode(...p.subarray(at + 4, at + 8)));
                    if (size < 8) break;
                    at += size;
                }
                assert.ok(at === p.length && types[0] === "moof" && types.every((t) => t === "moof" || t === "mdat"), `a broken part: ${types.join(",")} (${at} of ${p.length})`);
            }
        }
    }
});

test("playback during a save's remux reaches the next session whole", async () => {
    const srv = server();
    const cap = createCapture({ spill: async (ev) => srv.spill(ev), onRestart: () => srv.drop() });
    cap.add(0, "video/mp4");
    cap.append(0, concat(init(1), part(100)));
    await cap.flush();
    await cap.seal();
    srv.drop();               // finalized: the server's session is the save's
    cap.sessionTaken?.();     // (go.js, once the save starts)
    // 25 MB played while the save remuxes: each part marked by its size.
    for (let i = 1; i <= 25; i++) {
        cap.append(0, part((1 << 20) + i));
        await new Promise((r) => setTimeout(r, 0));  // (played over time)
    }
    await new Promise((r) => setTimeout(r, 20));
    cap.markSaved();          // the save done
    for (let i = 26; i <= 30; i++) {
        cap.append(0, part((1 << 20) + i));
        await new Promise((r) => setTimeout(r, 0));
    }
    await cap.seal();
    const got = srv.sessions.at(-1).tracks.get(0).parts.map((p) => p.length - 16 - (1 << 20));
    const want = Array.from({ length: 30 }, (_, k) => k + 1);
    assert.deepEqual(got.filter((n) => n > 0), want, "parts missed between the saves");
});

test("an end() while a save finalizes sends nothing over it; spilled once a new session's begun", async () => {
    const srv = server();
    let during = 0, finalizing = false;
    const cap = createCapture({ spill: async (ev) => { if (finalizing) during++; srv.spill(ev); }, onRestart: () => srv.drop() });
    cap.add(0, "video/mp4");
    cap.append(0, concat(init(1), part(100)));
    await cap.flush();
    await cap.seal();
    finalizing = true;          // finalize sent
    cap.append(0, part(100));   // the player's last part, then its end
    await cap.end();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(during, 0, "spilled over the finalize");
    finalizing = false;
    srv.drop();
    cap.sessionTaken?.();       // the save started
    await new Promise((r) => setTimeout(r, 10));
    await cap.flush();
    assert.ok(srv.sessions.at(-1).tracks.get(0)?.parts.length >= 1, "the last part never spilled");
});

test("a quality switch while a save seals doesn't let go of the session being saved", async () => {
    const srv = server();
    let restarts = 0, release;
    const gate = new Promise((r) => { release = r; });
    let slow = false;
    const cap = createCapture({ spill: async (ev) => { if (slow) await gate; srv.spill(ev); }, onRestart: () => { restarts++; srv.drop(); } });
    cap.add(0, "video/mp4");
    cap.append(0, concat(init(1), part(100)));
    await cap.flush();
    cap.append(0, part(100));
    slow = true;
    const sealing = cap.seal();           // its last part in flight…
    cap.append(0, concat(init(2), part(100), part(100)));  // …as the player switches
    release();
    await assert.rejects(sealing, /changed during save/);
    assert.equal(restarts, 0, "the session being saved let go");
    cap.unseal();                          // (go.js, the save not made)
    await cap.flush();
    assert.equal(srv.sessions.at(-1).tracks.get(0)?.init?.at(-1), 2, "the new init in a new session");
});

test("the same init appended again (a player after a seek) keeps the session", async () => {
    const srv = server();
    let restarts = 0;
    const cap = createCapture({ spill: async (ev) => srv.spill(ev), onRestart: () => { restarts++; srv.drop(); } });
    cap.add(0, "video/mp4");
    cap.append(0, concat(init(1), part(101), part(102)));
    await cap.flush();
    // Shaka, seeking past what's buffered, clears it and appends the init again.
    cap.append(0, concat(init(1), part(103), part(104)));
    await cap.flush();
    assert.equal(restarts, 0, "begun again");
    assert.equal(srv.sessions.length, 1);
    assert.deepEqual(srv.sessions[0].tracks.get(0).parts.map((p) => p.length), [117, 118, 119, 120]);
    // Another init (a quality switch): begun again, as before.
    cap.append(0, concat(init(2), part(105)));
    await cap.flush();
    assert.equal(restarts, 1);
});

test("a page's SourceBuffers made again and again (their numbers past 7) are saved, in the server's few tracks", async () => {
    const srv = server();
    const cap = createCapture({ spill: async (ev) => srv.spill(ev), onRestart: () => srv.drop() });
    for (let i = 0; i < 10; i++) {
        if (i > 0) cap.drop(i - 1);  // (a period's, a codec's change: removed, another added)
        cap.add(i, "video/mp4");
        cap.append(i, concat(init(i), part(100 + i)));
        await cap.flush();
    }
    const sizes = srv.sessions.flatMap((ss) => [...ss.tracks.values()].flatMap((tr) => tr.parts.map((p) => p.length)));
    for (const n of [107, 108, 109]) assert.ok(sizes.includes(16 + n), `buffer ${n - 100}'s part never reached the server: ${sizes.join(",")}`);
});

test("a quality switch while another track's parts spill sends that track's init first in the new session", async () => {
    const srv = server();
    let release, held = false;
    const gate = new Promise((r) => { release = r; });
    let slow = false;
    const cap = createCapture({
        spill: async (ev) => {
            srv.spill(ev);
            if (slow && ev.kind === "part" && ev.track === 1 && !held) { held = true; await gate; }  // (its reply slow)
        },
        onRestart: () => srv.drop(),
    });
    cap.add(0, "video/mp4");
    cap.add(1, "audio/mp4");
    cap.append(0, concat(init(1), part(100)));
    cap.append(1, concat(init(9), part(50)));
    await cap.flush();
    cap.append(1, concat(part(51), part(52), part(53)));
    slow = true;
    const flushing = cap.flush();          // audio's first part in flight…
    await new Promise((r) => setTimeout(r, 0));
    cap.append(0, concat(init(2), part(100), part(100)));  // …as the video switches quality
    release();
    await flushing;
    await cap.flush();
    await cap.seal();                      // (no "stream part before init" met)
    const last = srv.sessions.at(-1);
    assert.equal(last.tracks.get(0)?.init?.at(-1), 2, "the new video init");
    assert.ok(last.tracks.get(1)?.init, "audio's init never sent to the new session");
    assert.ok(last.tracks.get(1).parts.length >= 1);
});

test("a SourceBuffer removed during a save doesn't let go of the session being saved", async () => {
    const srv = server();
    let restarts = 0, release;
    const gate = new Promise((r) => { release = r; });
    let slow = false;
    const cap = createCapture({ spill: async (ev) => { if (slow) await gate; srv.spill(ev); }, onRestart: () => { restarts++; srv.drop(); } });
    cap.add(0, "video/mp4");
    cap.add(1, "audio/mp4");
    cap.append(0, concat(init(1), part(100)));
    cap.append(1, concat(init(9), part(50)));
    await cap.flush();
    // Sealed, then finalizing: the player removes its audio buffer.
    await cap.seal();
    cap.drop(1);
    assert.equal(restarts, 0, "the session being finalized let go");
    assert.equal(srv.sessions.length, 1);
    srv.drop();
    cap.sessionTaken();                    // (the save started)
    // Mid-seal: refused, the session kept; begun again once unsealed.
    cap.add(1, "audio/mp4");
    cap.append(1, concat(init(9), part(50)));
    await cap.flush();
    restarts = 0;
    cap.append(0, part(100));
    slow = true;
    const sealing = cap.seal();
    cap.drop(1);
    release();
    await assert.rejects(sealing, /changed during save/);
    assert.equal(restarts, 0, "the session being saved let go");
    cap.unseal();
    await cap.flush();
    assert.equal(restarts, 1);
    assert.ok(srv.sessions.at(-1).tracks.get(0)?.init, "the video's init in the new session");
});
