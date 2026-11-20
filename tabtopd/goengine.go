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
	// goEngineDataFactor is how many times its memory an engine's data
	// segment may be (see startGoEngine).
	goEngineDataFactor = 2
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
// engine can't fill the host's disk through it. cache, if set, is the
// engines' shared HTTP cache (gocache.go), bound writable at /cache.
func goSandboxArgs(engine, tabtopd, run, cache string) []string {
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
	if cache != "" {
		args = append(args, "--bind", cache, "/cache")
	}
	return args
}

// goAdapter is what tabtopd needs to know of a page engine to run one:
// Moli or Obscura, chosen by -go-engine (WEB_GO_ENGINE). The rest (the
// sandbox, the proxy, CDP, the agent) is the same for both.
// goInputGaps is what an engine leaves out of what a browser does with
// input, measured against Moli (which leaves out none).
type goInputGaps struct {
	// pointer: pointer events, mouseenter and mouseleave along the
	// ancestors entered and left, a right click's contextmenu (Obscura).
	pointer bool
	// activate: the keys that, given to it, don't press what has the
	// focus: it's clicked there, as input.
	activate []string
	// tab: Tab doesn't move the focus.
	tab bool
	// letGoClicks: a release outside its window is a click on what was
	// pressed: let go with another button (Obscura).
	letGoClicks bool
	// byElement: its places aren't a browser's (no layout: Lightpanda's
	// mouse lands elsewhere), so the mouse is given by script to the
	// element the person pointed at, not as input at a place.
	byElement bool
}

type goAdapter struct {
	name string
	// args are its arguments: CDP on port, everything fetched through
	// proxy, as userAgent if it's set, with the shared HTTP cache in cache
	// if it's set (and it takes one).
	args func(port int, proxy, userAgent, cache string) []string
	// cache is whether it can keep its HTTP cache in a directory shared by
	// the tabs' engines (gocache.go).
	cache bool
	// anySession: its page's events may come on a session of its own, not
	// the one tabtopd attached (some on both): they're taken from any,
	// once. An engine runs one page.
	anySession bool
	// input is what it leaves out of what a browser does with input, for
	// the agent to do (__tabtop.scripted, goinput.go).
	input goInputGaps
	// noDialogs: it answers the page's alert, confirm and prompt itself,
	// at once, and says nothing (no Page.javascriptDialogOpening): the
	// person is shown what was asked (godialogs.js), the page not waiting.
	noDialogs bool
	// env is what it's run with besides HOME, TMPDIR and PATH.
	env []string
	// cookieScopeLost: its cookies' domains come without the dot that
	// says a domain cookie (Obscura's): see exportCookies.
	cookieScopeLost bool
	// data is its data segment's limit (RLIMIT_DATA) if it isn't its
	// memory's: V8 counts some of what it reserves (not uses) against it.
	// The resident memory the watchdog allows is the same for both.
	data int64
}

var goAdapters = map[string]goAdapter{
	// Moli: nothing kept (no profile, no cookie jar) or fetched for display
	// (images, fonts: the client's broker fetches those). With --layout,
	// pages that measure themselves (a menu placed below its header) get
	// real sizes and places, at the size of the person's window (see
	// gobrowser.go's viewport).
	"moli": {name: "Moli", cache: true, args: func(port int, proxy, userAgent, cache string) []string {
		args := []string{"serve", "--host", "127.0.0.1", "--port", strconv.Itoa(port),
			"--http-proxy", proxy, "--log-level", "warn", "--layout"}
		if userAgent != "" {
			args = append(args, "--user-agent", userAgent)
		}
		if cache != "" {
			args = append(args, "--http-cache-dir", cache)
		}
		return args
	}},
	// Obscura: quiet. It refuses private addresses itself unless told not
	// to; tabtopd's proxy is where that policy is (and Obscura reaches the
	// proxy on loopback), so it's told not to. It has no HTTP cache of its
	// own to share: each engine fetches for itself.
	// Its V8 reserves address space that RLIMIT_DATA counts (1.25 GiB to
	// start, measured; more for each page's): its limit is 8 GiB, and what
	// it uses is held to goEngineMemory by the watchdog, as Moli's is.
	// Its page's events come on its own session as well as tabtopd's, and
	// those that input causes (a link clicked) on its own only.
	"obscura": {name: "Obscura", data: 8 << 30, anySession: true, noDialogs: true, cookieScopeLost: true,
		input: goInputGaps{pointer: true, activate: []string{" ", "Enter"}, tab: true, letGoClicks: true}, args: func(port int, proxy, userAgent, _ string) []string {
			args := []string{"serve", "--host", "127.0.0.1", "--port", strconv.Itoa(port),
				"--proxy", proxy, "--quiet", "--allow-private-network"}
			if userAgent != "" {
				args = append(args, "--user-agent", userAgent)
			}
			return args
		}},
	// Lightpanda (AGPL-3.0): stylesheets, iframes and workers loaded (by
	// default it loads none: a page's frames wouldn't be there), nothing
	// for display (pictures: the client's broker fetches them), no metrics
	// endpoint, and no telemetry (it reports usage by default; sandboxed it
	// couldn't reach out anyway). It refuses a User-Agent saying
	// "Mozilla", as every browser's does: it says it's Lightpanda.
	// Its mouse lands where its own layout (none to speak of) says, not on
	// what the person pointed at: given by script to the element. Enter
	// doesn't press a button (Space does, and Tab moves on).
	"lightpanda": {name: "Lightpanda", cache: true, env: []string{"LIGHTPANDA_DISABLE_TELEMETRY=true"},
		input: goInputGaps{byElement: true, activate: []string{"Enter"}},
		args: func(port int, proxy, _, cache string) []string {
			args := []string{"serve", "--host", "127.0.0.1", "--port", strconv.Itoa(port),
				"--http-proxy", proxy, "--log-level", "warn", "--disable-metrics",
				"--load-resources", "stylesheet", "--load-resources", "iframe", "--load-resources", "worker"}
			if cache != "" {
				args = append(args, "--http-cache-dir", cache)
			}
			return args
		}},
}

