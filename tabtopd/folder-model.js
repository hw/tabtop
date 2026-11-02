import { sortEntries } from "./file-format.js";

// FolderModel owns listing generations and selection without depending on DOM.
export class FolderModel {
    constructor() {
        this.dir = null;
        this.revision = 0;
        this.entries = [];
        this.filter = "";
        this.sort = { key: "name", desc: false };
        this.selected = new Map();
    }
    begin() { return ++this.revision; }
    current(revision) { return revision === this.revision; }
    invalidate() { ++this.revision; this.dir = null; }
    load(revision, dir, entries, kept = null) {
        if (!this.current(revision)) return false;
        const names = kept?.selected ?? new Set();
        this.dir = dir;
        this.entries = entries;
        this.filter = entries.length ? kept?.filter ?? "" : "";
        this.selected = new Map(entries.filter((entry) => names.has(entry.name)).map((entry) => [entry.name, entry]));
        return true;
    }
    get visible() {
        const query = this.filter.trim().toLocaleLowerCase();
        return query ? this.entries.filter((entry) => entry.name.toLocaleLowerCase().includes(query)) : this.entries;
    }
    get sorted() { return sortEntries(this.visible, this.sort); }
    select(name, checked) {
        const entry = this.entries.find((entry) => entry.name === name);
        if (checked && entry) this.selected.set(name, entry);
        else this.selected.delete(name);
    }
    selectVisible(checked) {
        for (const entry of this.visible) {
            if (checked) this.selected.set(entry.name, entry);
            else this.selected.delete(entry.name);
        }
    }
    snapshot() { return { filter: this.filter, selected: new Set(this.selected.keys()) }; }
}
