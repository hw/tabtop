// The remote browser's check (go-check.mjs), its steps of frames' canvases,
// certificate warnings, local DNS records, connections lost.
import { readFileSync } from "node:fs";
import { sleep } from "../harness.mjs";
import { step } from "./step.mjs";

// certsNet runs them, with ctx: the check's browser, the site it browses, and its helpers (see check).
export async function certsNet(ctx) {
    const { goTo, site, frameWait, frame, adSite, ev, frameClick, submitUrl, waitFor, closeSettings, leave, base, cdp } = ctx;
    await step("a 2D canvas in a same-origin frame is shown as it's drawn again", async () => {
        await goTo(site + "c2dframe.html", "Canvas frame");
        const pixel = `(() => { const c = document.getElementById("f")?.shadowRoot?.getElementById("c"); try { return c ? [...c.getContext("2d").getImageData(10, 10, 1, 1).data].slice(0, 3).join() : ""; } catch { return ""; } })()`;
        await frameWait(`${pixel} === "255,0,0"`, "the frame's canvas, red", 20000);
        await frameWait(`${pixel} === "0,0,255"`, "the frame's canvas, drawn blue", 15000);
    });

    await step("a WebGL canvas taken out of the page and put back is mirrored again", async () => {
        await goTo(site + "glback.html", "GL back");
        await frameWait(`document.getElementById("s")?.textContent === "back"`, "the canvas put back", 20000);
        // (Mirrored: its title says so, no aria-label; unavailable: both say that.)
        await frameWait(`document.getElementById("c")?.title === "WebGL rendering mirrored from the remote page"`, "the canvas mirrored again", 15000).catch(async (err) => {
            throw new Error(`${err.message} (it says ${await frame(`document.getElementById("c")?.title`)})`);
        });
    });

    await step("a same-origin frame's own frame is shown, and its changes", async () => {
        await goTo(site + "nestframe.html", "Nest frame");
        const deep = (want) => `(() => { const seen = (root) => { if (root.textContent?.includes(${JSON.stringify(want)})) return true; for (const el of root.querySelectorAll("*")) if (el.shadowRoot && seen(el.shadowRoot)) return true; return false; }; return seen(document); })()`;
        await frameWait(deep("first"), "the inner page", 20000);
        await frameWait(deep("later"), "the inner page's change", 15000);
        await goTo(site + "index.html", "Fixture");
    });

    if (adSite) await step("a field in another origin's frame, in a third's that keeps changing, keeps the focus as it's redrawn", async () => {
        await goTo(site + "nestfocus.html?c=" + encodeURIComponent(adSite + "nestfocusin.html"), "Nest focus");
        const deep = `const deep = (root, sel) => { const hit = root.querySelector(sel); if (hit) return hit; for (const el of root.querySelectorAll("*")) if (el.shadowRoot) { const f = deep(el.shadowRoot, sel); if (f) return f; } return null; };`;
        const active = `(() => { let a = document.activeElement; while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement; return a?.tagName; })()`;
        await frameWait(`(() => { ${deep} return !!deep(document, "input"); })()`, "the innermost frame's field", 30000);
        // The page's frame given the focus first, as a click into it would:
        // a sandboxed frame without it can't take it by script (Chrome 158,
        // measured; once it has it, script moves it within).
        await ev(`document.getElementById("go_view").focus()`);
        await frame(`(() => { ${deep} deep(document, "input").focus(); })()`);
        if ((await frame(active)) !== "INPUT") throw new Error("the field couldn't be focused");
        const tick = () => frame(`(() => { ${deep} return deep(document, "#tick")?.textContent; })()`);
        const was = await tick();
        await frameWait(`(() => { ${deep} return Number(deep(document, "#tick")?.textContent) >= ${Number(was) + 3}; })()`, "the middle frame redrawn", 15000);
        if ((await frame(active)) !== "INPUT") throw new Error(`the field lost the focus as the frame holding it was redrawn (now on ${await frame(active)})`);
        await goTo(site + "index.html", "Fixture");
    });

    await step("a site whose certificate isn't trusted: TabTop's warning, Back, then Continue (an exception, this tab), its pictures too", async () => {
        // The page's own link to href (certlink.html), clicked: followed by
        // the engine.
        const frameClickLink = async (href) => {
            await goTo(site + "certlink.html?to=" + encodeURIComponent(href), "Cert link");
            await frameWait(`!!document.getElementById("to")`, "the link");
            await sleep(300);  // (its address set by its script, in the engine)
            await frameClick("#to");
        };
        const secure = site.replace(/^http:/, "https:");
        const ask = submitUrl;
        await goTo(site + "second.html", "Second");
        await ask(secure + "index.html");
        await waitFor(`!document.getElementById("go_cert").hidden`, "the certificate warning", 30000);
        const said = await ev(`[document.getElementById("go_cert_reason").textContent, document.querySelector("#go_cert .details").textContent]`);
        if (!/authority|another site/.test(said[0]) || !/tabtop-untrusted\.test/.test(said[1])) throw new Error(`the warning says ${JSON.stringify(said)}`);
        if ((await frame(`document.title`).catch(() => "")) === "Fixture") throw new Error("the untrusted site's page shown");
        // Back: where it was.
        await ev(`document.querySelector("#go_cert .back").click()`);
        await waitFor(`document.getElementById("go_cert").hidden && document.title.startsWith("Second")`, "back from the warning");
        // Continue: shown, marked, its pictures (TabTop's own fetches) too.
        await ask(secure + "index.html");
        await waitFor(`!document.getElementById("go_cert").hidden`, "the warning again (nothing's kept without Continue)", 30000);
        await ev(`document.querySelector("#go_cert .go").click()`);
        await waitFor(`document.title.startsWith("Fixture")`, "the page, continued to", 30000);
        if (!/certificate isn’t trusted/.test(await ev(`document.getElementById("go_site").title`))) throw new Error(`the site's button says ${await ev(`document.getElementById("go_site").title`)}`);
        // Site controls says so too, not "Secure".
        await ev(`document.getElementById("go_site").click()`);
        await waitFor(`!!document.querySelector("#go_settings iframe")?.contentDocument?.querySelector("#site_scope .badge")`, "Site controls, its badge", 15000);
        const badge = await ev(`document.querySelector("#go_settings iframe").contentDocument.querySelector("#site_scope .badge").textContent`);
        await closeSettings("Site controls closed");
        if (badge !== "Certificate not trusted") throw new Error(`Site controls says the excepted page is ${JSON.stringify(badge)}`);
        await frameWait(`document.getElementById("img")?.naturalWidth > 0`, "its picture, through the tab's exception");
        // Its link to another page of it: no warning (the tab's exception).
        await ask(secure + "second.html");
        await waitFor(`document.title.startsWith("Second")`, "another page of it, no warning", 30000);
        if (!(await ev(`document.getElementById("go_cert").hidden`))) throw new Error("warned again, the host an exception");
        // A link the page follows to another site whose certificate isn't
        // trusted (not an exception): warned of too.
        const other = adSite.replace(/^http:/, "https:");
        await frameClickLink(other + "index.html");
        await waitFor(`!document.getElementById("go_cert").hidden && document.querySelector("#go_cert .host").textContent === ${JSON.stringify(new URL(other).hostname)}`, "the warning for the link's site", 30000);
        await ev(`document.querySelector("#go_cert .back").click()`);
        await waitFor(`document.getElementById("go_cert").hidden`, "back from it");
        await goTo(site + "index.html", "Fixture");  // (where the steps after begin)
    });

    await step("a local DNS record's name is reached at its address (before the system's DNS, which doesn't know it); removed, it isn't", async () => {
        // (In a tab of its own, its history left to it; each load its own
        // address, not one the engines' shared cache could have from before.)
        await leave(`sessionStorage.clear(); location.href = ${JSON.stringify(new URL("go/tab", base).href)};`, { what: "a tab of its own, connected", ready: `document.getElementById("go_progress")?.hidden` });
        // Its record set here (the Settings step adds the same one through
        // its form), so this step runs on its own too (GO_ONLY, GO_FROM).
        const hosts = (list) => ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call({ type: "go-settings-set", setting: "hosts", hosts: ${JSON.stringify(list)} }); t.close(); })`);
        await hosts([{ name: "fixture.home.arpa", addr: new URL(site).hostname }]);
        await goTo(`http://fixture.home.arpa/index.html?local=${Date.now()}`, "Fixture");
        await hosts([]);
        const ask = submitUrl;
        await ask(`http://fixture.home.arpa/second.html?local=${Date.now()}`);
        await waitFor(`!document.getElementById("go_notice").hidden`, "the name not found, its record removed", 30000);
        await goTo(site + "index.html", "Fixture");
    });

    await step("a script fetched under a tab's certificate exception isn't run in another tab from the engines' shared cache", async () => {
        const secure = site.replace(/^http:/, "https:");
        const ask = submitUrl;
        // (Each in a tab of its own: the step before excepted this host in its.)
        const freshTab = async () => {
            await leave(`sessionStorage.clear(); location.href = ${JSON.stringify(new URL("go/tab", base).href)};`, { what: "a tab of its own, connected", ready: `document.getElementById("go_progress")?.hidden` });
        };
        await freshTab();
        await ask(secure + "certpage.html");
        await waitFor(`!document.getElementById("go_cert").hidden`, "the warning", 30000);
        await ev(`document.querySelector("#go_cert .go").click()`);
        await waitFor(`document.title.startsWith("Cached ran")`, "the excepted page, its script run", 30000);
        // Another tab (no exception): a trusted page using that script.
        await freshTab();
        await goTo(site + "cachehost.html", "Cache host");
        await sleep(4000);
        if (/Cached ran/.test(await ev(`document.title`))) throw new Error("another tab ran the script fetched under the first's certificate exception");
        await goTo(site + "index.html", "Fixture");
    });

    await step("a connection lost, then back another way (a page loaded): its banner goes at once, not at its next try", async () => {
        // The page's sockets known, and while __down, new ones refused (a
        // path of TabTop's own that isn't a tunnel's): as a network gone.
        const { identifier } = await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
            if (window !== top) return;
            const W = WebSocket;
            window.__sockets = [];
            window.__down = false;
            window.WebSocket = class extends W {
                constructor(url, protocols) {
                    super(window.__down ? String(url).replace(/^(wss?:\\/\\/[^/]+).*$/, "$1/go-check-down") : url, protocols);
                    window.__sockets.push(this);
                }
            };
        })()` });
        try {
            await leave(`location.reload();`, { what: "the page again, its sockets known", ready: `window.__sockets?.some((s) => s.readyState === 1) && document.getElementById("go_progress")?.hidden` });
            await ev(`window.__down = true; for (const s of window.__sockets) s.close()`);
            await waitFor(`/Connection lost/.test(document.getElementById("tabtop_reconnect")?.textContent ?? "")`, "the connection said lost", 15000);
            // Its own tries failing, the next one a while off.
            await waitFor(`/Trying again in [5-8] s/.test(document.getElementById("tabtop_reconnect")?.textContent ?? "")`, "its tries failing", 30000);
            await ev(`window.__down = false; (() => { const i = document.getElementById("go_url"); i.value = ${JSON.stringify(site + "second.html")}; i.form.requestSubmit(); })()`);
            await waitFor(`!document.getElementById("tabtop_reconnect")`, "the banner gone as it's connected", 3000);
            await waitFor(`document.title.startsWith("Second")`, "the page loaded", 30000);
        } finally {
            await cdp("Page.removeScriptToEvaluateOnNewDocument", { identifier });
        }
    });

    await step("a page coloured by its body's attributes (bgcolor, text) is shown in its colours", async () => {
        await goTo(site + "bgcolor.html", "Bgcolor");
        await frameWait(`!!document.getElementById("t")`, "the page");
        const colours = await frame(`JSON.stringify({ bg: getComputedStyle(document.body).backgroundColor, text: getComputedStyle(document.getElementById("t")).color })`);
        if (colours !== JSON.stringify({ bg: "rgb(0, 0, 0)", text: "rgb(255, 255, 255)" })) throw new Error(`the copy's colours: ${colours}`);
    });

    await step("Continue pressed on a certificate warning while the connection's lost is done once it's back", async () => {
        const { identifier } = await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
            if (window !== top) return;
            const W = WebSocket;
            window.__sockets = [];
            window.__down = false;
            window.WebSocket = class extends W {
                constructor(url, protocols) {
                    super(window.__down ? String(url).replace(/^(wss?:\\/\\/[^/]+).*$/, "$1/go-check-down") : url, protocols);
                    window.__sockets.push(this);
                }
            };
        })()` });
        try {
            // A tab of its own (no exception yet), its sockets known.
            await leave(`sessionStorage.clear(); location.href = location.origin + location.pathname.replace(/\\/go\\/.*$/, "/go/tab");`, { what: "a tab of its own, connected", ready: `document.getElementById("go_progress")?.hidden && window.__sockets?.some((s) => s.readyState === 1)` });
            const secure = site.replace(/^http:/, "https:");
            await submitUrl(secure + "index.html?offline-continue");
            await waitFor(`!document.getElementById("go_cert").hidden`, "the certificate warning", 30000);
            await ev(`window.__down = true; for (const s of window.__sockets) s.close()`);
            await waitFor(`/Connection lost/.test(document.getElementById("tabtop_reconnect")?.textContent ?? "")`, "the connection said lost", 15000);
            await ev(`document.querySelector("#go_cert .go").click()`);
            await ev(`window.__down = false; document.querySelector("#tabtop_reconnect button")?.click()`);
            await waitFor(`document.title.startsWith("Fixture") && document.getElementById("go_cert").hidden && !document.getElementById("tabtop_reconnect")`, "the page continued to, once connected", 30000);
            // Loaded once: the Continue said on taking the tab back, not
            // the page's address loaded again too (go-reload) to replace it.
            if (process.env.GO_LOG) {
                const ops = readFileSync(process.env.GO_LOG, "utf8").split("\n").filter((l) => /go-debug: op (cert-continue|navigate) /.test(l));
                const after = ops.slice(ops.findLastIndex((l) => / op cert-continue /.test(l)) + 1);
                if (after.length) throw new Error(`loaded again after Continue: ${after.join(" / ")}`);
            }
        } finally {
            await cdp("Page.removeScriptToEvaluateOnNewDocument", { identifier });
        }
    });

}
