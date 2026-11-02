export const SESSION_KEY = "tabtop_session";

// The session from logging in: its id and secret, kept in this browser's
// storage and shared by the desktop, terminal and downloads.
export function storedSession() {
    try {
        const s = JSON.parse(localStorage.getItem(SESSION_KEY));
        return s?.id && s?.secret ? s : null;
    } catch {
        return null;
    }
}

// forgetSession forgets the stored session, or, given one that's over,
// forgets it only if it's still the one stored: not a newer login, from
// this page or another.
export function forgetSession(over) {
    try {
        if (!over || storedSession()?.id === over.id) {
            localStorage.removeItem(SESSION_KEY);
        }
    } catch {
        // Nothing stored.
    }
}

export function saveSession(s) {
    try {
        localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    } catch {
        // Not remembered: this page still has it.
    }
}
