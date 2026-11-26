package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// An item Trash can't take is reported with a code the page acts on, and
// can then be deleted permanently.
func TestDeleteFallsBackToPermanentWhenTrashRefuses(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	big := filepath.Join(g.downloadsDir, "disk.iso")
	f, err := os.Create(big)
	if err != nil {
		t.Fatal(err)
	}
	// Sparse: over Trash's limit without using the space.
	if err := f.Truncate(trashBytes + 1); err != nil {
		t.Fatal(err)
	}
	f.Close()
	reply := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "delete", Path: "disk.iso"})
	if reply["code"] != errTrashUnavailable || !exists(big) {
		t.Fatalf("refused delete: %v", reply)
	}
	reply = openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "delete", Path: "disk.iso", Permanent: true})
	if reply["ok"] != true || exists(big) {
		t.Fatalf("permanent delete: %v", reply)
	}
	// Errors are the friendly ones, not the system's.
	reply = openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "delete", Path: "disk.iso"})
	if reply["error"] != "It's already gone." {
		t.Fatalf("missing item: %v", reply)
	}
}

// Only Trash at the top of a root is reserved: a folder of that name
// deeper down is the user's to list, open and delete.
func TestNestedTrashNameIsOrdinary(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	nested := filepath.Join(g.downloadsDir, "project", trashDir)
	os.MkdirAll(nested, 0755)
	os.WriteFile(filepath.Join(nested, "keep.txt"), []byte("mine"), 0644)
	reply := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "list", Path: "project"})
	found := false
	for _, e := range reply["entries"].([]any) {
		if e.(map[string]any)["name"] == trashDir {
			found = true
		}
	}
	if !found {
		t.Fatalf("nested folder hidden: %v", reply)
	}
	if reply := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "file", Path: "project/" + trashDir + "/keep.txt"}); reply["ok"] != true {
		t.Fatalf("nested file unreadable: %v", reply)
	}
	// Moving it to the top would take Trash's place.
	if reply := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "move", Path: "project/" + trashDir, To: ""}); reply["error"] == nil {
		t.Fatal("moved a folder into Trash's place")
	}
	if reply := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "delete", Path: "project/" + trashDir}); reply["ok"] != true || exists(nested) {
		t.Fatalf("nested folder not deleted: %v", reply)
	}
	// The top-level one stays out of reach.
	if reply := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "list", Path: trashDir}); reply["error"] == nil {
		t.Fatal("Trash listed directly")
	}
}

func TestRootSpecAllowsColonsInPaths(t *testing.T) {
	home, data, downloads := rootFixture(t)
	stamped := data + "-2026-01-01T10:00"
	if err := os.Mkdir(stamped, 0755); err != nil {
		t.Fatal(err)
	}
	roots, err := parseFileRoots("backup="+stamped+":ro,data="+data, home, downloads)
	if err != nil {
		t.Fatal(err)
	}
	if roots[0].Path != stamped || !roots[0].ReadOnly || roots[1].Path != data || roots[1].ReadOnly {
		t.Fatalf("roots: %+v", roots)
	}
}

// Without WEB_FS_ROOTS, Downloads missing at startup still has a binding,
// so links survive and new ones can be made once it exists.
func TestDefaultRootBindingWithoutDownloads(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "Downloads")
	roots, err := parseFileRoots("", t.TempDir(), missing)
	if err != nil {
		t.Fatal(err)
	}
	before := roots[0].Binding
	if len(before) != 64 {
		t.Fatalf("binding %q", before)
	}
	os.Mkdir(missing, 0755)
	again, _ := parseFileRoots("", t.TempDir(), missing)
	if again[0].Binding != before {
		t.Fatal("binding changed once the folder existed")
	}
}

