package main

import (
	"archive/zip"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"sort"
	"strings"
	"time"
)

const maxZipExtractBytes = 512 << 20
const maxZipExtractFiles = 1000

var zipExtractSlots = newPreviewWork(previewEditConcurrency)

// Only regular files with plain, confined paths can become filesystem entries.
// Names are decoded exactly as in the listing; ordinal IDs distinguish duplicates.
func zipExtractName(f *zip.File) (string, bool) {
	name, err := zipPreviewName(f)
	if err != nil || !f.Mode().IsRegular() || f.Flags&1 != 0 || (f.Method != zip.Store && f.Method != zip.Deflate) ||
		name == "" || len(name) > 4096 || path.IsAbs(name) || path.Clean(name) != name || strings.Contains(name, "\\") {
		return "", false
	}
	parts := strings.Split(name, "/")
	if len(parts) > 32 {
		return "", false
	}
	for _, part := range parts {
		if !validNewName(part) {
			return "", false
		}
	}
	return name, true
}

type zipExtractWriter struct {
	io.Writer
	ctx context.Context
}

// Check compressed reads too: a stream of empty deflate blocks can consume
// CPU without producing output and therefore without reaching the writer.
type zipExtractReader struct {
	io.ReaderAt
	ctx context.Context
}

func (r zipExtractReader) ReadAt(p []byte, off int64) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.ReaderAt.ReadAt(p, off)
}

func (w zipExtractWriter) Write(p []byte) (int, error) {
	if err := w.ctx.Err(); err != nil {
		return 0, err
	}
	return w.Writer.Write(p)
}

// Extract into a private staging root, then publish the complete folder with
// RENAME_NOREPLACE. No ZIP metadata controls links, permissions or replacement.
func extractZipFiles(ctx context.Context, opened *downloadItem, ids []int) (string, error) {
	return extractZipFilesWithSync(ctx, opened, ids, syncDir)
}

