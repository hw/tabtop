// Uploading files and folders dropped on the files page, or picked with
// its upload buttons, and deleting them, served by tabtopd. Used by
// files.js, which supplies how to send or delete one file and make a
// folder, and by the desktop and the terminal for files dropped on them.
// How each goes shows in the transfers panel (see ui.js).

import { runTransfer } from "./transfer.js";
import { humanBytes } from "./file-format.js";
import { askChoice, askYes, statusRow } from "./ui.js";

// dropUploads makes the page take dropped and pasted files and folders,
// into the folder here() gives when they arrive. Each file is passed in
// turn to send(file, progress, dir, signal, replace), which resolves to
// {name, warning}, the name it was saved as in the folder dir and anything
// to say about it, calls progress(bytes) as it goes, and stops, rejecting,
// once signal is aborted. inspect(dir) resolves to {names, free}: a Set of
// the names of the files in the folder, and the bytes free there, or null.
// If any of the files have the names of ones already in the folder, the
// person is asked whether to replace those (replace is then true) or keep
// both (the new ones get numbered names). Several files that won't fit
// together aren't started (the server checks each file itself). A folder
// is made with mkdir(dir, name), which resolves to the name it got, and
// then filled the same way. Progress shows in the
// transfers panel, with a Cancel button for each file or folder until
// it's done; done(names, dir) is called, and awaited, once all have been
// tried and any succeeded, with the names of the files and folders saved
// in the folder dir. While files are dragged over the page, it says where
// they'd go, followed by note. It returns a function that makes the upload
// buttons, which send the files or folder picked the same way.
export function dropUploads(send, mkdir, done, here, note = "", inspect = async () => ({ names: new Set(), free: null })) {
    let depth = 0;
    const isFiles = (e) => e.dataTransfer?.types.includes("Files");
    const where = document.createElement("p");
    const overlay = document.createElement("div");
    overlay.id = "drop_overlay";
    overlay.append(where);
    document.addEventListener("dragenter", (e) => {
        if (isFiles(e)) {
            if (!depth++) {
                let dir = "";
                try {
                    dir = here();
                } catch {
                    // A malformed address: the page says so, and uploads fail.
                }
                where.textContent = `Drop to upload into ${["Downloads", ...dir.split("/").filter(Boolean)].join(" / ")}${note ? ` ${note}` : ""}`;
                if (!overlay.isConnected) {
                    document.body.append(overlay);
                }
            }
            document.body.classList.add("dropping");
        }
    });
    document.addEventListener("dragleave", (e) => {
        if (isFiles(e) && --depth <= 0) {
            depth = 0;
            document.body.classList.remove("dropping");
        }
    });
    document.addEventListener("dragover", (e) => {
        if (isFiles(e)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
        }
    });
    // upload sends files, then folders: promises of {name, files, dirs},
    // into dir, by default the one shown.
    let queue = Promise.resolve();
    const upload = (files, folders = [], dir = here()) => {
        const jobs = [
            ...files.map((file) => ({ file, row: statusRow(`${file.name}: waiting`, true) })),
            ...folders.map((folder) => ({ folder, row: statusRow("Reading a folder…", true) })),
        ];
        // One upload at a time, after any still going from earlier ones.
        queue = queue.then(async () => {
            let info = null;
            try {
                info = await inspect(dir);
            } catch {
                // Uploaded anyway; the server checks each file.
            }
            const room = await tooBig(files, folders, info?.free);
            if (room) {
                // Each can be tried on its own, which the server checks.
                for (const { file, folder, row } of jobs) {
                    const name = file ? file.name : `${(await folder.catch(() => null))?.name ?? "A folder"}/`;
                    row.set(`${name}: not uploaded: ${room}`, true);
                    row.finish(() => upload(file ? [file] : [], folder ? [folder] : [], dir));
                }
                return;
            }
            const replace = await askReplace(files, dir, info?.names);
            if (replace === null) {
                for (const { file, folder, row } of jobs) {
                    row.set(file ? `${file.name}: cancelled` : "A folder's upload: cancelled");
                    row.finish();
                }
                return;
            }
            const saved = [];
            for (const { file, folder, row } of jobs) {
                const { name, retry } = await (file ? uploadOne(file, dir, row, send, replace.has(file.name), upload)
                    : uploadFolder(folder, dir, row, send, mkdir, upload));
                if (name) {
                    saved.push(name);
                }
                row.finish(retry);
            }
            if (saved.length) {
                await redraw(() => done(saved, dir));
            }
        });
    };
    document.addEventListener("drop", (e) => {
        if (!isFiles(e)) {
            return;
        }
        e.preventDefault();
        depth = 0;
        document.body.classList.remove("dropping");
        const files = [];
        const folders = [];
        // The items can only be read during the event; their entries after.
        for (const item of e.dataTransfer.items) {
            const entry = item.kind === "file" && item.webkitGetAsEntry?.();
            if (entry?.isDirectory) {
                folders.push(readFolder(entry));
            } else {
                const file = item.kind === "file" && item.getAsFile();
                if (file) {
                    files.push(file);
                }
            }
        }
        upload(files, folders);
    });
    // Files pasted, as a screenshot copied, unless into a text box.
    document.addEventListener("paste", (e) => {
        const files = [...(e.clipboardData?.files ?? [])];
        if (!files.length || e.target.closest?.("input, textarea, [contenteditable]") || document.querySelector("dialog[open]")) {
            return;
        }
        e.preventDefault();
        upload(files.map(pastedName));
    });
    const picker = (label, props, take) => {
        const input = Object.assign(document.createElement("input"), { type: "file", hidden: true, ...props });
        input.addEventListener("change", () => {
            take([...input.files]);
            input.value = "";
        });
        const button = Object.assign(document.createElement("button"), { type: "button", textContent: label });
        button.addEventListener("click", () => input.click());
        return [button, input];
    };
    return () => {
        const span = document.createElement("span");
        span.append(...picker("Upload files…", { multiple: true }, (files) => upload(files)));
        if ("webkitdirectory" in HTMLInputElement.prototype) {
            span.append(" ", ...picker("Upload a folder…", { webkitdirectory: true },
                (files) => files.length && upload([], [Promise.resolve(pickedFolder(files))])));
        }
        return span;
    };
}

