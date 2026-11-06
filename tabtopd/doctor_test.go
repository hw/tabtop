package main

import (
	"crypto/sha256"
	"encoding/base64"
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
	"sync"
	"sync/atomic"
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
	g.vncAddr = "unix:" + filepath.Join(t.TempDir(), "gone.sock") // nothing listens there
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
	if !report.Healthy || !strings.Contains(report.Checks["vnc"].Detail, "at VNC_ADDR") || report.Clock.Unix == 0 {
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
	g := &server{serverConfig: defaultServerConfig()}
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
	// A proxy behind Cloudflare, which added the edge's address: trust
	// both, and the visitor is the entry left of it.
	behind := func() *http.Request {
		r, _ := http.NewRequest("GET", "/doctor", nil)
		r.RemoteAddr = "10.192.45.1:60088"
		r.Header.Set("X-Forwarded-For", "61.13.203.162, 108.162.226.144")
		r.Header.Set("Cf-Ray", "8a1b2c3d4e5f-SIN")
		return r
	}
	d := strings.Join(g.proxyReport(behind())["diagnosis"].([]string), " ")
	if !strings.Contains(d, "WEB_TRUSTED_PROXIES=10.192.45.1,cloudflare.") || !strings.Contains(d, "taken as 61.13.203.162") ||
		!strings.Contains(d, "WEB_TRUST_NPROXIES=1 with WEB_TRUSTED_PROXIES=cloudflare") || strings.Contains(d, "cloudflared") {
		t.Errorf("behind Cloudflare: %s", d)
	}
	// Either fix it suggests works.
	for _, fix := range []struct {
		proxies string
		n       int
	}{{"10.192.45.1,cloudflare", 0}, {"cloudflare", 1}} {
		h := &server{serverConfig: defaultServerConfig()}
		h.trustedProxies, _ = parsePrefixes(fix.proxies)
		h.trustNProxies = fix.n
		if got := h.clientIP(behind()); got != "61.13.203.162" {
			t.Errorf("%+v: client %s", fix, got)
		}
	}
	// With only the proxy trusted, the client is a Cloudflare address:
	// trust Cloudflare too.
	h := &server{serverConfig: defaultServerConfig()}
	h.trustedProxies, _ = parsePrefixes("10.192.45.1")
	if d := strings.Join(h.proxyReport(behind())["diagnosis"].([]string), " "); !strings.Contains(d, "WEB_TRUSTED_PROXIES=10.192.45.1/32,cloudflare.") {
		t.Errorf("only the proxy trusted: %s", d)
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

func TestCheckVNCAddr(t *testing.T) {
	for addr, ok := range map[string]bool{
		"127.0.0.1:5901": true, "vnc.example:5900": true, "[2001:db8::1]:5900": true, "unix:/run/vnc.sock": true,
		"vnc.example:0": false, "vnc.example:65536": false, "vnc.example:99999": false, "vnc.example:x": false,
		"2001:db8::1:5900": false, "vnc.example": false, ":5900": false, "unix:": false, "unix:vnc.sock": false,
		"unix:/": false, "a b:5900": false,
	} {
		if err := checkVNCAddr(addr); (err == nil) != ok {
			t.Errorf("checkVNCAddr(%q) = %v, want ok %v", addr, err, ok)
		}
	}
}

// countingListener accepts connections on l, counting them.
func countingListener(t *testing.T, l net.Listener) *atomic.Int32 {
	t.Helper()
	t.Cleanup(func() { l.Close() })
	var n atomic.Int32
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			n.Add(1)
			c.Close()
		}
	}()
	return &n
}

// TestHealthzNoConnection never connects to the VNC server, which servers
// such as TigerVNC count as an abandoned login: a TCP address isn't
// checked, Xvnc's own socket is found in the kernel's table, and a socket
// the table lists under another path (as one bind-mounted from the host)
// by being a socket.
func TestHealthzNoConnection(t *testing.T) {
	g, srv := newDoctorServer(t, true)
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	tcp := countingListener(t, l)
	g.vncAddr = l.Addr().String()
	for range 5 {
		if status, _ := fetch(t, srv.URL+"/healthz"); status != 200 {
			t.Errorf("TCP healthz: %d", status)
		}
	}
	if _, body := fetch(t, srv.URL+"/doctor"); !strings.Contains(body, "not connected to") {
		t.Errorf("doctor doesn't say the TCP server wasn't connected to:\n%s", body)
	}

	dir := t.TempDir()
	path := filepath.Join(dir, "vnc.sock")
	ul, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	unix := countingListener(t, ul)
	g.vncAddr = "unix:" + path
	if status, _ := fetch(t, srv.URL+"/healthz"); status != 200 {
		t.Errorf("own socket: %d", status)
	}
	elsewhere := filepath.Join(t.TempDir(), "mounted.sock")
	if err := os.Symlink(path, elsewhere); err != nil {
		t.Fatal(err)
	}
	if unixListening(elsewhere) == nil {
		t.Fatal("the kernel's table lists the link's path; the test needs it not to")
	}
	g.vncAddr = "unix:" + elsewhere
	if status, _ := fetch(t, srv.URL+"/healthz"); status != 200 {
		t.Errorf("socket under another path: %d", status)
	}
	if n := tcp.Load() + unix.Load(); n != 0 {
		t.Errorf("connected to the VNC server %d times, want never", n)
	}
}

// TestNoVNCHeaders checks that the desktop page can't be framed by another
// site, nor its files sniffed.
func TestNoVNCHeaders(t *testing.T) {
	_, srv := newDoctorServer(t, false)
	resp, err := http.Get(srv.URL + "/vnc.html")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	for name, want := range map[string]string{
		"Content-Security-Policy": "frame-ancestors 'none'",
		"X-Frame-Options":         "DENY",
		"X-Content-Type-Options":  "nosniff",
	} {
		if got := resp.Header.Get(name); resp.StatusCode != 200 || !strings.Contains(got, want) {
			t.Errorf("%d, %s: %q, want %q", resp.StatusCode, name, got, want)
		}
	}
}

// TestNoVNCCSP allows the desktop page's inline scripts by their hashes,
// taken as the browser takes them, with \r\n made \n, and no others.
func TestNoVNCCSP(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "vnc.html"), []byte("<script type=\"module\" src=\"a.js\"></script>\r\n"+
		"<script type=\"module\">\r\n  start();\r\n</script>"), 0o644)
	sum := sha256.Sum256([]byte("\n  start();\n"))
	want := "script-src 'self' 'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "';"
	if csp := novncCSP(dir); !strings.Contains(csp, want) || strings.Count(csp, "sha256-") != 1 {
		t.Errorf("CSP %q, want it to have %q", csp, want)
	}
	if csp := novncCSP(t.TempDir()); !strings.Contains(csp, "script-src 'self';") {
		t.Errorf("without a page: %q", csp)
	}
}