// The default root follows ~/Downloads as it is now: one recreated while
// running is the one used.
func TestDefaultRootFollowsRecreatedDownloads(t *testing.T) {
	g, _ := newE2EServer(t)
	files := g.defaultFiles()
	if err := os.RemoveAll(g.downloadsDir); err != nil {
		t.Fatal(err)
	}
	os.Mkdir(g.downloadsDir, 0755)
	os.WriteFile(filepath.Join(g.downloadsDir, "new.txt"), []byte("new"), 0644)
	item, err := files.openFile("new.txt")
	if err != nil {
		t.Fatal(err)
	}
	item.Close()
}

// Deleting the watched folder ends the watch, rather than leaving it on a
// folder nobody can see.
func TestWatchEndsWhenFolderDeleted(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	tc := openSession(t, ctx, srv.URL, s)
	defer tc.c.CloseNow()
	if reply := tc.request(t, ctx, tunnelRequest{Type: "watch"}); reply["ok"] != true {
		t.Fatalf("watch: %v", reply)
	}
	time.Sleep(100 * time.Millisecond)
	if err := os.RemoveAll(g.downloadsDir); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			if _, _, err := tc.c.Read(ctx); err != nil {
				return
			}
		}
	}()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("watch went on after the folder was deleted")
	}
}

// Cleanup isn't scoped to a root: it covers every writable one, even when
// Downloads isn't among them.
func TestCleanupCoversEveryWritableRoot(t *testing.T) {
	base, _ := newE2EServer(t)
	home, data, downloads := rootFixture(t)
	c := base.serverConfig
	c.downloadsDir, c.fsHome = downloads, home
	c.fsRoots = "Documents:ro,data=" + data + ":rw"
	g, err := newServer(c)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(g.handler())
	t.Cleanup(srv.Close)
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	reply := rootRequest(t, ctx, srv.URL, s, tunnelRequest{Type: "cleanup", Root: "downloads", DryRun: true})
	if reply["ok"] != true {
		t.Fatalf("cleanup: %v", reply)
	}
}

func TestZipAndActivityNamesFollowTheRoot(t *testing.T) {
	if got := zipName("Documents", ".", []string{"a", "b"}); got != "Documents.zip" {
		t.Errorf("zip of the top: %q", got)
	}
	if got := zipName("Documents", "photos/2024", []string{"a", "b"}); got != "2024.zip" {
		t.Errorf("zip of a folder: %q", got)
	}
	for dir, want := range map[string]string{".": "Downloads", "": "Downloads", ".config": "Downloads/.config/", "a/b": "Downloads/a/b/"} {
		if got := rootFolderText("Downloads", dir); got != want {
			t.Errorf("rootFolderText(%q) = %q, want %q", dir, got, want)
		}
	}
}

// Entries a crash left unreadable are pruned once old enough, and Empty
// Trash takes them at once.
func TestTrashPrunesOrphans(t *testing.T) {
	dir := t.TempDir()
	s, err := openDownloadStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	trash, err := s.openTrash(true)
	if err != nil {
		t.Fatal(err)
	}
	defer trash.Close()
	old, fresh := strings.Repeat("a", 32), strings.Repeat("b", 32)
	for _, id := range []string{old, fresh} {
		os.Mkdir(filepath.Join(dir, trashDir, id), 0700)
	}
	long := time.Now().Add(-2 * orphanGrace)
	os.Chtimes(filepath.Join(dir, trashDir, old), long, long)
	if err := trash.pruneOrphans(time.Now(), orphanGrace); err != nil {
		t.Fatal(err)
	}
	if exists(filepath.Join(dir, trashDir, old)) || !exists(filepath.Join(dir, trashDir, fresh)) {
		t.Fatal("pruning didn't take only the old orphan")
	}
	if err := trash.pruneOrphans(time.Now(), 0); err != nil || exists(filepath.Join(dir, trashDir, fresh)) {
		t.Fatalf("emptying left an orphan: %v", err)
	}
}

