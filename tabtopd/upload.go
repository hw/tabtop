package main

// Uploads into ~/Downloads from the files page, through the tunnel. A file
// is written to a hidden temporary file in its folder first, then linked
// under its name, which never replaces a file already there: a clash gets
// " (1)", " (2)" and so on before the extension instead.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path"
	"regexp"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
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
		root, err := os.OpenRoot(dir)
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
		f, err := root.Open(d)
		if err != nil {
			continue
		}
		for !stop.Load() {
			des, err := f.ReadDir(256)
			for _, de := range des {
				p := path.Join(d, de.Name())
				switch {
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

var errUploadName = errors.New("That name can't be used for a file.")

// validUploadName reports whether name can be a file's name in a folder:
// one path segment, not a temporary upload's.
func validUploadName(name string) bool {
	return name != "" && name != "." && name != ".." && len(name) <= maxNameBytes && utf8.ValidString(name) &&
		!strings.ContainsAny(name, "/\x00") && !strings.HasPrefix(name, uploadTempPrefix)
}

// upload is a file being uploaded into dir in root.
type upload struct {
	root     *os.Root
	dir, tmp string
	f        *os.File
	unsynced bool // saved, but its folder may not be on disk yet
}

// startUpload creates the temporary file for an upload into dir.
func startUpload(root *os.Root, dir string) (*upload, error) {
	st, err := root.Stat(dir)
	if err != nil || !st.IsDir() {
		return nil, fs.ErrNotExist
	}
	b := make([]byte, 8)
	rand.Read(b)
	tmp := path.Join(dir, uploadTempPrefix+hex.EncodeToString(b)+".part")
	f, err := root.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return nil, err
	}
	return &upload{root: root, dir: dir, tmp: tmp, f: f}, nil
}

func (u *upload) Write(p []byte) (int, error) { return u.f.Write(p) }

// abort removes the temporary file.
func (u *upload) abort() {
	u.f.Close()
	u.root.Remove(u.tmp)
}

// finish saves the upload as name, or as the first free name like it, and
// returns the name it got.
func (u *upload) finish(name string) (string, error) {
	defer u.root.Remove(u.tmp)
	// On disk before the page is told it's saved, so a power cut can't
	// lose it after.
	if err := u.f.Sync(); err != nil {
		u.f.Close()
		return "", err
	}
	if err := u.f.Close(); err != nil {
		return "", err
	}
	ext := path.Ext(name)
	if ext == name {
		ext = "" // ".bashrc" is all name
	}
	base := strings.TrimSuffix(name, ext)
	for i := 0; i < 1000; i++ {
		got := name
		if i > 0 {
			got = numberedName(base, ext, i)
		}
		// Unlike a rename, a link fails rather than replace a file.
		err := u.root.Link(u.tmp, path.Join(u.dir, got))
		if err == nil {
			// And the folder, so the name is. If that fails, the file is
			// still saved, so the upload is too, with a warning; unless
			// the file system can't sync a folder at all, where the file
			// being synced is as far as it goes (and saying so on every
			// upload would only be noise).
			if err := syncDir(u.root, u.dir); err != nil && !errors.Is(err, syscall.EINVAL) && !errors.Is(err, syscall.ENOTSUP) {
				log.Printf("upload saved as %s, but syncing its folder failed: %v", path.Join(u.dir, got), err)
				u.unsynced = true
			}
			return got, nil
		}
		if !errors.Is(err, fs.ErrExist) {
			return "", err
		}
	}
	return "", errors.New("too many files with that name")
}

// numberedName is "base (i)ext", with base cut short (at a character's
// end) if that would be longer than a name can be. If the extension leaves
// no room, it's cut short as part of the name instead.
func numberedName(base, ext string, i int) string {
	suffix := fmt.Sprintf(" (%d)", i)
	room := maxNameBytes - len(suffix) - len(ext)
	if room < 1 {
		base, ext = base+ext, ""
		room = maxNameBytes - len(suffix)
	}
	for len(base) > room {
		_, size := utf8.DecodeLastRuneInString(base)
		base = base[:len(base)-size]
	}
	return base + suffix + ext
}

func syncDir(root *os.Root, dir string) error {
	d, err := root.Open(dir)
	if err != nil {
		return err
	}
	err = d.Sync()
	if cerr := d.Close(); err == nil {
		err = cerr
	}
	return err
}

// uploadError is what to tell the user about err.
func uploadError(err error) string {
	switch {
	case errors.Is(err, errUploadName):
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

// tunnelUpload answers an upload request: the page sends the file's
// contents in data messages, and the server acknowledges each with an
// empty data message once it's written, as the page does for downloads, so
// at most fileWindow chunks are on their way. Once it has req.Size bytes,
// it saves the file and sends {"name":...} with the name it got, or
// {"error":...}.
func (g *server) tunnelUpload(t *tunnel, req tunnelRequest, reply func(map[string]any) bool, fail func(string)) {
	if !validUploadName(req.Name) || req.Size < 0 {
		fail(errUploadName.Error())
		return
	}
	root, err := os.OpenRoot(g.downloadsDir)
	if err != nil {
		fail(uploadError(fs.ErrNotExist))
		return
	}
	defer root.Close()
	dir := strings.Trim(req.Path, "/")
	if dir == "" {
		dir = "."
	}
	u, err := startUpload(root, dir)
	if err != nil {
		fail(uploadError(err))
		return
	}
	saved := false
	defer func() {
		if !saved {
			u.abort()
		}
	}()
	t.c.SetReadLimit(fileChunk + tunnelOverhead)
	if !reply(nil) {
		return
	}
	for got := int64(0); got < req.Size; {
		ctx, cancel := context.WithTimeout(context.Background(), fileStall)
		typ, p, err := t.Read(ctx)
		cancel()
		if err != nil {
			return
		}
		if typ != websocket.MessageBinary || len(p) == 0 || got+int64(len(p)) > req.Size {
			t.Close(websocket.StatusPolicyViolation, "bad upload")
			return
		}
		if _, err := u.Write(p); err != nil {
			fail(uploadError(err))
			return
		}
		got += int64(len(p))
		ctx, cancel = context.WithTimeout(context.Background(), tunnelTimeout)
		err = t.Write(ctx, websocket.MessageBinary, nil)
		cancel()
		if err != nil {
			return
		}
	}
	name, err := u.finish(req.Name)
	saved = true
	if err != nil {
		log.Printf("upload of %q: %v", path.Join(dir, req.Name), err)
		fail(uploadError(err))
		return
	}
	log.Printf("upload through the tunnel saved %s (%s)", path.Join(dir, name), humanSize(req.Size))
	res := map[string]any{"name": name}
	if u.unsynced {
		res["warning"] = "saved, but the disk didn't confirm it; it could be lost if the power fails soon"
	}
	writeJSON(t, res)
	t.Close(websocket.StatusNormalClosure, "")
}
