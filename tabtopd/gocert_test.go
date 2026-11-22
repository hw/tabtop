package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// certServer is an HTTPS server whose certificate isn't trusted (httptest's
// own, for example.com), and a dial reaching it whatever the name.
func certServer(t *testing.T) (*httptest.Server, func(ctx context.Context, network, addr string) (net.Conn, error)) {
	t.Helper()
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("hello")) }))
	t.Cleanup(srv.Close)
	addr := srv.Listener.Addr().String()
	return srv, func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, addr)
	}
}

func TestGoCertError(t *testing.T) {
	for text, want := range map[string]bool{"net::ERR_CERT_AUTHORITY_INVALID": true, "net::ERR_CERT_DATE_INVALID": true, "net::ERR_CERT_COMMON_NAME_INVALID": true,
		"net::ERR_FAILED": false, "net::ERR_NAME_NOT_RESOLVED": false, "net::ERR_SSL_PROTOCOL_ERROR": false} {
		if goCertError(text) != want {
			t.Errorf("%s: %v", text, !want)
		}
	}
	if !strings.Contains(goCertReason("net::ERR_CERT_DATE_INVALID"), "expired") || !strings.Contains(goCertReason("net::ERR_CERT_COMMON_NAME_INVALID"), "another site") {
		t.Error("reasons")
	}
}

// TestGoCertProbe: the warning's details, read on a connection of its own.
func TestGoCertProbe(t *testing.T) {
	_, dial := certServer(t)
	d := goCertProbe(context.Background(), dial, "example.com")
	if d == nil || !strings.Contains(strings.Join(d.Names, " "), "example.com") || d.Problem != "not from a trusted authority" || d.NotAfter == "" {
		t.Fatalf("details: %+v", d)
	}
	if p := goCertProbe(context.Background(), dial, "other.test").Problem; p != "for another name" {
		t.Errorf("another name's problem: %q", p)
	}
}

// TestGoCertClient: a tab's own fetches skip the check for an exception's
// host only; every other is checked in full, on the tab's own connections.
func TestGoCertClient(t *testing.T) {
	_, dial := certServer(t)
	base := &http.Client{Transport: &http.Transport{DialContext: dial}}
	get := func(c *http.Client, host string) error {
		r, err := c.Get("https://" + host + "/")
		if err == nil {
			r.Body.Close()
		}
		return err
	}
	c := &goCertExceptions{}
	if c.client(base) != base {
		t.Fatal("a client of its own, no exceptions")
	}
	if get(base, "example.com") == nil {
		t.Fatal("an untrusted certificate taken")
	}
	c.add("Example.com.", false)
	tab := c.client(base)
	if tab == base || c.client(base) != tab || c.client(tab) != tab {
		t.Fatal("the tab's client: made once, not made again of itself")
	}
	if err := get(tab, "example.com"); err != nil {
		t.Fatalf("the exception's host refused: %v", err)
	}
	if err := get(tab, "other.test"); err == nil {
		t.Error("another host's untrusted certificate taken")
	}
	if get(base, "example.com") == nil {
		t.Error("the shared client took the exception")
	}
	// A host that's an address (no name sent in TLS): an exception all the same.
	c.add("127.0.0.1", false)
	if err := get(c.client(base), "127.0.0.1"); err != nil {
		t.Errorf("an address's exception refused: %v", err)
	}
}

// TestGoCertRefuses: while the engine ignores certificate errors, the
// proxy refuses any host but an exception's, and says which it refused.
func TestGoCertRefuses(t *testing.T) {
	c := &goCertExceptions{}
	c.add("lan.test", false)
	if c.refuses("other.test") {
		t.Fatal("refused while the engine checks")
	}
	c.ignoring.Store(true)
	if c.refuses("Lan.test.") {
		t.Error("the exception refused")
	}
	if !c.refuses("other.test") {
		t.Fatal("another host let through while ignoring")
	}
	if !c.tookRefused("Other.test") || c.tookRefused("other.test") || c.tookRefused("lan.test") {
		t.Error("what was refused, told once")
	}
	var none *goCertExceptions
	if none.refuses("x") || none.tookRefused("x") || none.allows("x") || none.client(http.DefaultClient) != http.DefaultClient {
		t.Error("no exceptions")
	}
}

// TestGoCertClientHandshakeTimeout: a tab's own fetch, with exceptions, to
// a server that never finishes its TLS handshake fails, as without them.
func TestGoCertClientHandshakeTimeout(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			defer c.Close() // (held open, saying nothing)
		}
	}()
	addr := l.Addr().String()
	base := &http.Client{Transport: &http.Transport{TLSHandshakeTimeout: 200 * time.Millisecond,
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, addr)
		}}}
	c := &goCertExceptions{}
	c.add("lan.test", false)
	done := make(chan error, 1)
	go func() {
		r, err := c.client(base).Get("https://other.test/")
		if err == nil {
			r.Body.Close()
		}
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil {
			t.Error("no error")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the handshake not bounded")
	}
}

