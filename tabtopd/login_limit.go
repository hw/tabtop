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
	authMu        sync.Mutex
	logins        []loginEvent
	failures      map[string][]time.Time
	pending       map[string]int
	siteFailures  []time.Time
	nextLogin     time.Time
	throttling    bool
	failuresSwept time.Time
}

// lockedOutLocked counts logins still awaiting their result as failures,
// so opening many connections at once can't buy extra guesses. g.authMu must be
// held.
func (g *authentication) lockedOutLocked(ip string) bool {
	now := time.Now()
	recent := slices.DeleteFunc(g.failures[ip], func(t time.Time) bool { return now.Sub(t) >= failureWindow })
	if len(recent) == 0 {
		delete(g.failures, ip)
	} else {
		g.failures[ip] = recent
	}
	return len(recent)+g.pending[ip] >= maxFailures
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
		if g.failures == nil {
			g.failures = map[string][]time.Time{}
		}
		g.failures[key] = append(g.failures[key], now)
		g.sweepFailuresLocked()
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

// sweepFailuresLocked forgets the failures of every IP that has none left
// in the window, at most once a window, so addresses that fail once and
// never come back don't pile up. g.authMu must be held.
func (g *authentication) sweepFailuresLocked() {
	now := time.Now()
	if now.Sub(g.failuresSwept) < failureWindow {
		return
	}
	g.failuresSwept = now
	for ip, times := range g.failures {
		if len(times) == 0 || now.Sub(times[len(times)-1]) >= failureWindow {
			delete(g.failures, ip)
		}
	}
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
	for ip := range g.failures {
		if g.lockedOutLocked(ip) {
			lockedOut++
		}
	}
	return lockedOut, g.throttling
}
