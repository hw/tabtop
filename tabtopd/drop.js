// Uploading files dropped on the files page, or picked with its upload
// button, and deleting files, served by tabtopd. Used by files.js, which
// supplies how to send or delete one file.

// dropUploads makes the page take dropped files: each is passed in turn to
// send(file, progress), which resolves to the name it was saved as and
// calls progress(bytes) as it goes. Folders are skipped. Progress shows in
// a list at the bottom of the page; done() is called, and awaited, once
// all have been tried and any succeeded. It returns a function that makes
// an upload button, which sends the files picked with it the same way.
export function dropUploads(send, done) {
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
    // upload sends files, and lists folders as skipped.
    let queue = Promise.resolve();
    const upload = (files, folders = []) => {
        const list = statusList();
        for (const name of folders) {
            line(list, name).textContent = `${name}: folders can't be uploaded`;
        }
        // One upload at a time, after any still going from earlier ones.
        queue = queue.then(async () => {
            let saved = 0;
            for (const file of files) {
                const row = line(list, file.name);
                const progress = (got) => (row.textContent =
                    `${file.name}: ${file.size ? Math.floor(got * 100 / file.size) : 100}%`);
                progress(0);
                try {
                    const name = await send(file, progress);
                    row.textContent = name === file.name ? `${file.name}: uploaded` : `${file.name}: uploaded as ${name}`;
                    saved++;
                } catch (err) {
                    row.textContent = `${file.name}: failed: ${err.message}`;
                    row.className = "error";
                }
            }
            if (saved) {
                try {
                    await done();
                } catch {
                    // The list stays as it was; the uploads are saved.
                }
            }
            if (!list.isConnected) {
                document.body.append(list);  // done() may have redrawn the page
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
        for (const item of e.dataTransfer.items) {
            const file = item.kind === "file" && item.getAsFile();
            if (!file) {
                continue;
            }
            if (item.webkitGetAsEntry?.()?.isDirectory) {
                folders.push(file.name);
            } else {
                files.push(file);
            }
        }
        upload(files, folders);
    });
    return () => {
        const input = Object.assign(document.createElement("input"), { type: "file", multiple: true, hidden: true });
        input.addEventListener("change", () => {
            upload([...input.files]);
            input.value = "";
        });
        const button = Object.assign(document.createElement("button"), { type: "button", textContent: "Upload files…" });
        button.addEventListener("click", () => input.click());
        const span = document.createElement("span");
        span.append(button, input);
        return span;
    };
}

// deleteFile asks before deleting the file name with remove(), which
// resolves once it's gone, then calls and awaits done(). The outcome shows
// in the same list as uploads.
export async function deleteFile(name, remove, done) {
    if (!confirm(`Delete ${name}? This can't be undone.`)) {
        return;
    }
    const list = statusList();
    const row = line(list, `${name}: deleting`);
    try {
        await remove();
        row.textContent = `${name}: deleted`;
    } catch (err) {
        row.textContent = `${name}: not deleted: ${err.message}`;
        row.className = "error";
    }
    try {
        await done();
    } catch {
        // The list stays as it was.
    }
    if (!list.isConnected) {
        document.body.append(list);
    }
}

function statusList() {
    let list = document.getElementById("uploads");
    if (!list) {
        list = document.createElement("div");
        list.id = "uploads";
        list.setAttribute("role", "status");
        document.body.append(list);
    }
    return list;
}

function line(list, name) {
    const p = document.createElement("p");
    p.textContent = name;
    list.append(p);
    return p;
}
