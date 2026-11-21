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
// All sites' selection (Select): whether it's on, the sites selected, and
// those listed (what Select all selects).
let selecting = false;
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
const themeLabel = { auto: "Follow device", light: "Light", dark: "Dark" };

// siteHasData is whether a site keeps cookies or localStorage: what Clear
// data clears.
function siteHasData(name) {
    const info = data?.sites?.find((item) => item.site === name);
    return !!(info?.cookies || info?.storageItems);
}

// The selection bar, while selecting: how many are selected, Select all
// (or none), and what can be done to them, each with how many it's for
// (Clear data: those with data; Delete settings: those with settings).
function renderSelection() {
    $("selection_bar").hidden = !selecting;
    $("select_sites").hidden = selecting;
    $("select_sites").disabled = state.busy || !listedSites.length;
    const names = [...checked];
    const n = names.length;
    $("selection_count").textContent = n ? `${n} selected` : "Select sites";
    const all = listedSites.length > 0 && listedSites.every((name) => checked.has(name));
    $("select_all").textContent = all ? "Select none" : "Select all";
    $("select_all").disabled = state.busy || !listedSites.length;
    const withData = names.filter(siteHasData).length, withSettings = names.filter(savedUnder).length;
    $("clear_selected").textContent = withData ? `Clear data (${withData})…` : "Clear data…";
    $("clear_selected").disabled = state.busy || !withData;
    $("forget_selected").textContent = withSettings ? `Delete settings (${withSettings})…` : "Delete settings…";
    $("forget_selected").disabled = state.busy || !withSettings;
    $("clear_selection").disabled = state.busy;
}

// select starts (or, false, ends) selecting: rows become toggles.
function select(on, first) {
    selecting = on;
    if (!on) checked.clear();
    if (first) checked.add(first);
    renderSites();
    (on ? $("selection_bar").querySelector("button:not(:disabled)") : $("select_sites"))?.focus();
}

// ago says how long ago a time (unix ms) was, briefly ("3 h ago").
function ago(ms) {
    const s = (Date.now() - ms) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
    return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: s > 300 * 86400 ? "numeric" : undefined });
}

// What a site has of its own: its settings as chips (a block marked), and
// whether its block, or its permissions, differ from the defaults.
function siteState(name) {
    const chips = [];
    const blocked = covering(name, settings?.blocked);
    if (blocked) chips.push(["Blocked", true]);
    const videoHost = !!settings?.videoHosts?.includes(name);
    if (videoHost) chips.push(["Its videos blocked", true]);
    const popup = override(settings?.popups, name);
    if (popup !== "default") chips.push([{ ask: "Pop-ups: ask", block: "Pop-ups: blocked", allow: "Pop-ups: allowed" }[popup]]);
    const media = override(settings?.media, name);
    if (media !== "default") chips.push([{ block: "Videos: blocked", allow: "Videos: allowed", "no-autoplay": "No autoplay" }[media]]);
    const ads = override(settings?.ads, name);
    if (ads !== "default") chips.push([{ block: "Ads: blocked", allow: "Ads: allowed" }[ads]]);
    const theme = override(settings?.theme, name);
    if (theme !== "default") chips.push([{ auto: "Dark mode: device", light: "Dark mode: light", dark: "Dark mode: dark" }[theme]]);
    return { chips, blocked, custom: popup !== "default" || media !== "default" || ads !== "default" || theme !== "default" || videoHost };
}

let siteFilter = "all";

