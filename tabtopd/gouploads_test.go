package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestGoUploadName: a file's name as a page's file has it.
func TestGoUploadName(t *testing.T) {
	for in, want := range map[string]string{
		"report.pdf":             "report.pdf",
		"../../etc/passwd":       "passwd",
		`C:\Users\me\photo.jpg`:  "photo.jpg",
		"a\x00b\nc.txt":          "abc.txt",
		"..":                     "",
		".":                      "",
		"":                       "",
		"  spaced.txt ":          "spaced.txt",
		"dir/":                   "dir",
		strings.Repeat("é", 300): strings.Repeat("é", 100),
	} {
		if got := goUploadName(in); got != want {
			t.Errorf("goUploadName(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestGoUploads: files are taken only for the chooser waiting, by its
// token; kept in a directory each, under their names; bounded in count,
// size and all a tab's; given to the page only when all are there; and
// removed when it's cancelled or another chooser comes.
func TestGoUploads(t *testing.T) {
	dir := t.TempDir()
	newChooser := func(multiple bool) *goChooser {
		return &goChooser{token: goToken(), gen: 1, backend: 7, multiple: multiple, dir: filepath.Join(dir, "uploads"), engine: "/run/tt/uploads", opened: time.Now()}
	}
	var u goUploads
	write := func(c *goChooser, name, text string) (*goUpload, error) {
		f, w, err := u.begin(c.token, name, int64(len(text)))
		if err != nil {
			return nil, err
		}
		w.WriteString(text)
		w.Close()
		u.finish(f, true)
		return f, nil
	}

	// None waiting: refused.
	if _, _, err := u.begin("nope", "a.txt", 1); err != errUploadChooser {
		t.Fatalf("with no chooser: %v", err)
	}
	c := newChooser(true)
	u.open(c)
	if _, _, err := u.begin("another token", "a.txt", 1); err != errUploadChooser {
		t.Errorf("another chooser's token: %v", err)
	}
	if _, _, err := u.begin(c.token, "..", 1); err == nil {
		t.Errorf("a name of nothing was taken")
	}
	if _, _, err := u.begin(c.token, "big.bin", goUploadFileMax+1); err == nil {
		t.Errorf("a file past the most was taken")
	}
	a, err := write(c, "../a.txt", "first")
	if err != nil {
		t.Fatal(err)
	}
	b, err := write(c, "a.txt", "second") // the same name: a directory of its own
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(a.path) != "a.txt" || filepath.Base(b.path) != "a.txt" || a.path == b.path {
		t.Errorf("kept as %s and %s", a.path, b.path)
	}
	if got, _ := os.ReadFile(b.path); string(got) != "second" {
		t.Errorf("the second holds %q", got)
	}
	if !strings.HasPrefix(a.engine, "/run/tt/uploads/") || !strings.HasSuffix(a.engine, "/a.txt") {
		t.Errorf("the engine's path: %s", a.engine)
	}
	// Fewer than sent: not given, and let go.
	if _, _, _, ok := u.take(c.token, 1); ok {
		t.Errorf("taken with a file missing")
	}
	if _, err := os.Stat(a.path); !os.IsNotExist(err) || u.total != 0 {
		t.Errorf("a chooser let go kept its files (total %d)", u.total)
	}

	// All there: given, and kept.
	c = newChooser(true)
	u.open(c)
	a, _ = write(c, "x.txt", "xx")
	b, _ = write(c, "y.txt", "yyy")
	paths, backend, gen, ok := u.take(c.token, 2)
	if !ok || backend != 7 || gen != 1 || len(paths) != 2 || paths[0] != a.engine || paths[1] != b.engine {
		t.Fatalf("taken: %v %d %d %v", paths, backend, gen, ok)
	}
	if _, _, _, ok := u.take(c.token, 2); ok {
		t.Errorf("taken twice")
	}
	if _, err := os.Stat(a.path); err != nil || u.total != 5 {
		t.Errorf("given files weren't kept: %v (total %d)", err, u.total)
	}

	// One only, if it's not multiple; another chooser drops what it had.
	c = newChooser(false)
	u.open(c)
	one, _ := write(c, "one.txt", "1")
	if _, _, err := u.begin(c.token, "two.txt", 1); err != errUploadMany {
		t.Errorf("a second file for a single chooser: %v", err)
	}
	u.open(newChooser(true))
	if _, err := os.Stat(one.path); !os.IsNotExist(err) || u.total != 5 {
		t.Errorf("a chooser replaced kept its files (total %d)", u.total)
	}
	// An upload still going as its chooser's dropped isn't counted twice.
	c = newChooser(true)
	u.open(c)
	f, w, err := u.begin(c.token, "going.txt", 3)
	if err != nil {
		t.Fatal(err)
	}
	u.open(newChooser(true))
	w.Close()
	u.finish(f, false)
	if u.total != 5 {
		t.Errorf("total %d after a dropped upload failed", u.total)
	}

	// All a tab's: bounded.
	u.total = goUploadTabMax - 1
	c = newChooser(true)
	u.open(c)
	if _, _, err := u.begin(c.token, "more.txt", 2); err == nil {
		t.Errorf("taken past the tab's most")
	}
	// A chooser waited for too long.
	c.opened = time.Now().Add(-goChooserFor - time.Second)
	if _, _, err := u.begin(c.token, "late.txt", 0); err != errUploadChooser {
		t.Errorf("an old chooser: %v", err)
	}
}
