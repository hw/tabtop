package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
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

func TestFinishPublishesOpenFile(t *testing.T) {
	for _, replace := range []bool{false, true} {
		dir := t.TempDir()
		root, err := os.OpenRoot(dir)
		if err != nil {
			t.Fatal(err)
		}
		defer root.Close()
		u, err := (&downloadStore{root: root}).startUpload(".")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := u.Write([]byte("original")); err != nil {
			t.Fatal(err)
		}
		if err := root.Rename(u.tmp, u.tmp+".old"); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, u.tmp), []byte("substituted"), 0600); err != nil {
			t.Fatal(err)
		}
		if replace {
			os.WriteFile(filepath.Join(dir, "result"), []byte("previous"), 0600)
		}
		if _, err := u.finish("result", replace); err != nil {
			t.Fatal(err)
		}
		got, err := os.ReadFile(filepath.Join(dir, "result"))
		if err != nil || string(got) != "original" {
			t.Fatalf("published %q: %v", got, err)
		}
	}
}

func TestResumeRejectsReplacedPartial(t *testing.T) {
	for _, fifo := range []bool{false, true} {
		dir := t.TempDir()
		root, err := os.OpenRoot(dir)
		if err != nil {
			t.Fatal(err)
		}
		defer root.Close()
		g := &server{serverConfig: serverConfig{downloadsDir: dir}}
		u, err := (&downloadStore{root: root}).startUpload(".")
		if err != nil {
			t.Fatal(err)
		}
		u.Write([]byte("part"))
		g.transfers.keepPartial(u, 10)
		// Keep the old inode allocated to make identity differences deterministic.
		if err := root.Rename(u.tmp, u.tmp+".old"); err != nil {
			t.Fatal(err)
		}
		if fifo {
			err = syscall.Mkfifo(filepath.Join(dir, u.tmp), 0600)
		} else {
			err = os.WriteFile(filepath.Join(dir, u.tmp), []byte("fake"), 0600)
		}
		if err != nil {
			t.Fatal(err)
		}
		res, offset := g.transfers.claimPartial(&downloadStore{root: root}, u.id(), ".", 10)
		if res != nil || offset != 0 {
			t.Fatal("resumed a replaced partial")
		}
		if _, err := root.Lstat(u.tmp); err != nil {
			t.Fatal("deleted replacement")
		}
	}
}