function renderSites() {
    const query = $("filter").value.trim().toLowerCase()
        .replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/, 1)[0];
    const usage = new Map((data?.sites ?? []).map((info) => [info.site, info]));
    const names = new Set([
        ...usage.keys(), ...(settings?.blocked ?? []), ...Object.keys(settings?.media ?? {}),
        ...Object.keys(settings?.popups ?? {}), ...Object.keys(settings?.ads ?? {}), ...(settings?.videoHosts ?? []),
        ...Object.keys(settings?.theme ?? {}),
    ]);
    const hasData = (name) => !!(usage.get(name)?.cookies || usage.get(name)?.storageItems);
    const when = (name) => Math.max(usage.get(name)?.visited ?? 0, usage.get(name)?.changed ?? 0);
    const sort = $("sort_sites").value;
    const score = (name) => sort === "size" ? usage.get(name)?.storage ?? 0 : sort === "recent" ? when(name) : 0;
    // Found by the search: a site named so, or one that covers the host
    // typed (example.io's settings hold for tracker.example.io).
    const covers = (name) => !!query && query.endsWith("." + name);
    const shows = { all: () => true, data: hasData, blocked: (name) => !!siteState(name).blocked || !!settings?.videoHosts?.includes(name), custom: (name) => siteState(name).custom };
    const found = [...names].filter((name) => (name.includes(query) || covers(name)) && shows[siteFilter](name))
        .sort((a, b) => score(b) - score(a) || a.localeCompare(b));
    listedSites = found;
    for (const name of [...checked]) {
        if (!names.has(name)) checked.delete(name);
    }
    $("sites").classList.toggle("selecting", selecting);
    closeRowMenu();
    $("sites").replaceChildren(...found.map((name) => {
        const li = document.createElement("li");
        li.dataset.site = name;
        const { chips } = siteState(name);
        const row = Object.assign(document.createElement("button"), { type: "button", className: "site-row", disabled: state.busy });
        row.append(Object.assign(document.createElement("span"), { className: "site", textContent: name }));
        if (covers(name)) row.append(Object.assign(document.createElement("span"), { className: "hint", textContent: `Includes ${query}` }));
        if (chips.length) {
            const list = Object.assign(document.createElement("span"), { className: "chips" });
            list.append(...chips.map(([text, blocked]) => Object.assign(document.createElement("span"), { className: blocked ? "chip blocked" : "chip", textContent: text })));
            row.append(list);
        }
        const detail = [...siteDataSummary(usage.get(name)), ...(when(name) ? [ago(when(name))] : [])];
        if (detail.length) row.append(Object.assign(document.createElement("span"), { className: "detail", textContent: detail.join(" · ") }));
        const chev = Object.assign(document.createElement("span"), { className: "chev" });
        chev.setAttribute("aria-hidden", "true");
        row.append(chev);
        // Selecting: a toggle, its state its border (and said: pressed).
        // Otherwise it opens the site; Ctrl or ⌘ and a click starts
        // selecting with it.
        if (selecting) row.setAttribute("aria-pressed", String(checked.has(name)));
        row.addEventListener("click", (event) => {
            if (selecting) {
                if (checked.has(name)) checked.delete(name);
                else checked.add(name);
                row.setAttribute("aria-pressed", String(checked.has(name)));
                renderSelection();
            } else if (event.ctrlKey || event.metaKey) {
                select(true, name);
                $("sites").querySelector(`li[data-site="${CSS.escape(name)}"] .site-row`)?.focus();
            } else openSite(name);
        });
        const more = Object.assign(document.createElement("button"), { type: "button", className: "row-more", textContent: "⋯", disabled: state.busy });
        more.setAttribute("aria-label", `More for ${name}`);
        more.setAttribute("aria-haspopup", "menu");
        more.setAttribute("aria-expanded", "false");
        more.addEventListener("click", (event) => { event.stopPropagation(); openRowMenu(more, name, hasData(name)); });
        li.append(row, more);
        return li;
    }));
    // A site typed that isn't listed, nor covered by one that is: offered,
    // first, to open (its settings and data), as Enter does.
    const typed = /^([a-z0-9-]+\.)+[a-z0-9-]{2,}$|^\d{1,3}(\.\d{1,3}){3}$/.test(query) && !names.has(query) && ![...names].some(covers);
    if (typed) {
        const li = Object.assign(document.createElement("li"), { className: "open-row" });
        const row = Object.assign(document.createElement("button"), { type: "button", className: "site-row", disabled: state.busy });
        row.append(Object.assign(document.createElement("span"), { className: "site", textContent: `Open settings for ${query}` }),
            Object.assign(document.createElement("span"), { className: "hint", textContent: "No saved settings or data yet" }));
        row.addEventListener("click", () => openSite($("filter").value.trim()));
        li.append(row);
        $("sites").prepend(li);
    }
    const total = names.size;
    $("site_count").textContent = !settings && !data ? "" : found.length === total ? `${total} site${total === 1 ? "" : "s"}` : `${found.length} of ${total} sites`;
    for (const b of document.querySelectorAll(".filters button")) {
        b.setAttribute("aria-pressed", String(b.dataset.filter === siteFilter));
        b.disabled = state.busy;
    }
    $("empty").hidden = found.length > 0 || typed || (state.busy && !settings && !data);
    $("empty").textContent = query || siteFilter !== "all" ? "No matching sites." : "No sites with saved settings or data.";
    $("storage_usage").hidden = !data?.storage;
    if (data?.storage) {
        const { used, max } = data.storage;
        $("storage_text").textContent = `${storageSize(used)} of ${storageSize(max)}`;
        $("storage_fill").style.width = `${Math.min(100, 100 * used / max)}%`;
    }
    renderSelection();
}

