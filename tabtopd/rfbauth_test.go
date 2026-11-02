package main

import (
	"bytes"
	"crypto/des"
	"crypto/tls"
	"encoding/binary"
	"encoding/pem"
	"errors"
	"io"
	"net"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestX509VNC(t *testing.T) {
	fixture := httptest.NewTLSServer(nil)
	defer fixture.Close()
	ca := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: fixture.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"example.com", "wrong.example", "untrusted"} {
		t.Run(name, func(t *testing.T) {
			client, upstream := net.Pipe()
			defer client.Close()
			client.SetDeadline(time.Now().Add(3 * time.Second))
			go func() {
				defer upstream.Close()
				upstream.SetDeadline(time.Now().Add(3 * time.Second))
				upstream.Write([]byte{0, 2})
				var version [2]byte
				io.ReadFull(upstream, version[:])
				upstream.Write(binary.BigEndian.AppendUint32([]byte{0, 1}, 261))
				var subtype uint32
				binary.Read(upstream, binary.BigEndian, &subtype)
				if version != [2]byte{0, 2} || subtype != 261 {
					return
				}
				upstream.Write([]byte{1})
				secure := tls.Server(upstream, fixture.TLS)
				if secure.Handshake() != nil {
					return
				}
				challenge := []byte("0123456789abcdef")
				secure.Write(challenge)
				response := make([]byte, 16)
				io.ReadFull(secure, response)
				if !bytes.Equal(response, vncAuthWant("password", challenge)) {
					return
				}
				secure.Write([]byte("init"))
			}()
			if err := negotiateX509VNC(client); err != nil {
				t.Fatal(err)
			}
			g := &server{serverConfig: serverConfig{vncCAFile: ca, vncServerName: name}}
			if name == "untrusted" {
				g.vncCAFile, g.vncServerName = "", "example.com"
			}
			cfg, err := g.vncTLSConfig()
			if err != nil {
				t.Fatal(err)
			}
			secure := tls.Client(client, cfg)
			err = secure.Handshake()
			if name != "example.com" {
				if err == nil {
					t.Fatal("accepted incorrect hostname")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			challenge := make([]byte, 16)
			if _, err := io.ReadFull(secure, challenge); err != nil {
				t.Fatal(err)
			}
			secure.Write(vncAuthResponse("password", challenge))
			var init [4]byte
			if _, err := io.ReadFull(secure, init[:]); err != nil || string(init[:]) != "init" {
				t.Fatalf("TLS relay: %q, %v", init, err)
			}
		})
	}
}

func TestX509PlainLogin(t *testing.T) {
	fixture := httptest.NewTLSServer(nil)
	defer fixture.Close()
	ca := filepath.Join(t.TempDir(), "ca.pem")
	os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: fixture.Certificate().Raw}), 0600)
	for _, reject := range []bool{false, true} {
		client, upstream := net.Pipe()
		page, browser := net.Pipe()
		defer client.Close()
		defer page.Close()
		defer browser.Close()
		password := "full-password-beyond-eight-bytes"
		errs := make(chan error, 1)
		go func() {
			defer upstream.Close()
			upstream.SetDeadline(time.Now().Add(3 * time.Second))
			upstream.Write(rfbVersionMsg(8))
			if _, err := rfbVersion(upstream); err != nil {
				errs <- err
				return
			}
			upstream.Write([]byte{1, 19})
			var choice [1]byte
			io.ReadFull(upstream, choice[:])
			upstream.Write([]byte{0, 2})
			var version [2]byte
			io.ReadFull(upstream, version[:])
			upstream.Write(binary.BigEndian.AppendUint32([]byte{0, 1}, 262))
			var subtype uint32
			binary.Read(upstream, binary.BigEndian, &subtype)
			if subtype != 262 {
				errs <- errors.New("wrong subtype")
				return
			}
			upstream.Write([]byte{1})
			secure := tls.Server(upstream, fixture.TLS)
			var ulen, plen uint32
			if err := binary.Read(secure, binary.BigEndian, &ulen); err != nil {
				errs <- err
				return
			}
			binary.Read(secure, binary.BigEndian, &plen)
			if ulen != uint32(len("alice")) || plen != uint32(len(password)) {
				errs <- errors.New("credential lengths")
				return
			}
			credentials := make([]byte, int(ulen+plen))
			io.ReadFull(secure, credentials)
			if string(credentials) != "alice"+password {
				errs <- errors.New("credentials truncated")
				return
			}
			if reject {
				secure.Write([]byte{0, 0, 0, 1, 0, 0, 0, 0})
				errs <- nil
				return
			}
			secure.Write([]byte{0, 0, 0, 0})
			io.ReadFull(secure, choice[:])
			secure.Write([]byte("init"))
			errs <- nil
		}()
		if !reject {
			go fakeNoVNC(browser)
		}
		g := &server{serverConfig: serverConfig{vncX509: true, vncUsername: "alice", vncCAFile: ca, vncServerName: "example.com"}}
		result, err := g.vncSecurity(client, page, password)
		conn := result.conn
		if reject {
			if result.outcome != vncPasswordRejected {
				t.Fatal("password rejection lost from result")
			}
			if !errors.Is(err, errVNCPasswordRejected) {
				t.Fatalf("password rejection: %v", err)
			}
		} else {
			if result.outcome != vncAuthenticated {
				t.Fatal("successful authentication lost from result")
			}
			if err != nil {
				t.Fatal(err)
			}
			var init [1]byte
			io.ReadFull(page, init[:])
			conn.Write(init[:])
			var data [4]byte
			if _, err := io.ReadFull(conn, data[:]); err != nil || string(data[:]) != "init" {
				t.Fatalf("relay %q: %v", data, err)
			}
		}
		conn.Close()
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
}

