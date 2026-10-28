package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func newTTYTestServer(t *testing.T) (*server, *httptest.Server) {
	t.Helper()
	dir := t.TempDir()
	for _, name := range []string{"xterm.mjs", "addon-clipboard.mjs", "PowerlineSymbols.otf"} {
		os.WriteFile(filepath.Join(dir, name), []byte("export {}"), 0o644)
	}
	g := &server{base: "/", sessions: map[string]time.Time{}, failures: map[string][]time.Time{},
		pending: map[string]int{}, ttys: map[string]int{}, xtermDir: dir}
	srv := httptest.NewServer(http.HandlerFunc(g.tty))
	t.Cleanup(srv.Close)
	return g, srv
}

func get(t *testing.T, url, token string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest("GET", url, nil)
	if token != "" {
		req.AddCookie(&http.Cookie{Name: cookieName, Value: token})
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp
}

func TestTTYNeedsSession(t *testing.T) {
	_, srv := newTTYTestServer(t)
	for _, p := range []string{"/tty/", "/tty/ws", "/tty/xterm.mjs"} {
		if resp := get(t, srv.URL+p, "bogus"); resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s without a session: status %d, want 401", p, resp.StatusCode)
		}
	}
}

func TestTTYOff(t *testing.T) {
	g, srv := newTTYTestServer(t)
	g.xtermDir = ""
	if resp := get(t, srv.URL+"/tty/", g.newSession()); resp.StatusCode != http.StatusNotFound {
		t.Errorf("status %d, want 404", resp.StatusCode)
	}
}

func TestTTYPage(t *testing.T) {
	g, srv := newTTYTestServer(t)
	token := g.newSession()
	resp := get(t, srv.URL+"/tty/", token)
	if resp.StatusCode != http.StatusOK || !strings.Contains(resp.Header.Get("Content-Security-Policy"), "default-src 'self'") {
		t.Errorf("page: status %d, CSP %q", resp.StatusCode, resp.Header.Get("Content-Security-Policy"))
	}
	for p, want := range map[string]int{"/tty/tty.js": 200, "/tty/xterm.mjs": 200, "/tty/addon-clipboard.mjs": 200,
		"/tty/PowerlineSymbols.otf": 200, "/tty/../main.go": 404, "/tty/other": 404} {
		if resp := get(t, srv.URL+p, token); resp.StatusCode != want {
			t.Errorf("%s: status %d, want %d", p, resp.StatusCode, want)
		}
	}
	if resp := get(t, srv.URL+"/tty/PowerlineSymbols.otf", token); resp.Header.Get("Content-Type") != "font/otf" {
		t.Errorf("font Content-Type %q, want font/otf", resp.Header.Get("Content-Type"))
	}
}

// TestTTYSession runs a shell script in the PTY instead of tmux: it waits
// for a line of input, then reports the terminal size.
func TestTTYSession(t *testing.T) {
	g, srv := newTTYTestServer(t)
	old := ttyCommand
	ttyCommand = func() *exec.Cmd {
		return exec.Command("sh", "-c", "stty -echo; echo ready; read x; stty size; echo got $x")
	}
	t.Cleanup(func() { ttyCommand = old })

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	h := http.Header{}
	h.Set("Cookie", cookieName+"="+g.newSession())
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/tty/ws", &websocket.DialOptions{HTTPHeader: h})
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()

	var out strings.Builder
	readUntil := func(want string) {
		t.Helper()
		for !strings.Contains(out.String(), want) {
			_, data, err := c.Read(ctx)
			if err != nil {
				t.Fatalf("waiting for %q, got %q: %v", want, out.String(), err)
			}
			out.Write(data)
		}
	}
	readUntil("ready")
	c.Write(ctx, websocket.MessageText, []byte(`{"type":"resize","cols":100,"rows":30}`))
	c.Write(ctx, websocket.MessageText, []byte(`{"type":"resize","cols":0,"rows":99999}`)) // ignored
	c.Write(ctx, websocket.MessageBinary, []byte("hello\r"))
	readUntil("got hello")
	if !strings.Contains(out.String(), "30 100") {
		t.Errorf("terminal size not applied: %q", out.String())
	}
	// The program exiting closes the WebSocket.
	if _, _, err := c.Read(ctx); websocket.CloseStatus(err) != websocket.StatusNormalClosure {
		t.Errorf("after exit: %v, want a normal close", err)
	}
}

func TestTTYLimit(t *testing.T) {
	g, _ := newTTYTestServer(t)
	for i := range maxTTYs {
		if !g.openTTY("a") {
			t.Fatalf("terminal %d refused", i+1)
		}
	}
	if g.openTTY("a") {
		t.Error("terminal over the limit allowed")
	}
	if !g.openTTY("b") {
		t.Error("another session's terminal refused")
	}
	g.closeTTY("a")
	if !g.openTTY("a") {
		t.Error("terminal refused after one closed")
	}
}
