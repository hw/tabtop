package main

// Uploads through an upload link in pieces, which carry on after a lost
// connection: the upload page's script sends each file this way (curl -T
// sends it whole). Each piece is a PUT to the file's name, with
//
//	?u=<id>                       the upload's, made up by the page
//	Content-Range: bytes a-b/size where the piece goes in the file
//
// The first piece (a = 0) starts the upload, taking its place in the link's
// limits for the whole size at once; each one after must start where the
// file has got to; the last saves it, as receive does, and answers 201.
// Any other piece answers 204, and a piece that doesn't start where the
// file has got to, 409: both say where that is in Upload-Offset, as HEAD
// of the same address does, so a page whose connection was lost asks, and
// carries on from there. A piece cut off keeps what came of it.
//
// What has come is kept in a hidden temporary file, as for uploads from
// the files page, for partialKeep after the last piece; then, or once its
// link has ended, it's deleted, and its place in the link's limits freed.

import (
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"sync"
	"time"
)

// Uploads in pieces kept at once, through every link, and through any one:
// past that, new ones are refused till some finish or are given up. (So
// one link's holder can't take every place.)
const (
	maxLinkPartials        = 64
	maxLinkPartialsPerLink = 8
)

var chunkUploadID = regexp.MustCompile(`^[A-Za-z0-9_-]{16,64}$`)

// linkPartial is an upload in pieces through link, under way.
type linkPartial struct {
	link     *shareLink
	name, ip string
	part     partialUpload // its temporary file, and how much it holds
	busy     bool          // a piece is being written
	last     time.Time     // when the last piece ended
	timer    lifecycleTimer
}

// linkPartials are the uploads in pieces under way, by link ID and upload
// id.
type linkPartials struct {
	mu       sync.Mutex
	m        map[string]*linkPartial
	starting int // places taken by uploads starting, not yet in m
	// those, by link ID
	startingFor map[string]int
	// Uploads finished lately, by the same keys, so a page that never got
	// the answer to its last piece (its connection lost) and asks again is
	// told it's done, rather than starting it again (see recordDone).
	done map[string]linkDone
}

// linkDone is an upload in pieces that's been saved, as name.
type linkDone struct {
	name string
	size int64
	at   time.Time
}

// How many finished uploads are remembered, and for how long.
const maxLinkDone = 256

// recordDone remembers that the upload key was saved as name, forgetting
// those older than partialKeep, and the oldest past maxLinkDone. ps.mu
// must be held.
func (ps *linkPartials) recordDoneLocked(key, name string, size int64, now time.Time) {
	if ps.done == nil {
		ps.done = map[string]linkDone{}
	}
	for k, d := range ps.done {
		if now.Sub(d.at) >= partialKeep {
			delete(ps.done, k)
		}
	}
	for len(ps.done) >= maxLinkDone {
		oldest := ""
		for k, d := range ps.done {
			if oldest == "" || d.at.Before(ps.done[oldest].at) {
				oldest = k
			}
		}
		delete(ps.done, oldest)
	}
	ps.done[key] = linkDone{name, size, now}
}

// drop gives up the upload kept as key, if it's p and not being written:
// deleting what it had, and freeing its place in its link's limits.
func (g *server) dropLinkPartial(key string, p *linkPartial) {
	ps := &g.shares.partials
	ps.mu.Lock()
	if ps.m[key] != p || p.busy {
		ps.mu.Unlock()
		return
	}
	delete(ps.m, key)
	if p.timer != nil {
		p.timer.Stop()
	}
	ps.mu.Unlock()
	g.transfers.removePartial(&p.part)
	g.shares.settle(p.link, p.part.size, "", "")
}

// doneStarting gives back a place an upload starting through the link id
// took; ps.mu is held.
func (ps *linkPartials) doneStarting(id string) {
	if ps.startingFor[id]--; ps.startingFor[id] <= 0 {
		delete(ps.startingFor, id)
	}
}

// forLink counts the uploads in pieces kept, or starting, through the link
// id; ps.mu is held.
func (ps *linkPartials) forLink(id string) int {
	n := ps.startingFor[id]
	for _, p := range ps.m {
		if p.link.ID == id {
			n++
		}
	}
	return n
}

// dropEndedLinkPartials deletes the uploads in pieces kept through links
// that have been revoked, or have run out, with their places.
func (g *server) dropEndedLinkPartials() {
	if g.shares == nil {
		return
	}
	ps := &g.shares.partials
	ps.mu.Lock()
	candidates := map[string]*linkPartial{}
	for k, p := range ps.m {
		candidates[k] = p
	}
	ps.mu.Unlock()
	now := g.shares.clock.Now()
	for k, p := range candidates {
		if p.link.revoked.Load() || !now.Before(g.shares.now(p.link).Expires) {
			g.dropLinkPartial(k, p)
		}
	}
}

