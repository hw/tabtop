package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"
)

func TestValidUploadName(t *testing.T) {
	for name, want := range map[string]bool{
		"a.txt": true, "with space.pdf": true, ".bashrc": true, "ü.bin": true,
		"": false, ".": false, "..": false, "a/b": false, "a\x00b": false, "\xff": false,
		strings.Repeat("x", 256): false, uploadTempPrefix + "1.part": false,
	} {
		if got := validUploadName(name); got != want {
			t.Errorf("validUploadName(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestListDirHidesUploadsInProgress(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(dir, uploadTempPrefix+"1.part"), []byte("x"), 0o644)
	root, _ := os.OpenRoot(dir)
	defer root.Close()
	f, _ := root.Open(".")
	defer f.Close()
	entries, _, err := listDir(root, ".", f)
	if err != nil || len(entries) != 1 || entries[0].Name != "a.txt" {
		t.Errorf("listed %v: %v", entries, err)
	}
}

func TestTunnelUpload(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	os.WriteFile(filepath.Join(g.downloadsDir, "big.bin"), []byte("old"), 0o644)
	s := login(t, ctx, srv.URL, code(0))
	data := make([]byte, 3*fileChunk+5)
	for i := range data {
		data[i] = byte(i * 7)
	}

	tc := openSession(t, ctx, srv.URL, s)
	if reply := tc.request(t, ctx, tunnelRequest{Type: "upload", Name: "big.bin", Size: int64(len(data))}); reply["ok"] != true {
		t.Fatalf("upload: %v", reply)
	}
	for off := 0; off < len(data); off += fileChunk {
		tc.write(ctx, msgData, data[off:min(off+fileChunk, len(data))])
		if kind, p, err := tc.read(ctx); err != nil || kind != msgData || len(p) != 0 {
			t.Fatalf("acknowledgement: kind %d %q: %v", kind, p, err)
		}
	}
	if res := tc.readJSON(t, ctx); res["name"] != "big (1).bin" {
		t.Fatalf("saved as %v", res)
	}
	if b, _ := os.ReadFile(filepath.Join(g.downloadsDir, "big (1).bin")); !bytes.Equal(b, data) {
		t.Fatalf("saved %d bytes, want %d", len(b), len(data))
	}
	if b, _ := os.ReadFile(filepath.Join(g.downloadsDir, "big.bin")); string(b) != "old" {
		t.Errorf("the existing file now holds %d bytes", len(b))
	}

	// Replacing, as the person chose to.
	tc = openSession(t, ctx, srv.URL, s)
	if reply := tc.request(t, ctx, tunnelRequest{Type: "upload", Name: "big.bin", Size: 3, Replace: true}); reply["ok"] != true {
		t.Fatalf("upload: %v", reply)
	}
	tc.write(ctx, msgData, []byte("new"))
	tc.read(ctx)
	if res := tc.readJSON(t, ctx); res["name"] != "big.bin" {
		t.Fatalf("replacing, saved as %v", res)
	}
	if b, _ := os.ReadFile(filepath.Join(g.downloadsDir, "big.bin")); string(b) != "new" {
		t.Errorf("the replaced file holds %q", b)
	}
	os.Mkdir(filepath.Join(g.downloadsDir, "folder"), 0o755)
	tc = openSession(t, ctx, srv.URL, s)
	tc.request(t, ctx, tunnelRequest{Type: "upload", Name: "folder", Size: 1, Replace: true})
	tc.write(ctx, msgData, []byte("x"))
	tc.read(ctx)
	if res := tc.readJSON(t, ctx); res["error"] != errReplaceFolder.Error() {
		t.Errorf("replacing a folder: %v", res)
	}
	os.Remove(filepath.Join(g.downloadsDir, "folder"))

	// More than the size given ends the tunnel, and nothing is saved.
	tc = openSession(t, ctx, srv.URL, s)
	tc.request(t, ctx, tunnelRequest{Type: "upload", Name: "short.bin", Size: 3})
	tc.write(ctx, msgData, []byte("toolong"))
	if _, _, err := tc.read(ctx); websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Errorf("too much data: %v", err)
	}
	// So does leaving early.
	tc = openSession(t, ctx, srv.URL, s)
	tc.request(t, ctx, tunnelRequest{Type: "upload", Name: "left.bin", Size: 10})
	tc.write(ctx, msgData, []byte("abc"))
	tc.read(ctx)
	tc.c.CloseNow()
	for _, tc := range []tunnelRequest{
		{Type: "upload", Name: "../x", Size: 1},
		{Type: "upload", Name: "x", Path: "../", Size: 1},
		{Type: "upload", Name: "x", Path: "missing", Size: 1},
	} {
		if reply := openSession(t, ctx, srv.URL, s).request(t, ctx, tc); reply["error"] == nil {
			t.Errorf("upload %+v: %v", tc, reply)
		}
	}
	time.Sleep(100 * time.Millisecond)
	entries, _ := os.ReadDir(g.downloadsDir)
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	if strings.Join(names, ",") != "big (1).bin,big.bin" {
		t.Errorf("Downloads holds %v", names)
	}
}

func TestRemoveStaleUploadsBudget(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, uploadTempPrefix+"0123456789abcdef.part")
	os.WriteFile(p, nil, 0o644)
	old := time.Now().Add(-time.Hour)
	os.Chtimes(p, old, old)
	removeStaleUploads(dir, time.Now().Add(-time.Minute), time.Second) // already over
	if _, err := os.Stat(p); err != nil {
		t.Fatal("removed after the budget ran out")
	}
	removeStaleUploads(dir, time.Now(), time.Second)
	if _, err := os.Stat(p); err == nil {
		t.Error("not removed within the budget")
	}
}

func TestRemoveStaleUploads(t *testing.T) {
	dir := t.TempDir()
	os.Mkdir(filepath.Join(dir, "sub"), 0o755)
	outside := t.TempDir()
	os.Symlink(outside, filepath.Join(dir, "link"))
	old := time.Now().Add(-time.Hour)
	for _, p := range []string{
		filepath.Join(dir, uploadTempPrefix+"0123456789abcdef.part"),
		filepath.Join(dir, "sub", uploadTempPrefix+"1123456789abcdef.part"),
		filepath.Join(dir, "keep.part"),
		filepath.Join(dir, uploadTempPrefix+"mine.part"), // not a name an upload makes
		filepath.Join(outside, uploadTempPrefix+"2123456789abcdef.part"),
	} {
		os.WriteFile(p, nil, 0o644)
		os.Chtimes(p, old, old)
	}
	current := filepath.Join(dir, uploadTempPrefix+"3123456789abcdef.part")
	os.WriteFile(current, nil, 0o644)

	removeStaleUploads(dir, time.Now().Add(-time.Minute), time.Hour)
	for p, want := range map[string]bool{
		filepath.Join(dir, uploadTempPrefix+"0123456789abcdef.part"):        false,
		filepath.Join(dir, "sub", uploadTempPrefix+"1123456789abcdef.part"): false,
		filepath.Join(dir, "keep.part"):                                     true,
		filepath.Join(dir, uploadTempPrefix+"mine.part"):                    true,
		filepath.Join(outside, uploadTempPrefix+"2123456789abcdef.part"):    true, // behind a symlink
		current: true, // still being written
	} {
		if _, err := os.Stat(p); (err == nil) != want {
			t.Errorf("%s: exists %v, want %v", p, err == nil, want)
		}
	}
}

func TestTunnelMkdir(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	os.Mkdir(filepath.Join(g.downloadsDir, "photos"), 0o755)
	os.WriteFile(filepath.Join(g.downloadsDir, "photos", "a.jpg"), []byte("old"), 0o644)
	s := login(t, ctx, srv.URL, code(0))
	mkdir := func(req tunnelRequest) map[string]any {
		req.Type = "mkdir"
		return openSession(t, ctx, srv.URL, s).request(t, ctx, req)
	}
	// A folder that's there already isn't merged into.
	if res := mkdir(tunnelRequest{Name: "photos"}); res["name"] != "photos (1)" {
		t.Fatalf("photos: %v", res)
	}
	if res := mkdir(tunnelRequest{Path: "photos (1)", Name: "2024.trip"}); res["name"] != "2024.trip" {
		t.Fatalf("subfolder: %v", res)
	}
	if res := mkdir(tunnelRequest{Path: "photos (1)", Name: "2024.trip"}); res["name"] != "2024.trip (1)" {
		t.Fatalf("subfolder again: %v", res)
	}
	if st, err := os.Stat(filepath.Join(g.downloadsDir, "photos (1)", "2024.trip (1)")); err != nil || !st.IsDir() {
		t.Fatalf("not created: %v", err)
	}
	if entries, _ := os.ReadDir(filepath.Join(g.downloadsDir, "photos")); len(entries) != 1 {
		t.Errorf("the existing folder holds %d entries", len(entries))
	}
	for _, req := range []tunnelRequest{{Name: ".."}, {Name: "a/b"}, {Name: ""}, {Path: "../", Name: "x"},
		{Path: "missing", Name: "x"}, {Path: "photos/a.jpg", Name: "x"}, {Name: uploadTempPrefix + "x"}} {
		if res := mkdir(req); res["error"] == nil {
			t.Errorf("mkdir %+v: %v", req, res)
		}
	}
}

// TestRemoveStaleUploadsSwapped checks that a queued folder replaced by a
// symlink to one outside isn't followed.
func TestRemoveStaleUploadsSwapped(t *testing.T) {
	dir, outside := t.TempDir(), t.TempDir()
	p := filepath.Join(outside, uploadTempPrefix+"0123456789abcdef.part")
	os.WriteFile(p, nil, 0o644)
	old := time.Now().Add(-time.Hour)
	os.Chtimes(p, old, old)
	os.Symlink(outside, filepath.Join(dir, "sub")) // was a folder when it was queued
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	var stop atomic.Bool
	if n := walkStaleUploads(root, []string{"sub"}, time.Now(), &stop); n != 0 {
		t.Errorf("removed %d", n)
	}
	if _, err := os.Stat(p); err != nil {
		t.Error("removed a file outside")
	}
}

// TestUploadLongNameTaken checks that a name as long as a name can be still
// gets a numbered name when it's taken.
func TestUploadLongNameTaken(t *testing.T) {
	dir := t.TempDir()
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	for _, name := range []string{
		strings.Repeat("a", 251) + ".txt",
		strings.Repeat("ü", 125) + ".bin" + "x", // 255 bytes; "ü" is two
		"a." + strings.Repeat("e", 253),         // all extension
	} {
		if len(name) != maxNameBytes || !validUploadName(name) {
			t.Fatalf("test name %q: %d bytes", name, len(name))
		}
		for i := range 3 {
			u, err := startUpload(root, ".")
			if err != nil {
				t.Fatal(err)
			}
			if !uploadTempName.MatchString(filepath.Base(u.tmp)) {
				t.Fatalf("temporary file %q isn't one removeStaleUploads would remove", u.tmp)
			}
			got, err := u.finish(name, false)
			if err != nil {
				t.Fatalf("upload %d of %q: %v", i, name[:10], err)
			}
			if len(got) > maxNameBytes || !utf8.ValidString(got) || (i > 0) != strings.Contains(got, fmt.Sprintf(" (%d)", i)) {
				t.Errorf("upload %d of %q: saved as %q", i, name[:10], got)
			}
		}
	}
}

// TestRemoveStaleUploadsHung checks that the search returns after its
// budget even while a read of the file system hangs: here, opening a FIFO
// where a folder was expected.
func TestRemoveStaleUploadsHung(t *testing.T) {
	dir := t.TempDir()
	fifo := filepath.Join(dir, "fifo")
	if err := syscall.Mkfifo(fifo, 0o644); err != nil {
		t.Skip(err)
	}
	t.Cleanup(func() {
		// Let the walker's open go, so it can finish.
		if f, err := os.OpenFile(fifo, os.O_WRONLY|syscall.O_NONBLOCK, 0); err == nil {
			f.Close()
		}
	})
	start := time.Now()
	removeStaleUploads(fifo, start, 200*time.Millisecond)
	if d := time.Since(start); d > time.Second {
		t.Errorf("returned after %v", d)
	}
}
