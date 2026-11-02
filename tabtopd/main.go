// Command tabtopd is the container's only public web endpoint.
//
// It serves the noVNC client, the files page for the desktop user's
// ~/Downloads at /downloads/, and a browser terminal at /tty/ (tty.go),
// and streams the desktop's audio (audio.go). Everything private goes
// through one encrypted tunnel between the page's JavaScript and tabtopd
// (tunnel.go, e2e.go), so a proxy that terminates TLS on the way sees
// neither logins nor content. With -base-path, all of it is served under
// that URL path instead of /, for a reverse proxy that puts the site in a
// subdirectory.
//
// Credentials are a TOTP code, or a password followed immediately by the
// code when a pam_oath PIN is set, checked against a pam_oath users file
// with liboath (see oath.go), which records used codes. One login buys a
// 12-hour session for the desktop, the terminal and the files.
//
// Failed logins are limited per client IP. Xvnc asks for no login of its
// own: it listens only on a socket that only the desktop user (and so the
// gateway) can open.
package main

import (
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
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
)

const (
	downloadsPrefix = "/downloads/"
	maxFailures     = 5 // failed logins per client IP per failureWindow
	failureWindow   = 5 * time.Minute
	// Logins checked at once, from every address together.
	maxLoginWork = 4
	// Tunnels not yet logged in or tied to a session, from every address
	// together and from one, so connections that never finish their
	// handshake can't take everything.
	maxHandshakes      = 256
	maxHandshakesPerIP = 16
	// Most entries a Downloads folder's listing shows.
	maxListing = 10000
	// Longest the search for unfinished uploads may hold up the start.
	staleUploadScan = 10 * time.Second
	// Most entries looked at for a listing, counting ones it leaves out.
	maxListingScan = 100000
	// Most proxy hops -trust-nproxies may trust.
	maxTrustNProxies = 10
	// Largest message accepted from a noVNC client; clipboard pastes are the
	// only big ones.
	maxClientMessage = 16 << 20
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
	// How many proxy hops nearest the container are trusted whatever their
	// address, counting the one that connects; see clientIP.
	trustNProxies int
	audio         *audioHub     // nil when audio is off
	termDir       string        // ghostty-web files; empty when the terminal is off
	doctorOn      bool          // serve the doctor report
	nobleDir      string        // noble library files for tunnel.js
	timeZone      string        // TZ's zone name, for the files page's times; UTC if it has none
	pingInterval  time.Duration // for tests; 0 means the pingInterval constant
	// How long a session lasts at most, and without a tunnel open (0: no
	// limit); see session.go.
	sessionMax, sessionIdle time.Duration
	noble, ttyFiles         assetSet
	handshakes              handshakes

	mu       sync.Mutex
	sessions map[string]*session       // session id -> session
	logins   []loginEvent              // recent logins, oldest first
	ttys     map[string]int            // session token -> open terminals
	failures map[string][]time.Time    // client IP -> recent failed logins
	pending  map[string]int            // client IP -> logins awaiting their result
	partials map[string]*partialUpload // id -> an upload cut off, kept to resume (see keepPartial)
	uploads  map[string]*activeUpload  // id -> an upload going on (see claimPartial)

	failuresSwept time.Time // when failures last lost its expired IPs

	placedMu sync.Mutex
	placedAt map[string]time.Time // names the gateway moved into ~/Downloads itself, lately (see watch.go)
}

