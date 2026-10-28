package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha1"
	"crypto/tls"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// Test vectors from RFC 4226 appendix D and RFC 6238 appendix B (SHA-1).
func TestHOTP(t *testing.T) {
	key := []byte("12345678901234567890")
	for counter, want := range []string{"755224", "287082", "359152", "969429", "338314"} {
		if got := hotp(key, int64(counter), 6); got != want {
			t.Errorf("hotp(counter=%d) = %s, want %s", counter, got, want)
		}
	}
	for _, tc := range []struct {
		unix int64
		want string
	}{{59, "94287082"}, {1111111109, "07081804"}, {1234567890, "89005924"}, {20000000000, "65353130"}} {
		if got := hotp(key, tc.unix/30, 8); got != tc.want {
			t.Errorf("totp(t=%d) = %s, want %s", tc.unix, got, tc.want)
		}
	}
}

// hotp computes an RFC 4226 one-time password; TOTP feeds it the time step.
func hotp(key []byte, counter int64, digits int) string {
	mac := hmac.New(sha1.New, key)
	binary.Write(mac, binary.BigEndian, counter)
	sum := mac.Sum(nil)
	offset := sum[len(sum)-1] & 0x0F
	value := binary.BigEndian.Uint32(sum[offset:offset+4]) & 0x7FFFFFFF
	mod := uint32(1)
	for range digits {
		mod *= 10
	}
	return fmt.Sprintf("%0*d", digits, value%mod)
}

func TestParseUsersOath(t *testing.T) {
	user, digits, ok := parseUsersOath("HOTP/T30/6\talice\t-\t3132333435363738393031323334353637383930\n")
	if !ok || user != "alice" || digits != 6 {
		t.Fatalf("totp-only: user=%q digits=%d ok=%v", user, digits, ok)
	}
	user, digits, ok = parseUsersOath("HOTP/T30/8 bob s3cret " + hex.EncodeToString([]byte("12345678901234567890")) + " 1 2")
	if !ok || user != "bob" || digits != 8 {
		t.Fatalf("with pin: user=%q digits=%d ok=%v", user, digits, ok)
	}
	if _, _, ok := parseUsersOath("bad"); ok {
		t.Fatal("accepted a bad line")
	}
}

var testKey = []byte("12345678901234567890")

// newUsersFile writes a pam_oath users file for alice with pin ("-" for
// none), as the entrypoint does.
func newUsersFile(t *testing.T, pin string) *server {
	t.Helper()
	f := filepath.Join(t.TempDir(), "users.oath")
	line := "HOTP/T30/6\talice\t" + pin + "\t" + hex.EncodeToString(testKey) + "\n"
	if err := os.WriteFile(f, []byte(line), 0o600); err != nil {
		t.Fatal(err)
	}
	return &server{usersFile: f}
}

func code(offset int64) string { return hotp(testKey, time.Now().Unix()/30+offset, 6) }

func TestCredentialsOK(t *testing.T) {
	g := newUsersFile(t, "-")
	now := code(0)
	if !g.credentialsOK(now) {
		t.Fatal("TOTP-only: valid code rejected")
	}
	if g.credentialsOK(now) {
		t.Fatal("TOTP-only: reused code accepted")
	}
	if g.credentialsOK("s3cret" + code(1)) {
		t.Fatal("TOTP-only: accepted a password in front of the code")
	}

	// Once a later code is used, earlier ones in the window are refused.
	g = newUsersFile(t, "-")
	if !g.credentialsOK(code(1)) {
		t.Fatal("next code rejected")
	}
	if g.credentialsOK(code(0)) {
		t.Fatal("accepted a code older than the last one used")
	}
	if g.credentialsOK(code(5)) {
		t.Fatal("accepted a code outside the window")
	}

	g = newUsersFile(t, "s3cret")
	for _, cred := range []string{
		"wrong" + code(0), // wrong password
		code(0),           // code without password
		"s3cret",          // no code
		"s3cret000000",    // wrong code
		"",
	} {
		if g.credentialsOK(cred) {
			t.Errorf("password+TOTP: accepted %q", cred)
		}
	}
	if !g.credentialsOK("s3cret" + code(0)) {
		t.Fatal("password+TOTP: valid credentials rejected")
	}
}

// serverHandshake is what Xvnc sends up to (not including) the security result.
var serverHandshake = []byte("RFB 003.008\n\x01\x13\x00\x02\x00\x01\x00\x00\x01\x00")

