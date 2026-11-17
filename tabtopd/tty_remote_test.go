package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/creack/pty"
	ssh "golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

func TestRemoteTTYConfig(t *testing.T) {
	c := serverConfig{ttyTmuxHost: "alice@server"}
	if err := validateRemoteTTY(&c); err != nil || c.ttyTmuxSession != "tabtop" {
		t.Fatalf("default: %+v %v", c, err)
	}
	for _, host := range []string{"server-alias", "alice@host.example", "alice@[::1]"} {
		c = serverConfig{ttyTmuxHost: host, ttyTmuxSession: "monitor-1"}
		if err := validateRemoteTTY(&c); err != nil {
			t.Fatal(err)
		}
	}
	for _, c := range []serverConfig{{ttyTmuxSession: "unused"}, {ttyTmuxHost: "-oProxyCommand=evil"}, {ttyTmuxHost: "host\ncommand"}, {ttyTmuxHost: "host", ttyTmuxSession: "a:b"}, {ttyTmuxHost: "host", ttyTmuxSession: "a.b"}} {
		if validateRemoteTTY(&c) == nil {
			t.Fatalf("accepted %+v", c)
		}
	}
}

func TestRemoteTTYControlFailsClosed(t *testing.T) {
	r, err := newRemoteTerminal(serverConfig{ttyTmuxHost: "invalid.example"})
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(r.dir)
	cmd := r.control(context.Background(), "echo unexpected")
	args := strings.Join(cmd.Args, " ")
	for _, s := range []string{"BatchMode=yes", "ProxyCommand=false", "ControlMaster=no", "ClearAllForwardings=yes"} {
		if !strings.Contains(args, s) {
			t.Fatal(args)
		}
	}
	if _, err := r.run(context.Background(), "echo unexpected"); err == nil {
		t.Fatal("control connected without master")
	}
	info, err := os.Stat(r.dir)
	if err != nil || info.Mode().Perm() != 0700 {
		t.Fatal("control directory permissions", err)
	}
}

func TestRemoteTTYCommandQuoting(t *testing.T) {
	r := &remoteTerminal{session: "monitor", remoteDir: "/tmp/tabtop-tty-test", command: "printf '%s\\n' \"$HOME\"; htop"}
	if !strings.Contains(r.startup(), shellArgument(r.command)) {
		t.Fatal(r.startup())
	}
	// Shell quoting must round-trip text without executing metacharacters.
	text := `it's; $(touch /tmp/tabtop-should-not-exist) "quoted"`
	out, err := exec.Command("sh", "-c", "printf '%s' "+shellArgument(text)).Output()
	if err != nil || string(out) != text {
		t.Fatalf("quote: %s %v", out, err)
	}
}

// A real OpenSSH client against a test SSH server requiring TWO interactive
// answers. The remote runs real PTYs and tmux, isolated from the user's server.
// No password/OTP is provided by an environment variable or identity file.
type remoteTTYTestSSH struct {
	auths       atomic.Int32
	connections atomic.Int32
	config      string
	socketDir   string
}

