package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestTunnelZipDownload(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	data := extractionArchive(t, "a.txt", "nested/b.txt")
	if err := os.WriteFile(filepath.Join(g.downloadsDir, "book.zip"), data, 0600); err != nil {
		t.Fatal(err)
	}
	ask := func(req tunnelRequest) map[string]any {
		tc := openSession(t, ctx, srv.URL, s)
		defer tc.c.CloseNow()
		return tc.request(t, ctx, req)
	}
	listing := ask(tunnelRequest{Type: "zip-preview", Path: "book.zip"})
	mtime := listing["mtime"].(string)
	size := int64(len(data))

	// One file: streamed as itself, not written beside the ZIP.
	tc := openSession(t, ctx, srv.URL, s)
	reply := tc.request(t, ctx, tunnelRequest{Type: "zip-download", Path: "book.zip", Entries: []int{0}, IfMtime: mtime, IfSize: size})
	if reply["ok"] != true || reply["name"] != "a.txt" || int64(reply["size"].(float64)) != int64(len("content:a.txt")) {
		t.Fatalf("one file meta: %v", reply)
	}
	var payload []byte
	for len(payload) < int(reply["size"].(float64)) {
		kind, p, err := tc.read(ctx)
		if err != nil {
			t.Fatalf("one file ended early: %v", err)
		}
		if kind != msgData {
			t.Fatalf("one file: unexpected %d frame", kind)
		}
		payload = append(payload, p...)
		tc.write(ctx, msgData, nil)
	}
	if string(payload) != "content:a.txt" {
		t.Fatalf("one file payload %q", payload)
	}
	if entries, _ := os.ReadDir(g.downloadsDir); len(entries) != 1 || entries[0].Name() != "book.zip" {
		t.Fatalf("download wrote into Downloads: %v", entries)
	}
	tc.c.CloseNow()

	// Several files: a zip made while it's sent.
	tc = openSession(t, ctx, srv.URL, s)
	reply = tc.request(t, ctx, tunnelRequest{Type: "zip-download", Path: "book.zip", Entries: []int{0, 1}, IfMtime: mtime, IfSize: size})
	if reply["ok"] != true || reply["name"] != "book-selection.zip" {
		t.Fatalf("multi meta: %v", reply)
	}
	var zipBytes []byte
	var end map[string]any
	for {
		kind, p, err := tc.read(ctx)
		if err != nil {
			t.Fatalf("multi ended without done: %v", err)
		}
		if kind == msgText {
			json.Unmarshal(p, &end)
			break
		}
		zipBytes = append(zipBytes, p...)
		tc.write(ctx, msgData, nil)
	}
	zr, err := zip.NewReader(bytes.NewReader(zipBytes), int64(len(zipBytes)))
	if err != nil {
		t.Fatal(err)
	}
	if got := zipContents(t, zr); got != "a.txt=content:a.txt nested/b.txt=content:nested/b.txt" || end["done"] != true {
		t.Fatalf("multi: %v %.200s", end, got)
	}
	if entries, _ := os.ReadDir(g.downloadsDir); len(entries) != 1 || entries[0].Name() != "book.zip" {
		t.Fatalf("multi download wrote into Downloads: %v", entries)
	}
	tc.c.CloseNow()

	for _, req := range []tunnelRequest{
		{Type: "zip-download", Path: "book.zip", Entries: []int{0}, IfMtime: "stale", IfSize: size},
		{Type: "zip-download", Path: "book.zip", Entries: []int{99}, IfMtime: mtime, IfSize: size},
		{Type: "zip-download", Path: "book.zip", Entries: []int{}, IfMtime: mtime, IfSize: size},
	} {
		if res := ask(req); res["error"] == nil {
			t.Errorf("accepted %+v: %v", req, res)
		}
	}
}
