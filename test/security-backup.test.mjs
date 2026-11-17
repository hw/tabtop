import assert from "node:assert/strict";
import test from "node:test";
import { BACKUP_FORMAT, parseSecurityBackup } from "../tabtopd/security-backup-format.js";

test("parseSecurityBackup accepts v1 inventory", () => {
    const raw = JSON.stringify({
        format: BACKUP_FORMAT,
        exported_at: "2026-01-01T00:00:00.000Z",
        host: "example.test",
        passkeys: [],
        shares: [],
        activity: [],
        browser: { session_name: "laptop", starred: [], recent: [] },
    });
    const got = parseSecurityBackup(raw);
    assert.equal(got.format, BACKUP_FORMAT);
    assert.equal(got.browser.session_name, "laptop");
});

test("parseSecurityBackup rejects other JSON", () => {
    assert.throws(() => parseSecurityBackup("{}"), /tabtop-security-backup/);
    assert.throws(() => parseSecurityBackup("not-json"), /valid JSON/);
});