// A restore isn't announced as a new download.
func TestRestoreIsNotANewDownload(t *testing.T) {
	g, _ := newE2EServer(t)
	files := g.defaultFiles()
	os.WriteFile(filepath.Join(g.downloadsDir, "report.pdf"), []byte("pdf"), 0644)
	store, err := files.openStore()
	if err != nil {
		t.Fatal(err)
	}
	e, err := store.putTrash("report.pdf", time.Now())
	store.Close()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := files.trashRequest(tunnelRequest{Type: "trash-restore", Name: e.ID}); err != nil {
		t.Fatal(err)
	}
	if !files.wasPlaced("report.pdf") {
		t.Fatal("restore would be announced as a download")
	}
}

// Cleanup that only finds TabTop's own leftovers still logs it.
func TestCleanupLogsGatewayLeftovers(t *testing.T) {
	g, srv := newE2EServer(t)
	g.sharesFile = filepath.Join(t.TempDir(), "shares.json")
	leftover := filepath.Join(filepath.Dir(g.sharesFile), ".shares-12345")
	os.WriteFile(leftover, []byte("{}"), 0o600)
	old := time.Now().Add(-2 * cleanupAge)
	os.Chtimes(leftover, old, old)
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	reply := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "cleanup"})
	if reply["cleanup"].(map[string]any)["temps"] != float64(1) || exists(leftover) {
		t.Fatalf("cleanup: %v", reply)
	}
	if got, _ := g.activity.list(1); len(got) == 0 || got[0].Kind != "cleanup" {
		t.Fatalf("activity: %+v", got)
	}
}

// A link back to the root doesn't reach Trash: not listed, read, changed
// or moved into its place.
func TestTrashUnreachableThroughLinks(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	os.WriteFile(filepath.Join(g.downloadsDir, "gone.txt"), []byte("x"), 0644)
	store, _ := g.defaultFiles().openStore()
	e, err := store.putTrash("gone.txt", time.Now())
	store.Close()
	if err != nil {
		t.Fatal(err)
	}
	os.Symlink(".", filepath.Join(g.downloadsDir, "self"))
	os.Symlink(trashDir+"/"+e.ID, filepath.Join(g.downloadsDir, "entry"))
	req := func(r tunnelRequest) map[string]any {
		return openSession(t, ctx, srv.URL, s).request(t, ctx, r)
	}
	for _, list := range []string{"self", ""} {
		reply := req(tunnelRequest{Type: "list", Path: list})
		for _, x := range reply["entries"].([]any) {
			if n := x.(map[string]any)["name"]; n == trashDir || n == "entry" {
				t.Errorf("listing %q shows %v", list, n)
			}
		}
	}
	inside := "self/" + trashDir + "/" + e.ID + "/info.json"
	for _, r := range []tunnelRequest{
		{Type: "file", Path: inside},
		{Type: "file", Path: "entry/info.json"},
		{Type: "delete", Path: inside},
		{Type: "rename", Path: inside, Name: "x.json"},
		{Type: "move", Path: "self/" + trashDir, To: "elsewhere"},
		{Type: "list", Path: "self/" + trashDir},
	} {
		if reply := req(r); reply["ok"] == true {
			t.Errorf("%s %s reached Trash", r.Type, r.Path)
		}
	}
	// A folder named as Trash can't be moved into its place by way of a link.
	os.RemoveAll(filepath.Join(g.downloadsDir, trashDir))
	os.MkdirAll(filepath.Join(g.downloadsDir, "sub", trashDir), 0755)
	if reply := req(tunnelRequest{Type: "move", Path: "sub/" + trashDir, To: "self"}); reply["ok"] == true {
		t.Fatal("moved a folder into Trash's place through a link")
	}
}

