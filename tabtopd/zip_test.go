package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"testing"
)

func TestZipFileReplacedByFIFO(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "file")
	if err := os.WriteFile(p, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(p); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(p, 0600); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	var out bytes.Buffer
	z := &zipper{store: &downloadStore{root: root}, zw: zip.NewWriter(&out)}
	if err := z.addFile("file", "file", st); err != nil {
		t.Fatal(err)
	}
	if z.skipped != 1 || z.files != 0 {
		t.Fatalf("files=%d skipped=%d", z.files, z.skipped)
	}
	z.zw.Close()
}

// fetchZip makes a zip request and returns the zip, its name, and the
// final message.
func fetchZip(t *testing.T, tc *tunnelClient, req tunnelRequest) (*zip.Reader, string, map[string]any) {
	t.Helper()
	ctx := testCtx(t)
	req.Type = "zip"
	reply := tc.request(t, ctx, req)
	if reply["ok"] != true {
		t.Fatalf("zip %+v: %v", req, reply)
	}
	var data []byte
	for {
		kind, p, err := tc.read(ctx)
		if err != nil {
			t.Fatalf("zip ended without done: %v", err)
		}
		if kind == msgText {
			var end map[string]any
			json.Unmarshal(p, &end)
			zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
			if err != nil {
				t.Fatal(err)
			}
			return zr, reply["name"].(string), end
		}
		data = append(data, p...)
		tc.write(ctx, msgData, nil)
	}
}

func zipContents(t *testing.T, zr *zip.Reader) string {
	t.Helper()
	var out []string
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(rc)
		rc.Close()
		out = append(out, f.Name+"="+string(b))
	}
	sort.Strings(out)
	return strings.Join(out, " ")
}

func TestTunnelZip(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	dir := g.downloadsDir
	os.MkdirAll(filepath.Join(dir, "photos", "trip", "empty"), 0o755)
	os.WriteFile(filepath.Join(dir, "photos", "a.jpg"), []byte("jpeg"), 0o644)
	os.WriteFile(filepath.Join(dir, "photos", "trip", "notes.txt"), bytes.Repeat([]byte("n"), 3*fileChunk), 0o644)
	os.WriteFile(filepath.Join(dir, "photos", uploadTempPrefix+"0123456789abcdef.part"), []byte("partial"), 0o644)
	os.WriteFile(filepath.Join(dir, "top.txt"), []byte("top"), 0o644)
	os.Symlink("../top.txt", filepath.Join(dir, "photos", "link.txt")) // to a file inside: followed
	os.Symlink("..", filepath.Join(dir, "photos", "loop"))             // to a folder: left out
	os.WriteFile(filepath.Join(filepath.Dir(dir), "secret"), []byte("s"), 0o644)
	os.Symlink(filepath.Join(filepath.Dir(dir), "secret"), filepath.Join(dir, "photos", "escape")) // outside: left out
	s := login(t, ctx, srv.URL, code(0))

	zr, name, end := fetchZip(t, openSession(t, ctx, srv.URL, s), tunnelRequest{Names: []string{"photos"}})
	want := "photos/= photos/a.jpg=jpeg photos/link.txt=top photos/trip/= photos/trip/empty/= photos/trip/notes.txt=" + strings.Repeat("n", 3*fileChunk)
	if got := zipContents(t, zr); name != "photos.zip" || got != want || end["done"] != true {
		t.Errorf("photos: %s, %v, %.200s", name, end, got)
	}
	for _, f := range zr.File {
		if f.Name == "photos/a.jpg" && f.Method != zip.Store {
			t.Errorf("a.jpg compressed again")
		}
	}

	zr, name, _ = fetchZip(t, openSession(t, ctx, srv.URL, s), tunnelRequest{Path: "photos", Names: []string{"a.jpg", "trip"}})
	if got := zipContents(t, zr); name != "photos.zip" || !strings.HasPrefix(got, "a.jpg=jpeg trip/= trip/empty/= trip/notes.txt=") {
		t.Errorf("two in photos: %s, %.100s", name, got)
	}
	if _, name, _ = fetchZip(t, openSession(t, ctx, srv.URL, s), tunnelRequest{Names: []string{"top.txt", "photos"}}); name != "Downloads.zip" {
		t.Errorf("two at the top: %s", name)
	}

	for _, req := range []tunnelRequest{{}, {Names: []string{".."}}, {Names: []string{"a/b"}}, {Path: "../", Names: []string{"x"}},
		{Path: "top.txt", Names: []string{"x"}}, {Names: []string{"top.txt", "top.txt"}}} {
		req.Type = "zip"
		if reply := openSession(t, ctx, srv.URL, s).request(t, ctx, req); reply["error"] == nil {
			t.Errorf("zip %+v: %v", req, reply)
		}
	}
}

// zipNames lists what a zip made by z holds.
func zipNames(t *testing.T, b *bytes.Buffer) []string {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(b.Bytes()), int64(b.Len()))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, f := range zr.File {
		names = append(names, f.Name)
	}
	return names
}

// TestZipSwappedFolder leaves out a folder swapped for a symlink after it
// was listed, here to the folder above it, rather than follow it.
func TestZipSwappedFolder(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "top", "a"), 0o755)
	os.WriteFile(filepath.Join(dir, "top", "a", "f.txt"), []byte("f"), 0o644)
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	listed, err := root.Lstat("top/a")
	if err != nil {
		t.Fatal(err)
	}
	// Swapped once it's been listed.
	os.Rename(filepath.Join(dir, "top", "a"), filepath.Join(dir, "top", "b"))
	os.Symlink("..", filepath.Join(dir, "top", "a"))

	var b bytes.Buffer
	z := &zipper{store: &downloadStore{root: root}, zw: zip.NewWriter(&b)}
	if err := z.addDir("top/a", "a", listed, 2); err != nil {
		t.Fatal(err)
	}
	z.zw.Close()
	if names := zipNames(t, &b); len(names) != 0 || z.skipped != 1 {
		t.Errorf("swapped folder: zip holds %q, %d skipped; want nothing, 1 skipped", names, z.skipped)
	}
}

// TestZipDepth stops maxZipDepth folders down.
func TestZipDepth(t *testing.T) {
	dir := t.TempDir()
	deep := dir
	for range maxZipDepth + 6 {
		deep = filepath.Join(deep, "d")
	}
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	var b bytes.Buffer
	z := &zipper{store: &downloadStore{root: root}, zw: zip.NewWriter(&b)}
	if err := z.add("d", "d"); err != nil {
		t.Fatal(err)
	}
	z.zw.Close()
	if names := zipNames(t, &b); len(names) != maxZipDepth || z.skipped != 1 {
		t.Errorf("zip holds %d folders, %d skipped; want %d, 1 skipped", len(names), z.skipped, maxZipDepth)
	}
}
