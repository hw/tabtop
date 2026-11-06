package main

// Download selected ZIP entries through the tunnel without writing them into
// Downloads: one file is streamed as itself; several become a new zip made
// while it's sent (as folder zips are).

import (
	"archive/zip"
	"compress/flate"
	"context"
	"errors"
	"io"
	"log"
	"path"
	"strings"
	"time"
)

var zipDownloadSlots = newPreviewWork(previewEditConcurrency)

// tunnelZipDownload streams req.Entries from the ZIP at req.Path to the
// page: {"name":...,"size":...} then bytes for one file, or {"name":...}
// then a zip and {"done":true} for several.
func (g *server) tunnelZipDownload(t *tunnel, req tunnelRequest, session, ip string, r *tunnelResponder) {
	release, ok := zipDownloadSlots.acquire()
	if !ok {
		r.fail("Other ZIP downloads are in progress; try again in a moment.")
		return
	}
	defer release()
	opened, err := openDownloadsFile(g.downloadsDir, req.Path)
	if err != nil {
		r.fail(err.Error())
		return
	}
	defer opened.Close()
	if req.IfMtime == "" || req.IfMtime != fileVersion(opened.info) || req.IfSize != opened.info.Size() {
		r.fail("The ZIP changed; open it again.")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	zr, err := openBoundedZip(zipExtractReader{ReaderAt: opened.file, ctx: ctx}, opened.info.Size(), zipListingLimits)
	if err != nil && !errors.Is(err, zip.ErrInsecurePath) {
		r.fail("ZIP can't be read: " + err.Error())
		return
	}
	selected, names, total, err := zipSelectedFiles(zr, req.Entries)
	if err != nil {
		r.fail(err.Error())
		return
	}
	if len(selected) == 1 {
		if !streamZipEntry(t, r, ctx, opened, selected[0], names[0], total) {
			return
		}
		g.act(session, "files", ip, "downloaded %s from %s", names[0], opened.name)
		log.Printf("%s downloaded %q from ZIP %q through the tunnel", ip, names[0], opened.name)
		return
	}
	if !streamZipEntriesZip(t, r, ctx, opened, selected, names) {
		return
	}
	g.act(session, "files", ip, "downloaded %d files from %s", len(selected), opened.name)
	log.Printf("%s downloaded %d files from ZIP %q through the tunnel", ip, len(selected), opened.name)
}

// streamZipEntry sends one decompressed entry. It reports whether the
// transfer finished cleanly (for activity logging).
func streamZipEntry(t *tunnel, r *tunnelResponder, ctx context.Context, opened *downloadItem, f *zip.File, name string, size uint64) bool {
	saveAs := path.Base(name)
	if !validNewName(saveAs) {
		saveAs = "download"
	}
	if size > uint64(^uint64(0)>>1) {
		r.fail("That file is too large to download this way.")
		return false
	}
	if !r.accept(map[string]any{"name": saveAs, "size": int64(size)}) {
		return false
	}
	input, err := f.Open()
	if err != nil {
		r.fail("ZIP can't be read: " + err.Error())
		return false
	}
	defer input.Close()
	w := newChunkWriter(t)
	defer w.stop()
	n, err := io.Copy(zipExtractWriter{Writer: w, ctx: ctx}, io.LimitReader(input, int64(size)+1))
	if err == nil && uint64(n) != size {
		err = errors.New("a ZIP entry has an invalid size")
	}
	if err != nil {
		w.fail(err)
		return false
	}
	if after, stErr := opened.file.Stat(); stErr != nil || fileVersion(after) != fileVersion(opened.info) || after.Size() != opened.info.Size() {
		w.fail(errors.New("the ZIP changed; open it again"))
		return false
	}
	if w.flush() != nil {
		return false
	}
	r.finish(nil)
	return true
}

// streamZipEntriesZip sends several entries as a new zip. It reports
// whether the transfer finished cleanly.
func streamZipEntriesZip(t *tunnel, r *tunnelResponder, ctx context.Context, opened *downloadItem, selected []*zip.File, names []string) bool {
	base := strings.TrimSuffix(path.Base(opened.name), path.Ext(opened.name))
	if !validNewName(base) {
		base = "files"
	}
	if !r.accept(map[string]any{"name": base + "-selection.zip"}) {
		return false
	}
	w := newChunkWriter(t)
	defer w.stop()
	zw := zip.NewWriter(w)
	zw.RegisterCompressor(zip.Deflate, func(out io.Writer) (io.WriteCloser, error) {
		return flate.NewWriter(out, flate.BestSpeed)
	})
	for i, f := range selected {
		if err := ctx.Err(); err != nil {
			w.fail(err)
			return false
		}
		header := &zip.FileHeader{Name: names[i], Method: zip.Deflate}
		if !f.Modified.IsZero() {
			header.Modified = f.Modified
		}
		out, err := zw.CreateHeader(header)
		if err != nil {
			w.fail(err)
			return false
		}
		input, err := f.Open()
		if err != nil {
			w.fail(err)
			return false
		}
		n, copyErr := io.Copy(zipExtractWriter{Writer: out, ctx: ctx}, io.LimitReader(input, int64(f.UncompressedSize64)+1))
		input.Close()
		if copyErr == nil && uint64(n) != f.UncompressedSize64 {
			copyErr = errors.New("a ZIP entry has an invalid size")
		}
		if copyErr != nil {
			w.fail(copyErr)
			return false
		}
	}
	if err := zw.Close(); err != nil {
		w.fail(err)
		return false
	}
	if after, err := opened.file.Stat(); err != nil || fileVersion(after) != fileVersion(opened.info) || after.Size() != opened.info.Size() {
		w.fail(errors.New("the ZIP changed; open it again"))
		return false
	}
	if w.flush() != nil {
		return false
	}
	r.finish(map[string]any{"done": true})
	return true
}
