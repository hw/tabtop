package main

// The passkey tunnel, and the requests that add, list and remove passkeys
// (see passkey.go).

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
)

// passkeyTunnel runs the server's side of a passkey tunnel, from ip, by
// browser. hello is the browser's first message after its version and
// kind bytes: its ephemeral X25519 key. handshaken gives back the slot
// the tunnel's handshake holds, once it's waiting for the browser, which
// has a bound of its own.
func (g *server) passkeyTunnel(c *websocket.Conn, ip, browser string, hello []byte, handshaken func()) {
	if len(hello) != 32 {
		c.Close(websocket.StatusPolicyViolation, "bad hello")
		return
	}
	// Waiting for the browser, and someone at it, isn't a login being
	// checked, so holds none of the login limit's slots (which a few
	// tunnels left waiting would fill, locking out every login from the
	// address): waits have their own bound, and the login's checked, and
	// counted, once an assertion comes.
	if g.lockedOut(ip) {
		log.Printf("passkey login from %s refused: too many failed logins", ip)
		c.Close(closeLoginRefused, "Too many failed attempts. Try again in a few minutes.")
		return
	}
	stopWaiting, ok := g.passkeyWaits.startUpTo(limitKey(ip), passkeyWaits, passkeyWaitsPerIP)
	if !ok {
		c.Close(websocket.StatusTryAgainLater, "Too many passkey logins are waiting to be answered. Try again in a minute.")
		return
	}
	defer stopWaiting()
	eph, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		c.Close(websocket.StatusInternalError, "")
		return
	}
	ya := hello
	ee, err := x25519(eph, ya)
	if err != nil {
		c.Close(websocket.StatusPolicyViolation, "bad hello")
		return
	}
	yb := eph.PublicKey().Bytes()
	nonce := make([]byte, 32)
	rand.Read(nonce)
	keys := passkeyKeys(ee, ya, yb, nonce)
	challenge := passkeyTunnelChallenge(ya, yb, nonce)
	ctx, cancel := context.WithTimeout(context.Background(), handshakeTimeout)
	defer cancel()
	if c.Write(ctx, websocket.MessageBinary, append(append([]byte{tunnelVersion}, yb...), nonce...)) != nil {
		return
	}
	t, err := newTunnel(c, keys[:32], keys[32:])
	if err != nil {
		c.Close(websocket.StatusInternalError, "")
		return
	}
	// Time for the browser to ask, and someone to answer it.
	handshaken()
	c.SetReadLimit(passkeyAssertionLimit + tunnelOverhead)
	wait, done := context.WithTimeout(context.Background(), passkeyWait)
	defer done()
	typ, msg, err := t.Read(wait)
	if err != nil {
		return // given up on, or timed out: not a failed login
	}
	stopWaiting()
	// With none added, or none that can be read, it's refused as one
	// that isn't added is: checked, counted and answered the same, so
	// whether the owner has any isn't told to whoever asks. (The
	// Passkeys section, once logged in, says if their file can't be read.)
	if !g.beginLogin(ip) {
		c.Close(closeLoginRefused, "Too many failed attempts. Try again in a few minutes.")
		return
	}
	settled := false
	settle := func(failed bool) {
		if !settled {
			settled = true
			g.endLogin(ip, browser+", with a passkey", failed)
		}
	}
	defer settle(false)
	if !g.loginTurn() {
		c.Close(websocket.StatusTryAgainLater, "Many logins have failed here lately, so they're being slowed down. Try again in a few seconds.")
		return
	}
	var a passkeyAssertion
	if typ != websocket.MessageText || json.Unmarshal(msg, &a) != nil {
		settle(true)
		c.Close(websocket.StatusPolicyViolation, "bad message")
		return
	}
	name, err := g.passkeys.verifyLogin(a, challenge, time.Now())
	if err != nil {
		settle(true)
		log.Printf("passkey login from %s failed: %v", ip, err)
		g.activity.failedLogin(ip, browser+", with a passkey")
		c.Close(closeLoginFailed, errPasskeyUnknown)
		return
	}
	settle(false)
	log.Printf("login from %s succeeded, with the passkey %q", ip, name)
	g.activity.add("login", ip, "logged in with the passkey %q%s", name, withBrowser(browser))
	id, secret, history := g.newSession(ip, browser+", with a passkey")
	write, stop := context.WithTimeout(context.Background(), handshakeTimeout)
	defer stop()
	b, _ := json.Marshal(map[string]any{"ok": true, "session": id, "secret": base64.StdEncoding.EncodeToString(secret),
		"ip": ip, "logins": history, "expires": g.sessionExpiry(id).UnixMilli()})
	if t.Write(write, websocket.MessageText, b) == nil {
		t.Close(websocket.StatusNormalClosure, "")
	}
}

// errPasskeyUnknown is a passkey login's refusal: the same whether any
// are added here or not.
const errPasskeyUnknown = "That passkey can't log in here: it isn't one added here, or it couldn't be checked."

// passkeyWaits and passkeyWaitsPerIP bound the passkey tunnels waiting
// for an assertion (see server.passkeyWaits): in all, and from one
// address as limitKey has it.
const (
	passkeyWaits      = 256
	passkeyWaitsPerIP = 3
)

// routePasskeys lists the passkeys added.
func (g *server) routePasskeys(c *tunnelCall) {
	if err := g.passkeys.unreadable(); err != nil {
		c.r.fail(err.Error())
		return
	}
	c.r.finish(map[string]any{"passkeys": g.passkeys.list(), "max": passkeyMax})
}

