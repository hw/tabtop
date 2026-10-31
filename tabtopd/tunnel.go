package main

// The encrypted tunnel, which carries everything private: a WebSocket at
// /tunnel whose messages are encrypted between the page's JavaScript
// (tunnel.js) and tabtopd, so a proxy that terminates TLS in between, and
// logs or inspects what passes through, sees neither logins nor content. It
// doesn't stop a proxy that rewrites traffic: that one can serve different
// JavaScript.
//
// There are two kinds of tunnel, told apart by the browser's first
// message. Every handshake message is one binary WebSocket message.
//
// A login tunnel turns the credential (PIN + TOTP code) into a session,
// with CPace (cpace.go), so the credential never crosses the wire:
//
//	browser: 3, 1, sid (16), Ya (32)       Ya = X25519(a, generator(credential, sid))
//	server:  3, Yb1, Yb2, Yb3 (32 each)    one per code the browser may hold
//	browser: tag1, tag2, tag3 (32 each)    key confirmation for each
//	server:  3, server tag (32)            for the one that matched, then
//	         {"ok":true,"session":id,"secret":...} encrypted with its keys
//
// The keys for candidate i are HKDF-SHA256 of its CPace ISK, info
// "tabtop login v3 keys", 128 bytes: from the browser, from the server,
// browser tag, server tag. The browser confirms first, so a wrong guess
// learns nothing before it counts as a failed login. A wrong credential
// ends the tunnel with closeLoginFailed.
//
// A session tunnel carries everything else; the session's random secret,
// which the login tunnel delivered, authenticates both sides:
//
//	browser: 3, 2, ephemeral X25519 key (32), session id
//	server:  3, ephemeral X25519 key (32)
//
// and both compute HKDF-SHA256(secret X25519(ephemerals) || session
// secret, salt SHA-256("tabtop tunnel v3" || browser key || server key ||
// session id), info "tabtop session keys", 64 bytes): from the browser,
// then from the server. The fresh X25519 keys mean a leaked session secret
// doesn't decrypt tunnels recorded earlier. An unknown or expired session
// ends the tunnel with closeLogin.
//
// After either handshake, every message is one binary WebSocket message:
// ChaCha20-Poly1305 with each direction's key and a 12-byte nonce of 4
// zero bytes and a big-endian message counter from 0. The plaintext starts
// with a type byte, 0 for data (terminal bytes, RFB, files, audio packets)
// or 1 for text (JSON), so the tunnel carries the same binary and text
// messages a WebSocket would. A message that fails to decrypt ends the
// tunnel. A session tunnel's first message from the browser is a JSON
// request (tunnelRequest) and the server's first is the reply:
// {"ok":true,...}, or {"error":...} followed by the end of the tunnel.
//
// A file request's data comes with flow control: the browser sends an
// empty data message for each chunk it has used, and the server sends at
// most fileWindow chunks ahead of those. An upload request's goes the
// other way: the server acknowledges each chunk once it's written, then
// sends {"name":...} once it has the whole file (see tunnelUpload).

import (
	"context"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"log"
	"net"
	"sync"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/crypto/chacha20poly1305"
)

const (
	tunnelVersion  = 3
	helloLogin     = 1
	helloSession   = 2
	tunnelLabel    = "tabtop tunnel v3"
	tunnelTimeout  = 30 * time.Second // for each handshake step and the request
	tunnelOverhead = 1 + chacha20poly1305.Overhead
	// Read limits: the handshakes' messages are small, the largest being
	// the login tags (32 bytes per candidate code); then a session tunnel's
	// request. Only the desktop and the terminal take more after that, up to
	// maxClientMessage (a pasted clipboard).
	tunnelHelloLimit   = 256
	tunnelRequestLimit = 64<<10 + tunnelOverhead
	msgData            = 0
	msgText            = 1

	// Close codes the page acts on; the reason is shown to the user.
	closeLogin        websocket.StatusCode = 4001 // no such session: log in
	closeLoginFailed  websocket.StatusCode = 4003
	closeLoginRefused websocket.StatusCode = 4029 // too many failed logins
)

var errTunnelFrame = errors.New("tunnel: bad message")

// pingInterval is how often an open tunnel is pinged, so proxies that close
// idle WebSockets don't close an idle desktop or terminal: Cloudflare after
// about 100 seconds, nginx after 60 by default.
const pingInterval = 30 * time.Second

