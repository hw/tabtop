package main

import (
	"archive/zip"
	"io"
	"io/fs"
	"os"
	"path"
	"strings"
)

// zipper writes files from root into a zip. Folders are walked a batch at
// a time; symlinks to files in root are followed, but not those to
// folders, so a loop can't make it go on forever. A folder in a listing is
// opened by name, so it's checked to be the same folder once open: one
// swapped for a symlink in between, to a folder above it say, is left out
// rather than followed. Folders deeper than maxZipDepth are left out too.
// What can't be opened is counted in skipped and left out; a failure part
// way through a file, or in sending, ends the zip.
type zipper struct {
	store   *downloadStore
	zw      *zip.Writer
	files   int
	skipped int
}

// maxZipDepth is how many folders deep a zip goes.
const maxZipDepth = 64

// add adds what's at p in root as name in the zip.
func (z *zipper) add(p, name string) error {
	st, err := z.store.root.Stat(p)
	switch {
	case err != nil:
		z.skipped++
		return nil
	case st.IsDir():
		return z.addDir(p, name, st, 1)
	case st.Mode().IsRegular():
		return z.addFile(p, name, st)
	}
	return nil // a device, a socket, a FIFO
}

func (z *zipper) addFile(p, name string, st fs.FileInfo) error {
	f, err := z.store.openRegular(p, st)
	if err != nil {
		z.skipped++
		return nil
	}
	defer f.Close()
	h := &zip.FileHeader{Name: name, Modified: st.ModTime(), Method: zip.Deflate}
	if storedExt[strings.ToLower(path.Ext(name))] {
		h.Method = zip.Store
	}
	h.SetMode(st.Mode().Perm())
	w, err := z.zw.CreateHeader(h)
	if err != nil {
		return err
	}
	if _, err := io.Copy(w, f); err != nil {
		return err
	}
	z.files++
	return nil
}

// addDir adds the folder at p in root as name, depth folders deep, if it's
// still the folder want describes.
func (z *zipper) addDir(p, name string, want fs.FileInfo, depth int) error {
	if depth > maxZipDepth {
		z.skipped++
		return nil
	}
	d, err := openRootDirectory(z.store.root, p)
	if err != nil {
		z.skipped++
		return nil
	}
	defer d.Close()
	if st, err := d.Stat(); err != nil || !st.IsDir() || !os.SameFile(st, want) {
		z.skipped++
		return nil
	}
	// Its own entry, so an empty folder is kept.
	if _, err := z.zw.CreateHeader(&zip.FileHeader{Name: name + "/", Method: zip.Store}); err != nil {
		return err
	}
	for {
		des, rerr := d.ReadDir(256)
		for _, de := range des {
			if strings.HasPrefix(de.Name(), uploadTempPrefix) {
				continue // an upload in progress
			}
			cp, cn := path.Join(p, de.Name()), name+"/"+de.Name()
			var err error
			switch {
			case de.IsDir():
				if st, serr := de.Info(); serr == nil {
					err = z.addDir(cp, cn, st, depth+1)
				} else {
					z.skipped++
				}
			case de.Type().IsRegular():
				if st, serr := de.Info(); serr == nil {
					err = z.addFile(cp, cn, st)
				} else {
					z.skipped++
				}
			case de.Type()&fs.ModeSymlink != 0:
				if st, serr := z.store.root.Stat(cp); serr == nil && st.Mode().IsRegular() {
					err = z.addFile(cp, cn, st)
				}
			}
			if err != nil {
				return err
			}
		}
		if rerr == io.EOF {
			return nil
		}
		if rerr != nil {
			z.skipped++
			return nil
		}
	}
}
