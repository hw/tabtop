package main

import (
	"bytes"
	"context"
	"fmt"
	"io/fs"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// newTransferServer serves Downloads, data (writable) and docs (read-only).
func newTransferServer(t *testing.T) (g *server, url string, s testSession, downloads, data, docs string) {
	t.Helper()
	base, _ := newE2EServer(t)
	home, data, downloads := rootFixture(t)
	docs = filepath.Join(home, "Documents")
	c := base.serverConfig
	c.downloadsDir, c.fsHome = downloads, home
	c.fsRoots = "Downloads,data=" + data + ",Documents:ro"
	g, err := newServer(c)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(g.handler())
	t.Cleanup(srv.Close)
	return g, srv.URL, login(t, testCtx(t), srv.URL, code(0)), downloads, data, docs
}

// transfer runs req, and returns its first reply and its last.
func transfer(t *testing.T, ctx context.Context, url string, s testSession, req tunnelRequest) (first, last map[string]any) {
	t.Helper()
	req.Type = "transfer"
	tc := openSession(t, ctx, url, s)
	first = tc.request(t, ctx, req)
	if first["ok"] != true || first["path"] != nil {
		return first, first // refused, or done at once (a rename)
	}
	for {
		m := tc.readJSON(t, ctx)
		if _, progress := m["done"]; progress && len(m) == 1 {
			continue
		}
		return first, m
	}
}

func write(t *testing.T, p, text string) {
	t.Helper()
	os.MkdirAll(filepath.Dir(p), 0755)
	if err := os.WriteFile(p, []byte(text), 0644); err != nil {
		t.Fatal(err)
	}
}

func TestCopyBetweenRoots(t *testing.T) {
	_, url, s, downloads, data, docs := newTransferServer(t)
	ctx := testCtx(t)
	write(t, filepath.Join(downloads, "photos", "a.jpg"), "aaa")
	write(t, filepath.Join(downloads, "photos", "deep", "b.txt"), "bb")
	write(t, filepath.Join(downloads, "photos", uploadTempPrefix+"0123.part"), "unfinished")
	os.Symlink("a.jpg", filepath.Join(downloads, "photos", "link"))
	old := time.Date(2020, 1, 2, 3, 4, 5, 0, time.UTC)
	os.Chtimes(filepath.Join(downloads, "photos", "a.jpg"), old, old)

	first, last := transfer(t, ctx, url, s, tunnelRequest{Root: "downloads", Path: "photos", ToRoot: "data", To: "", Copy: true})
	if first["total"] != float64(5) || last["path"] != "photos" || last["root"] != "data" || last["skipped"] != float64(1) {
		t.Fatalf("copy: %v then %v", first, last)
	}
	if got, _ := os.ReadFile(filepath.Join(data, "photos", "deep", "b.txt")); string(got) != "bb" {
		t.Fatalf("copied content: %q", got)
	}
	if st, _ := os.Stat(filepath.Join(data, "photos", "a.jpg")); st == nil || !st.ModTime().Equal(old) {
		t.Fatalf("modification time not kept: %v", st)
	}
	if exists(filepath.Join(data, "photos", "link")) || exists(filepath.Join(data, "photos", uploadTempPrefix+"0123.part")) {
		t.Fatal("copied a link, or an unfinished upload")
	}
	if !exists(filepath.Join(downloads, "photos", "a.jpg")) {
		t.Fatal("a copy removed the original")
	}
	// Again: a name of its own, and nothing staged is left.
	if _, last := transfer(t, ctx, url, s, tunnelRequest{Root: "downloads", Path: "photos", ToRoot: "data", Copy: true}); last["path"] != "photos (1)" {
		t.Fatalf("second copy: %v", last)
	}
	des, _ := os.ReadDir(data)
	for _, de := range des {
		if hiddenDownloadName(de.Name()) {
			t.Fatalf("left %s", de.Name())
		}
	}
	// From a read-only root, a copy's fine; into one, nothing is.
	write(t, filepath.Join(docs, "report.pdf"), "pdf")
	if _, last := transfer(t, ctx, url, s, tunnelRequest{Root: "documents", Path: "report.pdf", ToRoot: "data", Copy: true}); last["path"] != "report.pdf" {
		t.Fatalf("copy from read-only: %v", last)
	}
	if first, _ := transfer(t, ctx, url, s, tunnelRequest{Root: "documents", Path: "report.pdf", ToRoot: "data"}); first["code"] != "read-only" {
		t.Fatalf("move from read-only: %v", first)
	}
	if first, _ := transfer(t, ctx, url, s, tunnelRequest{Root: "downloads", Path: "photos", ToRoot: "documents", Copy: true}); first["code"] != "read-only" {
		t.Fatalf("copy into read-only: %v", first)
	}
}

func TestMoveBetweenRoots(t *testing.T) {
	g, url, s, downloads, data, _ := newTransferServer(t)
	ctx := testCtx(t)
	os.Mkdir(filepath.Join(data, "in"), 0755)
	write(t, filepath.Join(downloads, "renamed", "x.txt"), "x")
	// On one filesystem, a rename.
	if _, last := transfer(t, ctx, url, s, tunnelRequest{Root: "downloads", Path: "renamed", ToRoot: "data", To: "in"}); last["path"] != "in/renamed" {
		t.Fatalf("move: %v", last)
	}
	if exists(filepath.Join(downloads, "renamed")) || !exists(filepath.Join(data, "in", "renamed", "x.txt")) {
		t.Fatal("not moved")
	}

	// Links and all, as a rename: nothing's read first.
	write(t, filepath.Join(downloads, "withlink", "a.txt"), "a")
	os.Symlink("a.txt", filepath.Join(downloads, "withlink", "l"))
	if _, last := transfer(t, ctx, url, s, tunnelRequest{Root: "downloads", Path: "withlink", ToRoot: "data", To: "in"}); last["path"] != "in/withlink" {
		t.Fatalf("move with a link, renamed: %v", last)
	}
	if l, err := os.Readlink(filepath.Join(data, "in", "withlink", "l")); err != nil || l != "a.txt" {
		t.Fatalf("the link: %q %v", l, err)
	}

	// Across filesystems, a copy, then the original's removed.
	renameAcrossRoots = func(*downloadStore, string, string, *downloadStore, string, string) error { return syscall.EXDEV }
	t.Cleanup(func() { renameAcrossRoots = renameBetween })
	big := bytes.Repeat([]byte("z"), 3<<20)
	os.MkdirAll(filepath.Join(downloads, "copied"), 0755)
	os.WriteFile(filepath.Join(downloads, "copied", "big.bin"), big, 0600)
	first, last := transfer(t, ctx, url, s, tunnelRequest{Root: "downloads", Path: "copied", ToRoot: "data", To: "in"})
	if first["total"] != float64(len(big)) || last["path"] != "in/copied" {
		t.Fatalf("move by copying: %v then %v", first, last)
	}
	if got, _ := os.ReadFile(filepath.Join(data, "in", "copied", "big.bin")); !bytes.Equal(got, big) || exists(filepath.Join(downloads, "copied")) {
		t.Fatal("not moved whole")
	}
	if st, _ := os.Stat(filepath.Join(data, "in", "copied", "big.bin")); st.Mode().Perm() != 0600 {
		t.Fatalf("permissions not kept: %v", st.Mode())
	}

	// Links keep a move from starting: nothing's lost, nothing's left.
	write(t, filepath.Join(downloads, "linked", "a.txt"), "a")
	os.Symlink("a.txt", filepath.Join(downloads, "linked", "l"))
	if first, _ := transfer(t, ctx, url, s, tunnelRequest{Root: "downloads", Path: "linked", ToRoot: "data"}); first["error"] != errTransferOdd.Error() {
		t.Fatalf("move with a link: %v", first)
	}
	if !exists(filepath.Join(downloads, "linked", "l")) || exists(filepath.Join(data, "linked")) {
		t.Fatal("a refused move changed something")
	}

	// Nor into Trash, nor while something's being written into it.
	os.Mkdir(filepath.Join(data, trashDir), 0700)
	if first, _ := transfer(t, ctx, url, s, tunnelRequest{Root: "downloads", Path: "linked/a.txt", ToRoot: "data", To: trashDir, Copy: true}); first["error"] == nil {
		t.Fatal("copied into Trash")
	}
	done, _ := g.defaultRoot().writes.begin("linked")
	if first, _ := transfer(t, ctx, url, s, tunnelRequest{Root: "downloads", Path: "linked", ToRoot: "data", Copy: false}); first["error"] == nil {
		t.Fatal("moved during a write")
	}
	done()
	// Nor the same root, nor the root itself.
	if first, _ := transfer(t, ctx, url, s, tunnelRequest{Root: "downloads", Path: "linked/a.txt", ToRoot: "downloads", Copy: true}); first["error"] == nil {
		t.Fatal("transferred within a root")
	}
	if first, _ := transfer(t, ctx, url, s, tunnelRequest{Root: "downloads", Path: "", ToRoot: "data", Copy: true}); first["error"] == nil {
		t.Fatal("copied a whole root")
	}
}

// A staged copy is left alone by cleanup, however long it takes.
func TestCleanupLeavesStagesInUse(t *testing.T) {
	g, _, _, _, data, _ := newTransferServer(t)
	stage := uploadTempPrefix + "00112233445566778899aabbccddeeff.stage"
	os.MkdirAll(filepath.Join(data, stage, "item"), 0700)
	old := time.Now().Add(-time.Hour)
	os.Chtimes(filepath.Join(data, stage), old, old)
	root, err := g.rootByID("data")
	if err != nil {
		t.Fatal(err)
	}
	files := g.scope(root)
	unstage := root.writes.staging(stage)
	files.cleanup(false)
	if !exists(filepath.Join(data, stage)) {
		t.Fatal("cleanup removed a stage in use")
	}
	unstage()
	files.cleanup(false)
	if exists(filepath.Join(data, stage)) {
		t.Fatal("cleanup left a stage no longer in use")
	}
}

// Trash across roots lists each root's, saying whose.
func TestTrashAcrossRoots(t *testing.T) {
	_, url, s, downloads, data, _ := newTransferServer(t)
	ctx := testCtx(t)
	write(t, filepath.Join(downloads, "a.txt"), "a")
	write(t, filepath.Join(data, "b.txt"), "b")
	for _, req := range []tunnelRequest{{Type: "delete", Root: "downloads", Path: "a.txt"}, {Type: "delete", Root: "data", Path: "b.txt"}} {
		if reply := openSession(t, ctx, url, s).request(t, ctx, req); reply["ok"] != true {
			t.Fatalf("%v: %v", req, reply)
		}
	}
	reply := openSession(t, ctx, url, s).request(t, ctx, tunnelRequest{Type: "trash-all"})
	entries, _ := reply["entries"].([]any)
	roots, _ := reply["roots"].([]any)
	if len(entries) != 2 || len(roots) != 3 || reply["max_items"] != float64(trashCount) {
		t.Fatalf("trash-all: %v", reply)
	}
	got := map[any]any{}
	for _, e := range entries {
		got[e.(map[string]any)["path"]] = e.(map[string]any)["root"]
	}
	if got["a.txt"] != "downloads" || got["b.txt"] != "data" {
		t.Fatalf("entries: %v", got)
	}
	// Restored through its own root.
	id := ""
	for _, e := range entries {
		if e.(map[string]any)["root"] == "data" {
			id = e.(map[string]any)["id"].(string)
		}
	}
	if reply := openSession(t, ctx, url, s).request(t, ctx, tunnelRequest{Type: "trash-restore", Root: "data", Name: id}); reply["path"] != "b.txt" || !exists(filepath.Join(data, "b.txt")) {
		t.Fatalf("restore: %v", reply)
	}
}

// A move keeps its original if it changed while it was copied.
func TestMoveKeepsWhatChangedMeanwhile(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "a", "proj", "a.log"), "one")
	write(t, filepath.Join(dir, "a", "proj", "sub", "b.txt"), "b")
	os.Mkdir(filepath.Join(dir, "b"), 0755)
	open := func(p string) *downloadStore {
		r, err := os.OpenRoot(p)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { r.Close() })
		return &downloadStore{root: r}
	}
	src, dst := open(filepath.Join(dir, "a")), open(filepath.Join(dir, "b"))
	for i, change := range []func(){
		func() {},
		func() { write(t, filepath.Join(dir, "a", "proj", "sub", "new.txt"), "new") },
		func() {
			f, _ := os.OpenFile(filepath.Join(dir, "a", "proj", "a.log"), os.O_APPEND|os.O_WRONLY, 0)
			f.WriteString(" two")
			f.Close()
		},
		func() { os.Remove(filepath.Join(dir, "a", "proj", "sub", "b.txt")) }, // gone: it was copied
	} {
		info, err := src.root.Lstat("proj")
		if err != nil {
			t.Fatal(err)
		}
		c := &copier{ctx: context.Background(), src: src, dst: dst, seen: map[string]fs.FileInfo{}}
		to := fmt.Sprintf("copy%d", i)
		if err := c.copyItem("proj", info, to, 0); err != nil {
			t.Fatal(err)
		}
		change()
		if got, want := c.unchanged("proj", "proj"), i != 1 && i != 2; got != want {
			t.Fatalf("change %d: unchanged %v", i, got)
		}
	}
}

