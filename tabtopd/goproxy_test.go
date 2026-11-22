package main

import (
	"bufio"
	"bytes"
	"crypto/tls"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// startGoProxy serves p on a loopback port, and returns a client that goes
// through it.
func startGoProxy(t *testing.T, p *goProxy, user, password string) (*http.Client, string) {
	t.Helper()
	p.logf = t.Logf
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go p.serve(l)
	t.Cleanup(func() { l.Close() })
	u := &url.URL{Scheme: "http", Host: l.Addr().String()}
	if user != "" {
		u.User = url.UserPassword(user, password)
	}
	return &http.Client{
		Transport: &http.Transport{Proxy: http.ProxyURL(u), DisableKeepAlives: true},
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
		Timeout: 10 * time.Second,
	}, l.Addr().String()
}

func allowAll(netip.Addr) bool { return true }

func TestGoProxyForwards(t *testing.T) {
	var got http.Header
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		if r.URL.Path == "/moved" {
			http.Redirect(w, r, "/elsewhere", http.StatusFound)
			return
		}
		fmt.Fprint(w, "hello from the site")
	}))
	defer site.Close()
	goTestPorts(t, portOf(t, site.URL))
	client, _ := startGoProxy(t, newGoProxy(allowAll, "", ""), "", "")

	req, _ := http.NewRequest("GET", site.URL+"/page", nil)
	req.Header.Set("Connection", "X-Secret")
	req.Header.Set("X-Secret", "hop-by-hop")
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || string(body) != "hello from the site" {
		t.Fatalf("got %d %q", res.StatusCode, body)
	}
	for _, h := range []string{"X-Secret", "Proxy-Authorization", "Proxy-Connection", "X-Forwarded-For", "Forwarded", "X-Forwarded-Host"} {
		if v := got.Get(h); v != "" {
			t.Errorf("the site was sent %s: %q", h, v)
		}
	}

	// A redirect goes back to the engine, which follows it itself.
	res, err = client.Get(site.URL + "/moved")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusFound || res.Header.Get("Location") != "/elsewhere" {
		t.Errorf("redirect: got %d to %q", res.StatusCode, res.Header.Get("Location"))
	}
}

func TestGoProxyRefusesWhereFetchesCannotGo(t *testing.T) {
	var hits atomic.Int32
	site := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits.Add(1) }))
	defer site.Close()
	tlsSite := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits.Add(1) }))
	defer tlsSite.Close()
	// The test sites are on loopback, which the policy refuses, as it
	// refuses this machine's addresses in use.
	noLoopback := func(a netip.Addr) bool { return !a.Unmap().IsLoopback() }
	p := newGoProxy(noLoopback, "", "")
	p.ports = map[string]bool{portOf(t, tlsSite.URL): true}
	client, addr := startGoProxy(t, p, "", "")

	_, sitePort, _ := net.SplitHostPort(strings.TrimPrefix(site.URL, "http://"))
	for _, u := range []string{site.URL, "http://localhost:" + sitePort + "/", "http://[::ffff:127.0.0.1]:" + sitePort + "/"} {
		res, err := client.Get(u)
		if err != nil {
			t.Fatalf("%s: %v", u, err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusForbidden {
			t.Errorf("%s: got %d, want 403", u, res.StatusCode)
		}
	}
	if code := connect(t, addr, strings.TrimPrefix(tlsSite.URL, "https://"), ""); code != http.StatusForbidden {
		t.Errorf("CONNECT to loopback: got %d, want 403", code)
	}
	if n := hits.Load(); n != 0 {
		t.Errorf("the sites were reached %d times", n)
	}
}

func TestGoProxyTunnels(t *testing.T) {
	tlsSite := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "secure hello")
	}))
	defer tlsSite.Close()
	p := newGoProxy(allowAll, "", "")
	p.ports = map[string]bool{portOf(t, tlsSite.URL): true}
	client, addr := startGoProxy(t, p, "", "")
	client.Transport.(*http.Transport).TLSClientConfig = tlsSite.Client().Transport.(*http.Transport).TLSClientConfig

	res, err := client.Get(tlsSite.URL)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if string(body) != "secure hello" {
		t.Errorf("through the tunnel: got %q", body)
	}

	// Only the ports tunnels may use.
	other := httptest.NewServer(http.NotFoundHandler())
	defer other.Close()
	if code := connect(t, addr, strings.TrimPrefix(other.URL, "http://"), ""); code != http.StatusForbidden {
		t.Errorf("CONNECT to another port: got %d, want 403", code)
	}
}

