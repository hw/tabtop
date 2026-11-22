package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

// TestGoHostRecords: names and addresses as they're kept, each once; what
// isn't a host name or an address refused.
func TestGoHostRecords(t *testing.T) {
	got, err := goHostRecords([]goHostRecord{
		{" NAS.Lan. ", "192.168.1.10"},
		{"nas.lan", "[2001:db8::10]"},
		{"nas.lan", "192.168.1.10"}, // (again)
		{"printer", "::ffff:10.0.0.7"},
		{"_svc.example.test", "2001:db8::1"},
	})
	want := []goHostRecord{{"nas.lan", "192.168.1.10"}, {"nas.lan", "2001:db8::10"}, {"printer", "10.0.0.7"}, {"_svc.example.test", "2001:db8::1"}}
	if err != nil || !slices.Equal(got, want) {
		t.Fatalf("kept %v (%v), want %v", got, err, want)
	}
	for _, bad := range []goHostRecord{
		{"", "192.0.2.1"}, {"192.0.2.9", "192.0.2.1"}, {"[2001:db8::9]", "192.0.2.1"}, {"a..b", "192.0.2.1"}, {"-a.test", "192.0.2.1"},
		{"a b.test", "192.0.2.1"}, {"ok.test", "nas"}, {"ok.test", "fe80::1%eth0"}, {"ok.test", "0.0.0.0"}, {"ok.test", "::"}, {"ok.test", ""},
	} {
		if _, err := goHostRecords([]goHostRecord{bad}); err == nil {
			t.Errorf("%v taken", bad)
		}
	}
	many := make([]goHostRecord, maxGoHostRecords+1)
	for i := range many {
		many[i] = goHostRecord{fmt.Sprintf("h%d.test", i), "192.0.2.1"}
	}
	if _, err := goHostRecords(many); err == nil {
		t.Error("more records than allowed taken")
	}
}

// listenLocal is a TCP listener on this machine taking connections (and
// closing them); its port.
func listenLocal(t *testing.T) string {
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
			c.Close()
		}
	}()
	_, port, _ := net.SplitHostPort(l.Addr().String())
	return port
}

// setLocalHosts uses records while the test runs.
func setLocalHosts(t *testing.T, records ...goHostRecord) {
	t.Helper()
	kept, err := goHostRecords(records)
	if err != nil {
		t.Fatal(err)
	}
	goHostsNow.Store(goHostsTable(kept))
	t.Cleanup(func() { goHostsNow.Store(nil) })
}

// TestGoHostsFirst: a name with local records is dialled at them, before
// DNS over HTTPS (not asked) or the system's DNS; whatever its case; the
// address policy still applies to them.
func TestGoHostsFirst(t *testing.T) {
	port := listenLocal(t)
	dial := newGoDialer(func(netip.Addr) bool { return true })
	setLocalHosts(t, goHostRecord{"only-local.test", "127.0.0.1"}, goHostRecord{"site.test", "127.0.0.1"})
	// DoH off: the system's DNS doesn't know it; the record's used.
	c, err := dial.DialContext(context.Background(), "tcp", net.JoinHostPort("Only-Local.Test.", port))
	if err != nil {
		t.Fatalf("a local record's name, DoH off: %v", err)
	}
	c.Close()
	// DoH on, saying elsewhere: not asked.
	srv, asked := dohServer(t, map[string]netip.Addr{"site.test": netip.MustParseAddr("192.0.2.1")}, 60)
	goDoHNow.Store(testDoH(t, srv))
	t.Cleanup(func() { goDoHNow.Store(nil) })
	if c, err = dial.DialContext(context.Background(), "tcp", net.JoinHostPort("site.test", port)); err != nil {
		t.Fatalf("a local record's name, DoH on: %v", err)
	}
	c.Close()
	if n := asked.Load(); n != 0 {
		t.Errorf("DoH asked %d times for a name with a local record", n)
	}
	// This machine's address, refused by the policy, record or not.
	if _, err := newGoDialer(fetchPolicy(false)).DialContext(context.Background(), "tcp", net.JoinHostPort("site.test", port)); !errors.Is(err, errFetchAddress) {
		t.Errorf("a local record past the policy: %v", err)
	}
	// Records cleared: DoH again.
	goHostsNow.Store(nil)
	if c, err := dial.DialContext(context.Background(), "tcp", net.JoinHostPort("only-local.test", port)); err == nil {
		c.Close()
		t.Error("its record cleared, the name still found")
	}
}

