package main

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestDirectoryOperationsRejectFIFO(t *testing.T) {
	dir := t.TempDir()
	victim := filepath.Join(dir, "victim")
	if err := os.Mkdir(victim, 0700); err != nil {
		t.Fatal(err)
	}
	want, err := os.Stat(victim)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(victim); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(victim, 0600); err != nil {
		t.Fatal(err)
	}
	store, err := openDownloadStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	u, err := store.startUpload(".")
	if err != nil {
		t.Fatal(err)
	}
	defer u.abort()
	u.dir = "victim"
	for _, tc := range []struct {
		name      string
		run       func() error
		wantError bool
	}{
		{"root", func() error {
			s, e := openDownloadStore(victim)
			if s != nil {
				s.Close()
			}
			return e
		}, true},
		{"nested", func() error {
			f, e := openRootDirectory(store.root, "victim")
			if f != nil {
				f.Close()
			}
			return e
		}, true},
		{"publish", func() error { return u.publish("saved", false) }, true},
		{"sync", func() error { return syncDir(store.root, "victim") }, true},
		{"rename-source", func() error { return store.renameAt("victim", "a", ".", "b") }, true},
		{"rename-target", func() error { return store.renameAt(".", "a", "victim", "b") }, true},
		{"diagnostics", func() error { _, e := countEntries(victim, 10); return e }, true},
		{"zip", func() error {
			z := zipper{store: store, zw: zip.NewWriter(io.Discard)}
			defer z.zw.Close()
			if e := z.addDir("victim", "victim", want, 1); e != nil {
				return e
			}
			if z.skipped != 1 {
				return fmt.Errorf("skipped %d entries, want 1", z.skipped)
			}
			return nil
		}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			done := make(chan error, 1)
			go func() { done <- tc.run() }()
			select {
			case err := <-done:
				if (err != nil) != tc.wantError {
					t.Fatalf("error=%v, wantError=%v", err, tc.wantError)
				}
			case <-time.After(time.Second):
				// Release a regressed blocking open so the test leaves no stuck worker.
				if f, e := os.OpenFile(victim, os.O_WRONLY|syscall.O_NONBLOCK, 0); e == nil {
					f.Close()
				}
				select {
				case <-done:
				case <-time.After(time.Second):
				}
				t.Fatal("directory operation blocked on a FIFO")
			}
		})
	}
}

func TestDirectoryRootPreservesPathRules(t *testing.T) {
	if root, err := openDirectoryRoot(""); err == nil {
		root.Close()
		t.Fatal("empty path became a valid root")
	}
	dir := t.TempDir()
	store, err := openDownloadStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	again, err := openDownloadStore(store.root.Name())
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	if store.root.Name() != again.root.Name() {
		t.Fatal("root path grows on repeated opens")
	}
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("sub", filepath.Join(dir, "inside")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(t.TempDir(), filepath.Join(dir, "outside")); err != nil {
		t.Fatal(err)
	}
	if f, err := openRootDirectory(store.root, "inside"); err != nil {
		t.Fatal(err)
	} else {
		f.Close()
	}
	if f, err := openRootDirectory(store.root, "outside"); err == nil {
		f.Close()
		t.Fatal("followed a symlink outside Downloads")
	}
}
