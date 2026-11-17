// Security backup: export/import inventory kept on the Sessions page.
// Export is archival JSON (activity, passkey names, share inventory, browser
// pins). Import restores browser-local pins and session name; passkeys and
// share tokens cannot be recreated from the file alone.
import { call, saveBlob } from "./requests.js";
import { listRecent, listStarred, mergePins } from "./files-pins.js";
import { store, stored } from "./stored.js";
import { askYes, statusRow } from "./ui.js";
import { BACKUP_FORMAT, parseSecurityBackup } from "./security-backup-format.js";

export { BACKUP_FORMAT, parseSecurityBackup };
const SESSION_NAME = "tabtop.session-name";

function pickFile() {
    return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "application/json,.json";
        input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
        input.click();
    });
}

async function gatherExport() {
    const [sessions, passkeys, activity] = await Promise.all([
        call({ type: "sessions" }),
        call({ type: "passkeys" }).catch(() => null),
        call({ type: "activity", max: 0 }).catch(() => null),
    ]);
    try {
        const s = sessions.reply;
        const keys = passkeys?.reply?.passkeys ?? [];
        const entries = activity?.reply?.entries ?? [];
        return {
            format: BACKUP_FORMAT,
            exported_at: new Date().toISOString(),
            host: location.host,
            build_time: s.build_time ?? null,
            bootstrap: {
                decoder_sha256: s.bootstrap_decoder_sha256 ?? null,
                pack_sha256: s.bootstrap_pack_sha256 ?? null,
                tabtop_sha256: s.bootstrap_tabtop_sha256 ?? null,
            },
            passkeys: keys.map((k) => ({
                id: k.id,
                name: k.name,
                created: k.created,
                last_used: k.last_used,
            })),
            shares: (s.shares ?? []).map((l) => ({
                handle: l.handle,
                root: l.root,
                root_label: l.root_label,
                path: l.path,
                dir: !!l.dir,
                upload: !!l.upload,
                label: l.label ?? "",
                created: l.created,
                expires: l.expires,
                max: l.max,
                count: l.count,
                max_bytes: l.max_bytes,
                bytes: l.bytes,
                by_ip: l.by_ip,
                mine: !!l.mine,
            })),
            activity: entries,
            browser: {
                session_name: stored(SESSION_NAME, "") || "",
                starred: listStarred(),
                recent: listRecent(),
            },
        };
    } finally {
        sessions.close();
        passkeys?.close();
        activity?.close();
    }
}

export async function exportSecurityBackup() {
    const row = statusRow("Security backup: exporting");
    try {
        const backup = await gatherExport();
        const name = `tabtop-security-backup-${new Date().toISOString().slice(0, 10)}.json`;
        saveBlob(new Blob([JSON.stringify(backup, null, 2) + "\n"], { type: "application/json" }), name);
        row.set(`${name}: downloaded (${backup.activity.length} activity, ${backup.passkeys.length} passkeys, ${backup.shares.length} shares)`);
        row.finish();
        return backup;
    } catch (err) {
        row.set(`Security backup: not exported: ${err.message}`, true);
        row.finish();
        throw err;
    }
}

function summarize(backup) {
    const b = backup.browser ?? {};
    return [
        `${(backup.activity ?? []).length} activity entries`,
        `${(backup.passkeys ?? []).length} passkey names`,
        `${(backup.shares ?? []).length} share links (inventory only; tokens not included)`,
        `${(b.starred ?? []).length} starred`,
        `${(b.recent ?? []).length} recent`,
        b.session_name ? `session name “${b.session_name}”` : "no session name",
    ].join("; ");
}

export async function importSecurityBackup() {
    const file = await pickFile();
    if (!file) return null;
    const row = statusRow(`Security backup: reading ${file.name}`);
    try {
        const backup = parseSecurityBackup(await file.text());
        row.set(`Security backup: ${summarize(backup)}`);
        const ok = await askYes(
            `Import this backup into this browser?\n\n${summarize(backup)}\n\n`
            + "Starred and Recent paths are merged here. The session name is restored if the file has one. "
            + "Passkey credentials and share-link tokens are not in the file and cannot be recreated from it — "
            + "the lists are for your records only.",
            "Import",
        );
        if (!ok) {
            row.set("Security backup: import cancelled");
            row.finish();
            return null;
        }
        mergePins({ starred: backup.browser?.starred, recent: backup.browser?.recent });
        if (typeof backup.browser?.session_name === "string" && backup.browser.session_name) {
            store(SESSION_NAME, backup.browser.session_name);
        }
        row.set("Security backup: imported browser pins"
            + (backup.browser?.session_name ? " and session name" : "")
            + ". Passkeys and shares were not changed on the server.");
        row.finish();
        return backup;
    } catch (err) {
        row.set(`Security backup: not imported: ${err.message}`, true);
        row.finish();
        throw err;
    }
}
