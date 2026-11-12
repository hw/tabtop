import { el } from "./preview-dom.js";
import { previewWebURL } from "./preview-model.js";
import { copyText } from "./ui.js";
import { iconSVG } from "./glyphs.js";

export function previewLink(frame, href) {
    const url = previewWebURL(href);
    const owner = frame.closest("dialog") ?? document.body;
    if (!url || owner.querySelector("dialog.preview-link[open]")) return;
    const heading = el("p", { textContent: "Open external link?" });
    const address = el("p", { className: "link-url", textContent: url });
    const status = el("p", { className: "hint", role: "status" });
    const close = el("button", { type: "button", className: "close", title: "Close" });
    close.setAttribute("aria-label", "Close");
    close.innerHTML = iconSVG("close-circle");
    const copy = el("button", { type: "button", textContent: "Copy URL" });
    const proceed = el("button", { type: "button", className: "primary", textContent: "Open in browser" });
    const dialog = el("dialog", { className: "preview-link" }, close, heading, address, status,
        el("div", { className: "buttons" }, copy, proceed));
    dialog.setAttribute("aria-label", "Open external link?");
    dialog.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
            e.preventDefault();
            dialog.close();
        }
    });
    dialog.addEventListener("cancel", (e) => {
        e.preventDefault();
        e.stopPropagation();
        dialog.close();
    });
    close.addEventListener("click", () => dialog.close());
    copy.addEventListener("click", async () => {
        try {
            await copyText(url);
            status.textContent = "URL copied";
        } catch {
            status.textContent = "Couldn't copy the URL. Select and copy the address above.";
        }
    });
    proceed.addEventListener("click", () => {
        window.open(url, "_blank", "noopener,noreferrer");
        dialog.close();
    });
    dialog.addEventListener("close", () => dialog.remove());
    owner.append(dialog);
    dialog.showModal();
    copy.focus();
}

