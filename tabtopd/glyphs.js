// TabTop's UI glyphs. This module has no DOM or session dependencies, so
// it can also be loaded by the sandboxed PDF and EPUB frames.
// Labels, tooltips, and event handlers belong to the controls using them.

export const glyphs = Object.freeze({
    up: "↑", down: "↓", left: "←", right: "→",
    previous: "‹", next: "›", close: "✕", edit: "✎", menu: "⋯",
    expand: "⤢", contract: "⤡", chevronUp: "▴", chevronDown: "▾", chevronRight: "▸",
    triangleUp: "▲", triangleDown: "▼", filter: "▽", sort: "⇅",
    source: "≡", markdown: "¶", table: "▦", json: "{ }",
    themeAuto: "◐", themeLight: "☀", themeDark: "☾",
    folder: "📁", upFolder: "⬑", contents: "☰",
    minus: "−", plus: "+", fontSmaller: "A−", fontLarger: "A+", font: "Aa", notification: "🔔",
});

const speaker = '<path d="M3.5 9.5h3.5l4.5-4v14l-4.5-4h-3.5z" fill="currentColor"/>';
const microphone = '<rect x="8" y="3" width="6" height="11" rx="3" fill="currentColor"/>'
    + '<path d="M5 11.5a6 6 0 0 0 12 0M11 17.5v4m-3 0h6"/>';