func TestRootSpecRefusesWholeFilesystem(t *testing.T) {
	home, data, downloads := rootFixture(t)
	for _, spec := range []string{"all=/:rw", "all=/,data=" + data, "data=" + data + ",all=/"} {
		if _, err := parseFileRoots(spec, home, downloads); err == nil {
			t.Errorf("accepted %q", spec)
		}
	}
	// No Downloads path: nothing is taken for the default root.
	roots, err := parseFileRoots("downloads="+data, home, "")
	if err != nil {
		t.Fatal(err)
	}
	if roots[0].Default {
		t.Fatal("matched an empty Downloads path")
	}
}

func TestLinkActivityNamesItsRoot(t *testing.T) {
	l := &shareLink{RootLabel: "data", Path: ".", Upload: true}
	if got := linkTarget(l); got != "data" {
		t.Errorf("top: %q", got)
	}
	l.Path = "sub"
	if got := linkTarget(l); got != "data/sub/" {
		t.Errorf("folder: %q", got)
	}
	if got := folderOrPath(map[string]any{"path": "sub", "dir": true, "root_label": "Documents"}); got != "Documents/sub/" {
		t.Errorf("again: %q", got)
	}
}

// Leftover uploads in a folder named as Trash, deeper down, are cleaned up.
func TestCleanupEntersNestedTrashNamedFolders(t *testing.T) {
	dir := t.TempDir()
	nested := filepath.Join(dir, "photos", trashDir)
	os.MkdirAll(nested, 0755)
	stale := filepath.Join(nested, uploadTempPrefix+"0123456789abcdef.part")
	os.WriteFile(stale, []byte("x"), 0644)
	old := time.Now().Add(-2 * cleanupAge)
	os.Chtimes(stale, old, old)
	root, err := openDirectoryRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	var stop atomic.Bool
	if n, _ := cleanTemps(root, time.Now().Add(-cleanupAge), map[string]bool{}, false, &stop); n != 1 || exists(stale) {
		t.Fatalf("cleaned %d, left %v", n, exists(stale))
	}
}

// Something that isn't a folder in Trash's place: deleting offers the
// permanent fallback rather than failing with no way out.
func TestDeleteFallsBackWhenTrashIsBlocked(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	os.WriteFile(filepath.Join(g.downloadsDir, trashDir), []byte("not a folder"), 0644)
	os.WriteFile(filepath.Join(g.downloadsDir, "a.txt"), []byte("a"), 0644)
	reply := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "delete", Path: "a.txt"})
	if reply["code"] != errTrashUnavailable {
		t.Fatalf("blocked Trash: %v", reply)
	}
	reply = openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "delete", Path: "a.txt", Permanent: true})
	if reply["ok"] != true || exists(filepath.Join(g.downloadsDir, "a.txt")) {
		t.Fatalf("permanent delete: %v", reply)
	}
}

// A root missing at startup is left out and reported, not fatal, and its
// links are kept for when it's back.
func TestMissingRootIsLeftOut(t *testing.T) {
	base, _ := newE2EServer(t)
	home, data, downloads := rootFixture(t)
	c := base.serverConfig
	c.downloadsDir, c.fsHome = downloads, home
	c.fsRoots = "Downloads:rw,usb=" + filepath.Join(t.TempDir(), "unmounted") + ":ro,data=" + data
	c.shareOn = true
	c.sharesFile = filepath.Join(t.TempDir(), "shares.json")
	g, err := newServer(c)
	if err != nil {
		t.Fatalf("a missing root stopped the start: %v", err)
	}
	if len(g.roots) != 2 || len(g.rootProblems) != 1 || g.rootProblems[0].ID != "usb" {
		t.Fatalf("roots %d, problems %+v", len(g.roots), g.rootProblems)
	}
	if _, err := g.rootByID("usb"); err == nil {
		t.Fatal("served a missing root")
	}
	// A link to it survives the start's check of links.
	st, _ := os.Stat(data)
	if _, _, err := g.shares.create(".", st, 0, shareSpec{Root: "usb", RootBinding: strings.Repeat("0", 64), RootLabel: "usb", Life: time.Hour}, "", "192.0.2.1"); err != nil {
		t.Fatal(err)
	}
	g.shares.flush()
	again, err := newServer(c)
	if err != nil {
		t.Fatal(err)
	}
	if len(again.shares.list("")) != 1 {
		t.Fatal("a link to a missing root was revoked")
	}
	// Mistakes in the setting still stop it.
	c.fsRoots = "usb=/nowhere,usb=/elsewhere"
	if _, err := newServer(c); err == nil {
		t.Fatal("accepted a duplicate root ID")
	}
}

