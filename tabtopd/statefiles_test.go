package main

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

// TestStateFiles: the gateway's own files and folders, the remote
// browser's filter lists among them, and what saving them leaves (by
// either name writeFileAtomic has used) cleaned up, nothing else.
func TestStateFiles(t *testing.T) {
	g, _ := newE2EServer(t)
	conf := filepath.Join(t.TempDir(), "conf")
	os.MkdirAll(conf, 0o700)
	g.goAdBlockFile = filepath.Join(conf, "go-adblock.json")
	g.passkeysFile = filepath.Join(conf, "passkeys.json")
	if files := g.stateFiles(); !slices.Contains(files, filepath.Join(conf, "go-filters")) || !slices.Contains(files, g.passkeysFile) {
		t.Fatalf("state files: %v", files)
	}
	old := time.Now().Add(-time.Hour)
	for _, name := range []string{".tabtop-123", ".shares-456", ".tabtop-upload-x.part", "keep.json"} {
		p := filepath.Join(conf, name)
		os.WriteFile(p, []byte("{}"), 0o600)
		os.Chtimes(p, old, old)
	}
	if n, _ := g.cleanGatewayTemps(false); n != 2 {
		t.Errorf("%d cleaned, want 2", n)
	}
	for name, want := range map[string]bool{".tabtop-123": false, ".shares-456": false, ".tabtop-upload-x.part": true, "keep.json": true} {
		if _, err := os.Stat(filepath.Join(conf, name)); (err == nil) != want {
			t.Errorf("%s: there %v, want %v", name, err == nil, want)
		}
	}
}
