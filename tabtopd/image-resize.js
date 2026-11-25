// Resizing, in the image editor (see startEditing in image-view.js): a
// width and height, or a percentage, kept in proportion; Apply makes it a
// change, Enter too; Cancel or Escape leaves it.
import { el } from "./preview-dom.js";

// resizeTool puts its fields on toolbar, opened and closed by button (its
// own). geometry() is the picture's {width, height} now; maxSide and
// maxPixels, the most it can be made; canOpen(), whether it may open now
// (no other tool open, nothing being saved); apply([width, height]) makes
// the change; changed() follows its opening or closing. It returns
// active(), open(), close(), toggle() and recipe() (the size typed as a
// recipe's pending step, or null; see editRecipe).
export function resizeTool({ toolbar, button, geometry, maxSide, maxPixels, canOpen, apply, changed }) {
    button.setAttribute("aria-pressed", "false");
    const newWidth = el("input", { type: "number", className: "image-resize-width", min: "1", max: String(maxSide), step: "1" });
    const newHeight = el("input", { type: "number", className: "image-resize-height", min: "1", max: String(maxSide), step: "1" });
    const percent = el("input", { type: "number", className: "image-resize-percent", min: "1", max: "1000", step: "1", value: "100" });
    newWidth.setAttribute("aria-label", "Width, in pixels");
    newHeight.setAttribute("aria-label", "Height, in pixels");
    percent.setAttribute("aria-label", "Size, as a percentage");
    const applyResize = el("button", { type: "button", className: "image-resize-apply", textContent: "Apply", ariaLabel: "Apply resize" });
    const cancelResize = el("button", { type: "button", className: "image-resize-cancel", textContent: "Cancel" });
    const resizePanel = el("span", { className: "image-resize", hidden: true }, newWidth, "×", newHeight, "px, or ", percent, "% ", applyResize, cancelResize);
    toolbar.append(resizePanel);
    const wanted = () => [Math.round(Number(newWidth.value)), Math.round(Number(newHeight.value))];
    const resizeOK = () => {
        const [w, h] = wanted(), { width, height } = geometry();
        return w >= 1 && h >= 1 && w <= maxSide && h <= maxSide && w * h <= maxPixels && (w !== width || h !== height);
    };
    const setSize = (w) => {
        const { width, height } = geometry();
        newWidth.value = String(Math.max(1, Math.round(w)));
        newHeight.value = String(Math.max(1, Math.round(w * height / width)));
        applyResize.disabled = !resizeOK();
    };
    newWidth.addEventListener("input", () => { setSize(Number(newWidth.value) || 0); percent.value = String(Math.round(Number(newWidth.value) / geometry().width * 100)); });
    newHeight.addEventListener("input", () => {
        const { width, height } = geometry();
        const h = Number(newHeight.value) || 0;
        newWidth.value = String(Math.max(1, Math.round(h * width / height)));
        percent.value = String(Math.round(h / height * 100));
        applyResize.disabled = !resizeOK();
    });
    percent.addEventListener("input", () => setSize(geometry().width * (Number(percent.value) || 0) / 100));
    const setResizing = (on) => {
        if (on && !canOpen()) return;
        resizePanel.hidden = !on;
        button.setAttribute("aria-pressed", String(on));
        changed();
        if (on) {
            percent.value = "100";
            setSize(geometry().width);
            newWidth.select?.();
            newWidth.focus?.();
        }
    };
    button.addEventListener("click", () => setResizing(resizePanel.hidden));
    cancelResize.addEventListener("click", () => setResizing(false));
    applyResize.addEventListener("click", () => {
        if (!resizeOK()) return;
        const size = wanted();
        setResizing(false);
        apply(size);
    });
    resizePanel.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); applyResize.click(); }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setResizing(false); }
        e.stopPropagation();
    });
    return {
        active: () => !resizePanel.hidden,
        open: () => setResizing(true),
        close: () => setResizing(false),
        toggle: () => setResizing(resizePanel.hidden),
        recipe: () => {
            if (!resizeOK()) return null;
            const { width, height } = geometry();
            return { kind: "resize", width, height, size: wanted() };
        },
    };
}
