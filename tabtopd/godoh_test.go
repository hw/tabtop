package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

// dohServer is a DoH server (RFC 8484, POST): A questions answered from
// names (a name absent: NXDOMAIN; "fail.test": SERVFAIL), AAAA ones with
// none; what it's asked counted.
func dohServer(t *testing.T, names map[string]netip.Addr, ttl uint32) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var asked atomic.Int32
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.Header.Get("Content-Type") != "application/dns-message" {
			http.Error(w, "no", http.StatusBadRequest)
			return
		}
		asked.Add(1)
		body, _ := io.ReadAll(r.Body)
		var q dnsmessage.Message
		if err := q.Unpack(body); err != nil || len(q.Questions) != 1 {
			http.Error(w, "no", http.StatusBadRequest)
			return
		}
		name := strings.TrimSuffix(q.Questions[0].Name.String(), ".")
		a := dnsmessage.Message{Header: dnsmessage.Header{ID: q.ID, Response: true, RecursionAvailable: true}, Questions: q.Questions}
		at, known := names[name]
		switch {
		case name == "fail.test":
			a.RCode = dnsmessage.RCodeServerFailure
		case !known:
			a.RCode = dnsmessage.RCodeNameError
		case q.Questions[0].Type == dnsmessage.TypeA:
			a.Answers = []dnsmessage.Resource{{Header: dnsmessage.ResourceHeader{Name: q.Questions[0].Name, Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET, TTL: ttl},
				Body: &dnsmessage.AResource{A: at.As4()}}}
		}
		out, _ := a.Pack()
		w.Header().Set("Content-Type", "application/dns-message")
		w.Write(out)
	}))
	t.Cleanup(srv.Close)
	return srv, &asked
}

// testDoH is DoH by srv (a custom server), trusting its certificate, its
// address (this machine's) allowed.
func testDoH(t *testing.T, srv *httptest.Server) *goDoH {
	t.Helper()
	was := goDoHAllow
	goDoHAllow = func(netip.Addr) bool { return true }
	t.Cleanup(func() { goDoHAllow = was })
	d := newGoDoH(srv.URL+"/dns-query", nil)
	d.client.Transport.(*http.Transport).TLSClientConfig = srv.Client().Transport.(*http.Transport).TLSClientConfig
	return d
}

// TestGoDoHLookup: names looked up by the DoH server, kept for their TTL
// (at least 30 s), a name not found kept too; SERVFAIL an error, not kept.
func TestGoDoHLookup(t *testing.T) {
	srv, asked := dohServer(t, map[string]netip.Addr{"example.com": netip.MustParseAddr("192.0.2.1"), "site.test": netip.MustParseAddr("192.0.2.7")}, 1)
	d := testDoH(t, srv)
	if err := d.check(context.Background()); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		addrs, err := d.lookup(context.Background(), "Site.test.")
		if err != nil || len(addrs) != 1 || addrs[0] != netip.MustParseAddr("192.0.2.7") {
			t.Fatalf("site.test: %v %v", addrs, err)
		}
	}
	if n := asked.Load(); n != 3 { // (the check's; then A and AAAA, once)
		t.Errorf("asked %d times, want 3", n)
	}
	for range 2 {
		if _, err := d.lookup(context.Background(), "missing.test"); !errors.Is(err, errGoDNS) {
			t.Fatalf("a name not found: %v", err)
		}
	}
	if n := asked.Load(); n != 5 {
		t.Errorf("a name not found asked again: %d", n)
	}
	for range 2 {
		if _, err := d.lookup(context.Background(), "fail.test"); !errors.Is(err, errGoDNS) || !strings.Contains(err.Error(), "couldn't say") {
			t.Fatalf("SERVFAIL: %v", err)
		}
	}
	if n := asked.Load(); n != 9 {
		t.Errorf("SERVFAIL kept: asked %d times, want 9", n)
	}
}

