// Background removal, in the image editor (see startEditing in
// image-view.js): U2NetP's mask (image-background.js), adjusted by its
// sliders, kept to a selection, and brushed, filled or picked (magic
// select) where it's wrong, previewed over the picture until Apply.
import { el } from "./preview-dom.js";
import { imageMaskPoint, newMaskMark, extendMaskMark, glyphCaption, enclosedFill, brushControls } from "./image-mask.js";
import { Segmenter, selectionMark } from "./image-segment.js";
import { adjustedMask, mapImagePoint, objectMask } from "./image-background.js";

// backgroundTool makes it for the editor, ed: what of the editor's it
// uses, read (and, the background removal's own state the editor reads
// too, set: backgroundEdit, backgroundFrame, backgroundPointer, backgroundPreview, maskSerial, removing) as it's used. It returns its
// controls and what the editor calls of it.
export function backgroundTool(ed) {
    const removeBackground = ed.button("remove-background", "Remove background", "image-remove-background");
    removeBackground.setAttribute("aria-haspopup", "dialog");
    removeBackground.setAttribute("aria-expanded", "false");
    const backgroundPanel = el("div", { className: "mask-brush-options image-background-panel", role: "dialog", ariaLabel: "Background removal adjustments" });
    backgroundPanel.setAttribute("popover", "auto");
    const backgroundNote = el("p", { className: "hint image-background-note", role: "status" });
    const sliders = [
        ["threshold", "Threshold", 0, 100, 1, 50, "Higher removes more; lower keeps more."],
        ["softness", "Edge softness", 0, 100, 1, 100, "Higher blends the cutout edge; zero makes a hard cutoff."],
        ["grow", "Shrink / grow", -5, 5, .25, 0, "Negative shrinks the foreground; positive grows it."],
    ].map(([key, title, min, max, step, value, help]) => {
        const input = el("input", { type: "range", className: `image-background-${key}`, min, max, step, value, ariaLabel: title });
        const output = el("output", { className: "image-background-value" });
        const label = el("label", {}, el("span", { textContent: title }), input, output, el("small", { className: "hint", textContent: help }));
        return { key, input, output, label, initial: value };
    });
    const backgroundSettings = () => Object.fromEntries(sliders.map(({ key, input }) => [key, Number(input.value)]));
    backgroundPanel.append(...sliders.map(({ label }) => label), backgroundNote);
    ed.view.append(backgroundPanel);
    let backgroundMode = "pan", gesture = null;
    const selectionBox = el("div", { className: "image-background-selection", hidden: true, ariaHidden: "true" });
    // Magic select: the objects clicked are what's kept, in place of
    // U2NetP's foreground. The picture's analysed once, when it's chosen.
    const segmenter = new Segmenter();
    const magicBox = el("div", { className: "image-background-magic-box", hidden: true, ariaHidden: "true" });
    ed.stage.append(magicBox);
    let magicBusy = false, magicDoing = "";
    // Magic select: Select area, its shape an object.
    const magicMode = () => backgroundMode === "select" && brushes.shape.value === "object";
    const brushCursor = el("div", { className: "image-background-cursor", hidden: true, ariaHidden: "true" });
    ed.stage.append(selectionBox, brushCursor);
    const modes = [["pan", "Pan"], ["select", "Select area"], ["erase", "Erase"], ["restore", "Restore"], ["fill", "Flood fill enclosed area"]].map(([mode, title]) => {
        const icon = { pan: "pan", select: "select-area", erase: "paint-brush", restore: "restore", fill: "flood-fill" }[mode];
        const control = ed.button(icon, title, `image-background-mode-${mode}`);
        control.setAttribute("aria-pressed", "false");
        control.addEventListener("click", () => setBackgroundMode(mode));
        return { mode, title, control };
    });
    const invertSelection = ed.button("invert-selection", "Invert selection", "image-background-invert");
    invertSelection.setAttribute("aria-pressed", "false");
    const wholeImage = ed.button("select-all", "Apply removal to the whole image", "image-background-whole");
    const allObjects = ed.button("magic-all", "Keep all objects: only the objects magic select finds, in place of the cutout", "image-background-magic-all");
    const brushes = brushControls(modes.find(({ mode }) => mode === "erase").control, {
        prefix: "image-background", sizeClass: "image-background-brush-size", selectionButton: modes.find(({ mode }) => mode === "select").control, onShape: () => setBackgroundMode("select"),
        magic: "click an object to remove it, or drag a box round it; Shift-click adds one back",
    });
    const brushSize = brushes.size;
    const undoStroke = glyphCaption(ed.button("undo", "Undo stroke", "image-background-undo-stroke"), "Undo");
    const settingsButton = ed.button("save-options", "Background removal adjustments", "image-background-settings");
    const spatialApply = ed.button("check", "Apply background removal", "image-background-spatial-apply");
    const spatialCancel = ed.button("close-circle", "Cancel background removal", "image-background-spatial-cancel");
    const spatialHint = el("span", { className: "hint image-background-spatial-hint", role: "status" });
    const spatialBar = el("div", { className: "image-background-spatial", hidden: true },
        ...modes.flatMap(({ mode, control }) => mode === "erase" ? [brushes.group] : mode === "select" ? [brushes.selectionGroup, el("span", { className: "image-magic-group" }, allObjects)] : [control]), wholeImage,
        invertSelection, undoStroke,
        settingsButton, spatialApply, spatialCancel);
    ed.editBar.append(spatialBar);
    ed.hintBar.append(spatialHint);
    const maskPoint = (point, inverse = true) => mapImagePoint(point, ...ed.backgroundEdit.imageSize, ed.backgroundEdit.trailing, inverse);
    const imagePoint = (px, py) => [(px - ed.x) / ed.scale, (py - ed.y) / ed.scale];
    const insideImage = ([px, py]) => px >= 0 && py >= 0 && px <= ed.width && py <= ed.height;
    const rectOf = ([ax, ay], [bx, by]) => ({ x: Math.min(ax, bx), y: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) });
    const showSelection = () => {
        const selection = ed.backgroundEdit?.selection;
        selectionBox.hidden = !selection || !selection.width || !selection.height;
        if (selectionBox.hidden) return;
        const a = maskPoint([selection.x, selection.y], false);
        const b = maskPoint([selection.x + selection.width, selection.y + selection.height], false);
        const rect = rectOf(a, b);
        const left = Math.max(0, rect.x), top = Math.max(0, rect.y);
        const right = Math.min(ed.width, rect.x + rect.width), bottom = Math.min(ed.height, rect.y + rect.height);
        selectionBox.hidden = right <= left || bottom <= top;
        Object.assign(selectionBox.style, { left: `${ed.x + left * ed.scale}px`, top: `${ed.y + top * ed.scale}px`, width: `${(right - left) * ed.scale}px`, height: `${(bottom - top) * ed.scale}px` });
        selectionBox.style.borderRadius = selection.shape === "circle" ? "50%" : "0";
        selectionBox.style.clipPath = "none";
        if (selection.shape === "circle") {
            Object.assign(selectionBox.style, { left: `${ed.x + rect.x * ed.scale}px`, top: `${ed.y + rect.y * ed.scale}px`, width: `${rect.width * ed.scale}px`, height: `${rect.height * ed.scale}px`,
                clipPath: `inset(${Math.max(0, -rect.y) * ed.scale}px ${Math.max(0, rect.x + rect.width - ed.width) * ed.scale}px ${Math.max(0, rect.y + rect.height - ed.height) * ed.scale}px ${Math.max(0, -rect.x) * ed.scale}px)` });
        }
        selectionBox.dataset.size = `${Math.round(right - left)}×${Math.round(bottom - top)}${selection.inverted ? " (outside)" : ""}`;
    };
    const showSpatial = () => {
        spatialBar.hidden = !ed.backgroundEdit;
        spatialHint.hidden = !ed.backgroundEdit;
        for (const { mode, control } of modes) {
            control.disabled = !ed.backgroundEdit?.rawMask || ed.removing || magicBusy;
            control.setAttribute("aria-pressed", String(mode === backgroundMode));
        }
        wholeImage.disabled = !ed.backgroundEdit?.rawMask || ed.removing;
        allObjects.hidden = !magicMode();
        allObjects.disabled = !ed.backgroundEdit?.analysed || ed.removing || magicBusy;
        invertSelection.disabled = wholeImage.disabled || !ed.backgroundEdit?.selection || ed.backgroundEdit.selection.width < 1 || ed.backgroundEdit.selection.height < 1;
        invertSelection.setAttribute("aria-pressed", String(!!ed.backgroundEdit?.selection?.inverted));
        brushes.update(!ed.backgroundEdit?.rawMask || ed.removing || magicBusy);
        undoStroke.disabled = !ed.backgroundEdit?.added.length || ed.removing || magicBusy;
        ed.stage.classList.toggle("background-selecting", !!ed.backgroundEdit && backgroundMode === "select" && !magicMode());
        ed.stage.classList.toggle("background-brushing", !!ed.backgroundEdit && ["erase", "restore"].includes(backgroundMode));
        spatialHint.classList.toggle("error", backgroundNote.classList.contains("error"));
        spatialHint.textContent = backgroundNote.classList.contains("error") ? backgroundNote.textContent
            : ed.removing ? "Removing background…"
            : magicMode() ? (magicBusy ? (ed.backgroundEdit?.analysed ? magicDoing : "Analysing the picture for magic select…")
                : "Click an object to remove it, or drag a box round it; Shift-click (or Shift-drag) one to add it back.")
            : backgroundMode === "fill" ? "Draw a closed outline with Erase, then click inside to fill it."
            : backgroundMode === "select" && brushes.shape.value === "circle" ? "Circle: drag from its centre to its edge."
            : backgroundMode === "select" ? (ed.backgroundEdit?.selection ? "Drag a rectangle: only this area changes." : "Background removal affects the whole image. Drag a rectangle to limit it to that area.")
            : backgroundMode === "erase" ? `Paint to make pixels transparent ${ed.backgroundEdit?.selection ? (ed.backgroundEdit.selection.inverted ? "outside the outlined area" : "inside the selected area") : "in the image"}.`
            : backgroundMode === "restore" ? `Paint to restore the original pixels ${ed.backgroundEdit?.selection ? (ed.backgroundEdit.selection.inverted ? "outside the outlined area" : "inside the selected area") : "in the image"}.`
            : ed.backgroundEdit?.selection ? (ed.backgroundEdit.selection.inverted ? "Background removal affects everything outside the outlined area." : "Background removal is limited to the outlined area.") : "Background removal affects the whole image.";
        showSelection();
    };
    const hideBackgroundControls = () => {
        backgroundPanel.hidePopover();
        removeBackground.setAttribute("aria-expanded", "false");
        settingsButton.setAttribute("aria-expanded", "false");
    };
    const showBackgroundControls = () => {
        backgroundPanel.showPopover();
        positionBackground();
        removeBackground.setAttribute("aria-expanded", "true");
        settingsButton.setAttribute("aria-expanded", "true");
    };
    const scheduleBackground = () => {
        cancelAnimationFrame(ed.backgroundFrame);
        ed.backgroundFrame = requestAnimationFrame(previewBackground);
    };
    function setBackgroundMode(mode) {
        if (!ed.backgroundEdit?.rawMask || ed.removing || magicBusy) return;
        ed.backgroundPointer.up(true);
        backgroundMode = mode;
        // (An error here is magic select's: U2NetP's leaves no cutout to work on.)
        backgroundNote.classList.remove("error");
        backgroundNote.textContent = "Adjust the preview, then Apply.";
        // (No area selected is the whole image: one's made only by dragging.)
        hideBackgroundControls();
        brushCursor.hidden = true;
        previewBackground();
        ed.stage.focus({ preventScroll: true });
        if (magicMode()) analyseForMagic();
    }
    // The mask is the objects picked, if any; else U2NetP's.
    const useObjects = () => {
        const edit = ed.backgroundEdit;
        edit.rawMask = edit.objects.length ? objectMask(edit.objects, ...edit.imageSize, edit.found) : edit.found;
    };
    // magicTask runs one magic select step for edit, if it's still the one open.
    const magicTask = async (edit, task, doing = "Selecting…") => {
        magicBusy = true; magicDoing = doing; showSpatial(); ed.showButtons();
        try {
            await task();
        } catch (err) {
            if (!ed.stopped && ed.backgroundEdit === edit) { backgroundNote.textContent = err.message; backgroundNote.classList.add("error"); ed.say(err.message, true); }
        } finally {
            if (!ed.stopped && ed.backgroundEdit === edit) { magicBusy = false; showSpatial(); ed.showButtons(); }
        }
    };
    const analyseForMagic = () => {
        const edit = ed.backgroundEdit;
        if (!edit || edit.analysed || magicBusy) return;
        backgroundNote.classList.remove("error");
        magicTask(edit, async () => {
            await segmenter.analyse(edit.source);
            if (ed.backgroundEdit === edit) edit.analysed = true;
        });
    };
    const pickObject = (prompt, erase) => {
        const edit = ed.backgroundEdit;
        if (!edit?.analysed || magicBusy) return;
        backgroundNote.classList.remove("error");
        magicTask(edit, async () => {
            const mask = await segmenter.select(prompt);
            if (ed.backgroundEdit !== edit) return;
            const { width: w, height: h } = segmenter.size;
            const mark = selectionMark(mask, w, h, ...edit.imageSize, erase);
            if (!mark) { ed.say("Nothing found there. Try a click nearer the object's middle, or a box round it."); return; }
            edit.objects.push(mark); edit.added.push(mark);
            useObjects(); previewBackground();
            ed.say(erase ? "Object removed. Apply to keep the change." : "Object added back. Apply to keep the change.");
        });
    };
    invertSelection.addEventListener("click", () => {
        if (invertSelection.disabled) return;
        ed.backgroundEdit.selection = { ...ed.backgroundEdit.selection, inverted: !ed.backgroundEdit.selection.inverted };
        previewBackground();
    });
    wholeImage.addEventListener("click", () => {
        if (!ed.backgroundEdit?.rawMask) return;
        ed.backgroundEdit.selection = null;
        setBackgroundMode("pan");
    });
    brushSize.addEventListener("input", () => { brushCursor.hidden = true; });
    allObjects.addEventListener("click", () => {
        const edit = ed.backgroundEdit;
        if (!edit?.analysed || magicBusy) return;
        backgroundNote.classList.remove("error");
        ed.say("Finding every object… (this takes a while)");
        magicTask(edit, async () => {
            const { mask, count } = await segmenter.findAll();
            if (ed.backgroundEdit !== edit) return;
            const { width: w, height: h } = segmenter.size;
            const mark = count ? selectionMark(mask, w, h, ...edit.imageSize) : null;
            if (!mark) { ed.say("No objects found. Click one, or drag a box round it."); return; }
            mark.only = true; // (only these kept: what's found replaces the cutout)
            edit.objects.push(mark); edit.added.push(mark);
            useObjects(); previewBackground();
            ed.say(`Kept ${count} ${count === 1 ? "object" : "objects"}. Click any to remove it.`);
        }, "Finding every object… (this takes a while)");
    });
    // Undo takes back the last stroke, fill or object picked.
    undoStroke.addEventListener("click", () => {
        const edit = ed.backgroundEdit, last = edit?.added.pop();
        if (!last) return;
        for (const list of [edit.strokes, edit.objects]) { const i = list.lastIndexOf(last); if (i >= 0) list.splice(i, 1); }
        useObjects(); previewBackground();
    });
    settingsButton.setAttribute("aria-haspopup", "dialog");
    settingsButton.setAttribute("aria-expanded", "false");
    settingsButton.popoverTargetElement = backgroundPanel;
    settingsButton.popoverTargetAction = "toggle";
    const syncBackgroundControls = () => {
        const expanded = String(backgroundPanel.matches(":popover-open"));
        settingsButton.setAttribute("aria-expanded", expanded);
        removeBackground.setAttribute("aria-expanded", expanded);
    };
    settingsButton.addEventListener("click", () => queueMicrotask(() => { syncBackgroundControls(); positionBackground(); }));
    backgroundPanel.addEventListener("toggle", () => { syncBackgroundControls(); positionBackground(); });
    spatialApply.addEventListener("click", () => closeBackground(true));
    spatialCancel.addEventListener("click", () => closeBackground());
    spatialBar.addEventListener("keydown", (event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeBackground(); }
    });
    ed.backgroundPointer = {
        painting: () => !!ed.backgroundEdit && backgroundMode !== "pan",
        place: showSelection,
        down(px, py, event) {
            if (!ed.backgroundEdit?.rawMask || ed.removing || backgroundMode === "pan") return false;
            const point = imagePoint(px, py);
            if (magicMode()) {
                if (!ed.backgroundEdit.analysed) analyseForMagic(); // (it failed: again)
                else if (!magicBusy) gesture = { magic: true, from: maskPoint(imageMaskPoint(px, py, { x: ed.x, y: ed.y, width: ed.width, height: ed.height, scale: ed.scale }, 6)), at: [px, py], erase: !(event?.shiftKey || event?.altKey) }; // (a click removes; Shift adds back)
                return true;
            }
            const rectangle = backgroundMode === "select" && brushes.shape.value === "rectangle";
            if (!rectangle && !insideImage(point)) return true;
            const mapped = maskPoint(rectangle ? imageMaskPoint(px, py, { x: ed.x, y: ed.y, width: ed.width, height: ed.height, scale: ed.scale }, 6) : point);
            if (backgroundMode === "select") {
                const mark = newMaskMark(brushes.shape.value, mapped, 0);
                gesture = { from: mapped, previous: ed.backgroundEdit.selection, selectionMark: mark };
                ed.backgroundEdit.selection = mark.circle ? { shape: "circle", x: mapped[0], y: mapped[1], width: 0, height: 0 } : mark.rect;
            } else {
                const adjacent = maskPoint([point[0] + Number(brushSize.value) / 2, point[1]]);
                if (backgroundMode === "fill") {
                    try {
                        const marks = ed.backgroundEdit.strokes.map((stroke) => ({ ...stroke, erase: stroke.mode === "restore" }));
                        const fill = enclosedFill(marks, ...ed.backgroundEdit.imageSize, mapped);
                        if (fill) { const stroke = { ...fill, mode: "erase" }; ed.backgroundEdit.strokes.push(stroke); ed.backgroundEdit.added.push(stroke); previewBackground(); ed.say("Area filled. Apply to keep it."); }
                        else ed.say("That area is already erased.");
                    } catch (err) { ed.say(err.message, true); }
                    return true;
                }
                const stroke = newMaskMark("brush", mapped, Math.hypot(adjacent[0] - mapped[0], adjacent[1] - mapped[1]));
                stroke.mode = backgroundMode;
                ed.backgroundEdit.strokes.push(stroke); ed.backgroundEdit.added.push(stroke);
                gesture = { stroke, from: mapped };
            }
            scheduleBackground();
            return true;
        },
        move(px, py) {
            if (!ed.backgroundEdit?.rawMask || ed.removing || backgroundMode === "pan") return false;
            const point = imagePoint(px, py);
            brushCursor.hidden = !["erase", "restore"].includes(backgroundMode) || !insideImage(point);
            if (!brushCursor.hidden) {
                const diameter = Number(brushSize.value) * ed.scale;
                Object.assign(brushCursor.style, { left: `${px - diameter / 2}px`, top: `${py - diameter / 2}px`, width: `${diameter}px`, height: `${diameter}px` });
            }
            if (!gesture) return true;
            if (gesture.magic) {
                gesture.dragged ||= Math.hypot(px - gesture.at[0], py - gesture.at[1]) >= 5;
                const [ax, ay] = gesture.at;
                magicBox.hidden = !gesture.dragged;
                Object.assign(magicBox.style, { left: `${Math.min(ax, px)}px`, top: `${Math.min(ay, py)}px`, width: `${Math.abs(px - ax)}px`, height: `${Math.abs(py - ay)}px` });
                return true;
            }
            const rectangle = !!gesture.selectionMark?.rect;
            const mapped = maskPoint(imageMaskPoint(px, py, { x: ed.x, y: ed.y, width: ed.width, height: ed.height, scale: ed.scale }, rectangle ? 6 : 0));
            if (gesture.stroke) extendMaskMark(gesture.stroke, gesture.from, mapped);
            else {
                extendMaskMark(gesture.selectionMark, gesture.from, mapped);
                const mark = gesture.selectionMark;
                ed.backgroundEdit.selection = mark.circle ? { shape: "circle", x: mark.circle.cx - mark.circle.r, y: mark.circle.cy - mark.circle.r, width: mark.circle.r * 2, height: mark.circle.r * 2 } : mark.rect;
            }
            scheduleBackground();
            return true;
        },
        up(cancelled, px, py) {
            if (gesture?.magic) {
                const { from, erase } = gesture;
                if (!cancelled && Number.isFinite(px) && Number.isFinite(py)) ed.backgroundPointer.move(px, py);
                const dragged = gesture.dragged;
                gesture = null; magicBox.hidden = true;
                if (cancelled || !ed.backgroundEdit) return;
                if (!dragged) { pickObject({ point: from }, erase); return; }
                const to = maskPoint(imageMaskPoint(px, py, { x: ed.x, y: ed.y, width: ed.width, height: ed.height, scale: ed.scale }, 6)), box = rectOf(from, to);
                if (box.width >= 1 && box.height >= 1) pickObject({ box: [box.x, box.y, box.width, box.height] }, erase);
                return;
            }
            if (!gesture) return;
            if (!cancelled && Number.isFinite(px) && Number.isFinite(py)) ed.backgroundPointer.move(px, py);
            if (cancelled && ed.backgroundEdit) {
                if (gesture.stroke) { ed.backgroundEdit.strokes.pop(); ed.backgroundEdit.added.pop(); }
                else ed.backgroundEdit.selection = gesture.previous;
            } else if (ed.backgroundEdit && gesture.selectionMark) {
                // A click, not a drag, leaves the area as it was.
                const s = ed.backgroundEdit.selection;
                if (!s || s.width < 1 || s.height < 1) ed.backgroundEdit.selection = gesture.previous;
            }
            gesture = null;
            if (ed.backgroundEdit) {
                cancelAnimationFrame(ed.backgroundFrame);
                previewBackground();
            }
        },
        leave() { brushCursor.hidden = true; },
    };
    // The picture and spatial toolbar are part of this editing session;
    // interacting with them must not dismiss the adjustment preview.
    const outsideBackground = (event) => {
        if (ed.backgroundEdit && ![backgroundPanel, spatialBar, ed.stage, ed.bar, ed.hintBar, ed.toolScope].some((node) => node?.contains(event.target))) closeBackground(false, false);
    };
    document.addEventListener("pointerdown", outsideBackground, true);

    const positionBackground = () => {
        if (!backgroundPanel.matches(":popover-open")) return;
        const rect = settingsButton.getBoundingClientRect();
        const panel = backgroundPanel.getBoundingClientRect();
        backgroundPanel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - panel.width - 8))}px`;
        backgroundPanel.style.top = `${Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - panel.height - 8))}px`;
    };
    const previewBackground = () => {
        for (const { key, input, output } of sliders) output.textContent = `${key === "grow" && Number(input.value) > 0 ? "+" : ""}${input.value}%`;
        if (!ed.backgroundEdit?.rawMask) return;
        const { rawMask, index } = ed.backgroundEdit;
        ed.backgroundPreview = ed.ops.slice();
        const op = { background: adjustedMask(rawMask, backgroundSettings()), rawMask, settings: backgroundSettings(), serial: ed.maskSerial + 1,
            imageSize: ed.backgroundEdit.imageSize, selection: ed.backgroundEdit.selection, strokes: ed.backgroundEdit.strokes, objects: ed.backgroundEdit.objects.slice() };
        if (index < 0) ed.backgroundPreview.push(op);
        else ed.backgroundPreview[index] = op;
        ed.redraw(false);
    };
    const closeBackground = (apply = false, focus = true) => {
        if (!ed.backgroundEdit) return;
        cancelAnimationFrame(ed.backgroundFrame);
        if (apply && ed.backgroundEdit.rawMask) {
            previewBackground(); // include a slider event whose animation frame hasn't run yet
            const previous = ed.ops[ed.backgroundEdit.index];
            const details = (op) => JSON.stringify([op?.settings, op?.selection ?? null, op?.strokes ?? [], op?.objects ?? []]);
            const candidate = ed.backgroundPreview[ed.backgroundEdit.index < 0 ? ed.backgroundPreview.length - 1 : ed.backgroundEdit.index];
            if (!previous || details(previous) !== details(candidate)) {
                ed.remember();
                ed.ops.splice(0, ed.ops.length, ...ed.backgroundPreview);
                ed.maskSerial++;
            }
            if (ed.format.value === "image/jpeg") ed.format.value = "image/png";
        }
        gesture = null;
        backgroundMode = "pan";
        brushes.close();
        brushCursor.hidden = selectionBox.hidden = true;
        ed.backgroundEdit = ed.backgroundPreview = null;
        ed.remover.cancel(); segmenter.cancel();
        ed.removing = magicBusy = false; magicBox.hidden = true;
        hideBackgroundControls();
        ed.redraw(false);
        ed.say(apply ? "Background removed. Undo to restore it." : "Background removal cancelled.");
        if (focus) removeBackground.focus({ preventScroll: true });
    };
    for (const { input } of sliders) input.addEventListener("input", () => {
        cancelAnimationFrame(ed.backgroundFrame);
        ed.backgroundFrame = requestAnimationFrame(previewBackground);
    });
    backgroundPanel.addEventListener("keydown", (event) => {
        // Editing shortcuts and the preview dialog must not consume slider keys.
        if (event.key === "Escape") { event.preventDefault(); hideBackgroundControls(); settingsButton.focus(); }
        event.stopPropagation();
    });
    removeBackground.addEventListener("click", async () => {
        if (ed.backgroundEdit) {
            if (backgroundPanel.matches(":popover-open")) hideBackgroundControls();
            else showBackgroundControls();
            return;
        }
        if (ed.saving || ed.stopped || ed.otherOpen("background", "inpaint")) return;
        ed.inpainting?.close();
        ed.cropper.close();
        ed.resizing.close();
        // Each activation edits the current image. Replacing an earlier
        // operation would restore its removed pixels outside a new selection.
        // (source: the picture as it is now, for magic select; found: U2NetP's mask;
        // added: strokes, fills and objects, in order, for Undo.)
        const edit = ed.backgroundEdit = { index: -1, rawMask: null, found: null, source: ed.content, analysed: false,
            imageSize: [ed.width, ed.height], trailing: [], selection: null, strokes: [], objects: [], added: [] };
        // It starts with Select area, a rectangle: none drawn yet, the whole image.
        backgroundMode = "select"; brushes.shape.value = "rectangle";
        for (const { input, initial } of sliders) input.value = initial;
        ed.removing = !edit.rawMask;
        backgroundNote.textContent = ed.removing ? "Removing background…" : "Adjust the preview, then Apply.";
        backgroundNote.classList.remove("error");
        ed.showButtons();
        previewBackground();
        hideBackgroundControls();
        ed.stage.focus({ preventScroll: true });
        if (!ed.removing) return;
        ed.say("Removing background…");
        try {
            edit.rawMask = edit.found = await ed.remover.remove(ed.content);
            if (ed.stopped || ed.backgroundEdit !== edit) return;
            previewBackground();
            backgroundNote.textContent = "Adjust the preview, then Apply.";
            ed.say("");
        } catch (err) {
            if (!ed.stopped && ed.backgroundEdit === edit) {
                backgroundNote.textContent = err.message;
                backgroundNote.classList.add("error");
                ed.say(err.message, true);
            }
        } finally {
            if (!ed.stopped && ed.backgroundEdit === edit) {
                ed.removing = false;
                ed.showOptions();
            }
        }
    });
    window.addEventListener("resize", positionBackground);
    return { removeBackground, backgroundPanel, backgroundSettings, sliders, brushCursor, brushes, magicBox, segmenter, selectionBox, spatialApply, spatialHint, spatialBar, showSpatial, outsideBackground, positionBackground, closeBackground };
}