// keepalive pings c every interval until ctx ends. A ping without a pong
// isn't an error: the pong is only seen while something reads c, and the
// ping has already done its job by being sent.
func keepalive(ctx context.Context, c *websocket.Conn, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			pctx, cancel := context.WithTimeout(ctx, interval)
			c.Ping(pctx)
			cancel()
		}
	}
}

func tunnelNonce(n uint64) []byte {
	nonce := make([]byte, chacha20poly1305.NonceSize)
	binary.BigEndian.PutUint64(nonce[4:], n)
	return nonce
}

// tunnel is one encrypted WebSocket. Its methods match *websocket.Conn's
// (see msgConn), so handlers serve either the same way. One goroutine may
// read while others write.
type tunnel struct {
	c          *websocket.Conn
	recv, send cipher.AEAD
	recvN      uint64

	wmu   sync.Mutex
	sendN uint64
}

func newTunnel(c *websocket.Conn, fromClient, fromServer []byte) (*tunnel, error) {
	recv, err := chacha20poly1305.New(fromClient)
	if err != nil {
		return nil, err
	}
	send, err := chacha20poly1305.New(fromServer)
	if err != nil {
		return nil, err
	}
	return &tunnel{c: c, recv: recv, send: send}, nil
}

// loginKeys derives a CPace candidate's keys: from the browser, from the
// server, the browser's tag and the server's tag, 32 bytes each.
func loginKeys(sid, k, ya, yb []byte) []byte {
	keys, err := hkdf.Key(sha256.New, cpaceISK(sid, k, ya, yb), nil, "tabtop login v3 keys", 128)
	if err != nil {
		panic(err) // only for lengths HKDF can't produce
	}
	return keys
}

// sessionKeys derives a session tunnel's keys: from the browser, then from
// the server.
func sessionKeys(ee, secret, clientEph, serverEph []byte, id string) []byte {
	salt := sha256Sum([]byte(tunnelLabel), clientEph, serverEph, []byte(id))
	keys, err := hkdf.Key(sha256.New, append(append([]byte{}, ee...), secret...), salt, "tabtop session keys", 64)
	if err != nil {
		panic(err)
	}
	return keys
}

