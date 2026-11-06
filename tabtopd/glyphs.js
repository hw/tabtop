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
    desktop: '<rect x="2.5" y="4" width="20" height="13.5" rx="1.5"/><path d="M8.5 21h8m-4-3.5v3.5"/>',
    terminal: '<rect x="3" y="5" width="19" height="15" rx="2"/><path d="M7 10l3 2.5-3 2.5m5 1h5"/>',
    files: '<path d="M3 7.5a1.5 1.5 0 0 1 1.5-1.5h5l2 2.5h9a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5h-16a1.5 1.5 0 0 1-1.5-1.5z"/>',
    logout: '<path d="M10 4.5h-5v16h5m4-12l4.5 4-4.5 4m4.5-4h-10"/>',
    search: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5.5 5.5"/>',
    bell: '<path d="M6.5 17.5v-6.5a6 6 0 0 1 12 0v6.5l1.5 1.5h-15z"/><path d="M10.5 21.5h4"/>',
    "bell-off": '<path d="M6.5 17.5v-6.5a6 6 0 0 1 12 0v6.5l1.5 1.5h-15z"/><path d="M10.5 21.5h4M4 4l17 17"/>',
    security: '<path d="M12.5 3l7.5 3v5.5c0 4.6-3.2 8.6-7.5 10-4.3-1.4-7.5-5.4-7.5-10v-5.5z"/><path d="M9.5 12.5l2.2 2.2 4-4"/>',
    share: '<path d="M10.5 15l-1.8 1.8a4 4 0 0 1-5.7-5.6l4-4a4 4 0 0 1 5.7 0m1.8 2.8l1.8-1.8a4 4 0 0 1 5.7 5.6l-4 4a4 4 0 0 1-5.7 0M9 16l7-7"/>',
    back: '<path d="M10 5l-7 7 7 7M3 12h18"/>',
    "download": '<path d="M6 2h6v10h4L9 21 2 12h4z"/><path stroke-width="1.5" fill="var(--raised, white)" d="M19 14l4 1.3v2.6c0 2-1.6 3.8-4 4.6-2.4-.8-4-2.6-4-4.6v-2.6z"/>',
    "download-direct": '<path d="M9 2h6v10h5L12 22 4 12h5z"/>',
    // Arrow into a folder: extract ZIP entries beside the archive.
    "extract": '<path d="M3 9a1.5 1.5 0 0 1 1.5-1.5h5l2 2.5h9A1.5 1.5 0 0 1 22 11.5v7a1.5 1.5 0 0 1-1.5 1.5h-16A1.5 1.5 0 0 1 3 18.5z"/><path d="M12 2v11m-3-3l3 3 3-3"/>',
    "fold-all": '<path d="M8 3h13v13h-3"/><rect x="3" y="8" width="13" height="13" rx="1"/><path d="M6.5 14.5h6"/>',
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
};

// Most navigation/desktop icons use the original 25px noVNC-style grid.
// Preview icons retain their own grids, sizes, and stroke weights.
const metrics = {
    download: [18, 24, 1.8], "download-direct": [18, 24, 1.8], extract: [18, 24, 1.8],
    back: [18, 24, 1.8], "fold-all": [18, 24, 1.8], "fit-page": [18, 24, 1.8],
    "fit-width": [18, 24, 1.8], "actual-size": [28, 24, 1.8],
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