func TestGoProxyCredentials(t *testing.T) {
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Proxy-Authorization") != "" {
			t.Error("the site was sent the proxy's credentials")
		}
		fmt.Fprint(w, "ok")
	}))
	defer site.Close()
	goTestPorts(t, portOf(t, site.URL))
	p := newGoProxy(allowAll, "engine", "s3cret")

	anon, addr := startGoProxy(t, p, "", "")
	res, err := anon.Get(site.URL)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusProxyAuthRequired {
		t.Errorf("without credentials: got %d, want 407", res.StatusCode)
	}
	if code := connect(t, addr, "example.com:443", "Basic "+basicAuth("engine", "wrong")); code != http.StatusProxyAuthRequired {
		t.Errorf("CONNECT with wrong credentials: got %d, want 407", code)
	}

	authed, _ := startGoProxy(t, p, "engine", "s3cret")
	res, err = authed.Get(site.URL)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Errorf("with credentials: got %d", res.StatusCode)
	}
}

func TestGoProxyRefusesOddRequests(t *testing.T) {
	_, addr := startGoProxy(t, newGoProxy(allowAll, "", ""), "", "")
	for _, line := range []string{"GET /relative HTTP/1.1", "GET ftp://example.com/ HTTP/1.1", "GET http://user:pw@example.com/ HTTP/1.1"} {
		if code := rawRequest(t, addr, line+"\r\nHost: example.com\r\n\r\n"); code != http.StatusBadRequest {
			t.Errorf("%q: got %d, want 400", line, code)
		}
	}
	// Plain requests, like tunnels, go only to HTTP's and HTTPS's ports.
	for _, line := range []string{"GET http://example.com:25/ HTTP/1.1", "GET http://example.com:8080/ HTTP/1.1", "GET https://example.com:22/ HTTP/1.1"} {
		if code := rawRequest(t, addr, line+"\r\nHost: example.com\r\n\r\n"); code != http.StatusForbidden {
			t.Errorf("%q: got %d, want 403", line, code)
		}
	}
}

func TestGoProxyLimitsConnections(t *testing.T) {
	p := newGoProxy(allowAll, "", "")
	p.slots = make(chan struct{}, 1)
	_, addr := startGoProxy(t, p, "", "")
	// One tunnel open holds the only slot...
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
			defer c.Close()
		}
	}()
	p.ports = map[string]bool{portOf(t, "http://"+l.Addr().String()): true}
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	fmt.Fprintf(c, "CONNECT %s HTTP/1.1\r\nHost: %[1]s\r\n\r\n", l.Addr())
	res, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("first tunnel: %v %v", res, err)
	}
	// ...so the next connection is turned away.
	if code := connect(t, addr, l.Addr().String(), ""); code != http.StatusServiceUnavailable {
		t.Errorf("over the limit: got %d, want 503", code)
	}
}

func TestGoProxyCloseEndsTunnels(t *testing.T) {
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
			go io.Copy(io.Discard, c) // holds the tunnel open
		}
	}()
	p := newGoProxy(allowAll, "", "")
	p.ports = map[string]bool{portOf(t, "http://"+l.Addr().String()): true}
	_, addr := startGoProxy(t, p, "", "")
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	fmt.Fprintf(c, "CONNECT %s HTTP/1.1\r\nHost: %[1]s\r\n\r\n", l.Addr())
	br := bufio.NewReader(c)
	if res, err := http.ReadResponse(br, nil); err != nil || res.StatusCode != 200 {
		t.Fatalf("tunnel: %v %v", res, err)
	}
	done := make(chan struct{})
	go func() { p.close(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("close didn't end the tunnel")
	}
	c.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := br.ReadByte(); err != io.EOF && !isClosedErr(err) {
		t.Errorf("the engine's side stayed open: %v", err)
	}
}

