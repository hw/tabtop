// Recent and starred paths across filesystem roots (browser-local).
import { storedJSON, storeJSON } from "./stored.js";
import { filesystemRoot, filesystemRoots } from "./fs-context.js";
import { el } from "./preview-dom.js";
import { iconSVG } from "./glyphs.js";
import { RECENT_FILES_KEY as RECENT_KEY, STARRED_FILES_KEY as STARRED_KEY, handOffSession } from "./session-state.js";
const RECENT_MAX = 20;

const same = (a, b) => a.rootId === b.rootId && a.path === b.path;

export function listRecent() {
    return (storedJSON(RECENT_KEY, []) || []).filter((e) => e?.rootId && typeof e.path === "string");
}

export function listStarred() {
    return (storedJSON(STARRED_KEY, []) || []).filter((e) => e?.rootId && typeof e.path === "string");
}

export function rememberRecent({ rootId = filesystemRoot().id, path, name, dir = false }) {
    if (!path && path !== "") return;
    const entry = { rootId, path, name: name || path.split("/").pop() || path, dir: !!dir, at: Date.now() };
    const next = [entry, ...listRecent().filter((e) => !same(e, entry))].slice(0, RECENT_MAX);
    storeJSON(RECENT_KEY, next);
}

export function isStarred({ rootId = filesystemRoot().id, path }) {
    return listStarred().some((e) => same(e, { rootId, path }));
}

export function toggleStar({ rootId = filesystemRoot().id, path, name, dir = false }) {
    const entry = { rootId, path, name: name || path.split("/").pop() || path, dir: !!dir };
    const starred = listStarred();
    const next = starred.some((e) => same(e, entry))
        ? starred.filter((e) => !same(e, entry))
        : [entry, ...starred];
    storeJSON(STARRED_KEY, next);
    return next.some((e) => same(e, entry));
}

// mergePins merges imported starred/recent entries into this browser's lists
// (imported first for starred; recent capped).
export function mergePins({ starred = [], recent = [] } = {}) {
    const clean = (list) => (Array.isArray(list) ? list : [])
        .filter((e) => e && e.rootId && typeof e.path === "string")
        .map((e) => ({ rootId: String(e.rootId), path: String(e.path), name: String(e.name || e.path.split("/").pop() || e.path), dir: !!e.dir, ...(e.at ? { at: Number(e.at) || undefined } : {}) }));
    const merge = (current, incoming, max = Infinity) => {
        const out = [];
        for (const entry of [...clean(incoming), ...current]) {
            if (out.some((e) => same(e, entry))) continue;
            out.push(entry);
            if (out.length >= max) break;
        }
        return out;
    };
    storeJSON(STARRED_KEY, merge(listStarred(), starred));
    storeJSON(RECENT_KEY, merge(listRecent(), recent, RECENT_MAX));
}

function openPin(entry) {
    const target = new URL(location.href);
    target.searchParams.set("root", entry.rootId);
    // (Each part of it encoded, as files.js's dirHash does: a folder named
    // "50% off" is "#/50%25%20off/".)
    const hash = (dir) => "#/" + dir.split("/").filter(Boolean).map(encodeURIComponent).join("/") + (dir ? "/" : "");
    if (entry.dir) {
        target.hash = hash(entry.path);
        handOffSession(() => location.assign(target.href), true);
        return;
    }
    // A file: its folder, then it opened there (see takePendingOpen), as
    // clicking it in the list does. Already in that folder, the address
    // doesn't change, so the folder is asked to open it now.
    const at = entry.path.lastIndexOf("/");
    target.hash = hash(at < 0 ? "" : entry.path.slice(0, at));
    try { sessionStorage.setItem(PENDING_KEY, JSON.stringify({ rootId: entry.rootId, path: entry.path })); } catch { /* not kept: just the folder */ }
    if (target.href === location.href) dispatchEvent(new Event(PENDING_EVENT));
    else handOffSession(() => location.assign(target.href), true);
}

const PENDING_KEY = "tabtop-files-open";
// Fired when a file in the folder shown is to be opened.
export const PENDING_EVENT = "tabtop-files-open";

// takePendingOpen is the path of the file a pin asked to open in this
// root's folder dir, once (it's forgotten either way), or null.
export function takePendingOpen(dir) {
    let pending = null;
    try {
        pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "null");
        sessionStorage.removeItem(PENDING_KEY);
    } catch { return null; }
    if (!pending || pending.rootId !== filesystemRoot().id || typeof pending.path !== "string") return null;
    const at = pending.path.lastIndexOf("/");
    if ((at < 0 ? "" : pending.path.slice(0, at)) !== dir) return null;
    return pending.path.slice(at + 1);
}

function rootLabel(id) {
    return filesystemRoots().find((r) => r.id === id)?.label ?? id;
}

// pinsBar is the Starred and Recent menus: a glyph each, shown at the end
// of the folder's heading row, that opens its list (the menus' closing on
// a click elsewhere and Escape is ui.js's, as for a row's menu).
export function pinsBar({ onChange } = {}) {
    const menu = (className, icon, title, empty) => {
        const summary = el("summary", { title });
        summary.innerHTML = iconSVG(icon);
        summary.setAttribute("aria-label", title);
        const items = el("div", { className: "items" });
        const node = el("details", { className: `menu files-pin-menu ${className}` }, summary, items);
        node.addEventListener("toggle", () => {
            if (!node.open) return;
            for (const other of document.querySelectorAll("details.menu[open]")) if (other !== node) other.open = false;
        });
        const fill = (list) => {
            items.replaceChildren(...(list.length ? list.map((entry) => {
                const missing = !filesystemRoots().some((r) => r.id === entry.rootId);
                const label = `${entry.name || entry.path}${entry.dir ? "/" : ""}`;
                const b = el("button", { type: "button", className: "files-pin-link", disabled: missing,
                    title: missing ? `${label} (${rootLabel(entry.rootId)} unavailable)` : `${rootLabel(entry.rootId)}: ${entry.path || "/"}` },
                    el("span", { textContent: label }), el("small", { textContent: rootLabel(entry.rootId) }));
                b.addEventListener("click", () => {
                    node.open = false;
                    openPin(entry);
                });
                return b;
            }) : [el("p", { className: "hint", textContent: empty })]));
        };
        return { node, fill };
    };
    const starred = menu("starred", "star", "Starred", "Nothing starred yet: star a file or folder from its ⋯ menu.");
    const recent = menu("recent", "history", "Recent", "Nothing opened yet.");
    const box = el("div", { className: "files-pins" }, starred.node, recent.node);
    const draw = () => {
        starred.fill(listStarred());
        recent.fill(listRecent().slice(0, 12));
        onChange?.();
    };
    draw();
    return { node: box, refresh: draw };
}
