package main

import (
	"bytes"
	"encoding/binary"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeXvncNone listens like Xvnc on a Unix socket, offering no login, then
// echoes.
func fakeXvncNone(t *testing.T, types ...byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "vnc.sock")
	l, err := net.Listen("unix", path)
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
			go func() {
				defer c.Close()
				c.Write([]byte(rfbVersion))
				io.ReadFull(c, make([]byte, 12))
				c.Write(append([]byte{byte(len(types))}, types...))
				if _, err := io.ReadFull(c, make([]byte, 1)); err != nil {
					return
				}
				c.Write([]byte{0, 0, 0, 0})
				io.Copy(c, c)
			}()
		}
	}()
	return "unix:" + path
}

// noVNCLogin runs noVNC's side of the handshake with a Plain login, and
// returns the security result's reason ("" for success).
func noVNCLogin(t *testing.T, c net.Conn, user, password string) string {
	t.Helper()
	c.SetDeadline(time.Now().Add(5 * time.Second))
	read := func(n int) []byte {
		b := make([]byte, n)
		if _, err := io.ReadFull(c, b); err != nil {
			t.Fatalf("reading %d bytes: %v", n, err)
		}
		return b
	}
	if v := read(12); string(v) != rfbVersion {
		t.Fatalf("version %q", v)
	}
	c.Write([]byte(rfbVersion))
	if b := read(2); !bytes.Equal(b, []byte{1, rfbVeNCrypt}) {
		t.Fatalf("security types %v", b)
	}
	c.Write([]byte{rfbVeNCrypt})
	read(2)
	c.Write([]byte{0, 2})
	if b := read(6); !bytes.Equal(b, []byte{0, 1, 0, 0, 1, 0}) {
		t.Fatalf("VeNCrypt subtypes %v", b)
	}
	msg := binary.BigEndian.AppendUint32(nil, vencryptPlain)
	msg = binary.BigEndian.AppendUint32(msg, uint32(len(user)))
	msg = binary.BigEndian.AppendUint32(msg, uint32(len(password)))
	c.Write(append(append(msg, user...), password...))
	if binary.BigEndian.Uint32(read(4)) == 0 {
		return ""
	}
	return string(read(int(binary.BigEndian.Uint32(read(4)))))
}

func newVNCServer(t *testing.T, pin string) *server {
	g := newUsersFile(t, pin)
	g.vncAddr = fakeXvncNone(t, 1)
	g.failures, g.pending = map[string][]time.Time{}, map[string]int{}
	return g
}

// startBridge runs bridgeVNC on one end of a pipe and returns the other.
func startBridge(g *server) (net.Conn, chan struct{}) {
	client, server := net.Pipe()
	done := make(chan struct{})
	go func() {
		g.bridgeVNC(server, "192.0.2.1", "")
		server.Close()
		close(done)
	}()
	return client, done
}

func TestVNCLogin(t *testing.T) {
	g := newVNCServer(t, "s3cret")
	c, _ := startBridge(g)
	if reason := noVNCLogin(t, c, "alice", "s3cret"+code(0)); reason != "" {
		t.Fatalf("login: %q", reason)
	}
	// Then the session reaches Xvnc: the fake echoes.
	c.Write([]byte("ClientInit"))
	got := make([]byte, 10)
	if _, err := io.ReadFull(c, got); err != nil || string(got) != "ClientInit" {
		t.Fatalf("after the login: %q %v", got, err)
	}
	c.Close()

	for _, tc := range []struct{ user, password string }{
		{"alice", "s3cret" + code(0)}, // used already
		{"bob", "s3cret" + code(1)},
		{"alice", code(1)},
		{"alice", "wrong" + code(1)},
	} {
		c, done := startBridge(g)
		if reason := noVNCLogin(t, c, tc.user, tc.password); !strings.Contains(reason, "wrong") {
			t.Errorf("%s/%s: %q", tc.user, tc.password, reason)
		}
		c.Close()
		<-done
	}
	if n := len(g.failures["192.0.2.1"]); n != 4 {
		t.Errorf("%d failures counted, want 4", n)
	}
	// With the limit reached, the next connection is turned away before it
	// can try.
	g.mu.Lock()
	for range maxFailures {
		g.failures["192.0.2.1"] = append(g.failures["192.0.2.1"], time.Now())
	}
	g.mu.Unlock()
	c, done := startBridge(g)
	defer c.Close()
	c.SetDeadline(time.Now().Add(5 * time.Second))
	io.ReadFull(c, make([]byte, 12))
	c.Write([]byte(rfbVersion))
	b, _ := io.ReadAll(c)
	if len(b) < 5 || b[0] != 0 || !strings.Contains(string(b), "Too many") {
		t.Errorf("over the limit: %q", b)
	}
	<-done
}

