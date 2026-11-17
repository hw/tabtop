import { glyphs, iconSVG } from "./glyphs.js";

export function el(tag, props = {}, ...children) {
    const e = Object.assign(document.createElement(tag), props);
    e.append(...children);
    return e;
}

export const join = (dir, name) => (dir ? `${dir}/${name}` : name);

// copyText puts text on the clipboard: with the clipboard API where the
// browser has it (over HTTPS or on localhost) and allows it, else the old
// way, from a box made for it (in the dialog on top, if one is open,
// as what's under it can't be selected). It rejects if neither copied it.
export async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return;
    } catch {
        // No clipboard API here, or not allowed.
    }
    const area = el("textarea", { value: text, readOnly: true });
    Object.assign(area.style, { position: "fixed", opacity: "0" });
    ([...document.querySelectorAll("dialog[open]")].at(-1) ?? document.body).append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    if (!ok) {
        throw new Error("not copied");
    }
}

// Toggle a dialog between its normal bounds and the whole viewport.
export function maximizeButton(dialog, className) {
    const button = el("button", { type: "button", className: `${className} glyph` });
    const update = () => {
        const wide = dialog.classList.contains("wide");
        button.textContent = wide ? glyphs.contract : glyphs.expand;
        button.title = wide ? "Restore size" : "Maximize";
        button.setAttribute("aria-label", button.title);
        button.setAttribute("aria-pressed", String(wide));
    };
    button.addEventListener("click", () => { dialog.classList.toggle("wide"); update(); });
    update();
    return button;
}

// Glyph-only choice control, with labelled options in a native popover.
export function glyphChoice({ className, title, choices, value, change }) {
    const current = el("button", { type: "button", className: `${className} glyph` });
    current.setAttribute("aria-haspopup", "menu");
    current.setAttribute("aria-expanded", "false");
    const menu = el("div", { className: `glyph-choice-menu ${className}-menu`, role: "menu", ariaLabel: title });
    menu.setAttribute("popover", "auto");
    const update = () => {
        const chosen = choices.find(choice => choice.value === value);
        current.innerHTML = iconSVG(chosen.icon);
        current.append(el("span", { className: "glyph-choice-arrow", ariaHidden: "true", textContent: glyphs.chevronDown }));
        current.title = `${title}: ${chosen.label}`;
        current.setAttribute("aria-label", current.title);
        for (const option of menu.children) option.setAttribute("aria-checked", String(option.dataset.value === value));
    };
    for (const choice of choices) {
        const option = el("button", { type: "button", className: "glyph", role: "menuitemradio", title: choice.label });
        option.dataset.value = choice.value;
        option.innerHTML = iconSVG(choice.icon);
        option.append(el("span", { textContent: choice.label }));
        option.addEventListener("click", () => {
            value = choice.value;
            update(); menu.hidePopover(); current.focus(); change(value);
        });
        menu.append(option);
    }
    current.addEventListener("click", () => {
        menu.togglePopover();
        if (!menu.matches(":popover-open")) return;
        const rect = current.getBoundingClientRect(), box = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - box.width - 8))}px`;
        menu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, innerHeight - box.height - 8))}px`;
        menu.querySelector('[aria-checked="true"]').focus();
    });
    current.addEventListener("keydown", event => {
        if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        if (!menu.matches(":popover-open")) current.click();
        (event.key === "ArrowUp" ? menu.lastElementChild : menu.firstElementChild).focus();
    });
    menu.addEventListener("toggle", event => current.setAttribute("aria-expanded", String(event.newState === "open")));
    menu.addEventListener("keydown", event => {
        if (event.key === "Escape") { event.preventDefault(); menu.hidePopover(); current.focus(); }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const options = [...menu.children], at = options.indexOf(document.activeElement);
            const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (at + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length;
            options[next].focus();
        }
        event.stopPropagation();
    });
    update();
    return el("span", { className: "glyph-choice" }, current, menu);
}
