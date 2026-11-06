import { glyphs } from "./glyphs.js";

const EDIT_HIGHLIGHT = "tabtop.edit-highlight";
export function editHighlight() {
    try {
        return localStorage.getItem(EDIT_HIGHLIGHT) !== "0";
    } catch {
        return true;
    }
}
export function setEditHighlight(enabled) {
    try {
        localStorage.setItem(EDIT_HIGHLIGHT, enabled ? "1" : "0");
    } catch {
        // The current editor still keeps the choice.
    }
}

// Whether previews fill the window, as last chosen in this browser.
const PREVIEW_WIDE = "tabtop.preview-wide";
export function previewWide() {
    try {
        return localStorage.getItem(PREVIEW_WIDE) === "1";
    } catch {
        return false;
    }
}
export function setPreviewWide(wide) {
    try {
        localStorage.setItem(PREVIEW_WIDE, wide ? "1" : "0");
    } catch {
        // Only for now, then.
    }
}

// The themes for what's shown in a frame (rendered Markdown, a book), in
// the order the button goes through them: as the system is, light, dark;
// as last chosen in this browser.
export const THEMES = { "": [glyphs.themeAuto, "Light or dark as the system is"], light: [glyphs.themeLight, "Light"], dark: [glyphs.themeDark, "Dark"] };
const READING_THEME = "tabtop.reading-theme";
export function readingTheme() {
    try {
        const t = localStorage.getItem(READING_THEME) ?? "";
        return Object.hasOwn(THEMES, t) ? t : "";
    } catch {
        return "";
    }
}
export function setReadingTheme(t) {
    try {
        localStorage.setItem(READING_THEME, t);
    } catch {
        // Only for now, then.
    }
}

// The ways text files are shown other than as text, by format: whether
// they are is kept in this browser, under key, as shown or text (the
// values Markdown's has always had); and the view button's text and title
// for each way.
export const VIEWS = {
    html: { key: "tabtop.html-view", shown: "rendered", text: "source",
        toText: [glyphs.source, "Source: the HTML as written"], toShown: [glyphs.markdown, "Rendered: the HTML as it reads"] },
    markdown: { key: "tabtop.markdown-view", shown: "rendered", text: "source",
        toText: [glyphs.source, "Source: the Markdown as written"], toShown: [glyphs.markdown, "Rendered: the Markdown as it reads"] },
    table: { key: "tabtop.table-view", shown: "table", text: "text",
        toText: [glyphs.source, "Raw: the file as it is, as text"], toShown: [glyphs.table, "Table: the file as a table"] },
    json: { key: "tabtop.json-view", shown: "tree", text: "text",
        toText: [glyphs.source, "Raw: the JSON as it is, as text"], toShown: [glyphs.json, "Tree: the JSON as a tree"] },
};

export function viewShown(format) {
    try {
        return localStorage.getItem(VIEWS[format].key) !== VIEWS[format].text;
    } catch {
        return true;
    }
}
export function setViewShown(format, shown) {
    try {
        localStorage.setItem(VIEWS[format].key, shown ? VIEWS[format].shown : VIEWS[format].text);
    } catch {
        // Only for now, then.
    }
}

// Where each book was read to, in this browser, by its path and size: the
// most recent BOOK_PLACES of them.
const BOOK_PLACES = 50;
const placeKey = (path, size) => `${path}\n${size}`;
function bookPlaces() {
    try {
        const all = JSON.parse(localStorage.getItem("tabtop.bookPlaces") ?? "{}");
        return all && typeof all === "object" ? all : {};
    } catch {
        return {};
    }
}
export function bookPlace(path, size) {
    return bookPlaces()[placeKey(path, size)] ?? null;
}
// moveBookPlace keeps where the book at path was read to, as it changes
// size (its details changed).
export function moveBookPlace(path, from, to) {
    const place = bookPlace(path, from);
    if (place) {
        setBookPlace(path, to, place);
    }
}
export function setBookPlace(path, size, place) {
    const all = bookPlaces();
    delete all[placeKey(path, size)];
    all[placeKey(path, size)] = place;
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - BOOK_PLACES))) {
        delete all[k];
    }
    try {
        localStorage.setItem("tabtop.bookPlaces", JSON.stringify(all));
    } catch {
        // Not remembered, then.
    }
}

