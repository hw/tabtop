package main

// healthz is a liveness check for Docker and load balancers; doctor is a
// troubleshooting report, served only with -doctor.

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// How long the doctor report's checks are kept, shared by every request
// in the meantime.
const vncProbeCache = 10 * time.Second

// healthz answers 200 while Xvnc is listening and the TOTP users file can be
// read, so logins can work. It needs no login and reveals nothing else.
// See vncListening for how the RFB server is checked.
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

// vncListening reports whether the RFB server is there, without connecting
// to it: a connection closed without logging in counts as an abandoned
// login on servers such as TigerVNC, even one closed as soon as it opens,
// and enough of them, which anyone could cause through healthz, get the
// gateway's address blacklisted, refusing the desktop too. A socket is
// found in the kernel's table, or, mounted from elsewhere (which the table
// lists under its original path), by being a socket. A TCP address isn't
// checked: health then says the gateway can serve, and the doctor report
// how its last login to the server went.
func (g *server) vncListening() error {
	path, ok := strings.CutPrefix(g.vncAddr, "unix:")
	if !ok {
		return nil
	}
	if unixListening(path) == nil {
		return nil
	}
	if st, err := os.Stat(path); err == nil && st.Mode()&os.ModeSocket != 0 {
		return nil
	}
	return fmt.Errorf("nothing listens on the VNC server's socket %s", path)
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

type check struct {
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
}

// Public diagnostics share one batch of network probes for ten seconds,
// including failed probes. Holding mu through the batch bounds upstream
// concurrency to one probe, even when many requests arrive together.
type doctorProbeCache struct {
	mu     sync.Mutex
	clock  lifecycleClock
	at     time.Time
	result doctorProbeResult
}

type doctorProbeResult struct {
	vnc      check
	audioErr error
}

func (p *doctorProbeCache) get(probe func() doctorProbeResult) doctorProbeResult {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.at.IsZero() || p.clock.Now().Sub(p.at) >= vncProbeCache {
		p.result = probe()
		p.at = p.clock.Now()
	}
	return p.result
}

// vncLoginCheck adds to the VNC server's check how the gateway's last
// login to it went, when the gateway logs in (VNC_UPSTREAM_PASSWORD or
// VNC_X509): a failure fails the check, with its reason.
func (g *server) vncLoginCheck(c check) check {
	if g.vncPassword() == "" && !g.vncX509 {
		return c // noVNC logs in itself
	}
	at, err := g.vncBackoff.last()
	kind := "VNC Authentication"
	if g.vncX509 {
		kind = fmt.Sprintf("VeNCrypt %s with a verified certificate", x509Name(g.x509Subtype()))
	}
	switch {
	case at.IsZero():
		c.Detail += "; no desktop has logged in to it yet"
	case err != nil:
		return newCheck("", fmt.Errorf("the last login to it, %v ago, failed: %v", time.Since(at).Round(time.Second), err))
	default:
		c.Detail += fmt.Sprintf("; last logged in to %v ago, with %s", time.Since(at).Round(time.Second), kind)
	}
	return c
}

func (g *server) probeDoctorServices() doctorProbeResult {
	// The same check as healthz, which doesn't connect (see vncListening).
	// How the gateway's last real login went is reported instead (see
	// vncLoginCheck).
	detail := fmt.Sprintf("listening at %s", g.vncAddr)
	if !strings.HasPrefix(g.vncAddr, "unix:") {
		detail = fmt.Sprintf("at %s, not connected to (that could get the gateway blacklisted)", g.vncAddr)
	}
	result := doctorProbeResult{vnc: newCheck(detail, g.vncListening())}
	if g.audio != nil {
		result.audioErr = g.audio.checkSink()
	}
	return result
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
// so it leaves out the password and TOTP key, and redacts what would name
// the account or the VNC server (see redact).
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

	report := g.collectDoctorReport(r)
	h.Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	enc.Encode(report)
}

type doctorReport struct {
	Healthy  bool             `json:"healthy"`
	Checks   map[string]check `json:"checks"`
	Clock    doctorClock      `json:"clock"`
	Proxy    map[string]any   `json:"proxy"`
	BasePath string           `json:"base_path"`
	State    doctorState      `json:"state"`
}

type doctorClock struct {
	UTC      string `json:"utc"`
	Unix     int64  `json:"unix"`
	TOTPStep int64  `json:"totp_step"`
	Note     string `json:"note"`
}

type doctorState struct {
	WebSessions    int  `json:"web_sessions"`
	OpenTerminals  int  `json:"open_terminals"`
	LockedOutIPs   int  `json:"locked_out_ips"`
	LoginsSlowed   bool `json:"logins_slowed"`
	AudioListeners int  `json:"audio_listeners"`
}

// collectDoctorReport gathers and redacts diagnostics independently of HTTP
// response handling. Request metadata is used only by the proxy diagnosis.
func (g *server) collectDoctorReport(r *http.Request) doctorReport {
	checks := map[string]check{}
	probes := g.doctorProbes.get(g.probeDoctorServices)
	checks["vnc"] = probes.vnc
	// Runtime cooldown and counters remain fresh rather than being cached.
	if left := g.vncBackoff.waiting(); probes.vnc.OK && left > 0 {
		if g.vncX509 {
			checks["vnc"] = newCheck("", fmt.Errorf("logging in to it failed (see the log), so the desktop is refused for another %v", left.Round(time.Second)))
		} else {
			checks["vnc"] = newCheck("", fmt.Errorf("it turned VNC_UPSTREAM_PASSWORD down (see the log), so noVNC asks for its password for another %v", left.Round(time.Second)))
		}
	} else if probes.vnc.OK {
		checks["vnc"] = g.vncLoginCheck(probes.vnc)
	}

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

	entries, err := countEntries(g.downloadsDir, maxListing)
	checks["downloads"] = newCheck(fmt.Sprintf("%s, %s entries", g.downloadsDir, entries), err)

	if g.audio == nil {
		checks["audio"] = check{OK: true, Detail: "off"}
	} else {
		checks["audio"] = newCheck(g.audio.describe(), probes.audioErr)
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

	state, now := g.doctorSnapshot()

	healthy := true
	for name, c := range checks {
		healthy = healthy && c.OK
		c.Detail = g.redact(c.Detail)
		checks[name] = c
	}
	return doctorReport{
		Healthy: healthy, Checks: checks,
		Clock: doctorClock{now.UTC().Format(time.RFC3339), now.Unix(), now.Unix() / 30, "codes are only accepted within 30s of this clock"},
		Proxy: g.proxyReport(r), BasePath: g.base, State: state,
	}
}

func (g *server) doctorSnapshot() (doctorState, time.Time) {
	var state doctorState
	g.mu.Lock()
	now := g.clock.Now()
	for _, s := range g.sessions {
		if g.liveLocked(s, now) {
			state.WebSessions++
		}
	}
	for _, n := range g.ttys {
		state.OpenTerminals += n
	}
	g.mu.Unlock()
	state.LockedOutIPs, state.LoginsSlowed = g.loginState()
	state.AudioListeners = g.audio.listenerCount()
	return state, now
}

// redact takes out of a check's detail, errors included, what would tell
// someone without a login the account's name or where the VNC server is:
// the home folder (/home/<VNC_USER>) becomes ~, the runtime folder
// (/tmp/runtime-<VNC_USER>) $XDG_RUNTIME_DIR, the VNC server's address
// VNC_ADDR, and the name in its certificate VNC_SERVER_NAME.
func (g *server) redact(s string) string {
	vnc := strings.TrimPrefix(g.vncAddr, "unix:")
	if vnc != "" {
		s = strings.ReplaceAll(s, vnc, "VNC_ADDR")
	}
	if g.vncServerName != "" {
		s = strings.ReplaceAll(s, g.vncServerName, "VNC_SERVER_NAME")
	}
	if rt := os.Getenv("XDG_RUNTIME_DIR"); len(rt) > 1 {
		s = strings.ReplaceAll(s, rt, "$XDG_RUNTIME_DIR")
	}
	if home, err := os.UserHomeDir(); err == nil && len(home) > 1 {
		s = strings.ReplaceAll(s, home, "~")
	}
	return s
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

	// A proxy behind Cloudflare puts the address Cloudflare's edge
	// connected from at the right of X-Forwarded-For: then both it and
	// Cloudflare need trusting, and the visitor is the entry left of it.
	var entries []string
	for _, v := range xff {
		entries = append(entries, strings.Split(v, ",")...)
	}
	edge, visitor := "", ""
	if n := len(entries); n > 0 {
		if a, err := parseHop(strings.TrimSpace(entries[n-1])); err == nil && inCloudflare(a) {
			edge = a.String()
			if n > 1 {
				visitor = strings.TrimSpace(entries[n-2])
			}
		}
	}
	behind := func(proxy string) string {
		via := ""
		if visitor != "" {
			via = fmt.Sprintf(" Then the client is taken as %s, the address Cloudflare added.", visitor)
		}
		return fmt.Sprintf("Trust both: WEB_TRUSTED_PROXIES=%s.%s If %s changes (a platform's load balancer) and "+
			"every visitor comes through it, use WEB_TRUST_NPROXIES=1 with WEB_TRUSTED_PROXIES=%s instead.",
			proxy, via, peer.Addr, strings.Join(append(trusted, "cloudflare"), ","))
	}
	clientAddr, _ := netip.ParseAddr(client)

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
	case !peer.Trusted && edge != "":
		diagnosis = append(diagnosis, fmt.Sprintf("The request came through Cloudflare, then a proxy at %s: "+
			"X-Forwarded-For ends with %s, one of Cloudflare's addresses, which that proxy added. Neither is "+
			"trusted, so failed logins count against %s. %s", peer.Addr, edge, client,
			behind(strings.Join(append(trusted, peer.Addr, "cloudflare"), ","))))
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
	case clientAddr.IsValid() && inCloudflare(clientAddr) && !last.Trusted:
		diagnosis = append(diagnosis, fmt.Sprintf("The client is taken as %s, one of Cloudflare's addresses: "+
			"%s is behind Cloudflare, which isn't trusted, so every visitor counts as one of Cloudflare's few "+
			"addresses. %s", client, peer.Addr, behind(strings.Join(append(trusted, "cloudflare"), ","))))
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

// countEntries counts dir's entries, stopping after limit: "12", or
// "10000+".
func countEntries(dir string, limit int) (string, error) {
	f, err := os.OpenFile(dir, directoryOpenFlags, 0)
	if err != nil {
		return "0", err
	}
	defer f.Close()
	n := 0
	for n <= limit {
		names, err := f.Readdirnames(1000)
		n += len(names)
		if err == io.EOF {
			break
		} else if err != nil {
			return "0", err
		}
	}
	if n > limit {
		return fmt.Sprintf("%d+", limit), nil
	}
	return strconv.Itoa(n), nil
}
