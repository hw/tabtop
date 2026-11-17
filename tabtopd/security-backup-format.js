// Format and parse helpers for Sessions security backups (no DOM / tunnel).
export const BACKUP_FORMAT = "tabtop-security-backup/v1";

export function parseSecurityBackup(text) {
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error("That file isn't valid JSON.");
    }
    if (!data || data.format !== BACKUP_FORMAT) {
        throw new Error(`Choose a ${BACKUP_FORMAT} export from TabTop Sessions.`);
    }
    return data;
}