const icons = {
    "scan-document": '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M7 6h7l3 3v9H7zM10 12h4m-4 3h4"/>',
    "invert-selection": '<rect x="3" y="3" width="18" height="18" rx="1" stroke-dasharray="2 2"/><path d="M12 4h8v16H4v-8h8z" fill="currentColor" opacity=".4"/><path d="M6 6h6v6H6z"/>',
    desktop: '<rect x="2.5" y="4" width="20" height="13.5" rx="1.5"/><path d="M8.5 21h8m-4-3.5v3.5"/>',
    terminal: '<rect x="3" y="5" width="19" height="15" rx="2"/><path d="M7 10l3 2.5-3 2.5m5 1h5"/>',
    files: '<path d="M3 7.5a1.5 1.5 0 0 1 1.5-1.5h5l2 2.5h9a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5h-16a1.5 1.5 0 0 1-1.5-1.5z"/>',
    logout: '<path d="M10 4.5h-5v16h5m4-12l4.5 4-4.5 4m4.5-4h-10"/>',
    search: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5.5 5.5"/>',
    bell: '<path d="M6.5 17.5v-6.5a6 6 0 0 1 12 0v6.5l1.5 1.5h-15z"/><path d="M10.5 21.5h4"/>',
    "bell-off": '<path d="M6.5 17.5v-6.5a6 6 0 0 1 12 0v6.5l1.5 1.5h-15z"/><path d="M10.5 21.5h4M4 4l17 17"/>',
    security: '<path d="M12.5 3l7.5 3v5.5c0 4.6-3.2 8.6-7.5 10-4.3-1.4-7.5-5.4-7.5-10v-5.5z"/><path d="M9.5 12.5l2.2 2.2 4-4"/>',
    share: '<path d="M10.5 15l-1.8 1.8a4 4 0 0 1-5.7-5.6l4-4a4 4 0 0 1 5.7 0m1.8 2.8l1.8-1.8a4 4 0 0 1 5.7 5.6l-4 4a4 4 0 0 1-5.7 0M9 16l7-7"/>',
    "external-none": '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c-5 5-5 13 0 18M12 3c5 5 5 13 0 18"/><path d="M3 3l18 18"/>',
    "external-proxy": '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c-5 5-5 13 0 18M12 3c5 5 5 13 0 18"/><path d="M15 15h7v4l-3.5 3-3.5-3z"/>',
    "external-direct": '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c-5 5-5 13 0 18M12 3c5 5 5 13 0 18"/><path d="M16 2h6v6m0-6-7 7"/>',
    syntax: '<path d="M8 6l-6 6 6 6m8-12l6 6-6 6M14 3l-4 18"/>',
    binary: '<rect x="4" y="4" width="5" height="7" rx="1"/><path d="M15 4h2v7m-2 0h4M4 15h2v7m-2 0h4"/><rect x="14" y="15" width="5" height="7" rx="1"/>',
    preview: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
    back: '<path d="M10 5l-7 7 7 7M3 12h18"/>',
    "download": '<path d="M6 2h6v10h4L9 21 2 12h4z"/><path stroke-width="1.5" fill="var(--raised, white)" d="M19 14l4 1.3v2.6c0 2-1.6 3.8-4 4.6-2.4-.8-4-2.6-4-4.6v-2.6z"/>',
    "download-direct": '<path d="M9 2h6v10h5L12 22 4 12h5z"/>',
    // Arrow into a folder: extract ZIP entries beside the archive.
    "extract": '<path d="M3 9a1.5 1.5 0 0 1 1.5-1.5h5l2 2.5h9A1.5 1.5 0 0 1 22 11.5v7a1.5 1.5 0 0 1-1.5 1.5h-16A1.5 1.5 0 0 1 3 18.5z"/><path d="M12 2v11m-3-3l3 3 3-3"/>',
    "fold-all": '<path d="M8 3h13v13h-3"/><rect x="3" y="8" width="13" height="13" rx="1"/><path d="M6.5 14.5h6"/>',
    // The picture preview: zoom, and editing (see image-view.js).
    "zoom-in": '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5l5.5 5.5M7.5 10.5h6m-3-3v6"/>',
    "zoom-out": '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5l5.5 5.5M7.5 10.5h6"/>',
    "rotate-left": '<path d="M4 4v5h5"/><path d="M4.5 9A8 8 0 1 1 6 17"/>',
    "rotate-right": '<path d="M20 4v5h-5"/><path d="M19.5 9A8 8 0 1 0 18 17"/>',
    "flip-h": '<path d="M12 2v20"/><path d="M9 6L3 18h6zM15 6l6 12h-6z"/>',
    "flip-v": '<path d="M2 12h20"/><path d="M6 9L18 3v6zM6 15l12 6v-6z"/>',
    crop: '<path d="M6 2v16h16"/><path d="M2 6h16v16"/>',
    resize: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 16l8-8M8 12v4h4M12 8h4v4"/>',
    inpaint: '<path d="M4 17l10-10 5 5-10 10H4zM12 9l5 5M18 2v4m-2-2h4M3 6v4M1 8h4"/>',
    "scan-corners": '<path d="M6.5 5.5l11-1.5 2.5 15.5-15.5.5z"/><circle cx="6.5" cy="5.5" r="2" fill="currentColor"/><circle cx="17.5" cy="4" r="2" fill="currentColor"/><circle cx="20" cy="19.5" r="2" fill="currentColor"/><circle cx="4.5" cy="20" r="2" fill="currentColor"/>',
    "scan-preview": '<path d="M11 21H5V3h8l4 4v4M13 3v4h4M8 10h6M8 14h3"/><circle cx="16" cy="16.5" r="3.5"/><path d="M18.5 19l2.5 2.5"/>',
    "select-area": '<rect x="3" y="3" width="18" height="18" rx="1" stroke-dasharray="3 3"/>',
    "select-circle": '<circle cx="12" cy="12" r="9" stroke-dasharray="3 3"/>',
    "draw-shape": '<rect x="3" y="3" width="11" height="11" rx="1"/><circle cx="15" cy="15" r="6"/>',
    "shape-rect": '<rect x="3.5" y="5.5" width="17" height="13" rx="1"/>',
    "shape-circle": '<circle cx="12" cy="12" r="8.5"/>',
    "shape-fill": '<rect x="4" y="4" width="16" height="16" rx="1" fill="currentColor"/>',
    "shape-outline": '<rect x="4" y="4" width="16" height="16" rx="1"/><rect x="8" y="8" width="8" height="8" rx=".5" stroke-dasharray="2 2" stroke-width="1"/>',
    pen: '<path d="M4 20l1.2-4.6L16.5 4.1a2 2 0 0 1 2.8 0l.6.6a2 2 0 0 1 0 2.8L8.6 18.8zM14.5 6l3.5 3.5"/>',
    highlighter: '<path d="M8 14l7.5-9.5 4 3.2L12 17zM8 14l-1.5 3.5L10 19l2-2M4 21h7"/>',
    redo: '<path d="M20 4v6h-6M20 10l-4-4a8 8 0 1 0-1 14"/>',
    history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6L3.5 8.5M3.5 4v4.5H8M12 7.5V12l3 2"/>',
    "paste-image": '<rect x="3" y="7" width="14" height="14" rx="1"/><path d="M3 17l4-4 3 3 2-2 5 5M9 4h11v11"/><circle cx="12.5" cy="11.5" r="1.3"/>',
    "select-all": '<rect x="3" y="3" width="18" height="18" rx="1" stroke-dasharray="3 3"/><path d="M7 12l3 3 7-7"/>',
    filter: '<path d="M3 4h18l-7 8v7l-4 2v-9z"/>',
    "paint-brush": '<path d="M14 13l7-9-2-2-9 7zM10 10c-5-1-2 7-7 8 6 3 11-1 10-5"/>',
    erase: '<path d="M3 14l10-10a2 2 0 0 1 3 0l5 5a2 2 0 0 1 0 3l-9 9H8l-5-5a1.5 1.5 0 0 1 0-2zM8 9l10 10M12 21h9"/>',
    pan: '<path d="M8 12V6a2 2 0 0 1 4 0v6-8a2 2 0 0 1 4 0v8-6a2 2 0 0 1 4 0v8-4a2 2 0 0 1 4 0v5c0 5-4 7-8 7h-1c-2 0-4-1-5-3l-5-6a2 2 0 0 1 3-2l3 3" transform="translate(-2 0)"/>',
    undo: '<path d="M4 4v6h6M4 10l4-4a8 8 0 1 1 1 14"/>',
    "flood-fill": '<path d="M4 3l10 10M3 11l8-8 9 9-8 8zM4 12h15M19 16s-3 3-3 5a3 3 0 0 0 6 0c0-2-3-5-3-5z"/>',
    restore: '<path d="M14 13l7-9-2-2-9 7zM10 10c-5-1-2 7-7 8 6 3 11-1 10-5M4 3v4M2 5h4"/>',
    "clear-mask": '<rect x="3" y="3" width="18" height="18" rx="1" stroke-dasharray="3 3"/><path d="M8 8l8 8m0-8-8 8"/>',
    "save-options": '<path d="M3 6h3m4 0h11M3 12h11m4 0h3M3 18h5m4 0h9"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/>',
    "remove-background": '<rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="2 3"/><path d="M8 17l2-5 2 2 2-5 3 8z"/><path d="M5 5l14 14M18 3v4m-2-2h4"/>',
    "fit-page": '<rect x="3" y="1" width="18" height="22" rx="1"/><path stroke-width="1.5" d="M10 9L6 5m0 3V5h3M14 9l4-4m-3 0h3v3M10 15l-4 4m0-3v3h3M14 15l4 4m-3 0h3v-3"/>',
    "fit-width": '<path d="M3 5v14m18-14v14M5 12h14M8 9l-3 3 3 3m8-6l3 3-3 3"/>',
    "actual-size": '<rect x="2" y="4" width="20" height="16" rx="1"/><text x="12" y="12" text-anchor="middle" dominant-baseline="central" font-family="system-ui, sans-serif" font-size="6" font-weight="600" textLength="16" lengthAdjust="spacingAndGlyphs" fill="currentColor" stroke="none">100%</text>',
    "audio-off": speaker + '<path d="M15.5 10l5 5m0-5l-5 5"/>',
    "audio-connecting": speaker + '<path d="M15 12.5h.01m3 0h.01m3 0h.01"/>',
    "audio-on": speaker + '<path d="M15 9.5a4 4 0 0 1 0 6m3-9a8 8 0 0 1 0 12"/>',
    "audio-error": speaker + '<path d="M18 8.5v5m0 3.5h.01"/>',
    "mic-off": microphone + '<path d="M3 3l19 19"/>',
    "mic-connecting": microphone + '<path d="M18 4.5h.01m2 0h.01"/>',
    "mic-on": microphone,
    "mic-error": microphone + '<path d="M21 4v5m0 3.5h.01"/>',
    "close-circle": '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6m0-6l-6 6"/>',
    copy: '<rect x="8.5" y="8.5" width="11" height="12" rx="2"/><path d="M15.5 8.5V5.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2"/>',
    check: '<path d="M5 12.5l4.5 4.5 9.5-10"/>',
    inspector: '<rect x="2.5" y="4" width="19" height="16" rx="2"/><path d="M14 4v16M16.5 9h2.5M16.5 12.5h2.5M16.5 16h2.5"/>',
    // Search as hex bytes (a drawn 0x) or as ASCII text (a drawn Aa).
    "find-hex": '<ellipse cx="7" cy="12" rx="4" ry="7"/><path d="M14.5 10l6.5 9m0-9l-6.5 9"/>',
    "find-ascii": '<path d="M2.5 19l5-14 5 14M4.3 14h6.4"/><circle cx="18" cy="15.5" r="3.5"/><path d="M21.5 12v7"/>',
};