// ~/ in WEB_FS_ROOTS is the user's home, as in a shell.
func TestRootSpecExpandsHome(t *testing.T) {
	home, _, downloads := rootFixture(t)
	roots, err := parseFileRoots("Docs=~/Documents:ro,~/Downloads", home, downloads)
	if err != nil {
		t.Fatal(err)
	}
	if roots[0].Path != filepath.Join(home, "Documents") || roots[1].ID != "downloads" || roots[1].Path != downloads {
		t.Fatalf("roots: %+v", roots)
	}
	if _, err := parseFileRoots("docs=~other/Documents", home, downloads); err == nil {
		t.Fatal("~name accepted")
	}
}

// A link out of the root, or round in circles, isn't taken for a way into
// Trash: using it fails as it would without Trash, not with Trash's error.
func TestLinksOutOfTheRootAreNotTrash(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	if err := os.Mkdir(filepath.Join(g.downloadsDir, trashDir), 0700); err != nil {
		t.Fatal(err)
	}
	proj := filepath.Join(g.downloadsDir, "proj")
	os.Mkdir(proj, 0755)
	os.Symlink("/usr/lib", filepath.Join(proj, "lib"))
	os.Symlink("loop", filepath.Join(proj, "loop"))
	for _, p := range []string{"proj/lib", "proj/loop"} {
		reply := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "list", Path: p})
		if e, _ := reply["error"].(string); e == "" || strings.Contains(e, "Trash") {
			t.Fatalf("%s: %v", p, reply)
		}
	}
}

// Whether a request writes is the route table's to say, so a read-only
// root refuses it before it's served.
func TestRouteWrites(t *testing.T) {
	for _, c := range []struct {
		req   tunnelRequest
		write bool
	}{
		{tunnelRequest{Type: "list"}, false},
		{tunnelRequest{Type: "delete"}, true},
		{tunnelRequest{Type: "share"}, false},
		{tunnelRequest{Type: "share", Upload: true}, true},
		{tunnelRequest{Type: "fetch", Name: "id"}, false},
		{tunnelRequest{Type: "fetch", URL: "https://example.com/"}, true},
	} {
		if got := tunnelRoutes[c.req.Type].writes(c.req); got != c.write {
			t.Errorf("%+v writes: %v", c.req, got)
		}
	}
}

// Another spelling of Trash's name is Trash only where it names the same
// folder, on a filesystem that ignores case. Here, where it doesn't, it's
// the user's folder, listed and used as any other, Trash or not; but new
// items can't be given any spelling of it.
func TestTrashNameInAnotherCase(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	if err := os.Mkdir(filepath.Join(g.downloadsDir, trashDir), 0700); err != nil {
		t.Fatal(err)
	}
	mine := filepath.Join(g.downloadsDir, ".TABTOP-TRASH")
	os.Mkdir(mine, 0755)
	os.WriteFile(filepath.Join(mine, "keep.txt"), []byte("mine"), 0644)
	reply := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "list", Path: ""})
	names := map[any]bool{}
	for _, e := range reply["entries"].([]any) {
		names[e.(map[string]any)["name"]] = true
	}
	if !names[".TABTOP-TRASH"] || names[trashDir] {
		t.Fatalf("listing: %v", reply)
	}
	if reply := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "file", Path: ".TABTOP-TRASH/keep.txt"}); reply["ok"] != true {
		t.Fatalf("user's folder unreadable: %v", reply)
	}
	if validNewName(".TabTop-Trash") {
		t.Error("Trash's name in another case accepted for something new")
	}
}

