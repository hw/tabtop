package main

import (
	"encoding/hex"
	"encoding/json"
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
	g.base, g.novncDir, g.downloadsDir, g.doctorOn = "/", novnc, t.TempDir(), doctorOn
	g.vncAddr = fakeXvnc(t)
	g.sessions, g.failures, g.pending, g.ttys = map[string]time.Time{}, map[string][]time.Time{}, map[string]int{}, map[string]int{}
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
	_, srv := newDoctorServer(t, false)
	if status, _ := fetch(t, srv.URL+"/doctor"); status != 404 {
		t.Errorf("doctor off: %d, want 404", status)
	}

	_, srv = newDoctorServer(t, true)
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
	for _, name := range []string{"vnc", "login", "novnc", "downloads", "audio", "terminal"} {
		if c, ok := report.Checks[name]; !ok || !c.OK {
			t.Errorf("check %s: %+v", name, c)
		}
	}
	if !report.Healthy || !strings.HasPrefix(report.Checks["vnc"].Detail, "RFB 003.008") || report.Clock.Unix == 0 {
		t.Errorf("report: %s", body)
	}
	for _, secret := range []string{"alice", "s3cret", hex.EncodeToString(testKey)} {
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
		SecureCookies     bool     `json:"secure_cookies"`
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
	if p.ConnectionTrusted || p.ClientIP != "127.0.0.1" || p.SecureCookies ||
		len(p.XForwardedFor) != 1 || p.XForwardedFor[0] != "203.0.113.9" ||
		!has(p.Diagnosis, "isn't in WEB_TRUSTED_PROXIES") || !has(p.Diagnosis, "WEB_TRUSTED_PROXIES=127.0.0.1") ||
		!has(p.Diagnosis, "X-Forwarded-Proto (https) is ignored") {
		t.Errorf("untrusted: %+v", p)
	}

	g.trustedProxies, _ = parsePrefixes("127.0.0.1, ::1")
	p = report("1.2.3.4, 203.0.113.9", "https")
	if !p.ConnectionTrusted || p.ClientIP != "203.0.113.9" || !p.SecureCookies || len(p.Trace) != 2 ||
		p.Trace[1].Addr != "203.0.113.9" || p.Trace[1].Trusted || !has(p.Diagnosis, "cookies are Secure") {
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
