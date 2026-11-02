import { test } from "node:test";
import assert from "node:assert/strict";
import { Osc } from "../tabtopd/osc.js";

const encode = (s) => new TextEncoder().encode(s);
function parser() {
    const events = [];
    return { events, osc: new Osc(() => events.push(["bell"]),
        (title, text) => events.push(["notify", title, text]),
        (text) => events.push(["copy", text])) };
}

test("OSC events survive every possible message boundary", () => {
    const sequence = encode("hello\x07\x1b]9;Hi 🌍\x07\x1b]777;notify;Title;Body\x1b\\\x1b]52;c;aGVsbG8=\x07");
    const expected = [["bell"], ["notify", "", "Hi 🌍"], ["notify", "Title", "Body"], ["copy", "hello"]];
    for (let split = 0; split <= sequence.length; split++) {
        const { osc, events } = parser();
        osc.scan(sequence.slice(0, split));
        osc.scan(sequence.slice(split));
        assert.deepEqual(events, expected, `split at ${split}`);
    }
    const { osc, events } = parser();
    for (const byte of sequence) osc.scan([byte]);
    assert.deepEqual(events, expected);
});

test("clipboard queries, malformed data, unknown OSC and progress emit nothing", () => {
    const { osc, events } = parser();
    osc.scan(encode("\x1b]52;c;?\x07\x1b]52;c;%%%\x07\x1b]123;ignored\x07\x1b]9;4;50\x07"));
    assert.deepEqual(events, []);
    osc.scan(encode("\x1b]9;after malformed input\x07"));
    assert.deepEqual(events, [["notify", "", "after malformed input"]]);
});

test("oversized input is bounded and a later sequence still parses", () => {
    const { osc, events } = parser();
    osc.scan(encode("\x1b]52;c;" + "A".repeat((1 << 20) + 64)));
    assert.ok(osc.buf.length <= (1 << 20) + 17);
    assert.deepEqual(events, []);
    osc.scan(encode("\x1b]9;recovered\x07"));
    assert.deepEqual(events, [["notify", "", "recovered"]]);
});