// A folder can't be deleted while an upload into it goes on; uploads kept
// there to resume are given up when it is.
func TestDeleteWaitsForUploadsInto(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	os.MkdirAll(filepath.Join(g.downloadsDir, "photos", "2026"), 0755)
	m := &g.defaultRoot().transfers
	a := m.track("going", "photos/2026", nil)
	reply := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "delete", Path: "photos"})
	if e, _ := reply["error"].(string); !strings.Contains(e, "still being uploaded") || !exists(filepath.Join(g.downloadsDir, "photos")) {
		t.Fatalf("deleted during an upload: %v", reply)
	}
	// Other folders aren't held up.
	os.Mkdir(filepath.Join(g.downloadsDir, "photo"), 0755)
	if reply := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "delete", Path: "photo"}); reply["ok"] != true {
		t.Fatalf("unrelated folder: %v", reply)
	}
	m.untrack("going", a)
	tmp := filepath.Join(g.downloadsDir, "photos", "2026", uploadTempPrefix+"kept")
	os.WriteFile(tmp, []byte("part"), 0600)
	pin, err := os.OpenRoot(filepath.Join(g.downloadsDir, "photos", "2026"))
	if err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	m.partials = map[string]*partialUpload{"kept": {root: pin, dir: "photos/2026", tmp: uploadTempPrefix + "kept", timer: g.clock.AfterFunc(time.Hour, func() {})}}
	m.mu.Unlock()
	if reply := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "delete", Path: "photos"}); reply["ok"] != true {
		t.Fatalf("delete after the upload: %v", reply)
	}
	m.mu.Lock()
	left := len(m.partials)
	m.mu.Unlock()
	if left != 0 {
		t.Fatal("upload kept to resume into a deleted folder")
	}
}

// Restoring doesn't follow a link made since into Trash, where what's
// restored would be hidden.
func TestRestoreRefusesLinkIntoTrash(t *testing.T) {
	dir := t.TempDir()
	s, err := openDownloadStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	os.MkdirAll(filepath.Join(dir, "a"), 0755)
	os.WriteFile(filepath.Join(dir, "a", "file"), []byte("x"), 0644)
	os.WriteFile(filepath.Join(dir, "other"), []byte("y"), 0644)
	e, err := s.putTrash("a/file", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	o, err := s.putTrash("other", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	os.Remove(filepath.Join(dir, "a"))
	os.Symlink(trashDir+"/"+o.ID, filepath.Join(dir, "a"))
	if _, err := s.restoreTrash(e.ID); !errors.Is(err, errRestoreIntoTrash) {
		t.Fatalf("restore: %v", err)
	}
}

// With every root listed missing, none is served: not ~/Downloads, which
// wasn't listed, in their place.
func TestNoFallbackWhenEveryRootIsMissing(t *testing.T) {
	base, _ := newE2EServer(t)
	home, _, downloads := rootFixture(t)
	c := base.serverConfig
	c.downloadsDir, c.fsHome = downloads, home
	c.fsRoots = "usb=" + filepath.Join(t.TempDir(), "unmounted") + ":ro"
	g, err := newServer(c)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"", "downloads"} {
		if root, err := g.rootByID(id); err == nil {
			t.Fatalf("%q served %s", id, root.Path)
		}
	}
	if len(g.fileServices()) != 0 {
		t.Fatal("a root served for cleanup")
	}
}

// Where Trash can't be moved into safely, the page is offered to delete
// permanently.
func TestNoRenameOffersPermanentDelete(t *testing.T) {
	err := fmt.Errorf("Couldn't move this item to Trash; nothing was deleted: %w", errNoRename)
	if !trashRefused(err) || !strings.Contains(deleteError(err), "nothing was deleted") {
		t.Fatalf("%v: refused %v, %q", err, trashRefused(err), deleteError(err))
	}
}

// Uploads paused in a folder Trash refuses are kept, to resume: nothing
// was deleted.
func TestRefusedDeleteKeepsPausedUploads(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	dir := filepath.Join(g.downloadsDir, "big")
	os.Mkdir(dir, 0755)
	f, _ := os.Create(filepath.Join(dir, "disk.iso"))
	f.Truncate(trashBytes + 1)
	f.Close()
	pin, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	m := &g.defaultRoot().transfers
	m.mu.Lock()
	m.partials = map[string]*partialUpload{"kept": {root: pin, dir: "big", tmp: uploadTempPrefix + "kept", size: 4, timer: g.clock.AfterFunc(time.Hour, func() {})}}
	m.mu.Unlock()
	reply := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "delete", Path: "big"})
	if reply["code"] != errTrashUnavailable {
		t.Fatalf("delete: %v", reply)
	}
	m.mu.Lock()
	p := m.partials["kept"]
	m.mu.Unlock()
	if p == nil || p.holding > 0 {
		t.Fatalf("paused upload lost or left held: %+v", p)
	}
}

