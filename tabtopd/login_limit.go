package main

import (
	"log"
	"net/netip"
	"slices"
	"sync"
	"time"
)

// authentication owns login reservations, throttling and history. Session
// operations may acquire authMu while holding server.mu; authentication never
// acquires server.mu, so history and session creation keep a fixed lock order.
// The zero value is ready for use.
type authentication struct {
	authMu       sync.Mutex
	logins       []loginEvent
	failures     windowCounter // failed logins, by address (limitKey)
	pending      map[string]int
	siteFailures []time.Time
	nextLogin    time.Time
	throttling   bool
}

// lockedOutLocked counts logins still awaiting their result as failures,
// so opening many connections at once can't buy extra guesses. g.authMu must be
// held.
func (g *authentication) lockedOutLocked(ip string) bool {
	return len(g.failures.recent(ip, time.Now(), failureWindow))+g.pending[ip] >= maxFailures
}

// loginWork has a slot for each login being checked. Checking takes CPU
// (CPace) and liboath's lock on the users file, so without a bound a flood
// of logins from many addresses, each within its own limit, would queue
// without end. One that finds no slot is turned away: while a flood lasts,
// logins may be refused, but nothing stays locked afterwards.
var loginWork = make(chan struct{}, maxLoginWork)

const (
	loginBusy    = "too many logins being checked at once"
	loginBusyMsg = "The server is busy checking other logins. Try again in a moment."
)

// startLoginWork takes a slot for checking a login, or reports that there's
// none free; endLoginWork gives it back.
func startLoginWork() bool {
	select {
	case loginWork <- struct{}{}:
		return true
	default:
		return false
	}
}

func endLoginWork() { <-loginWork }

// limitKey is what failed logins and unfinished handshakes from ip are
// counted against: an IPv4 address as it is, and an IPv6 address's /64,
// since one subscriber usually has a whole /64 and could otherwise step
// through it for a fresh limit with every guess.
func limitKey(ip string) string {
	addr, err := netip.ParseAddr(ip)
	if err != nil {
		return ip
	}
	if addr = addr.Unmap(); addr.Is4() {
		return addr.String()
	}
	p, _ := addr.Prefix(64)
	return p.String()
}

// lockedOut reports whether logins from ip are refused, for now, for
// the failures from it.
func (g *authentication) lockedOut(ip string) bool {
	g.authMu.Lock()
	defer g.authMu.Unlock()
	return g.lockedOutLocked(limitKey(ip))
}

// beginLogin reserves one of ip's login attempts until endLogin gives its
// result, or reports that it has none left.
func (g *authentication) beginLogin(ip string) bool {
	key := limitKey(ip)
	g.authMu.Lock()
	defer g.authMu.Unlock()
	if g.lockedOutLocked(key) {
		return false
	}
	if g.pending == nil {
		g.pending = map[string]int{}
	}
	g.pending[key]++
	return true
}

func (g *authentication) endLogin(ip, browser string, failed bool) {
	key := limitKey(ip)
	g.authMu.Lock()
	defer g.authMu.Unlock()
	if g.pending[key]--; g.pending[key] <= 0 {
		delete(g.pending, key)
	}
	if failed {
		now := time.Now()
		g.recordLoginLocked(ip, browser, false)
		g.failures.add(key, now, failureWindow, 0) // (no bound: none's forgotten to make room)
		g.failures.sweep(now, failureWindow, failureWindow)
		g.siteFailures = append(g.siteFailures, now)
		if len(g.siteFailures) > maxSiteFailures {
			g.siteFailures = g.siteFailures[len(g.siteFailures)-maxSiteFailures:]
		}
	}
}

// loginTurn reports whether a login may be checked now. The limit per
// address doesn't stop guesses spread over many addresses, so once
// maxSiteFailures logins have failed within failureWindow, from anywhere,
// logins are checked at most one per siteThrottle until the failures thin
// out. That turns guessing a code-only login (one in about 333,000 for 6
// digits, since three codes are accepted at a time) from a matter of hours
// into weeks, and the owner can still get in, if not at the first try.
func (g *authentication) loginTurn() bool {
	g.authMu.Lock()
	defer g.authMu.Unlock()
	now := time.Now()
	if len(g.siteFailures) < maxSiteFailures || now.Sub(g.siteFailures[0]) >= failureWindow {
		if g.throttling {
			g.throttling = false
			log.Printf("failed logins have thinned out: no longer slowing logins down")
		}
		return true
	}
	if !g.throttling {
		g.throttling = true
		log.Printf("warning: %d failed logins in %v, from all addresses together: slowing logins down to one per %v",
			maxSiteFailures, failureWindow, siteThrottle)
	}
	if now.Before(g.nextLogin) {
		return false
	}
	g.nextLogin = now.Add(siteThrottle)
	return true
}

func (g *authentication) recordLoginLocked(ip, browser string, ok bool) {
	g.logins = append(g.logins, loginEvent{time.Now(), ip, browser, ok})
	if len(g.logins) > maxLoginLog {
		g.logins = slices.Delete(g.logins, 0, len(g.logins)-maxLoginLog)
	}
}

func (g *authentication) loginHistory(ip, browser string, record bool) []loginEvent {
	g.authMu.Lock()
	defer g.authMu.Unlock()
	history := slices.Clone(g.logins)
	slices.Reverse(history)
	if record {
		g.recordLoginLocked(ip, browser, true)
	}
	if history == nil {
		history = []loginEvent{}
	}
	return history
}

func (g *authentication) loginState() (lockedOut int, slowed bool) {
	g.authMu.Lock()
	defer g.authMu.Unlock()
	for ip := range g.failures.events {
		if g.lockedOutLocked(ip) {
			lockedOut++
		}
	}
	return lockedOut, g.throttling
}

// loginAttempt is a login, or a check counted as one (a code or passkey
// confirming an action): reserved against its address's failed-login
// limit when begun (beginAttempt), then settled once. Failed (failed,
// badMessage), it's counted against the address; given up on, passed, or
// not checked at all (end, deferred by whoever began it), it isn't.
type loginAttempt struct {
	g           *server
	ip, browser string
	settled     bool
}

// beginAttempt reserves a login from ip (browser: how it's said in the
// activity log), or is nil if ip has no tries left for now.
func (g *server) beginAttempt(ip, browser string) *loginAttempt {
	if !g.beginLogin(ip) {
		return nil
	}
	return &loginAttempt{g: g, ip: ip, browser: browser}
}

// failed settles it as a failed login: counted, and said in the activity
// log.
func (a *loginAttempt) failed() {
	if a.settle(true) {
		a.g.activity.failedLogin(a.ip, a.browser)
	}
}

// badMessage settles it as failed for a message that isn't one a browser
// sends: counted (it could be a guess), but not a login to say was tried.
func (a *loginAttempt) badMessage() { a.settle(true) }

// end settles it, if it isn't yet, as not failed.
func (a *loginAttempt) end() { a.settle(false) }

// settle settles it, reporting whether this did (it's settled once).
func (a *loginAttempt) settle(failed bool) bool {
	if a.settled {
		return false
	}
	a.settled = true
	a.g.endLogin(a.ip, a.browser, failed)
	return true
}
