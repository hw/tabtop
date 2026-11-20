package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// goFakeEngineArg runs the test binary as a stand-in for Moli (see
// TestMain): -go-fake-engine BEHAVIOUR PORT PROXY.
const goFakeEngineArg = "-go-fake-engine"

// runGoFakeEngine answers CDP on 127.0.0.1:PORT as an engine does: its
// /json/version, and on its WebSocket every command with an empty result
// (Target.createTarget and attachToTarget with IDs). BEHAVIOUR is how it
// misbehaves: "ok", "spin" (keeps a core busy), "grow" (takes more and more
// memory), "hang" (stops answering), or "die" (exits soon).
func runGoFakeEngine(args []string) int {
	if len(args) < 2 {
		return 2
	}
	behaviour, port := args[0], args[1]
	l, err := net.Listen("tcp", "127.0.0.1:"+port)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/json/version", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]string{"Browser": "Fake/1", "webSocketDebuggerUrl": "ws://127.0.0.1:" + port + "/devtools/browser/fake"})
	})
	mux.HandleFunc("/devtools/browser/fake", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		c.SetReadLimit(cdpReadLimit) // as an engine takes: the agent alone is over the default
		for {
			_, b, err := c.Read(context.Background())
			if err != nil {
				return
			}
			var m struct {
				ID     int64  `json:"id"`
				Method string `json:"method"`
				Params struct {
					URL string `json:"url"`
				} `json:"params"`
			}
			json.Unmarshal(b, &m)
			result := map[string]any{}
			var events []string
			switch m.Method {
			case "Target.createTarget":
				result["targetId"] = "T1"
			case "Target.attachToTarget":
				result["sessionId"] = "S1"
			case "Page.navigate":
				// As Moli does: a failure for an address it can't reach,
				// no loader within the same document, else the events.
				result["frameId"] = "F1"
				switch {
				case strings.Contains(m.Params.URL, "unreachable"):
					result["loaderId"], result["errorText"] = "L1", "net::ERR_FAILED"
				case strings.Contains(m.Params.URL, "#"):
				default:
					result["loaderId"] = "L1"
					events = []string{"Page.frameNavigated", "Page.loadEventFired"}
				}
				if !strings.Contains(m.Params.URL, "unreachable") {
					fakeURL = m.Params.URL
				}
			case "Page.getFrameTree":
				result["frameTree"] = map[string]any{"frame": map[string]any{"id": "F1"}}
			case "Page.createIsolatedWorld":
				result["executionContextId"] = 7
			case "Runtime.evaluate":
				// The serializer's answer, for the document navigated to.
				snap, _ := json.Marshal(map[string]any{"url": fakeURL, "base": fakeURL, "title": "  Fake \n page ", "doc": fakeDocument()})
				result["result"] = map[string]any{"type": "string", "value": string(snap)}
			}
			reply, _ := json.Marshal(map[string]any{"id": m.ID, "result": result})
			c.Write(context.Background(), websocket.MessageText, reply)
			for _, ev := range events {
				msg, _ := json.Marshal(map[string]any{"method": ev, "params": map[string]any{}, "sessionId": "S1"})
				c.Write(context.Background(), websocket.MessageText, msg)
			}
		}
	})
	srv := &http.Server{Handler: mux}
	go srv.Serve(l)
	switch behaviour {
	case "spin":
		go func() {
			for {
			}
		}()
	case "grow":
		go func() {
			var kept [][]byte
			for {
				b := make([]byte, 16<<20)
				for i := range b {
					b[i] = 1
				}
				kept = append(kept, b)
				time.Sleep(50 * time.Millisecond)
			}
		}()
	case "hang":
		time.Sleep(500 * time.Millisecond)
		l.Close()
		srv.SetKeepAlivesEnabled(false)
	case "die":
		time.Sleep(300 * time.Millisecond)
		return 3
	}
	select {}
}

// fakeURL is the fake engine's document's address: the last navigated to.
var fakeURL = "about:blank"