// TestGoCertIgnoreFails: a call to the engine that fails (perhaps heeded
// all the same) leaves the proxy refusing others: from before ignoring is
// asked for, till not ignoring certainly is.
func TestGoCertIgnoreFails(t *testing.T) {
	b := &goBrowser{ctx: context.Background(), cdp: &cdpConn{err: errCDPClosed}, certs: &goCertExceptions{}}
	b.certs.add("lan.test", false)
	b.certIgnore(context.Background(), "https://lan.test/")
	if !b.certs.ignoring.Load() || !b.certs.refuses("other.test") {
		t.Fatal("ignoring asked for, failed: others let through")
	}
	b.certIgnore(context.Background(), "https://other.test/")
	if !b.certs.ignoring.Load() {
		t.Error("not ignoring asked for, failed: taken as done")
	}
}

// fakeCDP is an engine's CDP endpoint that answers every call, failing
// those fail says to, and tells calls each method it was sent.
func fakeCDP(t *testing.T, fail func(method string, n int) bool) (*cdpConn, chan string) {
	t.Helper()
	return fakeCDPCode(t, -32000, fail)
}

// fakeCDPCode is fakeCDP, its failures with code.
func fakeCDPCode(t *testing.T, code int, fail func(method string, n int) bool) (*cdpConn, chan string) {
	t.Helper()
	calls := make(chan string, 64)
	counts := map[string]int{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		for {
			_, b, err := c.Read(r.Context())
			if err != nil {
				return
			}
			var m struct {
				ID     int64  `json:"id"`
				Method string `json:"method"`
			}
			json.Unmarshal(b, &m)
			counts[m.Method]++
			calls <- m.Method
			reply := fmt.Sprintf(`{"id":%d,"result":{}}`, m.ID)
			if fail(m.Method, counts[m.Method]) {
				reply = fmt.Sprintf(`{"id":%d,"error":{"code":%d,"message":"failed"}}`, m.ID, code)
			}
			c.Write(r.Context(), websocket.MessageText, []byte(reply))
		}
	}))
	t.Cleanup(srv.Close)
	ws, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	c := &cdpConn{ws: ws, pending: map[int64]chan cdpMessage{}, Events: make(chan cdpEvent, 8), done: make(chan struct{})}
	go c.read()
	t.Cleanup(func() { ws.CloseNow() })
	return c, calls
}

// TestGoCertIgnoreRetried: ignoring asked for, and failed, is asked for
// again the next time (the warning's Continue isn't stuck); not ignoring,
// after, is asked for too (the engine may have heeded the failed call).
func TestGoCertIgnoreRetried(t *testing.T) {
	cdp, calls := fakeCDP(t, func(method string, n int) bool { return n == 1 })
	b := &goBrowser{ctx: context.Background(), cdp: cdp, certs: &goCertExceptions{}}
	b.certs.add("lan.test", false)
	b.certIgnore(context.Background(), "https://lan.test/") // fails
	b.certIgnore(context.Background(), "https://lan.test/") // asked again
	b.certIgnore(context.Background(), "https://other.test/")
	b.certIgnore(context.Background(), "https://other.test/") // (known: not asked)
	if n := len(calls); n != 3 {
		t.Fatalf("%d calls to the engine, want 3", n)
	}
	if b.certs.ignoring.Load() {
		t.Error("ignoring, told not to")
	}
}

// TestGoCertIgnoreRace: certIgnore (a job's) and the page's events (the
// tab's loop) don't share what they change (go test -race).
func TestGoCertIgnoreRace(t *testing.T) {
	cdp, _ := fakeCDP(t, func(string, int) bool { return false })
	b := &goBrowser{ctx: context.Background(), cdp: cdp, certs: &goCertExceptions{}}
	b.certs.add("lan.test", false)
	b.docRequest = [2]string{"1", "https://other.test/"}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := range 20 {
			b.certIgnore(context.Background(), []string{"https://lan.test/", "https://other.test/"}[i%2])
		}
	}()
	ev := cdpEvent{Params: json.RawMessage(`{"requestId":"1","type":"Document","errorText":"net::ERR_TUNNEL_CONNECTION_FAILED"}`)}
	for range 20 {
		b.certs.ignoring.Store(true)
		b.certs.refuses("other.test")
		b.docFailedCert(ev)
	}
	<-done
}

// TestGoCertClientCopy: a copy of the tab's own client (fetchRemoteResource
// copies it, for its redirects) is taken as it is, not wrapped again (a
// transport, kept for the tab's life, each time).
func TestGoCertClientCopy(t *testing.T) {
	c := &goCertExceptions{}
	c.add("lan.test", false)
	tab := c.client(&http.Client{Transport: &http.Transport{}})
	for range 3 {
		copied := *tab
		if got := c.client(&copied); got != &copied {
			t.Fatal("a copy of the tab's client wrapped again")
		}
	}
	if len(c.clients) != 1 {
		t.Errorf("%d clients kept, want 1", len(c.clients))
	}
}

