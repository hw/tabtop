package main

import (
	"os"
	"path/filepath"
)

// writeFileAtomic replaces file with data, readable only by its owner, in a
// folder only it can open.
func writeFileAtomic(file string, data []byte) error {
	dir := filepath.Dir(file)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".tabtop-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name()) // gone once renamed
	// Only a file written whole, on disk, and closed replaces the old one.
	_, err = f.Write(data)
	if err == nil {
		err = syncFile(f)
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if err := os.Rename(f.Name(), file); err != nil {
		return err
	}
	// And the folder, so the rename is on disk too: without it, a power
	// cut can bring back the old file, or none. A file system that can't
	// sync a folder goes as far as the file being synced.
	return syncFolder(dir)
}

// syncFolder puts what's changed in the folder dir on disk.
func syncFolder(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	err = syncFile(d)
	if cerr := d.Close(); err == nil {
		err = cerr
	}
	if syncUnsupported(err) {
		return nil
	}
	return err
}
