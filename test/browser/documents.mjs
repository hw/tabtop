import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, rmSync } from "node:fs";
import { zipFile, pngSquare } from "./fixtures.mjs";

export async function checkText(checks) {
    const { inContainer, step, ev, waitFor, click, open, listed } = checks;
    await step("files: preview text in colour", async () => {
        inContainer("sh", "-c", `cd ~/Downloads/media && printf 'def greet(name):\\n    return f"hi {name}"  # say hi\\n' > colours.py `
            + `&& printf 'package main\\r\\n\\r\\nfunc main() {}\\r\\n' > crlf.go `
            + `&& printf '<img src=x onerror="document.title=1"><script>document.title=2</script>\\n' > page.html`);
        await open("fs/#/media/", `${listed}.includes("colours.py") && ${listed}.includes("page.html")`, "the files to preview");
        const show = async (name) => {
            await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === ${JSON.stringify(name)}).click()`);
            await waitFor(`!!document.querySelector("dialog.preview[open] pre")`, name);
        };
        const close = async () => {
            await ev(`document.querySelector("dialog.preview button.close").click()`);
            await waitFor(`!document.querySelector("dialog.preview")`, "the preview to close");
        };
        await show("colours.py");
        await waitFor(`document.querySelector("dialog.preview pre.coloured code.language-python .hljs-keyword")?.textContent === "def"`,
            "colours.py in colour");
        if (await ev(`document.querySelector("dialog.preview pre").textContent`) !== 'def greet(name):\n    return f"hi {name}"  # say hi\n') {
            throw new Error("colours.py's text isn't shown as it is");
        }
        await close();
        await show("crlf.go");
        await waitFor(`document.querySelector("dialog.preview pre.coloured .hljs-keyword")?.textContent === "package"`, "crlf.go in colour");
        await close();
        // A web page's source: coloured, and only ever text.
        await ev(`localStorage.setItem("tabtop.html-view", "source")`);
        const title = await ev("document.title");
        await show("page.html");
        await waitFor(`!!document.querySelector("dialog.preview pre.coloured .hljs-tag")`, "page.html in colour");
        if (await ev(`!!document.querySelector("dialog.preview pre img, dialog.preview pre script")`)
            || !(await ev(`document.querySelector("dialog.preview pre").textContent.startsWith("<img src=x")`))
            || await ev("document.title") !== title) {
            throw new Error("page.html's source was made into elements");
        }
        await close();
        await ev(`localStorage.removeItem("tabtop.html-view")`);
        inContainer("sh", "-c", "cd ~/Downloads/media && rm colours.py crlf.go page.html");
        await open("fs/#/", `document.title === "Downloads /" && !!document.querySelector("table")`, "the listing");
        return "Python, Go with CRLF, and HTML's source as text";
    });
}

export async function checkHTML(checks) {
    const { base, work, container, inContainer, sleep, step, ev, waitFor, click, open, listed, inFrame, checkPreviewLink, rendered } = checks;
    await step("files: preview HTML safely", async () => {
        const html = `<!doctype html><html><head><title>Untrusted title</title>
            <base href="https://example.com/"><meta http-equiv="refresh" content="0;url=https://example.com/">
            <link rel="stylesheet" href="https://example.com/style.css"><style>@import 'https://example.com/import.css';</style>
            <script>parent.postMessage('html-ran', '*')</script></head><body onload="parent.postMessage('html-ran', '*')">
            <h1 id="top">HTML preview</h1><p id="styled" style="color: rgb(12, 34, 56); font-weight: bold; position: fixed; background-image: url(https://example.com/css.png)" onclick="parent.postMessage('html-ran', '*')">Styled text</p>
            <table><tr><th>Heading</th><td>Cell</td></tr></table><img src="htmlpic.png" alt="Local"><img src="https://example.com/track.png" alt="Remote">
            <iframe src="https://example.com/"></iframe><object data="https://example.com/"></object><form action="https://example.com/"><input autofocus><button>Submit</button></form>
            <svg onload="parent.postMessage('html-ran', '*')"><script>parent.postMessage('html-ran', '*')</script></svg>
            <a href="javascript:parent.postMessage('html-ran','*')">Bad link</a><a href="https://example.com/">Web</a><a href="next.htm#part">Next file</a>
            ${'<p>More readable content.</p>'.repeat(80)}<h2 id="end">End</h2><a href="#top">Top</a></body></html>`;
        writeFileSync(`${work}/demo.html`, html);
        writeFileSync(`${work}/next.htm`, `<h1>Next file</h1>${'<p>Filler.</p>'.repeat(50)}<h2 id="part">Part</h2>`);
        writeFileSync(`${work}/htmlpic.png`, pngSquare(40));
        writeFileSync(`${work}/limits.html`, Array.from({ length: 500 }, (_, i) => `<img src="htmlpic.png#${i}" alt="Repeated image">`).join(""));
        for (const name of ["demo.html", "next.htm", "htmlpic.png", "limits.html"]) {
            execFileSync("docker", ["cp", "-q", `${work}/${name}`, `${container}:/home/user/Downloads/media/${name}`]);
            execFileSync("docker", ["exec", container, "chown", "user", `/home/user/Downloads/media/${name}`]);
        }
        await open("fs/#/media/", `${listed}.includes("demo.html")`, "HTML files");
        await ev(`window.htmlRan = 0; window.addEventListener("message", (e) => { if (e.data === "html-ran") window.htmlRan++; }); localStorage.removeItem("tabtop.html-view");`);
        const show = async () => {
            await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === "demo.html").click()`);
            await waitFor(`JSON.parse(document.querySelector("dialog.preview iframe.html")?.dataset.rendered ?? "null")?.images === 1`, "HTML rendered with its local image");
        };
        await show();
        const details = await inFrame("md-frame.html", `(() => {
            const doc = document.getElementById("doc"), styled = getComputedStyle(document.getElementById("styled"));
            return { bad: doc.querySelectorAll("script, style, link, meta, base, iframe, object, form, input, button, svg, math, [onclick], [onload], [srcset]").length,
                badLinks: [...doc.querySelectorAll("a[href]")].some((a) => /^javascript:/i.test(a.getAttribute("href"))),
                text: doc.textContent, color: styled.color, position: styled.position, background: styled.backgroundImage,
                width: document.querySelector("img")?.naturalWidth, height: innerHeight };
        })()`);
        if (details.bad || details.badLinks || !details.text.includes("Styled text") || !details.text.includes("Cell") || details.color !== "rgb(12, 34, 56)" || details.position !== "static" || details.background !== "none" || details.height < 300 || await ev(`window.htmlRan`)) {
            throw new Error(`HTML sanitation: ${JSON.stringify(details)}`);
        }
        await checkPreviewLink("md-frame.html", `document.querySelector('a[href="https://example.com/"]').click()`, "https://example.com/");
        // Heading history and history across .html/.htm files.
        await inFrame("md-frame.html", `document.getElementById("end").scrollIntoView()`);
        const at = await inFrame("md-frame.html", `scrollY`);
        await inFrame("md-frame.html", `document.querySelector('a[href="#top"]').click()`);
        await waitFor(`!document.querySelector("dialog.preview button.back").hidden`, "HTML heading history");
        await ev(`document.querySelector("dialog.preview button.back").click()`);
        await sleep(100);
        if (Math.abs((await inFrame("md-frame.html", `scrollY`)) - at) > 3) throw new Error("HTML Back lost the heading position");
        await inFrame("md-frame.html", `document.querySelector('a[href="next.htm#part"]').click()`);
        await waitFor(`document.querySelector("dialog.preview .head strong").textContent === "next.htm" && !!document.querySelector("dialog.preview iframe.html")?.dataset.rendered`, "linked HTM file");
        await ev(`document.querySelector("dialog.preview button.back").click()`);
        await waitFor(`document.querySelector("dialog.preview .head strong").textContent === "demo.html" && !!document.querySelector("dialog.preview iframe.html")?.dataset.rendered`, "Back to the HTML file");
        if (Math.abs((await inFrame("md-frame.html", `scrollY`)) - at) > 3) throw new Error("HTML Back lost the file position");
        await ev(`document.querySelector('dialog.preview button[aria-label="Source: the HTML as written"]').click()`);
        await waitFor(`document.querySelector("dialog.preview pre")?.textContent.includes("<script>")`, "HTML source");
        await ev(`document.querySelector('dialog.preview button[aria-label="Rendered: the HTML as it reads"]').click()`);
        await waitFor(`!!document.querySelector("dialog.preview iframe.html")?.dataset.rendered`, "HTML rendered again");
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "HTML preview closed");
        await show();
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "HTML preview closed again");
        await ev(`[...document.querySelectorAll("td.name a")].find(a => a.textContent === "limits.html").click()`);
        await waitFor(`JSON.parse(document.querySelector("dialog.preview iframe.html")?.dataset.rendered ?? "null")?.images === 100`, "repeated images respect the per-render limit");
        if (await inFrame("md-frame.html", `document.querySelectorAll("#doc .note").length`) !== 400) throw new Error("repeated image limit did not refuse remaining images");
        // Supersede a render after it has created an image URL. URLs made by
        // that incomplete render must be revoked, along with the old display.
        await inFrame("md-frame.html", `(() => {
            window.auditURLs = []; window.auditRevoked = [];
            const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
            URL.createObjectURL = blob => { const url = create(blob); auditURLs.push(url);
                if (auditURLs.length === 1) parent.postMessage({type:"audit-picture"}, "*"); return url; };
            URL.revokeObjectURL = url => { auditRevoked.push(url); revoke(url); };
        })()`);
        await ev(`(() => {
            const frame = document.querySelector("dialog.preview iframe.html");
            const replace = event => { if (event.source !== frame.contentWindow || event.data?.type !== "audit-picture") return;
                window.removeEventListener("message", replace);
                frame.contentWindow.postMessage({type:"render", format:"html", html:"<p>Replacement without pictures</p>"}, "*"); };
            window.addEventListener("message", replace);
            frame.contentWindow.postMessage({type:"render", format:"html", html:'<img src="htmlpic.png">'.repeat(50)}, "*");
        })()`);
        await waitFor(`JSON.parse(document.querySelector("dialog.preview iframe.html")?.dataset.rendered ?? "null")?.images === 0`, "superseded image render");
        await sleep(100);
        if (!await inFrame("md-frame.html", `auditURLs.length > 0 && auditURLs.every(url => auditRevoked.includes(url))`)) {
            throw new Error("cancelled picture rendering leaked object URLs");
        }
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "limited preview closes");
        inContainer("sh", "-c", "cd ~/Downloads/media && rm demo.html next.htm htmlpic.png limits.html");
        return "sanitized HTML and inline formatting, local images, source toggle, web link confirmation and Back history";
    });
}

