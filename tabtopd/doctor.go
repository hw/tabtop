package main

// healthz is a liveness check for Docker and load balancers; doctor is a
// troubleshooting report, served only with -doctor.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const vncProbeTimeout = 2 * time.Second

// healthz answers 200 while Xvnc is listening and the TOTP users file can be
// read, so logins can work. It needs no login and reveals nothing else. It
// doesn't connect to Xvnc, which would log every check.
func (g *server) healthz(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Cache-Control", "no-store, no-transform")
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		h.Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	err := g.vncListening()
	if err == nil {
		err = g.usersFileOK()
	}
	if err != nil {
		log.Printf("health check failed: %v", err)
		http.Error(w, "unhealthy", http.StatusServiceUnavailable)
		return
	}
	h.Set("Content-Type", "text/plain; charset=utf-8")
	io.WriteString(w, "ok\n")
}

// vncListening reports whether something listens on Xvnc's TCP port or
// socket, from the kernel's socket tables.
func (g *server) vncListening() error {
	if path, ok := strings.CutPrefix(g.vncAddr, "unix:"); ok {
		return unixListening(path)
	}
	_, portStr, err := net.SplitHostPort(g.vncAddr)
	if err != nil {
		return err
	}
	port, err := strconv.ParseUint(portStr, 10, 16)
	if err != nil {
		return err
	}
	want := fmt.Sprintf(":%04X", port)
	for _, table := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		f, err := os.Open(table)
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			// sl local_address rem_address st ...; st 0A is LISTEN.
			fields := strings.Fields(sc.Text())
			if len(fields) > 3 && strings.HasSuffix(fields[1], want) && fields[3] == "0A" {
				f.Close()
				return nil
			}
		}
		f.Close()
	}
	return fmt.Errorf("nothing listens on Xvnc's port %d", port)
}

// unixListening looks for a listening socket at path in /proc/net/unix:
// "Num RefCount Protocol Flags Type St Inode Path", where flags 00010000
// mark a listening socket.
func unixListening(path string) error {
	f, err := os.Open("/proc/net/unix")
	if err != nil {
		return err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) == 8 && fields[7] == path && fields[3] == "00010000" {
			return nil
		}
	}
	return fmt.Errorf("nothing listens on Xvnc's socket %s", path)
}

func (g *server) usersFileOK() error {
	data, err := os.ReadFile(g.usersFile)
	if err != nil {
		return err
	}
	if _, _, ok := parseUsersOath(string(data)); !ok {
		return fmt.Errorf("cannot parse %s", g.usersFile)
	}
	return nil
}

// probeVNC connects to Xvnc and reads its greeting, the protocol version.
func (g *server) probeVNC() (string, error) {
	conn, err := g.dialVNC()
	if err != nil {
		return "", err
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(vncProbeTimeout))
	greeting := make([]byte, 12)
	if _, err := io.ReadFull(conn, greeting); err != nil {
		return "", fmt.Errorf("reading Xvnc's greeting: %w", err)
	}
	if !bytes.HasPrefix(greeting, []byte("RFB ")) {
		return "", fmt.Errorf("unexpected greeting %q", greeting)
	}
	return strings.TrimSpace(string(greeting)), nil
}

type check struct {
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
}

func newCheck(detail string, err error) check {
	if err != nil {
		return check{OK: false, Detail: err.Error()}
	}
	return check{OK: true, Detail: detail}
}

