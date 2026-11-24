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

// TestGoFSWrites: a save destination's pieces go to the person's browser
// many at once (not the one ask at a time), each answered by its own; an
// opened file's handle isn't written, nor one of another page's.
func TestGoFSWrites(t *testing.T) {
	b, w := goClipTab()
	b.docURL = "https://www.example.com/page"
	b.viewerCaps = goViewerCaps{FileSystem: true}
	b.rememberFSHandles("fs-open", `{"files":[{"handle":"open1","name":"a.txt","size":1}]}`, 1, 1)
	b.rememberFSHandles("fs-save", `{"handle":"save1","name":"out.txt","size":0}`, 1, 1)
	b.rememberFSHandles("fs-save", `{"handle":"old1","name":"old.txt","size":0}`, 0, 1)
	piece := func(id, handle string) goDeviceAsk {
		return goDeviceAsk{ID: id, Kind: "fs-write", FS: &goFSRequest{Handle: handle, Value: "aGVsbG8="}}
	}
	// An opened file's, or an earlier page's: refused, not sent.
	b.devices(1, []goDeviceAsk{piece("x1", "open1"), piece("x2", "old1"), {ID: "x3", Kind: "fs-begin", FS: &goFSRequest{Handle: "open1"}}})
	if len(goSentOf(w, "go-device")) != 0 || b.acts.waiting() != 3 || b.device != nil {
		t.Fatalf("a read-only or stale handle written: %d sent, %d refused", len(goSentOf(w, "go-device")), b.acts.waiting())
	}
	// Twenty pieces: sixteen a read taken, all sent at once, the ask slot
	// left free.
	var asks []goDeviceAsk
	for i := range 20 {
		asks = append(asks, piece("p"+string(rune('a'+i)), "save1"))
	}
	b.devices(1, asks)
	sent := goSentOf(w, "go-device")
	if len(sent) != 16 || b.device != nil || len(b.fs.writes) != 16 {
		t.Fatalf("%d sent, %d waiting, ask slot %v", len(sent), len(b.fs.writes), b.device)
	}
	// A location ask alongside them still asks.
	b.viewerCaps.Location = true
	b.devices(1, []goDeviceAsk{{ID: "loc", Kind: "location"}})
	if b.device == nil || b.device.kind != "location" {
		t.Fatalf("an ask held up by the pieces")
	}
	// Answered each by its own: written, or the browser's error.
	before := b.acts.waiting()
	b.deviceAnswer(goClientMsg{Gen: 1, Text: sent[0]["ask"].(string), Accept: true})
	b.deviceAnswer(goClientMsg{Gen: 1, Text: sent[1]["ask"].(string), Value: "QuotaExceededError"})
	b.deviceAnswer(goClientMsg{Gen: 1, Text: sent[1]["ask"].(string), Accept: true}) // (answered already)
	if b.acts.waiting() != before+2 || len(b.fs.writes) != 14 || b.device == nil {
		t.Errorf("%d answered, %d waiting, the location ask %v", b.acts.waiting()-before, len(b.fs.writes), b.device)
	}
	// So many waiting at most; the page left, none.
	for i := range goFSWritesMax {
		b.devices(1, []goDeviceAsk{piece("q"+string(rune('a'+i%26))+string(rune('a'+i/26)), "save1")})
	}
	if len(b.fs.writes) != goFSWritesMax {
		t.Errorf("%d waiting", len(b.fs.writes))
	}
	b.resetFileSystem()
	if len(b.fs.writes) != 0 || b.fsWritable("save1", 1, 1) {
		t.Errorf("kept as the page's left")
	}
}
