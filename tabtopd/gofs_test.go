package main

import (
	"os"
	"path/filepath"
	"testing"
)

// TestGoFSReplies: a picker's answer is taken only as a handle the page can
// use: a save's name one that can't leave its staging directory; a save's
// handle readable (getFile) as an opened file's is.
func TestGoFSReplies(t *testing.T) {
	for _, name := range []string{"../x", "a/b", "", "..", "a\x00"} {
		if _, why := validateGoFSReply("fs-save", `{"handle":"abc123","name":"`+name+`","size":0}`); why == "" {
			t.Errorf("a save named %q taken", name)
		}
	}
	if _, why := validateGoFSReply("fs-save", `{"handle":"abc123","name":"out.txt","size":0}`); why != "" {
		t.Errorf("a save refused: %s", why)
	}
	if _, why := validateGoFSReply("fs-open", `{"files":[{"handle":"abc123","name":"../x","size":1}]}`); why == "" {
		t.Errorf("an opened file named ../x taken")
	}
	b := &goBrowser{}
	if !b.rememberFSHandles("fs-save", `{"handle":"abc123","name":"out.txt","size":5}`, 2, 3) {
		t.Fatal("a save's handle not kept")
	}
	if h := b.fs.handles["abc123"]; h == nil || h.name != "out.txt" || h.gen != 2 || h.world != 3 {
		t.Fatalf("kept as %+v", h)
	}
	if !b.rememberFSHandles("fs-open", `{"files":[{"handle":"def456","name":"a.txt","size":1},{"handle":"ghi789","name":"b.txt","size":2}]}`, 2, 3) || len(b.fs.handles) != 3 {
		t.Fatalf("opened files not kept: %d", len(b.fs.handles))
	}
}

// TestGoFSWritten: a copy staged for getFile is let go once the file's
// written (staged again at the next read), its bytes no longer counted.
func TestGoFSWritten(t *testing.T) {
	dir := filepath.Join(t.TempDir(), ".tabtop-fs-1")
	os.Mkdir(dir, 0o700)
	path := filepath.Join(dir, "out.txt")
	os.WriteFile(path, []byte("hello"), 0o600)
	b := &goBrowser{}
	b.fs.handles = map[string]*goFSHandle{"abc123": {name: "out.txt", path: path, enginePath: "/run/tt/out.txt", size: 5}}
	b.fs.total = 5
	b.fsWritten("abc123")
	if h := b.fs.handles["abc123"]; h.path != "" || h.enginePath != "" || b.fs.total != 0 {
		t.Errorf("still staged: %+v, %d counted", h, b.fs.total)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Errorf("its staging directory kept")
	}
	b.fsWritten("none") // (a handle not kept: nothing)
}
