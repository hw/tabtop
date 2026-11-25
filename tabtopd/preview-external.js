// The preview's External resources menu (see preview in preview.js): how
// what a rendered file asks for from elsewhere is loaded, none (the
// default), through the gateway (proxy) or by the browser itself (direct),
// for the file shown; a button showing which, and a menu of the three.
import { glyphs, iconSVG } from "./glyphs.js";
import { el } from "./preview-dom.js";

// externalMenu makes it with button (the preview's maker of its buttons).
// opened() is called as the menu opens (other menus closing);
// hiddenWhile(), whether to hide it anyway (while editing); changed(mode),
// after another mode's chosen. It returns its group (the element), mode,
// open (the menu's), found(count) (that many external things found, 0 as a
// file starts to be drawn), reset() (a new file: none, and hidden), hide()
// and close() (the menu).
export function externalMenu({ button, opened, hiddenWhile, changed }) {
    // Resource permissions belong to this file and start blocked.
    let externalMode = "none", externalCount = 0;
    const externalResources = button("", "", "external-resources glyph");
    const externalMore = button(glyphs.chevronDown, "External resource modes", "external-more");
    const externalMenu = el("div", { className: "external-menu", hidden: true, role: "menu" });
    externalMenu.setAttribute("aria-label", "External resources");
    const externalGroup = el("span", { className: "external-group", hidden: true }, externalResources, externalMore, externalMenu);
    const externalStates = ["none", "proxy", "direct"];
    const externalLabels = { none: "No external", proxy: "Proxy", direct: "Direct" };
    let externalOpener = externalResources;
    const showExternalMenu = (show, opener = externalOpener) => {
        externalMenu.hidden = !show;
        externalOpener = opener;
        for (const control of [externalResources, externalMore]) control.setAttribute("aria-expanded", String(show));
        if (show) {
            opened();
            externalMenu.querySelector('[aria-checked="true"]')?.focus();
        }
    };
    const showExternal = () => {
        // Shown while there's something external to load, or while a mode
        // other than the default is on: a book counts chapter by chapter,
        // and one with none mustn't hide a mode that's still on.
        externalGroup.hidden = externalResources.hidden = !externalCount && externalMode === "none" || hiddenWhile();
        if (externalGroup.hidden) showExternalMenu(false);
        externalResources.dataset.mode = externalMode;
        externalResources.innerHTML = iconSVG(`external-${externalMode}`);
        externalResources.title = `External resources: ${externalLabels[externalMode]}`;
        externalResources.setAttribute("aria-label", externalResources.title);
        for (const item of externalMenu.querySelectorAll("button")) item.setAttribute("aria-checked", String(item.dataset.mode === externalMode));
    };
    const selectExternal = mode => {
        showExternalMenu(false);
        externalResources.focus({ preventScroll: true });
        if (mode === externalMode) return;
        externalMode = mode;
        showExternal();
        changed(mode);
    };
    for (const mode of externalStates) {
        const item = button("", externalLabels[mode], `external-option external-${mode} glyph`);
        item.innerHTML = iconSVG(`external-${mode}`);
        item.append(el("span", { textContent: externalLabels[mode] }));
        item.dataset.mode = mode;
        item.setAttribute("role", "menuitemradio");
        item.setAttribute("aria-checked", String(mode === externalMode));
        item.tabIndex = -1;
        item.addEventListener("click", () => selectExternal(mode));
        externalMenu.append(item);
    }
    for (const control of [externalResources, externalMore]) {
        control.setAttribute("aria-haspopup", "menu");
        control.setAttribute("aria-expanded", "false");
        control.addEventListener("click", () => showExternalMenu(externalMenu.hidden, control));
    }
    externalResources.hidden = true;
    externalMenu.addEventListener("keydown", event => {
        const items = [...externalMenu.querySelectorAll("button")];
        const at = items.indexOf(document.activeElement);
        if (event.key === "Escape") {
            event.preventDefault(); event.stopPropagation();
            showExternalMenu(false); externalOpener.focus();
        } else if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
            event.preventDefault(); event.stopPropagation();
            const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
            items[next]?.focus();
        } else if (event.key === "Tab") { showExternalMenu(false); externalMore.focus(); }
    });
    externalGroup.addEventListener("focusout", event => {
        if (!externalGroup.contains(event.relatedTarget)) showExternalMenu(false);
    });
    const hide = () => {
        externalGroup.hidden = externalResources.hidden = true;
        showExternalMenu(false);
    };
    return {
        group: externalGroup,
        get mode() { return externalMode; },
        get open() { return !externalMenu.hidden; },
        found: (count) => { externalCount = count; showExternal(); },
        reset: () => { externalMode = "none"; externalCount = 0; hide(); },
        hide,
        close: () => showExternalMenu(false),
    };
}
