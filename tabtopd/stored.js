// What this browser keeps for TabTop's pages, in localStorage, which may
// refuse (a private window, site data blocked, its space full) or be
// missing: reads then give their fallback, and writes keep it only for now.
// What's read is checked by whoever reads it: another tab, or an older
// TabTop, may have written something else.

const storage = () => globalThis.localStorage;

// stored is the text kept under key, or fallback.
export function stored(key, fallback = null) {
    try {
        return storage()?.getItem(key) ?? fallback;
    } catch {
        return fallback;
    }
}

// store keeps value (as text) under key; null or undefined forgets it.
export function store(key, value) {
    try {
        if (value == null) storage()?.removeItem(key);
        else storage()?.setItem(key, String(value));
    } catch {
        // Only for now, then.
    }
}

// storedJSON is the JSON kept under key, parsed, or fallback (if there's
// none, or it isn't JSON).
export function storedJSON(key, fallback = null) {
    try {
        return JSON.parse(storage()?.getItem(key) ?? "null") ?? fallback;
    } catch {
        return fallback;
    }
}

// storeJSON keeps value, as JSON, under key.
export function storeJSON(key, value) {
    store(key, JSON.stringify(value));
}
