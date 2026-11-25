package main

import (
	"crypto/rand"
	"errors"
	"net/http"
	"net/netip"
	"strings"
	"testing"

	"github.com/coder/websocket"
)

func TestHostUnrebindable(t *testing.T) {
	for host, want := range map[string]bool{
		"127.0.0.1:6080":           true,
		"192.168.1.20":             true,
		"[::1]:6080":               true,
		"[fe80::1%25eth0]:6080":    true,
		"LOCALHOST:6080":           true,
		"foo.localhost.":           true,
		"nas":                      true,
		"nas.":                     true,
		"notlocal":                 true,
		"printer.local":            true,
		"box.home.arpa":            true,
		"svc.internal":             true,
		"router.lan:6080":          true,
		"":                         false,
		"attacker.example:6080":    false,
		"127.0.0.1.nip.io":         false,
		"x.local.attacker.example": false,
		"evil.localhost.example":   false,
		"notlocal.example":         false,
		"tabtop.example.com.":      false,
		"locallan":                 true, // (a single label)
		"x.notlan":                 false,
	} {
		if got := hostUnrebindable(hostName(host)); got != want {
			t.Errorf("%q: %v, want %v", host, got, want)
		}
	}
}

func TestParseHosts(t *testing.T) {
	got, err := parseHosts("nas.example.com, Media.Example.org. ,x.ts.net")
	if err != nil || strings.Join(got, " ") != "nas.example.com media.example.org x.ts.net" {
		t.Fatalf("%q %v", got, err)
	}
	for _, bad := range []string{"http://nas.example", "nas.example:6080", "nas.example/path", "[::1]", "user@nas.example"} {
		if _, err := parseHosts(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
	if got, err := parseHosts(""); err != nil || got != nil {
		t.Errorf("empty: %q %v", got, err)
	}
}

func TestHostRefusedReasonFits(t *testing.T) {
	for _, name := range []string{"attacker.example", strings.Repeat("a.", 200) + "example", "<b>\"x\"</b>.example"} {
		r := hostRefusedReason(hostName(name))
		if len(r) > 123 {
			t.Errorf("%d bytes: %q", len(r), r)
		}
		if strings.ContainsAny(r, "<>\"") {
			t.Errorf("unclean: %q", r)
		}
	}
}

// tunnelLoginReply opens the tunnel by host (with origin and more headers)
// and sends a login's hello: nil if the server answered it, else why not.
func tunnelLoginReply(t *testing.T, url, host, origin string, more http.Header) error {
	t.Helper()
	h := http.Header{}
	for k, v := range more {
		h[k] = v
	}
	if origin != "" {
		h.Set("Origin", origin)
	}
	c, _, err := websocket.Dial(testCtx(t), url, &websocket.DialOptions{HTTPHeader: h, Host: host})
	if err != nil {
		return err
	}
	defer c.CloseNow()
	sid := make([]byte, cpaceSID)
	rand.Read(sid)
	_, ya, _ := cpaceShare(cpaceGenerator(code(0), sid))
	c.Write(testCtx(t), websocket.MessageBinary, loginHello(sid, ya))
	_, _, err = c.Read(testCtx(t))
	return err
}

// TestTunnelRefusesRebinding: a page of a name that resolves here (DNS
// rebinding) can't open the tunnel over plain HTTP; it's told why, and
// nothing's counted against its visitor's address.
func TestTunnelRefusesRebinding(t *testing.T) {
	g, srv := newE2EServer(t)
	err := tunnelLoginReply(t, wsURL(srv.URL), "attacker.example:6080", "http://attacker.example:6080", nil)
	var ce websocket.CloseError
	if !errors.As(err, &ce) || ce.Code != websocket.StatusPolicyViolation || !strings.Contains(ce.Reason, "WEB_HOSTS") {
		t.Fatalf("rebound name: %v, want a policy close naming WEB_HOSTS", err)
	}
	if n := failureCount(g); n != 0 {
		t.Errorf("%d failures counted", n)
	}
	g.mu.Lock()
	sessions := len(g.sessions)
	g.mu.Unlock()
	if sessions != 0 {
		t.Errorf("%d sessions", sessions)
	}
	// The offline client's "null" origin skips Accept's own check: not this one.
	g.offlineClient = true
	if err := tunnelLoginReply(t, wsURL(srv.URL), "attacker.example", "null", nil); !errors.As(err, &ce) || ce.Code != websocket.StatusPolicyViolation {
		t.Errorf("null origin by a rebound name: %v", err)
	}
}

// TestTunnelHostsAllowed: the names a browser's tunnel is opened by still.
func TestTunnelHostsAllowed(t *testing.T) {
	g, srv := newE2EServer(t)
	g.hosts = []string{"nas.example.com"}
	g.offlineClient = true
	proxied := http.Header{"X-Forwarded-Proto": {"https"}}
	for _, c := range []struct {
		name, host, origin string
		more               http.Header
		proxy              bool
	}{
		{name: "an address", host: "127.0.0.1:6080", origin: "http://127.0.0.1:6080"},
		{name: "localhost", host: "localhost:6080", origin: "http://localhost:6080"},
		{name: "a single label", host: "nas:6080", origin: "http://nas:6080"},
		{name: "mDNS", host: "nas.local:6080", origin: "http://nas.local:6080"},
		{name: "WEB_HOSTS", host: "NAS.example.com:6080", origin: "http://nas.example.com:6080"},
		{name: "an https: page", host: "tabtop.example.com", origin: "https://tabtop.example.com"},
		{name: "a trusted proxy's HTTPS", host: "tabtop.example.com", origin: "http://tabtop.example.com", more: proxied, proxy: true},
		{name: "the offline client by an address", host: "192.168.1.20:6080", origin: "null"},
		{name: "the offline client through a trusted proxy's HTTPS", host: "tabtop.example.com", origin: "null", more: proxied, proxy: true},
		{name: "no Origin (not a browser)", host: "tabtop.example.com"},
	} {
		g.trustedProxies = nil
		if c.proxy {
			g.trustedProxies = []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}
		}
		if err := tunnelLoginReply(t, wsURL(srv.URL), c.host, c.origin, c.more); err != nil {
			t.Errorf("%s: %v", c.name, err)
		}
	}
	// An untrusted peer's X-Forwarded-Proto is no HTTPS.
	g.trustedProxies = nil
	if err := tunnelLoginReply(t, wsURL(srv.URL), "tabtop.example.com", "http://tabtop.example.com", proxied); err == nil {
		t.Error("an untrusted X-Forwarded-Proto let a rebound name in")
	}
}
