package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func runSearch(t *testing.T, url string, s testSession, req tunnelRequest) (found []map[string]any, end map[string]any) {
	t.Helper()
	ctx := testCtx(t)
	req.Type = "search"
	if req.Root == "" {
		req.Root = "data"
	}
	tc := openSession(t, ctx, url, s)
	first := tc.request(t, ctx, req)
	if first["ok"] != true {
		return nil, first
	}
	for {
		m := tc.readJSON(t, ctx)
		batch, ok := m["found"].([]any)
		if !ok {
			return found, m
		}
		for _, f := range batch {
			found = append(found, f.(map[string]any))
		}
	}
}

func TestSearchInFiles(t *testing.T) {
	_, url, s, _, data, _ := newTransferServer(t)
	write(t, filepath.Join(data, "notes", "a.txt"), "first line\nthe Needle is here\nlast")
	write(t, filepath.Join(data, "notes", "deep", "b.md"), "no\nno\nneedle again, "+strings.Repeat("x", 300))
	write(t, filepath.Join(data, "notes", "bin.dat"), "needle\x00binary")
	write(t, filepath.Join(data, "notes", uploadTempPrefix+"0.part"), "needle unfinished")
	write(t, filepath.Join(data, trashDir, "0123456789abcdef0123456789abcdef", "data"), "needle in Trash")
	os.Symlink("/etc", filepath.Join(data, "notes", "out"))
	write(t, filepath.Join(data, "elsewhere.txt"), "needle outside the folder")

	found, end := runSearch(t, url, s, tunnelRequest{Path: "notes", Query: "needle"})
	if end["matches"] != float64(2) || len(found) != 2 || end["stopped"] != "" {
		t.Fatalf("found %v, then %v", found, end)
	}
	byPath := map[any]map[string]any{}
	for _, f := range found {
		byPath[f["path"]] = f
	}
	a := byPath["notes/a.txt"]
	if a == nil || a["line"] != float64(2) || a["before"] != "the " || a["match"] != "Needle" || a["after"] != " is here" {
		t.Fatalf("a.txt: %v", a)
	}
	if b := byPath["notes/deep/b.md"]; b == nil || b["line"] != float64(3) || !strings.HasSuffix(b["after"].(string), "…") {
		t.Fatalf("b.md: %v", b)
	}
	// Case, when asked; a regular expression; and Trash, everywhere, not.
	if found, _ := runSearch(t, url, s, tunnelRequest{Path: "notes", Query: "needle", MatchCase: true}); len(found) != 1 {
		t.Fatalf("matching case: %v", found)
	}
	if found, _ := runSearch(t, url, s, tunnelRequest{Path: "", Query: `ne+dle (is|again|outside)`, Regex: true}); len(found) != 3 {
		t.Fatalf("regex from the top: %v", found)
	}
	for _, req := range []tunnelRequest{{Query: ""}, {Query: "a*", Regex: true}, {Query: "(", Regex: true}, {Path: trashDir, Query: "needle"}} {
		if _, end := runSearch(t, url, s, req); end["error"] == nil {
			t.Fatalf("%+v: %v", req, end)
		}
	}
}

// What's shown around a match is the line's text, even where it isn't
// valid UTF-8 before it.
func TestSearchInvalidText(t *testing.T) {
	_, url, s, _, data, _ := newTransferServer(t)
	write(t, filepath.Join(data, "odd.txt"), "ab\xff\xfecd needle ef")
	found, _ := runSearch(t, url, s, tunnelRequest{Query: "needle"})
	if len(found) != 1 || found[0]["match"] != "needle" || found[0]["before"] != "ab�cd " || found[0]["after"] != " ef" {
		t.Fatalf("found %v", found)
	}
}

// A folder that can't be opened is passed over, and counted.
func TestSearchPassesUnreadableFolders(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root opens every folder")
	}
	_, url, s, _, data, _ := newTransferServer(t)
	write(t, filepath.Join(data, "notes", "a.txt"), "needle")
	write(t, filepath.Join(data, "notes", "shut", "b.txt"), "needle")
	os.Chmod(filepath.Join(data, "notes", "shut"), 0)
	t.Cleanup(func() { os.Chmod(filepath.Join(data, "notes", "shut"), 0o755) })
	found, end := runSearch(t, url, s, tunnelRequest{Path: "notes", Query: "needle"})
	if len(found) != 1 || end["unreadable"] != float64(1) || end["error"] != nil {
		t.Fatalf("found %v, then %v", found, end)
	}
}

// A folder of the user's, named as Trash is but for case, on a filesystem
// that tells them apart, is looked in, as it's listed.
func TestSearchLooksInTrashLikeNames(t *testing.T) {
	_, url, s, _, data, _ := newTransferServer(t)
	write(t, filepath.Join(data, ".TabTop-Trash", "a.txt"), "needle")
	write(t, filepath.Join(data, trashDir, "0123456789abcdef0123456789abcdef", "data"), "needle in Trash")
	if found, _ := runSearch(t, url, s, tunnelRequest{Query: "needle"}); len(found) != 1 {
		t.Fatalf("found %v", found)
	}
}

// Searched through a link to a folder, what's found is shown under the
// link, where the page is.
func TestSearchThroughLink(t *testing.T) {
	_, url, s, _, data, _ := newTransferServer(t)
	write(t, filepath.Join(data, "work", "proj", "a.txt"), "needle")
	os.Symlink("work/proj", filepath.Join(data, "proj"))
	found, end := runSearch(t, url, s, tunnelRequest{Path: "proj", Query: "needle"})
	if len(found) != 1 || found[0]["path"] != "proj/a.txt" {
		t.Fatalf("found %v, then %v", found, end)
	}
}
