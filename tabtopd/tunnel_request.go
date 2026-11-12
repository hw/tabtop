package main

// Authenticated tunnel request routing, file handlers and desktop bridging.

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/coder/websocket"
	"io"
	"log"
	"net/http"
	"path"
	"strings"
	"time"
)

const (
	// Size of the data messages a file is sent in.
	fileChunk = 256 << 10
	// How many of a file's chunks may be sent before the page acknowledges
	// them, and how long the server waits for an acknowledgement.
	fileWindow = 32
	// The most a file request asks for a part of the file may get.
	maxFileRange = 16 << 20
	fileStall    = 2 * time.Minute
)

type tunnelRequest struct {
	// Type is the request (see tunnelRoutes for them all).
	Type string `json:"type"`

	// --- Files ---
	Path  string   `json:"path,omitempty"`
	Name  string   `json:"name,omitempty"`  // upload, mkdir, create: the file's or folder's name, in the folder at Path; rename: the new name; end-session: the session's handle
	Size  int64    `json:"size,omitempty"`  // upload: its size
	Names []string `json:"names,omitempty"` // zip: what to put in it, in the folder at Path
	To    string   `json:"to,omitempty"`    // move: the folder to move what's at Path into
	// upload: replace a file that has the name, rather than save under a
	// free one
	Replace bool `json:"replace,omitempty"`
	// upload: the id of one cut off, to carry on with (see keepPartial)
	Resume string `json:"resume,omitempty"`
	// upload with Replace, and the edits below: only if the file there is
	// still as the page read it, with this version (see fileVersion) and
	// IfSize (see changed); reads: only of the file as it was, if given
	// (see changedSinceRead)
	IfMtime string `json:"if_mtime,omitempty"`
	IfSize  int64  `json:"if_size,omitempty"`
	// file: only Length bytes of it, from Offset (see maxFileRange); also
	// file-search's start, and preview-resource's media range
	Offset int64 `json:"offset,omitempty"`
	Length int64 `json:"length,omitempty"`
	// cleanup: only say what it would delete
	DryRun bool `json:"dry_run,omitempty"`

	// --- ZIP archives ---
	Entries []int `json:"entries,omitempty"` // zip-extract, zip-download: entry ordinals from the preview

	// --- EPUB books ---
	// epub: a chapter or picture of the book at Path, by its path in the
	// book, rather than the book (see epub.go)
	Item string `json:"item,omitempty"`
	// epub: what uses each of the book's pictures, rather than the book
	Uses bool `json:"uses,omitempty"`
	// epub-edit: the book's new title and author (see epub_edit.go);
	// RegenerateTOC rebuilds the contents list from chapter headings
	Title         string `json:"title,omitempty"`
	Creator       string `json:"creator,omitempty"`
	RegenerateTOC bool   `json:"regenerate_toc,omitempty"`
	// epub-edit: a picture already in the book, by its path in it, to name
	// the cover, rather than one sent
	CoverItem string `json:"cover_item,omitempty"`
	// epub-edit: pictures in the book to remove from it, by their paths in
	// it (cover pages showing one are made to show the cover instead)
	RemoveItems []string `json:"remove_items,omitempty"`

	// --- Bytes (the hex view; see hex_edit.go) ---
	// file-patch: runs of bytes to write over the file's
	Patches []bytePatch `json:"patches,omitempty"`
	// file-patch: the SHA-256, as hex, of the bytes the page saw where the
	// runs go, one run's after another's: they must be there still
	IfBytes string `json:"if_bytes,omitempty"`
	// file-search: the bytes to look for, and which bits of them matter, as
	// hex; from Offset, backwards with Backward
	Pattern  string `json:"pattern,omitempty"`
	Mask     string `json:"mask,omitempty"`
	Backward bool   `json:"backward,omitempty"`

	// --- SQLite ---
	// sqlite: what to ask of the database at Path (see sqlite.go)
	SQLite *sqliteQuery `json:"sqlite,omitempty"`

	// --- The web: fetching, and previews' external resources ---
	// fetch: the address to fetch into the folder at Path (or, with Name,
	// the id of a fetch to follow); preview-resource: the resource's
	URL string `json:"url,omitempty"`
	// preview-resource: image (default), css, font or ranged media.
	Resource string `json:"resource,omitempty"`

	// --- Share links ---
	// share: how long the link lasts, in seconds, and how many downloads
	// it allows (0 for no limit)
	Expires int64 `json:"expires,omitempty"`
	Max     int   `json:"max,omitempty"`
	// share: an upload link, into the folder at Path, rather than a
	// download link; Max is then files, and MaxBytes what they may come to
	// in all
	Upload   bool  `json:"upload,omitempty"`
	MaxBytes int64 `json:"max_bytes,omitempty"`
	// share, reshare: the link's label
	Label string `json:"label,omitempty"`
	// share: for downloading the file now, from this page, over HTTPS (a
	// preview's Direct Download): the link, for one download, is counted
	// as made, and comes with a ticket that fetches it (see ticket)
	Direct bool `json:"direct,omitempty"`
	// reshare-many: set the label too
	Relabel bool `json:"relabel,omitempty"`
}