export async function checkMarkdownRender(checks) {
    const { work, container, inContainer, sleep, step, ev, waitFor, click, open, listed, inMarkdownFrame, rendered } = checks;
    await step("files: preview Markdown, rendered", async () => {
        writeFileSync(`${work}/doc.md`, "# Notes\n\nInline $e^{i\\pi} + 1 = 0$, and on its own:\n\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$\n\n| Thing | Count |\n|:--|--:|\n| apples | 3 |\n\n```go\nfunc main() { fmt.Println(\"hi\") }\n```\n\n```mermaid\ngraph LR; A[Start] --> B[End]\n```\n\n![pixel](pic.png) ![remote](https://example.com/x.png)\n\n<script>document.title = \"ran\"</script>\n");
        execFileSync("docker", ["cp", "-q", `${work}/doc.md`, `${container}:/home/user/Downloads/media/doc.md`]);
        inContainer("sh", "-c", "echo iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg== "
            + "| base64 -d > ~/Downloads/media/pic.png");
        execFileSync("docker", ["exec", container, "chown", "user", "/home/user/Downloads/media/doc.md"]);
        await open("fs/#/media/", `${listed}.includes("doc.md") && ${listed}.includes("pic.png")`, "doc.md");
        const title = await ev("document.title");
        await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === "doc.md").click()`);
        await waitFor(`!!document.querySelector("dialog.preview iframe.markdown")?.dataset.rendered`, "doc.md, rendered", 60000);
        const report = JSON.parse(await ev(`document.querySelector("dialog.preview iframe.markdown").dataset.rendered`));
        if (report.math !== 2 || report.diagrams !== 1 || report.code !== 1 || report.images !== 1 || report.remote !== 1 || report.errors.length) {
            throw new Error(`rendered: ${JSON.stringify(report)}`);
        }
        const sandbox = await ev(`document.querySelector("dialog.preview iframe.markdown").getAttribute("sandbox")`);
        if (sandbox.includes("allow-same-origin") || await ev("document.title") !== title) {
            throw new Error(`the frame is sandboxed as "${sandbox}", or something in it ran here`);
        }
        // Its source, coloured; and back; the choice remembered.
        await ev(`document.querySelector('dialog.preview .views button[aria-pressed="false"]').click()`);
        await waitFor(`document.querySelector("dialog.preview pre.coloured")?.textContent.startsWith("# Notes")`, "doc.md's source");
        if (await ev(`localStorage.getItem("tabtop.markdown-view")`) !== "source") {
            throw new Error("the choice of source wasn't kept");
        }
        await ev(`document.querySelector('dialog.preview .views button[aria-pressed="false"]').click()`);
        await waitFor(`!!document.querySelector("dialog.preview iframe.markdown")?.dataset.rendered`, "doc.md, rendered again", 60000);
        // Dark, as chosen (◐, ☀, then ☾), and kept, for the next opened.
        const themeButton = `document.querySelector("dialog.preview button.theme")`;
        const frameTheme = `(document.documentElement.dataset.theme ?? "") + " " + getComputedStyle(document.body).backgroundColor`;
        await ev(`${themeButton}.click()`);
        await ev(`${themeButton}.click()`);
        for (let i = 0; await inMarkdownFrame(frameTheme) !== "dark rgb(28, 28, 30)"; i++) {
            if (i === 20) {
                throw new Error(`the frame, set dark: ${await inMarkdownFrame(frameTheme)}`);
            }
            await sleep(100);
        }
        if (await ev(`localStorage.getItem("tabtop.reading-theme")`) !== "dark" || await ev(`${themeButton}.textContent`) !== "☾") {
            throw new Error("dark wasn't kept");
        }
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "the preview to close");
        await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === "doc.md").click()`);
        await waitFor(`!!document.querySelector("dialog.preview iframe.markdown")?.dataset.rendered`, "doc.md, opened again", 60000);
        if (await inMarkdownFrame(frameTheme) !== "dark rgb(28, 28, 30)") {
            throw new Error(`opened again: ${await inMarkdownFrame(frameTheme)}`);
        }
        // Back to as the system is.
        await ev(`${themeButton}.click()`);
        await waitFor(`localStorage.getItem("tabtop.reading-theme") === ""`, "the system's theme again");
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "the preview to close");
        inContainer("sh", "-c", "cd ~/Downloads/media && rm doc.md pic.png");
        await open("fs/#/", `document.title === "Downloads /" && !!document.querySelector("table")`, "the listing");
        return `math ${report.math}, diagrams ${report.diagrams}, code ${report.code}, pictures ${report.images}, remote left out ${report.remote}`;
    });
}

