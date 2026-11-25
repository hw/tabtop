// The remote browser's check (go-check.mjs), its steps of the toolbar,
// loading a page through the engine, what the frame is kept from, navigation,
// Site controls and Settings.
import { sleep } from "../harness.mjs";
import { step } from "./step.mjs";

// pages runs them, with ctx: the check's browser, the site it browses, and its helpers (see check).
export async function pages(ctx) {
    const { cdp, waitFor, ev, submitUrl, site, frame, frameWait, base, requests, frameClick, pageShown, goTo, closeSettings } = ctx;
    await step("the browser toolbar fits a mobile viewport", async () => {
        try {
            await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 700, deviceScaleFactor: 1, mobile: true });
            // The width at once; the height once the page has followed the
            // visual viewport's resize (an event of its own, a moment later).
            await waitFor(`document.getElementById("go_view").getBoundingClientRect().width === 390`, "mobile layout");
            await waitFor(`Math.abs(document.getElementById("go_view").getBoundingClientRect().bottom - visualViewport.height) <= 1`, "the page fitted to the screen's height", 5000).catch(() => {});
            const layout = await ev(`(() => {
                const input = document.getElementById("go_url"), bar = document.getElementById("go_bar");
                const view = document.getElementById("go_view").getBoundingClientRect();
                return { font: parseFloat(getComputedStyle(input).fontSize), radius: parseFloat(getComputedStyle(input).borderRadius),
                    targets: [...bar.querySelectorAll("button")].filter((b) => b.getClientRects().length).every(b => b.getBoundingClientRect().height >= 44 && b.getBoundingClientRect().width >= 44),
                    // The bar of links in the menu, not above: this bar's at the top.
                    nav: !!document.querySelector("#go_menu_panel .tabtop-nav") && bar.getBoundingClientRect().top === 0,
                    // Forward stays in the history panel: room for the address.
                    forward: getComputedStyle(document.getElementById("go_forward")).display === "none",
                    top: view.top, barBottom: bar.getBoundingClientRect().bottom, bottom: view.bottom, height: visualViewport.height,
                    overflow: document.documentElement.scrollWidth > innerWidth };
            })()`);
            if (layout.font < 16 || layout.radius > 6 || !layout.targets || !layout.nav || !layout.forward || layout.overflow || layout.top !== layout.barBottom || Math.abs(layout.bottom - layout.height) > 1) {
                throw new Error(JSON.stringify(layout));
            }
            // A notch and a home bar (where this Chrome can say so): the bar
            // below the one, the page above the other.
            const insets = await cdp("Emulation.setSafeAreaInsetsOverride", { insets: { top: 47, topMax: 47, bottom: 34, bottomMax: 34, left: 0, right: 0 } }).then(() => true, () => false);
            if (insets) {
                try {
                    await waitFor(`parseFloat(getComputedStyle(document.getElementById("go_bar")).paddingTop) === 47`, "the bar below the notch", 5000);
                    const clear = await ev(`(() => {
                        const bar = document.getElementById("go_bar").getBoundingClientRect(), view = document.getElementById("go_view").getBoundingClientRect();
                        const input = document.getElementById("go_url").getBoundingClientRect();
                        return { input: input.top >= 47, view: view.top === bar.bottom && Math.abs(view.bottom - (document.body.getBoundingClientRect().bottom - 34)) <= 1,
                            pull: getComputedStyle(document.documentElement).overscrollBehaviorY === "none" };
                    })()`);
                    if (!clear.input || !clear.view || !clear.pull) throw new Error(`with a notch and home bar: ${JSON.stringify(clear)}`);
                } finally {
                    await cdp("Emulation.setSafeAreaInsetsOverride", { insets: {} }).catch(() => {});
                }
            }
        } finally {
            await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        }
    });

    await step("load a page through the engine", async () => {
        await submitUrl(site + "index.html");
        await waitFor(`document.title.startsWith("Fixture")`, "the page's title", 30000);
        for (let i = 0; i < 100; i++) {
            if (await frame(`document.getElementById("p")?.textContent ?? ""`).catch(() => "") === "scripted") break;
            await sleep(100);
        }
        const text = await frame(`document.getElementById("p")?.textContent`);
        if (text !== "scripted") {
            const why = { status: await ev(`document.getElementById("go_status").textContent`),
                notice: await ev(`document.getElementById("go_notice").hidden ? "" : document.querySelector("#go_notice p").textContent`),
                frame: await frame(`document.documentElement.outerHTML.slice(0, 400)`).catch((e) => e.message) };
            throw new Error(`the page reads ${JSON.stringify(text)}, not what its script wrote: ${JSON.stringify(why)}`);
        }
        const ws = await frame(`document.getElementById("ws").textContent`);
        if (ws !== "portable binary\ncode") throw new Error(`whitespace between elements was lost: ${JSON.stringify(ws)}`);
        return await ev(`(document.getElementById("go_url").dataset.url || document.getElementById("go_url").value)`);
    });

    await step("stylesheets, imports, fonts and pictures through the server", async () => {
        await frame(`document.fonts.ready`);
        // A face's font comes once its text is shown (go-frame.js's fonts).
        await frameWait(`[...document.fonts].some((f) => f.family.replace(/"/g, "") === "Fixture Font" && f.status === "loaded")`, "the page's font");
        for (let i = 0; i < 50; i++) {
            if (await frame(`document.getElementById("img").naturalWidth > 0`)) break;
            await sleep(100);
        }
        const got = await frame(`(() => {
            const p = document.getElementById("p"), img = document.getElementById("img");
            return {
                color: getComputedStyle(p).color,
                background: getComputedStyle(document.body).backgroundColor,
                font: document.fonts.check('16px "Fixture Font"'),
                fontLoaded: [...document.fonts].some((f) => f.family.replace(/"/g, "") === "Fixture Font" && f.status === "loaded"),
                img: img.naturalWidth, imgSrc: img.src.slice(0, 5),
                bg: getComputedStyle(document.getElementById("bg")).backgroundImage.slice(0, 9),
                gradient: getComputedStyle(document.getElementById("rect")).fill,
                varBg: getComputedStyle(document.getElementById("varbg")).backgroundImage.slice(0, 9),
            };
        })()`);
        const want = { color: "rgb(0, 128, 128)", background: "rgb(250, 250, 240)", fontLoaded: true, imgSrc: "blob:", bg: 'url("blob', varBg: 'url("blob' };
        for (const [k, v] of Object.entries(want)) {
            if (got[k] !== v) throw new Error(`${k}: ${JSON.stringify(got[k])}, want ${JSON.stringify(v)} (${JSON.stringify(got)})`);
        }
        if (!(got.img > 0)) throw new Error(`the picture didn't load: ${JSON.stringify(got)}`);
        if (!got.gradient.includes("#g")) throw new Error(`the SVG's own url(#g) was lost: ${got.gradient}`);
        return `picture ${got.img}px wide`;
    });

    await step("what runs or loads is left out", async () => {
        const left = await frame(`({
            scripts: document.querySelectorAll("script").length,
            frames: document.querySelectorAll("iframe, object, embed").length,
            handlers: [...document.querySelectorAll("*")].filter((e) => [...e.attributes].some((a) => a.name.startsWith("on"))).length,
            linkHref: document.getElementById("next").getAttribute("href"),
            formAction: document.getElementById("form").getAttribute("action"),
            origin: self.origin,
        })`);
        const want = { scripts: 0, frames: 0, handlers: 0, linkHref: "#", formAction: null, origin: "null" };
        for (const [k, v] of Object.entries(want)) {
            if (left[k] !== v) throw new Error(`${k}: ${JSON.stringify(left[k])}, want ${JSON.stringify(v)}`);
        }
    });

    await step("iframe snapshots update and use the embedded page's base URL", async () => {
        await frameWait(`document.getElementById("embedded")?.shadowRoot?.getElementById("embedded-text")?.textContent === "updated content"`, "embedded page update");
        await frameWait(`document.getElementById("embedded")?.shadowRoot?.querySelector("img")?.naturalWidth > 0`, "embedded image");
        const valid = await frame(`(() => {
            const root = document.getElementById("embedded").shadowRoot;
            const paragraph = root.getElementById("embedded-text");
            // (Not inert: presses in it go to its page, in the engine.)
            return root.querySelector("script, iframe, [onclick]") === null && getComputedStyle(paragraph).color === "rgb(0, 128, 128)";
        })()`);
        if (!valid) throw new Error("embedded snapshot was not sanitized and styled");
    });

    await step("the frame can't reach the page, the site or the web", async () => {
        const got = await frame(`(async () => {
            const out = {};
            try { out.parent = !!parent.document; } catch { out.parent = false; }
            try { out.storage = !!localStorage; } catch { out.storage = false; }
            try { await fetch("https://example.com/"); out.fetch = true; } catch { out.fetch = false; }
            try { await fetch(${JSON.stringify(base)} + "go/"); out.site = true; } catch { out.site = false; }
            out.image = await new Promise((resolve) => { const i = new Image(); i.onload = () => resolve(true); i.onerror = () => resolve(false); i.src = ${JSON.stringify(site + "pic.png")}; });
            return out;
        })()`);
        for (const [k, v] of Object.entries(got)) if (v !== false) throw new Error(`the frame reached ${k}`);
    });

    await step("the frame can't navigate itself to the web", async () => {
        const before = requests.length;
        // A raw link, as a sanitizer bypass would leave, and a script's own
        // navigation: the page's frame-src stops both.
        await frame(`(() => { const a = document.createElement("a"); a.href = ${JSON.stringify(site + "second.html")}; document.body.append(a); a.click(); })()`);
        await sleep(1000);
        await frame(`location.href = ${JSON.stringify(site + "second.html")}`).catch(() => {});
        await sleep(1000);
        const leaked = requests.slice(before).filter((u) => u.startsWith(site));
        if (leaked.length) throw new Error(`the frame requested ${leaked.join(", ")}`);
        // Blocked, the frame shows the browser's own error page; the page
        // puts its document back, and the page shown again.
        for (let i = 0; i < 50; i++) {
            if (await frame(`document.getElementById("p")?.textContent`).catch(() => "") === "scripted") return "the frame was put back";
            await sleep(100);
        }
        throw new Error("the frame wasn't put back after being navigated away");
    });

    await step("a link loads the next page through the engine", async () => {
        await frameClick("#next");
        await waitFor(`document.title.startsWith("Second")`, "the second page", 30000);
        if (!(await ev(`(document.getElementById("go_url").dataset.url || document.getElementById("go_url").value)`)).endsWith("/second.html")) throw new Error("the address bar didn't follow");
    });

    await step("back and forward", async () => {
        await ev(`document.getElementById("go_back").click()`);
        await waitFor(`document.title.startsWith("Fixture")`, "the first page again", 30000);
        await ev(`document.getElementById("go_forward").click()`);
        await waitFor(`document.title.startsWith("Second")`, "the second page again", 30000);
        await ev(`document.getElementById("go_back").click()`);
        await waitFor(`document.title.startsWith("Fixture")`, "the first page", 30000);
    });

    await step("a link within the page scrolls, without a load", async () => {
        await pageShown();
        for (let i = 0; i < 50 && !(await frame(`!!document.getElementById("jump")`).catch(() => false)); i++) await sleep(100);
        await frameClick("#jump");
        await waitFor(`(document.getElementById("go_url").dataset.url || document.getElementById("go_url").value).endsWith("#end")`, "the address with #end");
        const y = await frame(`scrollY`);
        if (!(y > 1000)) throw new Error(`scrolled to ${y}`);
    });

    await step("the address shows its site till edited, the menu has the other pages, and the device's back goes back a page", async () => {
        await goTo(site + "second.html", "Second");
        const siteShown = (new URL(site).protocol === "https:" ? "" : "http://") + new URL(site).host.replace(/^www\./, "");
        const bar = await ev(`(() => { const a = document.getElementById("go_url"); return { value: a.value, url: a.dataset.url }; })()`);
        if (bar.value !== siteShown || !bar.url.endsWith("/second.html")) throw new Error(`the bar shows ${JSON.stringify(bar)}`);
        // The site's button at its start: its controls, not https said (the test site's http), out of the way while it's edited.
        const siteHost = new URL(site).hostname;
        await waitFor(`(() => { const b = document.getElementById("go_site"); return !b.hidden && b.classList.contains("insecure") && b.title.startsWith(${JSON.stringify("Site controls for " + siteHost + "; not secure")}) && b.getBoundingClientRect().right <= document.getElementById("go_url").getBoundingClientRect().left + parseFloat(getComputedStyle(document.getElementById("go_url")).paddingLeft); })()`, "the site's button, at the address's start, before its text");
        await ev(`document.getElementById("go_url").focus()`);
        if (!(await ev(`document.getElementById("go_url").value`)).endsWith("/second.html")) throw new Error("the whole address isn't there to edit");
        if (!(await ev(`document.getElementById("go_site").hidden`))) throw new Error("the site's button while the address is edited");
        await ev(`document.getElementById("go_url").blur()`);
        await waitFor(`document.getElementById("go_url").value === ${JSON.stringify(siteShown)} && !document.getElementById("go_site").hidden`, "the site again, not edited");
        // The menu: display modes, then the pages and logging out.
        await ev(`document.getElementById("go_menu").click()`);
        const items = await ev(`[...document.querySelectorAll("#go_menu_panel .label")].filter((l) => l.getClientRects().length).map((l) => l.textContent).join()`);
        // (The other pages are those the server has: Files, Terminal...)
        if (items !== "Settings") throw new Error(`the menu has ${items}`);
        // Its first row: what's done most, each a glyph over its name (Forward's in the bar here, not a phone's;
        // a computer's: Mobile, the other pages than its own, offered).
        const actions = await ev(`[...document.querySelectorAll("#go_menu_actions button")].filter((b) => b.getClientRects().length).map((button) => ({ name: button.textContent, top: button.getBoundingClientRect().top, glyph: !!button.querySelector("svg"), under: button.querySelector("svg")?.getBoundingClientRect().bottom <= button.querySelector(".caption").getBoundingClientRect().top }))`);
        if (actions.map((action) => action.name).join() !== "Mobile,Full screen,Hide browser" ||
            actions.some((action) => !action.glyph || !action.under) || new Set(actions.map((action) => action.top)).size !== 1) throw new Error(`the menu's first row: ${JSON.stringify(actions)}`);
        if (await ev(`document.getElementById("go_menu_actions").compareDocumentPosition(document.getElementById("go_menu_settings")) & Node.DOCUMENT_POSITION_PRECEDING`)) throw new Error("Settings above the first row");
        // The other pages and logging out: one row, icons only (named for a
        // screen reader), logging out last.
        const pages = await ev(`[...document.querySelectorAll("#go_menu_panel .tabtop-nav > .page, #go_menu_panel .tabtop-nav > button")].filter((p) => p.getClientRects().length).map((p) => ({ top: Math.round(p.getBoundingClientRect().top), name: p.getAttribute("aria-label") }))`);
        const hasFiles = pages.some((p) => p.name?.startsWith("Files ("));
        if (hasFiles !== (process.env.GO_NO_FS !== "1") || new Set(pages.map((p) => p.top)).size !== 1 || pages.some((p) => !p.name || /Browser/.test(p.name)) || !/^Log out/.test(pages.at(-1).name)) throw new Error(`the pages: ${JSON.stringify(pages)}`);
        // Set apart: the browser's items, then the other pages, then logging out.
        const parts = await ev(`(() => { const nav = document.querySelector("#go_menu_panel .tabtop-nav"), sep = nav.querySelector(".sep");
            return { navLine: getComputedStyle(nav).borderTopWidth, sep: sep ? Math.round(sep.getBoundingClientRect().height) : 0, before: sep?.nextElementSibling?.textContent, after: sep?.previousElementSibling?.textContent }; })()`);
        if (parts.navLine !== "1px" || !(parts.sep > 10) || parts.before !== "Log out" || !parts.after) throw new Error(`the menu's parts: ${JSON.stringify(parts)}`);
        await ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
        await waitFor(`document.getElementById("go_menu_panel").hidden`, "the menu closed");
        // The device's back (the tab's history: a swipe, a button): a page
        // back here, still on this page.
        const here = await ev(`location.href`);
        await ev(`history.back()`);
        await waitFor(`document.title.startsWith("Second") === false && !document.getElementById("go_url").dataset.url.endsWith("/second.html")`, "the page before", 30000);
        if ((await ev(`location.href`)) !== here) throw new Error("left the browser page");
        await ev(`history.forward()`);
        await waitFor(`document.getElementById("go_url").dataset.url.endsWith("/second.html")`, "forward again", 30000);
    });

    await step("Site controls and Settings open in a lightbox over the page, and close back to it", async () => {
        const here = await ev(`document.getElementById("go_url").dataset.url`);
        const inside = (expr) => ev(`(() => { const d = document.querySelector("#go_settings iframe").contentDocument; return !!d && (${expr}); })()`);
        await ev(`document.getElementById("go_site").click()`);
        await waitFor(`document.getElementById("go_settings").open`, "the lightbox open");
        await waitFor(`(() => { const d = document.querySelector("#go_settings iframe").contentDocument; return !!d?.getElementById("popups") && !!d.getElementById("cookies") && d.documentElement.classList.contains("framed") && getComputedStyle(d.querySelector("header")).display === "none"; })()`, "the settings in it, its own header not shown", 15000);
        const host = new URL(here).hostname;
        await waitFor(`(() => { const d = document.querySelector("#go_settings iframe").contentDocument; return !d.getElementById("site_settings").hidden && d.getElementById("site_heading").textContent === ${JSON.stringify(host)} && d.getElementById("popups").value === "default" && d.getElementById("popups").selectedOptions[0].textContent === "Default (Ask)"; })()`, "the current site and its default permission");
        // Content then Privacy: Videos and sound, Pop-ups, Notifications, Dark mode, Ads.
        {
            const order = await inside(`[...d.querySelectorAll("#site_settings [data-setting]")].map((el) => el.dataset.setting).join()`);
            if (order !== "videos,popups,notifications,theme,ads") throw new Error(`site settings order: ${order}`);
        }
        await inside(`(d.getElementById("show_all").click(), true)`);
        await waitFor(`(() => { const d = document.querySelector("#go_settings iframe").contentDocument; return !d.getElementById("all_sites").hidden && d.activeElement === d.getElementById("filter"); })()`, "All sites opens with search focused");
        await inside(`(d.getElementById("show_browser").click(), true)`);
        await waitFor(`(() => { const d = document.querySelector("#go_settings iframe").contentDocument; return !d.getElementById("browser_settings").hidden && d.getElementById("site_settings").hidden && d.getElementById("default_popups").value === "ask" && !!d.getElementById("clear_cache"); })()`, "browser-wide settings in their own view");
        {
            const order = await inside(`[...[...d.querySelectorAll("#browser_settings .card")].find((c) => c.querySelector("h3")?.textContent === "Site defaults").querySelectorAll("select")].map((el) => el.id).join()`);
            if (order !== "default_videos,default_popups,default_theme") throw new Error(`Site defaults order: ${order}`);
        }
        if ((await ev(`document.getElementById("go_settings_h").textContent`)) !== "Site controls") throw new Error("the lightbox isn't titled Site controls");
        if (await inside(`!!d.getElementById("adblock_on")`)) throw new Error("ad blocking is in Site controls");
        // The page's own close (its header's link) closes it; so do ✕ and Esc.
        await inside(`(d.getElementById("back").click(), true)`);
        await waitFor(`!document.getElementById("go_settings").open`, "closed by the page's link");
        // Settings from the menu: its own page, ad blocking in it.
        await ev(`document.getElementById("go_menu").click(); document.getElementById("go_menu_settings").click()`);
        await waitFor(`(() => { const d = document.querySelector("#go_settings iframe")?.contentDocument; return d?.getElementById("adblock_on")?.disabled === false && d.querySelectorAll("#ad_lists li").length >= 2 && !d.getElementById("site_settings") && !d.getElementById("default_popups") && d.documentElement.classList.contains("framed"); })()`, "Settings from the menu", 15000).catch(async (err) => {
            const shows = await ev(`(() => { const d = document.querySelector("#go_settings iframe")?.contentDocument; return JSON.stringify({ at: d?.location.pathname, done: d?.getElementById("done")?.textContent, on: d?.getElementById("adblock_on")?.disabled, lists: d?.querySelectorAll("#ad_lists li").length }); })()`);
            throw new Error(`${err.message} (it shows ${shows})`);
        });
        if ((await ev(`document.getElementById("go_settings_h").textContent`)) !== "Settings") throw new Error("the lightbox isn't titled Settings");
        // DNS over HTTPS: off at first; a custom server's address that isn't
        // https refused, said; off again.
        {
            const d = `document.querySelector("#go_settings iframe").contentDocument`;
            if ((await ev(`${d}.getElementById("doh").value`)) !== "off") throw new Error("DNS over HTTPS isn't off at first");
            await ev(`(() => { const s = ${d}.getElementById("doh"); s.value = "custom"; s.dispatchEvent(new Event("change")); })()`);
            await waitFor(`!${d}.getElementById("doh_custom").hidden`, "the custom server's address asked for");
            await ev(`(() => { const i = ${d}.getElementById("doh_url"); i.value = "http://dns.example/dns-query"; i.dispatchEvent(new Event("input")); ${d}.getElementById("doh_save").click(); })()`);
            await waitFor(`/https address/.test(${d}.getElementById("done").textContent)`, "a non-https DoH server refused, said", 15000);
            await ev(`(() => { const s = ${d}.getElementById("doh"); s.value = "off"; s.dispatchEvent(new Event("change")); })()`);
            await waitFor(`${d}.getElementById("done").textContent === "DNS over HTTPS is off." && ${d}.getElementById("doh_custom").hidden`, "DNS over HTTPS off again", 15000);
            // Local DNS records: a name that isn't one refused, said; one
            // for the fixture's site added, listed (an A record).
            const add = (name, addr) => ev(`(() => { const d = ${d}; d.getElementById("host_name").value = ${JSON.stringify(name)}; d.getElementById("host_addr").value = ${JSON.stringify(addr)}; d.getElementById("host_addr").dispatchEvent(new Event("input")); d.getElementById("host_add_button").click(); })()`);
            await add("not a name", "192.0.2.1");
            await waitFor(`(() => { const e = ${d}.getElementById("host_name_error"); return !e.hidden && /Letters, digits/.test(e.textContent) && ${d}.getElementById("host_name").getAttribute("aria-invalid") === "true" && !${d}.querySelector("#host_list li"); })()`, "a record's bad name refused, said by the field", 15000);
            await add("fixture.home.arpa", new URL(site).hostname);
            await waitFor(`(() => { const li = ${d}.querySelector("#host_list li"); return ${d}.getElementById("done").textContent === "Record added." && li?.querySelector(".name").textContent === "fixture.home.arpa" && li.querySelector(".kind").textContent === "A" && !${d}.getElementById("host_name").value; })()`, "the record listed", 15000);
        }
        await closeSettings("Settings closed by ✕");
        await ev(`document.getElementById("go_site").click()`);
        await waitFor(`document.getElementById("go_settings").open`, "open again");
        await closeSettings("closed by ✕");
        await ev(`document.getElementById("go_site").click()`);
        await waitFor(`document.getElementById("go_settings").open`, "open once more");
        await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
        await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
        await waitFor(`!document.getElementById("go_settings").open`, "closed by Esc");
        if ((await ev(`document.getElementById("go_url").dataset.url`)) !== here) throw new Error("the page changed under it");
        // The browser's history as it was: the device's back still a page
        // of the tab's (the lightbox's frames weren't entries of it).
        // (Removed as the dialog's close event comes, just after it's shut.)
        await waitFor(`!document.querySelector("#go_settings iframe")`, "its frame gone", 2000);
    });

    await step("Settings: records by name, edited in place, hosts lines pasted; unsaved filters asked of; settings exported and imported", async () => {
        const d = `document.querySelector("#go_settings iframe")?.contentDocument`;
        const w = `document.querySelector("#go_settings iframe").contentWindow`;
        await ev(`document.getElementById("go_menu").click(); document.getElementById("go_menu_settings").click()`);
        await waitFor(`${d}?.getElementById("host_name")?.disabled === false && ${d}.getElementById("settings_export").disabled === false`, "Settings", 15000);
        const done = (text, what) => waitFor(`${d}.getElementById("done").textContent === ${JSON.stringify(text)}`, what, 15000);
        const add = async (name, addr) => {
            await ev(`(() => { const d = ${d}; d.getElementById("host_name").value = ${JSON.stringify(name)}; d.getElementById("host_addr").value = ${JSON.stringify(addr)}; d.getElementById("host_addr").dispatchEvent(new Event("input")); d.getElementById("host_add").requestSubmit(); })()`);
            await waitFor(`${d}.getElementById("done").textContent === "Record added." && !${d}.getElementById("host_name").value && ${d}.getElementById("host_list").textContent.includes(${JSON.stringify(addr)})`, "added " + addr, 15000);
        };
        // Exported first, to put back at the end.
        await ev(`(() => { const w = ${w}; w.__blob = null; w.URL.createObjectURL = (b) => (w.__blob = b, "blob:none"); w.HTMLAnchorElement.prototype.click = function () { w.__saved = this.download; }; w.document.getElementById("settings_export").click(); })()`);
        await waitFor(`!!${w}.__blob && ${w}.__saved === "tabtop-browser-settings.json"`, "the settings exported");
        const before = await ev(`${w}.__blob.text()`);
        const was = JSON.parse(before);
        if (was.tabtop !== "go-settings" || !Array.isArray(was.hosts) || !was.hosts.some((h) => h.name === "fixture.home.arpa") || !was.adblock?.lists?.length) throw new Error(`the export: ${before}`);
        // One name's two addresses, one entry; the A record edited in place.
        await add("nas.home.arpa", "192.168.1.10");
        await add("nas.home.arpa", "fd00::10");
        const nas = `[...${d}.querySelectorAll("#host_list li")].find((li) => li.querySelector(".name").textContent === "nas.home.arpa")`;
        if ((await ev(`${nas}.querySelectorAll(".addr-row").length`)) !== 2) throw new Error("the name's addresses aren't together");
        await ev(`${d}.querySelector('#host_list button[aria-label="Edit nas.home.arpa 192.168.1.10"]').click()`);
        await waitFor(`${d}.getElementById("host_add_button").textContent === "Save record" && ${d}.getElementById("host_addr").value === "192.168.1.10"`, "the record in the form to edit");
        await ev(`(() => { const a = ${d}.getElementById("host_addr"); a.value = "192.168.1.11"; a.dispatchEvent(new Event("input")); ${d}.getElementById("host_add").requestSubmit(); })()`);
        await done("Record saved.", "the record saved");
        if ((await ev(`[...${nas}.querySelectorAll(".addr")].map((a) => a.textContent).join()`)) !== "192.168.1.11,fd00::10") throw new Error("not edited in place");
        // Hosts lines pasted: each name a record; what can't be, said.
        await ev(`${d}.getElementById("hosts_paste").click()`);
        await ev(`(() => { const t = ${d}.getElementById("hosts_text"); t.value = "10.0.0.5 tv.home.arpa tv\\nbad line here\\n10.0.0.6"; t.dispatchEvent(new Event("input")); })()`);
        await waitFor(`${d}.getElementById("hosts_dialog_add").textContent === "Add 2 records" && ${d}.querySelectorAll("#hosts_text_problems li").length === 2`, "the lines read");
        await ev(`${d}.getElementById("hosts_paste_form").requestSubmit()`);
        await done("2 records added.", "the pasted records added");
        // My filters edited, not saved: marked, and asked of before closing.
        await ev(`(() => { const t = ${d}.getElementById("my_filters"); t.value += "\\n||unsaved.example^"; t.dispatchEvent(new Event("input")); })()`);
        await waitFor(`!${d}.getElementById("filters_unsaved").hidden && !${d}.getElementById("discard_filters").hidden`, "marked unsaved");
        await ev(`window.__asked = 0; window.__confirm = window.confirm; window.confirm = () => (window.__asked++, false)`);
        // ✕ with filters unsaved: asked first (and, as it's said no, not closed).
        await ev(`document.querySelector("#go_settings .close").click()`);
        await waitFor(`window.__asked >= 1`, "asked about the unsaved filters");
        if (!(await ev(`document.getElementById("go_settings").open && window.__asked === 1`))) throw new Error("closed on unsaved filters without asking");
        await ev(`window.confirm = window.__confirm`);
        await ev(`${d}.getElementById("discard_filters").click()`);
        await waitFor(`${d}.getElementById("filters_unsaved").hidden && !${d}.getElementById("my_filters").value.includes("unsaved.example")`, "the changes discarded");
        // Imported: what it can be, what it can't said; then the export put back.
        const load = (text) => ev(`(() => { const w = ${w}; w.confirm = () => true; const dt = new w.DataTransfer(); dt.items.add(new w.File([${JSON.stringify(text)}], "settings.json", { type: "application/json" })); const i = w.document.getElementById("settings_file"); i.files = dt.files; i.dispatchEvent(new w.Event("change")); })()`);
        await load(JSON.stringify({ ...was, searchEngine: "bing", doh: "nosuch", hosts: [{ name: "imported.home.arpa", addr: "192.0.2.9" }] }));
        await waitFor(`/Not imported: DNS over HTTPS/.test(${d}.getElementById("done").textContent) && /search engine/.test(${d}.getElementById("done").textContent)`, "the import, said in part", 20000);
        if ((await ev(`${d}.getElementById("search_engine").value + " " + [...${d}.querySelectorAll("#host_list .name")].map((n) => n.textContent).join()`)) !== "bing imported.home.arpa") throw new Error("not imported");
        await load(before);
        await done("Settings imported.", "the export put back");
        if ((await ev(`${d}.getElementById("search_engine").value + " " + [...${d}.querySelectorAll("#host_list .name")].map((n) => n.textContent).join()`)) !== `${was.searchEngine} fixture.home.arpa`) throw new Error("the export not put back");
        await closeSettings("Settings closed");
    });

}
