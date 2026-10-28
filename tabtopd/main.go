// Command tabtopd is the container's only public web endpoint.
//
// It serves the noVNC client, bridges noVNC's WebSocket to Xvnc (the job
// websockify used to do), and serves the desktop user's ~/Downloads at
// /downloads/ behind a login. It also streams the desktop's audio
// (audio.go) and offers a browser terminal at /tty/ (tty.go), which shares
// the downloads login. With -base-path, all of it is served under that URL
// path instead of /, for a reverse proxy that puts the site in a
// subdirectory. Credentials are a TOTP code, or a password followed
// immediately by the code when a pam_oath PIN is set. A TOTP code is
// single-use, so it can't serve as an HTTP Basic password (the browser
// resends it with every request): one successful login buys a session
// cookie instead.
//
// Logins are checked against the same pam_oath users file as Xvnc's, with
// the same library (liboath, see oath.go), so both accept the same
// credentials and share one record of used codes.
//
// Failed logins are limited per client IP, across both the desktop and the
// downloads page since they share the TOTP secret. Xvnc can't do this
// itself: every connection reaches it from the gateway, so its own
// blacklist (turned off in the entrypoint) would lock everyone out at once.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"flag"
	"fmt"
	"html/template"
	"io"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"path"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const (
	downloadsPrefix = "/downloads/"
	cookieName      = "tabtop_session"
	sessionTTL      = 12 * time.Hour
	maxFailures     = 5 // failed logins per client IP per failureWindow, desktop and downloads together
	failureWindow   = 5 * time.Minute
	maxFormBytes    = 4096
	// Largest message accepted from a noVNC client; clipboard pastes are the
	// only big ones.
	maxClientMessage = 16 << 20
	// How long a VNC client may take to log in before it's disconnected, so
	// an idle handshake can't hold one of its IP's login attempts forever.
	vncLoginTimeout = 60 * time.Second

	csp = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"
)

type server struct {
	// URL path the site is served under: "/", or "/a/b/" behind a reverse
	// proxy that passes it through. Handlers see paths with it cut down to
	// "/" (see stripBase); abs puts it back in URLs sent to the browser.
	base         string
	novncDir     string
	vncAddr      string
	usersFile    string
	downloadsDir string
	// Proxies whose X-Forwarded-For entries are believed; see clientIP.
	trustedProxies []netip.Prefix
	audio          *audioHub // nil when audio is off
	xtermDir       string    // xterm.js files; empty when the terminal is off

	mu       sync.Mutex
	sessions map[string]time.Time   // token -> expiry
	ttys     map[string]int         // session token -> open terminals
	failures map[string][]time.Time // client IP -> recent failed logins
	pending  map[string]int         // client IP -> VNC logins awaiting their result
}

