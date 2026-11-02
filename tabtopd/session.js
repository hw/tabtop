import { loginForm } from "./login-ui.js";
import { storedSession } from "./session-state.js";
export { SESSION_KEY, storedSession, forgetSession, saveSession } from "./session-state.js";

// Only one login form at a time, however many tunnels are waiting for it.
let pendingLogin = null;

// session returns the stored session, or shows a login form over the page
// and returns the new one.
export async function session(title) {
    const s = storedSession();
    if (s) {
        return s;
    }
    pendingLogin ??= loginForm(title).finally(() => (pendingLogin = null));
    return pendingLogin;
}

// renewSession shows the login form, with a Cancel button, to log in
// again before the session runs out, and resolves to the new session, or
// null if it's cancelled. The old session goes on until it's ended: what
// it has open then reconnects with the new one.
export function renewSession(title) {
    return loginForm(title, true);
}
