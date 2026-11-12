// Placing a picture over the one being edited: pasted, or from a file;
// moved, resized (in proportion, or stretched to cover an area), and made
// see-through if wanted. What's placed is a step ({paste}) as a crop is:
// replayed by transform, and as a recipe's "paste" step, scaled to other
// pages, its picture (a Blob) kept with it.
import { el } from "./preview-dom.js";
import { iconSVG } from "./glyphs.js";

export const MAX_PLACED_BYTES = 50 << 20, MAX_PLACED_PIXELS = 40e6;
const HANDLE = 12; // the corner handle's size, on screen

// validPlacement is paste ({rect, opacity}) if it can be drawn, else it
// throws: a recipe's may come from elsewhere.
export function validPlacement(paste) {
    const r = paste?.rect;
    if (![r?.x, r?.y, r?.width, r?.height].every(Number.isFinite) || r.width < 0 || r.height < 0 ||
        !(Number.isFinite(paste.opacity) && paste.opacity > 0 && paste.opacity <= 1)) {
        throw new Error("Not a picture that can be placed.");
    }
    return paste;
}

// drawPlacement draws image (a bitmap, or anything drawImage takes) on ctx
// where paste says.
export function drawPlacement(ctx, paste, image) {
    const { rect, opacity } = validPlacement(paste);
    if (rect.width < 1 || rect.height < 1) return;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height);
    ctx.restore();
}

// pastedPicture is the picture in a paste event's clipboard, or null.
export function pastedPicture(event) {
    const data = event.clipboardData;
    for (const file of data?.files ?? []) if (file.type.startsWith("image/")) return file;
    for (const item of data?.items ?? []) if (item.kind === "file" && item.type.startsWith("image/")) return item.getAsFile();
    return null;
}