// TestGoProxyWithMoli drives a real engine through the proxy: a page on
// 127.0.0.1 (which this test's policy allows) tries to reach a service on
// [::1], the metadata address and a private one, over fetch, XHR and
// WebSocket. The policy refuses them all, and the service must see none.
// Set TABTOP_TEST_MOLI to a Moli binary to run it.
func TestGoProxyWithMoli(t *testing.T) {
	moli := os.Getenv("TABTOP_TEST_MOLI")
	if moli == "" {
		t.Skip("TABTOP_TEST_MOLI isn't set to a Moli binary")
	}
	var leaks atomic.Int32
	secretL, err := net.Listen("tcp", "[::1]:0")
	if err != nil {
		t.Skip("no IPv6 loopback here")
	}
	secret := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		leaks.Add(1)
		t.Errorf("the service on [::1] was reached: %s", r.URL)
		io.WriteString(w, "<title>SECRET</title>")
	})}
	go secret.Serve(secretL)
	defer secret.Close()
	_, secretPort, _ := net.SplitHostPort(secretL.Addr().String())

	page := `<!doctype html><title>probe</title>
<script src="http://[::1]:PORT/script"></script>
<link rel="stylesheet" href="http://[::1]:PORT/style">
<img src="http://[::1]:PORT/img">
<iframe src="http://[::1]:PORT/frame"></iframe>
<script>
window.probe = async () => {
  const race = (p) => Promise.race([p, new Promise((_, no) => setTimeout(() => no("timeout"), 3000))]);
  const out = [];
  navigator.sendBeacon && navigator.sendBeacon("http://[::1]:PORT/beacon", "x");
  if (typeof EventSource !== "undefined") {
    out.push(await race(new Promise((ok, no) => { const s = new EventSource("http://[::1]:PORT/events"); s.onopen = () => ok("events open"); s.onerror = () => no(); })).catch(() => "events failed"));
  }
  const f = document.createElement("iframe"); f.src = "http://localhost:PORT/frame2"; document.body.appendChild(f);
  await new Promise((ok) => setTimeout(ok, 500));
  for (const u of ["http://[::1]:PORT/a", "http://localhost:PORT/b", "http://169.254.169.254/c", "http://10.0.0.1/d"]) {
    out.push(await race(fetch(u)).then(() => "fetch answered", () => "fetch failed"));
  }
  out.push(await race(new Promise((ok, no) => { const x = new XMLHttpRequest(); x.open("GET", "http://[::1]:PORT/x"); x.onload = () => ok("xhr answered"); x.onerror = () => no(); x.send(); })).catch(() => "xhr failed"));
  out.push(await race(new Promise((ok, no) => { const w = new WebSocket("ws://[::1]:PORT/w"); w.onopen = () => ok("ws open"); w.onerror = () => no(); })).catch(() => "ws failed"));
  return document.title + ": " + out.join(", ");
};
</script>`
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		io.WriteString(w, strings.ReplaceAll(page, "PORT", secretPort))
	}))
	defer site.Close()
	// The service's port too: it's the address policy that must refuse it.
	goTestPorts(t, portOf(t, site.URL), secretPort)

	only127 := func(a netip.Addr) bool { return a.Unmap() == netip.MustParseAddr("127.0.0.1") }
	p := newGoProxy(only127, "engine", "s3cret")
	_, addr := startGoProxy(t, p, "", "")

	cmd := exec.Command(moli, "fetch", "--http-proxy", "http://engine:s3cret@"+addr, "--image", "--font",
		"--eval", "window.probe()", site.URL)
	cmd.Env = []string{"HOME=" + t.TempDir(), "PATH=/usr/bin:/bin"} // and no NO_PROXY
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("moli: %v\n%s", err, out)
	}
	got := strings.TrimSpace(string(out))
	t.Logf("moli: %s", got)
	if !strings.Contains(got, "probe:") {
		t.Fatalf("the page didn't load through the proxy: %s", got)
	}
	if strings.Contains(got, "answered") || strings.Contains(got, " open") {
		t.Errorf("a refused address answered: %s", got)
	}
	// A navigation there fails too.
	nav := exec.Command(moli, "fetch", "--http-proxy", "http://engine:s3cret@"+addr, "--eval", "document.title",
		"http://[::1]:"+secretPort+"/navigate")
	nav.Env = cmd.Env
	// Moli shows the proxy's refusal as the page; it mustn't be the service's.
	if out, _ := nav.CombinedOutput(); strings.Contains(string(out), "SECRET") {
		t.Errorf("navigating to [::1] reached the service: %s", out)
	}
	if n := leaks.Load(); n != 0 {
		t.Errorf("the service on [::1] was reached %d times", n)
	}
}

func isClosedErr(err error) bool {
	return err != nil && (strings.Contains(err.Error(), "reset") || strings.Contains(err.Error(), "closed"))
}

// connect sends a CONNECT for target to the proxy at addr, and returns the
// status it answers with.
func connect(t *testing.T, addr, target, auth string) int {
	t.Helper()
	req := fmt.Sprintf("CONNECT %s HTTP/1.1\r\nHost: %[1]s\r\n", target)
	if auth != "" {
		req += "Proxy-Authorization: " + auth + "\r\n"
	}
	return rawRequest(t, addr, req+"\r\n")
}

func rawRequest(t *testing.T, addr, req string) int {
	t.Helper()
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(10 * time.Second))
	io.WriteString(c, req)
	res, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	return res.StatusCode
}

