import { test } from "node:test";
import assert from "node:assert/strict";
import { FolderModel } from "../tabtopd/folder-model.js";

test("older listings and invalidated requests cannot replace the current folder", () => {
    const m = new FolderModel();
    const old = m.begin();
    const next = m.begin();
    assert.equal(m.load(next, "new", [{ name: "new.txt" }]), true);
    assert.equal(m.load(old, "old", [{ name: "old.txt" }]), false);
    assert.equal(m.dir, "new");
    assert.deepEqual(m.entries, [{ name: "new.txt" }]);
    m.invalidate();
    assert.equal(m.load(next, "new", []), false);
    assert.equal(m.dir, null);
});

test("refresh keeps selections by name and binds them to fresh entries", () => {
    const m = new FolderModel();
    m.load(m.begin(), "photos", [{ name: "a", bytes: 1 }, { name: "b" }]);
    m.select("a", true);
    m.select("b", true);
    m.filter = "a";
    const kept = m.snapshot();
    const fresh = { name: "a", bytes: 20 };
    m.load(m.begin(), "photos", [fresh, { name: "c" }], kept);
    assert.deepEqual([...m.selected.keys()], ["a"]);
    assert.equal(m.selected.get("a"), fresh);
    assert.equal(m.filter, "a");
    m.load(m.begin(), "other", [{ name: "a" }]);
    assert.equal(m.selected.size, 0);
    assert.equal(m.filter, "");
});

test("filtering and sorting preserve hidden selections", () => {
    const m = new FolderModel();
    m.load(m.begin(), "", [{ name: "b", bytes: 20 }, { name: "a", bytes: 10 }, { name: "folder", dir: true }]);
    m.select("b", true);
    m.filter = " A ";
    m.selectVisible(true);
    assert.deepEqual([...m.selected.keys()], ["b", "a"]);
    m.selectVisible(false);
    assert.deepEqual([...m.selected.keys()], ["b"]);
    m.filter = "";
    m.sort = { key: "size", desc: true };
    assert.deepEqual(m.sorted.map((entry) => entry.name), ["folder", "b", "a"]);
    assert.deepEqual(m.entries.map((entry) => entry.name), ["b", "a", "folder"]);
});
