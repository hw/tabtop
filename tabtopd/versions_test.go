package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// keepAs saves text over the file at name in g, keeping what it was.
func keepAs(t *testing.T, g *fileService, dir, name, text string) {
	t.Helper()
	p := filepath.Join(dir, name)
	if f, err := os.Open(p); err == nil {
		g.keepVersion(name, f, false)
		f.Close()
	}
	// The kept one's a link: replace by a new file, as a save does.
	tmp := p + ".new"
	write(t, tmp, text)
	if err := os.Rename(tmp, p); err != nil {
		t.Fatal(err)
	}
}

// A save keeps what it replaces, which can be listed, read, and put back.
func TestVersionsKeptReadAndRestored(t *testing.T) {
	g, url, s, _, data, _ := newTransferServer(t)
	ctx := testCtx(t)
	root, _ := g.rootByID("data")
	files := g.scope(root)
	write(t, filepath.Join(data, "notes.txt"), "one")
	// Kept, then dropped again as a failed save would.
	f, _ := os.Open(filepath.Join(data, "notes.txt"))
	files.keepVersion("notes.txt", f, false)()
	f.Close()
	if versions, _ := files.versionsOf("notes.txt"); len(versions) != 0 {
		t.Fatalf("a dropped version stayed: %v", versions)
	}
	for _, text := range []string{"one", "two"} {
		f, _ := os.Open(filepath.Join(data, "notes.txt"))
		files.keepVersion("notes.txt", f, false)
		f.Close()
		tmp := filepath.Join(data, "notes.new")
		write(t, tmp, text+"+")
		os.Rename(tmp, filepath.Join(data, "notes.txt"))
		time.Sleep(time.Millisecond)
	}
	req := func(r tunnelRequest) (*tunnelClient, map[string]any) {
		if r.Root == "" {
			r.Root = "data"
		}
		tc := openSession(t, ctx, url, s)
		return tc, tc.request(t, ctx, r)
	}
	_, list := req(tunnelRequest{Type: "versions", Path: "notes.txt"})
	versions, _ := list["versions"].([]any)
	if len(versions) != 2 {
		t.Fatalf("versions: %v", list)
	}
	newest := versions[0].(map[string]any)["id"].(string)
	oldest := versions[1].(map[string]any)["id"].(string)
	tc, reply := req(tunnelRequest{Type: "version-file", Path: "notes.txt", Name: newest})
	if reply["ok"] != true || reply["size"] != float64(4) {
		t.Fatalf("version-file: %v", reply)
	}
	if kind, got, err := tc.read(ctx); err != nil || kind != msgData || string(got) != "one+" {
		t.Fatalf("version read %q: %v", got, err)
	}
	// Only by the file it's a version of.
	write(t, filepath.Join(data, "other.txt"), "x")
	if _, reply := req(tunnelRequest{Type: "version-file", Path: "other.txt", Name: newest}); reply["error"] != errNoVersion.Error() {
		t.Fatalf("another file's version: %v", reply)
	}
	// Not without saying how the file was, nor over a save since.
	if _, reply := req(tunnelRequest{Type: "version-restore", Path: "notes.txt", Name: oldest}); reply["ok"] == true {
		t.Fatalf("restored, not saying how it was: %v", reply)
	}
	mtime, size := list["mtime"].(string), int64(list["size"].(float64))
	if _, reply := req(tunnelRequest{Type: "version-restore", Path: "notes.txt", Name: oldest, IfMtime: mtime, IfSize: size + 1}); reply["error"] != errChangedSince.Error() {
		t.Fatalf("restored over a change: %v", reply)
	}
	// Put back, what it was is kept in turn.
	if _, reply := req(tunnelRequest{Type: "version-restore", Path: "notes.txt", Name: oldest, IfMtime: mtime, IfSize: size}); reply["ok"] != true {
		t.Fatalf("restore: %v", reply)
	}
	if got, _ := os.ReadFile(filepath.Join(data, "notes.txt")); string(got) != "one" {
		t.Fatalf("restored %q", got)
	}
	if versions, _ := files.versionsOf("notes.txt"); len(versions) != 3 {
		t.Fatalf("after restoring: %v", versions)
	}
	// Trash doesn't show them, nor does emptying it take them.
	_, trash := req(tunnelRequest{Type: "trash-list"})
	if entries, _ := trash["entries"].([]any); len(entries) != 0 {
		t.Fatalf("Trash shows versions: %v", trash)
	}
	req(tunnelRequest{Type: "trash-empty"})
	if versions, _ := files.versionsOf("notes.txt"); len(versions) != 3 {
		t.Fatalf("emptying Trash took versions: %v", versions)
	}
	// From a read-only root, no restoring.
	if _, reply := req(tunnelRequest{Type: "version-restore", Root: "documents", Path: "notes.txt", Name: oldest}); reply["ok"] == true {
		t.Fatalf("restored into a read-only root: %v", reply)
	}
}

