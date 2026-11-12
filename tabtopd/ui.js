// Pieces of the files page's interface, served by tabtopd: the panel in
// the corner that shows uploads, downloads of zips and other changes as
// they go (also on the desktop), dialogs that ask for a name, a folder, a
// yes or a choice, and the menus of each row. Used by files.js, drop.js
// and download.js.

import { glyphs } from "./glyphs.js";
import { copyText } from "./preview-dom.js";
import { storeJSON, storedJSON } from "./stored.js";

export { copyText };

function el(tag, props = {}, ...children) {
    const e = Object.assign(document.createElement(tag), props);
    e.append(...children);
    return e;
}

// The transfers panel: a list of rows, each a change and how it's going,
// under a heading that says how many are still going, with a bar for how
// many of them are done, a button that clears the finished ones, and one
// that folds the list away. It's shown while it has rows. Rows that went
// well go by themselves a minute after they finish; those that failed stay
// until cleared, some with a Retry button. While any are going, the tab's
// title starts with how far they've got, so a tab in the background shows
// it too.
let panel = null;

// TITLE_MARK starts the title while transfers are going; what follows it,
// up to " · ", is put there by showProgress, and replaced each time.
const TITLE_MARK = `${glyphs.sort} `;

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
    const announcements = el("div", { className: "sr-status" });
    announcements.setAttribute("role", "status");
    announcements.setAttribute("aria-live", "polite");
    const summary = el("span", { className: "summary" });
    const overall = el("progress", { className: "overall", max: 1 });
    const clear = el("button", { type: "button", textContent: "Clear finished" });
    const fold = el("button", { type: "button", className: "fold" });
    const completed = el("button", { type: "button", className: "show-completed", textContent: "Show completed" });
    const box = el("section", { id: "transfers", hidden: true },
        el("div", { className: "head" }, el("strong", { textContent: "Transfers" }), summary, completed, clear, fold), overall, list, announcements);
    box.setAttribute("aria-label", "Transfers");
    const update = () => {
        const rows = [...list.children];
        const going = rows.filter((p) => p.classList.contains("going")).length;
        box.hidden = !rows.length;
        document.body.classList.toggle("has-transfers", !box.hidden);
        const failed = rows.filter(p => !p.classList.contains("going") && p.classList.contains("error")).length;
        const done = rows.length - going - failed;
        summary.textContent = going ? `${going} active${failed ? ` · ${failed} failed` : ""}` : failed ? `${failed} failed · ${done} completed` : `${done} completed`;
        box.classList.toggle("has-active", going > 0);
        completed.hidden = !going || !done;
        const showDone = box.classList.contains("show-finished");
        completed.textContent = `${showDone ? "Hide" : "Show"} completed (${done})`;
        completed.setAttribute("aria-expanded", String(showDone));
        overall.hidden = !going;
        overall.value = rows.length ? (rows.length - going) / rows.length : 0;
        clear.disabled = going === rows.length;
        const folded = box.classList.contains("folded");
        fold.textContent = folded ? glyphs.chevronUp : glyphs.chevronDown;
        fold.title = folded ? "Show transfers" : "Hide transfers";
        fold.setAttribute("aria-label", fold.title);
        fold.setAttribute("aria-expanded", String(!folded));
        showProgress(rows);
    };
    completed.addEventListener("click", () => { box.classList.toggle("show-finished"); update(); });
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
    panel = { box, list, announcements, update };
    return panel;
}

// How long a row that went well stays once it's finished, in ms; not
// while the pointer or the focus is in the panel, to read it.
const FINISHED_STAYS = 60000;

function tidyAway(p) {
    const { box, update } = transfers();
    setTimeout(() => {
        if (!p.isConnected) {
            return;
        }
        if (box.matches(":hover, :focus-within")) {
            tidyAway(p);
            return;
        }
        p.remove();
        update();
    }, FINISHED_STAYS);
}