// Uploads through links and ZIPs being extracted hold up deleting the
// folder they're into, as uploads from the files page do.
func TestDeleteWaitsForOtherWrites(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	os.MkdirAll(filepath.Join(g.downloadsDir, "inbox", "sub"), 0755)
	done, _ := g.defaultRoot().writes.begin("inbox/sub")
	reply := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "delete", Path: "inbox"})
	if e, _ := reply["error"].(string); !strings.Contains(e, "still being uploaded") {
		t.Fatalf("deleted during a write: %v", reply)
	}
	done()
	if reply := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "delete", Path: "inbox"}); reply["ok"] != true {
		t.Fatalf("delete after the write: %v", reply)
	}
}

// Requests naming no root, as the desktop's do, reach Downloads only at
// its default place; the page is told which root that is.
func TestRootlessRequestsNeedDefaultDownloads(t *testing.T) {
	home, data, downloads := rootFixture(t)
	roots, err := parseFileRoots("downloads="+data, home, downloads)
	if err != nil {
		t.Fatal(err)
	}
	g := &server{roots: roots}
	if _, err := g.rootByID(""); err == nil {
		t.Fatal("a root named downloads elsewhere served as Downloads")
	}
	if root, err := g.rootByID("downloads"); err != nil || root.Default {
		t.Fatalf("named: %v %v", root, err)
	}
	roots, err = parseFileRoots("Downloads", home, downloads)
	if err != nil {
		t.Fatal(err)
	}
	g = &server{roots: roots}
	root, err := g.rootByID("")
	if err != nil || !root.Default {
		t.Fatalf("default: %v %v", root, err)
	}
	if b, _ := json.Marshal(root); !strings.Contains(string(b), `"default":true`) {
		t.Fatalf("reported: %s", b)
	}
}

// Where another spelling of Trash's name is a folder of the user's, it's
// deleted as any other.
func TestUsersTrashSpelledFolderDeletes(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	mine := filepath.Join(g.downloadsDir, ".Tabtop-Trash")
	os.Mkdir(mine, 0755)
	os.WriteFile(filepath.Join(mine, "old.iso"), []byte("x"), 0644)
	if reply := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "delete", Path: ".Tabtop-Trash/old.iso"}); reply["ok"] != true {
		t.Fatalf("file: %v", reply)
	}
	if reply := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "delete", Path: ".Tabtop-Trash"}); reply["ok"] != true || exists(mine) {
		t.Fatalf("folder: %v", reply)
	}
}

