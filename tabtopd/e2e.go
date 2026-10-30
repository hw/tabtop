package main

// What -e2e serves: the scripts under /tabtop/ (with noble's
// ChaCha20-Poly1305, which browsers don't have built in), the downloads
// page (a script that lists and fetches files through the tunnel), and
// /tunnel (see tunnel.go), which logs in or answers a session's request.

import (
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
	"slices"
	"strings"
	"time"

	"github.com/coder/websocket"
)

const (
	// Size of the data messages a file is sent in.
	fileChunk = 256 << 10
	// The downloads page loads its script and talks to the tunnel; blob:
	// is for saving the files it fetched.
	filesCSP = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; " +
		"img-src 'self' data: blob:; form-action 'none'; frame-ancestors 'none'"
)

//go:embed tunnel.js novnc.js files.js
var e2eFiles embed.FS

// The files of @noble/ciphers that tunnel.js imports, from -noble-dir.
var nobleFiles = []string{"chacha.js", "_arx.js", "_poly1305.js", "utils.js"}

// scripts serves the page scripts under /tabtop/. e2e.js tells the others
// whether to use the tunnel: it re-exports tunnel.js with -e2e, and is
// empty without.
func (g *server) scripts(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Content-Type", "text/javascript; charset=utf-8")
	h.Set("Cache-Control", "no-cache")
	h.Set("X-Content-Type-Options", "nosniff")
	name := strings.TrimPrefix(r.URL.Path, "/tabtop/")
	switch {
	case name == "audio.js":
		if g.audio == nil {
			io.WriteString(w, "// Desktop audio is turned off (WEB_AUDIO=0).\n")
			return
		}
		w.Write(audioJS)
	case name == "e2e.js":
		if g.e2e {
			io.WriteString(w, "export * from \"./tunnel.js\";\nexport const enabled = true;\n")
		} else {
			io.WriteString(w, "// End-to-end encryption is off (WEB_E2E=0).\nexport const enabled = false;\n")
		}
	case name == "tunnel.js" || name == "novnc.js" || name == "files.js":
		http.ServeFileFS(w, r, e2eFiles, name)
	case strings.HasPrefix(name, "noble/") && g.nobleDir != "" &&
		slices.Contains(nobleFiles, strings.TrimPrefix(name, "noble/")):
		http.ServeFileFS(w, r, os.DirFS(g.nobleDir), strings.TrimPrefix(name, "noble/"))
	default:
		h.Del("Content-Type")
		http.NotFound(w, r)
	}
}

var filesTmpl = template.Must(template.New("files").Parse(pageHead + `
<title>Downloads</title><body>
<p>Loading…</p>
<script type="module" src="{{.Script}}"></script>`))

// filesPage serves the downloads page with -e2e. It's the same for every
// path: the script shows the directory named after the "#", so other
// paths redirect there.
func (g *server) filesPage(w http.ResponseWriter, r *http.Request) {
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
	Type string `json:"type"` // vnc, logout, tty, list, file or audio
	Path string `json:"path,omitempty"`
}

type fileEntry struct {
	Name     string `json:"name"`
	Dir      bool   `json:"dir,omitempty"`
	Size     string `json:"size,omitempty"`
	Modified string `json:"modified"`
}

// tunnelWS accepts a tunnel and runs its handshake: a login, or a
// session's request. Accept rejects cross-origin requests, as for every
// WebSocket here.
func (g *server) tunnelWS(w http.ResponseWriter, r *http.Request) {
	if !g.e2e {
		http.NotFound(w, r)
		return
	}
	c, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer c.CloseNow()
	c.SetReadLimit(maxClientMessage + tunnelOverhead)
	ip := g.clientIP(r)

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
		if t, session := g.sessionTunnel(c, hello[2:]); t != nil {
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
		if reply(nil) {
			g.bridgeDesktop(t, session, ip)
		}

	case "logout":
		g.endSession(session)
		reply(nil)
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
		if reply(nil) {
			g.serveTTY(t, session, ip)
		}

	case "list", "file":
		g.tunnelFiles(t, req, reply, fail)

	case "audio":
		if g.audio == nil {
			fail("Desktop audio is turned off.")
			return
		}
		// Only while this session has the desktop open, as with the cookie.
		l, _, err := g.audio.join(session, ip)
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
// login: with -e2e, Xvnc listens on a socket only the desktop user can
// open and asks for none, so noVNC goes straight to the desktop. Logging
// out, or the session ending, closes it.
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
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		tick := time.NewTicker(ttySessionCheck)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				if !g.sessionValid(session) {
					t.Close(websocket.StatusPolicyViolation, "logged out")
					vnc.Close()
					return
				}
			}
		}
	}()
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
func (g *server) tunnelFiles(t *tunnel, req tunnelRequest, reply func(map[string]any) bool, fail func(string)) {
	// os.Root confines every lookup to the directory, as for /downloads/.
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
		entries, err := listDir(root, name, f)
		if err != nil {
			fail("Not found.")
			return
		}
		out := []fileEntry{}
		for _, e := range entries {
			out = append(out, fileEntry{Name: strings.TrimSuffix(e.Name, "/"), Dir: e.dir, Size: e.Size, Modified: e.Modified})
		}
		reply(map[string]any{"entries": out})
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
	ctx := t.CloseRead(context.Background()) // ends the copy if the page goes
	buf := make([]byte, fileChunk)
	for {
		n, err := f.Read(buf)
		if n > 0 {
			if t.Write(ctx, websocket.MessageBinary, buf[:n]) != nil {
				return
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Close(websocket.StatusInternalError, "read error")
			return
		}
	}
	t.Close(websocket.StatusNormalClosure, "")
}

// newE2ESession starts a session for a tunnel login: its id, and the
// secret its tunnels' keys come from.
func (g *server) newE2ESession() (string, []byte) {
	id := g.newSession()
	secret := make([]byte, 32)
	rand.Read(secret)
	g.mu.Lock()
	defer g.mu.Unlock()
	g.secrets[id] = secret
	return id, secret
}

// sessionSecret returns a live session's secret.
func (g *server) sessionSecret(id string) ([]byte, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	expiry, ok := g.sessions[id]
	secret := g.secrets[id]
	return secret, ok && secret != nil && time.Now().Before(expiry)
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

func newToken() string {
	b := make([]byte, 32)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}
