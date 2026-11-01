package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// fetchZip makes a zip request and returns the zip, its name, and the
// final message.
func fetchZip(t *testing.T, tc *tunnelClient, req tunnelRequest) (*zip.Reader, string, map[string]any) {
	t.Helper()
	ctx := testCtx(t)
	req.Type = "zip"
	reply := tc.request(t, ctx, req)
	if reply["ok"] != true {
		t.Fatalf("zip %+v: %v", req, reply)
	}
	var data []byte
	for {
		kind, p, err := tc.read(ctx)
		if err != nil {
			t.Fatalf("zip ended without done: %v", err)
		}
		if kind == msgText {
			var end map[string]any
			json.Unmarshal(p, &end)
			zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
			if err != nil {
				t.Fatal(err)
			}
			return zr, reply["name"].(string), end
		}
		data = append(data, p...)
		tc.write(ctx, msgData, nil)
	}
}

func zipContents(t *testing.T, zr *zip.Reader) string {
	t.Helper()
	var out []string
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(rc)
		rc.Close()
		out = append(out, f.Name+"="+string(b))
	}
	sort.Strings(out)
	return strings.Join(out, " ")
}

func TestTunnelZip(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	dir := g.downloadsDir
	os.MkdirAll(filepath.Join(dir, "photos", "trip", "empty"), 0o755)
	os.WriteFile(filepath.Join(dir, "photos", "a.jpg"), []byte("jpeg"), 0o644)
	os.WriteFile(filepath.Join(dir, "photos", "trip", "notes.txt"), bytes.Repeat([]byte("n"), 3*fileChunk), 0o644)
	os.WriteFile(filepath.Join(dir, "photos", uploadTempPrefix+"0123456789abcdef.part"), []byte("partial"), 0o644)
	os.WriteFile(filepath.Join(dir, "top.txt"), []byte("top"), 0o644)
	os.Symlink("../top.txt", filepath.Join(dir, "photos", "link.txt")) // to a file inside: followed
	os.Symlink("..", filepath.Join(dir, "photos", "loop"))             // to a folder: left out
	os.WriteFile(filepath.Join(filepath.Dir(dir), "secret"), []byte("s"), 0o644)
	os.Symlink(filepath.Join(filepath.Dir(dir), "secret"), filepath.Join(dir, "photos", "escape")) // outside: left out
	s := login(t, ctx, srv.URL, code(0))

	zr, name, end := fetchZip(t, openSession(t, ctx, srv.URL, s), tunnelRequest{Names: []string{"photos"}})
	want := "photos/= photos/a.jpg=jpeg photos/link.txt=top photos/trip/= photos/trip/empty/= photos/trip/notes.txt=" + strings.Repeat("n", 3*fileChunk)
	if got := zipContents(t, zr); name != "photos.zip" || got != want || end["done"] != true {
		t.Errorf("photos: %s, %v, %.200s", name, end, got)
	}
	for _, f := range zr.File {
		if f.Name == "photos/a.jpg" && f.Method != zip.Store {
			t.Errorf("a.jpg compressed again")
		}
	}

	zr, name, _ = fetchZip(t, openSession(t, ctx, srv.URL, s), tunnelRequest{Path: "photos", Names: []string{"a.jpg", "trip"}})
	if got := zipContents(t, zr); name != "photos.zip" || !strings.HasPrefix(got, "a.jpg=jpeg trip/= trip/empty/= trip/notes.txt=") {
		t.Errorf("two in photos: %s, %.100s", name, got)
	}
	if _, name, _ = fetchZip(t, openSession(t, ctx, srv.URL, s), tunnelRequest{Names: []string{"top.txt", "photos"}}); name != "Downloads.zip" {
		t.Errorf("two at the top: %s", name)
	}

	for _, req := range []tunnelRequest{{}, {Names: []string{".."}}, {Names: []string{"a/b"}}, {Path: "../", Names: []string{"x"}},
		{Path: "top.txt", Names: []string{"x"}}, {Names: []string{"top.txt", "top.txt"}}} {
		req.Type = "zip"
		if reply := openSession(t, ctx, srv.URL, s).request(t, ctx, req); reply["error"] == nil {
			t.Errorf("zip %+v: %v", req, reply)
		}
	}
}