func main() {
	listen := flag.String("listen", ":6080", "address to serve on")
	basePath := flag.String("base-path", "/", "URL path the site is served under, e.g. /tabtop/")
	g := &server{
		sessions: map[string]time.Time{},
		ttys:     map[string]int{},
		failures: map[string][]time.Time{},
		pending:  map[string]int{},
	}
	flag.StringVar(&g.novncDir, "novnc-dir", "/opt/novnc", "noVNC client files")
	flag.StringVar(&g.vncAddr, "vnc-addr", "127.0.0.1:5901", "Xvnc's RFB address")
	flag.StringVar(&g.usersFile, "users-file", "", "pam_oath users file holding the TOTP key")
	flag.StringVar(&g.downloadsDir, "downloads-dir", "", "directory served at "+downloadsPrefix)
	trusted := flag.String("trusted-proxies", "",
		"comma-separated IPs or CIDR ranges of reverse proxies whose X-Forwarded-For is believed")
	flag.StringVar(&g.xtermDir, "xterm-dir", "", "xterm.js files for the terminal at "+ttyPrefix+"; empty turns it off")
	audioSink := flag.String("audio-sink", "", "PulseAudio sink whose sound is streamed to browsers; empty turns audio off")
	audioKbps := flag.Int("audio-bitrate", 64, fmt.Sprintf("audio bitrate in kbit/s (%d-%d)", minAudioBitrate, maxAudioBitrate))
	flag.Parse()
	log.SetFlags(0)
	log.SetPrefix("tabtopd: ")
	if g.usersFile == "" || g.downloadsDir == "" {
		log.Fatal("-users-file and -downloads-dir are required")
	}
	var err error
	if g.base, err = parseBasePath(*basePath); err != nil {
		log.Fatalf("-base-path: %v", err)
	}
	if g.trustedProxies, err = parsePrefixes(*trusted); err != nil {
		log.Fatalf("-trusted-proxies: %v", err)
	}
	if len(g.trustedProxies) > 0 {
		log.Printf("believing X-Forwarded-For from %v", g.trustedProxies)
	}
	if *audioSink != "" {
		if *audioKbps < minAudioBitrate || *audioKbps > maxAudioBitrate {
			log.Fatalf("-audio-bitrate must be %d to %d", minAudioBitrate, maxAudioBitrate)
		}
		g.audio = newAudioHub(*audioSink, *audioKbps)
		log.Printf("streaming audio from sink %s at %d kbit/s", *audioSink, *audioKbps)
	}

	srv := &http.Server{
		Addr:              *listen,
		Handler:           g.handler(),
		ReadHeaderTimeout: 30 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}
	log.Printf("listening on %s under %s; %s serves %s", *listen, g.base, g.abs(downloadsPrefix), g.downloadsDir)
	log.Fatal(srv.ListenAndServe())
}

func (g *server) handler() http.Handler {
	mux := http.NewServeMux()
	static := http.FileServerFS(noListingFS{os.DirFS(g.novncDir)})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/vnc.html" {
			g.audio.setCookie(w, r, g.base, g.secure(r))
		}
		static.ServeHTTP(w, r)
	})
	mux.HandleFunc("/websockify", g.websockify)
	mux.HandleFunc(downloadsPrefix, g.downloads)
	mux.HandleFunc(ttyPrefix, g.tty)
	// The mux would add the trailing slash itself, but to the path without
	// the base.
	for _, p := range []string{downloadsPrefix, ttyPrefix} {
		mux.Handle(strings.TrimSuffix(p, "/"), http.RedirectHandler(g.abs(p), http.StatusMovedPermanently))
	}
	mux.HandleFunc("/tabtop/audio.js", g.audioScript)
	mux.HandleFunc("/audio/ws", g.audioWS)
	mux.HandleFunc("/audio/stream.ogg", g.audioOgg)
	return g.stripBase(mux)
}

// stripBase serves h under g.base. The base without its trailing slash
// redirects to it, and paths outside it are not found. Everything the
// browser loads uses relative URLs, so only the server's redirects, form
// actions and cookie paths need the base put back (abs).
func (g *server) stripBase(h http.Handler) http.Handler {
	if g.base == "/" {
		return h
	}
	trimmed := strings.TrimSuffix(g.base, "/")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == trimmed:
			http.Redirect(w, r, g.base, http.StatusMovedPermanently)
		case strings.HasPrefix(r.URL.Path, g.base):
			r2 := new(http.Request)
			*r2 = *r
			r2.URL = new(url.URL)
			*r2.URL = *r.URL
			r2.URL.Path = strings.TrimPrefix(r.URL.Path, trimmed)
			// The base has no characters that need escaping, so an escaped
			// path starts with it too (else EscapedPath ignores RawPath).
			r2.URL.RawPath = strings.TrimPrefix(r.URL.RawPath, trimmed)
			h.ServeHTTP(w, r2)
		default:
			http.NotFound(w, r)
		}
	})
}

// abs turns a path as the handlers see it ("/downloads/") into the one the
// browser uses ("/tabtop/downloads/").
func (g *server) abs(p string) string {
	return g.base + strings.TrimPrefix(p, "/")
}

// parseBasePath checks a -base-path value and gives it a leading and
// trailing slash. Its segments are limited to unreserved URL characters, so
// it can go into redirects, HTML and cookie paths as it is.
func parseBasePath(s string) (string, error) {
	trimmed := strings.Trim(s, "/")
	if trimmed == "" {
		return "/", nil
	}
	for seg := range strings.SplitSeq(trimmed, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return "", fmt.Errorf("%q has an empty, . or .. segment", s)
		}
		for _, c := range seg {
			if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("-._~", c)) {
				return "", fmt.Errorf("%q may only contain letters, digits, -, ., _, ~ and /", s)
			}
		}
	}
	return "/" + trimmed + "/", nil
}