export async function checkMarkdownLinks(checks) {
    const { work, container, inContainer, sleep, step, ev, waitFor, click, open, listed, inMarkdownFrame, checkPreviewLink, rendered } = checks;
    await step("files: Markdown links, front matter and contents", async () => {
        inContainer("sh", "-c", "mkdir -p ~/Downloads/media/more");
        writeFileSync(`${work}/index.md`, "---\ntitle: Index\ntags: [check]\n---\n# Index\n\n## One\n\n## Two\n\n## Three\n\nSee [the page](more/page.md#part-two). [Web](https://example.com/).\n");
        writeFileSync(`${work}/page.md`, "# Page\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\nFiller.\n\n## Part two\n\nBack [to the index](../index.md).\n");
        for (const [from, to] of [["index.md", "media/index.md"], ["page.md", "media/more/page.md"]]) {
            execFileSync("docker", ["cp", "-q", `${work}/${from}`, `${container}:/home/user/Downloads/${to}`]);
            execFileSync("docker", ["exec", container, "chown", "user", `/home/user/Downloads/${to}`]);
        }
        await open("fs/#/media/", `${listed}.includes("index.md")`, "index.md");
        await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === "index.md").click()`);
        await waitFor(`${rendered}?.contents === 4`, "index.md, rendered with its contents");
        if (!(await ev(`${rendered}.frontMatter`))) {
            throw new Error("index.md's front matter isn't folded away");
        }
        await checkPreviewLink("md-frame.html", `document.querySelector('a[href="https://example.com/"]').click()`, "https://example.com/");
        // Its link to another file, in another folder: opened here, at
        // the heading it names, with Back.
        await ev(`document.querySelector("dialog.preview iframe.markdown").dataset.rendered = ""`);
        await inMarkdownFrame(`document.querySelector('a[href="more/page.md#part-two"]').click()`);
        await waitFor(`document.querySelector("dialog.preview .head strong").textContent === "media/more/page.md" && !!${rendered}
            && !document.querySelector("dialog.preview button.back").hidden`, "page.md, from the link");
        if ((await ev(`${rendered}.scrolled`)) < 100) {
            throw new Error("page.md wasn't scrolled to Part two");
        }
        const linkedPosition = await inMarkdownFrame(`scrollY`);
        await inMarkdownFrame(`(() => { const a = document.createElement("a"); a.href = "#page"; document.getElementById("doc").append(a); a.click(); })()`);
        if ((await inMarkdownFrame(`scrollY`)) > 100) throw new Error("Markdown heading link didn't jump to the top");
        await ev(`document.querySelector("dialog.preview button.back").click()`);
        await sleep(100);
        if (Math.abs((await inMarkdownFrame(`scrollY`)) - linkedPosition) > 3) throw new Error("Markdown Back lost the heading position");
        await ev(`document.querySelector("dialog.preview button.back").click()`);
        await waitFor(`document.querySelector("dialog.preview .head strong").textContent === "index.md"
            && document.querySelector("dialog.preview button.back").hidden`, "back at index.md");
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "the preview to close");
        return "contents of 4, front matter folded, a link followed to its heading, and back";
    });
}

export async function checkTextEdit(checks) {
    const { downloads, waitForFile, inContainer, sleep, step, ev, waitFor, click, type, open, listed, answer, status, rendered, press, cdp } = checks;
    await step("files: edit a file and save it", async () => {
        inContainer("sh", "-c", "mkdir -p ~/Downloads/media/more; printf '# Index\\n' > ~/Downloads/media/index.md");
        inContainer("sh", "-c", "printf '#!/bin/sh\\r\\necho one\\r\\n' > ~/Downloads/media/edit.sh && chmod 755 ~/Downloads/media/edit.sh");
        const statEdit = () => inContainer("stat", "-c", "%y %s inode %i", "/home/user/Downloads/media/edit.sh");
        const made = statEdit();
        await open("fs/#/media/", `${listed}.includes("edit.sh")`, "edit.sh");
        const preview = async (name) => {
            await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === ${JSON.stringify(name)}).click()`);
            await waitFor(`!!document.querySelector("dialog.preview button.edit:not([hidden])")`, `${name}, with Edit`);
            await ev(`document.querySelector("dialog.preview button.edit").click()`);
            await waitFor(`!!document.querySelector("dialog.preview textarea.editor")`, `${name}'s editor`);
        };
        const type = (text) => ev(`(() => { const b = document.querySelector("dialog.preview textarea.editor"); b.value = ${JSON.stringify(text)};
            b.dispatchEvent(new Event("input")); })()`);
        const saveKeys = () => ev(`document.querySelector("dialog.preview textarea.editor").dispatchEvent(new KeyboardEvent("keydown",
            { key: "s", ctrlKey: true, bubbles: true }))`);
        // In brackets: in "a ?? b === c", === goes first.
        const note = `(document.querySelector("dialog.preview .edit-status")?.textContent ?? "")`;
        await preview("edit.sh");
        const highlighted = `document.querySelector("dialog.preview .syntax-editor.highlighted")`;
        await waitFor(`!!${highlighted}?.querySelector(".hljs-meta")`, "shell syntax highlighted in the editor");
        const syntaxToggle = `document.querySelector("dialog.preview button.syntax-toggle")`;
        const cursorLocation = `document.querySelector("dialog.preview .head .editor-position")`;
        await waitFor(`!!${cursorLocation}`, "cursor location in the editor toolbar");
        await ev(`(() => { const b = document.querySelector("textarea.editor"); b.setSelectionRange(0, b.value.indexOf("\\n") + 1, "backward"); })()`);
        await waitFor(`${cursorLocation}.textContent === "1:1"`, "backward selection shows its active endpoint");
        await ev(`(() => { const b = document.querySelector("textarea.editor"); b.setSelectionRange(0, b.value.indexOf("\\n") + 1, "forward"); })()`);
        await waitFor(`${cursorLocation}.textContent === "2:1"`, "forward selection shows its active endpoint");
        if (!await ev(`${syntaxToggle}.nextElementSibling?.classList.contains("widen")
            && getComputedStyle(document.querySelector(".edit-bar")).display === "none"
            && document.querySelector(".save-edit").title.includes("Ctrl S")`)) {
            throw new Error("the edit hint bar is visible or the syntax toggle is not before fullscreen");
        }
        await click(syntaxToggle);
        await type("#!/bin/sh\necho toggle\n");
        await sleep(250);
        if (await ev(`!!${highlighted} || ${syntaxToggle}.getAttribute("aria-pressed") !== "false"`)) {
            throw new Error("syntax highlighting did not stay off while typing");
        }
        await click(syntaxToggle);
        await waitFor(`!!${highlighted} && ${syntaxToggle}.getAttribute("aria-pressed") === "true"`, "syntax highlighting re-enabled");
        const toolbarSaved = await ev(`(() => {
            const glyph = ${syntaxToggle}; glyph.focus();
            const event = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true });
            glyph.dispatchEvent(event); return event.defaultPrevented;
        })()`);
        if (!toolbarSaved) throw new Error("Ctrl+S from the syntax toolbar control did not save");
        await waitFor(`${note} === "Saved."`, "save from the toolbar shortcut");
        if (await ev(`document.querySelector("textarea.editor").value`) !== "#!/bin/sh\necho toggle\n") {
            throw new Error("toggling syntax highlighting changed the text");
        }
        await type("#!/bin/sh\necho one\n");
        await waitFor(`!!${highlighted}`, "original shell source highlighted");
        await ev(`document.querySelector("textarea.editor").dispatchEvent(new CompositionEvent("compositionstart"))`);
        if (await ev(`!!${highlighted}`)) throw new Error("highlighting obscures composition input");
        await ev(`document.querySelector("textarea.editor").dispatchEvent(new CompositionEvent("compositionend"))`);
        await waitFor(`!!${highlighted}`, "highlighting resumes after composition");
        if (await ev(`document.querySelector("dialog.preview textarea.editor").value`) !== "#!/bin/sh\necho one\n") {
            throw new Error("the editor doesn't hold edit.sh's text");
        }
        await type("#!/bin/sh\necho two\n");
        await waitFor(`${highlighted}?.querySelector("code")?.textContent === "#!/bin/sh\\necho two\\n\\n"`, "highlighting updates as typed");
        // Real textarea remains the input; the painted copy tracks scrolling
        // and handles source that looks like markup as inert text.
        await type('#!/bin/sh\n' + 'echo "<img src=x onerror=alert(1)>"\n'.repeat(120));
        await waitFor(`!!${highlighted}`, "long highlighted source");
        if (!await ev(`(() => {
            const b = document.querySelector("textarea.editor"), p = document.querySelector(".editor-highlight");
            b.scrollTop = 400; b.dispatchEvent(new Event("scroll"));
            return b.scrollTop > 0 && b.scrollTop === p.scrollTop && b.clientWidth === p.clientWidth
                && getComputedStyle(b).lineHeight === getComputedStyle(p).lineHeight
                && p.textContent === b.value + "\\n" && !p.querySelector("img");
        })()`)) throw new Error("the highlighted editor lost source text, scroll alignment or markup safety");
        // Go to a logical line, reveal it, and preserve the edited source.
        const goto = async (target = 'document.querySelector("textarea.editor")') => {
            if (!await ev(`(() => { const target = ${target}; target.focus();
                const e = new KeyboardEvent("keydown", { key: "g", ctrlKey: true, bubbles: true, cancelable: true });
                target.dispatchEvent(e); return e.defaultPrevented; })()`)) throw new Error("Ctrl+G was not handled");
            await waitFor(`!!document.querySelector('input[aria-label="Line number"]')`, "Go to line dialog");
        };
        await goto();
        if (!await ev(`(() => { const input = document.querySelector('input[aria-label="Line number"]');
            let invalid = true;
            for (const value of ["0", "99999", "100:0", "-1", "1.5", "1:2:3"]) {
                input.value = value; input.dispatchEvent(new Event("input"));
                invalid &&= !input.checkValidity();
            }
            input.value = "100"; input.dispatchEvent(new Event("input"));
            return invalid && input.checkValidity(); })()`)) throw new Error("Go to line accepted an invalid location");
        await press("Enter");
        await waitFor(`document.activeElement === document.querySelector("textarea.editor") &&
            document.querySelector("textarea.editor").selectionStart === document.querySelector("textarea.editor").value.split("\\n").slice(0, 99).join("\\n").length + 1`, "caret on line 100");
        if (!await ev(`document.querySelector("textarea.editor").scrollTop > 0 && document.querySelector("textarea.editor").value.startsWith("#!/bin/sh")`)) throw new Error("Go to line did not scroll or changed the source");
        await waitFor(`${cursorLocation}.textContent === "100:1"`, "cursor location follows Go to line");
        await cdp("Input.insertText", { text: "goto-focus-check" });
        await waitFor(`${cursorLocation}.textContent === "100:17"`, "cursor location follows typing");
        await press("ArrowLeft");
        await waitFor(`${cursorLocation}.textContent === "100:16"`, "cursor location follows arrow keys");
        if (!await ev(`document.querySelector("textarea.editor").value.split("\\n")[99].startsWith("goto-focus-check")`)) {
            throw new Error("typing immediately after Go to line did not reach the target line");
        }
        await goto(syntaxToggle);
        await ev(`(() => { const input = document.querySelector('input[aria-label="Line number"]');
            if (input.value !== "100:16") throw new Error("current line and column were not offered");
            })()`);
        await press("Escape");
        await waitFor(`!document.querySelector('input[aria-label="Line number"]')`, "Go to line cancelled");
        await waitFor(`document.activeElement === document.querySelector("textarea.editor")`, "editor focused after cancelling Go to line");
        // Clicking the compact toolbar location opens the same dialog.
        await click(cursorLocation);
        await waitFor(`!!document.querySelector('input[aria-label="Line number"]')`, "Go to line from the toolbar location");
        await ev(`(() => { const input = document.querySelector('input[aria-label="Line number"]');
            input.value = "100:4"; input.dispatchEvent(new Event("input")); })()`);
        await press("Enter");
        await waitFor(`${cursorLocation}.textContent === "100:4" && document.activeElement === document.querySelector("textarea.editor")`, "jump to a line and column");
        await cdp("Input.insertText", { text: "column-check" });
        if (!await ev(`document.querySelector("textarea.editor").value.split("\\n")[99].startsWith("gotcolumn-checko-focus-check")`)) throw new Error("typing after a column jump went to the wrong position");
        await click(cursorLocation);
        await waitFor(`!!document.querySelector('input[aria-label="Line number"]')`, "Go to line again");
        await ev(`(() => { const input = document.querySelector('input[aria-label="Line number"]');
            input.value = "2:9999"; input.dispatchEvent(new Event("input")); })()`);
        await press("Enter");
        await waitFor(`${cursorLocation}.textContent === "2:" + (document.querySelector("textarea.editor").value.split("\\n")[1].length + 1)`, "column past the line clamps to its end");
        await type("x".repeat(512 * 1024 + 1));
        await sleep(250);
        if (await ev(`!!${highlighted}`)) throw new Error("large text was highlighted past the preview's cap");
        await type("#!/bin/sh\necho two\n");
        await saveKeys();
        await waitFor(`${note} === "Saved."`, "the save");
        // Its line endings and permissions, kept.
        const held = inContainer("sh", "-c", "od -An -c ~/Downloads/media/edit.sh | tr -s ' '");
        const want = inContainer("sh", "-c", "printf '#!/bin/sh\\r\\necho two\\r\\n' | od -An -c | tr -s ' '");
        const mode = inContainer("stat", "-c", "%a", "/home/user/Downloads/media/edit.sh");
        if (held !== want || mode !== "755") {
            // What the editor had, when the save's answer says the file
            // changed, and the file then and a little later.
            const box = await ev(`document.querySelector("dialog.preview textarea.editor")?.value`);
            const replied = await ev(`document.querySelector("dialog.preview .edit-status")?.dataset.mtime`);
            const stat = statEdit();
            await sleep(2000);
            const later = inContainer("sh", "-c", "od -An -c ~/Downloads/media/edit.sh | tr -s ' '");
            throw new Error(`edit.sh holds ${JSON.stringify(held)}, mode ${mode}; want ${JSON.stringify(want)}, 755. `
                + `The editor had ${JSON.stringify(box)}; the save answered mtime ${replied}; the file was made ${made}, was ${stat} `
                + `when read, and 2 s later is ${statEdit()}, holding ${JSON.stringify(later)}`);
        }
        // Changed meanwhile, by something else: not saved over.
        inContainer("sh", "-c", "sleep 0.01; echo '# added elsewhere' >> ~/Downloads/media/edit.sh");
        await type("#!/bin/sh\necho three\n");
        await saveKeys();
        await waitFor(`${note}.includes("Not saved: It's been changed since it was opened")`, "the save refused");
        await waitFor(`document.querySelector(".download-changes")?.hidden === false && document.querySelector(".save-status")?.classList.contains("error")`, "unsaved changes can be downloaded after a conflict");
        await click(`document.querySelector(".download-changes")`);
        await waitForFile(`${downloads}/edit.sh`, "a copy of unsaved changes");
        if (readFileSync(`${downloads}/edit.sh`, "utf8") !== "#!/bin/sh\r\necho three\r\n") throw new Error("recovery download lost unsaved text or line endings");
        rmSync(`${downloads}/edit.sh`);
        if (!inContainer("cat", "/home/user/Downloads/media/edit.sh").includes("added elsewhere")) {
            throw new Error("the save went over the change made elsewhere");
        }
        // Done, with changes not saved: asked first.
        await click(syntaxToggle);
        await ev(`document.querySelector("dialog.preview button.done-edit").click()`);
        await waitFor(`(document.querySelectorAll("dialog[open]")[1]?.textContent ?? "").includes("aren't saved")`, "the question");
        await answer();
        await waitFor(`!document.querySelector("dialog.preview textarea.editor")`, "editing ended");
        if (await ev(`!!${cursorLocation}`)) throw new Error("cursor location remained after leaving edit mode");
        if (await ev(`!!document.querySelector("dialog.preview .syntax-toggle")`)) throw new Error("the edit syntax toggle remained after Done");
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "the preview to close");
        // Markdown: rendered beside it, as it's typed.
        await preview("index.md");
        if (await ev(`${syntaxToggle}.getAttribute("aria-pressed")`) !== "false") throw new Error("syntax preference was lost between files");
        await click(syntaxToggle);
        await waitFor(`!!${highlighted}?.querySelector(".hljs-section")`, "Markdown syntax highlighted beside its preview");
        await waitFor(`!!document.querySelector("dialog.preview .editing iframe.markdown")?.dataset.rendered`, "index.md, rendered beside it");
        await ev(`document.querySelector("dialog.preview .editing iframe.markdown").dataset.rendered = ""`);
        await type("# Changed\n\n$x^2$\n");
        await waitFor(`JSON.parse(document.querySelector("dialog.preview .editing iframe.markdown").dataset.rendered || "null")?.math === 1`,
            "the change, rendered");

        await ev(`document.querySelector("dialog.preview button.done-edit").click()`);
        await answer();
        await waitFor(`!document.querySelector("dialog.preview textarea.editor")`, "editing ended");
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "the preview to close");
        inContainer("sh", "-c", "cd ~/Downloads/media && rm -r edit.sh index.md more");
        await open("fs/#/", `document.title === "Downloads /" && !!document.querySelector("table")`, "the listing");
        return "live syntax highlighting, scrolling and composition, large-file fallback, CRLF and 755 kept, stale save refused, recovery download, Markdown rendered as typed";
    });
}

