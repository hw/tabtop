import assert from "node:assert/strict";
import { test } from "node:test";
import { mseStageKeeper } from "../tabtopd/mse-stages.js";

const session = (n) => ({ n, closed: false, aborted: false, abort() { this.aborted = this.closed = true; } });

test("a capture begun again while its session opens: that session's let go, the next spill opens another", async () => {
    const opened = [];
    let release;
    const keeper = mseStageKeeper(() => new Promise((resolve) => {
        const s = session(opened.length + 1);
        opened.push(s);
        release = () => resolve(s);
    }));
    const stream = {};
    const first = keeper.ensure(stream);   // the old generation's init, opening
    keeper.abort(stream);                  // restart() meanwhile
    release();
    await assert.rejects(first);           // (its spill's: ignored, a generation since)
    assert.equal(opened[0].aborted, true, "the superseded session kept open");
    const next = keeper.ensure(stream);
    release();
    assert.equal((await next).n, 2, "the new generation spilled into the old session");
});

test("spills while a session opens wait for it: one session, not two", async () => {
    let opens = 0, release;
    const keeper = mseStageKeeper(() => new Promise((resolve) => { opens++; release = () => resolve(session(opens)); }));
    const stream = {};
    const a = keeper.ensure(stream), b = keeper.ensure(stream);
    release();
    assert.equal(await a, await b);
    assert.equal(opens, 1);
});
