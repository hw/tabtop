package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func del(t *testing.T, url, cookie string, header map[string]string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest("DELETE", url, nil)
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	for k, v := range header {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var res map[string]any
	json.NewDecoder(resp.Body).Decode(&res)
	return resp.StatusCode, res
}

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

func TestWebDelete(t *testing.T) {
	g, srv, sc := newUploadServer(t)
	dir := g.downloadsDir
	deleteFixture(t, dir)
	base := srv.URL + "/downloads/"

	if status, _ := del(t, base+"target", "", nil); status != http.StatusUnauthorized || !exists(filepath.Join(dir, "target")) {
		t.Errorf("without a login: status %d", status)
	}
	if status, _ := del(t, base+"target", sc, map[string]string{"Sec-Fetch-Site": "cross-site"}); status != http.StatusForbidden ||
		!exists(filepath.Join(dir, "target")) {
		t.Errorf("from another site: status %d", status)
	}
	if status, res := del(t, base+"sub%20dir/%C3%A9.txt", sc, nil); status != http.StatusOK || exists(filepath.Join(dir, "sub dir", "é.txt")) {
		t.Errorf("delete: %d %v", status, res)
	}
	if status, _ := del(t, base+"sub%20dir/%C3%A9.txt", sc, nil); status != http.StatusNotFound {
		t.Errorf("deleting again: status %d", status)
	}
	// A symlink goes, not what it leads to.
	if status, res := del(t, base+"link", sc, nil); status != http.StatusOK || exists(filepath.Join(dir, "link")) ||
		!exists(filepath.Join(dir, "target")) {
		t.Errorf("symlink: %d %v", status, res)
	}
	for p, want := range map[string]int{
		"sub%20dir":                 http.StatusConflict,
		"sub%20dir/":                http.StatusConflict,
		"dirlink":                   http.StatusConflict,
		"":                          http.StatusConflict,
		"escape":                    http.StatusNotFound,
		"..%2Foutside":              http.StatusNotFound,
		uploadTempPrefix + "1.part": http.StatusNotFound,
	} {
		if status, res := del(t, base+p, sc, nil); status != want {
			t.Errorf("DELETE %q: %d %v, want %d", p, status, res, want)
		}
	}
	for _, p := range []string{"sub dir", "dirlink", "escape", "target", uploadTempPrefix + "1.part", "../outside"} {
		if !exists(filepath.Join(dir, p)) {
			t.Errorf("%s is gone", p)
		}
	}
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
