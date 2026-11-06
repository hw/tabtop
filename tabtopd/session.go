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
	"crypto/sha256"
	"encoding/base64"
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
	// uses three while connected (picture, sound, and notices of new
	// downloads).
	maxSessionTunnels = 64
)

type session struct {
	secret    []byte
	created   time.Time
	expiry    time.Time
	open      map[*tunnel]bool
	idleSince time.Time    // when its last tunnel closed (or it was made)
	uses      []sessionUse // where its tunnels came from: the login's first
	browser   string       // what logged in, as browserName says
	label     string       // what the person using it called it, such as "work laptop"
	expire    lifecycleTimer
	idle      lifecycleTimer // nil while a tunnel is open, or with no idle limit
}

// sessionUse is one address a session was used from.
type sessionUse struct {
	IP    string    `json:"ip"`
	First time.Time `json:"first"`
	Last  time.Time `json:"last"`
}

// loginEvent is one login, for the history shown after logging in.
type loginEvent struct {
	Time    time.Time `json:"time"`
	IP      string    `json:"ip"`
	Browser string    `json:"browser,omitempty"` // as browserName says
	OK      bool      `json:"ok"`
}

// liveLocked reports whether s can still be used. g.mu must be held.
func (g *server) liveLocked(s *session, now time.Time) bool {
	return now.Before(s.expiry) &&
		(len(s.open) > 0 || g.sessionIdle == 0 || now.Sub(s.idleSince) < g.sessionIdle)
}

