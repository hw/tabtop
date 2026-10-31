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
	"path/filepath"
	"regexp"
	"strings"
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
// written before the gateway started, so none still going, even with the
// gateway serving meanwhile. Symlinked folders aren't followed.
func removeStaleUploads(dir string, started time.Time) {
	n := 0
	filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || !d.Type().IsRegular() || !uploadTempName.MatchString(d.Name()) {
			return nil
		}
		if info, err := d.Info(); err == nil && info.ModTime().Before(started) && os.Remove(p) == nil {
			n++
		}
		return nil
	})
	if n > 0 {
		log.Printf("removed %d unfinished uploads left from before a restart", n)
	}
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
	writeJSON(t, map[string]any{"name": name})
	t.Close(websocket.StatusNormalClosure, "")
}
