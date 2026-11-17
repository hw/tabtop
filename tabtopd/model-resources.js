// The files a 3D model refers to (glTF's buffers and pictures, an OBJ's
// materials, .mtl, and their textures, an FBX's textures), read from
// beside it, for model-view.js: found where the model says, relative to
// its folder; else, by name alone, in its folder (as a model made
// elsewhere names them where they were there: C:\Users\…\wood.png). Never
// from the web, nor outside the files' root (the server sees to that).
import { resolvePath } from "./preview-model.js";

// At most this many files are read for a model, each at most
// MAX_RESOURCE bytes, all of them at most MAX_RESOURCES_TOTAL.
export const MAX_RESOURCE_FILES = 64;
export const MAX_RESOURCE = 64 << 20;
export const MAX_RESOURCES_TOTAL = 256 << 20;
// At most this many of what a model names are looked for (found or not:
// one naming thousands that aren't there doesn't have them all asked for).
export const MAX_RESOURCE_LOOKUPS = 4 * MAX_RESOURCE_FILES;

// What a model's reference to a file that isn't there is given: a URL a
// loader can load, so it doesn't go elsewhere; a picture of one white,
// opaque pixel, so a texture that isn't there leaves its colour as it is
// (not black, as a see-through one would make it).
export const BLANK = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC";

const join = (dir, name) => (dir ? `${dir}/${name}` : name);

// resourceCandidates is where the file a model in dir refers to as ref
// may be, in the order they're tried: the paths, within the files' root.
// uri says ref is a URI (glTF's are: percent-encoded); otherwise it's a
// name as written (an MTL's, an FBX's). A web address, or a data: or
// blob: URL, isn't one of these: none. A name alone is also looked for in
// the folders near names, beside the model (an FBX's own .fbm folder,
// textures/: FBX's loader leaves only the name of what's in a folder).
export function resourceCandidates(dir, ref, { uri = false, near = [] } = {}) {
    let r = String(ref ?? "").trim();
    if (!r) return [];
    // A scheme, but not a Windows drive (C:\ or C:/).
    if (/^[a-z][a-z0-9+.-]*:/i.test(r) && !/^[a-z]:[\\/]/i.test(r)) return [];
    if (!uri) r = r.split(/[\\/]/).map(encodeURIComponent).join("/");
    else r = r.replace(/\\/g, "/");
    const segments = r.split("/").filter(Boolean);
    const name = segments.at(-1) ?? "";
    const out = [];
    const absolute = r.startsWith("/") || /^[a-z]%3A$/i.test(segments[0] ?? "") || /^[a-z]:$/i.test(segments[0] ?? "");
    if (!absolute) {
        const p = resolvePath(dir, segments.join("/"));
        if (p) out.push(p);
    }
    const alone = name && resolvePath(dir, name);
    if (alone && !out.includes(alone)) out.push(alone);
    if (segments.length === 1 && name) {
        for (const folder of near) {
            const p = resolvePath(dir, `${encodeURIComponent(folder)}/${name}`);
            if (p && !out.includes(p)) out.push(p);
        }
    }
    return out;
}