func TestParseSecurityResult(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   []byte
		want rfbState
	}{
		{"partial", serverHandshake[:15], rfbNeedMore},
		{"awaiting result", serverHandshake, rfbNeedMore},
		{"ok", append(slices.Clone(serverHandshake), 0, 0, 0, 0), rfbOK},
		{"failed", append(slices.Clone(serverHandshake), 0, 0, 0, 1), rfbFailed},
		{"no security types", []byte("RFB 003.008\n\x00\x00\x00\x00\x04nope"), rfbNoLogin},
		{"VeNCrypt version refused", []byte("RFB 003.008\n\x01\x13\x00\x02\xff"), rfbNoLogin},
	} {
		if got := parseSecurityResult(tc.in); got != tc.want {
			t.Errorf("%s: got %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestWatcherSplitWrites(t *testing.T) {
	var got []bool
	w := &rfbWatcher{result: func(ok bool) { got = append(got, ok) }}
	stream := append(slices.Clone(serverHandshake), 0, 0, 0, 1, 'x', 'y')
	for _, b := range stream { // one byte at a time, as a slow network might deliver it
		w.Write([]byte{b})
	}
	if !slices.Equal(got, []bool{false}) {
		t.Errorf("results = %v, want one failure", got)
	}
}

func TestCheckClientHandshake(t *testing.T) {
	good := "RFB 003.008\n\x13\x00\x02\x00\x00\x01\x00"
	var fwd bytes.Buffer
	if err := checkClientHandshake(strings.NewReader(good+"creds"), &fwd); err != nil || fwd.String() != good {
		t.Errorf("good handshake: err=%v forwarded=%q", err, fwd.String())
	}
	for name, in := range map[string]string{
		"RFB 3.3":       "RFB 003.003\n",
		"VNC auth type": "RFB 003.008\n\x02",
		"TLS subtype":   "RFB 003.008\n\x13\x00\x02\x00\x00\x01\x03",
	} {
		fwd.Reset()
		if err := checkClientHandshake(strings.NewReader(in), &fwd); err != errBadHandshake {
			t.Errorf("%s: err = %v, want errBadHandshake", name, err)
		}
		if fwd.Len() >= len(in) { // only the steps before the bad one may reach the server
			t.Errorf("%s: forwarded the bad step: %q", name, fwd.String())
		}
	}
}

func TestClientIP(t *testing.T) {
	trusted, err := parsePrefixes("10.0.0.1, 172.16.0.0/12 2001:db8::/32")
	if err != nil {
		t.Fatal(err)
	}
	g := &server{trustedProxies: trusted}
	for _, tc := range []struct {
		name, peer string
		xff        []string
		want       string
	}{
		{"untrusted peer, header ignored", "198.51.100.7:5000", []string{"203.0.113.9"}, "198.51.100.7"},
		{"trusted peer, no header", "10.0.0.1:5000", nil, "10.0.0.1"},
		{"trusted peer", "10.0.0.1:5000", []string{"203.0.113.9"}, "203.0.113.9"},
		{"client-forged entries on the left ignored", "10.0.0.1:5000", []string{"1.2.3.4, 203.0.113.9"}, "203.0.113.9"},
		{"chain of trusted proxies", "10.0.0.1:5000", []string{"203.0.113.9, 172.20.0.5"}, "203.0.113.9"},
		{"split across headers", "10.0.0.1:5000", []string{"1.2.3.4", "203.0.113.9, 172.20.0.5"}, "203.0.113.9"},
		{"entry with port", "10.0.0.1:5000", []string{"203.0.113.9:4711"}, "203.0.113.9"},
		{"IPv6 peer and client", "[2001:db8::2]:5000", []string{"[2001:db9::7]:4711"}, "2001:db9::7"},
		{"IPv4-mapped peer", "[::ffff:10.0.0.1]:5000", []string{"203.0.113.9"}, "203.0.113.9"},
		{"garbage stops at last trusted hop", "10.0.0.1:5000", []string{"203.0.113.9, junk, 172.20.0.5"}, "172.20.0.5"},
		{"all hops trusted", "10.0.0.1:5000", []string{"172.20.0.9"}, "172.20.0.9"},
	} {
		r, _ := http.NewRequest("GET", "/", nil)
		r.RemoteAddr = tc.peer
		for _, v := range tc.xff {
			r.Header.Add("X-Forwarded-For", v)
		}
		if got := g.clientIP(r); got != tc.want {
			t.Errorf("%s: got %s, want %s", tc.name, got, tc.want)
		}
	}
	if _, err := parsePrefixes("10.0.0.1, not-an-ip"); err == nil {
		t.Error("parsePrefixes accepted an invalid entry")
	}
}

func TestParseBasePath(t *testing.T) {
	for in, want := range map[string]string{
		"": "/", "/": "/", "tabtop": "/tabtop/", "/tabtop": "/tabtop/", "/tabtop/": "/tabtop/",
		"/a/b.c_~-/": "/a/b.c_~-/",
	} {
		if got, err := parseBasePath(in); err != nil || got != want {
			t.Errorf("parseBasePath(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"/a//b/", "/a/../b/", "/./", "/a b/", "/a%2fb/", "/{x}/", "/ä/"} {
		if got, err := parseBasePath(in); err == nil {
			t.Errorf("parseBasePath(%q) = %q, want an error", in, got)
		}
	}
}

func TestServeUnderBasePath(t *testing.T) {
	novnc, downloads := t.TempDir(), t.TempDir()
	os.WriteFile(filepath.Join(novnc, "vnc.html"), []byte("noVNC"), 0o644)
	os.Mkdir(filepath.Join(downloads, "sub dir"), 0o755)
	key := []byte("12345678901234567890")
	users := filepath.Join(t.TempDir(), "users.oath")
	os.WriteFile(users, []byte("HOTP/T30/6\talice\t-\t"+hex.EncodeToString(key)+"\n"), 0o600)
	g := &server{base: "/tabtop/", novncDir: novnc, downloadsDir: downloads, usersFile: users, xtermDir: t.TempDir(),
		audio: newAudioHub("test", 64), sessions: map[string]time.Time{}, ttys: map[string]int{},
		failures: map[string][]time.Time{}, pending: map[string]int{}}
	srv := httptest.NewServer(g.handler())
	t.Cleanup(srv.Close)
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

	do := func(method, p, cookie string, form url.Values) (*http.Response, string) {
		t.Helper()
		req, _ := http.NewRequest(method, srv.URL+p, strings.NewReader(form.Encode()))
		if form != nil {
			req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		}
		if cookie != "" {
			req.Header.Set("Cookie", cookie)
		}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		return resp, string(body)
	}
	cookie := func(resp *http.Response, name string) *http.Cookie {
		t.Helper()
		for _, c := range resp.Cookies() {
			if c.Name == name {
				return c
			}
		}
		t.Fatalf("no %s cookie", name)
		return nil
	}

	for p, want := range map[string]int{"/": 404, "/vnc.html": 404, "/tabtopx": 404, "/tabtopx/vnc.html": 404,
		"/downloads/": 404, "/tabtop/vnc.html": 200, "/tabtop/downloads/": 401} {
		if resp, _ := do("GET", p, "", nil); resp.StatusCode != want {
			t.Errorf("GET %s: status %d, want %d", p, resp.StatusCode, want)
		}
	}
	for p, want := range map[string]string{"/tabtop": "/tabtop/", "/tabtop/downloads": "/tabtop/downloads/",
		"/tabtop/tty": "/tabtop/tty/"} {
		if resp, _ := do("GET", p, "", nil); resp.StatusCode != 301 || resp.Header.Get("Location") != want {
			t.Errorf("GET %s: %d to %q, want 301 to %s", p, resp.StatusCode, resp.Header.Get("Location"), want)
		}
	}
	resp, _ := do("GET", "/tabtop/vnc.html", "", nil)
	if c := cookie(resp, audioCookie); c.Path != "/tabtop/" || c.Secure {
		t.Errorf("audio cookie path %q secure %v, want /tabtop/ over plain HTTP", c.Path, c.Secure)
	}
	if _, body := do("GET", "/tabtop/downloads/", "", nil); !strings.Contains(body, `action="/tabtop/downloads/"`) {
		t.Errorf("login form doesn't post to /tabtop/downloads/:\n%s", body)
	}

	code := hotp(key, time.Now().Unix()/30, 6)
	resp, _ = do("POST", "/tabtop/downloads/", "", url.Values{"password": {code}})
	if resp.StatusCode != 303 || resp.Header.Get("Location") != "/tabtop/downloads/" {
		t.Fatalf("login: %d to %q, want 303 to /tabtop/downloads/", resp.StatusCode, resp.Header.Get("Location"))
	}
	session := cookie(resp, cookieName)
	if session.Path != "/tabtop/" || session.Secure {
		t.Errorf("session cookie path %q secure %v, want /tabtop/ over plain HTTP", session.Path, session.Secure)
	}
	sc := cookieName + "=" + session.Value

	resp, body := do("GET", "/tabtop/downloads/", sc, nil)
	if resp.StatusCode != 200 || !strings.Contains(body, `href="sub%20dir/"`) || !strings.Contains(body, `action="/tabtop/downloads/"`) {
		t.Errorf("listing: %d\n%s", resp.StatusCode, body)
	}
	resp, _ = do("GET", "/tabtop/downloads/sub%20dir", sc, nil)
	if resp.StatusCode != 301 || resp.Header.Get("Location") != "/tabtop/downloads/sub%20dir/" {
		t.Errorf("directory redirect: %d to %q", resp.StatusCode, resp.Header.Get("Location"))
	}
	resp, _ = do("POST", "/tabtop/downloads/sub%20dir/", sc, url.Values{"logout": {"1"}})
	if c := cookie(resp, cookieName); c.Path != "/tabtop/" || c.MaxAge >= 0 ||
		resp.Header.Get("Location") != "/tabtop/downloads/sub%20dir/" {
		t.Errorf("logout: cookie path %q max-age %d, to %q", c.Path, c.MaxAge, resp.Header.Get("Location"))
	}
}

func TestSecure(t *testing.T) {
	trusted, _ := parsePrefixes("10.0.0.1")
	g := &server{trustedProxies: trusted}
	for _, tc := range []struct {
		name, peer, proto string
		tls, want         bool
	}{
		{"plain HTTP", "198.51.100.7:5000", "", false, false},
		{"TLS to tabtopd", "198.51.100.7:5000", "", true, true},
		{"trusted proxy, https", "10.0.0.1:5000", "https", false, true},
		{"trusted proxy, chain", "10.0.0.1:5000", "HTTPS, http", false, true},
		{"trusted proxy, http", "10.0.0.1:5000", "http", false, false},
		{"trusted proxy, no header", "10.0.0.1:5000", "", false, false},
		{"untrusted peer's header ignored", "198.51.100.7:5000", "https", false, false},
	} {
		r, _ := http.NewRequest("GET", "/", nil)
		r.RemoteAddr = tc.peer
		if tc.proto != "" {
			r.Header.Set("X-Forwarded-Proto", tc.proto)
		}
		if tc.tls {
			r.TLS = &tls.ConnectionState{}
		}
		if got := g.secure(r); got != tc.want {
			t.Errorf("%s: got %v, want %v", tc.name, got, tc.want)
		}
	}
}

// TestSecureCookies logs in and loads noVNC through a trusted proxy that
// reports HTTPS; every cookie set must be Secure.
func TestSecureCookies(t *testing.T) {
	g := newUsersFile(t, "-")
	novnc := t.TempDir()
	os.WriteFile(filepath.Join(novnc, "vnc.html"), []byte("noVNC"), 0o644)
	g.base, g.novncDir, g.downloadsDir = "/", novnc, t.TempDir()
	g.trustedProxies, _ = parsePrefixes("127.0.0.1, ::1")
	g.audio = newAudioHub("test", 64)
	g.sessions, g.failures, g.pending = map[string]time.Time{}, map[string][]time.Time{}, map[string]int{}
	srv := httptest.NewServer(g.handler())
	t.Cleanup(srv.Close)
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

	for _, req := range []*http.Request{
		httptest.NewRequest("GET", srv.URL+"/vnc.html", nil),
		httptest.NewRequest("POST", srv.URL+"/downloads/", strings.NewReader("password="+code(0))),
		httptest.NewRequest("POST", srv.URL+"/downloads/", strings.NewReader("logout=1")),
	} {
		req.RequestURI = ""
		req.Header.Set("X-Forwarded-Proto", "https")
		if req.Method == "POST" {
			req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if len(resp.Cookies()) == 0 {
			t.Errorf("%s %s: no cookie set", req.Method, req.URL.Path)
		}
		for _, c := range resp.Cookies() {
			if !c.Secure {
				t.Errorf("%s %s: cookie %s isn't Secure", req.Method, req.URL.Path, c.Name)
			}
		}
	}
}
