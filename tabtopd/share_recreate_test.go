package main

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// needBirth skips a test where the filesystem doesn't say when p was made:
// there, a folder made again under its name, with its inode, still matches
// a link to the one before (see shareLink.matches).
func needBirth(t *testing.T, p string) {
	t.Helper()
	f, err := os.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if birthTime(f) == 0 {
		t.Skip("the filesystem doesn't say when a folder was made")
	}
}

func inodeOf(t *testing.T, p string) uint64 {
	t.Helper()
	st, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	return st.Sys().(*syscall.Stat_t).Ino
}

// A folder share link must stop working once its folder is deleted, even
// if a new folder is later made under the same name (docs: "A link stops
// working once its folder is moved, renamed or deleted"; environment.md:
// "deleting and recreating its folder, invalidates its shares").
func TestShareFolderRecreatedSameName(t *testing.T) {
	g, srv, s, _ := newShareServer(t)
	dir := filepath.Join(g.downloadsDir, "for-alice")
	os.MkdirAll(dir, 0o755)
	needBirth(t, dir)
	os.WriteFile(filepath.Join(dir, "meant-for-alice.txt"), []byte("ok"), 0o644)
	url := makeShare(t, srv, s, "for-alice", 3600, 0)
	before := inodeOf(t, dir)

	// Later the owner deletes the folder (rm -rf in the terminal, or
	// emptying Trash) and makes a new one with the same name.
	os.RemoveAll(dir)
	os.Mkdir(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "private.txt"), []byte("secret"), 0o644)
	if inodeOf(t, dir) != before {
		t.Skip("filesystem did not reuse the inode (tmpfs); run with TMPDIR on ext4")
	}

	res, body := shareFetch(t, "GET", url)
	if res.StatusCode == 200 {
		zr, _ := zip.NewReader(bytes.NewReader(body), int64(len(body)))
		var names []string
		for _, f := range zr.File {
			names = append(names, f.Name)
		}
		t.Fatalf("old link to a deleted folder serves the new folder: %d %v", res.StatusCode, names)
	}
}

func TestShareUploadFolderRecreatedSameName(t *testing.T) {
	g, srv, s, _ := newShareServer(t)
	dir := filepath.Join(g.downloadsDir, "inbox")
	os.MkdirAll(dir, 0o755)
	needBirth(t, dir)
	url := makeUploadLink(t, srv, s, "inbox", 0, 1<<20)
	before := inodeOf(t, dir)

	os.RemoveAll(dir)
	os.Mkdir(dir, 0o755)
	if inodeOf(t, dir) != before {
		t.Skip("filesystem did not reuse the inode (tmpfs); run with TMPDIR on ext4")
	}
	res, body := sendBody(t, "PUT", url+"dropped.txt", "", strings.NewReader("x"))
	if res.StatusCode == 201 {
		t.Fatalf("old upload link writes into a recreated folder: %d %q", res.StatusCode, body)
	}
}

// The same, entirely through the files page: Delete (to Trash), Empty
// Trash, New folder with the same name.
func TestShareFolderRecreatedInApp(t *testing.T) {
	g, srv, s, _ := newShareServer(t)
	dir := filepath.Join(g.downloadsDir, "for-alice")
	os.MkdirAll(dir, 0o755)
	needBirth(t, dir)
	os.WriteFile(filepath.Join(dir, "meant-for-alice.txt"), []byte("ok"), 0o644)
	url := makeShare(t, srv, s, "for-alice", 3600, 0)
	before := inodeOf(t, dir)
	req := func(r tunnelRequest) map[string]any {
		return openSession(t, testCtx(t), srv, s).request(t, testCtx(t), r)
	}
	if r := req(tunnelRequest{Type: "delete", Path: "for-alice"}); r["ok"] != true {
		t.Fatalf("delete: %v", r)
	}
	if r := req(tunnelRequest{Type: "trash-empty"}); r["ok"] != true {
		t.Fatalf("empty trash: %v", r)
	}
	if r := req(tunnelRequest{Type: "mkdir", Name: "for-alice"}); r["name"] != "for-alice" {
		t.Fatalf("mkdir: %v", r)
	}
	os.WriteFile(filepath.Join(dir, "private.txt"), []byte("secret"), 0o644)
	if inodeOf(t, dir) != before {
		t.Skip("filesystem did not reuse the inode (tmpfs); run with TMPDIR on ext4")
	}
	if res, body := shareFetch(t, "GET", url); res.StatusCode == 200 {
		zr, _ := zip.NewReader(bytes.NewReader(body), int64(len(body)))
		var names []string
		for _, f := range zr.File {
			names = append(names, f.Name)
		}
		t.Fatalf("old link serves the new folder: %v", names)
	}
}