// A row's ⋯: its quick actions, those that apply (open it; clear its data;
// unblock it; its permissions back to the defaults), in a menu by it.
let rowMenuFor = null;
function closeRowMenu(focus = false) {
    if (!rowMenuFor) return;
    $("row_menu").hidden = true;
    rowMenuFor.setAttribute("aria-expanded", "false");
    if (focus && rowMenuFor.isConnected) rowMenuFor.focus();
    rowMenuFor = null;
}
function openRowMenu(button, name, hasData) {
    if (rowMenuFor === button) return closeRowMenu(true);
    closeRowMenu();
    const { blocked, custom } = siteState(name);
    const items = [["Open site settings", () => openSite(name)]];
    if (hasData) items.push(["Clear data…", () => confirmClear([name]), true]);
    if (blocked) items.push([blocked === name ? "Unblock" : `Unblock ${blocked}`, () => {
        if (blocked !== name && !confirm(`Remove the access block for ${blocked} and its subdomains?`)) return;
        set(blocked, "unblock", `Unblocked ${blocked}.`);
    }]);
    if (custom) items.push(["Reset permissions", () => resetSite(name)]);
    if (savedUnder(name)) items.push(["Delete settings…", () => forgetSettings([name], name, name), true]);
    const menu = $("row_menu");
    menu.replaceChildren(...items.map(([text, act, danger]) => {
        const item = Object.assign(document.createElement("button"), { type: "button", textContent: text, className: danger ? "danger" : "" });
        item.setAttribute("role", "menuitem");
        item.addEventListener("click", () => { closeRowMenu(); act(); });
        return item;
    }));
    menu.setAttribute("aria-label", `Actions for ${name}`);
    menu.hidden = false;
    // By the button, its right edge with the button's (on the page: the
    // menu's positioned against it).
    const b = button.getBoundingClientRect();
    menu.style.left = `${Math.max(8, b.right - menu.offsetWidth) + scrollX}px`;
    menu.style.top = `${b.bottom + 4 + scrollY}px`;
    button.setAttribute("aria-expanded", "true");
    rowMenuFor = button;
    menu.querySelector("button").focus();
}
$("row_menu").addEventListener("keydown", (event) => {
    const items = [...$("row_menu").querySelectorAll("button")];
    const at = items.indexOf(document.activeElement);
    if (event.key === "Escape") { event.preventDefault(); closeRowMenu(true); }
    else if (event.key === "ArrowDown") { event.preventDefault(); items[(at + 1) % items.length].focus(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); items[(at - 1 + items.length) % items.length].focus(); }
    else if (event.key === "Tab") closeRowMenu();
});
document.addEventListener("click", (event) => {
    if (rowMenuFor && !$("row_menu").contains(event.target)) closeRowMenu();
});

// savedUnder is whether any setting is kept under name: its block, its
// pop-ups, videos or ads, or its videos blocked by host.
function savedUnder(name) {
    return !!(settings?.blocked?.includes(name) || settings?.videoHosts?.includes(name) ||
        [settings?.popups, settings?.media, settings?.ads, settings?.theme].some((map) => map && Object.hasOwn(map, name)));
}

// forgetSettings deletes all the settings kept under names (a site's, and
// the host's it was opened as), asked first: the browser's defaults hold
// for it after; its cookies and data stay (Clear data's).
function forgetSettings(names, label, host = label) {
    names = [...new Set(names)].filter(savedUnder);
    if (!names.length) return;
    const over = host && covering(host, settings?.blocked);
    const parent = over && !names.includes(over) ? ` The block for ${over}, which covers it, stays.` : "";
    const its = names.length > 1 && !host ? "Their" : "Its";
    if (!confirm(`Delete all saved settings for ${label}? ${its} block, pop-ups, videos and sound, Dark mode, and ads go back to the browser's defaults. ${its} cookies and site data are kept.${parent}`)) return;
    return run(async () => {
        for (const name of names) {
            settings = await ask({ type: "go-settings-set", name, setting: "forget" });
            if (!siteHasData(name)) checked.delete(name);  // (gone from the list)
        }
        told("media-changed");
        told("theme-changed");
    }, `Deleted the saved settings for ${label}.`);
}

