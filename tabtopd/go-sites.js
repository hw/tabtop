// Site controls (go/sites): each site's access, permissions and data, and
// what holds for them all (Browser-wide). The browser's own settings, ad
// blocking, are in Settings (go/settings, go-settings.js).
import { iconSVG } from "../tabtop/glyphs.js";
import { setLoginTitle } from "../tabtop/requests.js";
import { siteDataSummary, storageSize } from "./go-cookies.js";
import { $, ask, runner, told } from "./go-pages.js";

setLoginTitle("Site controls");

$("back_to_sites_glyph").innerHTML = $("back_to_site_glyph").innerHTML = iconSVG("back");
const currentName = new URLSearchParams(location.search).get("site");
const views = {
    all: ["show_all", "all_sites"],
    site: ["show_current", "site_settings"],
    browser: ["show_browser", "browser_settings"],
    inspect: [null, "site_inspect"],  // (a site's, from its view: no button of its own)
};
let view = "all";
let current, selected, pendingClear;
let fromAllSites = false;
let settings, data;
// The inspector: the site's cookies and localStorage (go-site-data), which
// list is shown, and the rows opened (kept open as it's shown again).
let inspected, inspectTab = "cookies";
const opened = new Set();
// Sites ticked on All sites, for clearing cookies and localStorage together.
const checked = new Set();
let listedSites = [];
const state = runner(render);
const run = state.run;

function covering(host, names) {
    return (names ?? []).filter((name) => host === name || host.endsWith("." + name))
        .sort((a, b) => a.length - b.length)[0];
}

function override(map, site) {
    return map && Object.hasOwn(map, site) ? map[site] : "default";
}

const policyLabel = { ask: "Ask", allow: "Allow", block: "Block", "no-autoplay": "No autoplay" };

function renderSelection() {
    const n = checked.size;
    const listed = listedSites.length;
    $("selection_bar").hidden = listed === 0;
    $("selection_count").textContent = n ? `${n} selected` : "";
    $("clear_selected").disabled = state.busy || n === 0;
    const all = $("select_all");
    const selectedListed = listedSites.filter((name) => checked.has(name)).length;
    all.checked = listed > 0 && selectedListed === listed;
    all.indeterminate = selectedListed > 0 && selectedListed < listed;
    all.disabled = state.busy || listed === 0;
}

function renderSites() {
    const query = $("filter").value.trim().toLowerCase()
        .replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/, 1)[0];
    const usage = new Map((data?.sites ?? []).map((info) => [info.site, info]));
    const names = new Set([
        ...usage.keys(), ...(settings?.blocked ?? []), ...Object.keys(settings?.media ?? {}),
        ...Object.keys(settings?.popups ?? {}), ...Object.keys(settings?.ads ?? {}), ...(settings?.videoHosts ?? []),
    ]);
    const sort = $("sort_sites").value;
    const score = (info) => sort === "size" ? info?.storage ?? 0
        : sort === "recent" ? Math.max(info?.visited ?? 0, info?.changed ?? 0) : 0;
    const found = [...names].filter((name) => name.includes(query)).sort((a, b) =>
        score(usage.get(b)) - score(usage.get(a)) || a.localeCompare(b));
    listedSites = found;
    for (const name of [...checked]) {
        if (!names.has(name)) checked.delete(name);
    }
    $("sites").replaceChildren(...found.map((name) => {
        const li = document.createElement("li");
        li.dataset.site = name;
        const pick = Object.assign(document.createElement("input"), {
            type: "checkbox", checked: checked.has(name), disabled: state.busy,
        });
        pick.setAttribute("aria-label", `Select ${name}`);
        pick.addEventListener("click", (event) => event.stopPropagation());
        pick.addEventListener("change", () => {
            if (pick.checked) checked.add(name);
            else checked.delete(name);
            renderSelection();
        });
        const row = Object.assign(document.createElement("button"), { type: "button", className: "site-row", disabled: state.busy });
        const parts = [];
        if (covering(name, settings?.blocked)) parts.push("Access blocked");
        const popup = override(settings?.popups, name);
        if (popup !== "default") parts.push({ ask: "Pop-ups ask first", block: "Pop-ups blocked", allow: "Pop-ups allowed" }[popup]);
        const media = override(settings?.media, name);
        if (media !== "default") parts.push({ block: "Videos and sound blocked", allow: "Videos and sound allowed", "no-autoplay": "No autoplay" }[media]);
        const ads = override(settings?.ads, name);
        if (ads !== "default") parts.push({ block: "Ads blocked", allow: "Ads allowed" }[ads]);
        if (settings?.videoHosts?.includes(name)) parts.push("Videos from here blocked");
        parts.push(...siteDataSummary(usage.get(name)));
        row.append(Object.assign(document.createElement("span"), { className: "site", textContent: name }));
        if (parts.length) row.append(Object.assign(document.createElement("span"), { className: "detail", textContent: parts.join(" · ") }));
        row.addEventListener("click", () => openSite(name));
        li.append(pick, row);
        return li;
    }));
    $("empty").hidden = found.length > 0 || (state.busy && !settings && !data);
    $("empty").textContent = query ? "No matching sites." : "No sites with saved settings or data.";
    $("storage_usage").hidden = !data?.storage;
    if (data?.storage) $("storage_usage").textContent = `${storageSize(data.storage.used)} of ${storageSize(data.storage.max)}`;
    $("open_site").disabled = state.busy || !$("filter").value.trim();
    renderSelection();
}

