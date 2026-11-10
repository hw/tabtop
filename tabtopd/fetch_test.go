package main

import (
	"bytes"
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestFetchAllowed(t *testing.T) {
	for a, want := range map[string][2]bool{ // public only, private too
		"93.184.216.34":            {true, true},
		"2606:2800:220:1::1":       {true, true},
		"127.0.0.1":                {false, false},
		"::1":                      {false, false},
		"::ffff:127.0.0.1":         {false, false},
		"0.0.0.0":                  {false, false},
		"0.1.2.3":                  {false, false},
		"169.254.169.254":          {false, false},
		"fe80::1":                  {false, false},
		"224.0.0.1":                {false, false},
		"255.255.255.255":          {false, false},
		"64:ff9b::7f00:1":          {false, false},
		"::127.0.0.1":              {false, false},
		"10.1.2.3":                 {false, true},
		"172.17.0.1":               {false, true},
		"192.168.1.10":             {false, true},
		"::ffff:192.168.1.10":      {false, true},
		"100.100.1.1":              {false, true},
		"fd12:3456::1":             {false, true},
		"2002:7f00:1::1":           {false, false},
		"2001:4860:4860::8888":     {true, true},
		"::ffff:93.184.216.34":     {true, true},
		"198.18.0.1":               {false, true},
		"192.0.2.1":                {true, true},   // documentation: harmless
		"fec0::1":                  {false, true},  // old site-local: private
		"fd00:ec2::254":            {false, false}, // AWS's metadata (IPv6)
		"fd00:ec2::253":            {false, true},
		"fd20:ce::254":             {false, false}, // Google Cloud's metadata (IPv6)
		"100.100.100.200":          {false, false}, // Alibaba Cloud's metadata
		"::ffff:100.100.100.200":   {false, false},
		"192.0.0.192":              {false, false}, // Oracle Cloud's metadata
		"168.63.129.16":            {false, false}, // Azure's WireServer
		"ff02::1":                  {false, false},
		"100.63.255.255":           {true, true},
		"2001:db8::1":              {true, true},
		"64:ff9b:1::a00:1":         {false, false},
		"::ffff:0:0":               {false, false},
		"172.32.0.1":               {true, true},
		"11.0.0.1":                 {true, true},
		"192.169.0.1":              {true, true},
		"fc00::1":                  {false, true},
		"fe00::1":                  {true, true},
		"febf::1":                  {false, false},
		"100.127.255.255":          {false, true},
		"0000:0000::0001":          {false, false},
		"0:0:0:0:0:ffff:7f00:0001": {false, false},
	} {
		got := [2]bool{fetchAllowed(netip.MustParseAddr(a), false), fetchAllowed(netip.MustParseAddr(a), true)}
		if got != want {
			t.Errorf("%s: %v, want %v", a, got, want)
		}
	}
}

// The real policy refuses this machine, however it's named, and wherever
// a redirect points.
func TestFetchRefusesLoopback(t *testing.T) {
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits++ }))
	defer srv.Close()
	c := newFetchClient(func(a netip.Addr) bool { return fetchAllowed(a, true) })
	_, port, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	for _, u := range []string{srv.URL, "http://localhost:" + port, "http://[::ffff:127.0.0.1]:" + port, "http://2130706433:" + port} {
		res, err := c.Get(u)
		if err == nil {
			res.Body.Close()
			t.Errorf("%s: fetched", u)
		} else if fetchError(err) != errFetchAddress && !strings.Contains(err.Error(), "no such host") {
			t.Errorf("%s: %v", u, fetchError(err))
		}
	}
	if hits != 0 {
		t.Errorf("the server was reached %d times", hits)
	}
}

// newFetchServer is an e2e server whose fetches may go anywhere, as
// tests' servers are on this machine.
func newFetchServer(t *testing.T) (*server, string, testSession) {
	t.Helper()
	g, srv := newE2EServer(t)
	g.fetches = &fetchManager{downloadsDir: g.downloadsDir, transfers: &g.transfers,
		client: newFetchClient(func(netip.Addr) bool { return true }), resourceClient: newFetchClient(func(netip.Addr) bool { return true })}
	t.Cleanup(func() { g.fetches.stop(context.Background()) })
	return g, srv.URL, login(t, testCtx(t), srv.URL, code(0))
}

// follow reads a fetch's replies until the last, and returns it.
func follow(t *testing.T, tc *tunnelClient) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	for {
		m := tc.readJSON(t, ctx)
		if m["error"] != nil {
			return m
		}
		if f, _ := m["fetch"].(map[string]any); f["done"] == true {
			return m
		}
	}
}

