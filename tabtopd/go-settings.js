// Settings (go/settings): the browser's own, in sections: Search (the
// address bar's engine), Network (DNS over HTTPS, godoh.go; local DNS
// records, gohosts.go), Ad blocking (goadblock.go: on or off, its filter
// lists, the person's own filters) and Backup (all of them, as a file).
// Each site's, and the defaults for them all, are in Site controls
// (go/sites, go-sites.js).
import { setLoginTitle } from "../tabtop/requests.js";
import { $, ask, runner, say, told } from "./go-pages.js";
import { addrProblem, byName, hostNameProblem, hostsText, kindOf, parseHosts, searchTemplateProblem } from "./go-settings-parse.js";

setLoginTitle("Settings");

let ads;
let searchEngine = "duckduckgo", searchURL = "", searchPicked = null;
// DNS over HTTPS (godoh.go): "off", "cloudflare", "quad9" or "custom" (dohURL);
// dohStatus: when it last answered, or why it didn't ({ok, error, at}).
let doh = "off", dohURL = "", dohPicked = null, dohStatus = null;
// Local DNS records (gohosts.go): [{name, addr}], null till loaded; the
// one being edited (in the form), if any.
let hosts = null, editing = null;
let filtersEdited = false;
const state = runner(render);
const run = state.run;

function render() {
    renderSearch();
    renderDoH();
    renderHosts();
    renderAds();
    renderBackup();
}

// --- Sections: jumped to by the buttons at the top (not links: a
// fragment would be an entry in the lightbox frame's history).
for (const b of document.querySelectorAll("#jump button")) {
    b.addEventListener("click", () => {
        const to = $(b.dataset.to);
        to.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
        to.focus({ preventScroll: true });
    });
}

// --- Search ------------------------------------------------------------------

function renderSearch() {
    const shown = searchPicked ?? searchEngine;
    $("search_engine").value = shown;
    $("search_engine").disabled = state.busy;
    $("search_custom").hidden = shown !== "custom";
    $("search_url").disabled = state.busy;
    $("search_save").disabled = state.busy || !$("search_url").value.trim() || searchEngine === "custom" && $("search_url").value.trim() === searchURL;
}

function setSearch(id, url = "") {
    return run(async () => {
        let reply;
        try {
            reply = await ask({ type: "go-settings-set", setting: "search-" + id, url });
        } catch (err) {
            if (id === "custom") fieldError("search_url", "search_error", err.message);  // (by the field, kept open)
            throw err;
        }
        searchEngine = reply.searchEngine || id;
        searchURL = reply.searchURL ?? "";
        if (searchURL) $("search_url").value = searchURL;
        searchPicked = null;
        told("search-changed");
    }, "Search engine saved.").then((ok) => {
        if (!ok && id !== "custom") searchPicked = null;
        render();
        return ok;
    });
}

$("search_engine").addEventListener("change", () => {
    const id = $("search_engine").value;
    if (id === "custom") {
        searchPicked = "custom"; // (its address first)
        render();
        $("search_url").focus();
        return;
    }
    setSearch(id);
});
$("search_url").addEventListener("input", () => {
    fieldError("search_url", "search_error", "");
    render();
});
$("search_custom").addEventListener("submit", (event) => {
    event.preventDefault();
    const url = $("search_url").value.trim();
    const why = searchTemplateProblem(url);
    if (why) return fieldError("search_url", "search_error", why);
    setSearch("custom", url);
});

// --- DNS over HTTPS ------------------------------------------------------------

function renderDoH() {
    const busy = state.busy;
    // (Custom picked, its address not given yet: shown as picked.)
    const shown = dohPicked ?? doh;
    $("doh").value = shown;
    $("doh").disabled = busy;
    $("doh_custom").hidden = shown !== "custom";
    $("doh_url").disabled = busy;
    $("doh_save").disabled = busy || !$("doh_url").value.trim() || doh === "custom" && $("doh_url").value.trim() === dohURL;
    $("doh_status").hidden = doh === "off";
    $("doh_test").disabled = busy || doh === "off";
    const state_ = $("doh_state");
    const name = doh === "custom" ? dohURL : $("doh").querySelector(`option[value="${doh}"]`)?.textContent;
    state_.className = "hint";
    if (doh === "off") state_.textContent = "";
    else if (dohStatus?.error && (!dohStatus.ok || dohStatus.errorAt > dohStatus.ok)) {
        state_.textContent = `In use: ${name}. Last lookup failed ${ago(dohStatus.errorAt)}: ${dohStatus.error}`;
        state_.classList.add("error");
    } else if (dohStatus?.ok) {
        state_.textContent = `In use: ${name}. Last answered ${ago(dohStatus.ok)}.`;
        state_.classList.add("ok");
    } else state_.textContent = `In use: ${name}.`;
}

