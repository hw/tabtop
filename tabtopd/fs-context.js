// A page is bound to one filesystem root. Switching roots navigates to a new
// document so editors, range readers and upload retries cannot change roots.
const queryRoot = typeof location === "undefined" ? "" : new URLSearchParams(location.search).get("root") ?? "";
let current = { id: queryRoot || "downloads", label: "Downloads", shell_path: "~/Downloads", read_only: false };
let roots = [], loading;
export const rootStorageScope = () => new URL("../", import.meta.url).pathname + ":" + current.id + (current.version ? ":" + current.version : "");
export const filesystemRoot = () => current;
// onFilesPage is whether this is the files page, bound to a root it shows;
// any other (the desktop, the terminal) works with Downloads, as the
// server has it at its default place, and uploads into a root it asks for.
export const onFilesPage = () => typeof location === "undefined" || /\/fs\/?$/.test(location.pathname) || globalThis.tabtopOffline?.page === "files";
export const filesystemRoots = () => roots;
export const rootLabel = () => current.label;
export const rootPath = () => current.shell_path ?? current.path ?? current.label;
export const readOnlyRoot = () => !!current.read_only;
export function setFilesystemRoot(root) { current = root; }
export function updateFilesystemRoot(root) {
    if (root.id !== current.id) return;
    current = root;
    roots = roots.map(entry => entry.id === root.id ? root : entry);
}
// rootsLoading is the promise of the roots, once they're asked for.
export const rootsLoading = () => loading;
// rootsKnown resolves once the roots are first known, whenever they're
// asked for: before then, or after a try that failed.
let rootsReady;
const known = new Promise(resolve => { rootsReady = resolve; });
export const rootsKnown = () => known;
export function ensureFilesystemRoots(call) {
    loading ??= call({ type: "roots" }).then(t => {
        roots = t.reply.roots; t.close();
        rootsReady(roots);
        // The one named; or with none, the one the server has as the
        // default (Downloads at its default place, whatever it's named
        // here), as requests naming no root go to; else the first.
        const root = queryRoot ? roots.find(root => root.id === queryRoot)
            : roots.find(root => root.default) ?? roots.find(root => root.id === "downloads") ?? roots[0];
        if (!root) throw new Error("That filesystem root is unavailable. Choose another folder.");
        current = root;
        return roots;
    }).catch(err => { loading = null; throw err; });
    return loading;
}
// uploadRoot is, away from the files page, the root uploads go into, once
// chosen (see ensureUploadRoot in requests.js).
let uploadTarget = null;
export const uploadRoot = () => uploadTarget;
export function setUploadRoot(root) { uploadTarget = root; }
// uploadRootLabel names where uploads go: the root shown, on the files
// page; elsewhere the one chosen, or else Downloads at its default place
// if it can be written to; or null, if one's still to be asked for.
export function uploadRootLabel() {
    if (onFilesPage()) return rootLabel();
    return uploadTargetOrDefault()?.label ?? null;
}
// uploadRootPath is the same root's path, as a shell takes it.
export function uploadRootPath() {
    if (onFilesPage()) return rootPath();
    const root = uploadTargetOrDefault();
    return root ? root.shell_path ?? root.path ?? root.label : null;
}
const uploadTargetOrDefault = () => uploadTarget ?? roots.find(root => root.default && !root.read_only);
export function assertWritableRoot() {
    if (readOnlyRoot()) throw new Error("This folder is read-only.");
}