// noListingFS hides directories without an index.html, so the file server
// doesn't list noVNC's source tree.
type noListingFS struct{ fs.FS }

func (f noListingFS) Open(name string) (fs.File, error) {
	file, err := f.FS.Open(name)
	if err != nil {
		return nil, err
	}
	if st, err := file.Stat(); err == nil && st.IsDir() {
		if _, err := fs.Stat(f.FS, path.Join(name, "index.html")); err != nil {
			file.Close()
			return nil, fs.ErrNotExist
		}
	}
	return file, nil
}

// websockify bridges a noVNC WebSocket to Xvnc's RFB port. Accept also
// rejects cross-origin requests, so another site can't open a session in a
// visitor's browser.
func (g *server) websockify(w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"binary"}})
	if err != nil {
		return // Accept has already sent the error response.
	}
	c.SetReadLimit(maxClientMessage)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ws := websocket.NetConn(ctx, c, websocket.MessageBinary)
	defer ws.Close()

	ip := g.clientIP(r)
	audioToken := g.audio.token(r)
	if !g.beginVNCLogin(ip) {
		log.Printf("VNC connection from %s refused: too many failed logins", ip)
		refuseRFB(ws, "Too many failed login attempts. Try again in a few minutes.")
		return
	}
	var once sync.Once
	settle := func(result string) {
		once.Do(func() {
			g.endVNCLogin(ip, result == "failed")
			log.Printf("VNC login from %s %s", ip, result)
		})
	}
	defer settle("abandoned")

	vnc, err := net.DialTimeout("tcp", g.vncAddr, 5*time.Second)
	if err != nil {
		log.Printf("cannot reach VNC server: %v", err)
		return
	}
	defer vnc.Close()
	log.Printf("VNC connection from %s", ip)
	timer := time.AfterFunc(vncLoginTimeout, func() {
		settle("timed out")
		ws.Close()
		vnc.Close()
	})
	defer timer.Stop()

	// Written by the server-to-client copy, read after both copies are done.
	audioLinked := false
	watch := &rfbWatcher{result: func(ok bool) {
		timer.Stop()
		if ok {
			settle("succeeded")
			g.audio.link(audioToken, ip)
			audioLinked = true
		} else {
			settle("failed")
		}
	}}
	done := make(chan struct{}, 2)
	go func() {
		if err := checkClientHandshake(ws, vnc); err != nil {
			log.Printf("VNC connection from %s: %v", ip, err)
		} else {
			io.Copy(vnc, ws)
		}
		done <- struct{}{}
	}()
	go func() { io.Copy(ws, io.TeeReader(vnc, watch)); done <- struct{}{} }()
	// Either side closing ends the session; closing both stops the other copy.
	<-done
	ws.Close()
	vnc.Close()
	<-done
	if audioLinked {
		g.audio.unlink(audioToken, ip)
	}
	log.Printf("VNC connection from %s closed", ip)
}

// The only login Xvnc offers here: RFB 3.8, security type VeNCrypt (19),
// VeNCrypt version 0.2, subtype Plain (256). Holding the client to exactly
// these choices is what lets rfbWatcher find the login result in the
// server's replies without misreading them.
var clientHandshake = [][]byte{[]byte("RFB 003.008\n"), {19}, {0, 2}, {0, 0, 1, 0}}

var errBadHandshake = errors.New("unexpected RFB handshake from client")

// checkClientHandshake forwards the client's handshake to the server, one
// step at a time, and fails on anything other than clientHandshake.
func checkClientHandshake(client io.Reader, server io.Writer) error {
	for _, want := range clientHandshake {
		got := make([]byte, len(want))
		if _, err := io.ReadFull(client, got); err != nil {
			return err
		}
		if !bytes.Equal(got, want) {
			return errBadHandshake
		}
		if _, err := server.Write(got); err != nil {
			return err
		}
	}
	return nil
}

