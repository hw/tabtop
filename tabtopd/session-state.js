import { store, storeJSON, storedJSON } from "./stored.js";

// Pages import this from <base>/tabtop/, so its parent identifies the
// deployment even when several instances share one origin.
export const SESSION_KEY = "tabtop_session:" + new URL("../", import.meta.url).pathname;

// In the offline client (tabtop.html, opened as a file; see nav.js), the
// browser's storage is every local file's: any .html opened could read a
// session kept there. So the session is kept in this page only (held), and
// handed to a page of the client's own, as it opens it in a tab or loads
// it in this one (handOffSession): in this tab's own storage, which the
// page opened takes, and forgets, as it starts.
const offline = !!globalThis.tabtopOffline;
export const HANDOFF_KEY = "tabtop-offline-session";
let held = null;
if (offline) {
    try {
        const s = JSON.parse(sessionStorage.getItem(HANDOFF_KEY) ?? "null");
        sessionStorage.removeItem(HANDOFF_KEY);
        if (s?.id && s?.secret) held = s;
    } catch {
        // None handed over: logged in here.
    }
}

// handOffSession runs go, which opens a page of the client's own (in a tab
// of its own, or, with here, in this one), handing it the session. Into
// another tab, it's in this one's storage only while go opens it (which
// copies this tab's storage to the new one).
export function handOffSession(go, here = false) {
    if (!offline || !held) return go();
    try { sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(held)); } catch { /* not handed over: logged in again there */ }
    try {
        return go();
    } finally {
        if (!here) try { sessionStorage.removeItem(HANDOFF_KEY); } catch { /* gone with the tab */ }
    }
}

// The session from logging in: its id and secret, kept in this browser's
// storage and shared by the desktop, terminal and downloads (offline, in
// this page only: see held).
export function storedSession() {
    if (offline) return held;
    const s = storedJSON(SESSION_KEY);
    return s?.id && s?.secret ? s : null;
}

// forgetSession forgets the stored session, or, given one that's over,
// forgets it only if it's still the one stored: not a newer login, from
// this page or another.
export function forgetSession(over) {
    if (!over || storedSession()?.id === over.id) {
        held = null;
        store(SESSION_KEY, null);
        forgetThumbnails();
        // (The files opened: gone with the session, as what they're called is private.)
        store(RECENT_FILES_KEY, null);
    }
}

// Where the files page keeps the files and folders opened lately, and those
// starred (see files-pins.js): this deployment's. Recent ones go with the
// session; starred ones stay, as bookmarks do.
export const RECENT_FILES_KEY = "tabtop-files-recent:" + new URL("../", import.meta.url).pathname;
export const STARRED_FILES_KEY = "tabtop-files-starred:" + new URL("../", import.meta.url).pathname;

// THUMBNAIL_CACHE is where the files page keeps thumbnails of pictures
// (see thumbnails.js): this deployment's, gone with its session, as what
// they show is private.
export const THUMBNAIL_CACHE = "tabtop-thumbnails:" + new URL("../", import.meta.url).pathname;

function forgetThumbnails() {
    try {
        globalThis.caches?.delete(THUMBNAIL_CACHE).catch(() => {});
    } catch {
        // No Cache Storage here: nothing kept.
    }
}

// (Not remembered, if the browser won't: this page still has it.)
export const saveSession = (s) => (offline ? (held = s) : storeJSON(SESSION_KEY, s));
