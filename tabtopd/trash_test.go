package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestTrashRestoreAndConflicts(t *testing.T) {
	dir := t.TempDir()
	s, err := openDownloadStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	os.MkdirAll(filepath.Join(dir, "nested"), 0755)
	os.WriteFile(filepath.Join(dir, "nested", "a.txt"), []byte("original"), 0644)
	now := time.Now()
	e, err := s.putTrash("nested/a.txt", now)
	if err != nil {
		t.Fatal(err)
	}
	if exists(filepath.Join(dir, "nested", "a.txt")) {
		t.Fatal("source remains")
	}
	// Reopening the store simulates a restart: metadata and content persist.
	s2, _ := openDownloadStore(dir)
	defer s2.Close()
	os.WriteFile(filepath.Join(dir, "nested", "a.txt"), []byte("replacement"), 0644)
	got, err := s2.restoreTrash(e.ID)
	if err != nil || got != "nested/a (1).txt" {
		t.Fatalf("restore %q: %v", got, err)
	}
	b, _ := os.ReadFile(filepath.Join(dir, got))
	if string(b) != "original" {
		t.Fatalf("content %q", b)
	}
	b, _ = os.ReadFile(filepath.Join(dir, "nested", "a.txt"))
	if string(b) != "replacement" {
		t.Fatal("overwrote existing file")
	}
	if _, err := s.restoreTrash(e.ID); err == nil {
		t.Fatal("restored twice")
	}
	// Restore recreates deleted parent folders.
	e, err = s.putTrash(got, now)
	if err != nil {
		t.Fatal(err)
	}
	os.RemoveAll(filepath.Join(dir, "nested"))
	if got, err = s.restoreTrash(e.ID); err != nil || got != "nested/a (1).txt" {
		t.Fatalf("missing parent: %s %v", got, err)
	}
}