// statusRow adds a row to the transfers panel, and returns it as
// {set(text, error), progress(fraction), text, signal, finish(retry)}: its
// text, marked as an error if error; a bar, shown once progress is given a
// fraction, or null for an amount not known; and, if cancellable, a
// Cancel button that aborts signal. The row counts as going, and keeps
// its button, until finish() is called. A row that's then marked as an
// error stays, with a Retry button if given retry, which removes the row
// and calls it; one that isn't goes after a while.
export function statusRow(text, cancellable = false) {
    const { list, announcements, update } = transfers();
    const span = el("span", { textContent: text });
    const bar = el("progress", { max: 1, hidden: true });
    const destination = el("small", { className: "transfer-destination", hidden: true });
    const p = el("p", { className: "going" }, span, destination, bar);
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
        destination(text) { destination.textContent = text; destination.hidden = !text; },
        set(t, error = false) {
            span.textContent = t;
            p.classList.toggle("error", error);
            update();
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
        finish(retry) {
            button?.remove();
            bar.hidden = true;
            p.classList.remove("going");
            if (!p.classList.contains("error")) {
                tidyAway(p);
            } else if (retry) {
                const again = el("button", { type: "button", className: "retry", textContent: "Retry" });
                again.addEventListener("click", () => {
                    p.remove();
                    update();
                    retry();
                });
                p.append(again);
            }
            announcements.textContent = span.textContent;
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

// labelField is a box for a link's label, starting with value.
function labelField(value = "") {
    const input = el("input", { type: "text", value, maxLength: 100, spellcheck: false, autocomplete: "off",
        placeholder: "Optional: who it's for, or why" });
    input.setAttribute("aria-label", "Label, only for you");
    return input;
}

// The choices last made in the Share and Upload link dialogs, which they
// start with next time, kept in localStorage, which may refuse.
const lastChoices = (key) => storedJSON(key, {});
const keepChoices = (key, choices) => storeJSON(key, choices);
// choose sets the select s to value, if it offers it.
function pick(s, value) {
    if (value !== undefined && [...s.options].some((o) => o.value === String(value))) {
        s.value = String(value);
    }
}

// askShare asks how a share link to name (a folder if dir) should work,
// and resolves to {expires, max}, in seconds and downloads (0 for no
// limit), or null if none is to be made.
export async function askShare(name, dir) {
    const select = (label, options) => {
        const s = el("select", {}, ...options.map(([value, text]) => el("option", { value, textContent: text })));
        s.setAttribute("aria-label", label);
        return s;
    };
    const expires = select("The link lasts", [["3600", "1 hour"], ["86400", "1 day"], ["604800", "7 days"]]);
    expires.value = "86400";
    const max = select("Downloads it allows", [["0", "Any number of downloads"], ["1", "1 download"], ["5", "5 downloads"],
        ["10", "10 downloads"]]);
    const last = lastChoices("tabtop.share-choices");
    pick(expires, last.expires);
    pick(max, last.max);
    const row = (label, field) => el("label", { className: "field" }, el("span", { textContent: label }), field);
    const note = el("p", { className: "hint", textContent: (dir ? "Anyone with the link gets a .zip of what the folder holds when "
        + "they download it, files added later too. " : "Anyone with the link can download the file, as long as it isn't changed or moved. ")
        + "It works without logging in, and it isn't end-to-end encrypted like the rest of TabTop: only HTTPS protects it. "
        + "Opened in a browser, it shows a page with a Download button first, so chat apps and mail scanners that open "
        + "links pasted into them usually don't use up a download; wget and curl get the file at once. "
        + "Ending this session (End…) or Log out everywhere revokes it." });
    const label = labelField();
    if (!(await ask(`Share ${name}${dir ? " (as a .zip)" : ""}?`, "Make link", row("Label", label), row("Lasts", expires), row("Allows", max), note))) {
        return null;
    }
    keepChoices("tabtop.share-choices", { expires: expires.value, max: max.value });
    return { expires: Number(expires.value), max: Number(max.value), label: label.value.trim() };
}

// askUploadLink asks how a link for uploading into the folder name should
// work, and resolves to {expires, max, maxBytes}, in seconds, files (0 for
// no limit) and bytes, or null if none is to be made.
export async function askUploadLink(name) {
    const select = (label, options) => {
        const s = el("select", {}, ...options.map(([value, text]) => el("option", { value, textContent: text })));
        s.setAttribute("aria-label", label);
        return s;
    };
    const expires = select("The link lasts", [["3600", "1 hour"], ["86400", "1 day"], ["604800", "7 days"]]);
    expires.value = "86400";
    const max = select("Files it takes", [["1", "1 file"], ["10", "10 files"], ["100", "100 files"], ["0", "Any number of files"]]);
    max.value = "10";
    const GB = 1024 ** 3;
    const bytes = select("What they may come to in all", [[String(GB / 10), "100 MB"], [String(GB), "1 GB"], [String(10 * GB), "10 GB"],
        [String(100 * GB), "100 GB"]]);
    bytes.value = String(GB);
    const last = lastChoices("tabtop.upload-choices");
    pick(expires, last.expires);
    pick(max, last.max);
    pick(bytes, last.bytes);
    const row = (label, field) => el("label", { className: "field" }, el("span", { textContent: label }), field);
    const note = el("p", { className: "hint", textContent: "Anyone with the link can upload files into this folder, without "
        + "logging in, from a browser or with curl -T. They can't see what's in it, replace anything, or make folders. "
        + "Uploads aren't end-to-end encrypted like the rest of TabTop: only HTTPS protects them. "
        + "Ending this session (End…) or Log out everywhere revokes it." });
    const label = labelField();
    if (!(await ask(`A link for uploading into ${name}?`, "Make link", row("Label", label), row("Lasts", expires), row("Takes", max),
        row("Up to", bytes), note))) {
        return null;
    }
    keepChoices("tabtop.upload-choices", { expires: expires.value, max: max.value, bytes: bytes.value });
    return { expires: Number(expires.value), max: Number(max.value), maxBytes: Number(bytes.value), label: label.value.trim() };
}

// askChangeLinks asks how n links should change together: when they end
// (as now, or from now), and their label (as each is, a new one, or none),
// and resolves to {expires, label, relabel}, or null to leave them.
export async function askChangeLinks(n) {
    const expires = el("select", {}, ...[["0", "As each is now"], ["3600", "1 hour from now"], ["86400", "1 day from now"],
        ["604800", "7 days from now"]].map(([value, textContent]) => el("option", { value, textContent })));
    expires.setAttribute("aria-label", "When they end");
    const label = labelField();
    label.placeholder = "Empty keeps each link's label";
    const clear = el("input", { type: "checkbox" });
    clear.addEventListener("change", () => {
        label.disabled = clear.checked;
    });
    const row = (text, field) => el("label", { className: "field" }, el("span", { textContent: text }), field);
    if (!(await ask(`Change ${n} link${n === 1 ? "" : "s"}?`, "Change them", row("Label", label),
        el("label", { className: "check" }, clear, " Take their labels away"), row("Ends", expires),
        el("p", { className: "hint", textContent: "What each allows stays as it is; Change… beside a link changes that." })))) {
        return null;
    }
    const text = label.value.trim();
    return { expires: Number(expires.value), label: clear.checked ? "" : text, relabel: clear.checked || !!text };
}

// askSessionName asks what to call a session, starting with value, and
// resolves to it ("" for no name), or null to leave it. With current,
// it's this browser's, which keeps the name for its next logins.
export async function askSessionName(value, current) {
    const input = el("input", { type: "text", value, maxLength: 50, spellcheck: false, autocomplete: "off",
        placeholder: "Such as work laptop, or phone" });
    input.setAttribute("aria-label", "The session's name");
    requestAnimationFrame(() => input.select());
    const note = el("p", { className: "hint", textContent: current
        ? "Shown in this list and the activity log. This browser keeps it, for its next logins."
        : "Shown in this list and the activity log, for as long as that session lasts." });
    return (await ask(current ? "What should this browser be called?" : "What should that session be called?", "Name it", input, note))
        ? input.value.trim() : null;
}

// askURL asks for an address to fetch into the folder name, and resolves
// to it, or null if none is given.
export async function askURL(name) {
    const input = el("input", { type: "url", required: true, spellcheck: false, autocomplete: "off", placeholder: "https://…" });
    input.setAttribute("aria-label", "The address to fetch");
    const note = el("p", { className: "hint", textContent: "The server downloads it itself, straight into this folder, "
        + "and carries on if you close this page. It only fetches from the internet, not from this machine or a private "
        + "network (unless WEB_FETCH_PRIVATE=1)." });
    return (await ask(`Fetch a file from the web into ${name}:`, "Fetch", input, note)) ? input.value.trim() : null;
}

// askChangeLink asks how the link l, as Share links lists it,
// should work from now on, with ends saying when it ends now and bytes
// writing a size, and resolves to {expires, max, maxBytes} (expires 0 to
// keep when it ends), or null if it's to stay as it is. Only limits at
// least what it's had already are offered.
export async function askChangeLink(l, ends, bytes) {
    const select = (label, options, value) => {
        const s = el("select", {}, ...options.map(([v, text]) => el("option", { value: String(v), textContent: text })));
        s.setAttribute("aria-label", label);
        s.value = String(value);
        return s;
    };
    const totals = (choices, current, floor) => [...new Set([...choices, current])].filter((n) => n && n >= floor).sort((a, b) => a - b);
    const expires = select("When it ends", [[0, `As now: ${ends}`], [3600, "1 hour from now"], [86400, "1 day from now"],
        [604800, "7 days from now"]], 0);
    const unit = l.upload ? "file" : "download";
    const more = (n) => (l.count ? `, ${n - l.count} more` : "");
    const max = select(l.upload ? "Files it takes" : "Downloads it allows", [
        ...totals(l.upload ? [1, 10, 100] : [1, 5, 10, 20, 50], l.max, Math.max(l.count, 1))
            .map((n) => [n, `${n} ${unit}${n === 1 ? "" : "s"} in all${more(n)}`]),
        [0, `Any number of ${unit}s`]], l.max);
    const label = labelField(l.label ?? "");
    const fields = [["Label", label], ["Ends", expires], [l.upload ? "Takes" : "Allows", max]];
    let size = null;
    if (l.upload) {
        const GB = 1024 ** 3;
        size = select("What they may come to in all", totals([GB / 10, GB, 10 * GB, 100 * GB], l.max_bytes, Math.max(l.bytes ?? 0, 1))
            .map((n) => [n, bytes(n)]), l.max_bytes);
        fields.push(["Up to", size]);
    }
    const row = (label, field) => el("label", { className: "field" }, el("span", { textContent: label }), field);
    const so = l.upload ? `It has taken ${l.count} file${l.count === 1 ? "" : "s"} (${bytes(l.bytes ?? 0)}) so far.`
        : `It has been downloaded ${l.count} time${l.count === 1 ? "" : "s"} so far.`;
    const name = l.path === "." ? "Downloads" : l.path;
    if (!(await ask(`Change the ${l.upload ? "upload " : ""}link to ${name}?`, "Change it", ...fields.map(([label, f]) => row(label, f)),
        el("p", { className: "hint", textContent: `${so} Its address stays the same.` })))) {
        return null;
    }
    return { expires: Number(expires.value), max: Number(max.value), maxBytes: size ? Number(size.value) : 0, label: label.value.trim() };
}

// showLink shows message and url, selected, with Close and Copy link
// buttons, and resolves to whether Copy link was chosen.
export async function showLink(message, url) {
    const input = el("input", { type: "text", value: url, readOnly: true, spellcheck: false });
    input.setAttribute("aria-label", "The link");
    requestAnimationFrame(() => input.select());
    return (await choose(message, [["", "Close"], ["copy", "Copy link"]], input)) === "copy";
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

// Accept a one-based line, optionally followed by a one-based column.
// The editor clamps columns beyond the chosen line to its end.
export async function askLine(current, total) {
    const input = el("input", { type: "text", value: String(current), required: true,
        placeholder: "Line or Line:Column", autocomplete: "off", spellcheck: false });
    input.setAttribute("aria-label", "Line number");
    const position = () => {
        const match = /^(\d+)(?::(\d+))?$/.exec(input.value.trim());
        return match ? { line: Number(match[1]), column: Number(match[2] ?? 1) } : null;
    };
    const validate = () => {
        const at = position();
        input.setCustomValidity(!at || !Number.isSafeInteger(at.line) || at.line < 1 || at.line > total ||
            !Number.isSafeInteger(at.column) || at.column < 1
            ? `Enter a line from 1 to ${total}, optionally followed by :column (starting at 1).` : "");
    };
    input.addEventListener("input", validate);
    validate();
    // The form's first submit button is Cancel. Enter explicitly chooses Go.
    input.addEventListener("keydown", event => {
        if (event.key === "Enter" && !event.isComposing) {
            event.preventDefault();
            validate();
            input.form.requestSubmit(input.form.querySelector("button.primary"));
        }
    });
    requestAnimationFrame(() => input.select());
    return (await ask(`Go to line (1–${total}), optionally :column`, "Go", input)) ? position() : null;
}

// askBookDetails asks for a book's title and author, starting with those
// it has, and a new cover, showing its cover (coverURL, if it has one,
// hasCover, and it could be fetched). The new cover is a picture from
// outside the book, added to it: one in Downloads, chosen with pick()
// (which resolves to it, as a File, or null), or one from this computer,
// dropped on the dialog, pasted into it, or chosen by clicking the cover;
// or a picture already in the book, chosen with pickEpub() (which resolves
// to {item, file}, its path in the book and, to show it, its bytes, or
// null). Rebuild TOC closes this dialog and resolves to
// {rebuildTOC: true} (after a confirm when hasTOC). Else it resolves to
// {title, creator, picture, coverItem, removeItems}: picture,
// the File to add, or coverItem, the path of the book's picture, if either
// was chosen; and removeItems, the pictures to remove from the book (any
// cover pages showing one are made to show the cover); or null for Cancel. uses resolves to what uses each of
// the book's pictures (see epubPictureUse in epub_trim.go), or null;
// thumb(path, signal) to a picture's bytes, to show it (aborting signal
// gives up on it); size(bytes) says a size.
export async function askBookDetails({ title, creator, hasCover, coverURL, pick, pickEpub, hasTOC, uses, thumb, size }) {
    const field = (label, input) => el("label", { className: "field" }, el("span", { textContent: label }), input);
    const titleBox = el("input", { type: "text", value: title, required: true, maxLength: 500, spellcheck: false, autocomplete: "off" });
    const creatorBox = el("input", { type: "text", value: creator, maxLength: 500, spellcheck: false, autocomplete: "off",
        placeholder: "None" });
    const shown = el("img", { className: "cover", alt: "The cover", hidden: !coverURL });
    if (coverURL) {
        shown.src = coverURL;
    }
    const none = el("span", { className: "hint no-cover", textContent: hasCover ? "Not shown" : "No cover", hidden: !!coverURL });
    const which = el("span", { className: "hint cover-name" });
    const clear = el("button", { type: "button", className: "cover-clear", textContent: "Clear new picture", hidden: true });
    // What's chosen: a picture to add (picked), or one in the book
    // (pickedItem), never both; pickedURL shows either.
    let picked = null;
    let pickedItem = null;
    let pickedURL = null;
    const showCover = (src) => {
        if (src) {
            shown.src = src;
            shown.hidden = false;
            none.hidden = true;
        } else {
            shown.removeAttribute("src");
            shown.hidden = true;
            none.hidden = false;
        }
    };
    const setPicture = (file, item) => {
        picked = item ? null : file;
        pickedItem = item;
        if (pickedURL) {
            URL.revokeObjectURL(pickedURL);
        }
        pickedURL = URL.createObjectURL(file);
        showCover(pickedURL);
        which.textContent = item ? `From the book: ${item}` : file.name ? `New: ${file.name}` : "New: a picture pasted";
        clear.hidden = false;
        updateTrim();
    };
    const take = (file) => {
        if (!file || !file.type.startsWith("image/")) {
            return false;
        }
        setPicture(file, null);
        return true;
    };
    clear.addEventListener("click", () => {
        picked = null;
        pickedItem = null;
        if (pickedURL) {
            URL.revokeObjectURL(pickedURL);
            pickedURL = null;
        }
        showCover(coverURL || "");
        which.textContent = "";
        clear.hidden = true;
        updateTrim();
    });
    const fromDownloads = el("button", { type: "button", className: "cover-pick", textContent: "From Downloads…" });
    fromDownloads.addEventListener("click", async () => take(await pick()));
    const fromEpub = el("button", { type: "button", className: "cover-pick-epub", textContent: "From EPUB Content…" });
    fromEpub.addEventListener("click", async () => {
        const got = await pickEpub();
        if (got?.item && got.file) {
            setPicture(got.file, got.item);
        }
    });
    // Clicked (or Enter or Space on it), the cover asks for a picture
    // from this computer, as one dropped or pasted would be.
    const chooser = el("input", { type: "file", accept: "image/*", hidden: true, className: "cover-file" });
    chooser.addEventListener("change", () => {
        take(chooser.files?.[0] ?? null);
        chooser.value = "";
    });
    const cover = el("div", { className: "cover-field", tabIndex: 0,
        title: "Choose a picture from this computer" }, shown, none,
        el("span", { className: "hint cover-drop-hint", textContent: "Drop, paste or click" }), chooser);
    cover.setAttribute("role", "button");
    cover.setAttribute("aria-label", "The cover: choose a picture from this computer, or drop or paste one");
    cover.addEventListener("click", (e) => {
        if (e.target !== chooser) {
            chooser.click();
        }
    });
    cover.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            chooser.click();
        }
    });
    const note = el("p", { className: "hint cover-note", textContent: hasCover
        ? "A picture from the book becomes the cover where it is; any other is added to the book. The old cover stays in it."
        : "A picture from the book becomes the cover where it is; any other is added to the book as its cover." });
    // Trimming: the old cover, once a new one's chosen and only its cover
    // pages use it, and pictures nothing uses, chosen with Cleanup Pics…: all
    // removed on Save. Known once uses resolves.
    let report = null;
    let removing = new Set();
    // Whether Cleanup Pics… has been through: if so, removing is what was
    // chosen, even if that's nothing, and isn't ticked afresh.
    let picturesChosen = false;
    const oldCover = el("input", { type: "checkbox", checked: true, className: "remove-old-cover" });
    const oldCoverText = el("span");
    const oldCoverRow = el("label", { className: "check remove-old-cover-row", hidden: true }, oldCover, oldCoverText);
    const picturesButton = el("button", { type: "button", className: "book-pictures", textContent: "Cleanup Pics…", disabled: true,
        title: "Remove pictures nothing in the book uses" });
    const trimText = el("span", { className: "hint trim-summary" });
    const oldCoverUse = () => report?.find((u) => u.cover) ?? null;
    const removable = (u) => (u.users ?? []).every((f) => (u.cover_pages ?? []).includes(f));
    // A cover to show on cover pages instead: the book's, or a new one.
    const coverToShow = () => !!picked || !!pickedItem || !!report?.some((u) => u.cover);
    const removingOldCover = () => !oldCoverRow.hidden && oldCover.checked;
    function updateTrim() {
        // Ticked to go, but used by cover pages, with no cover now for
        // them to show instead (the new one cleared): kept after all, or
        // the save would refuse to remove it, and fail.
        if (report) {
            removing = new Set([...removing].filter((p) => {
                const u = report.find((x) => x.path === p);
                return u && canGo(u, coverToShow());
            }));
        }
        const old = oldCoverUse();
        const newCover = !!picked || !!pickedItem && pickedItem !== old?.path;
        oldCoverRow.hidden = !(old && newCover && removable(old));
        if (!oldCoverRow.hidden) {
            const pages = old.cover_pages?.length ?? 0;
            oldCoverText.textContent = `Remove the old cover from the book (${size(old.bytes)})` +
                (pages ? `; ${pages === 1 ? "its cover page shows" : "its cover pages show"} the new one` : "");
        }
        const chosen = [...removing].filter((p) => p !== pickedItem);
        const total = chosen.reduce((n, p) => n + (report?.find((u) => u.path === p)?.bytes ?? 0), 0);
        trimText.textContent = chosen.length ? `${chosen.length} picture${chosen.length === 1 ? "" : "s"} removed on Save (${size(total)})` : "";
        if (report) {
            picturesButton.disabled = !report.some((u) => canGo(u, coverToShow()) && u.path !== pickedItem);
            picturesButton.title = picturesButton.disabled ? "Every picture in the book is used" : "Remove pictures nothing in the book uses";
        }
    }
    Promise.resolve(uses).then((r) => {
        report = Array.isArray(r) ? r : null;
        if (!report) {
            picturesButton.title = "The book's pictures couldn't be read";
        }
        updateTrim();
    }, () => (picturesButton.title = "The book's pictures couldn't be read"));
    picturesButton.addEventListener("click", async () => {
        const got = await askPictures(report, picturesChosen ? removing : null, pickedItem, coverToShow(), thumb, size);
        if (got) {
            removing = got;
            picturesChosen = true;
            updateTrim();
        }
    });
    const body = el("div", { className: "book-edit" }, cover,
        el("div", { className: "book-meta" }, field("Title", titleBox), field("Author", creatorBox),
            el("div", { className: "cover-actions" }, fromDownloads, fromEpub, clear), which, note, oldCoverRow,
            trimText));
    const asking = choose("The book's details", [["", "Cancel"], ["ok", "Save"]], body);
    // A picture dropped on the dialog, or pasted into it, is the new cover,
    // not an upload into the folder, as one dropped on the page is.
    const dialog = body.closest("dialog");
    dialog.classList.add("book-details");
    const rebuild = el("button", { type: "button", className: "rebuild-toc", textContent: "Rebuild TOC",
        title: "Remake the contents list from the chapters' headings" });
    rebuild.addEventListener("click", async () => {
        if (rebuild.disabled || dialog.returnValue) {
            return;
        }
        rebuild.disabled = true;
        try {
            const dirty = titleBox.value !== title || creatorBox.value !== creator || !!picked || !!pickedItem || removing.size > 0;
            const parts = [];
            if (hasTOC) {
                parts.push("Replace the book's contents list with one made from its headings?");
            }
            if (dirty) {
                parts.push("Title, author and cover changes in this dialog won't be saved.");
            }
            if (parts.length && !(await askYes(parts.join(" "), "Rebuild"))) {
                return;
            }
            dialog.close("rebuild");
        } finally {
            if (dialog.open) {
                rebuild.disabled = false;
            }
        }
    });
    // The book-wide tools, left of Cancel and Save: Rebuild TOC, and
    // Cleanup Pics… beside it.
    dialog.querySelector(".buttons")?.prepend(rebuild, picturesButton);
    titleBox.focus();
    titleBox.select();
    const pictureIn = (list) => [...(list ?? [])].find((f) => f.type.startsWith("image/")) ?? null;
    for (const type of ["dragenter", "dragover", "dragleave"]) {
        dialog.addEventListener(type, (e) => {
            e.stopPropagation();
            if (type === "dragover" && e.dataTransfer?.types.includes("Files")) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
                cover.classList.add("dropping");
            } else if (type === "dragleave" && !dialog.contains(e.relatedTarget)) {
                cover.classList.remove("dropping");
            }
        });
    }
    dialog.addEventListener("drop", (e) => {
        e.stopPropagation();
        cover.classList.remove("dropping");
        // Only files: text dragged into a box goes in, as ever.
        if (e.dataTransfer?.types.includes("Files")) {
            e.preventDefault();
            take(pictureIn(e.dataTransfer.files));
        }
    });
    dialog.addEventListener("paste", (e) => {
        // Pasted into the title or author: text, even if what was copied
        // came with a picture, as copies from documents and pages often do.
        if (e.target.closest?.("input, textarea")) {
            return;
        }
        const picture = pictureIn(e.clipboardData?.files);
        if (picture && take(picture)) {
            e.preventDefault();
        }
    });
    const result = await asking;
    if (pickedURL) {
        URL.revokeObjectURL(pickedURL);
    }
    if (result === "rebuild") {
        return { rebuildTOC: true };
    }
    if (result !== "ok") {
        return null;
    }
    const removeItems = [...removing].filter((p) => p !== pickedItem);
    if (removingOldCover()) {
        removeItems.push(oldCoverUse().path);
    }
    return { title: titleBox.value, creator: creatorBox.value, picture: picked, coverItem: pickedItem, removeItems };
}