// doctor reports what tabtopd sees: each part's state, the server's clock
// (TOTP codes depend on it) and how this request arrived through any
// proxies. It needs no login, so a broken login can be diagnosed with it,
// and it leaves out the username, password and TOTP key.
func (g *server) doctor(w http.ResponseWriter, r *http.Request) {
	if !g.doctorOn {
		http.NotFound(w, r)
		return
	}
	h := w.Header()
	h.Set("Cache-Control", "no-store, no-transform")
	h.Set("X-Content-Type-Options", "nosniff")
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		h.Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	checks := map[string]check{}
	greeting, err := g.probeVNC()
	checks["vnc"] = newCheck(fmt.Sprintf("%s at %s", greeting, g.vncAddr), err)

	digits := 0
	data, err := os.ReadFile(g.usersFile)
	if err == nil {
		var ok bool
		if _, digits, ok = parseUsersOath(string(data)); !ok {
			err = fmt.Errorf("cannot parse %s", g.usersFile)
		}
	}
	checks["login"] = newCheck(fmt.Sprintf("%d-digit codes, users file %s", digits, g.usersFile), err)

	_, err = os.Stat(filepath.Join(g.novncDir, "vnc.html"))
	checks["novnc"] = newCheck(g.novncDir, err)

	entries, err := os.ReadDir(g.downloadsDir)
	checks["downloads"] = newCheck(fmt.Sprintf("%s, %d entries", g.downloadsDir, len(entries)), err)

	if g.audio == nil {
		checks["audio"] = check{OK: true, Detail: "off"}
	} else {
		checks["audio"] = newCheck(g.audio.describe(), g.audio.checkSink())
	}

	if g.termDir == "" {
		checks["terminal"] = check{OK: true, Detail: "off"}
	} else {
		tmux, err := exec.LookPath("tmux")
		if err == nil {
			_, err = os.Stat(filepath.Join(g.termDir, "ghostty-web.js"))
		}
		checks["terminal"] = newCheck(fmt.Sprintf("tmux %s, ghostty-web in %s", tmux, g.termDir), err)
	}

	err = nil
	for _, name := range nobleFiles {
		if _, err = os.Stat(filepath.Join(g.nobleDir, name)); err != nil {
			break
		}
	}
	checks["tunnel"] = newCheck(fmt.Sprintf("CPace logins, ChaCha20-Poly1305 tunnels; noble libraries in %s", g.nobleDir), err)

	g.mu.Lock()
	now := time.Now()
	sessions, ttys, lockedOut := 0, 0, 0
	for _, s := range g.sessions {
		if g.liveLocked(s, now) {
			sessions++
		}
	}
	for _, n := range g.ttys {
		ttys += n
	}
	for ip := range g.failures {
		if g.lockedOutLocked(ip) {
			lockedOut++
		}
	}
	g.mu.Unlock()

	healthy := true
	for _, c := range checks {
		healthy = healthy && c.OK
	}
	report := map[string]any{
		"healthy": healthy,
		"checks":  checks,
		"clock": map[string]any{
			"utc":       now.UTC().Format(time.RFC3339),
			"unix":      now.Unix(),
			"totp_step": now.Unix() / 30,
			"note":      "codes are only accepted within 30s of this clock",
		},
		"proxy":     g.proxyReport(r),
		"base_path": g.base,
		"state": map[string]any{
			"web_sessions":    sessions,
			"open_terminals":  ttys,
			"locked_out_ips":  lockedOut,
			"audio_listeners": g.audio.listenerCount(),
		},
		"go": runtime.Version(),
	}
	h.Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	enc.Encode(report)
}