// setDoH chooses DNS over HTTPS; a server's taken once it's answered.
function setDoH(mode, url = "") {
    return run(async () => {
        if (mode !== "off") say("Asking the DNS over HTTPS service…");
        let reply;
        try {
            reply = await ask({ type: "go-settings-set", setting: "doh-" + mode, url });
        } catch (err) {
            if (mode === "custom") fieldError("doh_url", "doh_error", err.message);  // (by the field, kept open)
            throw err;
        }
        doh = reply.doh ?? mode;
        dohURL = reply.dohURL ?? "";
        dohStatus = reply.dohStatus ?? null;
        if (dohURL) $("doh_url").value = dohURL;  // (filled as it's had, not as it's typed: it can be emptied)
        dohPicked = null;
    }, mode === "off" ? "DNS over HTTPS is off." : "DNS over HTTPS is on.").then((ok) => {
        if (ok || mode !== "custom") fieldError("doh_url", "doh_error", "");
        if (!ok && mode !== "custom") dohPicked = null;
        render();
        return ok;
    });
}

$("doh").addEventListener("change", () => {
    const mode = $("doh").value;
    if (mode === "custom") {
        // Its address first.
        dohPicked = "custom";
        render();
        $("doh_url").focus();
        return;
    }
    setDoH(mode);
});
$("doh_url").addEventListener("input", () => {
    fieldError("doh_url", "doh_error", "");
    render();
});
$("doh_custom").addEventListener("submit", (event) => {
    event.preventDefault();
    const url = $("doh_url").value.trim();
    if (url) setDoH("custom", url);
});
$("doh_test").addEventListener("click", () => run(async () => {
    say("Asking the DNS over HTTPS service…");
    const reply = await ask({ type: "go-settings-set", setting: "doh-test" });
    dohStatus = reply.dohStatus ?? null;
    if (reply.dohTest) throw new Error(reply.dohTest);
}, "The DNS over HTTPS service answered."));

// --- Local DNS records -------------------------------------------------------

// fieldError shows why a field's value isn't one (or clears it).
function fieldError(input, note, why) {
    $(input).setAttribute("aria-invalid", why ? "true" : "false");
    $(note).textContent = why;
    $(note).hidden = !why;
    if (why) $(input).focus();
}

let hostsShown = "";  // what the list was drawn from (not drawn again for every keystroke)
function renderHosts() {
    const busy = state.busy || !hosts;
    const key = JSON.stringify([hosts, busy, editing]);
    if (key !== hostsShown) {
        hostsShown = key;
        $("host_list").replaceChildren(...byName(hosts ?? []).map(({ name, addrs }) => {
            const li = document.createElement("li");
            if (editing?.name === name) li.classList.add("editing");
            const rows = document.createElement("div");
            rows.className = "addrs";
            for (const addr of addrs) {
                const row = document.createElement("div");
                row.className = "addr-row";
                // (Its word, or on a narrow screen its glyph, for room.)
                const button = (word, glyph, label) => {
                    const b = Object.assign(document.createElement("button"), { type: "button", disabled: busy, className: "quiet", title: label });
                    b.setAttribute("aria-label", label);
                    b.append(Object.assign(document.createElement("span"), { className: "word", textContent: word }),
                        Object.assign(document.createElement("span"), { className: "glyph", textContent: glyph }));
                    return b;
                };
                const edit = button("Edit", "✎", `Edit ${name} ${addr}`);
                edit.addEventListener("click", () => startEdit({ name, addr }));
                const remove = button("Remove", "✕", `Remove ${name} ${addr}`);
                remove.addEventListener("click", () => setHosts(hosts.filter((h) => !(h.name === name && h.addr === addr)), "Record removed."));
                row.append(
                    Object.assign(document.createElement("span"), { className: "kind", textContent: kindOf(addr) }),
                    Object.assign(document.createElement("span"), { className: "addr", textContent: addr }),
                    edit, remove);
                rows.append(row);
            }
            li.append(Object.assign(document.createElement("span"), { className: "name", textContent: name }), rows);
            return li;
        }));
    }
    $("host_name").disabled = $("host_addr").disabled = busy;
    $("host_add_button").textContent = editing ? "Save record" : "Add record";
    $("host_add_button").disabled = busy || !$("host_name").value.trim() || !$("host_addr").value.trim();
    $("host_cancel").hidden = !editing;
    $("hosts_paste").disabled = busy;
    $("hosts_copy").disabled = busy || !hosts?.length;
}

