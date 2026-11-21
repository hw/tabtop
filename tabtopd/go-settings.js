// Settings (go/settings): the browser's own, the address bar's search
// engine, ad blocking and its filter lists (goadblock.go). Each site's,
// and the defaults for them all, are in Site controls (go/sites, go-sites.js).
import { setLoginTitle } from "../tabtop/requests.js";
import { $, ask, runner, told } from "./go-pages.js";

setLoginTitle("Settings");

let ads;
let searchEngine = "duckduckgo";
const state = runner(render);
const run = state.run;

function render() {
    renderSearch();
    renderAds();
}

function renderSearch() {
    $("search_engine").value = searchEngine;
    $("search_engine").disabled = state.busy;
}

// ago says how long ago a time (ms) was, roughly.
function ago(ms) {
    const minutes = Math.round((Date.now() - ms) / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    return `${Math.round(hours / 24)} days ago`;
}

const count = (n) => Number(n || 0).toLocaleString();
const many = (n, one, more = one + "s") => `${count(n)} ${Number(n) === 1 ? one : more}`;

function renderAds() {
    const busy = state.busy;
    $("adblock_on").checked = !!ads?.enabled;
    $("adblock_on").disabled = busy || !ads;
    const ticked = (ads?.lists ?? []).filter((l) => l.on);
    $("adblock_about").textContent = !ads ? ""
        : !ads.enabled ? "Off. Turning it on downloads the ticked filter lists, and blocks the sites they name for ads and tracking."
        : `${many(ads.rules, "rule")} in force, from ${ticked.filter((l) => l.had).length} of ${many(ticked.length, "ticked list")}.` +
            (ads.unsupported ? ` ${count(ads.unsupported)} more can't be used here (regular expressions, scripts run in pages, options that change requests).` : "") +
            " A page's own site is never blocked.";
    const rows = (ads?.lists ?? []).map((l) => {
        const li = document.createElement("li");
        li.dataset.list = l.id;
        const label = document.createElement("label");
        const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: l.on, disabled: busy });
        box.addEventListener("change", () => setAds(box.checked ? "list-on" : "list-off", { name: l.id }));
        const text = document.createElement("span");
        text.append(Object.assign(document.createElement("span"), { className: "name", textContent: l.name }));
        const detail = Object.assign(document.createElement("span"), { className: "detail" });
        detail.title = l.url;
        if (l.updating) detail.textContent = "Updating…";
        else if (l.error) {
            detail.textContent = l.error + (l.had && l.updated ? ` Using the copy from ${ago(l.updated)}.` : "");
            detail.classList.add("error");
        } else if (l.had) {
            detail.textContent = `${many(l.rules, "rule")}${l.unsupported ? ` (${count(l.unsupported)} not used yet)` : ""} · updated ${ago(l.updated)}`;
        }
        else detail.textContent = l.on && ads.enabled ? "Not downloaded yet" : "Not downloaded";
        text.append(detail);
        label.append(box, text);
        li.append(label);
        if (!l.builtIn) {
            const remove = Object.assign(document.createElement("button"), { type: "button", textContent: "Remove", disabled: busy });
            remove.setAttribute("aria-label", `Remove ${l.name}`);
            remove.addEventListener("click", () => {
                if (confirm(`Remove the list ${l.name}?`)) setAds("list-remove", { name: l.id }, "List removed.");
            });
            li.append(remove);
        }
        return li;
    });
    $("ad_lists").replaceChildren(...rows);
    $("ad_url").disabled = busy || !ads;
    $("ad_add_button").disabled = busy || !ads || !$("ad_url").value.trim();
    $("ad_interval").value = ads?.interval ?? "daily";
    $("ad_interval").disabled = busy || !ads;
    $("ad_update").disabled = busy || !ads?.enabled || ticked.length === 0;
    // My filters: as saved, unless being edited; the lines that can't be
    // used, by number.
    if (ads && !filtersEdited) $("my_filters").value = ads.filters ?? "";
    $("my_filters").disabled = busy || !ads;
    $("save_filters").disabled = busy || !ads || !filtersEdited;
    $("filter_problems").replaceChildren(...(ads?.filterProblems ?? []).map((p) => Object.assign(document.createElement("li"), {
        textContent: `Line ${p.line}, can't be used here (a regular expression, a script run in pages, or an option that changes requests): ${p.text}`,
    })));
}
let filtersEdited = false;

// setAds makes an ad blocking change; what's turned on that isn't had yet
// is downloaded first, which the reply says the outcome of.
function setAds(setting, extra = {}, done = "Setting saved.") {
    const slow = setting === "on" || setting === "list-on" || setting === "list-add";
    return run(async () => {
        if (slow) $("done").textContent = setting === "list-add" ? "Downloading the list…" : "Downloading filter lists…";
        ads = await ask({ type: "go-adblock-set", setting, ...extra });
        if (ads.error) throw new Error(ads.error);
    }, done);
}

$("search_engine").addEventListener("change", () => {
    const id = $("search_engine").value;
    run(async () => {
        const reply = await ask({ type: "go-settings-set", setting: "search-" + id });
        searchEngine = reply.searchEngine || id;
        told("search-changed");
    }, "Search engine saved.");
});
$("adblock_on").addEventListener("change", () => setAds($("adblock_on").checked ? "on" : "off", {},
    $("adblock_on").checked ? "Ad blocking is on." : "Ad blocking is off."));
$("ad_interval").addEventListener("change", () => setAds($("ad_interval").value));
$("ad_url").addEventListener("input", render);
$("ad_add").addEventListener("submit", (event) => {
    event.preventDefault();
    const url = $("ad_url").value.trim();
    if (!url) return;
    setAds("list-add", { url }, "List added.").then((ok) => {
        if (ok) $("ad_url").value = "";
        render();
    });
});
$("my_filters").addEventListener("input", () => {
    filtersEdited = true;
    $("save_filters").disabled = state.busy;
});
$("save_filters").addEventListener("click", () => run(async () => {
    ads = await ask({ type: "go-adblock-set", setting: "filters", filters: $("my_filters").value });
    filtersEdited = false;
}, "Filters saved."));
$("ad_update").addEventListener("click", () => run(async () => {
    $("done").textContent = "Updating filter lists…";
    ads = await ask({ type: "go-adblock-update" });
    if (ads.error) throw new Error(ads.error);
}, "Filter lists updated."));

async function load() {
    const [adblock, settings] = await Promise.all([ask({ type: "go-adblock" }), ask({ type: "go-settings" })]);
    ads = adblock;
    if (typeof settings?.searchEngine === "string" && $("search_engine").querySelector(`option[value="${CSS.escape(settings.searchEngine)}"]`)) {
        searchEngine = settings.searchEngine;
    }
}
run(load);
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && ads) run(load);
});