// Bytes written into a file (the hex editor's) keep a copy of what it was.
func TestPatchKeepsVersion(t *testing.T) {
	g, _, _, _, data, _ := newTransferServer(t)
	root, _ := g.rootByID("data")
	files := g.scope(root)
	write(t, filepath.Join(data, "b.bin"), "abcd")
	st, _ := os.Stat(filepath.Join(data, "b.bin"))
	sum := sha256Hex([]byte("b"))
	if _, _, err := files.patchFile(tunnelRequest{Path: "b.bin", IfMtime: fileVersion(st), IfSize: 4,
		Patches: []bytePatch{{Offset: 1, Hex: "5a"}}, IfBytes: sum}); err != nil {
		t.Fatal(err)
	}
	versions, _ := files.versionsOf("b.bin")
	if len(versions) != 1 {
		t.Fatalf("versions: %v", versions)
	}
	f, _, err := files.openVersion("b.bin", versions[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	got := make([]byte, 8)
	n, _ := f.Read(got)
	if string(got[:n]) != "abcd" {
		t.Fatalf("kept %q", got[:n])
	}
}

// Only the latest few of a file are kept.
func TestVersionsPerFile(t *testing.T) {
	g, _, _, _, data, _ := newTransferServer(t)
	root, _ := g.rootByID("data")
	files := g.scope(root)
	write(t, filepath.Join(data, "a.txt"), "0")
	for i := 1; i <= versionsPerFile+3; i++ {
		keepAs(t, files, data, "a.txt", fmt.Sprint(i))
		time.Sleep(time.Millisecond)
	}
	versions, _ := files.versionsOf("a.txt")
	if len(versions) != versionsPerFile {
		t.Fatalf("kept %d", len(versions))
	}
	f, _, _ := files.openVersion("a.txt", versions[0].ID)
	defer f.Close()
	b := make([]byte, 8)
	n, _ := f.Read(b)
	if want := fmt.Sprint(versionsPerFile + 2); string(b[:n]) != want {
		t.Fatalf("newest kept is %q, not %q", b[:n], want)
	}
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// Versions go with the file, deleted for good; and one by one, or all.
func TestVersionsDeleted(t *testing.T) {
	g, url, s, _, data, _ := newTransferServer(t)
	ctx := testCtx(t)
	root, _ := g.rootByID("data")
	files := g.scope(root)
	req := func(r tunnelRequest) map[string]any {
		r.Root = "data"
		return openSession(t, ctx, url, s).request(t, ctx, r)
	}
	for _, name := range []string{"a.txt", "b.txt", "c.txt", "d.txt"} {
		write(t, filepath.Join(data, "f", name), "1")
		keepAs(t, files, data, "f/"+name, "2")
		keepAs(t, files, data, "f/"+name, "3")
	}
	count := func(name string) int { v, _ := files.versionsOf("f/" + name); return len(v) }
	// One, then the rest.
	v, _ := files.versionsOf("f/a.txt")
	if r := req(tunnelRequest{Type: "version-delete", Path: "f/a.txt", Name: v[0].ID}); r["deleted"] != float64(1) || count("a.txt") != 1 {
		t.Fatalf("one: %v", r)
	}
	if r := req(tunnelRequest{Type: "version-delete", Path: "f/a.txt"}); r["deleted"] != float64(1) || count("a.txt") != 0 {
		t.Fatalf("all: %v", r)
	}
	// Deleted for good: its versions go.
	if r := req(tunnelRequest{Type: "delete", Path: "f/b.txt", Permanent: true}); r["ok"] != true || count("b.txt") != 0 || count("c.txt") != 2 {
		t.Fatalf("permanent delete: %v; left %d, %d", r, count("b.txt"), count("c.txt"))
	}
	// To Trash, they go with it; emptied, they go.
	req(tunnelRequest{Type: "delete", Path: "f/c.txt"})
	write(t, filepath.Join(data, "f", "c.txt"), "new")
	if count("c.txt") != 0 || files.versionsInTrash(t) != 2 {
		t.Fatalf("moving to Trash: %d at the path, %d in Trash", count("c.txt"), files.versionsInTrash(t))
	}
	if r := req(tunnelRequest{Type: "trash-empty"}); r["ok"] != true || files.versionsInTrash(t) != 0 {
		t.Fatalf("emptying Trash: %v; left %d", r, files.versionsInTrash(t))
	}
}

// Versions gone to Trash with their file go with it when Trash drops it
// to keep to its limits; past their time, any go, whether or not
// anything's saved again.
func TestVersionsTidied(t *testing.T) {
	g, url, s, _, data, _ := newTransferServer(t)
	ctx := testCtx(t)
	root, _ := g.rootByID("data")
	files := g.scope(root)
	req := func(r tunnelRequest) map[string]any {
		r.Root = "data"
		return openSession(t, ctx, url, s).request(t, ctx, r)
	}
	for _, name := range []string{"kept.txt", "renamed.txt", "trashed.txt", "old.txt"} {
		write(t, filepath.Join(data, name), "1")
		keepAs(t, files, data, name, "2")
	}
	count := func(name string) int { v, _ := files.versionsOf(name); return len(v) }
	tidy := func(now time.Time) {
		store, _ := files.openStore()
		defer store.Close()
		trash, err := store.openTrash(true)
		if err != nil {
			t.Fatal(err)
		}
		defer trash.Close()
		files.tidyVersions(store, now)
	}
	os.Rename(filepath.Join(data, "renamed.txt"), filepath.Join(data, "other.txt"))
	req(tunnelRequest{Type: "delete", Path: "trashed.txt"})
	tidy(time.Now())
	// (One renamed away outside TabTop keeps its versions their time: it
	// may be back.)
	if count("kept.txt") != 1 || count("renamed.txt") != 1 || count("trashed.txt") != 0 || files.versionsInTrash(t) != 1 {
		t.Fatalf("left: %d, %d, %d, %d in Trash", count("kept.txt"), count("renamed.txt"), count("trashed.txt"), files.versionsInTrash(t))
	}
	// Trash pruned, as by its limits: its versions go, before a new file
	// there could take them.
	store, _ := files.openStore()
	trash, _ := store.openTrash(false)
	trash.pruneTrash(time.Now().Add(trashAge + time.Hour))
	trash.Close()
	store.Close()
	tidy(time.Now())
	if files.versionsInTrash(t) != 0 {
		t.Fatal("the versions of one gone from Trash stayed")
	}
	// Past their time, removed from the disk.
	tidy(time.Now().Add(versionAge))
	v, closeAll, err := files.versionStore(false)
	if err != nil {
		t.Fatal(err)
	}
	defer closeAll()
	if left, _ := v.trashEntries(); len(left) != 0 {
		t.Fatalf("versions past their time left: %v", left)
	}
}

// Renamed or moved, in its root or to another, a file's versions follow
// it.
func TestVersionsFollowRenames(t *testing.T) {
	g, url, s, downloads, data, _ := newTransferServer(t)
	ctx := testCtx(t)
	root, _ := g.rootByID("data")
	files := g.scope(root)
	req := func(r tunnelRequest) map[string]any {
		if r.Root == "" {
			r.Root = "data"
		}
		return openSession(t, ctx, url, s).request(t, ctx, r)
	}
	count := func(name string) int { v, _ := files.versionsOf(name); return len(v) }
	write(t, filepath.Join(data, "a.txt"), "1")
	keepAs(t, files, data, "a.txt", "2")
	write(t, filepath.Join(data, "f", "b.txt"), "1")
	keepAs(t, files, data, "f/b.txt", "2")
	// A stale one, of a file gone from where a.txt is going.
	write(t, filepath.Join(data, "c.txt"), "1")
	keepAs(t, files, data, "c.txt", "2")
	os.Remove(filepath.Join(data, "c.txt"))

	if r := req(tunnelRequest{Type: "rename", Path: "a.txt", Name: "c.txt"}); r["ok"] != true || count("a.txt") != 0 || count("c.txt") != 1 {
		t.Fatalf("rename: %v; %d, %d", r, count("a.txt"), count("c.txt"))
	}
	os.Mkdir(filepath.Join(data, "g"), 0o755)
	if r := req(tunnelRequest{Type: "move", Path: "f", To: "g"}); r["ok"] != true || count("f/b.txt") != 0 || count("g/f/b.txt") != 1 {
		t.Fatalf("move: %v; %d, %d", r, count("f/b.txt"), count("g/f/b.txt"))
	}
	if _, last := transfer(t, ctx, url, s, tunnelRequest{Root: "data", Path: "c.txt", ToRoot: "downloads"}); last["path"] != "c.txt" || count("c.txt") != 0 {
		t.Fatalf("moved to another root: %v; %d left", last, count("c.txt"))
	}
	if !exists(filepath.Join(downloads, "c.txt")) {
		t.Fatal("not moved")
	}
	if v, _ := g.scope(g.defaultRoot()).versionsOf("c.txt"); len(v) != 1 {
		t.Fatalf("versions there: %v", v)
	}
}

// A version a crash left part made is removed, once it's old enough not
// to be one being made.
func TestVersionsOrphansRemoved(t *testing.T) {
	g, _, _, _, data, _ := newTransferServer(t)
	root, _ := g.rootByID("data")
	files := g.scope(root)
	write(t, filepath.Join(data, "a.txt"), "1")
	keepAs(t, files, data, "a.txt", "2")
	orphan := filepath.Join(data, trashDir, versionsDir, "0123456789abcdef0123456789abcdef")
	write(t, filepath.Join(orphan, "data"), "half made")
	old := time.Now().Add(-2 * orphanGrace)
	os.Chtimes(orphan, old, old)
	store, _ := files.openStore()
	defer store.Close()
	trash, _ := store.openTrash(false)
	defer trash.Close()
	files.tidyVersions(store, time.Now())
	if exists(orphan) || files.versionsCount(t) != 1 {
		t.Fatal("the orphan stayed, or more went")
	}
}

func (g *fileService) versionsCount(t *testing.T) int {
	v, _ := g.versionsOf("a.txt")
	return len(v)
}

// versionsInTrash counts the versions kept with what's in Trash.
func (g *fileService) versionsInTrash(t *testing.T) int {
	t.Helper()
	v, closeAll, err := g.versionStore(false)
	if err != nil {
		return 0
	}
	defer closeAll()
	entries, _ := v.trashEntries()
	n := 0
	for _, e := range entries {
		if e.Trashed != "" {
			n++
		}
	}
	return n
}

// In Trash, a file's versions are kept with it, not shown for a new file
// at its path, nor taken by one renamed there; restored, under whatever
// name, they come back with it.
func TestVersionsGoWithTrash(t *testing.T) {
	g, url, s, _, data, _ := newTransferServer(t)
	ctx := testCtx(t)
	root, _ := g.rootByID("data")
	files := g.scope(root)
	req := func(r tunnelRequest) map[string]any {
		r.Root = "data"
		return openSession(t, ctx, url, s).request(t, ctx, r)
	}
	count := func(name string) int { v, _ := files.versionsOf(name); return len(v) }
	write(t, filepath.Join(data, "report.txt"), "1")
	keepAs(t, files, data, "report.txt", "2")
	keepAs(t, files, data, "report.txt", "3")
	gone := req(tunnelRequest{Type: "delete", Path: "report.txt"})
	write(t, filepath.Join(data, "draft.txt"), "draft")
	if r := req(tunnelRequest{Type: "rename", Path: "draft.txt", Name: "report.txt"}); r["ok"] != true || count("report.txt") != 0 {
		t.Fatalf("a new file at the path: %v, %d versions", r, count("report.txt"))
	}
	r := req(tunnelRequest{Type: "trash-restore", Name: gone["id"].(string)})
	if r["path"] != "report (1).txt" || count("report (1).txt") != 2 || count("report.txt") != 0 {
		t.Fatalf("restored: %v; %d, %d", r, count("report (1).txt"), count("report.txt"))
	}
}

// A folder being written into isn't renamed or moved from under what's
// writing, which knows it by its path.
func TestRenameWaitsForWrites(t *testing.T) {
	g, url, s, _, data, _ := newTransferServer(t)
	ctx := testCtx(t)
	root, _ := g.rootByID("data")
	req := func(r tunnelRequest) map[string]any {
		r.Root = "data"
		return openSession(t, ctx, url, s).request(t, ctx, r)
	}
	os.MkdirAll(filepath.Join(data, "a"), 0o755)
	os.MkdirAll(filepath.Join(data, "g"), 0o755)
	done, err := root.writes.begin("a")
	if err != nil {
		t.Fatal(err)
	}
	if r := req(tunnelRequest{Type: "rename", Path: "a", Name: "b"}); r["ok"] == true {
		t.Fatalf("renamed while written into: %v", r)
	}
	if r := req(tunnelRequest{Type: "move", Path: "a", To: "g"}); r["ok"] == true {
		t.Fatalf("moved while written into: %v", r)
	}
	done()
	if r := req(tunnelRequest{Type: "rename", Path: "a", Name: "b"}); r["ok"] != true {
		t.Fatalf("rename after: %v", r)
	}
}

// A file with another name (a hard link) is kept by a copy, not a link:
// written into by that name, its version stays as it was.
func TestVersionsOfHardLinkedFiles(t *testing.T) {
	g, _, _, _, data, _ := newTransferServer(t)
	root, _ := g.rootByID("data")
	files := g.scope(root)
	write(t, filepath.Join(data, "a.bin"), "first")
	if err := os.Link(filepath.Join(data, "a.bin"), filepath.Join(data, "b.bin")); err != nil {
		t.Skip(err)
	}
	keepAs(t, files, data, "a.bin", "second")
	f, _ := os.OpenFile(filepath.Join(data, "b.bin"), os.O_WRONLY, 0)
	f.WriteAt([]byte("CHANGED"), 0)
	f.Close()
	v, _ := files.versionsOf("a.bin")
	if len(v) != 1 {
		t.Fatalf("versions: %v", v)
	}
	kept, _, err := files.openVersion("a.bin", v[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	defer kept.Close()
	got := make([]byte, 16)
	n, _ := kept.Read(got)
	if string(got[:n]) != "first" {
		t.Fatalf("the version changed: %q", got[:n])
	}
}

// A write into a folder is seen by a delete or move of it by another
// path, through a link.
func TestWritesSeenThroughLinks(t *testing.T) {
	g, _, _, _, data, _ := newTransferServer(t)
	root, _ := g.rootByID("data")
	files := g.scope(root)
	os.MkdirAll(filepath.Join(data, "real", "sub"), 0o755)
	os.Symlink("real", filepath.Join(data, "link"))
	done, err := files.beginWrites("real/sub")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, busy := files.holdWrites("link/sub"); !busy {
		t.Fatal("deleted through a link while written into")
	}
	done()
	done, _ = files.beginWrites("link/sub")
	if _, _, busy := files.holdWrites("real/sub"); !busy {
		t.Fatal("written into through a link, deleted by its own path")
	}
	done()
	release, _, busy := files.holdWrites("real/sub")
	if busy {
		t.Fatal("busy with nothing written")
	}
	release(false, "")
}

// Reached through a link, a file's versions are found, and go with it,
// as by its own path.
func TestVersionsThroughLinks(t *testing.T) {
	g, url, s, _, data, _ := newTransferServer(t)
	ctx := testCtx(t)
	root, _ := g.rootByID("data")
	files := g.scope(root)
	req := func(r tunnelRequest) map[string]any {
		r.Root = "data"
		return openSession(t, ctx, url, s).request(t, ctx, r)
	}
	write(t, filepath.Join(data, "a", "f.txt"), "1")
	os.Symlink("a", filepath.Join(data, "lnk"))
	keepAs(t, files, data, "a/f.txt", "2")
	if r := req(tunnelRequest{Type: "versions", Path: "lnk/f.txt"}); len(r["versions"].([]any)) != 1 {
		t.Fatalf("through the link: %v", r)
	}
	req(tunnelRequest{Type: "delete", Path: "lnk/f.txt"})
	if v, _ := files.versionsOf("a/f.txt"); len(v) != 0 || files.versionsInTrash(t) != 1 {
		t.Fatalf("deleted through the link: %d left, %d in Trash", len(v), files.versionsInTrash(t))
	}
}

// Restoring from Trash is a write into the folder it goes back to: not
// made while that's being deleted or moved.
func TestRestoreWaitsForDeletes(t *testing.T) {
	g, url, s, _, data, _ := newTransferServer(t)
	ctx := testCtx(t)
	root, _ := g.rootByID("data")
	files := g.scope(root)
	req := func(r tunnelRequest) map[string]any {
		r.Root = "data"
		return openSession(t, ctx, url, s).request(t, ctx, r)
	}
	write(t, filepath.Join(data, "x", "f.txt"), "1")
	gone := req(tunnelRequest{Type: "delete", Path: "x/f.txt"})
	release, _, busy := files.holdWrites("x")
	if busy {
		t.Fatal("busy")
	}
	if r := req(tunnelRequest{Type: "trash-restore", Name: gone["id"].(string)}); r["ok"] == true {
		t.Fatalf("restored into a folder being deleted: %v", r)
	}
	release(false, "")
	if r := req(tunnelRequest{Type: "trash-restore", Name: gone["id"].(string)}); r["path"] != "x/f.txt" {
		t.Fatalf("restore after: %v", r)
	}
}

// Several deleted together, more than Trash keeps: the last isn't taken
// by dropping the first, unasked, but offered for deleting for good.
func TestTrashKeepsWhatWasJustDeleted(t *testing.T) {
	_, url, s, _, data, _ := newTransferServer(t)
	ctx := testCtx(t)
	req := func(r tunnelRequest) map[string]any {
		r.Root = "data"
		return openSession(t, ctx, url, s).request(t, ctx, r)
	}
	for _, name := range []string{"a", "b", "c"} {
		f, _ := os.Create(filepath.Join(data, name))
		f.Truncate(trashBytes*2/5 + 1) // sparse: two fit, three don't
		f.Close()
	}
	first := req(tunnelRequest{Type: "delete", Path: "a"})
	if r := req(tunnelRequest{Type: "delete", Path: "b"}); r["ok"] != true {
		t.Fatalf("the second: %v", r)
	}
	if r := req(tunnelRequest{Type: "delete", Path: "c"}); r["code"] != errTrashUnavailable || !exists(filepath.Join(data, "c")) {
		t.Fatalf("the third: %v", r)
	}
	// With one restored, there's room.
	if r := req(tunnelRequest{Type: "trash-restore", Name: first["id"].(string)}); r["path"] != "a" {
		t.Fatalf("restore: %v", r)
	}
	if r := req(tunnelRequest{Type: "delete", Path: "c"}); r["ok"] != true {
		t.Fatalf("the third, with room: %v", r)
	}
}
