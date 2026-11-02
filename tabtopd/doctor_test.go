package main

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeXvnc listens like Xvnc and greets each connection.
func fakeXvnc(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			c.Write([]byte("RFB 003.008\n"))
			c.Close()
		}
	}()
	return l.Addr().String()
}

func newDoctorServer(t *testing.T, doctorOn bool) (*server, *httptest.Server) {
	t.Helper()
	g := newUsersFile(t, "s3cret")
	novnc := t.TempDir()
	os.WriteFile(filepath.Join(novnc, "vnc.html"), []byte("noVNC"), 0o644)
	g.base, g.novncDir, g.downloadsDir, g.nobleDir, g.doctorOn = "/", novnc, t.TempDir(), fakeNoble(t), doctorOn
	g.vncAddr = fakeXvnc(t)
	g.sessions, g.failures, g.pending, g.ttys = map[string]*session{}, map[string][]time.Time{}, map[string]int{}, map[string]int{}
	srv := httptest.NewServer(g.handler())
	t.Cleanup(srv.Close)
	return g, srv
}

func fetch(t *testing.T, url string) (int, string) {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(body)
}

func TestHealthz(t *testing.T) {
	g, srv := newDoctorServer(t, false)
	if status, body := fetch(t, srv.URL+"/healthz"); status != 200 || body != "ok\n" {
		t.Errorf("healthy: %d %q", status, body)
	}

	os.WriteFile(g.usersFile, []byte("garbage"), 0o600)
	if status, _ := fetch(t, srv.URL+"/healthz"); status != 503 {
		t.Errorf("unreadable users file: %d, want 503", status)
	}

	g, srv = newDoctorServer(t, false)
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	g.vncAddr = l.Addr().String()
	l.Close() // nothing listens there now
	if status, _ := fetch(t, srv.URL+"/healthz"); status != 503 {
		t.Errorf("Xvnc not listening: %d, want 503", status)
	}
}

func TestDoctor(t *testing.T) {
	_, off := newDoctorServer(t, false)
	if status, _ := fetch(t, off.URL+"/doctor"); status != 404 {
		t.Errorf("doctor off: %d, want 404", status)
	}

	g, srv := newDoctorServer(t, true)
	g.newSession("198.51.100.77", "")
	status, body := fetch(t, srv.URL+"/doctor")
	if status != 200 {
		t.Fatalf("doctor on: %d\n%s", status, body)
	}
	var report struct {
		Healthy bool             `json:"healthy"`
		Checks  map[string]check `json:"checks"`
		Clock   struct {
			Unix int64 `json:"unix"`
		} `json:"clock"`
	}
	if err := json.Unmarshal([]byte(body), &report); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, body)
	}
	for _, name := range []string{"vnc", "login", "novnc", "downloads", "audio", "terminal", "tunnel"} {
		if c, ok := report.Checks[name]; !ok || !c.OK {
			t.Errorf("check %s: %+v", name, c)
		}
	}
	if !report.Healthy || !strings.HasPrefix(report.Checks["vnc"].Detail, "RFB 003.008") || report.Clock.Unix == 0 {
		t.Errorf("report: %s", body)
	}
	if !strings.Contains(body, `"web_sessions": 1`) {
		t.Errorf("session not counted: %s", body)
	}
	// It's served without a login, so it says nothing about sessions but
	// how many.
	for _, secret := range []string{"alice", "s3cret", hex.EncodeToString(testKey), "198.51.100.77"} {
		if strings.Contains(body, secret) {
			t.Errorf("report contains %q", secret)
		}
	}
}