// resetSite puts a site's permissions back to the browser's defaults:
// pop-ups, videos and sound, ads, and its videos blocked by host. (Its
// access block, and its data, are their own to change.)
function resetSite(site, host = site) {
    return run(async () => {
        for (const setting of ["popups-default", "videos-default", "ads-default", "theme-default"]) settings = await ask({ type: "go-settings-set", name: site, setting });
        if (settings.videoHosts?.includes(host)) settings = await ask({ type: "go-settings-set", name: host, setting: "videos-host-allow" });
        told("media-changed");
        told("theme-changed");
    }, `${site}'s permissions are back to the browser's defaults.`);
}

// The page's own: secure (https) or not, as the browser said opening
// Site controls (?secure); and its icon, when the browser sends it.
const pageSecure = new URLSearchParams(location.search).get("secure");
let siteIcon = null;  // {host, url}

// What a site's settings are, each: its value here, its default, and how
// each's said. (Kinds: what go-settings-set takes, popups-…, …)
const kinds = {
    popups: { map: "popups", label: (v) => policyLabel[v], def: () => settings.popupDefault ?? "ask", name: "Pop-ups" },
    videos: { map: "media", label: (v) => policyLabel[v], def: () => settings.mediaDefault ?? "allow", name: "Videos and sound" },
    theme: { map: "theme", label: (v) => themeLabel[v], def: () => settings.themeDefault ?? "auto", name: "Dark mode" },
    ads: { map: "ads", label: (v) => policyLabel[v], def: () => (settings.adblock ? "block" : "allow"), name: "Ads and trackers" },
};

// openSettingsPage opens Settings (ad blocking): in the lightbox, the
// browser's; else here.
function openSettingsPage() {
    if (window.parent !== window) told("open-settings");
    else location.href = "settings";
}

function renderSite() {
    if (!selected || !settings) return;
    const { host, site } = selected;
    const blocked = covering(host, settings.blocked);
    const info = data?.sites?.find((item) => item.site === site);
    $("site_heading").textContent = host;
    // Its icon, or its initial.
    const icon = $("site_icon");
    if (siteIcon?.host === host) {
        if (icon.querySelector("img")?.src !== siteIcon.url) {
            const img = Object.assign(document.createElement("img"), { src: siteIcon.url, alt: "" });
            img.addEventListener("error", () => { siteIcon = null; renderSite(); }, { once: true });  // (not a picture: its initial)
            icon.replaceChildren(img);
        }
    } else icon.textContent = (host.replace(/^www\./, "")[0] ?? "?").toUpperCase();
    // What its settings cover, once; and, the page shown's, if it's secure.
    const scope = $("site_scope");
    scope.replaceChildren(site === host ? "Settings include its subdomains" : `Settings apply to ${site} and its subdomains`);
    if (current && host === current.host && (pageSecure === "1" || pageSecure === "0")) {
        scope.append(Object.assign(document.createElement("span"), pageSecure === "1"
            ? { className: "badge secure", textContent: "Secure" }
            : { className: "badge insecure", textContent: "Not secure", title: "The page isn't loaded over HTTPS: what's sent to it, or shown, can be read or changed on the way." }));
    }
    // Access: blocked, by its rule or a domain's over it.
    $("access").textContent = blocked ? "Unblock site" : "Block site";
    $("access").classList.toggle("danger", !blocked);
    $("access").classList.toggle("safe", !!blocked);
    $("access").disabled = state.busy;
    $("access_note").textContent = blocked && blocked !== host ? `Blocked by the rule for ${blocked}.`
        : blocked ? "Blocked: it and its subdomains don't load." : "Allowed";
    $("video_host_row").hidden = !settings.videoHosts?.includes(host);
    $("video_host").disabled = state.busy;
    // Each setting: its control showing what applies (the default, said
    // as it is); changed, marked, its default said, ↺ to put it back.
    for (const [kind, k] of Object.entries(kinds)) {
        const select = $(kind === "popups" ? "popups" : kind);
        const value = override(settings[k.map], site);
        select.value = value;
        select.disabled = state.busy;
        select.querySelector('option[value="default"]').textContent = `Default (${k.label(k.def())})`;
        const row = select.closest(".setting");
        row.classList.toggle("changed", value !== "default");
        const undo = row.querySelector(".undo");
        undo.hidden = value === "default";
        undo.disabled = state.busy;
        undo.title = `Back to the default (${k.label(k.def())})`;
        undo.setAttribute("aria-label", `${k.name}: back to the default, ${k.label(k.def())}`);
        const note = $({ popups: "popup_scope", videos: "video_note", theme: "theme_note", ads: "ads_note" }[kind]);
        note.replaceChildren(value === "default" ? "" : Object.assign(document.createElement("span"), { className: "changed-note", textContent: `Changed · default: ${k.label(k.def())}` }));
    }
    // Ads: blocked by site, from the filter lists in Settings (ad blocking,
    // on or off there, is the default): said, with Settings a link.
    const settingsLink = () => {
        const b = Object.assign(document.createElement("button"), { type: "button", className: "link", textContent: "Settings" });
        b.addEventListener("click", openSettingsPage);
        return b;
    };
    const adsNote = $("ads_note");
    if ($("ads").value === "default") adsNote.append(`Ad blocking in `, settingsLink(), ` is ${settings.adblock ? "on" : "off"}.`);
    else if ($("ads").value === "block" && !settings.adblock) adsNote.append(" · ", "Uses the filter lists ticked in ", settingsLink(), ".");
    // Its data: each count opens the inspector at it; when it changed.
    const dataNote = $("site_data");
    dataNote.replaceChildren();
    const link = (text, tab) => {
        const b = Object.assign(document.createElement("button"), { type: "button", className: "link", textContent: text, disabled: state.busy });
        b.addEventListener("click", () => openInspector(tab));
        return b;
    };
    const parts = [];
    if (info?.cookies) parts.push(link(`${info.cookies} cookie${info.cookies === 1 ? "" : "s"}`, "cookies"));
    if (info?.storageItems) parts.push(link(`${storageSize(info.storage ?? 0)} in ${info.storageItems} item${info.storageItems === 1 ? "" : "s"}`, "storage"));
    if (info?.open) parts.push("Used by an open tab");
    if (info?.changed) parts.push(`changed ${ago(info.changed)}`);
    if (!parts.length) parts.push(data ? "No site data." : "Site data unavailable.");
    parts.forEach((p, i) => dataNote.append(...(i ? [" · ", p] : [p])));
    $("clear_site").disabled = state.busy || !info?.cookies && !info?.storageItems;
    $("inspect_site").disabled = state.busy || !info?.cookies && !info?.storageItems;
    // Reset: what's changed of it, back to the defaults (asked: the list).
    const changes = resetChanges();
    $("reset_site").disabled = state.busy || !changes.list.length && !changes.unblock;
    $("reset_note").textContent = changes.list.length || changes.unblock
        ? `${changes.list.length + (changes.unblock ? 1 : 0)} changed from the browser's defaults.`
        : "Nothing changed: the browser's defaults apply.";
}

