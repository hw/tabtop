import * as tunnel from "./tunnel.js";
import { call, saveBlob, shareURL } from "./requests.js";
import { askChangeLink, askChangeLinks, askSessionName, askYes, copyText, showLink, statusRow } from "./ui.js";
import { logOut } from "./nav.js";
import { humanBytes } from "./download.js";

const SECURITY_TITLE = "Sessions and Activity";

// This browser's name for its session (see nameSession), kept in
// localStorage, which may refuse.
const SESSION_NAME = "tabtop.session-name";
function savedSessionName() {
    try {
        return localStorage.getItem(SESSION_NAME) ?? "";
    } catch {
        return "";
    }
}
function saveSessionName(name) {
    try {
        name ? localStorage.setItem(SESSION_NAME, name) : localStorage.removeItem(SESSION_NAME);
    } catch {
        // Only this login is named, then.
    }
}

// untilText says how long ms is, roughly: "45 minutes", "3 hours".
function untilText(ms) {
    const minutes = Math.max(1, Math.round(ms / 60000));
    if (minutes < 60) {
        return `${minutes} minute${minutes === 1 ? "" : "s"}`;
    }
    const hours = Math.round(minutes / 60);
    return `${hours} hour${hours === 1 ? "" : "s"}`;
}
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

export function createSessionView({ security, formatTime }) {
    // needsAttention says whether the sessions report r has anything new to
    // look at: a failed login since this session logged in (those before,
    // the summary shown after logging in told of) or since the warnings were
    // marked as seen, or a session used from another address, or a share
    // link made by another session, since they were. The Sessions and Activity button is marked if so. The times are
    // all the server's, so the browser's clock doesn't matter.
    function newSince(r) {
        const seen = Date.parse(r.seen) || 0;
        const since = Math.max(seen, Date.parse(r.sessions.find((s) => s.current)?.created) || 0);
        return r.logins.some((l) => !l.ok && Date.parse(l.time) > since) ||
            r.sessions.some((s) => s.uses.slice(1).some((u) => Date.parse(u.first) > seen)) ||
            (r.shares ?? []).some((l) => !l.mine && Date.parse(l.created) > seen);
    }
    // A client IP that looks like a proxy's (r.ip_warning) also marks it,
    // till it's fixed.
    function needsAttention(r) {
        const attention = newSince(r) || !!r.ip_warning;
        security.classList.toggle("attention", attention);
        security.title = attention ? `${SECURITY_TITLE}: something here needs attention (failed logins, a session used from another address, `
            + "a share link another session made, or the server seeing visitors as a proxy)"
            : SECURITY_TITLE;
        security.setAttribute("aria-label", security.title);
        return attention;
    }

    // checkSecurity marks the Sessions and Activity button if anything there
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
        // This browser's name for its session, given again to each new
        // login (sessions are the gateway's, and end; the name is the
        // browser's).
        const me = r.sessions.find((s) => s.current);
        const kept = savedSessionName();
        if (me && !me.label && kept) {
            try {
                (await call({ type: "name-session", label: kept })).close();
                me.label = kept;
            } catch {
                // Named next time.
            }
        }
        const when = formatTime;
        // How long until t, by the server's clock.
        const serverNow = Date.parse(r.now) || Date.now();
        const left = (t) => Date.parse(t) - serverNow;
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
            const name = button("name-session", "Name…", () => nameSession(s, box));
            return el("tr", {}, field("Logged in", {}, ...(s.label ? [el("strong", { textContent: s.label }), el("br")] : []),
                when(s.created) + (s.current ? " (this browser)" : ""),
                ...(s.browser ? [el("br"), el("span", { className: "hint", textContent: s.browser })] : [])),
                field("Used from", { className: "name" }, login.ip, ...(others ? [el("br"), el("span", { className: "error", textContent: "also " + others })] : [])),
                field("Open", { className: "num", textContent: s.open }),
                field("Actions", { className: "act" }, name, ...(end ? [" ", end] : [])));
        });
        const logins = r.logins.map((l) => el("tr", {}, field("When", { textContent: when(l.time) }),
            field("Used from", { className: "name", textContent: l.browser ? `${l.ip}, ${l.browser}` : l.ip }),
            field("Result", { className: l.ok ? "" : "error", textContent: l.ok ? "logged in" : "failed" })));
        const idle = r.idle_minutes ? ` A login with nothing open ends after ${r.idle_minutes} minutes.` : "";
        needsAttention(r);
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
        // Not something to mark as seen: it lasts till the setup is fixed.
        const ipWarning = r.ip_warning ? [el("p", { className: "attention ip-warning" }, r.ip_warning)] : [];
        const marked = newSince(r);
        const built = typeof r.build_time === "string" && r.build_time
            ? el("p", { className: "hint build-time", textContent: `TabTop built ${when(r.build_time)}` })
            : null;
        box.replaceChildren(...ipWarning,
            ...(marked ? [el("p", { className: "attention" }, "Something here is new since you last looked: a failed login, "
                + "a session used from another address, or a share link another session made. ",
                el("a", { href: "#shares", textContent: "Share links" }), " ", markSeen)] : []),
            el("div", { className: "bar" }, el("h2", { textContent: "Sessions" }), everywhere),
            el("table", { className: "sessions-table" }, el("tr", {}, el("th", { textContent: "Logged in" }), el("th", { textContent: "Used from" }),
                el("th", { className: "num", textContent: "Open" }), el("th", { className: "act" })), ...rows),
            el("p", { className: "hint", textContent: "A session used from an address it didn't log in from is marked in red. "
                + "This page could hide that if it was changed on the way; the gateway also logs it (docker logs). "
                + "Browsers name themselves, so a name tells logins apart but proves nothing. "
                + "End… logs another session out." + idle }),
            el("h2", { textContent: "Recent logins" }),
            el("table", { className: "logins-table" }, ...(logins.length ? logins : [el("tr", {}, field("", { textContent: "None since the server started." }))])));
        const activity = el("section", { className: "activity" });
        box.append(activity);
        await showActivity(activity, when, field);
        if (built) {
            box.append(built);
        }
    }

    // Share and upload links, with cleanup below the links.
    async function showShares(box) {
        let r;
        try {
            const t = await call({ type: "sessions" });
            t.close();
            r = t.reply;
        } catch (err) {
            box.replaceChildren(el("p", { className: "error", textContent: `Share links: ${err.message}` }));
            return;
        }
        needsAttention(r);
        const when = formatTime;
        const serverNow = Date.parse(r.now) || Date.now();
        const left = (t) => Date.parse(t) - serverNow;
        const field = (label, props = {}, ...children) => {
            const td = el("td", props, ...children);
            td.dataset.label = label;
            return td;
        };
        // Links ticked, to revoke together, and those used up.
        const picked = new Set();
        const revokePicked = button("revoke-picked", "Revoke selected…", () =>
            revokeShares((r.shares ?? []).filter((l) => picked.has(l.handle)), box));
        const updatePicked = () => {
            revokePicked.disabled = !picked.size;
            revokePicked.textContent = picked.size ? `Revoke ${picked.size} selected…` : "Revoke selected…";
            changePicked.disabled = !picked.size;
            changePicked.textContent = picked.size ? `Change ${picked.size} selected…` : "Change selected…";
        };
        const usedUp = (r.shares ?? []).filter((l) => l.max > 0 && l.count >= l.max || l.upload && (l.bytes ?? 0) >= l.max_bytes);
        const changePicked = button("change-picked", "Change selected…", () =>
            changeShares((r.shares ?? []).filter((l) => picked.has(l.handle)), box));
        updatePicked();
        const revokeUsedUp = usedUp.length
            ? [button("revoke-used-up", `Revoke ${usedUp.length} used up…`, () => revokeShares(usedUp, box))] : [];
        const shares = (r.shares ?? []).map((l) => {
            // An upload link counts files, and what they come to.
            const downloads = `${l.count}${l.max ? ` of ${l.max}` : ""}` + (l.upload
                ? ` file${l.count === 1 && !l.max ? "" : "s"}, ${humanBytes(l.bytes ?? 0)} of ${humanBytes(l.max_bytes)}` : "");
            const from = [...new Set(l.uses.map((u) => u.ip))].join(", ");
            const what = l.upload ? `Upload into ${l.path === "." ? "Downloads" : l.path}/` : l.path + (l.dir ? "/ (as a .zip)" : "");
            const tick = el("input", { type: "checkbox", title: `Select the link to ${what}` });
            tick.addEventListener("change", () => {
                tick.checked ? picked.add(l.handle) : picked.delete(l.handle);
                updatePicked();
            });
            return el("tr", {}, field("", { className: "sel" }, tick),
                field("Link to", { className: "name" }, ...(l.label ? [el("strong", { textContent: l.label }), el("br")] : []), what, el("br"),
                    el("span", { className: l.mine ? "hint" : "error", textContent: `made ${when(l.created)} from ${l.by_ip}`
                        + (l.mine ? "" : ", by another session") })),
                field("Ends", {}, when(l.expires), ...(left(l.expires) < 24 * 3600e3
                    ? [el("br"), el("span", { className: "soon", textContent: `ends in ${untilText(left(l.expires))}` })] : [])),
                field("Used", { className: "num" }, downloads, ...(from ? [el("br"), el("span", { className: "hint", textContent: from })] : [])),
                field("Actions", { className: "act" }, ...(l.shown ? [button("show-link", "Show link", () => showShare(l, when)), " "] : []),
                    button("change", "Change…", () => changeShare(l, when, box)), " ",
                    button("revoke", "Revoke…", () => revokeShare(l, box))));
        });
        box.replaceChildren(el("h2", { textContent: "Share links" }),
            ...(!r.shares ? [el("p", { className: "hint", textContent: "Share and upload links are disabled." })]
                : shares.length ? [el("div", { className: "shares-bar" }, changePicked, revokePicked, ...revokeUsedUp),
                    el("table", { className: "shares-table" }, el("tr", {}, el("th", { className: "sel" }), el("th", { textContent: "Link to" }),
                        el("th", { textContent: "Ends" }), el("th", { className: "num", textContent: "Used" }), el("th", { className: "act" })), ...shares)]
                : [el("p", { className: "hint", textContent: "None. Share… in a file's ⋯ menu makes one, and Upload link… below a folder." })]));
        const cleanup = el("section", { className: "cleanup" },
            el("div", { className: "bar" }, el("h2", { textContent: "Temporary files" }), button("clean-up", "Clean up…", () => cleanUp(box))),
            el("p", { className: "hint", textContent: "Uploads cut off are kept for an hour so they can carry on, and a crash can leave "
                + "temporary files behind (they're deleted at the next start). Clean up… deletes them now. Uploads and fetches going on "
                + "aren't touched." }));
        box.append(cleanup);
    }

    // How many entries of the activity log are shown at first.
    const ACTIVITY_SHOWN = 25;
    // The activity log's kinds of entry, in groups to filter by.
    const ACTIVITY_KINDS = [["", "Everything"], ["login logout logout-all end-session session login-failed", "Logins and sessions"],
        ["login-failed", "Failed logins"], ["share share-used", "Share and upload links"], ["upload", "Files received"],
        ["fetch", "Fetches"], ["cleanup cleared", "Cleaning up"]];
    // What the log is filtered by, kept as it's listed again.
    const activityFilter = { kinds: "", text: "" };

    // showActivity lists the activity log in section, its newest entries,
    // or all of them with all, or filtered (see activityFilter), with
    // buttons to show them all, download it and clear it.
    async function showActivity(section, when, field, all = false) {
        const filtering = !!(activityFilter.kinds || activityFilter.text.trim());
        let r;
        try {
            const t = await call({ type: "activity", max: all || filtering ? 0 : ACTIVITY_SHOWN });
            t.close();
            r = t.reply;
        } catch (err) {
            section.replaceChildren(el("h2", { textContent: "Activity" }), el("p", { className: "error", textContent: `Activity: ${err.message}` }));
            return;
        }
        const kinds = new Set(activityFilter.kinds.split(" ").filter(Boolean));
        const q = activityFilter.text.trim().toLowerCase();
        const entries = r.entries.filter((e) => (!kinds.size || kinds.has(e.kind))
            && (!q || e.text.toLowerCase().includes(q) || (e.ip ?? "").toLowerCase().includes(q)));
        const rows = entries.map((e) => el("tr", {}, field("When", { textContent: when(e.time) }),
            field("From", { className: "name" }, e.ip || "", ...(e.session ? [el("br"), el("span", { className: "hint", textContent: e.session })] : [])),
            field("What", { className: e.kind === "login-failed" || e.kind === "cleared" ? "error" : "", textContent: e.text })));
        const more = !filtering && r.total > r.entries.length
            ? [button("more", `Show all ${r.total}`, () => showActivity(section, when, field, true))] : [];
        const kind = el("select", { className: "kind" }, ...ACTIVITY_KINDS.map(([value, text]) => el("option", { value, textContent: text })));
        kind.value = activityFilter.kinds;
        kind.setAttribute("aria-label", "Show");
        const text = el("input", { type: "search", className: "filter", value: activityFilter.text, placeholder: "Filter by address or words",
            autocomplete: "off", spellcheck: false });
        text.setAttribute("aria-label", "Filter the activity log");
        let typing;
        const refilter = () => showActivity(section, when, field, all);
        kind.addEventListener("change", () => {
            activityFilter.kinds = kind.value;
            refilter();
        });
        text.addEventListener("input", () => {
            activityFilter.text = text.value;
            clearTimeout(typing);
            typing = setTimeout(async () => {
                const focused = document.activeElement === text;
                const at = text.selectionStart;
                await refilter();
                const again = section.querySelector("input.filter");
                if (focused && again) {
                    again.focus();
                    again.setSelectionRange(at, at);
                }
            }, 250);
        });
        const download = button("download", "Download", () => downloadActivity());
        const clear = button("clear danger", "Clear…", () => clearActivity(section, when, field));
        section.replaceChildren(
            el("div", { className: "bar" }, el("h2", { textContent: "Activity" }), el("span", { className: "buttons" }, download, " ", clear)),
            el("div", { className: "find" }, kind, text, ...(filtering ? [el("span", { className: "hint",
                textContent: `${entries.length} of ${r.total} shown` })] : [])),
            rows.length ? el("table", { className: "activity-table" }, el("tr", {}, el("th", { textContent: "When" }),
                el("th", { textContent: "From" }), el("th", { textContent: "What" })), ...rows)
                : el("p", { className: "hint", textContent: filtering ? "Nothing matches." : "Nothing yet." }),
            ...more,
            el("p", { className: "hint", textContent: "Logins, logging out, share and upload links and what's done with them, "
                + `fetches from URLs and cleaning up, kept across restarts (the newest ${r.max ?? 2000}). Clearing it leaves an entry saying so.` }));
    }

    // cleanUp says what cleaning up would delete, asks, then does it.
    async function cleanUp(box) {
        const row = statusRow("Cleaning up");
        try {
            let t = await call({ type: "cleanup", dry_run: true });
            t.close();
            const c = t.reply.cleanup;
            if (!c.kept && !c.temps) {
                row.set("Nothing to clean up" + (c.stopped ? " found (the search stopped part way, in a big folder)" : ""));
                row.finish();
                return;
            }
            const what = [c.kept ? `${c.kept} upload${c.kept === 1 ? "" : "s"} cut off and kept to carry on` : "",
                c.temps ? `${c.temps} leftover temporary file${c.temps === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
            if (!(await askYes(`Delete ${what}, ${humanBytes(c.bytes)} in all? Uploads cut off can't carry on after this; `
                + "send them again.", "Delete them"))) {
                row.set("Not cleaned up");
                row.finish();
                return;
            }
            t = await call({ type: "cleanup" });
            t.close();
            row.set(`Cleaned up ${humanBytes(t.reply.cleanup.bytes)}`);
        } catch (err) {
            row.set(`Not cleaned up: ${err.message}`, true);
        }
        row.finish();
        await showShares(box);
    }

    // downloadActivity saves the whole activity log, oldest first, as
    // tab-separated lines.
    async function downloadActivity() {
        const row = statusRow("Activity log: downloading");
        try {
            const t = await call({ type: "activity", max: 0 });
            t.close();
            const lines = ["time\tfrom\tsession\tkind\twhat",
                ...t.reply.entries.reverse().map((e) => [e.time, e.ip ?? "", e.session ?? "", e.kind, e.text].join("\t"))];
            const name = `tabtop-activity-${new Date().toISOString().slice(0, 10)}.tsv`;
            saveBlob(new Blob([lines.join("\n") + "\n"], { type: "text/tab-separated-values" }), name);
            row.set(`${name}: downloaded`);
        } catch (err) {
            row.set(`Activity log: not downloaded: ${err.message}`, true);
        }
        row.finish();
    }

    // clearActivity asks, then clears the activity log, and lists it again.
    async function clearActivity(section, when, field) {
        if (!(await askYes("Clear the activity log? Everything in it goes, for good, except one entry saying it was "
            + "cleared, by which session, and from where.", "Clear it"))) {
            return;
        }
        const row = statusRow("Clearing the activity log");
        try {
            (await call({ type: "activity-clear" })).close();
            row.set("Cleared the activity log");
        } catch (err) {
            row.set(`The activity log wasn't cleared: ${err.message}`, true);
        }
        row.finish();
        await showActivity(section, when, field);
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


    // showShare shows the link l again, as listed, to copy.
    async function showShare(l, when) {
        const name = l.path === "." ? "Downloads" : l.path;
        let r;
        try {
            const t = await call({ type: "share-again", name: l.handle });
            t.close();
            r = t.reply;
        } catch (err) {
            const row = statusRow("");
            row.set(`The link to ${name} can't be shown: ${err.message}`, true);
            row.finish();
            return;
        }
        const url = shareURL(r.token, r);
        const what = l.upload ? `The link for uploading into ${name}` : `The link to ${name}${l.dir ? " (as a .zip)" : ""}`;
        if (await showLink(`${what}, until ${when(l.expires)}.`, url)) {
            const row = statusRow("");
            try {
                await copyText(url);
                row.set(`Copied the link to ${name}`);
            } catch {
                row.set(`Couldn't copy the link to ${name}: ${url}`, true);
            }
            row.finish();
        }
    }

    // changeShare asks how the share link l, as listed in box, should work
    // from now on, changes it, and lists them again.
    async function changeShare(l, when, box) {
        const how = await askChangeLink(l, when(l.expires), humanBytes);
        if (!how) {
            return;
        }
        const name = l.path === "." ? "Downloads" : l.path;
        const row = statusRow("Changing a link");
        try {
            const t = await call({ type: "reshare", name: l.handle, expires: how.expires, max: how.max, max_bytes: how.maxBytes, label: how.label });
            t.close();
            row.set(`Changed the link to ${name}: it ends ${when(t.reply.expires)}`);
        } catch (err) {
            row.set(`The link wasn't changed: ${err.message}`, true);
        }
        row.finish();
        await showShares(box);
    }

    // changeShares asks how the share links ls, as listed in box, should
    // change, changes them together, and lists them again.
    async function changeShares(ls, box) {
        const how = ls.length ? await askChangeLinks(ls.length) : null;
        if (!how) {
            return;
        }
        const row = statusRow("Changing links");
        try {
            const t = await call({ type: "reshare-many", names: ls.map((l) => l.handle), expires: how.expires, label: how.label,
                relabel: how.relabel });
            t.close();
            row.set(`Changed ${t.reply.changed} link${t.reply.changed === 1 ? "" : "s"}`);
        } catch (err) {
            row.set(`The links weren't changed: ${err.message}`, true);
        }
        row.finish();
        await showShares(box);
    }

    // nameSession asks what to call the session s, as listed in box, names
    // it, and lists the sessions again. This browser keeps its own
    // session's name, for its next logins.
    async function nameSession(s, box) {
        const label = await askSessionName(s.label ?? "", s.current);
        if (label === null) {
            return;
        }
        const row = statusRow("Naming a session");
        try {
            (await call({ type: "name-session", name: s.current ? "" : s.handle, label })).close();
            if (s.current) {
                saveSessionName(label);
            }
            row.set(label ? `Named the session "${label}"` : "Took the session's name away");
        } catch (err) {
            row.set(`The session wasn't named: ${err.message}`, true);
        }
        row.finish();
        await showSessions(box);
    }

    // revokeShares asks, then revokes the share links ls, as listed in box,
    // and lists them again.
    async function revokeShares(ls, box) {
        if (!ls.length || !(await askYes(`Revoke ${ls.length} link${ls.length === 1 ? "" : "s"}? They stop working at once, `
            + "downloads and uploads going on included.", "Revoke them"))) {
            return;
        }
        const row = statusRow("Revoking links");
        try {
            const t = await call({ type: "unshare", names: ls.map((l) => l.handle) });
            t.close();
            row.set(`Revoked ${t.reply.revoked} link${t.reply.revoked === 1 ? "" : "s"}`);
        } catch (err) {
            row.set(`The links weren't revoked: ${err.message}`, true);
        }
        row.finish();
        await showShares(box);
    }

    // revokeShare asks, then revokes the share link l, as listed in box, and
    // lists them again.
    async function revokeShare(l, box) {
        if (!(await askYes(`Revoke the ${l.upload ? "upload " : ""}link to ${l.path === "." ? "Downloads" : l.path}? `
            + `It stops working at once, ${l.upload ? "uploads" : "downloads"} going on included.`, "Revoke it"))) {
            return;
        }
        const row = statusRow("Revoking a link");
        try {
            (await call({ type: "unshare", name: l.handle })).close();
            row.set(`Revoked the link to ${l.path === "." ? "Downloads" : l.path}`);
        } catch (err) {
            row.set(`The link wasn't revoked: ${err.message}`, true);
        }
        row.finish();
        await showShares(box);
    }

    return { checkSecurity, showSessions, showShares };
}
