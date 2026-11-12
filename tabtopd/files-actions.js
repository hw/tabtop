// File actions and transfer tracking. Folder rendering stays in files.js.
import { askFolder, askName, askShare, askUploadLink, askURL, copyText, showLink, statusRow } from "./ui.js";
import { call, shareURL, shellPath } from "./requests.js";
import { humanBytes } from "./file-format.js";
export const MOVE_TYPE = "application/x-tabtop-move";
export function createFileActions({ show, exactTime, el, join }) {
    // deletion is how deleteFiles (see drop.js) deletes the entry e in dir.
    function deletion(dir, e) {
        return { name: e.name, dir: e.dir, remove: () => call({ type: "delete", path: join(dir, e.name) }).then((t) => t.close()) };
    }

    // rename asks for a new name for the entry e in dir, and renames it.
    async function rename(dir, e) {
        const slash = e.dir ? "/" : "";
        const name = await askName(`Rename ${e.name}${slash} to:`, "Rename", e.name, !e.dir);
        if (name === null || name === e.name) {
            return;
        }
        const row = statusRow(`${e.name}${slash}: renaming`);
        try {
            const t = await call({ type: "rename", path: join(dir, e.name), name });
            t.close();
            row.set(`${e.name}${slash}: renamed to ${name}${slash}`);
        } catch (err) {
            row.set(`${e.name}${slash}: not renamed: ${err.message}`, true);
        }
        row.finish();
        await show();
    }

    // Moving ---------------------------------------------------------------

    // What's dragged when a row is: {dir, names}, in this type, so dropping it
    // isn't taken for files dropped to upload.


    // moveTarget makes target, a row or link for the folder to, take rows
    // dragged onto it from the folder dir, and move them there.
    function moveTarget(target, dir, to) {
        const ours = (ev) => ev.dataTransfer?.types.includes(MOVE_TYPE);
        target.addEventListener("dragover", (ev) => {
            if (ours(ev)) {
                ev.preventDefault();
                ev.dataTransfer.dropEffect = "move";
                target.classList.add("drop-target");
            }
        });
        target.addEventListener("dragleave", () => target.classList.remove("drop-target"));
        target.addEventListener("drop", (ev) => {
            target.classList.remove("drop-target");
            if (!ours(ev)) {
                return;
            }
            ev.preventDefault();
            const { names } = JSON.parse(ev.dataTransfer.getData(MOVE_TYPE));
            // A folder dragged onto itself stays.
            moveNames(dir, names.filter((n) => join(dir, n) !== to), to);
        });
    }

    // askMove asks which folder to move names, in the folder dir, into, and
    // moves them there.
    async function askMove(dir, names) {
        const what = names.length === 1 ? names[0] : `these ${names.length} items`;
        const to = await askFolder(`Move ${what} into which folder? Give its path in Downloads, as photos/2026.`, "Move", dir);
        if (to !== null && to !== dir) {
            await moveNames(dir, names, to);
        }
    }

    // moveNames moves names, in the folder dir, into the folder to, showing
    // how each goes in the transfers panel, then redraws the page.
    async function moveNames(dir, names, to) {
        if (!names.length) {
            return;
        }
        const where = ["Downloads", ...to.split("/").filter(Boolean)].join(" / ");
        for (const name of names) {
            const row = statusRow(`${name}: moving to ${where}`);
            try {
                const t = await call({ type: "move", path: join(dir, name), to });
                t.close();
                row.set(`${name}: moved to ${where}`);
            } catch (err) {
                row.set(`${name}: not moved: ${err.message}`, true);
            }
            row.finish();
        }
        await show();
    }

    // copyPath copies the path of path, in ~/Downloads, as a shell takes it
    // (see shellPath).
    async function copyPath(path) {
        const text = shellPath(path);
        const row = statusRow("");
        try {
            await copyText(text);
            row.set(`Copied ${text}`);
        } catch {
            row.set(`Couldn't copy ${text}`, true);
        }
        row.finish();
    }

    // Share links -------------------------------------------------------------

    // makeLink makes a share link to what's at path (a folder if dir), lasting
    // expires seconds and allowing max downloads, and resolves to its URL and
    // when it ends. The URL ends in the name it's saved as, so plain wget gets
    // that.
    async function makeLink(path, dir, expires, max, label = "") {
        const t = await call({ type: "share", path, expires, max, label });
        t.close();
        const { token, name, expires: ends } = t.reply;
        return { url: shareURL(token, { name, dir }), ends };
    }

    // share asks how a link to what's at path should work, makes it and shows
    // it.
    async function share(path, dir) {
        const name = path.split("/").pop();
        const how = await askShare(name, dir);
        if (!how) {
            return;
        }
        let link;
        try {
            link = await makeLink(path, dir, how.expires, how.max, how.label);
        } catch (err) {
            const row = statusRow("");
            row.set(`No link to ${name}: ${err.message}`, true);
            row.finish();
            return;
        }
        const allows = how.max ? `, for ${how.max} download${how.max === 1 ? "" : "s"}` : "";
        if (await showLink(`A link to ${name}${dir ? " (as a .zip)" : ""}, until ${exactTime(Date.parse(link.ends) / 1000)}${allows}. `
            + "Revoke it from Share links.", link.url)) {
            await copyAndSay(link.url, `the link to ${name}`);
        }
    }

    // Fetches from URLs: the gateway's, going on whether this page is open
    // or not (see fetch.go). A row follows each, with a Cancel button; the
    // page, opened again, follows those still going.
    const following = new Set();
    let fetchesFollowed = false;
    function followOnce() {
        if (!fetchesFollowed) { fetchesFollowed = true; followGoing(); }
    }

    // fetchURL asks for an address, and has the gateway fetch it into dir.
    async function fetchURL(dir) {
        const url = await askURL(dir ? dir.split("/").pop() : "Downloads");
        if (!url) {
            return;
        }
        let t;
        try {
            t = await call({ type: "fetch", path: dir, url });
        } catch (err) {
            const row = statusRow("");
            row.set(`Not fetched: ${err.message}`, true);
            row.finish();
            return;
        }
        followFetch(t);
    }

    // followGoing follows the fetches going, started here before or elsewhere.
    async function followGoing() {
        let t;
        try {
            t = await call({ type: "fetches" });
            t.close();
        } catch {
            return;
        }
        for (const f of t.reply.fetches ?? []) {
            if (!f.done && !following.has(f.id)) {
                try {
                    followFetch(await call({ type: "fetch", name: f.id }));
                } catch {
                    // Finished meanwhile.
                }
            }
        }
    }

    // followFetch shows how the fetch t replied about goes, in a row, until
    // it's done. If the connection is lost, it follows it again once it can:
    // the fetch goes on meanwhile.
    async function followFetch(t) {
        const id = t.reply.fetch.id;
        if (following.has(id)) {
            t.close();
            return;
        }
        following.add(id);
        let last = t.reply.fetch;
        const label = () => `${last.name || "a file"} from ${last.host}`;
        const row = statusRow(`${label()}: fetching`, true);
        row.signal.addEventListener("abort", () => {
            try {
                t.sendText(JSON.stringify({ cancel: true }));
            } catch {
                // Lost: cancelled once it's followed again.
            }
        });
        const update = (f) => {
            last = f;
            row.set(`${label()}: ${humanBytes(f.got)}${f.total >= 0 ? ` of ${humanBytes(f.total)}` : ""}`);
            row.progress(f.total > 0 ? f.got / f.total : null);
        };
        update(last);
        const where = last.dir === "." ? "Downloads" : last.dir;
        row.destination(`To: ${where}`);
        try {
            for (;;) {
                const m = await t.next();
                if (!m) {
                    t.close();
                    row.set(`${label()}: still fetching; reconnecting to follow it…`);
                    t = await refollow(id, row.signal);
                    if (row.signal.aborted) {
                        t.sendText(JSON.stringify({ cancel: true }));
                    }
                    continue;
                }
                if (m.text === undefined) {
                    continue;
                }
                const res = JSON.parse(m.text);
                if (res.error) {
                    throw new Error(res.error);
                }
                update(res.fetch);
                if (res.fetch.done) {
                    row.set(`${res.fetch.name}: fetched from ${res.fetch.host} into ${where}${res.warning ? ` (${res.warning})` : ""}`);
                    break;
                }
            }
        } catch (err) {
            if (err.message === FETCH_FORGOTTEN) {
                // Ended while this page was away, so long ago how isn't known:
                // not said to have failed.
                row.set(`${label()}: finished while this page was away; see the folder, or Sessions and Activity`);
                return;
            }
            row.set(err.message === "cancelled" ? `${label()}: cancelled` : `${label()}: not fetched: ${err.message}`, err.message !== "cancelled");
        } finally {
            t.close();
            following.delete(id);
            row.finish();
        }
    }

    // What the server says of a fetch that ended too long ago for it to say how
    // (see errFetchForgotten in fetch.go).
    const FETCH_FORGOTTEN = "That fetch finished a while ago.";

    // refollow follows the fetch id again, trying until it can.
    async function refollow(id, signal) {
        for (let wait = 1000; ; wait = Math.min(wait * 2, 15000)) {
            await new Promise((resolve) => setTimeout(resolve, wait));
            try {
                return await call({ type: "fetch", name: id });
            } catch (err) {
                if (!err.lost || signal.aborted) {
                    throw err;
                }
            }
        }
    }

    // uploadLink asks how a link for uploading into dir should work, makes it
    // and shows it.
    async function uploadLink(dir) {
        const name = dir ? dir.split("/").pop() : "Downloads";
        const how = await askUploadLink(name);
        if (!how) {
            return;
        }
        let reply;
        try {
            const t = await call({ type: "share", path: dir, expires: how.expires, max: how.max, upload: true, max_bytes: how.maxBytes, label: how.label });
            t.close();
            reply = t.reply;
        } catch (err) {
            const row = statusRow("");
            row.set(`No upload link to ${name}: ${err.message}`, true);
            row.finish();
            return;
        }
        const url = shareURL(reply.token, { upload: true });
        const files = how.max ? `${how.max} file${how.max === 1 ? "" : "s"}` : "any number of files";
        if (await showLink(`A link for uploading into ${name}, until ${exactTime(Date.parse(reply.expires) / 1000)}, for ${files} `
            + `of up to ${humanBytes(how.maxBytes)} in all. Open it in a browser, or upload with curl -T <file> <link>. `
            + "Revoke it from Share links.", url)) {
            await copyAndSay(url, `the upload link to ${name}`);
        }
    }

    // directLink makes a link that downloads what's at path elsewhere, with
    // wget, curl, a browser or anything else, once, within an hour, and shows
    // it. It's copied from the dialog, by a click of its own: one made before
    // the link came back may no longer be allowed to.
    async function directLink(path, dir) {
        const name = path.split("/").pop() + (dir ? ".zip" : "");
        let link;
        try {
            link = await makeLink(path, dir, 3600, 1);
        } catch (err) {
            const row = statusRow("");
            row.set(`No direct download link for ${name}: ${err.message}`, true);
            row.finish();
            return;
        }
        if (await showLink(`A direct download link for ${name}, for one download until ${exactTime(Date.parse(link.ends) / 1000)}, `
            + "with wget -c, curl -fLO -C -, a browser or anything else. Revoke it from Share links.", link.url)) {
            await copyAndSay(link.url, `the direct download link for ${name}`);
        }
    }

    // directDownload downloads what's at path, a file, straight from the
    // gateway over HTTPS, as a browser downloads anything, rather than through
    // the encrypted tunnel: by a link made for this one download, counted as
    // it's made, and a ticket for it (see ticket in share.go), which fetches
    // the file rather than the link's page. The link stays listed in Security
    // and sessions till it ends, as any does.
    async function directDownload(path) {
        const name = path.split("/").pop();
        let reply;
        try {
            const t = await call({ type: "share", path, expires: 3600, max: 1, label: "Direct Download", direct: true });
            t.close();
            reply = t.reply;
        } catch (err) {
            const row = statusRow("");
            row.set(`${name}: not downloaded directly: ${err.message}`, true);
            row.finish();
            return;
        }
        const a = el("a", { href: `${shareURL(reply.token, { name: reply.name })}?t=${encodeURIComponent(reply.ticket)}`, hidden: true });
        (document.querySelector("dialog[open]") ?? document.body).append(a);
        a.click();
        a.remove();
    }

    async function copyAndSay(text, what) {
        const row = statusRow("");
        try {
            await copyText(text);
            row.set(`Copied ${what}`);
        } catch {
            row.set(`Couldn't copy ${what}: ${text}`, true);
        }
        row.finish();
    }

    return { deletion, rename, moveTarget, askMove, copyPath, share, fetchURL, followOnce, uploadLink, directLink, directDownload };
}