export async function checkPDF(checks) {
    const { work, container, inContainer, sleep, step, cdp, ev, waitFor, click, press, open, listed, inFrame, checkPreviewLink, rendered } = checks;
    await step("files: preview a PDF, a part at a time", async () => {
        // 40 pages: the first with text and a link, each after with a big
        // picture that doesn't compress, so most of the file is pages not
        // looked at yet.
        writeFileSync(`${work}/pdf-source.html`, `<!doctype html><style>@page { size: A4; margin: 1cm } section { page-break-after: always }
            canvas { width: 17cm; height: 17cm }</style>
            <section><h1>A PDF</h1><p>The first page, with <a href="https://example.com/">a link to example.com</a>. <a href="#page-three">Jump ahead</a></p></section>
            ${Array.from({ length: 39 }, (_, i) => `<section id="${i === 1 ? "page-three" : "p" + (i + 2)}"><h2>Page ${i + 2}</h2><canvas width="900" height="900"></canvas></section>`).join("")}
            <script>for (const c of document.querySelectorAll("canvas")) { const x = c.getContext("2d"), d = x.createImageData(900, 900);
            for (let i = 0; i < d.data.length; i++) d.data[i] = Math.random() * 256 | 0; x.putImageData(d, 0, 0); } window.done = true;</script>`);
        // And 10 pages of pictures alone, as a scanned PDF is.
        writeFileSync(`${work}/scanned-source.html`, `<!doctype html><style>@page { size: A4; margin: 1cm } div { page-break-after: always }
            canvas { width: 10cm; height: 10cm }</style>
            ${Array.from({ length: 10 }, () => `<div><canvas width="60" height="60"></canvas></div>`).join("")}
            <script>for (const c of document.querySelectorAll("canvas")) { const x = c.getContext("2d"); x.fillStyle = "#468"; x.fillRect(5, 5, 50, 50); }
            window.done = true;</script>`);
        const printed = async (source, name) => {
            await cdp("Page.navigate", { url: `file://${work}/${source}` });
            await waitFor("window.done === true", `${name}'s source`);
            const { stream } = await cdp("Page.printToPDF", { printBackground: true, transferMode: "ReturnAsStream" });
            const parts = [];
            for (;;) {
                const r = await cdp("IO.read", { handle: stream, size: 1 << 20 });
                parts.push(Buffer.from(r.data, r.base64Encoded ? "base64" : "utf8"));
                if (r.eof) {
                    break;
                }
            }
            await cdp("IO.close", { handle: stream });
            const pdf = Buffer.concat(parts);
            writeFileSync(`${work}/${name}`, pdf);
            execFileSync("docker", ["cp", "-q", `${work}/${name}`, `${container}:/home/user/Downloads/media/${name}`]);
            execFileSync("docker", ["exec", container, "chown", "user", `/home/user/Downloads/media/${name}`]);
            return pdf;
        };
        const pdf = await printed("pdf-source.html", "big.pdf");
        await printed("scanned-source.html", "scanned.pdf");

        await open("fs/#/media/", `${listed}.includes("big.pdf")`, "big.pdf");
        await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === "big.pdf").click()`);
        const report = `JSON.parse(document.querySelector("dialog.preview iframe.pdf")?.dataset.rendered ?? "null")`;
        const fetched = `Number(document.querySelector("dialog.preview iframe.pdf")?.dataset.bytes ?? 0)`;
        await waitFor(`${report}?.pages === 40 && ${report}.drawn.includes(1)`, "big.pdf's first page", 60000);
        const first = await ev(fetched);
        const r1 = await ev(report);
        if (r1.errors.length || r1.links < 1) {
            throw new Error(`the first page: ${JSON.stringify(r1)}`);
        }
        if (first > pdf.length / 4) {
            throw new Error(`${first} bytes of ${pdf.length} fetched for the first page`);
        }
        await checkPreviewLink("pdf-frame.html", `document.querySelector('.page[data-page="1"] a[href="https://example.com/"]').click()`, "https://example.com/");
        // Its text: over it, where it's drawn, to be selected.
        await waitFor(`${report}?.text.includes(1)`, "the first page's text", 30000);
        const text = await inFrame("pdf-frame.html", `(() => {
            const box = document.querySelector('.page[data-page="1"]'), layer = box.querySelector(".textLayer");
            const heading = [...layer.querySelectorAll("span")].find((s) => s.textContent.includes("A PDF"));
            const r = new Range();
            r.selectNodeContents(layer);
            getSelection().removeAllRanges();
            getSelection().addRange(r);
            const b = box.getBoundingClientRect(), h = heading?.getBoundingClientRect();
            return { selected: getSelection().toString(), inside: !!h && h.width > 20 && h.left >= b.left && h.right <= b.right && h.top >= b.top && h.bottom <= b.top + b.height / 4 };
        })()`);
        if (!/A PDF/.test(text.selected) || !/first page/.test(text.selected) || !text.inside) {
            throw new Error(`the first page's text: ${JSON.stringify(text)}`);
        }
        // The last page: fetched as it's shown, without those between.
        await inFrame("pdf-frame.html", `document.querySelector('.page[data-page="40"]').scrollIntoView()`);
        await waitFor(`${report}?.drawn.includes(40)`, "big.pdf's last page", 60000);
        const last = await ev(fetched);
        if (last <= first || last > pdf.length / 2) {
            throw new Error(`${last} bytes of ${pdf.length} fetched by the last page, ${first} by the first`);
        }
        // Internal PDF links retain the prior page and reading position.
        await inFrame("pdf-frame.html", `scrollTo(0, 150)`);
        await waitFor(`${report}?.drawn.includes(1)`, "the first page redrawn");
        const pdfPosition = await inFrame("pdf-frame.html", `scrollY`);
        await inFrame("pdf-frame.html", `document.querySelector('.page[data-page="1"] a[href="#"]').click()`);
        await waitFor(`!document.querySelector("dialog.preview button.back").hidden && ${report}?.drawn.includes(3)`, "the PDF link to page three");
        await inFrame("pdf-frame.html", `document.querySelector("#bar button.fit-page").click()`);
        await ev(`document.querySelector("dialog.preview button.back").click()`);
        await sleep(200);
        if (Math.abs((await inFrame("pdf-frame.html", `scrollY`)) - pdfPosition) > 3) throw new Error("PDF Back lost the original reading position");
        await waitFor(`document.querySelector("dialog.preview button.back").hidden`, "PDF history exhausted");
        if (!(await inFrame("pdf-frame.html", `document.querySelector("#bar button.fit-width").getAttribute("aria-pressed") === "true"`))) throw new Error("PDF Back didn't restore its zoom mode");
        // A page asked for, by clicking where it says which: gone to.
        await inFrame("pdf-frame.html", `(() => { document.querySelector("#bar button.where").click(); const b = document.querySelector("#bar input.go-to");
            b.value = "25"; b.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
        await waitFor(`${report}?.drawn.includes(25)`, "page 25, asked for", 60000);
        for (let i = 0; ; i++) {
            const at = await inFrame("pdf-frame.html", `!document.querySelector("#bar .where").hidden && document.querySelector("#bar .where").textContent`);
            if (at === "Page 25 of 40") {
                break;
            }
            if (i === 20) {
                throw new Error(`gone to page 25, the bar says ${at}`);
            }
            await sleep(100);
        }
        // Escape, and nothing's asked.
        const asked = await inFrame("pdf-frame.html", `(() => { document.querySelector("#bar button.where").click(); const b = document.querySelector("#bar input.go-to");
            const shown = !b.hidden; b.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            return shown && b.hidden && !document.querySelector("#bar .where").hidden; })()`);
        if (!asked) {
            throw new Error("the page box didn't open, or close with Escape");
        }
        // Fit uses both dimensions, and grows beyond the former 1,000px cap.
        const assertFitted = async (wide = false) => {
            let size;
            for (let i = 0; i < 100; i++) {
                size = await inFrame("pdf-frame.html", `(() => {
                    const bar = document.querySelector("#bar");
                    const n = Number(document.querySelector("button.where").textContent.match(/\\d+/)?.[0]);
                    const box = document.querySelector('.page[data-page="' + n + '"]');
                    const r = box.getBoundingClientRect();
                    const w = document.querySelector("#pages").clientWidth - 16, h = innerHeight - bar.offsetHeight - 24;
                    return { width: r.width, height: r.height, fitted: !!box.querySelector("canvas") && r.width <= w + 1 && r.height <= h + 1
                        && Math.min(Math.abs(r.width - w), Math.abs(r.height - h)) <= 2
                        && r.top >= bar.getBoundingClientRect().bottom - 1 && r.bottom <= innerHeight + 1 };
                })()`);
                if (size.fitted && (!wide || size.width > 1000)) {
                    return;
                }
                await sleep(200);
            }
            throw new Error(`the PDF didn't fit the window: ${JSON.stringify(size)}`);
        };
        await inFrame("pdf-frame.html", `[...document.querySelectorAll("#bar button")].find((b) => b.title === "Zoom in").click();
            document.querySelector("#bar button.fit-page").click()`);
        await assertFitted();
        const wasWide = await ev(`document.querySelector("dialog.preview button.widen").getAttribute("aria-pressed") === "true"`);
        try {
            await cdp("Emulation.setDeviceMetricsOverride", { width: 1800, height: 1800, deviceScaleFactor: 1, mobile: false });
            if (!wasWide) {
                await ev(`document.querySelector("dialog.preview button.widen").click()`);
            }
            await assertFitted(true);
        } finally {
            await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
            if (!wasWide) {
                await ev(`document.querySelector("dialog.preview button.widen").click()`);
            }
        }
        await assertFitted();
        // 100% is a fixed PDF-point-to-CSS-pixel scale, independent of the window.
        const mediaBox = /\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/.exec(pdf.toString("latin1"));
        if (!mediaBox) {
            throw new Error("the PDF fixture has no MediaBox");
        }
        const actualWidth = (Number(mediaBox[3]) - Number(mediaBox[1])) * 96 / 72;
        const actualHeight = (Number(mediaBox[4]) - Number(mediaBox[2])) * 96 / 72;
        const assertActual = async () => {
            let size;
            for (let i = 0; i < 100; i++) {
                size = await inFrame("pdf-frame.html", `(() => {
                    const n = Number(document.querySelector("button.where").textContent.match(/\\d+/)?.[0]);
                    const box = document.querySelector('.page[data-page="' + n + '"]');
                    const r = box.getBoundingClientRect();
                    return { width: r.width, height: r.height, drawn: !!box.querySelector("canvas"),
                        actual: document.querySelector("button.actual-size").getAttribute("aria-pressed") === "true",
                        fit: document.querySelector("button.fit-page").getAttribute("aria-pressed") === "true" };
                })()`);
                if (size.drawn && size.actual && !size.fit && Math.abs(size.width - actualWidth) <= 1 && Math.abs(size.height - actualHeight) <= 1) {
                    return;
                }
                await sleep(200);
            }
            throw new Error(`100% wasn't the fixed PDF size: ${JSON.stringify(size)}`);
        };
        await inFrame("pdf-frame.html", `document.querySelector("button.actual-size").click()`);
        await assertActual();
        await inFrame("pdf-frame.html", `[...document.querySelectorAll("#bar button")].find((b) => b.title === "Zoom in").click();
            document.querySelector("button.actual-size").click()`);
        await assertActual();
        try {
            await cdp("Emulation.setDeviceMetricsOverride", { width: 1800, height: 1000, deviceScaleFactor: 1, mobile: false });
            await sleep(300); // let the frame's resize layout run before checking its fixed scale
            await assertActual();
        } finally {
            await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        }
        // The adjacent width preset fills the container and follows resizing.
        const assertWidth = async () => {
            let size;
            for (let i = 0; i < 100; i++) {
                size = await inFrame("pdf-frame.html", `(() => {
                    const n = Number(document.querySelector("button.where").textContent.match(/\\d+/)?.[0]);
                    const box = document.querySelector('.page[data-page="' + n + '"]');
                    return { width: box.getBoundingClientRect().width, available: document.querySelector("#pages").clientWidth - 16,
                        drawn: !!box.querySelector("canvas"), selected: document.querySelector("button.fit-width").getAttribute("aria-pressed") === "true",
                        other: !!document.querySelector("button.fit-page[aria-pressed=true], button.actual-size[aria-pressed=true]") };
                })()`);
                if (size.drawn && size.selected && !size.other && Math.abs(size.width - size.available) <= 1) {
                    return;
                }
                await sleep(200);
            }
            throw new Error(`the PDF didn't fit the preview width: ${JSON.stringify(size)}`);
        };
        await inFrame("pdf-frame.html", `document.querySelector("button.fit-width").click()`);
        await assertWidth();
        try {
            await cdp("Emulation.setDeviceMetricsOverride", { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false });
            await sleep(300);
            await assertWidth();
        } finally {
            await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        }
        await inFrame("pdf-frame.html", `document.querySelector("button.fit-page").click()`);
        await assertFitted();
        // Find: through every page's text, to the match, highlighted.
        const findFor = (q) => inFrame("pdf-frame.html", `(() => { const f = document.querySelector("input.find"); f.value = ${JSON.stringify(q)};
            f.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
        const foundNow = `${report}?.found`;
        // Ctrl+F, pressed in the page, not the frame: to the frame's Find.
        await ev(`document.querySelector("dialog.preview button.close").focus()`);
        await press("f", 2);
        for (let i = 0; await inFrame("pdf-frame.html", `document.activeElement?.className`) !== "find"; i++) {
            if (i === 20) {
                throw new Error("Ctrl+F didn't go to Find");
            }
            await sleep(100);
        }
        // Mostly pictures, so it stops to ask once it's fetched 32 MB more.
        const beforeFind = await ev(fetched);
        await findFor("page 37");
        await waitFor(`${foundNow}.paused.startsWith("Fetched")`, "finding to stop and ask", 60000);
        const atPause = await ev(fetched);
        if (atPause - beforeFind > 48 << 20) {
            throw new Error(`${atPause - beforeFind} bytes fetched before finding asked`);
        }
        await inFrame("pdf-frame.html", `document.querySelector("button.keep-looking").click()`);
        await waitFor(`${foundNow}.searched === 40 && ${foundNow}.matches === 1 && ${foundNow}.page === 37 && ${report}.text.includes(37)`, "page 37 found", 60000);
        const lit = await inFrame("pdf-frame.html", `(() => { const h = CSS.highlights.get("found-current"); const [r] = h ?? [];
            return { size: h?.size ?? 0, text: r?.toString() ?? "", top: r?.getBoundingClientRect().top ?? -1, height: innerHeight,
                where: document.querySelector(".where").textContent }; })()`);
        if (lit.size !== 1 || !/^Page\s+37$/.test(lit.text) || lit.top < 0 || lit.top > lit.height || lit.where !== "Page 37 of 40") {
            throw new Error(`page 37's match: ${JSON.stringify(lit)}`);
        }
        await findFor("PAGE");
        await waitFor(`${foundNow}.query === "PAGE" && ${foundNow}.searched === 40`, "every page searched", 60000);
        const pageMatches = (await ev(report)).found.matches;
        if (pageMatches !== 40) {
            throw new Error(`"PAGE" found ${pageMatches} times, not 40`);
        }
        const searched = await ev(fetched);
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "the preview to close");

        // A PDF without text: finding stops after the first pages, till asked.
        await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === "scanned.pdf").click()`);
        await waitFor(`${report}?.pages === 10 && ${report}.drawn.includes(1)`, "scanned.pdf's first page", 60000);
        await findFor("anything");
        await waitFor(`${foundNow}.paused && ${foundNow}.searched === 8`, "finding to stop at 8 pages", 60000);
        await inFrame("pdf-frame.html", `document.querySelector("button.keep-looking").click()`);
        await waitFor(`!${foundNow}.paused && ${foundNow}.searched === 10 && ${foundNow}.matches === 0`, "the rest looked through", 60000);
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "the preview to close");
        inContainer("sh", "-c", "rm ~/Downloads/media/big.pdf ~/Downloads/media/scanned.pdf");
        await open("fs/#/", `document.title === "Downloads /" && !!document.querySelector("table")`, "the listing");
        return `${(pdf.length / 1e6).toFixed(1)} MB, 40 pages: ${(first / 1e3).toFixed(0)} KB for page 1, ${(last / 1e6).toFixed(1)} MB with page 40, ` +
            `asked after ${((atPause - beforeFind) / 1e6).toFixed(1)} MB more, ${(searched / 1e6).toFixed(1)} MB once searched; ` +
            "text selected, found with Ctrl+F and highlighted; a scanned one's finding stopped till asked";
    });
}

export async function checkEPUBPictureBudget({ work, container, inContainer, step, ev, waitFor, open, listed, inFrame }) {
    await step("files: bound EPUB picture memory per chapter", async () => {
        const picture = Buffer.alloc(20 * 1024 * 1024);
        pngSquare(20).copy(picture); // Valid PNG with harmless padding up to the per-image cap.
        const chapter = body => `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Budget</title></head><body>${body}</body></html>`;
        const book = zipFile([
            ["mimetype", "application/epub+zip"],
            ["META-INF/container.xml", `<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`],
            ["book.opf", `<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Picture budget</dc:title></metadata><manifest>` +
                `<item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/><item id="picture" href="picture.png" media-type="image/png"/>` +
                `</manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>`],
            ["one.xhtml", chapter('<img src="picture.png" alt="Repeated"/>'.repeat(4) + '<a href="two.xhtml">Next</a>')],
            ["two.xhtml", chapter('<img src="picture.png" alt="Next chapter"/>')],
            ["picture.png", picture],
        ]);
        writeFileSync(`${work}/bounded.epub`, book);
        execFileSync("docker", ["cp", "-q", `${work}/bounded.epub`, `${container}:/home/user/Downloads/media/bounded.epub`]);
        execFileSync("docker", ["exec", container, "chown", "user", "/home/user/Downloads/media/bounded.epub"]);
        await open("fs/#/media/", `${listed}.includes("bounded.epub")`, "the bounded EPUB");
        await ev(`[...document.querySelectorAll("td.name a")].find(a => a.textContent === "bounded.epub").click()`);
        const report = `JSON.parse(document.querySelector("dialog.preview iframe.epub")?.dataset.rendered ?? "null")`;
        await waitFor(`${report}?.pictures === 3 && ${report}.errors.some(e => e.includes("preview limit"))`, "three 20 MiB pictures fit, the fourth is refused", 60000);
        await inFrame("epub-frame.html", `document.querySelector('#doc a').click()`);
        await waitFor(`${report}?.chapter === 2 && ${report}.pictures === 1`, "the next chapter gets a fresh budget", 60000);
        await ev(`document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "EPUB budget preview closes");
        inContainer("rm", "/home/user/Downloads/media/bounded.epub");
        return "repeated 20 MiB pictures share a read and spend the 64 MiB budget; next chapter resets it";
    });
}

