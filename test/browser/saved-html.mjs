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
            if (!await inFrame("md-frame.html", '[...document.querySelectorAll("#doc .note")].some(note => note.textContent.includes("logo: Local image not found:") && note.textContent.includes("companion resource folder"))')) throw new Error("missing logo did not explain the companion folder requirement");
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
            await ev('[...document.querySelectorAll("dialog.preview-link button")].find(b => b.textContent === "Cancel").click()');
            await ev('document.querySelector("dialog.preview button.close").click()');
            await waitFor('!document.querySelector("dialog.preview")', "saved preview closes");
            inContainer("rm", `/home/user/Downloads/media/${name}`);
        }
        return "missing companion-folder explanation, declared data URLs recovered without scripts, real pointer clicks open URL confirmation";
    });
}
