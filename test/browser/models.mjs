import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

// 3D models and G-code: drawn, with what they are; G-code's layers by its
// slider, and its text; a .obj that's a compiler's, its bytes.
export async function checkModels(checks) {
    const { work, container, step, ev, waitFor, open, listed } = checks;
    await step("files: 3D models and G-code drawn; G-code's layers, and its text; a compiler's .obj in hex", async () => {
        const fixtures = new URL("../data/3d/", import.meta.url);
        writeFileSync(`${work}/prism.stl`, readFileSync(new URL("prism.stl", fixtures)));
        writeFileSync(`${work}/part.gcode`, readFileSync(new URL("cura.gcode", fixtures)));
        // MSVC's object files are .obj too.
        writeFileSync(`${work}/main.obj`, Buffer.from([0x64, 0x86, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
        execFileSync("docker", ["exec", container, "mkdir", "-p", "/home/user/Downloads/models"]);
        for (const name of ["prism.stl", "part.gcode", "main.obj"]) {
            execFileSync("docker", ["cp", "-q", `${work}/${name}`, `${container}:/home/user/Downloads/models/${name}`]);
        }
        execFileSync("docker", ["exec", container, "chown", "-R", "user", "/home/user/Downloads/models"]);
        const view = `document.querySelector("dialog.preview .model-view")`;
        const info = `${view}?.querySelector(".model-info")?.textContent`;
        const toggle = `document.querySelector("dialog.preview button.preview-mode-toggle")`;
        const show = (name) => ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === ${JSON.stringify(name)}).click()`);
        const close = async () => {
            await ev(`document.querySelector("dialog.preview button.close").click()`);
            await waitFor(`!document.querySelector("dialog.preview")`, "the preview closes");
        };
        await open("fs/#/models/", `${listed}.includes("prism.stl") && ${listed}.includes("part.gcode")`, "the models listed");

        await show("prism.stl");
        await waitFor(`${info} === "STL · 12 × 12 × 6 mm · 96 triangles · 0.67 cm³"`, "the STL, drawn, with what it is");
        if (!await ev(`(() => { const c = ${view}.querySelector("canvas"); return c.width > 100 && c.height > 100; })()`)) throw new Error("no canvas drawn");
        if (await ev(`${toggle}.hidden || ${toggle}.title !== "Show binary view"`)) throw new Error("the STL's bytes not offered");
        await close();

        await show("part.gcode");
        await waitFor(`/^G-code · 27\\.59 × 27\\.59 × 5\\.7 mm · 20 layers · .* · Cura_SteamEngine 5\\.0\\.0$/.test(${info})`, "the G-code, drawn");
        await ev(`(s => { s.value = "4"; s.dispatchEvent(new Event("input")); })(${view}.querySelector(".model-layer"))`);
        await waitFor(`${view}.querySelector(".model-layer-label").textContent === "Layer 5 of 20 · Z 1.50 mm"`, "layer 5, by the slider");
        if (!await ev(`[...${view}.querySelectorAll(".model-legend li")].map((l) => l.textContent).join() === "Outer wall,Inner wall,Infill,Top/bottom,Skirt/brim"`)) throw new Error("the legend");
        await ev(`${toggle}.click()`);
        await waitFor(`document.querySelector("dialog.preview .body")?.textContent.includes(";FLAVOR:Marlin")`, "the G-code as text");
        if (await ev(`${toggle}.title`) !== "Show 3D view") throw new Error("no way back to 3D");
        await ev(`${toggle}.click()`);
        await waitFor(`/^G-code · /.test(${info})`, "drawn again");
        await close();

        await show("main.obj");
        await waitFor(`!!document.querySelector("dialog.preview .hex-view")`, "a compiler's .obj, in hex");
        await close();
        execFileSync("docker", ["exec", container, "rm", "-r", "/home/user/Downloads/models"]);
    });
}
