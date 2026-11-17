import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { png } from "./images.mjs";

// 3D models and G-code: drawn, with what they are; G-code's layers by its
// slider, and its text; a .obj that's a compiler's, its bytes.
export async function checkModels(checks) {
    const { work, container, step, ev, waitFor, open, listed } = checks;
    await step("files: 3D models and G-code drawn; G-code's layers, and its text; a compiler's .obj in hex", async () => {
        const fixtures = new URL("../data/3d/", import.meta.url);
        writeFileSync(`${work}/prism.stl`, readFileSync(new URL("prism.stl", fixtures)));
        writeFileSync(`${work}/part.gcode`, readFileSync(new URL("cura.gcode", fixtures)));
        writeFileSync(`${work}/part.bgcode`, readFileSync(new URL("prism.bgcode", fixtures)));
        // MSVC's object files are .obj too.
        writeFileSync(`${work}/main.obj`, Buffer.from([0x64, 0x86, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
        // A textured square: as glTF, its data and picture beside it; as an
        // OBJ, its material (.mtl) and picture; and one whose picture isn't there.
        writeFileSync(`${work}/tex.png`, png(8, 8, (x, y) => ((x + y) % 2 ? [255, 0, 0, 255] : [255, 255, 255, 255])));
        const square = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, /* uv */ 0, 1, 1, 1, 1, 0, 0, 0]);
        const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
        writeFileSync(`${work}/square.bin`, Buffer.concat([Buffer.from(square.buffer), Buffer.from(indices.buffer)]));
        writeFileSync(`${work}/square.gltf`, JSON.stringify({
            asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
            meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
            materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0 } }],
            textures: [{ source: 0 }], images: [{ uri: "tex.png" }],
            accessors: [{ bufferView: 0, componentType: 5126, count: 4, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
                { bufferView: 1, componentType: 5126, count: 4, type: "VEC2" }, { bufferView: 2, componentType: 5123, count: 6, type: "SCALAR" }],
            bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 48 }, { buffer: 0, byteOffset: 48, byteLength: 32 }, { buffer: 0, byteOffset: 80, byteLength: 12 }],
            buffers: [{ uri: "square.bin", byteLength: 92 }],
        }));
        writeFileSync(`${work}/square.obj`, "mtllib square.mtl\nv 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\nusemtl checks\nf 1/1 2/2 3/3 4/4\n");
        writeFileSync(`${work}/square.mtl`, "newmtl checks\nKd 1 1 1\nmap_Kd tex.png\n");
        writeFileSync(`${work}/lost.obj`, "mtllib lost.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 0 1\nusemtl gone\nf 1/1 2/2 3/3\n");
        writeFileSync(`${work}/lost.mtl`, "newmtl gone\nmap_Kd C:\\Users\\someone\\gone.png\n");
        execFileSync("docker", ["exec", container, "mkdir", "-p", "/home/user/Downloads/models"]);
        for (const name of ["prism.stl", "part.gcode", "main.obj", "tex.png", "square.bin", "square.gltf", "square.obj", "square.mtl", "lost.obj", "lost.mtl", "part.bgcode"]) {
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
        await waitFor(`${info} === "STL · 12 × 12 × 6 mm · 96 triangles · 0.67 cm³ · watertight"`, "the STL, drawn, with what it is");
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

        // Textured: its files found beside it, read through the tunnel.
        await show("square.gltf");
        await waitFor(`${info} === "glTF · 1 × 1 × 0 m · 2 triangles · 1 texture"`, "the glTF, its data and texture found");
        await close();
        await show("square.obj");
        await waitFor(`${info} === "OBJ · 1 × 1 × 0 mm · 2 triangles · 1 texture"`, "the OBJ, its material and texture found");
        await close();
        await show("lost.obj");
        await waitFor(`${info} === "OBJ · 1 × 1 × 0 mm · 1 triangle · a file it refers to isn't here: gone.png"`, "a texture that isn't there, said");
        await close();

        // Binary G-code: as its text; coloured by speed, its legend saying so.
        await show("part.bgcode");
        await waitFor(`/^Binary G-code · .* · 20 layers · .* · PrusaSlicer 2\\.9\\.2/.test(${info})`, "the binary G-code, drawn");
        await ev(`${view}.querySelector(".model-colour").click(); ${view}.querySelector('.model-colour-menu [data-value="speed"]').click()`);
        await waitFor(`${view}.querySelector(".model-ramp-name")?.textContent === "Speed (mm/s)"`, "coloured by speed");
        await close();
        // A model's overhangs, and its check.
        await show("prism.stl");
        await ev(`${view}.querySelector(".model-look").click(); ${view}.querySelector('.model-look-menu [data-value="overhang"]').click()`);
        await waitFor(`!${view}.querySelector(".model-angle-box").hidden`, "the overhang angle offered");
        if (!(await ev(`${info}.endsWith("· watertight")`))) throw new Error("the prism's check");
        await close();

        await show("main.obj");
        await waitFor(`!!document.querySelector("dialog.preview .hex-view")`, "a compiler's .obj, in hex");
        await close();
        execFileSync("docker", ["exec", container, "rm", "-r", "/home/user/Downloads/models"]);
    });
}
