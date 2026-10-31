package main

// Sessions: what a login yields, and what every later tunnel is keyed
// from. A session ends when it's logged out, when it reaches -session-max,
// or when it has had no tunnel open for -session-idle; ending it closes
// its open tunnels at once. Each remembers the addresses its tunnels came
// from, and the gateway remembers recent logins, so a session used from
// somewhere unexpected can be noticed and ended. All of it is in memory
// only: a restart forgets it, and logs everyone out.

import (
	"crypto/rand"
	"errors"
	"log"
	"slices"
	"strings"
	"sync"
	"time"
)

const (
	defaultSessionMax  = 12 * time.Hour
	defaultSessionIdle = time.Hour
	maxSessionUses     = 8  // addresses remembered per session
	maxLoginLog        = 20 // logins remembered, successful or not
	// Tunnels open at once per session, so a page stuck reconnecting, or a
	// client that means harm, can't open them without limit. A desktop tab
	// uses two (picture and sound).
	maxSessionTunnels = 64
)

type session struct {
	secret    []byte
	created   time.Time
	expiry    time.Time
	open      map[*tunnel]bool
	idleSince time.Time    // when its last tunnel closed (or it was made)
	uses      []sessionUse // where its tunnels came from: the login's first
	expire    *time.Timer
	idle      *time.Timer // nil while a tunnel is open, or with no idle limit
}

// sessionUse is one address a session was used from.
type sessionUse struct {
	IP    string    `json:"ip"`
	First time.Time `json:"first"`
	Last  time.Time `json:"last"`
}

// loginEvent is one login, for the history shown after logging in.
type loginEvent struct {
	Time time.Time `json:"time"`
	IP   string    `json:"ip"`
	OK   bool      `json:"ok"`
}

// liveLocked reports whether s can still be used. g.mu must be held.
func (g *server) liveLocked(s *session, now time.Time) bool {
	return now.Before(s.expiry) &&
		(len(s.open) > 0 || g.sessionIdle == 0 || now.Sub(s.idleSince) < g.sessionIdle)
}

