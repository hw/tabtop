package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Cleaning up deletes uploads kept to carry on and old temporary files,
// counting them first if asked; never one in use, or changed lately.
func TestCleanup(t *testing.T) {
	g, srv, s, _ := newShareServer(t)
	dir := g.downloadsDir
	os.MkdirAll(filepath.Join(dir, "sub"), 0o755)
	old := time.Now().Add(-time.Hour)
	temp := func(p string, size int, when time.Time) string {
		f := filepath.Join(dir, p)
		os.WriteFile(f, make([]byte, size), 0o644)
		os.Chtimes(f, when, when)
		return f
	}
	stale := temp("sub/"+uploadTempPrefix+"0123456789abcdef.part", 100, old)
	fresh := temp(uploadTempPrefix+"fedcba9876543210.part", 10, time.Now())
	notOurs := temp(".tabtop-upload-notours.part", 10, old)
	stage := filepath.Join(dir, uploadTempPrefix+"0123456789abcdef0123456789abcdef.stage")
	os.Mkdir(stage, 0o700)
	os.Chtimes(stage, old, old)
	g.sharesFile = filepath.Join(t.TempDir(), "conf", "shares.json")
	os.MkdirAll(filepath.Dir(g.sharesFile), 0o700)
	leftover := filepath.Join(filepath.Dir(g.sharesFile), ".shares-12345")
	os.WriteFile(leftover, []byte("{}"), 0o600)
	os.Chtimes(leftover, old, old)
	// An upload through a link, in pieces, not being sent.
	url := makeUploadLink(t, srv, s, "", 0, 1000) + "a.bin"
	if res, _ := piece(t, url, "abcdefghijklmnop", 0, 100, make([]byte, 40)); res.StatusCode != 204 {
		t.Fatal("piece")
	}

	req := func(dry bool) map[string]any {
		r := openSession(t, testCtx(t), srv, s).request(t, testCtx(t), tunnelRequest{Type: "cleanup", DryRun: dry})
		return r["cleanup"].(map[string]any)
	}
	// Its piece just sent, it's between pieces, still going: left.
	if c := req(true); c["kept"] != float64(0) {
		t.Errorf("one with a piece just now: %v", c)
	}
	// A while since its last piece: left behind.
	g.shares.partials.mu.Lock()
	for _, p := range g.shares.partials.m {
		p.last = p.last.Add(-cleanupIdle)
	}
	g.shares.partials.mu.Unlock()
	// Counted, nothing deleted.
	if c := req(true); c["kept"] != float64(1) || c["temps"] != float64(3) || c["bytes"] != float64(40+100+2) {
		t.Errorf("dry run: %v", c)
	}
	if _, err := os.Stat(stale); err != nil {
		t.Fatal("a dry run deleted something")
	}
	if c := req(false); c["kept"] != float64(1) || c["temps"] != float64(3) {
		t.Errorf("cleanup: %v", c)
	}
	for _, f := range []string{stale, stage, leftover} {
		if _, err := os.Stat(f); err == nil {
			t.Errorf("%s is still there", f)
		}
	}
	for _, f := range []string{fresh, notOurs} {
		if _, err := os.Stat(f); err != nil {
			t.Errorf("%s was deleted", f)
		}
	}
	if left, _ := filepath.Glob(filepath.Join(dir, uploadTempPrefix+"*.part")); len(left) != 2 {
		t.Errorf("left %v", left)
	}
	// The link's place freed, the activity logged.
	if l := g.shares.list("")[0]; l.Count != 0 {
		t.Errorf("link: %+v", l)
	}
	if got, _ := g.activity.list(1); got[0].Kind != "cleanup" {
		t.Errorf("activity: %+v", got[0])
	}
	if c := req(true); c["kept"] != float64(0) || c["temps"] != float64(0) {
		t.Errorf("again: %v", c)
	}
}
