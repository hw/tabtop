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
	pingInterval  time.Duration // for tests; 0 means the pingInterval constant
	// How long a session lasts at most, and without a tunnel open (0: no
	// limit); see session.go.
	sessionMax, sessionIdle time.Duration
	noble, ttyFiles         assetSet
	handshakes              handshakes

	mu       sync.Mutex
	sessions map[string]*session    // session id -> session
	logins   []loginEvent           // recent logins, oldest first
	ttys     map[string]int         // session token -> open terminals
	failures map[string][]time.Time // client IP -> recent failed logins
	pending  map[string]int         // client IP -> logins awaiting their result

	failuresSwept time.Time // when failures last lost its expired IPs
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
			}
			if !e.dir {
				e.Size = humanSize(st.Size())
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

func (g *server) endLogin(ip string, failed bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.pending[ip]--; g.pending[ip] <= 0 {
		delete(g.pending, ip)
	}
	if failed {
		g.recordLoginLocked(ip, false)
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
body { font: 15px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 56rem;
       padding: 0 1rem; color: #1d1d1f; background: #fff; }
@media (prefers-color-scheme: dark) { body { color: #e8e8ea; background: #1c1c1e; }
       a { color: #8ab4f8; } th, td { border-color: #3a3a3c !important; } }
h1 { font-size: 1.25rem; font-weight: 600; word-break: break-all; }
h2 { font-size: 1.05rem; font-weight: 600; margin-top: 2rem; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid #ddd; }
td.num, th.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
td.name { word-break: break-all; }
.bar { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
.error { color: #c5221f; }
.hint { opacity: .7; font-size: 13px; }
body.dropping { outline: 3px dashed #8ab4f8; outline-offset: .75rem; }
#uploads p { margin: .25rem 0; word-break: break-all; }
p.upload { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
p.upload button { font: inherit; }
th.sel, td.sel { width: 1%; padding-right: 0; }
td.act { width: 1%; text-align: right; white-space: nowrap; }
td.act button + button { margin-left: .25rem; }
td.act button, .selection button, #uploads button { font: inherit; font-size: 13px; white-space: nowrap; }
.selection { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; margin-bottom: .5rem;
             padding: .4rem .5rem; border-radius: 6px; background: rgba(138, 180, 248, .18); }
.selection[hidden] { display: none; }
@media (max-width: 40rem) { .mod { display: none; } td.act { white-space: normal; }
       td.act button { display: block; margin: .15rem 0 0 auto !important; } }
</style>`