// rfbWatcher reads the server side of the handshake and reports whether the
// login succeeded. Server bytes, given the client's choices above:
//
//	"RFB 003.008\n"                 version
//	n, n×type                       security types (n = 0: refused, reason follows)
//	major, minor                    VeNCrypt version
//	ack                             0 = client's VeNCrypt version accepted
//	k, k×U32                        VeNCrypt subtypes
//	U32                             security result after the Plain login: 0 = OK
type rfbWatcher struct {
	buf    []byte
	done   bool
	result func(ok bool)
}

func (w *rfbWatcher) Write(p []byte) (int, error) {
	if w.done {
		return len(p), nil
	}
	w.buf = append(w.buf, p...)
	switch parseSecurityResult(w.buf) {
	case rfbNeedMore:
		return len(p), nil
	case rfbOK:
		w.result(true)
	case rfbFailed:
		w.result(false)
	}
	// rfbNoLogin: the server refused before any password was checked; the
	// connection ends and counts as abandoned, not as a failed guess.
	w.done, w.buf = true, nil
	return len(p), nil
}

type rfbState int

const (
	rfbNeedMore rfbState = iota
	rfbOK
	rfbFailed
	rfbNoLogin
)

func parseSecurityResult(b []byte) rfbState {
	i := 12 // version
	if len(b) < i+1 {
		return rfbNeedMore
	}
	n := int(b[i])
	if n == 0 {
		return rfbNoLogin
	}
	i += 1 + n + 2 // types, VeNCrypt version
	if len(b) < i+1 {
		return rfbNeedMore
	}
	if b[i] != 0 {
		return rfbNoLogin
	}
	i++ // ack
	if len(b) < i+1 {
		return rfbNeedMore
	}
	k := int(b[i])
	if k == 0 {
		return rfbNoLogin
	}
	i += 1 + 4*k // subtypes
	if len(b) < i+4 {
		return rfbNeedMore
	}
	if binary.BigEndian.Uint32(b[i:i+4]) == 0 {
		return rfbOK
	}
	return rfbFailed
}

// refuseRFB speaks just enough RFB to turn a client away with a reason that
// noVNC shows to the user, instead of a bare dropped connection.
func refuseRFB(conn net.Conn, reason string) {
	conn.SetDeadline(time.Now().Add(10 * time.Second))
	if _, err := io.WriteString(conn, "RFB 003.008\n"); err != nil {
		return
	}
	if _, err := io.ReadFull(conn, make([]byte, 12)); err != nil {
		return
	}
	msg := []byte{0} // no security types: the reason follows
	msg = binary.BigEndian.AppendUint32(msg, uint32(len(reason)))
	conn.Write(append(msg, reason...))
}

func (g *server) downloads(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")

	switch r.Method {
	case http.MethodPost:
		g.login(w, r)
		return
	case http.MethodGet, http.MethodHead:
	default:
		h.Set("Allow", "GET, HEAD, POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !g.sessionOK(r) {
		g.loginPage(w, r.URL.Path, "", http.StatusUnauthorized)
		return
	}

	// os.Root confines every lookup to the directory: ".." and symlinks
	// leading outside it fail, even if they change between checks.
	root, err := os.OpenRoot(g.downloadsDir)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer root.Close()
	name := strings.Trim(strings.TrimPrefix(r.URL.Path, downloadsPrefix), "/")
	if name == "" {
		name = "."
	}
	f, err := root.Open(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		http.NotFound(w, r)
		return
	}

	switch {
	case st.IsDir():
		if !strings.HasSuffix(r.URL.Path, "/") {
			http.Redirect(w, r, g.abs(escapePath(r.URL.Path))+"/", http.StatusMovedPermanently)
			return
		}
		g.listing(w, r, root, name, f)
	case st.Mode().IsRegular():
		// Always an attachment: an HTML file from Downloads must never render
		// as a page on this origin, where it could script the noVNC session.
		h.Set("Content-Type", "application/octet-stream")
		h.Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": st.Name()}))
		http.ServeContent(w, r, st.Name(), st.ModTime(), f)
	default:
		http.NotFound(w, r)
	}
}

type entry struct {
	Name, Href, Size, Modified string
	dir                        bool
}

func (g *server) listing(w http.ResponseWriter, r *http.Request, root *os.Root, dir string, f *os.File) {
	des, err := f.ReadDir(-1)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	var entries []entry
	for _, de := range des {
		// Stat through the root: this follows symlinks that stay inside and
		// fails for ones leading outside, which are left out.
		st, err := root.Stat(path.Join(dir, de.Name()))
		if err != nil {
			continue
		}
		e := entry{
			Name:     de.Name(),
			Href:     url.PathEscape(de.Name()),
			Modified: st.ModTime().Format("2006-01-02 15:04"),
			dir:      st.IsDir(),
		}
		if e.dir {
			e.Name += "/"
			e.Href += "/"
		} else {
			e.Size = humanSize(st.Size())
		}
		entries = append(entries, e)
	}
	slices.SortFunc(entries, func(a, b entry) int {
		if a.dir != b.dir {
			if a.dir {
				return -1
			}
			return 1
		}
		return strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name))
	})
	title := "/"
	if dir != "." {
		title = "/" + dir + "/"
	}
	renderPage(w, http.StatusOK, listingTmpl, map[string]any{
		"Title": title, "Action": g.abs(escapePath(r.URL.Path)), "Entries": entries, "Root": dir == ".",
	})
}

