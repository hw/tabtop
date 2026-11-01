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
	"os"
	"strings"
	"sync/atomic"
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
	// worker.
	filesCSP = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; " +
		"img-src 'self' data: blob:; worker-src 'self'; frame-src 'self'; form-action 'none'; frame-ancestors 'none'"
	// The download service worker fetches nothing itself.
	downloadSWCSP = "default-src 'none'"
)

//go:embed tunnel.js novnc.js files.js download-sw.js drop.js ui.js
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

// scripts serves the page scripts under /tabtop/.
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
	case name == "tunnel.js":
		js, _ := e2eFiles.ReadFile(name)
		w.Write(bytes.ReplaceAll(js, []byte(`"./noble/`), []byte(`"./`+g.noblePath()+`/`)))
	case name == "novnc.js" || name == "files.js" || name == "drop.js" || name == "ui.js":
		http.ServeFileFS(w, r, e2eFiles, name)
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
	Type  string   `json:"type"` // vnc, logout, tty, list, file, zip, upload, mkdir, rename, delete or audio
	Path  string   `json:"path,omitempty"`
	Name  string   `json:"name,omitempty"`  // upload, mkdir: the file's or folder's name, in the folder at Path; rename: the new name
	Size  int64    `json:"size,omitempty"`  // upload: its size
	Names []string `json:"names,omitempty"` // zip: what to put in it, in the folder at Path
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
	handshaken, ok := g.handshakes.start(ip)
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

	ctx, cancel := context.WithTimeout(context.Background(), tunnelTimeout)
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
		g.loginTunnel(c, ip, hello[2:])
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
	reply := func(v map[string]any) bool {
		if v == nil {
			v = map[string]any{}
		}
		v["ok"] = true
		return writeJSON(t, v) == nil
	}
	fail := func(msg string) {
		writeJSON(t, map[string]any{"error": msg})
		t.Close(websocket.StatusNormalClosure, "")
	}

	switch req.Type {
	case "vnc":
		t.c.SetReadLimit(maxClientMessage + tunnelOverhead)
		if reply(nil) {
			g.bridgeDesktop(t, session, ip)
		}

	case "logout":
		g.endSession(session, "Logged out.", t)
		reply(nil)
		t.Close(websocket.StatusNormalClosure, "")

	case "logout-all":
		log.Printf("all sessions logged out from %s", ip)
		g.endAllSessions("Logged out everywhere.", t)
		reply(nil)
		t.Close(websocket.StatusNormalClosure, "")

	case "sessions":
		reply(g.sessionsReport(session, t))
		t.Close(websocket.StatusNormalClosure, "")

	case "tty":
		if g.termDir == "" {
			fail("The terminal is turned off.")
			return
		}
		if !g.openTTY(session) {
			fail("Too many open terminals.")
			return
		}
		defer g.closeTTY(session)
		t.c.SetReadLimit(maxTTYMessage + tunnelOverhead)
		if reply(nil) {
			g.serveTTY(t, session, ip)
		}

	case "list", "file":
		g.tunnelFiles(t, req, reply, fail)

	case "upload":
		g.tunnelUpload(t, req, reply, fail)

	case "mkdir":
		g.tunnelMkdir(t, req, reply, fail)

	case "zip":
		g.tunnelZip(t, req, ip, reply, fail)

	case "rename":
		g.tunnelRename(t, req, ip, reply, fail)

	case "delete":
		g.tunnelDelete(t, req, ip, reply, fail)

	case "audio":
		if g.audio == nil {
			fail("Desktop audio is turned off.")
			return
		}
		// Only while this session has the desktop open, from the same IP.
		l, err := g.audio.join(session, ip)
		switch {
		case errors.Is(err, errAudioDenied):
			fail("Connect to the desktop first.")
			return
		case err != nil:
			log.Printf("audio: %v", err)
			fail("Audio is unavailable.")
			return
		}
		log.Printf("audio tunnel listener from %s joined", ip)
		defer log.Printf("audio tunnel listener from %s left", ip)
		defer g.audio.leave(l)
		if reply(nil) {
			streamAudio(t, l)
		}

	default:
		fail("Unknown request.")
	}
}

