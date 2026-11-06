package main

// The activity log: what's been done with TabTop that matters for its
// security, kept across restarts in -activity-file, one JSON object a line,
// and shown in Sessions and Activity. Logins, failed ones too, logging out
// and ending sessions; share and upload links made, changed, revoked and
// used, and files received through them; fetches from URLs. Not what's done
// with files through the tunnel, which would bury the rest.
//
// It keeps the newest maxActivity entries. What it records never holds a
// link's token or a fetch's whole address (only its host), as the gateway's
// own log doesn't. Clearing it, from Sessions and Activity, leaves one
// entry saying who did, so it can't be done unseen.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

// The most entries kept: past that, the oldest go.
const maxActivity = 2000

// activityEntry is one thing done.
type activityEntry struct {
	Time time.Time `json:"time"`
	Kind string    `json:"kind"` // login, login-failed, logout, logout-all, end-session, session (naming one), share, share-used, upload, fetch, cleanup or cleared
	IP   string    `json:"ip,omitempty"`
	// What the session that did it was called (see nameSession), if
	// anything
	Session string `json:"session,omitempty"`
	Text    string `json:"text"`

	// For failed logins merged into one (see failedLogin): how many, the
	// last when, and from where: the first few addresses, and how many of
	// the tries came from others.
	Count  int       `json:"count,omitempty"`
	Last   time.Time `json:"last,omitempty"`
	IPs    []string  `json:"ips,omitempty"`
	Others int       `json:"others,omitempty"`
}

// Failed logins within failedLoginMerge of the one before are merged into
// its entry, which lists up to failedLoginIPs of their addresses.
const (
	failedLoginMerge = 10 * time.Minute
	failedLoginIPs   = 10
)

// activityLog is the log, kept in file (if it isn't "").
type activityLog struct {
	file  string
	clock lifecycleClock

	mu      sync.Mutex
	entries []activityEntry // oldest first
	lines   int             // in the file, which is rewritten once it has twice maxActivity
	// A rewrite to come, for an entry changed (see failedLogin).
	rewriteTimer lifecycleTimer
}

// activityRewriteDelay is how soon the file is written again after an
// entry in it changes: once for many.
const activityRewriteDelay = 10 * time.Second

// rewriteSoonLocked writes the file again within activityRewriteDelay;
// a.mu must be held.
func (a *activityLog) rewriteSoonLocked() {
	if a.file == "" || a.rewriteTimer != nil {
		return
	}
	a.rewriteTimer = a.clock.AfterFunc(activityRewriteDelay, func() {
		a.mu.Lock()
		defer a.mu.Unlock()
		a.rewriteTimer = nil
		a.rewriteLocked()
	})
}

// flush writes the file now, if a rewrite is to come, as the gateway stops.
func (a *activityLog) flush() {
	if a == nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.rewriteTimer != nil {
		a.rewriteTimer.Stop()
		a.rewriteTimer = nil
		a.rewriteLocked()
	}
}

func newActivityLog(file string, clock lifecycleClock) *activityLog {
	a := &activityLog{file: file, clock: clock}
	if file == "" {
		return a
	}
	data, err := os.ReadFile(file)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			log.Printf("activity log: %v; starting a new one", err)
		}
		return a
	}
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		a.lines++
		var e activityEntry
		// A line that doesn't parse (the file is the desktop user's to
		// change, or one cut short by a crash) is left out.
		if json.Unmarshal(sc.Bytes(), &e) == nil && !e.Time.IsZero() && e.Text != "" {
			a.entries = append(a.entries, e)
		}
	}
	if len(a.entries) > maxActivity {
		a.entries = slices.Clone(a.entries[len(a.entries)-maxActivity:])
	}
	return a
}

// add records something done from ip, as kind, described by format and
// args. A nil log records nothing.
func (a *activityLog) add(kind, ip, format string, args ...any) {
	a.addAs("", kind, ip, format, args...)
}

// addAs is add, for the session called session.
func (a *activityLog) addAs(session, kind, ip, format string, args ...any) {
	if a == nil {
		return
	}
	e := activityEntry{Time: a.clock.Now().UTC().Truncate(time.Second), Kind: kind, IP: ip, Session: session, Text: fmt.Sprintf(format, args...)}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.entries = append(a.entries, e)
	if len(a.entries) > maxActivity {
		a.entries = slices.Delete(a.entries, 0, len(a.entries)-maxActivity)
	}
	if a.file == "" {
		return
	}
	if a.lines+1 > 2*maxActivity {
		a.rewriteLocked()
		return
	}
	line, _ := json.Marshal(e)
	if err := appendLine(a.file, line); err != nil {
		log.Printf("activity log: %v", err)
		return
	}
	a.lines++
}