// routePasskeyOptions gives this session a challenge to add a passkey with,
// and what the page needs to ask the browser for one, if req.Code is the
// password + code: given again, and counted as a login, right or wrong.
// Checked before the browser makes the passkey, so a wrong code doesn't
// leave one on the device that can't log in here.
func (g *server) routePasskeyOptions(c *tunnelCall) {
	browser := ""
	if c.t.req != nil {
		browser = browserName(c.t.req.Header.Get("User-Agent"))
	}
	// Before the code's checked, which uses it up: not for nothing.
	if err := g.passkeys.room(); err != nil {
		c.r.fail(err.Error())
		return
	}
	if err := g.checkCode(c.ip, browser+", adding a passkey", c.req.Code); err != nil {
		c.r.fail(err.Error())
		return
	}
	opts, err := g.passkeys.challengeFor(c.session, time.Now())
	if err != nil {
		c.r.fail(err.Error())
		return
	}
	c.r.finish(opts)
}

// routePasskeyAdd adds the passkey req.Passkey, named req.Name, made for
// this session's challenge (which only the password + code got).
func (g *server) routePasskeyAdd(c *tunnelCall) {
	name, ok := passkeyName(c.req.Name)
	if !ok || c.req.Passkey == nil {
		c.r.fail("A passkey's name is one line of at most 50 characters.")
		return
	}
	now := time.Now()
	challenge := g.passkeys.takeChallenge(c.session, now)
	if challenge == nil {
		c.r.fail("That took too long: try adding it again.")
		return
	}
	k, err := verifyRegistration(*c.req.Passkey, challenge, name, now)
	if err != nil {
		c.r.fail(err.Error())
		return
	}
	// Made for the site the page is on: the origin the browser gave the
	// tunnel (which the WebSocket's own check has matched to its host), or
	// with none, the host it asked for.
	if c.t.req == nil || !madeHere(k, c.t.req) {
		c.r.fail("That passkey was made for another site than this one.")
		return
	}
	if err := g.passkeys.add(k); err != nil {
		c.r.fail(err.Error())
		return
	}
	log.Printf("passkey %q added from %s, for %s", name, c.ip, k.RPID)
	g.act(c.session, "passkey", c.ip, "added the passkey %q", name)
	c.r.finish(map[string]any{"id": k.ID, "name": name})
}

// routePasskeyRemove removes the passkey req.Name, if req.Code is the
// password + code, given again as for adding one: a session alone, taken
// over, can't take away the owner's passkeys.
func (g *server) routePasskeyRemove(c *tunnelCall) {
	browser := ""
	if c.t.req != nil {
		browser = browserName(c.t.req.Header.Get("User-Agent"))
	}
	if !g.passkeys.has(c.req.Name) {
		c.r.fail("That passkey is gone already.") // not using up a code for it
		return
	}
	if err := g.checkCode(c.ip, browser+", removing a passkey", c.req.Code); err != nil {
		c.r.fail(err.Error())
		return
	}
	name, err := g.passkeys.remove(c.req.Name)
	if err != nil {
		c.r.fail(err.Error())
		return
	}
	log.Printf("passkey %q removed from %s", name, c.ip)
	g.act(c.session, "passkey", c.ip, "removed the passkey %q", name)
	c.r.finish(nil)
}

// checkCode checks code, the password + authenticator code, as a login
// does: limited as logins are, counted as one, the code used up.
func (g *server) checkCode(ip, browser, code string) error {
	if !g.beginLogin(ip) {
		return errTooManyLogins
	}
	failed := true
	defer func() { g.endLogin(ip, browser, failed) }()
	if !g.loginTurn() || !startLoginWork() {
		failed = false // not checked
		return errLoginsBusy
	}
	defer endLoginWork()
	e, err := readOathEntry(g.usersFile)
	if err != nil {
		failed = false
		log.Printf("reading the TOTP users file: %v", err)
		return errLoginsBusy
	}
	if len(code) < e.digits {
		log.Printf("password and code from %s, for a passkey, too short", ip)
		g.activity.failedLogin(ip, browser)
		return errWrongCode
	}
	if err := oathAuthenticate(g.usersFile, e.user, code[:len(code)-e.digits], code[len(code)-e.digits:]); err != nil {
		if oe, ok := err.(oathError); !ok || !oe.rejected() {
			// Not the code, but checking it, that failed: not counted.
			log.Printf("checking TOTP code: %v", err)
			failed = false
			return errLoginsBusy
		}
		log.Printf("password and code from %s, to add a passkey, wrong", ip)
		g.activity.failedLogin(ip, browser)
		return errWrongCode
	}
	failed = false
	return nil
}

var (
	errTooManyLogins = &loginRefusal{"Too many failed attempts. Try again in a few minutes."}
	errLoginsBusy    = &loginRefusal{"Logins can't be checked just now. Try again in a few seconds."}
	errWrongCode     = &loginRefusal{"That password and code are wrong, expired or already used. A code that's just logged in can't be used again: wait for the next one."}
)

type loginRefusal struct{ msg string }

func (e *loginRefusal) Error() string { return e.msg }

// madeHere reports whether k was made for the site r came to: its origin
// the one r gives, or, with none, its name r's host's.
func madeHere(k *passkey, r *http.Request) bool {
	if o := r.Header.Get("Origin"); o != "" {
		return k.Origin == o
	}
	host := r.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	return host != "" && strings.EqualFold(k.RPID, host)
}