function renderSite() {
    if (!selected || !settings) return;
    const { host, site } = selected;
    const blocked = covering(host, settings.blocked);
    const info = data?.sites?.find((item) => item.site === site);
    $("site_heading").textContent = host;
    $("access").textContent = blocked ? "Unblock site" : "Block site";
    $("access").disabled = state.busy;
    $("video_host_row").hidden = !settings.videoHosts?.includes(host);
    $("video_host").disabled = state.busy;
    $("access_note").textContent = blocked && blocked !== host ? `Blocked by the rule for ${blocked}.`
        : blocked ? "This site and its subdomains are blocked." : "Allowed";
    const scope = site === host ? "" : `Applies to ${site}. `;
    $("popups").value = override(settings.popups, site);
    $("popups").disabled = state.busy;
    $("popup_scope").textContent = scope + ($("popups").value === "default" ? `Default: ${policyLabel[settings.popupDefault] ?? "Ask"}.` : "");
    $("videos").value = override(settings.media, site);
    $("videos").disabled = state.busy;
    $("video_note").textContent = scope + ($("videos").value === "default" ? `Default: ${policyLabel[settings.mediaDefault] ?? "Allow"}.` : "");
    // Ads: blocked by site, from the filter lists in Settings (ad blocking,
    // on or off there, is the default).
    $("ads").value = override(settings.ads, site);
    $("ads").disabled = state.busy;
    $("ads_note").textContent = scope + ($("ads").value === "default"
        ? `Default: ${settings.adblock ? "Block" : "Allow"} (ad blocking in Settings is ${settings.adblock ? "on" : "off"}).`
        : $("ads").value === "block" && !settings.adblock ? "Uses the filter lists ticked in Settings." : "");
    const usage = siteDataSummary(info).join(" · ");
    $("site_data").textContent = (site === host ? "" : `${site} · `) +
        (usage || (data ? "No site data." : "Site data unavailable."));
    $("clear_site").disabled = state.busy || !info;
    $("inspect_site").disabled = state.busy || !info?.cookies && !info?.storageItems;
}