// Most navigation/desktop icons use the original 25px noVNC-style grid.
// Preview icons retain their own grids, sizes, and stroke weights.
const metrics = {
    "external-none": [18, 24, 1.8], "external-proxy": [18, 24, 1.8], "external-direct": [18, 24, 1.8],
    download: [18, 24, 1.8], "download-direct": [18, 24, 1.8], extract: [18, 24, 1.8],
    syntax: [18, 24, 1.8], binary: [18, 24, 1.8], preview: [18, 24, 1.8], back: [18, 24, 1.8], "fold-all": [18, 24, 1.8], "fit-page": [18, 24, 1.8],
    "fit-width": [18, 24, 1.8], "actual-size": [28, 24, 1.8], "close-circle": [18, 24, 1.8], copy: [14, 24, 2], check: [14, 24, 2.2], inspector: [18, 24, 1.8],
    "find-hex": [18, 24, 2], "find-ascii": [18, 24, 2],
    "zoom-in": [18, 24, 1.8], "zoom-out": [18, 24, 1.8], "rotate-left": [18, 24, 1.8], "rotate-right": [18, 24, 1.8],
    "flip-h": [18, 24, 1.8], "flip-v": [18, 24, 1.8], crop: [18, 24, 1.8], inpaint: [18, 24, 1.8], resize: [18, 24, 1.8], "remove-background": [18, 24, 1.8],
    "select-area": [18, 24, 1.8], "paint-brush": [18, 24, 1.8], erase: [18, 24, 1.8], pan: [18, 24, 1.8], undo: [18, 24, 1.8], "clear-mask": [18, 24, 1.8],
    "save-options": [18, 24, 1.8], "scan-document": [18, 24, 1.8], "scan-corners": [18, 24, 1.8], "scan-preview": [18, 24, 1.8],
    "select-circle": [18, 24, 1.8], "select-all": [18, 24, 1.8], "flood-fill": [18, 24, 1.8], restore: [18, 24, 1.8],
    pen: [18, 24, 1.8], highlighter: [18, 24, 1.8], redo: [18, 24, 1.8], history: [18, 24, 1.8], "paste-image": [18, 24, 1.8],
    "draw-shape": [18, 24, 1.8], "shape-rect": [18, 24, 1.8], "shape-circle": [18, 24, 1.8], "shape-fill": [18, 24, 1.8], "shape-outline": [18, 24, 1.8],
    filter: [16, 24, 1.8],
};
const attribute = (value) => String(value).replace(/[&"<>]/g,
    (c) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c]);

export function iconSVG(id, color = "currentColor") {
    if (!Object.hasOwn(icons, id)) {
        throw new Error(`Unknown icon: ${id}`);
    }
    const [size, grid, stroke] = metrics[id] ?? [25, 25, 2];
    const ink = attribute(color);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${grid} ${grid}" fill="none" `
        + `color="${ink}" stroke="${ink}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[id]}</svg>`;
}

export function iconDataURL(id, color = "#fff") {
    return "data:image/svg+xml," + encodeURIComponent(iconSVG(id, color));
}
