package main

import (
	"bytes"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// openTTY opens a terminal tunnel for s, running a program that waits.
func openTTY(t *testing.T, srvURL string, s testSession) *tunnelClient {
	t.Helper()
	ctx := testCtx(t)
	tc := openSession(t, ctx, srvURL, s)
	if reply := tc.request(t, ctx, tunnelRequest{Type: "tty"}); reply["ok"] != true {
		t.Fatalf("tty: %v", reply)
	}
	return tc
}

func waitingTTY(t *testing.T) {
	old := ttyCommand
	ttyCommand = func() *exec.Cmd { return exec.Command("sh", "-c", "read x") }
	t.Cleanup(func() { ttyCommand = old })
}

// closedWith waits for the server to close tc, and returns how.
func closedWith(t *testing.T, tc *tunnelClient) (websocket.StatusCode, string) {
	t.Helper()
	for {
		if _, _, err := tc.read(testCtx(t)); err != nil {
			var ce websocket.CloseError
			if !errors.As(err, &ce) {
				t.Fatalf("not closed by the server: %v", err)
			}
			return ce.Code, ce.Reason
		}
	}
}

func TestLoginHistory(t *testing.T) {
	_, srv := newE2EServer(t)
	ctx := testCtx(t)
	first := login(t, ctx, srv.URL, code(-1))
	if len(first.logins) != 0 {
		t.Errorf("first login's history: %v", first.logins)
	}
	loginAt(t, ctx, wsURL(srv.URL), code(5))
	second := login(t, ctx, srv.URL, code(0))
	if h := second.logins; len(h) != 2 || h[0].OK || !h[1].OK || h[1].IP != "127.0.0.1" {
		t.Errorf("second login's history, newest first: %+v", h)
	}
}

func TestSessionIdle(t *testing.T) {
	g, srv := newE2EServer(t)
	g.sessionIdle = 200 * time.Millisecond
	waitingTTY(t)
	ctx := testCtx(t)

	// Unused, it ends.
	s := login(t, ctx, srv.URL, code(-1))
	time.Sleep(300 * time.Millisecond)
	if _, status := openSessionAt(t, ctx, wsURL(srv.URL), s); status != closeLogin {
		t.Errorf("idle session: status %d", status)
	}
	if n := g.liveSessions(); n != 0 {
		t.Errorf("%d live sessions", n)
	}

	// With a tunnel open, it doesn't; once that closes, it ends.
	s = login(t, ctx, srv.URL, code(0))
	tty := openTTY(t, srv.URL, s)
	time.Sleep(400 * time.Millisecond)
	if _, ok := g.sessionSecret(s.id); !ok {
		t.Fatal("session with a terminal open ended as idle")
	}
	tty.write(ctx, msgData, []byte("bye\n"))
	closedWith(t, tty)
	time.Sleep(400 * time.Millisecond)
	if _, ok := g.sessionSecret(s.id); ok {
		t.Error("session still live after its terminal closed and it sat idle")
	}
}

func TestSessionMax(t *testing.T) {
	g, srv := newE2EServer(t)
	g.sessionMax = 300 * time.Millisecond
	waitingTTY(t)
	tty := openTTY(t, srv.URL, login(t, testCtx(t), srv.URL, code(0)))
	start := time.Now()
	if code, reason := closedWith(t, tty); code != closeLogin || !strings.Contains(reason, "over") {
		t.Errorf("open terminal at the session's end: %d %q", code, reason)
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Errorf("closed %v after the session ended", d)
	}
}

// TestLogoutEverywhere checks that every session ends, and that their open
// tunnels close at once.
func TestLogoutEverywhere(t *testing.T) {
	g, srv := newE2EServer(t)
	waitingTTY(t)
	ctx := testCtx(t)
	mine := login(t, ctx, srv.URL, code(-1))
	theirs := login(t, ctx, srv.URL, code(0))
	tty := openTTY(t, srv.URL, theirs)
	// A download that's waiting for the browser to take more.
	os.WriteFile(filepath.Join(g.downloadsDir, "big.bin"), make([]byte, (fileWindow+2)*fileChunk), 0o644)
	download := openSession(t, ctx, srv.URL, theirs)
	if reply := download.request(t, ctx, tunnelRequest{Type: "file", Path: "big.bin"}); reply["ok"] != true {
		t.Fatalf("file: %v", reply)
	}
	download.read(ctx)

	reply := openSession(t, ctx, srv.URL, mine).request(t, ctx, tunnelRequest{Type: "sessions"})
	list, _ := reply["sessions"].([]any)
	if len(list) != 2 || list[0].(map[string]any)["current"] != true || list[1].(map[string]any)["open"] != float64(2) {
		t.Fatalf("sessions: %v", reply)
	}

	start := time.Now()
	if reply := openSession(t, ctx, srv.URL, mine).request(t, ctx, tunnelRequest{Type: "logout-all"}); reply["ok"] != true {
		t.Fatalf("logout-all: %v", reply)
	}
	if code, reason := closedWith(t, tty); code != closeLogin || reason != "Logged out everywhere." {
		t.Errorf("their terminal: %d %q", code, reason)
	}
	if code, reason := closedWith(t, download); code != closeLogin || reason != "Logged out everywhere." {
		t.Errorf("their download: %d %q", code, reason)
	}
	if d := time.Since(start); d > time.Second {
		t.Errorf("their terminal and download closed after %v", d)
	}
	for _, s := range []testSession{mine, theirs} {
		if _, status := openSessionAt(t, ctx, wsURL(srv.URL), s); status != closeLogin {
			t.Errorf("after logging out everywhere: status %d", status)
		}
	}
	if n := g.liveSessions(); n != 0 {
		t.Errorf("%d live sessions", n)
	}
}

// TestSessionUses checks that the addresses a session is used from are
// listed, the login's first.
func TestSessionUses(t *testing.T) {
	g := &server{}
	id, _, _ := g.newSession("198.51.100.1", "Firefox on Linux")
	for _, ip := range []string{"198.51.100.1", "203.0.113.9"} {
		detach, err := g.attach(id, ip, &tunnel{})
		if err != nil {
			t.Fatal(err)
		}
		detach()
	}
	for i := range maxSessionUses + 3 {
		detach, _ := g.attach(id, fmt.Sprintf("192.0.2.%d", i), &tunnel{})
		detach()
	}
	r := g.sessionsReport(id, nil)
	list := r["sessions"].([]sessionInfo)
	if len(list) != 1 || !list[0].Current || list[0].Open != 0 || list[0].Browser != "Firefox on Linux" {
		t.Fatalf("sessions: %+v", list)
	}
	uses := list[0].Uses
	if len(uses) != maxSessionUses || uses[0].IP != "198.51.100.1" {
		t.Errorf("uses: %+v", uses)
	}
	if logins := r["logins"].([]loginEvent); len(logins) != 1 || logins[0].IP != "198.51.100.1" || logins[0].Browser != "Firefox on Linux" || !logins[0].OK {
		t.Errorf("logins: %+v", logins)
	}
}

func TestBrowserName(t *testing.T) {
	for ua, want := range map[string]string{
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36":                   "Chrome on macOS",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0":           "Edge on Windows",
		"Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0":                                                                  "Firefox on Linux",
		"Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1": "Safari on iPhone",
		"Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1":       "Chrome on iPad",
		"Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36":                            "Chrome on Android",
		"Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36":                          "Chrome on ChromeOS",
		"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/130.0.0.0 Safari/537.36":                           "Chrome on Linux",
		"curl/8.5.0": "",
		"":           "",
	} {
		if got := browserName(ua); got != want {
			t.Errorf("%s: %q, want %q", ua, got, want)
		}
	}
}

func TestParseSessionLimit(t *testing.T) {
	for _, tc := range []struct {
		in     string
		zeroOK bool
		want   time.Duration
		ok     bool
	}{
		{"12h", false, 12 * time.Hour, true},
		{"90m", false, 90 * time.Minute, true},
		{"0", true, 0, true},
		{"0", false, 0, false},
		{"30s", true, 0, false},
		{"-1h", true, 0, false},
		{"soon", true, 0, false},
	} {
		got, err := parseSessionLimit(tc.in, tc.zeroOK)
		if (err == nil) != tc.ok || got != tc.want {
			t.Errorf("%q (zero ok %v): %v, %v", tc.in, tc.zeroOK, got, err)
		}
	}
}

func TestSessionTunnelLimit(t *testing.T) {
	g := &server{}
	id, _, _ := g.newSession("198.51.100.1", "")
	detaches := []func(){}
	for range maxSessionTunnels {
		detach, err := g.attach(id, "198.51.100.1", &tunnel{})
		if err != nil {
			t.Fatal(err)
		}
		detaches = append(detaches, detach)
	}
	if _, err := g.attach(id, "198.51.100.1", &tunnel{}); err != errTooManyTunnels {
		t.Fatalf("one too many: %v", err)
	}
	detaches[0]()
	if _, err := g.attach(id, "198.51.100.1", &tunnel{}); err != nil {
		t.Fatalf("after one closed: %v", err)
	}
}

// TestSessionBrowserCloses checks that a desktop the browser closes, or
// just drops, stops counting as open, so the session can go idle.
func TestSessionBrowserCloses(t *testing.T) {
	g, srv := newE2EServer(t)
	g.vncAddr = "unix:" + fakeXvncUnix(t)
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	open := func() int {
		return g.sessionsReport(s.id, nil)["sessions"].([]sessionInfo)[0].Open
	}
	for _, how := range []string{"close", "drop"} {
		desktop := openSession(t, ctx, srv.URL, s)
		if reply := desktop.request(t, ctx, tunnelRequest{Type: "vnc"}); reply["ok"] != true {
			t.Fatalf("vnc: %v", reply)
		}
		desktop.read(ctx) // the greeting
		if n := open(); n != 1 {
			t.Fatalf("%s: %d open with the desktop", how, n)
		}
		if how == "close" {
			desktop.c.Close(websocket.StatusNormalClosure, "")
		} else {
			desktop.c.CloseNow()
		}
		start := time.Now()
		for open() != 0 {
			if time.Since(start) > 6*time.Second {
				t.Fatalf("%s: still open after %v", how, time.Since(start))
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Logf("%s: detached after %v", how, time.Since(start).Round(time.Millisecond))
	}
}

// TestTTYMessageLimit checks that terminal tunnels take messages up to
// maxTTYMessage, not the desktop's larger limit.
func TestTTYMessageLimit(t *testing.T) {
	_, srv := newE2EServer(t)
	waitingTTY(t)
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	resize := func(size int) []byte {
		m := []byte(`{"type":"resize","cols":80,"rows":24}`)
		return append(m, bytes.Repeat([]byte(" "), size-len(m))...)
	}

	tty := openTTY(t, srv.URL, s)
	tty.write(ctx, msgText, resize(maxTTYMessage))
	tty.write(ctx, msgData, []byte("bye\n"))
	if code, reason := closedWith(t, tty); code != websocket.StatusNormalClosure {
		t.Errorf("at the limit: %d %q", code, reason)
	}

	tty = openTTY(t, srv.URL, s)
	tty.write(ctx, msgText, resize(maxTTYMessage+1))
	if code, reason := closedWith(t, tty); code != websocket.StatusMessageTooBig {
		t.Errorf("over the limit: %d %q", code, reason)
	}
}

// TestTTYStalledClient checks that a terminal whose client stops reading
// is closed once a write has waited tunnelWriteTimeout.
func TestTTYStalledClient(t *testing.T) {
	g, srv := newE2EServer(t)
	old := tunnelWriteTimeout
	tunnelWriteTimeout = 200 * time.Millisecond
	t.Cleanup(func() { tunnelWriteTimeout = old })
	oldCmd := ttyCommand
	ttyCommand = func() *exec.Cmd { return exec.Command("yes") }
	t.Cleanup(func() { ttyCommand = oldCmd })

	openTTY(t, srv.URL, login(t, testCtx(t), srv.URL, code(0))) // and never read
	start := time.Now()
	for {
		g.mu.Lock()
		n := len(g.ttys)
		g.mu.Unlock()
		if n == 0 {
			break
		}
		if time.Since(start) > 10*time.Second {
			t.Fatal("the terminal is still open")
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Logf("closed after %v", time.Since(start).Round(time.Millisecond))
}

// TestHandshakeLimit checks that tunnels that never send their hello are
// limited per address, and that one that does stops counting.
func TestHandshakeLimit(t *testing.T) {
	_, srv := newE2EServer(t)
	ctx := testCtx(t)
	for i := range maxHandshakesPerIP {
		c, _, err := websocket.Dial(ctx, wsURL(srv.URL), nil)
		if err != nil {
			t.Fatalf("tunnel %d: %v", i+1, err)
		}
		defer c.CloseNow()
	}
	_, resp, err := websocket.Dial(ctx, wsURL(srv.URL), nil)
	if err == nil || resp == nil || resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("one too many: %v", err)
	}
}

func TestHandshakeCount(t *testing.T) {
	g := &server{}
	var done []func()
	for range maxHandshakesPerIP {
		f, ok := g.handshakes.start("192.0.2.1")
		if !ok {
			t.Fatal("refused")
		}
		done = append(done, f)
	}
	if _, ok := g.handshakes.start("192.0.2.1"); ok {
		t.Fatal("one too many from an address")
	}
	if _, ok := g.handshakes.start("192.0.2.2"); !ok {
		t.Fatal("another address refused")
	}
	done[0]()
	done[0]() // twice is once
	if _, ok := g.handshakes.start("192.0.2.1"); !ok {
		t.Fatal("refused after one finished")
	}
	if _, ok := g.handshakes.start("192.0.2.1"); ok {
		t.Fatal("a second call freed two")
	}
}

func TestHandshakeTotal(t *testing.T) {
	var h handshakes
	for i := range maxHandshakes {
		if _, ok := h.start(fmt.Sprint("ip", i)); !ok {
			t.Fatalf("handshake %d refused", i+1)
		}
	}
	if _, ok := h.start("another"); ok {
		t.Fatal("one too many in all")
	}
}

func TestEndSessionByHandle(t *testing.T) {
	g, srv := newE2EServer(t)
	waitingTTY(t)
	ctx := testCtx(t)
	mine := login(t, ctx, srv.URL, code(0))
	theirs := login(t, ctx, srv.URL, code(1))
	open := openTTY(t, srv.URL, theirs)

	r := openSession(t, ctx, srv.URL, mine).request(t, ctx, tunnelRequest{Type: "sessions"})
	handles := map[bool]string{}
	for _, s := range r["sessions"].([]any) {
		s := s.(map[string]any)
		handles[s["current"].(bool)], _ = s["handle"].(string)
	}
	if handles[true] == "" || handles[false] == "" || strings.Contains(handles[false], theirs.id) {
		t.Fatalf("handles %v", handles)
	}
	for _, h := range []string{handles[true], "nope"} {
		if reply := openSession(t, ctx, srv.URL, mine).request(t, ctx, tunnelRequest{Type: "end-session", Name: h}); reply["error"] == nil {
			t.Errorf("ended %q: %v", h, reply)
		}
	}
	if reply := openSession(t, ctx, srv.URL, mine).request(t, ctx, tunnelRequest{Type: "end-session", Name: handles[false]}); reply["ok"] != true {
		t.Fatalf("end-session: %v", reply)
	}
	if code, _ := closedWith(t, open); code != closeLogin {
		t.Errorf("the ended session's terminal closed with %d", code)
	}
	if _, ok := g.sessionSecret(theirs.id); ok {
		t.Error("the other session is still live")
	}
	if _, ok := g.sessionSecret(mine.id); !ok {
		t.Error("this session ended too")
	}
}
