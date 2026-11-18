package main

// The remote browser's page engine (see docs/browser-plan.md, section 3).
// Moli, a headless browser, runs every page the remote browser (/go) opens:
// one engine per browsing context, started for it and killed with it, so
// nothing a page leaves behind outlives it.
//
// Pages are written by anyone, so the engine runs, where it can, in a
// bubblewrap sandbox: namespaces of its own, no capabilities, a filesystem
// of the engine, the system's libraries and certificates only, and a
// network with nothing but loopback. The bridge (gobridge.go) joins that to
// two sockets in the engine's run directory: tabtopd reaches the engine's
// CDP through one, and the engine reaches the web through the other, the
// egress proxy (goproxy.go), which goes only where fetches may.
//
// Where bubblewrap can't make its namespaces (a container with Docker's
// default seccomp and AppArmor profiles), /go is unavailable, unless
// -go-unsandboxed says to run the engine anyway, as a plain child: then
// the proxy, on a loopback port with the engine's own credentials, is all
// that confines its requests, and a page that exploits the engine runs
// with tabtopd's user. Its CDP is then on a loopback port too, without
// authentication: Moli listens only on TCP and takes no token. Pages can't
// reach it (the proxy refuses loopback); other local programs, which run
// as tabtopd's user anyway in TabTop's container, can.
//
// A watchdog kills an engine that stops answering, or uses more memory, or
// keeps a core busy on its own (with nobody using it) for longer, than a page
// should.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

type goSandboxMode int

const (
	goUnavailable goSandboxMode = iota
	goSandboxed
	goUnsandboxed
)

func (m goSandboxMode) String() string {
	switch m {
	case goSandboxed:
		return "sandboxed"
	case goUnsandboxed:
		return "unsandboxed"
	}
	return "unavailable"
}

const (
	// The ports the engine and its proxy have inside the sandbox, whose
	// loopback is its own.
	goCDPPortInside   = 9222
	goProxyPortInside = 3128
	// goEngineStart is how long an engine has to answer on CDP.
	goEngineStart = 15 * time.Second
	// goEngineMemory is the most memory an engine may use: its data
	// segment's limit (RLIMIT_DATA, set by the bridge), and the resident
	// memory the watchdog allows. Moli needs at least 640 MiB to start.
	goEngineMemory = 1 << 30
	// goEngineTmp is the size of the sandbox's /tmp, where Moli keeps
	// IndexedDB and OPFS without a profile: memory too, beside its own.
	goEngineTmp = 256 << 20
	// An engine that keeps a core busy for goEngineBusy is stuck: Moli's
	// own watchdog ends a looping script after about 8 seconds.
	goEngineBusy = 60 * time.Second
	// goEnginePing is how often an engine's CDP is asked whether it's
	// there; goEngineMisses unanswered in a row, and it's killed.
	goEnginePing   = 5 * time.Second
	goEngineMisses = 3
)

// goSandboxProbe decides how engines will run: sandboxed, if bubblewrap
// (bwrap) makes its namespaces here; else unsandboxed, if that's allowed;
// else not at all. why says why not sandboxed.
func goSandboxProbe(bwrap string, unsandboxedOK bool) (mode goSandboxMode, why string) {
	err := probeBwrap(bwrap)
	if err == nil {
		return goSandboxed, ""
	}
	why = err.Error()
	if unsandboxedOK {
		return goUnsandboxed, why
	}
	return goUnavailable, why
}

func probeBwrap(bwrap string) error {
	if bwrap == "" {
		return errors.New("bubblewrap (bwrap) isn't installed")
	}
	trueBin, err := exec.LookPath("true")
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	args := append(goSandboxSystem(), "--unshare-all", "--cap-drop", "ALL", "--die-with-parent", "--dev", "/dev", "--tmpfs", "/tmp")
	cmd := exec.CommandContext(ctx, bwrap)
	// With the engine's seccomp filter too, where there's one.
	filter, err := goSeccompFile()
	if err != nil {
		return err
	}
	if filter != nil {
		defer filter.Close()
		cmd.ExtraFiles = []*os.File{filter}
		args = append(args, "--seccomp", "3")
	}
	cmd.Args = append(append(cmd.Args, args...), trueBin)
	out, err := cmd.CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if msg == "" {
			msg = err.Error()
		}
		return fmt.Errorf("bubblewrap can't make its sandbox here: %s", firstLine(msg))
	}
	return nil
}

