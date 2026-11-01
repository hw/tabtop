// A warning before the login runs out (after -session-max, 12 hours by
// default), on the desktop, the terminal and the files page, served by
// tabtopd. Ten minutes before, a banner at the top says when, with Log in
// again, so the new login comes when it suits rather than in the middle
// of something: in the bar of links at the top of the terminal and the
// files page, and over the top of the desktop. Logging in again ends the
// old login at once, so what's open in every tab reconnects with the new
// one then, while it's expected, and logging out later ends everything.
// It ends the warning in all the tabs too, since they share the stored
// session.

import { renewSession, request, SESSION_KEY, storedSession, Tunnel } from "./tunnel.js";

const WARN = 10 * 60 * 1000;  // how long before the end it's shown, in ms
const AGAIN = 60 * 1000;      // when it's shown again, once put off with Later

// When the stored session ends, by its id: from the login, or asked of
// the server for one stored before logins said.
const ends = new Map();

async function endOf(s) {
    if (s.expires) {
        return s.expires;
    }
    if (!ends.has(s.id)) {
        ends.set(s.id, null);
        try {
            const r = await request({ type: "sessions" });
            ends.set(s.id, Date.parse(r.sessions.find((x) => x.current)?.expires) || null);
        } catch {
            ends.delete(s.id);  // asked again next time
        }
    }
    return ends.get(s.id);
}

// warnExpiry starts watching for the session's end on this page. It checks
// every so often, rather than waiting once, since a computer asleep holds
// timers back.
export function warnExpiry() {
    let box = null;
    let laterUntil = 0;  // put off until this many ms before the end
    let renewing = false;
    const hide = () => {
        box?.remove();
        box = null;
    };
    const check = async () => {
        const s = storedSession();
        const end = s && (await endOf(s));
        const left = end ? end - Date.now() : Infinity;
        if (renewing || left > WARN || left <= 0 || left > laterUntil) {
            if (!renewing) {
                hide();
            }
            return;
        }
        show(end, left);
    };
    const show = (end, left) => {
        if (!box) {
            box = banner(() => {
                laterUntil = AGAIN;
                hide();
            }, async () => {
                renewing = true;
                hide();
                const old = storedSession();
                try {
                    if (await renewSession("Log in again")) {
                        laterUntil = WARN;
                        try {
                            (await Tunnel.open({ type: "logout" }, old)).close();
                        } catch {
                            // Over already.
                        }
                    }
                } finally {
                    renewing = false;
                    check();
                }
            });
        }
        const minutes = Math.ceil(left / 60000);
        const at = new Date(end).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
        box.text.textContent = box.inBar ? `Login ends in ${minutes} min (${at})`
            : `This login ends in ${minutes} ${minutes === 1 ? "minute" : "minutes"}, at ${at}. Log in again now so it doesn't stop you then.`;
        box.title = `This login ends at ${at}. Log in again now so it doesn't stop you then.`;
    };
    laterUntil = WARN;
    // A login in another tab, or logging out, changes the stored session.
    addEventListener("storage", (e) => {
        if (e.key === SESSION_KEY || e.key === null) {
            laterUntil = WARN;
            check();
        }
    });
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && check());
    setInterval(check, 15000);
    check();
}

// banner shows the warning, with Log in again and Later buttons: in the
// bar of links, after the links, where there is one, so it covers
// nothing; else over the top of the page. It returns the box, whose text
// is box.text, and box.inBar says which.
function banner(later, again) {
    const nav = document.querySelector(".tabtop-nav");
    const box = document.createElement(nav ? "span" : "div");
    box.id = "tabtop_expiry";
    box.setAttribute("role", "alert");
    box.inBar = !!nav;
    const look = { boxSizing: "border-box", color: "#1c1c1e", background: "#fdd663", textAlign: "left" };
    Object.assign(box.style, look, nav ? {
        display: "inline-flex", alignItems: "center", gap: ".4rem", minWidth: "0", padding: "0 .25rem 0 .6rem",
        borderRadius: "4px", fontSize: "12px", lineHeight: "20px", whiteSpace: "nowrap",
    } : {
        position: "fixed", top: "8px", left: "50%", transform: "translateX(-50%)", zIndex: "998", width: "max-content",
        maxWidth: "calc(100vw - 2rem)", padding: ".5rem 1rem", borderRadius: "8px", font: "14px/1.5 system-ui, sans-serif",
        boxShadow: "0 2px 12px rgba(0,0,0,.4)",
    });
    const button = (text, onClick) => {
        const b = Object.assign(document.createElement("button"), { type: "button", textContent: text });
        // Not the bar's own buttons' look, nor noVNC's.
        Object.assign(b.style, { all: "revert", font: "inherit", ...(nav ? { padding: "0 .4rem", lineHeight: "16px" } : { marginLeft: ".5rem" }) });
        b.addEventListener("click", onClick);
        return b;
    };
    box.text = document.createElement("span");
    Object.assign(box.text.style, { overflow: "hidden", textOverflow: "ellipsis" });
    box.append(box.text, button("Log in again", again), button("Later", later));
    const logOut = nav?.querySelector(":scope > button");
    if (logOut) {
        logOut.before(box);
    } else {
        (nav ?? document.body).append(box);
    }
    return box;
}
