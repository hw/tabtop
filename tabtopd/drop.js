// Uploading files dropped on a downloads page, served by tabtopd. Used by
// upload.js (the plain listing) and files.js (with WEB_E2E=1), which each
// supply how to send one file.

// dropUploads makes the page take dropped files: each is passed in turn to
// send(file, progress), which resolves to the name it was saved as and
// calls progress(bytes) as it goes. Folders are skipped. Progress shows in
// a list at the bottom of the page; done() is called, and awaited, once
// all have been tried and any succeeded.
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
    let queue = Promise.resolve();
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
        const list = statusList();
        for (const name of folders) {
            line(list, name).textContent = `${name}: folders can't be uploaded`;
        }
        // One upload at a time, after any still going from an earlier drop.
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
    });
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