// newSession starts a session for a login from ip, by browser (see
// browserName): its id, its secret, and the logins before it, newest
// first.
func (g *server) newSession(ip, browser string) (string, []byte, []loginEvent) {
	id := newToken()
	secret := make([]byte, 32)
	rand.Read(secret) // can't fail (see newToken)
	now := g.clock.Now()
	max := g.sessionMax
	s := &session{
		secret: secret, created: now, expiry: now.Add(max), open: map[*tunnel]bool{},
		idleSince: now, uses: []sessionUse{{ip, now, now}}, browser: browser,
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.sessions == nil {
		g.sessions = map[string]*session{}
	}
	g.sessions[id] = s
	s.expire = g.clock.AfterFunc(max, func() { g.endSession(id, "The session is over. Log in again.", nil) })
	g.armIdleLocked(id, s)
	history := g.loginHistory(ip, browser, true)
	return id, secret, history
}

// sessionExpiry returns when the session id ends at the latest, for the
// pages to warn of it, or the zero time if there's no such session.
func (g *server) sessionExpiry(id string) time.Time {
	g.mu.Lock()
	defer g.mu.Unlock()
	if s, ok := g.sessions[id]; ok {
		return s.expiry
	}
	return time.Time{}
}

// armIdleLocked starts s's idle timer, if there's an idle limit. g.mu must
// be held.
func (g *server) armIdleLocked(id string, s *session) {
	if g.sessionIdle == 0 {
		return
	}
	s.idle = g.clock.AfterFunc(g.sessionIdle, func() {
		g.mu.Lock()
		idle := g.sessions[id] == s && !g.liveLocked(s, g.clock.Now())
		g.mu.Unlock()
		if idle {
			g.endSession(id, "", nil)
		}
	})
}

// sessionSecret returns a live session's secret.
func (g *server) sessionSecret(id string) ([]byte, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	s, ok := g.sessions[id]
	if !ok || !g.liveLocked(s, g.clock.Now()) {
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
	now := g.clock.Now()
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
			s.idleSince = g.clock.Now()
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

// sessionHandle names the session id in the files page's list, to end it
// by: a hash of it, so the page never learns other sessions' ids.
func sessionHandle(id string) string {
	h := sha256.Sum256([]byte("tabtop session handle\x00" + id))
	return base64.RawURLEncoding.EncodeToString(h[:12])
}

// endSessionByHandle ends the session named handle (see sessionHandle),
// for another session, asking, from ip, and reports whether there was
// one. A session doesn't end itself this way: logging out does that.
func (g *server) endSessionByHandle(handle, asking, ip string) bool {
	g.mu.Lock()
	id := ""
	for sid := range g.sessions {
		if sessionHandle(sid) == handle && sid != asking {
			id = sid
			break
		}
	}
	g.mu.Unlock()
	if id == "" {
		return false
	}
	log.Printf("a session was ended from another, at %s", ip)
	g.endSession(id, "This session was ended from another.", nil)
	return true
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
	n, now := 0, g.clock.Now()
	for _, s := range g.sessions {
		if g.liveLocked(s, now) {
			n++
		}
	}
	return n
}

// sessionInfo is a session as the files page lists it.
type sessionInfo struct {
	Handle  string       `json:"handle"` // names it to end it (see sessionHandle)
	Created time.Time    `json:"created"`
	Expires time.Time    `json:"expires"`
	Open    int          `json:"open"`
	Uses    []sessionUse `json:"uses"`
	Browser string       `json:"browser,omitempty"` // what logged in, as browserName says
	Label   string       `json:"label,omitempty"`
	Current bool         `json:"current"`
}

// sessionName is what the session id has been called, or "".
func (g *server) sessionName(id string) string {
	g.mu.Lock()
	defer g.mu.Unlock()
	if s := g.sessions[id]; s != nil {
		return s.label
	}
	return ""
}

// nameSession calls the session with handle (or asking, for "") label,
// and reports whether there was one, and whether it was asking.
func (g *server) nameSession(handle, asking, label string) (found, own bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	for id, s := range g.sessions {
		if handle == "" && id == asking || handle != "" && sessionHandle(id) == handle {
			s.label = label
			return true, id == asking
		}
	}
	return false, false
}

// sessionsReport lists the live sessions, oldest first, and the logins
// remembered, newest first, for the session current. The tunnel asking
// isn't counted as open, so the count is only what else is. "seen" is
// when the warnings were last marked as seen, if they have been: failed
// logins and addresses from before then don't need looking at again.
func (g *server) sessionsReport(current string, asking *tunnel) map[string]any {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := g.clock.Now()
	list := []sessionInfo{}
	for id, s := range g.sessions {
		if g.liveLocked(s, now) {
			open := len(s.open)
			if s.open[asking] {
				open--
			}
			list = append(list, sessionInfo{sessionHandle(id), s.created, s.expiry, open, slices.Clone(s.uses), s.browser, s.label, id == current})
		}
	}
	slices.SortFunc(list, func(a, b sessionInfo) int { return a.Created.Compare(b.Created) })
	logins := g.loginHistory("", "", false)
	res := map[string]any{
		"now":          now,
		"sessions":     list,
		"logins":       logins,
		"idle_minutes": int(g.sessionIdle / time.Minute),
	}
	if !g.seen.IsZero() {
		res["seen"] = g.seen
	}
	return res
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

// browserName names the browser that sent the User-Agent ua, and what it
// runs on, as "Chrome on macOS", so the sessions list can tell logins
// apart; "" if it can't tell either. The browser says this itself, so it
// tells logins apart but proves nothing.
func browserName(ua string) string {
	has := func(s ...string) bool {
		return slices.ContainsFunc(s, func(s string) bool { return strings.Contains(ua, s) })
	}
	browser := ""
	switch {
	case has("Edg/", "EdgA/", "EdgiOS/"):
		browser = "Edge"
	case has("OPR/", "Opera"):
		browser = "Opera"
	case has("SamsungBrowser/"):
		browser = "Samsung Internet"
	case has("Firefox/", "FxiOS/"):
		browser = "Firefox"
	case has("Chromium/"):
		browser = "Chromium"
	case has("Chrome/", "CriOS/"):
		browser = "Chrome"
	case has("Safari/") && has("Version/"):
		browser = "Safari"
	}
	system := ""
	switch {
	case has("iPhone"):
		system = "iPhone"
	case has("iPad"):
		system = "iPad"
	case has("Android"):
		system = "Android"
	case has("CrOS"):
		system = "ChromeOS"
	case has("Windows"):
		system = "Windows"
	case has("Macintosh", "Mac OS X"):
		system = "macOS"
	case has("Linux", "X11"):
		system = "Linux"
	}
	switch {
	case browser != "" && system != "":
		return browser + " on " + system
	case browser != "":
		return browser
	case system != "":
		return "a browser on " + system
	}
	return ""
}