func newRemoteTTYTestSSH(t *testing.T) *remoteTTYTestSSH {
	t.Helper()
	for _, name := range []string{"ssh", "tmux"} {
		if _, err := exec.LookPath(name); err != nil {
			t.Skip(name + " not installed")
		}
	}
	root, err := os.MkdirTemp("", "ttest-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		exec.Command("tmux", "-S", filepath.Join(root, fmt.Sprintf("tmux-%d", os.Getuid()), "default"), "kill-server").Run()
		os.RemoveAll(root)
	})
	state := &remoteTTYTestSSH{socketDir: root}
	_, key, _ := ed25519.GenerateKey(rand.Reader)
	signer, _ := ssh.NewSignerFromKey(key)
	cfg := &ssh.ServerConfig{KeyboardInteractiveCallback: func(_ ssh.ConnMetadata, challenge ssh.KeyboardInteractiveChallenge) (*ssh.Permissions, error) {
		state.auths.Add(1)
		answers, err := challenge("", "", []string{"Password:", "Verification code:"}, []bool{false, false})
		if err != nil || len(answers) != 2 || answers[0] != "test-password" || answers[1] != "123456" {
			return nil, fmt.Errorf("interactive authentication rejected")
		}
		return nil, nil
	}}
	cfg.AddHostKey(signer)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	conns := map[net.Conn]bool{}
	t.Cleanup(func() {
		listener.Close()
		mu.Lock()
		defer mu.Unlock()
		for c := range conns {
			c.Close()
		}
	})
	go func() {
		for {
			raw, err := listener.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			conns[raw] = true
			mu.Unlock()
			go func() {
				defer func() { raw.Close(); mu.Lock(); delete(conns, raw); mu.Unlock() }()
				conn, chans, requests, err := ssh.NewServerConn(raw, cfg)
				if err != nil {
					return
				}
				defer conn.Close()
				state.connections.Add(1)
				go ssh.DiscardRequests(requests)
				for channel := range chans {
					if channel.ChannelType() != "session" {
						channel.Reject(ssh.UnknownChannelType, "session only")
						continue
					}
					ch, reqs, err := channel.Accept()
					if err != nil {
						continue
					}
					go serveRemoteTTYTestChannel(ch, reqs, root)
				}
			}()
		}
	}()
	port := listener.Addr().(*net.TCPAddr).Port
	known := filepath.Join(root, "known_hosts")
	os.WriteFile(known, []byte(knownhosts.Line([]string{fmt.Sprintf("[127.0.0.1]:%d", port)}, signer.PublicKey())+"\n"), 0600)
	state.config = filepath.Join(root, "ssh_config")
	os.WriteFile(state.config, []byte(fmt.Sprintf("Host tabtop-test\n HostName 127.0.0.1\n Port %d\n User test\n UserKnownHostsFile %s\n StrictHostKeyChecking yes\n PreferredAuthentications keyboard-interactive\n PubkeyAuthentication no\n KbdInteractiveAuthentication yes\n RemoteCommand false\n", port, known)), 0600)
	old := remoteSSHCommand
	remoteSSHCommand = func(ctx context.Context, args ...string) *exec.Cmd {
		return exec.CommandContext(ctx, "ssh", append([]string{"-F", state.config}, args...)...)
	}
	t.Cleanup(func() { remoteSSHCommand = old })
	return state
}
func serveRemoteTTYTestChannel(ch ssh.Channel, reqs <-chan *ssh.Request, root string) {
	defer ch.Close()
	var size *pty.Winsize
	for req := range reqs {
		switch req.Type {
		case "pty-req":
			var p struct {
				Term                      string
				Cols, Rows, Width, Height uint32
				Modes                     string
			}
			ssh.Unmarshal(req.Payload, &p)
			size = &pty.Winsize{Cols: uint16(p.Cols), Rows: uint16(p.Rows)}
			req.Reply(true, nil)
		case "env":
			req.Reply(true, nil)
		case "exec":
			var p struct{ Command string }
			if ssh.Unmarshal(req.Payload, &p) != nil {
				req.Reply(false, nil)
				return
			}
			req.Reply(true, nil)
			cmd := exec.Command("sh", "-c", p.Command)
			// TMUX_TMPDIR puts its socket in tmux-<uid>/default below root.
			env := []string{}
			for _, v := range os.Environ() {
				if !strings.HasPrefix(v, "TMUX=") && !strings.HasPrefix(v, "TMUX_PANE=") {
					env = append(env, v)
				}
			}
			cmd.Env = append(env, "TERM=xterm-256color", "TMUX_TMPDIR="+root)
			status := uint32(0)
			if size != nil {
				pt, err := pty.StartWithSize(cmd, size)
				if err != nil {
					return
				}
				go func() { io.Copy(pt, ch); pt.Close() }()
				io.Copy(ch, pt)
				if err := cmd.Wait(); err != nil {
					status = 1
				}
				pt.Close()
			} else {
				cmd.Stdin = ch
				cmd.Stdout = ch
				cmd.Stderr = ch.Stderr()
				if err := cmd.Run(); err != nil {
					status = 1
				}
			}
			ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{status}))
			return
		default:
			req.Reply(false, nil)
		}
	}
}

