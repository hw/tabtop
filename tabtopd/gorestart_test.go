package main

import (
	"encoding/base64"
	"fmt"
	"strings"
	"testing"
)

// TestGoRestartConfirmed: restarting the engine only with the password +
// code given again (a wrong one counted as a failed login), or a passkey's
// assertion for the session's own challenge, used once.
func TestGoRestartConfirmed(t *testing.T) {
	g, srv := newE2EServer(t)
	g.goOn, g.goMode = true, goUnsandboxed // (no tabs: none restarted)
	ctx := testCtx(t)
	srv.URL = strings.Replace(srv.URL, "127.0.0.1", "localhost", 1) // a name, as passkeys need
	s := login(t, ctx, srv.URL, code(-1))
	req := func(r tunnelRequest) map[string]any { return openSession(t, ctx, srv.URL, s).request(t, ctx, r) }

	if r := req(tunnelRequest{Type: "go-restart"}); r["ok"] == true {
		t.Fatalf("restarted with nothing given: %v", r)
	}
	before := failureCount(g)
	if r := req(tunnelRequest{Type: "go-restart", Code: "000000"}); r["ok"] == true || failureCount(g) != before+1 {
		t.Fatalf("a wrong code: %v, %d failures", r, failureCount(g)-before)
	}
	if r := req(tunnelRequest{Type: "go-restart", Code: code(0)}); r["ok"] != true {
		t.Fatalf("the right code: %v", r)
	}

	// No passkey yet: no challenge.
	if r := req(tunnelRequest{Type: "go-restart-challenge"}); r["ok"] == true {
		t.Fatalf("a challenge with no passkeys: %v", r)
	}
	a := newAuthenticator(t, coseES256, "http://localhost")
	opts := req(tunnelRequest{Type: "passkey-options", Code: code(1)})
	challenge, _ := unb64(opts["challenge"].(string))
	user, _ := unb64(opts["user_id"].(string))
	reg := a.register(challenge)
	if r := req(tunnelRequest{Type: "passkey-add", Name: "Laptop", Passkey: &reg}); r["ok"] != true {
		t.Fatalf("add: %v", r)
	}
	assertion := func(key *authenticator) passkeyAssertion {
		r := req(tunnelRequest{Type: "go-restart-challenge"})
		c, err := unb64(r["challenge"].(string))
		if err != nil || len(c) != 32 {
			t.Fatalf("challenge: %v", r)
		}
		return key.assert(c, user)
	}
	as := assertion(a)
	if r := req(tunnelRequest{Type: "go-restart", Assertion: &as}); r["ok"] != true {
		t.Fatalf("with the passkey: %v", r)
	}
	if r := req(tunnelRequest{Type: "go-restart", Assertion: &as}); r["ok"] == true {
		t.Fatalf("its challenge used again: %v", r)
	}
	before = failureCount(g)
	other := assertion(newAuthenticator(t, coseES256, "http://localhost"))
	if r := req(tunnelRequest{Type: "go-restart", Assertion: &other}); r["ok"] == true || failureCount(g) != before+1 {
		t.Fatalf("an unknown key: %v, %d failures", r, failureCount(g)-before)
	}
	// A challenge is the session's: another's assertion for it isn't taken.
	// (The second session logged in with the passkey: the codes the
	// server takes now are used up.)
	// The assertion's made after that login, so it's the newest the key's
	// made: refused for whose challenge it is, not as an old one.
	reply, status := passkeyLogin(t, ctx, srv.URL, a, user)
	secret, err := base64.StdEncoding.DecodeString(fmt.Sprint(reply["secret"]))
	if status != 0 || err != nil {
		t.Fatalf("a second session: %v %v", reply, status)
	}
	s2 := testSession{id: fmt.Sprint(reply["session"]), secret: secret}
	mine := assertion(a)
	if r := openSession(t, ctx, srv.URL, s2).request(t, ctx, tunnelRequest{Type: "go-restart", Assertion: &mine}); r["ok"] == true {
		t.Fatalf("another session's challenge taken: %v", r)
	}
	// Still good for its own session.
	if r := req(tunnelRequest{Type: "go-restart", Assertion: &mine}); r["ok"] != true {
		t.Fatalf("its own session's, after: %v", r)
	}
}