func fetchedName(m map[string]any) string {
	f, _ := m["fetch"].(map[string]any)
	s, _ := f["name"].(string)
	return s
}

func TestFetch(t *testing.T) {
	g, srv, s := newFetchServer(t)
	data := bytes.Repeat([]byte("abcdefgh"), 100000)
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/named":
			w.Header().Set("Content-Disposition", `attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`)
			w.Write([]byte("cv"))
		case "/files/report.bin":
			http.ServeContent(w, r, "report.bin", time.Time{}, bytes.NewReader(data))
		case "/hidden/.bashrc":
			w.Write([]byte("x"))
		case "/redirect":
			http.Redirect(w, r, "/files/report.bin", http.StatusFound)
		default:
			http.NotFound(w, r)
		}
	}))
	defer remote.Close()
	os.WriteFile(filepath.Join(g.downloadsDir, "report.bin"), []byte("old"), 0o644)

	for _, c := range []struct{ path, name, err string }{
		{"/files/report.bin", "report (1).bin", ""},
		{"/redirect", "report (2).bin", ""},
		{"/named", "résumé.pdf", ""},
		{"/hidden/.bashrc", "bashrc", ""},
		{"/missing", "", "the server answered 404 Not Found"},
	} {
		tc := openSession(t, testCtx(t), srv, s)
		first := tc.request(t, testCtx(t), tunnelRequest{Type: "fetch", URL: remote.URL + c.path + "?token=secret"})
		if first["ok"] != true {
			t.Fatalf("%s: %v", c.path, first)
		}
		last := follow(t, tc)
		if c.err != "" {
			if last["error"] != c.err {
				t.Errorf("%s: %v, want %q", c.path, last, c.err)
			}
			continue
		}
		if got := fetchedName(last); got != c.name {
			t.Errorf("%s: saved as %q (%v), want %q", c.path, got, last, c.name)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(g.downloadsDir, "report (1).bin")); !bytes.Equal(b, data) {
		t.Errorf("report (1).bin holds %d bytes", len(b))
	}
	if b, _ := os.ReadFile(filepath.Join(g.downloadsDir, "report.bin")); string(b) != "old" {
		t.Errorf("report.bin replaced")
	}
	// Nothing left behind, and none still going.
	if left, _ := filepath.Glob(filepath.Join(g.downloadsDir, uploadTempPrefix+"*")); len(left) > 0 {
		t.Errorf("left %v", left)
	}
	reply := openSession(t, testCtx(t), srv, s).request(t, testCtx(t), tunnelRequest{Type: "fetches"})
	if l, _ := reply["fetches"].([]any); len(l) != 5 {
		t.Errorf("fetches listed: %v", reply)
	}
	// Into a folder that isn't there; not http.
	for _, req := range []tunnelRequest{{Type: "fetch", Path: "nowhere", URL: remote.URL + "/named"}, {Type: "fetch", URL: "file:///etc/passwd"}} {
		tc := openSession(t, testCtx(t), srv, s)
		if r := tc.request(t, testCtx(t), req); r["ok"] == true {
			if last := follow(t, tc); last["error"] == nil {
				t.Errorf("%+v: %v", req, last)
			}
		}
	}
}

// A connection cut off part way is carried on from where it stopped.
func TestFetchResumes(t *testing.T) {
	g, srv, s := newFetchServer(t)
	data := bytes.Repeat([]byte("0123456789"), 300000)
	var cuts, ranged atomic.Int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Range") != "" {
			ranged.Add(1)
		}
		if cuts.Add(1) <= 2 {
			// Send some, then drop the connection.
			start := int64(0)
			if rng := r.Header.Get("Range"); rng != "" {
				start = startOf(rng)
			}
			w.Header().Set("Accept-Ranges", "bytes")
			w.Header().Set("ETag", `"v1"`)
			if start > 0 {
				w.Header().Set("Content-Range", "bytes "+itoa(start)+"-"+itoa(int64(len(data)-1))+"/"+itoa(int64(len(data))))
				w.Header().Set("Content-Length", itoa(int64(len(data))-start))
				w.WriteHeader(http.StatusPartialContent)
			} else {
				w.Header().Set("Content-Length", itoa(int64(len(data))))
			}
			w.Write(data[start : start+100000])
			w.(http.Flusher).Flush()
			panic(http.ErrAbortHandler)
		}
		w.Header().Set("ETag", `"v1"`)
		http.ServeContent(w, r, "big.bin", time.Time{}, bytes.NewReader(data))
	}))
	defer remote.Close()
	tc := openSession(t, testCtx(t), srv, s)
	tc.request(t, testCtx(t), tunnelRequest{Type: "fetch", URL: remote.URL + "/big.bin"})
	last := follow(t, tc)
	if fetchedName(last) != "big.bin" {
		t.Fatalf("%v", last)
	}
	if b, _ := os.ReadFile(filepath.Join(g.downloadsDir, "big.bin")); !bytes.Equal(b, data) {
		t.Errorf("big.bin holds %d bytes, not the %d sent", len(b), len(data))
	}
	if ranged.Load() != 2 {
		t.Errorf("%d requests carried on with a range, want 2", ranged.Load())
	}
}

