package main

// Uploads into ~/Downloads from the files page, through the tunnel. A file
// is written to a hidden temporary file in its folder first, then linked
// under its name, which never replaces a file already there: a clash gets
// " (1)", " (2)" and so on before the extension instead. Only when the page
// asks to replace (the person chose to) is it renamed over the file
// instead. An upload cut off by the connection is kept a while, so the
// page can carry on from where it stopped rather than send it all again.

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"io/fs"
	"log"
	"os"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/coder/websocket"
)

// Uploads in progress are written to files named with this prefix, which
// listings leave out.
const uploadTempPrefix = ".tabtop-upload-"

// The longest a file's name can be, in bytes, on Linux file systems.
const maxNameBytes = 255

// uploadTempName matches exactly the names startUpload makes.
var uploadTempName = regexp.MustCompile(`^` + regexp.QuoteMeta(uploadTempPrefix) + `[0-9a-f]{16}\.part$`)

// uploadStageName matches exactly the folders a replacing upload stages
// its file in (see publish); one left by a crash still holds a link to it.
var uploadStageName = regexp.MustCompile(`^` + regexp.QuoteMeta(uploadTempPrefix) + `[0-9a-f]{32}\.stage$`)

// removeStaleUploads removes the temporary files under dir of uploads cut
// off by a crash or a forced stop, which no one else removes: those last
// written before started. It runs before the gateway serves anything, so
// none are still going; another gateway sharing dir isn't supported.
// Symlinked folders aren't followed. It returns after budget at most, even
// if a read of the file system hangs, so a huge or slow tree can't hold up
// the start for long: the search stops there, removing nothing more, and
// what it didn't get to waits for the next start.
func removeStaleUploads(dir string, started time.Time, budget time.Duration) {
	if time.Since(started) >= budget {
		return
	}
	var stop atomic.Bool
	removed := make(chan int, 1)
	go func() {
		root, err := openDirectoryRoot(dir)
		if err != nil {
			removed <- 0
			return
		}
		defer root.Close()
		removed <- walkStaleUploads(root, []string{"."}, started, &stop)
	}()
	timer := time.NewTimer(budget - time.Since(started))
	defer timer.Stop()
	select {
	case n := <-removed:
		if n > 0 {
			log.Printf("removed %d unfinished uploads left from before a restart", n)
		}
	case <-timer.C:
		stop.Store(true)
		log.Printf("stopped looking for unfinished uploads after %v; the rest are looked for at the next start", budget)
	}
}

// walkStaleUploads does removeStaleUploads's search, until stop, reading
// folders a batch at a time so it can stop part way through a big one,
// starting with dirs. It goes through root, so a folder swapped for a
// symlink while it's queued can't lead it out.
func walkStaleUploads(root *os.Root, dirs []string, started time.Time, stop *atomic.Bool) int {
	n := 0
	for len(dirs) > 0 && !stop.Load() {
		d := dirs[len(dirs)-1]
		dirs = dirs[:len(dirs)-1]
		f, err := openRootDirectory(root, d)
		if err != nil {
			continue
		}
		for !stop.Load() {
			des, err := f.ReadDir(256)
			for _, de := range des {
				p := path.Join(d, de.Name())
				switch {
				case de.IsDir() && uploadStageName.MatchString(de.Name()):
					if info, err := de.Info(); err == nil && info.ModTime().Before(started) && !stop.Load() && root.RemoveAll(p) == nil {
						n++
					}
				case de.IsDir(): // not a symlink to one: its type is the link's
					dirs = append(dirs, p)
				case de.Type().IsRegular() && uploadTempName.MatchString(de.Name()):
					if info, err := de.Info(); err == nil && info.ModTime().Before(started) && !stop.Load() && root.Remove(p) == nil {
						n++
					}
				}
			}
			if err != nil {
				break
			}
		}
		f.Close()
	}
	return n
}

var (
	errUploadName    = errors.New("That name can't be used for a file.")
	errReplaceFolder = errors.New("A folder has that name, so it can't be replaced.")
	errReplaceLink   = errors.New("That's a link to another file, so it can't be saved over here. Open the file it leads to, and save that.")
)

// validUploadName reports whether name can be a file's name in a folder:
// one path segment, not a temporary upload's.
func validUploadName(name string) bool {
	return name != "" && name != "." && name != ".." && len(name) <= maxNameBytes && utf8.ValidString(name) &&
		!strings.ContainsAny(name, "/\x00") && !strings.HasPrefix(name, uploadTempPrefix)
}

// validNewName reports whether name can be given to a file or folder made
// or renamed from the files page: as validUploadName, and without control
// characters, such as a line break, which would make it hard to use in a
// shell, and could pass for something else where it's shown. One already
// there with them can still be renamed, moved and deleted.
func validNewName(name string) bool {
	return validUploadName(name) && !strings.ContainsFunc(name, unicode.IsControl)
}

