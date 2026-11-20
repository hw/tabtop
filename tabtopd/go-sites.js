// Site controls (go/sites): each site's access, permissions and data, and
// what holds for them all (Browser-wide). The browser's own settings, ad
// blocking, are in Settings (go/settings, go-settings.js).
import { iconSVG } from "../tabtop/glyphs.js";
import { setLoginTitle } from "../tabtop/requests.js";
import { siteDataSummary, storageSize } from "./go-cookies.js";
import { $, ask, runner, told } from "./go-pages.js";

setLoginTitle("Site controls");

$("back_to_sites_glyph").innerHTML = iconSVG("back");
const currentName = new URLSearchParams(location.search).get("site");
const views = {
    all: ["show_all", "all_sites"],
    site: ["show_current", "site_settings"],
    browser: ["show_browser", "browser_settings"],
};
let view = "all";
let current, selected, pendingClear;
let fromAllSites = false;
let settings, data;
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

function renderSites() {
    const query = $("filter").value.trim().toLowerCase()
        .replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/, 1)[0];
    const usage = new Map((data?.sites ?? []).map((info) => [info.site, info]));
    const names = new Set([
        ...usage.keys(), ...(settings?.blocked ?? []), ...Object.keys(settings?.media ?? {}),
        ...Object.keys(settings?.popups ?? {}), ...Object.keys(settings?.ads ?? {}),
    ]);
    const sort = $("sort_sites").value;
    const score = (info) => sort === "size" ? info?.storage ?? 0
        : sort === "recent" ? Math.max(info?.visited ?? 0, info?.changed ?? 0) : 0;
    const found = [...names].filter((name) => name.includes(query)).sort((a, b) =>
        score(usage.get(b)) - score(usage.get(a)) || a.localeCompare(b));
    $("sites").replaceChildren(...found.map((name) => {
        const li = document.createElement("li");
        li.dataset.site = name;
        const row = Object.assign(document.createElement("button"), { type: "button", className: "site-row", disabled: state.busy });
        const parts = [];
        if (covering(name, settings?.blocked)) parts.push("Access blocked");
        const popup = override(settings?.popups, name);
        if (popup !== "default") parts.push({ ask: "Pop-ups ask first", block: "Pop-ups blocked", allow: "Pop-ups allowed" }[popup]);
        const media = override(settings?.media, name);
        if (media !== "default") parts.push({ block: "Videos and sound blocked", allow: "Videos and sound allowed", "no-autoplay": "No autoplay" }[media]);
        const ads = override(settings?.ads, name);
        if (ads !== "default") parts.push({ block: "Ads blocked", allow: "Ads allowed" }[ads]);
        parts.push(...siteDataSummary(usage.get(name)));
        row.append(Object.assign(document.createElement("span"), { className: "site", textContent: name }));
        if (parts.length) row.append(Object.assign(document.createElement("span"), { className: "detail", textContent: parts.join(" · ") }));
        row.addEventListener("click", () => openSite(name));
        li.append(row);
        return li;
    }));
    $("empty").hidden = found.length > 0 || (state.busy && !settings && !data);
    $("empty").textContent = query ? "No matching sites." : "No sites with saved settings or data.";
    $("storage_usage").hidden = !data?.storage;
    if (data?.storage) $("storage_usage").textContent = `${storageSize(data.storage.used)} of ${storageSize(data.storage.max)}`;
    $("open_site").disabled = state.busy || !$("filter").value.trim();
}

function renderSite() {
    if (!selected || !settings) return;
    const { host, site } = selected;
    const blocked = covering(host, settings.blocked);
    const info = data?.sites?.find((item) => item.site === site);
    $("site_heading").textContent = host;
    $("access").textContent = blocked ? "Unblock site" : "Block site";
    $("access").disabled = state.busy;
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
}

function render() {
    $("show_current").hidden = !current;
    const active = view === "site" && fromAllSites ? "all" : view;
    $("back_to_sites").hidden = !fromAllSites;
    for (const [name, [button, panel]] of Object.entries(views)) {
        $(panel).hidden = name !== view;
        if (name === active) $(button).setAttribute("aria-current", "true");
        else $(button).removeAttribute("aria-current");
    }
    renderSites();
    renderSite();
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
    if (focus) $({ all: "filter", site: "site_heading", browser: "browser_heading" }[name]).focus();
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

// confirmClear asks before clearing a site's data (name), or every site's
// for a time range ("").
function confirmClear(name) {
    pendingClear = name;
    $("clear_heading").textContent = name ? `Clear data for ${name}?` : "Clear browsing data?";
    $("clear_summary").textContent = name
        ? "This clears cookies and site data for this site. You may be signed out."
        : "This clears cookies and site data across sites for the selected time range. You may be signed out.";
    $("time_range").hidden = !!name;
    $("confirm_clear").returnValue = "";
    $("confirm_clear").showModal();
}
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
    const name = pendingClear;
    const within = Number($("within").value);
    run(async () => {
        data = await ask({ type: "go-cookies-forget", name, within: name ? 0 : within });
    }, name ? `Cleared site data for ${name}.` : "Cleared browsing data for the selected time range.");
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