func startOf(rng string) int64 {
	var n int64
	fmt.Sscanf(rng, "bytes=%d-", &n)
	return n
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

// A fetch goes on with the page gone; another page follows it, and
// cancels it, which deletes what it had.
func TestFetchFollowAndCancel(t *testing.T) {
	g, srv, s := newFetchServer(t)
	release := make(chan struct{})
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "1000000")
		w.Write(make([]byte, 1000))
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer remote.Close()
	defer close(release)
	tc := openSession(t, testCtx(t), srv, s)
	first := tc.request(t, testCtx(t), tunnelRequest{Type: "fetch", URL: remote.URL + "/slow.iso"})
	id := first["fetch"].(map[string]any)["id"].(string)
	tc.c.CloseNow()

	tc = openSession(t, testCtx(t), srv, s)
	again := tc.request(t, testCtx(t), tunnelRequest{Type: "fetch", Name: id})
	if again["ok"] != true || again["fetch"].(map[string]any)["name"] != "slow.iso" {
		t.Fatalf("following it again: %v", again)
	}
	// Wait till it has the first bytes, then cancel.
	for deadline := time.Now().Add(10 * time.Second); ; {
		m := tc.readJSON(t, testCtx(t))
		if f, _ := m["fetch"].(map[string]any); f["got"].(float64) >= 1000 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("it got nothing")
		}
	}
	tc.write(testCtx(t), msgText, []byte(`{"cancel":true}`))
	if last := follow(t, tc); last["error"] != "cancelled" {
		t.Errorf("cancelled: %v", last)
	}
	if left, _ := filepath.Glob(filepath.Join(g.downloadsDir, uploadTempPrefix+"*")); len(left) > 0 {
		t.Errorf("left %v", left)
	}
}

// This machine's own addresses are refused, whichever interface they're
// on, private networks allowed or not.
func TestFetchRefusesOwnAddresses(t *testing.T) {
	addrs, _ := net.InterfaceAddrs()
	var own netip.Addr
	for _, x := range addrs {
		if n, ok := x.(*net.IPNet); ok {
			if ip, ok := netip.AddrFromSlice(n.IP); ok && ip.Unmap().Is4() && !ip.IsLoopback() && !ip.IsLinkLocalUnicast() {
				own = ip.Unmap()
				break
			}
		}
	}
	if !own.IsValid() {
		t.Skip("no address but loopback here")
	}
	ln, err := net.Listen("tcp", net.JoinHostPort(own.String(), "0"))
	if err != nil {
		t.Skip(err)
	}
	hits := 0
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits++ })}
	go srv.Serve(ln)
	defer srv.Close()
	for _, private := range []bool{false, true} {
		res, err := newFetchClient(fetchPolicy(private)).Get("http://" + ln.Addr().String() + "/")
		if err == nil {
			res.Body.Close()
			t.Errorf("private %v: fetched from %s", private, ln.Addr())
		} else if fetchError(err) != errFetchAddress {
			t.Errorf("private %v: %v", private, fetchError(err))
		}
	}
	if hits != 0 || !localAddr(own) || localAddr(netip.MustParseAddr("192.0.2.77")) {
		t.Errorf("hits %d; local %v", hits, localAddr(own))
	}
}