// Whatever the filesystem does with inodes: a link made for one folder
// doesn't match another that has its inode, but was made later.
func TestShareLinkMatchesBirth(t *testing.T) {
	dir := t.TempDir()
	a, b := filepath.Join(dir, "a"), filepath.Join(dir, "b")
	os.Mkdir(a, 0o755)
	time.Sleep(5 * time.Millisecond)
	os.Mkdir(b, 0o755)
	open := func(p string) (*os.File, os.FileInfo) {
		f, err := os.Open(p)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { f.Close() })
		st, _ := f.Stat()
		return f, st
	}
	fa, sa := open(a)
	fb, sb := open(b)
	if birthTime(fa) == 0 {
		t.Skip("the filesystem doesn't say when a file was made")
	}
	l := &shareLink{Dir: true, Ino: inodeOf(t, a), Birth: birthTime(fa)}
	if !l.matches(fa, sa) {
		t.Fatal("the link doesn't match its own folder")
	}
	l.Ino = inodeOf(t, b) // as if b had been given a's inode
	if l.matches(fb, sb) {
		t.Fatal("a folder made later, with the link's inode, matches it")
	}
	// A link saved before birth times were kept goes by the inode alone.
	l.Birth = 0
	if !l.matches(fb, sb) {
		t.Fatal("a link without a birth time doesn't match by inode")
	}
}

// Wherever the filesystem says nothing of when a folder was made: a link
// is revoked once what it's to is removed for good (Trash emptied, one
// item deleted from Trash, a permanent delete), and only that link. A
// link made since to a new folder by the same name is left.
func TestShareLinksEndWithWhatsRemoved(t *testing.T) {
	g, srv, s, _ := newShareServer(t)
	req := func(r tunnelRequest) map[string]any {
		return openSession(t, testCtx(t), srv, s).request(t, testCtx(t), r)
	}
	ok := func(url string) bool {
		res, _ := shareFetch(t, "GET", url)
		return res.StatusCode == 200
	}
	links := func() int {
		g.shares.mu.Lock()
		defer g.shares.mu.Unlock()
		return len(g.shares.links)
	}
	mk := func(name string) {
		dir := filepath.Join(g.downloadsDir, name)
		os.MkdirAll(filepath.Join(dir, "in"), 0o755)
		os.WriteFile(filepath.Join(dir, "in", "f.txt"), []byte("x"), 0o644)
	}

	// Emptying Trash: the folder's link, and one to a file in it, end;
	// the new folder's link doesn't.
	mk("a")
	old, inner := makeShare(t, srv, s, "a", 3600, 0), makeShare(t, srv, s, "a/in/f.txt", 3600, 0)
	if r := req(tunnelRequest{Type: "delete", Path: "a"}); r["ok"] != true {
		t.Fatalf("delete: %v", r)
	}
	mk("a")
	fresh := makeShare(t, srv, s, "a", 3600, 0)
	if links() != 3 {
		t.Fatalf("%d links before emptying Trash, not 3", links())
	}
	if r := req(tunnelRequest{Type: "trash-empty"}); r["ok"] != true {
		t.Fatalf("empty Trash: %v", r)
	}
	if links() != 1 || !ok(fresh) || ok(old) || ok(inner) {
		t.Fatalf("after emptying Trash: %d links, the new folder's working: %v", links(), ok(fresh))
	}

	// One item deleted from Trash.
	mk("b")
	makeShare(t, srv, s, "b", 3600, 0)
	r := req(tunnelRequest{Type: "delete", Path: "b"})
	id, _ := r["id"].(string)
	if id == "" {
		t.Fatalf("delete: %v", r)
	}
	if r := req(tunnelRequest{Type: "trash-delete", Name: id}); r["ok"] != true {
		t.Fatalf("delete from Trash: %v", r)
	}
	if links() != 1 {
		t.Fatalf("%d links after deleting from Trash, not 1", links())
	}

	// A permanent delete.
	mk("c")
	makeShare(t, srv, s, "c/in/f.txt", 3600, 0)
	if r := req(tunnelRequest{Type: "delete", Path: "c", Permanent: true}); r["ok"] != true {
		t.Fatalf("permanent delete: %v", r)
	}
	if links() != 1 || !ok(fresh) {
		t.Fatalf("%d links after a permanent delete, not 1", links())
	}
}

// A permanent delete that's refused (the exposed folder itself) ends no
// links: they end only once what they're to is gone.
func TestShareLinksKeptWhenDeleteRefused(t *testing.T) {
	g, srv, s, _ := newShareServer(t)
	dir := filepath.Join(g.downloadsDir, "a")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "f.txt"), []byte("x"), 0o644)
	file := makeShare(t, srv, s, "a/f.txt", 3600, 0)
	makeShare(t, srv, s, "a", 3600, 0)
	r := openSession(t, testCtx(t), srv, s).request(t, testCtx(t), tunnelRequest{Type: "delete", Path: "", Permanent: true})
	if r["ok"] == true {
		t.Fatalf("the exposed folder deleted: %v", r)
	}
	g.shares.mu.Lock()
	n := len(g.shares.links)
	g.shares.mu.Unlock()
	if res, _ := shareFetch(t, "GET", file); n != 2 || res.StatusCode != 200 {
		t.Fatalf("after a refused delete: %d of 2 links left, the file's answering %d", n, res.StatusCode)
	}
}