// goAdapterFor is engine's adapter: by its file's name, or else by what it
// says it is (--version, asked once); Moli's if neither says.
func goAdapterFor(engine string) goAdapter {
	base := strings.ToLower(filepath.Base(engine))
	for key, a := range goAdapters {
		if strings.HasPrefix(base, key) {
			return a
		}
	}
	goAdapterSeen.Lock()
	defer goAdapterSeen.Unlock()
	if a, ok := goAdapterSeen.m[engine]; ok {
		return a
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, _ := exec.CommandContext(ctx, engine, "--version").Output()
	a := goAdapters["moli"]
	for key, candidate := range goAdapters {
		if strings.HasPrefix(strings.ToLower(strings.TrimSpace(string(out))), key) {
			a = candidate
		}
	}
	goAdapterSeen.m[engine] = a
	return a
}

var goAdapterSeen = struct {
	sync.Mutex
	m map[string]goAdapter
}{m: map[string]goAdapter{}}

type goEngineConfig struct {
	engine string // the engine's binary
	mode   goSandboxMode
	bwrap  string
	allow  func(netip.Addr) bool // where its requests may go
	// args are the engine's arguments; nil for its adapter's (goAdapterFor).
	args      func(port int, proxy string) []string
	userAgent string
	// cache is the engines' shared HTTP cache, on the host ("": none).
	cache  string
	memory int64         // resident memory limit; 0 for goEngineMemory
	data   int64         // data segment limit, if not memory's (its adapter's)
	busy   time.Duration // a core kept busy this long: 0 for goEngineBusy
	ping   time.Duration // how often it's asked if it's there: 0 for goEnginePing
	logf   func(format string, args ...any)
}

type goEngine struct {
	cfg     goEngineConfig
	adapter goAdapter // what it is
	run     string    // its run directory: sockets, its home when unsandboxed
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
	adapter := goAdapterFor(cfg.engine)
	if cfg.args == nil {
		cfg.data = adapter.data
		if !adapter.cache {
			cfg.cache = "" // none to share: not bound into its sandbox either
		}
		ua, cache := cfg.userAgent, cfg.cache
		if cache != "" && cfg.mode == goSandboxed {
			cache = "/cache" // where the sandbox has it
		}
		cfg.args = func(port int, proxy string) []string { return adapter.args(port, proxy, ua, cache) }
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
	e := &goEngine{cfg: cfg, adapter: adapter, run: run, stderr: &tailBuffer{max: 4096}, exited: make(chan struct{}), killed: make(chan struct{})}
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
	// The data segment's limit: twice the memory allowed, by default. An
	// engine's V8 reserves address space RLIMIT_DATA counts beyond what it
	// uses (Moli's: 1.27 GiB on heavy pages, using 460 MiB), and ends the
	// engine (SIGTRAP, saying nothing) when it can't; at the memory limit
	// itself, heavy pages ended it, and were loaded again, over and over.
	// What's used is held to the memory limit by the watchdog; this is the
	// ceiling it can't pass between the watchdog's looks.
	data := goEngineDataFactor * cfg.memory
	if cfg.data > 0 {
		data = cfg.data
	}
	dataLimit := fmt.Sprintf("-data=%d", data)
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
		argv = append([]string{cfg.bwrap}, goSandboxArgs(cfg.engine, tabtopd, run, cfg.cache)...)
		// The seccomp filter (goseccomp.go), read by bwrap from fd 4.
		if filterFile, err = goSeccompFile(); err != nil {
			return fail(err)
		}
		if filterFile != nil {
			defer filterFile.Close()
			argv = append(argv, "--seccomp", "4")
		}
		for _, kv := range adapter.env {
			k, v, _ := strings.Cut(kv, "=")
			argv = append(argv, "--setenv", k, v)
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
	e.cmd.Env = append([]string{"HOME=" + home, "TMPDIR=" + tmp, "PATH=/usr/bin:/bin"}, adapter.env...)
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
				// Being killed; but if it ended first (its tab closed as
				// its connection went), the bridge says how.
				out := strings.TrimSpace(e.stderr.String())
				if last := out[strings.LastIndex(out, "\n")+1:]; strings.HasPrefix(last, "go-bridge: the engine ended by") {
					e.cfg.logf("go: engine exited: %s", last)
				}
				return
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