// TestFetchNoValidator: a server that takes ranges, but doesn't say which
// version of the file it sent, isn't asked for the rest of it when it's cut
// off, which could be of another version: the file is fetched again, whole.
func TestFetchNoValidator(t *testing.T) {
	g, srv, s := newFetchServer(t)
	v1 := bytes.Repeat([]byte("A"), 400000)
	v2 := bytes.Repeat([]byte("B"), 400000)
	var requests, ranged atomic.Int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Accept-Ranges", "bytes")
		if requests.Add(1) == 1 {
			// Version 1, cut off.
			w.Header().Set("Content-Length", itoa(int64(len(v1))))
			w.Write(v1[:100000])
			w.(http.Flusher).Flush()
			panic(http.ErrAbortHandler)
		}
		// Changed meanwhile: version 2, ranges and all, but no ETag or
		// Last-Modified to tell.
		if r.Header.Get("Range") != "" {
			ranged.Add(1)
		}
		http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(v2))
	}))
	defer remote.Close()
	tc := openSession(t, testCtx(t), srv, s)
	tc.request(t, testCtx(t), tunnelRequest{Type: "fetch", URL: remote.URL + "/v.bin"})
	last := follow(t, tc)
	if fetchedName(last) != "v.bin" {
		t.Fatalf("%v", last)
	}
	if b, _ := os.ReadFile(filepath.Join(g.downloadsDir, "v.bin")); !bytes.Equal(b, v2) {
		t.Errorf("v.bin holds %d A's and %d B's, not version 2 whole", bytes.Count(b, []byte("A")), bytes.Count(b, []byte("B")))
	}
	if ranged.Load() != 0 {
		t.Errorf("%d requests asked for the rest, without a validator", ranged.Load())
	}
}

// TestFetchFollowedLate: a page that follows a fetch again after it's no
// longer listed (its computer asleep, say) is told how it ended, not that
// it failed; and only once even that's forgotten, that it ended long ago.
func TestFetchFollowedLate(t *testing.T) {
	g, srv, s := newFetchServer(t)
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/missing" {
			http.NotFound(w, r)
			return
		}
		w.Write([]byte("hello"))
	}))
	defer remote.Close()
	// fetched fetches path, follows it to its end, and stops listing it.
	fetched := func(path string) string {
		tc := openSession(t, testCtx(t), srv, s)
		first := tc.request(t, testCtx(t), tunnelRequest{Type: "fetch", URL: remote.URL + path})
		id := first["fetch"].(map[string]any)["id"].(string)
		follow(t, tc)
		g.fetches.forget(g.fetches.job(id))
		return id
	}
	again := func(id string) map[string]any {
		tc := openSession(t, testCtx(t), srv, s)
		if r := tc.request(t, testCtx(t), tunnelRequest{Type: "fetch", Name: id}); r["ok"] != true {
			return r
		}
		return follow(t, tc)
	}
	ok := fetched("/hello.txt")
	if last := again(ok); fetchedName(last) != "hello.txt" {
		t.Errorf("followed late: %v", last)
	}
	failed := fetched("/missing")
	if last := again(failed); last["error"] != "the server answered 404 Not Found" {
		t.Errorf("followed late, failed: %v", last)
	}
	g.fetches.mu.Lock()
	g.fetches.outcomes = nil
	g.fetches.mu.Unlock()
	if last := again(ok); last["error"] != errFetchForgotten.Error() {
		t.Errorf("followed after it's forgotten: %v", last)
	}
}

// TestFetchUnsizedRoom: a server that sends without saying how much, and
// without end, can't fill the disk: the fetch stops at what's free, less
// what it keeps spare, and nothing's left behind.
func TestFetchUnsizedRoom(t *testing.T) {
	g, srv, s := newFetchServer(t)
	free, _, ok := diskSpace(g.downloadsDir)
	if !ok {
		t.Skip("can't tell what's free")
	}
	old := fetchSpare
	fetchSpare = free - 1<<20 // about 1 MB of room
	defer func() { fetchSpare = old }()
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		chunk := bytes.Repeat([]byte("z"), 64<<10)
		for i := 0; i < 1000; i++ { // 64 MB, without a length
			if _, err := w.Write(chunk); err != nil {
				return
			}
			w.(http.Flusher).Flush()
		}
	}))
	defer remote.Close()
	tc := openSession(t, testCtx(t), srv, s)
	tc.request(t, testCtx(t), tunnelRequest{Type: "fetch", URL: remote.URL + "/endless"})
	last := follow(t, tc)
	if e, _ := last["error"].(string); !strings.Contains(e, "bigger than the room on the disk") {
		t.Errorf("%v", last)
	}
	if left, _ := filepath.Glob(filepath.Join(g.downloadsDir, "*")); len(left) != 0 {
		t.Errorf("left %v", left)
	}
}