// vncAuthWant computes a VNC Authentication response its own way: each
// key byte's bits reversed one at a time.
func vncAuthWant(password string, challenge []byte) []byte {
	key := make([]byte, 8)
	copy(key, password)
	for i, b := range key {
		var r byte
		for j := range 8 {
			if b&(1<<j) != 0 {
				r |= 0x80 >> j
			}
		}
		key[i] = r
	}
	c, _ := des.NewCipher(key)
	out := make([]byte, 16)
	c.Encrypt(out[:8], challenge[:8])
	c.Encrypt(out[8:], challenge[8:])
	return out
}

// fakeRFB is a VNC server's handshake on c: version 3.minor, then the
// security types it offers (for 3.3, the one it picks), a VNC
// Authentication challenge if it's chosen, checked against password, then
// a ServerInit stand-in, "init". It reports what went wrong, if anything.
func fakeRFB(c net.Conn, minor int, types []byte, password string) error {
	defer c.Close()
	c.Write(rfbVersionMsg(minor))
	got, err := rfbVersion(c)
	if err != nil || got != minor {
		return errors.New("client version")
	}
	choice := types[0]
	if minor == 3 {
		c.Write(binary.BigEndian.AppendUint32(nil, uint32(choice)))
	} else {
		c.Write(append([]byte{byte(len(types))}, types...))
		if !bytes.ContainsAny(types, "\x01\x02") {
			return nil // the client hands it to noVNC
		}
		var b [1]byte
		if _, err := io.ReadFull(c, b[:]); err != nil {
			return err
		}
		choice = b[0]
	}
	switch choice {
	case rfbSecNone:
		if minor >= 8 {
			c.Write([]byte{0, 0, 0, 0})
		}
	case rfbSecVNCAuth:
		challenge := []byte("0123456789abcdef")
		c.Write(challenge)
		resp := make([]byte, 16)
		if _, err := io.ReadFull(c, resp); err != nil {
			return err
		}
		if !bytes.Equal(resp, vncAuthWant(password, challenge)) {
			c.Write([]byte{0, 0, 0, 1})
			if minor >= 8 {
				c.Write(append([]byte{0, 0, 0, 14}, "Authentication"...))
			}
			return nil
		}
		c.Write([]byte{0, 0, 0, 0})
	default:
		return nil // the client handles it
	}
	// ClientInit, then ServerInit.
	var shared [1]byte
	if _, err := io.ReadFull(c, shared[:]); err != nil {
		return err
	}
	c.Write([]byte("init"))
	return nil
}

