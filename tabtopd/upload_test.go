package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

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

func newUploadServer(t *testing.T) (*server, *httptest.Server, string) {
	t.Helper()
	g := &server{base: "/", downloadsDir: t.TempDir(), sessions: map[string]time.Time{}, secrets: map[string][]byte{},
		failures: map[string][]time.Time{}, pending: map[string]int{}, ttys: map[string]int{}}
	srv := httptest.NewServer(g.handler())
	t.Cleanup(srv.Close)
	return g, srv, cookieName + "=" + g.newSession()
}

func put(t *testing.T, url, cookie string, body []byte, header map[string]string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest("PUT", url, bytes.NewReader(body))
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

func TestPutUpload(t *testing.T) {
	g, srv, sc := newUploadServer(t)
	os.Mkdir(filepath.Join(g.downloadsDir, "sub dir"), 0o755)
	os.WriteFile(filepath.Join(filepath.Dir(g.downloadsDir), "outside"), nil, 0o644)
	os.Symlink(filepath.Dir(g.downloadsDir), filepath.Join(g.downloadsDir, "escape"))
	base := srv.URL + "/downloads/"

	if status, _ := put(t, base+"a.txt", "", []byte("x"), nil); status != http.StatusUnauthorized {
		t.Errorf("without a login: status %d", status)
	}
	if status, _ := put(t, base+"a.txt", sc, []byte("x"), map[string]string{"Sec-Fetch-Site": "cross-site"}); status != http.StatusForbidden {
		t.Errorf("from another site: status %d", status)
	}
	if status, res := put(t, base+"sub%20dir/r%C3%A9sum%C3%A9.pdf", sc, []byte("one"), nil); status != http.StatusCreated || res["name"] != "résumé.pdf" {
		t.Fatalf("upload: %d %v", status, res)
	}
	// A clash never replaces the file.
	for i, want := range []string{"résumé (1).pdf", "résumé (2).pdf"} {
		if status, res := put(t, base+"sub%20dir/r%C3%A9sum%C3%A9.pdf", sc, []byte{'2' + byte(i)}, nil); status != http.StatusCreated || res["name"] != want {
			t.Fatalf("clash %d: %d %v, want %s", i, status, res, want)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(g.downloadsDir, "sub dir", "résumé.pdf")); string(b) != "one" {
		t.Errorf("first upload now holds %q", b)
	}
	if status, res := put(t, base+".bashrc", sc, nil, nil); status != http.StatusCreated || res["name"] != ".bashrc" {
		t.Fatalf("empty dotfile: %d %v", status, res)
	}
	if status, res := put(t, base+".bashrc", sc, nil, nil); res["name"] != ".bashrc (1)" {
		t.Fatalf("dotfile clash: %d %v", status, res)
	}
	for _, p := range []string{"escape/x", "missing/x", "a.txt/x"} {
		if status, res := put(t, base+p, sc, []byte("x"), nil); status != http.StatusNotFound {
			t.Errorf("PUT %s: %d %v", p, status, res)
		}
	}
	if status, _ := put(t, base+uploadTempPrefix+"x.part", sc, []byte("x"), nil); status != http.StatusBadRequest {
		t.Errorf("temporary file's name: status %d", status)
	}
	if status, _ := put(t, base+"sub%20dir/", sc, []byte("x"), nil); status != http.StatusBadRequest {
		t.Errorf("no name: status %d", status)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(g.downloadsDir), "x")); err == nil {
		t.Error("wrote outside Downloads")
	}
	// No temporary files are left behind.
	filepath.Walk(g.downloadsDir, func(p string, info os.FileInfo, err error) error {
		if strings.HasPrefix(filepath.Base(p), uploadTempPrefix) {
			t.Errorf("left %s", p)
		}
		return nil
	})
}

func TestPutUploadAborted(t *testing.T) {
	g, srv, sc := newUploadServer(t)
	// Fewer bytes than the Content-Length, then the connection closes.
	pr, pw := io.Pipe()
	req, _ := http.NewRequest("PUT", srv.URL+"/downloads/cut.bin", pr)
	req.ContentLength = 1000
	req.Header.Set("Cookie", sc)
	go func() {
		pw.Write([]byte("partial"))
		pw.CloseWithError(io.ErrUnexpectedEOF)
	}()
	if resp, err := http.DefaultClient.Do(req); err == nil {
		resp.Body.Close()
	}
	time.Sleep(100 * time.Millisecond)
	entries, _ := os.ReadDir(g.downloadsDir)
	if len(entries) != 0 {
		t.Errorf("an aborted upload left %v", entries)
	}
}

func TestListingHidesUploadsInProgress(t *testing.T) {
	g, srv, sc := newUploadServer(t)
	os.WriteFile(filepath.Join(g.downloadsDir, uploadTempPrefix+"abc.part"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(g.downloadsDir, "done.txt"), []byte("x"), 0o644)
	req, _ := http.NewRequest("GET", srv.URL+"/downloads/", nil)
	req.Header.Set("Cookie", sc)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "done.txt") || strings.Contains(string(body), uploadTempPrefix) {
		t.Errorf("listing:\n%s", body)
	}
	if csp := resp.Header.Get("Content-Security-Policy"); !strings.Contains(csp, "script-src 'self'") ||
		!strings.Contains(string(body), `src="/tabtop/upload.js"`) {
		t.Errorf("listing doesn't load upload.js: CSP %q", csp)
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

	// More than the size given ends the tunnel, and nothing is saved.
	tc = openSession(t, ctx, srv.URL, s)
	tc.request(t, ctx, tunnelRequest{Type: "upload", Name: "short.bin", Size: 3})
	tc.write(ctx, msgData, []byte("toolong"))
	if _, _, err := tc.read(ctx); websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Errorf("too much data: %v", err)
	}
	// So does leaving early.
	tc = openSession(t, ctx, srv.URL, s)
	tc.request(t, ctx, tunnelRequest{Type: "upload", Name: "left.bin", Size: 10})
	tc.write(ctx, msgData, []byte("abc"))
	tc.read(ctx)
	tc.c.CloseNow()
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
