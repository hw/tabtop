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