func TestRemoteTTYInteractiveAuthenticationSearchAndReattach(t *testing.T) {
	sshServer := newRemoteTTYTestSSH(t)
	g, srv := newE2EServer(t)
	g.ttyTmuxHost = "tabtop-test"
	g.ttyCommand = "printf 'initial-command-once\\n'; exec sh"
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	sess := login(t, ctx, srv.URL, code(0))
	connect := func() (*tunnelClient, *strings.Builder) {
		tc := openSession(t, ctx, srv.URL, sess)
		if reply := tc.request(t, ctx, tunnelRequest{Type: "tty"}); reply["search"] != false {
			t.Fatalf("search offered before auth: %v", reply)
		}
		return tc, &strings.Builder{}
	}
	readUntil := func(tc *tunnelClient, out *strings.Builder, want string) {
		t.Helper()
		for !strings.Contains(out.String(), want) {
			kind, p, err := tc.read(ctx)
			if err != nil {
				t.Fatalf("waiting for %q, got %q: %v", want, out.String(), err)
			}
			if kind == msgData {
				out.Write(p)
			}
		}
	}
	authenticate := func(tc *tunnelClient, out *strings.Builder) {
		readUntil(tc, out, "Password:")
		tc.write(ctx, msgData, []byte("test-password\r"))
		readUntil(tc, out, "Verification code:")
		tc.write(ctx, msgData, []byte("123456\r"))
		for {
			kind, p, err := tc.read(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if kind == msgData {
				out.Write(p)
				continue
			}
			var notice map[string]any
			json.Unmarshal(p, &notice)
			if notice["type"] == "tty-capabilities" && notice["search"] == true {
				break
			}
		}
	}
	tc, out := connect()
	t.Cleanup(func() {
		tc.c.CloseNow()
		deadline := time.Now().Add(4 * time.Second)
		for time.Now().Before(deadline) {
			g.mu.Lock()
			n := g.ttys[sess.id]
			g.mu.Unlock()
			if n == 0 {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
	})
	// UI cannot invoke tmux while authentication is still waiting.
	tc.write(ctx, msgText, []byte(`{"type":"search","do":"find","text":"ignored-before-auth"}`))
	authenticate(tc, out)
	readUntil(tc, out, "initial-command-once")
	tc.write(ctx, msgData, []byte("echo retained-history\r"))
	readUntil(tc, out, "retained-history")
	tc.write(ctx, msgText, []byte(`{"type":"search","do":"find","text":"retained-history"}`))
	readUntil(tc, out, "retained-history")
	modeDeadline := time.Now().Add(3 * time.Second)
	inMode := false
	for time.Now().Before(modeDeadline) {
		mode, queryErr := exec.CommandContext(ctx, "tmux", "-S", filepath.Join(sshServer.socketDir, fmt.Sprintf("tmux-%d", os.Getuid()), "default"), "list-panes", "-a", "-F", "#{pane_in_mode}").CombinedOutput()
		if queryErr != nil {
			t.Logf("mode query: %s: %v", mode, queryErr)
		}
		if strings.TrimSpace(string(mode)) == "1" {
			inMode = true
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !inMode {
		t.Fatal("remote history search did not enter copy mode")
	}
	// A separate control channel must reuse the one completed authentication.
	time.Sleep(100 * time.Millisecond)
	if sshServer.auths.Load() != 1 || sshServer.connections.Load() != 1 {
		t.Fatalf("reauthenticated for control: %d %d", sshServer.auths.Load(), sshServer.connections.Load())
	}
	tc.write(ctx, msgText, []byte(`{"type":"search","do":"stop"}`))
	tc.c.CloseNow()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		g.mu.Lock()
		n := g.ttys[sess.id]
		g.mu.Unlock()
		if n == 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	// Same session, different initial command: attach must not run it.
	g.ttyCommand = "echo SHOULD-NOT-RUN; exec sh"
	tc2, out2 := connect()
	defer func() {
		tc2.c.CloseNow()
		until := time.Now().Add(4 * time.Second)
		for time.Now().Before(until) {
			g.mu.Lock()
			n := g.ttys[sess.id]
			g.mu.Unlock()
			if n == 0 {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Error("remote terminal was not cleaned up")
	}()
	authenticate(tc2, out2)
	tc2.write(ctx, msgData, []byte("echo attached-again\r"))
	readUntil(tc2, out2, "attached-again")
	if strings.Contains(out2.String(), "SHOULD-NOT-RUN") {
		t.Fatal("initial command restarted on attach")
	}
	if sshServer.auths.Load() != 2 {
		t.Fatalf("new terminal did not require fresh auth: %d", sshServer.auths.Load())
	}
}