func (g *server) login(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxFormBytes)
	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	back := g.abs(escapePath(r.URL.Path))
	ip := g.clientIP(r)

	if r.PostForm.Has("logout") {
		if c, err := r.Cookie(cookieName); err == nil {
			g.mu.Lock()
			delete(g.sessions, c.Value)
			g.mu.Unlock()
		}
		http.SetCookie(w, &http.Cookie{Name: cookieName, Path: g.base, MaxAge: -1,
			HttpOnly: true, Secure: g.secure(r), SameSite: http.SameSiteStrictMode})
		http.Redirect(w, r, back, http.StatusSeeOther)
		return
	}
	if g.lockedOut(ip) {
		log.Printf("web login from %s refused: too many failed logins", ip)
		g.loginPage(w, r.URL.Path, "Too many failed attempts. Try again in a few minutes.",
			http.StatusTooManyRequests)
		return
	}
	if !g.credentialsOK(strings.TrimSpace(r.PostForm.Get("password"))) {
		g.recordFailure(ip)
		log.Printf("web login from %s failed", ip)
		g.loginPage(w, r.URL.Path, "Those credentials are wrong, expired or already used.", http.StatusUnauthorized)
		return
	}
	log.Printf("web login from %s succeeded", ip)
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: g.newSession(), Path: g.base,
		MaxAge: int(sessionTTL.Seconds()), HttpOnly: true, Secure: g.secure(r), SameSite: http.SameSiteStrictMode})
	http.Redirect(w, r, back, http.StatusSeeOther)
}

// loginPage is the login form for the downloads and the terminal, which
// share one session.
func (g *server) loginPage(w http.ResponseWriter, p, errMsg string, status int) {
	title := "Downloads"
	if strings.HasPrefix(p, ttyPrefix) {
		title = "Terminal"
	}
	renderPage(w, status, loginTmpl, map[string]any{"Title": title, "Action": g.abs(escapePath(p)), "Error": errMsg})
}

// credentialsOK reports whether cred matches the pam_oath users file: a TOTP
// code alone when the PIN is "-", or password immediately followed by the
// code when a PIN is set. It's split the way pam_oath splits it.
func (g *server) credentialsOK(cred string) bool {
	data, err := os.ReadFile(g.usersFile)
	if err != nil {
		log.Printf("cannot read TOTP users file: %v", err)
		return false
	}
	user, digits, ok := parseUsersOath(string(data))
	if !ok {
		log.Printf("cannot parse TOTP users file %s", g.usersFile)
		return false
	}
	if len(cred) < digits {
		return false
	}
	err = oathAuthenticate(g.usersFile, user, cred[:len(cred)-digits], cred[len(cred)-digits:])
	if e, ok := err.(oathError); err != nil && !(ok && e.rejected()) {
		log.Printf("checking TOTP code: %v", err)
	}
	return err == nil
}

