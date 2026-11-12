package main

// Binary editing and searching, for the hex preview (see hex-view.js).
//
// A file-patch request overwrites bytes in a file in Downloads, where they
// are: never inserting or removing any, so its size stays as it was. It
// writes in place, rather than as a new file put in its place, as a text
// save does: a binary file may be gigabytes, and only its changed bytes are
// written. The whole request arrives before anything is written, so a lost
// connection writes nothing; a crash while writing may leave some of its
// runs written and some not. As a save does, it holds the lock an upload
// or save replacing the file takes, and writes only to the file as the page
// read it (its version and size, and the bytes where the runs go), and
// not through a link.
//
// A file-search request looks for a run of bytes, some of them (or half of
// one, a hex digit) any value, in a file, from an offset, forwards or
// backwards, a bounded stretch at a time: it answers where it found it, or
// where to carry on from, or that it reached the end.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"slices"
	"strings"
	"syscall"
	"time"
)

const (
	// Most bytes one save changes: its runs travel in the request, as hex,
	// which is at most tunnelRequestLimit (1 MiB).
	maxPatchBytes = 256 << 10
	maxPatchRuns  = 10000
	// Longest search pattern, in bytes.
	maxSearchPattern = 256
	// How far one search request reads, and for how long, before it says
	// where to carry on from.
	searchStretch = 64 << 20
	searchTime    = 3 * time.Second
	searchChunk   = 1 << 20
)

// bytePatch is a run of bytes to write at Offset, as hex.
type bytePatch struct {
	Offset int64  `json:"offset"`
	Hex    string `json:"hex"`
}

// searchSlots bounds the searches going at once, from every session.
var searchSlots = newBoundedWork(4, previewQueueWait)

var errPatch = errors.New("Those changes can't be made: each must be bytes within the file, in order, not overlapping.")

// patchRuns checks runs against a file of size bytes: sorted, apart, within
// it, and in all at most maxPatchBytes; and returns their bytes.
func patchRuns(runs []bytePatch, size int64) ([][]byte, int, error) {
	if len(runs) > maxPatchRuns {
		return nil, 0, fmt.Errorf("At most %d separate stretches of bytes can be changed in one save; save what's changed, then carry on.", maxPatchRuns)
	}
	if len(runs) == 0 {
		return nil, 0, errPatch
	}
	out := make([][]byte, len(runs))
	total, end := 0, int64(-1)
	for i, r := range runs {
		b, err := hex.DecodeString(r.Hex)
		if err != nil || len(b) == 0 || r.Offset < 0 || r.Offset <= end || r.Offset > size-int64(len(b)) {
			return nil, 0, errPatch
		}
		total += len(b)
		if total > maxPatchBytes {
			return nil, 0, fmt.Errorf("At most %s can be changed in one save; save what's changed, then carry on.", humanSize(maxPatchBytes))
		}
		end = r.Offset + int64(len(b)) - 1
		out[i] = b
	}
	return out, total, nil
}

// tunnelFilePatch answers a file-patch request: req.Patches written into
// the file at req.Path, if it's as the page read it (req.IfMtime,
// req.IfSize and req.IfBytes); {"mtime", "size"} after. The answer goes once the lock's
// let go: answering waits on the page closing the tunnel.
func (g *server) tunnelFilePatch(req tunnelRequest, session, ip string, r *tunnelResponder) {
	reply, total, err := g.patchFile(req)
	if err != nil {
		r.fail(err.Error())
		return
	}
	g.act(session, "files", ip, "changed %d byte%s in %s", total, plural(total), path.Clean(strings.Trim(req.Path, "/")))
	r.finish(reply)
}

