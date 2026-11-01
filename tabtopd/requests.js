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
            tunnel.forgetSession();
        }
    }
}

// Uploads are sent in chunks the size of the server's, at most
// UPLOAD_WINDOW of them ahead of those it has acknowledged writing, so a
// slow server or disk doesn't pile the file up in the browser.
const UPLOAD_CHUNK = 256 * 1024;
const UPLOAD_WINDOW = 16;

// uploadFile uploads a dropped or picked file into the folder dir, and
// returns the name it was saved as, and any warning. With replace, a file
// with its name there is replaced; otherwise it gets a free name. Aborting
// signal ends it, and the server then deletes what it had of the file.
export async function uploadFile(file, progress, dir, signal, replace = false) {
    signal.throwIfAborted();
    const t = await call({ type: "upload", path: dir, name: file.name, size: file.size, ...(replace ? { replace: true } : {}) });
    const abort = () => t.close();
    signal.addEventListener("abort", abort);
    try {
        signal.throwIfAborted();  // while it was opening
        const chunks = Math.ceil(file.size / UPLOAD_CHUNK);
        let sent = 0;
        let acked = 0;
        for (;;) {
            while (sent < chunks && sent - acked < UPLOAD_WINDOW) {
                const start = sent * UPLOAD_CHUNK;
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
                    return { name: res.name, warning: res.warning };
                }
                throw new Error(res.error || "the server's reply is malformed");
            }
            acked++;
            progress(Math.min(acked * UPLOAD_CHUNK, file.size));
        }
    } finally {
        signal.removeEventListener("abort", abort);
        t.close();
    }
}

// fileNames resolves to the names of the files in the folder dir (not
// its folders, which an upload can't replace).
export async function fileNames(dir) {
    const t = await call({ type: "list", path: dir });
    t.close();
    return new Set(t.reply.entries.filter((e) => !e.dir).map((e) => e.name));
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