// While a folder is being deleted, no write into it can start; one into
// it going on holds the delete up.
func TestFolderWritesGate(t *testing.T) {
	var w folderWrites
	end, busy := w.startDeleting("photos")
	if busy {
		t.Fatal("busy with nothing going")
	}
	for _, dir := range []string{"photos", "photos/2026", "/photos/"} {
		if _, err := w.begin(dir); !errors.Is(err, errFolderDeleting) {
			t.Errorf("%q: began during the delete: %v", dir, err)
		}
	}
	done, err := w.begin("photo")
	if err != nil {
		t.Fatal("an unrelated folder refused")
	}
	end()
	done()
	done, err = w.begin("photos/2026")
	if err != nil {
		t.Fatal(err)
	}
	if _, busy := w.startDeleting("photos"); !busy {
		t.Fatal("deleted during a write")
	}
	done()
}

// An upload kept to resume in a folder moved to Trash is given up, and
// its file removed from where it went, not left in Trash.
func TestTrashedFolderLosesPausedUploadFiles(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	os.MkdirAll(filepath.Join(g.downloadsDir, "photos", "2026"), 0755)
	tmp := filepath.Join(g.downloadsDir, "photos", "2026", uploadTempPrefix+"kept.part")
	os.WriteFile(tmp, []byte("part"), 0600)
	pin, err := os.OpenRoot(g.downloadsDir)
	if err != nil {
		t.Fatal(err)
	}
	m := &g.defaultRoot().transfers
	m.mu.Lock()
	m.partials = map[string]*partialUpload{"kept": {root: pin, dir: "photos/2026", tmp: "photos/2026/" + uploadTempPrefix + "kept.part", timer: g.clock.AfterFunc(time.Hour, func() {})}}
	m.mu.Unlock()
	reply := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "delete", Path: "photos"})
	if reply["ok"] != true {
		t.Fatalf("delete: %v", reply)
	}
	moved := filepath.Join(g.downloadsDir, trashDir, reply["id"].(string), "data", "2026", uploadTempPrefix+"kept.part")
	if exists(moved) {
		t.Fatal("the paused upload's file was left in Trash")
	}
	if !exists(filepath.Dir(moved)) {
		t.Fatal("the folder isn't in Trash where expected")
	}
}

// A sync the filesystem can't do isn't a failure.
func TestSyncUnsupported(t *testing.T) {
	if !syncUnsupported(syscall.EINVAL) || !syncUnsupported(&os.PathError{Op: "sync", Err: syscall.ENOTSUP}) || syncUnsupported(syscall.EIO) || syncUnsupported(nil) {
		t.Fatal("misjudged")
	}
}

// devInfo is info as another mount of the same filesystem shows it: the
// same inode, on another device number.
type devInfo struct {
	os.FileInfo
	st syscall.Stat_t
}

func (d devInfo) Sys() any { return &d.st }

// A root's binding, which its links are bound to, survives a remount
// that gives its filesystem another device number or ID, but not the
// folder being made again.
func TestRootBindingSurvivesRemount(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "data")
	os.Mkdir(dir, 0755)
	info, _ := os.Stat(dir)
	st := *info.Sys().(*syscall.Stat_t)
	remounted := st
	remounted.Dev += 7
	if directoryBinding(dir, info) != directoryBinding(dir, devInfo{info, remounted}) {
		t.Fatal("the binding changed with the device number")
	}
	// Made again: a new inode (kept apart from the old one by a file
	// holding it).
	os.Rename(dir, dir+".old")
	os.Mkdir(dir, 0755)
	again, _ := os.Stat(dir)
	if directoryBinding(dir, info) == directoryBinding(dir, again) {
		t.Fatal("a folder made again kept the binding")
	}
	// The startup check of links keeps them across a restart.
	home, data, downloads := rootFixture(t)
	first, err := parseFileRoots("data="+data, home, downloads)
	if err != nil {
		t.Fatal(err)
	}
	second, _ := parseFileRoots("data="+data, home, downloads)
	if first[0].Binding != second[0].Binding {
		t.Fatal("the binding changed across a restart")
	}
}