// fakeDocument is the fake engine's document, as its serializer gives it,
// with what a snapshot leaves out all the same (a script, a comment, an
// event handler), as an engine that misbehaved might.
func fakeDocument() map[string]any {
	el := func(id int, name string, attrs []string, kids ...map[string]any) map[string]any {
		return map[string]any{"i": id, "t": 1, "n": name, "a": attrs, "c": kids}
	}
	text := func(id int, v string) map[string]any { return map[string]any{"i": id, "t": 3, "v": v} }
	return map[string]any{"i": 1, "t": 9, "c": []map[string]any{
		{"i": 2, "t": 8, "v": "a doctype, or a comment"},
		el(3, "html", nil,
			el(4, "head", nil, el(5, "title", nil, text(6, "Fake page"))),
			el(7, "body", []string{"onload", "steal()", "class", "main"},
				map[string]any{"i": 8, "t": 8, "v": "secret comment"},
				el(9, "p", []string{"id", "p"}, text(10, "hello"), text(17, " "), el(11, "script", nil, text(12, "steal()"))),
				el(13, "noscript", nil, text(14, "no scripts")),
				el(15, "a", []string{"href", "/next", "OnClick", "steal()"}, text(16, "next")),
			)),
	}}
}

// fakeEngineConfig starts the test binary as the engine, behaving as
// behaviour says.
func fakeEngineConfig(t *testing.T, mode goSandboxMode, behaviour string) goEngineConfig {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	bwrap, _ := exec.LookPath("bwrap")
	return goEngineConfig{
		engine: exe, mode: mode, bwrap: bwrap, allow: allowAll, logf: t.Logf,
		args: func(port int, proxy string) []string {
			return []string{goFakeEngineArg, behaviour, fmt.Sprint(port), proxy}
		},
	}
}

func sandboxOrSkip(t *testing.T) {
	t.Helper()
	bwrap, _ := exec.LookPath("bwrap")
	if mode, why := goSandboxProbe(bwrap, false); mode != goSandboxed {
		t.Skip(why)
	}
}

func TestGoSandboxArgs(t *testing.T) {
	// An engine in someone's home: only the binary is bound, not the home.
	args := goSandboxArgs("/home/someone/bin/moli", "/usr/local/bin/tabtopd", "/tmp/tabtop-go-1", "")
	joined := " " + strings.Join(args, " ") + " "
	for _, want := range []string{" --unshare-all ", " --die-with-parent ", " --new-session ", " --cap-drop ALL ", " --clearenv ",
		" --ro-bind /usr /usr ", " --ro-bind /home/someone/bin/moli /app/moli ", " --ro-bind /usr/local/bin/tabtopd /bridge ",
		" --ro-bind /tmp/tabtop-go-1 /run/tt ", " --size 268435456 --tmpfs /tmp ", " --dev /dev "} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing%s", want)
		}
	}
	// No /proc (Docker won't mount one), and nothing of the host's home or
	// /etc but certificates and fonts.
	for _, banned := range []string{"--proc", "--share-net", " /home/someone ", " /home/someone/bin ", "/root", " /etc /", "--bind /tmp/tabtop-go-1"} {
		if strings.Contains(joined, banned) {
			t.Errorf("has %q", banned)
		}
	}
	if cached := strings.Join(goSandboxArgs("/opt/moli/moli", "/usr/local/bin/tabtopd", "/tmp/tabtop-go-1", "/home/u/.cache/tabtop/go-http-cache"), " "); !strings.Contains(cached, "--bind /home/u/.cache/tabtop/go-http-cache /cache") || strings.Contains(joined, "/cache") {
		t.Errorf("the shared cache's bind: %q", cached)
	}
	if m := goAdapters["moli"].args(9222, "http://127.0.0.1:3128", "", "/cache"); !slices.Contains(m, "--http-cache-dir") || m[len(m)-1] != "/cache" {
		t.Errorf("Moli's cache argument: %q", m)
	}
	moli := goAdapters["moli"].args(9222, "http://127.0.0.1:3128", "", "")
	if !slices.Equal(moli, []string{"serve", "--host", "127.0.0.1", "--port", "9222", "--http-proxy", "http://127.0.0.1:3128", "--log-level", "warn", "--layout"}) {
		t.Errorf("Moli's arguments: %q", moli)
	}
	// Obscura: its own proxy flag, and no cache, even if one is given.
	obscura := goAdapters["obscura"].args(9222, "http://127.0.0.1:3128", "Agent/1", "/cache")
	if !slices.Equal(obscura, []string{"serve", "--host", "127.0.0.1", "--port", "9222", "--proxy", "http://127.0.0.1:3128", "--quiet", "--allow-private-network", "--user-agent", "Agent/1"}) {
		t.Errorf("Obscura's arguments: %q", obscura)
	}
}

