package main

// Restarting the remote browser's engine (Settings, go/settings: the
// go-restart request): every tab's engine ended, each tab told first, so
// it connects again by itself, with a new engine, loading the page it
// showed (go.js). For an engine that's hung, or misbehaving: what's kept
// (cookies, sites' storage, the shared cache, settings) is the server's,
// not an engine's.
//
// Only on the person's own say-so, given again: the password +
// authenticator code (checkCode, counted as a login is), or a passkey (a
// challenge of its own for the session, go-restart-challenge; its
// assertion checked as a passkey login's is, and limited as logins are),
// so a session someone else got hold of can't restart it.

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"log"
	"time"
)

// goRestartTold is how long a tab's loop is given to tell its page the
// engine's restarting: one that's hung isn't waited for.
const goRestartTold = 2 * time.Second

// routeGoRestartChallenge gives the session a challenge to confirm a
// restart with a passkey.
func (g *server) routeGoRestartChallenge(c *tunnelCall) {
	if g.passkeys.count() == 0 {
		c.r.fail("No passkey has been added here: give your password + authenticator code instead.")
		return
	}
	challenge, err := g.passkeys.confirmChallenge(c.session, time.Now())
	if err != nil {
		c.r.fail(err.Error())
		return
	}
	c.r.finish(map[string]any{"challenge": base64.RawURLEncoding.EncodeToString(challenge)})
}

// routeGoRestart restarts every tab's engine, if the person confirms it:
// Code, the password + code, or Assertion, a passkey's, for the session's
// challenge.
func (g *server) routeGoRestart(c *tunnelCall) {
	if !g.goOn || g.goMode == goUnavailable {
		c.r.fail("The remote browser is turned off or unavailable.")
		return
	}
	if err := g.confirmed(c, "restarting the remote browser's engine"); err != nil {
		c.r.fail(err.Error())
		return
	}
	// Every tab, private ones too, whose cookies and storage are kept for
	// them to come back to a while (goincognito.go).
	tabs := g.goTabList().browsers()
	g.goPrivates.keepAWhile()
	done := make(chan struct{})
	for _, b := range tabs {
		go func() {
			b.restartEngine("restarted from Settings")
			done <- struct{}{}
		}()
	}
	for range tabs {
		<-done
	}
	log.Printf("go: engine restarted from %s (%d tabs)", c.ip, len(tabs))
	g.act(c.session, "go", c.ip, "restarted the remote browser's engine (%d tab%s)", len(tabs), plural(len(tabs)))
	c.r.finish(map[string]any{"tabs": len(tabs)})
}

// confirmed checks the person's say-so for what: a passkey's assertion
// for the session's challenge, or else the password + code.
func (g *server) confirmed(c *tunnelCall, what string) error {
	browser := ""
	if c.t.req != nil {
		browser = browserName(c.t.req.Header.Get("User-Agent"))
	}
	if c.req.Assertion == nil {
		return g.checkCode(c.ip, browser+", "+what, c.req.Code)
	}
	now := time.Now()
	challenge := g.passkeys.takeChallenge(passkeyConfirmKey(c.session), now)
	if challenge == nil {
		return errors.New("That took too long: try again.")
	}
	if !g.beginLogin(c.ip) {
		return errTooManyLogins
	}
	failed := true
	defer func() { g.endLogin(c.ip, browser+", with a passkey, "+what, failed) }()
	if !g.loginTurn() {
		failed = false // not checked
		return errLoginsBusy
	}
	name, err := g.passkeys.verifyLogin(*c.req.Assertion, challenge, now)
	if err != nil {
		log.Printf("passkey from %s, %s, refused: %v", c.ip, what, err)
		g.activity.failedLogin(c.ip, browser+", with a passkey, "+what)
		return errors.New("That passkey wasn't accepted here.")
	}
	failed = false
	log.Printf("%s confirmed from %s with the passkey %q", what, c.ip, name)
	return nil
}

// restartEngine ends the tab's engine, its page told first (it connects
// again, with a new one), if its loop answers in time.
func (b *goBrowser) restartEngine(reason string) {
	told := make(chan struct{})
	select {
	case b.results <- func() {
		b.send(map[string]any{"type": "go-restarting", "gen": b.gen})
		close(told)
	}:
		select {
		case <-told:
		case <-time.After(goRestartTold):
		}
	case <-b.stop:
		return // ended already
	case <-time.After(goRestartTold):
	}
	b.e.kill(reason)
}

// passkeyConfirmKey is the session's key for a challenge to confirm
// something with (not one to add a passkey with: kept apart).
func passkeyConfirmKey(session string) string { return "confirm " + session }

// confirmChallenge gives the session a challenge to confirm something with
// a passkey.
func (s *passkeyStore) confirmChallenge(session string, now time.Time) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.broken {
		return nil, errPasskeysBroken
	}
	for id, p := range s.pending {
		if now.After(p.expires) {
			delete(s.pending, id)
		}
	}
	c := make([]byte, 32)
	rand.Read(c)
	s.pending[passkeyConfirmKey(session)] = passkeyChallenge{c, now.Add(passkeyChallengeLife)}
	return c, nil
}