// TestGoCertIgnoreUnsupported: an engine that can't ignore certificate
// errors (no such method): not taken as ignoring them (the proxy refusing
// every other host for good), and Continue's refused.
func TestGoCertIgnoreUnsupported(t *testing.T) {
	cdp, _ := fakeCDPCode(t, -32601, func(method string, n int) bool { return method == "Security.setIgnoreCertificateErrors" })
	b := &goBrowser{ctx: context.Background(), cdp: cdp, certs: &goCertExceptions{}}
	b.certs.add("lan.test", false)
	b.certIgnore(context.Background(), "https://lan.test/")
	if b.certs.ignoring.Load() || b.certs.refuses("other.test") {
		t.Fatal("an engine that can't: taken as ignoring, every other host refused")
	}
	if !b.certUnsupported.Load() {
		t.Error("not noted that the engine can't")
	}
}

// TestGoCertExceptionRevoked: continued to past a revoked certificate's
// warning alone, a host's allowed, the engine not told to ignore errors for
// it; past the engine's error too, it is.
func TestGoCertExceptionRevoked(t *testing.T) {
	var c goCertExceptions
	if !c.add("revoked.test", true) || !c.allows("revoked.test") || c.ignores("revoked.test") {
		t.Fatalf("revoked alone: allows %v, ignores %v", c.allows("revoked.test"), c.ignores("revoked.test"))
	}
	if !c.add("revoked.test", false) || !c.ignores("revoked.test") {
		t.Fatal("the engine's error too, not ignored")
	}
	if !c.add("revoked.test", true) || !c.ignores("revoked.test") {
		t.Fatal("a revocation's after the engine's error took its ignoring away")
	}
	if !c.add("lan.test", false) || !c.ignores("lan.test") {
		t.Fatal("an engine error's exception not ignored")
	}
}

// TestGoCertRevokedExceptionStillChecks: continued to past a revoked
// certificate's warning alone, a host's certificate is still checked in
// full by TabTop's own fetches (a self-signed one refused), its revocation
// alone not looked up; and while the engine ignores errors for another
// host's exception, the proxy refuses the revoked one's tunnels as any
// other's (the engine would take any certificate there).
func TestGoCertRevokedExceptionStillChecks(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) }))
	defer srv.Close()
	addr := srv.Listener.Addr().String()
	base := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, addr)
	}}}
	c := &goCertExceptions{}
	c.add("revoked.test", true)
	if r, err := c.client(base).Get("https://revoked.test/"); err == nil {
		r.Body.Close()
		t.Error("a self-signed certificate taken for a host excepted for its revocation alone")
	}
	c.add("lan.test", false)
	if r, err := c.client(base).Get("https://lan.test/"); err != nil {
		t.Errorf("an engine error's exception: %v", err)
	} else {
		r.Body.Close()
	}
	c.ignoring.Store(true)
	if !c.refuses("revoked.test") {
		t.Error("while the engine ignores errors, a tunnel to a host excepted for its revocation alone let through")
	}
	if c.refuses("lan.test") {
		t.Error("the engine error's exception refused")
	}
}

// TestGoCertIgnoreUnsupportedDrops: on an engine without
// Security.setIgnoreCertificateErrors, the exception just made for its
// error is taken away (it'd only have TabTop's own fetches skip the host's
// checks); a revocation's alone isn't one the engine's asked about.
func TestGoCertIgnoreUnsupportedDrops(t *testing.T) {
	cdp, _ := fakeCDPCode(t, -32601, func(string, int) bool { return true })
	b := &goBrowser{ctx: context.Background(), cdp: cdp, certs: &goCertExceptions{}}
	b.certs.add("lan.test", false)
	b.certs.add("revoked.test", true)
	b.certIgnore(context.Background(), "https://lan.test/")
	if !b.certUnsupported.Load() {
		t.Fatal("the engine's lack not learned")
	}
	if b.certs.allows("lan.test") {
		t.Error("the engine error's exception kept on an engine that can't ignore errors")
	}
	if !b.certs.allows("revoked.test") {
		t.Error("a revocation's exception taken away")
	}
}

// TestGoCertRevokedNotes: a note of a host refused for its revocation is
// a load's for a while, then let go; with many (pictures' hosts), the
// oldest go first, so a page's own is always noted.
func TestGoCertRevokedNotes(t *testing.T) {
	c := &goCertExceptions{}
	for i := range 80 {
		c.refusedRevoked(fmt.Sprintf("img%d.test", i))
	}
	c.refusedRevoked("page.test")
	if !c.tookRevoked("page.test") {
		t.Error("a page's note lost among others")
	}
	if c.tookRevoked("img0.test") {
		t.Error("the oldest note not let go")
	}
	c.refusedRevoked("old.test")
	c.mu.Lock()
	c.revokedRefused["old.test"] = time.Now().Add(-time.Minute)
	c.mu.Unlock()
	if c.tookRevoked("old.test") {
		t.Error("a note a minute old taken")
	}
}
