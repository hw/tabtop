import { store, storeJSON, storedJSON } from "./stored.js";

// Pages import this from <base>/tabtop/, so its parent identifies the
// deployment even when several instances share one origin.
export const SESSION_KEY = "tabtop_session:" + new URL("../", import.meta.url).pathname;

// The session from logging in: its id and secret, kept in this browser's
// storage and shared by the desktop, terminal and downloads.
export function storedSession() {
    const s = storedJSON(SESSION_KEY);
    return s?.id && s?.secret ? s : null;
}

// forgetSession forgets the stored session, or, given one that's over,
// forgets it only if it's still the one stored: not a newer login, from
// this page or another.
export function forgetSession(over) {
    if (!over || storedSession()?.id === over.id) {
        store(SESSION_KEY, null);
        forgetThumbnails();
    }
}

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
export const saveSession = (s) => storeJSON(SESSION_KEY, s);