function startEdit(record) {
    editing = record;
    $("host_name").value = record.name;
    $("host_addr").value = record.addr;
    fieldError("host_name", "host_name_error", "");
    fieldError("host_addr", "host_addr_error", "");
    render();
    $("host_addr").focus();
}

function stopEdit() {
    editing = null;
    $("host_name").value = $("host_addr").value = "";
    fieldError("host_name", "host_name_error", "");
    fieldError("host_addr", "host_addr_error", "");
    render();
}

// setHosts keeps the local records, all of them (the server checks each).
function setHosts(list, done) {
    return run(async () => {
        const reply = await ask({ type: "go-settings-set", setting: "hosts", hosts: list });
        hosts = Array.isArray(reply.hosts) ? reply.hosts : [];
    }, done);
}

for (const [input, note, problem] of [["host_name", "host_name_error", hostNameProblem], ["host_addr", "host_addr_error", addrProblem]]) {
    // What's wrong said once the field's left (or as it's put right).
    $(input).addEventListener("input", () => {
        if ($(input).getAttribute("aria-invalid") === "true" && !problem($(input).value)) fieldError(input, note, "");
        render();
    });
    $(input).addEventListener("blur", () => {
        if ($(input).value.trim()) {
            const why = problem($(input).value);
            $(input).setAttribute("aria-invalid", why ? "true" : "false");
            $(note).textContent = why;
            $(note).hidden = !why;
        }
    });
}
$("host_add").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = $("host_name").value.trim(), addr = $("host_addr").value.trim();
    if (!hosts) return;
    const nameWhy = hostNameProblem(name), addrWhy = addrProblem(addr);
    if (addrWhy) fieldError("host_addr", "host_addr_error", addrWhy);
    if (nameWhy) fieldError("host_name", "host_name_error", nameWhy);
    if (nameWhy || addrWhy) return;
    const list = editing ? hosts.map((h) => (h.name === editing.name && h.addr === editing.addr ? { name, addr } : h)) : [...hosts, { name, addr }];
    setHosts(list, editing ? "Record saved." : "Record added.").then((ok) => {
        if (ok) stopEdit();
    });
});
$("host_cancel").addEventListener("click", stopEdit);

// Hosts lines pasted: read, what can't be said, the rest added.
const hostsDialog = $("hosts_dialog");
function renderPasted() {
    const { records, problems } = parseHosts($("hosts_text").value);
    $("hosts_text_problems").replaceChildren(...problems.map((p) => Object.assign(document.createElement("li"), {
        textContent: `Line ${p.line}, left out (${p.why}): ${p.text}`,
    })));
    $("hosts_dialog_add").disabled = !records.length;
    $("hosts_dialog_add").textContent = records.length ? `Add ${records.length === 1 ? "1 record" : `${records.length} records`}` : "Add records";
    return records;
}
$("hosts_paste").addEventListener("click", () => {
    $("hosts_text").value = "";
    renderPasted();
    hostsDialog.showModal();
    $("hosts_text").focus();
});
$("hosts_text").addEventListener("input", renderPasted);
$("hosts_dialog_cancel").addEventListener("click", () => hostsDialog.close());
$("hosts_paste_form").addEventListener("submit", (event) => {
    event.preventDefault();
    const records = renderPasted();
    if (!records.length || !hosts) return;
    const seen = new Set(hosts.map((h) => `${h.name} ${h.addr}`));
    const added = records.filter((r) => !seen.has(`${r.name} ${r.addr}`) && seen.add(`${r.name} ${r.addr}`));
    if (!added.length) {
        hostsDialog.close();
        return say("They're all records already.");
    }
    // (Closed once they're kept: refused, they're still there to put right.)
    setHosts([...hosts, ...added], added.length === 1 ? "1 record added." : `${added.length} records added.`).then((ok) => {
        if (ok) hostsDialog.close();
    });
});

// copyText puts text on the clipboard (navigator.clipboard where there is
// one: an https page's; else the older way).
async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch { /* not here (http), or refused */ }
    const area = Object.assign(document.createElement("textarea"), { value: text, readOnly: true });
    area.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { /* none */ }
    area.remove();
    return ok;
}
$("hosts_copy").addEventListener("click", async () => {
    if (await copyText(hostsText(hosts))) say("Records copied, as hosts file lines.");
    else say("They couldn't be copied here: this browser doesn't allow it.", true);
});

