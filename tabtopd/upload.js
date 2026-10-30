// Uploads for the downloads listing without WEB_E2E, served by tabtopd
// (see upload.go): a file dropped on the page is PUT to the folder's URL
// plus its name, then the listing is refreshed in place.

import { dropUploads } from "./drop.js";

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

dropUploads(put, refresh);
