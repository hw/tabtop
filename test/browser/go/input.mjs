// The remote browser's check (go-check.mjs), its steps of links, buttons,
// typing, rich text, web components, forms, dialogs, the search engine, a
// page's file input, drops, restarting the engine, redirects.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sleep, totp } from "../harness.mjs";
import { step } from "./step.mjs";

// input runs them, with ctx: the check's browser, the site it browses, and its helpers (see check).
export async function input(ctx) {
    const { site, ev, waitFor, stillNot, goTo, frameWait, frameClick, browser, frame, cdp, viewOrigin, adSite, closeSettings, submitUrl, frameDrop } = ctx;
    await step("an address in a link from elsewhere waits for Enter", async () => {
        const url = site + "result.html?q=linked";
        // In one go, to a new address: the page there before can't put its
        // own address back in between.
        await ev(`sessionStorage.clear(); location.replace(location.pathname + "?linked#" + ${JSON.stringify(url)})`);
        await waitFor(`!!document.getElementById("go_url") && (document.getElementById("go_url").dataset.url || document.getElementById("go_url").value) === ${JSON.stringify(url)}`, "the address waiting", 30000);
        if ((await ev(`location.hash`)) !== "") throw new Error("the linked address stayed in the tab's address");
        await stillNot(ev, `document.title.startsWith("Result")`, "it loaded without Enter", 1500);
        await ev(`document.getElementById("go_url").form.requestSubmit()`);
        await waitFor(`document.title.startsWith("Result")`, "the page, after Enter", 30000);
    });

    await step("a button that changes the page, done in the engine", async () => {
        await goTo(site + "interact.html", "Interact");
        await frameWait(`!!document.getElementById("add")`, "the page");
        await frameClick("#add");
        await frameWait(`document.getElementById("list").textContent.includes("item 1")`, "the item the page's script added");
        await frameClick("#add");
        await frameWait(`document.getElementById("list").children.length === 2`, "a second item");
    });

    await step("a change the page makes by itself, after loading", async () => {
        await frameWait(`document.getElementById("late")?.textContent === "late"`, "the late paragraph");
    });

    await step("typing, then Enter, with no form; the field cleared by the page", async () => {
        await frameClick("#todo");
        await browser.type("milk");
        await browser.press("Enter");
        await frameWait(`document.getElementById("list").textContent.includes("todo milk")`, "the to-do");
        await frameWait(`document.getElementById("todo").value === ""`, "the field cleared");
    });

    await step("rich text (contenteditable): typed, deleted, a new paragraph, text put in (a phone's keyboard, a paste), in the engine's page; a chat box's Enter sends", async () => {
        await goTo(site + "editable.html", "Editable");
        const engine = (text) => frameWait(`document.getElementById("got").textContent === ${JSON.stringify("engine: " + text)}`, `the engine's page to hold ${JSON.stringify(text)}`);
        const shown = (text) => frameWait(`[...document.getElementById("ed").childNodes].map((n) => n.textContent).join("|") === ${JSON.stringify(text)}`, `the copy to show ${JSON.stringify(text)}`);
        // The caret at the end of "hello", here.
        await frameClick("#ed p");
        await frame(`(() => { const t = document.querySelector("#ed p").firstChild; getSelection().setBaseAndExtent(t, 5, t, 5); })()`);
        await browser.type(" world");
        await engine("hello world");
        await shown("hello world");
        // A key that doesn't edit between two that do (Shift, for a capital):
        // the caret's not moved by it.
        await browser.type("a");
        await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 8 });
        await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 });
        await browser.type("B");
        await engine("hello worldaB");
        for (let i = 0; i < 2; i++) await browser.press("Backspace");
        await engine("hello world");
        for (let i = 0; i < 5; i++) await browser.press("Backspace");
        await engine("hello ");
        await shown("hello ");
        await browser.press("Enter");
        await browser.type("two");
        await engine("hello |two");
        await shown("hello |two");
        // Text put in, not typed (a phone's keyboard, an IME's word).
        await cdp("Input.insertText", { text: "!" });
        await engine("hello |two!");
        // An IME's word: made here as it's chosen, sent once it's done.
        await cdp("Input.imeSetComposition", { text: "o", selectionStart: 1, selectionEnd: 1 });
        await cdp("Input.imeSetComposition", { text: "ok", selectionStart: 2, selectionEnd: 2 });
        await cdp("Input.insertText", { text: "ok" });
        await engine("hello |two!ok");
        await shown("hello |two!ok");
        // A word begun as soon as a key's typed (its change coming back as
        // the word's chosen): shown once, and in the engine.
        await browser.type("Q");
        await cdp("Input.imeSetComposition", { text: "w", selectionStart: 1, selectionEnd: 1 });
        await sleep(200);
        await cdp("Input.imeSetComposition", { text: "wo", selectionStart: 2, selectionEnd: 2 });
        await sleep(400);
        await cdp("Input.insertText", { text: "wo" });
        await engine("hello |two!okQwo");
        await shown("hello |two!okQwo");
        for (let i = 0; i < 3; i++) await browser.press("Backspace");
        await engine("hello |two!ok");
        // The caret moved here (a click): typed there, not where it was.
        await frameClick("#ed p");
        await frame(`(() => { const t = document.querySelector("#ed p").firstChild; getSelection().setBaseAndExtent(t, 0, t, 0); })()`);
        await browser.type("X");
        await engine("Xhello |two!ok");
        // Backspace at a paragraph's start: the two made one.
        await frame(`(() => { const t = document.querySelectorAll("#ed p")[1].firstChild; getSelection().setBaseAndExtent(t, 0, t, 0); })()`);
        await frameClick("#ed p:nth-child(2)");
        await frame(`(() => { const t = document.querySelectorAll("#ed p")[1].firstChild; getSelection().setBaseAndExtent(t, 0, t, 0); })()`);
        await browser.press("Backspace");
        await engine("Xhello two!ok");
        await shown("Xhello two!ok");
        // A chat box: Enter sends it (the page's), not a new paragraph.
        await frameClick("#chat");
        await browser.type("hi there");
        await browser.press("Enter");
        await frameWait(`document.getElementById("sent").textContent === "hi there" && document.getElementById("chat").textContent === ""`, "the message sent, the box emptied");
        // A word made by an IME in the box, empty: once, and sent.
        await cdp("Input.imeSetComposition", { text: "y", selectionStart: 1, selectionEnd: 1 });
        await cdp("Input.imeSetComposition", { text: "yo", selectionStart: 2, selectionEnd: 2 });
        await cdp("Input.insertText", { text: "yo" });
        await frameWait(`document.getElementById("chat").textContent === "yo"`, "the word shown once");
        await sleep(500);
        if ((await frame(`document.getElementById("chat").textContent`)) !== "yo") throw new Error(`the box, after the engine's change: ${await frame(`document.getElementById("chat").textContent`)}`);
        await browser.press("Enter");
        await frameWait(`document.getElementById("sent").textContent === "hi thereyo"`, "the word sent");
        // An editor as frameworks make them: typed, deleted, typed where the
        // caret's put, its box made anew each time.
        await frameClick("#fw");
        await browser.type("abc");
        await browser.press("Backspace");
        await browser.type("d");
        await frameWait(`document.getElementById("fwgot").textContent === "model: abd"`, "the editor's model abd");
        await frameWait(`document.getElementById("fw").textContent === "abd"`, "the editor shown");
        await frameClick("#fw");
        await frame(`(() => { const t = document.getElementById("fw").firstChild; getSelection().setBaseAndExtent(t, 1, t, 1); })()`);
        await browser.type("X");
        await frameWait(`document.getElementById("fwgot").textContent === "model: aXbd"`, "X typed where the caret was put");
        // In an embedded page: typed, and Enter a new paragraph, there.
        const deep = `const deep = (root, sel) => { const hit = root.querySelector(sel); if (hit) return hit; for (const el of root.querySelectorAll("*")) if (el.shadowRoot) { const f = deep(el.shadowRoot, sel); if (f) return f; } return null; };`;
        await frameWait(`(() => { ${deep} return !!deep(document, "#fed p"); })()`, "the frame's rich text", 30000);
        const r = await frame(`(() => { ${deep} const b = deep(document, "#fed p").getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
        const f = await viewOrigin();
        for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: f.x + r.x, y: f.y + r.y, button: "left", clickCount: 1 });
        await frame(`(() => { ${deep} const t = deep(document, "#fed p").firstChild; getSelection().setBaseAndExtent(t, 2, t, 2); })()`);
        await browser.type("!");
        await frameWait(`(() => { ${deep} return deep(document, "#fgot")?.textContent === "frame: in!"; })()`, "the frame's page to hold in!");
        const focused = `(() => { let a = document.activeElement; while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement; return a?.id; })()`;
        if ((await frame(focused)) !== "fed") throw new Error(`the frame's rich text lost the focus as it was redrawn (now ${await frame(focused)})`);
        await browser.press("Enter");
        await browser.type("x");
        await frameWait(`(() => { ${deep} return deep(document, "#fgot")?.textContent === "frame: in!|x"; })()`, "the frame's page to hold in!|x");
        await goTo(site + "interact.html", "Interact");  // (the steps after's)
    });

    await step("web components: shadow roots shown (adopted styles, a slot, a closed one, one attached later), a button and rich text in one used, frames in one shown", async () => {
        await goTo(site + "shadow.html" + (adSite ? "?x=" + encodeURIComponent(adSite + "shadow-frame.html") : ""), "Shadow");
        const deep = `const deep = (root, sel) => { const hit = root.querySelector(sel); if (hit) return hit; for (const el of root.querySelectorAll("*")) if (el.shadowRoot) { const f = deep(el.shadowRoot, sel); if (f) return f; } return null; };`;
        const at = (sel) => frame(`(() => { ${deep} const e = deep(document, ${JSON.stringify(sel)}); return e ? [e.textContent, getComputedStyle(e).color, !!e.assignedSlot] : null; })()`);
        // Shown, styled by the adopted stylesheet; the host's child in its slot.
        await frameWait(`(() => { ${deep} return deep(document, "#inner")?.textContent === "inner text" && getComputedStyle(deep(document, "#inner")).color === "rgb(10, 20, 30)"; })()`, "the shadow root's content, styled by its adopted stylesheet");
        const slotted = await at("#slotted");
        if (!slotted || slotted[1] !== "rgb(40, 50, 60)" || !slotted[2]) throw new Error(`the slotted child: ${JSON.stringify(slotted)}`);
        // A closed one: shown (the page still told it's closed).
        await frameWait(`(() => { ${deep} const e = deep(document, "#secret"); return e?.textContent === "closed text" && getComputedStyle(e).color === "rgb(70, 80, 90)"; })()`, "the closed shadow root's content, with its <style>");
        // A <style> in a (closed) root filled by script: its rules, and one
        // put in later.
        const ruledColor = (c) => `(() => { ${deep} const e = deep(document, "#ruledtext"); return e?.textContent === "ruled text" && getComputedStyle(e).color === "${c}"; })()`;
        await frameWait(ruledColor("rgb(11, 22, 33)"), "a <style> in a shadow root, its rules put in by script");
        await frameClick("#rerule");
        await frameWait(ruledColor("rgb(44, 55, 66)"), "a rule put in later, in a <style> in a shadow root");
        // A closed one from its HTML (which the page's world can't open):
        // shown all the same, with its <style>.
        await frameWait(`(() => { ${deep} const e = deep(document, "#dsdclosed"); return e?.textContent === "closed, from the HTML" && getComputedStyle(e).color === "rgb(12, 13, 14)"; })()`, "a closed shadow root from the page's HTML", 15000);
        // One from its HTML, taken up by its element; one drawn once seen.
        await frameWait(`(() => { ${deep} const e = deep(document, "#declared"); return e?.getAttribute("data-taken") === "yes" && getComputedStyle(e).color === "rgb(5, 6, 7)"; })()`, "a declarative shadow root, taken up by its element");
        await frame(`(() => { ${deep} deep(document, "#lazybox").scrollIntoView({ block: "center" }); })()`);
        await frameWait(`(() => { ${deep} return deep(document, "#lazybox")?.textContent === "seen"; })()`, "what's in a shadow root seen, as the page's IntersectionObserver is told");
        // Its adopted stylesheet replaced: the copy's restyled.
        await frameClick("#restyle");
        await frameWait(`(() => { ${deep} return getComputedStyle(deep(document, "#inner")).color === "rgb(90, 91, 92)"; })()`, "the shadow root restyled as its adopted stylesheet's replaced");
        // One attached later.
        await frameClick("#define");
        await frameWait(`(() => { ${deep} return deep(document, "#later")?.textContent === "defined later"; })()`, "a shadow root attached later");
        // A button in one: pressed, in the engine.
        const clickDeep = async (sel, dx = 0.5) => {
            const r = await frame(`(() => { ${deep} const e = deep(document, ${JSON.stringify(sel)}); e.scrollIntoView({ block: "center" }); const b = e.getBoundingClientRect(); return { x: b.x + b.width * ${dx}, y: b.y + b.height / 2 }; })()`);
            const f = await viewOrigin();
            for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: f.x + r.x, y: f.y + r.y, button: "left", clickCount: 1 });
        };
        await clickDeep("#btn");
        await frameWait(`document.getElementById("clicks").textContent === "clicks 1"`, "the button in the shadow root pressed in the engine");
        // Rich text in one: typed at its end, in the engine.
        await clickDeep("#ed", 0.9);
        await frame(`(() => { ${deep} const t = deep(document, "#ed").firstChild; getSelection().setBaseAndExtent(t, 7, t, 7); })()`);
        await browser.type("!");
        await frameWait(`document.getElementById("edgot").textContent === "engine: edit me!"`, "typed in rich text in the shadow root");
        // Mid-text there: typed, deleted, a new paragraph, the caret moved.
        const edEngine = (text) => frameWait(`document.getElementById("edgot").textContent === ${JSON.stringify("engine: " + text)}`, `the rich text in the shadow root to hold ${JSON.stringify(text)}`);
        await clickDeep("#ed", 0.3);
        await frame(`(() => { ${deep} const t = deep(document, "#ed").firstChild; getSelection().setBaseAndExtent(t, 4, t, 4); })()`);
        await browser.type("abc");
        await edEngine("editabc me!");
        await browser.press("Backspace");
        await edEngine("editab me!");
        await browser.press("Enter");
        await edEngine("editab| me!");
        // The engine's caret, come back here, at the new line's start (past
        // its space, not shown, as a browser has it): one along, after "m".
        await browser.press("ArrowRight");
        await browser.type("X");
        await edEngine("editab| mXe!");
        // Frames in one: this site's, and another's.
        await frameWait(`(() => { ${deep} return deep(document, "#infr")?.textContent === "in a frame in a shadow root"; })()`, "a frame's page in the shadow root", 30000);
        if (adSite) await frameWait(`(() => { ${deep} const all = []; const walk = (root) => { for (const el of root.querySelectorAll("*")) { if (el.id === "infr") all.push(el); if (el.shadowRoot) walk(el.shadowRoot); } }; walk(document); return all.length === 2; })()`, "another site's frame's page in the shadow root too", 30000);
        // A component in each frame: its root and its adopted stylesheet.
        const framed = (n) => `(() => { const all = []; const walk = (root) => { for (const el of root.querySelectorAll("*")) { if (el.classList?.contains("finner")) all.push(getComputedStyle(el).color); if (el.shadowRoot) walk(el.shadowRoot); } }; walk(document); return all.length === ${n} && all.every((c) => c === "rgb(33, 44, 55)"); })()`;
        await frameWait(framed(adSite ? 2 : 1), "a component in each frame, styled by its adopted stylesheet", 30000);
        // A closed root from its HTML in each frame (this site's, read by
        // the page's agent; another's, by its own).
        const closedFramed = `(() => { let n = 0; const walk = (root) => { for (const el of root.querySelectorAll("*")) { if (el.classList?.contains("fdsd")) n++; if (el.shadowRoot) walk(el.shadowRoot); } }; walk(document); return n; })()`;
        await frameWait(`${closedFramed} === ${adSite ? 2 : 1}`, "a closed shadow root from its HTML in each frame", 30000);
        // A button in each frame there, pressed: in its page in the engine.
        const frameButtons = `(() => { const all = []; const walk = (root) => { for (const el of root.querySelectorAll("*")) { if (el.id === "fbtn") all.push(el); if (el.shadowRoot) walk(el.shadowRoot); } }; walk(document); return all; })()`;
        for (let i = 0; i < (adSite ? 2 : 1); i++) {
            const r = await frame(`(() => { const b = ${frameButtons}[${i}]; b.scrollIntoView({ block: "center" }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
            const f = await viewOrigin();
            for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: f.x + r.x, y: f.y + r.y, button: "left", clickCount: 1 });
            await frameWait(`${frameButtons}[${i}]?.textContent === "frame pressed"`, `the button in frame ${i + 1} in the shadow root pressed`, 15000);
        }
        await goTo(site + "interact.html", "Interact");  // (the steps after's)
    });

    await step("a checkbox and a select", async () => {
        await frameClick("#cb");
        await frameWait(`document.getElementById("status").textContent === "checked true"`, "the box ticked in the engine");
        await frame(`document.getElementById("sel").focus()`);
        await browser.press("ArrowDown");
        await frameWait(`document.getElementById("status").textContent === "selected b"`, "the option chosen in the engine");
    });

    await step("a route by history.pushState shows in the address bar", async () => {
        await frameClick("#push");
        await waitFor(`(document.getElementById("go_url").dataset.url || document.getElementById("go_url").value).endsWith("/routed")`, "the routed address");
        await frameWait(`document.getElementById("status").textContent === "routed"`, "the routed status");
    });

    await step("alert and confirm are asked here", async () => {
        await frameClick("#alert");
        await waitFor(`document.getElementById("go_dialog").open`, "the alert");
        const said = await ev(`document.querySelector("#go_dialog p").textContent`);
        if (!said.includes("hello from the page")) throw new Error(`the alert said ${said}`);
        await ev(`document.querySelector("#go_dialog .ok").click()`);
        await frameWait(`document.getElementById("status").textContent === "after alert"`, "the page carrying on");
        await frameClick("#confirm");
        await waitFor(`document.getElementById("go_dialog").open`, "the question");
        await ev(`document.querySelector("#go_dialog .cancel").click()`);
        await frameWait(`document.getElementById("status").textContent === "confirmed false"`, "the answer");
    });

    await step("a dialog asked after opening a window says who asked, not where the window goes", async () => {
        await frameClick("#openask");
        await waitFor(`document.getElementById("go_dialog").open`, "the alert");
        const said = await ev(`document.querySelector("#go_dialog p").textContent`);
        const asker = new URL(site).host;
        if (!said.startsWith(`${asker} says: who asks`)) throw new Error(`the alert said ${JSON.stringify(said)}, not from ${asker}`);
        await ev(`document.querySelector("#go_dialog .ok").click()`);
        await goTo(site + "interact.html", "Interact");
        await frameWait(`!!document.getElementById("alert")`, "the page");
    });

    await step("a click on a button's SVG icon presses the button", async () => {
        await frameClick("#svgpath");
        await frameWait(`document.getElementById("status").textContent === "icon pressed"`, "the button pressed");
    });

    await step("a GET form, sent in the engine", async () => {
        await frameClick("#q");
        await browser.type("cats");
        await frameClick("#go");
        await waitFor(`document.title.startsWith("Result")`, "the result page", 30000);
        await frameWait(`document.getElementById("p")?.textContent === "query cats"`, "the query");
        if (!(await ev(`(document.getElementById("go_url").dataset.url || document.getElementById("go_url").value)`)).includes("result.html?q=cats")) throw new Error("the address bar didn't follow");
    });

    await step("a custom search engine: words typed are searched there, and shown as words", async () => {
        const d = `document.querySelector("#go_settings iframe")?.contentDocument`;
        const openSettings = async () => {
            await ev(`document.getElementById("go_menu").click(); document.getElementById("go_menu_settings").click()`);
            await waitFor(`${d}?.getElementById("search_engine")?.disabled === false`, "Settings", 15000);
        };
        await openSettings();
        await ev(`(() => { const s = ${d}.getElementById("search_engine"); s.value = "custom"; s.dispatchEvent(new Event("change")); })()`);
        await waitFor(`!${d}.getElementById("search_custom").hidden`, "its address asked for");
        const setURL = (u) => ev(`(() => { const d = ${d}; const i = d.getElementById("search_url"); i.value = ${JSON.stringify(u)}; i.dispatchEvent(new Event("input")); d.getElementById("search_custom").requestSubmit(); })()`);
        await setURL(site + "result.html?q=x%s");
        await waitFor(`!${d}.getElementById("search_error").hidden && /whole value/.test(${d}.getElementById("search_error").textContent)`, "%s not a whole value, said by the field");
        await setURL(site + "result.html?q=%s");
        await waitFor(`${d}.getElementById("done").textContent === "Search engine saved."`, "the custom engine saved", 15000);
        await closeSettings();
        await sleep(1000); // (the browser asks for the engine again as it's told)
        await submitUrl("cats and dogs");
        await waitFor(`document.title.startsWith("Result")`, "the custom engine's result page", 30000);
        await frameWait(`document.getElementById("p")?.textContent === "query cats and dogs"`, "the words searched for");
        await waitFor(`document.getElementById("go_url").value === "cats and dogs"`, "the address bar showing the words");
        // What isn't an address at all (a space in its host) is searched for.
        await goTo(site + "index.html", "Fixture");
        await submitUrl("https://exa mple.com/x");
        await waitFor(`document.title.startsWith("Result")`, "an address that isn't one, searched for", 30000);
        await frameWait(`document.getElementById("p")?.textContent === "query https://exa mple.com/x"`, "searched for as typed");
        // An address typed whose name no site has (a typo; .invalid never
        // is one): searched for as typed, without http:// or https://, in
        // its place, so Back goes to the page before.
        for (const [typed, words] of [["nosuchsite.invalid", "nosuchsite.invalid"], ["https://nosuchsite.invalid/x", "nosuchsite.invalid/x"]]) {
            await goTo(site + "index.html", "Fixture");
            await submitUrl(typed);
            await waitFor(`document.title.startsWith("Result")`, `${typed}, no site's name, searched for`, 30000);
            await frameWait(`document.getElementById("p")?.textContent === ${JSON.stringify("query " + words)}`, "searched for without its scheme");
            await ev(`document.getElementById("go_back").click()`);
            await waitFor(`document.title.startsWith("Fixture")`, "Back, to the page before the typo", 30000);
        }
        // Back to the default.
        await openSettings();
        if ((await ev(`${d}.getElementById("search_engine").value`)) !== "custom") throw new Error("Settings doesn't show the custom engine");
        await ev(`(() => { const s = ${d}.getElementById("search_engine"); s.value = "duckduckgo"; s.dispatchEvent(new Event("change")); })()`);
        await waitFor(`${d}.getElementById("done").textContent === "Search engine saved." && ${d}.getElementById("search_custom").hidden`, "DuckDuckGo again", 15000);
        await closeSettings();
    });

    await step("a POST form", async () => {
        await goTo(site + "interact.html", "Interact");
        await frameWait(`!!document.getElementById("send")`, "the page");
        await frameClick("#send");
        await waitFor(`document.title.startsWith("Posted")`, "the posted page", 30000);
        await frameWait(`document.getElementById("p")?.textContent === "pq=posted+value"`, "what was posted");
    });

    await step("a page's file input: its chooser answered here, its files the page's (read, posted); a shown one shows them; files from TabTop's Files instead; none opened without a press", async () => {
        // The files, on this machine; this browser's chooser taken (not
        // shown), and the files put in it as a person would pick them.
        const dir = mkdtempSync(join(tmpdir(), "go-check-files-"));
        writeFileSync(join(dir, "a.txt"), "first file's text");
        writeFileSync(join(dir, "b.txt"), "second file's text");
        const pickHere = async (paths) => {
            await waitFor(`!!document.getElementById("go_file_input")?.dataset.chooser`, "the page's chooser, here", 15000);
            const { root } = await cdp("DOM.getDocument", { depth: 0 });
            const { nodeId } = await cdp("DOM.querySelector", { nodeId: root.nodeId, selector: "#go_file_input" });
            await cdp("DOM.setFileInputFiles", { nodeId, files: paths });
        };
        // Waited for, TabTop's side said if it doesn't come: its chooser,
        // its notice, what the page shows.
        const pageGets = (expr, what) => frameWait(expr, what, 30000).catch(async (err) => {
            const here = await ev(`JSON.stringify({ chooser: document.getElementById("go_file_input").dataset.chooser ?? null, files: document.getElementById("go_file_input").files.length, notice: document.getElementById("go_notice").hidden ? "" : document.querySelector("#go_notice p").textContent, status: document.getElementById("go_status")?.textContent ?? "" })`).catch(() => "?");
            const there = await frame(`JSON.stringify([document.getElementById("fgot")?.textContent, document.getElementById("fshown")?.textContent])`).catch(() => "?");
            throw new Error(`${err.message} (here ${here}; the page ${there})`);
        });
        await cdp("Page.setInterceptFileChooserDialog", { enabled: true });
        try {
            await goTo(site + "fileinput.html", "File input");
            await frameWait(`!!document.getElementById("pick")`, "the page");
            // Opened by its button: two files, read and posted by the page.
            // (With Files on, asked here first: This device… pressed, its
            // own chooser opened from that press.)
            await frameClick("#pick");
            if (process.env.GO_NO_FS !== "1") {
                await waitFor(`!document.getElementById("go_pick").hidden`, "the chooser, asked here", 15000);
                const before = ctx.choosersOpened;
                const b = await ev(`(() => { const r = document.querySelector("#go_pick .device").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
                for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: b.x, y: b.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
                for (const end = Date.now() + 10000; ctx.choosersOpened === before && Date.now() < end;) await sleep(200);
                if (ctx.choosersOpened === before) throw new Error("This device… didn't open this browser's chooser");
            }
            await pickHere([join(dir, "a.txt"), join(dir, "b.txt")]);
            await pageGets(`document.getElementById("fgot").textContent === "a.txt=first file's text, b.txt=second file's text"`, "the files, read by the page");
            await frameWait(`document.getElementById("fposted").textContent === "both posted"`, "the files, posted to the site", 15000);
            // A shown one, pressed: its file, and shown in it here.
            await frameClick("#shown");
            await pickHere([join(dir, "b.txt")]);
            await pageGets(`document.getElementById("fshown").textContent === "b.txt=second file's text"`, "the shown field's file, read by the page");
            const here = await frame(`(() => { const f = document.getElementById("shown"); return f.files.length + " " + (f.files[0]?.name ?? ""); })()`);
            if (here !== "1 b.txt") throw new Error(`the shown field here holds ${JSON.stringify(here)}`);
            // From TabTop's own Files (with Files on): chosen here, copied
            // by the server, read by the page; a path out of Files, or for
            // no chooser, refused.
            if (process.env.GO_DOWNLOADS && process.env.GO_NO_FS !== "1") {
                const pickDir = join(process.env.GO_DOWNLOADS, "go-check-pick");
                mkdirSync(pickDir, { recursive: true });
                writeFileSync(join(pickDir, "c.txt"), "from Files");
                writeFileSync(join(pickDir, "d.txt"), "also from Files");
                await goTo(site + "fileinput.html", "File input");
                await frameWait(`!!document.getElementById("pick")`, "the page");
                await frameClick("#pick");
                await waitFor(`!document.getElementById("go_pick").hidden`, "the chooser, asked here", 15000);
                const token = await ev(`document.getElementById("go_file_input").dataset.chooser`);
                const refused = (path, chooser = token) => ev(`import("../tabtop/requests.js").then(async (m) => { try { const t = await m.call({ type: "go-upload-files", go_tab: sessionStorage.getItem(Object.keys(sessionStorage).find((k) => k.startsWith("tabtop-go-resume"))), chooser: ${JSON.stringify(chooser)}, path: ${JSON.stringify(path)} }); t.close(); return ""; } catch (e) { return e.message || "refused"; } })`);
                if (!(await refused("../../../etc/passwd"))) throw new Error("a path out of Files was given to the page");
                if (!(await refused("go-check-pick/c.txt", "notthechooser"))) throw new Error("a file was given to no chooser");
                await ev(`document.querySelector("#go_pick .files-go").click()`);
                await waitFor(`[...document.querySelectorAll("#go_pick li .folder")].some((b) => b.textContent === "go-check-pick/")`, "Files' folders, listed", 15000);
                await ev(`[...document.querySelectorAll("#go_pick li .folder")].find((b) => b.textContent === "go-check-pick/").click()`);
                await waitFor(`document.querySelectorAll("#go_pick li label input").length === 2`, "the folder's files", 15000);
                await ev(`for (const i of document.querySelectorAll("#go_pick li label input")) i.click()`);
                await ev(`document.querySelector("#go_pick .give").click()`);
                await pageGets(`document.getElementById("fgot").textContent === "c.txt=from Files, d.txt=also from Files"`, "the files from Files, read by the page");
                if (!(await ev(`document.getElementById("go_pick").hidden`))) throw new Error("the chooser left open");
                rmSync(pickDir, { recursive: true, force: true });
            }
            // One a timer opens, no press: nothing asked here.
            await goTo(site + "fileauto.html", "File auto");
            await stillNot(ev, `!!document.getElementById("go_file_input").dataset.chooser`, "a chooser opened without a press was asked here", 2000);
        } finally {
            await cdp("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
            rmSync(dir, { recursive: true, force: true });
        }
        await goTo(site + "index.html", "Fixture");
    });

    await step("files dropped on the page: sent, then dropped there, each a drop of its own (Moli gives a drop one file); on an embedded page of another origin, given there, in one drop", async () => {
        const dir = mkdtempSync(join(tmpdir(), "go-check-drop-"));
        writeFileSync(join(dir, "a.txt"), "first file's text");
        writeFileSync(join(dir, "b.txt"), "second file's text");
        try {
            await goTo(site + "filedrop.html", "File drop");
            await frameWait(`!!document.getElementById("zone")`, "the page");
            const view = () => viewOrigin();
            const data = { items: [], files: [join(dir, "a.txt"), join(dir, "b.txt")], dragOperationsMask: 1 };
            await frameDrop(async () => {
                const r = await frame(`(() => { const b = document.getElementById("zone").getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
                const f = await view();
                return { x: f.x + r.x, y: f.y + r.y };
            }, data);
            await frameWait(`document.getElementById("dropped").textContent === "a.txt=first file's text, b.txt=second file's text"`, "both files, dropped on the page", 30000);
            const types = await frame(`document.getElementById("dtypes").textContent`);
            if (types !== "Files") throw new Error(`the page's drag had ${JSON.stringify(types)}`);
            // On an embedded page of another origin: given to it there, all
            // in one drop.
            await goTo(site + "filedropframe.html", "File drop frame");
            await frameWait(`!!document.getElementById("x")?.shadowRoot?.querySelector("#zone")`, "the embedded page's copy", 20000);
            await frameDrop(async () => {
                const z = JSON.parse(await frame(`(() => { const b = document.getElementById("x").shadowRoot.querySelector("#zone").getBoundingClientRect(); return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2 }); })()`));
                const f = await view();
                return { x: f.x + z.x, y: f.y + z.y };
            }, data);
            await frameWait(`document.getElementById("x")?.shadowRoot?.querySelector("#dropped")?.textContent === "a.txt=first file's text, b.txt=second file's text"`, "both files, dropped on the embedded page", 30000)
                .catch(async (err) => { throw new Error(`${err.message}: ${await frame(`document.getElementById("x")?.shadowRoot?.querySelector("#dropped")?.textContent`)}; ${await ev(`document.getElementById("go_notice").hidden ? "" : document.querySelector("#go_notice p")?.textContent`)}`); });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
        await goTo(site + "index.html", "Fixture");
    });

    await step("Settings: Restart remote web engine, confirmed with the password + code (a wrong one refused): the tab loads its page again in a new engine", async () => {
        await goTo(site + "restart.html", "Restart");
        await frameWait(`!!document.getElementById("born")?.textContent`, "the page");
        const born = await frame(`document.getElementById("born").textContent`);
        const d = `document.querySelector("#go_settings iframe")?.contentDocument`;
        await ev(`document.getElementById("go_menu").click(); document.getElementById("go_menu_settings").click()`);
        await waitFor(`${d}?.getElementById("engine_restart")?.disabled === false`, "Settings' Restart", 15000);
        const said = `${d}.getElementById("done").textContent`;
        const dialog = `${d}.getElementById("restart_dialog")`;
        await ev(`${d}.getElementById("engine_restart").click()`);
        await waitFor(`${dialog}.open && ${d}.activeElement === ${d}.getElementById("restart_code")`, "the restart's dialog, its field focused");
        const enter = (code) => ev(`(() => { const d = ${d}; const c = d.getElementById("restart_code"); c.value = ${JSON.stringify(code)}; c.dispatchEvent(new Event("input")); d.getElementById("restart_go").click(); })()`);
        // A wrong password + code: said in the dialog, still open, its field
        // cleared to try again; nothing restarted.
        await enter("0000000");
        await waitFor(`${d}.getElementById("restart_error").textContent.startsWith("That password and code are wrong") && ${dialog}.open && !${d}.getElementById("restart_code").value`, "a wrong code refused, said in the dialog", 15000);
        if ((await frame(`document.getElementById("born").textContent`)) !== born) throw new Error("the page was loaded again on a wrong code");
        // The right one, in the same dialog: restarted (every tab's: others
        // the steps before left too, kept to be taken back), the dialog closed.
        await enter(await totp());
        await waitFor(`!${dialog}.open && /^Engine restarted · (1 tab|[0-9]+ tabs) reloaded\\.$/.test(${said})`, "the restart done, the dialog closed", 30000);
        await frameWait(`document.title === "Restart" && !!document.getElementById("born")?.textContent && document.getElementById("born").textContent !== ${JSON.stringify(born)}`, "the page, loaded again in a new engine", 30000);
        if (await ev(`!document.getElementById("go_notice").hidden && document.getElementById("go_notice").dataset.connection === "1"`)) throw new Error("asked to reconnect, not connected again by itself");
        await closeSettings("Settings closed");
        await goTo(site + "index.html", "Fixture");
    });

    await step("a redirect by script, and a window the page opens, stay in this tab", async () => {
        await goTo(site + "interact.html", "Interact");
        await frameWait(`!!document.getElementById("redirect")`, "the page");
        await frameClick("#redirect");
        await waitFor(`document.title.startsWith("Second")`, "the redirect", 30000);
        await ev(`document.getElementById("go_back").click()`);
        await waitFor(`document.title.startsWith("Interact")`, "back", 30000);
        await frameWait(`!!document.getElementById("open")`, "the page");
        await frameClick("#open");
        // Asked first (a site with nothing said of its pop-ups): opened, the
        // answer not kept (the pop-ups' step, below, has that).
        await waitFor(`!document.getElementById("go_popup").hidden`, "asked about the pop-up", 30000);
        await ev(`(() => { document.querySelector("#go_popup .remember input").checked = false; document.querySelector("#go_popup .open").click(); })()`);
        await waitFor(`document.title.startsWith("Second")`, "the opened window, here", 30000);
    });

}