// A nonempty destination with an error means publication succeeded but its
// parent could not be synced; callers must report a warning, not retry.
func extractZipFilesWithSync(ctx context.Context, opened *downloadItem, ids []int, syncDirectory func(*os.Root, string) error) (string, error) {
	if len(ids) == 0 || len(ids) > maxZipExtractFiles {
		return "", fmt.Errorf("select between 1 and %d files", maxZipExtractFiles)
	}
	zr, err := openBoundedZip(zipExtractReader{ReaderAt: opened.file, ctx: ctx}, opened.info.Size(), zipListingLimits)
	if err != nil && !errors.Is(err, zip.ErrInsecurePath) {
		return "", err
	}
	selected := make([]*zip.File, 0, len(ids))
	names := make([]string, 0, len(ids))
	seen := map[string]bool{}
	var total uint64
	for _, id := range ids {
		if id < 0 || id >= len(zr.File) {
			return "", errors.New("the ZIP selection is invalid; open it again")
		}
		f := zr.File[id]
		name, ok := zipExtractName(f)
		if !ok || seen[name] {
			return "", errors.New("the selection contains an unsafe, encrypted, unsupported or duplicate file")
		}
		seen[name] = true
		if f.UncompressedSize64 > maxZipExtractBytes-total {
			return "", errors.New("extract at most 512 MiB at a time")
		}
		total += f.UncompressedSize64
		selected = append(selected, f)
		names = append(names, name)
	}
	for _, name := range names {
		for parent := path.Dir(name); parent != "."; parent = path.Dir(parent) {
			if seen[parent] {
				return "", errors.New("a selected file is also used as a folder")
			}
		}
	}
	dir := path.Dir(opened.name)
	destination, err := openRootDirectory(opened.store.root, dir)
	if err != nil {
		return "", err
	}
	free, _, _, spaceKnown := fileDiskSpace(destination)
	destination.Close()
	if spaceKnown && uint64(max(0, free)) < total {
		return "", errors.New("there isn't enough free space to extract these files")
	}
	token := make([]byte, 16)
	if _, err = rand.Read(token); err != nil {
		return "", err
	}
	stageName := uploadTempPrefix + hex.EncodeToString(token) + ".stage"
	stage := path.Join(dir, stageName)
	if err = opened.store.root.Mkdir(stage, 0700); err != nil {
		return "", err
	}
	defer opened.store.root.RemoveAll(stage)
	root, err := opened.store.root.OpenRoot(stage)
	if err != nil {
		return "", err
	}
	defer root.Close()
	directories := map[string]bool{}
	for i, f := range selected {
		if err = ctx.Err(); err != nil {
			return "", err
		}
		name := names[i]
		if parent := path.Dir(name); parent != "." {
			for d := parent; d != "."; d = path.Dir(d) {
				directories[d] = true
			}
			if err = root.MkdirAll(parent, 0755); err != nil {
				return "", err
			}
		}
		out, err := root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
		if err != nil {
			return "", err
		}
		input, err := f.Open()
		if err != nil {
			out.Close()
			return "", err
		}
		n, copyErr := io.Copy(zipExtractWriter{Writer: out, ctx: ctx}, io.LimitReader(input, int64(f.UncompressedSize64)+1))
		input.Close()
		if copyErr == nil && uint64(n) != f.UncompressedSize64 {
			copyErr = errors.New("a ZIP entry has an invalid size")
		}
		if copyErr == nil {
			copyErr = out.Sync()
		}
		closeErr := out.Close()
		if copyErr != nil {
			return "", copyErr
		}
		if closeErr != nil {
			return "", closeErr
		}
	}
	if err = ctx.Err(); err != nil {
		return "", err
	}
	after, err := opened.file.Stat()
	if err != nil || fileVersion(after) != fileVersion(opened.info) || after.Size() != opened.info.Size() {
		return "", errors.New("the ZIP changed; open it again")
	}
	if err = root.Chmod(".", 0755); err != nil {
		return "", err
	}
	// Persist entries from the leaves up, then the staging root (including
	// its final permissions), before making the folder visible.
	dirs := make([]string, 0, len(directories))
	for d := range directories {
		dirs = append(dirs, d)
	}
	sort.Sort(sort.Reverse(sort.StringSlice(dirs)))
	for _, d := range append(dirs, ".") {
		if err = ctx.Err(); err != nil {
			return "", err
		}
		if err = syncDirectory(root, d); err != nil {
			return "", err
		}
	}
	base := strings.TrimSuffix(path.Base(opened.name), path.Ext(opened.name))
	if !validNewName(base) {
		base = "Extracted files"
	}
	for i := 0; i < 1000; i++ {
		got := base
		if i > 0 {
			got = numberedName(base, "", i)
		}
		err = opened.store.renameAt(dir, stageName, dir, got)
		if errors.Is(err, fs.ErrExist) {
			continue
		}
		if err != nil {
			return "", err
		}
		return path.Join(dir, got), syncDirectory(opened.store.root, dir)
	}
	return "", errors.New("too many folders with that name")
}

func (g *server) tunnelZipExtract(req tunnelRequest, session, ip string, r *tunnelResponder) {
	release, ok := zipExtractSlots.acquire()
	if !ok {
		r.fail("Other files are being extracted; try again in a moment.")
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
	destination, err := extractZipFiles(ctx, opened, req.Entries)
	if err != nil && destination == "" {
		r.fail("ZIP can't be extracted: " + err.Error())
		return
	}
	g.act(session, "files", ip, "extracted %d files from %s into %s", len(req.Entries), opened.name, destination)
	reply := map[string]any{"path": destination, "count": len(req.Entries)}
	if err != nil {
		reply["warning"] = "Extracted, but the disk did not confirm the folder was saved; it could be lost if the power fails soon."
	}
	r.finish(reply)
}
