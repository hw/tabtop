// Requests about ~/Downloads through the encrypted tunnel, served by
// tabtopd (see e2e.go), for the files page and for files dropped on the
// desktop: running one with the session, uploading a file, making a
// folder, and collecting a file or zip that's fetched.

import * as tunnel from "./tunnel.js";

// The login form's title, if one is needed: the page's name.
let title = "Downloads";

export function setLoginTitle(t) {
    title = t;
}

// call runs a request with the session, logging in again if it's over.
export async function call(req) {
    for (;;) {
        const session = await tunnel.session(title);
        try {
            return await tunnel.Tunnel.open(req, session);
        } catch (err) {
            if (!err.login) {
                throw err;
            }
            tunnel.forgetSession(session);
        }
    }
}

// Uploads are sent in chunks the size of the server's, at most
// UPLOAD_WINDOW of them ahead of those it has acknowledged writing, so a
// slow server or disk doesn't pile the file up in the browser.
const UPLOAD_CHUNK = 256 * 1024;
const UPLOAD_WINDOW = 16;

// Uploads cut off, by File, as {id, dir}: the server keeps
// what it had of one whose connection was lost (see keepPartial in
// upload.go), so uploading the same file into the same folder again, as
// Retry does, carries on from there.
const partial = new WeakMap();

// uploadFile uploads a dropped or picked file into the folder dir, and
// returns the name it was saved as, and any warning. With replace, a file
// with its name there is replaced; otherwise it gets a free name. Aborting
// signal ends it, telling the server to delete what it had of the file. If
// it stopped any other way the last time this file was uploaded into dir,
// it carries on from there. (If the file has changed on disk since it was
// picked, the browser won't read it, so it fails rather than mixing the
// two.)
export async function uploadFile(file, progress, dir, signal, replace = false) {
    signal.throwIfAborted();
    const kept = partial.get(file);
    const resume = kept?.dir === dir ? kept.id : "";
    const t = await call({ type: "upload", path: dir, name: file.name, size: file.size,
        ...(replace ? { replace: true } : {}), ...(resume ? { resume } : {}) });
    const abort = () => {
        partial.delete(file);
        try {
            t.sendText(JSON.stringify({ cancel: true }));
        } catch {
            // Lost already: the server keeps it a while, then deletes it.
        }
        t.close();
    };
    signal.addEventListener("abort", abort);
    try {
        signal.throwIfAborted();  // while it was opening
        if (t.reply.id) {
            partial.set(file, { id: t.reply.id, dir });
        }
        const offset = t.reply.offset ?? 0;
        const chunks = Math.ceil((file.size - offset) / UPLOAD_CHUNK);
        let sent = 0;
        let acked = 0;
        progress(offset);
        for (;;) {
            while (sent < chunks && sent - acked < UPLOAD_WINDOW) {
                const start = offset + sent * UPLOAD_CHUNK;
                t.sendData(new Uint8Array(await file.slice(start, start + UPLOAD_CHUNK).arrayBuffer()));
                sent++;
            }
            const m = await t.next();
            if (!m) {
                throw new Error(t.closeReason || "connection lost");
            }
            if (m.text !== undefined) {
                const res = JSON.parse(m.text);
                if (res.name && acked === chunks) {
                    partial.delete(file);
                    return { name: res.name, warning: res.warning };
                }
                throw new Error(res.error || "the server's reply is malformed");
            }
            acked++;
            progress(Math.min(offset + acked * UPLOAD_CHUNK, file.size));
        }
    } finally {
        signal.removeEventListener("abort", abort);
        t.close();
    }
}

// shellPath is the path of path, in ~/Downloads, as a shell takes it:
// quoted if it needs to be.
export function shellPath(path) {
    return "~/Downloads/" + (/^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`);
}

// folderInfo resolves, for uploads into the folder dir, to {names, free}:
// the names of the files in it (not its folders, which an upload can't
// replace), and the bytes free there, or null if the server can't tell.
export async function folderInfo(dir) {
    const t = await call({ type: "list", path: dir });
    t.close();
    return { names: new Set(t.reply.entries.filter((e) => !e.dir).map((e) => e.name)), free: t.reply.free ?? null };
}

// makeFolder makes the folder name in dir for an upload, and returns the
// name it got.
export async function makeFolder(dir, name) {
    const t = await call({ type: "mkdir", path: dir, name });
    t.close();
    return t.reply.name;
}

// complete reports whether a download that's ended came whole: all size
// bytes of a file, or a zip (size null) the server said it finished.
export function complete(t, got, size) {
    return size === null ? t.trailer?.done === true : got === size;
}

// collect gathers the rest of a file or zip request t into a Blob of
// type, calling progress(bytes) as it goes, and throws if it ends before
// all size bytes (see complete) have come. Each chunk becomes a Blob as it
// arrives, which moves it out of the page's memory into the browser's blob
// storage; Chrome keeps large ones in temporary files on disk.
export async function collect(t, size, progress, type = "application/octet-stream") {
    const chunks = [];
    let got = 0;
    for (let data; (data = await t.nextChunk());) {
        if (size !== null && got + data.byteLength > size) {
            t.close();
            throw new Error("more than the file's size");
        }
        chunks.push(new Blob([data]));
        got += data.byteLength;
        progress(got);
    }
    if (!complete(t, got, size)) {
        throw new Error(t.closeReason || "connection lost");
    }
    return new Blob(chunks, { type });
}

// saveBlob saves blob as a download named name. The link that does it goes
// in the open dialog, if there is one, since a modal dialog makes the rest
// of the page inert, which stops its links working.
export function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob.type === "application/octet-stream" ? blob : blob.slice(0, blob.size, "application/octet-stream"));
    const a = Object.assign(document.createElement("a"), { href: url, download: name, hidden: true });
    (document.querySelector("dialog[open]") ?? document.body).append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}
