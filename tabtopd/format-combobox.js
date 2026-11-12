import { el } from "./preview-dom.js";
import { glyphs } from "./glyphs.js";

let nextId = 0;
const label = entry => entry.id ? `${entry.title} (${entry.id})` : "Raw hex";

// Editable, select-only autocomplete: typing filters, but only a listed format
// can be committed. Focus stays in the textbox while navigating the popup.
export function formatCombobox(onSelect) {
    const id = `binary-format-${++nextId}`;
    const input = el("input", { id, type: "text", value: "Raw hex", role: "combobox", ariaLabel: "Binary format",
        autocomplete: "off", placeholder: "Choose or type a format…", disabled: true });
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-controls", `${id}-options`);
    const toggle = el("button", { type: "button", className: "kaitai-format-toggle", textContent: glyphs.chevronDown,
        ariaLabel: "Show binary formats", disabled: true });
    toggle.setAttribute("aria-haspopup", "listbox");
    toggle.setAttribute("aria-controls", `${id}-options`);
    toggle.setAttribute("aria-expanded", "false");
    const popup = el("div", { id: `${id}-options`, className: "kaitai-format-popup", role: "listbox", ariaLabel: "Binary formats", hidden: true });
    const element = el("div", { className: "kaitai-format-combo" }, input, toggle, popup);
    let entries = [], matches = [], selected = { id: "", title: "Raw hex" }, active = -1;
    const close = () => {
        popup.hidden = true;
        input.setAttribute("aria-expanded", "false");
        input.removeAttribute("aria-activedescendant");
        toggle.setAttribute("aria-expanded", "false");
    };
    const highlight = index => {
        active = index;
        const rows = popup.querySelectorAll('[role="option"]');
        rows.forEach((row, i) => row.setAttribute("aria-selected", String(i === index)));
        if (rows[index]) {
            input.setAttribute("aria-activedescendant", rows[index].id);
            if (!popup.hidden) rows[index].scrollIntoView({ block: "nearest" });
        } else input.removeAttribute("aria-activedescendant");
    };
    const commit = entry => {
        const changed = selected.id !== entry.id;
        selected = entry;
        input.value = label(entry);
        input.setCustomValidity("");
        close();
        if (changed) onSelect(entry.id ? entry : null);
    };
    const render = query => {
        const term = query.trim().toLowerCase();
        matches = entries.filter(entry => `${label(entry)} ${entry.category ?? ""}`.toLowerCase().includes(term));
        popup.replaceChildren(...matches.map((entry, index) => {
            const row = el("div", { id: `${id}-option-${index}`, role: "option", className: "kaitai-format-option" },
                el("span", { textContent: label(entry) }),
                el("small", { className: "hint", textContent: entry.category ?? "" }));
            row.addEventListener("pointerdown", event => event.preventDefault());
            row.addEventListener("click", () => { commit(entry); input.focus(); });
            return row;
        }));
        if (!matches.length) popup.append(el("p", { className: "hint", role: "status", textContent: "No matching formats" }));
        const exact = matches.findIndex(entry => entry.id.toLowerCase() === term);
        highlight(matches.length ? Math.max(0, exact) : -1);
    };
    const open = (query = "") => {
        if (input.disabled) return;
        render(query);
        popup.hidden = false;
        input.setAttribute("aria-expanded", "true");
        toggle.setAttribute("aria-expanded", "true");
        highlight(active);
    };
    const exact = () => {
        const text = input.value.trim().toLowerCase();
        return entries.find(entry => label(entry).toLowerCase() === text || entry.id.toLowerCase() === text || entry.title.toLowerCase() === text);
    };
    input.addEventListener("focus", () => { input.select(); open(); });
    input.addEventListener("click", () => { if (popup.hidden) open(); });
    input.addEventListener("input", () => { input.setCustomValidity(""); open(input.value); });
    input.addEventListener("change", () => {
        const entry = exact();
        if (entry) commit(entry);
        else input.setCustomValidity("Choose a format from the dropdown, or Raw hex.");
    });
    input.addEventListener("keydown", event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault(); event.stopPropagation();
            if (popup.hidden) { open(); highlight(event.key === "ArrowDown" ? 0 : matches.length - 1); }
            else if (matches.length) highlight((active + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
        } else if ((event.key === "Home" || event.key === "End") && !popup.hidden) {
            event.preventDefault(); highlight(event.key === "Home" ? 0 : matches.length - 1);
        } else if (event.key === "Enter") {
            event.preventDefault(); event.stopPropagation();
            // Resolve an exact ID even when the textbox was populated without an input event.
            const entry = exact() ?? (!popup.hidden ? matches[active] : null);
            if (entry) commit(entry);
            else { input.setCustomValidity("Choose a format from the dropdown, or Raw hex."); open(input.value); }
        } else if (event.key === "Escape" && !popup.hidden) {
            event.preventDefault(); event.stopPropagation();
            input.value = label(selected); input.setCustomValidity(""); close();
        } else if (event.key === "Tab") close();
    });
    toggle.addEventListener("pointerdown", event => event.preventDefault());
    toggle.addEventListener("click", () => {
        const wasOpen = !popup.hidden;
        input.focus();
        if (wasOpen) close(); else open();
    });
    const outside = event => {
        if (!element.contains(event.target)) {
            input.value = label(selected); input.setCustomValidity(""); close();
        }
    };
    document.addEventListener("pointerdown", outside);
    element.addEventListener("focusout", event => { if (!element.contains(event.relatedTarget)) close(); });
    return { element, input,
        setFormats(formats) {
            entries = [{ id: "", title: "Raw hex" }, ...formats];
            input.disabled = toggle.disabled = false;
            render("");
        },
        // choose selects the format with this id, as if it were picked.
        choose(formatId) {
            const entry = entries.find(e => e.id === formatId);
            if (entry) commit(entry);
        },
        stop() { document.removeEventListener("pointerdown", outside); close(); },
    };
}