// An engine's adapter is chosen by its file's name, or by what it says it
// is; Moli's if neither says.
func TestGoAdapterFor(t *testing.T) {
	dir := t.TempDir()
	says := func(name, version string) string {
		p := filepath.Join(dir, name)
		os.WriteFile(p, []byte("#!/bin/sh\necho '"+version+"'\n"), 0o755)
		return p
	}
	for _, c := range []struct{ engine, want string }{
		{"/opt/moli/moli", "Moli"},
		{"/opt/obscura/obscura", "Obscura"},
		{"/opt/lightpanda/lightpanda", "Lightpanda"},
		{says("engine-a", "obscura 0.2.7"), "Obscura"},
		{says("engine-b", "moli 1.1.25"), "Moli"},
		{says("engine-c", "something else"), "Moli"},
	} {
		if got := goAdapterFor(c.engine).name; got != c.want {
			t.Errorf("%s: %s, want %s", c.engine, got, c.want)
		}
	}
}

// TestGoSandboxConfines runs a shell in the engine's sandbox, in place of
// an engine a page has taken over, and checks what it can't do.
func TestGoSandboxConfines(t *testing.T) {
	sandboxOrSkip(t)
	bwrap, _ := exec.LookPath("bwrap")
	home := t.TempDir() // stands for the user's files, beside the engine
	engine := filepath.Join(home, "moli")
	os.WriteFile(engine, []byte("#!/bin/sh\n"), 0o755)
	os.WriteFile(filepath.Join(home, "secret.txt"), []byte("secret"), 0o600)
	run := t.TempDir()
	host, err := net.Listen("tcp", "127.0.0.1:0") // a service on the host's loopback
	if err != nil {
		t.Fatal(err)
	}
	defer host.Close()
	_, hostPort, _ := net.SplitHostPort(host.Addr().String())
	exe, _ := os.Executable()
	shell := `
probe() { if eval "$2" >/dev/null 2>&1; then echo "REACHABLE $1"; else echo "blocked $1"; fi; }
probe "the engine's directory" "cat /app/secret.txt"
probe "the user's home" "cat ` + home + `/secret.txt"
probe "/etc/passwd" "cat /etc/passwd"
probe "writing the run directory" "touch /run/tt/x"
probe "the host's loopback" "exec 3<>/dev/tcp/127.0.0.1/` + hostPort + `"
probe "the internet" "timeout 3 bash -c 'exec 3<>/dev/tcp/1.1.1.1/80'"
probe "more than 256 MiB in /tmp" "head -c 300000000 /dev/zero > /tmp/big"
`
	args := append(goSandboxArgs(engine, exe, run, ""), "/bin/bash", "-c", shell)
	out, err := exec.Command(bwrap, args...).CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	t.Logf("\n%s", out)
	if strings.Contains(string(out), "REACHABLE") {
		t.Error("the sandbox let something through")
	}
	if strings.Count(string(out), "blocked") != 7 {
		t.Error("not every probe ran")
	}
}

