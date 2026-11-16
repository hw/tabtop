import { execFileSync } from "node:child_process";

export async function checkTextDiff({ container, inContainer, open, listed, row, ev, waitFor, press, click, step, cdp }) {
    const root = "/home/user/Downloads/diff-check";
    inContainer("mkdir", "-p", root + "/folder");
    const put = (name, text) => execFileSync("docker", ["exec", "-i", "-u", "user", container, "sh", "-c", 'cat > "$1"', "diff-fixture", root + "/" + name], { input: Buffer.from(text) });
    const a = 'const same = 0;\n/* multiline\ncomment */\nconst value = 1;\n<script>globalThis.diffPwned=true</script>\n';
    const b = a.replace("value = 1", "value = 2") + "const added = true;\n";
    put("left.js", a); put("right.js", b); put("binary.txt", "a\0b"); put("invalid.txt", new Uint8Array([0xff]));
    put("large.txt", "x".repeat(2_000_001));
    put("long-a.txt", Array.from({ length: 1200 }, (_, i) => `Line ${i}\n`).join(""));
    put("long-b.txt", Array.from({ length: 1200 }, (_, i) => `Line ${i}${i === 1100 ? " changed" : ""}\n`).join(""));
    put("crlf.txt", "\ufefforiginal\r\n");
    const dialog = 'document.querySelector("dialog.text-diff[open]")';
    const summary = `${dialog}?.querySelector(".diff-summary").textContent`;
    const select = async (...names) => {
        await open("fs/#/diff-check/", `${listed}.includes("left.js")`, "diff fixtures");
        await ev(`document.querySelector(".selection button:last-child")?.click()`);
        for (const name of names) await ev(`${row(name)}.querySelector('input[type=checkbox]').click()`);
    };
    const close = async () => { await press("Escape"); await waitFor(`!${dialog}`, "comparison closed"); };
    const compare = async (...names) => {
        await select(...names);
        await ev(`document.querySelector("button.compare-files").click()`);
        await waitFor(`!!${dialog}`, "comparison opens");
        await waitFor(`${summary} !== "Loading text files…" && ${summary} !== "Comparing…"`, "comparison result");
    };
    await step("diff: selection, aligned changes and inert syntax highlighting", async () => {
        await select("left.js");
        if (!await ev(`document.querySelector("button.compare-files").hidden`)) throw new Error("one file offered comparison");
        await ev(`${row("right.js")}.querySelector('input').click()`);
        if (await ev(`document.querySelector("button.compare-files").hidden || !document.querySelector("button.compare-images").hidden`)) throw new Error("two text files weren't offered text comparison alone");
        await ev(`${row("folder/")}.querySelector('input').click()`);
        if (!await ev(`document.querySelector("button.compare-files").hidden`)) throw new Error("folder/third item offered comparison");
        await ev(`${row("folder/")}.querySelector('input').click()`);
        await click('document.querySelector("button.compare-files")');
        await waitFor(`${summary}?.includes("removed")`, "diff ready");
        if (!await ev(`${dialog}.querySelectorAll(".diff-removed").length > 0 && ${dialog}.querySelectorAll(".diff-added").length > 0 && ${dialog}.querySelectorAll("thead th").length === 2`)) throw new Error("missing two-sided changes");
        if (!await ev(`${dialog}.textContent.includes("<script>globalThis.diffPwned=true</script>") && !globalThis.diffPwned && !${dialog}.querySelector("script")`)) throw new Error("source wasn't inert text");
        if (!await ev(`${dialog}.querySelector(".hljs-keyword") && [...${dialog}.querySelectorAll(".hljs-comment")].some(n => n.textContent.includes("comment */"))`)) throw new Error("syntax highlighting lost multiline context");
        await ev(`${dialog}.querySelector(".diff-next").click()`);
        await waitFor(`${dialog}.querySelector(".diff-position").textContent.startsWith("Change 1 of")`, "next change");
        await click(`${dialog}.querySelector(".diff-maximize")`);
        await waitFor(`${dialog}.classList.contains("wide") && ${dialog}.querySelector(".diff-maximize").getAttribute("aria-pressed")==="true" && Math.abs(${dialog}.getBoundingClientRect().width-innerWidth)<2`, "comparison maximized");
        await click(`${dialog}.querySelector(".diff-maximize")`);
        await waitFor(`!${dialog}.classList.contains("wide") && ${dialog}.querySelector(".diff-maximize").getAttribute("aria-label")==="Maximize"`, "comparison size restored");
        await click(`${dialog}.querySelector(".diff-layout")`);
        await waitFor(`${dialog}.querySelector("table").classList.contains("unified") && ${dialog}.querySelectorAll("thead th").length===1 && ${dialog}.querySelectorAll(".diff-removed").length>0 && ${dialog}.querySelectorAll(".diff-added").length>0`, "unified differences");
        await click(`${dialog}.querySelector(".diff-layout")`);
        await waitFor(`${dialog}.querySelectorAll("thead th").length===2`, "split differences restored");
        await cdp("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
        await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
        if (!await ev(`(()=>{const d=${dialog}, t=d.querySelector("table");return d.getBoundingClientRect().width <= innerWidth && t.getBoundingClientRect().width <= d.clientWidth && d.querySelectorAll("thead th").length === 2})()`)) throw new Error("narrow comparison overflowed or lost a side");
        await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await cdp("Emulation.setEmulatedMedia", { features: [] });
        await close();
        if (!await ev(`document.activeElement.matches("button.compare-files")`)) throw new Error("focus wasn't restored");
    });
    await step("diff: change navigation across paged rows", async () => {
        await compare("long-a.txt", "long-b.txt");
        if (!await ev(`${dialog}.querySelectorAll("tbody tr").length === 500`)) throw new Error("unbounded row rendering");
        await ev(`${dialog}.querySelector(".diff-next").click()`);
        await waitFor(`${dialog}.querySelector(".diff-current")?.dataset.row === "1100"`, "change on later page");
        if (!await ev(`${dialog}.querySelector(".diff-range").textContent.includes("1001–1200")`)) throw new Error("didn't switch pages");
        await close();
    });
    await step("diff: binary and invalid UTF-8 fail, cancellation leaves no dialog", async () => {
        for (const name of ["binary.txt", "invalid.txt"]) {
            await compare("left.js", name);
            if (!await ev(`${summary}?.startsWith("Can't compare:")`)) throw new Error("accepted non-text file");
            await close();
        }
        await select("large.txt", "left.js");
        if (!await ev(`document.querySelector("button.compare-files").hidden`)) throw new Error("oversize comparison offered");
        await select("left.js", "right.js");
        await ev(`document.querySelector("button.compare-files").click();document.querySelector("dialog.text-diff .diff-close").click()`);
        await waitFor(`!${dialog}`, "cancelled dialog removed");
    });
    await step("diff: editor saved snapshot advances only after a successful save", async () => {
        await open("fs/#/diff-check/", `${listed}.includes("crlf.txt")`, "editable file");
        await ev(`${row("crlf.txt")}.querySelector("td.name a").click()`);
        await waitFor(`!!document.querySelector("dialog.preview button.edit:not([hidden])")`, "text preview");
        await click('document.querySelector("dialog.preview button.edit")');
        await waitFor(`!!document.querySelector("textarea.editor")`, "editor");
        const setText = async text => ev(`(()=>{const box=document.querySelector("textarea.editor");box.value=${JSON.stringify(text)};box.dispatchEvent(new Event("input"));})()`);
        await setText("edited\n");
        if (!await ev('document.querySelectorAll("button.compare-saved").length===1 && document.querySelector("button.compare-saved").matches(".save-status") && document.querySelector("button.compare-saved").textContent==="Unsaved changes"')) throw new Error("comparison wasn't merged with the unsaved status");
        await click('document.querySelector("button.compare-saved")');
        await waitFor(`${summary}?.includes("removed")`, "saved comparison");
        if (!await ev(`${dialog}.querySelectorAll("thead th")[0].textContent.includes("Last saved") && ${dialog}.textContent.includes("original") && ${dialog}.textContent.includes("edited") && ${dialog}.querySelectorAll("thead th")[1].textContent.includes("with BOM · CRLF")`)) throw new Error("wrong saved/current snapshot or encoding");
        await close();
        if (await ev('document.querySelector("textarea.editor").value') !== "edited\n") throw new Error("comparison changed editor");
        await click('document.querySelector("button.save-edit")');
        await waitFor(`document.querySelector(".edit-status")?.textContent === "Saved."`, "save succeeds");
        await click('document.querySelector("button.compare-saved")');
        await waitFor(`${summary} === "Files are identical."`, "saved baseline updated");
        await close();
        await setText("unsaved\n");
        put("crlf.txt", "changed externally\r\n");
        await click('document.querySelector("button.save-edit")');
        await waitFor(`document.querySelector(".edit-status")?.textContent.startsWith("Not saved:")`, "conflicting save refused");
        await click('document.querySelector("button.compare-saved")');
        await waitFor(`${summary}?.includes("removed")`, "compare after failed save");
        if (!await ev(`${dialog}.textContent.includes("edited") && ${dialog}.textContent.includes("unsaved") && !${dialog}.textContent.includes("changed externally")`)) throw new Error("failed save replaced the baseline");
        await close();
        await setText("edited\n");
        await click('document.querySelector("button.done-edit")');
        await click('document.querySelector("dialog.preview button.close")');
    });
}