// --- Ad blocking -------------------------------------------------------------

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
    $("filter_lists").classList.toggle("off", !!ads && !ads.enabled);
    const ticked = (ads?.lists ?? []).filter((l) => l.on);
    $("adblock_about").textContent = !ads ? ""
        : !ads.enabled ? "Off. Turning it on downloads the ticked lists below, and blocks the sites they name for ads and tracking."
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
        else detail.textContent = !ads.enabled ? (l.on ? "Downloaded when ad blocking's turned on" : "Not in use") : l.on ? "Not downloaded yet" : "Not in use";
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
    // Update now: only with ad blocking on, and a list ticked; said why not.
    $("ad_update").disabled = busy || !ads?.enabled || ticked.length === 0;
    $("ad_update_note").textContent = !ads ? "" : !ads.enabled ? "Turn on ad blocking to update lists."
        : ticked.length === 0 ? "Tick a list to update it." : "Downloaded from their sites by this server.";
    // My filters: as saved, unless being edited; the lines that can't be
    // used, by number.
    if (ads && !filtersEdited) $("my_filters").value = ads.filters ?? "";
    $("my_filters").disabled = busy || !ads;
    $("save_filters").disabled = busy || !ads || !filtersEdited;
    $("discard_filters").hidden = !filtersEdited;
    $("discard_filters").disabled = busy;
    $("filters_unsaved").hidden = !filtersEdited;
    $("filter_problems").replaceChildren(...(ads?.filterProblems ?? []).map((p) => Object.assign(document.createElement("li"), {
        textContent: `Line ${p.line}, can't be used here (a regular expression, a script run in pages, or an option that changes requests): ${p.text}`,
    })));
}

// setAds makes an ad blocking change; what's turned on that isn't had yet
// is downloaded first, which the reply says the outcome of.
function setAds(setting, extra = {}, done = "Setting saved.") {
    const slow = setting === "on" || setting === "list-on" || setting === "list-add";
    return run(async () => {
        if (slow) say(setting === "list-add" ? "Downloading the list…" : "Downloading filter lists…");
        ads = await ask({ type: "go-adblock-set", setting, ...extra });
        if (ads.error) throw new Error(ads.error);
    }, done);
}

// unsaved: My filters edited and not saved, told to the browser (go.js
// asks before closing the lightbox on them) and asked of before leaving.
function unsaved(edited) {
    if (filtersEdited === edited) return;
    filtersEdited = edited;
    told(edited ? "unsaved" : "saved");
}
addEventListener("beforeunload", (event) => {
    if (filtersEdited) event.preventDefault();
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
    unsaved(true);
    render();
});
$("save_filters").addEventListener("click", () => run(async () => {
    ads = await ask({ type: "go-adblock-set", setting: "filters", filters: $("my_filters").value });
    unsaved(false);
}, "Filters saved."));
$("discard_filters").addEventListener("click", () => {
    unsaved(false);
    render();
    say("Changes to your filters discarded.");
});
$("ad_update").addEventListener("click", () => run(async () => {
    say("Updating filter lists…");
    ads = await ask({ type: "go-adblock-update" });
    if (ads.error) throw new Error(ads.error);
}, "Filter lists updated."));

// --- Backup ------------------------------------------------------------------

function renderBackup() {
    $("settings_export").disabled = state.busy || !ads || !hosts;
    $("settings_import").disabled = state.busy || !ads || !hosts;
}