type fileEntry struct {
	Name     string `json:"name"`
	Dir      bool   `json:"dir,omitempty"`
	Size     string `json:"size,omitempty"`
	Bytes    int64  `json:"bytes,omitempty"` // Size exactly
	Modified string `json:"modified"`
	Time     int64  `json:"time"` // Modified, in Unix seconds
}

// tunnelWS accepts a tunnel and runs its handshake: a login, or a
// session's request. Accept rejects cross-origin requests, as for every
// WebSocket here.
func (g *server) tunnelWS(w http.ResponseWriter, r *http.Request) {
	ip := g.clientIP(r)
	handshaken, ok := g.handshakes.start(limitKey(ip))
	if !ok {
		http.Error(w, "too many connections being set up", http.StatusServiceUnavailable)
		return
	}
	defer handshaken()
	c, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	untrack, ok := g.drain.add(c)
	if !ok {
		// Stopping: as lost, to try again once it's back.
		c.Close(websocket.StatusServiceRestart, "")
		return
	}
	defer untrack()
	defer c.CloseNow()
	c.SetReadLimit(tunnelHelloLimit)
	alive, stop := context.WithCancel(context.Background())
	defer stop()
	interval := g.pingInterval
	if interval == 0 {
		interval = pingInterval
	}
	go keepalive(alive, c, interval)

	ctx, cancel := context.WithTimeout(context.Background(), handshakeTimeout)
	typ, hello, err := c.Read(ctx)
	cancel()
	if err != nil {
		return
	}
	if typ != websocket.MessageBinary || len(hello) < 2 || hello[0] != tunnelVersion {
		c.Close(websocket.StatusPolicyViolation, "unsupported tunnel version; reload the page")
		return
	}
	switch hello[1] {
	case helloLogin:
		g.loginTunnel(c, ip, browserName(r.Header.Get("User-Agent")), hello[2:])
	case helloSession:
		t, session := g.sessionTunnel(c, hello[2:])
		if t != nil {
			t.req = r
			g.serveRequest(t, session, ip, handshaken)
		}
	default:
		c.Close(websocket.StatusPolicyViolation, "bad hello")
	}
}

// The first encrypted request proves possession of the session secret. Until
// then, retain handshake limits and leave the session's idle timer and uses alone.
func (g *server) serveRequest(t *tunnel, session, ip string, authenticated func()) {
	ctx, cancel := context.WithTimeout(context.Background(), handshakeTimeout)
	typ, msg, err := t.Read(ctx)
	cancel()
	var req tunnelRequest
	if err != nil || typ != websocket.MessageText || json.Unmarshal(msg, &req) != nil {
		t.Close(websocket.StatusPolicyViolation, "bad request")
		return
	}
	detach, err := g.attach(session, ip, t)
	if err != nil {
		code := closeLogin
		if errors.Is(err, errTooManyTunnels) {
			code = websocket.StatusTryAgainLater
		}
		t.Close(code, err.Error())
		return
	}
	defer detach()
	authenticated()
	r := &tunnelResponder{t: t}
	// Gate access before dispatch, including requests from cached pages or
	// clients that bypass navigation (see tunnelRoutes).
	route, ok := tunnelRoutes[req.Type]
	switch {
	case !ok:
		r.fail("Unknown request.")
	case route.files && g.fsOff:
		r.fail("File support is turned off (WEB_FS=0).")
	default:
		route.serve(g, &tunnelCall{t: t, req: req, session: session, ip: ip, r: r})
	}
}