// The name Trash has is refused at the top of a root, however it's reached.
func TestTransferTrashNameThroughLink(t *testing.T) {
	_, url, s, downloads, data, _ := newTransferServer(t)
	ctx := testCtx(t)
	// Spelt otherwise, as on a filesystem that ignores case it'd be Trash.
	name := strings.ToUpper(trashDir)
	write(t, filepath.Join(downloads, "sub", name, "x.txt"), "x")
	os.Symlink(".", filepath.Join(data, "self"))
	first, _ := transfer(t, ctx, url, s, tunnelRequest{Root: "downloads", Path: "sub/" + name, ToRoot: "data", To: "self", Copy: true})
	if msg, _ := first["error"].(string); !strings.Contains(msg, "kept for Trash") {
		t.Fatalf("copied Trash's name to the top through a link: %v", first)
	}
	if exists(filepath.Join(data, name)) {
		t.Fatal("made a Trash")
	}
}

// An entry Trash can't read doesn't stop it being listed, as often as it
// is, nor emptied.
func TestTrashListsPastBrokenEntries(t *testing.T) {
	_, url, s, _, data, _ := newTransferServer(t)
	ctx := testCtx(t)
	write(t, filepath.Join(data, "a.txt"), "a")
	req := func(r tunnelRequest) map[string]any {
		r.Root = "data"
		return openSession(t, ctx, url, s).request(t, ctx, r)
	}
	if reply := req(tunnelRequest{Type: "delete", Path: "a.txt"}); reply["ok"] != true {
		t.Fatalf("delete: %v", reply)
	}
	orphan := filepath.Join(data, trashDir, "ffffffffffffffffffffffffffffffff")
	os.Mkdir(orphan, 0700)
	for i := range 3 {
		reply := req(tunnelRequest{Type: "trash-list"})
		if entries, _ := reply["entries"].([]any); reply["ok"] != true || len(entries) != 1 {
			t.Fatalf("list %d: %v", i, reply)
		}
	}
	if reply := req(tunnelRequest{Type: "trash-empty"}); reply["ok"] != true || exists(orphan) {
		t.Fatalf("empty: %v", reply)
	}
}