// newSession starts a session for a login from ip: its id, its secret,
// and the logins before it, newest first.
func (g *server) newSession(ip string) (string, []byte, []loginEvent) {
	id := newToken()
	secret := make([]byte, 32)
	rand.Read(secret) // can't fail (see newToken)
	now := time.Now()
	max := g.sessionMax
	if max == 0 {
		max = defaultSessionMax // a server made by a test
	}
	s := &session{
		secret: secret, created: now, expiry: now.Add(max), open: map[*tunnel]bool{},
		idleSince: now, uses: []sessionUse{{ip, now, now}},
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.sessions == nil {
		g.sessions = map[string]*session{}
	}
	g.sessions[id] = s
	s.expire = time.AfterFunc(max, func() { g.endSession(id, "The session is over. Log in again.", nil) })
	g.armIdleLocked(id, s)
	history := slices.Clone(g.logins)
	slices.Reverse(history)
	g.recordLoginLocked(ip, true)
	return id, secret, history
}

// armIdleLocked starts s's idle timer, if there's an idle limit. g.mu must
// be held.
func (g *server) armIdleLocked(id string, s *session) {
	if g.sessionIdle == 0 {
		return
	}
	s.idle = time.AfterFunc(g.sessionIdle, func() {
		g.mu.Lock()
		idle := g.sessions[id] == s && !g.liveLocked(s, time.Now())
		g.mu.Unlock()
		if idle {
			g.endSession(id, "", nil)
		}
	})
}

func (g *server) recordLoginLocked(ip string, ok bool) {
	g.logins = append(g.logins, loginEvent{time.Now(), ip, ok})
	if len(g.logins) > maxLoginLog {
		g.logins = slices.Delete(g.logins, 0, len(g.logins)-maxLoginLog)
	}
}

// sessionSecret returns a live session's secret.
func (g *server) sessionSecret(id string) ([]byte, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	s, ok := g.sessions[id]
	if !ok || !g.liveLocked(s, time.Now()) {
		return nil, false
	}
	return s.secret, true
}

// attach counts t as one of a session's open tunnels, from ip, so ending
// the session closes it. The returned function detaches it. It fails with
// errSessionEnded, or errTooManyTunnels.
func (g *server) attach(id, ip string, t *tunnel) (func(), error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	s, ok := g.sessions[id]
	now := time.Now()
	if !ok || !g.liveLocked(s, now) {
		return nil, errSessionEnded
	}
	if len(s.open) >= maxSessionTunnels {
		return nil, errTooManyTunnels
	}
	s.open[t] = true
	if s.idle != nil {
		s.idle.Stop()
		s.idle = nil
	}
	if i := slices.IndexFunc(s.uses, func(u sessionUse) bool { return u.IP == ip }); i >= 0 {
		s.uses[i].Last = now
	} else {
		log.Printf("session logged in from %s used from %s too", s.uses[0].IP, ip)
		if len(s.uses) == maxSessionUses {
			// Keep the login's address; forget the next oldest.
			s.uses = slices.Delete(s.uses, 1, 2)
		}
		s.uses = append(s.uses, sessionUse{ip, now, now})
	}
	return func() {
		g.mu.Lock()
		defer g.mu.Unlock()
		if g.sessions[id] != s || !s.open[t] {
			return
		}
		delete(s.open, t)
		if len(s.open) == 0 {
			s.idleSince = time.Now()
			g.armIdleLocked(id, s)
		}
	}, nil
}

var (
	errSessionEnded   = errors.New("Log in first.")
	errTooManyTunnels = errors.New("Too many connections open for this session.")
)

// endSession ends a session and closes its open tunnels with reason, which
// the page shows, except for the one asking, which closes itself after its
// reply; "" means "Logged out.".
func (g *server) endSession(id, reason string, asking *tunnel) {
	g.mu.Lock()
	s, ok := g.sessions[id]
	if ok {
		g.endLocked(id, s)
	}
	g.mu.Unlock()
	if ok {
		closeTunnels(s, reason, asking)
	}
}

// endAllSessions ends every session, closing their tunnels but the one
// asking.
func (g *server) endAllSessions(reason string, asking *tunnel) {
	g.mu.Lock()
	ended := []*session{}
	for id, s := range g.sessions {
		g.endLocked(id, s)
		ended = append(ended, s)
	}
	g.mu.Unlock()
	for _, s := range ended {
		closeTunnels(s, reason, asking)
	}
}

func (g *server) endLocked(id string, s *session) {
	delete(g.sessions, id)
	s.expire.Stop()
	if s.idle != nil {
		s.idle.Stop()
	}
}

// closeTunnels closes an ended session's tunnels, which are no longer
// changed: detaching from an ended session does nothing. The page logs in
// again when it sees closeLogin.
func closeTunnels(s *session, reason string, asking *tunnel) {
	if reason == "" {
		reason = "Logged out."
	}
	for t := range s.open {
		if t != asking {
			go t.Close(closeLogin, reason)
		}
	}
}

// handshakes counts tunnels not yet logged in or tied to a session, by
// client IP. It has its own lock, so a flood of them doesn't hold up the
// sessions.
type handshakes struct {
	mu    sync.Mutex
	total int
	byIP  map[string]int
}

// start counts a tunnel from ip until it's logged in or tied to a session,
// which the returned function (safe to call twice) records. It's false if
// too many are at that stage already.
func (h *handshakes) start(ip string) (func(), bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.total >= maxHandshakes || h.byIP[ip] >= maxHandshakesPerIP {
		return nil, false
	}
	if h.byIP == nil {
		h.byIP = map[string]int{}
	}
	h.total++
	h.byIP[ip]++
	var once sync.Once
	return func() {
		once.Do(func() {
			h.mu.Lock()
			defer h.mu.Unlock()
			h.total--
			if h.byIP[ip]--; h.byIP[ip] <= 0 {
				delete(h.byIP, ip)
			}
		})
	}, true
}

// liveSessions counts the sessions that can still be used.
func (g *server) liveSessions() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	n, now := 0, time.Now()
	for _, s := range g.sessions {
		if g.liveLocked(s, now) {
			n++
		}
	}
	return n
}

// sessionInfo is a session as the files page lists it.
type sessionInfo struct {
	Created time.Time    `json:"created"`
	Expires time.Time    `json:"expires"`
	Open    int          `json:"open"`
	Uses    []sessionUse `json:"uses"`
	Current bool         `json:"current"`
}

// sessionsReport lists the live sessions, oldest first, and the logins
// remembered, newest first, for the session current. The tunnel asking
// isn't counted as open, so the count is only what else is.
func (g *server) sessionsReport(current string, asking *tunnel) map[string]any {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := time.Now()
	list := []sessionInfo{}
	for id, s := range g.sessions {
		if g.liveLocked(s, now) {
			open := len(s.open)
			if s.open[asking] {
				open--
			}
			list = append(list, sessionInfo{s.created, s.expiry, open, slices.Clone(s.uses), id == current})
		}
	}
	slices.SortFunc(list, func(a, b sessionInfo) int { return a.Created.Compare(b.Created) })
	logins := slices.Clone(g.logins)
	slices.Reverse(logins)
	if logins == nil {
		logins = []loginEvent{}
	}
	return map[string]any{
		"sessions":     list,
		"logins":       logins,
		"idle_minutes": int(g.sessionIdle / time.Minute),
	}
}

// parseSessionLimit parses -session-max or -session-idle: a Go duration
// in whole minutes, such as "12h" or "90m"; "0" (for the idle limit only)
// means none.
func parseSessionLimit(s string, zeroOK bool) (time.Duration, error) {
	d, err := time.ParseDuration(strings.TrimSpace(s))
	switch {
	case err != nil:
		return 0, err
	case d < 0 || (d == 0 && !zeroOK) || d%time.Minute != 0:
		return 0, errBadLimit
	}
	return d, nil
}

var errBadLimit = errors.New("must be whole minutes, such as 90m or 12h")
