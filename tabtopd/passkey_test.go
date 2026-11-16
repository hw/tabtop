package main

import (
	"context"
	"crypto"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/crypto/chacha20poly1305"
)

// authenticator is a software one, for tests: one key, on one site.
type authenticator struct {
	id     []byte
	signer crypto.Signer
	alg    int
	origin string
	count  uint32
	flags  byte
}

func newAuthenticator(t *testing.T, alg int, origin string) *authenticator {
	t.Helper()
	var signer crypto.Signer
	switch alg {
	case coseES256:
		signer, _ = ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	case coseEdDSA:
		_, signer, _ = ed25519.GenerateKey(rand.Reader)
	case coseRS256:
		signer, _ = rsa.GenerateKey(rand.Reader, 2048)
	}
	id := make([]byte, 20)
	rand.Read(id)
	return &authenticator{id: id, signer: signer, alg: alg, origin: origin, flags: authFlagUP | authFlagUV}
}

func (a *authenticator) rpHash() []byte {
	rp, _ := rpIDOf(a.origin)
	h := sha256.Sum256([]byte(rp))
	return h[:]
}

func (a *authenticator) clientData(typ string, challenge []byte) []byte {
	b, _ := json.Marshal(map[string]any{"type": typ, "challenge": b64url.EncodeToString(challenge), "origin": a.origin, "crossOrigin": false})
	return b
}

// register makes what the page sends to add the key, for challenge.
func (a *authenticator) register(challenge []byte) passkeyRegistration {
	ad := append(a.rpHash(), a.flags|authFlagAT, 0, 0, 0, 0)
	ad = append(ad, make([]byte, 16)...) // AAGUID
	ad = binary.BigEndian.AppendUint16(ad, uint16(len(a.id)))
	ad = append(ad, a.id...)
	ad = append(ad, 0xa0) // its COSE key, which isn't read
	der, _ := x509.MarshalPKIXPublicKey(a.signer.Public())
	return passkeyRegistration{ID: b64url.EncodeToString(a.id), PublicKey: b64url.EncodeToString(der), Alg: a.alg,
		AuthenticatorData: b64url.EncodeToString(ad), ClientData: b64url.EncodeToString(a.clientData("webauthn.create", challenge))}
}

// assert signs challenge, as logging in does, for the account user.
func (a *authenticator) assert(challenge, user []byte) passkeyAssertion {
	if a.count > 0 {
		a.count++
	}
	ad := binary.BigEndian.AppendUint32(append(a.rpHash(), a.flags), a.count)
	cd := a.clientData("webauthn.get", challenge)
	h := sha256.Sum256(cd)
	signed := append(append([]byte{}, ad...), h[:]...)
	var sig []byte
	if a.alg == coseEdDSA {
		sig, _ = a.signer.Sign(rand.Reader, signed, crypto.Hash(0))
	} else {
		d := sha256.Sum256(signed)
		sig, _ = a.signer.Sign(rand.Reader, d[:], crypto.SHA256)
	}
	return passkeyAssertion{ID: b64url.EncodeToString(a.id), AuthenticatorData: b64url.EncodeToString(ad),
		ClientData: b64url.EncodeToString(cd), Signature: b64url.EncodeToString(sig), UserHandle: b64url.EncodeToString(user)}
}

