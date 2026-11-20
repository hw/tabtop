// The remote browser's site settings, at go/settings (gosites.go): sites'
// pop-ups (allowed, blocked, or asked about), sites whose videos are
// blocked, and sites blocked. (Its cookies and site data, on the same page:
// go-cookies.js.)

import { call, setLoginTitle } from "../tabtop/requests.js";

setLoginTitle("Site settings");

const $ = (id) => document.getElementById(id);

// In the browser's lightbox (a frame of the site's own: go.js): its header's
// there (with closing it), so this one's not shown.
if (window.parent !== window) {
    document.documentElement.classList.add("framed");
    $("back").addEventListener("click", (e) => {
        e.preventDefault();
        parent.postMessage({ goSettings: "close" }, location.origin);
    });
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

// The filter: each list's sites but those that match hidden, a list with
// none that do saying so. Given the page's site (?site=, from the browser's
// lightbox), that; cleared, or none given, all.
const matches = (site, f) => !f || site === f || site.endsWith("." + f) || f.endsWith("." + site) || site.includes(f);
function filter() {
    const f = $("filter").value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
    $("filter_clear").hidden = !f;
    for (const list of document.querySelectorAll("ul")) {
        const items = [...list.querySelectorAll(":scope > li[data-site]")];
        for (const li of items) li.classList.toggle("filtered", !matches(li.dataset.site, f));
        let none = list.nextElementSibling?.classList.contains("nomatch") ? list.nextElementSibling : null;
        const hideNone = !f || !items.length || items.some((li) => !li.classList.contains("filtered"));
        if (hideNone) none?.remove();
        else if (!none) {
            none = Object.assign(document.createElement("p"), { className: "nomatch" });
            list.after(none);
        }
        // (Set only as it changes: the observer below sees it, and would again.)
        if (none?.isConnected && none.textContent !== `None for ${f}.`) none.textContent = `None for ${f}.`;
    }
}
$("filter").value = new URLSearchParams(location.search).get("site") ?? "";
$("filter").addEventListener("input", filter);
$("filter_clear").addEventListener("click", () => {
    $("filter").value = "";
    filter();
    $("filter").focus();
});
// Lists drawn again (here, or the cookies' by go-cookies.js): filtered.
new MutationObserver(filter).observe(document.querySelector("main"), { childList: true, subtree: true });
filter();

function show(r) {
    const popups = Object.entries(r.popups ?? {}).sort(([a], [b]) => a.localeCompare(b));
    $("popups").replaceChildren(...popups.map(([site, setting]) => {
        const li = document.createElement("li");
        li.dataset.site = site;
        const select = document.createElement("select");
        select.setAttribute("aria-label", `${site}'s pop-ups`);
        for (const [value, label] of [["allow", "Allowed"], ["block", "Blocked"], ["ask", "Ask"]]) {
            select.append(Object.assign(document.createElement("option"), { value, textContent: label, selected: value === setting }));
        }
        select.addEventListener("change", () => set(site, "popups-" + select.value, `${site}'s pop-ups: ${select.selectedOptions[0].textContent.toLowerCase()}.`));
        li.append(Object.assign(document.createElement("span"), { className: "site", textContent: site }), select);
        return li;
    }));
    $("popups_empty").hidden = popups.length > 0;
    const blocked = Array.isArray(r.blocked) ? r.blocked : [];
    $("blocked").replaceChildren(...blocked.map((site) => {
        const li = document.createElement("li");
        li.dataset.site = site;
        const b = Object.assign(document.createElement("button"), { type: "button", textContent: "Unblock" });
        b.setAttribute("aria-label", `Unblock ${site}`);
        b.addEventListener("click", () => set(site, "unblock", `${site} unblocked.`));
        li.append(Object.assign(document.createElement("span"), { className: "site", textContent: site }), b);
        return li;
    }));
    $("blocked_empty").hidden = blocked.length > 0;
    $("referer").checked = r.referer !== false;
    const noVideos = Array.isArray(r.noVideos) ? r.noVideos : [];
    $("videos").replaceChildren(...noVideos.map((site) => {
        const li = document.createElement("li");
        li.dataset.site = site;
        const b = Object.assign(document.createElement("button"), { type: "button", textContent: "Allow" });
        b.setAttribute("aria-label", `Let ${site}'s videos play`);
        b.addEventListener("click", () => set(site, "videos-allow", `${site}'s videos play again.`));
        li.append(Object.assign(document.createElement("span"), { className: "site", textContent: site }), b);
        return li;
    }));
    $("videos_empty").hidden = noVideos.length > 0;
}

async function set(name, setting, done) {
    try {
        show(await ask({ type: "go-settings-set", name, setting }));
        say(done);
        return true;
    } catch (err) {
        say(err.message, { error: true });
        return false;
    }
}

$("referer").addEventListener("change", () => {
    const on = $("referer").checked;
    set("", on ? "referer-on" : "referer-off", on ? "Pages' addresses are sent with what they load." : "Pages' addresses aren't sent with what they load.");
});

$("video_block").addEventListener("submit", async (e) => {
    e.preventDefault();
    const site = $("video_site").value.trim();
    if (!site) return;
    if (await set(site, "videos-block", `${site}'s videos blocked.`)) $("video_site").value = "";
});

$("block").addEventListener("submit", async (e) => {
    e.preventDefault();
    const site = $("site").value.trim();
    if (!site) return;
    if (await set(site, "block", `${site} blocked.`)) $("site").value = "";
});

async function load() {
    try {
        show(await ask({ type: "go-settings" }));
    } catch (err) {
        say(err.message, { error: true });
    }
}
load();
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") load(); });