func TestRFBLogin(t *testing.T) {
	for _, tc := range []struct {
		name   string
		minor  int
		types  []byte
		done   bool
		replay []byte
		err    error
	}{
		{"3.8 VNC Authentication", 8, []byte{rfbSecVNCAuth}, true, nil, nil},
		{"3.7 VNC Authentication", 7, []byte{16, rfbSecVNCAuth}, true, nil, nil},
		{"3.3 VNC Authentication", 3, []byte{rfbSecVNCAuth}, true, nil, nil},
		{"3.8 None preferred", 8, []byte{rfbSecVNCAuth, rfbSecNone}, true, nil, nil},
		{"3.3 None", 3, []byte{rfbSecNone}, true, nil, nil},
		{"3.8 VeNCrypt only", 8, []byte{19}, false, []byte{1, 19}, nil},
		{"3.3 other", 3, []byte{30}, false, []byte{0, 0, 0, 30}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client, server := net.Pipe()
			defer client.Close()
			errc := make(chan error, 1)
			go func() { errc <- fakeRFB(server, tc.minor, tc.types, "s3cret-and-more") }()
			done, minor, replay, err := rfbLogin(client, "s3cret-and-more") // only the first 8 count
			if done != tc.done || minor != tc.minor || !bytes.Equal(replay, tc.replay) || err != nil {
				t.Fatalf("rfbLogin = %v, 3.%d, %v, %v", done, minor, replay, err)
			}
			if done {
				client.Write([]byte{1})
				init := make([]byte, 4)
				if _, err := io.ReadFull(client, init); err != nil || string(init) != "init" {
					t.Fatalf("after the handshake: %q, %v", init, err)
				}
			}
			client.Close()
			if err := <-errc; err != nil {
				t.Fatal(err)
			}
		})
	}

	for _, minor := range []int{8, 3} {
		client, server := net.Pipe()
		go fakeRFB(server, minor, []byte{rfbSecVNCAuth}, "right")
		if _, _, _, err := rfbLogin(client, "wrong"); !errors.Is(err, errVNCPasswordRejected) {
			t.Errorf("3.%d, wrong password: %v", minor, err)
		}
		client.Close()
	}
}

// fakeNoVNC is noVNC's side of a handshake offered None: it answers the
// version, picks None, reads the result, and sends ClientInit.
func fakeNoVNC(c net.Conn) ([]byte, error) {
	minor, err := rfbVersion(c)
	if err != nil {
		return nil, err
	}
	c.Write(rfbVersionMsg(minor))
	var n [1]byte
	io.ReadFull(c, n[:])
	types := make([]byte, n[0])
	io.ReadFull(c, types)
	if !bytes.Equal(types, []byte{rfbSecNone}) {
		return types, nil
	}
	c.Write([]byte{rfbSecNone})
	res := make([]byte, 4)
	if _, err := io.ReadFull(c, res); err != nil {
		return nil, err
	}
	c.Write([]byte{1})
	return types, nil
}

