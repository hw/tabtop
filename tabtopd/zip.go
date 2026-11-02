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
	"log"
	"path"
	"strings"
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

// tunnelZip answers a zip request, for req.Names in the folder req.Path,
// with {"name":...}, what to save it as, then the zip in data messages,
// sent as a file is, then {"done":true,"skipped":n}, n being how many files
// or folders couldn't be read and were left out.
func (g *server) tunnelZip(t *tunnel, req tunnelRequest, ip string, r *tunnelResponder) {
	root, err := openDownloadStore(g.downloadsDir)
	if err != nil {
		r.fail("The downloads folder is missing.")
		return
	}
	defer root.Close()
	dir := strings.Trim(req.Path, "/")
	if dir == "" {
		dir = "."
	}
	if st, err := root.stat(dir); err != nil || !st.IsDir() {
		r.fail("Not found.")
		return
	}
	if len(req.Names) == 0 || len(req.Names) > maxListing {
		r.fail("Nothing to download.")
		return
	}
	seen := map[string]bool{}
	for _, n := range req.Names {
		if !validUploadName(n) || seen[n] {
			r.fail("Not found.")
			return
		}
		seen[n] = true
	}
	name := zipName(dir, req.Names)
	if !r.accept(map[string]any{"name": name}) {
		return
	}
	w := newChunkWriter(t)
	defer w.stop()
	zw := zip.NewWriter(w)
	// Fast rather than small: it's made while it's sent.
	zw.RegisterCompressor(zip.Deflate, func(out io.Writer) (io.WriteCloser, error) {
		return flate.NewWriter(out, flate.BestSpeed)
	})
	z := &zipper{store: root, zw: zw}
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
			log.Printf("zip of %q for %s: %v", path.Join(dir, name), ip, err)
		}
		w.fail(err)
		return
	}
	log.Printf("%s downloaded %q through the tunnel (%d files)", ip, path.Join(dir, name), z.files)
	r.finish(map[string]any{"done": true, "skipped": z.skipped})
}