// pastedName names a pasted picture, which browsers call "image.png",
// after when it was pasted, so pasting several doesn't make "image (1).png"
// and so on. Other files keep their names.
function pastedName(file) {
    const generic = /^image\.(\w+)$/i.exec(file.name);
    if (!generic) {
        return file;
    }
    const d = new Date();
    const two = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}.${two(d.getMinutes())}.${two(d.getSeconds())}`;
    return new File([file], `Pasted ${stamp}.${generic[1].toLowerCase()}`, { type: file.type, lastModified: file.lastModified });
}

// tooBig says why files and folders (promises of them) can't all be
// uploaded, if there's more than one file among them and together they're
// more than free bytes; else "". A single file is left to the server,
// which knows how much of one cut off it already has.
async function tooBig(files, folders, free) {
    if (free === null || free === undefined) {
        return "";
    }
    const read = (await Promise.allSettled(folders)).filter((r) => r.status === "fulfilled").map((r) => r.value);
    const sizes = [...files.map((f) => f.size), ...read.flatMap(folderSizes)];
    const total = sizes.reduce((a, b) => a + b, 0);
    if (sizes.length < 2 || total <= free) {
        return "";
    }
    return `there isn't room for all ${sizes.length} files: they're ${humanBytes(total)} together, and ${humanBytes(free)} is free.`;
}

function folderSizes(folder) {
    return [...folder.files.map((f) => f.size), ...folder.dirs.flatMap(folderSizes)];
}

// askReplace asks, if any of files have the names of ones already in dir,
// names (a Set, or undefined if the folder couldn't be read, when it keeps
// both), whether to replace those, and resolves to the Set of names to
// replace (empty to keep both), or null if the uploads are cancelled.
async function askReplace(files, dir, names) {
    if (!files.length || !names) {
        return new Set();
    }
    const taken = files.filter((f) => names.has(f.name)).map((f) => f.name);
    if (!taken.length) {
        return new Set();
    }
    const where = ["Downloads", ...dir.split("/").filter(Boolean)].join(" / ");
    const shown = taken.slice(0, 3).join(", ") + (taken.length > 3 ? ` and ${taken.length - 3} more` : "");
    const message = taken.length === 1 ? `${where} already has a file named ${taken[0]}. Replace it, or keep both (the new one gets a number)?`
        : `${where} already has files named ${shown}. Replace them, or keep both (the new ones get numbers)?`;
    const choice = await askChoice(message, [["keep", "Keep both"], ["replace", taken.length === 1 ? "Replace" : "Replace them"]]);
    return choice === null ? null : new Set(choice === "replace" ? taken : []);
}

// uploadOne uploads file into dir, showing how it goes in row, and
// returns {name, retry}: the name it was saved as, or "" if it wasn't, and
// if it failed, a function that tries again, with upload(files, folders,
// dir). With replace, a file with its name there is replaced.
async function uploadOne(file, dir, row, send, replace, upload) {
    row.destination(`To: Downloads${dir ? "/" + dir : ""}`);
    const result = await runTransfer({
        signal: row.signal,
        retry: () => upload([file], [], dir),
        progress: (got, note) => {
            row.set(`${file.name}: ${percent(got, file.size)}${note ? `, ${note}` : ""}`);
            row.progress(file.size ? got / file.size : 1);
        },
        run: async ({ signal, progress }) => {
            progress(0);
            return send(file, progress, dir, signal, replace);
        },
    });
    if (result.state === "cancelled") {
        row.set(`${file.name}: cancelled`);
        return { name: "" };
    }
    if (result.state === "failed") {
        row.set(`${file.name}: failed: ${result.error.message}`, true);
        return { name: "", retry: result.retry };
    }
    const { name, warning } = result.value;
    row.set(name === file.name ? `${file.name}: uploaded` : `${file.name}: uploaded as ${name}`);
    if (warning) { row.set(`${row.text} (${warning})`, true); }
    return { name };
}

// A folder to upload is {name, files, dirs}: its name, the Files in it,
// and the folders in it, the same way.

// readFolder reads a dropped folder's entry.
async function readFolder(entry) {
    const folder = { name: entry.name, files: [], dirs: [] };
    const reader = entry.createReader();
    // readEntries gives a batch at a time, then an empty one.
    for (let batch; (batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject))).length;) {
        for (const e of batch) {
            if (e.isDirectory) {
                folder.dirs.push(await readFolder(e));
            } else if (e.isFile) {
                folder.files.push(await new Promise((resolve, reject) => e.file(resolve, reject)));
            }
        }
    }
    return folder;
}

// pickedFolder makes the folder picked with the folder button from its
// files, each named by its path in it. Empty folders aren't picked.
function pickedFolder(files) {
    const folders = new Map();
    const at = (path) => {
        let f = folders.get(path);
        if (!f) {
            const slash = path.lastIndexOf("/");
            f = { name: path.slice(slash + 1), files: [], dirs: [] };
            folders.set(path, f);
            if (slash >= 0) {
                at(path.slice(0, slash)).dirs.push(f);
            }
        }
        return f;
    };
    for (const file of files) {
        const path = file.webkitRelativePath;
        at(path.slice(0, path.lastIndexOf("/"))).files.push(file);
    }
    return at(files[0].webkitRelativePath.split("/")[0]);
}

function countFiles(folder) {
    return folder.dirs.reduce((n, d) => n + countFiles(d), folder.files.length);
}

const join = (dir, name) => (dir ? `${dir}/${name}` : name);
const percent = (got, size) => `${size ? Math.floor(got * 100 / size) : 100}%`;

// uploadFolder uploads folder, a promise of one, into dir: a new folder,
// named after it unless that's taken, and everything in it, until row's
// Cancel button is pressed. Its progress shows in row, and files that fail
// in rows of their own, each with Retry. It returns {name, retry}: the
// name the new folder got, if any of its files were saved, else "", and,
// if the folder couldn't be made, a function that tries again with
// upload(files, folders, dir).
async function uploadFolder(pending, dir, row, send, mkdir, upload) {
    let folder;
    try {
        folder = await pending;
    } catch (err) {
        row.set(`A folder couldn't be read: ${err.message}`, true);
        return { name: "" };
    }
    const { signal } = row;
    if (signal.aborted) {
        row.set(`${folder.name}/: cancelled`);
        return { name: "" };
    }
    const total = countFiles(folder);
    let got;
    try {
        got = await mkdir(dir, folder.name);
    } catch (err) {
        row.set(`${folder.name}/: failed: ${err.message}`, true);
        return { name: "", retry: () => upload([], [Promise.resolve(folder)], dir) };
    }
    let tried = 0;
    let saved = 0;
    const failed = (path, message, retry) => {
        const r = statusRow("");
        r.set(`${path}: failed: ${message}`, true);
        r.finish(retry);
        row.set(row.text, true);
    };
    // fill uploads what's in f into the new folder at to, and shows it at
    // path, the folder's path as dropped.
    const fill = async (f, to, path) => {
        for (const file of f.files) {
            if (signal.aborted) {
                return;
            }
            const progress = (bytes, note) => {
                row.set(`${folder.name}/: ${tried} of ${total} files, ${file.name} ${percent(bytes, file.size)}${note ? `, ${note}` : ""}`);
                row.progress((tried + (file.size ? bytes / file.size : 1)) / total);
            };
            progress(0);
            try {
                const result = await runTransfer({signal, progress, run: ({progress}) => send(file, progress, to, signal)});
                if (result.state === "cancelled") { return; }
                if (result.state === "failed") { throw result.error; }
                const { name, warning } = result.value;
                saved++;
                if (warning) {
                    failed(join(path, name), warning);
                }
            } catch (err) {
                if (!signal.aborted) {
                    failed(join(path, file.name), err.message, () => upload([file], [], to));
                }
            }
            tried++;
        }
        for (const d of f.dirs) {
            if (signal.aborted) {
                return;
            }
            let sub;
            try {
                sub = await mkdir(to, d.name);
            } catch (err) {
                failed(join(path, d.name) + "/", err.message);
                tried += countFiles(d);
                continue;
            }
            await fill(d, join(to, sub), join(path, d.name));
        }
    };
    await fill(folder, join(dir, got), folder.name);
    const as = got === folder.name ? "" : `, as ${got}/`;
    row.set(signal.aborted ? `${folder.name}/: cancelled after ${saved} of ${total} files${as}`
        : `${folder.name}/: ${saved} of ${total} files uploaded${as}`);
    return { name: saved ? got : "" };
}

// deleteFiles asks before deleting items, [{name, dir, remove}], each a
// file or folder (if dir) and a function that deletes it, resolving once
// it's gone; then calls and awaits done(). The outcome of each shows in the
// status list.
export async function deleteFiles(items, done) {
    const [only] = items;
    const question = items.length > 1 ? `Delete these ${items.length} items? Folders among them go with everything in them.`
        : only.dir ? `Delete the folder ${only.name} and everything in it?` : `Delete ${only.name}?`;
    if (!(await askYes(`${question} This can't be undone.`, "Delete"))) {
        return;
    }
    for (const { name, dir, remove } of items) {
        const label = dir ? `${name}/` : name;
        const row = statusRow(`${label}: deleting`);
        try {
            await remove();
            row.set(`${label}: deleted`);
        } catch (err) {
            row.set(`${label}: not deleted: ${err.message}`, true);
        }
        row.finish();
    }
    await redraw(done);
}

// redraw calls and awaits done(), which redraws the page.
async function redraw(done) {
    try {
        await done();
    } catch {
        // The page stays as it was.
    }
}
