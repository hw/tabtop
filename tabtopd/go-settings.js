// The remote browser's site settings, at go/settings (gosites.go): sites'
// pop-ups (allowed, blocked, or asked about), sites whose videos are
// blocked, and sites blocked. (Its cookies and site data, on the same page:
// go-cookies.js.)

import { call, setLoginTitle } from "../tabtop/requests.js";

setLoginTitle("Site settings");

const $ = (id) => document.getElementById(id);

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
    const popups = Object.entries(r.popups ?? {}).sort(([a], [b]) => a.localeCompare(b));
    $("popups").replaceChildren(...popups.map(([site, setting]) => {
        const li = document.createElement("li");
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