// receiveData is size bytes the page sends after its request (once it's
// accepted), as data messages, held in memory: for what's small enough
// (see maxMarkdown and maxEpubPicture). Not ok if the tunnel went, or sent
// something else or too much, when it's closed, saying why.
func receiveData(t *tunnel, size int64, why string) ([]byte, bool) {
	data := make([]byte, 0, size)
	if size > 0 {
		t.c.SetReadLimit(fileChunk + tunnelOverhead)
	}
	for int64(len(data)) < size {
		ctx, cancel := context.WithTimeout(context.Background(), fileStall)
		typ, p, err := t.Read(ctx)
		cancel()
		if err != nil {
			return nil, false
		}
		if typ != websocket.MessageBinary || int64(len(data)+len(p)) > size {
			t.Close(websocket.StatusPolicyViolation, why)
			return nil, false
		}
		data = append(data, p...)
	}
	return data, true
}

// tunnelMarkdown answers a markdown request: the file at req.Path, as
// HTML for the preview's frame (see markdown.go), in {"html": ...}.
func (g *server) tunnelMarkdown(t *tunnel, req tunnelRequest, r *tunnelResponder) {
	if req.Path == "" {
		// Text being edited (see the editor in preview.js), req.Size bytes
		// of it, sent after the request as data, as an upload's is: too
		// much, as JSON, for a request.
		if req.Size < 0 || req.Size > maxMarkdown {
			r.fail(errMarkdownTooBig.Error())
			return
		}
		if !r.accept(nil) {
			return
		}
		text, ok := receiveData(t, req.Size, "bad text")
		if !ok {
			return
		}
		html, err := renderMarkdownIsolated(bytes.NewReader(text))
		if err != nil {
			r.fail(err.Error())
			return
		}
		r.finish(map[string]any{"html": html})
		return
	}
	opened, err := openDownloadsFile(g.downloadsDir, req.Path)
	if err != nil {
		r.fail(err.Error())
		return
	}
	defer opened.Close()
	f, st := opened.file, opened.info
	if st.Size() > maxMarkdown {
		r.fail(errMarkdownTooBig.Error())
		return
	}
	html, err := renderMarkdownIsolated(f)
	if err != nil {
		r.fail(err.Error())
		return
	}
	r.finish(map[string]any{"html": html})
}

// revokeShares revokes the share links that match, if links are on.
func (g *server) revokeShares(match func(*shareLink) bool) int {
	// Then the uploads in pieces through those links go, as they've ended.
	defer g.dropEndedLinkPartials()
	if g.shares == nil {
		return 0
	}
	return g.shares.revoke(match)
}

