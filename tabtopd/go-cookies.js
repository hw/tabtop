// The remote browser's cookies and site data, on its site settings page
// (go/settings#cookies; go/cookie goes there): the sites
// whose cookies are kept for the account (gocookies.go), or whose data is
// in a /go tab open now; how many cookies, and when last set. A site's
// deleted, or what sites set in a time is cleared. Only sites and counts
// come here, never a cookie's value.

import { call, setLoginTitle } from "../tabtop/requests.js";


const $ = (id) => document.getElementById(id);

function ago(ms) {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    for (const [unit, n] of [["day", 86400], ["hour", 3600], ["minute", 60]]) {
        if (s >= n) {
            const k = Math.round(s / n);
            return `${k} ${unit}${k === 1 ? "" : "s"} ago`;
        }
    }
    return "just now";
}

function say(text, { error = false } = {}) {
    $("done").textContent = text;
    $("done").classList.toggle("error", error);
}

async function ask(req) {
    const t = await call(req);
    t.close();
    return t.reply;
}

function show(r) {
    $("about").textContent = (r.kept
        ? "Cookies sites set in the remote browser are kept on the server for your account, sealed, so sites remember you across tabs. "
        : "Cookies sites set in the remote browser are kept on the server for your account until it restarts. ")
        + "Sites' other data (local storage, databases) lasts only while a tab is open: deleting or clearing clears it in the tabs open now.";
    const all = Array.isArray(r.sites) ? r.sites : [];
    $("sites").replaceChildren(...all.map((site) => {
        const li = document.createElement("li");
        const what = Object.assign(document.createElement("div"), { className: "what" });
        const parts = [];
        if (site.cookies > 0) parts.push(`${site.cookies} cookie${site.cookies === 1 ? "" : "s"}`);
        if (site.changed > 0) parts.push(`set ${ago(site.changed)}`);
        if (site.open) parts.push("data in an open tab");
        what.append(Object.assign(document.createElement("div"), { className: "site", textContent: String(site.site) }),
            Object.assign(document.createElement("div"), { className: "detail", textContent: parts.join(" · ") }));
        const del = Object.assign(document.createElement("button"), { type: "button", textContent: "Delete" });
        del.setAttribute("aria-label", `Delete ${site.site}'s cookies and data`);
        del.addEventListener("click", () => forget({ name: String(site.site) }, `${site.site} deleted.`, del));
        li.append(what, del);
        return li;
    }));
    $("empty").hidden = all.length > 0;
}

async function forget(req, done, button) {
    if (button) button.disabled = true;
    try {
        show(await ask({ type: "go-cookies-forget", ...req }));
        say(done);
    } catch (err) {
        say(err.message, { error: true });
    }
    if (button?.isConnected) button.disabled = false;  // (a site's is gone with its row)
}

$("clear").addEventListener("click", () => {
    const within = Number($("within").value);
    const label = $("within").selectedOptions[0]?.textContent ?? "";
    if (within === 0 && !confirm("Clear all cookies and site data kept for this account? Sites will forget you.")) return;
    forget({ name: "", within }, `Cleared what sites set in ${label}.`, $("clear"));
});

async function load() {
    try {
        show(await ask({ type: "go-cookies" }));
    } catch (err) {
        $("about").textContent = "";
        say(err.message, { error: true });
    }
}
load();
// Fresh when come back to (cookies set in a tab meanwhile).
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") load(); });