// TestGoDoHAnswerOf: a reply's addresses of the type asked, its least TTL;
// one that isn't a reply refused.
func TestGoDoHAnswerOf(t *testing.T) {
	name := dnsmessage.MustNewName("site.test.")
	m := dnsmessage.Message{Header: dnsmessage.Header{Response: true}, Answers: []dnsmessage.Resource{
		{Header: dnsmessage.ResourceHeader{Name: name, Type: dnsmessage.TypeCNAME, Class: dnsmessage.ClassINET, TTL: 10}, Body: &dnsmessage.CNAMEResource{CNAME: dnsmessage.MustNewName("cdn.test.")}},
		{Header: dnsmessage.ResourceHeader{Name: dnsmessage.MustNewName("cdn.test."), Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET, TTL: 300}, Body: &dnsmessage.AResource{A: [4]byte{192, 0, 2, 9}}},
		{Header: dnsmessage.ResourceHeader{Name: dnsmessage.MustNewName("cdn.test."), Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET, TTL: 120}, Body: &dnsmessage.AResource{A: [4]byte{192, 0, 2, 10}}},
	}}
	body, _ := m.Pack()
	addrs, ttl, err := goDoHAnswerOf(body, dnsmessage.TypeA)
	if err != nil || len(addrs) != 2 || ttl.Seconds() != 120 {
		t.Errorf("%v %v %v", addrs, ttl, err)
	}
	if addrs, _, _ := goDoHAnswerOf(body, dnsmessage.TypeAAAA); len(addrs) != 0 {
		t.Errorf("A answers taken for AAAA: %v", addrs)
	}
	m.Header.Response = false
	body, _ = m.Pack()
	if _, _, err := goDoHAnswerOf(body, dnsmessage.TypeA); err == nil {
		t.Error("a question taken as a reply")
	}
}

// TestGoDoHDial: while DoH's on, what the browser dials is looked up by it
// (a name the system's DNS doesn't know), its answers by the address
// policy; a name it doesn't find isn't asked of the system's DNS; off, as
// before.
func TestGoDoHDial(t *testing.T) {
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
			c.Close()
		}
	}()
	_, port, _ := net.SplitHostPort(l.Addr().String())
	srv, _ := dohServer(t, map[string]netip.Addr{"only-by-doh.test": netip.MustParseAddr("127.0.0.1")}, 60)
	doh := testDoH(t, srv)
	dial := newGoDialer(func(netip.Addr) bool { return true })
	goDoHNow.Store(doh)
	t.Cleanup(func() { goDoHNow.Store(nil) })
	c, err := dial.DialContext(context.Background(), "tcp", net.JoinHostPort("only-by-doh.test", port))
	if err != nil {
		t.Fatalf("dialled by DoH: %v", err)
	}
	c.Close()
	// localhost: the system knows it; DoH doesn't, and isn't fallen back from
	// (/etc/hosts, which would have it, empty here).
	noEtcHosts(t)
	if c, err := dial.DialContext(context.Background(), "tcp", net.JoinHostPort("localhost", port)); err == nil || !errors.Is(err, errGoDNS) {
		if c != nil {
			c.Close()
		}
		t.Errorf("a name DoH doesn't know, the system's DNS asked instead: %v", err)
	}
	// DoH's answer (this machine) refused by the policy, before it's dialled.
	if _, err := newGoDialer(fetchPolicy(false)).DialContext(context.Background(), "tcp", net.JoinHostPort("only-by-doh.test", port)); !errors.Is(err, errFetchAddress) {
		t.Errorf("DoH's answer dialled, the policy refusing it: %v", err)
	}
	goDoHNow.Store(nil)
	if c, err := dial.DialContext(context.Background(), "tcp", net.JoinHostPort("only-by-doh.test", port)); err == nil {
		c.Close()
		t.Error("off, the name found all the same")
	}
}

// TestGoDoHProxy: the engine's tunnels go where DoH says; a name it
// doesn't know refused (dns).
func TestGoDoHProxy(t *testing.T) {
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("by doh")) }))
	defer site.Close()
	srv, _ := dohServer(t, map[string]netip.Addr{"site.test": netip.MustParseAddr("127.0.0.1")}, 60)
	goDoHNow.Store(testDoH(t, srv))
	t.Cleanup(func() { goDoHNow.Store(nil) })
	p := newGoProxy(allowAll, "", "")
	port := portOf(t, site.URL)
	p.ports = map[string]bool{port: true}
	_, addr := startGoProxy(t, p, "", "")
	if code := connect(t, addr, "site.test:"+port, ""); code != http.StatusOK {
		t.Errorf("a tunnel to a name DoH knows: %d", code)
	}
	if code := connect(t, addr, "missing.test:"+port, ""); code != http.StatusBadGateway {
		t.Errorf("a tunnel to a name DoH doesn't know: %d", code)
	}
}

