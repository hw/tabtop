// Pieces of the files page's interface, served by tabtopd: the panel in
// the corner that shows uploads, downloads of zips and other changes as
// they go (also on the desktop), dialogs that ask for a name, a folder, a
// yes or a choice, and the menus of each row. Used by files.js, drop.js
// and download.js.

function el(tag, props = {}, ...children) {
    const e = Object.assign(document.createElement(tag), props);
    e.append(...children);
    return e;
}

// The transfers panel: a list of rows, each a change and how it's going,
// under a heading that says how many are still going, with a bar for how
// many of them are done, a button that clears the finished ones, and one
// that folds the list away. It's shown while it has rows. While any are
// going, the tab's title starts with how far they've got, so a tab in the
// background shows it too.
let panel = null;

// TITLE_MARK starts the title while transfers are going; what follows it,
// up to " · ", is put there by showProgress, and replaced each time.
const TITLE_MARK = "⇅ ";

// showProgress puts how far the going rows have got at the start of the
// tab's title: the percentage of their bytes where every one knows it,
// else how many are going. The page may change the title meanwhile.
function showProgress(rows) {
    const title = document.title;
    const base = title.startsWith(TITLE_MARK) ? title.slice(title.indexOf(" · ") + 3) : title;
    const going = rows.filter((p) => p.classList.contains("going"));
    if (!going.length) {
        if (base !== title) {
            document.title = base;
        }
        return;
    }
    const fractions = going.map((p) => p._fraction);
    const known = fractions.every((f) => typeof f === "number");
    const how = known ? `${Math.floor(fractions.reduce((a, b) => a + b, 0) * 100 / going.length)}%` : `${going.length} going`;
    const next = `${TITLE_MARK}${how} · ${base}`;
    if (next !== title) {
        document.title = next;
    }
}

function transfers() {
    if (panel) {
        return panel;
    }
    const list = el("div", { id: "uploads" });
    list.setAttribute("role", "status");
    const summary = el("span", { className: "summary" });
    const overall = el("progress", { className: "overall", max: 1 });
    const clear = el("button", { type: "button", textContent: "Clear" });
    const fold = el("button", { type: "button", className: "fold", title: "Fold away" });
    const box = el("section", { id: "transfers", hidden: true },
        el("div", { className: "head" }, el("strong", { textContent: "Transfers" }), summary, clear, fold), overall, list);
    box.setAttribute("aria-label", "Transfers");
    const update = () => {
        const rows = [...list.children];
        const going = rows.filter((p) => p.classList.contains("going")).length;
        box.hidden = !rows.length;
        document.body.classList.toggle("has-transfers", !box.hidden);
        summary.textContent = going ? `${going} going` : "all done";
        overall.hidden = !going;
        overall.value = rows.length ? (rows.length - going) / rows.length : 0;
        clear.disabled = going === rows.length;
        fold.textContent = box.classList.contains("folded") ? "▴" : "▾";
        showProgress(rows);
    };
    clear.addEventListener("click", () => {
        for (const p of [...list.children]) {
            if (!p.classList.contains("going")) {
                p.remove();
            }
        }
        update();
    });
    fold.addEventListener("click", () => {
        box.classList.toggle("folded");
        update();
    });
    document.body.append(box);
    // The page may set its own title (a folder, the terminal's), which
    // loses the progress till the next update: put it back.
    new MutationObserver(() => showProgress([...list.children])).observe(document.querySelector("title") ?? document.head,
        { childList: true, characterData: true, subtree: true });
    panel = { list, update };
    return panel;
}

// statusRow adds a row to the transfers panel, and returns it as
// {set(text, error), progress(fraction), text, signal, finish()}: its text,
// marked as an error if error; a bar, shown once progress is given a
// fraction, or null for an amount not known; and, if cancellable, a
// Cancel button that aborts signal. The row counts as going, and keeps
// its button, until finish() is called.
export function statusRow(text, cancellable = false) {
    const { list, update } = transfers();
    const span = el("span", { textContent: text });
    const bar = el("progress", { max: 1, hidden: true });
    const p = el("p", { className: "going" }, span, bar);
    const abort = new AbortController();
    let button = null;
    if (cancellable) {
        button = el("button", { type: "button", className: "cancel", textContent: "Cancel" });
        button.addEventListener("click", () => {
            abort.abort();
            button.disabled = true;
        });
        p.append(button);
    }
    list.append(p);
    update();
    return {
        set(t, error = false) {
            span.textContent = t;
            p.classList.toggle("error", error);
        },
        progress(fraction) {
            bar.hidden = false;
            p._fraction = fraction;
            if (fraction === null) {
                bar.removeAttribute("value");  // moving, with no end known
            } else {
                bar.value = fraction;
            }
            showProgress([...list.children]);
        },
        get text() {
            return span.textContent;
        },
        signal: abort.signal,
        finish() {
            button?.remove();
            bar.hidden = true;
            p.classList.remove("going");
            update();
        },
    };
}