// A transfer into a folder reached by a link is made where it really is:
// staged there, as cleanup sees it (see folderWrites.staged), and named.
func TestTransferGoesWhereItLeads(t *testing.T) {
	_, url, s, downloads, data, _ := newTransferServer(t)
	ctx := testCtx(t)
	write(t, filepath.Join(downloads, "f.txt"), "f")
	os.Mkdir(filepath.Join(data, "sub"), 0755)
	os.Symlink(".", filepath.Join(data, "self"))
	var into string
	renameAcrossRoots = func(_ *downloadStore, _, _ string, _ *downloadStore, to, _ string) error {
		into = to
		return syscall.EXDEV
	}
	t.Cleanup(func() { renameAcrossRoots = renameBetween })
	if _, last := transfer(t, ctx, url, s, tunnelRequest{Root: "downloads", Path: "f.txt", ToRoot: "data", To: "self/sub"}); last["path"] != "self/sub/f.txt" || into != "sub" {
		t.Fatalf("move into %q: %v", into, last)
	}
	if !exists(filepath.Join(data, "sub", "f.txt")) || exists(filepath.Join(downloads, "f.txt")) {
		t.Fatal("not moved")
	}
}

// A move by copying puts back an original that changed meanwhile, and
// removes one that didn't.
func TestMoveRemovesOnlyWhatWasCopied(t *testing.T) {
	g, _, _, downloads, _, _ := newTransferServer(t)
	srcRoot, _ := g.rootByID("downloads")
	dstRoot, _ := g.rootByID("data")
	files, there := g.scope(srcRoot), g.scope(dstRoot)
	for i, change := range []func(){
		func() {},
		func() { write(t, filepath.Join(downloads, "proj", "late.txt"), "late") },
	} {
		write(t, filepath.Join(downloads, "proj", "a.txt"), "a")
		src, _ := files.openStore()
		dst, _ := there.openStore()
		info, _ := src.root.Lstat("proj")
		c := &copier{ctx: context.Background(), src: src, dst: dst, seen: map[string]fs.FileInfo{}}
		if err := c.copyItem("proj", info, fmt.Sprintf("copy%d", i), 0); err != nil {
			t.Fatal(err)
		}
		change()
		warning := files.removeOriginal(src, "proj", c)
		if kept := exists(filepath.Join(downloads, "proj", "a.txt")); kept != (i == 1) || (warning != "") != (i == 1) {
			t.Fatalf("change %d: kept %v, warning %q", i, kept, warning)
		}
		des, _ := os.ReadDir(downloads)
		for _, de := range des {
			if hiddenDownloadName(de.Name()) {
				t.Fatalf("change %d: left %s", i, de.Name())
			}
		}
		src.Close()
		dst.Close()
		os.RemoveAll(filepath.Join(downloads, "proj"))
	}
}