// parseUsersOath reads the user and code length from the first line,
// "HOTP/T30/<digits> <user> <pin> <hex key> [last use...]".
func parseUsersOath(data string) (user string, digits int, ok bool) {
	line, _, _ := strings.Cut(data, "\n")
	fields := strings.Fields(line)
	if len(fields) < 4 {
		return "", 0, false
	}
	digits, err := strconv.Atoi(fields[0][strings.LastIndex(fields[0], "/")+1:])
	if err != nil || digits < 6 || digits > 8 {
		return "", 0, false
	}
	return fields[1], digits, true
}

func (g *server) lockedOut(ip string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.lockedOutLocked(ip)
}

// lockedOutLocked counts VNC logins still awaiting their result as failures,
// so opening many connections at once can't buy extra guesses. g.mu must be
// held.
func (g *server) lockedOutLocked(ip string) bool {
	now := time.Now()
	recent := slices.DeleteFunc(g.failures[ip], func(t time.Time) bool { return now.Sub(t) >= failureWindow })
	if len(recent) == 0 {
		delete(g.failures, ip)
	} else {
		g.failures[ip] = recent
	}
	return len(recent)+g.pending[ip] >= maxFailures
}

func (g *server) recordFailure(ip string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.failures[ip] = append(g.failures[ip], time.Now())
}

// beginVNCLogin reserves one of ip's login attempts, or reports that it has
// none left.
func (g *server) beginVNCLogin(ip string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.lockedOutLocked(ip) {
		return false
	}
	g.pending[ip]++
	return true
}

func (g *server) endVNCLogin(ip string, failed bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.pending[ip]--; g.pending[ip] <= 0 {
		delete(g.pending, ip)
	}
	if failed {
		g.failures[ip] = append(g.failures[ip], time.Now())
	}
}

func (g *server) sessionOK(r *http.Request) bool {
	return g.sessionValid(sessionToken(r))
}

func sessionToken(r *http.Request) string {
	c, err := r.Cookie(cookieName)
	if err != nil {
		return ""
	}
	return c.Value
}

func (g *server) sessionValid(token string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	expiry, ok := g.sessions[token]
	return ok && time.Now().Before(expiry)
}

func (g *server) newSession() string {
	b := make([]byte, 32)
	rand.Read(b)
	token := base64.RawURLEncoding.EncodeToString(b)
	g.mu.Lock()
	defer g.mu.Unlock()
	now := time.Now()
	for t, expiry := range g.sessions {
		if !now.Before(expiry) {
			delete(g.sessions, t)
		}
	}
	g.sessions[token] = now.Add(sessionTTL)
	return token
}

// clientIP is the address failed logins are counted against. It's the
// connection's peer, unless that peer is a trusted proxy: then it's taken from
// X-Forwarded-For, walking right to left past entries added by trusted
// proxies. The first untrusted entry is the client; anything left of it was
// supplied by the client and could be forged, so it's ignored. Nobody else's
// X-Forwarded-For is read, so a client can't pick its own address to dodge
// the limit.
func (g *server) clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	peer, err := netip.ParseAddr(host)
	if err != nil || !g.trusted(peer) {
		return host
	}
	var hops []string
	for _, v := range r.Header.Values("X-Forwarded-For") {
		hops = append(hops, strings.Split(v, ",")...)
	}
	client := peer
	for _, hop := range slices.Backward(hops) {
		addr, err := parseHop(strings.TrimSpace(hop))
		if err != nil {
			break // garbage from the client's side; stay with the last hop we trust
		}
		client = addr
		if !g.trusted(addr) {
			break
		}
	}
	return client.String()
}

// secure reports whether the browser reached the site over HTTPS: to
// tabtopd itself, or to a trusted proxy that says so in X-Forwarded-Proto
// (anyone else's is ignored, as with X-Forwarded-For). Cookies set then are
// Secure, so the browser never sends them over plain HTTP.
func (g *server) secure(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	peer, err := netip.ParseAddr(host)
	if err != nil || !g.trusted(peer) {
		return false
	}
	// A chain of proxies may list one scheme per hop; the first is the
	// browser's.
	proto, _, _ := strings.Cut(r.Header.Get("X-Forwarded-Proto"), ",")
	return strings.EqualFold(strings.TrimSpace(proto), "https")
}

