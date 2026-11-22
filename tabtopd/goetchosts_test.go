package main

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// useEtcHosts reads hosts as /etc/hosts while the test runs.
func useEtcHosts(t *testing.T, hosts string) string {
	t.Helper()
	file := filepath.Join(t.TempDir(), "hosts")
	if err := os.WriteFile(file, []byte(hosts), 0o644); err != nil {
		t.Fatal(err)
	}
	was := goEtcHostsFile
	goEtcHostsFile = file
	t.Cleanup(func() { goEtcHostsFile = was; goEtcHosts.Lock(); goEtcHosts.file = ""; goEtcHosts.Unlock() })
	return file
}

// noEtcHosts is an empty /etc/hosts while the test runs.
func noEtcHosts(t *testing.T) { useEtcHosts(t, "") }

// TestGoEtcHostsRead: names and addresses as a hosts file has them:
// comments, aliases, case, IPv6 and IPv4-mapped; what isn't one skipped.
func TestGoEtcHostsRead(t *testing.T) {
	useEtcHosts(t, "# a comment\n127.0.0.1 localhost\n192.168.1.10\tNAS.lan nas # the box\n::ffff:10.0.0.7 printer.lan\n2001:db8::10 nas.lan\nfe80::1%eth0 linklocal.lan\nbogus line\n10.0.0.9 not_a@name ok.lan\n")
	for name, want := range map[string][]string{
		"nas.lan.": {"192.168.1.10", "2001:db8::10"}, "NAS": {"192.168.1.10"}, "printer.lan": {"10.0.0.7"}, "ok.lan": {"10.0.0.9"},
	} {
		got, ok := goEtcHostsLookup(name)
		var s []string
		for _, a := range got {
			s = append(s, a.String())
		}
		if !ok || !slices.Equal(s, want) {
			t.Errorf("%s: %v (%v), want %v", name, s, ok, want)
		}
	}
	for _, name := range []string{"linklocal.lan", "not_a@name", "missing.lan"} {
		if _, ok := goEtcHostsLookup(name); ok {
			t.Errorf("%s found", name)
		}
	}
}

// TestGoEtcHostsOrder: the local records first, then /etc/hosts, then DNS
// over HTTPS (not asked for a name /etc/hosts has); the file read again
// as it changes.
func TestGoEtcHostsOrder(t *testing.T) {
	port := listenLocal(t)
	file := useEtcHosts(t, "127.0.0.1 hosts.test both.test\n")
	srv, asked := dohServer(t, map[string]netip.Addr{"hosts.test": netip.MustParseAddr("192.0.2.1"), "both.test": netip.MustParseAddr("192.0.2.1")}, 60)
	goDoHNow.Store(testDoH(t, srv))
	t.Cleanup(func() { goDoHNow.Store(nil) })
	dial := newGoDialer(func(netip.Addr) bool { return true })
	c, err := dial.DialContext(context.Background(), "tcp", net.JoinHostPort("hosts.test", port))
	if err != nil {
		t.Fatalf("a name in /etc/hosts, DoH on: %v", err)
	}
	c.Close()
	if n := asked.Load(); n != 0 {
		t.Errorf("DoH asked %d times for a name /etc/hosts has", n)
	}
	// A local record over /etc/hosts.
	setLocalHosts(t, goHostRecord{"both.test", "192.0.2.55"})
	if addrs, ok := goHostsLookup("both.test"); !ok || addrs[0] != netip.MustParseAddr("192.0.2.55") {
		t.Fatal("the local record not had")
	}
	refused := newGoDialer(func(a netip.Addr) bool { return a != netip.MustParseAddr("192.0.2.55") })
	if _, err := refused.DialContext(context.Background(), "tcp", net.JoinHostPort("both.test", port)); err == nil {
		t.Error("/etc/hosts's address dialled, a local record saying another")
	}
	// The file changed: read again.
	if err := os.WriteFile(file, []byte("# none now\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	os.Chtimes(file, time.Now().Add(time.Minute), time.Now().Add(time.Minute))
	goEtcHosts.Lock()
	goEtcHosts.checked = time.Time{}
	goEtcHosts.Unlock()
	if _, ok := goEtcHostsLookup("hosts.test"); ok {
		t.Error("a name taken out of /etc/hosts still found")
	}
}

// TestGoEtcHostsCut: a file past what's read keeps its first lines; the
// one the cut falls in isn't taken (a name cut short).
func TestGoEtcHostsCut(t *testing.T) {
	line := "0.0.0.0 tracker-0000000.example\n"
	var b []byte
	b = append(b, "10.0.0.1 first.lan\n"...)
	for len(b)+len(line) <= goEtcHostsMax-10 {
		b = append(b, line...)
	}
	b = append(b, "10.0.0.2 cut-across-the-limit.example\n"...)
	useEtcHosts(t, string(b))
	if _, ok := goEtcHostsLookup("first.lan"); !ok {
		t.Fatal("a name before the cut not found")
	}
	if _, ok := goEtcHostsLookup("cut-across-the-limit.example"); ok {
		t.Error("the line past the cut taken whole")
	}
	for name := range goEtcHosts.names {
		if len(name) > 0 && name != "first.lan" && name != "tracker-0000000.example" {
			t.Errorf("a name cut short taken: %q", name)
		}
	}
}

// TestGoEtcHostsLongLine: a line of thousands of names (over a Scanner's
// 64 KiB) is read, and what comes after it too.
func TestGoEtcHostsLongLine(t *testing.T) {
	var long strings.Builder
	long.WriteString("0.0.0.1")
	for i := range 8000 {
		fmt.Fprintf(&long, " blocked%d.example", i)
	}
	useEtcHosts(t, long.String()+"\n192.168.65.254 host.docker.internal\n")
	if got, ok := goEtcHostsLookup("host.docker.internal"); !ok || len(got) != 1 || got[0] != netip.MustParseAddr("192.168.65.254") {
		t.Fatalf("the name after the long line: %v %v", got, ok)
	}
	if _, ok := goEtcHostsLookup("blocked7999.example"); !ok {
		t.Fatal("the long line's last name not read")
	}
}
