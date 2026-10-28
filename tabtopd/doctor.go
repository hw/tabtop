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
	h.Set("Cache-Control", "no-store")
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

// vncListening reports whether something listens on Xvnc's TCP port, from
// the kernel's socket tables.
func (g *server) vncListening() error {
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
	conn, err := net.DialTimeout("tcp", g.vncAddr, vncProbeTimeout)
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
	h.Set("Cache-Control", "no-store")
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

	if g.xtermDir == "" {
		checks["terminal"] = check{OK: true, Detail: "off"}
	} else {
		tmux, err := exec.LookPath("tmux")
		if err == nil {
			_, err = os.Stat(filepath.Join(g.xtermDir, "xterm.mjs"))
		}
		checks["terminal"] = newCheck(fmt.Sprintf("tmux %s, xterm.js in %s", tmux, g.xtermDir), err)
	}

	g.mu.Lock()
	now := time.Now()
	sessions, ttys, lockedOut := 0, 0, 0
	for _, expiry := range g.sessions {
		if now.Before(expiry) {
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

// proxyReport shows how this request's client IP and cookie security were
// worked out, whoever sent it, with what to change when it looks wrong.
func (g *server) proxyReport(r *http.Request) map[string]any {
	client, trace := g.traceClientIP(r)
	peer := trace[0]
	// Empty lists rather than null in the JSON, so "none" reads clearly.
	xff := append([]string{}, r.Header.Values("X-Forwarded-For")...)
	proto := append([]string{}, r.Header.Values("X-Forwarded-Proto")...)
	trusted := []string{}
	for _, p := range g.trustedProxies {
		trusted = append(trusted, p.String())
	}
	suggest := peer.Addr
	if len(trusted) > 0 {
		suggest = strings.Join(append(trusted, peer.Addr), ",")
	}

	var diagnosis []string
	last := trace[len(trace)-1]
	switch {
	case !peer.Trusted && len(xff) == 0:
		diagnosis = append(diagnosis, fmt.Sprintf("Direct connection from %s with no X-Forwarded-For; "+
			"failed logins count against %s. If a reverse proxy is in front, it isn't adding X-Forwarded-For.",
			peer.Addr, client))
	case !peer.Trusted:
		diagnosis = append(diagnosis, fmt.Sprintf("The connection comes from %s, which isn't in "+
			"WEB_TRUSTED_PROXIES, so its X-Forwarded-For is ignored and failed logins count against %s. "+
			"If %s is your reverse proxy, trust it: WEB_TRUSTED_PROXIES=%s. On a Docker network, "+
			"give the proxy a fixed address rather than trusting the network's range, which includes "+
			"its gateway, where visitors through a published port appear to come from.",
			peer.Addr, client, peer.Addr, suggest))
	case len(xff) == 0:
		diagnosis = append(diagnosis, fmt.Sprintf("%s is a trusted proxy but sent no X-Forwarded-For, so "+
			"every visitor through it counts as %s. Have the proxy set X-Forwarded-For.", peer.Addr, client))
	case last.Note != "":
		diagnosis = append(diagnosis, fmt.Sprintf("X-Forwarded-For contains %q, which isn't an IP address; "+
			"the client is taken as %s, the last trusted address before it.", last.Addr, client))
	case last.Trusted:
		diagnosis = append(diagnosis, fmt.Sprintf("Every address in X-Forwarded-For is trusted, so the "+
			"client is taken as the leftmost, %s. If that's a proxy too, the visitor's address is missing.", client))
	default:
		diagnosis = append(diagnosis, fmt.Sprintf("The client is %s: reading X-Forwarded-For from the "+
			"right, the first address that isn't a trusted proxy.", client))
	}
	for _, h := range trace[1:] {
		if h.Trusted {
			diagnosis = append(diagnosis, fmt.Sprintf("X-Forwarded-For entry %s is trusted, so the address "+
				"left of it is believed. That's right if %s is another proxy of yours; if it's a Docker "+
				"network's gateway or any address visitors arrive from, visitors can choose their own IP.",
				h.Addr, h.Addr))
		}
	}
	switch {
	case r.TLS != nil:
		diagnosis = append(diagnosis, "HTTPS straight to tabtopd: cookies are Secure.")
	case !peer.Trusted && len(proto) > 0:
		diagnosis = append(diagnosis, fmt.Sprintf("X-Forwarded-Proto (%s) is ignored from an untrusted "+
			"connection: cookies aren't Secure.", strings.Join(proto, ", ")))
	case !peer.Trusted:
		diagnosis = append(diagnosis, "Plain HTTP and no trusted proxy: cookies aren't Secure.")
	case len(proto) == 0:
		diagnosis = append(diagnosis, "The trusted proxy sent no X-Forwarded-Proto: cookies aren't Secure. "+
			"Have the proxy set it.")
	case g.secure(r):
		diagnosis = append(diagnosis, "The trusted proxy reports HTTPS: cookies are Secure.")
	default:
		diagnosis = append(diagnosis, fmt.Sprintf("The trusted proxy reports %s: cookies aren't Secure.",
			strings.Join(proto, ", ")))
	}

	return map[string]any{
		"connection_from":    r.RemoteAddr,
		"connection_trusted": peer.Trusted,
		"host":               r.Host,
		"x_forwarded_for":    xff,
		"x_forwarded_proto":  proto,
		"trusted_proxies":    trusted,
		"client_ip":          client,
		"secure_cookies":     g.secure(r),
		"trace":              trace,
		"diagnosis":          diagnosis,
	}
}
