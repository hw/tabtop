package main

// Downloading folders, or several files and folders at once, as one zip
// from the files page, through the tunnel. The zip is made as it's sent,
// so it needs no room on disk, and its size isn't known until it's done:
// the server ends with {"done":true}, so a zip cut short isn't taken for
// a whole one.

import (
	"archive/zip"
	"compress/flate"
	"errors"
	"io"
	"io/fs"
	"log"
	"os"
	"path"
	"strings"

	"github.com/coder/websocket"
)

// storedExt are extensions of files that are compressed already, which a
// zip stores as they are rather than spend time compressing again.
var storedExt = map[string]bool{
	".zip": true, ".gz": true, ".tgz": true, ".xz": true, ".bz2": true, ".zst": true, ".7z": true, ".rar": true,
	".jpg": true, ".jpeg": true, ".png": true, ".gif": true, ".webp": true, ".heic": true, ".avif": true,
	".mp3": true, ".m4a": true, ".aac": true, ".ogg": true, ".opus": true, ".flac": true,
	".mp4": true, ".m4v": true, ".mkv": true, ".mov": true, ".webm": true,
}

// zipName is what to call a zip of names in dir: after the one thing in
// it, or else after dir.
func zipName(dir string, names []string) string {
	switch {
	case len(names) == 1:
		return names[0] + ".zip"
	case dir == ".":
		return "Downloads.zip"
	}
	return path.Base(dir) + ".zip"
}

// zipper writes files from root into a zip. Folders are walked a batch at
// a time; symlinks to files in root are followed, but not those to
// folders, so a loop can't make it go on forever. A folder in a listing is
// opened by name, so it's checked to be the same folder once open: one
// swapped for a symlink in between, to a folder above it say, is left out
// rather than followed. Folders deeper than maxZipDepth are left out too.
// What can't be opened is counted in skipped and left out; a failure part
// way through a file, or in sending, ends the zip.
type zipper struct {
	root    *os.Root
	zw      *zip.Writer
	files   int
	skipped int
}

// maxZipDepth is how many folders deep a zip goes.
const maxZipDepth = 64

// add adds what's at p in root as name in the zip.
func (z *zipper) add(p, name string) error {
	st, err := z.root.Stat(p)
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
	f, err := z.root.Open(p)
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
	d, err := z.root.Open(p)
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
				if st, serr := z.root.Stat(cp); serr == nil && st.Mode().IsRegular() {
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

// tunnelZip answers a zip request, for req.Names in the folder req.Path,
// with {"name":...}, what to save it as, then the zip in data messages,
// sent as a file is, then {"done":true,"skipped":n}, n being how many files
// or folders couldn't be read and were left out.
func (g *server) tunnelZip(t *tunnel, req tunnelRequest, ip string, reply func(map[string]any) bool, fail func(string)) {
	root, err := os.OpenRoot(g.downloadsDir)
	if err != nil {
		fail("The downloads folder is missing.")
		return
	}
	defer root.Close()
	dir := strings.Trim(req.Path, "/")
	if dir == "" {
		dir = "."
	}
	if st, err := root.Stat(dir); err != nil || !st.IsDir() {
		fail("Not found.")
		return
	}
	if len(req.Names) == 0 || len(req.Names) > maxListing {
		fail("Nothing to download.")
		return
	}
	seen := map[string]bool{}
	for _, n := range req.Names {
		if !validUploadName(n) || seen[n] {
			fail("Not found.")
			return
		}
		seen[n] = true
	}
	name := zipName(dir, req.Names)
	if !reply(map[string]any{"name": name}) {
		return
	}
	w := newChunkWriter(t)
	defer w.stop()
	zw := zip.NewWriter(w)
	// Fast rather than small: it's made while it's sent.
	zw.RegisterCompressor(zip.Deflate, func(out io.Writer) (io.WriteCloser, error) {
		return flate.NewWriter(out, flate.BestSpeed)
	})
	z := &zipper{root: root, zw: zw}
	for _, n := range req.Names {
		if err = z.add(path.Join(dir, n), n); err != nil {
			break
		}
	}
	if err == nil {
		err = zw.Close()
	}
	if err == nil {
		err = w.flush()
	}
	if err != nil {
		if !errors.Is(err, errStalled) && w.ctx.Err() == nil {
			log.Printf("zip of %s for %s: %v", path.Join(dir, name), ip, err)
		}
		w.fail(err)
		return
	}
	log.Printf("%s downloaded %s through the tunnel (%d files)", ip, path.Join(dir, name), z.files)
	if writeJSON(t, map[string]any{"done": true, "skipped": z.skipped}) == nil {
		t.Close(websocket.StatusNormalClosure, "")
	}
}
