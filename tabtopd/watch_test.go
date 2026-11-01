package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestWatchDownloads(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "old.txt"), []byte("x"), 0o644)
	os.Mkdir(filepath.Join(dir, "sub"), 0o755)
	stop := make(chan struct{})
	got := make(chan string, 16)
	done := make(chan error, 1)
	go func() {
		done <- watchDownloads(dir, stop, func(name string, size int64) { got <- name })
	}()
	time.Sleep(100 * time.Millisecond) // for the watch to start

	write := func(name, data string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(data), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// A browser's download, renamed when done.
	write("report.pdf.crdownload", "pdf")
	os.Rename(filepath.Join(dir, "report.pdf.crdownload"), filepath.Join(dir, "report.pdf"))
	// Written in place, twice in a row: one notice.
	write("notes.txt", "a")
	write("notes.txt", "ab")
	// Not new: renamed, hidden, in a folder, an upload linked in, or an
	// upload replacing a file.
	os.Rename(filepath.Join(dir, "old.txt"), filepath.Join(dir, "older.txt"))
	write(".hidden", "x")
	write("sub/inner.txt", "x")
	write(uploadTempPrefix+"0123456789abcdef.part", "up")
	os.Link(filepath.Join(dir, uploadTempPrefix+"0123456789abcdef.part"), filepath.Join(dir, "uploaded.bin"))
	os.Rename(filepath.Join(dir, uploadTempPrefix+"0123456789abcdef.part"), filepath.Join(dir, "notes.txt"))
	// Moved in from elsewhere.
	other := filepath.Join(t.TempDir(), "moved.zip")
	os.WriteFile(other, []byte("zip"), 0o644)
	os.Rename(other, filepath.Join(dir, "moved.zip"))

	want := map[string]bool{"report.pdf": true, "notes.txt": true, "moved.zip": true}
	seen := map[string]int{}
	timeout := time.After(3 * time.Second)
wait:
	for {
		select {
		case name := <-got:
			seen[name]++
		case <-timeout:
			break wait
		}
	}
	for name := range want {
		if seen[name] != 1 {
			t.Errorf("%s told of %d times", name, seen[name])
		}
	}
	for name, n := range seen {
		if !want[name] {
			t.Errorf("%s told of %d times, though not new", name, n)
		}
	}
	close(stop)
	select {
	case err := <-done:
		if err != nil {
			t.Error(err)
		}
	case <-time.After(2 * time.Second):
		t.Error("the watch didn't stop")
	}
}

func TestMoveEntry(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "a", "b"), 0o755)
	os.Mkdir(filepath.Join(dir, "dest"), 0o755)
	os.WriteFile(filepath.Join(dir, "f.txt"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(dir, "dest", "taken.txt"), []byte("old"), 0o644)
	os.WriteFile(filepath.Join(dir, "taken.txt"), []byte("new"), 0o644)
	os.Symlink(filepath.Join(filepath.Dir(dir)), filepath.Join(dir, "escape"))
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()

	if err := moveEntry(root, "f.txt", "dest"); err != nil || !exists(filepath.Join(dir, "dest", "f.txt")) {
		t.Errorf("file: %v", err)
	}
	if err := moveEntry(root, "dest/f.txt", ""); err != nil || !exists(filepath.Join(dir, "f.txt")) {
		t.Errorf("back up: %v", err)
	}
	if err := moveEntry(root, "a", "dest"); err != nil || !exists(filepath.Join(dir, "dest", "a", "b")) {
		t.Errorf("folder: %v", err)
	}
	for _, c := range []struct {
		name, to string
		want     error
	}{
		{"taken.txt", "dest", errMoveTaken},
		{"dest", "dest/a", errMoveInside},
		{"dest", "dest", errMoveInside},
		{"f.txt", "", errMoveHere},
		{"f.txt", "missing", errNoFolder},
		{"f.txt", "taken.txt", errNoFolder},
		{"f.txt", "escape", errNoFolder},
		{"f.txt", "..", errNoFolder},
	} {
		if err := moveEntry(root, c.name, c.to); err != c.want {
			t.Errorf("move %s to %q: %v, want %v", c.name, c.to, err, c.want)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "dest", "taken.txt")); string(b) != "old" {
		t.Error("a move replaced a file")
	}
}

func TestTunnelWatchAndMove(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	dir := g.downloadsDir
	os.Mkdir(filepath.Join(dir, "sub"), 0o755)
	os.WriteFile(filepath.Join(dir, "sub", "inner.txt"), []byte("x"), 0o644)
	s := login(t, ctx, srv.URL, code(0))

	w := openSession(t, ctx, srv.URL, s)
	if reply := w.request(t, ctx, tunnelRequest{Type: "watch"}); reply["ok"] != true {
		t.Fatalf("watch: %v", reply)
	}
	time.Sleep(100 * time.Millisecond)
	// Moved in by the gateway: not told of. Saved by something else: told.
	if reply := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "move", Path: "sub/inner.txt", To: ""}); reply["ok"] != true {
		t.Fatalf("move: %v", reply)
	}
	os.WriteFile(filepath.Join(dir, "saved.txt"), []byte("hello"), 0o644)
	if res := w.readJSON(t, ctx); res["saved"] != "saved.txt" || res["bytes"] != float64(5) {
		t.Errorf("told %v", res)
	}
	if reply := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "move", Path: "saved.txt", To: "sub/../.."}); reply["error"] == nil {
		t.Errorf("moved out of Downloads: %v", reply)
	}
}