func (g *server) trusted(addr netip.Addr) bool {
	addr = addr.Unmap()
	return slices.ContainsFunc(g.trustedProxies, func(p netip.Prefix) bool { return p.Contains(addr) })
}

// parseHop parses an X-Forwarded-For entry, which some proxies write with a
// port ("192.0.2.1:4711", "[2001:db8::1]:4711").
func parseHop(s string) (netip.Addr, error) {
	if addr, err := netip.ParseAddr(s); err == nil {
		return addr.Unmap(), nil
	}
	ap, err := netip.ParseAddrPort(s)
	return ap.Addr().Unmap(), err
}

// parsePrefixes parses a comma- or space-separated list of IPs and CIDR
// ranges; a bare IP is a range of one.
func parsePrefixes(s string) ([]netip.Prefix, error) {
	var prefixes []netip.Prefix
	for _, f := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ' ' }) {
		if strings.Contains(f, "/") {
			p, err := netip.ParsePrefix(f)
			if err != nil {
				return nil, err
			}
			prefixes = append(prefixes, p.Masked())
			continue
		}
		addr, err := netip.ParseAddr(f)
		if err != nil {
			return nil, err
		}
		addr = addr.Unmap()
		prefixes = append(prefixes, netip.PrefixFrom(addr, addr.BitLen()))
	}
	return prefixes, nil
}

func escapePath(p string) string {
	return (&url.URL{Path: p}).EscapedPath()
}

func humanSize(n int64) string {
	if n < 1024 {
		return fmt.Sprintf("%d B", n)
	}
	size := float64(n)
	for _, unit := range []string{"KB", "MB", "GB", "TB"} {
		size /= 1024
		if size < 1024 || unit == "TB" {
			return fmt.Sprintf("%.1f %s", size, unit)
		}
	}
	return ""
}

func renderPage(w http.ResponseWriter, status int, t *template.Template, data map[string]any) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", csp)
	w.WriteHeader(status)
	if err := t.Execute(w, data); err != nil {
		log.Printf("rendering page: %v", err)
	}
}

const pageHead = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body { font: 15px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 56rem;
       padding: 0 1rem; color: #1d1d1f; background: #fff; }
@media (prefers-color-scheme: dark) { body { color: #e8e8ea; background: #1c1c1e; }
       a { color: #8ab4f8; } th, td { border-color: #3a3a3c !important; } }
h1 { font-size: 1.25rem; font-weight: 600; word-break: break-all; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid #ddd; }
td.num, th.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
td.name { word-break: break-all; }
.bar { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
.error { color: #c5221f; }
input[name=password] { font: inherit; font-size: 1.25rem; width: 16em; }
</style>`

var loginTmpl = template.Must(template.New("login").Parse(pageHead + `
<title>{{.Title}} login</title><body>
<h1>{{.Title}}</h1>{{if .Error}}<p class="error">{{.Error}}</p>{{end}}
<form method="post" action="{{.Action}}">
<p><label>Password + authenticator code<br>
<input name="password" type="password" autocomplete="off" autofocus required></label></p>
<p><button>Log in</button></p></form>`))

var listingTmpl = template.Must(template.New("listing").Parse(pageHead + `
<title>Downloads {{.Title}}</title><body>
<div class="bar"><h1>Downloads{{.Title}}</h1>
<form method="post" action="{{.Action}}"><button name="logout" value="1">Log out</button></form></div>
<table><tr><th>Name</th><th class="num">Size</th><th class="num">Modified</th></tr>
{{if not .Root}}<tr><td class="name"><a href="../">../</a></td><td></td><td></td></tr>{{end}}
{{range .Entries}}<tr><td class="name"><a href="{{.Href}}">{{.Name}}</a></td>
<td class="num">{{.Size}}</td><td class="num">{{.Modified}}</td></tr>
{{else}}<tr><td colspan="3">No files yet.</td></tr>{{end}}
</table>`))
