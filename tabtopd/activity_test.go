package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestActivityLog(t *testing.T) {
	file := filepath.Join(t.TempDir(), "conf", "activity.jsonl")
	a := newActivityLog(file, lifecycleClock{})
	a.add("login", "203.0.113.9", "logged in%s", withBrowser("Firefox on Linux"))
	a.add("login-failed", "198.51.100.7", "login failed")
	// Kept across a restart, newest first; a line that doesn't parse is
	// left out.
	f, _ := os.OpenFile(file, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString("{not json\n")
	f.Close()
	if st, _ := os.Stat(file); st.Mode().Perm() != 0o600 {
		t.Errorf("the file is %v", st.Mode().Perm())
	}
	a = newActivityLog(file, lifecycleClock{})
	got, total := a.list(0)
	if total != 2 || got[0].Text != "login failed" || got[1].Text != "logged in with Firefox on Linux" || got[1].IP != "203.0.113.9" {
		t.Fatalf("after a restart: %d, %+v", total, got)
	}
	if got, _ := a.list(1); len(got) != 1 || got[0].Kind != "login-failed" {
		t.Errorf("newest 1: %+v", got)
	}
	// Only the newest maxActivity are kept, and the file doesn't grow
	// past twice that.
	for i := range 2*maxActivity + 10 {
		a.add("share", "", "entry %d", i)
	}
	if _, total := a.list(0); total != maxActivity {
		t.Errorf("kept %d", total)
	}
	data, _ := os.ReadFile(file)
	if n := bytes.Count(data, []byte("\n")); n > 2*maxActivity {
		t.Errorf("the file has %d lines", n)
	}
	if got, _ := newActivityLog(file, lifecycleClock{}).list(1); got[0].Text != "entry 4009" {
		t.Errorf("newest after a restart: %+v", got)
	}
	// Cleared: one entry saying who did.
	a.clear("192.0.2.4", "laptop")
	got, total = newActivityLog(file, lifecycleClock{}).list(0)
	if total != 1 || got[0].Kind != "cleared" || got[0].IP != "192.0.2.4" || got[0].Session != "laptop" {
		t.Errorf("cleared: %+v", got)
	}
	// A nil log records nothing, and doesn't fail.
	(*activityLog)(nil).add("login", "", "x")
}

// What a session does shows in the log, through the tunnel; and it can be
// cleared.
func TestActivityThroughTunnel(t *testing.T) {
	g, srv, s, _ := newShareServer(t)
	os.WriteFile(filepath.Join(g.downloadsDir, "f.txt"), []byte("x"), 0o644)
	loginAt(t, testCtx(t), wsURL(srv), "000000") // a failed login
	url := makeShare(t, srv, s, "f.txt", 3600, 0)
	shareFetch(t, "GET", url)
	activity := func() string {
		r := openSession(t, testCtx(t), srv, s).request(t, testCtx(t), tunnelRequest{Type: "activity"})
		var lines []string
		for _, e := range r["entries"].([]any) {
			m := e.(map[string]any)
			lines = append(lines, m["kind"].(string)+": "+m["text"].(string))
		}
		return strings.Join(lines, "\n")
	}
	got := activity()
	for _, want := range []string{"share-used: downloaded f.txt through a share link (1 so far)",
		"share: made a share link to f.txt, for 1 hour, any number of downloads", "login-failed: login failed", "login: logged in"} {
		if !strings.Contains(got, want) {
			t.Errorf("activity lacks %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, strings.Split(url, "/")[4]) {
		t.Errorf("activity holds the link's token:\n%s", got)
	}
	if r := openSession(t, testCtx(t), srv, s).request(t, testCtx(t), tunnelRequest{Type: "activity-clear"}); r["ok"] != true {
		t.Fatalf("clear: %v", r)
	}
	if got := activity(); got != "cleared: cleared the activity log" {
		t.Errorf("after clearing:\n%s", got)
	}
}

// TestActivityFailedLogins: failed logins close together, from any number
// of addresses, are one entry, so they can't push all else out of the log;
// apart, they're entries of their own.
func TestActivityFailedLogins(t *testing.T) {
	file := filepath.Join(t.TempDir(), "activity")
	now := time.Date(2026, 11, 4, 14, 0, 0, 0, time.UTC)
	a := newActivityLog(file, lifecycleClock{now: func() time.Time { return now }})
	a.add("login", "192.0.2.1", "logged in")
	for i := range 2000 {
		now = now.Add(5 * time.Second)
		a.failedLogin(fmt.Sprintf("198.51.100.%d", i%13), "Firefox on Linux")
	}
	got, total := a.list(0)
	if total != 2 || got[1].Text != "logged in" {
		t.Fatalf("%d entries: %+v", total, got[0])
	}
	want := "login failed 2000 times, the last at 16:46 UTC, from 198.51.100.0, 198.51.100.1, 198.51.100.2, 198.51.100.3, " +
		"198.51.100.4, 198.51.100.5, 198.51.100.6, 198.51.100.7, 198.51.100.8, 198.51.100.9, and 460 tries from other addresses"
	if got[0].Text != want || got[0].Count != 2000 {
		t.Errorf("merged: %q", got[0].Text)
	}
	// As kept, after a restart (its file written then, if not before).
	a.flush()
	if again, _ := newActivityLog(file, lifecycleClock{}).list(1); again[0].Text != want {
		t.Errorf("after a restart: %q", again[0].Text)
	}
	// Later, a new entry; and two merged from two addresses read so.
	now = now.Add(time.Hour)
	a.failedLogin("203.0.113.5", "")
	now = now.Add(time.Second)
	a.failedLogin("203.0.113.6", "")
	if got, total := a.list(1); total != 3 || got[0].Text != "login failed 2 times, the last at 17:46 UTC, from 203.0.113.5 and 203.0.113.6" {
		t.Errorf("later: %d, %q", total, got[0].Text)
	}
	// After a login, a new entry, so it's seen to come after it.
	now = now.Add(time.Second)
	a.add("login", "192.0.2.1", "logged in")
	now = now.Add(time.Second)
	a.failedLogin("203.0.113.5", "")
	if got, total := a.list(2); total != 5 || got[0].Kind != "login-failed" || got[0].Count != 0 || got[1].Kind != "login" {
		t.Errorf("after a login: %d, %+v", total, got)
	}
	now = now.Add(time.Hour)
	a.failedLogin("203.0.113.7", "Safari on macOS")
	if got, _ := a.list(1); got[0].Text != "login failed with Safari on macOS" {
		t.Errorf("one alone: %q", got[0].Text)
	}
}
