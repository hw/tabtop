import { test } from "node:test";
import assert from "node:assert/strict";
import { createTimeFormatter } from "../tabtopd/file-format.js";

const seconds = (value) => Date.parse(value) / 1000;
const formatter = (timeZone, instant) => createTimeFormatter({ timeZone, locale: "en-US", now: () => new Date(instant) });

test("formatter instances own their timezone independently", () => {
    const utc = formatter("UTC", "2026-06-02T00:30:00Z");
    const singapore = formatter("Asia/Singapore", "2026-06-02T00:30:00Z");
    const when = seconds("2026-06-01T23:30:00Z");
    assert.match(utc.friendlyTime(when), /^Yesterday /);
    assert.match(singapore.friendlyTime(when), /^Today /);
    const before = singapore.exactTime(when);
    utc.setTimeZone("America/New_York");
    assert.equal(singapore.exactTime(when), before);
});

test("injected clock controls midnight and year boundaries", () => {
    let now = new Date("2027-01-01T00:05:00Z");
    const f = createTimeFormatter({ locale: "en-US", now: () => now });
    assert.match(f.friendlyTime(seconds("2026-12-31T23:55:00Z")), /^Yesterday /);
    now = new Date("2027-01-10T00:05:00Z");
    assert.match(f.friendlyTime(seconds("2026-12-20T12:00:00Z")), /2026/);
    assert.doesNotMatch(f.friendlyTime(seconds("2027-01-01T12:00:00Z")), /2027/);
});

test("calendar days remain correct across both daylight-saving transitions", () => {
    for (const [now, previous] of [
        ["2026-03-09T04:15:00Z", "2026-03-08T05:30:00Z"],
        ["2026-11-02T05:15:00Z", "2026-11-01T04:30:00Z"],
    ]) {
        const f = formatter("America/New_York", now);
        assert.match(f.friendlyTime(seconds(previous)), /^Yesterday /);
    }
});

test("unsupported timezone falls back to UTC", () => {
    const fallback = formatter("Unknown/Zone", "2026-06-02T00:30:00Z");
    const utc = formatter("UTC", "2026-06-02T00:30:00Z");
    const when = seconds("2026-06-01T23:30:00Z");
    assert.equal(fallback.exactTime(when), utc.exactTime(when));
    fallback.setTimeZone("Asia/Singapore");
    fallback.setTimeZone("Unknown/Zone");
    assert.equal(fallback.shortTime("2026-06-01T23:30:00Z"), utc.shortTime("2026-06-01T23:30:00Z"));
});