// ask shows a dialog with message, any fields, and buttons Cancel and ok,
// and resolves to whether ok was chosen. Enter chooses ok, and Escape or
// Cancel doesn't.
async function ask(message, ok, ...fields) {
    return (await choose(message, [["", "Cancel"], ["ok", ok]], ...fields)) === "ok";
}

// choose shows a dialog with message, any fields, and a button for each of
// choices, [value, label], the last the main one, and resolves to the
// value of the one chosen, or "" for Escape. Enter chooses the last.
function choose(message, choices, ...fields) {
    return new Promise((resolve) => {
        const buttons = choices.map(([value, label], i) => el("button", { type: "submit", value: value || "",
            className: i === choices.length - 1 ? "primary" : "", formNoValidate: !value, textContent: label }));
        const form = el("form", { method: "dialog" }, el("p", { textContent: message }), ...fields,
            el("div", { className: "buttons" }, ...buttons));
        const dialog = el("dialog", {}, form);
        dialog.addEventListener("close", () => {
            dialog.remove();
            resolve(dialog.returnValue);
        });
        document.body.append(dialog);
        dialog.showModal();
        (fields.find((f) => f.tagName === "INPUT") ?? buttons.at(-1)).focus();
    });
}

// askChoice asks message, with a Cancel button and one for each of
// choices, [value, label], the last the main one, and resolves to the
// value chosen, or null for Cancel.
export async function askChoice(message, choices) {
    return (await choose(message, [["", "Cancel"], ...choices])) || null;
}

// askYes asks message, with ok naming what yes does, and resolves to
// whether it was chosen.
export function askYes(message, ok) {
    return ask(message, ok);
}

// askName asks for a name for a file or folder, starting with value, and
// resolves to it, or null if it's not given. With stem, only the part
// before the extension starts selected, so typing keeps the extension.
export async function askName(message, ok, value = "", stem = false) {
    const input = el("input", { type: "text", value, required: true, spellcheck: false, autocomplete: "off" });
    input.setAttribute("aria-label", message);
    input.addEventListener("input", () => input.setCustomValidity(
        input.value.includes("/") ? "A name can't have / in it." : input.value === "." || input.value === ".." ? "That name can't be used." : ""));
    const dot = input.value.lastIndexOf(".");
    requestAnimationFrame(() => input.setSelectionRange(0, stem && dot > 0 ? dot : value.length));
    return (await ask(message, ok, input)) ? input.value : null;
}

// askFolder asks for a folder in ~/Downloads, by its path there,
// starting with value, and resolves to it, without slashes at either end
// ("" for Downloads itself), or null if it's not given.
export async function askFolder(message, ok, value = "") {
    const input = el("input", { type: "text", value, spellcheck: false, autocomplete: "off", placeholder: "Empty for Downloads itself" });
    input.setAttribute("aria-label", message);
    requestAnimationFrame(() => input.select());
    if (!(await ask(message, ok, input))) {
        return null;
    }
    return input.value.trim().replace(/^~?\/?(Downloads(\/|$))?/, "").replace(/^\/+|\/+$/g, "");
}

// rowMenu makes a row's menu: a ⋯ button, named label for screen readers,
// that opens a list of items, each [className, text, onClick]. Choosing
// one closes it, as do clicking elsewhere and Escape; opening one closes
// any other.
export function rowMenu(label, items) {
    const summary = el("summary", { textContent: "⋯", title: label });
    summary.setAttribute("aria-label", label);
    const menu = el("details", { className: "menu" }, summary,
        el("div", { className: "items" }, ...items.map(([className, textContent, onClick]) => {
            const b = el("button", { type: "button", className, textContent });
            b.addEventListener("click", () => {
                menu.open = false;
                onClick();
            });
            return b;
        })));
    menu.addEventListener("toggle", () => {
        if (menu.open) {
            for (const other of document.querySelectorAll("details.menu[open]")) {
                if (other !== menu) {
                    other.open = false;
                }
            }
        }
    });
    return menu;
}

document.addEventListener("click", (e) => {
    for (const menu of document.querySelectorAll("details.menu[open]")) {
        if (!menu.contains(e.target)) {
            menu.open = false;
        }
    }
});
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        for (const menu of document.querySelectorAll("details.menu[open]")) {
            menu.open = false;
            menu.querySelector("summary").focus();
        }
    }
});