func firstLine(s string) string {
	s, _, _ = strings.Cut(s, "\n")
	return s
}

// goSandboxSystem binds the system's programs and libraries read-only, as
// they're laid out here: /lib and the like as the symbolic links they are
// on a merged /usr, or as directories where they're not.
func goSandboxSystem() []string {
	args := []string{"--ro-bind", "/usr", "/usr"}
	for _, dir := range []string{"/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"} {
		fi, err := os.Lstat(dir)
		switch {
		case err != nil:
		case fi.Mode()&os.ModeSymlink != 0:
			if target, err := os.Readlink(dir); err == nil {
				args = append(args, "--symlink", target, dir)
			}
		case fi.IsDir():
			args = append(args, "--ro-bind", dir, dir)
		}
	}
	return args
}

// goSandboxArgs are bwrap's arguments for an engine: everything up to the
// program it runs (the bridge, /bridge, then the engine, /app/NAME). Only
// the engine's binary is bound, not the directory it's in, which could be
// anyone's home; and the run directory read-only: its sockets work, but the
// engine can't fill the host's disk through it.
func goSandboxArgs(engine, tabtopd, run string) []string {
	args := []string{
		"--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
		"--clearenv", "--setenv", "HOME", "/tmp", "--setenv", "PATH", "/usr/bin:/bin",
	}
	args = append(args, goSandboxSystem()...)
	// Certificates, for HTTPS through the proxy's tunnels, and fonts'
	// configuration; where they are. No /proc: Moli doesn't need one, and
	// Docker won't let one be mounted without more relaxed settings.
	args = append(args,
		"--ro-bind-try", "/etc/ssl", "/etc/ssl",
		"--ro-bind-try", "/etc/ca-certificates", "/etc/ca-certificates",
		"--ro-bind-try", "/etc/fonts", "/etc/fonts",
		"--ro-bind", engine, "/app/"+filepath.Base(engine),
		"--ro-bind", tabtopd, "/bridge",
		"--ro-bind", run, "/run/tt",
		"--size", strconv.Itoa(goEngineTmp), "--tmpfs", "/tmp",
		"--dev", "/dev",
	)
	return args
}

// goMoliArgs are Moli's arguments: CDP on port, everything fetched through
// the proxy, and nothing kept (no profile, no cookie jar) or fetched for
// display (images, fonts: the client's broker fetches those).
func goMoliArgs(port int, proxy, userAgent string) []string {
	args := []string{"serve", "--host", "127.0.0.1", "--port", strconv.Itoa(port),
		"--http-proxy", proxy, "--log-level", "warn"}
	if userAgent != "" {
		args = append(args, "--user-agent", userAgent)
	}
	return args
}

type goEngineConfig struct {
	engine string // the engine's binary
	mode   goSandboxMode
	bwrap  string
	allow  func(netip.Addr) bool // where its requests may go
	// args are the engine's arguments; nil for Moli's (goMoliArgs).
	args      func(port int, proxy string) []string
	userAgent string
	memory    int64         // resident memory limit; 0 for goEngineMemory
	busy      time.Duration // a core kept busy this long: 0 for goEngineBusy
	ping      time.Duration // how often it's asked if it's there: 0 for goEnginePing
	logf      func(format string, args ...any)
}

type goEngine struct {
	cfg     goEngineConfig
	run     string // its run directory: sockets, its home when unsandboxed
	cmd     *exec.Cmd
	proxy   *goProxy
	proxyL  net.Listener
	cdpNet  string // how CDP is reached: "unix" (sandboxed) or "tcp"
	cdpAddr string
	cdpHost string // the Host header the engine expects
	stderr  *tailBuffer
	exited  chan struct{}

	killOnce sync.Once
	killed   chan struct{}
	mu       sync.Mutex
	reason   string // why it was killed
	// uses counts what the person has done in it: busy is only a runaway
	// page's when nobody has, for all of cfg.busy.
	uses atomic.Int64
}

// use notes that the person has asked something of the engine (loading a
// page, a click), so the CPU it takes isn't held against a page: loading a
// heavy site takes more than a core for seconds (see watch).
func (e *goEngine) use() { e.uses.Add(1) }

