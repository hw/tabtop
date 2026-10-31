// Uploads and deletions for the downloads listing without WEB_E2E, served
// by tabtopd (see upload.go and delete.go): a file dropped on the page, or
// picked with its button, is PUT to the folder's URL plus its name, a
// file's delete button sends a DELETE of its URL, and then the listing is
// refreshed in place.

import { deleteFile, dropUploads } from "./drop.js";

function put(file, progress) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", location.pathname.replace(/\/?$/, "/") + encodeURIComponent(file.name));
        xhr.responseType = "json";
        xhr.upload.onprogress = (e) => progress(e.loaded);
        xhr.onload = () => {
            if (xhr.status === 201 && xhr.response?.name) {
                resolve(xhr.response.name);
            } else if (xhr.status === 401) {
                reject(new Error("logged out; reload the page"));
            } else {
                reject(new Error(xhr.response?.error || `server error ${xhr.status}`));
            }
        };
        xhr.onerror = () => reject(new Error("connection lost"));
        xhr.send(file);
    });
}

// refresh replaces the listing with the server's current one.
async function refresh() {
    const res = await fetch(location.href, { cache: "no-store" });
    const fresh = new DOMParser().parseFromString(await res.text(), "text/html").querySelector("table");
    if (res.ok && fresh) {
        document.querySelector("table").replaceWith(fresh);
    }
}

async function remove(href) {
    const res = await fetch(location.pathname.replace(/\/?$/, "/") + href, { method: "DELETE" });
    if (res.status === 401) {
        throw new Error("logged out; reload the page");
    }
    if (!res.ok) {
        throw new Error((await res.json().catch(() => null))?.error || `server error ${res.status}`);
    }
}

document.querySelector("p.upload")?.prepend(dropUploads(put, refresh)());
// The table is replaced on refresh, so its buttons are handled here.
document.addEventListener("click", (e) => {
    const button = e.target.closest("button.delete");
    if (button) {
        deleteFile(button.dataset.name, () => remove(button.dataset.href), refresh);
    }
});
