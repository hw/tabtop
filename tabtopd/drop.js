// Uploading files and folders dropped on the files page, or picked with
// its upload buttons, and deleting them, served by tabtopd. Used by
// files.js, which supplies how to send or delete one file and make a
// folder. How each goes shows in the transfers panel (see ui.js).

import { askYes, statusRow } from "./ui.js";

// dropUploads makes the page take dropped files and folders, into the
// folder here() gives when they're dropped. Each file is passed in turn to
// send(file, progress, dir, signal), which resolves to {name, warning},
// the name it was saved as in the folder dir and anything to say about it,
// calls progress(bytes) as it goes, and stops, rejecting, once signal is
// aborted. A folder is made with mkdir(dir, name), which resolves to the
// name it got, and then filled the same way. Progress shows in the
// transfers panel, with a Cancel button for each file or folder until
// it's done; done() is called, and awaited, once all have been tried
// and any succeeded. It returns a function that makes the upload buttons,
// which send the files or folder picked the same way.
export function dropUploads(send, mkdir, done, here) {
    let depth = 0;
    const isFiles = (e) => e.dataTransfer?.types.includes("Files");
    document.addEventListener("dragenter", (e) => {
        if (isFiles(e)) {
            depth++;
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
    // upload sends files, then folders: promises of {name, files, dirs}.
    let queue = Promise.resolve();
    const upload = (files, folders = []) => {
        const dir = here();
        const jobs = [
            ...files.map((file) => ({ file, row: statusRow(`${file.name}: waiting`, true) })),
            ...folders.map((folder) => ({ folder, row: statusRow("Reading a folder…", true) })),
        ];
        // One upload at a time, after any still going from earlier ones.
        queue = queue.then(async () => {
            let saved = 0;
            for (const { file, folder, row } of jobs) {
                saved += await (file ? uploadOne(file, dir, row, send) : uploadFolder(folder, dir, row, send, mkdir));
                row.finish();
            }
            if (saved) {
                await redraw(done);
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

// uploadOne uploads file into dir, showing how it goes in row, and
// returns 1 if it was saved, else 0.
async function uploadOne(file, dir, row, send) {
    if (row.signal.aborted) {
        row.set(`${file.name}: cancelled`);
        return 0;
    }
    const progress = (got) => {
        row.set(`${file.name}: ${percent(got, file.size)}`);
        row.progress(file.size ? got / file.size : 1);
    };
    progress(0);
    try {
        const { name, warning } = await send(file, progress, dir, row.signal);
        row.set(name === file.name ? `${file.name}: uploaded` : `${file.name}: uploaded as ${name}`);
        if (warning) {
            row.set(`${row.text} (${warning})`, true);
        }
        return 1;
    } catch (err) {
        if (row.signal.aborted) {
            row.set(`${file.name}: cancelled`);
        } else {
            row.set(`${file.name}: failed: ${err.message}`, true);
        }
        return 0;
    }
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
// in rows of their own. It returns how many files were saved.
async function uploadFolder(pending, dir, row, send, mkdir) {
    let folder;
    try {
        folder = await pending;
    } catch (err) {
        row.set(`A folder couldn't be read: ${err.message}`, true);
        return 0;
    }
    const { signal } = row;
    if (signal.aborted) {
        row.set(`${folder.name}/: cancelled`);
        return 0;
    }
    const total = countFiles(folder);
    let got;
    try {
        got = await mkdir(dir, folder.name);
    } catch (err) {
        row.set(`${folder.name}/: failed: ${err.message}`, true);
        return 0;
    }
    let tried = 0;
    let saved = 0;
    const failed = (path, message) => {
        const r = statusRow("");
        r.set(`${path}: failed: ${message}`, true);
        r.finish();
        row.set(row.text, true);
    };
    // fill uploads what's in f into the new folder at to, and shows it at
    // path, the folder's path as dropped.
    const fill = async (f, to, path) => {
        for (const file of f.files) {
            if (signal.aborted) {
                return;
            }
            const progress = (bytes) => {
                row.set(`${folder.name}/: ${tried} of ${total} files, ${file.name} ${percent(bytes, file.size)}`);
                row.progress((tried + (file.size ? bytes / file.size : 1)) / total);
            };
            progress(0);
            try {
                const { name, warning } = await send(file, progress, to, signal);
                saved++;
                if (warning) {
                    failed(join(path, name), warning);
                }
            } catch (err) {
                if (!signal.aborted) {
                    failed(join(path, file.name), err.message);
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
    return saved;
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