// bridgeDesktop connects a session tunnel to Xvnc. The session is the
// login: Xvnc listens on a socket only the desktop user can open and asks
// for none, so noVNC goes straight to the desktop. Logging out, or the
// session ending, closes it.
func (g *server) bridgeDesktop(t *tunnel, session, ip string) {
	vnc, err := g.dialVNC()
	if err != nil {
		log.Printf("cannot reach VNC server: %v", err)
		t.Close(websocket.StatusInternalError, "cannot reach the desktop")
		return
	}
	defer vnc.Close()
	log.Printf("desktop tunnel from %s opened", ip)
	g.audio.link(session, ip)
	defer g.audio.unlink(session, ip)

	conn := &tunnelConn{t: t}
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
// chunkWriter sends what's written to it to the page in data messages of
// fileChunk bytes. The page acknowledges each once it has used it, with an
// empty data message, and at most fileWindow are unacknowledged, so a slow
// or paused download holds the sender back here instead of piling up in
// the page. Once the page goes, or leaves the writer waiting for room for
// fileStall, writes fail.
type chunkWriter struct {
	t       *tunnel
	ctx     context.Context
	cancel  context.CancelFunc
	credits chan struct{}
	sent    atomic.Int64
	stall   *time.Timer
	buf     []byte
}

// errStalled is a chunkWriter's error once the page stops acknowledging.
var errStalled = errors.New("the download stalled")

func newChunkWriter(t *tunnel) *chunkWriter {
	w := &chunkWriter{t: t, credits: make(chan struct{}, fileWindow), stall: time.NewTimer(fileStall),
		buf: make([]byte, 0, fileChunk)}
	w.stall.Stop() // runs only while waiting for room
	for range fileWindow {
		w.credits <- struct{}{}
	}
	w.ctx, w.cancel = context.WithCancel(context.Background())
	go func() {
		defer w.cancel() // ends the writes if the page goes
		for acked := int64(0); ; acked++ {
			typ, p, err := t.Read(w.ctx)
			if err != nil {
				t.CloseNow()
				return
			}
			if typ != websocket.MessageBinary || len(p) != 0 || acked >= w.sent.Load() {
				t.Close(websocket.StatusPolicyViolation, "bad acknowledgement")
				return
			}
			w.credits <- struct{}{} // never blocks: one was taken for each chunk sent
		}
	}()
	return w
}

func (w *chunkWriter) Write(p []byte) (int, error) {
	n := 0
	for len(p) > 0 {
		k := min(len(p), fileChunk-len(w.buf))
		w.buf = append(w.buf, p[:k]...)
		p, n = p[k:], n+k
		if len(w.buf) == fileChunk {
			if err := w.flush(); err != nil {
				return n, err
			}
		}
	}
	return n, nil
}

// flush sends what's buffered, once the page has room for it.
func (w *chunkWriter) flush() error {
	if len(w.buf) == 0 {
		return nil
	}
	// Only time spent waiting for the page counts: a zip can take long
	// between chunks on its own, walking a big folder.
	select {
	case <-w.credits:
	default:
		w.stall.Reset(fileStall)
		select {
		case <-w.credits:
		case <-w.ctx.Done():
			return w.ctx.Err()
		case <-w.stall.C:
			return errStalled
		}
		w.stall.Stop()
	}
	w.sent.Add(1)
	if err := w.t.Write(w.ctx, websocket.MessageBinary, w.buf); err != nil {
		return err
	}
	w.buf = w.buf[:0]
	return nil
}

// fail ends the tunnel after err from Write or from what was being sent.
func (w *chunkWriter) fail(err error) {
	switch {
	case errors.Is(err, errStalled):
		w.t.Close(websocket.StatusPolicyViolation, "the download stalled")
	case w.ctx.Err() != nil: // the page went
	default:
		w.t.Close(websocket.StatusInternalError, "read error")
	}
}

// stop ends the acknowledgement reader.
func (w *chunkWriter) stop() {
	w.cancel()
	w.stall.Stop()
}

func (g *server) tunnelFiles(t *tunnel, req tunnelRequest, reply func(map[string]any) bool, fail func(string)) {
	// os.Root confines every lookup to the directory: ".." and symlinks
	// leading outside it fail, even if they change between checks.
	root, err := os.OpenRoot(g.downloadsDir)
	if err != nil {
		fail("The downloads folder is missing.")
		return
	}
	defer root.Close()
	name := strings.Trim(req.Path, "/")
	if name == "" {
		name = "."
	}
	f, err := root.Open(name)
	if err != nil {
		fail("Not found.")
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		fail("Not found.")
		return
	}

	if req.Type == "list" {
		if !st.IsDir() {
			fail("Not a folder.")
			return
		}
		entries, truncated, err := listDir(root, name, f)
		if err != nil {
			fail("Not found.")
			return
		}
		out := make([]fileEntry, 0, len(entries))
		for _, e := range entries {
			out = append(out, fileEntry{Name: strings.TrimSuffix(e.Name, "/"), Dir: e.dir, Size: e.Size, Bytes: e.bytes,
				Modified: e.Modified, Time: e.time})
		}
		reply(map[string]any{"entries": out, "truncated": truncated, "max": maxListing, "tz": g.timeZone})
		t.Close(websocket.StatusNormalClosure, "")
		return
	}

	if !st.Mode().IsRegular() {
		fail("Not a file.")
		return
	}
	if !reply(map[string]any{"name": st.Name(), "size": st.Size()}) {
		return
	}
	w := newChunkWriter(t)
	defer w.stop()
	if _, err := io.Copy(w, f); err != nil {
		w.fail(err)
		return
	}
	if w.flush() == nil {
		t.Close(websocket.StatusNormalClosure, "")
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