func TestVNCLoginBadHandshake(t *testing.T) {
	g := newVNCServer(t, "-")
	for name, steps := range map[string][][]byte{
		"RFB 3.3":       {[]byte("RFB 003.003\n")},
		"VNC auth type": {[]byte(rfbVersion), {2}},
		"TLS subtype":   {[]byte(rfbVersion), {rfbVeNCrypt}, {0, 2}, {0, 0, 1, 3}},
		"huge password": {[]byte(rfbVersion), {rfbVeNCrypt}, {0, 2}, {0, 0, 1, 0}, {0, 0, 0, 5, 0, 1, 0, 0}},
	} {
		c, done := startBridge(g)
		c.SetDeadline(time.Now().Add(5 * time.Second))
		go io.Copy(io.Discard, c)
		for _, s := range steps {
			c.Write(s)
		}
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Errorf("%s: still open", name)
		}
		c.Close()
	}
	if n := len(g.failures["192.0.2.1"]); n != 0 {
		t.Errorf("%d failures counted for broken handshakes", n)
	}
}

func TestVNCLoginXvncWantsLogin(t *testing.T) {
	g := newVNCServer(t, "-")
	g.vncAddr = fakeXvncNone(t, 19) // Plain only, as Xvnc used to be set up
	c, _ := startBridge(g)
	defer c.Close()
	if reason := noVNCLogin(t, c, "alice", code(0)); !strings.Contains(reason, "isn't running") {
		t.Errorf("reason %q", reason)
	}
}

// With -e2e auto, a request over HTTPS (here, said so by a trusted proxy)
// gets the plain pages, and one over HTTP gets the tunnel.
func TestE2EAuto(t *testing.T) {
	g, srv := newE2EServer(t)
	g.e2e, g.e2eAuto = false, true
	var err error
	if g.trustedProxies, err = parsePrefixes("127.0.0.1"); err != nil {
		t.Fatal(err)
	}
	get := func(path string, header ...string) (int, string) {
		t.Helper()
		req, _ := http.NewRequest("GET", srv.URL+path, nil)
		for i := 0; i < len(header); i += 2 {
			req.Header.Set(header[i], header[i+1])
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b)
	}
	https := []string{"X-Forwarded-Proto", "https"}
	if _, body := get("/tabtop/e2e.js"); !strings.Contains(body, "enabled = true") {
		t.Errorf("e2e.js over HTTP: %q", body)
	}
	if _, body := get("/tabtop/e2e.js", https...); !strings.Contains(body, "enabled = false") {
		t.Errorf("e2e.js over HTTPS: %q", body)
	}
	if status, body := get("/downloads/", https...); status != http.StatusUnauthorized || !strings.Contains(body, `name="password"`) {
		t.Errorf("downloads over HTTPS: %d", status)
	}
	if status, body := get("/downloads/"); status != http.StatusOK || strings.Contains(body, `name="password"`) {
		t.Errorf("downloads over HTTP: %d", status)
	}
	if status, _ := get("/tunnel"); status == http.StatusNotFound {
		t.Error("no tunnel over HTTP")
	}
	if status, _ := get("/tunnel", https...); status != http.StatusNotFound {
		t.Errorf("tunnel over HTTPS: %d", status)
	}
	if status, _ := get("/websockify"); status != http.StatusNotFound {
		t.Errorf("websockify over HTTP: %d", status)
	}

	// A tunnel's session id, which a watcher on the HTTP network can read,
	// doesn't work as a cookie over HTTPS.
	s := login(t, testCtx(t), srv.URL, code(0))
	if status, _ := get("/downloads/", append(https, "Cookie", cookieName+"="+s.id)...); status != http.StatusUnauthorized {
		t.Errorf("tunnel session as a cookie: %d", status)
	}
	if status, _ := get("/tty/", append(https, "Cookie", cookieName+"="+s.id)...); status != http.StatusUnauthorized {
		t.Errorf("tunnel session as a terminal cookie: %d", status)
	}
}
