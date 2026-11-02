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
	"testing"
	"time"
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
			g := &server{vncCAFile: ca, vncServerName: name}
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
		g := &server{vncX509: true, vncUsername: "alice", vncCAFile: ca, vncServerName: "example.com"}
		conn, err := g.vncSecurity(client, page, password)
		if reject {
			if !errors.Is(err, errVNCPasswordRejected) {
				t.Fatalf("password rejection: %v", err)
			}
		} else {
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