// A read-only folder's copy is read-only too, once it's whole: not before,
// when it's still to be moved out of its stage.
func TestCopyReadOnlyFolder(t *testing.T) {
	_, url, s, downloads, data, _ := newTransferServer(t)
	ctx := testCtx(t)
	write(t, filepath.Join(downloads, "ro", "inner", "x.txt"), "x")
	os.Chmod(filepath.Join(downloads, "ro", "inner"), 0o555)
	os.Chmod(filepath.Join(downloads, "ro"), 0o555)
	t.Cleanup(func() {
		os.Chmod(filepath.Join(downloads, "ro"), 0o755)
		os.Chmod(filepath.Join(downloads, "ro", "inner"), 0o755)
		os.Chmod(filepath.Join(data, "ro"), 0o755)
		os.Chmod(filepath.Join(data, "ro", "inner"), 0o755)
	})
	if _, last := transfer(t, ctx, url, s, tunnelRequest{Root: "downloads", Path: "ro", ToRoot: "data", Copy: true}); last["path"] != "ro" {
		t.Fatalf("copy: %v", last)
	}
	for _, p := range []string{"ro", "ro/inner"} {
		if st, err := os.Stat(filepath.Join(data, p)); err != nil || st.Mode().Perm() != 0o555 {
			t.Fatalf("%s: %v %v", p, st, err)
		}
	}
	if got, _ := os.ReadFile(filepath.Join(data, "ro", "inner", "x.txt")); string(got) != "x" {
		t.Fatalf("copied %q", got)
	}
}

