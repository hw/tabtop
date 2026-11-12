import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

// png is a width×height RGBA PNG, each pixel colour(x, y) → [r, g, b, a].
function png(width, height, colour) {
    const crcTable = Array.from({ length: 256 }, (_, n) => {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        return c >>> 0;
    });
    const crc = (buf) => {
        let c = 0xffffffff;
        for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type, data) => {
        const head = Buffer.alloc(8);
        head.writeUInt32BE(data.length, 0);
        head.write(type, 4, "ascii");
        const sum = Buffer.alloc(4);
        sum.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
        return Buffer.concat([head, data, sum]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // RGBA
    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) raw.set(colour(x, y), y * (width * 4 + 1) + 1 + x * 4);
    }
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// Pictures: zoomed, fitted, at actual size, what they are; over a
// checkerboard; rotated and cropped, undone, and saved over the file, as
// its pixels say; an animated one, said to be, and not editable.
export async function checkImages(checks) {
    const { work, container, inContainer, step, ev, waitFor, open, listed } = checks;
    const toolbarMode = async mode => {
        const masking=mode==="inpaint"||mode==="background";
        const error = await ev(`(() => {
            const view=document.querySelector("dialog.preview .image-view"), bar=view.querySelector(".image-bar");
            const normal=view.querySelector(".image-edit-default");
            if(normal.hidden!==${Boolean(mode)})return "default tools visibility";
            const hints=view.querySelector(".image-tool-hints");
            if(hints.hidden!==${!masking})return "hint row visibility";
            if(!view.querySelector(".image-zoom-in").checkVisibility())return "zoom hidden";
            if(${Boolean(mode)}) {
                if(view.querySelector(".image-save-options").matches(":popover-open"))return "save settings still shown";
                for(const selector of [".image-flip-h", ".image-crop-start", ".image-save-options-toggle"])
                    if(view.querySelector(selector).checkVisibility())return selector+" still shown";
                const tools=view.querySelector(${JSON.stringify({inpaint:".image-inpaint-tools",background:".image-background-spatial",crop:".image-crop-tools",resize:".image-resize"}[mode])});
                const control=tools.querySelector(${masking} ? "button" : "button:not(.glyph)"), bounds=bar.getBoundingClientRect(), rect=control.getBoundingClientRect();
                if(control.closest(".image-bar")!==bar||!control.checkVisibility()||rect.top<bounds.top||rect.bottom>bounds.bottom)return "mask tools outside main toolbar";
                if(${masking}) {
                    const hint=hints.querySelector(${JSON.stringify(mode === "inpaint" ? ".image-inpaint-note" : ".image-background-spatial-hint")});
                    if(!hint.checkVisibility()||hint.closest(".image-bar")||hints.getBoundingClientRect().top<bounds.bottom)return "hint isn't below the main toolbar";
                } else {
                    for(const selector of [".image-crop-start",".image-resize-start",".image-remove-background",".image-inpaint-start"])
                        if(!view.querySelector(selector).disabled||view.querySelector(selector).checkVisibility())return selector+" still available";
                    if(control.textContent!=="Apply")return "missing Apply button";
                    if(${mode === "resize"}&&!tools.querySelector(".image-resize-width").checkVisibility())return "resize fields hidden";
                }
            } else if(!view.querySelector(".image-save-options-toggle").checkVisibility())return "default tools not restored";
            return "";
        })()`);
        if(error)throw new Error(`image toolbar: ${error}`);
    };
    await step("files: pictures zoomed and fitted, rotated, cropped and resized, saved, saved as a JPEG copy, and stripped of metadata losslessly", async () => {
        // Quarters: red, green; blue, and see-through.
        const quarters = (x, y) => (y < 100 ? (x < 150 ? [255, 0, 0, 255] : [0, 255, 0, 255]) : x < 150 ? [0, 0, 255, 255] : [0, 0, 0, 0]);
        writeFileSync(`${work}/quarters.png`, png(300, 200, quarters));
        // A GIF that loops: animated, so not editable.
        writeFileSync(`${work}/loop.gif`, Buffer.concat([Buffer.from("GIF89a"), Buffer.from([1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255]),
            Buffer.from([0x21, 0xff, 0x0b]), Buffer.from("NETSCAPE2.0"), Buffer.from([3, 1, 0, 0, 0]),
            Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0, 0x3b])]));
        for (const name of ["quarters.png", "loop.gif"]) {
            execFileSync("docker", ["cp", "-q", `${work}/${name}`, `${container}:/home/user/Downloads/media/${name}`]);
            execFileSync("docker", ["exec", container, "chown", "user", `/home/user/Downloads/media/${name}`]);
        }
        const view = `document.querySelector("dialog.preview .image-view")`;
        const info = `${view}?.querySelector(".image-info")?.textContent`;
        const zoom = `${view}.querySelector(".image-zoom").textContent`;
        const click = (cls) => ev(`${view}.querySelector(${JSON.stringify(cls)}).click()`);
        const close = async () => {
            await ev(`document.querySelector("dialog.preview button.close").click()`);
            await waitFor(`!document.querySelector("dialog.preview")`, "the preview closes");
        };
        await open("fs/#/media/", `${listed}.includes("quarters.png") && ${listed}.includes("loop.gif")`, "the pictures listed");
        await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === "quarters.png").click()`);
        await waitFor(`/^300×200 · PNG · /.test(${info})`, "what the picture is");
        // Fitted (small enough: at actual size); zoomed in and out, at the
        // wheel and keys; fitted again; and a checkerboard behind.
        if (await ev(zoom) !== "100%") throw new Error(`fitted at ${await ev(zoom)}`);
        await click("button.image-zoom-in");
        await waitFor(`${zoom} === "125%"`, "zoomed in");
        await ev(`${view}.querySelector(".image-stage").dispatchEvent(new WheelEvent("wheel", { deltaY: -500, clientX: 400, clientY: 300, bubbles: true, cancelable: true }))`);
        await waitFor(`parseInt(${zoom}) > 125`, "zoomed in more by the wheel");
        await ev(`${view}.querySelector(".image-stage").dispatchEvent(new KeyboardEvent("keydown", { key: "0", bubbles: true }))`);
        await waitFor(`${zoom} === "100%"`, "fitted by 0");
        await ev(`${view}.querySelector(".image-stage").dispatchEvent(new MouseEvent("dblclick", { clientX: 400, clientY: 300, bubbles: true }))`);
        await waitFor(`${zoom} === "100%"`, "a double click: actual size (the same, here)");
        if (!(await ev(`getComputedStyle(${view}.querySelector(".image-stage")).backgroundImage.includes("conic-gradient")`))) throw new Error("no checkerboard");

        // Editing: turned right, the top half kept, undone and done again;
        // saved, it's 200×150, as the file's header and pixels say.
        await waitFor(`!document.querySelector("dialog.preview button.edit").hidden`, "an Edit button");
        await ev(`document.querySelector("dialog.preview button.edit").click()`);
        await waitFor(`!!${view}.querySelector(".image-edit:not([hidden]) .image-rotate-right")`, "the editing tools");
        if (await ev(`${view}.querySelector(".image-save-options").matches(":popover-open")`)) throw new Error("save options are shown by default");
        if(!(await ev(`${view}.querySelector(".image-save-options-toggle").parentElement===${view}.querySelector(".image-save-options-more").parentElement`)))throw new Error("save options arrow isn't attached to its glyph");
        await checks.click(`${view}.querySelector(".image-save-options-more")`);
        await waitFor(`${view}.querySelector(".image-save-options").matches(":popover-open") && ${view}.querySelector(".image-save-options-more").getAttribute("aria-expanded") === "true"`,"save options dropdown opened");
        if(!(await ev(`(() => {const r=${view}.querySelector(".image-save-options").getBoundingClientRect();return r.x>=0&&r.right<=innerWidth&&r.y>=0&&r.bottom<=innerHeight;})()`)))throw new Error("save options dropdown is outside viewport");
        await checks.click(`${view}.querySelector(".image-save-options-more")`);
        await waitFor(`!${view}.querySelector(".image-save-options").matches(":popover-open")`,"save options dropdown collapsed");
        await click("button.image-rotate-right");
        await waitFor(`/^200×300 /.test(${info})`, "turned right");
        await click("button.image-crop-start");
        await toolbarMode("crop");
        await ev(`${view}.querySelector(".image-stage").dispatchEvent(new KeyboardEvent("keydown",{key:"s",bubbles:true,cancelable:true}))`);
        await toolbarMode("crop");
        await click(".image-crop-cancel");
        await toolbarMode(null);
        await click("button.image-crop-start");
        await ev(`(() => {
            const stage = ${view}.querySelector(".image-stage"), r = ${view}.querySelector(".image-content").getBoundingClientRect();
            const at = (type, x, y) => stage.dispatchEvent(new PointerEvent(type, { pointerId: 7, button: 0, clientX: x, clientY: y, bubbles: true }));
            at("pointerdown", r.left - 5, r.top - 5);
            at("pointermove", r.left + 100, r.top + 75);
            at("pointermove", r.left + r.width + 5, r.top + r.height / 2);
            at("pointerup", r.left + r.width + 5, r.top + r.height / 2);
        })()`);
        await waitFor(`${view}.querySelector(".image-crop").dataset.size === "200×150" && !${view}.querySelector(".image-crop-apply").disabled`, "the top half chosen");
        await click("button.image-crop-apply");
        await waitFor(`/^200×150 /.test(${info})`, "cropped");
        await toolbarMode(null);
        await ev(`${view}.querySelector(".image-stage").dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }))`);
        await waitFor(`/^200×300 /.test(${info})`, "the crop undone");
        await click("button.image-crop-start");
        await ev(`(() => {
            const stage = ${view}.querySelector(".image-stage"), r = ${view}.querySelector(".image-content").getBoundingClientRect();
            const at = (type, x, y) => stage.dispatchEvent(new PointerEvent(type, { pointerId: 7, button: 0, clientX: x, clientY: y, bubbles: true }));
            at("pointerdown", r.left - 5, r.top - 5);
            at("pointermove", r.left + r.width + 5, r.top + r.height / 2);
            at("pointerup", r.left + r.width + 5, r.top + r.height / 2);
        })()`);
        await click("button.image-crop-apply");
        await waitFor(`/^200×150 /.test(${info})`, "cropped again");
        await ev(`document.querySelector("dialog.preview button.save-edit").click()`);
        await waitFor(`/^Saved: 200×150 · PNG/.test(${view}.querySelector(".edit-status").textContent)`, "saved");
        const header = inContainer("sh", "-c", "head -c 24 ~/Downloads/media/quarters.png | od -An -tu1 -v").trim().split(/\s+/).map(Number);
        const dims = [header.slice(16, 20), header.slice(20, 24)].map((b) => b.reduce((n, v) => n * 256 + v, 0));
        if (dims.join("×") !== "200×150") throw new Error(`the file is ${dims.join("×")}`);
        await ev(`document.querySelector("dialog.preview button.done-edit").click()`);
        await waitFor(`/^200×150 · PNG/.test(${info}) && !document.querySelector("dialog.preview button.edit").hidden`, "shown as saved");
        // Its pixels: blue at the top left (what was the bottom left), red
        // at the top right (the top left), as turned and cropped.
        const pixels = await ev(`(() => {
            const img = ${view}.querySelector("img.image-content"), c = document.createElement("canvas");
            c.width = img.naturalWidth; c.height = img.naturalHeight;
            const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
            return [[5, 5], [195, 5]].map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data].join(","));
        })()`);
        if (JSON.stringify(pixels) !== JSON.stringify(["0,0,255,255", "255,0,0,255"])) throw new Error(`pixels: ${JSON.stringify(pixels)}`);

        // Resized to half, and saved over it; then saved as a JPEG, a copy
        // beside it, the PNG left as it is.
        const pngSize = () => {
            const h = inContainer("sh", "-c", "head -c 24 ~/Downloads/media/quarters.png | od -An -tu1 -v").trim().split(/\s+/).map(Number);
            return [h.slice(16, 20), h.slice(20, 24)].map((b) => b.reduce((n, v) => n * 256 + v, 0)).join("×");
        };
        await ev(`document.querySelector("dialog.preview button.edit").click()`);
        await waitFor(`!!${view}.querySelector(".image-resize-start")`, "editing again");
        await click("button.image-resize-start");
        await toolbarMode("resize");
        await ev(`${view}.querySelector(".image-stage").dispatchEvent(new KeyboardEvent("keydown",{key:"c",bubbles:true,cancelable:true}))`);
        await toolbarMode("resize");
        await click(".image-resize-cancel");
        await toolbarMode(null);
        await click("button.image-resize-start");
        if (await ev(`${view}.querySelector(".image-save-options").matches(":popover-open")`)) throw new Error("resizing exposed save options");
        await ev(`(p => { p.value = "50"; p.dispatchEvent(new Event("input")); })(${view}.querySelector("input.image-resize-percent"))`);
        await waitFor(`${view}.querySelector("input.image-resize-width").value === "100" && ${view}.querySelector("input.image-resize-height").value === "75"`, "half: 100×75");
        await click("button.image-resize-apply");
        await waitFor(`/^100×75 /.test(${info})`, "resized");
        await toolbarMode(null);
        await ev(`document.querySelector("dialog.preview button.save-edit").click()`);
        await waitFor(`/^Saved: 100×75 · PNG/.test(${view}.querySelector(".edit-status").textContent)`, "saved, resized");
        if (pngSize() !== "100×75") throw new Error(`the file is ${pngSize()}`);
        await click(".image-save-options-toggle");
        await ev(`(f => { f.value = "image/jpeg"; f.dispatchEvent(new Event("change")); })(${view}.querySelector("select.image-format"))`);
        await waitFor(`${view}.querySelector(".image-plan").textContent.startsWith("Save writes a copy as quarters.jpg (JPEG at 92%)")`, "what saving a JPEG will do");
        await ev(`document.querySelector("dialog.preview button.save-edit").click()`);
        await waitFor(`/^Saved a copy as quarters\.jpg: 100×75 · JPEG/.test(${view}.querySelector(".edit-status").textContent)`, "a JPEG copy");
        if (inContainer("sh", "-c", "head -c 3 ~/Downloads/media/quarters.jpg | od -An -tx1").trim() !== "ff d8 ff" || pngSize() !== "100×75") throw new Error("the JPEG copy, or the PNG after it");
        await ev(`document.querySelector("dialog.preview button.done-edit").click()`);
        await close();

        // A photo with EXIF (turned: orientation 6, a camera's name) and a
        // comment: its metadata removed, losslessly, which way up it stands
        // kept: the same image data, standing as it did.
        const jpeg = execFileSync("docker", ["exec", container, "cat", "/home/user/Downloads/media/quarters.jpg"]);
        const seg = (marker, payload) => Buffer.concat([Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255]), payload]);
        const tiff = Buffer.from([0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 2, 0x01, 0x0f, 0, 2, 0, 0, 0, 8, 0, 0, 0, 38, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0, ...Buffer.from("SecretCam\0")]);
        const photo = Buffer.concat([jpeg.subarray(0, 2), seg(0xe1, Buffer.concat([Buffer.from("Exif\0\0"), tiff])), seg(0xfe, Buffer.from("taken at home")), jpeg.subarray(2)]);
        writeFileSync(`${work}/photo.jpg`, photo);
        execFileSync("docker", ["cp", "-q", `${work}/photo.jpg`, `${container}:/home/user/Downloads/media/photo.jpg`]);
        execFileSync("docker", ["exec", container, "chown", "user", "/home/user/Downloads/media/photo.jpg"]);
        await waitFor(`${listed}.includes("photo.jpg")`, "the photo listed");
        await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === "photo.jpg").click()`);
        await waitFor(`/^75×100 · JPEG · .* · EXIF, comment$/.test(${info})`, "the photo, standing as its EXIF says, with what metadata it has");
        await ev(`document.querySelector("dialog.preview button.edit").click()`);
        await waitFor(`!!${view}.querySelector("input.image-keep-meta")`, "editing the photo");
        await click(".image-save-options-toggle");
        await ev(`(k => { k.checked = false; k.dispatchEvent(new Event("change")); })(${view}.querySelector("input.image-keep-meta"))`);
        await waitFor(`${view}.querySelector(".image-plan").textContent === "Save removes its EXIF, comment, losslessly (keeping only which way up it stands)."`, "what stripping will do");
        await ev(`document.querySelector("dialog.preview button.save-edit").click()`);
        await waitFor(`/^Saved: 75×100 · JPEG .* · EXIF\.$/.test(${view}.querySelector(".edit-status").textContent)`, "stripped");
        const saved = execFileSync("docker", ["exec", container, "cat", "/home/user/Downloads/media/photo.jpg"]);
        const sos = (b) => b.subarray(b.indexOf(Buffer.from([0xff, 0xda])));
        if (saved.includes("SecretCam") || saved.includes("taken at home")) throw new Error("metadata left in");
        if (!sos(saved).equals(sos(jpeg))) throw new Error("the image data changed: not lossless");
        if (!saved.includes(Buffer.from([0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6]))) throw new Error("which way up it stands, lost");
        await ev(`document.querySelector("dialog.preview button.done-edit").click()`);
        await waitFor(`/^75×100 · JPEG · .* · EXIF$/.test(${info})`, "shown, standing as it did");
        await close();

        // Animated: said so; not editable (Save would keep one frame).
        await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === "loop.gif").click()`);
        await waitFor(`/^1×1 · GIF · .* · animated$/.test(${info})`, "an animated GIF, said to be");
        if (!(await ev(`document.querySelector("dialog.preview button.edit").hidden`))) throw new Error("an animated GIF offered for editing");
        await close();
        execFileSync("docker", ["exec", container, "rm", "/home/user/Downloads/media/quarters.png", "/home/user/Downloads/media/quarters.jpg", "/home/user/Downloads/media/photo.jpg", "/home/user/Downloads/media/loop.gif"]);
        // Back where the next check expects the page to be.
        await open("fs/#/", `document.title === "Downloads /" && !!document.querySelector("table")`, "the listing");
    });

    await step("files: U2NetP adjusts masks, selects an area, erases/restores with brushes, cancels, undoes, and saves a transparent PNG copy", async () => {
        // A red disk on white: a clear foreground with known centre and corners.
        // One corner is already transparent, to check that alpha is retained.
        writeFileSync(`${work}/subject.png`, png(300, 200, (x, y) =>
            x < 10 && y < 10 ? [0, 0, 0, 0] : x < 16 && y < 10 ? [80, 100, 120, 128] : (x - 150) ** 2 + (y - 100) ** 2 < 65 ** 2 ? [220, 30, 30, 255] : [255, 255, 255, 255]));
        execFileSync("docker", ["cp", "-q", `${work}/subject.png`, `${container}:/home/user/Downloads/media/subject.png`]);
        execFileSync("docker", ["exec", container, "chown", "user", "/home/user/Downloads/media/subject.png"]);
        const view = `document.querySelector("dialog.preview .image-view")`;
        const note = `${view}.querySelector(".edit-status").textContent`;
        const click = (cls) => ev(`${view}.querySelector(${JSON.stringify(cls)}).click()`);
        const close = async () => {
            await ev(`document.querySelector("dialog.preview button.close").click()`);
            await waitFor(`!document.querySelector("dialog.preview")`, "the picture closes");
        };
        const edit = async (name) => {
            await waitFor(`${listed}.includes(${JSON.stringify(name)})`, "the subject listed");
            await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === ${JSON.stringify(name)}).click()`);
            await waitFor(`!!${view} && !document.querySelector("dialog.preview button.edit").hidden`, "the subject shown");
            await ev(`document.querySelector("dialog.preview button.edit").click()`);
            await waitFor(`!!${view}.querySelector(".image-remove-background")`, "the background removal tool");
        };
        const alphas = () => ev(`(() => {
            const c = ${view}.querySelector("canvas.image-content"), ctx = c.getContext("2d");
            return [[2,2], [20,20], [150,100]].map(([x,y]) => ctx.getImageData(x,y,1,1).data[3]);
        })()`);
        await open("fs/#/media/", `${listed}.includes("subject.png")`, "the subject listed");
        await edit("subject.png");
        await ev(`(() => {
            window.backgroundRuns = 0;
            const Original = window.Worker;
            window.Worker = class extends Original {
                constructor(url, ...args) { super(url, ...args); this.background = String(url).includes("image-background-worker.js"); }
                postMessage(...args) { if (this.background) window.backgroundRuns++; return super.postMessage(...args); }
            };
        })()`);
        if (!(await ev(`${view}.querySelector("button.glyph.image-remove-background svg") !== null`))) throw new Error("background removal isn't a glyph");
        await click(".image-remove-background");
        await toolbarMode("background");
        if(await ev(`${view}.querySelector(".image-background-panel").matches(":popover-open")`))throw new Error("background adjustments opened automatically");
        await click(".image-background-spatial-cancel");
        await toolbarMode(null);
        await waitFor(`${note}.includes("cancelled") && !${view}.querySelector(".image-remove-background").disabled`, "removal cancelled");
        if (JSON.stringify(await alphas()) !== "[0,255,255]") throw new Error("cancellation changed the image");
        await click(".image-remove-background");
        const ready = `!${view}.querySelector(".image-background-spatial").hidden && !${view}.querySelector(".image-background-spatial-apply").disabled`;
        await waitFor(`${ready} || ${view}.querySelector(".image-background-note.error")`, "U2NetP preview finishes", 120000);
        if (!(await ev(ready))) throw new Error(await ev(note));
        if(await ev(`${view}.querySelector(".image-background-panel").matches(":popover-open")`))throw new Error("background adjustments opened after inference");
        await checks.click(`${view}.querySelector(".image-background-settings")`);
        await waitFor(`${view}.querySelector(".image-background-panel").matches(":popover-open")`,"background adjustments opened on request");
        if (await ev(`${view}.querySelector(".image-background-panel").querySelector("strong, .image-background-tools, .image-background-actions, button") !== null`)) throw new Error("adjustments still contain a heading, toolbar or action buttons");
        if (!(await ev(`${view}.querySelector(".image-background-panel").classList.contains("mask-brush-options")`))) throw new Error("adjustments do not share the save-options popover style");
        await checks.click(`${view}.querySelector(".image-background-settings")`);
        await waitFor(`!${view}.querySelector(".image-background-panel").matches(":popover-open") && ${view}.querySelector(".image-background-settings").getAttribute("aria-expanded") === "false"`, "adjustments toggled closed");
        await checks.click(`${view}.querySelector(".image-background-settings")`);
        await waitFor(`${view}.querySelector(".image-background-panel").matches(":popover-open")`, "adjustments toggled open");
        const initialRuns = await ev("window.backgroundRuns");
        const alphaSum = () => ev(`(() => {
            const c = ${view}.querySelector("canvas.image-content"), d = c.getContext("2d").getImageData(0,0,c.width,c.height).data;
            let sum = 0; for (let i = 3; i < d.length; i += 4) sum += d[i]; return sum;
        })()`);
        const set = async (key, value) => {
            await ev(`(input => { input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event("input")); })(${view}.querySelector(".image-background-${key}"))`);
            await waitFor(`${view}.querySelector(".image-background-${key}").parentElement.querySelector("output").textContent === ${JSON.stringify((key === "grow" && value > 0 ? "+" : "") + value + "%")}`, "the adjusted preview");
        };
        const dragImage = async (points, cancel = false) => {
            if (!cancel) {
                const box = await ev(`(() => {
                    const c = ${view}.querySelector("canvas.image-content"), r = c.getBoundingClientRect();
                    return { x: r.x, y: r.y, sx: r.width / c.width, sy: r.height / c.height };
                })()`);
                const at = async (type, [x, y], down) => checks.cdp("Input.dispatchMouseEvent", {
                    type, x: box.x + x * box.sx, y: box.y + y * box.sy, button: "left", buttons: down ? 1 : 0, clickCount: 1,
                });
                await at("mouseMoved", points[0], false);
                await at("mousePressed", points[0], true);
                for (const point of points.slice(1)) await at("mouseMoved", point, true);
                await at("mouseReleased", points.at(-1), false);
                return;
            }
            await ev(`(() => {
                const stage = ${view}.querySelector(".image-stage"), c = ${view}.querySelector("canvas.image-content"), r = c.getBoundingClientRect();
                const points = ${JSON.stringify(points)};
                const at = (type, [x,y]) => stage.dispatchEvent(new PointerEvent(type, { pointerId: 17, button: 0,
                    clientX: r.left + x * r.width / c.width, clientY: r.top + y * r.height / c.height, bubbles: true, cancelable: true }));
                at("pointerdown", points[0]);
                for (const point of points.slice(1)) at("pointermove", point);
                at(${JSON.stringify(cancel ? "pointercancel" : "pointerup")}, points.at(-1));
            })()`);
        };
        const rgbaAt = (px, py) => ev(`[...${view}.querySelector("canvas.image-content").getContext("2d").getImageData(${px},${py},1,1).data]`);
        const originalSum = await alphaSum();
        await set("threshold", 80);
        if (await alphaSum() >= originalSum) throw new Error("higher threshold didn't remove more");
        await set("softness", 0);
        await set("grow", 2);
        const grown = await alphaSum();
        await set("grow", -2);
        if (await alphaSum() >= grown) throw new Error("shrink didn't contract the mask");
        await set("threshold", 50);
        await set("softness", 100);
        await set("grow", 0);
        if (await alphaSum() !== originalSum || await ev("window.backgroundRuns") !== initialRuns) throw new Error("Restoring adjustments changed the raw mask or reran inference");
        // Use a real click: the dropdown must not cover its entry points.
        // Limit removal to the left half. The right half must retain every pixel.
        await checks.cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
        await waitFor(`(() => { const r = ${view}.querySelector(".image-background-panel").getBoundingClientRect(); return r.x >= 0 && r.right <= innerWidth && r.y >= 0 && r.bottom <= innerHeight; })()`, "the dropdown fits a narrow viewport");
        await checks.click(`${view}.querySelector(".image-background-mode-select")`);
        await checks.cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        // Let ResizeObserver fit the picture after the viewport change before
        // taking the screen coordinates used by the real pointer gesture.
        await ev("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
        // No area drawn yet is the whole image: Apply works, and nothing's outlined.
        if (await ev(`${view}.querySelector(".image-background-spatial-apply").disabled || !${view}.querySelector(".image-background-selection").hidden`)) throw new Error("with no area drawn, Apply is blocked or an area shown");
        await dragImage([[0, 0], [150, 200]]);
        try {
            await waitFor(`(() => {const box=${view}.querySelector(".image-background-selection"),c=${view}.querySelector("canvas.image-content");return !box.hidden&&box.dataset.size==="150×200"&&c.getContext("2d").getImageData(20,20,1,1).data[3]<30;})()`,"selected-area preview rendered");
        } catch (error) {
            throw new Error(`${error.message}: ${await ev(`(() => {const box=${view}.querySelector(".image-background-selection"),c=${view}.querySelector("canvas.image-content");return JSON.stringify({hidden:box.hidden,size:box.dataset.size,alpha:c.getContext("2d").getImageData(20,20,1,1).data[3],canvas:[c.width,c.height],note:${view}.querySelector(".image-background-spatial-hint")?.textContent});})()`)}`);
        }
        await ev(`(() => {
            const button = ${view}.querySelector(".image-zoom-in");
            button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); button.click();
        })()`);
        if (!(await ev(`!${view}.querySelector(".image-background-spatial").hidden && ${view}.querySelector(".image-zoom").textContent === "125%"`))) throw new Error("zooming dismissed the selection");
        if ((await rgbaAt(20, 20))[3] > 30 || JSON.stringify(await rgbaAt(280, 20)) !== "[255,255,255,255]") throw new Error("removal escaped its selection");
        await click(".image-background-invert");
        if ((await rgbaAt(20, 20))[3] !== 255 || (await rgbaAt(280, 20))[3] > 30) throw new Error("inverted background selection did not preserve the inside and remove the outside");
        await click(".image-background-invert");
        if ((await rgbaAt(20, 20))[3] > 30 || (await rgbaAt(280, 20))[3] !== 255) throw new Error("inverting twice changed the original background selection");
        // Background eraser shares compact brush settings, shapes, and bucket fill.
        await click(".image-background-mode-erase");
        if (await ev(`${view}.querySelector(".image-background-brush-options").matches(":popover-open")`)) throw new Error("background brush size is shown by default");
        await checks.click(`${view}.querySelector(".image-background-size-toggle")`);
        await waitFor(`${view}.querySelector(".image-background-brush-options").matches(":popover-open")`, "background brush size opened");
        await ev(`(input => { input.value="8"; input.dispatchEvent(new Event("input")); })(${view}.querySelector(".image-background-brush-size"))`);
        await ev(`${view}.querySelector(".image-background-brush-options").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))`);
        const backgroundShape = async (shape) => {
            if (shape === "brush") { await click(".image-background-mode-erase"); return; }
            await checks.click(`${view}.querySelector(".image-background-shape-toggle")`);
            await waitFor(`${view}.querySelector(".image-background-shape-options").matches(":popover-open")`, "background selection shape menu opened");
            await checks.click(`${view}.querySelector(".image-background-shape-${shape}")`);
        };
        const selectedSum = await alphaSum();
        if (!(await ev(`${view}.querySelector(".image-background-mode-select").parentElement.classList.contains("mask-selection-group") && ${view}.querySelector(".image-background-shape-toggle").parentElement === ${view}.querySelector(".image-background-mode-select").parentElement`))) throw new Error("background shape arrow isn't next to Select area");
        await backgroundShape("circle"); await dragImage([[30,30],[50,30]]);
        if ((await rgbaAt(30,30))[3] > 30 || (await rgbaAt(80,20))[3] !== 255) throw new Error("background circle selection geometry");
        await backgroundShape("rectangle"); await dragImage([[0,0],[150,200]]);
        if (await alphaSum() !== selectedSum) throw new Error("background rectangle selection wasn't restored");
        await backgroundShape("brush");
        await dragImage([[104,84],[136,84],[136,116],[104,116],[104,84]]);
        if ((await rgbaAt(120,100))[3] < 230) throw new Error("freehand outline unexpectedly filled itself");
        await click(".image-background-mode-fill"); await dragImage([[120,100]]);
        if ((await rgbaAt(120,100))[3] !== 0 || (await rgbaAt(145,100))[3] < 230) throw new Error("background flood fill escaped the outline");
        await click(".image-background-undo-stroke");
        if ((await rgbaAt(120,100))[3] < 230) throw new Error("Undo fill didn't restore the interior");
        await click(".image-background-undo-stroke");
        if (await alphaSum() !== selectedSum) throw new Error("Undo outline didn't restore the previous mask");
        // Restore copies original RGBA, including pre-existing transparency.
        await checks.click(`${view}.querySelector(".image-background-mode-restore")`);
        await dragImage([[20, 20], [60, 20]]);
        if ((await rgbaAt(40, 20))[3] !== 255) throw new Error("restore brush left a gap between its points");
        await click(".image-background-undo-stroke");
        if ((await rgbaAt(40, 20))[3] > 30) throw new Error("Undo stroke did not restore the model mask");
        await dragImage([[13, 5]]);
        if ((await rgbaAt(13, 5))[3] !== 128 || (await rgbaAt(2, 2))[3] !== 0) throw new Error("restore brush lost original alpha");
        await click(".image-background-mode-erase");
        await dragImage([[100, 100]]);
        if ((await rgbaAt(100, 100))[3] !== 0) throw new Error("erase brush didn't remove the painted pixel");
        await dragImage([[250, 100]]);
        if ((await rgbaAt(250, 100))[3] !== 255) throw new Error("brush changed pixels outside the selection");
        const beforeCancelledStroke = await alphaSum();
        await dragImage([[130, 100]], true);
        if (await alphaSum() !== beforeCancelledStroke) throw new Error("a cancelled pointer gesture changed the mask");
        await ev(`(() => { const undo = ${view}.querySelector(".image-background-undo-stroke"); for (let i = 0; i < 100 && !undo.disabled; i++) undo.click(); })()`);
        await click(".image-background-whole");
        if (await alphaSum() !== originalSum || await ev("window.backgroundRuns") !== initialRuns) throw new Error("selection and brushes changed the raw prediction");
        await click(".image-background-spatial-apply");
        await waitFor(`${note}.startsWith("Background removed")`, "the preview applied");
        const alpha = await alphas();
        if (alpha[0] !== 0 || alpha[1] > 30 || alpha[2] < 230) throw new Error(`foreground mask: ${alpha}`);
        await click(".image-undo");
        if (JSON.stringify(await alphas()) !== "[0,255,255]") throw new Error("Undo did not restore the original alpha");
        // Save a JPEG copy, then edit that: removal must select PNG automatically.
        await click(".image-save-options-toggle");
        await ev(`(f => { f.value = "image/jpeg"; f.dispatchEvent(new Event("change")); })(${view}.querySelector(".image-format"))`);
        await ev(`document.querySelector("dialog.preview button.save-edit").click()`);
        await waitFor(`${note}.startsWith("Saved a copy as subject.jpg")`, "the JPEG fixture saved");
        await ev(`document.querySelector("dialog.preview button.done-edit").click()`);
        await close();
        execFileSync("docker", ["exec", container, "rm", "/home/user/Downloads/media/subject.png"]);
        await edit("subject.jpg");
        await click(".image-remove-background");
        await waitFor(`${ready} || ${view}.querySelector(".image-background-note.error")`, "JPEG background preview", 120000);
        await click(".image-background-mode-select");
        await dragImage([[0, 0], [150, 200]]);
        await click(".image-background-spatial-apply");
        if (await ev(`${view}.querySelector(".image-format").value`) !== "image/png") throw new Error(await ev(note));
        await click(".image-rotate-right");
        const previousRuns = await ev("window.backgroundRuns");
        const beforeAdjusting = await alphaSum();
        const previouslyRemoved = (await rgbaAt(180,20))[3];
        await click(".image-remove-background");
        await waitFor(ready, "a new background removal pass",120000);
        if(await ev("window.backgroundRuns")<=previousRuns)throw new Error("a new pass didn't analyze the current image");
        await click(".image-background-mode-select");
        await dragImage([[0,150],[200,300]]);
        if((await rgbaAt(180,20))[3]!==previouslyRemoved||(await rgbaAt(180,280))[3]>30)throw new Error("a new selection restored earlier removed pixels or missed the new area");
        const secondPreview = await alphaSum();
        await click(".image-background-mode-restore");
        await dragImage([[180,280]]);
        if ((await rgbaAt(180,280))[3] !== 255 || (await rgbaAt(180,20))[3] !== previouslyRemoved) throw new Error("restore brush changed an earlier pass");
        await click(".image-background-undo-stroke");
        if (await alphaSum() !== secondPreview) throw new Error("Undo stroke changed the new pass");
        const currentRuns=await ev("window.backgroundRuns");
        await click(".image-background-settings");
        await set("grow", 2);
        if ((await rgbaAt(180,20))[3] !== previouslyRemoved || await ev("window.backgroundRuns") !== currentRuns) throw new Error("adjustments changed an earlier pass or reran inference");
        const adjustedPreview = await alphaSum();
        await ev(`${view}.querySelector(".image-background-grow").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))`);
        await waitFor(`!${view}.querySelector(".image-background-panel").matches(":popover-open")`, "Escape closes adjustments");
        if (await alphaSum() !== adjustedPreview || await ev(`${view}.querySelector(".image-background-spatial").hidden`)) throw new Error("closing adjustments discarded the background preview");
        await click(".image-background-spatial-cancel");
        if (await alphaSum() !== beforeAdjusting) throw new Error("Cancel didn't restore the committed cutout");
        await click(".image-remove-background");
        await waitFor(ready, "the next removal pass",120000);
        await click(".image-background-mode-select");
        await dragImage([[0,150],[200,300]]);
        await click(".image-background-spatial-apply");
        if (await alphaSum() >= beforeAdjusting || (await rgbaAt(180,20))[3]!==previouslyRemoved || (await rgbaAt(180,280))[3]>30) throw new Error("the second pass didn't preserve the first removal");
        await click(".image-undo");
        if (await alphaSum() !== beforeAdjusting) throw new Error("Undo didn't remove only the latest background pass");
        await ev(`document.querySelector("dialog.preview button.save-edit").click()`);
        await waitFor(`${note}.startsWith("Saved a copy as subject.png: 200×300 · PNG")`, "transparent PNG copy saved");
        await ev(`document.querySelector("dialog.preview button.done-edit").click()`);
        await close();
        await edit("subject.png");
        const saved = await ev(`(() => {
            const c = ${view}.querySelector("canvas.image-content"), ctx = c.getContext("2d");
            return [c.width, c.height, ctx.getImageData(20,20,1,1).data[3], ctx.getImageData(100,150,1,1).data[3], ctx.getImageData(180,280,1,1).data[3]];
        })()`);
        if (saved[0] !== 200 || saved[1] !== 300 || saved[2] > 30 || saved[3] < 230 || saved[4] !== 255) throw new Error(`saved PNG: ${saved}`);
        await ev(`document.querySelector("dialog.preview button.done-edit").click()`);
        await close();
        if (inContainer("sh", "-c", "head -c 3 ~/Downloads/media/subject.jpg | od -An -tx1").trim() !== "ff d8 ff") throw new Error("the original JPEG was replaced");
        execFileSync("docker", ["exec", container, "rm", "/home/user/Downloads/media/subject.png", "/home/user/Downloads/media/subject.jpg"]);
        await open("fs/#/", `document.title === "Downloads /" && !!document.querySelector("table")`, "the listing");
    });
    await step("files: MI-GAN inpaints a masked logo, cancels, preserves other pixels and alpha, undoes, rotates, and saves", async () => {
        writeFileSync(`${work}/repair.png`, png(320, 240, (x,y) => x < 10 && y < 10 ? [0,0,0,0]
            : x >= 140 && x < 180 && y >= 100 && y < 140 ? [240,30,30,255]
            : [140,160,180, x >= 300 && y >= 220 ? 128 : 255]));
        execFileSync("docker", ["cp", "-q", `${work}/repair.png`, `${container}:/home/user/Downloads/media/repair.png`]);
        execFileSync("docker", ["exec", container, "chown", "user", "/home/user/Downloads/media/repair.png"]);
        await open("fs/#/media/", `${listed}.includes("repair.png")`, "the repair image listed");
        await ev(`[...document.querySelectorAll("td.name a")].find(a => a.textContent === "repair.png").click()`);
        await waitFor(`!!document.querySelector("dialog.preview .image-view") && !document.querySelector("dialog.preview button.edit").hidden`, "the repair image shown");
        await ev(`document.querySelector("dialog.preview button.edit").click()`);
        const view = `document.querySelector("dialog.preview .image-view")`;
        const click = (cls) => ev(`${view}.querySelector(${JSON.stringify(cls)}).click()`);
        const pixel = (x,y) => ev(`[...${view}.querySelector("canvas.image-content").getContext("2d").getImageData(${x},${y},1,1).data]`);
        const drawLine = async (points) => {
            const r = await ev(`(() => { const c = ${view}.querySelector("canvas.image-content"), r = c.getBoundingClientRect(); return {x:r.x,y:r.y,sx:r.width/c.width,sy:r.height/c.height}; })()`);
            const at = (type, [x,y], down) => checks.cdp("Input.dispatchMouseEvent", { type, x:r.x+x*r.sx, y:r.y+y*r.sy, button:"left", buttons:down?1:0, clickCount:1 });
            await at("mousePressed", points[0], true);
            for (const point of points.slice(1)) await at("mouseMoved", point, true);
            await at("mouseReleased", points.at(-1), false);
        };
        const drag = (from, to = from) => drawLine([from, to]);
        await waitFor(`!!${view}.querySelector(".image-inpaint-start")`, "the inpainting glyph");
        await ev(`(() => { const c = ${view}.querySelector("canvas.image-content"); window.repairOriginal = c.getContext("2d").getImageData(0,0,c.width,c.height).data; })()`);
        await click(".image-save-options-toggle");
        await click(".image-inpaint-start");
        await toolbarMode("inpaint");
        if (await ev(`${view}.querySelector(".image-inpaint-brush-options").matches(":popover-open")`)) throw new Error("inpainting brush size is shown by default");
        if (await ev(`${view}.querySelector(".image-undo .glyph-caption").textContent`) !== "Undo" || await ev(`${view}.querySelector(".image-inpaint-undo .glyph-caption").textContent`) !== "Undo") throw new Error("Undo caption missing");
        await checks.click(`${view}.querySelector(".image-inpaint-size-toggle")`);
        await waitFor(`${view}.querySelector(".image-inpaint-brush-options").matches(":popover-open")`, "inpainting brush size opened");
        await ev(`(s=>{s.value="8";s.dispatchEvent(new Event("input"));})(${view}.querySelector(".image-inpaint-size"))`);
        await ev(`${view}.querySelector(".image-inpaint-brush-options").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))`);
        const shape = async value => {
            if (value === "brush") { await click(".image-inpaint-paint"); return; }
            await checks.click(`${view}.querySelector(".image-inpaint-shape-toggle")`);
            await waitFor(`${view}.querySelector(".image-inpaint-shape-options").matches(":popover-open")`, "inpainting selection shape menu opened");
            await checks.click(`${view}.querySelector(".image-inpaint-shape-${value}")`);
        };
        if (!(await ev(`${view}.querySelector(".image-inpaint-select").parentElement.classList.contains("mask-selection-group") && ${view}.querySelector(".image-inpaint-shape-toggle").parentElement === ${view}.querySelector(".image-inpaint-select").parentElement`))) throw new Error("inpainting shape arrow isn't next to Select area");
        await shape("circle"); await drag([80,80],[100,80]);
        if (!(await ev(`(() => {const c=${view}.querySelector(".image-inpaint-overlay mask circle");return c&&Number(c.getAttribute("cx"))===80&&Number(c.getAttribute("cy"))===80&&Number(c.getAttribute("r"))===20;})()`))) throw new Error("inpainting circle geometry");
        await click(".image-inpaint-undo");
        await shape("rectangle"); await drag([20,20],[60,60]);
        if (!(await ev(`Number(${view}.querySelector(".image-inpaint-overlay mask rect:last-child").getAttribute("width"))===40`))) throw new Error("inpainting rectangle geometry");
        await click(".image-inpaint-invert");
        const invertedAlpha = await ev(`(async () => {
            const svg=${view}.querySelector(".image-inpaint-overlay").cloneNode(true);
            svg.removeAttribute("style"); svg.setAttribute("width",320); svg.setAttribute("height",240);
            const url=URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)],{type:"image/svg+xml"}));
            try { const image=new Image(); image.src=url; await image.decode();
                const c=Object.assign(document.createElement("canvas"),{width:320,height:240}),ctx=c.getContext("2d");ctx.drawImage(image,0,0);
                return [ctx.getImageData(30,30,1,1).data[3],ctx.getImageData(100,100,1,1).data[3]];
            } finally {URL.revokeObjectURL(url);}
        })()`);
        if (invertedAlpha[0] !== 0 || invertedAlpha[1] < 120) throw new Error(`inverted inpainting highlight does not show the complement: ${invertedAlpha}`);
        const maskPixels = await ev(`(async () => {
            const url=performance.getEntriesByType("resource").find(e=>new URL(e.name).pathname.endsWith("/image-mask.js")).name;
            const {drawMaskMarks}=await import(url);
            const c=Object.assign(document.createElement("canvas"),{width:8,height:8}),ctx=c.getContext("2d");
            const marks=[{rect:{x:2,y:2,width:4,height:4}},{invert:true,width:8,height:8}];
            drawMaskMarks(ctx,marks); const first=[ctx.getImageData(3,3,1,1).data[3],ctx.getImageData(0,0,1,1).data[3]];
            ctx.clearRect(0,0,8,8);drawMaskMarks(ctx,[...marks,{invert:true,width:8,height:8}]);
            return [...first,ctx.getImageData(3,3,1,1).data[3],ctx.getImageData(0,0,1,1).data[3]];
        })()`);
        if (JSON.stringify(maskPixels) !== "[0,255,255,0]") throw new Error(`inpainting mask inversion pixels: ${maskPixels}`);
        await click(".image-inpaint-undo");
        await click(".image-inpaint-reset"); await shape("brush");
        await drawLine([[50,50],[110,50],[110,110],[50,110],[50,50]]);
        await click(".image-inpaint-fill"); await drag([80,80]);
        const filledMask = `${view}.querySelector(".image-inpaint-overlay mask path:last-child")?.getAttribute("d").includes("v1")`;
        await waitFor(filledMask, "the enclosed outline filled");
        await click(".image-inpaint-undo");
        await waitFor(`!(${filledMask})`, "Undo fill kept the outline");
        await click(".image-inpaint-reset"); await click(".image-inpaint-paint");
        await drawLine([[50,50],[110,50],[110,110],[50,110]]);
        await click(".image-inpaint-fill"); await drag([80,80]);
        if (!(await ev(`${view}.querySelector(".image-inpaint-note").textContent.includes("outline is open")`))) throw new Error("open outline wasn't rejected");
        await click(".image-inpaint-reset");
        const fullMask = `${view}.querySelector(".image-inpaint-overlay mask rect:last-child")`;
        const isFullMask = `(() => { const r = ${fullMask}; return r && r.getAttribute("fill") === "white" && ["x","y","width","height"].map(k=>Number(r.getAttribute(k))).join(",") === "0,0,320,240"; })()`;
        await checks.click(`${view}.querySelector(".image-inpaint-all")`);
        await waitFor(isFullMask, "the entire image masked with one click");
        await click(".image-inpaint-undo");
        await ev(`${view}.querySelector(".image-stage").dispatchEvent(new KeyboardEvent("keydown", {key:"a",ctrlKey:true,bubbles:true,cancelable:true}))`);
        await waitFor(isFullMask, "the entire image masked with Ctrl+A");
        await click(".image-inpaint-reset");
        await click(".image-inpaint-select"); await drag([-8,-8], [328,248]);
        await waitFor(isFullMask, "a rectangle dragged from outside covers all edges");
        await click(".image-inpaint-reset");
        await drag([328,248], [-8,-8]);
        await waitFor(isFullMask, "reverse selection clamps to all edges");
        await click(".image-inpaint-reset");
        await drag([130,90], [190,150]);
        await click(".image-inpaint-run"); await click(".image-inpaint-cancel");
        await waitFor(`${view}.querySelector(".image-inpaint-tools").hidden`, "inpainting cancelled");
        await toolbarMode(null);
        if(await ev(`${view}.querySelector(".image-save-options").matches(":popover-open")`))throw new Error("save options reopened after inpainting");
        if (JSON.stringify(await pixel(160,120)) !== "[240,30,30,255]") throw new Error("cancel changed the original");
        let repairCount = 0;
        const repair = async () => {
            await click(".image-inpaint-start");
            if (repairCount++ === 0) {
                await shape("brush");
                await drawLine([[134,94],[186,94],[186,146],[134,146],[134,94]]);
                await click(".image-inpaint-fill"); await drag([160,120]);
                if (!(await ev(filledMask))) throw new Error(`logo outline wasn't filled: ${await ev(`${view}.querySelector(".image-inpaint-note").textContent`)}`);
            } else {
                await shape("circle"); await drag([160,120],[190,120]);
            }
            await shape("rectangle"); await drag([300,220], [320,240]);
            await shape("brush");
            // A brush mark can be undone, and subtracting a mark must not alter pixels.
            await click(".image-inpaint-paint"); await drag([220,180]); await click(".image-inpaint-undo");
            await ev(`(s => {s.value="8";s.dispatchEvent(new Event("input"));})(${view}.querySelector(".image-inpaint-size"))`);
            await click(".image-inpaint-erase"); await drag([132,92]);
            await click(".image-inpaint-run");
            await waitFor(`!${view}.querySelector(".image-inpaint-apply").disabled || ${view}.querySelector(".image-inpaint-note.error")`, "MI-GAN inference finishes", 120000);
            if (await ev(`${view}.querySelector(".image-inpaint-apply").disabled`)) throw new Error(await ev(`${view}.querySelector(".image-inpaint-note").textContent`));
            const centre = await pixel(160,120);
            if (Math.abs(centre[0]-240)+Math.abs(centre[1]-30)+Math.abs(centre[2]-30)<80) throw new Error(`logo wasn't repaired on attempt ${repairCount}: ${centre}`);
            const intact = await ev(`(() => {
                const c=${view}.querySelector("canvas.image-content"), data=c.getContext("2d").getImageData(0,0,320,240).data, before=window.repairOriginal;
                for(let y=0;y<240;y++)for(let x=0;x<320;x++){
                    const i=(y*320+x)*4, marked=(x>=130&&x<190&&y>=90&&y<150)||(x>=300&&y>=220);
                    if(data[i+3]!==before[i+3])return "alpha changed";
                    if(!marked)for(let ch=0;ch<4;ch++)if(data[i+ch]!==before[i+ch])return "unmarked pixels changed";
                }return "ok";
            })()`);
            if(intact!=="ok")throw new Error(intact);
            if (JSON.stringify(await pixel(132,92)) !== "[140,160,180,255]") throw new Error("subtracted mask changed pixels");
            await click(".image-inpaint-apply");
            await waitFor(`${view}.querySelector(".edit-status").textContent.startsWith("Inpainting applied")`, "the repair applied");
        };
        await repair();
        await click(".image-undo");
        if(JSON.stringify(await pixel(160,120))!=="[240,30,30,255]")throw new Error("Undo didn't restore the logo");
        await repair();
        await click(".image-rotate-right");
        await ev(`document.querySelector("dialog.preview button.save-edit").click()`);
        await waitFor(`${view}.querySelector(".edit-status").textContent.startsWith("Saved: 240×320 · PNG")`, "the inpainted PNG saved");
        await ev(`document.querySelector("dialog.preview button.done-edit").click()`);
        await waitFor(`!!${view}.querySelector("img.image-content") && !document.querySelector("dialog.preview button.edit").hidden`, "the saved repair shown");
        await ev(`document.querySelector("dialog.preview button.edit").click()`);
        await waitFor(`!!${view}.querySelector("canvas.image-content")`, "the saved pixels decoded");
        const centre=await pixel(120,160);
        if(Math.abs(centre[0]-240)+Math.abs(centre[1]-30)+Math.abs(centre[2]-30)<80)throw new Error("saved PNG still contains the logo");
        if((await pixel(10,310))[3]!==128||(await pixel(235,5))[3]!==0)throw new Error("saved transparency changed");
        await ev(`document.querySelector("dialog.preview button.done-edit").click(); document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "the repair image closed");
        execFileSync("docker", ["exec", container, "rm", "/home/user/Downloads/media/repair.png"]);
        await open("fs/#/", `document.title === "Downloads /" && !!document.querySelector("table")`, "the listing");
    });

    await step("files: shapes, a pen, a highlighter and a paint bucket in a colour picked from the picture, undo, redo and History, a pasted picture placed, and saved", async () => {
        // Blue on the left, white on the right.
        writeFileSync(`${work}/shapes.png`, png(200, 100, (x) => x < 100 ? [0,0,255,255] : [255,255,255,255]));
        execFileSync("docker", ["cp", "-q", `${work}/shapes.png`, `${container}:/home/user/Downloads/media/shapes.png`]);
        execFileSync("docker", ["exec", container, "chown", "user", "/home/user/Downloads/media/shapes.png"]);
        await open("fs/#/media/", `${listed}.includes("shapes.png")`, "the shapes image listed");
        await ev(`[...document.querySelectorAll("td.name a")].find(a => a.textContent === "shapes.png").click()`);
        const view = `document.querySelector("dialog.preview .image-view")`;
        await waitFor(`!!${view} && !document.querySelector("dialog.preview button.edit").hidden`, "the shapes image shown");
        await ev(`document.querySelector("dialog.preview button.edit").click()`);
        await waitFor(`!!${view}.querySelector(".image-draw-start") && !!${view}.querySelector("canvas.image-content")`, "the drawing glyph");
        const click = (cls) => ev(`${view}.querySelector(${JSON.stringify(cls)}).click()`);
        const pixel = (x,y) => ev(`[...${view}.querySelector("canvas.image-content").getContext("2d").getImageData(${x},${y},1,1).data]`);
        const near = (got, want) => got.slice(0, 3).every((v, i) => Math.abs(v - want[i]) < 40);
        const pointer = async (points) => {
            const r = await ev(`(() => { const c = ${view}.querySelector("canvas.image-content"), r = c.getBoundingClientRect(); return {x:r.x,y:r.y,sx:r.width/c.width,sy:r.height/c.height}; })()`);
            const at = (type, [x,y], down) => checks.cdp("Input.dispatchMouseEvent", { type, x:r.x+x*r.sx, y:r.y+y*r.sy, button:"left", buttons:down?1:0, clickCount:1 });
            await at("mousePressed", points[0], true);
            for (const point of points.slice(1)) await at("mouseMoved", point, true);
            await at("mouseReleased", points.at(-1), false);
        };
        const key = (k, mods = {}) => ev(`${view}.querySelector(".image-stage").dispatchEvent(new KeyboardEvent("keydown",{key:${JSON.stringify(k)},...${JSON.stringify(mods)},bubbles:true,cancelable:true}))`);
        const red = `(() => { const d = ${view}.querySelector("canvas.image-content").getContext("2d").getImageData(32,50,1,1).data; return d[0] > 200 && d[2] < 60; })()`;
        await click(".image-draw-start");
        await waitFor(`!${view}.querySelector(".image-draw-tools").hidden && ${view}.querySelector(".image-edit-default").hidden`, "the drawing tools shown");
        if (await ev(`!${view}.querySelector(".image-draw-apply").disabled`)) throw new Error("Draw offered before a shape is drawn");
        // The colour, picked from the picture's blue half.
        await ev(`(c=>{c.value="#00ff00";c.dispatchEvent(new Event("input"));})(${view}.querySelector(".image-draw-color"))`);
        await key("i");
        await waitFor(`${view}.querySelector(".image-stage").classList.contains("picking-colour")`, "picking a colour");
        await pointer([[20, 50]]);
        await waitFor(`${view}.querySelector(".image-draw-color").value === "#0000ff" && !${view}.querySelector(".image-stage").classList.contains("picking-colour")`, "the blue picked");
        // A filled rectangle on the white half, chosen from the menus.
        await checks.click(`${view}.querySelector(".image-draw-shape-menu-toggle")`);
        await waitFor(`${view}.querySelector(".image-draw-shape-menu-options").matches(":popover-open")`, "the Draw with menu opened");
        await checks.click(`${view}.querySelector(".image-draw-rect")`);
        await waitFor(`!${view}.querySelector(".image-draw-shape-menu-options").matches(":popover-open") && ${view}.querySelector(".image-draw-shape-menu-current").title === "Draw with: Rectangle" && ${view}.querySelector(".image-draw-rect").getAttribute("aria-checked") === "true"`, "Rectangle chosen");
        await checks.click(`${view}.querySelector(".image-draw-style-menu-current")`);
        await waitFor(`${view}.querySelector(".image-draw-style-menu-options").matches(":popover-open")`, "the Style menu opened");
        await checks.click(`${view}.querySelector(".image-draw-fill")`);
        await waitFor(`${view}.querySelector(".image-draw-style-menu-current").title === "Style: Filled"`, "Filled chosen");
        await pointer([[120, 20], [140, 40], [160, 60]]);
        await waitFor(`!${view}.querySelector(".image-draw-shape").hidden && ${view}.querySelector(".image-draw-shape").dataset.size === "40×40" && !${view}.querySelector(".image-draw-apply").disabled`, "the rectangle previewed");
        if (!near(await pixel(140, 40), [255,255,255])) throw new Error("the preview changed the picture before it was drawn");
        await click(".image-draw-apply");
        await waitFor(`${view}.querySelector(".image-draw-tools").hidden && !${view}.querySelector(".image-edit-default").hidden`, "the drawing tools closed");
        if (!near(await pixel(140, 40), [0,0,255]) || !near(await pixel(110, 40), [255,255,255]) || !near(await pixel(170, 70), [255,255,255])) throw new Error("the rectangle wasn't filled where it was drawn");
        // A red circle's outline, 4 pixels, drawn with Enter.
        await key("d");
        await waitFor(`!${view}.querySelector(".image-draw-tools").hidden`, "D opens the drawing tools");
        await click(".image-draw-circle"); await click(".image-draw-outline");
        await ev(`(c=>{c.value="#ff0000";c.dispatchEvent(new Event("input"));})(${view}.querySelector(".image-draw-color"))`);
        await ev(`(l=>{l.value="4";l.dispatchEvent(new Event("input"));})(${view}.querySelector(".image-draw-line"))`);
        if (!(await ev(`${view}.querySelector(".image-draw-line-label").checkVisibility()`))) throw new Error("no line width for an outline");
        if (await ev(`${view}.querySelector(".image-draw-undo-stroke").checkVisibility()`)) throw new Error("Undo stroke shown for a circle");
        await pointer([[60, 50], [75, 50], [90, 50]]);
        await waitFor(`${view}.querySelector(".image-draw-shape").dataset.size === "60×60"`, "the circle previewed");
        if (process.env.SHAPES_SCREENSHOT) { const shot = await checks.cdp("Page.captureScreenshot", { format: "png" }); writeFileSync(process.env.SHAPES_SCREENSHOT, Buffer.from(shot.data, "base64")); }
        await key("Enter");
        await waitFor(`${view}.querySelector(".image-draw-tools").hidden`, "Enter draws it");
        if (!near(await pixel(32, 50), [255,0,0]) || !near(await pixel(60, 50), [0,0,255]) || !near(await pixel(60, 22), [255,0,0])) throw new Error("the circle's outline isn't where it was drawn");
        await click(".image-undo");
        await waitFor(`(() => { const d = ${view}.querySelector("canvas.image-content").getContext("2d").getImageData(32,50,1,1).data; return d[0] < 40 && d[2] > 200; })()`, "Undo removes the circle");
        if (!near(await pixel(140, 40), [0,0,255])) throw new Error("Undo removed the rectangle too");
        // Redo, by button and keys; and History, to go back and forth.
        if (await ev(`${view}.querySelector(".image-redo .glyph-caption").textContent`) !== "Redo") throw new Error("Redo's caption isn't Redo");
        await click(".image-redo");
        await waitFor(red, "Redo brings the circle back");
        await key("z", { ctrlKey: true });
        await waitFor(`!${red}`, "Ctrl+Z undoes it again");
        await click(".image-history-toggle");
        await waitFor(`${view}.querySelector(".image-history").matches(":popover-open")`, "History shown");
        const steps = `[...${view}.querySelectorAll(".image-history-step")]`;
        const names = await ev(`${steps}.map(b => b.textContent)`);
        if (JSON.stringify(names) !== JSON.stringify(["Original", "Fill rectangle #0000ff", "Outline circle #ff0000"])) throw new Error(`History: ${JSON.stringify(names)}`);
        if (!(await ev(`${steps}[1].getAttribute("aria-current") === "step" && ${steps}[2].closest("li").classList.contains("undone")`))) throw new Error("History doesn't show where it is, and what's undone");
        await ev(`${steps}[0].click()`);
        await waitFor(`(() => { const d = ${view}.querySelector("canvas.image-content").getContext("2d").getImageData(140,40,1,1).data; return d[0] > 200 && d[2] > 200; })()`, "History back to the original");
        await ev(`${steps}[2].click()`);
        await waitFor(red, "History forward to the circle");
        if (!near(await pixel(140, 40), [0,0,255])) throw new Error("History forward skipped the rectangle");
        await ev(`${steps}[1].click()`);
        await waitFor(`!${red} && ${steps}[1].getAttribute("aria-current") === "step"`, "History back to the rectangle");
        await ev(`${view}.querySelector(".image-history").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))`);
        await waitFor(`!${view}.querySelector(".image-history").matches(":popover-open")`, "History closed");
        await key("z", { ctrlKey: true, shiftKey: true });
        await waitFor(red, "Ctrl+Shift+Z redoes");
        await key("z", { ctrlKey: true });
        await waitFor(`!${red}`, "and Ctrl+Z undoes");
        // Cancelled: nothing drawn.
        await click(".image-draw-start"); await pointer([[10, 10], [30, 30]]); await key("Escape");
        await waitFor(`${view}.querySelector(".image-draw-tools").hidden && ${view}.querySelector(".image-draw-shape").hidden`, "Escape cancels the shape");
        if (!near(await pixel(20, 20), [0,0,255])) throw new Error("a cancelled shape was drawn");
        // A pen's line; a highlighter's, crossing, no darker where they cross.
        await click(".image-draw-start"); await key("p");
        await waitFor(`${view}.querySelector(".image-draw-pen").getAttribute("aria-checked") === "true" && ${view}.querySelector(".image-draw-fill").disabled && ${view}.querySelector(".image-draw-outline span").textContent === "Solid line"`, "P picks the pen");
        await click(".image-draw-outline");
        await ev(`(c=>{c.value="#ff0000";c.dispatchEvent(new Event("input"));})(${view}.querySelector(".image-draw-color"))`);
        await ev(`(l=>{l.value="6";l.dispatchEvent(new Event("input"));})(${view}.querySelector(".image-draw-line"))`);
        await pointer([[110, 80], [130, 80], [150, 80], [170, 80], [190, 80]]);
        await waitFor(`${view}.querySelector(".image-draw-strokes").style.display !== "none" && !${view}.querySelector(".image-draw-apply").disabled`, "the pen's line previewed");
        await click(".image-draw-apply");
        await waitFor(`${view}.querySelector(".image-draw-tools").hidden`, "the line drawn");
        if (!near(await pixel(150, 80), [255,0,0]) || !near(await pixel(150, 70), [255,255,255])) throw new Error("the pen's line isn't where it was drawn");
        await click(".image-draw-start"); await click(".image-draw-highlight");
        await ev(`(c=>{c.value="#ffff00";c.dispatchEvent(new Event("input"));})(${view}.querySelector(".image-draw-color"))`);
        await ev(`(l=>{l.value="8";l.dispatchEvent(new Event("input"));})(${view}.querySelector(".image-draw-line"))`);
        await pointer([[165, 92], [180, 92], [195, 92]]);
        await pointer([[185, 86], [185, 92], [185, 98]]);
        await click(".image-draw-undo-stroke"); await pointer([[180, 86], [180, 92], [180, 98]]);
        await key("Enter");
        await waitFor(`${view}.querySelector(".image-draw-tools").hidden`, "the highlighting drawn");
        const once = await pixel(170, 92), twice = await pixel(180, 92);
        if (!near(once, [255,255,153]) || JSON.stringify(once) !== JSON.stringify(twice) || !near(await pixel(185, 70), [255,255,255])) throw new Error(`highlighting: ${once} once, ${twice} where it crosses`);
        // A picture pasted, placed over an area.
        await ev(`(async () => {
            const c = Object.assign(document.createElement("canvas"), { width: 50, height: 50 }), x = c.getContext("2d");
            x.fillStyle = "rgb(0,200,0)"; x.fillRect(0, 0, 50, 50);
            const blob = await new Promise(r => c.toBlob(r, "image/png")), data = new DataTransfer();
            data.items.add(new File([blob], "green.png", { type: "image/png" }));
            ${view}.querySelector(".image-stage").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
        })()`);
        await waitFor(`!${view}.querySelector(".image-place-tools").hidden && !${view}.querySelector(".image-place-preview").hidden && ${view}.querySelector(".image-place-frame").dataset.size === "50×50"`, "the pasted picture placed, centred");
        await pointer([[10, 10], [25, 25], [40, 40]]);
        await waitFor(`${view}.querySelector(".image-place-frame").dataset.size === "30×30"`, "the area it covers dragged");
        await key("Enter");
        await waitFor(`${view}.querySelector(".image-place-tools").hidden`, "the picture placed");
        if (!near(await pixel(25, 25), [0,200,0]) || !near(await pixel(50, 50), [0,0,255])) throw new Error("the pasted picture isn't over the area dragged");
        await click(".image-history-toggle");
        await waitFor(`${steps}.at(-1)?.textContent === "Place a picture over 15% × 30%"`, "the placing in History");
        await ev(`${view}.querySelector(".image-history").hidePopover()`);
        // The paint bucket: white filled, but only within a rectangle selected.
        await click(".image-draw-start"); await key("b");
        await waitFor(`${view}.querySelector(".image-draw-bucket").getAttribute("aria-checked") === "true" && ${view}.querySelector(".image-draw-tolerance-label").checkVisibility() && !${view}.querySelector(".image-draw-style-menu-group").checkVisibility() && ${view}.querySelector(".image-draw-select-menu-group").checkVisibility()`, "B picks the paint bucket");
        await ev(`(c=>{c.value="#ff00ff";c.dispatchEvent(new Event("input"));})(${view}.querySelector(".image-draw-color"))`);
        await ev(`(t=>{t.value="10";t.dispatchEvent(new Event("input"));})(${view}.querySelector(".image-draw-tolerance"))`);
        await click(".image-draw-select-rect");
        await pointer([[100, 0], [150, 25], [200, 50]]);
        await waitFor(`!${view}.querySelector(".image-draw-selection").hidden && ${view}.querySelector(".image-draw-selection").dataset.size === "100×50"`, "the bucket's selection dragged");
        await pointer([[105, 5]]);
        await waitFor(`!${view}.querySelector(".image-draw-filled").hidden && !${view}.querySelector(".image-draw-apply").disabled`, "the fill previewed");
        if (!near(await pixel(105, 5), [255,255,255])) throw new Error("the fill changed the picture before it was applied");
        await click(".image-draw-invert");
        await pointer([[105, 60]]);
        await waitFor(`!${view}.querySelector(".image-draw-filled").hidden && ${view}.querySelector(".image-draw-invert").getAttribute("aria-pressed") === "true"`, "the inverted bucket selection previewed");
        const inverseFill = await ev(`(()=>{const c=${view}.querySelector(".image-draw-filled"),ctx=c.getContext("2d");return [[105,5],[105,60]].map(([x,y])=>[...ctx.getImageData(x,y,1,1).data].slice(0,3));})()`);
        if (!near(inverseFill[0], [255,255,255]) || !near(inverseFill[1], [255,0,255])) throw new Error(`bucket inversion: ${JSON.stringify(inverseFill)}`);
        await click(".image-draw-undo-stroke");
        await click(".image-draw-invert");
        await waitFor(`!${view}.querySelector(".image-draw-apply").disabled`, "the original bucket selection restored");
        await key("Enter");
        await waitFor(`${view}.querySelector(".image-draw-tools").hidden`, "the fill applied");
        if (!near(await pixel(105, 5), [255,0,255]) || !near(await pixel(195, 45), [255,0,255])) throw new Error("the white in the selection wasn't filled");
        if (!near(await pixel(140, 40), [0,0,255]) || !near(await pixel(105, 60), [255,255,255]) || !near(await pixel(50, 50), [0,0,255])) throw new Error("the fill went past the colour or the selection");
        await click(".image-history-toggle");
        await waitFor(`${steps}.at(-1)?.textContent === "Fill 1 area #ff00ff within a rectangle"`, "the fill in History");
        await ev(`${view}.querySelector(".image-history").hidePopover()`);
        await ev(`document.querySelector("dialog.preview button.save-edit").click()`);
        await waitFor(`${view}.querySelector(".edit-status").textContent.startsWith("Saved: 200×100 · PNG")`, "the drawn PNG saved");
        await ev(`document.querySelector("dialog.preview button.done-edit").click(); document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "the shapes image closed");
        execFileSync("docker", ["exec", container, "rm", "/home/user/Downloads/media/shapes.png"]);
        await open("fs/#/", `document.title === "Downloads /" && !!document.querySelector("table")`, "the listing");
        return "an eyedropper-picked blue rectangle, a red outlined circle drawn with Enter, undone, redone and gone back to in History, a cancelled shape, a pen's line, crossing highlights no darker, a pasted picture placed, a paint-bucket fill kept to a selection, saved";
    });

    await step("files: inpainting selection reaches the lower-right image edge when fitted and zoomed", async () => {
        writeFileSync(`${work}/edges.png`, png(2400,1600,()=>[140,160,180,255]));
        execFileSync("docker",["cp","-q",`${work}/edges.png`,`${container}:/home/user/Downloads/media/edges.png`]);
        execFileSync("docker",["exec",container,"chown","user","/home/user/Downloads/media/edges.png"]);
        await open("fs/#/media/",`${listed}.includes("edges.png")`,"the large image listed");
        await ev(`[...document.querySelectorAll("td.name a")].find(a=>a.textContent==="edges.png").click()`);
        const view=`document.querySelector("dialog.preview .image-view")`;
        await waitFor(`!!${view} && !document.querySelector("dialog.preview button.edit").hidden`,"the large image shown");
        await ev(`document.querySelector("dialog.preview button.edit").click()`);
        const click=cls=>ev(`${view}.querySelector(${JSON.stringify(cls)}).click()`);
        await waitFor(`!!${view}.querySelector(".image-inpaint-start")`,"the large image editable");
        await click(".image-inpaint-start"); await click(".image-inpaint-select");
        const lowerRight = async () => {
            const r=await ev(`(() => { const c=${view}.querySelector("canvas.image-content").getBoundingClientRect(), s=${view}.querySelector(".image-stage").getBoundingClientRect(); return {right:Math.min(c.right,s.right)-1.5,bottom:Math.min(c.bottom,s.bottom)-1.5}; })()`);
            const at=(type,x,y,down)=>checks.cdp("Input.dispatchMouseEvent",{type,x,y,button:"left",buttons:down?1:0,clickCount:1});
            await at("mousePressed",r.right-60,r.bottom-60,true);
            await at("mouseMoved",r.right-12,r.bottom-12,true);
            // The release point must also update the endpoint, even without another move.
            await at("mouseReleased",r.right,r.bottom,false);
            const rect=await ev(`(() => {const r=${view}.querySelector(".image-inpaint-overlay mask rect:last-child");return ["x","y","width","height"].map(k=>Number(r.getAttribute(k)));})()`);
            if(rect[0]+rect[2]!==2400||rect[1]+rect[3]!==1600)throw new Error(`lower-right pixels were missed: ${rect}`);
            // Render the SVG too: correct mark coordinates alone don't prove
            // the mask's clipping region lets the yellow highlight reach them.
            const alpha=await ev(`(async () => {
                const svg=${view}.querySelector(".image-inpaint-overlay").cloneNode(true);
                svg.removeAttribute("style"); svg.setAttribute("width",2400); svg.setAttribute("height",1600);
                const url=URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)],{type:"image/svg+xml"}));
                try {
                    const image=new Image(); image.src=url; await image.decode();
                    const canvas=Object.assign(document.createElement("canvas"),{width:2400,height:1600});
                    const ctx=canvas.getContext("2d"); ctx.drawImage(image,0,0);
                    return ctx.getImageData(2399,1599,1,1).data[3];
                } finally { URL.revokeObjectURL(url); }
            })()`);
            if(alpha<120)throw new Error(`the yellow mask highlight clips the lower-right corner: alpha=${alpha}`);
        };
        await lowerRight();
        await click(".image-inpaint-reset"); await click(".image-zoom-in"); await click(".image-inpaint-pan");
        const box=await ev(`(() => {const r=${view}.querySelector(".image-stage").getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};})()`);
        await checks.cdp("Input.dispatchMouseEvent",{type:"mousePressed",x:box.x+box.w/2,y:box.y+box.h/2,button:"left",buttons:1,clickCount:1});
        await checks.cdp("Input.dispatchMouseEvent",{type:"mouseMoved",x:box.x+8,y:box.y+8,button:"left",buttons:1});
        await checks.cdp("Input.dispatchMouseEvent",{type:"mouseReleased",x:box.x+8,y:box.y+8,button:"left",buttons:0,clickCount:1});
        await click(".image-inpaint-select"); await lowerRight();
        await click(".image-inpaint-cancel");
        await ev(`document.querySelector("dialog.preview button.done-edit").click();document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`,"the large image closed");
        execFileSync("docker",["exec",container,"rm","/home/user/Downloads/media/edges.png"]);
        await open("fs/#/",`document.title==="Downloads /"&&!!document.querySelector("table")`,"the listing");
    });

    await step("files: magic select (MobileSAM) marks an object at a click, takes it out with Shift, marks one in a box, keeps objects in background removal, and inpaints", async () => {
        // A red disc and a blue square, on a busy striped ground.
        writeFileSync(`${work}/magic.png`, png(320, 240, (x,y) => Math.hypot(x-110,y-120) < 40 ? [220,30,30,255]
            : x >= 230 && x < 280 && y >= 40 && y < 90 ? [30,60,220,255]
            : ((x >> 3) + (y >> 3)) % 2 ? [200,190,150,255] : [120,150,110,255]));
        execFileSync("docker", ["cp", "-q", `${work}/magic.png`, `${container}:/home/user/Downloads/media/magic.png`]);
        execFileSync("docker", ["exec", container, "chown", "user", "/home/user/Downloads/media/magic.png"]);
        await open("fs/#/media/", `${listed}.includes("magic.png")`, "the magic select picture listed");
        await ev(`[...document.querySelectorAll("td.name a")].find(a => a.textContent === "magic.png").click()`);
        await waitFor(`!!document.querySelector("dialog.preview .image-view") && !document.querySelector("dialog.preview button.edit").hidden`, "the picture shown");
        // Magic select's workers, counted as they're made and stopped.
        await ev(`(() => {
            window.segmentWorkers = { made: 0, stopped: 0 };
            const Original = window.Worker;
            window.Worker = class extends Original {
                constructor(url, ...args) { super(url, ...args); this.segment = String(url).includes("image-segment-worker.js"); if (this.segment) window.segmentWorkers.made++; }
                terminate() { if (this.segment) window.segmentWorkers.stopped++; return super.terminate(); }
            };
        })()`);
        await ev(`document.querySelector("dialog.preview button.edit").click()`);
        const view = `document.querySelector("dialog.preview .image-view")`;
        const click = (cls) => ev(`${view}.querySelector(${JSON.stringify(cls)}).click()`);
        await waitFor(`!!${view}.querySelector("canvas.image-content")`, "the picture loaded");
        const pointer = async (from, to = from, modifiers = 0) => {
            const r = await ev(`(() => { const c = ${view}.querySelector("canvas.image-content"), r = c.getBoundingClientRect(); return {x:r.x,y:r.y,sx:r.width/c.width,sy:r.height/c.height}; })()`);
            const at = (type, [x,y], down) => checks.cdp("Input.dispatchMouseEvent", { type, x:r.x+x*r.sx, y:r.y+y*r.sy, button:"left", buttons:down?1:0, clickCount:1, modifiers });
            await at("mousePressed", from, true);
            if (to !== from) for (let i = 1; i <= 4; i++) await at("mouseMoved", [from[0]+(to[0]-from[0])*i/4, from[1]+(to[1]-from[1])*i/4], true);
            await at("mouseReleased", to, false);
        };
        // What's marked, as the overlay shows it: its alpha at points.
        const marked = (points) => ev(`(async () => {
            const svg=${view}.querySelector(".image-inpaint-overlay").cloneNode(true);
            svg.removeAttribute("style"); svg.setAttribute("width",320); svg.setAttribute("height",240);
            const url=URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)],{type:"image/svg+xml"}));
            try { const image=new Image(); image.src=url; await image.decode();
                const c=Object.assign(document.createElement("canvas"),{width:320,height:240}),ctx=c.getContext("2d");ctx.drawImage(image,0,0);
                return ${JSON.stringify(points)}.map(([x,y])=>ctx.getImageData(x,y,1,1).data[3]>0);
            } finally {URL.revokeObjectURL(url);}
        })()`);
        const note = () => ev(`${view}.querySelector(".image-inpaint-note").textContent`);
        const marks = () => ev(`${view}.querySelectorAll(".image-inpaint-overlay mask > :not(:first-child)").length`);
        await click(".image-inpaint-start");
        // Inpainting starts with Select area, a rectangle.
        if (await ev(`${view}.querySelector(".image-inpaint-select").getAttribute("aria-pressed")`) !== "true" || await ev(`${view}.querySelector(".image-inpaint-shape-rectangle").getAttribute("aria-checked")`) !== "true") throw new Error("inpainting doesn't start with a rectangle selected");
        // Magic select is a selection shape, as Rectangle and Circle are.
        await checks.click(`${view}.querySelector(".image-inpaint-shape-toggle")`);
        await waitFor(`${view}.querySelector(".image-inpaint-shape-options").matches(":popover-open")`, "the selection shapes");
        await checks.click(`${view}.querySelector(".image-inpaint-shape-object")`);
        if (await ev(`${view}.querySelector(".image-inpaint-select").getAttribute("aria-pressed")`) !== "true" || await ev(`${view}.querySelector(".image-inpaint-shape-object").getAttribute("aria-checked")`) !== "true"
            || !(await ev(`${view}.querySelector(".image-inpaint-select").title.startsWith("Select area: Object")`))) throw new Error("magic select isn't the chosen selection shape");
        await waitFor(`${view}.querySelector(".image-inpaint-note").textContent.startsWith("Click an object")||${view}.querySelector(".image-inpaint-note.error")`, "the picture analysed", 180000);
        if (await ev(`!!${view}.querySelector(".image-inpaint-note.error")`)) throw new Error(`analysis: ${await note()}`);
        // A click on the disc marks it, all of it, and nothing else.
        await pointer([110,120]);
        await waitFor(`${view}.querySelectorAll(".image-inpaint-overlay mask > :not(:first-child)").length===1||${view}.querySelector(".image-inpaint-note.error")`, "the disc selected", 60000);
        if (await marks() !== 1) throw new Error(`click: ${await note()}`);
        let seen = await marked([[110,120],[140,120],[110,92],[20,20],[255,65],[300,220]]);
        if (JSON.stringify(seen) !== "[true,true,true,false,false,false]") throw new Error(`the disc's selection: ${seen}`);
        if (process.env.MAGIC_SCREENSHOT) { const shot = await checks.cdp("Page.captureScreenshot", { format: "png" }); writeFileSync(process.env.MAGIC_SCREENSHOT, Buffer.from(shot.data, "base64")); }
        // Shift-click takes it out again.
        await pointer([110,120], [110,120], 8);
        await waitFor(`${view}.querySelectorAll(".image-inpaint-overlay mask > :not(:first-child)").length===2||${view}.querySelector(".image-inpaint-note.error")`, "the disc taken out", 60000);
        seen = await marked([[110,120],[140,120]]);
        if (JSON.stringify(seen) !== "[false,false]") throw new Error(`Shift-click didn't take the disc out: ${seen}`);
        await click(".image-inpaint-undo"); await click(".image-inpaint-undo");
        // Every object at once: the disc and the square, not the ground.
        if (!(await ev(`${view}.querySelector(".image-inpaint-magic-all").checkVisibility()`))) throw new Error("Mark all objects isn't shown with magic select");
        await click(".image-inpaint-magic-all");
        await waitFor(`${view}.querySelector(".image-inpaint-note").textContent.startsWith("Marked")||${view}.querySelector(".image-inpaint-note").textContent.startsWith("No objects")||${view}.querySelector(".image-inpaint-note.error")`, "every object found", 180000);
        if (!(await note()).startsWith("Marked")) throw new Error(`mark all objects: ${await note()}`);
        seen = await marked([[110,120],[255,65],[20,20],[300,220],[200,200]]);
        if (JSON.stringify(seen) !== "[true,true,false,false,false]") throw new Error(`all objects: ${seen} (${await note()})`);
        await click(".image-inpaint-undo");
        await click(".image-inpaint-paint");
        if (await ev(`${view}.querySelector(".image-inpaint-magic-all").checkVisibility()`)) throw new Error("Mark all objects is shown without magic select");
        await click(".image-inpaint-shape-object");
        // A box round the square marks it.
        await pointer([222,32], [288,98]);
        await waitFor(`${view}.querySelectorAll(".image-inpaint-overlay mask > :not(:first-child)").length===1||${view}.querySelector(".image-inpaint-note.error")`, "the square selected", 60000);
        seen = await marked([[255,65],[233,43],[110,120],[20,20]]);
        if (JSON.stringify(seen) !== "[true,true,false,false]") throw new Error(`the square's selection: ${seen}`);
        if (await ev(`${view}.querySelector(".image-inpaint-magic-box").getAttribute("visibility")`) !== "hidden") throw new Error("the box stays drawn");
        await click(".image-inpaint-cancel");
        // Background removal: the disc picked is what's kept, then the square too, in a box; Undo drops the square.
        await click(".image-remove-background");
        const ready = `!${view}.querySelector(".image-background-spatial").hidden && !${view}.querySelector(".image-background-spatial-apply").disabled`;
        await waitFor(`${ready} || ${view}.querySelector(".image-background-note.error")`, "U2NetP preview finishes", 120000);
        if (!(await ev(ready))) throw new Error(await ev(`${view}.querySelector(".image-background-note").textContent`));
        const hint = () => ev(`${view}.querySelector(".image-background-spatial-hint").textContent`);
        const alphas = (points) => ev(`(() => { const ctx=${view}.querySelector("canvas.image-content").getContext("2d"); return ${JSON.stringify(points)}.map(([x,y])=>ctx.getImageData(x,y,1,1).data[3]); })()`);
        // Background removal starts with Select area, a rectangle: none drawn, the whole image.
        if (await ev(`${view}.querySelector(".image-background-mode-select").getAttribute("aria-pressed")`) !== "true" || await ev(`${view}.querySelector(".image-background-shape-rectangle").getAttribute("aria-checked")`) !== "true"
            || !(await hint()).startsWith("Background removal affects the whole image")) throw new Error(`background removal doesn't start with a rectangle selected: ${await hint()}`);
        // Object, magic select, is a selection shape here too: it picks what's kept, limiting nothing.
        await checks.click(`${view}.querySelector(".image-background-shape-toggle")`);
        await waitFor(`${view}.querySelector(".image-background-shape-options").matches(":popover-open")`, "the background selection shapes");
        await checks.click(`${view}.querySelector(".image-background-shape-object")`);
        // While it analyses, the shape can't be changed under it.
        if (!(await ev(`!${view}.querySelector(".image-background-spatial-hint").textContent.startsWith("Analysing") || ${view}.querySelector(".image-background-shape-toggle").disabled`))) throw new Error("the selection shape can be changed while magic select is busy");
        if (await ev(`${view}.querySelector(".image-background-mode-select").getAttribute("aria-pressed")`) !== "true" || !(await ev(`${view}.querySelector(".image-background-magic-all").checkVisibility()`))
            || await ev(`${view}.querySelector(".image-background-spatial-apply").disabled`)) throw new Error("Object isn't the chosen selection shape, or it stops Apply");
        await waitFor(`${view}.querySelector(".image-background-spatial-hint").textContent.startsWith("Click an object to remove it")||${view}.querySelector(".image-background-spatial-hint.error")`, "the picture analysed for keeping", 180000);
        if (await ev(`!!${view}.querySelector(".image-background-spatial-hint.error")`)) throw new Error(`analysis: ${await hint()}`);
        // Clicked, the disc is removed from what U2NetP kept: the square stays.
        if (!(await ev(`${view}.querySelector(".image-background-mode-select").title.includes("click an object to remove it")`))) throw new Error("Object's title doesn't say a click removes");
        const editStatus = () => ev(`document.querySelector("dialog.preview .edit-status").textContent`);
        const said = (text, what) => waitFor(`document.querySelector("dialog.preview .edit-status").textContent.startsWith(${JSON.stringify(text)})||${view}.querySelector(".image-background-spatial-hint.error")`, what, 180000)
            .then(async () => { if (!(await editStatus()).startsWith(text)) throw new Error(`${what}: ${await editStatus()} ${await hint()}`); });
        const sayNothing = () => ev(`document.querySelector("dialog.preview .edit-status").textContent=""`);
        const found = await alphas([[110,120],[255,65],[20,20]]);
        await sayNothing(); await pointer([110,120]);
        await said("Object removed", "the disc removed from the cutout");
        let a = await alphas([[110,120],[255,65]]);
        if (!(a[0] < 30 && Math.abs(a[1] - found[1]) < 10)) throw new Error(`removing the disc from U2NetP's cutout: ${found} → ${a}`);
        // Shift-clicked, it's added back, and nothing else changes.
        await sayNothing(); await pointer([110,120], [110,120], 8);
        await said("Object added back", "the disc added back");
        a = await alphas([[110,120],[140,120],[255,65],[20,20]]);
        if (!(a[0] > 200 && a[1] > 200 && Math.abs(a[2] - found[1]) < 10 && Math.abs(a[3] - found[2]) < 10)) throw new Error(`adding the disc back: ${found} → ${a}`);
        // Undone: removed again; and again: as U2NetP left it.
        await click(".image-background-undo-stroke");
        a = await alphas([[110,120]]);
        if (!(a[0] < 30)) throw new Error(`Undo didn't take back the adding: ${a}`);
        await click(".image-background-undo-stroke");
        // A box removes the square.
        await sayNothing(); await pointer([222,32], [288,98]);
        await said("Object removed", "the square removed");
        a = await alphas([[255,65],[233,43]]);
        if (!(a[0] < 30 && a[1] < 30)) throw new Error(`removing the square: ${a}`);
        if (!(await ev(`${view}.querySelector(".image-background-magic-box").hidden`))) throw new Error("the box stays drawn");
        await click(".image-background-undo-stroke");
        // Every object kept, in place of the cutout; then the square clicked away.
        await sayNothing(); await click(".image-background-magic-all");
        await said("Kept", "every object kept");
        a = await alphas([[110,120],[255,65],[20,20],[200,200]]);
        if (!(a[0] > 200 && a[1] > 200 && a[2] < 30 && a[3] < 30)) throw new Error(`keeping all objects: ${a} ${await hint()}`);
        await sayNothing(); await pointer([255,65]);
        await said("Object removed", "the square removed from the objects kept");
        await click(".image-background-spatial-apply");
        await waitFor(`${view}.querySelector(".edit-status").textContent.startsWith("Background removed")`, "the background removed");
        a = await alphas([[110,120],[255,65],[20,20]]);
        if (!(a[0] > 200 && a[1] < 30 && a[2] < 30)) throw new Error(`applied: ${a}`);
        await click(".image-undo");
        // The paint bucket, kept within the disc: any colour (tolerance 100) at its middle.
        await click(".image-draw-start");
        await click(".image-draw-bucket");
        await ev(`(t=>{t.value="100";t.dispatchEvent(new Event("input"));})(${view}.querySelector(".image-draw-tolerance"))`);
        await ev(`(c=>{c.value="#00ff00";c.dispatchEvent(new Event("input"));})(${view}.querySelector(".image-draw-color"))`);
        await click(".image-draw-select-object");
        const drawNote = () => ev(`${view}.querySelector(".image-draw-note").textContent`);
        await waitFor(`${view}.querySelector(".image-draw-note").textContent.startsWith("Click to fill an area of a colour; drag a box round an object")||${view}.querySelector(".image-draw-note.error")`, "the picture analysed for the bucket", 180000);
        await pointer([110,120], [110,120], 8);
        await waitFor(`${view}.querySelector(".image-draw-selection.object")&&!${view}.querySelector(".image-draw-selection").hidden||${view}.querySelector(".image-draw-note.error")`, "the disc as the bucket's selection", 60000);
        if (!(await ev(`!!${view}.querySelector(".image-draw-selection.object")`))) throw new Error(`bucket selection: ${await drawNote()}`);
        await pointer([110,120]);
        await waitFor(`!${view}.querySelector(".image-draw-filled").hidden && !${view}.querySelector(".image-draw-apply").disabled`, "the fill within the disc previewed");
        const filled = await ev(`(()=>{const ctx=${view}.querySelector(".image-draw-filled").getContext("2d");return [[110,120],[140,120],[20,20],[255,65],[160,120]].map(([x,y])=>[...ctx.getImageData(x,y,1,1).data].slice(0,3).join(","));})()`);
        if (filled[0] !== "0,255,0" || filled[1] !== "0,255,0" || filled[2] === "0,255,0" || filled[3] === "0,255,0" || filled[4] === "0,255,0") throw new Error(`the fill went past the disc: ${filled}`);
        await click(".image-draw-cancel");
        // Cropping to the disc, then to every object.
        await click(".image-crop-start");
        await click(".image-crop-magic");
        await waitFor(`document.querySelector("dialog.preview .edit-status").textContent.startsWith("Click an object to crop")||document.querySelector("dialog.preview .edit-status.error")`, "the picture analysed for cropping", 180000);
        const status = () => ev(`document.querySelector("dialog.preview .edit-status").textContent`);
        const cropSize = () => ev(`${view}.querySelector(".image-crop").dataset.size`);
        await pointer([110,120]);
        await waitFor(`document.querySelector("dialog.preview .edit-status").textContent.startsWith("Cropped to the object")||document.querySelector("dialog.preview .edit-status.error")`, "the crop to the disc", 60000);
        const [cw, ch] = (await cropSize()).split("×").map(Number);
        if (Math.abs(cw - 80) > 6 || Math.abs(ch - 80) > 6) throw new Error(`the crop to the disc: ${await cropSize()} ${await status()}`);
        await click(".image-crop-magic-all");
        await waitFor(`/^(Cropped to \\d+ objects?|No objects)/.test(document.querySelector("dialog.preview .edit-status").textContent)||document.querySelector("dialog.preview .edit-status.error")`, "the crop to every object", 180000)
            .catch(async (e) => { throw new Error(`${e.message}: ${await status()}`); });
        const [aw, ah] = (await cropSize()).split("×").map(Number);
        if (Math.abs(aw - 210) > 8 || Math.abs(ah - 120) > 8) throw new Error(`the crop to every object: ${await cropSize()} ${await status()}`);
        await click(".image-crop-cancel");
        await click(".image-inpaint-start");
        await click(".image-inpaint-shape-object");
        await waitFor(`${view}.querySelector(".image-inpaint-note").textContent.startsWith("Click an object")||${view}.querySelector(".image-inpaint-note.error")`, "the picture analysed again", 180000);
        await pointer([222,32], [288,98]);
        await waitFor(`${view}.querySelectorAll(".image-inpaint-overlay mask > :not(:first-child)").length===1||${view}.querySelector(".image-inpaint-note.error")`, "the square selected again", 60000);
        // And it's inpainted away.
        await click(".image-inpaint-run");
        await waitFor(`!${view}.querySelector(".image-inpaint-apply").disabled || ${view}.querySelector(".image-inpaint-note.error")`, "MI-GAN inference finishes", 120000);
        if (await ev(`${view}.querySelector(".image-inpaint-apply").disabled`)) throw new Error(await note());
        await click(".image-inpaint-apply");
        await waitFor(`${view}.querySelector(".edit-status").textContent.startsWith("Inpainting applied")`, "the square removed");
        const centre = await ev(`[...${view}.querySelector("canvas.image-content").getContext("2d").getImageData(255,65,1,1).data]`);
        if (centre[2] > 150 && centre[0] < 80) throw new Error(`the square is still there: ${centre}`);
        await ev(`document.querySelector("dialog.preview button.save-edit").click()`);
        await waitFor(`${view}.querySelector(".edit-status").textContent.startsWith("Saved:")`, "the inpainted picture saved");
        // Left mid-removal, with Object analysed: no magic select worker is left running.
        await click(".image-remove-background");
        await waitFor(`!${view}.querySelector(".image-background-spatial-apply").disabled || ${view}.querySelector(".image-background-note.error")`, "U2NetP again", 120000);
        await click(".image-background-mode-select"); await click(".image-background-shape-object");
        await waitFor(`${view}.querySelector(".image-background-spatial-hint").textContent.startsWith("Click an object")||${view}.querySelector(".image-background-spatial-hint.error")`, "the picture analysed again", 180000);
        await ev(`document.querySelector("dialog.preview button.done-edit").click(); document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`, "the picture closed");
        const workers = await ev("window.segmentWorkers");
        if (!(workers.made >= 1 && workers.stopped === workers.made)) throw new Error(`magic select workers left running: ${JSON.stringify(workers)}`);
        execFileSync("docker", ["exec", container, "rm", "/home/user/Downloads/media/magic.png"]);
        await open("fs/#/", `document.title === "Downloads /" && !!document.querySelector("table")`, "the listing");
        return "the disc at a click, out with Shift-click, the square in a box; all objects marked; in background removal the disc removed and added back, undone, the square removed in a box, all objects kept and one removed, applied; the bucket kept within the disc; cropped to the disc and to every object; the square inpainted";
    });
    await step("files: scan a photographed page with perspective correction, paper whitening, undo and save", async () => {
        const corners = [[30,20],[280,40],[270,380],[15,360]];
        const inside = (x,y) => corners.every((a,i) => {const b=corners[(i+1)%4];return (b[0]-a[0])*(y-a[1])-(b[1]-a[1])*(x-a[0])>=0;});
        writeFileSync(`${work}/scan.png`,png(300,400,(x,y)=>{
            if(!inside(x,y))return [25,95,40,255];
            if(x>55&&x<240&&y>80&&y<320&&y%30<3)return [25,25,25,255];
            const shade=165+Math.round(40*x/300);return [shade+15,shade+5,shade-10,255];
        }));
        execFileSync("docker",["cp","-q",`${work}/scan.png`,`${container}:/home/user/Downloads/media/scan.png`]);
        execFileSync("docker",["exec",container,"chown","user","/home/user/Downloads/media/scan.png"]);
        await open("fs/#/media/",`${listed}.includes("scan.png")`,"the scan fixture");
        const view=`document.querySelector("dialog.preview .image-view")`;
        // Use the shared listing helper: its row selector also handles escaped names.
        const listedRow=checks.row("scan.png");
        await ev(`${listedRow}.querySelector("summary").click();[...${listedRow}.querySelectorAll("button")].find(b=>b.textContent==="Preview").click()`);
        await waitFor(`document.querySelector("dialog.preview button.edit")&&!document.querySelector("dialog.preview button.edit").hidden`,"the page editable");
        await ev(`document.querySelector("dialog.preview button.edit").click()`);
        const click=cls=>ev(`${view}.querySelector(${JSON.stringify(cls)}).click()`);
        // Until editing has loaded the picture, it's an <img>, not a canvas.
        const dimensions=`(()=>{const c=${view}.querySelector("canvas.image-content");return c?c.width+"x"+c.height:"";})()`;
        await waitFor(`${dimensions}==="300x400"`,"the photo loaded");
        await click(".image-scan-start");
        await waitFor(`!${view}.querySelector(".image-scan-tools").hidden&&${view}.querySelectorAll(".image-scan-corner:not([hidden])").length===8`,"four corners and four fold points");
        const moveCorner=async(i,point,curve=false)=>{
            const points=await ev(`(()=>{const b=${view}.querySelectorAll(${JSON.stringify(curve ? ".image-scan-curve-point" : ".image-scan-corner")})[${i}].getBoundingClientRect(),c=${view}.querySelector("canvas.image-content"),r=c.getBoundingClientRect();return [{x:b.x+b.width/2,y:b.y+b.height/2},{x:r.x+${point[0]}*r.width/c.width,y:r.y+${point[1]}*r.height/c.height}];})()`);
            for(const [type,at] of [["mousePressed",points[0]],["mouseMoved",points[1]],["mouseReleased",points[1]]])await checks.cdp("Input.dispatchMouseEvent",{type,...at,button:"left",buttons:type==="mouseReleased"?0:1,clickCount:1});
        };
        await moveCorner(0, [-12, 20]);
        await waitFor(`${view}.querySelector(".image-scan-corner").classList.contains("outside") && ${view}.querySelector(".image-scan-corner").getAttribute("aria-invalid") === "true" && ${view}.querySelector(".image-scan-apply").disabled`, "outside corner marked invalid");
        const invalidColor = await ev(`getComputedStyle(${view}.querySelector(".image-scan-corner")).backgroundColor`);
        if (invalidColor !== "rgb(165, 29, 37)") throw new Error(`the outside corner is not red: ${invalidColor}`);
        for(let i=0;i<4;i++)await moveCorner(i,corners[i]);
        if (await ev(`${view}.querySelector(".image-scan-corner").classList.contains("outside")`)) throw new Error("the repaired corner stays red");
        // Fold points follow the corners: a third and two thirds down each side.
        const foldAt=await ev(`(()=>{const c=${view}.querySelector("canvas.image-content"),r=c.getBoundingClientRect(),b=${view}.querySelectorAll(".image-scan-corner")[4].getBoundingClientRect();return [(b.x+b.width/2-r.x)*c.width/r.width,(b.y+b.height/2-r.y)*c.height/r.height];})()`);
        if(Math.abs(foldAt[0]-25)>4||Math.abs(foldAt[1]-133)>4)throw new Error(`the upper left fold point didn't follow the corners: ${foldAt}`);
        await click(".image-scan-preview");
        await waitFor(`!${view}.querySelector(".image-scan-result").hidden`,"the flattened page preview");
        const previewPixels=await ev(`(()=>{const c=${view}.querySelector(".image-scan-result"),d=c.getContext("2d").getImageData(0,0,c.width,c.height).data;let gray=true,light=0,dark=0;for(let i=0;i<d.length;i+=4){gray&&=d[i]===d[i+1]&&d[i+1]===d[i+2];light+=d[i]>225;dark+=d[i]<60;}return {width:c.width,height:c.height,gray,light,dark};})()`);
        if(Math.abs(previewPixels.width-253)>2||Math.abs(previewPixels.height-340)>2||!previewPixels.gray||previewPixels.light<50000||previewPixels.dark<1000)throw new Error(`scan preview: ${JSON.stringify(previewPixels)}`);
        await click(".image-scan-settings");
        await waitFor(`${view}.querySelector(".image-scan-options").matches(":popover-open")`,"scan adjustments popover");
        await ev(`(()=>{const m=${view}.querySelector(".image-scan-mode");m.value="bw";m.dispatchEvent(new Event("input"));})()`);
        await waitFor(`!${view}.querySelector(".image-scan-result").hidden&&(()=>{const c=${view}.querySelector(".image-scan-result"),d=c.getContext("2d").getImageData(0,0,c.width,c.height).data;return d.every((v,i)=>i%4===3||v===0||v===255);})()`,"black-and-white finish");
        await ev(`(()=>{const m=${view}.querySelector(".image-scan-mode");m.value="gray";m.dispatchEvent(new Event("input"));})()`);
        await click(".image-scan-corners");
        await moveCorner(0,[295,350]);
        await waitFor(`${view}.querySelector(".image-scan-apply").disabled`,"crossed outline rejected");
        await moveCorner(0,corners[0]);
        await waitFor(`!${view}.querySelector(".image-scan-apply").disabled`,"outline repaired");
        await click(".image-scan-apply");
        await waitFor(`${dimensions}!=="300x400"&&${view}.querySelector(".image-scan-tools").hidden`,"scan applied");
        const scanned=await ev(dimensions);
        await click(".image-save-options-toggle");
        await ev(`(f=>{f.value="application/pdf";f.dispatchEvent(new Event("change"));})(${view}.querySelector(".image-format"))`);
        await ev(`document.querySelector("dialog.preview button.save-edit").click()`);
        await waitFor(`${view}.querySelector(".edit-status").textContent.startsWith("Saved a copy as scan.pdf")`,"scan saved as a PDF copy");
        const pdfSignature=inContainer("sh","-c","head -c 8 ~/Downloads/media/scan.pdf");
        if(!pdfSignature.startsWith("%PDF-1.7"))throw new Error("scan PDF signature missing");
        await click(".image-save-options-toggle");
        await ev(`(f=>{f.value="image/png";f.dispatchEvent(new Event("change"));})(${view}.querySelector(".image-format"))`);
        await click(".image-undo"); await waitFor(`${dimensions}==="300x400"`,"scan undone to the original photo");
        await click(".image-redo"); await waitFor(`${dimensions}===${JSON.stringify(scanned)}`,"scan redone");
        // A folded paper: its fold points dragged onto the folds, then cancelled.
        await click(".image-scan-start");
        await waitFor(`${view}.querySelectorAll(".image-scan-corner:not([hidden])").length===8`,"eight points again");
        await click(".image-scan-preview");
        await waitFor(`!${view}.querySelector(".image-scan-result").hidden`, "the baseline eight-point preview");
        const foldPreviewSize = await ev(`(() => { const c = ${view}.querySelector(".image-scan-result"); return [c.width, c.height].join("x"); })()`);
        await click(".image-scan-corners");
        const outline=()=>ev(`[${view}.querySelector(".image-scan-outline polygon").getAttribute("points"),${view}.querySelector(".image-scan-fold-lines").getAttribute("d")]`);
        const [before,lines]=await outline();
        if(before.split(" ").length<8||(lines.match(/M/g)??[]).length!==2)throw new Error(`the outline doesn't run through the guide points: ${before} ${lines}`);
        if(!(await ev(`${view}.querySelectorAll(".image-scan-corner")[4].getAttribute("aria-label")==="Upper guide, left side"`)))throw new Error("guide point unlabelled");
        const scannedSize=scanned.split("x").map(Number);
        await moveCorner(4,[30,scannedSize[1]/3]); await moveCorner(5,[scannedSize[0]-30,scannedSize[1]/3]);
        const [after,foldedLines]=await outline();
        if(after===before||foldedLines===lines)throw new Error("dragging the fold points didn't move the fold");
        if(await ev(`${view}.querySelector(".image-scan-apply").disabled`))throw new Error("a fold drawn in was refused");
        await click(".image-scan-preview");
        await waitFor(`!${view}.querySelector(".image-scan-result").hidden`, "the moved-fold preview");
        const movedPreviewSize = await ev(`(() => { const c = ${view}.querySelector(".image-scan-result"); return [c.width, c.height].join("x"); })()`);
        if (movedPreviewSize !== foldPreviewSize) throw new Error(`moving fold handles changed the page dimensions: ${foldPreviewSize} to ${movedPreviewSize}`);
        const previewHash = () => ev(`(() => {const c=${view}.querySelector(".image-scan-result"),d=c.getContext("2d").getImageData(0,0,c.width,c.height).data;let hash=0;for(const v of d)hash=(Math.imul(hash,33)+v)>>>0;return hash;})()`);
        const straightHash = await previewHash();
        await click(".image-scan-corners");
        await waitFor(`${view}.querySelectorAll(".image-scan-curve-point:not([hidden])").length===2`, "two curvature diamonds");
        const bendPoint = [scannedSize[0] / 2, scannedSize[1] * .43];
        await moveCorner(0, [-12, bendPoint[1]], true);
        await waitFor(`${view}.querySelector(".image-scan-curve-point").classList.contains("outside") && ${view}.querySelector(".image-scan-apply").disabled`, "outside curvature diamond marked invalid");
        await moveCorner(0, bendPoint, true);
        if (await ev(`${view}.querySelector(".image-scan-curve-point").classList.contains("outside")`)) throw new Error("the repaired diamond stays red");
        if (await ev(`${view}.querySelector(".image-scan-apply").disabled`)) throw new Error("a gently bowed guide was refused");
        const bentLines = (await outline())[1];
        if (bentLines === foldedLines) throw new Error("curvature diamond did not bend its guide");
        await click(".image-scan-preview");
        await waitFor(`!${view}.querySelector(".image-scan-result").hidden`, "curved guide scan preview");
        if (await previewHash() === straightHash) throw new Error("the bowed guide did not affect scanned pixels");
        await click(".image-scan-corners");
        await moveCorner(0, [scannedSize[0] / 2, scannedSize[1] * .9], true);
        await waitFor(`${view}.querySelector(".image-scan-apply").disabled`, "crossing curves rejected before Apply");
        await moveCorner(0, bendPoint, true);
        await waitFor(`!${view}.querySelector(".image-scan-apply").disabled`, "curvature repaired");
        const enter = async selector => {
            await ev(`${view}.querySelector(${JSON.stringify(selector)}).focus()`);
            await checks.press("Enter");
        };
        await enter(".image-scan-surface-toggle");
        await waitFor(`${view}.querySelector(".image-scan-surface-options").matches(":popover-open") && !${view}.querySelector(".image-scan-tools").hidden`, "Enter opens paper-shape choices without applying the scan");
        await enter(".image-scan-surface-crease");
        if (await ev(`${view}.querySelectorAll(".image-scan-curve-point:not([hidden])").length`)) throw new Error("curve handles remain in sharp-fold mode");
        await click(".image-scan-surface-toggle");
        await click(".image-scan-surface-smooth");
        if ((await outline())[1] !== bentLines) throw new Error("switching back to Curved paper lost the bend");
        await enter(".image-scan-preview");
        await waitFor(`!${view}.querySelector(".image-scan-result").hidden && !${view}.querySelector(".image-scan-tools").hidden`, "Enter previews without applying");
        await enter(".image-scan-corners");
        await waitFor(`${view}.querySelector(".image-scan-result").hidden && !${view}.querySelector(".image-scan-tools").hidden`, "Enter returns to corner adjustments");
        if (process.env.SCAN_SCREENSHOT) { const shot = await checks.cdp("Page.captureScreenshot", { format: "png" }); writeFileSync(process.env.SCAN_SCREENSHOT, Buffer.from(shot.data, "base64")); }
        await enter(".image-scan-cancel");
        if(await ev(dimensions)!==scanned)throw new Error("cancel changed the committed scan");
        await ev(`document.querySelector("dialog.preview button.save-edit").click()`);
        await waitFor(`${view}.querySelector(".edit-status").textContent.startsWith("Saved:")`,"scanned PNG saved");
        await ev(`document.querySelector("dialog.preview button.done-edit").click();document.querySelector("dialog.preview button.close").click()`);
        await waitFor(`!document.querySelector("dialog.preview")`,"scan closed");
        const signature=inContainer("sh","-c","od -An -tu1 -j16 -N8 ~/Downloads/media/scan.png");
        const pngSize=signature.trim().split(/\s+/).map(Number);
        const savedWidth=pngSize.slice(0,4).reduce((v,b)=>v*256+b,0),savedHeight=pngSize.slice(4).reduce((v,b)=>v*256+b,0);
        if(`${savedWidth}x${savedHeight}`!==scanned)throw new Error("saved scan dimensions differ from the preview");
        execFileSync("docker",["exec",container,"rm","/home/user/Downloads/media/scan.png","/home/user/Downloads/media/scan.pdf"]);
        await open("fs/#/",`document.title==="Downloads /"&&!!document.querySelector("table")`,"the listing");
        return "corners and curved side guides, bowed interior guides, sharp-fold mode, invalid curve guard, grayscale and paper cleanup, undo/redo, Cancel, PDF copy and PNG Save";
    });

}