// fetchResources reads what a model in dir refers to, refs, with read
// (path, signal) => a Blob, or throwing if it isn't there. It resolves to
// {urls: a Map of each ref found to a blob: URL of it, blobs and paths (of
// each ref found: what it is, and where), missing: the refs not (of them,
// tooBig: those there, but too big to read), revoke() to let the URLs go}.
// With uri, refs are URIs; near, folders names alone are looked for in
// too (see above).
export async function fetchResources(dir, refs, read, { uri = false, near = [], signal } = {}) {
    const urls = new Map(), blobs = new Map(), paths = new Map(), missing = [], tooBig = [], made = [];
    let total = 0, files = 0, lookups = 0;
    for (const ref of [...new Set(refs)]) {
        signal?.throwIfAborted();
        const candidates = resourceCandidates(dir, ref, { uri, near });
        let blob = null, found = "";
        if (files < MAX_RESOURCE_FILES && candidates.length && lookups++ < MAX_RESOURCE_LOOKUPS) {
            for (const path of candidates) {
                try {
                    blob = await read(path, signal);
                } catch (err) {
                    if (signal?.aborted) throw err;
                    // (There, but too big: said so, not looked for elsewhere.)
                    if (err?.tooBig) {
                        tooBig.push(ref);
                        break;
                    }
                    continue;
                }
                if (blob.size > MAX_RESOURCE || total + blob.size > MAX_RESOURCES_TOTAL) {
                    blob = null;
                    tooBig.push(ref);
                }
                found = path;
                break;
            }
        }
        if (!blob) {
            if (candidates.length) missing.push(ref);
            continue;
        }
        files++;
        total += blob.size;
        const url = URL.createObjectURL(blob);
        made.push(url);
        urls.set(ref, url);
        blobs.set(ref, blob);
        paths.set(ref, found);
    }
    return { urls, blobs, paths, missing, tooBig, revoke: () => made.forEach((u) => URL.revokeObjectURL(u)) };
}

// gltfReferences is what a glTF's JSON (parsed) refers to by URI, not
// data: URLs: its buffers', then its pictures'.
export function gltfReferences(json) {
    return [...(json.buffers ?? []), ...(json.images ?? [])].map((x) => x?.uri).filter((u) => typeof u === "string" && !/^data:/i.test(u));
}

// glbJSON is a .glb's JSON, parsed (its first chunk), or throws.
export function glbJSON(buffer) {
    const v = new DataView(buffer);
    if (buffer.byteLength < 20 || v.getUint32(0, true) !== 0x46546c67) throw new Error("it isn't a binary glTF");
    const length = v.getUint32(12, true);
    if (v.getUint32(16, true) !== 0x4e4f534a || 20 + length > buffer.byteLength) throw new Error("its JSON is missing");
    return JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, length)));
}

// COMPRESSED are the glTF extensions model-decode.js decodes (in a worker:
// Draco's meshes, meshopt's buffers, KTX2 textures).
export const COMPRESSED = new Set(["KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_meshopt_compression", "KHR_texture_basisu"]);

// fbxText is an FBX's text, if it's a text (ASCII) one, not binary, made
// what three.js's FBX loader reads; else null. That loader turns the first
// space in each part of a property ("P:" line) into "_" (so "Lcl Rotation"
// is "Lcl_Rotation"), so values written with spaces after their commas
// (-90, -0, 0: as Assimp and others write them; Autodesk's own don't)
// aren't numbers to it, and the model's transforms are lost: those spaces
// taken out (of what's after a line's last quoted part, only). And it
// makes numbers only of properties of the types it knows: a texture's
// Scaling and Translation, of type "Vector" (as Autodesk's, too, write
// them), stay text, so the texture's repeat is nonsense: "Vector",
// "Vector2D" and "Vector4D" called "Vector3D", which it knows.
export function fbxText(bytes) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 20));
    if (head.startsWith("Kaydara FBX Binary")) return null;
    const text = new TextDecoder().decode(bytes);
    return text
        // (Spaces and tabs only, not \s: that runs over line ends, and a file
        // of many blank lines took time growing with their square.)
        .replace(/^([ \t]*P:[^\n]*")([^"\n]*)$/gm, (_, quoted, values) => quoted + values.replace(/,[ \t]+/g, ","))
        .replace(/^([ \t]*P:[ \t]*"[^"\n]*",[ \t]*")(?:Vector|Vector2D|Vector4D)(")/gm, "$1Vector3D$2");
}

// fbxTextVersion is a text FBX's version (7500 for 7.5), or 0 if it doesn't say.
export function fbxTextVersion(text) {
    const m = /^\s*FBXVersion:\s*(\d+)/m.exec(text.slice(0, 4096)) ?? /^; FBX (\d+)\.(\d+)/m.exec(text.slice(0, 200));
    if (!m) return 0;
    return m[2] !== undefined ? Number(m[1]) * 1000 + Number(m[2]) * 100 : Number(m[1]);
}
