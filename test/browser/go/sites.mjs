// The remote browser's check (go-check.mjs), its steps of history held,
// cookies and storage by site, Keep, All sites, Dark mode, phone and desktop
// pages, memory, fonts, the cache, refused addresses, reloading.
import { readFileSync, readdirSync } from "node:fs";
import { sleep } from "../harness.mjs";
import { step } from "./step.mjs";

// sites runs them, with ctx: the check's browser, the site it browses, and its helpers (see check).
export async function sites(ctx) {
    const { ev, waitFor, frame, site, goTo, leave, forgetKept, base, frameWait, cdp, frameClick, browser, submitUrl, closeSettings } = ctx;
    await step("back held lists the pages before, to go to one; forward's the pages after", async () => {
        // Held (a touch or the mouse): the list, the page just before first.
        await ev(`document.getElementById("go_back").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "touch" }))`);
        await waitFor(`!document.getElementById("go_history").hidden`, "the list, back held", 3000);
        const pages = await ev(`[...document.querySelectorAll("#go_history button.item")].map((b) => b.title)`);
        if (pages.length < 2 || pages.some((u) => u.endsWith("/second.html"))) throw new Error(`back lists ${JSON.stringify(pages)}`);
        await ev(`document.getElementById("go_back").dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerType: "touch" }))`);
        // The first page, more than one back.
        const first = pages[pages.length - 1];
        await ev(`[...document.querySelectorAll("#go_history button.item")].at(-1).click()`);
        await waitFor(`document.getElementById("go_history").hidden && document.getElementById("go_url").dataset.url === ${JSON.stringify(first)}`, "the first page", 30000);
        // Forward's list (its context menu: a right click), and the last.
        await ev(`document.getElementById("go_forward").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))`);
        await waitFor(`!document.getElementById("go_history").hidden`, "the list, forward", 3000);
        const ahead = await ev(`[...document.querySelectorAll("#go_history button.item")].map((b) => b.title)`);
        if (ahead.length !== pages.length || !ahead.at(-1).endsWith("/second.html")) throw new Error(`forward lists ${JSON.stringify(ahead)}`);
        await ev(`[...document.querySelectorAll("#go_history button.item")].at(-1).click()`);
        await waitFor(`document.getElementById("go_url").dataset.url.endsWith("/second.html")`, "the last page again", 30000);
        // And the device's back still a page at a time from there.
        await ev(`history.back()`);
        await waitFor(`document.getElementById("go_url").dataset.url === ${JSON.stringify(pages[0])}`, "a page back", 30000);
        await ev(`history.forward()`);
        await waitFor(`document.getElementById("go_url").dataset.url.endsWith("/second.html")`, "forward again", 30000);
        // At the first page, Back opens the panel with Back disabled and
        // Forward available.
        await ev(`document.getElementById("go_back").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))`);
        await waitFor(`!document.getElementById("go_history").hidden`, "the list again");
        const oldest = await ev(`[...document.querySelectorAll("#go_history button.item")].at(-1).title`);
        await ev(`[...document.querySelectorAll("#go_history button.item")].at(-1).click()`);
        await waitFor(`document.getElementById("go_url").dataset.url === ${JSON.stringify(oldest)}`, "the first page again", 30000);
        await ev(`document.getElementById("go_back").click()`);
        await waitFor(`!document.getElementById("go_history").hidden && !!document.querySelector("#go_history .foot .back:disabled") && !!document.querySelector("#go_history .foot .forward:not(:disabled)") && !!document.querySelector("#go_history .foot .clear:not(:disabled)")`, "Back, Forward, and Clear in the history panel");
        await ev(`document.querySelector("#go_history .foot .forward").click()`);
        await waitFor(`document.getElementById("go_url").dataset.url !== ${JSON.stringify(oldest)}`, "a page on, by its Forward", 30000);
        await ev(`document.getElementById("go_back").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))`);
        await waitFor(`!document.getElementById("go_history").hidden && !!document.querySelector("#go_history .foot .back:not(:disabled)")`, "Back is available from a later page");
        await ev(`document.querySelector("#go_history .foot .back").click()`);
        await waitFor(`document.getElementById("go_url").dataset.url === ${JSON.stringify(oldest)}`, "a page back, by its Back glyph", 30000);
        // Clear history: none back or forward, the page kept.
        await ev(`document.getElementById("go_back").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))`);
        await waitFor(`!document.getElementById("go_history").hidden && !!document.querySelector("#go_history .foot .clear:not(:disabled)")`, "Clear history offered");
        const kept = await ev(`document.getElementById("go_url").dataset.url`);
        await ev(`document.querySelector("#go_history .foot .clear").click()`);
        await waitFor(`document.getElementById("go_back").disabled && document.getElementById("go_forward").disabled && document.getElementById("go_url").dataset.url === ${JSON.stringify(kept)}`, "no pages back or forward, the page kept");
    });

    await step("a site's cookies are kept for new tabs, listed at go/cookie, and deleted by site or by time", async () => {
        const sent = () => frame(`document.getElementById("c")?.textContent`);
        const host = new URL(site).hostname;
        await goTo(site + "cookie?set", "Cookie");
        await goTo(site + "cookie", "Cookie");
        if ((await sent()) !== "sent kept=yes") throw new Error(`the site was sent ${await sent()}`);
        // A new tab (this page loaded again: its engine closed, a new one
        // started): given the cookie.
        const browserPage = async (path = "go/tab") => {
            // (The page left marked: what's waited for next is the new one's,
            // not the old one's as it goes.)
            await leave(`${forgetKept} location.href = ${JSON.stringify(new URL(path, base).href)};`, { what: "the page loaded anew" });
        };
        const newTab = async () => {
            await browserPage();
            await waitFor(`!!document.getElementById("go_url") && !!document.getElementById("go_menu") && document.getElementById("go_progress").hidden`, "the browser page again, connected");
            await sleep(1000);
        };
        await newTab();
        await goTo(site + "cookie", "Cookie");
        if ((await sent()) !== "sent kept=yes") throw new Error(`a new tab sent ${await sent()}`);
        // The site deleted while this tab is open: gone from it too.
        await ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call({ type: "go-cookies-forget", name: ${JSON.stringify(host)} }); t.close(); return t.reply.forgotten; })`);
        await goTo(site + "cookie", "Cookie");
        if ((await sent()) !== "sent nothing") throw new Error(`after deleting the site, the open tab sent ${await sent()}`);
        // The page at go/cookie: the site listed, then what was set in the
        // last hour cleared there.
        await goTo(site + "cookie?set", "Cookie");
        await browserPage("go/cookie");
        await waitFor(`[...document.querySelectorAll("#sites li")].some((li) => li.querySelector(".site").textContent === ${JSON.stringify(host)} && /1 cookie/.test(li.textContent))`, "the site listed with its cookie", 20000);
        // Older than an hour: the cookie just set isn't, kept.
        await ev(`document.getElementById("show_browser").click(); document.getElementById("clear_browser").click(); document.getElementById("within").value = "older:3600"; document.getElementById("clear").click();`);
        await waitFor(`document.getElementById("done").textContent === "Cleared browsing data older than 1 hour." && [...document.querySelectorAll("#sites li")].some((li) => li.querySelector(".site").textContent === ${JSON.stringify(host)} && /1 cookie/.test(li.textContent))`, "older than an hour cleared, the cookie just set kept");
        await ev(`document.getElementById("show_browser").click(); document.getElementById("clear_browser").click(); document.getElementById("within").value = "3600"; document.getElementById("clear").click();`);
        await waitFor(`/Cleared/.test(document.getElementById("done").textContent) && !/cookie/.test(document.getElementById("sites").textContent)`, "the last hour's cleared");
        await newTab();
        await goTo(site + "cookie", "Cookie");
        if ((await sent()) !== "sent nothing") throw new Error(`after clearing the last hour, a new tab sent ${await sent()}`);

        // Engines without localStorage persistence do not show the usage counter.
        await browserPage("go/cookie");
        await waitFor(`document.querySelectorAll("#sites li").length > 0 || document.getElementById("empty")?.hidden === false`, "storage capability loaded", 20000);
        if (process.env.GO_IMAGE ? (process.env.GO_ENGINE || "moli") === "moli" : true) {
            await waitFor(`document.getElementById("storage_usage")?.hidden === false`, "localStorage use is reported");
            const storageShown = () => frame(`document.getElementById("storage")?.textContent`);
            const usageRow = `[...document.querySelectorAll("#sites li")].find(li => li.dataset.site === ${JSON.stringify(host)})`;
            await newTab();
            await goTo(site + "storage?set", "Site storage");
            await newTab();
            await goTo(site + "storage", "Site storage");
            if (await storageShown() !== "saved") throw new Error("new tab did not restore localStorage before the inline script");
            await browserPage("go/cookie");
            await waitFor(`/10 B in 1 item/.test((${usageRow})?.textContent) && /10 B of 50 MB/.test(document.getElementById("storage_usage").textContent)`, "saved storage usage listed");
            await ev(`(${usageRow}).querySelector("button").click()`);
            await waitFor(`!document.getElementById("site_settings").hidden && !document.getElementById("clear_site").disabled`, "the site's data details");
            await ev(`document.getElementById("clear_site").click(); document.getElementById("clear").click();`);
            await waitFor(`/Cleared site data/.test(document.getElementById("done").textContent) && /0 B of 50 MB/.test(document.getElementById("storage_usage").textContent)`, "Delete cleared saved storage");
            await newTab();
            await goTo(site + "storage", "Site storage");
            if (await storageShown() !== "empty") throw new Error("deleted storage was restored");
            await goTo(site + "storage?set", "Site storage");
            await browserPage("go/cookie");
            await waitFor(`/10 B of 50 MB/.test(document.getElementById("storage_usage").textContent)`, "site storage listed again");
            await ev(`document.getElementById("show_browser").click(); document.getElementById("clear_browser").click(); document.getElementById("within").value = "3600"; document.getElementById("clear").click();`);
            await waitFor(`/Cleared/.test(document.getElementById("done").textContent) && /0 B of 50 MB/.test(document.getElementById("storage_usage").textContent)`, "last hour's saved storage cleared");
            await newTab();
            await goTo(site + "storage", "Site storage");
            if (await storageShown() !== "empty") throw new Error("cleared storage was restored");
        }
    });

    await step("a site's cookies and localStorage are listed in its Inspect, each deleted on its own, in the tabs too", async () => {
        const host = new URL(site).hostname;
        const browserPage = async (path) => {
            await leave(`${forgetKept} location.href = ${JSON.stringify(new URL(path, base).href)};`, { what: "the page loaded anew" });
        };
        await goTo(site + "cookie?set", "Cookie");
        await goTo(site + "storage?set", "Site storage");
        await sleep(500);
        // What it says: the cookie as set (HttpOnly too), and the item.
        const d = await ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call({ type: "go-site-data", name: ${JSON.stringify(host)} }); t.close(); return t.reply; })`);
        if (!d.cookies.some((c) => c.name === "kept" && c.value === "yes" && c.httpOnly && c.path === "/")) throw new Error(`the cookies: ${JSON.stringify(d.cookies)}`);
        const storage = !!d.storage;  // (kept only with an engine whose storage is: Moli's)
        if (storage && !d.storage.some((o) => o.items.some((i) => i.key === "check" && i.value === "saved"))) throw new Error(`the storage: ${JSON.stringify(d.storage)}`);
        // Its page: Site controls, the site, Inspect.
        await browserPage(`go/sites?site=${encodeURIComponent(host)}`);
        await waitFor(`!document.getElementById("site_settings").hidden && !document.getElementById("inspect_site").disabled`, "the site, Inspect offered", 20000);
        await ev(`document.getElementById("inspect_site").click()`);
        const named = (name) => `[...document.querySelectorAll("#inspect_list .entry")].find((e) => e.querySelector(".name").textContent === ${JSON.stringify(name)})`;
        await waitFor(`!!${named("kept")}`, "the cookie listed", 20000);
        await ev(`${named("kept")}.querySelector("summary").click()`);
        if (!(await ev(`/HttpOnly/.test(${named("kept")}.querySelector("dl").textContent) && ${named("kept")}.querySelector(".value").textContent === "yes"`))) throw new Error("the cookie's details not shown");
        await ev(`document.getElementById("inspect_filter").value = "nothing like it"; document.getElementById("inspect_filter").dispatchEvent(new Event("input"))`);
        if (await ev(`!!${named("kept")} || document.getElementById("inspect_empty").hidden`)) throw new Error("the filter kept what it doesn't find");
        await ev(`document.getElementById("inspect_filter").value = ""; document.getElementById("inspect_filter").dispatchEvent(new Event("input"))`);
        if (storage) {
            await ev(`document.getElementById("show_storage").click()`);
            await waitFor(`!!${named("check")}`, "the item listed");
            await ev(`window.confirm = () => true; ${named("check")}.querySelector("summary").click(); ${named("check")}.querySelector(".danger").click()`);
            await waitFor(`/Deleted the item check/.test(document.getElementById("done").textContent) && !${named("check")}`, "the item deleted");
            await ev(`document.getElementById("show_cookies").click()`);
        }
        await ev(`window.confirm = () => true; ${named("kept")}.querySelector(".danger").click()`);
        await waitFor(`/Deleted the cookie kept/.test(document.getElementById("done").textContent) && !${named("kept")}`, "the cookie deleted");
        // A tab anew: neither given back.
        await browserPage("go/tab");
        await waitFor(`!!document.getElementById("go_url") && !!document.getElementById("go_menu") && document.getElementById("go_progress").hidden`, "the browser page again, connected");
        await sleep(1000);
        await goTo(site + "cookie", "Cookie");
        if ((await frame(`document.getElementById("c")?.textContent`)) !== "sent nothing") throw new Error("the deleted cookie was sent");
        if (storage) {
            await goTo(site + "storage", "Site storage");
            if ((await frame(`document.getElementById("storage")?.textContent`)) !== "empty") throw new Error("the deleted item was restored");
        }
    });

    await step("Keep: a site kept keeps its cookies (its session's too) and storage through Clear browsing data, all time; Select's choices pass it by", async () => {
        const host = new URL(site).hostname;
        const moli = process.env.GO_IMAGE ? (process.env.GO_ENGINE || "moli") === "moli" : true;
        const browserPage = async (path) => {
            await leave(`${forgetKept} location.href = ${JSON.stringify(new URL(path, base).href)};`, { what: "the page loaded anew" });
        };
        const sitePage = async () => {
            await browserPage(`go/sites?site=${encodeURIComponent(host)}`);
            await waitFor(`!document.getElementById("site_settings").hidden && !document.getElementById("keep_site").disabled`, "the site's page", 20000);
        };
        await goTo(site + "cookie?set", "Cookie");
        await goTo(site + "cookie?session", "Cookie");
        if (moli) await goTo(site + "storage?set", "Site storage");
        await sleep(500);
        // Kept, from its page.
        await sitePage();
        if (await ev(`document.getElementById("keep_site").checked`)) throw new Error("kept before it was asked");
        await ev(`document.getElementById("keep_site").click()`);
        await waitFor(`/are kept/.test(document.getElementById("done").textContent) && document.getElementById("keep_site").checked && /leaves it/.test(document.getElementById("keep_note").textContent)`, "kept");
        // All sites: marked; Select ▸ All passes it by.
        await ev(`document.getElementById("show_all").click()`);
        const row = `document.querySelector('#sites li[data-site=${JSON.stringify(host)}]')`;
        await waitFor(`/Data kept/.test(${row}?.textContent ?? "")`, "marked kept in All sites", 20000);
        await ev(`document.getElementById("select_sites").click(); document.getElementById("select_pick").click(); [...document.querySelectorAll("#select_menu button")].find((b) => b.textContent === "All").click()`);
        if (await ev(`${row}.querySelector(".site-row").getAttribute("aria-pressed")`) !== "false") throw new Error("Select ▸ All picked the kept site");
        await ev(`document.getElementById("clear_selection").click()`);
        // Clear browsing data, all time: said to spare it, and does.
        await ev(`document.getElementById("show_browser").click(); document.getElementById("clear_browser").click(); document.getElementById("within").value = "0"`);
        const summary = await ev(`document.getElementById("clear_summary").textContent`);
        if (!summary.includes(`Kept sites aren't cleared: ${host}`)) throw new Error(`the dialog: ${summary}`);
        await ev(`document.getElementById("clear").click()`);
        await waitFor(`document.getElementById("done").textContent === "Cleared all browsing data."`, "all browsing data cleared");
        await browserPage("go/tab");
        await waitFor(`!!document.getElementById("go_url") && !!document.getElementById("go_menu") && document.getElementById("go_progress").hidden`, "the browser page again, connected");
        await sleep(1000);
        await goTo(site + "cookie", "Cookie");
        const sent = await frame(`document.getElementById("c")?.textContent`);
        if (!/kept=yes/.test(sent) || !/signin=s/.test(sent)) throw new Error(`a new tab, after all time cleared, sent ${sent}`);
        if (moli) {
            await goTo(site + "storage", "Site storage");
            if ((await frame(`document.getElementById("storage")?.textContent`)) !== "saved") throw new Error("the kept site's storage was cleared");
        }
        // Keep off, and its data cleared by name, for the steps after.
        await sitePage();
        await ev(`document.getElementById("keep_site").click()`);
        await waitFor(`/no longer kept/.test(document.getElementById("done").textContent) && !document.getElementById("keep_site").checked`, "kept no longer");
        await waitFor(`!document.getElementById("clear_site").disabled`, "Clear data offered");
        await ev(`document.getElementById("clear_site").click(); document.getElementById("clear").click()`);
        await waitFor(`/Cleared site data/.test(document.getElementById("done").textContent)`, "its data cleared");
        await browserPage("go/tab");
        await waitFor(`!!document.getElementById("go_url") && !!document.getElementById("go_menu") && document.getElementById("go_progress").hidden`, "the browser page again, connected");
        await sleep(1000);
    });

    await step("All sites: Select, any site selected (bordered), Clear data and Delete settings for those each applies to; a site typed opened from the list", async () => {
        const host = new URL(site).hostname;
        await goTo(site + "cookie?set", "Cookie");
        await ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call({ type: "go-settings-set", name: "rules-only.example", setting: "popups-block" }); t.close(); })`);
        await leave(`location.href = ${JSON.stringify(new URL("go/sites", base).href)};`, { what: "Site controls" });
        await ev(`document.getElementById("show_all").click()`);
        const row = (name) => `document.querySelector('#sites li[data-site=${JSON.stringify(name)}]')`;
        await waitFor(`!!${row(host)} && !!${row("rules-only.example")}`, "both sites listed", 20000);
        // No boxes: Select makes each row a toggle, its state a border.
        if (await ev(`!!document.querySelector("#sites input[type=checkbox]") || !document.getElementById("selection_bar").hidden`)) throw new Error("boxes, or the selection bar, before selecting");
        await ev(`document.getElementById("select_sites").click()`);
        if (!(await ev(`!document.getElementById("selection_bar").hidden && document.getElementById("sites").classList.contains("selecting") && ${row(host)}.querySelector(".site-row").getAttribute("aria-pressed") === "false"`))) throw new Error("Select didn't make the rows toggles");
        const bar = () => ev(`[document.getElementById("selection_count").textContent, document.getElementById("clear_selected").textContent, document.getElementById("clear_selected").disabled, document.getElementById("forget_selected").textContent, document.getElementById("forget_selected").disabled].join("|")`);
        // A site with data and one with only a setting: each action counts
        // those it's for.
        await ev(`${row(host)}.querySelector(".site-row").click()`);
        if ((await bar()) !== "1 selected|Clear data (1)…|false|Delete settings…|true") throw new Error(`a site with data selected: ${await bar()}`);
        await ev(`${row("rules-only.example")}.querySelector(".site-row").click()`);
        if ((await bar()) !== "2 selected|Clear data (1)…|false|Delete settings (1)…|false") throw new Error(`a settings-only site selected too: ${await bar()}`);
        if (!(await ev(`${row("rules-only.example")}.querySelector(".site-row").getAttribute("aria-pressed") === "true" && getComputedStyle(${row("rules-only.example")}.querySelector(".site-row")).boxShadow !== "none"`))) throw new Error("a selected row not bordered");
        // Delete settings, for those selected: the settings-only site gone.
        await ev(`window.confirm = () => true; document.getElementById("forget_selected").click()`);
        await waitFor(`/Deleted the saved settings for rules-only\\.example/.test(document.getElementById("done").textContent) && !${row("rules-only.example")}`, "the selected site's settings deleted");
        if ((await bar()) !== "1 selected|Clear data (1)…|false|Delete settings…|true") throw new Error(`after deleting settings: ${await bar()}`);
        // Select ▾: all, none, or by when active (the site's cookie was set
        // just now); Invert.
        const choose = async (label) => {
            await ev(`document.getElementById("select_pick").click()`);
            await waitFor(`document.getElementById("select_menu").matches(":popover-open") && document.activeElement?.parentElement?.id === "select_menu"`, "the Select menu open, its first choice focused");
            await ev(`[...document.querySelectorAll("#select_menu button")].find((b) => (b.getAttribute("aria-label") || b.textContent) === ${JSON.stringify(label)}).click()`);
            await waitFor(`!document.getElementById("select_menu").matches(":popover-open")`, "the menu closed");
        };
        const pressed = (name) => ev(`${row(name)}.querySelector(".site-row").getAttribute("aria-pressed")`);
        const listed = await ev(`document.querySelectorAll("#sites li").length`);
        await choose("None");
        if ((await ev(`document.getElementById("selection_count").textContent`)) !== "Select sites") throw new Error("None left some selected");
        await choose("Active in the last hour");
        if ((await pressed(host)) !== "true") throw new Error("a site active just now not selected as active in the last hour");
        await choose("Not active for an hour");
        if ((await pressed(host)) !== "false") throw new Error("a site active just now selected as not active for an hour");
        await ev(`document.getElementById("select_invert").click()`);
        if ((await pressed(host)) !== "true") throw new Error("Invert didn't select what wasn't");
        await choose("All");
        if ((await ev(`document.getElementById("selection_count").textContent`)) !== `${listed} selected`) throw new Error(`All: ${await ev(`document.getElementById("selection_count").textContent`)} of ${listed}`);
        await ev(`document.getElementById("select_invert").click()`);
        if ((await ev(`document.getElementById("selection_count").textContent`)) !== "Select sites") throw new Error("Invert of all left some selected");
        await ev(`${row(host)}.querySelector(".site-row").click()`);
        // Done (or Esc): rows open their sites again.
        await ev(`document.getElementById("clear_selection").click()`);
        if (!(await ev(`document.getElementById("selection_bar").hidden && !${row(host)}.querySelector(".site-row").hasAttribute("aria-pressed")`))) throw new Error("Done kept selecting");
        await ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call({ type: "go-settings-set", name: "rules-only.example", setting: "popups-block" }); t.close(); })`);
        await ev(`document.dispatchEvent(new Event("visibilitychange"))`);
        await waitFor(`!!${row("rules-only.example")}`, "the settings-only site listed again");
        // Its settings as chips, a count, and the filters.
        if (!(await ev(`/Pop-ups: blocked/.test(${row("rules-only.example")}.querySelector(".chips")?.textContent ?? "") && /^\\d+ sites?$/.test(document.getElementById("site_count").textContent)`))) throw new Error("no chips, or no count");
        await ev(`document.querySelector('.filters [data-filter="custom"]').click()`);
        if (!(await ev(`!!${row("rules-only.example")} && !${row(host)} && /^\\d+ of \\d+ sites$/.test(document.getElementById("site_count").textContent)`))) throw new Error("Custom permissions didn't filter to the sites with them");
        await ev(`document.querySelector('.filters [data-filter="all"]').click()`);
        // A host under a listed site: found as it.
        await ev(`(() => { const f = document.getElementById("filter"); f.value = "www.sub.rules-only.example"; f.dispatchEvent(new Event("input")); })()`);
        if (!(await ev(`/Includes sub\\.rules-only\\.example/.test(${row("rules-only.example")}?.textContent ?? "") && !document.querySelector("#sites .open-row")`))) throw new Error("a host under a listed site not found as it");
        await ev(`(() => { const f = document.getElementById("filter"); f.value = ""; f.dispatchEvent(new Event("input")); })()`);
        // ⋯: its quick actions; Reset permissions puts it back to the defaults.
        await ev(`${row("rules-only.example")}.querySelector(".row-more").click()`);
        const items = await ev(`[...document.querySelectorAll("#row_menu button")].map((b) => b.textContent)`);
        if (items.join() !== "Open site settings,Reset permissions,Delete settings…") throw new Error(`the row's menu: ${JSON.stringify(items)}`);
        await ev(`[...document.querySelectorAll("#row_menu button")].find((b) => b.textContent === "Reset permissions").click()`);
        await waitFor(`/back to the browser's defaults/.test(document.getElementById("done").textContent) && !${row("rules-only.example")}`, "its permissions reset, and it gone from the list");
        // Reset to defaults, in a site's own view.
        await ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call({ type: "go-settings-set", name: "rules-only.example", setting: "videos-block" }); t.close(); })`);
        await ev(`document.dispatchEvent(new Event("visibilitychange"))`);
        await waitFor(`!!${row("rules-only.example")}`, "listed again with its video setting");
        await ev(`${row("rules-only.example")}.querySelector(".site-row").click()`);
        await waitFor(`!document.getElementById("site_settings").hidden && !document.getElementById("reset_site").disabled && document.getElementById("videos").value === "block"`, "its controls, Reset offered");
        // Reset…: what'll change listed, then all of it at once.
        await ev(`document.getElementById("reset_site").click()`);
        await waitFor(`document.getElementById("confirm_reset").open && /Videos and sound: Block → Allow/.test(document.getElementById("reset_list").textContent)`, "what Reset will change, listed");
        await ev(`document.getElementById("reset_confirm").click()`);
        await waitFor(`document.getElementById("videos").value === "default" && document.getElementById("reset_site").disabled`, "reset to the defaults");
        await ev(`document.getElementById("show_all").click()`);
        // Delete settings, from a row's ⋯: its block and permissions gone, and
        // it, with no data, from the list.
        for (const setting of ["block", "popups-allow"]) await ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call({ type: "go-settings-set", name: "rules-only.example", setting: ${JSON.stringify(setting)} }); t.close(); })`);
        await ev(`document.dispatchEvent(new Event("visibilitychange"))`);
        await waitFor(`/Blocked/.test(${row("rules-only.example")}?.textContent ?? "")`, "blocked, with its pop-ups allowed");
        await ev(`${row("rules-only.example")}.querySelector(".row-more").click()`);
        await ev(`window.confirm = () => true; [...document.querySelectorAll("#row_menu button")].find((b) => b.textContent === "Delete settings…").click()`);
        await waitFor(`/Deleted the saved settings for rules-only\\.example/.test(document.getElementById("done").textContent) && !${row("rules-only.example")}`, "its settings deleted, and it gone");
        const left = await ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call({ type: "go-settings" }); t.close(); return t.reply; })`);
        if (left.blocked?.includes("rules-only.example") || left.popups?.["rules-only.example"]) throw new Error(`still kept: ${JSON.stringify(left)}`);
        // A site typed that isn't listed: a row to open it; Enter does too.
        await ev(`(() => { const f = document.getElementById("filter"); f.value = "typed-site.example"; f.dispatchEvent(new Event("input")); })()`);
        if (!(await ev(`/Open settings for typed-site\.example/.test(document.querySelector("#sites .open-row")?.textContent ?? "") && !document.getElementById("open_site")`))) throw new Error("no row to open a site typed");
        await ev(`document.querySelector("#sites .open-row button").click()`);
        await waitFor(`!document.getElementById("site_settings").hidden && document.getElementById("site_heading").textContent === "typed-site.example"`, "the typed site's controls");
        if (!(await ev(`document.getElementById("reset_site").disabled`))) throw new Error("Reset offered with nothing changed");
        await ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call({ type: "go-settings-set", name: "rules-only.example", setting: "popups-default" }); t.close(); })`).catch(() => {});
        await leave(`location.href = ${JSON.stringify(new URL("go/tab", base).href)};`, { what: "the browser again", ready: `!!document.getElementById("go_url") && document.getElementById("go_progress").hidden` });
        await sleep(1000);
    });

    await step("Dark mode: pages told dark or light as their site's setting says, changed live from Site controls", async () => {
        const host = new URL(site).hostname;
        const setTheme = (setting) => ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call({ type: "go-settings-set", name: ${JSON.stringify(host)}, setting: ${JSON.stringify(setting)} }); t.close(); })`);
        const told = () => frame(`document.getElementById("s")?.textContent`);
        try {
            await goTo(site + "scheme.html", "Scheme");
            if ((await told()) !== "light") throw new Error(`following the device (light): told ${await told()}`);
            await setTheme("theme-dark");
            await goTo(site + "scheme.html", "Scheme");
            if ((await told()) !== "dark") throw new Error(`Dark: told ${await told()}`);
            // And the copy's styles go by it, this browser being light.
            await goTo(site + "schemecss.html", "Scheme CSS");
            if ((await frame(`getComputedStyle(document.getElementById("c")).color`)) !== "rgb(2, 2, 2)") throw new Error(`Dark: the copy's styles ${await frame(`getComputedStyle(document.getElementById("c")).color`)}, not the page's dark ones`);
            await goTo(site + "scheme.html", "Scheme");
            // Changed in Site controls (its lightbox), the page shown follows.
            await ev(`document.getElementById("go_site").click()`);
            await waitFor(`(() => { const d = document.querySelector("#go_settings iframe")?.contentDocument; return d?.getElementById("theme")?.value === "dark" && !d.getElementById("theme").disabled; })()`, "the site's Dark mode in Site controls", 15000);
            await ev(`(() => { const d = document.querySelector("#go_settings iframe").contentDocument, s = d.getElementById("theme"); s.value = "light"; s.dispatchEvent(new Event("change")); })()`);
            await frameWait(`document.getElementById("s")?.textContent === "light"`, "the page told light", 15000);
            await ev(`(() => { const d = document.querySelector("#go_settings iframe").contentDocument; d.getElementById("back").click(); })()`);
            await waitFor(`!document.getElementById("go_settings").open`, "Site controls closed");
        } finally {
            await setTheme("theme-default").catch(() => {});
        }
    });

    await step("Current site: what applies shown in each control, a change marked with its default and ↺, Reload page offered, Not secure said, data counts opening the inspector", async () => {
        const host = new URL(site).hostname;
        await goTo(site + "cookie?set", "Cookie");
        const d = `document.querySelector("#go_settings iframe")?.contentDocument`;
        await ev(`document.getElementById("go_site").click()`);
        try {
            await waitFor(`(${d})?.getElementById("site_heading")?.textContent === ${JSON.stringify(host)} && !(${d}).getElementById("popups").disabled`, "the site's controls", 15000);
            const head = await ev(`(${d}).getElementById("site_scope").textContent + "|" + (${d}).getElementById("site_icon").textContent`);
            if (!/Not secure/.test(head) || !/subdomains/.test(head)) throw new Error(`its header says ${head}`);
            // Its icon (its /favicon.ico) by its name, not its initial.
            await waitFor(`(${d}).querySelector("#site_icon img")?.naturalWidth > 0`, "the site's icon shown", 15000);
            if ((await ev(`(${d}).getElementById("popups").selectedOptions[0].textContent`)) !== "Default (Ask)") throw new Error("the default not shown as what applies");
            // Changed: marked, its default said, ↺; and, holding for what loads
            // next, Reload page by what's said.
            await ev(`(() => { const s = (${d}).getElementById("popups"); s.value = "allow"; s.dispatchEvent(new Event("change")); })()`);
            await waitFor(`(() => { const doc = ${d}, row = doc.getElementById("popups").closest(".setting"); return row.classList.contains("changed") && !row.querySelector(".undo").hidden && /default: Ask/.test(doc.getElementById("popup_scope").textContent) && doc.getElementById("done").textContent === "Setting saved." && !doc.getElementById("done_action").hidden && doc.getElementById("done_action").textContent === "Reload page"; })()`, "the change marked, Reload page offered");
            await ev(`(${d}).querySelector('[data-reset="popups"]').click()`);
            await waitFor(`(() => { const doc = ${d}; return doc.getElementById("popups").value === "default" && !doc.getElementById("popups").closest(".setting").classList.contains("changed"); })()`, "↺ put it back");
            // Its data's counts: links to the inspector, at them.
            await ev(`(${d}).querySelector("#site_data button.link").click()`);
            await waitFor(`(() => { const doc = ${d}; return !doc.getElementById("site_inspect").hidden && doc.getElementById("show_cookies").getAttribute("aria-current") === "true"; })()`, "the inspector, at its cookies", 15000);
        } finally {
            await ev(`document.getElementById("go_settings").open && document.getElementById("go_settings").close()`).catch(() => {});
            await ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call({ type: "go-settings-set", name: ${JSON.stringify(host)}, setting: "popups-default" }); t.close(); })`).catch(() => {});
        }
    });

    await step("a phone switches between mobile and Desktop headers, and a video's site is sent its cookies", async () => {
        await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
        try {
            await sleep(1000);
            await goTo(site + "ua", "UA");
            const ua = await frame(`document.getElementById("ua").textContent`), mobile = await frame(`document.getElementById("m").textContent`);
            if (!/^Mozilla\/5\.0 \(Linux; Android 10; K\) .* Chrome\/\d+\.0\.0\.0 Mobile Safari\/537\.36$/.test(ua) || mobile !== "?1") throw new Error(`the site was told ${ua}, mobile ${mobile}`);
            await ev(`document.getElementById("go_menu").click(); document.getElementById("go_menu_fullscreen").click();`);
            await waitFor(`getComputedStyle(document.getElementById("go_bar")).display === "none" && !document.getElementById("go_exit_fullscreen").hidden`, "full screen hides the toolbar");
            await ev(`document.getElementById("go_exit_fullscreen").click()`);
            await waitFor(`getComputedStyle(document.getElementById("go_bar")).display !== "none" && document.getElementById("go_menu_fullscreen").getAttribute("aria-pressed") === "false"`, "exiting full screen restores the toolbar");
            const toggleDesktop = () => ev(`document.getElementById("go_menu").click(); document.getElementById("go_menu_desktop").click();`);
            // Its glyph and name the other pages, which it switches to: on a
            // phone, Desktop; pressed (highlighted) once switched to them.
            const glyph = () => ev(`(() => { const b = document.getElementById("go_menu_desktop"); return b.querySelector(".caption").textContent === (b.dataset.glyph === "mobile" ? "Mobile" : "Desktop") ? b.dataset.glyph + (b.getAttribute("aria-pressed") === "true" ? " pressed" : "") : "a caption not its mode's"; })()`);
            if ((await glyph()) !== "desktop") throw new Error(`a phone's mobile pages shown as ${await glyph()}`);
            await toggleDesktop();
            await frameWait(`document.getElementById("m")?.textContent === "?0" && !/Android|Mobile/.test(document.getElementById("ua")?.textContent)`, "Desktop sends desktop headers on a phone");
            if ((await glyph()) !== "desktop pressed") throw new Error(`a phone's desktop pages shown as ${await glyph()}`);
            await toggleDesktop();
            await frameWait(`document.getElementById("m")?.textContent === "?1" && /Android/.test(document.getElementById("ua")?.textContent)`, "unchecking Desktop restores the mobile profile");
            if ((await glyph()) !== "desktop") throw new Error(`a phone's mobile pages again shown as ${await glyph()}`);
            // A cookie on the site, and its video played: fetched with it,
            // as the page's own browser would.
            await goTo(site + "cookie?set", "Cookie");
            await goTo(site + "video.html", "Video");
            await waitFor(`[...document.querySelectorAll("video")].some((v) => v.readyState >= 1)`, "the clip's player", 30000);
            await goTo(site + "seen", "Seen");
            const seen = JSON.parse(await frame(`document.getElementById("s").textContent`));
            for (const what of ["/pic.png", "/clip.mp4"]) {
                const s = seen[what];
                if (!s || /tabtop/i.test(s.ua) || !/Android 10; K/.test(s.ua)) throw new Error(`${what} was fetched as ${s?.ua}`);
            }
            if (!seen["/clip.mp4"] || !/(^|; )kept=yes(;|$)/.test(seen["/clip.mp4"].cookie)) throw new Error(`the clip was fetched with cookies ${JSON.stringify(seen["/clip.mp4"])}`);
        } finally {
            await cdp("Emulation.setTouchEmulationEnabled", { enabled: false });
            await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        }
    });

    await step("a computer is given desktop pages, offered Mobile, and mobile ones once it's pressed, then desktop again; a narrow window, mobile ones, offered Desktop", async () => {
        await sleep(1000);  // (the view, a computer's again)
        const toggle = () => ev(`document.getElementById("go_menu").click(); document.getElementById("go_menu_desktop").click();`);
        const shown = () => ev(`(() => { const b = document.getElementById("go_menu_desktop"); return b.querySelector(".caption").textContent + (b.getAttribute("aria-pressed") === "true" ? " pressed" : ""); })()`);
        await goTo(site + "ua", "UA");
        await frameWait(`document.getElementById("m")?.textContent === "?0" && !/Android|Mobile/.test(document.getElementById("ua")?.textContent)`, "a computer's desktop headers");
        if ((await shown()) !== "Mobile") throw new Error(`a computer's desktop pages shown as ${await shown()}`);
        await toggle();
        await frameWait(`document.getElementById("m")?.textContent === "?1" && /Android/.test(document.getElementById("ua")?.textContent)`, "Mobile sends mobile headers on a computer");
        if ((await shown()) !== "Mobile pressed") throw new Error(`a computer's mobile pages shown as ${await shown()}`);
        await toggle();
        await frameWait(`document.getElementById("m")?.textContent === "?0" && !/Android|Mobile/.test(document.getElementById("ua")?.textContent)`, "its desktop headers again");
        if ((await shown()) !== "Mobile") throw new Error(`a computer's desktop pages again shown as ${await shown()}`);
        // A narrow window (no touch): laid out as a phone's, and given mobile
        // pages; offered Desktop, not pressed.
        await cdp("Emulation.setDeviceMetricsOverride", { width: 500, height: 800, deviceScaleFactor: 1, mobile: false });
        try {
            await sleep(1000);  // (the view, a narrow one)
            await goTo(site + "ua", "UA");
            await frameWait(`document.getElementById("m")?.textContent === "?1" && /Android/.test(document.getElementById("ua")?.textContent)`, "a narrow window's mobile headers");
            if ((await shown()) !== "Desktop") throw new Error(`a narrow window's mobile pages shown as ${await shown()}`);
        } finally {
            await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        }
        await sleep(1000);
        await goTo(site + "ua", "UA");
        await frameWait(`document.getElementById("m")?.textContent === "?0"`, "desktop headers, wide again");
    });

    await step("a tab whose engine is past its soft memory limit moves to a fresh one at its page's next address: shown once it's come, the old engine ended, its cookies kept; not while typing; a private tab's too", async () => {
        const resumeKey = `Object.keys(sessionStorage).find((k) => k.startsWith("tabtop-go-resume"))`;
        const token = () => ev(`sessionStorage.getItem(${resumeKey}) ?? ""`);
        const advise = () => ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call({ type: "go-debug-recycle", go_tab: sessionStorage.getItem(${resumeKey}) }); t.close(); return true; })`);
        // The engines this check's server runs, by process (none known: an image's).
        const engines = () => {
            const port = new URL(base).port, all = new Map();
            let server = 0;
            for (const d of readdirSync("/proc")) {
                if (!/^\d+$/.test(d)) continue;
                try {
                    const stat = readFileSync(`/proc/${d}/stat`, "utf8"), close = stat.lastIndexOf(")");
                    const comm = stat.slice(stat.indexOf("(") + 1, close);
                    all.set(Number(d), { comm, ppid: Number(stat.slice(close + 2).split(" ")[1]) });
                    if (comm === "tabtopd" && readFileSync(`/proc/${d}/cmdline`, "utf8").includes(`127.0.0.1:${port}`)) server = Number(d);
                } catch { /* gone */ }
            }
            if (!server) return null;
            const under = (p) => { while (p && p !== server && p !== 1) p = all.get(p)?.ppid; return p === server; };
            return [...all].filter(([p, x]) => x.comm === "moli" && under(p)).map(([p]) => p);
        };
        const loadOf = () => frame(`document.getElementById("load")?.textContent ?? ""`);
        // (Its new address, once the copy has it: read at once, it's the last.)
        const next = async () => {
            const was = await frame(`document.getElementById("where").textContent`);
            await frameClick("#next");
            await frameWait(`document.getElementById("where")?.textContent !== ${JSON.stringify(was)}`, "its next address", 10000);
            return frame(`document.getElementById("where").textContent`);
        };
        // (Each a tab on its own, its sessionStorage this check's.)
        const tab = async (path, setup = "") => {
            await leave(`sessionStorage.clear(); ${setup} location.href = ${JSON.stringify(new URL(path, base).href)};`, { what: "a tab of its own, connected", ready: `!!document.getElementById("go_url") && document.getElementById("go_progress").hidden` });
            await sleep(1000);  // (its connection's open)
        };
        // (Fresh: its own number for its load, not the old page's, which
        // has the new address too: pushState.)
        const swapped = async (what, before, loaded, where) => {
            await waitFor(`sessionStorage.getItem(${resumeKey}) !== ${JSON.stringify(before)}`, `${what}: a fresh tab`, 30000);
            await frameWait(`document.getElementById("load")?.textContent !== ${JSON.stringify(loaded)} && document.getElementById("where")?.textContent === ${JSON.stringify(where)}`, `${what}: its page, fresh, at ${where}`, 30000)
                .catch(async (err) => {
                    const targets = (await cdp("Target.getTargets")).targetInfos.filter((t) => t.url.includes("go-frame.html")).length;
                    throw new Error(`${err.message}; the page shows ${await ev(`JSON.stringify({ title: document.title, url: document.getElementById("go_url").dataset.url, status: document.getElementById("go_status").textContent })`)}; ${targets} frame targets`);
                });
        };
        try {
            // (Its engine: the one started for it, others' kept tabs
            // ending meanwhile.)
            const had = new Set(engines() ?? []);
            await tab("go/tab");
            await goTo(site + "swap.html", "Swap");
            await frameWait(`!!document.getElementById("next")`, "its button");
            const mine = (engines() ?? []).filter((p) => !had.has(p));
            // Advised: but typing (a key just now), not moved at its next address.
            await advise();
            await sleep(800);
            await frameClick("#t");
            await browser.type("a");
            const typing = await token();
            await next();
            await sleep(8000);  // (a move takes a few seconds: given time to show)
            if ((await token()) !== typing) throw new Error("moved to a fresh engine while typing");
            // Past that (10 s): moved at its next address, its page fresh there.
            await sleep(3000);
            const before = await token(), loaded = await loadOf();
            const where = await next();
            await swapped("not typing", before, loaded, where);
            const c = await frame(`document.getElementById("c").textContent`);
            if (!/justset=\d+/.test(c)) throw new Error(`the cookie set just before wasn't the fresh engine's: ${c}`);
            const ls = await frame(`document.getElementById("ls").textContent`);
            if (ls !== /justset=(\d+)/.exec(c)[1]) throw new Error(`the site's storage set just before wasn't the fresh engine's: ${ls} (the cookie ${c})`);
            if (engines()) {
                const left = () => engines().filter((p) => mine.includes(p));
                const end = Date.now() + 15000;
                while (left().length && Date.now() < end) await sleep(500);
                if (left().length) throw new Error(`the old engine (${left().join(", ")}) not ended after the move`);
                if (!mine.length) throw new Error("no engine of its own seen");
            }
            // A private tab: its sign-in kept across the move.
            await tab("go/tab?id=97", `sessionStorage.setItem("tabtop-go-private:97", "1");`);
            if (!(await ev(`document.documentElement.classList.contains("go-private")`))) throw new Error("not a private tab");
            // (Its title's "Private – Browser", whatever the page: loaded as
            // the copy shows it.)
            const privateTo = async (url, ready, what) => {
                await submitUrl(url);
                await frameWait(ready, what, 30000);
            };
            await privateTo(site + "cookie?session", `/^sent/.test(document.getElementById("c")?.textContent ?? "")`, "the private tab's sign-in");
            await privateTo(site + "swap.html", `!!document.getElementById("next")`, "the private tab's button");
            await advise();
            await sleep(800);
            const privateBefore = await token(), privateLoaded = await loadOf();
            await swapped("a private tab", privateBefore, privateLoaded, await next());
            await privateTo(site + "cookie", `/^sent/.test(document.getElementById("c")?.textContent ?? "") && !document.getElementById("next")`, "what the private tab sends");
            const sent = await frame(`document.getElementById("c").textContent`);
            if (!/signin=s/.test(sent)) throw new Error(`a private tab's sign-in not kept across the move: ${sent}`);
            if (!(await ev(`document.documentElement.classList.contains("go-private")`))) throw new Error("the private tab moved to one that isn't");
        } finally {
            await tab("go/tab");
        }
    });

    await step("a font is fetched as a browser would: the one source it takes, for a face its text uses", async () => {
        await goTo(site + "fonts.html", "Fonts");
        // Shown in it: not as wide as in the fallback (monospace).
        await frameWait(`(() => { const p = document.getElementById("used"); if (!p) return false; const mono = Object.assign(document.createElement("span"), { textContent: p.textContent }); mono.style.fontFamily = "monospace"; const its = Object.assign(document.createElement("span"), { textContent: p.textContent }); its.style.font = getComputedStyle(p).font; document.body.append(mono, its); const differ = Math.abs(mono.getBoundingClientRect().width - its.getBoundingClientRect().width) > 2; mono.remove(); its.remove(); return differ; })()`, "the text in the font used");
        await sleep(1000);
        await goTo(site + "seen", "Seen");
        const fonts = JSON.parse(await frame(`document.getElementById("s").textContent`)).fonts ?? [];
        // (The stylesheets were sent in Brotli and zstd, and shown: the steps above.)
        const coded = JSON.parse(await frame(`document.getElementById("s").textContent`));
        if (!(coded.brotli > 0) || !(coded.zstd > 0)) throw new Error(`stylesheets weren't sent in Brotli and zstd: ${JSON.stringify(coded)}`);
        if (!fonts.includes("/font.ttf?used")) throw new Error(`the font used wasn't fetched: ${fonts}`);
        const extra = fonts.filter((f) => /eot|svg|fallback|unused/.test(f));
        if (extra.length) throw new Error(`fetched too: ${extra}`);
        const usedLoaded = `[...document.fonts].some((f) => f.family.replaceAll('"', "") === "Used Font" && f.status === "loaded")`;
        // The intermediate page drops the installed face, while the rewritten
        // stylesheet stays cached for the next document.
        await goTo(site + "fonts-next.html", "Shared fonts");
        await frameWait(usedLoaded, "font restored from the cached stylesheet");
        await goTo(site + "fonts.html", "Fonts");
        await frameWait(usedLoaded, "font still loaded after navigation to the first page");
    });

    await step("Clear cached files, in Site controls' Browser-wide settings: a picture is fetched from its site again, not before", async () => {
        const fetched = async () => { await goTo(site + "seen", "Seen"); return JSON.parse(await frame(`document.getElementById("s").textContent`)).cached || 0; };
        const shown = () => frameWait(`document.getElementById("pic")?.naturalWidth > 0`, "the picture");
        await goTo(site + "cache.html", "Cached");
        await shown();
        const first = await fetched();
        if (first < 1) throw new Error("the picture wasn't fetched");
        await goTo(site + "cache.html", "Cached");
        await shown();
        if ((await fetched()) !== first) throw new Error("fetched again, not cleared");
        await ev(`document.getElementById("go_menu").click()`);
        await ev(`document.getElementById("go_site").click()`);
        const settings = `document.querySelector("#go_settings iframe")?.contentDocument`;
        await waitFor(`!!(${settings})?.getElementById("show_browser")`, "Site controls open");
        await ev(`(${settings}).getElementById("show_browser").click()`);
        await waitFor(`(${settings})?.getElementById("clear_cache")?.disabled === false`, "cache action available");
        await ev(`(${settings}).getElementById("clear_cache").click()`);
        await waitFor(`(${settings})?.getElementById("done")?.textContent === "Cached files cleared."`, "cache action succeeded");
        await closeSettings();
        await goTo(site + "cache.html", "Cached");
        await shown();
        const after = await fetched();
        if (after !== first + 1) throw new Error(`fetched ${after - first} times after clearing`);
    });

    await step("this machine's addresses are refused", async () => {
        await submitUrl("http://127.0.0.1:9/");
        await waitFor(`!document.getElementById("go_notice").hidden`, "the error", 30000);
        const message = await ev(`document.querySelector("#go_notice p").textContent`);
        if (!(await ev(`document.getElementById("go_progress").hidden && !document.querySelector("#go_notice .edit").hidden`))) throw new Error("missing recovery controls");
        await ev(`document.querySelector("#go_notice .edit").click()`);
        if (!(await ev(`document.activeElement.id === "go_url" && document.activeElement.value === "http://127.0.0.1:9/" && document.getElementById("go_notice").hidden`))) throw new Error("Edit address lost the attempted URL");
        return message;
    });

    await step("reloading the tab carries on where it was", async () => {
        await submitUrl(site + "second.html");
        await waitFor(`document.title.startsWith("Second")`, "the second page", 30000);
        await cdp("Page.reload");
        await waitFor(`document.title.startsWith("Second") && !!document.getElementById("go_url")`, "the second page after reloading", 30000);
        // The page's address is the tab's alone: not in its own (history).
        const own = await ev(`location.href`);
        if (own.includes("second.html") || own.includes("#")) throw new Error(`the tab's address is ${own}`);
    });

}