func TestDoctorProxy(t *testing.T) {
	g, srv := newDoctorServer(t, true)
	report := func(xff, proto string) (p struct {
		ConnectionTrusted bool     `json:"connection_trusted"`
		ClientIP          string   `json:"client_ip"`
		HTTPS             bool     `json:"https"`
		XForwardedFor     []string `json:"x_forwarded_for"`
		Trace             []hop    `json:"trace"`
		Diagnosis         []string `json:"diagnosis"`
	}) {
		t.Helper()
		req, _ := http.NewRequest("GET", srv.URL+"/doctor", nil)
		if xff != "" {
			req.Header.Set("X-Forwarded-For", xff)
		}
		if proto != "" {
			req.Header.Set("X-Forwarded-Proto", proto)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var body struct {
			Proxy json.RawMessage `json:"proxy"`
		}
		json.NewDecoder(resp.Body).Decode(&body)
		if err := json.Unmarshal(body.Proxy, &p); err != nil {
			t.Fatalf("proxy section: %v", err)
		}
		return p
	}
	has := func(diagnosis []string, s string) bool {
		return strings.Contains(strings.Join(diagnosis, " "), s)
	}

	// Untrusted connection: its headers are shown, ignored, and explained.
	p := report("203.0.113.9", "https")
	if p.ConnectionTrusted || p.ClientIP != "127.0.0.1" || p.HTTPS ||
		len(p.XForwardedFor) != 1 || p.XForwardedFor[0] != "203.0.113.9" ||
		!has(p.Diagnosis, "isn't in WEB_TRUSTED_PROXIES") || !has(p.Diagnosis, "WEB_TRUSTED_PROXIES=127.0.0.1") ||
		!has(p.Diagnosis, "X-Forwarded-Proto (https) is ignored") {
		t.Errorf("untrusted: %+v", p)
	}

	g.trustedProxies, _ = parsePrefixes("127.0.0.1, ::1")
	p = report("1.2.3.4, 203.0.113.9", "https")
	if !p.ConnectionTrusted || p.ClientIP != "203.0.113.9" || !p.HTTPS || len(p.Trace) != 2 ||
		p.Trace[1].Addr != "203.0.113.9" || p.Trace[1].Trusted || !has(p.Diagnosis, "The trusted proxy reports HTTPS") {
		t.Errorf("trusted: %+v", p)
	}
	if has(p.Diagnosis, "is trusted, so the address") {
		t.Errorf("warned about a trusted entry with none: %+v", p)
	}
	p = report("198.51.100.23, 127.0.0.1", "")
	if p.ClientIP != "198.51.100.23" || !has(p.Diagnosis, "entry 127.0.0.1 is trusted") {
		t.Errorf("trusted entry in X-Forwarded-For: %+v", p)
	}

	p = report("", "")
	if !has(p.Diagnosis, "sent no X-Forwarded-For") || !has(p.Diagnosis, "sent no X-Forwarded-Proto") {
		t.Errorf("trusted, no headers: %+v", p)
	}

	p = report("203.0.113.9, junk", "")
	if p.ClientIP != "127.0.0.1" || !has(p.Diagnosis, `contains "junk"`) {
		t.Errorf("garbage entry: %+v", p)
	}
}

func TestDoctorCloudflare(t *testing.T) {
	g := &server{}
	diagnosis := func(peer string, header ...string) string {
		r, _ := http.NewRequest("GET", "/doctor", nil)
		r.RemoteAddr = peer
		r.Header.Set("X-Forwarded-For", "203.0.113.9")
		for i := 0; i < len(header); i += 2 {
			r.Header.Set(header[i], header[i+1])
		}
		return strings.Join(g.proxyReport(r)["diagnosis"].([]string), " ")
	}
	// Straight from Cloudflare's edge: trust all of it, not one address.
	if d := diagnosis("162.158.1.2:5000"); !strings.Contains(d, "WEB_TRUSTED_PROXIES=cloudflare.") {
		t.Errorf("edge: %s", d)
	}
	// Through cloudflared: trust its address.
	if d := diagnosis("172.18.0.5:5000", "Cf-Ray", "8a1b2c3d4e5f-SIN"); !strings.Contains(d, "cloudflared") ||
		!strings.Contains(d, "WEB_TRUSTED_PROXIES=172.18.0.5)") {
		t.Errorf("cloudflared: %s", d)
	}
	// With another proxy trusted already, still all of Cloudflare.
	g.trustedProxies, _ = parsePrefixes("10.0.0.5")
	if d := diagnosis("162.158.1.2:5000"); !strings.Contains(d, "WEB_TRUSTED_PROXIES=10.0.0.5/32,cloudflare.") {
		t.Errorf("edge, another proxy trusted: %s", d)
	}
	g.trustedProxies, _ = parsePrefixes("cloudflare")
	if d := diagnosis("162.158.1.2:5000"); !strings.Contains(d, "The client is 203.0.113.9: the address Cloudflare added") {
		t.Errorf("trusted edge: %s", d)
	}
	if got := g.proxyReport(httptest.NewRequest("GET", "/doctor", nil))["trusted_proxies"]; len(got.([]string)) != 1 {
		t.Errorf("trusted_proxies: %v", got)
	}
}

func TestCountEntries(t *testing.T) {
	dir := t.TempDir()
	for want, n := range map[string]int{"0": 0, "3": 3, "5": 5, "5+": 7} {
		os.RemoveAll(dir)
		os.Mkdir(dir, 0o755)
		for i := range n {
			os.WriteFile(filepath.Join(dir, fmt.Sprint(i)), nil, 0o644)
		}
		if got, err := countEntries(dir, 5); got != want || err != nil {
			t.Errorf("%d entries: %q, %v; want %q", n, got, err, want)
		}
	}
}

func TestLocalHost(t *testing.T) {
	for host, want := range map[string]bool{
		"": true, "localhost": true, "127.0.0.1": true, "::1": true, "0.0.0.0": true,
		"192.0.2.10": false, "2001:db8::1": false, "vnc.example": false,
	} {
		if got := localHost(host); got != want {
			t.Errorf("localHost(%q) = %v, want %v", host, got, want)
		}
	}
}
