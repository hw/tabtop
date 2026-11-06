import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { FILE_TYPES } from "../tabtopd/file-types.js";

test("browser and classic-worker types match the canonical Go-embedded registry", () => {
    const canonical = JSON.parse(readFileSync(new URL("../tabtopd/file-types.json", import.meta.url), "utf8"));
    const self = {};
    runInNewContext(readFileSync(new URL("../tabtopd/file-types-worker.js", import.meta.url), "utf8"), { self });
    assert.deepEqual(FILE_TYPES, canonical, "run go generate after editing file-types.json");
    assert.deepEqual(JSON.parse(JSON.stringify(self.TabTopFileTypes)), canonical);
    for (const [ext, type] of Object.entries(canonical)) {
        assert.match(ext, /^[a-z0-9]+$/);
        assert.match(type.mime, /^[a-z]+\/[a-z0-9.+-]+$/);
        if (type.epubPicture) assert.equal(type.kind, "image");
    }
});