// tunnelMkdir answers a mkdir request, for a folder req.Name in req.Path,
// with {"name":...}, the name it got.
func (g *server) tunnelMkdir(t *tunnel, req tunnelRequest, r *tunnelResponder) {
	root, err := openDownloadStore(g.downloadsDir)
	if err != nil {
		r.fail(uploadError(fs.ErrNotExist))
		return
	}
	defer root.Close()
	dir := strings.Trim(req.Path, "/")
	if dir == "" {
		dir = "."
	}
	name, err := root.makeFolder(dir, req.Name)
	if err != nil {
		log.Printf("folder %q: %v", path.Join(dir, req.Name), err)
		r.fail(uploadError(err))
		return
	}
	log.Printf("folder %q created through the tunnel", path.Join(dir, name))
	r.finish(map[string]any{"name": name})
}

// uploadError is what to tell the user about err.
func uploadError(err error) string {
	switch {
	case errors.Is(err, errUploadName), errors.Is(err, errReplaceFolder), errors.Is(err, errReplaceLink):
		return err.Error()
	case errors.Is(err, fs.ErrNotExist):
		return "The folder is missing."
	case errors.Is(err, fs.ErrPermission):
		return "The folder can't be written to."
	case errors.Is(err, syscall.ENOSPC):
		return "The disk is full."
	}
	return "The file couldn't be saved."
}

// uploadSavedHook is called once an upload is saved, before it's recorded
// as done: for tests, to come between the two.
var uploadSavedHook = func() {}

// tunnelUpload answers an upload request: it replies {"id":...,
// "offset":...}, and the page sends the file's contents from offset in
// data messages, and the server acknowledges each with an empty data
// message once it's written, as the page does for downloads, so at most
// fileWindow chunks are on their way. Once it has req.Size bytes, it saves
// the file and sends {"name":...} with the name it got, or {"error":...}.
// With req.Replace, a file of that name is replaced. The page cancels it
// with a text message, which deletes what came; if it stops any other way
// part way, as when the connection is lost, what came is kept, and a
// request with req.Resume set to the id carries on from it (see
// keepPartial); offset is 0 if it's gone.
func (g *server) tunnelUpload(t *tunnel, req tunnelRequest, r *tunnelResponder) {
	if !validNewName(req.Name) || req.Size < 0 {
		r.fail(errUploadName.Error())
		return
	}
	root, err := openDownloadStore(g.downloadsDir)
	if err != nil {
		r.fail(uploadError(fs.ErrNotExist))
		return
	}
	defer root.Close()
	dir := strings.Trim(req.Path, "/")
	if dir == "" {
		dir = "."
	}
	// Carrying on with one saved already: its answer was lost, so it's
	// answered again, and nothing more is done. (Before the check that the
	// file's as it was: it's been changed since, by this upload.)
	done := func() bool {
		reply := g.transfers.doneUpload(req.Resume, dir, req.Size)
		if req.Resume == "" || reply == nil {
			return false
		}
		if r.accept(map[string]any{"id": req.Resume, "offset": req.Size}) {
			r.finish(reply)
		}
		return true
	}
	if done() {
		return
	}
	var u *upload
	offset := int64(0)
	if req.Resume != "" && !g.transfers.wasDone(req.Resume) {
		// The upload carried on with may still be going, perhaps saving
		// the file now: it's stopped, or let finish, first, then asked
		// about again, before the file is checked against how it was, which
		// a save that has just replaced it would fail. (One saved already,
		// though not as this asks, has nothing to wait for.)
		u, offset = g.transfers.claimPartial(root, req.Resume, dir, req.Size)
		if u == nil && done() {
			return
		}
	}
	if req.IfMtime != "" {
		if err := unchangedSince(root, path.Join(dir, req.Name), req.IfMtime, req.IfSize); err != nil {
			if u != nil {
				// Kept again, as it was: it's not this request's to lose.
				g.transfers.keepPartial(u, req.Size)
			}
			r.fail(err.Error())
			return
		}
	}
	resuming := u != nil
	if u == nil {
		if u, err = root.startUpload(dir); err != nil {
			r.fail(uploadError(err))
			return
		}
	}
	// Check the file actually opened, so nested mounts and directory races
	// cannot make the space check refer to a different filesystem.
	if free, ok := g.transfers.reclaimPartials(u.f, req.Size-offset); ok && req.Size-offset > free {
		if resuming {
			g.transfers.keepPartial(u, req.Size)
		} else {
			u.abort()
		}
		r.fail(fmt.Sprintf("There isn't room for it: it's %s, and %s is free.", humanSize(req.Size-offset), humanSize(free)))
		return
	}
	saved, keep := false, false
	active := g.transfers.track(u.id(), func() { t.CloseNow() })
	defer func() {
		switch {
		case saved:
		case keep || active.resumed.Load():
			g.transfers.keepPartial(u, req.Size)
		default:
			u.abort()
		}
		g.transfers.untrack(u.id(), active)
	}()
	t.c.SetReadLimit(fileChunk + tunnelOverhead)
	if !r.accept(map[string]any{"id": u.id(), "offset": offset}) {
		return
	}
	if offset > 0 {
		log.Printf("upload of %q resumed at %s of %s", path.Join(dir, req.Name), humanSize(offset), humanSize(req.Size))
	}
	for got := offset; got < req.Size; {
		ctx, cancel := context.WithTimeout(context.Background(), fileStall)
		typ, p, err := t.Read(ctx)
		cancel()
		if err != nil {
			keep = !errors.Is(err, errTunnelFrame)
			return
		}
		if typ == websocket.MessageText {
			return // cancelled
		}
		if len(p) == 0 || got+int64(len(p)) > req.Size {
			t.Close(websocket.StatusPolicyViolation, "bad upload")
			return
		}
		if _, err := u.Write(p); err != nil {
			r.fail(uploadError(err))
			return
		}
		got += int64(len(p))
		ctx, cancel = context.WithTimeout(context.Background(), tunnelTimeout)
		err = t.Write(ctx, websocket.MessageBinary, nil)
		cancel()
		if err != nil {
			keep = true
			return
		}
	}
	// One replacing at a time, so a save from another tab can't come
	// between this one's check and its replacing the file.
	unlock := func() {}
	if req.Replace {
		unlock = lockReplacing(path.Join(dir, req.Name))
	}
	if req.IfMtime != "" {
		// Again, now it's all here: it may have changed meanwhile.
		if err := unchangedSince(root, path.Join(dir, req.Name), req.IfMtime, req.IfSize); err != nil {
			unlock()
			r.fail(err.Error())
			return
		}
	}
	name, err := u.finish(req.Name, req.Replace)
	// Its time and size, read before another save can replace it: the
	// page sends them back to say which file it has (see unchangedSince).
	var st fs.FileInfo
	if err == nil {
		st, _ = root.stat(path.Join(dir, name))
	}
	unlock()
	saved = true
	if err != nil {
		log.Printf("upload of %q: %v", path.Join(dir, req.Name), err)
		r.fail(uploadError(err))
		return
	}
	replaced := ""
	if req.Replace {
		replaced = ", replacing any file of that name"
	}
	log.Printf("upload through the tunnel saved %q (%s%s)", path.Join(dir, name), humanSize(req.Size), replaced)
	res := map[string]any{"name": name}
	if st != nil {
		res["mtime"], res["size"] = fileVersion(st), st.Size()
	}
	if u.unsynced {
		res["warning"] = "saved, but the disk didn't confirm it; it could be lost if the power fails soon"
	}
	uploadSavedHook()
	g.transfers.recordDone(u.id(), dir, req.Size, res)
	r.finish(res)
}

