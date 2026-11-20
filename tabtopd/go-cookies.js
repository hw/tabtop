// Display helpers for the usage metadata returned by go-cookies.
export function storageSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const mib = bytes >= 1024 ** 2;
    const value = bytes / (mib ? 1024 ** 2 : 1024);
    return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${mib ? "MB" : "KB"}`;
}

export function siteDataSummary(site) {
    const parts = [];
    if (site?.cookies) parts.push(`${site.cookies} cookie${site.cookies === 1 ? "" : "s"}`);
    if (site?.storageItems) parts.push(`${storageSize(site.storage ?? 0)} in ${site.storageItems} item${site.storageItems === 1 ? "" : "s"}`);
    if (site?.open) parts.push("Data in an open tab");
    return parts;
}