// removeLinkPartials deletes every upload in pieces kept, as the gateway
// stops.
func (g *server) removeLinkPartials() {
	if g.shares == nil {
		return
	}
	ps := &g.shares.partials
	ps.mu.Lock()
	var gone []*linkPartial
	for k, p := range ps.m {
		delete(ps.m, k)
		if p.timer != nil { // nil while its first piece comes
			p.timer.Stop()
		}
		gone = append(gone, p)
	}
	ps.mu.Unlock()
	for _, p := range gone {
		g.transfers.removePartial(&p.part)
	}
}

// parseContentRange reads "bytes a-b/size".
func parseContentRange(h string) (a, b, size int64, ok bool) {
	if _, err := fmt.Sscanf(h, "bytes %d-%d/%d", &a, &b, &size); err != nil {
		return 0, 0, 0, false
	}
	return a, b, size, a >= 0 && a <= b && b < size
}

// chunkOffset says where the upload id through l has got to.
func (g *server) chunkOffset(l *shareLink, id string) int64 {
	ps := &g.shares.partials
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if p := ps.m[l.ID+"/"+id]; p != nil {
		return p.part.held
	}
	if d, ok := ps.done[l.ID+"/"+id]; ok {
		return d.size
	}
	return 0
}

// receiveChunk saves a piece of the upload id as name through l, from ip,
// and answers as the top of this file says.
func (g *server) receiveChunk(w http.ResponseWriter, r *http.Request, l *shareLink, store *downloadStore, ip, name, id string) {
	h := w.Header()
	h.Set("Content-Type", "text/plain; charset=utf-8")
	fail := func(err error) {
		refuseUpload(w, err)
	}
	a, b, size, ok := parseContentRange(r.Header.Get("Content-Range"))
	if !ok || !chunkUploadID.MatchString(id) || r.ContentLength != b-a+1 {
		http.Error(w, "A piece needs ?u=<id>, a Content-Range of bytes a-b/size, and a Content-Length to match.", http.StatusBadRequest)
		return
	}
	name, ok = linkFileName(name)
	if !ok {
		http.Error(w, "That name can't be used for a file.", http.StatusBadRequest)
		return
	}
	key := l.ID + "/" + id
	ps := &g.shares.partials
	if a == 0 {
		// A file starting: first, those of links ended meanwhile go; and
		// the same file, started before through this link from here and
		// left (its page reloaded, say), gives way to it, with its place
		// and the room it held in the link's limits.
		g.dropEndedLinkPartials()
		ps.mu.Lock()
		var stale []string
		for k, p := range ps.m {
			if k != key && p.link.ID == l.ID && p.name == name && p.ip == ip && p.part.size == size && !p.busy {
				stale = append(stale, k)
			}
		}
		ps.mu.Unlock()
		for _, k := range stale {
			ps.mu.Lock()
			p := ps.m[k]
			ps.mu.Unlock()
			if p != nil {
				g.dropLinkPartial(k, p)
			}
		}
	}
	offsetIs := func(n int64, code int, msg string) {
		h.Set("Upload-Offset", strconv.FormatInt(n, 10))
		w.WriteHeader(code)
		if msg != "" {
			fmt.Fprintln(w, msg)
		}
	}

	reserved := false // a place in ps.starting is held
	ps.mu.Lock()
	if d, ok := ps.done[key]; ok {
		// Saved already: its last piece again, from a page that didn't hear.
		ps.mu.Unlock()
		if d.size == size && b+1 == size {
			offsetIs(size, http.StatusCreated, "Uploaded "+d.name)
		} else {
			offsetIs(d.size, http.StatusConflict, "That upload has been saved already.")
		}
		return
	}
	p := ps.m[key]
	switch {
	case p == nil && a != 0:
		ps.mu.Unlock()
		offsetIs(0, http.StatusConflict, "That upload isn't going: start it again from the beginning.")
		return
	case p != nil && (p.busy || a != p.part.held || p.name != name || p.part.size != size):
		held := p.part.held
		ps.mu.Unlock()
		offsetIs(held, http.StatusConflict, "That's not where the upload has got to.")
		return
	case p == nil && len(ps.m)+ps.starting >= maxLinkPartials:
		ps.mu.Unlock()
		http.Error(w, "Too many uploads are going; try again later.", http.StatusServiceUnavailable)
		return
	case p == nil && ps.forLink(l.ID) >= maxLinkPartialsPerLink:
		ps.mu.Unlock()
		http.Error(w, "Too many uploads are going through this link; let some finish, then try again.", http.StatusServiceUnavailable)
		return
	}
	if p != nil {
		p.busy = true
		p.timer.Stop()
	} else {
		// Its place, taken now, so uploads starting at once can't all
		// pass the check above; given back once it's in ps.m, or isn't.
		ps.starting++
		if ps.startingFor == nil {
			ps.startingFor = map[string]int{}
		}
		ps.startingFor[l.ID]++
		reserved = true
		defer func() {
			if reserved {
				ps.mu.Lock()
				ps.starting--
				ps.doneStarting(l.ID)
				ps.mu.Unlock()
			}
		}()
	}
	ps.mu.Unlock()

	var u *upload
	if p == nil {
		// Its place in the link's limits, for all of it.
		if err := g.shares.reserve(l, size); err != nil {
			fail(err)
			return
		}
		if err := g.shares.grow(l, size); err != nil {
			g.shares.settle(l, 0, "", "")
			fail(err)
			return
		}
		var err error
		if u, err = store.startUpload(l.Path); err != nil {
			g.shares.settle(l, size, "", "")
			fail(&uploadLinkError{http.StatusInternalServerError, uploadError(err)})
			return
		}
		if free, ok := g.transfers.reclaimPartials(u.f, size); ok && size > free {
			u.abort()
			g.shares.settle(l, size, "", "")
			fail(&uploadLinkError{http.StatusInsufficientStorage, "There isn't room for it on the disk."})
			return
		}
		p = &linkPartial{link: l, name: name, ip: ip, busy: true,
			part: partialUpload{rootDir: g.downloadsDir, dir: l.Path, tmp: u.tmp, size: size}}
		ps.mu.Lock()
		if ps.m == nil {
			ps.m = map[string]*linkPartial{}
		}
		ps.starting--
		ps.doneStarting(l.ID)
		reserved = false
		if ps.m[key] != nil {
			// Started twice at once: this one gives way.
			ps.mu.Unlock()
			u.abort()
			g.shares.settle(l, size, "", "")
			offsetIs(0, http.StatusConflict, "That upload has started already.")
			return
		}
		ps.m[key] = p
		ps.mu.Unlock()
	} else if u, _ = store.resume(&p.part, size); u == nil {
		// Its file has gone, or changed: it starts again.
		ps.mu.Lock()
		p.busy = false
		ps.mu.Unlock()
		g.dropLinkPartial(key, p)
		offsetIs(0, http.StatusConflict, "What had come of that upload has gone: start it again from the beginning.")
		return
	}

	// The piece, as far as it comes.
	err := g.writePiece(u, l, stallReader{io.LimitReader(r.Body, b-a+1), http.NewResponseController(w)})
	st, serr := u.f.Stat()
	held := int64(0)
	if serr == nil {
		held = st.Size()
	}
	if err == nil && held != b+1 {
		err = &uploadLinkError{http.StatusBadRequest, "The piece was cut off."}
	}
	if err == nil && held == size {
		// It stays in ps.m, busy, until it's saved: a page asking meanwhile
		// is told it has all of it, then that it's done.
		saved := ""
		defer func() {
			ps.mu.Lock()
			delete(ps.m, key)
			if saved != "" {
				ps.recordDoneLocked(key, saved, size, g.shares.clock.Now())
			}
			ps.mu.Unlock()
			g.shares.settle(l, size, saved, ip)
		}()
		if st, err := store.stat(l.Path); err != nil || !l.matches(st) {
			u.abort()
			fail(&uploadLinkError{http.StatusNotFound, "The folder this link uploads to has gone."})
			return
		}
		got, err := u.finish(name, false)
		if err != nil {
			log.Printf("upload link to %q: saving %q: %v", l.Path, name, err)
			fail(&uploadLinkError{http.StatusInternalServerError, uploadError(err)})
			return
		}
		saved = got
		g.logUpload(l, ip, got, size, ", in pieces")
		w.WriteHeader(http.StatusCreated)
		fmt.Fprintf(w, "Uploaded %s\n", got)
		return
	}
	// Kept, for the next piece, or to carry on from.
	identity, _ := u.f.Stat()
	u.f.Close()
	ps.mu.Lock()
	p.part.identity, p.part.held, p.busy, p.last = identity, held, false, g.shares.clock.Now()
	p.timer = g.shares.clock.AfterFunc(partialKeep, func() { g.dropLinkPartial(key, p) })
	ps.mu.Unlock()
	if serr != nil || l.revoked.Load() {
		g.dropLinkPartial(key, p)
	}
	if err != nil {
		code, msg := errorCode(err)
		offsetIs(held, code, msg)
		return
	}
	offsetIs(held, http.StatusNoContent, "")
}

// writePiece writes what body holds to u, unless l has ended.
func (g *server) writePiece(u *upload, l *shareLink, body io.Reader) error {
	buf := make([]byte, 256<<10)
	for {
		n, rerr := body.Read(buf)
		if n > 0 {
			if l.revoked.Load() {
				return &uploadLinkError{http.StatusNotFound, "This link has ended."}
			}
			if _, err := u.Write(buf[:n]); err != nil {
				return &uploadLinkError{http.StatusInsufficientStorage, uploadError(err)}
			}
		}
		if rerr == io.EOF {
			return nil
		}
		if rerr != nil {
			return &uploadLinkError{http.StatusBadRequest, "The piece was cut off."}
		}
	}
}

// chunkHead answers HEAD for the upload id: where it has got to.
func (g *server) chunkHead(w http.ResponseWriter, l *shareLink, id string) {
	w.Header().Set("Upload-Offset", strconv.FormatInt(g.chunkOffset(l, id), 10))
	w.WriteHeader(http.StatusNoContent)
}
