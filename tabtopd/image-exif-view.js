// The EXIF dialog: what a photo says of itself, the things most people look
// for first (when, with what, where), then every field, by group; and, where
// the image can be saved, each changed where it is, with the control that
// suits it. What's read, asked and checked is image-exif-form.js's; what's
// saved, image-exif.js's, which leaves the compressed image as it was.
import { el, maximizeButton, showModal } from "./preview-dom.js";
import { iconSVG } from "./glyphs.js";
import { exifOf, replaceExif, metadataOf } from "./image-meta.js";
import { readExif, editExif, exifCatalog, exifTypeNames, exifEditValue } from "./image-exif.js";
import { HEIF_TYPES } from "./image-heif.js";
import { ORIENTATIONS, HINTS, fieldId, fieldKind, fieldError, friendlyValue, exifSummary, sensitive, identityRows, locationText, parseLocation, locationEdits,
    dateToInput, inputToDate, shiftDate, parseShift, pendingEdits } from "./image-exif-form.js";

const GROUPS = { Image: "Image", EXIF: "Camera settings", GPS: "Location", Interop: "Interoperability", Thumbnail: "Thumbnail" };
const DATES = ["Image:306", "EXIF:36867", "EXIF:36868"];
const hexTag = (tag) => `0x${tag.toString(16).padStart(4, "0")}`;
const glyph = (name, title, className) => {
    const b = el("button", { type: "button", className: `${className} glyph`, title, ariaLabel: title });
    b.innerHTML = iconSVG(name);
    return b;
};