func TestTunnelFilesRejectFIFO(t *testing.T) {
	g, srv := newE2EServer(t)
	if err := syscall.Mkfifo(filepath.Join(g.downloadsDir, "fifo"), 0600); err != nil {
		t.Fatal(err)
	}
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	for _, kind := range []string{"file", "list"} {
		c := openSession(t, ctx, srv.URL, s)
		if reply := c.request(t, ctx, tunnelRequest{Type: kind, Path: "fifo"}); reply["error"] == nil {
			t.Fatalf("%s accepted FIFO: %v", kind, reply)
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
	entries, _, err := (&downloadStore{root: root}).listDir(".", f)
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

	// Too big for the disk: refused before anything's sent.
	if reply := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "upload", Name: "huge.bin", Size: 1 << 62}); !strings.HasPrefix(fmt.Sprint(reply["error"]), "There isn't room for it") {
		t.Errorf("a huge upload: %v", reply)
	}
	// The listing says how much room there is.
	if reply := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "list"}); reply["free"] == nil || reply["total"].(float64) <= 0 {
		t.Errorf("listing: free %v of %v", reply["free"], reply["total"])
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
	// So does cancelling.
	tc = openSession(t, ctx, srv.URL, s)
	tc.request(t, ctx, tunnelRequest{Type: "upload", Name: "left.bin", Size: 10})
	tc.write(ctx, msgData, []byte("abc"))
	tc.read(ctx)
	tc.write(ctx, msgText, []byte(`{"cancel":true}`))
	tc.c.Close(websocket.StatusNormalClosure, "")
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

// TestTunnelUploadResume checks that an upload whose connection is lost is
// kept, and carries on from where it stopped when resumed.
func TestTunnelUploadResume(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	partials := func() int {
		g.transfers.mu.Lock()
		defer g.transfers.mu.Unlock()
		return len(g.transfers.partials)
	}
	// start begins an upload of size bytes, sends first, and returns the
	// tunnel and the reply.
	start := func(size int64, resume, first string) (*tunnelClient, map[string]any) {
		tc := openSession(t, ctx, srv.URL, s)
		reply := tc.request(t, ctx, tunnelRequest{Type: "upload", Name: "r.bin", Size: size, Resume: resume})
		if reply["ok"] != true {
			t.Fatalf("upload: %v", reply)
		}
		if first != "" {
			tc.write(ctx, msgData, []byte(first))
			if kind, _, err := tc.read(ctx); err != nil || kind != msgData {
				t.Fatalf("acknowledgement: %v", err)
			}
		}
		return tc, reply
	}
	tc, reply := start(10, "", "abc")
	id := reply["id"].(string)
	if reply["offset"] != 0.0 || id == "" {
		t.Fatalf("first reply %v", reply)
	}
	tc.c.Close(websocket.StatusGoingAway, "") // lost, not cancelled
	for deadline := time.Now().Add(5 * time.Second); partials() == 0; time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the upload cut off wasn't kept")
		}
	}

	// Not for a file of another size: that starts again, and the one kept
	// stays.
	tc, reply = start(11, id, "")
	if reply["offset"] != 0.0 || reply["id"] == id {
		t.Errorf("resuming as another size: %v", reply)
	}
	tc.write(ctx, msgText, []byte(`{"cancel":true}`))

	// Carried on, while it's still going: the server stops the first.
	tc, reply = start(10, id, "def")
	if reply["offset"] != 3.0 || reply["id"] != id {
		t.Fatalf("resuming: %v", reply)
	}
	tc2, reply := start(10, id, "ghi")
	if reply["offset"] != 6.0 || reply["id"] != id {
		t.Fatalf("resuming one going on: %v", reply)
	}
	if _, _, err := tc.read(ctx); err == nil {
		t.Error("the first tunnel is still open")
	}
	tc2.write(ctx, msgData, []byte("j"))
	tc2.read(ctx)
	if res := tc2.readJSON(t, ctx); res["name"] != "r.bin" {
		t.Fatalf("saved as %v", res)
	}
	tc2.read(ctx) // the close
	if b, _ := os.ReadFile(filepath.Join(g.downloadsDir, "r.bin")); string(b) != "abcdefghij" {
		t.Errorf("saved %q", b)
	}
	if n := partials(); n != 0 {
		t.Errorf("%d kept after saving", n)
	}
	time.Sleep(100 * time.Millisecond)
	if entries, _ := os.ReadDir(g.downloadsDir); len(entries) != 1 {
		t.Errorf("Downloads holds %d entries", len(entries))
	}
	// Gone, as after a restart (which forgets those saved, too): it starts
	// again.
	g.transfers.mu.Lock()
	g.transfers.done = nil
	g.transfers.mu.Unlock()
	if tc, reply := start(10, id, ""); reply["offset"] != 0.0 {
		t.Errorf("resuming one gone: %v", reply)
	} else {
		tc.write(ctx, msgText, []byte(`{"cancel":true}`))
	}
}

// TestKeepPartialLimit checks that only maxPartials uploads cut off are
// kept, the oldest going first.
func TestKeepPartialLimit(t *testing.T) {
	g := &server{serverConfig: serverConfig{downloadsDir: t.TempDir()}}
	root, _ := os.OpenRoot(g.downloadsDir)
	defer root.Close()
	var first string
	for i := range maxPartials + 1 {
		u, err := (&downloadStore{root: root}).startUpload(".")
		if err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			first = u.id()
		}
		g.transfers.keepPartial(u, 1)
	}
	entries, _ := os.ReadDir(g.downloadsDir)
	if len(g.transfers.partials) != maxPartials || len(entries) != maxPartials || g.transfers.partials[first] != nil {
		t.Errorf("%d kept, %d files, the first kept: %v", len(g.transfers.partials), len(entries), g.transfers.partials[first] != nil)
	}
	if u, _ := g.transfers.claimPartial(&downloadStore{root: root}, first, ".", 1); u != nil {
		t.Error("the oldest could be resumed")
	}
}