// A folder in it that can't be opened stops a copy before it starts.
func TestCopyUnreadableFolder(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root opens every folder")
	}
	_, url, s, downloads, data, _ := newTransferServer(t)
	ctx := testCtx(t)
	write(t, filepath.Join(downloads, "proj", "a.txt"), "a")
	write(t, filepath.Join(downloads, "proj", "shut", "b.txt"), "b")
	os.Chmod(filepath.Join(downloads, "proj", "shut"), 0)
	t.Cleanup(func() { os.Chmod(filepath.Join(downloads, "proj", "shut"), 0o755) })
	if first, _ := transfer(t, ctx, url, s, tunnelRequest{Root: "downloads", Path: "proj", ToRoot: "data", Copy: true}); first["error"] != errTransferUnreadable.Error() {
		t.Fatalf("copy: %v", first)
	}
	if exists(filepath.Join(data, "proj")) {
		t.Fatal("something was copied")
	}
	// Nor a file that can't be read: not left out, as a link is.
	write(t, filepath.Join(downloads, "one", "a.txt"), "a")
	write(t, filepath.Join(downloads, "one", "shut.txt"), "b")
	os.Chmod(filepath.Join(downloads, "one", "shut.txt"), 0)
	if _, last := transfer(t, ctx, url, s, tunnelRequest{Root: "downloads", Path: "one", ToRoot: "data", Copy: true}); last["error"] != errTransferUnreadable.Error() {
		t.Fatalf("copy with a file that can't be read: %v", last)
	}
	if exists(filepath.Join(data, "one")) {
		t.Fatal("a copy short of a file was left")
	}
}

// A move by copying, which removes the original after, isn't made of a
// folder something's mounted in, whose drive would be emptied.
func TestMoveRefusesMounts(t *testing.T) {
	_, url, s, downloads, data, _ := newTransferServer(t)
	ctx := testCtx(t)
	m := filepath.Join(downloads, "f", "m")
	os.MkdirAll(m, 0o755)
	if err := syscall.Mount("tmpfs", m, "tmpfs", 0, ""); err != nil {
		t.Skipf("can't mount here: %v", err)
	}
	t.Cleanup(func() { syscall.Unmount(m, syscall.MNT_DETACH) })
	write(t, filepath.Join(m, "kept"), "x")
	renameAcrossRoots = func(*downloadStore, string, string, *downloadStore, string, string) error { return syscall.EXDEV }
	t.Cleanup(func() { renameAcrossRoots = renameBetween })
	if first, _ := transfer(t, ctx, url, s, tunnelRequest{Root: "downloads", Path: "f", ToRoot: "data"}); first["error"] != errHoldsMount.Error() {
		t.Fatalf("move: %v", first)
	}
	if !exists(filepath.Join(m, "kept")) || exists(filepath.Join(data, "f")) {
		t.Fatal("something was moved")
	}
}
