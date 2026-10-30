package main

// Uploads into ~/Downloads, dropped on the files page: with a PUT to the
// folder's URL plus the file's name, or with -e2e through the tunnel. A
// file is written to a hidden temporary file in its folder first, then
// linked under its name, which never replaces a file already there: a
// clash gets " (1)", " (2)" and so on before the extension instead.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"
)

// Uploads in progress are written to files named with this prefix, which
// listings leave out.
const uploadTempPrefix = ".tabtop-upload-"

var errUploadName = errors.New("That name can't be used for a file.")

// validUploadName reports whether name can be a file's name in a folder:
// one path segment, not a temporary upload's.
func validUploadName(name string) bool {
	return name != "" && name != "." && name != ".." && len(name) <= 255 && utf8.ValidString(name) &&
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
			got = fmt.Sprintf("%s (%d)%s", base, i, ext)
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

// putUpload answers a PUT of a file into a folder of /downloads/. A page
// on another site can't send one: forms can't PUT, and the browser would
// ask first (CORS), which is never allowed here.
func (g *server) putUpload(w http.ResponseWriter, r *http.Request) {
	if !g.sessionOK(r) {
		http.Error(w, "Log in first.", http.StatusUnauthorized)
		return
	}
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if r.ContentLength < 0 {
		http.Error(w, "The file's size is missing.", http.StatusLengthRequired)
		return
	}
	rel := strings.TrimPrefix(r.URL.Path, downloadsPrefix)
	dir, name := path.Split(rel)
	dir = strings.Trim(dir, "/")
	if dir == "" {
		dir = "."
	}
	reply := func(status int, v map[string]any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(v)
	}
	if !validUploadName(name) {
		reply(http.StatusBadRequest, map[string]any{"error": errUploadName.Error()})
		return
	}
	root, err := os.OpenRoot(g.downloadsDir)
	if err != nil {
		reply(http.StatusNotFound, map[string]any{"error": uploadError(fs.ErrNotExist)})
		return
	}
	defer root.Close()
	u, err := startUpload(root, dir)
	if err != nil {
		reply(uploadStatus(err), map[string]any{"error": uploadError(err)})
		return
	}
	n, err := io.Copy(u, stallReader{r.Body, http.NewResponseController(w)})
	if err == nil && n != r.ContentLength {
		err = io.ErrUnexpectedEOF
	}
	if err != nil {
		u.abort()
		reply(uploadStatus(err), map[string]any{"error": uploadError(err)})
		return
	}
	got, err := u.finish(name)
	if err != nil {
		log.Printf("upload of %q: %v", rel, err)
		reply(uploadStatus(err), map[string]any{"error": uploadError(err)})
		return
	}
	log.Printf("upload from %s saved %s (%s)", g.clientIP(r), path.Join(dir, got), humanSize(n))
	reply(http.StatusCreated, map[string]any{"name": got})
}

func uploadStatus(err error) int {
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return http.StatusNotFound
	case errors.Is(err, fs.ErrPermission):
		return http.StatusForbidden
	case errors.Is(err, syscall.ENOSPC):
		return http.StatusInsufficientStorage
	}
	return http.StatusInternalServerError
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

// stallReader reads a request's body, ending it if it stalls for
// fileStall: the server has no overall read timeout, since uploads may be
// big.
type stallReader struct {
	r  io.Reader
	rc *http.ResponseController
}

func (s stallReader) Read(p []byte) (int, error) {
	s.rc.SetReadDeadline(time.Now().Add(fileStall))
	return s.r.Read(p)
}