// startGoEngine starts an engine, and returns once it answers on CDP.
func startGoEngine(cfg goEngineConfig) (*goEngine, error) {
	if cfg.mode == goUnavailable {
		return nil, errors.New("the remote browser's engine can't run here")
	}
	if cfg.args == nil {
		ua := cfg.userAgent
		cfg.args = func(port int, proxy string) []string { return goMoliArgs(port, proxy, ua) }
	}
	if cfg.memory == 0 {
		cfg.memory = goEngineMemory
	}
	if cfg.busy == 0 {
		cfg.busy = goEngineBusy
	}
	if cfg.ping == 0 {
		cfg.ping = goEnginePing
	}
	if cfg.logf == nil {
		cfg.logf = log.Printf
	}
	run, err := os.MkdirTemp("", "tabtop-go-")
	if err != nil {
		return nil, err
	}
	e := &goEngine{cfg: cfg, run: run, stderr: &tailBuffer{max: 4096}, exited: make(chan struct{}), killed: make(chan struct{})}
	// Whose it is, so a later tabtopd can tell it's left over (see
	// sweepGoRunDirs).
	if err := os.WriteFile(filepath.Join(run, goOwnerFile), []byte(strconv.Itoa(os.Getpid())), 0o600); err != nil {
		os.RemoveAll(run)
		return nil, err
	}
	fail := func(err error) (*goEngine, error) {
		if e.proxyL != nil {
			e.proxyL.Close()
		}
		os.RemoveAll(run)
		return nil, err
	}

	var argv []string
	var port int
	var proxyURL string
	var cdpFile *os.File    // the CDP socket, handed to the sandbox's bridge
	var filterFile *os.File // its seccomp filter, for bwrap
	tabtopd, err := os.Executable()
	if err != nil {
		return fail(err)
	}
	dataLimit := fmt.Sprintf("-data=%d", cfg.memory)
	switch cfg.mode {
	case goSandboxed:
		e.proxy = newGoProxy(cfg.allow, "", "")
		if e.proxyL, err = net.Listen("unix", filepath.Join(run, "egress.sock")); err != nil {
			return fail(err)
		}
		port, proxyURL = goCDPPortInside, fmt.Sprintf("http://127.0.0.1:%d", goProxyPortInside)
		e.cdpNet, e.cdpAddr = "unix", filepath.Join(run, "cdp.sock")
		// tabtopd makes the CDP socket, so the run directory can be
		// read-only in the sandbox; the bridge accepts on it as fd 3.
		cdpL, err := net.Listen("unix", e.cdpAddr)
		if err != nil {
			return fail(err)
		}
		cdpL.(*net.UnixListener).SetUnlinkOnClose(false)
		cdpFile, err = cdpL.(*net.UnixListener).File()
		cdpL.Close()
		if err != nil {
			return fail(err)
		}
		defer cdpFile.Close()
		argv = append([]string{cfg.bwrap}, goSandboxArgs(cfg.engine, tabtopd, run)...)
		// The seccomp filter (goseccomp.go), read by bwrap from fd 4.
		if filterFile, err = goSeccompFile(); err != nil {
			return fail(err)
		}
		if filterFile != nil {
			defer filterFile.Close()
			argv = append(argv, "--seccomp", "4")
		}
		argv = append(argv, "/bridge", goBridgeArg, dataLimit,
			fmt.Sprintf("fd:3=127.0.0.1:%d", goCDPPortInside),
			fmt.Sprintf("127.0.0.1:%d=/run/tt/egress.sock", goProxyPortInside),
			"--", "/app/"+filepath.Base(cfg.engine))
	case goUnsandboxed:
		user, password := randomHex(8), randomHex(16)
		e.proxy = newGoProxy(cfg.allow, user, password)
		if e.proxyL, err = net.Listen("tcp", "127.0.0.1:0"); err != nil {
			return fail(err)
		}
		if port, err = freeLoopbackPort(); err != nil {
			return fail(err)
		}
		proxyURL = fmt.Sprintf("http://%s:%s@%s", user, password, e.proxyL.Addr())
		e.cdpNet, e.cdpAddr = "tcp", fmt.Sprintf("127.0.0.1:%d", port)
		// The bridge, forwarding nothing here, only limits its memory.
		argv = []string{tabtopd, goBridgeArg, dataLimit, "--", cfg.engine}
	}
	e.cdpHost = fmt.Sprintf("127.0.0.1:%d", port)
	e.proxy.logf = cfg.logf
	argv = append(argv, cfg.args(port, proxyURL)...)

	// Unsandboxed, its home and temporary files (Moli's IndexedDB and
	// OPFS) are in the run directory, removed with it.
	home, tmp := filepath.Join(run, "home"), filepath.Join(run, "tmp")
	for _, dir := range []string{home, tmp} {
		if err := os.Mkdir(dir, 0o700); err != nil {
			return fail(err)
		}
	}
	e.cmd = exec.Command(argv[0], argv[1:]...)
	e.cmd.Dir = run
	// Nothing of tabtopd's environment: no proxy settings to bypass the
	// egress proxy with (NO_PROXY), no secrets.
	e.cmd.Env = []string{"HOME=" + home, "TMPDIR=" + tmp, "PATH=/usr/bin:/bin"}
	if cdpFile != nil {
		e.cmd.ExtraFiles = []*os.File{cdpFile}
		if filterFile != nil {
			e.cmd.ExtraFiles = append(e.cmd.ExtraFiles, filterFile)
		}
	}
	e.cmd.Stderr = e.stderr
	e.cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL, Setpgid: true}
	go e.proxy.serve(e.proxyL)
	if err := e.cmd.Start(); err != nil {
		return fail(err)
	}
	go func() {
		e.cmd.Wait()
		close(e.exited)
	}()

	deadline := time.Now().Add(goEngineStart)
	for {
		if e.ping(time.Second) == nil {
			break
		}
		select {
		case <-e.exited:
			e.kill("it exited while starting")
			return nil, fmt.Errorf("the engine exited while starting: %s", strings.TrimSpace(e.stderr.String()))
		case <-time.After(20 * time.Millisecond):
		}
		if time.Now().After(deadline) {
			e.kill("it didn't start in time")
			return nil, fmt.Errorf("the engine didn't answer within %s", goEngineStart)
		}
	}
	go e.watch()
	return e, nil
}

func randomHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func freeLoopbackPort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// dial connects to the engine's CDP.
func (e *goEngine) dial(ctx context.Context, _, _ string) (net.Conn, error) {
	var d net.Dialer
	return d.DialContext(ctx, e.cdpNet, e.cdpAddr)
}

// client is an HTTP client for the engine's CDP endpoints.
func (e *goEngine) client() *http.Client {
	return &http.Client{Transport: &http.Transport{DialContext: e.dial, DisableKeepAlives: true, Proxy: nil}}
}

// version is the engine's /json/version.
func (e *goEngine) version(ctx context.Context) (map[string]any, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", "http://"+e.cdpHost+"/json/version", nil)
	if err != nil {
		return nil, err
	}
	res, err := e.client().Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("/json/version: %s", res.Status)
	}
	var v map[string]any
	err = json.NewDecoder(io.LimitReader(res.Body, 1<<16)).Decode(&v)
	return v, err
}

func (e *goEngine) ping(timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	_, err := e.version(ctx)
	return err
}

// kill ends the engine, everything it started, and its proxy, and removes
// its run directory. The first reason given is kept.
func (e *goEngine) kill(reason string) {
	e.killOnce.Do(func() {
		e.mu.Lock()
		e.reason = reason
		e.mu.Unlock()
		if e.cmd.Process != nil {
			killProcessTree(e.cmd.Process.Pid)
		}
		select {
		case <-e.exited:
		case <-time.After(5 * time.Second):
			e.cfg.logf("go: engine %d didn't end after being killed", e.cmd.Process.Pid)
		}
		e.proxyL.Close()
		e.proxy.close()
		os.RemoveAll(e.run)
		close(e.killed)
	})
}

// killReason is why the engine was killed; "" while it runs.
func (e *goEngine) killReason() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.reason
}