// resetChanges is what Reset would put back for the site shown: each
// setting changed ("Pop-ups: Allow → Ask"), and its own block, if it has
// one (asked about apart: unblocking it is a choice of its own).
function resetChanges() {
    const { host, site } = selected;
    const list = [];
    for (const k of Object.values(kinds)) {
        const value = override(settings[k.map], site);
        if (value !== "default") list.push(`${k.name}: ${k.label(value)} → ${k.label(k.def())}`);
    }
    if (settings.videoHosts?.includes(host)) list.push("Videos from this host: blocked → allowed");
    const blocked = covering(host, settings.blocked);
    return { list, unblock: blocked === host || blocked === site ? blocked : null };
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
    $("default_theme").value = settings?.themeDefault ?? "auto";
    $("default_theme").disabled = busy || !settings;
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

// set saves a setting; said, where it's a site's (pop-ups, videos, ads)
// set from one of its hosts, to hold for the site and its subdomains.
// Where a change holds only for what loads next (pop-ups, ads, a block),
// made for the page shown in the browser (Site controls over it): Reload
// page, by what's said.
function set(name, setting, done = selected && selected.site !== selected.host && name === selected.site && /^(popups|videos|ads|theme)-/.test(setting)
    ? `Saved for ${selected.site} and its subdomains.` : "Setting saved.") {
    const pageShown = window.parent !== window && current && selected && selected.host === current.host && view !== "all";
    if (pageShown && /^(popups-|ads-|block$|unblock$)/.test(setting) && typeof done === "string") {
        done = { text: done, action: { label: "Reload page", run: () => told("reload") } };
    }
    return run(async () => {
        settings = await ask({ type: "go-settings-set", name, setting });
        if (setting.startsWith("videos-")) told("media-changed");
        if (setting.startsWith("theme-")) told("theme-changed");
    }, done);
}

// openInspector shows the site's data, at its cookies or its storage.
async function openInspector(tab = "cookies") {
    inspected = null;
    opened.clear();
    inspectTab = tab;
    $("inspect_filter").value = "";
    show("inspect", true);
    await inspect();
}
$("inspect_site").addEventListener("click", () => openInspector());
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
    // Blocking cuts it off at once (the page shown too): asked first.
    if (!blocked && !confirm(`Block ${host}? Its pages, and anything other sites load from it, won't load, until it's unblocked.`)) return;
    set(blocked ?? host, blocked ? "unblock" : "block", blocked ? `Unblocked ${blocked}.` : `Blocked ${host}.`);
});
$("popups").addEventListener("change", () => set(selected.site, "popups-" + $("popups").value));
$("videos").addEventListener("change", () => set(selected.site, "videos-" + $("videos").value));
$("ads").addEventListener("change", () => set(selected.site, "ads-" + $("ads").value));
$("default_popups").addEventListener("change", () => set("", "popups-" + $("default_popups").value));
$("default_videos").addEventListener("change", () => set("", "videos-" + $("default_videos").value));
$("default_theme").addEventListener("change", () => set("", "theme-" + $("default_theme").value));
$("theme").addEventListener("change", () => set(selected.site, "theme-" + $("theme").value));
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
$("select_sites").addEventListener("click", () => select(true));
$("select_all").addEventListener("click", () => {
    const all = listedSites.every((name) => checked.has(name));
    for (const name of listedSites) all ? checked.delete(name) : checked.add(name);
    renderSites();
});
$("forget_selected").addEventListener("click", () => {
    const names = [...checked].filter(savedUnder);
    if (names.length) forgetSettings(names, names.length === 1 ? names[0] : `${names.length} sites`, names.length === 1 ? names[0] : null);
});
// Esc ends selecting (not while a dialog, or a row's menu, has it).
document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !selecting || rowMenuFor || document.querySelector("dialog[open]")) return;
    event.preventDefault();
    select(false);
});
// A setting's ↺: it alone back to the default.
for (const undo of document.querySelectorAll("#site_settings .undo")) {
    undo.addEventListener("click", () => set(selected.site, `${undo.dataset.reset}-default`, `${kinds[undo.dataset.reset].name}: back to the default.`));
}
// Reset…: what'll change, listed, and its own block (if any) a choice of
// its own; then all at once.
$("reset_site").addEventListener("click", () => {
    const { list, unblock } = resetChanges();
    $("reset_heading").textContent = `Reset settings for ${selected.host}?`;
    $("reset_list").replaceChildren(...list.map((text) => Object.assign(document.createElement("li"), { textContent: text })));
    $("reset_list").hidden = !list.length;
    $("reset_unblock_row").hidden = !unblock;
    $("reset_unblock").checked = !list.length;
    $("reset_unblock_label").textContent = unblock ? `Also unblock ${unblock}` : "";
    $("confirm_reset").returnValue = "";
    $("confirm_reset").showModal();
});
$("confirm_reset").addEventListener("close", () => {
    if ($("confirm_reset").returnValue !== "reset") return;
    const { host, site } = selected;
    const { unblock } = resetChanges();
    const alsoUnblock = !!unblock && $("reset_unblock").checked;
    run(async () => {
        for (const setting of ["popups-default", "videos-default", "ads-default", "theme-default"]) settings = await ask({ type: "go-settings-set", name: site, setting });
        if (settings.videoHosts?.includes(host)) settings = await ask({ type: "go-settings-set", name: host, setting: "videos-host-allow" });
        if (alsoUnblock) settings = await ask({ type: "go-settings-set", name: unblock, setting: "unblock" });
        told("media-changed");
        told("theme-changed");
    }, alsoUnblock ? `${host}: settings reset, and unblocked.` : `${host}: settings reset to the browser's defaults.`);
});
// The site's icon, from the browser (the lightbox's): shown by its name.
window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.origin !== location.origin || !(event.data?.goSiteIcon instanceof Blob)) return;
    if (siteIcon) URL.revokeObjectURL(siteIcon.url);
    siteIcon = { host: event.data.host, url: URL.createObjectURL(event.data.goSiteIcon) };
    renderSite();
});
for (const b of document.querySelectorAll(".filters button")) {
    b.addEventListener("click", () => { siteFilter = b.dataset.filter; renderSites(); });
}
$("clear_selection").addEventListener("click", () => select(false));
$("clear_selected").addEventListener("click", () => {
    const names = [...checked].filter(siteHasData);
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