func main() {
	listen := flag.String("listen", ":6080", "address to serve on")
	basePath := flag.String("base-path", "/", "URL path the site is served under, e.g. /tabtop/")
	g := &server{
		sessions: map[string]*session{},
		ttys:     map[string]int{},
		failures: map[string][]time.Time{},
		pending:  map[string]int{},
	}
	flag.StringVar(&g.novncDir, "novnc-dir", "/opt/novnc", "noVNC client files")
	flag.StringVar(&g.vncAddr, "vnc-addr", "127.0.0.1:5901", "Xvnc's RFB address: host:port, or unix:path for a socket")
	flag.StringVar(&g.usersFile, "users-file", "", "pam_oath users file holding the TOTP key")
	flag.StringVar(&g.downloadsDir, "downloads-dir", "", "directory served at "+downloadsPrefix)
	flag.IntVar(&g.trustNProxies, "trust-nproxies", 0,
		"how many proxies in front are trusted whatever their address, counting the one that connects")
	trusted := flag.String("trusted-proxies", "",
		"comma-separated IPs or CIDR ranges of reverse proxies whose X-Forwarded-For is believed; cloudflare stands for Cloudflare's published ranges")
	sessionMax := flag.String("session-max", defaultSessionMax.String(), "how long a login lasts at most, in whole minutes, e.g. 12h")
	sessionIdle := flag.String("session-idle", defaultSessionIdle.String(),
		"how long a login lasts with nothing open, in whole minutes, e.g. 1h; 0 for no limit")
	flag.StringVar(&g.termDir, "term-dir", "", "ghostty-web files for the terminal at "+ttyPrefix+"; empty turns it off")
	audioSink := flag.String("audio-sink", "", "PulseAudio sink whose sound is streamed to browsers; empty turns audio off")
	flag.BoolVar(&g.doctorOn, "doctor", false, "serve a troubleshooting report at doctor, without a login")
	flag.StringVar(&g.nobleDir, "noble-dir", "", "noble library files (ciphers/, curves/, hashes/) the tunnel's JavaScript needs")
	audioKbps := flag.Int("audio-bitrate", 64, fmt.Sprintf("audio bitrate in kbit/s (%d-%d)", minAudioBitrate, maxAudioBitrate))
	flag.Parse()
	log.SetFlags(0)
	log.SetPrefix("tabtopd: ")
	if g.usersFile == "" || g.downloadsDir == "" || g.nobleDir == "" {
		log.Fatal("-users-file, -downloads-dir and -noble-dir are required")
	}
	g.timeZone = pageTimeZone(os.Getenv("TZ"))
	var err error
	if g.base, err = parseBasePath(*basePath); err != nil {
		log.Fatalf("-base-path: %v", err)
	}
	if g.trustedProxies, err = parsePrefixes(*trusted); err != nil {
		log.Fatalf("-trusted-proxies: %v", err)
	}
	if g.sessionMax, err = parseSessionLimit(*sessionMax, false); err != nil {
		log.Fatalf("-session-max: %v", err)
	}
	if g.sessionIdle, err = parseSessionLimit(*sessionIdle, true); err != nil {
		log.Fatalf("-session-idle: %v", err)
	}
	if g.trustNProxies < 0 || g.trustNProxies > maxTrustNProxies {
		log.Fatalf("-trust-nproxies must be 0 to %d", maxTrustNProxies)
	}
	if len(g.trustedProxies) > 0 {
		log.Printf("believing X-Forwarded-For from %s", strings.Join(describePrefixes(g.trustedProxies), ", "))
	}
	if g.trustNProxies > 0 {
		log.Printf("believing X-Forwarded-For from the %d nearest proxies, whatever their address", g.trustNProxies)
	}
	if g.doctorOn {
		log.Printf("serving the troubleshooting report at %s, without a login", g.abs("/doctor"))
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
		ReadHeaderTimeout: 10 * time.Second,
		MaxHeaderBytes:    64 << 10, // requests are small; tunnels carry the rest
		IdleTimeout:       2 * time.Minute,
	}
	// Before serving, so no upload is going yet, whatever the file
	// system's timestamps.
	removeStaleUploads(g.downloadsDir, time.Now(), staleUploadScan)
	// Read the files browsers keep now, rather than on the first request.
	if tag, _ := g.noble.load(g.nobleAssets()); tag == "" {
		log.Printf("warning: can't read the noble files in %s; see /doctor", g.nobleDir)
	}
	if g.termDir != "" {
		if tag, _ := g.ttyFiles.load(g.termAssets()); tag == "" {
			log.Printf("warning: can't read the terminal's files in %s; see /doctor", g.termDir)
		}
	}
	log.Printf("listening on %s under %s; %s serves %s", *listen, g.base, g.abs(downloadsPrefix), g.downloadsDir)
	log.Fatal(srv.ListenAndServe())
}