// TestDoctorRedacts keeps the home folder, which names the account, and
// the VNC server's address out of the report.
func TestDoctorRedacts(t *testing.T) {
	g, srv := newDoctorServer(t, true)
	home := filepath.Dir(g.usersFile)
	t.Setenv("HOME", home)
	status, body := fetch(t, srv.URL+"/doctor")
	if status != 200 {
		t.Fatalf("doctor: %d", status)
	}
	for _, leak := range []string{home, g.vncAddr, `"go"`} {
		if strings.Contains(body, leak) {
			t.Errorf("report has %q:\n%s", leak, body)
		}
	}
	for _, want := range []string{"~/users.oath", "at VNC_ADDR"} {
		if !strings.Contains(body, want) {
			t.Errorf("report lacks %q:\n%s", want, body)
		}
	}
}

func TestDoctorCollector(t *testing.T) {
	g, _ := newDoctorServer(t, true)
	clock := newManualClock()
	g.clock = clock.lifecycle()
	id, _, _ := g.newSession("192.0.2.1", "browser")
	defer g.endSession(id, "", nil)
	g.beginLogin("192.0.2.2")
	g.endLogin("192.0.2.2", "", true)
	report := g.collectDoctorReport(httptest.NewRequest(http.MethodGet, "http://localhost/doctor", nil))
	if !report.Healthy || report.State.WebSessions != 1 || report.Clock.Unix != clock.lifecycle().Now().Unix() {
		t.Fatalf("collected report: %+v", report)
	}
	if strings.Contains(report.Checks["vnc"].Detail, g.vncAddr) {
		t.Fatal("collector exposed VNC address")
	}
}

func TestDoctorProbeCache(t *testing.T) {
	clock := newManualClock()
	cache := doctorProbeCache{clock: clock.lifecycle()}
	var calls atomic.Int32
	started, release := make(chan struct{}), make(chan struct{})
	probe := func() doctorProbeResult {
		if calls.Add(1) == 1 {
			close(started)
			<-release
		}
		return doctorProbeResult{vnc: check{OK: false, Detail: "offline"}, audioErr: fmt.Errorf("no audio")}
	}
	var wg sync.WaitGroup
	for range 20 {
		wg.Go(func() {
			result := cache.get(probe)
			if result.vnc.OK || result.vnc.Detail != "offline" || result.audioErr == nil {
				t.Errorf("cached result: %+v", result)
			}
		})
	}
	<-started
	close(release)
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("concurrent probe batches: %d", calls.Load())
	}
	clock.Advance(vncProbeCache - time.Nanosecond)
	cache.get(probe)
	if calls.Load() != 1 {
		t.Fatal("failure result was not cached")
	}
	clock.Advance(time.Nanosecond)
	cache.get(probe)
	if calls.Load() != 2 {
		t.Fatal("expired probes were not retried")
	}
}