// canGo reports whether the picture u (as epubPictureUse has it) can be
// removed: not the cover, and used by nothing but cover pages, which show
// the cover instead, if there's one (hasCover).
function canGo(u, hasCover) {
    const users = u.users ?? [], pages = u.cover_pages ?? [];
    return !u.cover && users.every((f) => pages.includes(f)) && (!users.length || hasCover);
}

// askPictures lists the book's pictures (report, as askBookDetails has
// it), those that can go ticked to be removed (or as chosen, a set, if
// they were, even if none; null if not yet), and resolves to the set of those ticked, or null for Cancel.
// Those in use, and the cover (and coverItem, the new one), can't be.
async function askPictures(report, chosen, coverItem, hasCover, thumb, size) {
    const free = (u) => u.path !== coverItem && canGo(u, hasCover);
    const sorted = [...report].sort((a, b) => Number(free(b)) - Number(free(a)) || b.bytes - a.bytes);
    const tick = new Set(chosen ?? sorted.filter(free).map((u) => u.path));
    const summary = el("p", { className: "hint pictures-summary" });
    const update = () => {
        const total = sorted.filter((u) => tick.has(u.path)).reduce((n, u) => n + u.bytes, 0);
        summary.textContent = tick.size ? `Remove ${tick.size} picture${tick.size === 1 ? "" : "s"}, saving about ${size(total)}.` : "Nothing ticked to remove.";
    };
    // Each thumbnail fetched when its row comes into view, a few at a time;
    // once the dialog's closed, no more, and those coming given up on.
    const urls = [];
    const waiting = [];
    const closing = new AbortController();
    let fetching = 0;
    const next = () => {
        while (fetching < 3 && waiting.length && !closing.signal.aborted) {
            const [img, path] = waiting.shift();
            fetching++;
            thumb(path, closing.signal).then((blob) => {
                if (img.isConnected && !closing.signal.aborted) {
                    const url = URL.createObjectURL(blob);
                    urls.push(url);
                    img.src = url;
                }
            }, () => img.classList.add("none")).finally(() => {
                fetching--;
                next();
            });
        }
    };
    const seen = new IntersectionObserver((entries) => {
        for (const e of entries) {
            if (e.isIntersecting) {
                seen.unobserve(e.target);
                waiting.push([e.target, e.target.dataset.path]);
            }
        }
        next();
    });
    const users = (u) => {
        const list = u.users ?? [];
        const names = list.slice(0, 2).map((f) => f.split("/").pop()).join(", ");
        return list.length > 2 ? `Used by ${names} and ${list.length - 2} more` : `Used by ${names}`;
    };
    const rows = sorted.map((u) => {
        const box = el("input", { type: "checkbox", checked: tick.has(u.path), disabled: !free(u) });
        box.addEventListener("change", () => {
            box.checked ? tick.add(u.path) : tick.delete(u.path);
            update();
        });
        const img = el("img", { className: "picture-thumb", alt: "" });
        img.dataset.path = u.path;
        seen.observe(img);
        const pages = u.cover_pages?.length ?? 0;
        const why = u.cover ? "The cover" : u.path === coverItem ? "The new cover"
            : free(u) && pages ? `Only on ${pages === 1 ? "its cover page, which will show" : "its cover pages, which will show"} the cover instead`
            : free(u) ? "Not used" : users(u);
        return el("li", { className: free(u) ? "free" : "used" }, el("label", {}, box, img,
            el("span", { className: "picture-name", textContent: u.path, title: u.path }),
            el("span", { className: "hint picture-size", textContent: size(u.bytes) }),
            el("span", { className: "hint picture-why", textContent: why })));
    });
    update();
    const list = el("ul", { className: "pictures-list" }, ...rows);
    const asking = choose("The book's pictures: those nothing uses (but a cover page) can be removed", [["", "Cancel"], ["ok", "Done"]], list, summary);
    list.closest("dialog").classList.add("book-pictures");
    const result = await asking;
    seen.disconnect();
    waiting.length = 0;
    closing.abort();
    for (const url of urls) {
        URL.revokeObjectURL(url);
    }
    return result === "ok" ? tick : null;
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
    const summary = el("summary", { textContent: glyphs.menu, title: label });
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

