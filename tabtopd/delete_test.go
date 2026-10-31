package main

import (
	"os"
	"path/filepath"
	"testing"
)

// deleteFixture fills Downloads with a file, a folder, symlinks to a file
// inside and one outside, and an upload in progress.
func deleteFixture(t *testing.T, dir string) {
	t.Helper()
	os.Mkdir(filepath.Join(dir, "sub dir"), 0o755)
	os.WriteFile(filepath.Join(dir, "sub dir", "é.txt"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(dir, "target"), []byte("x"), 0o644)
	os.Symlink("target", filepath.Join(dir, "link"))
	os.Symlink("sub dir", filepath.Join(dir, "dirlink"))
	os.WriteFile(filepath.Join(filepath.Dir(dir), "outside"), []byte("x"), 0o644)
	os.Symlink(filepath.Join(filepath.Dir(dir), "outside"), filepath.Join(dir, "escape"))
	os.WriteFile(filepath.Join(dir, uploadTempPrefix+"1.part"), []byte("x"), 0o644)
}

func exists(p string) bool {
	_, err := os.Lstat(p)
	return err == nil
}

func TestTunnelDelete(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	dir := g.downloadsDir
	deleteFixture(t, dir)
	s := login(t, ctx, srv.URL, code(0))

	if reply := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "delete", Path: "sub dir/é.txt"}); reply["ok"] != true ||
		exists(filepath.Join(dir, "sub dir", "é.txt")) {
		t.Errorf("delete: %v", reply)
	}
	// A symlink goes, not what it leads to.
	if reply := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "delete", Path: "link"}); reply["ok"] != true ||
		exists(filepath.Join(dir, "link")) || !exists(filepath.Join(dir, "target")) {
		t.Errorf("symlink: %v", reply)
	}
	for _, p := range []string{"sub dir/é.txt", "sub dir", "dirlink", "", "escape", "../outside", uploadTempPrefix + "1.part"} {
		if reply := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "delete", Path: p}); reply["error"] == nil {
			t.Errorf("delete %q: %v", p, reply)
		}
	}
	for _, p := range []string{"sub dir", "dirlink", "escape", "target", uploadTempPrefix + "1.part", "../outside"} {
		if !exists(filepath.Join(dir, p)) {
			t.Errorf("%s is gone", p)
		}
	}
}