func TestDoctorBoundsUpstreamConnections(t *testing.T) {
	for _, x509 := range []bool{false, true} {
		t.Run(fmt.Sprint("x509=", x509), func(t *testing.T) {
			g, srv := newDoctorServer(t, true)
			clock := newManualClock()
			g.doctorProbes.clock = clock.lifecycle()
			l, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer l.Close()
			var accepted atomic.Int32
			go func() {
				for {
					c, err := l.Accept()
					if err != nil {
						return
					}
					accepted.Add(1)
					c.Write(rfbVersionMsg(8))
					c.Close()
				}
			}()
			g.vncAddr, g.vncX509 = l.Addr().String(), x509
			var wg sync.WaitGroup
			for i := range 20 {
				wg.Go(func() {
					method := http.MethodHead
					if i%2 == 0 {
						method = http.MethodGet
					}
					req, _ := http.NewRequest(method, srv.URL+"/doctor", nil)
					res, err := http.DefaultClient.Do(req)
					if err != nil {
						t.Error(err)
						return
					}
					defer res.Body.Close()
					if res.StatusCode != 200 {
						t.Errorf("status=%d", res.StatusCode)
					}
				})
			}
			wg.Wait()
			want := int32(0) // Diagnostics must never start a VNC login.
			if n := accepted.Load(); n != want {
				t.Fatalf("20 requests opened %d connections, want %d", n, want)
			}
			clock.Advance(vncProbeCache)
			fetch(t, srv.URL+"/doctor")
			if n := accepted.Load(); n != 2*want {
				t.Fatalf("after expiry opened %d connections, want %d", n, 2*want)
			}
		})
	}
}

// The warning Sessions and Activity shows when the client IP looks like a
// proxy's.
func TestIPWarning(t *testing.T) {
	req := func(peer string, header ...string) *http.Request {
		r := httptest.NewRequest("GET", "/tunnel", nil)
		r.RemoteAddr = peer
		for i := 0; i+1 < len(header); i += 2 {
			r.Header.Set(header[i], header[i+1])
		}
		return r
	}
	behind := []string{"X-Forwarded-For", "61.13.203.162, 108.162.226.144", "Cf-Ray", "8a1b2c3d4e5f-SIN"}
	for _, c := range []struct {
		trusted string
		n       int
		r       *http.Request
		want    string // in the warning; "" for none
	}{
		// Direct, from anywhere: nothing to say.
		{"", 0, req("192.168.1.20:5000"), ""},
		{"", 0, req("203.0.113.9:5000"), ""},
		// A trusted LAN proxy passing on a LAN visitor: fine.
		{"10.0.0.5", 0, req("10.0.0.5:5000", "X-Forwarded-For", "192.168.1.20"), ""},
		// The setup in the report: neither trusted.
		{"", 0, req("10.192.45.1:60088", behind...), "sees this browser as 10.192.45.1, which looks like a proxy's"},
		// Only the proxy: the visitor is taken as Cloudflare.
		{"10.192.45.1", 0, req("10.192.45.1:60088", behind...), "one of Cloudflare's"},
		// Fixed, either way.
		{"10.192.45.1,cloudflare", 0, req("10.192.45.1:60088", behind...), ""},
		{"cloudflare", 1, req("10.192.45.1:60088", behind...), ""},
		// Cloudflare connecting straight to the container, not trusted.
		{"", 0, req("162.158.1.2:5000", "X-Forwarded-For", "203.0.113.9"), "WEB_TRUSTED_PROXIES=cloudflare"},
	} {
		g := &server{serverConfig: defaultServerConfig()}
		g.trustedProxies, _ = parsePrefixes(c.trusted)
		g.trustNProxies = c.n
		got := g.ipWarning(c.r)
		if c.want == "" && got != "" || c.want != "" && !strings.Contains(got, c.want) {
			t.Errorf("%q, %d, from %s %v: %q, want %q", c.trusted, c.n, c.r.RemoteAddr, c.r.Header, got, c.want)
		}
	}
}