// loginTunnel runs the server's side of a login tunnel. hello is the
// browser's first message after its version and kind bytes.
func (g *server) loginTunnel(c *websocket.Conn, ip string, hello []byte) {
	if len(hello) != cpaceSID+32 {
		c.Close(websocket.StatusPolicyViolation, "bad hello")
		return
	}
	sid, ya := hello[:cpaceSID], hello[cpaceSID:]
	// The attempt is reserved now, so parallel tunnels can't buy extra
	// guesses. It only counts as a failure once the browser has committed
	// to its tags.
	if !g.beginLogin(ip) {
		log.Printf("login from %s refused: too many failed logins", ip)
		c.Close(closeLoginRefused, "Too many failed attempts. Try again in a few minutes.")
		return
	}
	// settle records the result before the tunnel is closed, since the
	// close waits for the browser's reply.
	settled := false
	settle := func(failed bool) {
		if !settled {
			settled = true
			g.endLogin(ip, failed)
		}
	}
	defer settle(false)

	// The CPace work takes one of the slots for checking logins, twice:
	// now, and once the tags arrive, but not while waiting for them.
	busy := func() bool {
		if startLoginWork() {
			return false
		}
		log.Printf("login from %s refused: %s", ip, loginBusy)
		c.Close(websocket.StatusTryAgainLater, loginBusyMsg)
		return true
	}
	if busy() {
		return
	}
	e, err := readOathEntry(g.usersFile)
	if err != nil {
		endLoginWork()
		log.Printf("reading the TOTP users file: %v", err)
		c.Close(websocket.StatusInternalError, "Logins can't be checked.")
		return
	}
	type candidate struct {
		prs   string
		yb, k []byte // k is nil if Ya is a low-order point
	}
	var cands []candidate
	reply := []byte{tunnelVersion}
	for _, prs := range e.candidates(time.Now()) {
		y, yb, err := cpaceShare(cpaceGenerator(prs, sid))
		if err != nil {
			endLoginWork()
			log.Printf("login exchange: %v", err)
			c.Close(websocket.StatusInternalError, "Logins can't be checked.")
			return
		}
		k, _ := x25519(y, ya)
		cands = append(cands, candidate{prs, yb, k})
		reply = append(reply, yb...)
	}
	endLoginWork()
	ctx, cancel := context.WithTimeout(context.Background(), tunnelTimeout)
	defer cancel()
	if c.Write(ctx, websocket.MessageBinary, reply) != nil {
		return
	}
	typ, tags, err := c.Read(ctx)
	if err != nil {
		return // abandoned before guessing: not a failure
	}
	if typ != websocket.MessageBinary || len(tags) != 32*len(cands) {
		settle(true)
		c.Close(websocket.StatusPolicyViolation, "bad message")
		return
	}
	if busy() {
		return // not checked, so not a failure
	}
	match, keys := -1, []byte(nil)
	for i, cand := range cands {
		if cand.k == nil {
			continue
		}
		ks := loginKeys(sid, cand.k, ya, cand.yb)
		if hmac.Equal(tags[32*i:32*i+32], ks[64:96]) && match < 0 {
			match, keys = i, ks
		}
	}
	// liboath checks the matched code against the shared record of used
	// codes, as for every other login, and records it.
	if match >= 0 {
		prs := cands[match].prs
		err = oathAuthenticate(g.usersFile, e.user, prs[:len(prs)-e.digits], prs[len(prs)-e.digits:])
		if oe, ok := err.(oathError); err != nil && !(ok && oe.rejected()) {
			log.Printf("checking TOTP code: %v", err)
		}
	}
	endLoginWork()
	if match < 0 || err != nil {
		settle(true)
		log.Printf("login from %s failed", ip)
		c.Close(closeLoginFailed, "Those credentials are wrong, expired or already used.")
		return
	}
	settle(false)
	log.Printf("login from %s succeeded", ip)
	id, secret := g.newE2ESession()
	if c.Write(ctx, websocket.MessageBinary, append([]byte{tunnelVersion}, keys[96:]...)) != nil {
		return
	}
	t, err := newTunnel(c, keys[:32], keys[32:64])
	if err != nil {
		return
	}
	writeJSON(t, map[string]any{"ok": true, "session": id, "secret": base64.StdEncoding.EncodeToString(secret)})
	t.Close(websocket.StatusNormalClosure, "")
}

// sessionTunnel runs the server's side of a session tunnel's handshake and
// returns the tunnel and its session, or nil once it has ended it.
func (g *server) sessionTunnel(c *websocket.Conn, hello []byte) (*tunnel, string) {
	if len(hello) <= 32 {
		c.Close(websocket.StatusPolicyViolation, "bad hello")
		return nil, ""
	}
	clientEph, id := hello[:32], string(hello[32:])
	secret, ok := g.sessionSecret(id)
	if len(id) != sessionIDLen || !ok {
		c.Close(closeLogin, "Log in first.")
		return nil, ""
	}
	eph, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		c.Close(websocket.StatusInternalError, "")
		return nil, ""
	}
	// Fails on a low-order key, whose result would be all zeros.
	ee, err := x25519(eph, clientEph)
	if err != nil {
		c.Close(websocket.StatusPolicyViolation, "bad hello")
		return nil, ""
	}
	serverEph := eph.PublicKey().Bytes()
	keys := sessionKeys(ee, secret, clientEph, serverEph, id)
	ctx, cancel := context.WithTimeout(context.Background(), tunnelTimeout)
	defer cancel()
	if c.Write(ctx, websocket.MessageBinary, append([]byte{tunnelVersion}, serverEph...)) != nil {
		return nil, ""
	}
	t, err := newTunnel(c, keys[:32], keys[32:])
	if err != nil {
		c.Close(websocket.StatusInternalError, "")
		return nil, ""
	}
	c.SetReadLimit(tunnelRequestLimit)
	return t, id
}

// Read returns the next message: data as MessageBinary, text as MessageText.
func (t *tunnel) Read(ctx context.Context) (websocket.MessageType, []byte, error) {
	typ, ct, err := t.c.Read(ctx)
	if err != nil {
		return 0, nil, err
	}
	if typ != websocket.MessageBinary {
		t.c.Close(websocket.StatusPolicyViolation, "unencrypted message")
		return 0, nil, errTunnelFrame
	}
	pt, err := t.recv.Open(ct[:0], tunnelNonce(t.recvN), ct, nil)
	if err != nil || len(pt) == 0 || pt[0] > msgText {
		t.c.Close(websocket.StatusPolicyViolation, "bad message")
		return 0, nil, errTunnelFrame
	}
	t.recvN++
	if pt[0] == msgText {
		return websocket.MessageText, pt[1:], nil
	}
	return websocket.MessageBinary, pt[1:], nil
}

