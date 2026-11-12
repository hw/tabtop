import { glyphs } from "./glyphs.js";
import { store, stored, storeJSON, storedJSON } from "./stored.js";

const EDIT_HIGHLIGHT = "tabtop.edit-highlight";
export const editHighlight = () => stored(EDIT_HIGHLIGHT) !== "0";
export const setEditHighlight = (enabled) => store(EDIT_HIGHLIGHT, enabled ? "1" : "0");

// Whether previews fill the window, as last chosen in this browser.
const PREVIEW_WIDE = "tabtop.preview-wide";
export const previewWide = () => stored(PREVIEW_WIDE) === "1";
export const setPreviewWide = (wide) => store(PREVIEW_WIDE, wide ? "1" : "0");

// The themes for what's shown in a frame (rendered Markdown, a book), in
// the order the button goes through them: as the system is, light, dark;
// as last chosen in this browser.
export const THEMES = { "": [glyphs.themeAuto, "Light or dark as the system is"], light: [glyphs.themeLight, "Light"], dark: [glyphs.themeDark, "Dark"] };
const READING_THEME = "tabtop.reading-theme";
export function readingTheme() {
    const t = stored(READING_THEME, "");
    return Object.hasOwn(THEMES, t) ? t : "";
}
export const setReadingTheme = (t) => store(READING_THEME, t);

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

export const viewShown = (format) => stored(VIEWS[format].key) !== VIEWS[format].text;
export const setViewShown = (format, shown) => store(VIEWS[format].key, shown ? VIEWS[format].shown : VIEWS[format].text);

// Where each book was read to, in this browser, by its path and size: the
// most recent BOOK_PLACES of them.
const BOOK_PLACES = 50, BOOK_PLACES_KEY = "tabtop.bookPlaces";
const placeKey = (path, size) => `${path}\n${size}`;
function bookPlaces() {
    const all = storedJSON(BOOK_PLACES_KEY, {});
    return typeof all === "object" ? all : {};
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
    storeJSON(BOOK_PLACES_KEY, all);
}