// TestGoDoHPrivateServer: a DoH server on a private network (or this
// machine) isn't used.
func TestGoDoHPrivateServer(t *testing.T) {
	srv, _ := dohServer(t, map[string]netip.Addr{"example.com": netip.MustParseAddr("192.0.2.1")}, 60)
	d := newGoDoH(srv.URL+"/dns-query", nil) // (goDoHAllow as it is)
	d.client.Transport.(*http.Transport).TLSClientConfig = srv.Client().Transport.(*http.Transport).TLSClientConfig
	if err := d.check(context.Background()); err == nil {
		t.Error("a DoH server on this machine used")
	}
}

// TestGoDoHSetting: off by default; a preset (its addresses pinned) or a
// custom server kept, read back; a custom address that isn't an https one
// refused.
func TestGoDoHSetting(t *testing.T) {
	file := filepath.Join(t.TempDir(), "sites.json")
	s := newGoSiteSettings(file)
	if e, _ := s.dohServer(); e != "" || s.report()["doh"] != "off" {
		t.Fatalf("not off by default: %q %v", e, s.report()["doh"])
	}
	s.setDoH("quad9", "")
	if e, pinned := newGoSiteSettings(file).dohServer(); e != goDoHPresets["quad9"].endpoint || len(pinned) == 0 {
		t.Errorf("Quad9 read back as %q %v", e, pinned)
	}
	s.setDoH("custom", "https://dns.example/dns-query")
	if got := newGoSiteSettings(file); got.report()["doh"] != "custom" || got.report()["dohURL"] != "https://dns.example/dns-query" {
		t.Errorf("custom read back as %v", got.report())
	}
	if u, err := goDoHEndpoint("https://dns.example"); err != nil || u != "https://dns.example/dns-query" {
		t.Errorf("no path: %q %v", u, err)
	}
	for _, bad := range []string{"http://dns.example/dns-query", "https://user:pw@dns.example/", "dns.example", "https:///x"} {
		if _, err := goDoHEndpoint(bad); err == nil {
			t.Errorf("%q taken", bad)
		}
	}
}

// TestGoDoHDialRace: an address that never answers (IPv6 routed but
// broken) doesn't hold up the others: IPv4 tried after a moment, as
// Go's own dialling does (Happy Eyeballs), not after its whole timeout.
func TestGoDoHDialRace(t *testing.T) {
	d := &goDialer{allow: func(netip.Addr) bool { return true }}
	d.dial = func(ctx context.Context, network, addr string) (net.Conn, error) {
		if strings.HasPrefix(addr, "[") { // IPv6: never answers
			<-ctx.Done()
			return nil, ctx.Err()
		}
		c1, c2 := net.Pipe()
		c2.Close()
		return c1, nil
	}
	doh := &goDoH{kept: map[string]goDoHAnswer{"site.test": {addrs: []netip.Addr{netip.MustParseAddr("2001:db8::1"), netip.MustParseAddr("2001:db8::2"), netip.MustParseAddr("192.0.2.1")}, until: time.Now().Add(time.Minute)}}}
	goDoHNow.Store(doh)
	t.Cleanup(func() { goDoHNow.Store(nil) })
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	start := time.Now()
	c, err := d.DialContext(ctx, "tcp", "site.test:443")
	if err != nil {
		t.Fatalf("not connected, IPv6 not answering: %v (after %v)", err, time.Since(start))
	}
	c.Close()
	if took := time.Since(start); took > time.Second {
		t.Errorf("IPv4 tried only after %v", took)
	}
}

