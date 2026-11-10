import http from "node:http";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

export async function checkStylesheetConditions(checks) {
    const { work, container, inContainer, step, ev, waitFor, click, open, listed, inFrame, sleep } = checks;
    await step("files: stylesheet media, disabled state, inline budgets and qualified imports", async () => {
        const hits = [];
        const sheets = {
            "/print.css": "#probe{color:rgb(240,0,0)}",
            "/disabled.css": "#probe{color:rgb(0,240,0)}",
            "/alternate.css": "#probe{color:rgb(0,0,240)}",
            "/main.css": '@layer first,second;@import "first.css" layer(second);@import "second.css" layer(first);@import "supported.css" supports(display:grid);@import "unsupported.css" supports(not (display:grid));@import "combined.css" layer(parts) supports(display:grid) screen and (min-width:1px);@import "anonymous.css" layer;',
            "/first.css": "#layer,#order{color:rgb(20,21,22)}",
            "/second.css": "#order{color:rgb(200,0,0)}",
            "/supported.css": "#supported{color:rgb(30,31,32)}",
            "/unsupported.css": "#unsupported{color:rgb(240,0,0)}",
            "/combined.css": "#combined{color:rgb(40,41,42)}",
            "/anonymous.css": "#anonymous{color:rgb(50,51,52)}",
        };
        const server = http.createServer((req, res) => {
            hits.push(req.url);
            res.writeHead(req.url in sheets ? 200 : 404, { "Content-Type": "text/css", "Cache-Control": "no-store" });
            res.end(sheets[req.url] ?? "");
        });
        await new Promise(resolve => server.listen(0, "0.0.0.0", resolve));
        const gateway = execFileSync("docker", ["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}", container], { encoding: "utf8" }).trim();
        const root = `http://${gateway}:${server.address().port}`;
        const name = "stylesheet-conditions.html";
        const html = `<html><head><style>#probe,#unsupported{color:rgb(10,20,30)}</style>${"<style></style>".repeat(20)}${Array.from({ length: 24 }, (_, i) => `<style>.unused${i}{color:red}</style>`).join("")}<style>#after{color:rgb(9,8,7)}</style><style media="print">#probe{color:rgb(250,0,0)}</style><style media="not all">#probe{color:rgb(0,250,0)}</style><style disabled>#probe{color:rgb(0,0,250)}</style><style type="text/plain">#probe{color:rgb(250,0,250)}</style><link rel="stylesheet" disabled href="${root}/disabled.css"><link rel="alternate stylesheet" title="Alternate" href="${root}/alternate.css"><link rel="stylesheet" media="print" href="${root}/print.css"><link rel="stylesheet" href="${root}/main.css"></head><body>${["probe", "after", "layer", "order", "supported", "unsupported", "combined", "anonymous"].map(id => `<p id="${id}">${id}</p>`).join("")}</body></html>`;
        writeFileSync(`${work}/${name}`, html);
        execFileSync("docker", ["cp", "-q", `${work}/${name}`, `${container}:/home/user/Downloads/media/${name}`]);
        execFileSync("docker", ["exec", container, "chown", "user", `/home/user/Downloads/media/${name}`]);
        const state = `(() => { const color = id => getComputedStyle(document.getElementById(id)).color; return {print:matchMedia("print").matches,probe:color("probe"),after:color("after"),layer:color("layer"),order:color("order"),supported:color("supported"),unsupported:color("unsupported"),combined:color("combined"),anonymous:color("anonymous")}; })()`;
        try {
            await ev('localStorage.setItem("tabtop.html-view","rendered")');
            await open("fs/#/media/", `${listed}.includes(${JSON.stringify(name)})`, name);
            await ev(`[...document.querySelectorAll("td.name a")].find(a => a.textContent === ${JSON.stringify(name)}).click()`);
            await waitFor('!!document.querySelector("dialog.preview iframe.html")?.dataset.rendered', "inline stylesheet conditions");
            const initial = await inFrame("md-frame.html", state);
            if (initial.print || initial.probe !== "rgb(10, 20, 30)" || initial.after !== "rgb(9, 8, 7)" || hits.length) throw new Error(`inline conditions or quota: ${JSON.stringify(initial)} hits=${JSON.stringify(hits)}`);
            for (const mode of ["proxy", "direct"]) {
                await click('document.querySelector("dialog.preview .external-resources")');
                await click(`document.querySelector('.external-option[data-mode="${mode}"]')`);
                await waitFor(`document.querySelector("dialog.preview .external-resources").dataset.mode === ${JSON.stringify(mode)} && !!document.querySelector("dialog.preview iframe.html")?.dataset.rendered`, mode + " styled preview");
                let result;
                for (let i = 0; i < 80; i++) {
                    result = await inFrame("md-frame.html", state);
                    if (result.layer === "rgb(20, 21, 22)" && result.supported === "rgb(30, 31, 32)" && result.combined === "rgb(40, 41, 42)" && result.anonymous === "rgb(50, 51, 52)") break;
                    await sleep(100);
                }
                if (result.probe !== "rgb(10, 20, 30)" || result.after !== "rgb(9, 8, 7)" || result.order !== "rgb(20, 21, 22)" || result.unsupported !== "rgb(10, 20, 30)" || result.layer !== "rgb(20, 21, 22)" || result.supported !== "rgb(30, 31, 32)" || result.combined !== "rgb(40, 41, 42)" || result.anonymous !== "rgb(50, 51, 52)") throw new Error(`${mode} stylesheet conditions: ${JSON.stringify(result)}`);
                if (hits.includes("/disabled.css") || hits.includes("/alternate.css")) throw new Error("inactive stylesheets were fetched");
            }
            await ev('document.querySelector("dialog.preview button.close").click()');
            await waitFor('!document.querySelector("dialog.preview")', "stylesheet preview closes");
        } finally {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
            inContainer("rm", `/home/user/Downloads/media/${name}`);
        }
        return "print media excluded on screen, disabled sheets inactive, 40+ inline sheets, named/anonymous layer imports and supports/media conditions";
    });
}