func TestTrashSymlinksAndProtection(t *testing.T) {
	dir := t.TempDir()
	s, _ := openDownloadStore(dir)
	defer s.Close()
	os.WriteFile(filepath.Join(dir, "target"), []byte("safe"), 0644)
	os.Symlink("target", filepath.Join(dir, "link"))
	e, err := s.putTrash("link", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !exists(filepath.Join(dir, "target")) {
		t.Fatal("moved link target")
	}
	if _, err = s.restoreTrash(e.ID); err != nil {
		t.Fatal(err)
	}
	if link, _ := os.Readlink(filepath.Join(dir, "link")); link != "target" {
		t.Fatal("link changed")
	}
	outside := t.TempDir()
	os.WriteFile(filepath.Join(outside, "safe"), []byte("safe"), 0644)
	os.Symlink(outside, filepath.Join(dir, "escape"))
	for _, name := range []string{".", "sub/..", "../outside", "escape/safe", trashDir, trashDir + "/data", uploadTempPrefix + "abc.part"} {
		if _, err := s.putTrash(name, time.Now()); err == nil {
			t.Errorf("accepted %q", name)
		}
	}
	for _, id := range []string{"", "..", "../target", strings.Repeat("a", 31), strings.Repeat("A", 32)} {
		if _, err := s.restoreTrash(id); err == nil {
			t.Errorf("accepted id %q", id)
		}
	}
	// A folder can contain escaping links; size accounting/deletion never follows them.
	os.Mkdir(filepath.Join(dir, "folder"), 0755)
	os.Symlink(outside, filepath.Join(dir, "folder", "escape"))
	e, err = s.putTrash("folder", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	trash, _ := s.openTrash(false)
	defer trash.Close()
	if err := trash.root.RemoveAll(e.ID); err != nil {
		t.Fatal(err)
	}
	if !exists(filepath.Join(outside, "safe")) {
		t.Fatal("followed symlink")
	}
}

func TestTrashRetentionAndSize(t *testing.T) {
	dir := t.TempDir()
	s, _ := openDownloadStore(dir)
	defer s.Close()
	now := time.Now()
	os.WriteFile(filepath.Join(dir, "old"), []byte("old"), 0644)
	e, err := s.putTrash("old", now.Add(-trashAge))
	if err != nil {
		t.Fatal(err)
	}
	trash, _ := s.openTrash(false)
	defer trash.Close()
	if _, err := trash.pruneTrash(now); err != nil {
		t.Fatal(err)
	}
	if _, err := trash.readTrash(e.ID); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("expired: %v", err)
	}
	// Sparse files exercise limits without allocating gigabytes.
	for _, name := range []string{"first", "second"} {
		f, _ := os.Create(filepath.Join(dir, name))
		f.Truncate(trashBytes * 3 / 4)
		f.Close()
	}
	first, err := s.putTrash("first", now)
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.putTrash("second", now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := trash.readTrash(first.ID); err == nil {
		t.Fatal("oldest not evicted")
	}
	if _, err := trash.readTrash(second.ID); err != nil {
		t.Fatal("newest evicted", err)
	}
	f, _ := os.Create(filepath.Join(dir, "huge"))
	f.Truncate(trashBytes + 1)
	f.Close()
	if _, err := s.putTrash("huge", now); !errors.Is(err, errTrashLimit) {
		t.Fatal(err)
	}
	if !exists(filepath.Join(dir, "huge")) {
		t.Fatal("oversize file deleted")
	}
}

func TestTrashHiddenFromListingAndZip(t *testing.T) {
	dir := t.TempDir()
	s, _ := openDownloadStore(dir)
	defer s.Close()
	os.WriteFile(filepath.Join(dir, "secret"), []byte("secret"), 0644)
	e, err := s.putTrash("secret", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	f, _ := openRootDirectory(s.root, ".")
	entries, _, err := s.listDir(".", f)
	f.Close()
	if err != nil || len(entries) != 0 {
		t.Fatalf("listing leaked Trash: %v %v", entries, err)
	}
	if f, _, err := s.open(trashDir + "/" + e.ID + "/data"); err == nil {
		f.Close()
		t.Fatal("opened Trash payload")
	}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	z := zipper{store: s, zw: zw}
	if err := z.add(".", "Downloads"); err != nil {
		t.Fatal(err)
	}
	zw.Close()
	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range zr.File {
		if strings.Contains(f.Name, trashDir) {
			t.Fatal("zip leaked Trash", f.Name)
		}
	}
	if validNewName(trashDir) {
		t.Fatal("reserved name allowed")
	}
}

func TestTunnelTrashLifecycle(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	session := login(t, ctx, srv.URL, code(0))
	request := func(req tunnelRequest) map[string]any {
		return openSession(t, ctx, srv.URL, session).request(t, ctx, req)
	}
	os.WriteFile(filepath.Join(g.downloadsDir, "a"), []byte("a"), 0644)
	reply := request(tunnelRequest{Type: "delete", Path: "a"})
	id, _ := reply["id"].(string)
	if !validTrashID(id) {
		t.Fatal(reply)
	}
	reply = request(tunnelRequest{Type: "trash-list"})
	if reply["ok"] != true || len(reply["entries"].([]any)) != 1 {
		t.Fatal(reply)
	}
	for _, typ := range []string{"file", "list", "delete", "share", "upload"} {
		if reply := request(tunnelRequest{Type: typ, Path: trashDir + "/" + id + "/data"}); reply["error"] == nil {
			t.Fatalf("%s bypass: %v", typ, reply)
		}
	}
	reply = request(tunnelRequest{Type: "trash-restore", Name: id})
	if reply["path"] != "a" || !exists(filepath.Join(g.downloadsDir, "a")) {
		t.Fatal(reply)
	}
	reply = request(tunnelRequest{Type: "delete", Path: "a"})
	id = reply["id"].(string)
	if reply = request(tunnelRequest{Type: "trash-delete", Name: id}); reply["ok"] != true {
		t.Fatal(reply)
	}
	if exists(filepath.Join(g.downloadsDir, trashDir, id)) {
		t.Fatal("permanent delete failed")
	}
	for _, name := range []string{"a", "b"} {
		os.WriteFile(filepath.Join(g.downloadsDir, name), []byte(name), 0644)
		if reply = request(tunnelRequest{Type: "delete", Path: name}); reply["ok"] != true {
			t.Fatal(reply)
		}
	}
	if reply = request(tunnelRequest{Type: "trash-empty"}); reply["ok"] != true {
		t.Fatal(reply)
	}
	reply = request(tunnelRequest{Type: "trash-list"})
	if len(reply["entries"].([]any)) != 0 {
		t.Fatal(reply)
	}
}

func TestTrashCountLimit(t *testing.T) {
	s, err := openDownloadStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	trash, err := s.openTrash(true)
	if err != nil {
		t.Fatal(err)
	}
	defer trash.Close()
	now := time.Now()
	for i := 0; i <= trashCount; i++ {
		id := fmt.Sprintf("%032x", i)
		if err := trash.root.Mkdir(id, 0700); err != nil {
			t.Fatal(err)
		}
		e := trashEntry{ID: id, Path: "file", Deleted: now.Add(time.Duration(i) * time.Second)}
		b, _ := json.Marshal(e)
		if err := trash.root.WriteFile(id+"/info.json", b, 0600); err != nil {
			t.Fatal(err)
		}
		if err := trash.root.WriteFile(id+"/data", nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := trash.pruneTrash(now); err != nil {
		t.Fatal(err)
	}
	entries, err := trash.trashEntries()
	if err != nil || len(entries) != trashCount {
		t.Fatalf("count %d: %v", len(entries), err)
	}
	if entries[0].ID != fmt.Sprintf("%032x", 1) {
		t.Fatal("did not evict oldest")
	}
}

func TestTrashStorageFailurePreservesSource(t *testing.T) {
	dir := t.TempDir()
	s, _ := openDownloadStore(dir)
	defer s.Close()
	os.WriteFile(filepath.Join(dir, "file"), []byte("keep"), 0600)
	os.Symlink(t.TempDir(), filepath.Join(dir, trashDir))
	if _, err := s.putTrash("file", time.Now()); err == nil {
		t.Fatal("accepted symlink storage")
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "file")); string(b) != "keep" {
		t.Fatal("source changed")
	}
}

func TestTrashSurvivesUploadCleanup(t *testing.T) {
	dir := t.TempDir()
	s, _ := openDownloadStore(dir)
	defer s.Close()
	os.Mkdir(filepath.Join(dir, "folder"), 0755)
	name := uploadTempPrefix + "0123456789abcdef.part"
	os.WriteFile(filepath.Join(dir, "folder", name), []byte("keep"), 0600)
	e, err := s.putTrash("folder", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	removeStaleUploads(dir, time.Now().Add(time.Hour), staleUploadScan)
	g := withDefaultRoot(t, &server{serverConfig: serverConfig{downloadsDir: dir}})
	g.defaultFiles().cleanup(false)
	if !exists(filepath.Join(dir, trashDir, e.ID, "data", name)) {
		t.Fatal("upload cleanup altered Trash")
	}
}

// What Trash couldn't remove again isn't taken; and an entry that can't be
// removed doesn't stop the rest being pruned.
func TestTrashUnreadableFolders(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root opens every folder")
	}
	dir := t.TempDir()
	s, _ := openDownloadStore(dir)
	defer s.Close()
	shut := filepath.Join(dir, "proj", "shut")
	os.MkdirAll(shut, 0o755)
	os.WriteFile(filepath.Join(shut, "f"), []byte("x"), 0o644)
	os.Chmod(shut, 0)
	t.Cleanup(func() { os.Chmod(shut, 0o755) })
	if _, err := s.putTrash("proj", time.Now()); !errors.Is(err, errTrashUnreadable) || !exists(shut) {
		t.Fatalf("put: %v", err)
	}

	now := time.Now()
	os.WriteFile(filepath.Join(dir, "a"), []byte("a"), 0o644)
	os.WriteFile(filepath.Join(dir, "b"), []byte("b"), 0o644)
	a, _ := s.putTrash("a", now.Add(-trashAge-time.Hour))
	b, _ := s.putTrash("b", now.Add(-trashAge))
	// a, shut after the fact, as by another program.
	stuck := filepath.Join(dir, trashDir, a.ID, "data2", "in")
	os.MkdirAll(stuck, 0o755)
	os.WriteFile(filepath.Join(stuck, "f"), []byte("x"), 0o644)
	os.Chmod(stuck, 0)
	t.Cleanup(func() { os.Chmod(stuck, 0o755) })
	trash, _ := s.openTrash(false)
	defer trash.Close()
	if n, err := trash.pruneTrash(now); n != 1 || err == nil {
		t.Fatalf("pruned %d: %v", n, err)
	}
	if _, err := trash.readTrash(b.ID); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("the one after a stuck one: %v", err)
	}
}

// What holds a mount goes neither to Trash, whose pruning would empty
// what's mounted, nor away for good.
func TestTrashRefusesMounts(t *testing.T) {
	dir := t.TempDir()
	m := filepath.Join(dir, "f", "m")
	os.MkdirAll(m, 0o755)
	if err := syscall.Mount("tmpfs", m, "tmpfs", 0, ""); err != nil {
		t.Skipf("can't mount here: %v", err)
	}
	t.Cleanup(func() { syscall.Unmount(m, syscall.MNT_DETACH) })
	os.WriteFile(filepath.Join(m, "kept"), []byte("x"), 0o644)
	s, _ := openDownloadStore(dir)
	defer s.Close()
	if _, err := s.putTrash("f", time.Now()); !errors.Is(err, errHoldsMount) {
		t.Fatalf("to Trash: %v", err)
	}
	if _, err := s.deleteFile("f"); !errors.Is(err, errHoldsMount) {
		t.Fatalf("for good: %v", err)
	}
	if _, err := s.deleteFile("f/m"); !errors.Is(err, errHoldsMount) {
		t.Fatalf("the mount itself, for good: %v", err)
	}
	if !exists(filepath.Join(m, "kept")) {
		t.Fatal("what's mounted was emptied")
	}
	// A bind mount, on the same filesystem, as well.
	src, b := filepath.Join(dir, "src"), filepath.Join(dir, "g", "b")
	os.MkdirAll(src, 0o755)
	os.MkdirAll(b, 0o755)
	os.WriteFile(filepath.Join(src, "kept"), []byte("x"), 0o644)
	if err := syscall.Mount(src, b, "", syscall.MS_BIND, ""); err != nil {
		t.Fatalf("bind: %v", err)
	}
	t.Cleanup(func() { syscall.Unmount(b, syscall.MNT_DETACH) })
	if _, err := s.deleteFile("g"); !errors.Is(err, errHoldsMount) || !exists(filepath.Join(src, "kept")) {
		t.Fatalf("a bind mount, for good: %v", err)
	}
}

// Where Trash can't be made ready (the top folder not to be written in),
// the item's left, and offered for deleting for good.
func TestTrashSetupRefused(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root writes anywhere")
	}
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "sub"), 0o755)
	os.WriteFile(filepath.Join(dir, "sub", "f"), []byte("x"), 0o644)
	os.Chmod(dir, 0o555)
	t.Cleanup(func() { os.Chmod(dir, 0o755) })
	s, _ := openDownloadStore(dir)
	defer s.Close()
	_, err := s.putTrash("sub/f", time.Now())
	if !errors.Is(err, errTrashSetup) || !trashRefused(err) || !exists(filepath.Join(dir, "sub", "f")) {
		t.Fatalf("put: %v", err)
	}
	if !strings.Contains(deleteError(err), "Nothing was deleted") {
		t.Fatalf("said: %q", deleteError(err))
	}
}