// proxyReport shows how this request's client IP and scheme were worked
// out, whoever sent it, with what to change when it looks wrong.
func (g *server) proxyReport(r *http.Request) map[string]any {
	client, trace := g.traceClientIP(r)
	peer := trace[0]
	// Empty lists rather than null in the JSON, so "none" reads clearly.
	xff := append([]string{}, r.Header.Values("X-Forwarded-For")...)
	proto := append([]string{}, r.Header.Values("X-Forwarded-Proto")...)
	trusted := describePrefixes(g.trustedProxies)
	suggest := peer.Addr
	fromCloudflare := false
	if addr, err := netip.ParseAddr(peer.Addr); err == nil && inCloudflare(addr) {
		// Cloudflare's edge connects from many addresses; trust them all.
		suggest, fromCloudflare = "cloudflare", true
	}
	if len(trusted) > 0 {
		suggest = strings.Join(append(trusted, suggest), ",")
	}

	var diagnosis []string
	last := trace[len(trace)-1]
	switch {
	case !peer.Trusted && len(xff) == 0:
		diagnosis = append(diagnosis, fmt.Sprintf("Direct connection from %s with no X-Forwarded-For; "+
			"failed logins count against %s. If a reverse proxy is in front, it isn't adding X-Forwarded-For.",
			peer.Addr, client))
	case !peer.Trusted && fromCloudflare:
		diagnosis = append(diagnosis, fmt.Sprintf("The connection comes from %s, one of Cloudflare's "+
			"addresses, which aren't trusted, so failed logins count against %s and every visitor shares "+
			"Cloudflare's few addresses. Trust them all: WEB_TRUSTED_PROXIES=%s. Not just this one; "+
			"Cloudflare connects from many.", peer.Addr, client, suggest))
	case !peer.Trusted && r.Header.Get("Cf-Ray") != "":
		diagnosis = append(diagnosis, fmt.Sprintf("The request came through Cloudflare (it has a Cf-Ray "+
			"header), but the connection comes from %s, which isn't one of Cloudflare's addresses or "+
			"trusted, so failed logins count against %s. With a Cloudflare Tunnel, that's cloudflared: "+
			"trust its address (WEB_TRUSTED_PROXIES=%s) and give it a fixed one on a Docker network.",
			peer.Addr, client, suggest))
	case !peer.Trusted:
		diagnosis = append(diagnosis, fmt.Sprintf("The connection comes from %s, which isn't in "+
			"WEB_TRUSTED_PROXIES (and WEB_TRUST_NPROXIES is 0), so its X-Forwarded-For is ignored and "+
			"failed logins count against %s. If %s is your reverse proxy, trust it: "+
			"WEB_TRUSTED_PROXIES=%s. On a Docker network, give the proxy a fixed address rather than "+
			"trusting the network's range, which includes its gateway, where visitors through a "+
			"published port appear to come from. If the proxy's address changes (a platform's load "+
			"balancer) and every visitor comes through it, use WEB_TRUST_NPROXIES=1 instead.",
			peer.Addr, client, peer.Addr, suggest))
	case len(xff) == 0:
		diagnosis = append(diagnosis, fmt.Sprintf("%s is a trusted proxy but sent no X-Forwarded-For, so "+
			"every visitor through it counts as %s. Have the proxy set X-Forwarded-For.", peer.Addr, client))
	case last.Note != "" && last.Addr != client:
		diagnosis = append(diagnosis, fmt.Sprintf("X-Forwarded-For contains %q, which isn't an IP address; "+
			"the client is taken as %s, the last trusted address before it.", last.Addr, client))
	case last.Note != "":
		diagnosis = append(diagnosis, fmt.Sprintf("The client is %s: the address Cloudflare added to "+
			"X-Forwarded-For. Entries left of it came from the visitor and are ignored.", client))
	case last.Trusted && last.By == "WEB_TRUST_NPROXIES":
		diagnosis = append(diagnosis, fmt.Sprintf("WEB_TRUST_NPROXIES=%d trusts more hops than this request "+
			"came through, so the client is taken as the leftmost X-Forwarded-For entry, %s, which the "+
			"visitor could have written. Set WEB_TRUST_NPROXIES to the number of proxies in front.",
			g.trustNProxies, client))
	case last.Trusted:
		diagnosis = append(diagnosis, fmt.Sprintf("Every address in X-Forwarded-For is trusted, so the "+
			"client is taken as the leftmost, %s. If that's a proxy too, the visitor's address is missing.", client))
	default:
		diagnosis = append(diagnosis, fmt.Sprintf("The client is %s: reading X-Forwarded-For from the "+
			"right, the first address that isn't a trusted proxy.", client))
	}
	if peer.By == "WEB_TRUST_NPROXIES" {
		diagnosis = append(diagnosis, fmt.Sprintf("The connection from %s is trusted by count "+
			"(WEB_TRUST_NPROXIES=%d), whatever its address. That's only safe if nobody can reach the "+
			"container except through that proxy.", peer.Addr, g.trustNProxies))
	}
	for _, h := range trace[1:] {
		if h.Trusted && h.By == "WEB_TRUST_NPROXIES" {
			diagnosis = append(diagnosis, fmt.Sprintf("X-Forwarded-For entry %s is trusted by count "+
				"(WEB_TRUST_NPROXIES=%d): it should be one of your proxies. If it's the visitor, the "+
				"count is too high and visitors can choose their own IP.", h.Addr, g.trustNProxies))
		} else if h.Trusted {
			diagnosis = append(diagnosis, fmt.Sprintf("X-Forwarded-For entry %s is trusted, so the address "+
				"left of it is believed. That's right if %s is another proxy of yours; if it's a Docker "+
				"network's gateway or any address visitors arrive from, visitors can choose their own IP.",
				h.Addr, h.Addr))
		}
	}
	// The browser decides what needs HTTPS (audio, saving downloads
	// straight to disk); this is only what the gateway can tell.
	const needsHTTPS = " Audio, and saving large downloads straight to disk, need HTTPS (or localhost)."
	switch {
	case r.TLS != nil:
		diagnosis = append(diagnosis, "HTTPS straight to tabtopd.")
	case !peer.Trusted && len(proto) > 0:
		diagnosis = append(diagnosis, fmt.Sprintf("X-Forwarded-Proto (%s) is ignored from an untrusted "+
			"connection, so the scheme the browser used is unknown.", strings.Join(proto, ", ")))
	case !peer.Trusted:
		diagnosis = append(diagnosis, "Plain HTTP and no trusted proxy."+needsHTTPS)
	case len(proto) == 0:
		diagnosis = append(diagnosis, "The trusted proxy sent no X-Forwarded-Proto, so the scheme the "+
			"browser used is unknown.")
	case g.secure(r):
		diagnosis = append(diagnosis, "The trusted proxy reports HTTPS.")
	default:
		diagnosis = append(diagnosis, fmt.Sprintf("The trusted proxy reports %s.%s", strings.Join(proto, ", "), needsHTTPS))
	}

	return map[string]any{
		"connection_from":    r.RemoteAddr,
		"connection_trusted": peer.Trusted,
		"host":               r.Host,
		"x_forwarded_for":    xff,
		"x_forwarded_proto":  proto,
		"trusted_proxies":    trusted,
		"trust_nproxies":     g.trustNProxies,
		"client_ip":          client,
		"https":              g.secure(r),
		"trace":              trace,
		"diagnosis":          diagnosis,
	}
}
