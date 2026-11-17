package main

// Remote tmux uses an interactive OpenSSH master for authentication and
// rendering, and noninteractive multiplexed channels for history search.
// Each terminal owns its socket; credentials never pass through a helper.
import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var remoteTTYHost = regexp.MustCompile(`^[a-zA-Z0-9_@.:%+\[\]-]+$`)
var remoteTTYSession = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)

func validateRemoteTTY(c *serverConfig) error {
	if c.ttyTmuxHost == "" {
		if c.ttyTmuxSession != "" {
			return errors.New("-tty-tmux-session requires -tty-tmux-host")
		}
		return nil
	}
	if strings.HasPrefix(c.ttyTmuxHost, "-") || !remoteTTYHost.MatchString(c.ttyTmuxHost) {
		return errors.New("-tty-tmux-host must be an SSH hostname, user@host, or SSH config alias")
	}
	if c.ttyTmuxSession == "" {
		c.ttyTmuxSession = "tabtop"
	}
	if !remoteTTYSession.MatchString(c.ttyTmuxSession) {
		return errors.New("-tty-tmux-session must contain 1–64 letters, digits, underscores or hyphens")
	}
	return nil
}

func shellArgument(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }

type remoteTerminal struct {
	sshCommand             func(context.Context, ...string) *exec.Cmd
	host, session, command string
	dir, socket, remoteDir string
}

func newRemoteTerminal(c serverConfig) (*remoteTerminal, error) {
	if err := validateRemoteTTY(&c); err != nil {
		return nil, err
	}
	dir, err := os.MkdirTemp("", "ttmux-")
	if err != nil {
		return nil, err
	}
	r := &remoteTerminal{sshCommand: remoteSSHCommand, host: c.ttyTmuxHost, session: c.ttyTmuxSession, command: c.ttyCommand, dir: dir, socket: filepath.Join(dir, "ssh"), remoteDir: "/tmp/tabtop-tty-" + newToken()}
	if len(r.socket) > 100 {
		os.RemoveAll(dir)
		return nil, errors.New("temporary directory path is too long for an SSH control socket")
	}
	return r, nil
}

// The remote shell records its actual PTY out of band before attaching.
// A private random directory prevents another user from substituting it.
// The shell remains as parent so it removes the record when SSH detaches.
func (r *remoteTerminal) startup() string {
	attach := "tmux new-session -A -s " + shellArgument(r.session)
	if r.command != "" {
		attach += " " + shellArgument(r.command)
	}
	return "umask 077; d=" + shellArgument(r.remoteDir) + "; mkdir \"$d\" || exit; " +
		"trap 'rm -f \"$d/tty\"; rmdir \"$d\" 2>/dev/null' EXIT; " +
		"trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM; " +
		"tty > \"$d/tty\" || exit; " + attach
}

var remoteSSHCommand = func(ctx context.Context, args ...string) *exec.Cmd { return exec.CommandContext(ctx, "ssh", args...) }

func (r *remoteTerminal) interactive() *exec.Cmd {
	return r.sshCommand(context.Background(), "-tt", "-o", "RemoteCommand=none", "-o", "BatchMode=no", "-o", "ControlMaster=yes", "-o", "ControlPersist=no", "-o", "ControlPath="+r.socket, "--", r.host, "sh -c "+shellArgument(r.startup()))
}

func (r *remoteTerminal) control(ctx context.Context, script string) *exec.Cmd {
	// ProxyCommand=false makes fallback fail closed if the master disappears:
	// no separate connection, agent authentication, or invisible TOTP prompt.
	return r.sshCommand(ctx, "-T", "-o", "RemoteCommand=none", "-S", r.socket, "-o", "ControlMaster=no", "-o", "BatchMode=yes", "-o", "ProxyCommand=false", "-o", "ClearAllForwardings=yes", "--", r.host, "sh -c "+shellArgument(script))
}

// Find the active pane for THIS client, not the most recently attached
// client in the session. Switching panes is reflected on every request.
func (r *remoteTerminal) panePrelude() string {
	return "tty=$(cat " + shellArgument(r.remoteDir+"/tty") + ") || exit 1; " +
		"pane=$(tmux list-clients -F '#{client_tty} #{pane_id}' | while read -r t p; do " +
		"if [ \"$t\" = \"$tty\" ]; then printf '%s\\n' \"$p\"; break; fi; done); " +
		"case \"$pane\" in %*) ;; *) exit 1;; esac; n=${pane#%}; case \"$n\" in ''|*[!0-9]*) exit 1;; esac; "
}

// Capture only bounded control output. Remote banners must not turn into
// unbounded memory allocations (or accidentally enter the terminal stream).
type ttyControlOutput struct{ bytes.Buffer }

func (b *ttyControlOutput) Write(p []byte) (int, error) {
	n := len(p)
	if b.Len()+n > 4096 {
		return 0, errors.New("remote tmux control output is too large")
	}
	return b.Buffer.Write(p)
}
func (r *remoteTerminal) run(ctx context.Context, script string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	cmd := r.control(ctx, script)
	var out ttyControlOutput
	cmd.Stdout = &out
	cmd.WaitDelay = 250 * time.Millisecond
	err := cmd.Run()
	return out.String(), err
}
func (r *remoteTerminal) ready(ctx context.Context) bool {
	if _, err := os.Stat(r.socket); err != nil {
		return false
	}
	out, err := r.run(ctx, r.panePrelude()+"printf 'tabtop-ready\\n'")
	return err == nil && strings.TrimSpace(out) == "tabtop-ready"
}
func (r *remoteTerminal) search(ctx context.Context, m ttyMessage) error {
	args := tmuxSearchArgs(m, "REMOTE_PANE")
	if len(args) == 0 {
		return nil
	}
	parts := []string{"exec tmux"}
	for i, arg := range args {
		if i > 0 && args[i-1] == "-t" {
			parts = append(parts, "\"$pane\"")
		} else {
			parts = append(parts, shellArgument(arg))
		}
	}
	_, err := r.run(ctx, r.panePrelude()+strings.Join(parts, " "))
	return err
}
func (r *remoteTerminal) close() {
	// Best effort cleanup while the authenticated master is still alive.
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	r.run(ctx, "rm -f "+shellArgument(r.remoteDir+"/tty")+"; rmdir "+shellArgument(r.remoteDir)+" 2>/dev/null")
}

func (g *server) startTTY() (*terminalProcess, *remoteTerminal, error) {
	if g.ttyTmuxHost == "" {
		p, err := startTerminal(g.ttyCommand)
		return p, nil, err
	}
	r, err := newRemoteTerminal(g.serverConfig)
	if err != nil {
		return nil, nil, err
	}
	cmd := r.interactive()
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor")
	if home, err := os.UserHomeDir(); err == nil {
		cmd.Dir = home
	}
	p, err := startTerminalProcess(cmd)
	if err != nil {
		os.RemoveAll(r.dir)
		return nil, nil, fmt.Errorf("remote tmux: %w", err)
	}
	return p, r, nil
}