func TestPasskeyVerification(t *testing.T) {
	now := time.Now()
	challenge := []byte("0123456789abcdef0123456789abcdef")
	user := []byte("0123456789abcdef")
	for _, alg := range []int{coseES256, coseEdDSA, coseRS256} {
		a := newAuthenticator(t, alg, "https://tabtop.example")
		k, err := verifyRegistration(a.register(challenge), challenge, "Laptop", now)
		if err != nil || k.RPID != "tabtop.example" || k.Origin != "https://tabtop.example" {
			t.Fatalf("alg %d: %v %+v", alg, err, k)
		}
		login := []byte("another challenge, for a login..")
		if _, err := k.verifyAssertion(a.assert(login, user), login, user); err != nil {
			t.Fatalf("alg %d login: %v", alg, err)
		}
		// Made for one handshake, it's no good for another.
		if _, err := k.verifyAssertion(a.assert(login, user), challenge, user); err == nil {
			t.Fatalf("alg %d: replayed", alg)
		}
	}

	a := newAuthenticator(t, coseES256, "https://tabtop.example")
	refused := func(what string, reg passkeyRegistration, c []byte) {
		t.Helper()
		if _, err := verifyRegistration(reg, c, "x", now); err == nil {
			t.Errorf("registration %s: accepted", what)
		}
	}
	refused("for another challenge", a.register(challenge), []byte("another challenge, not that one.."))
	on := func(origin string) passkeyRegistration { b := *a; b.origin = origin; return b.register(challenge) }
	refused("over HTTP", on("http://tabtop.example"), challenge)
	refused("on an IP address", on("https://192.0.2.1"), challenge)
	unverified := *a
	unverified.flags = authFlagUP
	refused("without user verification", unverified.register(challenge), challenge)
	other := a.register(challenge)
	other.ID = b64url.EncodeToString([]byte("another credential"))
	refused("for another credential", other, challenge)
	wrongType := a.register(challenge)
	wrongType.ClientData = b64url.EncodeToString(a.clientData("webauthn.get", challenge))
	refused("of the wrong type", wrongType, challenge)
	if _, err := verifyRegistration(on("http://localhost:6080"), challenge, "x", now); err != nil {
		t.Errorf("on localhost: %v", err)
	}

	k, _ := verifyRegistration(a.register(challenge), challenge, "Key", now)
	// Used on another site than it was added on.
	elsewhere := *a
	elsewhere.origin = "https://other.example"
	if _, err := k.verifyAssertion(elsewhere.assert(challenge, user), challenge, user); err == nil {
		t.Error("used on another site")
	}
	if _, err := k.verifyAssertion(unverified.assert(challenge, user), challenge, user); err == nil {
		t.Error("used without user verification")
	}
	if _, err := k.verifyAssertion(a.assert(challenge, []byte("someone else....")), challenge, user); err == nil {
		t.Error("for another account")
	}
	// A counter: going up is fine; going back, refused; 0 throughout (as
	// synced passkeys), fine.
	a.count = 5
	got, err := k.verifyAssertion(a.assert(challenge, user), challenge, user)
	if err != nil || got != 6 {
		t.Fatalf("counter: %d %v", got, err)
	}
	k.SignCount = got
	a.count = 3
	if _, err := k.verifyAssertion(a.assert(challenge, user), challenge, user); err == nil {
		t.Error("counter went back")
	}
	// Now 0, as one that's stopped counting: let in.
	a.count = 0
	if _, err := k.verifyAssertion(a.assert(challenge, user), challenge, user); err != nil {
		t.Errorf("counter now 0: %v", err)
	}
}

// passkeyLogin logs in with a over a tunnel to srvURL, returning the reply
// or how it was closed.
func passkeyLogin(t *testing.T, ctx context.Context, srvURL string, a *authenticator, user []byte) (map[string]any, websocket.StatusCode) {
	t.Helper()
	c := dialWS(t, ctx, wsURL(srvURL))
	defer c.CloseNow()
	eph, _ := ecdh.X25519().GenerateKey(rand.Reader)
	ya := eph.PublicKey().Bytes()
	c.Write(ctx, websocket.MessageBinary, append([]byte{tunnelVersion, helloPasskey}, ya...))
	_, hello, err := c.Read(ctx)
	if err != nil {
		return nil, websocket.CloseStatus(err)
	}
	if len(hello) != 65 || hello[0] != tunnelVersion {
		t.Fatalf("server hello %x", hello)
	}
	yb, nonce := hello[1:33], hello[33:]
	ee, _ := x25519(eph, yb)
	keys := passkeyKeys(ee, ya, yb, nonce)
	send, _ := chacha20poly1305.New(keys[:32])
	recv, _ := chacha20poly1305.New(keys[32:])
	tc := &tunnelClient{c: c, send: send, recv: recv}
	b, _ := json.Marshal(a.assert(passkeyTunnelChallenge(ya, yb, nonce), user))
	if err := tc.write(ctx, msgText, b); err != nil {
		t.Fatal(err)
	}
	_, reply, err := tc.read(ctx)
	if err != nil {
		return nil, websocket.CloseStatus(err)
	}
	var m map[string]any
	json.Unmarshal(reply, &m)
	return m, 0
}