// The inspector's rows: a site's cookies, or its origins' localStorage,
// those the filter finds (in a name, a key, a domain or a value); each
// opens to what it holds, and to Copy and Delete.
const when = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
function entry(id, name, value, fields, remove) {
    const details = document.createElement("details");
    details.className = "entry";
    details.open = opened.has(id);
    details.addEventListener("toggle", () => { if (details.open) opened.add(id); else opened.delete(id); });
    const summary = document.createElement("summary");
    summary.append(Object.assign(document.createElement("span"), { className: "name", textContent: name || "(no name)" }),
        Object.assign(document.createElement("span"), { className: "preview", textContent: value.value.slice(0, 200) || "(empty)" }));
    const body = Object.assign(document.createElement("div"), { className: "entry-body" });
    const list = document.createElement("dl");
    const size = value.size < 1024 ? `${value.size} B` : storageSize(value.size);
    for (const [term, text] of [...fields, ["Size", value.truncated ? `${size} (the first ${storageSize(value.value.length)} shown)` : size]]) {
        if (text) list.append(Object.assign(document.createElement("dt"), { textContent: term }), Object.assign(document.createElement("dd"), { textContent: text }));
    }
    const shown = Object.assign(document.createElement("pre"), { className: "value", textContent: value.value });
    shown.setAttribute("aria-label", "Value");
    const copy = Object.assign(document.createElement("button"), { type: "button", textContent: value.truncated ? "Copy shown" : "Copy value" });
    copy.addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText(value.value);
            say("Value copied.");
        } catch {
            // (No clipboard here, a page not served securely: the value
            // selected, for the person to copy.)
            getSelection().selectAllChildren(shown);
            say("Value selected: copy it.");
        }
    });
    const del = Object.assign(document.createElement("button"), { type: "button", className: "danger", textContent: "Delete", disabled: state.busy });
    del.addEventListener("click", remove);
    const acts = Object.assign(document.createElement("div"), { className: "tools" });
    acts.append(copy, del);
    body.append(list, shown, acts);
    details.append(summary, body);
    const li = document.createElement("li");
    li.append(details);
    return li;
}
function renderInspect() {
    if (!selected) return;
    $("inspect_heading").textContent = `${selected.site} data`;
    const cookies = inspected?.cookies ?? [], origins = inspected?.storage ?? [];
    const items = origins.reduce((n, o) => n + o.items.length, 0);
    $("show_cookies").textContent = `Cookies (${cookies.length})`;
    $("show_storage").textContent = `Local storage (${items})`;
    $("show_storage").hidden = !inspected || !inspected.storage;
    for (const [tab, button] of [["cookies", "show_cookies"], ["storage", "show_storage"]]) {
        if (inspectTab === tab) $(button).setAttribute("aria-current", "true");
        else $(button).removeAttribute("aria-current");
    }
    $("inspect_refresh").disabled = state.busy;
    const query = $("inspect_filter").value.trim().toLowerCase();
    const finds = (...texts) => !query || texts.some((t) => t?.toLowerCase().includes(query));
    const rows = [];
    if (inspectTab === "cookies") {
        $("inspect_note").textContent = "Cookies sites set in the browser, kept for your account. Deleting one may sign you out of its site.";
        for (const c of cookies) {
            if (!finds(c.name, c.domain, c.value)) continue;
            const flags = [c.httpOnly && "HttpOnly", c.secure && "Secure", c.sameSite && `SameSite=${c.sameSite}`].filter(Boolean).join(", ");
            rows.push(entry(`c:${c.name}\0${c.domain}\0${c.path}`, c.name, c, [
                ["Domain", c.domain.startsWith(".") ? `${c.domain} (and its subdomains)` : c.domain],
                ["Path", c.path],
                ["Expires", c.session || c.expires < 0 ? "When the browser session ends" : when(c.expires * 1000)],
                ["Flags", flags],
                ["Changed", c.changed ? when(c.changed) : ""],
            ], () => remove(`the cookie ${c.name}`, { cookie: { name: c.name, domain: c.domain, path: c.path } })));
        }
    } else {
        $("inspect_note").textContent = "What the site's pages keep in localStorage, kept for your account.";
        for (const o of origins) {
            const found = o.items.filter((i) => finds(i.key, i.value, o.origin));
            if (!found.length) continue;
            const head = Object.assign(document.createElement("li"), { className: "origin", textContent: o.origin + " " });
            head.append(Object.assign(document.createElement("span"), { className: "detail", textContent: `· ${o.items.length} item${o.items.length === 1 ? "" : "s"}${o.changed ? ` · changed ${when(o.changed)}` : ""}` }));
            rows.push(head);
            for (const i of found) {
                rows.push(entry(`s:${o.origin}\0${i.key}`, i.key, i, [["Origin", o.origin]],
                    () => remove(`the item ${i.key}`, { storage: { origin: o.origin, key: i.key } })));
            }
        }
    }
    $("inspect_list").replaceChildren(...rows);
    $("inspect_empty").hidden = rows.length > 0 || !inspected;
    $("inspect_empty").textContent = query ? "Nothing matches." : inspectTab === "cookies" ? "No cookies." : "No local storage.";
}