export function openExif({ name, blob, save }) {
    const focus = document.activeElement, controller = new AbortController();
    let model = null, bytes = null, editable = false, saving = false, stopped = false, asking = false, customs = 0, hasXMP = false;
    // What's been changed and not saved: a field's id to {group, tag, type,
    // value, format, remove, isNew, name, error}; and the two that take more
    // than a field away. open: the fields with their editors showing, each
    // with read(), which takes what its controls hold now.
    const pending = new Map(), open = new Map();
    let removeLocation = false, stripAll = false;

    const status = el("p", { className: "hint exif-status", textContent: "Loading EXIF…", role: "status" });
    const content = el("div", { className: "exif-content" });
    const close = glyph("close-circle", "Close (Esc)", "close-glyph");
    close.classList.remove("glyph");
    const head = el("div", { className: "exif-head" }, el("strong", { textContent: `EXIF — ${name}` }), close);
    const changes = el("span", { className: "exif-changes" });
    const store = el("button", { type: "button", className: "exif-save", textContent: "Save" });
    const discard = el("button", { type: "button", className: "exif-discard", textContent: "Discard" });
    const keep = el("button", { type: "button", className: "exif-keep", textContent: "Keep editing", hidden: true });
    const actions = el("div", { className: "exif-actions", hidden: true }, changes, keep, discard, store);
    const dialog = el("dialog", { className: "image-exif", ariaLabel: `EXIF information for ${name}` }, head, status, content, actions);
    close.before(maximizeButton(dialog, "exif-maximize"));

    const say = (text, error = false) => {
        status.classList.toggle("error", error);
        status.textContent = text;
    };
    // (Closed: see showModal below.)
    let finish = () => {};

    // A field as it stands: the row it was read as (null: a new one), what's
    // pending for it, and so its group, tag, type and name.
    const original = (id) => model.rows.find((r) => fieldId(r) === id) ?? null;
    const fieldOf = (id) => {
        const row = original(id), change = pending.get(id);
        return { id, row, change, group: change?.group ?? row.group, tag: change?.tag ?? row.tag, type: change?.type ?? row.type, name: row?.name ?? change.name,
            format: change?.format ?? (row ? exifEditValue(model, row).format : "value") };
    };
    const valueOf = (id) => pending.get(id)?.value ?? exifEditValue(model, original(id)).value;
    // Every field's row as it would then be read, for the summary and for
    // values said together (a latitude with its side of the equator).
    const rowsNow = () => {
        if (stripAll) return model.rows.filter((r) => fieldId(r) === "Image:274");
        const rows = model.rows.filter((r) => !(pending.get(fieldId(r))?.remove) && !(removeLocation && r.group === "GPS"))
            .map((r) => { const c = pending.get(fieldId(r)); return c ? { ...r, type: c.type, value: c.value } : r; });
        for (const [id, c] of pending) if (c.isNew && !c.remove && Number.isInteger(c.tag) && !(removeLocation && c.group === "GPS")) rows.push({ group: c.group, tag: c.tag, type: c.type, value: c.value, name: c.name, id });
        return rows;
    };
    const dirty = () => pending.size > 0 || removeLocation || stripAll;
    const setChange = (id, change) => {
        const row = original(id);
        // (As it was: no change at all.)
        if (row && !change.remove && change.type === row.type && change.value === exifEditValue(model, row).value) pending.delete(id);
        else pending.set(id, change);
    };

    function showActions() {
        const list = [...pending.values()], count = (test) => list.filter(test).length;
        const parts = [[count((c) => !c.isNew && !c.remove), "changed"], [count((c) => c.isNew && !c.remove), "added"], [count((c) => c.remove && !c.isNew), "removed"]]
            .filter(([n]) => n).map(([n, what]) => `${n} ${what}`);
        if (removeLocation) parts.push("location removed");
        actions.hidden = !dirty() && !asking;
        changes.textContent = asking ? "Close without saving these changes?" : stripAll ? "Everything but the orientation will be removed." : parts.join(", ");
        keep.hidden = !asking;
        discard.textContent = asking ? "Discard and close" : "Discard";
        store.hidden = asking;
        // (Not held back by what's wrong: saving says where.)
        store.disabled = saving;
    }

    // The editor of one field, in its row: the control that suits it over
    // the value as it's stored, with its type (and, for a field that isn't
    // in the list of those known, its group and tag) under Advanced.
    function editorOf(id, cell, before) {
        const field = fieldOf(id), kind = fieldKind(field, field.format), custom = field.change?.custom;
        const raw = el("textarea", { className: "exif-field-value", rows: kind === "bytes" || kind === "comment" ? 3 : 1, value: valueOf(id), spellcheck: false,
            maxLength: 3 * 1024 * 1024, ariaLabel: `${field.name} value` });
        const type = el("select", { className: "exif-type", ariaLabel: "Value type" }, ...Object.entries(exifTypeNames).map(([value, label]) => el("option", { value, textContent: label })));
        type.value = String(field.type);
        const group = el("select", { className: "exif-group-choice", ariaLabel: "Field group" }, ...[...new Set(["Image", "EXIF", "GPS", "Interop", ...model.directories.map((d) => d.group)])].map((g) => el("option", { value: g, textContent: g })));
        group.value = field.group;
        const tag = el("input", { type: "text", className: "exif-tag", value: Number.isInteger(field.tag) ? hexTag(field.tag) : "", placeholder: "0x1234", ariaLabel: "Tag ID" });
        const error = el("small", { className: "exif-field-error", role: "alert" });
        const hint = el("small", { className: "hint" });
        // (What's wrong with it is said once it's been typed in, or saving was tried.)
        let touched = !!field.change?.touched;
        // The control most people want, kept in step with the stored value.
        let friendly = null;
        if (kind === "orientation") {
            friendly = el("select", { className: "exif-friendly", ariaLabel: "Orientation" }, ...Object.entries(ORIENTATIONS).map(([value, label]) => el("option", { value, textContent: label })));
            friendly.value = raw.value.trim();
            friendly.addEventListener("change", () => { raw.value = friendly.value; changed(); });
        } else if (kind === "date" && dateToInput(raw.value)) {
            friendly = el("input", { type: "datetime-local", step: "1", className: "exif-friendly", value: dateToInput(raw.value), ariaLabel: `${field.name}, as a date and time` });
            friendly.addEventListener("input", () => { const text = inputToDate(friendly.value); if (text) { raw.value = text; changed(); } });
        }
        const read = () => {
            const next = { ...(pending.get(id) ?? {}), group: custom ? group.value : field.group, tag: custom ? (/^(?:0x[0-9a-f]{1,4}|\d{1,5})$/i.test(tag.value.trim()) ? Number(tag.value.trim()) : NaN) : field.tag,
                type: Number(type.value), value: raw.value, format: field.format, isNew: !field.row, name: field.name, custom, remove: false, touched };
            next.error = fieldError(next, next.value);
            setChange(id, next);
            return next;
        };
        function changed() {
            touched = true;
            const next = read();
            error.textContent = next.error ?? "";
            raw.setAttribute("aria-invalid", String(!!next.error));
            if (friendly && document.activeElement !== friendly) friendly.value = kind === "orientation" ? raw.value.trim() : dateToInput(raw.value) ?? friendly.value;
            hint.textContent = friendly ? note : HINTS[fieldKind({ ...field, type: Number(type.value) }, field.format)] ?? "";
            showActions();
        }
        for (const control of [raw, type, group, tag]) control.addEventListener("input", changed);
        // (Under a picker, how the value is written isn't needed: it's under Advanced, with the value as it's stored.)
        // (A HEIC's or AVIF's turn is its own, set apart from its EXIF: browsers, and this, go by that.)
        const note = kind === "orientation" && HEIF_TYPES.has(blob.type) ? "In a HEIC or AVIF file this is only noted: it doesn't turn the picture, whose own rotation does." : "";
        hint.textContent = friendly ? note : HINTS[kind] ?? "";
        if (touched) error.textContent = field.change.error ?? "";
        const done = el("button", { type: "button", className: "exif-done", textContent: "Done" });
        done.addEventListener("click", () => { read(); open.delete(id); render(id); });
        const advanced = el("details", { className: "exif-advanced", open: !!custom || !friendly && kind !== "text" && kind !== "comment" && kind !== "numbers" },
            el("summary", { textContent: "Advanced" }),
            el("div", { className: "exif-field-spec" }, ...(custom ? [el("label", {}, "Group", group), el("label", {}, "Tag", tag)] : []), el("label", {}, "Type", type)),
            ...(friendly ? [el("label", { className: "exif-raw" }, "As stored", raw)] : []));
        cell.replaceChildren(el("div", { className: "exif-editor" }, friendly ?? raw, error, hint, el("div", { className: "exif-editor-tools" }, advanced, done)));
        open.set(id, { read, before, focus: () => (custom && !tag.value ? tag : friendly ?? raw).focus(), cell,
            fail(message) { touched = true; error.textContent = message; raw.setAttribute("aria-invalid", "true"); } });
    }

    // One field's row: its name, its value as it's read (or its editor), and
    // what can be done with it.
    function rowOf(id, rows) {
        const field = fieldOf(id), change = field.change, managed = fieldKind(field, field.format) === "managed";
        const removed = !!change?.remove || removeLocation && field.group === "GPS" || stripAll && id !== "Image:274";
        const shown = change && !change.remove ? { group: field.group, tag: field.tag, type: field.type, value: change.value } : field.row;
        const value = el("td", { className: "exif-value" });
        const text = shown ? friendlyValue(shown, rows) : "";
        value.textContent = text === "" && change?.isNew ? "(empty)" : text;
        const tools = el("td", { className: "exif-row-tools" });
        const tr = el("tr", { className: ["exif-row", removed ? "removed" : "", change && !change.remove ? (change.isNew ? "added" : "changed") : "", managed ? "managed" : ""].filter(Boolean).join(" ") },
            el("th", { scope: "row" }, field.name, el("small", { className: "hint exif-tag-id", textContent: Number.isInteger(field.tag) ? hexTag(field.tag) : "" })), value, tools);
        tr.dataset.field = id;
        tr.dataset.find = `${field.name} ${Number.isInteger(field.tag) ? hexTag(field.tag) : ""} ${text} ${field.row?.value ?? ""}`.toLowerCase();
        if (!editable || managed || stripAll || removeLocation && field.group === "GPS") {
            if (managed) value.title = "Maintained automatically, to keep the embedded thumbnail right.";
            return tr;
        }
        if (open.has(id) && !removed) editorOf(id, value, open.get(id).before);
        else if (!removed) {
            value.tabIndex = 0;
            value.setAttribute("role", "button");
            value.title = "Change this value";
            const begin = () => { open.set(id, { before: pending.has(id) ? { ...pending.get(id) } : null }); render(id); };
            value.addEventListener("click", begin);
            value.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); begin(); } });
        }
        if (change) {
            const undo = glyph("undo", change.isNew ? "Don't add this field" : change.remove ? "Keep this field" : "Put its value back", "exif-field-undo");
            undo.addEventListener("click", () => { pending.delete(id); open.delete(id); render(); });
            tools.append(undo);
        }
        if (!change?.remove && !change?.isNew) {
            const remove = glyph("trash", `Remove ${field.name}`, "exif-field-remove");
            remove.addEventListener("click", () => { open.delete(id); pending.set(id, { group: field.group, tag: field.tag, type: field.type, value: "", name: field.name, remove: true }); render(); });
            tools.append(remove);
        }
        return tr;
    }

    // The few things most people look for; with the place, and the dates
    // together, changed from here.
    function summaryOf(rows) {
        const summary = exifSummary(rows), items = [];
        const line = (label, text, ...more) => items.push(el("dt", { textContent: label }), el("dd", {}, text ?? el("span", { className: "hint", textContent: "Not recorded" }), ...more));
        const link = (text, className, act) => { const b = el("button", { type: "button", className: `exif-link ${className}`, textContent: text }); b.addEventListener("click", act); return b; };
        const can = editable && !stripAll;
        const dates = DATES.filter((id) => (original(id) || pending.get(id)?.isNew) && !pending.get(id)?.remove);
        const shift = el("input", { type: "text", className: "exif-shift", placeholder: "+1h 30m", ariaLabel: "Shift every date by", size: 9 });
        const shiftNote = el("small", { className: "exif-field-error", role: "alert" });
        const applyShift = () => {
            const seconds = parseShift(shift.value), moved = dates.map((id) => [id, shiftDate(valueOf(id), seconds)]).filter(([, text]) => text);
            if (seconds == null || !moved.length) { shiftNote.textContent = seconds == null ? "Say how far, such as +1h 30m, -2d or 45s." : "There's no date that can be shifted."; return; }
            for (const [id, text] of moved) { const f = fieldOf(id); open.delete(id); setChange(id, { ...(pending.get(id) ?? {}), group: f.group, tag: f.tag, type: f.type, value: text, format: "value", isNew: !f.row, name: f.name, remove: false, error: null }); }
            render();
        };
        shift.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); applyShift(); } });
        const shifting = el("span", { className: "exif-shift-tools", hidden: true }, el("label", {}, "By ", shift), link("Shift", "exif-apply-shift", applyShift), shiftNote);
        line("Taken", summary.taken, ...(can && summary.takenRow ? [link("Change", "exif-change-taken", () => { const id = summary.takenRow.id ?? fieldId(summary.takenRow); open.set(id, { before: pending.has(id) ? { ...pending.get(id) } : null }); render(id); })] : []),
            ...(can && dates.length ? [link(dates.length > 1 ? "Shift all dates…" : "Shift…", "exif-show-shift", () => { shifting.hidden = !shifting.hidden; if (!shifting.hidden) shift.focus(); }), shifting] : []));
        line("Camera", summary.camera);
        line("Exposure", summary.exposure);
        const place = el("input", { type: "text", className: "exif-place", placeholder: "1.3521, 103.8198", ariaLabel: "Latitude and longitude", value: summary.location ? `${summary.location.latitude.toFixed(6).replace(/\.?0+$/, "")}, ${summary.location.longitude.toFixed(6).replace(/\.?0+$/, "")}` : "" });
        const placeNote = el("small", { className: "exif-field-error", role: "alert" });
        const applyPlace = () => {
            const where = parseLocation(place.value);
            if (!where) { placeNote.textContent = "Give a latitude and a longitude, such as 1.3521, 103.8198."; return; }
            removeLocation = false;
            for (const edit of locationEdits(where, model.rows)) {
                const id = fieldId(edit), row = original(id);
                open.delete(id);
                setChange(id, { ...edit, format: "value", isNew: !row, name: row?.name ?? exifCatalog.find((f) => f.group === "GPS" && f.tag === edit.tag)?.label ?? `Tag ${hexTag(edit.tag)}`, remove: false, error: null });
            }
            render();
        };
        place.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); applyPlace(); } });
        const placing = el("span", { className: "exif-place-tools", hidden: true }, place, link("Set", "exif-apply-place", applyPlace), placeNote);
        line("Location", removeLocation ? el("span", { className: "exif-going", textContent: "Will be removed" }) : summary.location ? locationText(summary.location) : null,
            ...(can ? [link(summary.location && !removeLocation ? "Change" : "Set", "exif-change-place", () => { placing.hidden = !placing.hidden; if (!placing.hidden) place.focus(); }), placing] : []));
        line("Rotation", summary.rotation);
        return el("dl", { className: "exif-summary" }, ...items);
    }

    // What says where it was taken, or who took it with which camera, taken
    // out in one go.
    function privacyOf() {
        const has = sensitive(model.rows), buttons = [];
        const toggle = (text, className, pressed, title, act) => {
            const b = el("button", { type: "button", className: `exif-privacy-action ${className}`, textContent: text, title });
            b.setAttribute("aria-pressed", String(pressed));
            b.addEventListener("click", act);
            buttons.push(b);
        };
        if (has.location) toggle("Remove location", "exif-remove-location", removeLocation, "Takes out the whole GPS group: where, how high, and when by its clock.", () => {
            removeLocation = !removeLocation;
            if (removeLocation) for (const [id, c] of [...pending]) if (c.group === "GPS") { pending.delete(id); open.delete(id); }
            render();
        });
        const identity = identityRows(model.rows), all = identity.length > 0 && identity.every((r) => pending.get(fieldId(r))?.remove);
        if (has.identity) toggle("Remove serial numbers and owner", "exif-remove-identity", all, `Takes out: ${identity.map((r) => r.name).join(", ")}. (The maker's notes often repeat the serial number.)`, () => {
            for (const r of identity) { const id = fieldId(r); open.delete(id); if (all) pending.delete(id); else pending.set(id, { group: r.group, tag: r.tag, type: r.type, value: "", name: r.name, remove: true }); }
            render();
        });
        if (model.rows.length) toggle("Remove everything but orientation", "exif-strip", stripAll, "Writes a new EXIF block with the orientation alone: nothing of the old one, its thumbnail included, is kept.", () => { stripAll = !stripAll; open.clear(); render(); });
        if (!buttons.length) return "";
        return el("div", { className: "exif-privacy" }, el("span", { className: "hint", textContent: "Privacy" }), ...buttons,
            ...(hasXMP ? [el("small", { className: "hint exif-xmp", textContent: "This image also has XMP metadata, which can say where and who too, and isn't changed here." })] : []));
    }

    // Adding a field: one of those known, found by typing some of its name,
    // or any other by its tag.
    function addingOf() {
        const present = new Set([...model.rows.map(fieldId), ...pending.keys()]), offered = exifCatalog.filter((f) => !present.has(fieldId(f)) && fieldKind(f) !== "managed");
        const label = (f) => `${f.group} — ${f.label} (${hexTag(f.tag)})`;
        const list = el("datalist", { id: `exif-fields-${Math.random().toString(36).slice(2)}` }, ...offered.map((f) => el("option", { value: label(f) })));
        const choice = el("input", { type: "text", className: "exif-add-choice", placeholder: "Add a field…", ariaLabel: "Add a field: type some of its name", autocomplete: "off" });
        choice.setAttribute("list", list.id);
        const add = (id, change) => { pending.set(id, change); open.set(id, { before: null }); render(id); };
        const chosen = () => {
            const f = offered.find((o) => label(o) === choice.value) ?? offered.find((o) => o.label.toLowerCase() === choice.value.trim().toLowerCase());
            if (f) add(fieldId(f), { group: f.group, tag: f.tag, type: f.type, value: "", format: f.group === "EXIF" && f.tag === 0x9286 ? "comment" : f.type === 7 ? "hex" : "value", isNew: true, name: f.label, remove: false, error: null });
        };
        choice.addEventListener("change", chosen);
        choice.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); chosen(); } });
        const custom = el("button", { type: "button", className: "exif-add-field", textContent: "Other field…", title: "A field by its tag number" });
        custom.addEventListener("click", () => add(`custom:${++customs}`, { group: "Image", tag: NaN, type: 2, value: "", format: "value", isNew: true, custom: true, name: "Other field", remove: false, error: null }));
        return [choice, list, custom];
    }

    function render(focusId = null) {
        if (!model) return;
        // What's in the editors still open, taken first: they're made again
        // from what's pending, and a value put in without an input event (by
        // a script, or some autofill) would otherwise be lost.
        for (const editor of open.values()) editor.read?.();
        const rows = rowsNow(), filterText = content.querySelector(".exif-filter")?.value ?? "";
        const filter = el("input", { type: "search", className: "exif-filter", placeholder: "Find a field…", ariaLabel: "Find a field", value: filterText });
        const ids = [...model.rows.map(fieldId), ...[...pending].filter(([, c]) => c.isNew).map(([id]) => id)];
        const groups = new Map();
        for (const id of ids) { const g = fieldOf(id).group; groups.set(g, [...(groups.get(g) ?? []), id]); }
        const order = [...new Set(["Image", "EXIF", "GPS", "Interop", ...groups.keys()])].filter((g) => groups.has(g));
        const sections = order.map((g) => {
            const body = el("tbody", {}, ...groups.get(g).map((id) => rowOf(id, rows)));
            return el("details", { className: "exif-group", open: g !== "Thumbnail" && !/\(next\)$/.test(g) }, el("summary", {}, `${GROUPS[g] ?? g} `, el("span", { className: "hint", textContent: `${groups.get(g).length}` })),
                el("table", { className: "exif-table" }, body));
        });
        const applyFilter = () => {
            const want = filter.value.trim().toLowerCase();
            for (const section of sections) {
                let any = false;
                for (const tr of section.querySelectorAll("tr.exif-row")) { tr.hidden = !!want && !tr.dataset.find.includes(want); any ||= !tr.hidden; }
                section.hidden = !any;
                if (want && any) section.open = true;
            }
        };
        filter.addEventListener("input", applyFilter);
        content.replaceChildren(summaryOf(rows), ...(editable ? [privacyOf()] : []), el("div", { className: "exif-tools" }, filter, ...(editable && !stripAll ? addingOf() : [])), ...sections,
            ...(ids.length ? [] : [el("p", { className: "hint", textContent: editable ? "No EXIF information yet. Add a field above." : "No EXIF information." })]));
        applyFilter();
        content.classList.toggle("stripping", stripAll);
        showActions();
        if (focusId && open.has(focusId)) {
            open.get(focusId).cell?.closest("details")?.setAttribute("open", "");
            open.get(focusId).cell?.scrollIntoView?.({ block: "nearest" });
            open.get(focusId).focus?.();
        } else if (focusId) content.querySelector(`tr[data-field="${CSS.escape(focusId)}"] .exif-value`)?.focus?.();
    }

    // Closing, asked for (the button, Escape): with changes not saved, only
    // after it's asked. (Closing by the image's own view isn't asked.)
    const takeAll = () => { for (const editor of open.values()) editor.read?.(); };
    const tryClose = () => {
        if (saving) return;
        takeAll();
        if (!dirty()) { finish(); return; }
        asking = true;
        showActions();
        keep.focus();
    };
    keep.addEventListener("click", () => { asking = false; showActions(); });
    discard.addEventListener("click", () => {
        if (asking) { finish(); return; }
        pending.clear(); open.clear(); removeLocation = stripAll = false;
        render();
        say(model.rows.length ? `${model.rows.length} EXIF fields.` : "No EXIF information.");
    });
    dialog.addEventListener("keydown", (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
            event.preventDefault();
            if (dirty() && !saving) store.click();
        } else if (event.key === "Escape") {
            // In a field's editor: that field put back as it was before, and
            // its editor closed. Asked whether to close: no. Else, closing.
            event.preventDefault();
            const tr = event.target.closest?.("tr.exif-row"), id = tr?.dataset.field;
            if (id && open.has(id)) {
                const { before } = open.get(id);
                if (before) pending.set(id, before);
                else pending.delete(id);
                open.delete(id);
                render(pending.has(id) || original(id) ? id : null);
            } else if (asking) keep.click();
            else tryClose();
        }
    });

    store.addEventListener("click", async () => {
        if (!save || saving || !model) return;
        takeAll();
        // What's wrong is said where it is, the first of it shown.
        const wrong = stripAll ? [] : [...pending].filter(([, c]) => c.error && !c.remove);
        const taken = new Map();
        if (!stripAll) for (const [id, c] of pending) {
            if (c.remove || !Number.isInteger(c.tag)) continue;
            const key = `${c.group}:${c.tag}`, other = c.custom ? (original(key) && !pending.get(key)?.remove ? key : taken.get(key)) : null;
            if (other) wrong.push([id, { ...c, error: `There's a field with that tag in ${c.group} already.` }]);
            taken.set(key, id);
        }
        if (wrong.length) {
            const [id, c] = wrong[0];
            if (!open.has(id)) open.set(id, { before: null });
            render(id);
            for (const [bad, change] of wrong) open.get(bad)?.fail?.(change.error);
            say(`Not saved: ${wrong.length === 1 ? `${c.name} needs putting right.` : `${wrong.length} fields need putting right.`}`, true);
            return;
        }
        const controls = [...dialog.querySelectorAll("input, textarea, select, button")], were = controls.map((c) => c.disabled);
        try {
            let tiff;
            if (stripAll) {
                const way = original("Image:274");
                tiff = editExif(null, {}, { edits: way ? [{ group: "Image", tag: 0x0112, type: way.type, value: exifEditValue(model, way).value }] : [] });
            } else tiff = editExif(exifOf(bytes, blob.type), {}, pendingEdits(pending, { removeLocation }));
            const output = replaceExif(bytes, blob.type, tiff), next = new Blob([output], { type: blob.type });
            saving = true;
            controls.forEach((c) => { c.disabled = true; });
            say("Saving EXIF…");
            await save(next, controller.signal);
            if (stopped) return;
            blob = next; bytes = output; model = readExif(tiff);
            pending.clear(); open.clear(); removeLocation = stripAll = asking = false;
            saving = false;
            render();
            say("EXIF saved. Compressed image data is unchanged.");
        } catch (err) {
            if (!stopped) say(`EXIF not saved: ${err.message}`, true);
        } finally {
            saving = false;
            controls.forEach((c, i) => { if (c.isConnected) c.disabled = were[i]; });
            if (!stopped) showActions();
        }
    });

    finish = showModal(dialog, { closeButton: close, focus, request: tryClose, closed: () => {
        stopped = true;
        controller.abort();
        bytes = model = null;
    } });
    void (async () => {
        try {
            const loaded = new Uint8Array(await blob.arrayBuffer());
            if (stopped) return;
            bytes = loaded;
            const tiff = exifOf(bytes, blob.type);
            model = readExif(tiff);
            hasXMP = new Set(metadataOf(bytes, blob.type).kinds).has("XMP");
            say(model.rows.length ? `${model.rows.length} EXIF fields.${save ? " Click a value to change it; saving leaves the compressed image as it is." : ""}` : "No EXIF information.");
            // Whether it can be changed at all is learnt now, not on saving:
            // a block whose values lie over each other can only be read.
            editable = !!save;
            if (save) {
                try {
                    editExif(tiff, {}, {});
                } catch (err) {
                    editable = false;
                    say(`${model.rows.length} EXIF fields. They can be read but not changed here: ${err.message}`);
                }
            }
            render();
        } catch (err) {
            if (!stopped) say(`EXIF couldn't be read: ${err.message}`, true);
        }
    })();
    return { close: () => finish() };
}
