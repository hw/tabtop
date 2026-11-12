import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

export async function checkSavedHTML(checks) {
    const { work, container, inContainer, step, ev, waitFor, open, listed, inFrame, cdp, sleep } = checks;
    await step("files: saved HTML missing assets and script-backed declared links", async () => {
        const base = "https://www.gartner.com/doc/reprints?id=example";
        const minimal = `<!doctype html><!-- saved from url=(0014)about:internet --><h1 id="one">Saved article</h1><img alt="logo" src="./Saved Article_files/logo.webp"><a href="${base}#one">One</a><a href="${base}#two">Two</a><h2 id="two">Recommended reading</h2><a data-ga-content-link="/document/code/123?ref=test" style="cursor:pointer" tabindex="0">Recommended article</a>`;
        const examples = [["saved-links.html", minimal, "Recommended article", "https://www.gartner.com/document/code/123?ref=test"]];
        // Keep the user's article outside the repository; optionally verify the
        // exact diagnostic sample in a temporary container as well as the fixture.
        if (process.env.SAVED_HTML_SAMPLE) examples.push(["saved-sample.html", readFileSync(process.env.SAVED_HTML_SAMPLE), "3 Key Steps to Build a Scalable AI Governance Framework", "https://www.gartner.com/document/code/819122?ref=authbody&refval=6579402"]);
        for (const [name, html, title, expected] of examples) {
            writeFileSync(`${work}/${name}`, html);
            execFileSync("docker", ["cp", "-q", `${work}/${name}`, `${container}:/home/user/Downloads/media/${name}`]);
            execFileSync("docker", ["exec", container, "chown", "user", `/home/user/Downloads/media/${name}`]);
            await ev('localStorage.setItem("tabtop.html-view","rendered")');
            await open("fs/#/media/", `${listed}.includes(${JSON.stringify(name)})`, name);
            await ev(`[...document.querySelectorAll("td.name a")].find(a => a.textContent === ${JSON.stringify(name)}).click()`);
            await waitFor('!!document.querySelector("dialog.preview iframe.html")?.dataset.rendered', "saved HTML rendered", 60000);
            if (!await inFrame("md-frame.html", '[...document.querySelectorAll("#doc .note")].some(note => /logo: Local image not found: \\S.*$/.test(note.textContent.trim()) && !note.textContent.includes("companion"))')) throw new Error("a missing logo isn't noted by its path alone");
            await inFrame("md-frame.html", `(() => { const a = [...document.querySelectorAll("#doc a")].find(a => a.textContent === ${JSON.stringify(title)}); if (!a || a.getAttribute("href") !== ${JSON.stringify(expected)}) throw new Error("declared target was not recovered"); a.scrollIntoView({ block: "center" }); })()`);
            await sleep(100);
            const point = await inFrame("md-frame.html", `(() => { const r = [...document.querySelectorAll("#doc a")].find(a => a.textContent === ${JSON.stringify(title)}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
            const frame = await ev('(() => { const r = document.querySelector("iframe.html").getBoundingClientRect(); return {x:r.x,y:r.y}; })()');
            for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: frame.x + point.x, y: frame.y + point.y, button: "left", clickCount: 1 });
            try {
                await waitFor(`document.querySelector("dialog.preview-link[open] .link-url")?.textContent === ${JSON.stringify(expected)}`, "saved article URL confirmation");
            } catch (error) {
                throw new Error(`${name}: ${error.message}; point=${JSON.stringify(point)} frame=${JSON.stringify(frame)}; hit=${await inFrame("md-frame.html", `document.elementFromPoint(${point.x},${point.y})?.outerHTML.slice(0,1000)`)}; dialogs=${await ev('[...document.querySelectorAll("dialog[open]")].map(d=>d.className+":"+d.textContent.slice(-500)).join(";")')}`);
            }
            await ev('document.querySelector("dialog.preview-link button.close").click()');
            await ev('document.querySelector("dialog.preview button.close").click()');
            await waitFor('!document.querySelector("dialog.preview")', "saved preview closes");
            inContainer("rm", `/home/user/Downloads/media/${name}`);
        }
        return "a missing image noted by its path, declared data URLs recovered without scripts, real pointer clicks open URL confirmation";
    });
    await step("files: saved HTML's embedded CSS pictures and fonts, and media beside it", async () => {
        // A second of silence, as WAV: 8 kHz, 8-bit, mono.
        const samples = 8000, wav = Buffer.alloc(44 + samples, 128);
        wav.write("RIFF", 0); wav.writeUInt32LE(36 + samples, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
        wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28);
        wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34); wav.write("data", 36); wav.writeUInt32LE(samples, 40);
        const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        const html = `<!doctype html><style>.icon{width:10px;height:10px;background-image:url(data:image/png;base64,${png})}` +
            `@font-face{font-family:Embedded;src:url(data:font/woff2;base64,d09GMgABAAAAAA==) format("woff2")}</style>` +
            `<h1>Embedded</h1><div class="icon"></div><audio src="embedded_files/beep.wav"></audio><video></video>`;
        writeFileSync(`${work}/embedded.html`, html);
        writeFileSync(`${work}/beep.wav`, wav);
        inContainer("mkdir", "-p", "/home/user/Downloads/media/embedded_files");
        execFileSync("docker", ["cp", "-q", `${work}/embedded.html`, `${container}:/home/user/Downloads/media/embedded.html`]);
        execFileSync("docker", ["cp", "-q", `${work}/beep.wav`, `${container}:/home/user/Downloads/media/embedded_files/beep.wav`]);
        // docker cp creates root-owned fixtures; changing their owner needs root.
        execFileSync("docker", ["exec", "-u", "root", container, "chown", "-R", "user", "/home/user/Downloads/media/embedded.html", "/home/user/Downloads/media/embedded_files"]);
        await ev('localStorage.setItem("tabtop.html-view","rendered")');
        await open("fs/#/media/", `${listed}.includes("embedded.html")`, "embedded.html");
        await ev('[...document.querySelectorAll("td.name a")].find(a => a.textContent === "embedded.html").click()');
        await waitFor('!!document.querySelector("dialog.preview iframe.html")?.dataset.rendered', "embedded HTML rendered", 60000);
        if (!await inFrame("md-frame.html", 'getComputedStyle(document.querySelector("#doc .icon")).backgroundImage.startsWith(\'url("data:image/png\')')) throw new Error("the CSS picture embedded as data: was dropped");
        if (!await inFrame("md-frame.html", '[...document.querySelectorAll("style[data-preview-processed]")].some(s => /@font-face\\{[^}]*blob:/.test(s.textContent))')) throw new Error("the font embedded as data: wasn't made a blob: URL");
        if (!await inFrame("md-frame.html", '[...document.querySelectorAll("#doc .note")].some(n => n.textContent === "Media with no source that can be played.") && ![...document.querySelectorAll("#doc .note")].some(n => /External media/.test(n.textContent))')) throw new Error("media notes are wrong");
        await waitFor('document.querySelector("dialog.preview audio.preview-embedded-media")?.readyState >= 1', "the audio beside the page plays", 30000);
        await ev('document.querySelector("dialog.preview button.close").click()');
        await waitFor('!document.querySelector("dialog.preview")', "embedded preview closes");
        inContainer("rm", "-r", "/home/user/Downloads/media/embedded.html", "/home/user/Downloads/media/embedded_files");
        return "a data: background kept, a data: font as blob:, local audio played by the page, an empty player noted";
    });
}
