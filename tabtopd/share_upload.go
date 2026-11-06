package main

// Upload links: the other way round from a share link, a link that lets
// someone without a login upload files into one folder in ~/Downloads.
// It's a share link with Upload set, at the same address,
//
//	<base>fs/<token>/
//
// A browser gets a page to pick files with (see share_page.go); curl -T
// file <link> puts one at <link><name>, which is what curl makes of a link
// ending in "/". A file is written to a hidden temporary file in the
// folder, as uploads from the files page are, then saved under its name,
// or the first free one like it: it never replaces a file. The link allows
// so many files, and so many bytes in all, and nothing else: no folders,
// no hidden files, no reading back what's there. Uploads can't be carried
// on part way.

import (
	"errors"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"path"
	"strings"
	"time"
)

// The most an upload link may take in all.
const maxUploadLinkBytes = 1 << 40

// uploadLinkError is an upload refused, with the status to say so with.
type uploadLinkError struct {
	code int
	msg  string
}

func (e *uploadLinkError) Error() string { return e.msg }

var errLinkFull = &uploadLinkError{http.StatusForbidden, "This link has taken as many files as it allows."}

// reserve makes room for an upload of length bytes (-1 if not known) with
// l, if it allows another file of that size.
func (s *shareStore) reserve(l *shareLink, length int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.links[l.ID] != l {
		return &uploadLinkError{http.StatusNotFound, "This link doesn't exist, or has ended."}
	}
	if l.Max > 0 && l.Count+l.pending >= l.Max {
		return errLinkFull
	}
	if l.pending >= maxLinkUploadsAtOnce {
		return &uploadLinkError{http.StatusServiceUnavailable, "Too many uploads are going through this link; let some finish, then try again."}
	}
	if s.uploadsAll >= maxLinkUploadsAll {
		return &uploadLinkError{http.StatusServiceUnavailable, "Too many uploads are going; try again in a little while."}
	}
	if length > l.MaxBytes-l.Bytes-l.pendingBytes {
		return s.tooBigLocked(l)
	}
	l.pending++
	s.uploadsAll++
	return nil
}

func (s *shareStore) tooBigLocked(l *shareLink) error {
	return &uploadLinkError{http.StatusRequestEntityTooLarge,
		fmt.Sprintf("That's more than this link takes: it has room for %s more.", humanSize(max(0, l.MaxBytes-l.Bytes-l.pendingBytes)))}
}

// grow counts n more bytes written by an upload with l, if they fit.
func (s *shareStore) grow(l *shareLink, n int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if l.Bytes+l.pendingBytes+n > l.MaxBytes {
		return s.tooBigLocked(l)
	}
	l.pendingBytes += n
	return nil
}

// settle ends an upload with l that wrote size bytes: saved as name, from
// ip, or not saved if name is "".
func (s *shareStore) settle(l *shareLink, size int64, name, ip string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	l.pending--
	l.pendingBytes -= size
	s.uploadsAll--
	if name == "" || s.links[l.ID] != l {
		return
	}
	l.Count++
	l.Bytes += size
	l.Uses = append(l.Uses, shareUse{IP: ip, Time: s.clock.Now(), Name: name, Size: size})
	if len(l.Uses) > maxShareUses {
		l.Uses = l.Uses[len(l.Uses)-maxShareUses:]
	}
	if l.Max > 0 {
		s.saveLocked()
	} else {
		// No limit to hold across a restart: saved soon, with others.
		s.saveSoonLocked()
	}
}

// Uploads through an upload link going at once, whole or in pieces; and
// through every link, all told. Each holds a temporary file and a buffer.
const (
	maxLinkUploadsAtOnce = 16
	maxLinkUploadsAll    = 64
)

// logUpload logs a file received through l from ip, in the log and the
// activity log, as often as logUse says: every one, for a link with a
// limit; for one without, once in a while from each address, so that
// sending file after file can't push all else out of the activity log.
func (g *server) logUpload(l *shareLink, ip, name string, size int64, how string) {
	if !g.shares.logUse(l, ip) {
		return
	}
	log.Printf("upload link to %q: %q (%s) uploaded from %s%s", l.Path, name, humanSize(size), ip, how)
	g.activity.add("upload", ip, "uploaded %s (%s) into %s through an upload link", name, humanSize(size), folderText(l.Path))
}