func TestRFBOfferNoneAndReplay(t *testing.T) {
	page, novnc := net.Pipe()
	defer page.Close()
	got := make(chan []byte, 1)
	go func() { types, _ := fakeNoVNC(novnc); got <- types }()
	if err := rfbOfferNone(page); err != nil {
		t.Fatal(err)
	}
	var clientInit [1]byte
	io.ReadFull(page, clientInit[:])
	if types := <-got; !bytes.Equal(types, []byte{rfbSecNone}) || clientInit[0] != 1 {
		t.Errorf("noVNC was offered %v, sent ClientInit %v", types, clientInit)
	}

	// Replayed: noVNC sees the server's own security types.
	page, novnc = net.Pipe()
	defer page.Close()
	go func() { types, _ := fakeNoVNC(novnc); got <- types }()
	if err := rfbReplay(page, 8, []byte{2, 19, 30}); err != nil {
		t.Fatal(err)
	}
	if types := <-got; !bytes.Equal(types, []byte{19, 30}) {
		t.Errorf("replayed %v, want [19 30]", types)
	}
}

// TestTunnelDesktopPassword logs in to a VNC server with the password
// for it (-vnc-password-file), through the tunnel, and noVNC sees no
// security; with a server that turns it down, or without a password for it,
// noVNC gets the server's own handshake. The login's password is never
// given to it.
func TestTunnelDesktopPassword(t *testing.T) {
	for _, tc := range []struct {
		name, vncPassword, serverPassword string
		want                              []byte // the security types noVNC is offered
	}{
		{"accepted", "vnc-pw", "vnc-pw", []byte{rfbSecNone}},
		{"rejected", "vnc-pw", "other", []byte{rfbSecVNCAuth}},
		{"none for it", "", "s3cret", []byte{rfbSecVNCAuth}}, // the login's password isn't tried
	} {
		t.Run(tc.name, func(t *testing.T) {
			g, srv := newE2EServerPin(t, "s3cret")
			if tc.vncPassword != "" {
				g.vncPasswordFile = filepath.Join(t.TempDir(), "vnc-password")
				os.WriteFile(g.vncPasswordFile, []byte(tc.vncPassword), 0o600)
			}
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
					go fakeRFB(c, 8, []byte{rfbSecVNCAuth}, tc.serverPassword)
				}
			}()
			g.vncAddr = l.Addr().String()
			ctx := testCtx(t)
			tc2 := openSession(t, ctx, srv.URL, login(t, ctx, srv.URL, "s3cret"+code(0)))
			if reply := tc2.request(t, ctx, tunnelRequest{Type: "vnc"}); reply["ok"] != true {
				t.Fatalf("vnc: %v", reply)
			}
			var in bytes.Buffer
			read := func(n int) []byte {
				t.Helper()
				for in.Len() < n {
					_, p, err := tc2.read(ctx)
					if err != nil {
						t.Fatalf("reading: %v", err)
					}
					in.Write(p)
				}
				return in.Next(n)
			}
			if v := read(12); string(v) != "RFB 003.008\n" {
				t.Fatalf("version %q", v)
			}
			tc2.write(ctx, msgData, []byte("RFB 003.008\n"))
			n := read(1)
			if types := read(int(n[0])); !bytes.Equal(types, tc.want) {
				t.Fatalf("noVNC offered %v, want %v", types, tc.want)
			}
			if tc.want[0] != rfbSecNone {
				if tc.name == "rejected" && g.vncBackoff.waiting() <= 0 {
					t.Fatal("password rejection cleared cooldown")
				}
				return
			}
			tc2.write(ctx, msgData, []byte{rfbSecNone})
			if res := read(4); !bytes.Equal(res, []byte{0, 0, 0, 0}) {
				t.Fatalf("SecurityResult %v", res)
			}
			tc2.write(ctx, msgData, []byte{1})
			if init := read(4); string(init) != "init" {
				t.Fatalf("ServerInit %q", init)
			}
		})
	}
}

