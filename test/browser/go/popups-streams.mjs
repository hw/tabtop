// The remote browser's check (go-check.mjs), its steps of pop-ups, ad
// blocking, saving streams and files, layout, what a page observes.
import { siteFetch, sleep } from "../harness.mjs";
import { step } from "./step.mjs";

// popupsStreams runs them, with ctx: the check's browser, the site it browses, and its helpers (see check).
export async function popupsStreams(ctx) {
    const { site, ev, goTo, frameWait, frameClick, waitFor, submitUrl, base, adSite, stillNot, frame, closeSettings, cdp } = ctx;
    await step("pop-ups are asked about, the answer kept for the site; blocked sites aren't loaded; both in Site controls", async () => {
        const host = new URL(site).hostname;
        const settings = (req) => ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call(${JSON.stringify(req)}); t.close(); return JSON.stringify(t.reply); })`);
        const openPopup = async () => {
            await goTo(site + "interact.html", "Interact");
            await frameWait(`!!document.getElementById("open")`, "the page");
            await frameClick("#open");
        };
        // Asked; opened, and kept: the next opens without asking.
        await openPopup();
        await waitFor(`!document.getElementById("go_popup").hidden && document.getElementById("go_popup_text").textContent.includes(${JSON.stringify(host)})`, "asked, naming the site", 30000);
        await ev(`document.querySelector("#go_popup .open").click()`);
        await waitFor(`document.title.startsWith("Second")`, "the pop-up opened", 30000);
        if (JSON.parse(await settings({ type: "go-settings" })).popups[host] !== "allow") throw new Error("the answer wasn't kept");
        await openPopup();
        await waitFor(`document.title.startsWith("Second")`, "opened without asking", 30000);
        if (await ev(`!document.getElementById("go_popup").hidden`)) throw new Error("asked again");
        // Blocked for the site: not opened, and said.
        await settings({ type: "go-settings-set", name: host, setting: "popups-block" });
        await openPopup();
        await waitFor(`/pop-up from .* was blocked/.test(document.getElementById("go_status").textContent)`, "the pop-up refused, and said", 30000);
        await sleep(1500);
        if (!(await ev(`document.title.startsWith("Interact")`))) throw new Error("the refused pop-up loaded");
        // A blocked site: not loaded, nor its pictures for others; then
        // unblocked.
        await settings({ type: "go-settings-set", name: host, setting: "block" });
        await submitUrl(site + "second.html");
        await waitFor(`!document.getElementById("go_notice").hidden && /blocked/.test(document.querySelector("#go_notice p").textContent)`, "the blocked site refused", 30000);
        await settings({ type: "go-settings-set", name: host, setting: "unblock" });
        // The page: both listed, a site blocked and unblocked from it.
        await ev(`location.href = ${JSON.stringify(new URL("go/sites", base).href)}`);
        const siteRow = `document.querySelector('#sites li[data-site="${host}"]')`;
        // (The page left may answer first: ?.)
        await waitFor(`document.getElementById("sort_sites")?.value === "recent" && /Pop-ups: blocked/.test((${siteRow})?.textContent)`, "the site's pop-ups listed with Most recent selected", 20000);
        await ev(`(${siteRow}).querySelector("button").click()`);
        await waitFor(`!document.getElementById("site_settings").hidden && document.getElementById("popups").value === "block"`, "the site's pop-up setting");
        await ev(`document.getElementById("back_to_sites").click()`);
        await waitFor(`!document.getElementById("all_sites").hidden && document.activeElement === (${siteRow})?.querySelector("button")`, "back to All sites returns focus to the selected row");
        await ev(`document.getElementById("filter").value = "https://www.ads.example/x"; document.getElementById("find_site").requestSubmit();`);
        await waitFor(`document.getElementById("site_heading").textContent === "ads.example" && !document.getElementById("site_settings").hidden`, "settings for a newly entered site");
        await ev(`window.confirm = () => true; document.getElementById("access").click()`);
        await waitFor(`document.getElementById("access").textContent === "Unblock site"`, "a site blocked from the page");
        await ev(`document.getElementById("access").click()`);
        await waitFor(`document.getElementById("access").textContent === "Block site"`, "unblocked from the page");
        // Back to asking, for the steps after.
        await settings({ type: "go-settings-set", name: host, setting: "popups-default" });
        await ev(`location.href = ${JSON.stringify(new URL("go/tab", base).href)}`);
        // (The page it was at, loaded again, before the next.)
        await waitFor(`!!document.getElementById("go_url") && document.title.startsWith("Second")`, "the browser page again, at its page", 30000);
    });

    if (adSite) await step("ad blocking: a list added in Settings blocks another site's picture on a page (the shield says one site), not on a site allowed in Site controls, nor the site's own pages; My filters block it too; off, it's fetched", async () => {
        const call = (req) => ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call(${JSON.stringify(req)}); t.close(); return JSON.stringify(t.reply); })`);
        // What the other site was asked for, said by it (not through TabTop).
        const adsSeen = async () => {
            const text = await (await siteFetch(adSite + "seen")).text();
            return JSON.parse(text.match(/<pre id=s>(.*)<\/pre>/s)[1]).ads || 0;
        };
        const adHost = new URL(adSite).hostname;
        // Off at first, and the built-in lists (from the internet) not wanted here.
        const first = JSON.parse(await call({ type: "go-adblock" }));
        if (first.enabled) throw new Error("ad blocking was on at first");
        await call({ type: "go-adblock-set", setting: "list-off", name: "easylist" });
        await call({ type: "go-adblock-set", setting: "list-off", name: "easyprivacy" });
        try {
            await ev(`location.href = ${JSON.stringify(new URL("go/settings", base).href)}`);
            await waitFor(`document.getElementById("adblock_on")?.disabled === false && /^Off/.test(document.getElementById("adblock_about").textContent)`, "Settings, ad blocking off", 20000);
            const list = site + "filters.txt?host=" + adHost + "&page=" + new URL(site).hostname;
            await ev(`(() => { const i = document.getElementById("ad_url"); i.value = ${JSON.stringify(list)}; i.dispatchEvent(new Event("input")); document.getElementById("ad_add").requestSubmit(); })()`);
            await waitFor(`document.getElementById("done").textContent === "List added." && [...document.querySelectorAll("#ad_lists li")].some((li) => /TabTop check list/.test(li.textContent) && /7 rules\\b/.test(li.textContent) && li.querySelector("input").checked)`, "the list added, named as it says, ticked", 20000);
            await ev(`document.getElementById("adblock_on").click()`);
            await waitFor(`document.getElementById("done").textContent === "Ad blocking is on." && /^7 rules in force, from 1 of 1 ticked list/.test(document.getElementById("adblock_about").textContent)`, "on, the rule in force", 20000);
            await ev(`location.href = ${JSON.stringify(new URL("go/tab", base).href)}`);
            // (The page it was at, whichever an earlier step left, loaded
            // again before the next.)
            await waitFor(`!!document.getElementById("go_url") && document.readyState === "complete" && document.getElementById("go_progress")?.hidden && document.getElementById("go_view")?.getAttribute("aria-busy") !== "true"`, "the browser page again, at its page", 30000);
            const before = await adsSeen();
            await goTo(site + "ads?ad=" + encodeURIComponent(adSite), "Ads");
            await frameWait(`document.getElementById("own")?.naturalWidth > 0`, "the page's own picture");
            await stillNot(frame, `document.getElementById("ad")?.naturalWidth > 0`, "the other site's picture was shown", 1500);
            if ((await adsSeen()) !== before) throw new Error("the other site's picture was fetched");
            // Hidden: the ad, the site's own native ad, and one the page's script added after; not the page.
            const hidden = (sel) => `getComputedStyle(document.querySelector(${JSON.stringify(sel)})).display === "none"`;
            await frameWait(`!!document.getElementById("late")`, "the late ad, added by the page");
            await frameWait(`${hidden("#banner")} && ${hidden(".native")} && ${hidden("#late")} && getComputedStyle(document.getElementById("content")).display !== "none"`, "the ads hidden, the page shown", 5000);
            // By address, on the page's own site: its script under /ads/ not run nor asked for, but the one an
            // exception lets through run; its picture under /banner/ not fetched for the copy.
            const pageSeen = async () => JSON.parse((await (await siteFetch(site + "seen")).text()).match(/<pre id=s>(.*)<\/pre>/s)[1]);
            await frameWait(`document.getElementById("ok").textContent === "ran"`, "the script an exception lets through, run");
            if ((await frame(`document.getElementById("tracked").textContent`)) !== "not run") throw new Error("a script blocked by its address ran");
            const asked = await pageSeen();
            if (asked["/ads/track.js"] || asked["/banner/ad.png"] || !asked["/ads/ok.js"]) throw new Error(`the page's site was asked for ${JSON.stringify(asked)}`);
            if (await frame(`document.getElementById("pathad").naturalWidth > 0`)) throw new Error("a picture blocked by its address shown");
            // The shield: three blocked on this page (the other site, the script, the picture).
            await waitFor(`document.getElementById("go_site").dataset.glyph === "insecure,shield" && document.querySelector("#go_site .count").textContent === "3" && /3 ads and trackers blocked/.test(document.getElementById("go_site").title)`, "the site's button, saying three", 5000);
            // The site's ads allowed, in its controls (from the shield): fetched, shown, no shield.
            const pageHost = new URL(site).hostname;
            await ev(`document.getElementById("go_site").click()`);
            const sites = `document.querySelector("#go_settings iframe")?.contentDocument`;
            await waitFor(`(${sites})?.getElementById("ads")?.disabled === false && (${sites}).getElementById("site_heading").textContent === ${JSON.stringify(pageHost)} && (${sites}).getElementById("ads").selectedOptions[0].textContent === "Default (Block)"`, "the site's controls, from the shield", 15000);
            await ev(`(() => { const s = (${sites}).getElementById("ads"); s.value = "allow"; s.dispatchEvent(new Event("change")); })()`);
            await waitFor(`(${sites}).getElementById("done").textContent === "Setting saved."`, "the site's ads allowed");
            await closeSettings();
            await goTo(site + "ads?v=allowed&ad=" + encodeURIComponent(adSite), "Ads");
            await frameWait(`document.getElementById("ad")?.naturalWidth > 0`, "the other site's picture, ads allowed on the page's site");
            await frameWait(`getComputedStyle(document.getElementById("banner")).display !== "none"`, "the ad shown, ads allowed on the page's site");
            if ((await ev(`document.querySelector("#go_site .count").textContent`)) !== "") throw new Error("a count on the site's button, with ads allowed");
            await call({ type: "go-settings-set", name: pageHost, setting: "ads-default" });
            // My filters: the list off, the site named there instead.
            const listId = JSON.parse(await call({ type: "go-adblock" })).lists.find((l) => !l.builtIn).id;
            await call({ type: "go-adblock-set", setting: "list-off", name: listId });
            await ev(`location.href = ${JSON.stringify(new URL("go/settings", base).href)}`);
            await waitFor(`document.getElementById("my_filters")?.disabled === false && document.querySelectorAll("#ad_lists li").length > 0`, "My filters", 20000);
            await ev(`(() => { const t = document.getElementById("my_filters"); t.value = "! mine\\n" + ${JSON.stringify("||" + adHost + "^")} + "\\n/ads[0-9]+/"; t.dispatchEvent(new Event("input")); document.getElementById("save_filters").click(); })()`);
            await waitFor(`document.getElementById("done").textContent === "Filters saved." && /Line 3, can't be used here/.test(document.getElementById("filter_problems").textContent)`, "My filters saved, the line it can't use said").catch(async (err) => {
                throw new Error(`${err.message} (it shows ${await ev(`JSON.stringify({ done: document.getElementById("done").textContent, problems: document.getElementById("filter_problems").textContent, value: document.getElementById("my_filters").value, save: document.getElementById("save_filters").disabled })`)})`);
            });
            await ev(`location.href = ${JSON.stringify(new URL("go/tab", base).href)}`);
            await waitFor(`!!document.getElementById("go_url") && document.title.startsWith("Ads")`, "the browser page again, at its page", 30000);
            const seenBefore = await adsSeen();
            await goTo(site + "ads?v=mine&ad=" + encodeURIComponent(adSite), "Ads");
            await frameWait(`document.getElementById("own")?.naturalWidth > 0`, "the page's own picture");
            await stillNot(frame, `document.getElementById("ad")?.naturalWidth > 0`, "shown, with the site in My filters", 1500);
            if ((await adsSeen()) !== seenBefore) throw new Error("fetched, with the site in My filters");
            // Its own pages load: a page's own site is never blocked.
            await goTo(adSite + "second.html", "Second");
            // Off: fetched, and shown.
            await call({ type: "go-adblock-set", setting: "off" });
            await goTo(site + "ads?v=off&ad=" + encodeURIComponent(adSite), "Ads");
            await frameWait(`document.getElementById("ad")?.naturalWidth > 0`, "the other site's picture, blocking off");
            if (!((await adsSeen()) > before)) throw new Error("the other site's picture wasn't fetched, blocking off");
        } finally {
            const state = JSON.parse(await call({ type: "go-adblock" }));
            await call({ type: "go-adblock-set", setting: "off" });
            await call({ type: "go-adblock-set", setting: "filters", filters: "" });
            await call({ type: "go-settings-set", name: new URL(site).hostname, setting: "ads-default" });
            for (const l of state.lists ?? []) if (!l.builtIn) await call({ type: "go-adblock-set", setting: "list-remove", name: l.id });
        }
    });

    await step("an on-demand stream can be saved from the video player", async () => {
        // The page's video taken into the /go player (Watch, in the menu);
        // closed again.
        const watch = async () => {
            await ev(`document.getElementById("go_menu_panel").hidden && document.getElementById("go_menu").click()`);
            await waitFor(`[...document.querySelectorAll("#go_menu_media li .acts button")].some((b) => /^Watch /.test(b.getAttribute("aria-label") || "") && !b.disabled)`, "Watch offered", 30000);
            await ev(`[...document.querySelectorAll("#go_menu_media li .acts button")].find((b) => /^Watch /.test(b.getAttribute("aria-label") || "")).click()`);
            await waitFor(`!!document.querySelector("#video_player")`, "the player");
        };
        const unwatch = () => ev(`document.querySelector("#video_player button[aria-label^='Close the player']")?.click()`);
        const save = `#video_player button[aria-label^="Save stream"]`;
        // What's offered: the page's streams' names, the picker's (with what
        // the player's buffered, after them) or, one alone, Save's.
        const offered = () => ev(`(() => {
            const picker = document.querySelector("#video_player .stream-picker");
            const names = picker ? [...picker.options].map((o) => o.text) : [document.querySelector(${JSON.stringify(save)}).getAttribute("aria-label").replace(/^Save stream into Downloads · /, "")];
            return names.filter((n) => n !== "Buffered stream");
        })()`);
        await goTo(site + "stream-save.html", "Save stream");
        if (process.env.GO_NO_FS === "1") {
            await sleep(1500);
            await watch();
            if (await ev(`!!document.querySelector(${JSON.stringify(save)})`)) throw new Error("Save stream offered with Files off");
            return await unwatch();
        }
        await sleep(1500);  // (the manifest read by now)
        if (await ev(`!!document.getElementById("go_streams")`)) throw new Error("Save stream in the menu, not only the player");
        await watch();
        await waitFor(`!!document.querySelector(${JSON.stringify(save)})`, "Save stream in the player");
        // The page's stream, first (the picker's choice), named: how long it
        // lasts, and its site.
        const named = await offered();
        if (named.length !== 1 || !named[0].startsWith("0:03 · ")) throw new Error(`the streams offered: ${JSON.stringify(named)}`);
        if (await ev(`document.querySelector("#video_player .stream-picker")?.selectedIndex ?? 0`) !== 0) throw new Error("the page's stream not first");
        await ev(`document.querySelector(${JSON.stringify(save)}).click()`);
        await waitFor(`document.querySelector("#video_player .note")?.textContent.startsWith("Saved movie.mp4")`, "the assembled stream in Downloads", 30000);
        await unwatch();
        // A master playlist and the variant it names: one stream, the master's (the variant,
        // saved alone, would be the video without its sound), named by how long the variant says.
        await goTo(site + "stream-master.html", "Master stream");
        await sleep(1500);  // (the variant's fetched, and read, by now)
        await watch();
        await waitFor(`!!document.querySelector(${JSON.stringify(save)})`, "the master's stream");
        const master = await offered();
        if (master.length !== 1 || !master[0].startsWith("0:03 · ")) throw new Error(`a master and its variant offered as ${JSON.stringify(master)}`);
        await unwatch();
        // One that's slow, followed through the page's reload, and cancelled.
        await goTo(site + "stream-save.html?cancel", "Save stream");
        await sleep(1500);
        await watch();
        await waitFor(`!!document.querySelector(${JSON.stringify(save)})`, "the slow stream");
        await ev(`document.querySelector(${JSON.stringify(save)}).click()`);
        await waitFor(`Object.keys(sessionStorage).some(k => k.startsWith("tabtop-go-downloads:") && JSON.parse(sessionStorage[k]).length)`, "the download ID kept");
        await ev(`location.reload()`);
        await waitFor(`!!document.querySelector("#go_downloads button")`, "Cancel available after reconnecting");
        // Its engine past its soft memory limit: not moved to a fresh one
        // while the download runs; once it's done, at the next address.
        const resumeKey = `Object.keys(sessionStorage).find((k) => k.startsWith("tabtop-go-resume"))`;
        const token = () => ev(`sessionStorage.getItem(${resumeKey}) ?? ""`);
        const downloading = await token();
        await ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call({ type: "go-debug-recycle", go_tab: ${JSON.stringify(downloading)} }); t.close(); return true; })`);
        await sleep(800);
        await goTo(site + "swap.html", "Swap");
        await sleep(6000);  // (a move takes a few seconds: given time to show)
        if ((await token()) !== downloading) throw new Error("moved to a fresh engine while a download ran");
        await ev(`document.querySelector("#go_downloads button").click()`);
        await waitFor(`document.querySelector("#go_notice p")?.textContent === "Download cancelled." && !document.querySelector("#go_downloads button")`, "the download cancelled");
        await goTo(site + "stream-save.html", "Save stream");
        await waitFor(`sessionStorage.getItem(${resumeKey}) !== ${JSON.stringify(downloading)}`, "a fresh engine once the download's done", 30000);
        // A page that only streams through Media Source (no .m3u8): Save from the buffered capture.
        await goTo(site + "mse-save.html", "MSE save");
        await sleep(1500);
        await watch();
        await waitFor(`!!document.querySelector(${JSON.stringify(save)})`, "Save buffered MSE stream");
        await ev(`document.querySelector(${JSON.stringify(save)}).click()`);
        await waitFor(`/^Saved .* into Downloads\\.$/.test(document.querySelector("#video_player .note")?.textContent ?? "")`, "the buffered MSE stream in Downloads", 30000);
        await unwatch();
        // A WebM one, its video and sound in buffers of their own: one WebM.
        await goTo(site + "mse-webm.html", "MSE WebM");
        await sleep(1500);
        await watch();
        await waitFor(`!!document.querySelector(${JSON.stringify(save)})`, "Save buffered WebM stream", 30000);
        await ev(`document.querySelector(${JSON.stringify(save)}).click()`);
        await waitFor(`/^Saved .*\\.webm into Downloads\\.$/.test(document.querySelector("#video_player .note")?.textContent ?? "")`, "the buffered WebM stream in Downloads", 30000).catch(async (err) => {
            throw new Error(`${err.message}: the player says ${JSON.stringify(await ev(`document.querySelector("#video_player .note")?.textContent`))}`);
        });
        await unwatch();
        // (Its file checked by ffprobe, as it's saved: go-check.sh.)
    });

    if (process.env.GO_NO_FS !== "1") await step("after the page moves to its next video (pushState), the menu doesn't offer to save the last one's stream", async () => {
        await goTo(site + "mse-moved.html", "MSE moved");
        await ev(`document.getElementById("go_menu_panel").hidden && document.getElementById("go_menu").click()`);
        try {
            await waitFor(`document.querySelectorAll("#go_menu_media li").length >= 1`, "the video in the menu", 20000);
            await sleep(3000);  // (the page moved, its video playing)
            const said = await ev(`JSON.stringify([...document.querySelectorAll("#go_menu_media li .acts button")].map((b) => b.getAttribute("aria-label")))`);
            if (/0:03/.test(said)) throw new Error(`the menu offers the last video's stream: ${said}`);
        } finally {
            await ev(`document.getElementById("go_menu_panel").hidden || document.getElementById("go_menu").click()`);
        }
    });

    if (process.env.GO_NO_FS !== "1") await step("a stream no player here plays (the site's own): Save offered in the menu", async () => {
        await goTo(site + "onlystream.html", "Only stream");
        await ev(`document.getElementById("go_menu_panel").hidden && document.getElementById("go_menu").click()`);
        try {
            await waitFor(`[...document.querySelectorAll("#go_menu_media li")].some((li) => li.querySelector(".state")?.textContent === "Stream" && /^Save the stream of 0:03/.test(li.querySelector(".acts button")?.getAttribute("aria-label") || ""))`, "the stream's row, with Save", 15000);
            // No video in the list: its heading not shown (read to a screen reader).
            const head = await ev(`(() => { const h = document.getElementById("go_menu_media_h"); return { text: h.textContent, unseen: h.classList.contains("unseen"), color: getComputedStyle(h).color }; })()`);
            if (!head.unseen || head.color !== "rgba(0, 0, 0, 0)" || head.text !== "Streams on this page") throw new Error(`the heading with no video: ${JSON.stringify(head)}`);
        } finally {
            await ev(`document.getElementById("go_menu_panel").hidden || document.getElementById("go_menu").click()`);
        }
    });

    await step("a link to a file offers to save it", async () => {
        await goTo(site + "interact.html", "Interact");
        await frameWait(`!!document.getElementById("pdf")`, "the page");
        await frameClick("#pdf");
        // With Files off, nothing's said: the page stays, no notice.
        if (process.env.GO_NO_FS === "1") {
            await sleep(3000);
            await waitFor(`document.getElementById("go_progress").hidden`, "the click's load to end", 30000);
            const shown = await ev(`document.getElementById("go_notice").hidden ? "" : document.querySelector("#go_notice p").textContent`);
            if (shown) throw new Error(`with Files off, a notice: ${shown}`);
            if (!(await frame(`document.title === "Interact"`))) throw new Error("the page didn't stay");
            return "nothing said, Files off";
        }
        await waitFor(`!document.getElementById("go_notice").hidden && document.querySelector("#go_notice p").textContent.includes("application/pdf")`, "the file notice", 30000);
        await ev(`document.querySelector("#go_notice button").click()`);
        await waitFor(`document.querySelector("#go_notice p").textContent.startsWith("Saved doc.pdf")`, "the file saved", 30000);
        if (!(await ev(`document.querySelector("#go_notice .primary").textContent === "Open Downloads" && !document.querySelector("#go_notice .primary").hidden`))) throw new Error("no action to open Downloads");
        return await ev(`document.querySelector("#go_notice p").textContent`);
    });

    await step("a page that never stops changing stays usable", async () => {
        await goTo(site + "churn.html", "Churn");
        await sleep(3000);
        const n = Number(await frame(`document.getElementById("n").textContent`));
        if (!(n > 10)) throw new Error(`the counter shows ${n}`);
        await goTo(site + "second.html", "Second");
        return `counter seen at ${n}`;
    });

    await step("the page is laid out at the frame's size, and follows it", async () => {
        // The width it's laid out in here: the frame's, but for a scroll bar.
        const frameWidth = () => frame(`document.documentElement.clientWidth`);
        // Taller than the frame, with a scroll bar here: the engine's window
        // is the width left beside it (what's placed by the width, a
        // carousel's slides, is where it's shown).
        await goTo(site + "view.html?tall", "View");
        let fw = await frameWidth();
        if (fw >= await ev(`Math.round(document.getElementById("go_view").getBoundingClientRect().width)`)) throw new Error("no scroll bar to leave out");
        await frameWait(`document.getElementById("w")?.textContent === "width ${fw}"`, `the tall page at ${fw} wide, beside its scroll bar`);
        await goTo(site + "view.html", "View");
        fw = await frameWidth();
        await frameWait(`document.getElementById("w")?.textContent === "width ${fw}" && document.getElementById("mq").textContent === "wide"`, `the page at ${fw} wide`);
        // Narrower: the page's own resize handler and media query follow.
        await cdp("Emulation.setDeviceMetricsOverride", { width: 600, height: 800, deviceScaleFactor: 1, mobile: false });
        try {
            fw = await frameWidth();
            await frameWait(`document.getElementById("w")?.textContent === "width ${fw}" && document.getElementById("mq").textContent === "narrow"`, `the page at ${fw} wide`);
            // A menu placed by measuring its header lands under it.
            await frameClick("#menu");
            await frameWait(`document.getElementById("overlay")?.style.top === "123px"`, "the menu under the header");
            // Turned: the page's screen.orientation and (orientation: …)
            // follow this device's, a half turn (no size change) too.
            await cdp("Emulation.setDeviceMetricsOverride", { width: 600, height: 800, deviceScaleFactor: 1, mobile: false, screenOrientation: { type: "portraitPrimary", angle: 0 } });
            await frameWait(`document.getElementById("or")?.textContent === "portrait-primary 0 portrait"`, "the page held upright");
            await cdp("Emulation.setDeviceMetricsOverride", { width: 900, height: 500, deviceScaleFactor: 1, mobile: false, screenOrientation: { type: "landscapePrimary", angle: 90 } });
            await frameWait(`document.getElementById("or")?.textContent === "landscape-primary 90 landscape"`, "the page turned");
            await cdp("Emulation.setDeviceMetricsOverride", { width: 900, height: 500, deviceScaleFactor: 1, mobile: false, screenOrientation: { type: "landscapeSecondary", angle: 270 } });
            await frameWait(`document.getElementById("or")?.textContent === "landscape-secondary 270 landscape"`, "the page turned the other way");
        } finally {
            await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        }
        return `${fw} wide`;
    });

    await step("what the page observes is seen as it's shown here: a picture loads once scrolled to", async () => {
        await goTo(site + "lazy.html", "Lazy");
        await frameWait(`document.getElementById("feature")?.textContent === "feature yes"`, "the feature test passing");
        await frameWait(`document.getElementById("state")?.textContent === "not visible"`, "the picture seen as not visible");
        const before = await frame(`document.getElementById("lazy").getAttribute("src") || ""`);
        if (before) throw new Error(`the picture loaded before it was scrolled to: ${before.slice(0, 40)}`);
        await frame(`document.getElementById("lazy").scrollIntoView()`);
        await frameWait(`(document.getElementById("lazy").getAttribute("src") || "").startsWith("blob:") && document.getElementById("state").textContent.startsWith("loaded")`, "the picture loaded once scrolled to");
        return await frame(`document.getElementById("state").textContent`);
    });

    await step("an observer's callback can ask a question, and the page carries on", async () => {
        await goTo(site + "ioalert.html", "Observed alert");
        await waitFor(`document.getElementById("go_dialog").open`, "the alert");
        const said = await ev(`document.querySelector("#go_dialog p").textContent`);
        if (!said.includes("seen it")) throw new Error(`the alert said ${said}`);
        await ev(`document.querySelector("#go_dialog .ok").click()`);
        await frameWait(`document.getElementById("after")?.textContent === "after the alert"`, "the page carrying on");
    });


}
