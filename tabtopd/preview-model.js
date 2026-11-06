import { FILE_TYPES } from "./file-types.js";

// Pure preview metadata, navigation validation and file classification.
// What's previewed, by extension: its kind and the type it's shown as.

const textExtensions = new Set(("txt text md markdown rst org tex log csv tsv json jsonl ndjson xml yaml yml toml ini cfg conf " +
    "env properties sh bash zsh fish ps1 bat py rb pl php lua js mjs cjs ts tsx jsx go rs c h cc cpp cxx hpp java kt " +
    "swift cs scala sql diff patch css scss html htm srt vtt").split(" "));

// The language highlight.js colours text in, by extension, or by the whole
// name for names without one.
const languages = {
    md: "markdown", markdown: "markdown", json: "json", jsonl: "json", ndjson: "json", xml: "xml", html: "xml", htm: "xml",
    yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini", cfg: "ini", conf: "ini", properties: "ini", env: "bash",
    sh: "bash", bash: "bash", zsh: "bash", fish: "bash", ps1: "powershell", bat: "dos", py: "python", rb: "ruby", pl: "perl",
    php: "php", lua: "lua", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "typescript",
    tsx: "typescript", go: "go", rs: "rust", c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", java: "java",
    kt: "kotlin", swift: "swift", cs: "csharp", scala: "scala", sql: "sql", diff: "diff", patch: "diff", css: "css",
    scss: "scss", tex: "latex", dockerfile: "dockerfile", makefile: "makefile", gnumakefile: "makefile",
    "nginx.conf": "nginx", ".bashrc": "bash", ".profile": "bash", ".zshrc": "bash",
};

// languageOf is the language to colour the file named name in, or "".
export function languageOf(name) {
    const lower = name.toLowerCase();
    if (Object.hasOwn(languages, lower)) {
        return languages[lower];
    }
    const dot = lower.lastIndexOf(".");
    return dot > 0 && Object.hasOwn(languages, lower.slice(dot + 1)) ? languages[lower.slice(dot + 1)] : "";
}

// The most of each kind that's previewed, in bytes.
// Audio, video and PDFs are read in ranges, and a book a chapter at a time
// (see epubFrame), so these have no whole-file buffer limit.
export const binaryChunkSize = 1_000_000;

export const limits = { image: 50e6, video: Number.MAX_SAFE_INTEGER, audio: Number.MAX_SAFE_INTEGER, text: 2e6, hex: 2e6, pdf: Number.MAX_SAFE_INTEGER, epub: Number.MAX_SAFE_INTEGER, zip: Number.MAX_SAFE_INTEGER };

export function typeOf(name) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
    if (Object.hasOwn(FILE_TYPES, ext)) {
        const { kind, mime: type } = FILE_TYPES[ext];
        return { kind, type };
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

// formatOf is the format a text file named name has another view for:
// HTML, Markdown, table (CSV, TSV) or JSON (JSON, JSON Lines); or "".
export function formatOf(name) {
    const ext = name.toLowerCase().split(".").pop();
    if (ext === "html" || ext === "htm") return "html";
    if (languageOf(name) === "markdown") {
        return "markdown";
    }
    return ext === "csv" || ext === "tsv" ? "table" : ext === "json" || ext === "jsonl" || ext === "ndjson" ? "json" : "";
}
export const jsonLines = (name) => /\.(jsonl|ndjson)$/i.test(name);

// External destinations are validated again outside the sandbox.
export function previewWebURL(value) {
    if (typeof value !== "string" || value.length > 16384) return null;
    try {
        const url = new URL(value);
        return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
    } catch {
        return null;
    }
}

// Keep only bounded, serializable reading positions from sandboxed previews.
export function previewLocation(kind, value) {
    if (!value || typeof value !== "object") return null;
    const finite = (n, lo, hi) => Number.isFinite(n) && n >= lo && n <= hi;
    if ((kind === "markdown" || kind === "html") && finite(value.top, 0, 1e9) && finite(value.left, -1e9, 1e9)) {
        return { kind, top: value.top, left: value.left };
    }
    if (kind === "epub" && typeof value.item === "string" && value.item.length > 0 && value.item.length < 1000 &&
        finite(value.fraction, 0, 1) && Number.isInteger(value.size) && finite(value.size, 0, 6)) {
        return { kind, item: value.item, fraction: value.fraction, size: value.size };
    }
    if (kind === "pdf" && Number.isSafeInteger(value.page) && finite(value.page, 1, 1e6) &&
        finite(value.offset, 0, 1) && finite(value.left, -1e9, 1e9) && finite(value.zoom, 0.25, 4) &&
        ["width", "page", "actual"].includes(value.mode)) {
        return { kind, page: value.page, offset: value.offset, left: value.left, zoom: value.zoom, mode: value.mode };
    }
    return null;
}

// resolvePath names a path within Downloads, or null when it escapes it.
export function resolvePath(dir, p) {
    let decoded;
    try {
        decoded = decodeURIComponent(p.split("?")[0]);
    } catch {
        return null;
    }
    if (decoded.startsWith("/")) {
        return null;
    }
    if (decoded === "") {
        return "";
    }
    const parts = dir ? dir.split("/") : [];
    for (const s of decoded.split("/")) {
        if (s === "" || s === ".") {
            continue;
        }
        if (s === "..") {
            if (!parts.length) {
                return null;
            }
            parts.pop();
        } else {
            parts.push(s);
        }
    }
    return parts.join("/");
}

