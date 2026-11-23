package main

// Private tabs (see docs/browser-plan.md, "Private tabs"): a /go tab the
// person opens as private keeps nothing of where it went. Its engine is
// started without the shared HTTP cache (gocache.go), and it isn't given
// the account's cookies (gocookies.go) or saved localStorage
// (gostorage.go), nor does it add to them: a session's private tabs share
// a jar and a storage of their own, in memory only, so a sign-in in one
// (or in a window it opens) holds in the others, and both are forgotten as
// the session's last private tab ends (closed, not taken back in time, or
// its session ended). Its visits aren't counted in Site controls (they're
// the private jar's tabs, not the account's), and its server-side fetches
// (pictures, media) are sent its own cookies, never the account's.
//
// Site settings (blocked sites, ad blocking, pop-ups and media) still
// hold in it; a pop-up's answer isn't remembered from one. Files it
// downloads are saved, as a browser's private window saves them.

import (
	"sync"
	"time"
)

// goPrivateKeep is how long a restart (gorestart.go) keeps the session's
// private cookies and storage for its private tabs to come back to.
var goPrivateKeep = 30 * time.Second

// goPrivate is a session's private tabs' cookies and storage, and how many
// hold them (its tabs, and a restart under way).
type goPrivate struct {
	jar     *goCookieJar
	storage *goStorage
	holds   int
}

type goPrivates struct {
	mu sync.Mutex
	by map[string]*goPrivate // by session
}

// privateFor is the session's private jar and storage, held till release
// is called: made if the session has none open.
func (ps *goPrivates) privateFor(session string) (p *goPrivate, release func()) {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.by == nil {
		ps.by = map[string]*goPrivate{}
	}
	p = ps.by[session]
	if p == nil {
		p = &goPrivate{jar: newGoCookieJar("", ""), storage: newGoStorage("", nil)}
		ps.by[session] = p
	}
	p.holds++
	var once sync.Once
	return p, func() { once.Do(func() { ps.release(session, p) }) }
}

func (ps *goPrivates) release(session string, p *goPrivate) {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if p.holds--; p.holds > 0 {
		return
	}
	if ps.by[session] == p {
		delete(ps.by, session)
	}
	// Forgotten: nothing refers to them now but tabs already gone.
	p.jar.mu.Lock()
	p.jar.cookies = map[goCookieKey]*goCookie{}
	p.jar.mu.Unlock()
	p.storage.mu.Lock()
	p.storage.origins = map[string]*goStorageOrigin{}
	p.storage.mu.Unlock()
}

// has is whether the session has private cookies and storage held.
func (ps *goPrivates) has(session string) bool {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	return ps.by[session] != nil
}

// keepAWhile holds the private state of the sessions that have it, for
// goPrivateKeep: an engine restart ends every tab, and the private ones,
// connecting again, find their sign-ins still there.
func (ps *goPrivates) keepAWhile() {
	ps.mu.Lock()
	sessions := make([]string, 0, len(ps.by))
	for s := range ps.by {
		sessions = append(sessions, s)
	}
	ps.mu.Unlock()
	for _, s := range sessions {
		_, release := ps.privateFor(s)
		time.AfterFunc(goPrivateKeep, release)
	}
}

// goEngineConfigFor is what a tab's engine is started with: a private
// tab's without the shared HTTP cache (its engine's own, in memory or its
// sandbox's /tmp, goes with it).
func goEngineConfigFor(cfg goEngineConfig, private bool) goEngineConfig {
	if private {
		cfg.cache = ""
	}
	return cfg
}
