package main

import (
	"fmt"
	"os"
	"path"
	"slices"
	"strings"
	"testing"
	"time"
)

// defaultRoot is the root requests naming none are served from, for tests
// that reach into its state.
func (g *server) defaultRoot() *fileRoot {
	root, err := g.rootByID("")
	if err != nil {
		panic(err)
	}
	return root
}

// Path-based openers, for tests only: the gateway opens a root through
// its fileService, which checks the root is still the one configured.
func openDownloadStore(dir string) (*downloadStore, error) {
	root, err := openDirectoryRoot(dir)
	if err != nil {
		return nil, err
	}
	return &downloadStore{root: root}, nil
}
func openDownloadsItem(dir, name string) (*downloadItem, error) {
	store, err := openDownloadStore(dir)
	if err != nil {
		return nil, errDownloadsMissing
	}
	name = path.Clean(strings.Trim(name, "/"))
	f, st, err := store.open(name)
	if err != nil {
		store.Close()
		return nil, errDownloadMissing
	}
	return &downloadItem{store: store, file: f, info: st, name: name}, nil
}
func openDownloadsFile(dir, name string) (*downloadItem, error) {
	item, err := openDownloadsItem(dir, name)
	if err != nil {
		return nil, err
	}
	if !item.info.Mode().IsRegular() {
		item.Close()
		return nil, errDownloadMissing
	}
	return item, nil
}
func removeStaleUploads(dir string, started time.Time, budget time.Duration) {
	removeStaleUploadsWith(func() (*os.Root, error) { return openDirectoryRoot(dir) }, started, budget)
}

// parseFileRoots is parseFileRootsAll, failing if any root is unavailable.
func parseFileRoots(spec, home, downloads string) ([]*fileRoot, error) {
	roots, problems, err := parseFileRootsAll(spec, home, downloads)
	if err == nil && len(problems) > 0 {
		err = fmt.Errorf("root %q: %w", problems[0].Label, problems[0].Err)
	}
	return roots, err
}

// withDefaultRoot gives g, a server built by hand, the root a configured
// one has without WEB_FS_ROOTS: Downloads, at g.downloadsDir.
func withDefaultRoot(t testing.TB, g *server) *server {
	t.Helper()
	roots, _, err := parseFileRootsAll("", "", g.downloadsDir)
	if err != nil {
		t.Fatal(err)
	}
	g.roots = roots
	return g
}

// defaultFiles is the service for the root requests naming none reach.
func (g *server) defaultFiles() *fileService {
	root, err := g.rootByID("")
	if err != nil {
		return nil
	}
	return g.scope(root)
}

// shownEntries lists dir as the files page would: without Trash, which a
// save makes to keep the file it replaces (see versions.go).
func shownEntries(dir string) []os.DirEntry {
	des, _ := os.ReadDir(dir)
	return slices.DeleteFunc(des, func(de os.DirEntry) bool { return de.Name() == trashDir })
}