// watch kills the engine when it exits on its own, stops answering, or
// uses more memory or CPU than a page should.
func (e *goEngine) watch() {
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	lastPing := time.Now()
	misses := 0
	// CPU time (in clock ticks) at each of the last cfg.busy seconds.
	window := int(e.cfg.busy / time.Second)
	samples := make([]int64, 0, window+1)
	var uses int64
	for {
		select {
		case <-e.killed:
			return
		case <-e.exited:
			if e.killReason() != "" {
				return // it's being killed
			}
			e.cfg.logf("go: engine exited: %s", firstLine(strings.TrimSpace(e.stderr.String())))
			e.kill("it exited")
			return
		case <-tick.C:
		}
		rss, cpu := processTreeUsage(e.cmd.Process.Pid)
		if rss > e.cfg.memory {
			e.cfg.logf("go: engine killed: %d MB of memory", rss>>20)
			e.kill("it used too much memory")
			return
		}
		// The window starts again with each thing the person does: only
		// a page busy on its own all along it is stuck.
		if u := e.uses.Load(); u != uses {
			uses = u
			samples = samples[:0]
		}
		samples = append(samples, cpu)
		if len(samples) > window+1 {
			samples = samples[1:]
		}
		// Busy nearly all of the window: 90% of a core, in ticks.
		if len(samples) == window+1 && samples[window]-samples[0] >= int64(window)*clockTicks*9/10 {
			e.cfg.logf("go: engine killed: busy for %s", e.cfg.busy)
			e.kill("a page kept it busy too long")
			return
		}
		if time.Since(lastPing) >= e.cfg.ping {
			lastPing = time.Now()
			if e.ping(min(3*time.Second, e.cfg.ping)) != nil {
				if misses++; misses >= goEngineMisses {
					e.cfg.logf("go: engine killed: not answering")
					e.kill("it stopped answering")
					return
				}
			} else {
				misses = 0
			}
		}
	}
}

// clockTicks is /proc's unit of CPU time: Linux's USER_HZ, always 100.
const clockTicks = 100

// processTree is pid and its descendants, as /proc lists them.
func processTree(pid int) []int {
	pids := []int{pid}
	for i := 0; i < len(pids); i++ {
		tasks, _ := filepath.Glob(fmt.Sprintf("/proc/%d/task/*/children", pids[i]))
		for _, t := range tasks {
			b, err := os.ReadFile(t)
			if err != nil {
				continue
			}
			for _, f := range strings.Fields(string(b)) {
				if c, err := strconv.Atoi(f); err == nil {
					pids = append(pids, c)
				}
			}
		}
	}
	return pids
}

// processTreeUsage is the resident memory (bytes) and CPU time (clock
// ticks) of pid and its descendants.
func processTreeUsage(pid int) (rss, cpu int64) {
	for _, p := range processTree(pid) {
		if b, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", p)); err == nil {
			for _, line := range strings.Split(string(b), "\n") {
				if v, ok := strings.CutPrefix(line, "VmRSS:"); ok {
					kb, _ := strconv.ParseInt(strings.TrimSuffix(strings.TrimSpace(v), " kB"), 10, 64)
					rss += kb << 10
				}
			}
		}
		if b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", p)); err == nil {
			// The fields after the command's name, which may hold spaces
			// and parentheses: utime and stime are the 12th and 13th.
			if i := strings.LastIndexByte(string(b), ')'); i >= 0 {
				f := strings.Fields(string(b[i+1:]))
				if len(f) > 12 {
					u, _ := strconv.ParseInt(f[11], 10, 64)
					s, _ := strconv.ParseInt(f[12], 10, 64)
					cpu += u + s
				}
			}
		}
	}
	return rss, cpu
}

// killProcessTree kills pid and everything it started. Its descendants are
// found first, as they're reparented once it's gone; the sandbox's own
// session (bwrap --new-session) isn't in pid's process group, so the group
// alone isn't enough.
func killProcessTree(pid int) {
	pids := processTree(pid)
	syscall.Kill(-pid, syscall.SIGKILL)
	for i := len(pids) - 1; i >= 0; i-- {
		syscall.Kill(pids[i], syscall.SIGKILL)
	}
}

// tailBuffer keeps the last max bytes written to it.
type tailBuffer struct {
	mu  sync.Mutex
	max int
	b   []byte
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.b = append(t.b, p...)
	if len(t.b) > t.max {
		t.b = append([]byte(nil), t.b[len(t.b)-t.max:]...)
	}
	return len(p), nil
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.b)
}