// goTestPorts lets proxies made during t reach ports, besides HTTP's and
// HTTPS's, as test sites listen on any.
func goTestPorts(t *testing.T, ports ...string) {
	t.Helper()
	was := goProxyPorts
	goProxyPorts = map[string]bool{"80": true, "443": true}
	for _, port := range ports {
		goProxyPorts[port] = true
	}
	t.Cleanup(func() { goProxyPorts = was })
}

func portOf(t *testing.T, rawURL string) string {
	t.Helper()
	u, err := url.Parse(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	return u.Port()
}

func basicAuth(user, password string) string {
	return base64.StdEncoding.EncodeToString([]byte(user + ":" + password))
}

// An engine's requests come at most goProxyBurst at once, then at
// goProxyRate a second; once its bytes are spent, nothing more goes.
func TestGoProxyBudget(t *testing.T) {
	b := newGoProxyBudget()
	for i := range goProxyBurst {
		if !b.request() {
			t.Fatalf("request %d of the burst refused", i)
		}
	}
	if b.request() {
		t.Fatal("a request past the burst let through")
	}
	b.last = b.last.Add(-time.Second) // a second on
	n := 0
	for b.request() {
		n++
	}
	if n < goProxyRate-1 || n > goProxyRate+1 {
		t.Errorf("%d requests a second later, want %d", n, goProxyRate)
	}

	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(bytes.Repeat([]byte("x"), 4096))
	}))
	defer site.Close()
	goTestPorts(t, portOf(t, site.URL))
	p := newGoProxy(allowAll, "", "")
	p.budget.limit = 6000
	client, _ := startGoProxy(t, p, "", "")
	get := func() (int, error) {
		res, err := client.Get(site.URL)
		if err != nil {
			return 0, err
		}
		defer res.Body.Close()
		_, err = io.ReadAll(res.Body)
		return res.StatusCode, err
	}
	if code, err := get(); code != 200 || err != nil {
		t.Fatalf("first: %d %v", code, err)
	}
	if code, err := get(); err == nil && code == 200 {
		t.Fatal("the second went past the allowance whole")
	}
	if code, _ := get(); code != http.StatusTooManyRequests {
		t.Fatalf("once spent: %d, want 429", code)
	}
}

// TestGoProxyCertException: while the engine ignores certificate errors
// (its page an exception's), it reaches no other host by a tunnel, whatever
// the port: only the exception's; plain HTTP, any.
func TestGoProxyCertException(t *testing.T) {
	tlsSite := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "secure hello") }))
	defer tlsSite.Close()
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "plain hello") }))
	defer site.Close()
	p := newGoProxy(allowAll, "", "")
	p.ports = map[string]bool{portOf(t, tlsSite.URL): true, portOf(t, site.URL): true}
	certs := &goCertExceptions{}
	certs.add("excepted.test", false)
	certs.ignoring.Store(true)
	p.certs.Store(certs)
	client, addr := startGoProxy(t, p, "", "")
	// The engine, ignoring certificate errors.
	client.Transport.(*http.Transport).TLSClientConfig = &tls.Config{InsecureSkipVerify: true}

	if res, err := client.Get(tlsSite.URL); err == nil {
		res.Body.Close()
		t.Fatal("another host's HTTPS, its certificate unchecked, let through")
	}
	if !certs.tookRefused("127.0.0.1") {
		t.Error("the refusal not told")
	}
	// A tunnel by another port than 443 to another host: what's plain goes
	// (a ws:// WebSocket); TLS through it doesn't (https://host:80/).
	{
		c, err := net.Dial("tcp", addr)
		if err != nil {
			t.Fatal(err)
		}
		host := strings.TrimPrefix(site.URL, "http://")
		fmt.Fprintf(c, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\nGET / HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n", host, host, host)
		c.SetReadDeadline(time.Now().Add(5 * time.Second))
		got, _ := io.ReadAll(c)
		c.Close()
		if !strings.Contains(string(got), "200 Connection established") || !strings.Contains(string(got), "plain hello") {
			t.Errorf("plain through a tunnel to another host: %q", got)
		}
	}
	res, err := client.Get(site.URL)
	if err != nil {
		t.Fatalf("plain HTTP: %v", err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if string(body) != "plain hello" {
		t.Errorf("plain HTTP: %q", body)
	}
	// An exception's host: its TLS goes, unchecked as the person chose.
	certs.add("127.0.0.1", false)
	if res, err := client.Get(tlsSite.URL); err != nil {
		t.Errorf("an exception's TLS: %v", err)
	} else {
		res.Body.Close()
	}
	// Not ignoring: any, checked by the engine.
	p.certs.Store(&goCertExceptions{})
	if res, err := client.Get(tlsSite.URL); err != nil {
		t.Errorf("TLS, the engine checking: %v", err)
	} else {
		res.Body.Close()
	}
}