// Where a rename can't be told not to replace, a file or folder's still
// put by a name only if it's free.
func TestPlacePlainly(t *testing.T) {
	dir := t.TempDir()
	s, _ := openDownloadStore(dir)
	defer s.Close()
	os.MkdirAll(filepath.Join(dir, "stage", "d", "in"), 0o755)
	os.WriteFile(filepath.Join(dir, "stage", "f"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(dir, "taken"), []byte("old"), 0o644)
	os.Mkdir(filepath.Join(dir, "takendir"), 0o755)
	for _, c := range []struct {
		from, at string
		isDir    bool
	}{{"stage/f", "taken", false}, {"stage/d", "takendir", true}, {"stage/d", "taken", true}} {
		if err := s.placePlainly(c.from, c.at, c.isDir); !errors.Is(err, fs.ErrExist) {
			t.Fatalf("%s over %s: %v", c.from, c.at, err)
		}
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "taken")); string(got) != "old" || !exists(filepath.Join(dir, "stage", "d", "in")) {
		t.Fatal("something was replaced or lost")
	}
	if err := s.placePlainly("stage/f", "f", false); err != nil || exists(filepath.Join(dir, "stage", "f")) {
		t.Fatalf("a file: %v", err)
	}
	if err := s.placePlainly("stage/d", "d", true); err != nil || !exists(filepath.Join(dir, "d", "in")) || exists(filepath.Join(dir, "stage", "d")) {
		t.Fatalf("a folder: %v", err)
	}
}

// An item whose path takes long to write out (characters JSON spells with
// six bytes) is still read back from Trash, and restored.
func TestTrashLongPaths(t *testing.T) {
	dir := t.TempDir()
	s, _ := openDownloadStore(dir)
	defer s.Close()
	name := strings.Repeat("&<>", 80) // 240 bytes, 1440 written out
	p := name
	for range 8 {
		p = filepath.Join(p, name)
	}
	if err := os.MkdirAll(filepath.Join(dir, filepath.Dir(p)), 0o755); err != nil {
		t.Skip(err)
	}
	os.WriteFile(filepath.Join(dir, p), []byte("x"), 0o644)
	e, err := s.putTrash(p, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if got, err := s.restoreTrash(e.ID); err != nil || got != p {
		t.Fatalf("restore: %v", err)
	}
}
