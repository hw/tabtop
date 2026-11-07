// Pieces of the files page's interface, served by tabtopd: the panel in
// the corner that shows uploads, downloads of zips and other changes as
// they go (also on the desktop), dialogs that ask for a name, a folder, a
// yes or a choice, and the menus of each row. Used by files.js, drop.js
// and download.js.

import { glyphs } from "./glyphs.js";

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
function lastChoices(key) {
    try {
        return JSON.parse(localStorage.getItem(key) ?? "{}") ?? {};
    } catch {
        return {};
    }
}
function keepChoices(key, choices) {
    try {
        localStorage.setItem(key, JSON.stringify(choices));
    } catch {
        // They start as they always do, then.
    }
}
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

// askLine accepts a one-based line number within the current text.
export async function askLine(current, total) {
    const input = el("input", { type: "number", min: "1", max: String(total), step: "1",
        value: String(current), required: true });
    input.setAttribute("aria-label", "Line number");
    requestAnimationFrame(() => input.select());
    return (await ask(`Go to line (1–${total})`, "Go", input)) ? Number(input.value) : null;
}

// askBookDetails asks for a book's title and author, starting with those
// it has, and a new cover picture, showing its cover (coverURL, if it has
// one, hasCover, and it could be fetched), or why it can't be changed
// (coverNote). The picture is one in Downloads, chosen with pick() (which
// resolves to it, as a File, or null), one already in the book, chosen with
// pickEpub() the same way, or one dropped on the dialog or pasted into it,
// from this computer. Rebuild contents closes this dialog and resolves to
// {rebuildTOC: true} (after a confirm when hasTOC). Else it resolves to
// {title, creator, picture}, picture null if none was chosen, or null for
// Cancel.
export async function askBookDetails({ title, creator, hasCover, coverURL, coverNote, pick, pickEpub, hasTOC }) {
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
    let picked = null;
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
    const take = (file) => {
        if (coverNote || !file || !file.type.startsWith("image/")) {
            return false;
        }
        picked = file;
        if (pickedURL) {
            URL.revokeObjectURL(pickedURL);
        }
        pickedURL = URL.createObjectURL(file);
        showCover(pickedURL);
        which.textContent = file.name ? `New: ${file.name}` : "New: a picture pasted";
        clear.hidden = false;
        return true;
    };
    clear.addEventListener("click", () => {
        picked = null;
        if (pickedURL) {
            URL.revokeObjectURL(pickedURL);
            pickedURL = null;
        }
        showCover(coverURL || "");
        which.textContent = "";
        clear.hidden = true;
    });
    const fromDownloads = el("button", { type: "button", className: "cover-pick", textContent: "From Downloads…", disabled: !!coverNote });
    fromDownloads.addEventListener("click", async () => take(await pick()));
    const fromEpub = el("button", { type: "button", className: "cover-pick-epub", textContent: "From EPUB Content…", disabled: !!coverNote });
    fromEpub.addEventListener("click", async () => take(await pickEpub()));
    const cover = el("div", { className: "cover-field" + (coverNote ? " locked" : "") }, shown, none,
        ...(coverNote ? [] : [el("span", { className: "hint cover-drop-hint", textContent: "Drop or paste" })]));
    const note = el("p", { className: "hint cover-note", textContent: coverNote || (hasCover
        ? "A new picture replaces the cover, as the same type."
        : "A picture chosen is added as the cover.") });
    const body = el("div", { className: "book-edit" }, cover,
        el("div", { className: "book-meta" }, field("Title", titleBox), field("Author", creatorBox),
            el("div", { className: "cover-actions" }, fromDownloads, fromEpub, clear), which, note));
    const asking = choose("The book's details", [["", "Cancel"], ["ok", "Save"]], body);
    // A picture dropped on the dialog, or pasted into it, is the new cover,
    // not an upload into the folder, as one dropped on the page is.
    const dialog = body.closest("dialog");
    dialog.classList.add("book-details");
    const rebuild = el("button", { type: "button", className: "rebuild-toc", textContent: "Rebuild contents" });
    rebuild.addEventListener("click", async () => {
        if (rebuild.disabled || dialog.returnValue) {
            return;
        }
        rebuild.disabled = true;
        try {
            const dirty = titleBox.value !== title || creatorBox.value !== creator || !!picked;
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
    dialog.querySelector(".buttons")?.prepend(rebuild);
    titleBox.focus();
    titleBox.select();
    const pictureIn = (list) => [...(list ?? [])].find((f) => f.type.startsWith("image/")) ?? null;
    for (const type of ["dragenter", "dragover", "dragleave"]) {
        dialog.addEventListener(type, (e) => {
            e.stopPropagation();
            if (type === "dragover" && e.dataTransfer?.types.includes("Files")) {
                e.preventDefault();
                e.dataTransfer.dropEffect = coverNote ? "none" : "copy";
                if (!coverNote) {
                    cover.classList.add("dropping");
                }
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
    return result === "ok" ? { title: titleBox.value, creator: creatorBox.value, picture: picked } : null;
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

// copyText puts text on the clipboard: with the clipboard API where the
// browser has it (over HTTPS or on localhost) and allows it, else the old
// way.
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
