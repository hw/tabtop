import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// The frame's script, with no frame: only what it needs to load.
const env = {
    TextEncoder, URL, atob, decodeURIComponent,
    window: { addEventListener() {} },
    document: { documentElement: {} },
    ResizeObserver: class { observe() {} },
};
runInNewContext(readFileSync(new URL("../tabtopd/preview-html-resources.js", import.meta.url), "utf8"), env);
const { dataBytes } = env.TabTopHTMLResources;

test("a data: URL's text is its bytes: escapes as they are, the rest as UTF-8, characters beyond the BMP whole", () => {
    assert.deepEqual([...dataBytes("a%20b", false)], [0x61, 0x20, 0x62]);
    assert.deepEqual([...dataBytes("é", false)], [0xc3, 0xa9]);
    assert.deepEqual([...dataBytes("😀%00", false)], [0xf0, 0x9f, 0x98, 0x80, 0x00]);
    assert.deepEqual([...dataBytes("100%", false)], [0x31, 0x30, 0x30, 0x25], "a % that isn't an escape stays");
    assert.deepEqual([...dataBytes("AAEC\n/w==", true)], [0, 1, 2, 255]);
});