// inspect shows the selected site's data, read afresh.
function inspect() {
    return run(async () => {
        inspected = await ask({ type: "go-site-data", name: selected.site });
    });
}
function remove(what, which) {
    if (!confirm(`Delete ${what}?`)) return;
    run(async () => {
        inspected = await ask({ type: "go-site-data-delete", name: selected.site, ...which });
        data = await ask({ type: "go-cookies" }).catch(() => data);
    }, `Deleted ${what}.`);
}

function render() {
    $("show_current").hidden = !current;
    const active = (view === "site" || view === "inspect") && fromAllSites ? "all" : view === "inspect" ? "site" : view;
    $("back_to_sites").hidden = !fromAllSites;
    for (const [name, [button, panel]] of Object.entries(views)) {
        $(panel).hidden = name !== view;
        if (!button) continue;
        if (name === active) $(button).setAttribute("aria-current", "true");
        else $(button).removeAttribute("aria-current");
    }
    renderSites();
    renderSite();
    renderInspect();
    const busy = state.busy;
    $("default_popups").value = settings?.popupDefault ?? "ask";
    $("default_videos").value = settings?.mediaDefault ?? "allow";
    $("default_popups").disabled = $("default_videos").disabled = busy || !settings;
    $("referer").checked = settings?.referer !== false;
    $("referer").disabled = busy || !settings;
    $("clear_browser").disabled = busy || !data;
    $("clear_cache").disabled = busy || !settings;
    $("about").textContent = data?.storage
        ? "Clear cookies and site data across sites for a selected time range."
        : "Clear cookies and data in open tabs across sites for a selected time range.";
}

function show(name, focus) {
    view = name;
    render();
    if (focus) $({ all: "filter", site: "site_heading", browser: "browser_heading", inspect: "inspect_heading" }[name]).focus();
}

async function openSite(name) {
    if (!await run(async () => {
        const reply = await ask({ type: "go-settings", name });
        settings = reply;
        selected = { host: reply.host, site: reply.site };
    })) return;
    fromAllSites = true;
    show("site", true);
}

function set(name, setting, done = "Setting saved.") {
    return run(async () => {
        settings = await ask({ type: "go-settings-set", name, setting });
        if (setting.startsWith("videos-")) told("media-changed");
    }, done);
}

$("inspect_site").addEventListener("click", async () => {
    inspected = null;
    opened.clear();
    $("inspect_filter").value = "";
    show("inspect", true);
    await inspect();
});
$("back_to_site").addEventListener("click", () => {
    show("site");
    $("inspect_site").focus();
});
$("show_cookies").addEventListener("click", () => { inspectTab = "cookies"; renderInspect(); });
$("show_storage").addEventListener("click", () => { inspectTab = "storage"; renderInspect(); });
$("inspect_filter").addEventListener("input", renderInspect);
$("inspect_tools").addEventListener("submit", (event) => event.preventDefault());
$("inspect_refresh").addEventListener("click", inspect);
$("show_current").addEventListener("click", () => {
    selected = current;
    fromAllSites = false;
    show("site", true);
});
$("back_to_sites").addEventListener("click", () => {
    show("all");
    const row = [...$("sites").children].find((item) => item.dataset.site === selected.host);
    (row?.querySelector("button:not(:disabled)") ?? $("filter")).focus();
});
$("show_all").addEventListener("click", () => show("all", true));
$("show_browser").addEventListener("click", () => show("browser", true));
$("filter").addEventListener("input", renderSites);
$("sort_sites").addEventListener("change", renderSites);
$("find_site").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = $("filter").value.trim();
    if (name) openSite(name);
});
// A video host's block (a Skip held, in the browser): lifted.
$("video_host").addEventListener("click", () => set(selected.host, "videos-host-allow", "Videos from this host are allowed again."));
$("access").addEventListener("click", () => {
    const { host } = selected;
    const blocked = covering(host, settings.blocked);
    if (blocked && blocked !== host && !confirm(`Remove the access block for ${blocked} and its subdomains?`)) return;
    set(blocked ?? host, blocked ? "unblock" : "block");
});
$("popups").addEventListener("change", () => set(selected.site, "popups-" + $("popups").value));
$("videos").addEventListener("change", () => set(selected.site, "videos-" + $("videos").value));
$("ads").addEventListener("change", () => set(selected.site, "ads-" + $("ads").value));
$("default_popups").addEventListener("change", () => set("", "popups-" + $("default_popups").value));
$("default_videos").addEventListener("change", () => set("", "videos-" + $("default_videos").value));
$("referer").addEventListener("change", () => set("", $("referer").checked ? "referer-on" : "referer-off"));

