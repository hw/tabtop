// Cropping, in the image editor (see startEditing in image-view.js): a
// rectangle, in the picture's pixels, dragged over it; or, with magic
// select, the bounds of an object clicked (or boxed), or of every object
// found. Apply (Enter) makes it a change; Cancel (Escape) leaves it.
import { el } from "./preview-dom.js";
import { Segmenter, objectBounds } from "./image-segment.js";

// cropTool crops what the editor shows. toolbar: where its controls go;
// stage, the picture's; button, its own (opens and closes it); box, the
// rectangle shown over the stage; makeButton(icon, label, className), the
// editor's maker of its buttons. geometry() is {width, height, x, y,
// scale}: the picture's size, and where and how big it's shown; source(),
// the canvas shown (analysed for magic select). canOpen(), whether it may
// open now; say(text, error), the editor's status; apply(rect) makes the
// change; changed(), after anything its buttons show depends on changes.
// It returns active(), open(), close(), toggle(), commit() (Apply),
// recipe() (a recipe's pending step, or null: see editRecipe), sync({saving,
// removing}) (its buttons, enabled as they can be), place() (the rectangle
// put where the picture's shown), the stage's pointer's down(px, py)
// (true: it's the tool's), move(px, py), up(cancelled), painting(), and stop().
export function cropTool({ toolbar, stage, button, box, makeButton, geometry, source, canOpen, say, apply, changed }) {
    let cropping = false, crop = null, gesture = null;
    const toPicture = (px, py) => {
        const { width, height, x, y, scale } = geometry();
        return [Math.round(Math.max(0, Math.min(width, (px - x) / scale))), Math.round(Math.max(0, Math.min(height, (py - y) / scale)))];
    };
    function showCrop() {
        box.hidden = !cropping || !crop;
        if (box.hidden) return;
        const { x, y, scale } = geometry();
        Object.assign(box.style, { left: `${x + crop.x * scale}px`, top: `${y + crop.y * scale}px`,
            width: `${crop.width * scale}px`, height: `${crop.height * scale}px` });
        box.dataset.size = `${crop.width}×${crop.height}`;
    }
    button.setAttribute("aria-pressed", "false");
    const applyCrop = el("button", { type: "button", className: "image-crop-apply", textContent: "Apply", ariaLabel: "Apply crop", disabled: true });
    const cancelCrop = el("button", { type: "button", className: "image-crop-cancel", textContent: "Cancel" });
    const cropMagic = makeButton("magic-select", "Crop to an object: click it, or drag a box round it", "image-crop-magic");
    cropMagic.setAttribute("aria-pressed", "false");
    const cropAll = makeButton("magic-all", "Crop to all the objects magic select finds", "image-crop-magic-all");
    const cropTools = el("span", { className: "image-crop-tools", hidden: true }, el("span", { className: "image-magic-group" }, cropMagic, cropAll), applyCrop, cancelCrop);
    // Magic select, for cropping: the picture's analysed once (cropAnalysed:
    // the canvas it was), when the wand's first used.
    const cropSegmenter = new Segmenter();
    let cropMagicOn = false, cropAnalysed = null, cropBusy = false, cropToken = 0;
    const cropTask = async (doing, task) => {
        const token = ++cropToken, canvas = source();
        cropBusy = true; say(doing); changed();
        try {
            const current = () => cropping && token === cropToken;
            if (cropAnalysed !== canvas) {
                await cropSegmenter.analyse(canvas);
                if (!current()) return;
                cropAnalysed = canvas;
            }
            await task(current);
        } catch (err) {
            if (cropping && token === cropToken) say(err.message, true);
        } finally { if (token === cropToken) { cropBusy = false; changed(); } }
    };
    // cropTo crops to what mask selects, found as doing says.
    const cropTo = (mask, what) => {
        const { width, height } = geometry();
        const { width: w, height: h } = cropSegmenter.size, found = mask && objectBounds(mask, w, h, width, height);
        if (!found || found.width < 1 || found.height < 1) { say("Nothing found there. Try a box round the object."); return; }
        crop = found; showCrop(); changed();
        say(`Cropped to ${what}: Apply to keep it.`);
    };
    const pickCrop = (prompt) => cropTask("Finding the object…", async (current) => {
        const mask = await cropSegmenter.select(prompt);
        if (current()) cropTo(mask, "the object");
    });
    cropMagic.addEventListener("click", () => {
        if (!cropping || cropBusy) return;
        cropMagicOn = !cropMagicOn;
        cropMagic.setAttribute("aria-pressed", String(cropMagicOn));
        stage.classList.toggle("crop-magic", cropMagicOn);
        if (cropMagicOn) cropTask("Analysing the picture for magic select…", async () => say("Click an object to crop to it, or drag a box round it."));
        else say("");
        stage.focus({ preventScroll: true });
    });
    cropAll.addEventListener("click", () => {
        if (!cropping || cropBusy) return;
        cropTask("Finding every object… (this takes a while)", async (current) => {
            const { mask, count } = await cropSegmenter.findAll();
            if (!current()) return;
            if (!count) { say("No objects found. Click one with the wand, or drag a box round it."); return; }
            cropTo(mask, `${count} ${count === 1 ? "object" : "objects"}`);
        });
    });
    toolbar.append(cropTools);
    const setCropping = (on) => {
        if (on && !canOpen()) return;
        cropping = on;
        crop = null;
        gesture = null;
        if (!on) {
            cropToken++; cropBusy = cropMagicOn = false; cropAnalysed = null; cropSegmenter.cancel();
            cropMagic.setAttribute("aria-pressed", "false"); stage.classList.remove("crop-magic");
        }
        button.setAttribute("aria-pressed", String(on));
        cropTools.hidden = !on;
        stage.classList.toggle("cropping", on);
        showCrop();
        changed();
    };
    const commit = () => {
        if (applyCrop.disabled) return;
        const c = crop;
        setCropping(false);
        apply({ x: c.x, y: c.y, width: c.width, height: c.height });
    };
    button.addEventListener("click", () => setCropping(!cropping));
    cancelCrop.addEventListener("click", () => setCropping(false));
    applyCrop.addEventListener("click", commit);
    return {
        active: () => cropping,
        painting: () => cropping,
        open: () => setCropping(true),
        close: () => setCropping(false),
        toggle: () => setCropping(!cropping),
        commit,
        recipe: () => {
            if (applyCrop.disabled) return null;
            const { width, height } = geometry();
            return { kind: "crop", width, height, rect: { ...crop } };
        },
        sync({ saving, removing }) {
            applyCrop.disabled = saving || removing || cropBusy || !crop || crop.width < 1 || crop.height < 1;
            cropMagic.disabled = cropAll.disabled = saving || cropBusy;
        },
        place: showCrop,
        // Dragged: a rectangle drawn; with the wand, a box round an object
        // (shown as the crop is till it's found), or, not dragged, a click on one.
        down(px, py) {
            if (!cropping) return false;
            if (cropMagicOn) {
                gesture = { magic: true, at: [px, py], from: toPicture(px, py), previous: crop };
                return true;
            }
            gesture = { from: toPicture(px, py) };
            crop = { ...gesture.from, width: 0, height: 0 };
            showCrop();
            return true;
        },
        move(px, py) {
            if (!gesture) return false;
            if (gesture.magic) {
                gesture.dragged ||= Math.hypot(px - gesture.at[0], py - gesture.at[1]) >= 5;
                if (!gesture.dragged) return true;
            }
            const [cx, cy] = toPicture(px, py), [fx, fy] = gesture.from;
            crop = { x: Math.min(fx, cx), y: Math.min(fy, cy), width: Math.abs(cx - fx), height: Math.abs(cy - fy) };
            showCrop();
            if (!gesture.magic) changed();
            return true;
        },
        up(cancelled) {
            const g = gesture;
            gesture = null;
            if (!g?.magic) return;
            const rect = crop;
            if (g.dragged || cancelled) { crop = g.previous; showCrop(); }
            if (cancelled || cropBusy || cropAnalysed !== source()) return;
            if (!g.dragged) pickCrop({ point: g.from });
            else if (rect?.width >= 1 && rect?.height >= 1) pickCrop({ box: [rect.x, rect.y, rect.width, rect.height] });
        },
        stop() {
            setCropping(false);
            cropSegmenter.cancel();
        },
    };
}