// patchFile writes req.Patches into the file, holding the lock a save
// replacing it takes, and says how it is after, and how many bytes changed.
func (g *server) patchFile(req tunnelRequest) (map[string]any, int, error) {
	p := path.Clean(strings.Trim(req.Path, "/"))
	if req.IfMtime == "" || p == "." {
		return nil, 0, errors.New("That's not a change that can be made.")
	}
	store, err := openDownloadStore(g.downloadsDir)
	if err != nil {
		return nil, 0, errDownloadsMissing
	}
	defer store.Close()
	target, unlock, err := store.beginReplacement(p)
	if err != nil {
		return nil, 0, errDownloadMissing
	}
	defer unlock()
	name := path.Base(p)
	if lst, err := target.root.Lstat(name); err != nil {
		return nil, 0, errDownloadMissing
	} else if lst.Mode()&fs.ModeSymlink != 0 {
		return nil, 0, errReplaceLink
	} else if !lst.Mode().IsRegular() {
		return nil, 0, errors.New("Not a file.")
	}
	// O_NOFOLLOW: if a link took its place since, don't follow it.
	f, err := target.root.OpenFile(name, os.O_RDWR|syscall.O_NONBLOCK|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, 0, errors.New(uploadError(err))
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		return nil, 0, errors.New("Not a file.")
	}
	// Bytes are written into the file itself, not a new one put in its
	// place, so a hard link would carry them to its other names, which may
	// be outside Downloads.
	if sys, ok := st.Sys().(*syscall.Stat_t); !ok || sys.Nlink != 1 {
		return nil, 0, errHardLinked
	}
	if req.changed(st) {
		return nil, 0, errReopen(", then make the changes again")
	}
	runs, total, err := patchRuns(req.Patches, st.Size())
	if err != nil {
		return nil, 0, err
	}
	// The bytes where they go, still as the page saw them. Written in
	// place, the file keeps its inode, so its version is its time alone,
	// which another program's change made within the same tick of the
	// clock wouldn't alter; this would be.
	sum := sha256.New()
	for i, b := range runs {
		was := make([]byte, len(b))
		if _, err := f.ReadAt(was, req.Patches[i].Offset); err != nil {
			return nil, 0, errors.New(uploadError(err))
		}
		sum.Write(was)
	}
	if want, err := hex.DecodeString(req.IfBytes); err != nil || !bytes.Equal(sum.Sum(nil), want) {
		return nil, 0, errReopen(", then make the changes again")
	}
	for i, b := range runs {
		if _, err := f.WriteAt(b, req.Patches[i].Offset); err != nil {
			return nil, 0, errors.New(uploadError(err))
		}
	}
	if err := f.Sync(); err != nil {
		return nil, 0, errors.New(uploadError(err))
	}
	after, err := f.Stat()
	if err != nil {
		return nil, 0, errors.New(uploadError(err))
	}
	// Still the file at that name: written through its own descriptor, it
	// can't be another, but say so if it was moved meanwhile.
	if lst, err := target.root.Lstat(name); err != nil || !os.SameFile(lst, after) {
		return nil, 0, errors.New("The file was moved while it was being saved; its changes went with it.")
	}
	return map[string]any{"mtime": fileVersion(after), "size": after.Size()}, total, nil
}

var errHardLinked = errors.New("This file has other names (hard links), so its bytes can't be changed here.")

// searchPattern is a pattern's bytes and mask, as hex: a mask bit clear
// matches either value.
func searchPattern(value, mask string) ([]byte, []byte, error) {
	v, err1 := hex.DecodeString(value)
	m, err2 := hex.DecodeString(mask)
	if err1 != nil || err2 != nil || len(v) == 0 || len(v) != len(m) || len(v) > maxSearchPattern {
		return nil, nil, fmt.Errorf("Search for 1 to %d bytes.", maxSearchPattern)
	}
	if !slices.ContainsFunc(m, func(b byte) bool { return b != 0 }) {
		return nil, nil, errors.New("Search for at least one hex digit that isn't ?.")
	}
	for i := range v {
		v[i] &= m[i]
	}
	return v, m, nil
}

// matchAt reports whether b, from its start, matches value under mask.
func matchAt(b, value, mask []byte) bool {
	for i := range value {
		if b[i]&mask[i] != value[i] {
			return false
		}
	}
	return true
}

