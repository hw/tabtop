// Shared producer-side validation and cancellation for PDF/media byte reads.
// Consumers retain their own chunk caps and concurrency/worker policies.
export function validFileRange(begin, end, size, maxBytes) {
    return Number.isSafeInteger(begin) && Number.isSafeInteger(end) && begin >= 0 &&
        end <= size && end > begin && end - begin <= maxBytes;
}
export function createRangedFileReader({ call, collect }) {
    return async function readRange(path, file, begin, end, { maxBytes, signal } = {}) {
        if (!validFileRange(begin, end, file.size, maxBytes)) throw new Error("not a part of the file");
        signal?.throwIfAborted();
        // From the web: through a preview's resources, or the remote
        // browser's (file.via, "go-resource"), as the file says.
        const tunnel = await call({ ...(file.remote ? { type: file.via ?? "preview-resource", resource: "media", url: path } : { type: "file", path }), offset: begin, length: end - begin,
            if_mtime: file.mtime, if_size: file.size });
        const cancel = () => tunnel.close();
        signal?.addEventListener("abort", cancel, { once: true });
        try {
            signal?.throwIfAborted();
            if (file.remote && (tunnel.reply.total_size !== file.size || tunnel.reply.mime !== file.type ||
                file.mtime && tunnel.reply.validator !== file.mtime)) throw new Error("The remote media changed; reopen the preview.");
            if (tunnel.bytes instanceof ArrayBuffer) {
                if (tunnel.bytes.byteLength !== end - begin) throw new Error("Incomplete media range.");
                return tunnel.bytes;
            }
            const blob = await collect(tunnel, end - begin, () => {}, file.type ?? "application/octet-stream");
            signal?.throwIfAborted();
            return await blob.arrayBuffer();
        } finally {
            signal?.removeEventListener("abort", cancel);
            tunnel.close();
        }
    };
}