// tunnelShare makes a share link to the file or folder at req.Path, for
// req.Expires seconds and req.Max downloads. The reply has the token, which
// the gateway doesn't keep: the page makes the URL from it, with its own
// address, rather than one the gateway would have to guess from behind a
// proxy.
func (g *server) tunnelShare(req tunnelRequest, session, ip string, r *tunnelResponder) {
	if g.shares == nil {
		r.fail("Share links are turned off (WEB_SHARE=0).")
		return
	}
	if req.Direct && (req.Upload || req.Max != 1) {
		r.fail("A direct download is of a file, once.")
		return
	}
	life := time.Duration(req.Expires) * time.Second
	if life < time.Minute || life > maxShareLife || req.Max < 0 || req.Max > 1000 ||
		req.Upload && (req.MaxBytes <= 0 || req.MaxBytes > maxUploadLinkBytes) || !req.Upload && req.MaxBytes != 0 {
		r.fail("That's not a lifetime or limit a link can have.")
		return
	}
	store, err := openDownloadStore(g.downloadsDir)
	if err != nil {
		r.fail("The downloads folder is missing.")
		return
	}
	defer store.Close()
	// Cleaned first, so "./" or "a/.." are Downloads itself too.
	name := path.Clean(strings.Trim(req.Path, "/"))
	if name == "" {
		name = "."
	}
	if name == "." && !req.Upload {
		r.fail("Share a file or folder in Downloads, not Downloads itself.")
		return
	}
	f, st, err := store.open(name)
	if err != nil {
		r.fail("Not found.")
		return
	}
	f.Close()
	if req.Upload && !st.IsDir() {
		r.fail("Files can only be uploaded into a folder.")
		return
	}
	label, ok := shareLabel(req.Label)
	if !ok {
		r.fail(fmt.Sprintf("A label is one line of at most %d characters.", maxLabel))
		return
	}
	token, l, err := g.shares.create(path.Clean(name), st, shareSpec{Label: label, Life: life, Max: req.Max, Upload: req.Upload, MaxBytes: req.MaxBytes, Once: req.Direct},
		sessionHandle(session), ip)
	if errors.Is(err, errTooManyShares) {
		r.fail(err.Error())
		return
	}
	if err != nil {
		r.fail("The link couldn't be made.")
		return
	}
	// As made: read under the lock, as it can be changed (by another page)
	// as soon as it's made.
	n := g.shares.now(l)
	ticket := ""
	if req.Direct {
		// Counted now, for this page's own download, which the ticket
		// lets fetch the file, rather than the link's page.
		if err := g.shares.use(l, ip, false); err != nil {
			r.fail("The link couldn't be made.")
			return
		}
		g.logShareUse(l, ip)
		ticket = g.shares.ticket(l, ip)
	}
	if l.Upload {
		log.Printf("upload link to %q made from %s, for %s, %s files, up to %s", l.Path, ip, life, maxText(req.Max), humanSize(req.MaxBytes))
		g.act(session, "share", ip, "made an upload link to %s%s, for %s, %s, up to %s", folderText(l.Path), labelQuote(label), lifeText(life), countText(req.Max, "file"), humanSize(req.MaxBytes))
	} else {
		log.Printf("share link to %q made from %s, for %s, %s", l.Path, ip, life, maxText(req.Max))
		g.act(session, "share", ip, "made a share link to %s%s, for %s, %s", linkTarget(l), labelQuote(label), lifeText(life), countText(req.Max, "download"))
	}
	res := map[string]any{"token": token, "handle": l.handle(), "name": l.name(), "dir": l.Dir, "upload": l.Upload, "expires": n.Expires}
	if ticket != "" {
		res["ticket"] = ticket
	}
	r.finish(res)
}

// noMicMsg is the reply when there's no microphone (WEB_MIC=0, or host
// audio), which audio.js takes as a reason to hide its button.
const noMicMsg = "There's no microphone here."

// bridgeDesktop connects a session tunnel to Xvnc, or the VNC server at
// -vnc-addr. The session is the login: Xvnc listens on a socket only the
// desktop user can open and asks for none, so noVNC goes straight to the
// desktop, and a server elsewhere is given the login password, if there's
// one for it (see rfbauth.go). Logging out, or the session ending, closes
// it.
func (g *server) bridgeDesktop(t *tunnel, session, ip string) {
	cooling := g.vncBackoff.begin()
	reserved := true
	defer func() {
		if reserved {
			g.vncBackoff.release()
		}
	}()
	if cooling && g.vncX509 {
		// Logged once, when it failed (see vncBackoff).
		t.Close(websocket.StatusTryAgainLater, "cannot log in to the desktop")
		return
	}
	vnc, err := g.dialVNC()
	if err != nil {
		log.Printf("cannot reach VNC server: %v", err)
		t.Close(websocket.StatusInternalError, "cannot reach the desktop")
		return
	}
	conn := &tunnelConn{t: t}
	conn.SetDeadline(time.Now().Add(rfbHandshakeTimeout))
	// With a password for it (VNC_UPSTREAM_PASSWORD), the VNC server gets
	// that, and noVNC no security (see rfbauth.go). The login's own
	// password is never sent anywhere.
	// While cooling down without VNC_X509, the gateway doesn't log in, and
	// noVNC asks for the server's password (see vncBackoff).
	if password := g.vncPassword(); !cooling && (password != "" || g.vncX509) {
		if password == "" {
			vnc.Close()
			log.Printf("VNC_X509 needs VNC_UPSTREAM_PASSWORD, and there's none")
			t.Close(websocket.StatusInternalError, "cannot log in to the desktop")
			return
		}
		result, authErr := g.vncSecurity(vnc, conn, password)
		vnc, err = result.conn, authErr
		switch {
		case result.outcome == vncAuthenticated:
			g.vncBackoff.record(nil)
			g.vncBackoff.succeeded()
		case result.outcome == vncPasswordRejected && err == nil:
			g.vncBackoff.record(errVNCPasswordRejected)
		case err != nil && !errors.Is(err, errPageHandshake):
			g.vncBackoff.record(err)
		}
		if err != nil {
			if errors.Is(err, errPageHandshake) {
				// The page went part way: not a failed login.
				log.Printf("desktop tunnel from %s: %v", ip, err)
			} else {
				log.Printf("logging in to the VNC server: %v; not trying again for %v", err, g.vncBackoff.failed())
			}
			if vnc != nil {
				vnc.Close()
			}
			t.Close(websocket.StatusInternalError, "cannot log in to the desktop")
			return
		}
		if result.outcome == vncPasswordRejected {
			log.Printf("noVNC asks for the VNC server's password; VNC_UPSTREAM_PASSWORD isn't tried again for %v", g.vncBackoff.failed())
		}
	}
	defer vnc.Close()
	conn.SetDeadline(time.Time{})
	g.vncBackoff.release()
	reserved = false
	log.Printf("desktop tunnel from %s opened", ip)
	g.audio.link(session, ip)
	defer g.audio.unlink(session, ip)

	done := make(chan struct{}, 2)
	go func() { io.Copy(vnc, conn); done <- struct{}{} }()
	go func() { io.Copy(conn, vnc); done <- struct{}{} }()
	<-done
	conn.Close()
	vnc.Close()
	<-done
	log.Printf("desktop tunnel from %s closed", ip)
}