// TestGoDoHHalfAnswer: one question answered, the other failing (a
// SERVFAIL, a time out, the dial given up): its addresses used, not kept as
// the name's (the other kind's missing for minutes).
func TestGoDoHHalfAnswer(t *testing.T) {
	var asked atomic.Int32
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked.Add(1)
		body, _ := io.ReadAll(r.Body)
		var q dnsmessage.Message
		q.Unpack(body)
		a := dnsmessage.Message{Header: dnsmessage.Header{ID: q.ID, Response: true}, Questions: q.Questions}
		if q.Questions[0].Type == dnsmessage.TypeAAAA {
			a.RCode = dnsmessage.RCodeServerFailure
		} else {
			a.Answers = []dnsmessage.Resource{{Header: dnsmessage.ResourceHeader{Name: q.Questions[0].Name, Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET, TTL: 300},
				Body: &dnsmessage.AResource{A: [4]byte{192, 0, 2, 5}}}}
		}
		out, _ := a.Pack()
		w.Header().Set("Content-Type", "application/dns-message")
		w.Write(out)
	}))
	defer srv.Close()
	d := testDoH(t, srv)
	for range 2 {
		if addrs, err := d.lookup(context.Background(), "half.test"); err != nil || len(addrs) != 1 {
			t.Fatalf("%v %v", addrs, err)
		}
	}
	if n := asked.Load(); n != 4 {
		t.Errorf("half an answer kept: asked %d times, want 4", n)
	}
}

// TestGoDoHStatus: when the server last answered (a name not found is an
// answer), and last failed and why; a question given up isn't a failure.
func TestGoDoHStatus(t *testing.T) {
	srv, _ := dohServer(t, map[string]netip.Addr{"example.com": netip.MustParseAddr("192.0.2.1")}, 1)
	d := testDoH(t, srv)
	if s := d.status(); s["ok"] != int64(0) || s["error"] != nil {
		t.Fatalf("before any: %v", s)
	}
	if err := d.check(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := d.lookup(context.Background(), "missing.test"); !errors.Is(err, errGoDNS) {
		t.Fatal(err)
	}
	s := d.status()
	if ok, _ := s["ok"].(int64); ok == 0 || s["error"] != nil {
		t.Fatalf("answered: %v", s)
	}
	// A name that can't be asked isn't the server's answer.
	okAt := d.okAt.Load()
	time.Sleep(2 * time.Millisecond)
	if _, err := d.lookup(context.Background(), strings.Repeat("a", 70)+".test"); !errors.Is(err, errGoDNS) || d.okAt.Load() != okAt {
		t.Fatalf("a name that can't be asked: %v, noted as answered", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	d.lookup(ctx, "given-up.test")
	if s := d.status(); s["error"] != nil {
		t.Fatalf("given up, noted as failed: %v", s)
	}
	srv.Close()
	if err := d.check(context.Background()); err == nil {
		t.Fatal("a closed server answered")
	}
	s = d.status()
	if at, _ := s["errorAt"].(int64); at == 0 || s["error"] == "" || s["error"] == nil {
		t.Fatalf("failed: %v", s)
	}
}

// TestGoNameMissing: only a name the DoH server says doesn't exist is
// missing (a typed one is then searched for: go.js); not one it couldn't
// answer, one it knows, a local record's, or an address.
func TestGoNameMissing(t *testing.T) {
	srv, _ := dohServer(t, map[string]netip.Addr{"site.test": netip.MustParseAddr("192.0.2.7")}, 1)
	goDoHNow.Store(testDoH(t, srv))
	t.Cleanup(func() { goDoHNow.Store(nil) })
	setLocalHosts(t, goHostRecord{"only-local.test", "127.0.0.1"})
	ctx := context.Background()
	for host, want := range map[string]bool{
		"missing.test":    true,
		"MISSING.test.":   true,
		"site.test":       false,
		"fail.test":       false, // SERVFAIL: it may exist
		"only-local.test": false,
		"192.0.2.1":       false,
		"[2001:db8::1]":   false,
		"":                false,
	} {
		if got := goNameMissing(ctx, host); got != want {
			t.Errorf("goNameMissing(%q) = %v, want %v", host, got, want)
		}
	}
}