func TestPasskeyAddAndLogin(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	// At a name, as passkeys need: what they're made for is checked
	// against it.
	srv.URL = strings.Replace(srv.URL, "127.0.0.1", "localhost", 1)
	// None yet: refused as an unknown one is, and counted the same.
	a := newAuthenticator(t, coseES256, "http://localhost")
	if _, status := passkeyLogin(t, ctx, srv.URL, a, nil); status != closeLoginFailed || failureCount(g) != 1 {
		t.Fatalf("with none added: %v, %d failures", status, failureCount(g))
	}
	s := login(t, ctx, srv.URL, code(-1))
	req := func(r tunnelRequest) map[string]any { return openSession(t, ctx, srv.URL, s).request(t, ctx, r) }
	// Not without the password + code again: no challenge.
	if r := req(tunnelRequest{Type: "passkey-options", Code: "000000"}); r["ok"] == true || failureCount(g) != 2 {
		t.Fatalf("a challenge for a wrong code: %v, %d failures", r, failureCount(g))
	}
	opts := req(tunnelRequest{Type: "passkey-options", Code: code(0)})
	challenge, _ := unb64(opts["challenge"].(string))
	user, _ := unb64(opts["user_id"].(string))
	reg := a.register(challenge)
	if r := req(tunnelRequest{Type: "passkey-add", Name: "Laptop", Passkey: &reg}); r["ok"] != true {
		t.Fatalf("add: %v", r)
	}
	// The challenge is used up.
	if r := req(tunnelRequest{Type: "passkey-add", Name: "Again", Passkey: &reg}); r["ok"] == true {
		t.Fatalf("added again with a used challenge: %v", r)
	}
	list := req(tunnelRequest{Type: "passkeys"})
	if keys, _ := list["passkeys"].([]any); len(keys) != 1 || keys[0].(map[string]any)["name"] != "Laptop" {
		t.Fatalf("passkeys: %v", list)
	}

	// Logging in with it.
	reply, status := passkeyLogin(t, ctx, srv.URL, a, user)
	if status != 0 || reply["ok"] != true || reply["session"] == nil {
		t.Fatalf("passkey login: %v %v", reply, status)
	}
	// Another key: a failure, counted.
	before := failureCount(g)
	if _, status := passkeyLogin(t, ctx, srv.URL, newAuthenticator(t, coseES256, "http://localhost"), user); status != closeLoginFailed || failureCount(g) != before+1 {
		t.Fatalf("an unknown key: %v, %d failures", status, failureCount(g))
	}
	// Removed, it logs in no more.
	id := list["passkeys"].([]any)[0].(map[string]any)["id"].(string)
	if r := req(tunnelRequest{Type: "passkey-remove", Name: id}); r["ok"] == true {
		t.Fatalf("removed without the password + code: %v", r)
	}
	if r := req(tunnelRequest{Type: "passkey-remove", Name: id, Code: code(1)}); r["ok"] != true {
		t.Fatalf("remove: %v", r)
	}
	if _, status := passkeyLogin(t, ctx, srv.URL, a, user); status != closeLoginFailed {
		t.Fatalf("a removed key: %v", status)
	}
}

