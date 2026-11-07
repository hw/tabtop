// Bounds both cached source bytes and every image delivered to a render.
// Canonical keys deduplicate fragment/path aliases, while repeated uses still
// spend the delivery budget. Each render owns and cancels its loader.
export const PICTURE_COUNT = 100;
export const PICTURE_BYTES = 64 * 1024 * 1024;

export function pictureLoader({ resolve, load, maxPictures = PICTURE_COUNT, maxBytes = PICTURE_BYTES }) {
    const cache = new Map();
    const abort = new AbortController();
    let requested = 0, retained = 0, delivered = 0;
    const unavailable = () => ({ error: "Picture preview limit reached (100 images or 64 MiB per render)." });
    return {
        async read(src) {
            if (abort.signal.aborted) return { error: "Preview closed." };
            if (++requested > maxPictures) return unavailable();
            const key = resolve(src);
            if (key === null) return { error: "not in Downloads, beside this file" };
            if (!cache.has(key)) {
                let reserved = 0;
                // Run the loader in a microtask so its promise is installed in
                // the cache before any duplicate request can start another read.
                cache.set(key, Promise.resolve().then(() => load(key, size => {
                    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes - retained) return false;
                    retained += size; reserved += size;
                    return true;
                }, abort.signal)).then(got => {
                    if (!got.bytes) retained -= reserved;
                    return got;
                }).catch(error => {
                    retained -= reserved;
                    return { error: error.message };
                }));
            }
            const got = await cache.get(key);
            if (abort.signal.aborted) return { error: "Preview closed." };
            if (got.bytes) {
                if (got.bytes.byteLength > maxBytes - delivered) return unavailable();
                delivered += got.bytes.byteLength;
            }
            return got;
        },
        stop() { abort.abort(); cache.clear(); },
    };
}
