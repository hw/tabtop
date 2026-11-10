// Static document resources share a bounded, cancellable cache. The sandbox
// receives bytes and object URLs, never session credentials or arbitrary fetch.
import { call, collect } from "./requests.js";
import { pictureLoader } from "./preview-pictures.js";
import { resolvePath, typeOf } from "./preview-model.js";

const limits = { css: 512 << 10, font: 8 << 20, image: 20 << 20 };
export function resourceAddress(src, base, dir) {
    try {
        if (typeof src !== "string" || src.length > 8192 || typeof base !== "string") return null;
        src = src.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "").replace(/[\t\r\n]/g, "");
        let address = src;
        if (/^https?:/i.test(base)) address = new URL(src, base).href;
        if (/^(https?:|\/\/)/i.test(address)) {
            const u = new URL(address.startsWith("//") ? "https:" + address : address);
            if (u.username || u.password || !["http:", "https:"].includes(u.protocol)) return null;
            u.hash = "";
            return { url: u.href, remote: true };
        }
        if (/^[a-z][a-z0-9+.-]*:/i.test(address) || address.startsWith("//")) return null;
        const folder = base.startsWith("local:") ? base.slice(6).split("/").slice(0, -1).join("/") : dir;
        const path = resolvePath(folder, address.split("#")[0]);
        return path === null ? null : { url: path, remote: false };
    } catch { return null; }
}
export function frameResources(dir, mode) {
    const loader = pictureLoader({
        resolve: input => {
            const { src, base = "", kind } = JSON.parse(input);
            const at = resourceAddress(src, base, dir);
            return at && Object.hasOwn(limits, kind) ? JSON.stringify({ ...at, kind }) : null;
        },
        load: async (input, reserve, signal) => {
            const { url, remote, kind } = JSON.parse(input);
            if (remote && mode === "none") return { error: "External resources are blocked." };
            if (remote && mode === "direct") return { url, base: url };
            if (!remote && (kind === "css" && !/\.css$/i.test(url) || kind === "font" && !/\.(woff2?|ttf|otf)$/i.test(url) || kind === "image" && typeOf(url.split("/").pop())?.kind !== "image")) return { error: "Not a supported resource." };
            let tunnel;
            const cancel = () => tunnel?.close();
            signal.addEventListener("abort", cancel, { once: true });
            try {
                signal.throwIfAborted();
                tunnel = await call(remote ? { type: "preview-resource", resource: kind, url } : { type: "file", path: url });
                signal.throwIfAborted();
                const { size } = tunnel.reply;
                if (!Number.isSafeInteger(size) || size < 0 || size > limits[kind] || !reserve(size)) throw new Error("Resource exceeds the preview budget.");
                const mime = remote ? tunnel.reply.mime : kind === "css" ? "text/css" : kind === "font" ? (/\.woff2$/i.test(url) ? "font/woff2" : /\.woff$/i.test(url) ? "font/woff" : "font/ttf") : typeOf(url.split("/").pop()).type;
                const blob = await collect(tunnel, size, () => {}, mime);
                signal.throwIfAborted();
                return { bytes: await blob.arrayBuffer(), mime, base: remote ? tunnel.reply.url : "local:" + url };
            } finally {
                signal.removeEventListener("abort", cancel);
                tunnel?.close();
            }
        },
    });
    return { read: request => loader.read(JSON.stringify(request)), stop: () => loader.stop() };
}