// TestGoHostsDoHServer: a custom DoH server's own name, with a local
// record, is reached there (not looked up by the system's DNS).
func TestGoHostsDoHServer(t *testing.T) {
	srv, _ := dohServer(t, map[string]netip.Addr{"example.com": netip.MustParseAddr("192.0.2.1")}, 60)
	u, _ := url.Parse(srv.URL)
	setLocalHosts(t, goHostRecord{"example.com", "127.0.0.1"}) // (a name its certificate has)
	was := goDoHAllow
	goDoHAllow = func(netip.Addr) bool { return true }
	t.Cleanup(func() { goDoHAllow = was })
	d := newGoDoH("https://example.com:"+u.Port()+"/dns-query", nil)
	d.client.Transport.(*http.Transport).TLSClientConfig = srv.Client().Transport.(*http.Transport).TLSClientConfig
	if err := d.check(context.Background()); err != nil {
		t.Fatalf("the DoH server at its local record not reached: %v", err)
	}
}

// TestGoHostsSetting: kept with the browser-wide settings, read back, and
// reported.
func TestGoHostsSetting(t *testing.T) {
	file := filepath.Join(t.TempDir(), "sites.json")
	s := newGoSiteSettings(file)
	if len(s.localHosts()) != 0 {
		t.Fatal("records by default")
	}
	records := []goHostRecord{{"nas.lan", "192.168.1.10"}, {"nas.lan", "2001:db8::10"}}
	s.setHosts(records)
	if got := newGoSiteSettings(file).localHosts(); !slices.Equal(got, records) {
		t.Errorf("read back as %v", got)
	}
	if got, _ := s.report()["hosts"].([]goHostRecord); !slices.Equal(got, records) {
		t.Errorf("reported as %v", s.report()["hosts"])
	}
	s.setHosts(nil)
	if got := newGoSiteSettings(file).localHosts(); len(got) != 0 {
		t.Errorf("cleared, read back as %v", got)
	}
}

// TestGoDNSChangedClients: a change of names lets go of the connections
// kept idle by each of the browser's own clients (page resources, filter
// lists, a tab's with a certificate exception), not only the proxy's.
func TestGoDNSChangedClients(t *testing.T) {
	allow := func(netip.Addr) bool { return true }
	exceptions := &goCertExceptions{}
	exceptions.add("lan.test", false)
	for name, client := range map[string]*http.Client{
		"resources":   newGoResourceClient(allow),
		"lists":       newGoAdBlock("", allow).client,
		"exception's": exceptions.client(newGoResourceClient(allow)),
	} {
		closed := make(chan struct{}, 4)
		srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) }))
		srv.Config.ConnState = func(_ net.Conn, s http.ConnState) {
			if s == http.StateClosed {
				closed <- struct{}{}
			}
		}
		srv.Start()
		res, err := client.Get(srv.URL)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		io.Copy(io.Discard, res.Body)
		res.Body.Close()
		goDNSChanged()
		select {
		case <-closed:
		case <-time.After(2 * time.Second):
			t.Errorf("%s client: its idle connection kept, names changed", name)
		}
		srv.Close()
	}
}

// TestGoHostsLoadSkipsBad: a record in the file that isn't one is left out
// alone; the others are kept, and stay kept when it's saved again.
func TestGoHostsLoadSkipsBad(t *testing.T) {
	file := filepath.Join(t.TempDir(), "sites.json")
	if err := os.WriteFile(file, []byte(`{"hosts":[{"name":"nas.lan","addr":"192.168.1.10"},{"name":"bad name","addr":"192.0.2.1"},{"name":"printer.lan","addr":"10.0.0.7"}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	s := newGoSiteSettings(file)
	want := []goHostRecord{{"nas.lan", "192.168.1.10"}, {"printer.lan", "10.0.0.7"}}
	if got := s.localHosts(); !slices.Equal(got, want) {
		t.Fatalf("loaded %v, want %v", got, want)
	}
	s.setDoH("", "") // (any setting saved)
	if got := newGoSiteSettings(file).localHosts(); !slices.Equal(got, want) {
		t.Errorf("saved again, read back as %v", got)
	}
}