// The settings on this page, as a file's (gone through on import).
function exported() {
    return {
        tabtop: "go-settings", version: 1,
        searchEngine, searchURL: searchEngine === "custom" ? searchURL : undefined,
        doh, dohURL: doh === "custom" ? dohURL : undefined,
        hosts,
        adblock: {
            enabled: !!ads.enabled, interval: ads.interval, filters: ads.filters ?? "",
            lists: (ads.lists ?? []).map((l) => ({ url: l.url, on: !!l.on, builtIn: !!l.builtIn })),
        },
    };
}
$("settings_export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(exported(), null, 2) + "\n"], { type: "application/json" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "tabtop-browser-settings.json" });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    say("Settings exported.");
});
$("settings_import").addEventListener("click", () => $("settings_file").click());
$("settings_file").addEventListener("change", async () => {
    const file = $("settings_file").files?.[0];
    $("settings_file").value = "";
    if (!file) return;
    let data;
    try {
        if (file.size > 4 << 20) throw new Error("too large");
        data = JSON.parse(await file.text());
        if (data?.tabtop !== "go-settings") throw new Error("not one");
    } catch {
        return say("That isn't a settings file exported here.", true);
    }
    if (!confirm("Import these settings? What's set on this page now is replaced by the file's (each part the file has).")) return;
    // One run, its parts in turn, each through the settings' own requests
    // (checked there): what was done, and what wasn't and why, said.
    const done = [], failed = [];
    const part = async (name, f) => {
        try { await f(); done.push(name); } catch (err) { failed.push(`${name} (${err.message})`); }
    };
    await run(async () => {
        say("Importing settings…");
        if (typeof data.searchEngine === "string") await part("search engine", async () => {
            if (data.searchEngine === "custom") {
                const why = searchTemplateProblem(data.searchURL);
                if (why) throw new Error(why);
            }
            const r = await ask({ type: "go-settings-set", setting: "search-" + data.searchEngine, url: data.searchURL ?? "" });
            searchEngine = r.searchEngine ?? searchEngine;
            searchURL = r.searchURL ?? "";
            if (searchURL) $("search_url").value = searchURL;
            searchPicked = null;
            told("search-changed");
        });
        // (The records before DNS over HTTPS: a custom server's own name
        // may be one of them.)
        if (Array.isArray(data.hosts)) await part("local DNS records", async () => {
            const r = await ask({ type: "go-settings-set", setting: "hosts", hosts: data.hosts.map((h) => ({ name: String(h?.name ?? ""), addr: String(h?.addr ?? "") })) });
            hosts = Array.isArray(r.hosts) ? r.hosts : hosts;
        });
        if (typeof data.doh === "string") await part("DNS over HTTPS", async () => {
            const r = await ask({ type: "go-settings-set", setting: "doh-" + data.doh, url: data.dohURL ?? "" });
            doh = r.doh ?? doh;
            dohURL = r.dohURL ?? "";
            dohStatus = r.dohStatus ?? null;
            if (dohURL) $("doh_url").value = dohURL;
            dohPicked = null;
        });
        const a = data.adblock;
        if (a && typeof a === "object") {
            if (typeof a.filters === "string") await part("your filters", async () => {
                ads = await ask({ type: "go-adblock-set", setting: "filters", filters: a.filters });
                unsaved(false);
            });
            if (["daily", "weekly", "manual"].includes(a.interval)) await part("list updates", async () => {
                ads = await ask({ type: "go-adblock-set", setting: a.interval });
            });
            if (Array.isArray(a.lists)) await part("filter lists", async () => {
                const lists = a.lists.slice(0, 64).filter((l) => typeof l?.url === "string");
                // Those ticked here that the file hasn't ticked: not, as it has it.
                for (const have of ads.lists ?? []) {
                    if (have.on && !lists.some((l) => l.url === have.url && l.on)) ads = await ask({ type: "go-adblock-set", setting: "list-off", name: have.id });
                }
                for (const l of lists) {
                    let have = ads.lists?.find((m) => m.url === l.url);
                    if (!have && !l.builtIn) {
                        ads = await ask({ type: "go-adblock-set", setting: "list-add", url: l.url });
                        if (ads.error) throw new Error(ads.error);
                        have = ads.lists?.find((m) => m.url === l.url);
                    }
                    if (have && have.on !== !!l.on) {
                        ads = await ask({ type: "go-adblock-set", setting: l.on ? "list-on" : "list-off", name: have.id });
                        if (ads.error) throw new Error(ads.error);
                    }
                }
            });
            if (typeof a.enabled === "boolean" && a.enabled !== !!ads.enabled) await part("ad blocking", async () => {
                ads = await ask({ type: "go-adblock-set", setting: a.enabled ? "on" : "off" });
                if (ads.error) throw new Error(ads.error);
            });
        }
        if (failed.length) throw new Error(`Imported ${done.length ? done.join(", ") : "nothing"}. Not imported: ${failed.join("; ")}.`);
    }, "Settings imported.");
    render();
});

// --- Load ----------------------------------------------------------------------

async function load() {
    const [adblock, settings] = await Promise.all([ask({ type: "go-adblock" }), ask({ type: "go-settings" })]);
    ads = adblock;
    if (typeof settings?.searchEngine === "string" && $("search_engine").querySelector(`option[value="${CSS.escape(settings.searchEngine)}"]`)) {
        searchEngine = settings.searchEngine;
        searchURL = typeof settings.searchURL === "string" ? settings.searchURL : "";
        if (searchURL && !$("search_url").value) $("search_url").value = searchURL;
    }
    if (typeof settings?.doh === "string" && $("doh").querySelector(`option[value="${CSS.escape(settings.doh)}"]`)) {
        doh = settings.doh;
        dohURL = typeof settings.dohURL === "string" ? settings.dohURL : "";
        if (dohURL && !$("doh_url").value) $("doh_url").value = dohURL;
    }
    dohStatus = settings?.dohStatus ?? null;
    hosts = Array.isArray(settings?.hosts) ? settings.hosts : [];
}
run(load);
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && ads) run(load);
});