// replacing are locks for uploads that replace a file, chosen by the
// file's path: enough to keep those to one file in turn, few enough to
// take no more room however many files are saved.
var replacing [64]sync.Mutex

// lockReplacing locks replacing the file at p (in ~/Downloads), and
// returns the function that unlocks it.
func lockReplacing(p string) func() {
	h := fnv.New32a()
	h.Write([]byte(path.Clean(p)))
	mu := &replacing[h.Sum32()%uint32(len(replacing))]
	mu.Lock()
	return mu.Unlock
}

// fileVersion says which version of a file st is, as text, for a page to
// send back to have something done only to the file as it read it (see
// unchangedSince): when it was last changed, in Unix nanoseconds, and its
// inode. The time alone isn't enough: the kernel stamps it from a clock
// that moves only every few milliseconds, so a file replaced within one of
// those, by one of the same size, would seem the same; a file replaced is
// a new inode. (As text: a number that big loses digits as a JavaScript
// number.)
func fileVersion(st fs.FileInfo) string {
	v := strconv.FormatInt(st.ModTime().UnixNano(), 10)
	if sys, ok := st.Sys().(*syscall.Stat_t); ok {
		v += "-" + strconv.FormatUint(sys.Ino, 10)
	}
	return v
}

var errChangedSince = errors.New("It's been changed since it was opened (by someone or something else). Reload it, or save your text as another file.")

// unchangedSince reports, with an error to show, whether the file at p is
// still the one the page read: as long, and last changed at mtime.
func unchangedSince(store *downloadStore, p, mtime string, size int64) error {
	st, err := store.stat(p)
	if err != nil {
		return errors.New("It's been deleted or moved since it was opened.")
	}
	if !st.Mode().IsRegular() || fileVersion(st) != mtime || st.Size() != size {
		return errChangedSince
	}
	return nil
}

// diskSpace returns the bytes free for the gateway's files on the file
// system holding path, and its size, if it can tell.
func diskSpace(path string) (free, total int64, ok bool) {
	var st syscall.Statfs_t
	if syscall.Statfs(path, &st) != nil {
		return 0, 0, false
	}
	return int64(st.Bavail) * st.Bsize, int64(st.Blocks) * st.Bsize, true
}

// fileDiskSpace uses the open destination's filesystem rather than a pathname
// which may name another mount (or be replaced during a request).
func fileDiskSpace(f *os.File) (free, total int64, device uint64, ok bool) {
	var fs syscall.Statfs_t
	var st syscall.Stat_t
	if syscall.Fstatfs(int(f.Fd()), &fs) != nil || syscall.Fstat(int(f.Fd()), &st) != nil {
		return 0, 0, 0, false
	}
	return int64(fs.Bavail) * fs.Bsize, int64(fs.Blocks) * fs.Bsize, uint64(st.Dev), true
}