// linkFileName is name as an upload link saves it, if it can: one name, not
// a hidden file's, and one the files page could give.
func linkFileName(name string) (string, bool) {
	return name, validNewName(name) && !strings.HasPrefix(name, ".")
}

// stallReader gives each read of a request's body fileStall, so a client
// that stops sending doesn't hold an upload, and its place in the link's
// limits, open.
type stallReader struct {
	r  io.Reader
	rc *http.ResponseController
}

func (s stallReader) Read(p []byte) (int, error) {
	s.rc.SetReadDeadline(time.Now().Add(fileStall))
	return s.r.Read(p)
}

// receive saves body, length bytes (-1 if not known), as name in l's
// folder, uploaded from ip, and returns the name it got.
func (g *server) receive(l *shareLink, store *downloadStore, ip, name string, body io.Reader, length int64) (string, error) {
	name, ok := linkFileName(name)
	if !ok {
		return "", &uploadLinkError{http.StatusBadRequest, "That name can't be used for a file."}
	}
	if err := g.shares.reserve(l, length); err != nil {
		return "", err
	}
	written, saved := int64(0), ""
	defer func() { g.shares.settle(l, written, saved, ip) }()
	u, err := store.startUpload(l.Path)
	if err != nil {
		return "", &uploadLinkError{http.StatusInternalServerError, uploadError(err)}
	}
	if free, ok := g.transfers.reclaimPartials(u.f, max(length, 0)); ok && length > free {
		u.abort()
		return "", &uploadLinkError{http.StatusInsufficientStorage, "There isn't room for it on the disk."}
	}
	buf := make([]byte, 256<<10)
	for {
		n, rerr := body.Read(buf)
		if n > 0 {
			if l.revoked.Load() {
				u.abort()
				return "", &uploadLinkError{http.StatusNotFound, "This link has ended."}
			}
			if err := g.shares.grow(l, int64(n)); err != nil {
				u.abort()
				return "", err
			}
			written += int64(n)
			if _, err := u.Write(buf[:n]); err != nil {
				u.abort()
				return "", &uploadLinkError{http.StatusInsufficientStorage, uploadError(err)}
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			u.abort()
			return "", &uploadLinkError{http.StatusBadRequest, "The upload was cut off."}
		}
	}
	if length >= 0 && written != length {
		u.abort()
		return "", &uploadLinkError{http.StatusBadRequest, "The upload was cut off."}
	}
	// The folder may have gone, or been swapped, while it came.
	if st, err := store.stat(l.Path); err != nil || !l.matches(st) {
		u.abort()
		return "", &uploadLinkError{http.StatusNotFound, "The folder this link uploads to has gone."}
	}
	got, err := u.finish(name, false)
	if err != nil {
		log.Printf("upload link to %q: saving %q: %v", l.Path, name, err)
		return "", &uploadLinkError{http.StatusInternalServerError, uploadError(err)}
	}
	saved = got
	g.logUpload(l, ip, got, written, "")
	return got, nil
}

// refuseUpload answers an upload refused with err, and closes the
// connection after, rather than read the rest of a body refused (perhaps
// never coming) to use it again.
func refuseUpload(w http.ResponseWriter, err error) {
	code, msg := errorCode(err)
	w.Header().Set("Connection", "close")
	http.Error(w, msg, code)
}

// errorCode is the status to refuse err with.
func errorCode(err error) (int, string) {
	if e, ok := errors.AsType[*uploadLinkError](err); ok {
		return e.code, e.msg
	}
	return http.StatusInternalServerError, err.Error()
}

// serveUploadLink answers a request for the upload link l, with name what
// follows the token in the path: GET shows a browser the page (and tells
// curl how to use it), PUT uploads a file as name, and POST, the page's
// form without its script, the files picked.
func (g *server) serveUploadLink(w http.ResponseWriter, r *http.Request, l *shareLink, store *downloadStore, name string, page bool, ip string) {
	h := w.Header()
	if id := r.URL.Query().Get("u"); id != "" && name != "" {
		// A piece of an upload from the page (see share_chunks.go).
		switch r.Method {
		case http.MethodPut:
			g.receiveChunk(w, r, l, store, ip, name, id)
		case http.MethodHead:
			g.chunkHead(w, l, id)
		default:
			h.Set("Allow", "HEAD, PUT")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
		return
	}
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		if name != "" || !strings.HasSuffix(r.URL.Path, "/") {
			// The page sends files to names relative to it, so it's at the
			// link itself, ending in "/".
			if name != "" {
				h.Set("Location", "./")
			} else {
				h.Set("Location", path.Base(r.URL.Path)+"/")
			}
			w.WriteHeader(http.StatusSeeOther)
			return
		}
		if page {
			renderSharePage(w, http.StatusOK, g.uploadPage(l, nil))
			return
		}
		h.Set("Content-Type", "text/plain; charset=utf-8")
		fmt.Fprintf(w, "This link uploads files into %s/. Upload one with:\n\n    curl -T <file> <this link>\n", l.name())
	case http.MethodPut:
		if name == "" {
			http.Error(w, "Give the file's name after the link, as curl -T <file> <this link> does.", http.StatusBadRequest)
			return
		}
		got, err := g.receive(l, store, ip, name, stallReader{r.Body, http.NewResponseController(w)}, r.ContentLength)
		if err != nil {
			refuseUpload(w, err)
			return
		}
		h.Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusCreated)
		fmt.Fprintf(w, "Uploaded %s\n", got)
	case http.MethodPost:
		g.receiveForm(w, r, l, store, page, ip)
	default:
		h.Set("Allow", "GET, HEAD, PUT, POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// receiveForm saves the files posted with the upload page's form, each as
// it comes, rather than all of them first somewhere else.
func (g *server) receiveForm(w http.ResponseWriter, r *http.Request, l *shareLink, store *downloadStore, page bool, ip string) {
	r.Body = io.NopCloser(stallReader{r.Body, http.NewResponseController(w)})
	mr, err := r.MultipartReader()
	if err != nil {
		shareFail(w, page, http.StatusBadRequest, "Pick files to upload.")
		return
	}
	var sent []sentLine
	code := http.StatusOK
	for parts := 0; ; parts++ {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err == nil && parts == maxFormParts {
			// No more: each part, refused or not, is kept to say so.
			part.Close()
			sent = append(sent, sentLine{fmt.Sprintf("Only %d files can be sent at once: the rest weren't taken.", maxFormParts), true})
			code = http.StatusRequestEntityTooLarge
			break
		}
		if err != nil {
			sent = append(sent, sentLine{"The upload was cut off.", true})
			code = http.StatusBadRequest
			break
		}
		if part.FormName() != "file" || part.FileName() == "" {
			part.Close()
			continue
		}
		name := partName(part)
		got, err := g.receive(l, store, ip, name, part, -1)
		part.Close()
		if err != nil {
			c, msg := errorCode(err)
			sent = append(sent, sentLine{name + ": " + msg, true})
			code = c
			continue
		}
		sent = append(sent, sentLine{"Uploaded " + got, false})
	}
	if !page {
		h := w.Header()
		h.Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(code)
		for _, s := range sent {
			fmt.Fprintln(w, s.Text)
		}
		return
	}
	renderSharePage(w, code, g.uploadPage(l, sent))
}

// maxFormParts is the most parts a form posted through an upload link may
// have (files, or anything else): past that, the rest aren't read.
const maxFormParts = 100

// partName is the name of the file a form part holds, without any folders
// a browser put before it.
func partName(part *multipart.Part) string {
	return path.Base(strings.ReplaceAll(part.FileName(), `\`, "/"))
}

// uploadPage is the page an upload link shows a browser, with what was
// just sent, if anything.
func (g *server) uploadPage(l *shareLink, sent []sentLine) sharePage {
	n := g.shares.now(l)
	p := sharePage{Title: "Upload to " + l.name(), Heading: "Upload files to " + l.name(), Upload: true, Sent: sent}
	room := humanSize(max(0, n.MaxBytes-n.Bytes)) + " in all"
	if n.Max > 0 {
		left := max(0, n.Max-n.Count)
		room = fmt.Sprintf("%d more file%s, %s", left, map[bool]string{true: "", false: "s"}[left == 1], room)
		if left == 0 {
			p.Upload = false
			p.Error = errLinkFull.msg
		}
	}
	p.Meta = "It takes " + room + "."
	p.Notes = []string{"This link works for another " + timeLeft(g.shares.clock.Now(), n.Expires) +
		". Files are uploaded as they are; nothing already there is replaced, and you can't see what's there."}
	return p
}
