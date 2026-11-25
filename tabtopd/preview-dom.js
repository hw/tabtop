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

// showModal shows dialog, put in the page, modally, until it's closed
// (its closeButton, Esc, or its own closing, which it's given back):
// then, once, closed() (the dialog's own stopping), the dialog closed and
// taken away, and the focus given back (to focus, if it's still there,
// else restoreFocus()). request(close, how), if given, is asked instead
// when ✕ ("button") or Escape ("escape") would close it: it closes it, or
// asks first, or does something else (stops a search). parent: where it's
// put (the page, or a dialog it's of, for that one's keys). It returns
// close.
export function showModal(dialog, { closeButton, focus, restoreFocus, closed = () => {}, request = null, parent = document.body }) {
    let done = false;
    const close = () => {
        if (done) return;
        done = true;
        closed();
        if (dialog.open) dialog.close();
        dialog.remove();
        if (focus?.isConnected) focus.focus({ preventScroll: true });
        else restoreFocus?.();
    };
    // Asked to close (by ✕, or Escape): request, if given, decides.
    const ask = (how) => (request ? request(close, how) : close());
    closeButton?.addEventListener("click", () => ask("button"));
    dialog.addEventListener("close", close);
    dialog.addEventListener("cancel", (e) => { e.preventDefault(); ask("escape"); });
    parent.append(dialog);
    dialog.showModal();
    return close;
}

// maximizeButton toggles a dialog between the box it starts as and the
// whole window. dialog may be given as a function (a button made before
// its dialog); kept, {get, set}, keeps the choice (the preview's, as last
// chosen): its update() shows it again.
export function maximizeButton(dialog, className, kept = null) {
    const button = el("button", { type: "button", className: `${className} glyph` });
    // (A dialog given as a function may not be made yet: none, till it is.)
    const box = () => {
        try {
            return typeof dialog === "function" ? dialog() : dialog;
        } catch {
            return null;
        }
    };
    const show = (wide) => {
        box()?.classList.toggle("wide", wide);
        button.textContent = wide ? glyphs.contract : glyphs.expand;
        button.title = wide ? "Back to a box" : "Fill the window";
        button.setAttribute("aria-label", button.title);
        button.setAttribute("aria-pressed", String(wide));
    };
    button.update = () => show(kept ? kept.get() : !!box()?.classList.contains("wide"));
    button.addEventListener("click", () => {
        const wide = !box()?.classList.contains("wide");
        kept?.set(wide);
        show(wide);
    });
    button.update();
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