func (t *tunnel) Write(ctx context.Context, typ websocket.MessageType, p []byte) error {
	kind := byte(msgData)
	if typ == websocket.MessageText {
		kind = msgText
	}
	pt := make([]byte, 0, len(p)+tunnelOverhead)
	pt = append(append(pt, kind), p...)
	t.wmu.Lock()
	defer t.wmu.Unlock()
	ct := t.send.Seal(pt[:0], tunnelNonce(t.sendN), pt, nil)
	t.sendN++
	return t.c.Write(ctx, websocket.MessageBinary, ct)
}

// The close reason isn't encrypted; it's only ever a fixed message.
func (t *tunnel) Close(code websocket.StatusCode, reason string) error {
	return t.c.Close(code, reason)
}

func (t *tunnel) CloseNow() error { return t.c.CloseNow() }

// CloseRead reads and discards messages until the client goes, like
// websocket.Conn's, for a tunnel that only sends.
func (t *tunnel) CloseRead(ctx context.Context) context.Context {
	ctx, cancel := context.WithCancel(ctx)
	go func() {
		defer cancel()
		for {
			if _, _, err := t.Read(ctx); err != nil {
				t.CloseNow()
				return
			}
		}
	}()
	return ctx
}

// msgConn is a WebSocket, or a tunnel carrying the same messages encrypted.
type msgConn interface {
	Read(ctx context.Context) (websocket.MessageType, []byte, error)
	Write(ctx context.Context, typ websocket.MessageType, p []byte) error
	Close(code websocket.StatusCode, reason string) error
	CloseNow() error
	CloseRead(ctx context.Context) context.Context
}

// tunnelConn is a tunnel's data messages as a byte stream, for the RFB
// bridge. Text messages from the client are ignored.
type tunnelConn struct {
	t    *tunnel
	buf  []byte
	dmu  sync.Mutex
	rdl  time.Time
	wdl  time.Time
	once sync.Once
}

func (c *tunnelConn) ctx(deadline time.Time) (context.Context, context.CancelFunc) {
	if deadline.IsZero() {
		return context.WithCancel(context.Background())
	}
	return context.WithDeadline(context.Background(), deadline)
}

func (c *tunnelConn) Read(p []byte) (int, error) {
	for len(c.buf) == 0 {
		c.dmu.Lock()
		ctx, cancel := c.ctx(c.rdl)
		c.dmu.Unlock()
		typ, data, err := c.t.Read(ctx)
		cancel()
		if err != nil {
			return 0, err
		}
		if typ == websocket.MessageBinary {
			c.buf = data
		}
	}
	n := copy(p, c.buf)
	c.buf = c.buf[n:]
	return n, nil
}

func (c *tunnelConn) Write(p []byte) (int, error) {
	c.dmu.Lock()
	ctx, cancel := c.ctx(c.wdl)
	c.dmu.Unlock()
	defer cancel()
	if err := c.t.Write(ctx, websocket.MessageBinary, p); err != nil {
		return 0, err
	}
	return len(p), nil
}

func (c *tunnelConn) Close() error {
	c.once.Do(func() { c.t.Close(websocket.StatusNormalClosure, "") })
	return nil
}

func (c *tunnelConn) LocalAddr() net.Addr  { return tunnelAddr{} }
func (c *tunnelConn) RemoteAddr() net.Addr { return tunnelAddr{} }

func (c *tunnelConn) SetDeadline(t time.Time) error {
	c.dmu.Lock()
	defer c.dmu.Unlock()
	c.rdl, c.wdl = t, t
	return nil
}

func (c *tunnelConn) SetReadDeadline(t time.Time) error {
	c.dmu.Lock()
	defer c.dmu.Unlock()
	c.rdl = t
	return nil
}

func (c *tunnelConn) SetWriteDeadline(t time.Time) error {
	c.dmu.Lock()
	defer c.dmu.Unlock()
	c.wdl = t
	return nil
}

type tunnelAddr struct{}

func (tunnelAddr) Network() string { return "tunnel" }
func (tunnelAddr) String() string  { return "tunnel" }