// appendLine adds line to file, made readable only by its owner, in a
// folder only it can open.
func appendLine(file string, line []byte) error {
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(file, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return err
	}
	_, err = f.Write(append(line, '\n'))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

// rewriteLocked writes the file again with what's kept. a.mu must be held.
func (a *activityLog) rewriteLocked() {
	var buf bytes.Buffer
	for _, e := range a.entries {
		line, _ := json.Marshal(e)
		buf.Write(line)
		buf.WriteByte('\n')
	}
	if err := writeFileAtomic(a.file, buf.Bytes()); err != nil {
		log.Printf("activity log: %v", err)
		return
	}
	a.lines = len(a.entries)
}

// act records something the session id did, from ip, with what it's
// called.
func (g *server) act(id, kind, ip, format string, args ...any) {
	g.activity.addAs(g.sessionName(id), kind, ip, format, args...)
}

// withBrowser is ", with <browser>", if it's known.
func withBrowser(browser string) string {
	if browser == "" {
		return ""
	}
	return " with " + browser
}

// folderText is how the activity log names a folder in ~/Downloads.
func folderText(dir string) string {
	if dir == "." || dir == "" {
		return "Downloads"
	}
	return dir + "/"
}

// countText is "n units", or "any number of units" for 0.
func countText(n int, unit string) string {
	switch n {
	case 0:
		return "any number of " + unit + "s"
	case 1:
		return "1 " + unit
	}
	return fmt.Sprintf("%d %ss", n, unit)
}

// lifeText is how long d is, in the units a link's life is chosen in.
func lifeText(d time.Duration) string {
	unit, n := "minute", int(d/time.Minute)
	switch {
	case d%(24*time.Hour) == 0:
		unit, n = "day", int(d/(24*time.Hour))
	case d%time.Hour == 0:
		unit, n = "hour", int(d/time.Hour)
	}
	if n == 1 {
		return "1 " + unit
	}
	return fmt.Sprintf("%d %ss", n, unit)
}

// usedText is "(n of max)", or "(n so far)" with no limit.
func usedText(n, max int) string {
	if max == 0 {
		return fmt.Sprintf("(%d so far)", n)
	}
	return fmt.Sprintf("(%d of %d)", n, max)
}

// list returns the newest limit entries, newest first (all of them for
// limit 0), and how many there are.
func (a *activityLog) list(limit int) ([]activityEntry, int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	n := len(a.entries)
	if limit <= 0 || limit > n {
		limit = n
	}
	out := slices.Clone(a.entries[n-limit:])
	slices.Reverse(out)
	return out, n
}

// clear empties the log, then records that the session called session,
// from ip, did.
func (a *activityLog) clear(ip, session string) {
	a.mu.Lock()
	a.entries = nil
	if a.file != "" {
		a.rewriteLocked()
	}
	a.mu.Unlock()
	a.addAs(session, "cleared", ip, "cleared the activity log")
}

// failedLogin records a login from ip, with browser, that failed: as an
// entry of its own, or, within failedLoginMerge of the last failed one,
// merged into that one's. Anyone can fail to log in, from as many
// addresses as they have, and entries of their own would push all else
// out of the log.
func (a *activityLog) failedLogin(ip, browser string) {
	if a == nil {
		return
	}
	now := a.clock.Now().UTC().Truncate(time.Second)
	a.mu.Lock()
	for i := len(a.entries) - 1; i >= 0; i-- {
		e := &a.entries[i]
		if e.Kind == "login" {
			// A login since: what fails after it is after it, in the log.
			break
		}
		if e.Kind != "login-failed" {
			continue
		}
		last := e.Last
		if last.IsZero() {
			last = e.Time
		}
		if now.Sub(last) >= failedLoginMerge {
			break
		}
		if e.Count == 0 {
			e.Count = 1
			e.IPs = []string{e.IP}
		}
		e.Count++
		e.Last = now
		switch {
		case slices.Contains(e.IPs, ip):
		case len(e.IPs) < failedLoginIPs:
			e.IPs = append(e.IPs, ip)
		default:
			e.Others++
		}
		e.Text = failedLoginText(e)
		// Written soon, with those that follow, not at once: they come as
		// fast as anyone can try.
		a.rewriteSoonLocked()
		a.mu.Unlock()
		return
	}
	a.mu.Unlock()
	a.add("login-failed", ip, "login failed%s", withBrowser(browser))
}

// failedLoginText describes failed logins merged into e.
func failedLoginText(e *activityEntry) string {
	from := strings.Join(e.IPs, ", ")
	switch {
	case e.Others == 1:
		from += ", and 1 try from another address"
	case e.Others > 1:
		from += fmt.Sprintf(", and %d tries from other addresses", e.Others)
	case len(e.IPs) == 1:
		from = e.IPs[0]
	}
	if n := strings.LastIndex(from, ", "); n >= 0 && e.Others == 0 {
		from = from[:n] + " and " + from[n+2:]
	}
	return fmt.Sprintf("login failed %d times, the last at %s UTC, from %s", e.Count, e.Last.Format("15:04"), from)
}