func TestWatchChanges(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "watched")
	os.Mkdir(dir, 0o755)
	stop := make(chan struct{})
	defer close(stop)
	got := make(chan struct{}, 16)
	done := make(chan error, 1)
	go func() {
		done <- watchChanges(dir, stop, func() {}, func() { got <- struct{}{} })
	}()
	time.Sleep(100 * time.Millisecond) // for the watch to start
	expect := func(what string, want bool) {
		t.Helper()
		select {
		case <-got:
			if !want {
				t.Errorf("%s: told of a change", what)
			}
		case <-time.After(changesMax + 300*time.Millisecond):
			if want {
				t.Errorf("%s: not told of", what)
			}
		}
	}

	// A burst of changes is told of once.
	for i := range 5 {
		os.WriteFile(filepath.Join(dir, "a.txt"), []byte{byte(i)}, 0o644)
	}
	expect("a file written", true)
	expect("the burst", false)
	// The gateway's unfinished upload isn't listed.
	os.WriteFile(filepath.Join(dir, uploadTempPrefix+"0123456789abcdef.part"), []byte("up"), 0o644)
	expect("an upload's temporary file", false)
	os.Rename(filepath.Join(dir, uploadTempPrefix+"0123456789abcdef.part"), filepath.Join(dir, "up.bin"))
	expect("an upload finished", true)
	os.Mkdir(filepath.Join(dir, "sub"), 0o755)
	expect("a folder made", true)
	os.Chtimes(filepath.Join(dir, "a.txt"), time.Now(), time.Now().Add(-time.Hour))
	expect("a file touched", true)
	os.Remove(filepath.Join(dir, "a.txt"))
	expect("a file deleted", true)

	// The folder itself moved away.
	os.Rename(dir, dir+"-moved")
	expect("the folder moved", true)
	select {
	case err := <-done:
		if !errors.Is(err, errDirGone) {
			t.Errorf("ended with %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Error("the watch didn't end")
	}
}

func TestTunnelChanges(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	dir := g.downloadsDir
	os.Mkdir(filepath.Join(dir, "sub"), 0o755)
	os.WriteFile(filepath.Join(dir, "f.txt"), []byte("x"), 0o644)
	os.Symlink(filepath.Dir(dir), filepath.Join(dir, "escape"))
	s := login(t, ctx, srv.URL, code(0))
	if s.expires < time.Now().Add(defaultSessionMax-time.Minute).UnixMilli() || s.expires > time.Now().Add(defaultSessionMax).UnixMilli() {
		t.Errorf("the login said it expires at %d", s.expires)
	}

	for _, path := range []string{"f.txt", "missing", "escape", "../"} {
		if reply := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "changes", Path: path}); reply["error"] == nil {
			t.Errorf("changes in %q: %v", path, reply)
		}
	}

	w := openSession(t, ctx, srv.URL, s)
	if reply := w.request(t, ctx, tunnelRequest{Type: "changes", Path: "sub"}); reply["ok"] != true {
		t.Fatalf("changes: %v", reply)
	}
	time.Sleep(100 * time.Millisecond)
	os.WriteFile(filepath.Join(dir, "sub", "new.txt"), []byte("hello"), 0o644)
	if res := w.readJSON(t, ctx); res["changed"] != true {
		t.Errorf("told %v", res)
	}
	os.Rename(filepath.Join(dir, "sub"), filepath.Join(dir, "sub2"))
	expectGone(t, ctx, w, "moved")

	// Deleted, even though the gateway has it open.
	os.Mkdir(filepath.Join(dir, "empty"), 0o755)
	w = openSession(t, ctx, srv.URL, s)
	if reply := w.request(t, ctx, tunnelRequest{Type: "changes", Path: "empty"}); reply["ok"] != true {
		t.Fatalf("changes: %v", reply)
	}
	time.Sleep(100 * time.Millisecond)
	os.Remove(filepath.Join(dir, "empty"))
	expectGone(t, ctx, w, "deleted")
}

// expectGone reads w until it closes, as the gateway should once the
// folder it watches is gone (how says how), and checks it said why.
func expectGone(t *testing.T, ctx context.Context, w *tunnelClient, how string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	for {
		_, _, err := w.read(ctx)
		if err == nil {
			continue
		}
		if websocket.CloseStatus(err) != websocket.StatusNormalClosure {
			t.Errorf("folder %s: closed with %v", how, err)
		}
		var ce websocket.CloseError
		if !errors.As(err, &ce) || ce.Reason == "" {
			t.Errorf("folder %s: closed without saying why: %v", how, err)
		}
		return
	}
}
