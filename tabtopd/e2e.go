package main

// The page scripts under /tabtop/ (with the noble libraries'
// cryptography), the files page (a script that lists, fetches, uploads and
// deletes files through the tunnel), and /tunnel (see tunnel.go), which
// logs in or answers a session's request.

import (
	"bytes"
	"context"
	"crypto/rand"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"html/template"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
)

const (
	// Size of the data messages a file is sent in.
	fileChunk = 256 << 10
	// How many of a file's chunks may be sent before the page acknowledges
	// them, and how long the server waits for an acknowledgement.
	fileWindow = 32
	fileStall  = 2 * time.Minute
	// The downloads page loads its script and talks to the tunnel. It
	// registers download-sw.js and opens its downloads in a hidden frame;
	// blob: is for saving files held in memory where there's no service
	// worker, and for previews (see preview.js), which never use a frame.
	filesCSP = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; " +
		"img-src 'self' data: blob:; media-src blob:; worker-src 'self'; frame-src 'self'; form-action 'none'; frame-ancestors 'none'"
	// The download service worker fetches nothing itself.
	downloadSWCSP = "default-src 'none'"
)

//go:embed transfer.js folder-model.js osc.js tunnel.js tunnel-protocol.js tunnel-crypto.js session.js session-state.js login-ui.js file-format.js sessions-view.js novnc.js files.js download-sw.js drop.js ui.js nav.js requests.js preview.js reconnect.js download.js expiry.js
var e2eFiles embed.FS

// The files of the noble libraries that tunnel.js imports, directly or
// through each other, from -noble-dir: @noble/ciphers for
// ChaCha20-Poly1305, and @noble/curves for X25519 and @noble/hashes for
// SHA-2 and HKDF where the browser's WebCrypto can't do them. The
// Dockerfile's noble stage copies the same list.
var nobleFiles = []string{
	"ciphers/chacha.js", "ciphers/_arx.js", "ciphers/_poly1305.js", "ciphers/utils.js",
	"curves/ed25519.js", "curves/utils.js", "curves/abstract/curve.js", "curves/abstract/edwards.js",
	"curves/abstract/fft.js", "curves/abstract/frost.js", "curves/abstract/hash-to-curve.js",
	"curves/abstract/modular.js", "curves/abstract/montgomery.js", "curves/abstract/oprf.js",
	"hashes/sha2.js", "hashes/_md.js", "hashes/_u64.js", "hashes/hkdf.js", "hashes/hmac.js", "hashes/utils.js",
}

// noblePath is where the noble files are served, under /tabtop/ (see
// assetSet). tunnel.js is served with its "./noble/" imports pointing there.
func (g *server) noblePath() string { return g.noble.path(g.nobleAssets()) }

func (g *server) nobleAssets() assets { return assets{"noble", g.nobleDir, nobleFiles} }

// scripts serves the page scripts under /tabtop/, and the desktop's
// stylesheet for them.
func (g *server) scripts(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Content-Type", "text/javascript; charset=utf-8")
	h.Set("Cache-Control", "no-cache, no-transform")
	h.Set("X-Content-Type-Options", "nosniff")
	name := strings.TrimPrefix(r.URL.Path, "/tabtop/")
	switch {
	case name == "audio.js":
		if g.audio == nil {
			io.WriteString(w, "// Desktop audio is turned off (WEB_AUDIO=0).\n")
			return
		}
		w.Write(audioJS)
	case name == "tunnel-crypto.js":
		js, _ := e2eFiles.ReadFile(name)
		w.Write(bytes.ReplaceAll(js, []byte(`"./noble/`), []byte(`"./`+g.noblePath()+`/`)))
	case name == "transfer.js" || name == "folder-model.js" || name == "osc.js" || name == "tunnel.js" || name == "tunnel-protocol.js" || name == "session-state.js" || name == "session.js" || name == "login-ui.js" || name == "file-format.js" || name == "sessions-view.js" || name == "novnc.js" || name == "files.js" || name == "drop.js" || name == "ui.js" || name == "nav.js" ||
		name == "requests.js" || name == "preview.js" || name == "reconnect.js" || name == "download.js" || name == "expiry.js":
		http.ServeFileFS(w, r, e2eFiles, name)
	case name == "desktop.css":
		h.Set("Content-Type", "text/css; charset=utf-8")
		io.WriteString(w, desktopCSS)
	case name == "download-sw.js":
		h.Set("Content-Security-Policy", downloadSWCSP)
		http.ServeFileFS(w, r, e2eFiles, name)
	case g.noble.serve(w, r, g.nobleAssets(), name):
	default:
		h.Del("Content-Type")
		http.NotFound(w, r)
	}
}

var filesTmpl = template.Must(template.New("files").Parse(pageHead + `
<title>Downloads</title><body>
<p>Loading…</p>
<script type="module" src="{{.Script}}"></script>`))

// filesPage serves the files page. It's the same for every path: the
// script shows the directory named after the "#", so other paths redirect
// there.
func (g *server) filesPage(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Cache-Control", "no-store, no-transform")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if rest := strings.TrimPrefix(r.URL.Path, downloadsPrefix); rest != "" {
		http.Redirect(w, r, g.abs(downloadsPrefix)+"#/"+escapePath(rest), http.StatusSeeOther)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", filesCSP)
	w.WriteHeader(http.StatusOK)
	if err := filesTmpl.Execute(w, map[string]any{"Script": "../tabtop/files.js"}); err != nil {
		log.Printf("rendering page: %v", err)
	}
}