// confirmClear asks before clearing one site's data (string), several
// sites' (array), or every site's for a time range ("").
function confirmClear(target) {
    pendingClear = target;
    if (Array.isArray(target)) {
        const n = target.length;
        $("clear_heading").textContent = n === 1 ? `Clear data for ${target[0]}?` : `Clear data for ${n} sites?`;
        $("clear_summary").textContent = n === 1
            ? "This clears cookies and site data for this site. You may be signed out."
            : "This clears cookies and site data for the selected sites. You may be signed out.";
        $("time_range").hidden = true;
    } else {
        $("clear_heading").textContent = target ? `Clear data for ${target}?` : "Clear browsing data?";
        $("clear_summary").textContent = target
            ? "This clears cookies and site data for this site. You may be signed out."
            : "This clears cookies and site data across sites for the selected time range. You may be signed out.";
        $("time_range").hidden = !!target;
    }
    $("confirm_clear").returnValue = "";
    $("confirm_clear").showModal();
}
$("select_all").addEventListener("change", () => {
    if ($("select_all").checked) for (const name of listedSites) checked.add(name);
    else for (const name of listedSites) checked.delete(name);
    renderSites();
});
$("clear_selected").addEventListener("click", () => {
    const names = listedSites.filter((name) => checked.has(name));
    if (names.length) confirmClear(names);
});
$("clear_site").addEventListener("click", () => confirmClear(selected.site));
$("clear_browser").addEventListener("click", () => confirmClear(""));
$("clear_cache").addEventListener("click", () => run(async () => {
    await ask({ type: "go-cache-clear" });
    const events = new BroadcastChannel(new URL("./", location.href).pathname + "cache");
    events.postMessage("cleared");
    events.close();
}, "Cached files cleared."));
$("confirm_clear").addEventListener("close", () => {
    if ($("confirm_clear").returnValue !== "clear") return;
    const target = pendingClear;
    const within = Number($("within").value);
    run(async () => {
        if (Array.isArray(target)) {
            data = await ask({ type: "go-cookies-forget", names: target });
            for (const name of target) checked.delete(name);
        } else {
            data = await ask({ type: "go-cookies-forget", name: target, within: target ? 0 : within });
            if (target) checked.delete(target);
        }
    }, Array.isArray(target)
        ? (target.length === 1 ? `Cleared site data for ${target[0]}.` : `Cleared site data for ${target.length} sites.`)
        : target ? `Cleared site data for ${target}.` : "Cleared browsing data for the selected time range.");
});

run(async () => {
    const [siteResult, dataResult] = await Promise.allSettled([
        ask({ type: "go-settings", name: currentName ?? "" }),
        ask({ type: "go-cookies" }),
    ]);
    if (dataResult.status === "fulfilled") data = dataResult.value;
    if (siteResult.status === "rejected") throw siteResult.reason;
    settings = siteResult.value;
    if (settings.host) {
        current = selected = { host: settings.host, site: settings.site };
        if (view === "all") view = "site";
    }
    if (dataResult.status === "rejected") throw dataResult.reason;
});
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && settings) run(async () => {
        [settings, data] = await Promise.all([ask({ type: "go-settings" }), ask({ type: "go-cookies" })]);
    });
});
