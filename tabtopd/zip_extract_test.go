package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func extractionArchive(t *testing.T, names ...string) []byte {
	t.Helper()
	var b bytes.Buffer
	w := zip.NewWriter(&b)
	for _, name := range names {
		f, err := w.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Store})
		if err != nil {
			t.Fatal(err)
		}
		io.WriteString(f, "content:"+name)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}
func extractionItem(t *testing.T, data []byte) *downloadItem {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "book.zip"), data, 0600); err != nil {
		t.Fatal(err)
	}
	item, err := openDownloadsFile(dir, "book.zip")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { item.Close() })
	return item
}
func TestZipExtractSelectionAndCollisions(t *testing.T) {
	item := extractionItem(t, extractionArchive(t, "nested/a.txt", "b.txt", "not-picked.txt"))
	for i, want := range []string{"book", "book (1)"} {
		dest, err := extractZipFiles(context.Background(), item, []int{0, 1})
		if err != nil || dest != want {
			t.Fatalf("run %d: %q, %v", i, dest, err)
		}
		got, err := item.store.root.ReadFile(dest + "/nested/a.txt")
		if err != nil || string(got) != "content:nested/a.txt" {
			t.Fatalf("payload %q, %v", got, err)
		}
		if _, err = item.store.root.Stat(dest + "/not-picked.txt"); !os.IsNotExist(err) {
			t.Fatalf("unselected entry: %v", err)
		}
	}
}
func TestZipExtractRejectsUnsafeEntries(t *testing.T) {
	for _, name := range []string{"../escape", "/absolute", "a/../../escape", "a\\b", "a/./b", ".tabtop-upload-evil", "a/\x00b"} {
		t.Run(name, func(t *testing.T) {
			item := extractionItem(t, extractionArchive(t, name))
			if _, err := extractZipFiles(context.Background(), item, []int{0}); err == nil {
				t.Fatal("unsafe entry accepted")
			}
		})
	}
	for _, kind := range []string{"encrypted", "symlink", "too-large", "bad-crc", "duplicate", "conflict", "bad-index", "cancelled"} {
		t.Run(kind, func(t *testing.T) {
			data := extractionArchive(t, "a", "a/b")
			central := bytes.Index(data, []byte("PK\x01\x02"))
			switch kind {
			case "encrypted":
				binary.LittleEndian.PutUint16(data[central+8:], 1)
			case "symlink":
				data[central+5] = 3
				binary.LittleEndian.PutUint32(data[central+38:], uint32(0120777)<<16)
			case "too-large":
				binary.LittleEndian.PutUint32(data[central+24:], maxZipExtractBytes+1)
			case "bad-crc":
				data[31] ^= 1
			}
			item := extractionItem(t, data)
			ids := []int{0}
			ctx := context.Background()
			switch kind {
			case "duplicate":
				ids = []int{0, 0}
			case "conflict":
				ids = []int{0, 1}
			case "bad-index":
				ids = []int{2}
			case "cancelled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			}
			if _, err := extractZipFiles(ctx, item, ids); err == nil {
				t.Fatal("invalid extraction accepted")
			}
			entries, err := item.store.root.Open(".")
			if err != nil {
				t.Fatal(err)
			}
			defer entries.Close()
			names, _ := entries.Readdirnames(-1)
			if len(names) != 1 || names[0] != "book.zip" {
				t.Fatalf("failed extraction left files: %v", names)
			}
		})
	}
}
func TestTunnelZipExtract(t *testing.T) {
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
	req := tunnelRequest{Type: "zip-extract", Path: "book.zip", Entries: []int{1}, IfMtime: listing["mtime"].(string), IfSize: int64(len(data))}
	reply := ask(req)
	if reply["ok"] != true || reply["path"] != "book" {
		t.Fatalf("extract: %v", reply)
	}
	got, err := os.ReadFile(filepath.Join(g.downloadsDir, "book/nested/b.txt"))
	if err != nil || string(got) != "content:nested/b.txt" {
		t.Fatalf("payload %q: %v", got, err)
	}
	req.IfMtime = "stale"
	if reply = ask(req); reply["error"] == nil || !strings.Contains(reply["error"].(string), "changed") {
		t.Fatalf("stale: %v", reply)
	}
}

func TestZipExtractDirectorySyncFailures(t *testing.T) {
	for _, failAt := range []string{"", "nested/deep", ".", "published-parent"} {
		t.Run(failAt, func(t *testing.T) {
			item := extractionItem(t, extractionArchive(t, "nested/deep/a.txt", "top.txt"))
			var calls []string
			syncFailure := fmt.Errorf("injected sync failure")
			dest, err := extractZipFilesWithSync(context.Background(), item, []int{0, 1}, func(root *os.Root, dir string) error {
				label := dir
				if root == item.store.root {
					label = "published-parent"
				}
				calls = append(calls, label)
				if label == failAt {
					return syncFailure
				}
				return syncDir(root, dir)
			})
			if failAt == "" {
				if err != nil || dest != "book" {
					t.Fatalf("success: %q, %v", dest, err)
				}
				if !reflect.DeepEqual(calls, []string{"nested/deep", "nested", ".", "published-parent"}) {
					t.Fatalf("sync order: %v", calls)
				}
			} else {
				if !errors.Is(err, syncFailure) {
					t.Fatalf("sync failure lost: %v", err)
				}
				if failAt == "published-parent" {
					if dest != "book" {
						t.Fatalf("published destination lost: %q", dest)
					}
					if _, err := item.store.root.Stat("book/nested/deep/a.txt"); err != nil {
						t.Fatal(err)
					}
				} else {
					if dest != "" {
						t.Fatalf("premature publication: %q", dest)
					}
					entries, _ := os.ReadDir(item.store.root.Name())
					if len(entries) != 1 || entries[0].Name() != "book.zip" {
						t.Fatalf("failed staging not removed: %v", entries)
					}
				}
			}
		})
	}
}