// tunnelRequest is a session tunnel's first message: what it's for.
type tunnelRequest struct {
	Type  string   `json:"type"` // vnc, logout, logout-all, end-session, sessions, seen, tty, list, file, zip, upload, mkdir, rename, move, delete, watch, changes or audio
	Path  string   `json:"path,omitempty"`
	Name  string   `json:"name,omitempty"`  // upload, mkdir: the file's or folder's name, in the folder at Path; rename: the new name; end-session: the session's handle
	Size  int64    `json:"size,omitempty"`  // upload: its size
	Names []string `json:"names,omitempty"` // zip: what to put in it, in the folder at Path
	To    string   `json:"to,omitempty"`    // move: the folder to move what's at Path into
	// upload: replace a file that has the name, rather than save under a
	// free one
	Replace bool `json:"replace,omitempty"`
	// upload: the id of one cut off, to carry on with (see keepPartial)
	Resume string `json:"resume,omitempty"`
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
		handshaken() // from here, the session's limit applies
		if t != nil {
			detach, err := g.attach(session, ip, t)
			switch err {
			case errSessionEnded:
				t.Close(closeLogin, err.Error())
				return
			case errTooManyTunnels:
				t.Close(websocket.StatusTryAgainLater, err.Error())
				return
			}
			defer detach()
			g.serveRequest(t, session, ip)
		}
	default:
		c.Close(websocket.StatusPolicyViolation, "bad hello")
	}
}

// serveRequest answers a session tunnel's request.
func (g *server) serveRequest(t *tunnel, session, ip string) {
	ctx, cancel := context.WithTimeout(context.Background(), tunnelTimeout)
	typ, msg, err := t.Read(ctx)
	cancel()
	var req tunnelRequest
	if err != nil || typ != websocket.MessageText || json.Unmarshal(msg, &req) != nil {
		t.Close(websocket.StatusPolicyViolation, "bad request")
		return
	}
	r := &tunnelResponder{t: t}

	switch req.Type {
	case "vnc":
		t.c.SetReadLimit(maxClientMessage + tunnelOverhead)
		if r.accept(nil) {
			g.bridgeDesktop(t, session, ip)
		}

	case "logout":
		g.endSession(session, "Logged out.", t)
		r.finish(nil)

	case "end-session":
		// Another of the sessions listed, by its handle (see sessionsReport).
		if !g.endSessionByHandle(req.Name, session, ip) {
			r.fail("That session is over already, or it's this one.")
			return
		}
		r.finish(nil)

	case "logout-all":
		log.Printf("all sessions logged out from %s", ip)
		g.endAllSessions("Logged out everywhere.", t)
		r.finish(nil)

	case "sessions":
		r.finish(g.sessionsReport(session, t))

	case "seen":
		// The files page's security warnings, marked as seen: what's
		// listed now no longer marks it (see sessionsReport).
		g.mu.Lock()
		g.seen = time.Now()
		g.mu.Unlock()
		log.Printf("security warnings marked as seen from %s", ip)
		r.finish(nil)

	case "tty":
		if g.termDir == "" {
			r.fail("The terminal is turned off.")
			return
		}
		if !g.openTTY(session) {
			r.fail("Too many open terminals.")
			return
		}
		defer g.closeTTY(session)
		t.c.SetReadLimit(maxTTYMessage + tunnelOverhead)
		// search: whether there's tmux's history to search (see tty.go).
		if r.accept(map[string]any{"search": g.ttyCommand == ""}) {
			g.serveTTY(t, session, ip)
		}

	case "list", "file":
		g.tunnelFiles(t, req, r)

	case "upload":
		g.tunnelUpload(t, req, r)

	case "mkdir":
		g.tunnelMkdir(t, req, r)

	case "zip":
		g.tunnelZip(t, req, ip, r)

	case "rename":
		g.tunnelRename(t, req, ip, r)

	case "move":
		g.tunnelMove(t, req, ip, r)

	case "watch":
		g.tunnelWatch(t, r)

	case "changes":
		g.tunnelChanges(t, req, r)

	case "delete":
		g.tunnelDelete(t, req, ip, r)

	case "audio":
		if g.audio == nil {
			r.fail("Desktop audio is turned off.")
			return
		}
		// Only while this session has the desktop open, from the same IP.
		l, err := g.audio.join(session, ip)
		switch {
		case errors.Is(err, errAudioDenied):
			r.fail("Connect to the desktop first.")
			return
		case err != nil:
			log.Printf("audio: %v", err)
			r.fail("Audio is unavailable.")
			return
		}
		log.Printf("audio tunnel listener from %s joined", ip)
		defer log.Printf("audio tunnel listener from %s left", ip)
		defer g.audio.leave(l)
		if r.accept(nil) {
			streamAudio(t, l)
		}

	default:
		r.fail("Unknown request.")
	}
}

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
	// os.Root confines every lookup to the directory: ".." and symlinks
	// leading outside it fail, even if they change between checks.
	store, err := openDownloadStore(g.downloadsDir)
	if err != nil {
		r.fail("The downloads folder is missing.")
		return
	}
	defer store.Close()
	name := strings.Trim(req.Path, "/")
	if name == "" {
		name = "."
	}
	f, st, err := store.open(name)
	if err != nil {
		r.fail("Not found.")
		return
	}
	defer f.Close()

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
		res := map[string]any{"entries": out, "truncated": truncated, "max": maxListing, "tz": g.timeZone}
		if free, total, ok := g.transfers.uploadRoom(g.downloadsDir); ok {
			res["free"], res["total"] = free, total
		}
		r.finish(res)
		return
	}

	if !st.Mode().IsRegular() {
		r.fail("Not a file.")
		return
	}
	if !r.accept(map[string]any{"name": st.Name(), "size": st.Size()}) {
		return
	}
	w := newChunkWriter(t)
	defer w.stop()
	if _, err := io.CopyN(w, f, st.Size()); err != nil {
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