// Kept across a restart; a file that can't be read is left alone.
func TestPasskeyStoreFile(t *testing.T) {
	file := t.TempDir() + "/passkeys.json"
	s := newPasskeyStore(file)
	a := newAuthenticator(t, coseES256, "https://tabtop.example")
	c, _ := s.challengeFor("session", time.Now())
	ch, _ := unb64(c["challenge"].(string))
	k, err := verifyRegistration(a.register(ch), ch, "Phone", time.Now())
	if err != nil || s.add(k) != nil {
		t.Fatal(err)
	}
	again := newPasskeyStore(file)
	if len(again.list()) != 1 || string(again.userID) != string(s.userID) {
		t.Fatalf("after a restart: %v", again.list())
	}
	writeFileAtomic(file, []byte("{broken"))
	broken := newPasskeyStore(file)
	if _, err := broken.challengeFor("session", time.Now()); err == nil || broken.add(k) == nil {
		t.Fatal("added to a file that couldn't be read")
	}
}

// Passkey logins waiting for an answer hold no login attempts, so can't
// lock an address out; their own bound turns more away.
func TestPasskeyWaitsDontLockOut(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	a := newAuthenticator(t, coseES256, "http://localhost")
	c, _ := g.passkeys.challengeFor("x", time.Now())
	ch, _ := unb64(c["challenge"].(string))
	k, err := verifyRegistration(a.register(ch), ch, "Key", time.Now())
	if err != nil || g.passkeys.add(k) != nil {
		t.Fatal(err)
	}
	wait := func() (*websocket.Conn, websocket.StatusCode) {
		c := dialWS(t, ctx, wsURL(srv.URL))
		eph, _ := ecdh.X25519().GenerateKey(rand.Reader)
		c.Write(ctx, websocket.MessageBinary, append([]byte{tunnelVersion, helloPasskey}, eph.PublicKey().Bytes()...))
		if _, _, err := c.Read(ctx); err != nil {
			c.CloseNow()
			return nil, websocket.CloseStatus(err)
		}
		return c, 0
	}
	for range passkeyWaitsPerIP {
		c, status := wait()
		if c == nil {
			t.Fatalf("a wait refused: %v", status)
		}
		defer c.CloseNow()
	}
	if c, status := wait(); c != nil || status != websocket.StatusTryAgainLater {
		t.Fatalf("one wait too many: %v", status)
	}
	// Logging in otherwise still works.
	login(t, ctx, srv.URL, code(0))
	if failureCount(g) != 0 {
		t.Fatalf("%d failures", failureCount(g))
	}
}

// A passkeys file that can't be read says so, rather than that there are
// none.
func TestPasskeysFileUnreadable(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	file := t.TempDir() + "/passkeys.json"
	writeFileAtomic(file, []byte("{broken"))
	g.passkeys = newPasskeyStore(file)
	_, status := passkeyLogin(t, ctx, srv.URL, newAuthenticator(t, coseES256, "http://localhost"), nil)
	if status != closeLoginFailed {
		t.Fatalf("login: %v", status)
	}
	s := login(t, ctx, srv.URL, code(0))
	if r := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "passkeys"}); r["error"] != errPasskeysBroken.Error() {
		t.Fatalf("list: %v", r)
	}
}

// A passkey's added only for the site the page is on.
func TestPasskeyMadeHere(t *testing.T) {
	k := &passkey{Origin: "https://tabtop.example", RPID: "tabtop.example"}
	req := func(host, origin string) *http.Request {
		r := httptest.NewRequest("GET", "/", nil)
		r.Host = host
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		return r
	}
	for _, c := range []struct {
		host, origin string
		ok           bool
	}{
		{"tabtop.example", "https://tabtop.example", true},
		{"tabtop.example:443", "", true},
		{"tabtop.example", "https://evil.example", false},
		{"evil.example", "", false},
		{"", "", false},
	} {
		if got := madeHere(k, req(c.host, c.origin)); got != c.ok {
			t.Errorf("%q %q: %v", c.host, c.origin, got)
		}
	}
}