func (g *server) handler() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/", http.FileServerFS(noListingFS{os.DirFS(g.novncDir)}))
	mux.HandleFunc(downloadsPrefix, g.filesPage)
	mux.HandleFunc(ttyPrefix, g.tty)
	// The mux would add the trailing slash itself, but to the path without
	// the base.
	for _, p := range []string{downloadsPrefix, ttyPrefix} {
		mux.Handle(strings.TrimSuffix(p, "/"), http.RedirectHandler(g.abs(p), http.StatusMovedPermanently))
	}
	mux.HandleFunc("/tabtop/", g.scripts)
	mux.HandleFunc("/tunnel", g.tunnelWS)
	mux.HandleFunc("/healthz", g.healthz)
	mux.HandleFunc("/doctor", g.doctor)
	return noTransform(g.stripBase(mux))
}

// noTransform asks proxies, and CDNs such as Cloudflare, to pass every
// response on unchanged: one that rewrites or "optimizes" the page scripts
// could break the tunnel, or weaken it without anyone noticing. Handlers
// that set Cache-Control themselves include it too.
func noTransform(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-transform")
		h.ServeHTTP(w, r)
	})
}

// stripBase serves h under g.base. The base without its trailing slash
// redirects to it, and paths outside it are not found. Everything the
// browser loads uses relative URLs, so only the server's redirects need the
// base put back (abs).
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
// it can go into redirects and HTML as it is.
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

type entry struct {
	Name, Size, Modified string
	dir                  bool
	key                  string // Name in lower case, to sort by
	bytes, time          int64  // the size, and when it was modified in Unix seconds, for the page to sort by
}

// listDir lists the directory f, which is dir in root: directories first,
// then by name. It lists at most maxListing entries, as the directory
// happens to order them, and reports whether there were more. Entries left
// out (temporary uploads, broken symlinks) don't count, but at most
// maxListingScan are looked at, so a huge directory can't take forever.
func listDir(root *os.Root, dir string, f *os.File) (entries []entry, truncated bool, err error) {
	for scanned := 0; ; {
		if scanned >= maxListingScan {
			// Stopped looking: say so if there's anything more.
			more, _ := f.ReadDir(1)
			truncated = len(more) > 0
			break
		}
		des, err := f.ReadDir(min(1000, maxListingScan-scanned))
		if err != nil && err != io.EOF {
			return nil, false, err
		}
		if len(des) == 0 {
			break
		}
		scanned += len(des)
		for _, de := range des {
			if strings.HasPrefix(de.Name(), uploadTempPrefix) {
				continue // an upload in progress
			}
			// Stat through the root: this follows symlinks that stay inside
			// and fails for ones leading outside, which are left out.
			st, err := root.Stat(path.Join(dir, de.Name()))
			if err != nil {
				continue
			}
			if len(entries) == maxListing {
				truncated = true
				break
			}
			e := entry{
				Name:     de.Name(),
				key:      strings.ToLower(de.Name()),
				Modified: st.ModTime().Format("2006-01-02 15:04"),
				dir:      st.IsDir(),
				time:     st.ModTime().Unix(),
			}
			if !e.dir {
				e.Size, e.bytes = humanSize(st.Size()), st.Size()
			}
			entries = append(entries, e)
		}
		if truncated {
			break
		}
	}
	slices.SortFunc(entries, func(a, b entry) int {
		if a.dir != b.dir {
			if a.dir {
				return -1
			}
			return 1
		}
		return strings.Compare(a.key, b.key)
	})
	return entries, truncated, nil
}