func TestVNCBackoff(t *testing.T) {
	var b vncBackoff
	if b.waiting() > 0 {
		t.Fatal("waiting before any failure")
	}
	for _, want := range []time.Duration{30 * time.Second, time.Minute, 2 * time.Minute, 4 * time.Minute, 8 * time.Minute, 10 * time.Minute, 10 * time.Minute} {
		if got := b.failed(); got != want {
			t.Errorf("after a failure: %v, want %v", got, want)
		}
	}
	if b.waiting() <= 9*time.Minute {
		t.Errorf("waiting %v after the cap", b.waiting())
	}
	b.succeeded()
	if b.waiting() > 0 || b.failed() != vncBackoffMin {
		t.Error("not reset by a login that worked")
	}
}

// TestVNCBackoffTurns lets one login handshake run at a time: the others
// wait for it, rather than being refused or running alongside, and then see
// the cooldown its failure set.
func TestVNCBackoffTurns(t *testing.T) {
	var b vncBackoff
	if b.begin() {
		t.Fatal("cooling down before any failure")
	}
	var running, most atomic.Int32
	results := make(chan bool, 8)
	for range 8 {
		go func() {
			cooling := b.begin()
			if n := running.Add(1); n > most.Load() {
				most.Store(n)
			}
			running.Add(-1)
			b.release()
			results <- cooling
		}()
	}
	time.Sleep(50 * time.Millisecond)
	b.failed() // the first's login failed
	b.release()
	for range 8 {
		if !<-results {
			t.Error("a waiting handshake didn't see the cooldown")
		}
	}
	if most.Load() != 1 {
		t.Errorf("%d handshakes ran at once, want 1", most.Load())
	}
	b.succeeded()
	if b.begin() {
		t.Error("still cooling down after a login that worked")
	}
	b.release()
}

// TestTunnelDesktopBackoff stops logging in to the VNC server once that
// has failed: under VNC_X509 the desktop is refused without trying the
// server; without it, the gateway stays out of the handshake, so noVNC gets
// the server's own and asks for its password.
func TestTunnelDesktopBackoff(t *testing.T) {
	for _, x509 := range []bool{true, false} {
		t.Run(map[bool]string{true: "X509", false: "plain"}[x509], func(t *testing.T) {
			g, srv := newE2EServer(t)
			l, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer l.Close()
			var accepted, logins atomic.Int32
			go func() {
				for {
					c, err := l.Accept()
					if err != nil {
						return
					}
					accepted.Add(1)
					go func() {
						defer c.Close()
						// Refuses the connection, with a reason, once it's
						// been sent a version: a login attempt.
						c.Write(rfbVersionMsg(8))
						if _, err := io.ReadFull(c, make([]byte, 12)); err == nil {
							logins.Add(1)
							c.Write(append([]byte{0, 0, 0, 0, 7}, "go away"...))
						}
					}()
				}
			}()
			g.vncAddr = l.Addr().String()
			g.vncX509 = x509
			g.vncPasswordFile = filepath.Join(t.TempDir(), "vnc-password")
			os.WriteFile(g.vncPasswordFile, []byte("pw"), 0o600)
			ctx := testCtx(t)
			s := login(t, ctx, srv.URL, code(0))
			for i := range 2 {
				tc := openSession(t, ctx, srv.URL, s)
				if reply := tc.request(t, ctx, tunnelRequest{Type: "vnc"}); reply["ok"] != true {
					t.Fatalf("vnc %d: %v", i+1, reply)
				}
				_, p, err := tc.read(ctx)
				switch {
				case i == 0:
				case x509 && websocket.CloseStatus(err) != websocket.StatusTryAgainLater:
					t.Errorf("second desktop: %q, %v; want to try again later", p, err)
				case !x509 && string(p) != "RFB 003.008\n":
					t.Errorf("second desktop got %q, %v; want the server's own greeting", p, err)
				}
				tc.c.CloseNow()
			}
			want := int32(1) // only the first
			if !x509 {
				want = 2 // then passed through
			}
			if n := accepted.Load(); n != want {
				t.Errorf("the VNC server was connected to %d times, want %d", n, want)
			}
			if n := logins.Load(); n != 1 {
				t.Errorf("the gateway logged in %d times, want once", n)
			}
			if g.vncBackoff.waiting() <= 0 {
				t.Error("not backing off")
			}
		})
	}
}

