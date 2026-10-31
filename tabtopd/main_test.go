package main

import (
	"crypto/tls"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
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

// TestOathAuthenticate checks liboath's rules for the codes logins accept.
func TestOathAuthenticate(t *testing.T) {
	ok := func(g *server, pin, otp string) bool { return oathAuthenticate(g.usersFile, "alice", pin, otp) == nil }
	g := newUsersFile(t, "-")
	now := code(0)
	if !ok(g, "", now) {
		t.Fatal("TOTP-only: valid code rejected")
	}
	if ok(g, "", now) {
		t.Fatal("TOTP-only: reused code accepted")
	}
	if ok(g, "s3cret", code(1)) {
		t.Fatal("TOTP-only: accepted a password in front of the code")
	}

	// Once a later code is used, earlier ones in the window are refused.
	g = newUsersFile(t, "-")
	if !ok(g, "", code(1)) {
		t.Fatal("next code rejected")
	}
	if ok(g, "", code(0)) {
		t.Fatal("accepted a code older than the last one used")
	}
	if ok(g, "", code(5)) {
		t.Fatal("accepted a code outside the window")
	}

	g = newUsersFile(t, "s3cret")
	for _, c := range []struct{ pin, otp string }{
		{"wrong", code(0)},   // wrong password
		{"", code(0)},        // code without password
		{"s3cret", ""},       // no code
		{"s3cret", "000000"}, // wrong code
	} {
		if ok(g, c.pin, c.otp) {
			t.Errorf("password+TOTP: accepted %q + %q", c.pin, c.otp)
		}
	}
	if !ok(g, "s3cret", code(0)) {
		t.Fatal("password+TOTP: valid credentials rejected")
	}
}

// TestLoginLimitParallel starts many logins at once from one IP, all of
// which fail: only maxFailures of them may be checked, however they
// interleave.
func TestLoginLimitParallel(t *testing.T) {
	g := &server{failures: map[string][]time.Time{}, pending: map[string]int{}}
	started := make(chan bool, 50)
	var wg sync.WaitGroup
	for range cap(started) {
		wg.Go(func() {
			ok := g.beginLogin("192.0.2.1")
			if ok {
				time.Sleep(time.Millisecond)
				g.endLogin("192.0.2.1", true)
			}
			started <- ok
		})
	}
	wg.Wait()
	close(started)
	n := 0
	for ok := range started {
		if ok {
			n++
		}
	}
	if n != maxFailures {
		t.Fatalf("%d logins checked, want %d", n, maxFailures)
	}
	if g.beginLogin("192.0.2.1") {
		t.Fatal("a login once locked out")
	}
	if !g.beginLogin("192.0.2.2") {
		t.Fatal("another IP locked out")
	}
}

// fillLoginWork takes every slot for checking logins until the test ends.
func fillLoginWork(t *testing.T) {
	for range maxLoginWork {
		loginWork <- struct{}{}
	}
	t.Cleanup(func() {
		for range maxLoginWork {
			<-loginWork
		}
	})
}

// TestFailuresSwept checks that IPs whose failures have expired are
// forgotten without being looked up again.
func TestFailuresSwept(t *testing.T) {
	g := &server{failures: map[string][]time.Time{}, pending: map[string]int{}}
	old := time.Now().Add(-failureWindow)
	for i := range 100 {
		g.failures[fmt.Sprint("2001:db8::", i)] = []time.Time{old}
	}
	g.failures["192.0.2.1"] = []time.Time{time.Now()}
	g.beginLogin("192.0.2.2")
	g.endLogin("192.0.2.2", true)
	if len(g.failures) != 2 {
		t.Fatalf("%d IPs tracked after a sweep, want 2", len(g.failures))
	}
	g.failures["2001:db8::1"] = []time.Time{old}
	g.beginLogin("192.0.2.2")
	g.endLogin("192.0.2.2", true)
	if len(g.failures) != 3 {
		t.Fatalf("swept again within the window: %d IPs tracked", len(g.failures))
	}
}

func TestListDirTruncated(t *testing.T) {
	dir := t.TempDir()
	list := func() ([]entry, bool) {
		t.Helper()
		root, err := os.OpenRoot(dir)
		if err != nil {
			t.Fatal(err)
		}
		defer root.Close()
		f, err := root.Open(".")
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		entries, truncated, err := listDir(root, ".", f)
		if err != nil {
			t.Fatal(err)
		}
		return entries, truncated
	}
	if entries, truncated := list(); len(entries) != 0 || truncated {
		t.Fatalf("empty folder: %d entries, truncated %v", len(entries), truncated)
	}
	for i := range maxListing {
		os.WriteFile(filepath.Join(dir, fmt.Sprint(i)), nil, 0o644)
	}
	if entries, truncated := list(); len(entries) != maxListing || truncated {
		t.Fatalf("%d files: %d entries, truncated %v", maxListing, len(entries), truncated)
	}
	os.WriteFile(filepath.Join(dir, "one more"), nil, 0o644)
	if entries, truncated := list(); len(entries) != maxListing || !truncated {
		t.Fatalf("%d files: %d entries, truncated %v", maxListing+1, len(entries), truncated)
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

// TestClientIPTrustNProxies trusts hops by position: the connection's peer
// is the first, then X-Forwarded-For entries from the right.
func TestClientIPTrustNProxies(t *testing.T) {
	trusted, _ := parsePrefixes("10.0.0.1")
	for _, tc := range []struct {
		name string
		n    int
		peer string
		xff  []string
		want string
	}{
		{"0: by address only", 0, "198.51.100.7:5000", []string{"203.0.113.9"}, "198.51.100.7"},
		{"1: the connecting proxy", 1, "198.51.100.7:5000", []string{"1.2.3.4, 203.0.113.9"}, "203.0.113.9"},
		{"1: no header", 1, "198.51.100.7:5000", nil, "198.51.100.7"},
		{"2: a CDN in front of the load balancer", 2, "198.51.100.7:5000", []string{"1.2.3.4, 203.0.113.9, 192.0.2.50"}, "203.0.113.9"},
		{"2: forged entries further left ignored", 2, "198.51.100.7:5000", []string{"6.6.6.6, 203.0.113.9, 192.0.2.50"}, "203.0.113.9"},
		{"1, plus a listed proxy beyond the count", 1, "198.51.100.7:5000", []string{"203.0.113.9, 10.0.0.1"}, "203.0.113.9"},
		{"listed peer still trusted with a count", 1, "10.0.0.1:5000", []string{"203.0.113.9"}, "203.0.113.9"},
		{"count larger than the chain: leftmost entry", 3, "198.51.100.7:5000", []string{"203.0.113.9"}, "203.0.113.9"},
		{"IPv4-mapped peer counts too", 1, "[::ffff:198.51.100.7]:5000", []string{"203.0.113.9"}, "203.0.113.9"},
	} {
		g := &server{trustedProxies: trusted, trustNProxies: tc.n}
		r, _ := http.NewRequest("GET", "/", nil)
		r.RemoteAddr = tc.peer
		for _, v := range tc.xff {
			r.Header.Add("X-Forwarded-For", v)
		}
		if got := g.clientIP(r); got != tc.want {
			t.Errorf("%s: got %s, want %s", tc.name, got, tc.want)
		}
	}

	// The trace says why each hop is trusted.
	g := &server{trustedProxies: trusted, trustNProxies: 1}
	r, _ := http.NewRequest("GET", "/", nil)
	r.RemoteAddr = "198.51.100.7:5000"
	r.Header.Set("X-Forwarded-For", "203.0.113.9, 10.0.0.1")
	_, trace := g.traceClientIP(r)
	var by []string
	for _, h := range trace {
		by = append(by, h.Addr+"="+h.By)
	}
	if got := strings.Join(by, " "); got != "198.51.100.7=WEB_TRUST_NPROXIES 10.0.0.1=WEB_TRUSTED_PROXIES 203.0.113.9=" {
		t.Errorf("trace: %s", got)
	}

	// X-Forwarded-Proto from a proxy trusted by count is believed too.
	r.Header.Set("X-Forwarded-Proto", "https")
	if !g.secure(r) {
		t.Error("X-Forwarded-Proto from a counted proxy ignored")
	}
	if (&server{trustedProxies: trusted}).secure(r) {
		t.Error("X-Forwarded-Proto believed without a count")
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
	g, _ := newE2EServer(t)
	g.base = "/tabtop/"
	srv := httptest.NewServer(g.handler())
	t.Cleanup(srv.Close)
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	do := func(p string) *http.Response {
		t.Helper()
		resp, err := client.Get(srv.URL + p)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp
	}
	for p, want := range map[string]int{"/": 404, "/vnc.html": 404, "/tabtopx": 404, "/tabtopx/vnc.html": 404,
		"/downloads/": 404, "/tabtop/vnc.html": 200, "/tabtop/downloads/": 200, "/tabtop/tty/": 200} {
		if resp := do(p); resp.StatusCode != want {
			t.Errorf("GET %s: status %d, want %d", p, resp.StatusCode, want)
		}
	}
	for p, want := range map[string]string{"/tabtop": "/tabtop/", "/tabtop/downloads": "/tabtop/downloads/",
		"/tabtop/tty": "/tabtop/tty/", "/tabtop/downloads/sub%20dir/": "/tabtop/downloads/#/sub%20dir/"} {
		if resp := do(p); resp.StatusCode/100 != 3 || resp.Header.Get("Location") != want {
			t.Errorf("GET %s: %d to %q, want a redirect to %s", p, resp.StatusCode, resp.Header.Get("Location"), want)
		}
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