// dialVNC connects to Xvnc, over TCP or (with "unix:") its socket.
func (g *server) dialVNC() (net.Conn, error) {
	if path, ok := strings.CutPrefix(g.vncAddr, "unix:"); ok {
		return net.DialTimeout("unix", path, 5*time.Second)
	}
	return net.DialTimeout("tcp", g.vncAddr, 5*time.Second)
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

// lockedOutLocked counts logins still awaiting their result as failures,
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

// loginWork has a slot for each login being checked. Checking takes CPU
// (CPace) and liboath's lock on the users file, so without a bound a flood
// of logins from many addresses, each within its own limit, would queue
// without end. One that finds no slot is turned away: while a flood lasts,
// logins may be refused, but nothing stays locked afterwards.
var loginWork = make(chan struct{}, maxLoginWork)

const (
	loginBusy    = "too many logins being checked at once"
	loginBusyMsg = "The server is busy checking other logins. Try again in a moment."
)

// startLoginWork takes a slot for checking a login, or reports that there's
// none free; endLoginWork gives it back.
func startLoginWork() bool {
	select {
	case loginWork <- struct{}{}:
		return true
	default:
		return false
	}
}

func endLoginWork() { <-loginWork }

// beginLogin reserves one of ip's login attempts until endLogin gives its
// result, or reports that it has none left.
func (g *server) beginLogin(ip string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.lockedOutLocked(ip) {
		return false
	}
	g.pending[ip]++
	return true
}

func (g *server) endLogin(ip, browser string, failed bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.pending[ip]--; g.pending[ip] <= 0 {
		delete(g.pending, ip)
	}
	if failed {
		g.recordLoginLocked(ip, browser, false)
		g.failures[ip] = append(g.failures[ip], time.Now())
		g.sweepFailuresLocked()
	}
}

// sweepFailuresLocked forgets the failures of every IP that has none left
// in the window, at most once a window, so addresses that fail once and
// never come back don't pile up. g.mu must be held.
func (g *server) sweepFailuresLocked() {
	now := time.Now()
	if now.Sub(g.failuresSwept) < failureWindow {
		return
	}
	g.failuresSwept = now
	for ip, times := range g.failures {
		if len(times) == 0 || now.Sub(times[len(times)-1]) >= failureWindow {
			delete(g.failures, ip)
		}
	}
}

// clientIP is the address failed logins are counted against. It's the
// connection's peer, unless that peer is a trusted proxy: then it's taken from
// X-Forwarded-For, walking right to left past entries added by trusted
// proxies. The first untrusted entry is the client; anything left of it was
// supplied by the client and could be forged, so it's ignored. Nobody else's
// X-Forwarded-For is read, so a client can't pick its own address to dodge
// the limit.
//
// A hop is a trusted proxy if its address is in -trusted-proxies, or if it's
// one of the -trust-nproxies hops nearest the container, counting the
// connection's peer as the first: for proxies whose addresses change, such as
// a platform's load balancer. With more than there really are, the walk
// reaches entries the client wrote, so the count must be exact. The entry
// a trusted Cloudflare address added is the client, whatever its address.
func (g *server) clientIP(r *http.Request) string {
	client, _ := g.traceClientIP(r)
	return client
}

// hop is one address clientIP looked at, for the doctor report.
type hop struct {
	Addr    string `json:"addr"`
	From    string `json:"from"` // "connection" or "X-Forwarded-For"
	Trusted bool   `json:"trusted"`
	By      string `json:"by,omitempty"` // why it's trusted: "WEB_TRUSTED_PROXIES" or "WEB_TRUST_NPROXIES"
	Note    string `json:"note,omitempty"`
}

// trustedBy says why the hop at position i (0 for the connection's peer,
// then X-Forwarded-For entries from the right) is a trusted proxy, or "" if
// it isn't one.
func (g *server) trustedBy(addr netip.Addr, i int) string {
	switch {
	case g.trusted(addr):
		return "WEB_TRUSTED_PROXIES"
	case i < g.trustNProxies:
		return "WEB_TRUST_NPROXIES"
	}
	return ""
}

// traceClientIP is clientIP, also returning the addresses it looked at:
// the connection's peer first, then X-Forwarded-For entries right to left.
func (g *server) traceClientIP(r *http.Request) (string, []hop) {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	peer, err := netip.ParseAddr(host)
	if err != nil {
		return host, []hop{{Addr: host, From: "connection"}}
	}
	peer = peer.Unmap()
	by := g.trustedBy(peer, 0)
	if by == "" {
		return host, []hop{{Addr: host, From: "connection"}}
	}
	trace := []hop{{Addr: peer.String(), From: "connection", Trusted: true, By: by}}
	var entries []string
	for _, v := range r.Header.Values("X-Forwarded-For") {
		entries = append(entries, strings.Split(v, ",")...)
	}
	client := peer
	// Cloudflare is always the outermost proxy, so the entry it added is
	// the visitor even if it's one of Cloudflare's own addresses (a
	// Worker's request), whose entries further left are the visitor's own.
	afterCloudflare := inCloudflare(peer)
	for i, entry := range slices.Backward(entries) {
		entry = strings.TrimSpace(entry)
		addr, err := parseHop(entry)
		if err != nil {
			// Garbage from the client's side; stay with the last hop we trust.
			trace = append(trace, hop{Addr: entry, From: "X-Forwarded-For", Note: "not an IP address; stopped here"})
			break
		}
		client = addr
		if afterCloudflare {
			trace = append(trace, hop{Addr: addr.String(), From: "X-Forwarded-For",
				Note: "added by Cloudflare, so the visitor whatever its address"})
			break
		}
		// slices.Backward counts i down from the rightmost entry, which is
		// hop 1.
		by := g.trustedBy(addr, len(entries)-i)
		trace = append(trace, hop{Addr: addr.String(), From: "X-Forwarded-For", Trusted: by != "", By: by})
		if by == "" {
			break
		}
		afterCloudflare = inCloudflare(addr)
	}
	return client.String(), trace
}

// secure reports whether the browser reached the site over HTTPS: to
// tabtopd itself, or to a trusted proxy that says so in X-Forwarded-Proto
// (anyone else's is ignored, as with X-Forwarded-For), for the doctor
// report.
func (g *server) secure(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	peer, err := netip.ParseAddr(host)
	if err != nil || g.trustedBy(peer.Unmap(), 0) == "" {
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

// cloudflareRanges are the addresses Cloudflare's edge connects from, as
// published at https://www.cloudflare.com/ips-v4 and /ips-v6 (2026-10-31).
// "cloudflare" in -trusted-proxies stands for all of them.
var cloudflareRanges = mustParsePrefixes(`
	173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22
	141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20
	197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13
	104.24.0.0/14 172.64.0.0/13 131.0.72.0/22
	2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32
	2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32`)

func mustParsePrefixes(s string) []netip.Prefix {
	var prefixes []netip.Prefix
	for _, f := range strings.Fields(s) {
		prefixes = append(prefixes, netip.MustParsePrefix(f))
	}
	return prefixes
}

func inCloudflare(addr netip.Addr) bool {
	addr = addr.Unmap()
	return slices.ContainsFunc(cloudflareRanges, func(p netip.Prefix) bool { return p.Contains(addr) })
}

// describePrefixes lists prefixes for people to read, with Cloudflare's
// ranges shown as "cloudflare".
func describePrefixes(prefixes []netip.Prefix) []string {
	out := []string{}
	if !slices.ContainsFunc(cloudflareRanges, func(p netip.Prefix) bool { return !slices.Contains(prefixes, p) }) {
		out = append(out, "cloudflare")
		prefixes = slices.DeleteFunc(slices.Clone(prefixes), func(p netip.Prefix) bool {
			return slices.Contains(cloudflareRanges, p)
		})
	}
	for _, p := range prefixes {
		out = append(out, p.String())
	}
	return out
}

// parsePrefixes parses a comma- or space-separated list of IPs, CIDR
// ranges and "cloudflare"; a bare IP is a range of one.
func parsePrefixes(s string) ([]netip.Prefix, error) {
	var prefixes []netip.Prefix
	for _, f := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ' ' }) {
		if strings.EqualFold(f, "cloudflare") {
			prefixes = append(prefixes, cloudflareRanges...)
			continue
		}
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

// pageTimeZone is the zone named by tz, a TZ value, for the files page to
// show times in: UTC if it's unset, or isn't a name Go knows, as a POSIX
// rule such as "CET-1CEST" isn't.
func pageTimeZone(tz string) string {
	name := strings.TrimPrefix(tz, ":")
	if name == "" || name == "Local" {
		return "UTC"
	}
	if _, err := time.LoadLocation(name); err != nil {
		return "UTC"
	}
	return name
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

const pageHead = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root { --fg: #1d1d1f; --bg: #fff; --line: #ddd; --raised: #fff; --accent: #1a73e8; --hover: rgba(26, 115, 232, .12); }
@media (prefers-color-scheme: dark) { :root { --fg: #e8e8ea; --bg: #1c1c1e; --line: #3a3a3c; --raised: #2c2c2e;
       --accent: #8ab4f8; --hover: rgba(138, 180, 248, .18); } }
a { color: var(--accent); }
body { font: 15px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 56rem;
       padding: 0 1rem; color: var(--fg); background: var(--bg); }
button, input { font: inherit; }
button:not(.sort) { padding: .3rem .7rem; color: inherit; background: var(--raised); border: 1px solid var(--line); border-radius: 5px; }
button:not(.sort):not(:disabled) { cursor: pointer; }
button:not(.sort):not(:disabled):hover { background: var(--hover); }
button.danger, .selection button.delete { color: #c5221f; }
@media (prefers-color-scheme: dark) { button.danger, .selection button.delete { color: #f28b82; } }
button:focus-visible, a:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
h1 { font-size: 1.25rem; font-weight: 600; overflow-wrap: anywhere; }
h2 { font-size: 1.05rem; font-weight: 600; margin-top: 2rem; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid var(--line); }
td.num, th.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
td.name { overflow-wrap: anywhere; }
.bar { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
.error { color: #c5221f; }
@media (prefers-color-scheme: dark) { .error { color: #f28b82; } }
.hint { opacity: .7; font-size: 13px; }
p.upload { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
p.upload button { font: inherit; }
p.space { margin-top: -.25rem; }
#sessions button.end { font: inherit; font-size: 13px; }
#sessions h2 { font-size: 1rem; margin-top: 1.5rem; }
h1.crumbs { display: flex; flex-wrap: wrap; align-items: baseline; gap: .1rem .4rem; word-break: normal; overflow-wrap: anywhere;
       margin-top: .75rem; }
.tabtop-nav { display: flex; flex-wrap: wrap; align-items: center; gap: .25rem .5rem; padding-bottom: .5rem;
       border-bottom: 1px solid var(--line); font-size: 14px; }
.tabtop-nav .page { display: inline-flex; align-items: center; justify-content: center; padding: 3px; border-radius: 6px;
       color: var(--accent); }
.tabtop-nav .page svg { display: block; width: 22px; height: 22px; }
.tabtop-nav a.page:hover { background: var(--hover); }
.tabtop-nav .page[aria-current] { color: var(--fg); background: var(--line); }
.tabtop-nav button { margin-left: auto; font: inherit; }
.tabtop-nav button + button { margin-left: 0; }
.tabtop-nav button.security.attention { color: #c5221f; border-color: currentColor; }
.tabtop-nav button.security.attention::after { content: " •"; }
@media (prefers-color-scheme: dark) { .tabtop-nav button.security.attention { color: #f28b82; } }
.tabtop-nav button.security[aria-pressed=true] { color: var(--bg); background: var(--fg); border-color: var(--fg); }
.tabtop-nav button.logout { display: inline-flex; align-items: center; justify-content: center; padding: 3px 6px; }
.tabtop-nav button.logout svg { display: block; width: 22px; height: 22px; }
.find { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; margin-bottom: .5rem; }
.find input { font: inherit; flex: 0 1 20rem; min-width: 0; padding: .3rem .5rem; color: inherit; background: var(--bg);
       border: 1px solid var(--line); border-radius: 6px; }
h1.crumbs a { text-decoration: none; } h1.crumbs a:hover { text-decoration: underline; }
h1.crumbs .sep { opacity: .4; font-weight: 400; }
th.sel, td.sel { width: 1%; padding-right: 0; }
tbody tr:focus-within { background: var(--hover); }
.drop-target { outline: 2px dashed var(--accent); outline-offset: -2px; background: var(--hover); }
th button.sort { font: inherit; font-weight: 600; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
th button.sort::after { content: attr(data-arrow); margin-left: .3rem; font-size: .7em; }
th.act, td.act { width: 1%; text-align: right; padding-top: 0; padding-bottom: 0; }
.selection { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; margin-bottom: .5rem;
             padding: .4rem .5rem; border-radius: 6px; background: var(--hover); }
.selection[hidden] { display: none; }
.selection button { font: inherit; font-size: 13px; }
details.menu { position: relative; display: inline-block; }
details.menu summary { list-style: none; cursor: pointer; user-select: none; padding: 0 .55rem; border-radius: 4px;
       font-size: 18px; line-height: 1.6; }
details.menu summary::-webkit-details-marker { display: none; }
details.menu summary:hover, details.menu[open] summary { background: var(--hover); }
details.menu .items { position: absolute; right: 0; top: 100%; z-index: 5; display: flex; flex-direction: column;
       min-width: 11rem; padding: .25rem 0; background: var(--raised); border: 1px solid var(--line);
       border-radius: 8px; box-shadow: 0 6px 20px rgba(0, 0, 0, .2); }
details.menu .items button { font: inherit; text-align: left; color: inherit; background: none; border: 0;
       padding: .45rem 1rem; cursor: pointer; white-space: nowrap; }
details.menu .items button:hover, details.menu .items button:focus-visible { background: var(--hover); outline: none; }
details.menu .items button.delete { color: #c5221f; }
@media (prefers-color-scheme: dark) { details.menu .items button.delete { color: #f28b82; } }
body.has-transfers { padding-bottom: 14rem; }
dialog { width: min(26rem, calc(100vw - 2rem)); box-sizing: border-box; padding: 1.25rem; color: var(--fg);
       background: var(--raised); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 12px 40px rgba(0, 0, 0, .3); }
dialog::backdrop { background: rgba(0, 0, 0, .4); }
dialog p { margin: 0 0 .75rem; overflow-wrap: anywhere; }
dialog input { font: inherit; width: 100%; box-sizing: border-box; padding: .4rem .5rem; }
dialog .buttons { display: flex; justify-content: flex-end; gap: .5rem; margin-top: 1rem; }
dialog button { font: inherit; padding: .3rem .9rem; }
dialog button.primary { color: #fff; background: var(--accent); border: 1px solid var(--accent); border-radius: 4px; }
@media (prefers-color-scheme: dark) { dialog button.primary { color: #1c1c1e; } }
dialog.preview { width: min(72rem, calc(100vw - 2rem)); height: calc(100vh - 2rem); max-height: none; padding: 0; }
dialog.preview[open] { display: flex; flex-direction: column; }
dialog.preview .head { display: flex; align-items: center; gap: .5rem; padding: .5rem .75rem; border-bottom: 1px solid var(--line); }
dialog.preview .head strong { margin-right: auto; overflow-wrap: anywhere; }
dialog.preview .head button { padding: .2rem .7rem; }
dialog.preview .body { flex: 1; min-height: 0; overflow: auto; display: flex; align-items: center; justify-content: center; }
dialog.preview .body > * { max-width: 100%; max-height: 100%; }
dialog.preview .body > p { padding: 1rem; }
dialog.preview .body img, dialog.preview .body video { width: 100%; height: 100%; object-fit: scale-down; }
dialog.preview .body audio { width: min(30rem, 90%); }
dialog.preview .body pre { align-self: stretch; flex: 1; margin: 0; padding: .75rem 1rem; max-height: none;
       font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 40rem) { .mod { display: none; }
       dialog.preview { width: 100vw; height: 100vh; max-width: none; border-radius: 0; }
       dialog.preview .head { flex-wrap: wrap; } dialog.preview .head strong { flex-basis: 100%; }
       dialog.preview .head .hint { margin-right: auto; white-space: nowrap; } }
@media (max-width: 30rem) {
       body { margin-top: 1rem; padding: 0 .75rem; }
       .file-table .size { display: none; }
       th, td { padding-left: .35rem; padding-right: .35rem; }
       details.menu summary { min-width: 28px; min-height: 38px; box-sizing: border-box; text-align: center; }
       .sessions-table tr, .logins-table tr { display: block; padding: .5rem 0; border-bottom: 1px solid var(--line); }
       .sessions-table tr:first-child { display: none; }
       .sessions-table td, .logins-table td { display: grid; grid-template-columns: minmax(6rem, 35%) 1fr; gap: .5rem;
              padding: .15rem .25rem; border: 0; text-align: left; white-space: normal; }
       .sessions-table td::before, .logins-table td::before { content: attr(data-label); font-weight: 600; }
       .sessions-table td.act:empty { display: none; }
}
@media (pointer: coarse) {
       button, details.menu summary { min-height: 40px; }
       .tabtop-nav .page { min-width: 40px; min-height: 40px; box-sizing: border-box; }
       input[type=checkbox] { width: 22px; height: 22px; }
}
` + transfersCSS + `</style>`

// transfersCSS styles the overlay shown while files are dragged over a
// page (see drop.js) and the transfers panel (see ui.js), on the files
// page and, in desktopCSS, the desktop.
const transfersCSS = `#drop_overlay { display: none; position: fixed; inset: 0; z-index: 20; pointer-events: none; align-items: center;
       justify-content: center; padding: 1rem; background: color-mix(in srgb, var(--bg) 80%, transparent);
       border: 3px dashed var(--accent); }
body.dropping #drop_overlay { display: flex; }
#drop_overlay p { max-width: 36rem; margin: 0; padding: 1rem 1.5rem; font-size: 1.15rem; font-weight: 600; text-align: center;
       overflow-wrap: anywhere; color: var(--fg); background: var(--raised); border-radius: 10px;
       box-shadow: 0 8px 28px rgba(0, 0, 0, .25); }
#transfers { position: fixed; left: 1rem; bottom: 1rem; z-index: 10; width: min(26rem, calc(100vw - 2rem));
       max-height: 45vh; display: flex; flex-direction: column; background: var(--raised);
       border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 8px 28px rgba(0, 0, 0, .22); }
#transfers[hidden] { display: none; }
#transfers .head { display: flex; align-items: center; gap: .5rem; padding: .5rem .75rem; }
#transfers .summary { margin-right: auto; opacity: .7; font-size: 13px; }
#transfers .head button { font: inherit; font-size: 13px; }
#transfers progress.overall:not([hidden]) { display: block; width: 100%; height: 3px; }
#uploads { overflow: auto; padding: 0 .75rem .5rem; font-size: 14px; }
#transfers.folded #uploads, #transfers.folded progress.overall { display: none; }
#uploads p { display: flex; flex-wrap: wrap; align-items: center; gap: .2rem .5rem; margin: .4rem 0; overflow-wrap: anywhere; }
#uploads p span { flex: 1 1 12rem; }
#uploads p progress { order: 3; flex: 1 1 100%; height: 6px; }
#uploads button { font: inherit; font-size: 12px; }
.sr-status { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
       clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@media (max-width: 40rem) { #transfers { left: .5rem; right: .5rem; bottom: .5rem; width: auto; } }
`

// desktopCSS is /tabtop/desktop.css, which novnc.js adds to noVNC's page
// for files dropped on the desktop, and tty.js to the terminal's: the
// files page's colours, dark as noVNC is, the transfers panel on the
// right, clear of noVNC's control bar, and over its screen, and the
// browser's own buttons in it rather than noVNC's.
const desktopCSS = `#drop_overlay, #transfers { --fg: #e8e8ea; --bg: #1c1c1e; --line: #3a3a3c; --raised: #2c2c2e; --accent: #8ab4f8;
       font: 14px/1.5 system-ui, sans-serif; color: var(--fg); text-align: left; }
` + transfersCSS + `#drop_overlay { z-index: 300; }
#transfers { z-index: 200; }
#transfers button { all: revert; font-size: 13px; }
#transfers button:focus-visible, #tabtop_notices button:focus-visible { outline: 2px solid #8ab4f8; outline-offset: 2px; }
@media (min-width: 40.01rem) { #transfers { left: auto; right: 1rem; } }
#tabtop_notices { position: fixed; top: 1rem; right: 1rem; z-index: 250; display: flex; flex-direction: column; gap: .5rem;
       width: min(24rem, calc(100vw - 2rem)); font: 14px/1.5 system-ui, sans-serif; color: #e8e8ea; text-align: left; }
#tabtop_notices .notice { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem .5rem; padding: .6rem .75rem;
       background: #2c2c2e; border: 1px solid #3a3a3c; border-radius: 10px; box-shadow: 0 8px 28px rgba(0, 0, 0, .35); }
#tabtop_notices p { flex: 1 1 100%; margin: 0; overflow-wrap: anywhere; }
#tabtop_notices button { all: revert; font-size: 13px; }
#tabtop_notices button.primary { padding: .15rem .8rem; color: #1c1c1e; background: #8ab4f8; border: 1px solid #8ab4f8;
       border-radius: 4px; }
#tabtop_notices button.close { margin-left: auto; }
`
