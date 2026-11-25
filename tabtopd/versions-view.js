// The versions of a file kept as saves replaced it (see versions.go):
// listed, compared with the file as it is, and put back.
import { call, SERVER_DECODED } from "./requests.js";
import { el, showModal } from "./preview-dom.js";
import { iconSVG } from "./glyphs.js";
import { askYes } from "./ui.js";
import { humanBytes } from "./file-format.js";
import { openImageDiff } from "./image-diff-view.js";
import { typeOf } from "./preview-model.js";
import { openTextDiff, loadDiffText } from "./text-diff-view.js";

const when = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

// openVersions shows the versions of the file at path, named name; text
// says whether it's text; images are detected by name. restored() runs once
// a version is put back; closed(), once the dialog is closed.
export function openVersions({ path, name, text, restored, closed }) {
    // (Not a HEIC: browsers can't decode one to compare.)
    const image = typeOf(name)?.kind === "image" && !SERVER_DECODED.has(typeOf(name).type);
    const focus = document.activeElement;
    const close = el("button", { type: "button", className: "versions-close close-glyph", title: "Close (Esc)", ariaLabel: "Close" });
    close.innerHTML = iconSVG("close-circle");
    const status = el("p", { className: "hint versions-status", textContent: "Loading versions…" });
    status.setAttribute("role", "status");
    const list = el("tbody");
    const table = el("table", { className: "versions-table", hidden: true },
        el("thead", {}, el("tr", {}, el("th", { textContent: "Saved over" }), el("th", { textContent: "Size" }), el("th", { textContent: "" }))), list);
    const all = el("button", { type: "button", className: "danger versions-delete-all close-glyph", ariaLabel: "Delete all versions…", title: "Delete all earlier versions for good", hidden: true });
    all.innerHTML = iconSVG("trash");
    const dialog = el("dialog", { className: "versions", ariaLabel: `Versions of ${name}` },
        el("div", { className: "versions-head" }, el("strong", { textContent: `Versions of ${name}` }), close), status, table,
        el("p", { className: "versions-foot" }, all));
    const remove = async (id, question) => {
        if (!(await askYes(question, "Delete"))) return false;
        try {
            const t = await call({ type: "version-delete", path, ...(id ? { name: id } : {}) });
            t.close();
            return true;
        } catch (err) {
            status.textContent = `Not deleted: ${err.message}`;
            status.classList.add("error");
            return false;
        }
    };
    all.addEventListener("click", async () => {
        if (await remove("", `Delete every earlier version of ${name}? This can't be undone; the file itself stays as it is.`)) {
            list.replaceChildren();
            table.hidden = all.hidden = true;
            status.classList.remove("error");
            status.textContent = `No earlier versions of ${name}.`;
        }
    });
    // (Closing it is heard by its opener too: closed, once.)
    const done = showModal(dialog, { closeButton: close, focus, closed: () => closed?.() });

    (async () => {
        let reply;
        try {
            const t = await call({ type: "versions", path });
            t.close();
            reply = t.reply;
        } catch (err) {
            status.textContent = `Versions couldn't be listed: ${err.message}`;
            status.classList.add("error");
            return;
        }
        const versions = reply.versions ?? [];
        status.textContent = versions.length
            ? `What ${name} was before each save that replaced it: the latest ${reply.max}, for ${reply.days} days.`
            : `No earlier versions of ${name}. One is kept each time a save replaces it, for ${reply.days} days.`;
        for (const v of versions) {
            const label = `${name} — as it was before ${when(v.deleted)}`;
            const compare = el("button", { type: "button", className: "version-compare glyph", ariaLabel: "Compare", hidden: !text && !image,
                title: "Compare this version with the file as it is now" });
            compare.innerHTML = iconSVG("compare");
            compare.addEventListener("click", () => image ? openImageDiff({
                initialMode: "slider",
                a: { name, label, request: { type: "version-file", path, name: v.id } },
                b: { name, path, label: `${name} — Now` },
            }) : openTextDiff({
                left: { name, label, load: (signal) => loadDiffText(path, signal, { type: "version-file", path, name: v.id }) },
                right: { name, label: `${name} — Now`, load: (signal) => loadDiffText(path, signal) },
            }));
            const restore = el("button", { type: "button", className: "version-restore glyph", ariaLabel: "Restore",
                title: "Make the file this version again; what it is now is kept as a version" });
            restore.innerHTML = iconSVG("undo");
            restore.addEventListener("click", async () => {
                if (!(await askYes(`Make ${name} as it was before ${when(v.deleted)} again? What it is now is kept as a version, to go back to.`, "Restore"))) {
                    return;
                }
                restore.disabled = true;
                try {
                    const t = await call({ type: "version-restore", path, name: v.id, if_mtime: reply.mtime ?? "", if_size: reply.size ?? 0 });
                    t.close();
                    done();
                    restored();
                } catch (err) {
                    status.textContent = `Not restored: ${err.message}`;
                    status.classList.add("error");
                    restore.disabled = false;
                }
            });
            const del = el("button", { type: "button", className: "version-delete glyph", ariaLabel: "Delete",
                title: "Delete this version for good" });
            del.innerHTML = iconSVG("trash");
            del.addEventListener("click", async () => {
                if (await remove(v.id, `Delete the version of ${name} from before ${when(v.deleted)}? This can't be undone.`)) {
                    row.remove();
                    table.hidden = all.hidden = !list.children.length;
                }
            });
            const changed = v.modified ? `, last changed ${when(v.modified)}` : "";
            const row = el("tr", {},
                el("td", { textContent: when(v.deleted), title: `Kept when a save replaced it${changed}` }),
                el("td", { textContent: humanBytes(v.bytes) }),
                el("td", { className: "actions" }, compare, restore, del));
            row.dataset.id = v.id;
            list.append(row);
        }
        table.hidden = all.hidden = !versions.length;
    })();
}