func TestGoBridgeForward(t *testing.T) {
	// A TCP service, reached through a Unix socket, as tabtopd reaches the
	// engine's CDP.
	svc, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer svc.Close()
	go func() {
		for {
			c, err := svc.Accept()
			if err != nil {
				return
			}
			go func() { defer c.Close(); io.Copy(c, c) }() // echo
		}
	}()
	sock := filepath.Join(t.TempDir(), "s")
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	go goBridgeForward(l, svc.Addr().String())
	c, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	io.WriteString(c, "hello through the bridge")
	closeWrite(c)
	got, _ := io.ReadAll(c)
	if string(got) != "hello through the bridge" {
		t.Errorf("got %q", got)
	}
}

func testGoEngineLifecycle(t *testing.T, mode goSandboxMode) {
	e, err := startGoEngine(fakeEngineConfig(t, mode, "ok"))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, err := dialCDP(ctx, e)
	if err != nil {
		e.kill("test")
		t.Fatal(err)
	}
	session, err := c.newPage(ctx)
	if err != nil || session != "S1" {
		t.Errorf("newPage: %q %v", session, err)
	}
	c.close()
	pids := processTree(e.cmd.Process.Pid)
	e.kill("closed")
	if e.killReason() != "closed" {
		t.Errorf("reason %q", e.killReason())
	}
	if _, err := os.Stat(e.run); !os.IsNotExist(err) {
		t.Errorf("run directory left behind: %v", err)
	}
	for _, p := range pids {
		if alive(p) {
			b, _ := os.ReadFile(fmt.Sprintf("/proc/%d/status", p))
			t.Errorf("process %d still alive: %s", p, strings.Join(strings.Split(string(b), "\n")[:7], " | "))
		}
	}
}