// indexMasked is where in b value first matches under mask (or with last,
// last), or -1. It looks for the pattern's first whole byte, if it has one,
// and checks the rest there.
func indexMasked(b, value, mask []byte, last bool) int {
	n := len(value)
	if len(b) < n {
		return -1
	}
	anchor := slices.Index(mask, 0xff)
	if !last {
		for i := 0; i+n <= len(b); {
			if anchor >= 0 {
				j := bytes.IndexByte(b[i+anchor:len(b)-n+anchor+1], value[anchor])
				if j < 0 {
					return -1
				}
				i += j
			}
			if matchAt(b[i:], value, mask) {
				return i
			}
			i++
		}
		return -1
	}
	for i := len(b) - n; i >= 0; {
		if anchor >= 0 {
			j := bytes.LastIndexByte(b[anchor:i+anchor+1], value[anchor])
			if j < 0 {
				return -1
			}
			i = j
		}
		if matchAt(b[i:], value, mask) {
			return i
		}
		i--
	}
	return -1
}

// searchFile looks in f, of size bytes, for value under mask: forwards from
// from (a match starting there or after), or backwards (one starting there
// or before), reading at most stretch bytes, or for at most limit. found is
// its offset, or -1; next, where to carry on from, or -1 at the end. It
// stops, with ctx's error, once ctx ends.
func searchFile(ctx context.Context, f io.ReaderAt, size int64, value, mask []byte, from int64, backward bool, stretch int64, limit time.Duration) (found, next int64, err error) {
	n := int64(len(value))
	deadline := time.Now().Add(limit)
	buf := make([]byte, searchChunk+len(value)-1)
	read := int64(0)
	if !backward {
		for at := max(from, 0); at+n <= size; {
			end := min(at+searchChunk+n-1, size)
			b := buf[:end-at]
			if _, err := f.ReadAt(b, at); err != nil && err != io.EOF {
				return -1, -1, err
			}
			if i := indexMasked(b, value, mask, false); i >= 0 {
				return at + int64(i), -1, nil
			}
			at = end - n + 1
			read += int64(len(b))
			if at+n <= size && (read >= stretch || time.Now().After(deadline)) {
				return -1, at, nil
			}
			if ctx.Err() != nil {
				return -1, -1, ctx.Err()
			}
		}
		return -1, -1, nil
	}
	// Backwards: chunks ending with a match starting at from, at most.
	for last := min(from, size-n); last >= 0; {
		begin := max(last-searchChunk+1, 0)
		b := buf[:last+n-begin]
		if _, err := f.ReadAt(b, begin); err != nil && err != io.EOF {
			return -1, -1, err
		}
		if i := indexMasked(b, value, mask, true); i >= 0 {
			return begin + int64(i), -1, nil
		}
		last = begin - 1
		read += int64(len(b))
		if last >= 0 && (read >= stretch || time.Now().After(deadline)) {
			return -1, last, nil
		}
		if ctx.Err() != nil {
			return -1, -1, ctx.Err()
		}
	}
	return -1, -1, nil
}

// tunnelFileSearch answers a file-search request: req.Pattern (hex) under
// req.Mask in the file at req.Path, as the page read it, from req.Offset,
// backwards with req.Backward; {"found": offset or -1, "next": where to
// carry on from, or -1}.
func (g *server) tunnelFileSearch(req tunnelRequest, r *tunnelResponder) {
	value, mask, err := searchPattern(req.Pattern, req.Mask)
	if err != nil {
		r.fail(err.Error())
		return
	}
	// Ended, with its slot freed (or not waited for), if the page gives up
	// on it (a search begun after it, say): nothing more is read from the
	// tunnel.
	ctx := r.t.CloseRead(context.Background())
	release, ok := searchSlots.acquireContext(ctx)
	if !ok {
		if ctx.Err() == nil {
			r.fail("Other searches are going; try again in a moment.")
		}
		return
	}
	defer release()
	opened, err := openDownloadsFile(g.downloadsDir, req.Path)
	if err != nil {
		r.fail(err.Error())
		return
	}
	defer opened.Close()
	st := opened.info
	if req.changedSinceRead(st) {
		r.fail(errReopen(" to search it").Error())
		return
	}
	found, next, err := searchFile(ctx, opened.file, st.Size(), value, mask, req.Offset, req.Backward, searchStretch, searchTime)
	if ctx.Err() != nil {
		return
	}
	if err != nil {
		r.fail("It couldn't be read.")
		return
	}
	r.finish(map[string]any{"found": found, "next": next, "size": st.Size()})
}