// placeTool is the tool, in toolbar, over the picture shown in stage at
// geometry() ({width, height, x, y, scale}). apply(op) is given what's
// placed, as an op: {paste: {blob, image (a bitmap of it), rect, opacity}}.
export function placeTool({ toolbar, stage, button, geometry, apply, changed }) {
    let active = false, blob = null, image = null, url = null, rect = null, gesture = null, aspect = 1;
    const makeButton = (icon, title, cls, fn) => {
        const b = el("button", { type: "button", className: `glyph ${cls}`, title, ariaLabel: title });
        b.innerHTML = iconSVG(icon);
        b.addEventListener("click", fn);
        return b;
    };
    const keep = el("input", { type: "checkbox", className: "image-place-keep", checked: true });
    const keepLabel = el("label", { className: "check image-place-keep-label", title: "Off: stretch it to cover the area dragged" }, keep, "Keep proportions");
    const opacity = el("input", { type: "range", className: "image-place-opacity", min: "5", max: "100", step: "5", value: "100", ariaLabel: "Opacity" });
    const opacityText = el("span", { className: "hint image-place-opacity-value" });
    const opacityLabel = el("label", { className: "image-place-opacity-label" }, "Opacity ", opacity, opacityText);
    const fitButton = makeButton("fit-page", "Cover the whole picture", "image-place-fill", () => {
        const g = geometry();
        rect = keep.checked ? fitted(g.width, g.height, g.width / 2, g.height / 2) : { x: 0, y: 0, width: g.width, height: g.height };
        update();
    });
    const accept = makeButton("check", "Place it (Enter)", "image-place-apply", () => commit());
    const cancel = makeButton("close-circle", "Cancel (Esc)", "image-place-cancel", () => close());
    const note = el("span", { className: "hint image-place-note", role: "status" });
    const bar = el("div", { className: "image-place-tools", hidden: true }, keepLabel, opacityLabel, fitButton, accept, cancel, note);
    toolbar.append(bar);
    const preview = el("img", { className: "image-place-preview", alt: "", draggable: false, hidden: true });
    const frame = el("div", { className: "image-place-frame", hidden: true, ariaHidden: "true" }, el("span", { className: "image-place-handle" }));
    stage.append(preview, frame);
    keep.addEventListener("change", () => {
        if (keep.checked && rect) rect = { ...rect, height: rect.width / aspect };
        update();
        stage.focus({ preventScroll: true });
    });
    opacity.addEventListener("input", () => update());
    for (const input of [keep, opacity]) input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); } else if (e.key === "Escape") { e.preventDefault(); close(); }
        e.stopPropagation();
    });

    // The largest it fits at in w × h, in proportion, centred on cx, cy.
    function fitted(w, h, cx, cy) {
        const width = Math.min(w, h * aspect), height = width / aspect;
        return { x: cx - width / 2, y: cy - height / 2, width, height };
    }
    const pointOf = (px, py) => {
        const g = geometry();
        return [(px - g.x) / g.scale, (py - g.y) / g.scale];
    };
    const shown = () => !!rect && rect.width >= 1 && rect.height >= 1;
    function update() {
        opacityText.textContent = `${opacity.value}%`;
        accept.disabled = !shown();
        note.textContent = "Drag it to move it, its corner to resize it, or elsewhere to cover an area.";
        stage.classList.toggle("placing", active);
        place();
        changed();
    }
    function place() {
        preview.hidden = frame.hidden = !active || !shown();
        if (preview.hidden) return;
        const g = geometry();
        const box = { left: `${g.x + rect.x * g.scale}px`, top: `${g.y + rect.y * g.scale}px`, width: `${rect.width * g.scale}px`, height: `${rect.height * g.scale}px` };
        Object.assign(preview.style, box, { opacity: String(Number(opacity.value) / 100) });
        Object.assign(frame.style, box);
        frame.dataset.size = `${Math.round(rect.width)}×${Math.round(rect.height)}`;
    }
    // open places blob (an image), centred, at most half the picture's size.
    async function open(file) {
        if (!file?.type?.startsWith("image/")) throw new Error("That isn't a picture.");
        if (file.size > MAX_PLACED_BYTES) throw new Error("That picture is too big to place (over 50 MiB).");
        let bitmap;
        try {
            bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
        } catch {
            throw new Error("That picture can't be read.");
        }
        if (bitmap.width * bitmap.height > MAX_PLACED_PIXELS) {
            bitmap.close();
            throw new Error("That picture has too many pixels to place.");
        }
        release();
        blob = file;
        image = bitmap;
        aspect = bitmap.width / bitmap.height;
        url = URL.createObjectURL(file);
        preview.src = url;
        const g = geometry();
        rect = fitted(Math.min(g.width / 2, bitmap.width), Math.min(g.height / 2, bitmap.height), g.width / 2, g.height / 2);
        active = true;
        gesture = null;
        bar.hidden = false;
        button.setAttribute("aria-pressed", "true");
        update();
        stage.focus({ preventScroll: true });
    }
    function release() {
        if (url) URL.revokeObjectURL(url);
        image?.close?.();
        url = image = blob = null;
        preview.removeAttribute("src");
    }
    function close() {
        if (!active) return;
        active = false;
        rect = gesture = null;
        release();
        bar.hidden = true;
        button.setAttribute("aria-pressed", "false");
        update();
        stage.focus({ preventScroll: true });
    }
    function placement() {
        return shown() ? { rect: { ...rect }, opacity: Number(opacity.value) / 100 } : null;
    }
    function commit() {
        const made = placement();
        if (!active || !made) return;
        const op = { paste: { ...made, blob, image } };
        // (Handed over: not closed with the tool.)
        image = null;
        close();
        apply(op);
    }
    update();
    return {
        active: () => active,
        painting: () => active,
        open, close, commit,
        place,
        // What's placed as a recipe's pending step (see editRecipe), or null.
        recipe() {
            const made = placement(), g = geometry();
            return made ? { kind: "paste", width: g.width, height: g.height, ...made, blob } : null;
        },
        down(px, py) {
            if (!active) return false;
            const g = geometry(), [x, y] = pointOf(px, py);
            const corner = [g.x + (rect.x + rect.width) * g.scale, g.y + (rect.y + rect.height) * g.scale];
            if (shown() && Math.abs(px - corner[0]) <= HANDLE && Math.abs(py - corner[1]) <= HANDLE) gesture = { resize: true };
            else if (shown() && x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) gesture = { move: [x - rect.x, y - rect.y] };
            else { gesture = { from: [x, y], previous: rect }; rect = { x, y, width: 0, height: 0 }; }
            update();
            return true;
        },
        move(px, py) {
            if (!active) return false;
            if (!gesture) return true;
            const [x, y] = pointOf(px, py);
            if (gesture.move) rect = { ...rect, x: x - gesture.move[0], y: y - gesture.move[1] };
            else if (gesture.resize) {
                const width = Math.max(1, x - rect.x);
                rect = { ...rect, width, height: keep.checked ? width / aspect : Math.max(1, y - rect.y) };
            } else {
                const [fx, fy] = gesture.from;
                let width = Math.abs(x - fx), height = Math.abs(y - fy);
                if (keep.checked) {
                    // In proportion: as wide as dragged, or as tall, whichever's more.
                    if (width / aspect >= height) height = width / aspect; else width = height * aspect;
                }
                rect = { x: x < fx ? fx - width : fx, y: y < fy ? fy - height : fy, width, height };
            }
            update();
            return true;
        },
        up(cancelled = false, px, py) {
            if (gesture && !cancelled && Number.isFinite(px) && Number.isFinite(py)) this.move(px, py);
            // A click, or a cancelled drag, elsewhere: where it was.
            if (gesture?.from && (cancelled || !shown())) { rect = gesture.previous; update(); }
            gesture = null;
        },
        stop() {
            close();
            release();
            bar.remove();
            preview.remove();
            frame.remove();
        },
    };
}
