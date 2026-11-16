// Earlier versions, searching files' text, and the grid with thumbnails.
import { crc32, deflateSync } from "node:zlib";

// png is a w by h PNG, every pixel rgb.
function png(w, h, [r, g, b]) {
    const chunk = (type, data) => {
        const out = Buffer.alloc(12 + data.length);
        out.writeUInt32BE(data.length, 0);
        out.write(type, 4, "latin1");
        data.copy(out, 8);
        out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
        return out;
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(w, 0);
    header.writeUInt32BE(h, 4);
    header.set([8, 2, 0, 0, 0], 8);
    const rows = Buffer.alloc(h * (1 + 3 * w));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows.set([r, g, b], y * (1 + 3 * w) + 1 + 3 * x);
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
export async function checkFeatures({ base, cdp, totp, status, ev, waitFor, click, open, listed, row, answer, inContainer, step, sleep }) {
    const dialogText = (cls) => `(document.querySelector("dialog.${cls}")?.textContent ?? "")`;

    await step("files: earlier versions, compared, restored and deleted", async () => {
        inContainer("sh", "-c", "mkdir -p ~/Downloads/hist && printf 'one\\n' > ~/Downloads/hist/v.txt");
        await open("fs/#/hist/", `${listed}.includes("v.txt")`, "hist/");
        await ev(`${row("v.txt")}.querySelector("td.name a").click()`);
        await waitFor(`!!document.querySelector("dialog.preview button.edit:not([hidden])")`, "v.txt, with Edit");
        await ev(`document.querySelector("dialog.preview button.edit").click()`);
        await waitFor(`!!document.querySelector("dialog.preview textarea.editor")`, "the editor");
        await ev(`(() => { const b = document.querySelector("dialog.preview textarea.editor"); b.value = "two\\n"; b.dispatchEvent(new Event("input")); })()`);
        await ev(`document.querySelector("dialog.preview textarea.editor").dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }))`);
        await waitFor(`(document.querySelector("dialog.preview .edit-status")?.textContent ?? "") === "Saved."`, "the save");
        if (inContainer("cat", "/home/user/Downloads/hist/v.txt").trim() !== "two") throw new Error("not saved");
        await ev(`document.querySelector("dialog.preview button.done-edit").click()`);
        await waitFor(`!document.querySelector("dialog.preview textarea.editor")`, "editing ended");
        // The version the save replaced.
        await click(`document.querySelector("dialog.preview button.versions")`);
        await waitFor(`document.querySelectorAll("dialog.versions tbody tr").length === 1`, "one earlier version");
        await click(`document.querySelector("dialog.versions button.version-compare")`);
        await waitFor(`${dialogText("text-diff")}.includes("one") && ${dialogText("text-diff")}.includes("two")`, "the comparison");
        await click(`document.querySelector("dialog.text-diff button.diff-close")`);
        await waitFor(`!document.querySelector("dialog.text-diff")`, "the comparison to close");
        await click(`document.querySelector("dialog.versions button.version-restore")`);
        await answer();
        await waitFor(`!document.querySelector("dialog.versions") && (document.querySelector("dialog.preview .body")?.textContent ?? "").includes("one")`, "the version restored and shown");
        if (inContainer("cat", "/home/user/Downloads/hist/v.txt").trim() !== "one") throw new Error("the file wasn't restored");
        // What it was before restoring is a version in turn; delete them all.
        await click(`document.querySelector("dialog.preview button.versions")`);
        await waitFor(`document.querySelectorAll("dialog.versions tbody tr").length === 2`, "two earlier versions");
        await click(`document.querySelector("dialog.versions button.versions-delete-all")`);
        await ev(`[...document.querySelectorAll("dialog[open]")].at(-1).querySelector("button.primary, button.danger").click()`);
        await waitFor(`${dialogText("versions")}.includes("No earlier versions")`, "the versions deleted");
        await click(`document.querySelector("dialog.versions button.versions-close")`);
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "the preview to close");
        return "a save keeps a version, compared, restored (keeping another), and deleted";
    });

    await step("files: search in files, opening the file at the line", async () => {
        inContainer("sh", "-c", "mkdir -p ~/Downloads/hist/deep && seq 1 400 | sed 's/^/line /' > ~/Downloads/hist/deep/long.txt"
            + " && printf 'needle on 401\\n' >> ~/Downloads/hist/deep/long.txt && printf 'no\\nNeedle here\\n' > ~/Downloads/hist/n.md");
        await open("fs/#/hist/", `${listed}.includes("n.md")`, "hist/");
        await click(`document.querySelector("button.search-files")`);
        await waitFor(`!!document.querySelector("dialog.search input.search-query")`, "the search dialog");
        await ev(`(() => { const q = document.querySelector("dialog.search input.search-query"); q.value = "needle"; q.form.requestSubmit(); })()`);
        await waitFor(`(document.querySelector("dialog.search .search-status")?.textContent ?? "").startsWith("2 lines found in 2 files")`, "two lines found");
        const shown = await ev(`[...document.querySelectorAll("dialog.search .search-file h3")].map((h) => h.textContent).sort().join(",")`);
        if (shown !== "hist/deep/long.txt,hist/n.md") throw new Error(`found in ${shown}`);
        await ev(`[...document.querySelectorAll("dialog.search button.search-line")].find((b) => b.title.includes("long.txt")).click()`);
        await waitFor(`String(getSelection()) === "needle" && (document.querySelector("dialog.preview .body")?.scrollTop ?? 0) > 0`, "the file, scrolled to the match, selected");
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview") && !!document.querySelector("dialog.search")`, "back to the results");
        // Case, when asked.
        await ev(`(() => { document.querySelector("dialog.search .search-case").checked = true; document.querySelector("dialog.search form").requestSubmit(); })()`);
        await waitFor(`(document.querySelector("dialog.search .search-status")?.textContent ?? "").startsWith("1 line found in 1 file")`, "one line, matching case");
        await click(`document.querySelector("dialog.search button.search-close")`);
        await waitFor(`!document.querySelector("dialog.search")`, "the search to close");
        return "found across folders, opened at the line with the match selected, case matched when asked";
    });

    await step("files: the grid, with thumbnails", async () => {
        inContainer("sh", "-c", `printf %s ${png(400, 300, [200, 40, 40]).toString("base64")} | base64 -d > ~/Downloads/hist/pic.png`);
        await open("fs/#/hist/", `${listed}.includes("pic.png")`, "hist/");
        await click(`document.querySelector("button.view-toggle")`);
        await waitFor(`document.querySelector(".file-table")?.classList.contains("grid") && !!${row("pic.png")}?.querySelector("td.thumb img")`, "the grid, with pic.png's thumbnail");
        // Its rows work as the list's: ticking one.
        await ev(`${row("n.md")}.querySelector("td.sel input").click()`);
        await waitFor(`document.querySelector(".selection:not([hidden])")?.textContent.startsWith("1 selected")`, "n.md ticked in the grid");
        await ev(`${row("n.md")}.querySelector("td.sel input").click()`);
        // Remembered, then back to the list.
        await open("fs/#/hist/", `${listed}.includes("pic.png") && document.querySelector(".file-table")?.classList.contains("grid")`, "the grid again");
        await click(`document.querySelector("button.view-toggle")`);
        await waitFor(`!document.querySelector(".file-table")?.classList.contains("grid")`, "the list");
        inContainer("sh", "-c", "rm -r ~/Downloads/hist");
        await open("fs/#/", `document.title === "Downloads /" && !!document.querySelector("table")`, "the listing");
        await sleep(0);
        return "a thumbnail made, ticking works, the view remembered";
    });

    await step("security: add a passkey, log in with it, and remove it", async () => {
        // Passkeys need a name for the site, not an IP address: localhost,
        // a site of its own, logged into afresh.
        const local = base.replace("127.0.0.1", "localhost");
        await cdp("WebAuthn.enable", { enableUI: false });
        const { authenticatorId } = await cdp("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal",
            hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
        try {
            await cdp("Page.navigate", { url: local + "fs/#sessions" });
            await waitFor(`location.hostname === "localhost" && !!document.querySelector("#tabtop_login input")`, "the login form at localhost");
            if (!(await ev(`!!document.querySelector("#tabtop_login button.passkey-login")`))) throw new Error("no passkey button at localhost");
            await ev(`(() => { const i = document.querySelector("#tabtop_login input"); i.value = ${JSON.stringify(await totp())}; i.form.requestSubmit(); })()`);
            await waitFor(`!document.querySelector("#tabtop_login") && !!document.querySelector("button.add-passkey:not([disabled])")`, "the passkeys section");
            // Not with the code that logged in, nor a wrong one: the next.
            // The page may draw the section again as it settles: clicked till
            // the questions show.
            for (let i = 0; ; i++) {
                await ev(`document.querySelector("button.add-passkey:not([disabled])")?.click()`);
                try {
                    await waitFor(`!!document.querySelector("dialog[open] input.passkey-code")`, "the passkey's questions", 2000);
                    break;
                } catch (err) {
                    if (i === 4) throw err;
                }
            }
            const code = await totp();
            await ev(`(() => { const d = document.querySelector("dialog[open]"); d.querySelector("input.passkey-name").value = "Test key";
                d.querySelector("input.passkey-code").value = ${JSON.stringify(code)}; d.querySelector("button.primary").click(); })()`);
            await waitFor(`/Passkey Test key added/.test(${status}) && [...document.querySelectorAll(".passkeys-table td.name")].some((td) => td.textContent === "Test key")`, "the passkey added");
            // Logged out here, then in again with it.
            await ev(`import("/tabtop/session-state.js").then((m) => m.forgetSession())`);
            await cdp("Page.reload", { ignoreCache: true });
            await waitFor(`!!document.querySelector("#tabtop_login button.passkey-login")`, "the login form again");
            await ev(`document.querySelector("#tabtop_login button.passkey-login").click()`);
            await waitFor(`!document.querySelector("#tabtop_login") && (document.querySelector(".logins-table")?.textContent ?? "").includes("with a passkey")`, "logged in with the passkey");
            await waitFor(`[...document.querySelectorAll("#sessions .activity-table tr")].some((r) => r.textContent.includes('added the passkey "Test key"'))`, "the passkey added, in the activity log");
            // Removed, with the password + code again, it's gone from the list.
            await ev(`[...document.querySelectorAll(".passkeys-table tr")].find((tr) => tr.textContent.includes("Test key")).querySelector("button.remove-passkey").click()`);
            await answer(await totp());
            await waitFor(`(document.querySelector("section.passkeys")?.textContent ?? "").includes("None yet.")`, "the passkey removed");
        } finally {
            await cdp("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
            await cdp("WebAuthn.disable");
        }
        await open("fs/#/", `document.title === "Downloads /" && !!document.querySelector("table")`, "the listing, back at 127.0.0.1");
        return "added and removed with the password + code again, logged in with";
    });
}