// alive is whether pid is still running a second from now: not gone, and
// not a zombie waiting to be reaped.
func alive(pid int) bool {
	deadline := time.Now().Add(time.Second)
	for {
		b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
		if err != nil {
			return false
		}
		if i := strings.LastIndexByte(string(b), ')'); i >= 0 && strings.HasPrefix(strings.TrimSpace(string(b[i+1:])), "Z") {
			return false
		}
		if time.Now().After(deadline) {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestGoEngineUnsandboxed(t *testing.T) { testGoEngineLifecycle(t, goUnsandboxed) }

func TestGoEngineSandboxed(t *testing.T) {
	sandboxOrSkip(t)
	testGoEngineLifecycle(t, goSandboxed)
}

func TestGoEngineUnavailable(t *testing.T) {
	if _, err := startGoEngine(fakeEngineConfig(t, goUnavailable, "ok")); err == nil {
		t.Error("an engine started with no way to run")
	}
}

func TestGoSandboxProbeFallback(t *testing.T) {
	if mode, why := goSandboxProbe("", false); mode != goUnavailable || why == "" {
		t.Errorf("without bwrap: %v %q", mode, why)
	}
	if mode, _ := goSandboxProbe("", true); mode != goUnsandboxed {
		t.Errorf("without bwrap, unsandboxed allowed: %v", mode)
	}
	if mode, _ := goSandboxProbe("/bin/false", true); mode != goUnsandboxed {
		t.Errorf("with a bwrap that fails: %v", mode)
	}
}

func TestGoEngineWatchdog(t *testing.T) {
	for _, tc := range []struct {
		behaviour, reason string
		tune              func(*goEngineConfig)
	}{
		{"spin", "a page kept it busy too long", func(c *goEngineConfig) { c.busy = 3 * time.Second }},
		// Stopped by its data limit (it exits) or the watchdog, whichever
		// comes first.
		{"grow", "it used too much memory|it exited", func(c *goEngineConfig) { c.memory = 256 << 20 }},
		{"hang", "it stopped answering", func(c *goEngineConfig) { c.ping = 200 * time.Millisecond }},
		{"die", "it exited", nil},
	} {
		t.Run(tc.behaviour, func(t *testing.T) {
			if tc.behaviour == "grow" && raceEnabled {
				t.Skip("a race-detecting engine can't start under so low a data limit")
			}
			cfg := fakeEngineConfig(t, goUnsandboxed, tc.behaviour)
			if tc.tune != nil {
				tc.tune(&cfg)
			}
			e, err := startGoEngine(cfg)
			if err != nil {
				t.Fatal(err)
			}
			defer e.kill("test over")
			select {
			case <-e.killed:
			case <-time.After(20 * time.Second):
				t.Fatal("the watchdog didn't kill it")
			}
			if got := e.killReason(); !slices.Contains(strings.Split(tc.reason, "|"), got) {
				t.Errorf("reason %q, want %q", got, tc.reason)
			}
		})
	}
}

// TestGoEngineBusyWhileUsed: a busy engine the person keeps using (loading
// heavy sites one after another) isn't taken for a stuck one.
func TestGoEngineBusyWhileUsed(t *testing.T) {
	cfg := fakeEngineConfig(t, goUnsandboxed, "spin")
	cfg.busy = 3 * time.Second
	e, err := startGoEngine(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer e.kill("test over")
	for end := time.Now().Add(6 * time.Second); time.Now().Before(end); time.Sleep(time.Second) {
		e.use()
		select {
		case <-e.killed:
			t.Fatalf("killed while in use: %s", e.killReason())
		default:
		}
	}
	// Left alone, it's stuck.
	select {
	case <-e.killed:
		if got := e.killReason(); got != "a page kept it busy too long" {
			t.Errorf("reason %q", got)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the watchdog didn't kill it once left alone")
	}
}

// TestGoEngineWithMoli runs the real engine, sandboxed where bubblewrap
// works and unsandboxed, loads a page through the egress proxy, and reads
// it over CDP. Set TABTOP_TEST_MOLI to a Moli binary to run it.
func TestGoEngineWithMoli(t *testing.T) {
	moli := os.Getenv("TABTOP_TEST_MOLI")
	if moli == "" {
		t.Skip("TABTOP_TEST_MOLI isn't set to a Moli binary")
	}
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		if r.URL.Path == "/memory" {
			io.WriteString(w, `<!doctype html><title>memory</title><script>const a = []; for (;;) a.push(new Array(1e6).fill(1.5));</script>`)
			return
		}
		io.WriteString(w, `<!doctype html><title>Fixture</title><p id=p>static</p><script>document.getElementById("p").textContent = "scripted";</script>`)
	}))
	defer site.Close()
	goTestPorts(t, portOf(t, site.URL))
	only127 := func(a netip.Addr) bool { return a.Unmap() == netip.MustParseAddr("127.0.0.1") }
	bwrap, _ := exec.LookPath("bwrap")
	for _, mode := range []goSandboxMode{goSandboxed, goUnsandboxed} {
		t.Run(mode.String(), func(t *testing.T) {
			if mode == goSandboxed {
				sandboxOrSkip(t)
			}
			start := time.Now()
			e, err := startGoEngine(goEngineConfig{engine: moli, mode: mode, bwrap: bwrap, allow: only127, logf: t.Logf})
			if err != nil {
				t.Fatal(err)
			}
			defer e.kill("test over")
			t.Logf("started in %s", time.Since(start).Round(time.Millisecond))
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			c, err := dialCDP(ctx, e)
			if err != nil {
				t.Fatal(err)
			}
			defer c.close()
			session, err := c.newPage(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if err := c.call(ctx, session, "Page.navigate", map[string]any{"url": site.URL}, nil); err != nil {
				t.Fatal(err)
			}
			var got string
			for i := 0; i < 100 && got != "Fixture scripted"; i++ {
				var r struct {
					Result struct {
						Value string `json:"value"`
					} `json:"result"`
				}
				if err := c.call(ctx, session, "Runtime.evaluate", map[string]any{
					"expression": `document.title + " " + (document.getElementById("p") || {}).textContent`, "returnByValue": true}, &r); err == nil {
					got = r.Result.Value
				}
				time.Sleep(50 * time.Millisecond)
			}
			if got != "Fixture scripted" {
				t.Errorf("the page reads %q", got)
			}
			pids := processTree(e.cmd.Process.Pid)
			e.kill("done")
			for _, p := range pids {
				if alive(p) {
					t.Errorf("process %d outlived the engine", p)
				}
			}

			// A page that takes all the memory it can: the watchdog, with
			// no cgroup to help, must stop it near the limit.
			const limit = goEngineMemory
			e, err = startGoEngine(goEngineConfig{engine: moli, mode: mode, bwrap: bwrap, allow: only127, logf: t.Logf, memory: limit})
			if err != nil {
				t.Fatal(err)
			}
			defer e.kill("test over")
			c2, err := dialCDP(ctx, e)
			if err != nil {
				t.Fatal(err)
			}
			defer c2.close()
			session, err = c2.newPage(ctx)
			if err != nil {
				t.Fatal(err)
			}
			go c2.call(ctx, session, "Page.navigate", map[string]any{"url": site.URL + "/memory"}, nil)
			var peak int64
			deadline := time.After(20 * time.Second)
		watch:
			for {
				select {
				case <-e.killed:
					break watch
				case <-deadline:
					t.Fatal("the memory page wasn't stopped")
				case <-time.After(20 * time.Millisecond):
					if rss, _ := processTreeUsage(e.cmd.Process.Pid); rss > peak {
						peak = rss
					}
				}
			}
			t.Logf("memory page: %s; peak seen %d MB (limit %d MB)", e.killReason(), peak>>20, limit>>20)
			// Stopped by its memory limit (it exits), or by the watchdog: over
			// budget, or too busy allocating to answer its pings (as on CI's
			// slower machines, with layout on). Either way, under the limit.
			if r := e.killReason(); r != "it used too much memory" && r != "it exited" && r != "it stopped answering" {
				t.Errorf("killed because %q", r)
			}
			// Held under the data segment's limit (it can't pass that), and
			// stopped by the watchdog once over its memory.
			if peak > goEngineDataFactor*limit {
				t.Errorf("peak %d MB is over the data limit, %d MB", peak>>20, goEngineDataFactor*limit>>20)
			}
		})
	}
}

func TestNewServerRemoteBrowser(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	c := validTestConfig()
	c.fetchOn, c.goOn, c.goEngine = true, true, exe
	g, err := newServer(c)
	if err != nil {
		t.Fatal(err)
	}
	if !g.goOn || g.goMode == goUnavailable && g.goWhy == "" {
		t.Errorf("on, with an engine: %v %v %q", g.goOn, g.goMode, g.goWhy)
	}
	if g.goMode != goUnavailable && g.goConfig.engine != exe {
		t.Errorf("engine %q", g.goConfig.engine)
	}

	c.goEngine = filepath.Join(t.TempDir(), "no-moli")
	if g, err = newServer(c); err != nil || g.goMode != goUnavailable || !strings.Contains(g.goWhy, "isn't an executable") {
		t.Errorf("missing engine: %v %q %v", g.goMode, g.goWhy, err)
	}

	// WEB_GO_FETCH=0 makes it unavailable, saying why; so does no engine.
	c.goEngine, c.fetchOn = exe, false
	if g, _ = newServer(c); g.goMode != goUnavailable || !strings.Contains(g.goWhy, "WEB_GO_FETCH=0") {
		t.Errorf("fetching off: %v %q", g.goMode, g.goWhy)
	}
	c.goEngine, c.fetchOn = "", true
	if g, _ = newServer(c); g.goMode != goUnavailable || !strings.Contains(g.goWhy, "no engine") {
		t.Errorf("no engine: %v %q", g.goMode, g.goWhy)
	}
	// Files off doesn't turn it off.
	c.goEngine, c.fsOff = exe, true
	if g, _ = newServer(c); strings.Contains(g.goWhy, "WEB_GO_FETCH") {
		t.Errorf("files off: %v %q", g.goMode, g.goWhy)
	}
}