// tunnelFiles answers a list request with the directory's entries, and a
// file request with the file's name and size, then its contents in data
// messages.
func (g *server) tunnelFiles(t *tunnel, req tunnelRequest, r *tunnelResponder) {
	opened, err := openDownloadsItem(g.downloadsDir, req.Path)
	if err != nil {
		r.fail(err.Error())
		return
	}
	defer opened.Close()
	store, f, st, name := opened.store, opened.file, opened.info, opened.name

	if req.Type == "list" {
		if !st.IsDir() {
			r.fail("Not a folder.")
			return
		}
		entries, truncated, err := store.listDir(name, f)
		if err != nil {
			r.fail("Not found.")
			return
		}
		out := make([]fileEntry, 0, len(entries))
		for _, e := range entries {
			out = append(out, fileEntry{Name: strings.TrimSuffix(e.Name, "/"), Dir: e.dir, Size: e.Size, Bytes: e.bytes,
				Modified: e.Modified, Time: e.time})
		}
		res := map[string]any{"entries": out, "truncated": truncated, "max": maxListing, "tz": g.timeZone, "share": g.shares != nil, "fetch": g.fetches != nil}
		if free, total, ok := g.transfers.uploadRoom(f); ok {
			res["free"], res["total"] = free, total
		}
		r.finish(res)
		return
	}

	if !st.Mode().IsRegular() {
		r.fail("Not a file.")
		return
	}
	// A part of it, with Length: from Offset, as much as there is, up to
	// maxFileRange; and with IfMtime, only of the file as it was (the PDF
	// preview reads a file in parts, which mustn't come from two versions).
	from, n := int64(0), st.Size()
	if req.Length != 0 {
		if req.Offset < 0 || req.Length < 0 || req.Length > maxFileRange || req.Offset > st.Size() {
			r.fail("That's not a part of the file.")
			return
		}
		from, n = req.Offset, min(req.Length, st.Size()-req.Offset)
	}
	if req.changedSinceRead(st) {
		r.fail(errChangedSince.Error())
		return
	}
	if !r.accept(map[string]any{"name": st.Name(), "size": st.Size(), "mtime": fileVersion(st), "offset": from, "length": n}) {
		return
	}
	w := newChunkWriter(t)
	defer w.stop()
	if _, err := io.CopyN(w, io.NewSectionReader(f, from, n), n); err != nil {
		w.fail(err)
		return
	}
	if w.flush() == nil {
		r.finish(nil)
	}
}

func writeJSON(c msgConn, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), tunnelTimeout)
	defer cancel()
	return c.Write(ctx, websocket.MessageText, b)
}

// Session tokens are 32 random bytes, and sessionIDLen characters long.
var sessionIDLen = base64.RawURLEncoding.EncodedLen(32)

func newToken() string {
	b := make([]byte, 32)
	rand.Read(b) // can't fail: since Go 1.24, it crashes the program instead
	return base64.RawURLEncoding.EncodeToString(b)
}