// TestBeginVeNCryptRefusal reports a server's refusal, as TigerVNC sends
// in RFB 3.3 to an address it has blacklisted, by its reason, and a server
// that only speaks 3.3 as one that has no VeNCrypt.
func TestBeginVeNCryptRefusal(t *testing.T) {
	for _, tc := range []struct {
		name  string
		reply []byte
		want  string
	}{
		{"refused", append([]byte{0, 0, 0, 0, 0, 0, 0, 26}, "Too many security failures"...), "refused the connection: Too many security failures"},
		{"3.3 only", []byte{0, 0, 0, 2}, "speaks RFB 3.3"},
	} {
		client, server := net.Pipe()
		go func() {
			defer server.Close()
			server.Write(rfbVersionMsg(3))
			io.ReadFull(server, make([]byte, 12))
			server.Write(tc.reply)
		}()
		_, err := beginVeNCrypt(client)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: %v, want %q", tc.name, err, tc.want)
		}
		client.Close()
	}
}

// TestVNCLoginCheck reports how the gateway's last login to the VNC server
// went, rather than logging in for the report.
func TestVNCLoginCheck(t *testing.T) {
	g := &server{}
	g.vncX509 = true
	ok := check{OK: true, Detail: "listening at VNC_ADDR"}
	if c := g.vncLoginCheck(ok); !c.OK || !strings.Contains(c.Detail, "no desktop has logged in") {
		t.Errorf("before any login: %+v", c)
	}
	g.vncBackoff.record(nil)
	if c := g.vncLoginCheck(ok); !c.OK || !strings.Contains(c.Detail, "with VeNCrypt X509Vnc with a verified certificate") {
		t.Errorf("after a login: %+v", c)
	}
	g.vncBackoff.record(errors.New("tls: bad certificate"))
	if c := g.vncLoginCheck(ok); c.OK || !strings.Contains(c.Detail, "failed: tls: bad certificate") {
		t.Errorf("after a failure: %+v", c)
	}
	g.vncX509 = false // noVNC logs in itself
	if c := g.vncLoginCheck(ok); c != ok {
		t.Errorf("without a password for it: %+v", c)
	}
}

// TestTunnelDesktopPageGone doesn't count a page that closes part way
// through the handshake, after the gateway has logged in, as a failed
// login: it starts no cooldown.
func TestTunnelDesktopPageGone(t *testing.T) {
	g, srv := newE2EServerPin(t, "s3cret")
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
			go fakeRFB(c, 8, []byte{rfbSecVNCAuth}, "vnc-pw")
		}
	}()
	g.vncAddr = l.Addr().String()
	g.vncPasswordFile = filepath.Join(t.TempDir(), "vnc-password")
	os.WriteFile(g.vncPasswordFile, []byte("vnc-pw"), 0o600)
	ctx := testCtx(t)
	tc := openSession(t, ctx, srv.URL, login(t, ctx, srv.URL, "s3cret"+code(0)))
	if reply := tc.request(t, ctx, tunnelRequest{Type: "vnc"}); reply["ok"] != true {
		t.Fatalf("vnc: %v", reply)
	}
	tc.read(ctx) // the version offered to noVNC
	tc.c.CloseNow()
	for end := time.Now().Add(2 * time.Second); time.Now().Before(end); time.Sleep(20 * time.Millisecond) {
		if at, _ := g.vncBackoff.last(); !at.IsZero() {
			break
		}
	}
	time.Sleep(100 * time.Millisecond)
	if left := g.vncBackoff.waiting(); left > 0 {
		t.Errorf("cooling down for %v after the page went", left)
	}
	if at, err := g.vncBackoff.last(); at.IsZero() || err != nil {
		t.Errorf("last login: %v, %v; want one that worked", at, err)
	}
}
