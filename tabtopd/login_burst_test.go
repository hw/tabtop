package main

import (
	"crypto/rand"
	"fmt"
	"net/http"
	"net/netip"
	"testing"

	"github.com/coder/websocket"
)

// Logins begun at once, before the site-wide slowing down starts, are
// slowed as soon as it does: their guesses aren't all checked.
func TestTunnelLoginBurstSlowed(t *testing.T) {
	g, srv := newE2EServerWith(t, func(c *serverConfig) {
		c.trustedProxies = []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}
	})
	ctx := testCtx(t)
	const n = 60 // one tunnel per client address, as a proxy reports it
	sid := make([]byte, cpaceSID)
	rand.Read(sid)
	_, ya, _ := cpaceShare(cpaceGenerator("guess", sid))
	var conns []*websocket.Conn
	for i := range n {
		h := http.Header{}
		h.Set("X-Forwarded-For", fmt.Sprintf("198.51.100.%d", i+1))
		c, _, err := websocket.Dial(ctx, wsURL(srv.URL), &websocket.DialOptions{HTTPHeader: h})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { c.CloseNow() })
		c.Write(ctx, websocket.MessageBinary, loginHello(sid, ya))
		if _, _, err := c.Read(ctx); err != nil {
			t.Fatalf("tunnel %d: no shares: %v", i, err)
		}
		conns = append(conns, c)
	}
	checked := 0
	for _, c := range conns {
		c.Write(ctx, websocket.MessageBinary, make([]byte, 96)) // wrong tags: a wrong guess
		if _, _, err := c.Read(ctx); websocket.CloseStatus(err) == closeLoginFailed {
			checked++
		}
	}
	g.authMu.Lock()
	throttling := g.throttling
	g.authMu.Unlock()
	t.Logf("guesses checked: %d; throttling now: %v", checked, throttling)
	if checked > maxSiteFailures+1 {
		t.Fatalf("%d guesses checked in one burst, though logins are throttled to one per %v after %d failures",
			checked, siteThrottle, maxSiteFailures)
	}
}
