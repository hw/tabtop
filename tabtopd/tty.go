package main

// The browser terminal at /tty/: xterm.js in the page, a PTY running tmux
// on the server. It uses the downloads login and session. Every tab attaches
// to the same tmux session ("web"), so shells keep running when a tab is
// closed and the next tab picks them up.

import (
	"context"
	"embed"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/creack/pty"
)

const (
	ttyPrefix = "/tty/"
	// Terminals open at once per session, so one login can't start
	// processes without limit.
	maxTTYs = 5
	// How often an open terminal checks that its session is still valid, so
	// logging out or the session expiring closes it soon after.
	ttySessionCheck = 5 * time.Second
	// xterm.js styles its rows and cursor with inline styles.
	ttyCSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
		"form-action 'self'; frame-ancestors 'none'"
)

//go:embed tty.html tty.js
var ttyFiles embed.FS

// ttyCommand starts the terminal's program; a variable so tests can swap it.
var ttyCommand = func() *exec.Cmd { return exec.Command("tmux", "new-session", "-A", "-s", "web") }

func (g *server) tty(w http.ResponseWriter, r *http.Request) {
	if g.xtermDir == "" {
		http.NotFound(w, r)
		return
	}
	h := w.Header()
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")

	name := strings.TrimPrefix(r.URL.Path, ttyPrefix)
	switch r.Method {
	case http.MethodPost:
		if name != "" {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		g.login(w, r)
		return
	case http.MethodGet, http.MethodHead:
	default:
		h.Set("Allow", "GET, HEAD, POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !g.sessionOK(r) {
		if name == "" {
			g.loginPage(w, r.URL.Path, "", http.StatusUnauthorized)
		} else {
			http.Error(w, "log in first", http.StatusUnauthorized)
		}
		return
	}

	switch name {
	case "":
		h.Set("Content-Security-Policy", ttyCSP)
		http.ServeFileFS(w, r, ttyFiles, "tty.html")
	case "tty.js":
		http.ServeFileFS(w, r, ttyFiles, "tty.js")
	case "xterm.mjs", "xterm.css", "addon-fit.mjs", "addon-clipboard.mjs":
		http.ServeFileFS(w, r, os.DirFS(g.xtermDir), name)
	case "PowerlineSymbols.otf":
		// Not in Go's or Debian's MIME tables; nosniff needs the right type.
		h.Set("Content-Type", "font/otf")
		http.ServeFileFS(w, r, os.DirFS(g.xtermDir), name)
	case "ws":
		g.ttyWS(w, r)
	default:
		http.NotFound(w, r)
	}
}

// ttyMessage is a control message from the page; terminal input arrives as
// binary messages instead.
type ttyMessage struct {
	Type string `json:"type"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
}

// ttyWS connects the WebSocket to a new PTY. Output goes out as binary
// messages; input comes in as binary messages, and resizes as JSON text
// messages. Accept rejects cross-origin requests, so another site can't
// open a terminal with the visitor's session cookie.
func (g *server) ttyWS(w http.ResponseWriter, r *http.Request) {
	token, ip := sessionToken(r), g.clientIP(r)
	if !g.openTTY(token) {
		http.Error(w, "too many open terminals", http.StatusTooManyRequests)
		return
	}
	defer g.closeTTY(token)
	c, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer c.CloseNow()
	c.SetReadLimit(1 << 20)

	cmd := ttyCommand()
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor")
	if home, err := os.UserHomeDir(); err == nil {
		cmd.Dir = home
	}
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: 80, Rows: 24})
	if err != nil {
		log.Printf("terminal for %s: %v", ip, err)
		c.Close(websocket.StatusInternalError, "cannot start the terminal")
		return
	}
	log.Printf("terminal from %s opened", ip)
	// Canceling a read's context would drop the WebSocket without a close
	// message, so reads use none; closing the WebSocket ends them instead.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go func() {
		buf := make([]byte, 32<<10)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 && c.Write(ctx, websocket.MessageBinary, buf[:n]) != nil {
				return
			}
			if err != nil {
				// The program exited (or the PTY was closed).
				c.Close(websocket.StatusNormalClosure, "terminal closed")
				return
			}
		}
	}()
	go func() {
		t := time.NewTicker(ttySessionCheck)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if !g.sessionValid(token) {
					c.Close(websocket.StatusPolicyViolation, "logged out")
					return
				}
			}
		}
	}()

	for {
		typ, data, err := c.Read(context.Background())
		if err != nil {
			break
		}
		if typ == websocket.MessageBinary {
			if _, err := ptmx.Write(data); err != nil {
				break
			}
			continue
		}
		var m ttyMessage
		if json.Unmarshal(data, &m) == nil && m.Type == "resize" &&
			m.Cols > 0 && m.Cols <= 1000 && m.Rows > 0 && m.Rows <= 1000 {
			pty.Setsize(ptmx, &pty.Winsize{Cols: uint16(m.Cols), Rows: uint16(m.Rows)})
		}
	}

	// Closing the PTY hangs up tmux's client, which detaches; the tmux
	// session and its shells keep running for the next tab.
	cancel()
	ptmx.Close()
	exited := make(chan struct{})
	go func() { cmd.Wait(); close(exited) }()
	select {
	case <-exited:
	case <-time.After(2 * time.Second):
		cmd.Process.Kill()
		<-exited
	}
	c.Close(websocket.StatusNormalClosure, "terminal closed") // no-op if already closed
	log.Printf("terminal from %s closed", ip)
}

func (g *server) openTTY(token string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.ttys[token] >= maxTTYs {
		return false
	}
	g.ttys[token]++
	return true
}

func (g *server) closeTTY(token string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.ttys[token]--; g.ttys[token] <= 0 {
		delete(g.ttys, token)
	}
}