// TestReclaimPartials checks that the room uploads kept to resume take is
// counted as free, and given up to an upload that needs it.
func TestReclaimPartials(t *testing.T) {
	g := &server{serverConfig: serverConfig{downloadsDir: t.TempDir()}}
	root, _ := os.OpenRoot(g.downloadsDir)
	defer root.Close()
	u, err := (&downloadStore{root: root}).startUpload(".")
	if err != nil {
		t.Fatal(err)
	}
	held := int64(4 << 20)
	u.Write(make([]byte, held))
	u.f.Sync()
	g.transfers.keepPartial(u, 2*held)
	destination, err := openRootDirectory(root, ".")
	if err != nil {
		t.Fatal(err)
	}
	defer destination.Close()
	free, _, _ := diskSpace(g.downloadsDir)
	room, _, _ := g.transfers.uploadRoom(destination)
	if d := room - free; d < held/2 || d > 2*held {
		t.Errorf("%d more counted as free, with %d kept", d, held)
	}
	// More than there is: everything kept goes, and it's still refused.
	if free, ok := g.transfers.reclaimPartials(destination, 1<<62); !ok || free >= 1<<62 {
		t.Fatalf("free %d, %v", free, ok)
	}
	entries, _ := os.ReadDir(g.downloadsDir)
	if len(g.transfers.partials) != 0 || len(entries) != 0 {
		t.Errorf("%d still kept, %d files", len(g.transfers.partials), len(entries))
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

func TestTunnelCreate(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	os.Mkdir(filepath.Join(g.downloadsDir, "notes"), 0o755)
	os.WriteFile(filepath.Join(g.downloadsDir, "notes", "readme.md"), nil, 0o644)
	s := login(t, ctx, srv.URL, code(0))
	create := func(req tunnelRequest) map[string]any {
		req.Type = "create"
		return openSession(t, ctx, srv.URL, s).request(t, ctx, req)
	}
	if res := create(tunnelRequest{Path: "notes", Name: "readme.md"}); res["name"] != "readme (1).md" {
		t.Fatalf("readme.md taken: %v", res)
	}
	if res := create(tunnelRequest{Path: "notes", Name: "todo.txt"}); res["name"] != "todo.txt" {
		t.Fatalf("todo.txt: %v", res)
	}
	if res := create(tunnelRequest{Name: "Untitled.txt"}); res["name"] != "Untitled.txt" {
		t.Fatalf("Untitled.txt: %v", res)
	}
	if res := create(tunnelRequest{Name: "Untitled.txt"}); res["name"] != "Untitled (1).txt" {
		t.Fatalf("Untitled.txt again: %v", res)
	}
	for _, name := range []string{"notes/readme (1).md", "notes/todo.txt", "Untitled.txt", "Untitled (1).txt"} {
		st, err := os.Stat(filepath.Join(g.downloadsDir, name))
		if err != nil || st.IsDir() || st.Size() != 0 {
			t.Fatalf("%s: %v %#v", name, err, st)
		}
	}
	if entries, _ := os.ReadDir(filepath.Join(g.downloadsDir, "notes")); len(entries) != 3 {
		t.Errorf("notes holds %d entries", len(entries))
	}
	for _, req := range []tunnelRequest{{Name: ".."}, {Name: "a/b"}, {Name: ""}, {Path: "../", Name: "x"},
		{Path: "missing", Name: "x"}, {Path: "notes/readme.md", Name: "x"}, {Name: uploadTempPrefix + "x"}} {
		if res := create(req); res["error"] == nil {
			t.Errorf("create %+v: %v", req, res)
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
			u, err := (&downloadStore{root: root}).startUpload(".")
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

// TestNewNameControl refuses control characters in a name being made, but
// not in one already there, which can still be renamed and deleted.
func TestNewNameControl(t *testing.T) {
	for name, ok := range map[string]bool{"a.txt": true, "a\nb": false, "a\rb": false, "tab\there": false, "del\x7f": false, "é ü": true} {
		if validNewName(name) != ok {
			t.Errorf("validNewName(%q) = %v, want %v", name, !ok, ok)
		}
	}
	dir := t.TempDir()
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	if _, err := (&downloadStore{root: root}).makeFolder(".", "new\nfolder"); err != errUploadName {
		t.Errorf("folder with a line break: %v", err)
	}
	if _, err := (&downloadStore{root: root}).createFile(".", "new\nfile"); err != errUploadName {
		t.Errorf("file with a line break: %v", err)
	}
	os.WriteFile(filepath.Join(dir, "odd\nname"), []byte("x"), 0o644)
	if err := (&downloadStore{root: root}).renameEntry("plain", "odd\nagain"); err != errUploadName {
		t.Errorf("rename to a line break: %v", err)
	}
	if err := (&downloadStore{root: root}).renameEntry("odd\nname", "fixed"); err != nil {
		t.Errorf("renaming a file with a line break: %v", err)
	}
	if _, err := (&downloadStore{root: root}).deleteFile("fixed"); err != nil {
		t.Errorf("deleting it: %v", err)
	}
	os.WriteFile(filepath.Join(dir, "odd\nname"), []byte("x"), 0o644)
	if _, err := (&downloadStore{root: root}).deleteFile("odd\nname"); err != nil {
		t.Errorf("deleting a file with a line break: %v", err)
	}
}

func TestPartialRetentionDeadline(t *testing.T) {
	clock := newManualClock()
	m := uploadManager{clock: clock.lifecycle()}
	store, err := openDownloadStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	u, err := store.startUpload(".")
	if err != nil {
		t.Fatal(err)
	}
	id := u.id()
	m.keepPartial(u, 1)
	clock.Advance(partialKeep - time.Nanosecond)
	if m.partials[id] == nil {
		t.Fatal("partial expired before its retention deadline")
	}
	clock.Advance(time.Nanosecond)
	if len(m.partials) != 0 {
		t.Fatal("expired partial still tracked")
	}
	entries, err := os.ReadDir(store.root.Name())
	if err != nil || len(entries) != 0 {
		t.Fatalf("expired file remains: %v, %v", entries, err)
	}

	u, err = store.startUpload(".")
	if err != nil {
		t.Fatal(err)
	}
	id = u.id()
	if _, err := u.f.Write([]byte("x")); err != nil {
		t.Fatal(err)
	}
	m.keepPartial(u, 2)
	resumed, held := m.claimPartial(store, id, ".", 2)
	if resumed == nil || held != 1 {
		t.Fatalf("resume: %v, held %d", resumed, held)
	}
	defer resumed.f.Close()
	clock.Advance(partialKeep)
	if _, err := store.root.Stat(resumed.tmp); err != nil {
		t.Fatalf("retention timer removed resumed upload: %v", err)
	}
}

// TestResumeRemovesChangedPartial deletes a kept upload that's still the
// gateway's file but no longer as it was kept, since nothing else would.
func TestResumeRemovesChangedPartial(t *testing.T) {
	dir := t.TempDir()
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	g := &server{serverConfig: serverConfig{downloadsDir: dir}}
	u, err := (&downloadStore{root: root}).startUpload(".")
	if err != nil {
		t.Fatal(err)
	}
	u.Write([]byte("part"))
	g.transfers.keepPartial(u, 10)
	// The same file, grown since it was kept.
	f, err := os.OpenFile(filepath.Join(dir, u.tmp), os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	f.Write([]byte("more"))
	f.Close()
	if res, _ := g.transfers.claimPartial(&downloadStore{root: root}, u.id(), ".", 10); res != nil {
		t.Fatal("resumed a partial that changed")
	}
	if _, err := root.Lstat(u.tmp); !os.IsNotExist(err) {
		t.Errorf("changed partial left behind: %v", err)
	}
}

// TestRemoveStaleStages removes the staging folders replacing uploads left
// behind, with the link to the file in them, but no others.
func TestRemoveStaleStages(t *testing.T) {
	dir := t.TempDir()
	old := time.Now().Add(-time.Hour)
	stage := func(name string, when time.Time) string {
		p := filepath.Join(dir, name)
		os.Mkdir(p, 0o700)
		os.WriteFile(filepath.Join(p, "saved"), []byte("data"), 0o644)
		os.Chtimes(p, when, when)
		return p
	}
	stale := stage(uploadTempPrefix+strings.Repeat("ab", 16)+".stage", old)
	current := stage(uploadTempPrefix+strings.Repeat("cd", 16)+".stage", time.Now())
	other := stage(uploadTempPrefix+"mine.stage", old) // not a name a replace makes
	removeStaleUploads(dir, time.Now().Add(-time.Minute), time.Hour)
	for p, want := range map[string]bool{stale: false, current: true, other: true} {
		if _, err := os.Stat(p); (err == nil) != want {
			t.Errorf("%s: exists %v, want %v", filepath.Base(p), err == nil, want)
		}
	}
}

// Saving from the editor: replaces the file only if it's as it was read,
// keeping its permissions, and says when it's been changed meanwhile.
func TestTunnelUploadIfUnchanged(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	file := filepath.Join(g.downloadsDir, "run.sh")
	os.WriteFile(file, []byte("echo old\n"), 0o755)
	read := func() (string, int64) {
		tc := openSession(t, ctx, srv.URL, s)
		r := tc.request(t, ctx, tunnelRequest{Type: "file", Path: "run.sh"})
		tc.c.CloseNow()
		return r["mtime"].(string), int64(r["size"].(float64))
	}
	save := func(text, mtime string, size int64) map[string]any {
		tc := openSession(t, ctx, srv.URL, s)
		r := tc.request(t, ctx, tunnelRequest{Type: "upload", Name: "run.sh", Size: int64(len(text)), Replace: true, IfMtime: mtime, IfSize: size})
		if r["ok"] != true {
			return r
		}
		tc.write(ctx, msgData, []byte(text))
		tc.read(ctx)
		return tc.readJSON(t, ctx)
	}
	mtime, size := read()
	r := save("echo new\n", mtime, size)
	if r["name"] != "run.sh" || r["mtime"] == nil || r["mtime"] == mtime {
		t.Fatalf("save: %v", r)
	}
	if st, _ := os.Stat(file); st.Mode().Perm() != 0o755 {
		t.Errorf("the saved file is %v, not 0755 as before", st.Mode().Perm())
	}
	// Saved again from the same reading: it's changed since.
	if r := save("echo stale\n", mtime, size); !strings.Contains(fmt.Sprint(r["error"]), "changed since it was opened") {
		t.Errorf("stale save: %v", r)
	}
	// From the save's own answer, it's as expected.
	if r2 := save("echo newer\n", r["mtime"].(string), int64(r["size"].(float64))); r2["name"] != "run.sh" {
		t.Errorf("save after save: %v", r2)
	}
	if b, _ := os.ReadFile(file); string(b) != "echo newer\n" {
		t.Errorf("holds %q", b)
	}
	os.Remove(file)
	if r := save("x", mtime, size); !strings.Contains(fmt.Sprint(r["error"]), "deleted or moved") {
		t.Errorf("deleted meanwhile: %v", r)
	}
	// Text being edited, rendered: sent after the request, as data, so
	// more of it than a request can hold (1 MiB) renders too.
	render := func(text string) map[string]any {
		tc := openSession(t, ctx, srv.URL, s)
		if r := tc.request(t, ctx, tunnelRequest{Type: "markdown", Size: int64(len(text))}); r["ok"] != true {
			return r
		}
		for at := 0; at < len(text); at += fileChunk {
			tc.write(ctx, msgData, []byte(text[at:min(at+fileChunk, len(text))]))
		}
		return tc.readJSON(t, ctx)
	}
	if r := render("# Draft\n"); !strings.Contains(fmt.Sprint(r["html"]), `<h1 id="draft">Draft</h1>`) {
		t.Errorf("markdown text: %v", r)
	}
	big := "# Big\n\n" + strings.Repeat("Some \"quoted\" text, escaped in JSON as more.\n\n", 1_500_000/48)
	if r := render(big); !strings.Contains(fmt.Sprint(r["html"]), `<h1 id="big">Big</h1>`) {
		t.Errorf("1.5 MB of text: %.200v", r)
	}
	if r := render(strings.Repeat("x", maxMarkdown+1)); r["error"] == nil {
		t.Errorf("too much text: %v", r)
	}
}

// Saves from the same reading, at once, as from two tabs: one is saved,
// the rest are told the file changed, and none is lost silently.
func TestTunnelUploadIfUnchangedConcurrent(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	os.WriteFile(filepath.Join(g.downloadsDir, "notes.txt"), []byte("v0"), 0o644)
	tc := openSession(t, ctx, srv.URL, s)
	r := tc.request(t, ctx, tunnelRequest{Type: "file", Path: "notes.txt"})
	tc.c.CloseNow()
	mtime := r["mtime"].(string)
	const n = 8
	results := make([]map[string]any, n)
	conns := make([]*tunnelClient, n)
	for i := range n {
		conns[i] = openSession(t, ctx, srv.URL, s)
		text := fmt.Sprintf("tab %d", i)
		if r := conns[i].request(t, ctx, tunnelRequest{Type: "upload", Name: "notes.txt", Size: int64(len(text)), Replace: true,
			IfMtime: mtime, IfSize: 2}); r["ok"] != true {
			t.Fatalf("upload %d: %v", i, r)
		}
	}
	// All have passed the first check; now all send at once.
	var wg sync.WaitGroup
	for i := range n {
		wg.Go(func() {
			conns[i].write(ctx, msgData, []byte(fmt.Sprintf("tab %d", i)))
			conns[i].read(ctx)
			results[i] = conns[i].readJSON(t, ctx)
		})
	}
	wg.Wait()
	saved := 0
	for _, r := range results {
		if r["name"] == "notes.txt" {
			saved++
		} else if !strings.Contains(fmt.Sprint(r["error"]), "changed since") {
			t.Errorf("answered %v", r)
		}
	}
	if saved != 1 {
		t.Errorf("%d saves went through from the same reading", saved)
	}
}

// TestTunnelUploadDoneTwice: an upload saved, whose page lost the answer and
// asks to carry on with it, as uploadFile does, is told it's saved, with
// the answer it would have had; not saved again, as another file, or
// refused as changed since (by itself) when it's a save from the editor.
func TestTunnelUploadDoneTwice(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	file := filepath.Join(g.downloadsDir, "notes.txt")
	os.WriteFile(file, []byte("old"), 0o644)
	st, _ := os.Stat(file)
	req := tunnelRequest{Type: "upload", Name: "notes.txt", Size: 3, Replace: true, IfMtime: fileVersion(st), IfSize: 3}
	upload := func(req tunnelRequest, data string) (map[string]any, map[string]any) {
		tc := openSession(t, ctx, srv.URL, s)
		reply := tc.request(t, ctx, req)
		if reply["ok"] != true {
			return reply, nil
		}
		if data != "" {
			tc.write(ctx, msgData, []byte(data))
			if kind, _, err := tc.read(ctx); err != nil || kind != msgData {
				t.Fatalf("acknowledgement: %v", err)
			}
		}
		_, p, err := tc.read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var res map[string]any
		json.Unmarshal(p, &res)
		return reply, res
	}
	first, saved := upload(req, "new")
	if saved["name"] != "notes.txt" {
		t.Fatalf("saved: %v %v", first, saved)
	}
	// Again, carrying on with it.
	req.Resume = first["id"].(string)
	again, res := upload(req, "")
	if again["offset"] != 3.0 || res["name"] != "notes.txt" || res["mtime"] != saved["mtime"] {
		t.Errorf("asked again: %v %v, first %v", again, res, saved)
	}
	des, _ := os.ReadDir(g.downloadsDir)
	if b, _ := os.ReadFile(file); string(b) != "new" || len(des) != 1 {
		t.Errorf("notes.txt holds %q; in the folder: %v", b, des)
	}
	// Not for another folder's, or another size.
	req.Size = 4
	if again, _ := upload(req, ""); again["offset"] == 4.0 {
		t.Errorf("another size: %v", again)
	}
}

// TestTunnelUploadRetryWhileSaving: the page asks to carry on with an
// editor's save as that save replaces the file, before it's recorded as
// done: told it's saved, once it is, not that the file changed since.
func TestTunnelUploadRetryWhileSaving(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	file := filepath.Join(g.downloadsDir, "notes.txt")
	os.WriteFile(file, []byte("old"), 0o644)
	st, _ := os.Stat(file)
	saving := make(chan struct{})
	release := make(chan struct{})
	uploadSavedHook = func() {
		close(saving)
		<-release
	}
	defer func() { uploadSavedHook = func() {} }()
	req := tunnelRequest{Type: "upload", Name: "notes.txt", Size: 3, Replace: true, IfMtime: fileVersion(st), IfSize: 3}
	tc := openSession(t, ctx, srv.URL, s)
	first := tc.request(t, ctx, req)
	tc.write(ctx, msgData, []byte("new"))
	<-saving // replaced, not yet recorded as done
	req.Resume = first["id"].(string)
	go func() {
		time.Sleep(300 * time.Millisecond)
		close(release)
	}()
	tc2 := openSession(t, ctx, srv.URL, s)
	again := tc2.request(t, ctx, req)
	if again["ok"] != true || again["offset"] != 3.0 {
		t.Fatalf("asked again while it saved: %v", again)
	}
	if res := tc2.readJSON(t, ctx); res["name"] != "notes.txt" {
		t.Errorf("told %v", res)
	}
	des, _ := os.ReadDir(g.downloadsDir)
	if b, _ := os.ReadFile(file); string(b) != "new" || len(des) != 1 {
		t.Errorf("notes.txt holds %q; in the folder: %v", b, des)
	}
}

// TestFileVersionReplaced: a file replaced by one of the same size, with
// the same time (as happens within one tick of the kernel's clock), isn't
// taken for the same: it's another inode.
func TestFileVersionReplaced(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "f")
	os.WriteFile(file, []byte("old"), 0o644)
	st, _ := os.Stat(file)
	before := fileVersion(st)
	os.WriteFile(filepath.Join(dir, "g"), []byte("new"), 0o644)
	os.Chtimes(filepath.Join(dir, "g"), st.ModTime(), st.ModTime())
	os.Rename(filepath.Join(dir, "g"), file)
	st2, _ := os.Stat(file)
	if !st2.ModTime().Equal(st.ModTime()) || st2.Size() != st.Size() {
		t.Fatal("not the same time and size")
	}
	if fileVersion(st2) == before {
		t.Errorf("replaced, it's the same version: %s", before)
	}
	store, _ := openDownloadStore(dir)
	defer store.Close()
	if err := unchangedSince(store, "f", before, 3); err == nil {
		t.Error("taken as unchanged")
	}
}
