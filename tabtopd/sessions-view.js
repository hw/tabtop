import * as tunnel from "./tunnel.js";
import { call } from "./requests.js";
import { askYes, statusRow } from "./ui.js";
import { logOut } from "./nav.js";

const SECURITY_TITLE = "Security and sessions";
function el(tag, props = {}, ...children) {
    const e = Object.assign(document.createElement(tag), props);
    e.append(...children);
    return e;
}
function button(className, textContent, onClick) {
    const b = el("button", { type: "button", className, textContent });
    b.addEventListener("click", onClick);
    return b;
}

export function createSessionView({ security, refresh, formatTime }) {
    // needsAttention says whether the sessions report r has anything new to
    // look at: a failed login since this session logged in (those before,
    // the summary shown after logging in told of) or since the warnings were
    // marked as seen, or a session used from another address since they
    // were. The Security and sessions button is marked if so. The times are
    // all the server's, so the browser's clock doesn't matter.
    function needsAttention(r) {
        const seen = Date.parse(r.seen) || 0;
        const since = Math.max(seen, Date.parse(r.sessions.find((s) => s.current)?.created) || 0);
        const attention = r.logins.some((l) => !l.ok && Date.parse(l.time) > since) ||
            r.sessions.some((s) => s.uses.slice(1).some((u) => Date.parse(u.first) > seen));
        security.classList.toggle("attention", attention);
        security.title = attention ? `${SECURITY_TITLE}: something here needs attention (failed logins, or a session used from another address)`
            : SECURITY_TITLE;
        security.setAttribute("aria-label", security.title);
        return attention;
    }

    // checkSecurity marks the Security and sessions button if anything there
    // needs attention.
    async function checkSecurity() {
        try {
            const t = await call({ type: "sessions" });
            t.close();
            needsAttention(t.reply);
        } catch {
            // Checked again with the next folder.
        }
    }

    // showSessions lists in box the logins that are still live, where each
    // has been used from, and recent logins, with a button that ends every
    // session.
    async function showSessions(box) {
        let r;
        try {
            const t = await call({ type: "sessions" });
            t.close();
            r = t.reply;
        } catch (err) {
            box.replaceChildren(el("p", { className: "error", textContent: `Sessions: ${err.message}` }));
            return;
        }
        const when = formatTime;
        const everywhere = el("button", { className: "danger", textContent: "Log out everywhere" });
        everywhere.addEventListener("click", async () => {
            if (!(await askYes("Log out every session? Everything open in every desktop and terminal will disconnect, including this one.",
                "Log out everywhere"))) {
                return;
            }
            await logOut({ everywhere: true });
        });
        const field = (label, props = {}, ...children) => {
            const td = el("td", props, ...children);
            td.dataset.label = label;
            return td;
        };
        const rows = r.sessions.map((s) => {
            const login = s.uses[0];
            const others = s.uses.slice(1).map((u) => `${u.ip} (last ${when(u.last)})`).join(", ");
            // Another session can be ended from here; this one logs out.
            const end = s.current ? "" : button("end", "End…", () => endSession(s, when, box));
            return el("tr", {}, field("Logged in", {}, when(s.created) + (s.current ? " (this browser)" : ""),
                ...(s.browser ? [el("br"), el("span", { className: "hint", textContent: s.browser })] : [])),
                field("Used from", { className: "name" }, login.ip, ...(others ? [el("br"), el("span", { className: "error", textContent: "also " + others })] : [])),
                field("Open", { className: "num", textContent: s.open }),
                field("Actions", { className: "act" }, end));
        });
        const logins = r.logins.map((l) => el("tr", {}, field("When", { textContent: when(l.time) }),
            field("Used from", { className: "name", textContent: l.browser ? `${l.ip}, ${l.browser}` : l.ip }),
            field("Result", { className: l.ok ? "" : "error", textContent: l.ok ? "logged in" : "failed" })));
        const idle = r.idle_minutes ? ` A login with nothing open ends after ${r.idle_minutes} minutes.` : "";
        const attention = needsAttention(r);
        const markSeen = button("seen", "Mark as seen", async () => {
            markSeen.disabled = true;
            try {
                (await call({ type: "seen" })).close();
            } catch (err) {
                const row = statusRow("");
                row.set(`Not marked as seen: ${err.message}`, true);
                row.finish();
            }
            await showSessions(box);
        });
        box.replaceChildren(
            ...(attention ? [el("p", { className: "attention" }, "Something here is new since you last looked: a failed login, "
                + "or a session used from another address. ", markSeen)] : []),
            el("div", { className: "bar" }, el("h2", { textContent: "Sessions" }), everywhere),
            el("table", { className: "sessions-table" }, el("tr", {}, el("th", { textContent: "Logged in" }), el("th", { textContent: "Used from" }),
                el("th", { className: "num", textContent: "Open" }), el("th", { className: "act" })), ...rows),
            el("h2", { textContent: "Recent logins" }),
            el("table", { className: "logins-table" }, ...(logins.length ? logins : [el("tr", {}, field("", { textContent: "None since the server started." }))])),
            el("p", { className: "hint", textContent: "A session used from an address it didn't log in from is marked in red. "
                + "This page could hide that if it was changed on the way; the gateway also logs it (docker logs). "
                + "Browsers name themselves, so a name tells logins apart but proves nothing. "
                + "End… logs another session out." + idle }));
    }


    // endSession asks, then ends the session s, another than this one, as
    // listed in box, and lists the sessions again.
    async function endSession(s, when, box) {
        const by = s.browser ? ` with ${s.browser}` : "";
        if (!(await askYes(`End the session that logged in ${when(s.created)} from ${s.uses[0].ip}${by}? ` +
            "Everything it has open closes, and it has to log in again.", "End it"))) {
            return;
        }
        const row = statusRow("Ending a session");
        try {
            const t = await call({ type: "end-session", name: s.handle });
            t.close();
            row.set(`Ended the session from ${s.uses[0].ip}`);
        } catch (err) {
            row.set(`The session wasn't ended: ${err.message}`, true);
        }
        row.finish();
        await showSessions(box);
    }


    return { checkSecurity, showSessions };
}
