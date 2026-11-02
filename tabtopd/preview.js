// Previews on the files page, served by tabtopd: pictures, video, sound
// and text, shown over the page instead of saved. The file is fetched
// through the tunnel as for a download and held in memory (see collect),
// so only files up to a size are previewed, and Download in the preview
// saves the copy it holds rather than fetching it again.
//
// A file shown as a page of this site could run scripts that read the
// session, and ~/Downloads holds whatever the desktop's browser saved. So
// each kind is shown by an element that can't run what's in it: <img> for
// pictures (an SVG's scripts don't run in one), <video> and <audio>, and
// text, web pages' and SVG's source included, as the text of a <pre>.
// Nothing is shown in a frame, which is why PDFs are downloaded instead.

import { call, collect, saveBlob } from "./requests.js";

function el(tag, props = {}, ...children) {
    const e = Object.assign(document.createElement(tag), props);
    e.append(...children);
    return e;
}

const join = (dir, name) => (dir ? `${dir}/${name}` : name);

// What's previewed, by extension: its kind and the type it's shown as.
const types = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
    bmp: "image/bmp", ico: "image/x-icon", svg: "image/svg+xml",
    mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime", ogv: "video/ogg",
    mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", oga: "audio/ogg", ogg: "audio/ogg", opus: "audio/ogg",
    wav: "audio/wav", flac: "audio/flac",
};
const textExtensions = new Set(("txt text md markdown rst org tex log csv tsv json jsonl ndjson xml yaml yml toml ini cfg conf " +
    "env properties sh bash zsh fish ps1 bat py rb pl php lua js mjs cjs ts tsx jsx go rs c h cc cpp cxx hpp java kt " +
    "swift cs scala sql diff patch css scss html htm srt vtt").split(" "));

// The most of each kind that's previewed, in bytes.
const limits = { image: 50e6, video: 200e6, audio: 200e6, text: 2e6 };

function typeOf(name) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
    if (Object.hasOwn(types, ext)) {
        return { kind: types[ext].split("/")[0], type: types[ext] };
    }
    // Names without an extension, as README and Makefile, are mostly text;
    // a file that isn't says so when it's shown.
    return !ext || textExtensions.has(ext) ? { kind: "text", type: "text/plain" } : null;
}

// previewable reports whether a file named name, of size bytes, is
// previewed.
export function previewable(name, bytes) {
    const t = typeOf(name);
    return !!t && bytes <= limits[t.kind];
}

// preview shows files[index] of files, [{name, bytes}] in the folder dir,
// and steps through the rest with the arrow buttons and keys. Download
// saves the one shown, or, before it's arrived, closes the preview and
// calls download(path).
export function preview(dir, files, index, download) {
    const name = el("strong");
    const where = el("span", { className: "hint" });
    const step = (by, text, label) => {
        const b = el("button", { type: "button", textContent: text, title: label });
        b.setAttribute("aria-label", label);
        b.addEventListener("click", () => show(index + by));
        return b;
    };
    const prev = step(-1, "‹", "Previous (←)");
    const next = step(1, "›", "Next (→)");
    const save = el("button", { type: "button", textContent: "Download" });
    const close = el("button", { type: "button", className: "close", textContent: "✕", title: "Close (Esc)" });
    close.setAttribute("aria-label", "Close");
    const body = el("div", { className: "body" });
    const dialog = el("dialog", { className: "preview" }, el("div", { className: "head" }, name, where, prev, next, save, close), body);

    // What's shown: counted, so a file that arrives after the next was
    // asked for is dropped; its tunnel while it's coming; then it.
    let shown = 0;
    let t = null;
    let blob = null;
    let url = null;
    const stop = () => {
        t?.close();
        t = null;
        blob = null;
        if (url) {
            URL.revokeObjectURL(url);
            url = null;
        }
    };
    const show = async (i) => {
        if (i < 0 || i >= files.length) {
            return;
        }
        const me = ++shown;
        stop();
        index = i;
        const f = files[i];
        name.textContent = f.name;
        dialog.setAttribute("aria-label", f.name);
        where.textContent = files.length > 1 ? `${i + 1} of ${files.length}` : "";
        prev.hidden = next.hidden = files.length < 2;
        prev.disabled = i === 0;
        next.disabled = i === files.length - 1;
        const status = el("p", { className: "hint", textContent: "Loading…" });
        body.replaceChildren(status);
        try {
            const tt = await call({ type: "file", path: join(dir, f.name) });
            if (me !== shown) {
                tt.close();
                return;
            }
            t = tt;
            const { size } = tt.reply;
            const { kind, type } = typeOf(f.name);
            if (size > limits[kind]) {
                throw new Error("it's grown too big to preview; download it instead");
            }
            const got = await collect(tt, size, (n) => (status.textContent = `Loading… ${size ? Math.floor(n * 100 / size) : 100}%`), type);
            if (me !== shown) {
                return;
            }
            t = null;
            blob = got;
            url = URL.createObjectURL(blob);
            const shownAs = await render(kind, blob, url, f.name);
            if (me === shown) {
                body.replaceChildren(shownAs);
            }
        } catch (err) {
            if (me === shown) {
                body.replaceChildren(el("p", { className: "error", textContent: `${f.name} can't be shown: ${err.message}` }));
            }
        }
    };

    save.addEventListener("click", () => {
        if (blob) {
            saveBlob(blob, files[index].name);
        } else {
            dialog.close();
            download(join(dir, files[index].name));
        }
    });
    close.addEventListener("click", () => dialog.close());
    dialog.addEventListener("keydown", (e) => {
        if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !e.target.closest("video, audio, input")) {
            e.preventDefault();
            show(index + (e.key === "ArrowLeft" ? -1 : 1));
        }
    });
    // A click on the backdrop, outside the box, closes it.
    dialog.addEventListener("click", (e) => {
        const r = dialog.getBoundingClientRect();
        if (e.target === dialog && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) {
            dialog.close();
        }
    });
    dialog.addEventListener("close", () => {
        shown++;
        stop();
        dialog.remove();
    });
    document.body.append(dialog);
    dialog.showModal();
    close.focus();
    show(index);
}

// render makes what shows blob, a file of kind at url.
async function render(kind, blob, url, name) {
    const unshown = (what) => el("p", { className: "error", textContent: `This browser can't show ${what}. Download it instead.` });
    if (kind === "image") {
        const img = el("img", { src: url, alt: name });
        img.addEventListener("error", () => img.replaceWith(unshown("this picture")));
        return img;
    }
    if (kind === "video" || kind === "audio") {
        const media = el(kind, { src: url, controls: true, playsInline: true });
        media.addEventListener("error", () => media.replaceWith(unshown(`this ${kind === "video" ? "video" : "sound"}`)));
        return media;
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!bytes.length) {
        return el("p", { className: "hint", textContent: "This file is empty." });
    }
    if (bytes.subarray(0, 8000).includes(0)) {
        return el("p", { className: "hint", textContent: "This file isn't text, so it can't be shown here. Download it instead." });
    }
    return el("pre", { textContent: new TextDecoder().decode(bytes) });
}