export async function checkEPUB(checks) {
    const { work, container, inContainer, sleep, step, ev, waitFor, click, type, open, listed, inFrame, checkPreviewLink, rendered } = checks;
    await step("files: read an EPUB book", async () => {
        // A book of three chapters: the first with a picture, a link to a
        // place in the third, and a script that mustn't run; the second
        // long, to be read halfway, and opened there again.
        const filler = Array.from({ length: 80 }, (_, i) => `<p>Line ${i + 1} of the second chapter.</p>`).join("");
        const chapter = (title, body) => `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml">` +
            `<head><title/><script>parent.postMessage("ran", "*")</script></head><body><h1 id="chapter-title">${title}</h1>${body}</body></html>`;
        const book = zipFile([
            ["mimetype", "application/epub+zip"],
            ["META-INF/container.xml", `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">` +
                `<rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`],
            ["OEBPS/book.opf", `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">` +
                `<dc:title>The Check Book</dc:title><dc:creator>A. Checker</dc:creator><dc:language>en</dc:language></metadata><manifest>` +
                `<item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>` +
                `<item id="c1" href="text/one.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="text/two.xhtml" media-type="application/xhtml+xml"/>` +
                `<item id="c3" href="text/three.xhtml" media-type="application/xhtml+xml"/><item id="p" href="images/square.png" media-type="image/png"/>` +
                `</manifest><spine><itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/></spine></package>`],
            ["OEBPS/nav.xhtml", `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>` +
                `<nav epub:type="toc"><ol><li><a href="text/one.xhtml">Chapter One</a></li><li><a href="text/two.xhtml">Chapter Two</a></li>` +
                `<li><a href="text/three.xhtml">Chapter Three</a></li></ol></nav></body></html>`],
            ["OEBPS/text/one.xhtml", chapter("One", `<p>The first chapter's text.</p><img src="../images/square.png" alt="A square"/>` +
                `<img src="data:image/png;base64,${pngSquare(20).toString("base64")}" alt="Inline"/>` +
                `<p><a href="https://example.com/">Web</a></p><p onclick="parent.postMessage('ran', '*')">On to <a href="three.xhtml#later">later in the third</a>.</p>`)],
            ["OEBPS/text/two.xhtml", chapter("Two", filler)],
            ["OEBPS/text/three.xhtml", chapter("Three", `${filler.replaceAll("second", "third")}<p id="later">Later on.</p>${filler}`)],
            ["OEBPS/images/square.png", pngSquare(40)],
        ]);
        writeFileSync(`${work}/book.epub`, book);
        execFileSync("docker", ["cp", "-q", `${work}/book.epub`, `${container}:/home/user/Downloads/media/book.epub`]);
        execFileSync("docker", ["exec", container, "chown", "user", "/home/user/Downloads/media/book.epub"]);
        await ev(`window.ran = 0; window.addEventListener("message", (e) => { if (e.data === "ran") window.ran++; })`);

        const report = `JSON.parse(document.querySelector("dialog.preview iframe.epub")?.dataset.rendered ?? "null")`;
        const inBook = (expr) => inFrame("epub-frame.html", expr);
        const openBook = async () => {
            await open("fs/#/media/", `${listed}.includes("book.epub")`, "book.epub");
            await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === "book.epub").click()`);
        };
        const close = async () => {
            await ev(`document.querySelector("dialog.preview button.close").click()`);
            await waitFor(`!document.querySelector("dialog.preview")`, "the preview to close");
        };
        await openBook();
        await waitFor(`${report}?.stage === "shown" && ${report}.chapter === 1 && ${report}.pictures === 1`, "the first chapter, with its picture", 30000);
        const first = await inBook(`({ text: document.getElementById("doc").textContent, scripts: document.querySelectorAll("#doc script, [onclick]").length,
            picture: document.querySelector("#doc img")?.naturalWidth ?? 0,
            inline: document.querySelector('#doc img[alt="Inline"]')?.naturalWidth ?? 0, title: document.querySelector("#contents .book").textContent,
            where: document.querySelector("#bar .where").textContent })`);
        if (!first.text.includes("The first chapter's text.") || first.scripts || first.picture !== 40 || first.inline !== 20 ||
            first.title !== "The Check BookA. Checker" || first.where !== "Chapter 1 of 3 · Chapter One") {
            throw new Error(`the first chapter: ${JSON.stringify(first)}`);
        }
        await checkPreviewLink("epub-frame.html", `document.querySelector('#doc a[href="https://example.com/"]').click()`, "https://example.com/");
        // A link to a place in another chapter: there, at it.
        await inBook(`[...document.querySelectorAll("#doc a")].find((a) => a.textContent === "later in the third").click()`);
        await waitFor(`${report}?.chapter === 3`, "the third chapter");
        const later = await inBook(`(() => { const r = document.getElementById("b-later").getBoundingClientRect(); return { top: r.top, height: innerHeight }; })()`);
        if (later.top < 0 || later.top > later.height / 2) {
            throw new Error(`the link's place: ${JSON.stringify(later)}`);
        }
        await ev(`document.querySelector("dialog.preview button.back").click()`);
        await waitFor(`${report}?.chapter === 1 && ${report}.stage === "shown"`, "Back to the first chapter");
        if ((await inBook(`scrollY`)) > 3) throw new Error("EPUB Back lost the original position");
        await waitFor(`document.querySelector("dialog.preview button.back").hidden`, "EPUB history exhausted");
        // The contents, to the second chapter; read halfway.
        await inBook(`document.querySelector('#bar button[aria-label="Contents"]').click()`);
        await inBook(`[...document.querySelectorAll("#contents li button")].find((b) => b.textContent === "Chapter Two").click()`);
        await waitFor(`${report}?.chapter === 2 && ${report}.stage === "shown"`, "the second chapter");
        // At its end, the chapters before and after, in a bar at the frame's
        // foot; further up, not.
        const endsShown = `document.getElementById("ends").classList.contains("shown")`;
        await inBook(`scrollTo(0, document.documentElement.scrollHeight)`);
        for (let i = 0; !(await inBook(endsShown)); i++) {
            if (i === 20) {
                throw new Error("no bar of chapters at the chapter's end");
            }
            await sleep(100);
        }
        await sleep(400); // (it slides in)
        const bar = await inBook(`(() => { const r = document.getElementById("ends").getBoundingClientRect();
            return { bottom: Math.round(r.bottom), height: innerHeight, buttons: [...document.querySelectorAll("#ends button")].map((b) => b.textContent) }; })()`);
        if (bar.bottom !== bar.height || bar.buttons.join() !== "‹ Chapter One,Chapter Three ›") {
            throw new Error(`the bar: ${JSON.stringify(bar)}`);
        }
        await inBook(`scrollTo(0, (document.documentElement.scrollHeight - innerHeight) / 2)`);
        await sleep(1000);
        if (await inBook(endsShown)) {
            throw new Error("the bar of chapters stayed, halfway up");
        }
        await close();
        // Opened again: there.
        await openBook();
        await waitFor(`${report}?.chapter === 2 && ${report}.stage === "shown"`, "the book, where it was left", 30000);
        await sleep(300);
        const back = await inBook(`scrollY / (document.documentElement.scrollHeight - innerHeight)`);
        if (back < 0.4 || back > 0.6) {
            throw new Error(`opened again ${back} of the way down the second chapter, not halfway`);
        }
        // ›, to the next chapter.
        await inBook(`document.querySelector('#bar button[aria-label^="The next chapter"]').click()`);
        await waitFor(`${report}?.chapter === 3`, "the next chapter");

        // Its details: a new title and author, and a cover, where it had
        // none; shown again, where it was.
        // The cover, first a picture already in the book, then one in
        // Downloads, chosen there.
        writeFileSync(`${work}/cover.png`, pngSquare(60));
        execFileSync("docker", ["cp", "-q", `${work}/cover.png`, `${container}:/home/user/Downloads/media/cover.png`]);
        execFileSync("docker", ["exec", container, "chown", "user", "/home/user/Downloads/media/cover.png"]);
        const top = `[...document.querySelectorAll("dialog[open]")].at(-1)`;
        await ev(`document.querySelector("dialog.preview button.edit").click()`);
        await waitFor(`${top}?.querySelector(".cover-field .no-cover:not([hidden])")`, "the details, without a cover");
        await ev(`(() => { const [title, author] = ${top}.querySelectorAll("input[type=text]");
            title.value = "A Checked Book"; author.value = "B. Checker"; })()`);
        const picture = (name) => `[...document.querySelectorAll("dialog.picker button.picker-picture")].find((b) => b.textContent === ${JSON.stringify(name)})`;
        await ev(`${top}.querySelector("button.cover-pick-epub").click()`);
        await waitFor(`document.querySelector("dialog.picker .picker-where")?.textContent === "book.epub" && !!${picture("OEBPS/images/square.png")}`,
            "the book's pictures, for the cover");
        await ev(`${picture("OEBPS/images/square.png")}.click()`);
        await waitFor(`!document.querySelector("dialog.picker") && ${top}.querySelector("img.cover:not([hidden])")?.naturalWidth === 40`,
            "the book's picture, shown as the cover");
        await ev(`${top}.querySelector("button.cover-clear").click()`);
        await waitFor(`${top}?.querySelector(".cover-field .no-cover:not([hidden])")`, "the book's picture cleared");
        await ev(`${top}.querySelector("button.cover-pick").click()`);
        await waitFor(`document.querySelector("dialog.picker .picker-where")?.textContent === "Downloads / media" && !!${picture("cover.png")}`,
            "the picker, in the book's folder");
        await ev(`${picture("cover.png")}.click()`);
        await waitFor(`!document.querySelector("dialog.picker") && ${top}.querySelector("img.cover:not([hidden])")?.naturalWidth === 60`, "the new cover, shown");
        // Saved, it's shown again, in a new frame.
        const savedAndShown = async () => {
            await ev(`document.querySelector("dialog.preview iframe.epub").dataset.old = "1"`);
            await ev(`${top}.querySelector("button.primary").click()`);
            await waitFor(`!!document.querySelector("dialog.preview iframe.epub:not([data-old])") && ${report}?.chapter === 3 && ` +
                `${report}.stage === "shown" && !document.querySelector("dialog.preview p.saving")`, "the book shown again, changed", 60000);
        };
        await savedAndShown();
        // (The frame that showed it before may be listed a moment longer.)
        let changed = "";
        for (const end = Date.now() + 10000; changed !== "A Checked BookB. Checker" && Date.now() < end; await sleep(200)) {
            changed = await inBook(`document.querySelector("#contents .book")?.textContent ?? ""`).catch(() => "");
        }
        if (changed !== "A Checked BookB. Checker") {
            throw new Error(`the book's details read back as ${JSON.stringify(changed)}`);
        }
        await ev(`document.querySelector("dialog.preview button.edit").click()`);
        await waitFor(`${top}?.querySelector("img.cover:not([hidden])")?.naturalWidth === 60`, "the new cover, read back");
        const fields = await ev(`[...${top}.querySelectorAll("input[type=text]")].map((i) => i.value)`);
        await ev(`[...${top}.querySelectorAll(".buttons button")].find((b) => b.textContent === "Cancel").click()`);
        if (fields.join() !== "A Checked Book,B. Checker") {
            throw new Error(`the details read back as ${fields}`);
        }
        // A cover it has, replaced: by a picture from this computer, dropped
        // on the dialog (not uploaded into the folder, as one dropped on the
        // page is), too big, made smaller, as the type it is.
        // close() clears [open] before the close event resolves the editor.
        // Wait for removal so the next click cannot race its one-dialog guard.
        await waitFor(`!document.querySelector("dialog:not(.preview)")`, "the details to close");
        await ev(`document.querySelector("dialog.preview button.edit").click()`);
        await waitFor(`${top}?.querySelector("img.cover:not([hidden])")?.naturalWidth === 60`, "the cover");
        // (dataTransfer holds a file made here, as a drop from the desktop would.)
        const picked = (w, h, name) => `(async () => { const c = new OffscreenCanvas(${w}, ${h}); c.getContext("2d").fillRect(0, 0, 10, 10);
            const dt = new DataTransfer(); dt.items.add(new File([await c.convertToBlob({ type: "image/png" })], "${name}", { type: "image/png" }));
            return dt; })()`;
        await ev(`(async () => { const dt = await ${picked(3200, 2400, "big-cover.png")};
            ${top}.querySelector(".cover-field").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt })); })()`);
        await waitFor(`${top}.querySelector("img.cover:not([hidden])")?.naturalWidth === 3200`, "the big cover, dropped, shown");
        await savedAndShown();
        if (inContainer("ls", "/home/user/Downloads/media").includes("big-cover.png")) {
            throw new Error("the picture dropped on the dialog was uploaded too");
        }
        await ev(`document.querySelector("dialog.preview button.edit").click()`);
        await waitFor(`${top}?.querySelector("img.cover:not([hidden])")?.naturalWidth === 3000`, "the cover, made smaller, read back", 30000);
        // One pasted: shown as the new one, till it's cancelled.
        // Pasted into the title, a copy's picture isn't taken for the cover.
        await ev(`(async () => { const dt = await ${picked(20, 20, "image.png")};
            ${top}.querySelector("input[type=text]").dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt })); })()`);
        await sleep(300);
        if (await ev(`${top}.querySelector("img.cover:not([hidden])")?.naturalWidth`) !== 3000) {
            throw new Error("a picture pasted into the title was taken for the cover");
        }
        await ev(`(async () => { const dt = await ${picked(20, 20, "image.png")};
            ${top}.querySelector(".cover-field").dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt })); })()`);
        await waitFor(`${top}.querySelector("img.cover:not([hidden])")?.naturalWidth === 20`, "a picture pasted, shown");
        await ev(`[...${top}.querySelectorAll(".buttons button")].find((b) => b.textContent === "Cancel").click()`);
        await waitFor(`!document.querySelector("dialog:not(.preview)")`, "the details to close after paste cancel");
        // Rebuild contents from the chapters' headings (h1 One/Two/Three),
        // replacing the nav that said Chapter One/Two/Three.
        await ev(`document.querySelector("dialog.preview button.edit").click()`);
        await waitFor(`${top}?.querySelector("button.rebuild-toc")`, "Rebuild contents");
        await ev(`document.querySelector("dialog.preview iframe.epub").dataset.old = "1"`);
        await ev(`${top}.querySelector("button.rebuild-toc").click()`);
        await waitFor(`!!document.querySelector("dialog:not(.preview):not(.book-details) button.primary")`, "confirm rebuild");
        await ev(`document.querySelector("dialog:not(.preview):not(.book-details) button.primary").click()`);
        await waitFor(`!!document.querySelector("dialog.preview iframe.epub:not([data-old])") && ${report}?.stage === "shown" && ` +
            `!document.querySelector("dialog.preview p.saving")`, "the book after rebuilding contents", 60000);
        const tocLabels = await inBook(`[...document.querySelectorAll("#contents ol button")].map((b) => b.textContent).join(",")`);
        if (tocLabels !== "One,Two,Three") {
            throw new Error(`contents after rebuild: ${JSON.stringify(tocLabels)}`);
        }
        await close();
        if (await ev("window.ran")) {
            throw new Error("the book's scripts ran");
        }
        inContainer("sh", "-c", "rm ~/Downloads/media/book.epub ~/Downloads/media/cover.png");
        await open("fs/#/", `document.title === "Downloads /" && !!document.querySelector("table")`, "the listing");
        return "contents, a picture fetched and one inline, a link to another chapter's place, the next chapter, opened again where it was left; " +
            "its title, author and cover changed, and that cover replaced, made smaller; contents rebuilt from headings";
    });
}
