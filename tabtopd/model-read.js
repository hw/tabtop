// readResource reads a file a 3D model refers to (see model-resources.js),
// at path in the files' root, as a Blob of its type, or throws if it isn't
// there or is bigger than MAX_RESOURCE (an error with tooBig). (model-view.js's default; a page
// of its own can read them another way.)
import { call, collect } from "./requests.js";
import { typeOf } from "./preview-model.js";
import { MAX_RESOURCE } from "./model-resources.js";

export async function readResource(path, signal) {
    const t = await call({ type: "file", path }, { signal });
    const abort = () => t.close();
    signal?.addEventListener("abort", abort, { once: true });
    try {
        if (t.reply.size > MAX_RESOURCE) throw Object.assign(new Error("it's too big"), { tooBig: true });
        return await collect(t, t.reply.size, () => {}, typeOf(path.split("/").pop())?.type ?? "application/octet-stream");
    } finally {
        signal?.removeEventListener("abort", abort);
        t.close();
    }
}
