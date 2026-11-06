package main

// The browser terminal at /tty/: ghostty-web (Ghostty's terminal emulator,
// compiled to WebAssembly) in the page, a PTY running tmux on the server,
// connected through the tunnel. Every tab attaches to the same tmux session
// ("web"), so shells keep running when a tab is closed and the next tab
// picks them up. With -tty-command, each tab runs that command instead,
// as ssh to another machine, without tmux: it ends when its tab closes,
// and there's no tmux history to search.

import (
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/exec"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/coder/websocket"
)

const (
	ttyPrefix = "/tty/"
	// An empty module ghostty-web imports, only to read its WebAssembly from
	// disk outside a browser; served so the import doesn't fail.
	ghosttyStub = "__vite-browser-external-2447137e.js"
	// Largest message from the page: a paste.
	maxTTYMessage = 1 << 20
	// Terminals open at once per session, so one login can't start
	// processes without limit.
	maxTTYs = 5
	// ghostty-web carries its WebAssembly as a data: URL, which it fetches
	// and compiles, and styles its elements inline.
	ttyCSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' data:; " +
		"style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action 'none'; frame-ancestors 'none'"
)

//go:embed tty.html tty.js
var ttyFiles embed.FS

// ttyCommand starts the terminal's program: tmux, or with command, that
// instead, run with the user's shell; a variable so tests can swap it.
var ttyCommand = func(command string) *exec.Cmd {
	if command == "" {
		return exec.Command("tmux", "new-session", "-A", "-s", "web")
	}
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	return exec.Command(shell, "-c", command)
}

// tmuxCommand runs a command for the terminal's tmux session, as searching
// does; a variable so tests can swap it.
var tmuxCommand = func(ctx context.Context, args ...string) *exec.Cmd { return exec.CommandContext(ctx, "tmux", args...) }

// tty serves the terminal page and its files. They need no session, since
// they hold nothing private: the page logs in through the tunnel, and the
// terminal only runs through it.
func (g *server) tty(w http.ResponseWriter, r *http.Request) {
	if g.termDir == "" {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	h := w.Header()
	h.Set("Cache-Control", "no-store, no-transform")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	g.ttyFile(w, r, strings.TrimPrefix(r.URL.Path, ttyPrefix))
}

// ttyAssets are the terminal page's files from -term-dir, which browsers
// keep (see assetSet).
var ttyAssets = []string{"ghostty-web.js", ghosttyStub, ttyFontRegular, ttyFontBold}

// The terminal's own font, JetBrains Mono Nerd Font (see the Dockerfile).
const (
	ttyFontRegular = "JetBrainsMonoNerdFont-Regular.woff2"
	ttyFontBold    = "JetBrainsMonoNerdFont-Bold.woff2"
)

// ttyPath is where ttyAssets are served, under /tty/.
func (g *server) ttyPath() string { return g.ttyFiles.path(g.termAssets()) }

func (g *server) termAssets() assets { return assets{"ghostty", g.termDir, ttyAssets} }

// ttyFile serves the terminal page and its files. The page and tty.js are
// small, and sent afresh each time with their references pointing at
// ttyPath; the big files there are cached.
func (g *server) ttyFile(w http.ResponseWriter, r *http.Request, name string) {
	switch {
	case name == "":
		w.Header().Set("Content-Security-Policy", ttyCSP)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		page, _ := ttyFiles.ReadFile("tty.html")
		for _, font := range []string{ttyFontRegular, ttyFontBold} {
			page = bytes.ReplaceAll(page, []byte(`url("`+font+`")`), []byte(`url("`+g.ttyPath()+`/`+font+`")`))
		}
		w.Write(page)
	case name == "tty.js":
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		js, _ := ttyFiles.ReadFile("tty.js")
		w.Write(bytes.ReplaceAll(js, []byte(`"./ghostty-web.js"`), []byte(`"./`+g.ttyPath()+`/ghostty-web.js"`)))
	case g.ttyFiles.serve(w, r, g.termAssets(), name):
	default:
		http.NotFound(w, r)
	}
}

// ttyMessage is a control message from the page; terminal input arrives as
// binary messages instead.
type ttyMessage struct {
	Type string `json:"type"` // resize or search
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
	// search: find the newest Text, then older or newer matches, or stop
	Do   string `json:"do"`
	Text string `json:"text"`
}

// The longest text a search looks for, in bytes.
const maxSearch = 256

// searchTerminal searches tmux's history for the page, with its copy
// mode, which marks the match and shows how many there are: "find" looks
// for m.Text from the newest output back, "older" and "newer" go to the
// next match either way, and "stop" leaves copy mode.
func searchTerminal(m ttyMessage) {
	t := []string{"-t", "web"}
	var args []string
	switch m.Do {
	case "find":
		if m.Text == "" || len(m.Text) > maxSearch || !utf8.ValidString(m.Text) || strings.ContainsFunc(m.Text, unicode.IsControl) {
			return
		}
		// tmux takes an argument ending in ";" as the end of a command,
		// unless the ";" has a backslash before it.
		text := m.Text
		if strings.HasSuffix(text, ";") {
			text = strings.TrimSuffix(text, ";") + `\;`
		}
		args = slices.Concat([]string{"copy-mode"}, t, []string{";", "send-keys"}, t, []string{"-X", "history-bottom", ";", "send-keys"}, t,
			[]string{"-X", "search-backward-text", text})
	case "older":
		args = slices.Concat([]string{"send-keys"}, t, []string{"-X", "search-again"})
	case "newer":
		args = slices.Concat([]string{"send-keys"}, t, []string{"-X", "search-reverse"})
	case "stop":
		args = slices.Concat([]string{"send-keys"}, t, []string{"-X", "cancel"})
	default:
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	tmuxCommand(ctx, args...).Run() // one that finds nothing, or isn't in copy mode, fails quietly
}

// serveTTY runs a terminal over the tunnel c until either side ends it or
// token's session does. Input arrives as data messages, and resizes as JSON
// text messages.
func (g *server) serveTTY(c msgConn, token, ip string) {
	process, err := startTerminal(g.ttyCommand)
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
			n, err := process.Read(buf)
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

	for {
		typ, data, err := c.Read(context.Background())
		if err != nil {
			break
		}
		if typ == websocket.MessageBinary {
			if _, err := process.Write(data); err != nil {
				break
			}
			continue
		}
		var m ttyMessage
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		switch {
		case m.Type == "resize" && m.Cols > 0 && m.Cols <= 1000 && m.Rows > 0 && m.Rows <= 1000:
			process.Resize(m.Cols, m.Rows)
		case m.Type == "search" && g.ttyCommand == "":
			searchTerminal(m)
		}
	}

	// Closing the PTY hangs up tmux's client, which detaches; the tmux
	// session and its shells keep running for the next tab.
	cancel()
	process.Close()
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
