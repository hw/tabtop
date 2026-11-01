package main

import (
	"path/filepath"
	"testing"
)

func TestTunnelRename(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	dir := g.downloadsDir
	deleteFixture(t, dir)
	s := login(t, ctx, srv.URL, code(0))
	rename := func(p, name string) map[string]any {
		return openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "rename", Path: p, Name: name})
	}

	if reply := rename("sub dir/é.txt", "renamed.txt"); reply["ok"] != true || !exists(filepath.Join(dir, "sub dir", "renamed.txt")) {
		t.Errorf("file: %v", reply)
	}
	if reply := rename("sub dir", "folder"); reply["ok"] != true || !exists(filepath.Join(dir, "folder", "renamed.txt")) {
		t.Errorf("folder: %v", reply)
	}
	// Never over something there.
	if reply := rename("target", "folder"); reply["error"] != "That name is taken." || !exists(filepath.Join(dir, "target")) {
		t.Errorf("onto a folder: %v", reply)
	}
	if reply := rename("link", "target"); reply["error"] != "That name is taken." {
		t.Errorf("onto a file: %v", reply)
	}
	// A symlink is renamed itself.
	if reply := rename("link", "link2"); reply["ok"] != true || !exists(filepath.Join(dir, "link2")) || !exists(filepath.Join(dir, "target")) {
		t.Errorf("symlink: %v", reply)
	}
	for _, c := range [][2]string{{"target", "../out"}, {"target", "a/b"}, {"target", ""}, {"target", ".."},
		{"target", uploadTempPrefix + "x"}, {"", "x"}, {"escape", "x"}, {"../outside", "x"}, {"missing", "x"},
		{uploadTempPrefix + "1.part", "x"}} {
		if reply := rename(c[0], c[1]); reply["error"] == nil {
			t.Errorf("rename %q to %q: %v", c[0], c[1], reply)
		}
	}
	for _, p := range []string{"target", "escape", uploadTempPrefix + "1.part", "../outside"} {
		if !exists(filepath.Join(dir, p)) {
			t.Errorf("%s is gone", p)
		}
	}
	if exists(filepath.Join(filepath.Dir(dir), "out")) {
		t.Error("renamed out of Downloads")
	}
}
