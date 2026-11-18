package main

// The remote browser's tunnel route, "go" (see docs/browser-plan.md,
// sections 4 and 6). One tunnel is one browsing context: its own engine
// (goengine.go), started for it and killed when it closes, as it does when
// the page closes it, the session ends or logs out, or the server stops.
// What goes over it, both ways, is gobrowser.go's.
//
// The page sends JSON text:
//
//	{"op":"navigate","url":...,"view":{"w":...,"h":...,"dpr":...}}  {"op":"stop"}
//	{"op":"viewport","view":{...}}  the frame's size changed: the engine's window follows
//	{"op":"event","gen":N,"kind":"click"|"input"|"change"|"key"|"submit"|"focus","id":...}
//	{"op":"dialog","accept":...,"text":...}  {"op":"resync","gen":N}
//
// and the server answers, for each generation (a navigation, the person's
// or the page's):
//
//	{"type":"go-loading","gen":N,"url":...,"by":"you"|"page"}
//	{"type":"go-snapshot","gen":N,"url":final,"base":...,"title":...,"doc":tree,"again":bool}
//	{"type":"go-changes","gen":N,"seq":K,"title":...,"ops":[...]}
//	{"type":"go-url","gen":N,"url":...}         the page changed its address itself
//	{"type":"go-dialog","gen":N,"kind":...,"message":...,"default":...,"url":...}
//	{"type":"go-file","gen":N,"url":...,"mime":...}  a file, not a page
//	{"type":"go-error","gen":N,"message":...}
//
// A snapshot's nodes are {"i":id,"t":type,"n":name,"v":text,"a":[name,
// value,...],"c":[...]}, read by the agent (goagent.js) in an isolated
// world, with what can never be shown left out (scripts, noscript,
// templates, comments, event handler attributes), again here (goClean). It's
// still the page's, so the page that shows it sanitizes it again, and loads
// nothing from the web itself.
import (
	"context"
	"errors"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	// Engines (browsing contexts) open at once, for a session and in all.
	maxGoPerSession = 3
	maxGoEngines    = 8
	// goClientMessage is the largest message the page may send: a URL.
	goClientMessage = 64 << 10
	maxGoURL        = 8 << 10
	// goSnapshotLimit is the largest snapshot sent; a bigger page is an
	// error, not a partial one.
	goSnapshotLimit = 16 << 20
	// goLoadTimeout is how long a page has to load before what's there is
	// shown anyway.
	goLoadTimeout = 30 * time.Second
	goCallTimeout = 15 * time.Second
)

// openGo counts an engine for session, unless that's too many.
func (g *server) openGo(session string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.goEngines == nil {
		g.goEngines = map[string]int{}
	}
	total := 0
	for _, n := range g.goEngines {
		total += n
	}
	if total >= maxGoEngines || g.goEngines[session] >= maxGoPerSession {
		return false
	}
	g.goEngines[session]++
	return true
}

func (g *server) closeGo(session string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.goEngines[session]--; g.goEngines[session] <= 0 {
		delete(g.goEngines, session)
	}
}

func (g *server) routeGo(c *tunnelCall) {
	switch {
	case !g.goOn:
		c.r.fail("The remote browser is turned off (WEB_GO=0).")
		return
	case g.goMode == goUnavailable:
		c.r.fail("The remote browser is unavailable: " + g.goWhy + ".")
		return
	}
	if !g.openGo(c.session) {
		c.r.fail("Too many remote browser tabs are open.")
		return
	}
	defer g.closeGo(c.session)
	e, err := startGoEngine(g.goConfig)
	if err != nil {
		log.Printf("go: engine for %s: %v", c.ip, err)
		c.r.fail("The remote browser's engine didn't start.")
		return
	}
	defer e.kill("its tab was closed")
	ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
	cdp, err := dialCDP(ctx, e)
	var page, target string
	if err == nil {
		page, target, err = cdp.newPageTarget(ctx)
	}
	for _, m := range []string{"Page.enable", "Runtime.enable", "Network.enable"} {
		if err == nil {
			err = cdp.call(ctx, page, m, nil, nil)
		}
	}
	cancel()
	if err != nil {
		if cdp != nil {
			cdp.close()
		}
		log.Printf("go: engine for %s: %v", c.ip, err)
		c.r.fail("The remote browser's engine didn't start.")
		return
	}
	defer cdp.close()
	c.t.c.SetReadLimit(goClientMessage + tunnelOverhead)
	if !c.r.accept(map[string]any{"sandboxed": g.goMode == goSandboxed}) {
		return
	}
	log.Printf("go: remote browser tab from %s opened (%s)", c.ip, g.goMode)
	newGoBrowser(c.t, e, cdp, page, target).run()
	log.Printf("go: remote browser tab from %s closed", c.ip)
}

// goURL checks a URL the page asked for: HTTP or HTTPS, with a host and no
// credentials. Where it may go is the egress proxy's to decide.
func goURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if len(raw) > maxGoURL {
		return "", errors.New("That address is too long.")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.Scheme != "http" && u.Scheme != "https" {
		return "", errors.New("Enter an address starting with http:// or https://.")
	}
	if u.User != nil {
		return "", errors.New("Addresses with a user name or password aren't supported.")
	}
	return u.String(), nil
}

// goNavError is what the page is told when a navigation fails.
func goNavError(err error) string {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "ERR_FAILED"), strings.Contains(msg, "ERR_TUNNEL"), strings.Contains(msg, "ERR_PROXY"):
		return "The page couldn't be loaded: the site can't be reached from here, or the server doesn't allow that address."
	case errors.Is(err, context.DeadlineExceeded):
		return "The page took too long to load."
	}
	return "The page couldn't be loaded (" + msg + ")."
}

// goNode is a node of a snapshot.
type goNode struct {
	ID    int       `json:"i"`
	Type  int       `json:"t"`
	Name  string    `json:"n,omitempty"`
	Value string    `json:"v,omitempty"`
	Attrs []string  `json:"a,omitempty"`
	Kids  []*goNode `json:"c,omitempty"`
}

// goDropped are elements a snapshot leaves out, with all inside them:
// scripts have run in the engine already, noscript is for when they
// don't, and a template's content isn't the page's.
var goDropped = map[string]bool{"script": true, "noscript": true, "template": true}

// goClean takes out of a snapshot, again, what the serializer leaves out:
// elements that can never be shown and event handler attributes. (The page
// that shows the snapshot sanitizes it a third time.)
func goClean(n *goNode) *goNode {
	if n == nil {
		return nil
	}
	switch n.Type {
	case 1:
		if goDropped[strings.ToLower(n.Name)] {
			return nil
		}
		var attrs []string
		for i := 0; i+1 < len(n.Attrs); i += 2 {
			if !strings.HasPrefix(strings.ToLower(n.Attrs[i]), "on") {
				attrs = append(attrs, n.Attrs[i], n.Attrs[i+1])
			}
		}
		n.Attrs = attrs
		n.Value = ""
	case 3:
		n.Name, n.Attrs, n.Kids = "", nil, nil
		return n
	case 9, 11:
		n.Name, n.Value, n.Attrs = "", "", nil
	default:
		return nil
	}
	kids := n.Kids[:0]
	for _, k := range n.Kids {
		if c := goClean(k); c != nil {
			kids = append(kids, c)
		}
	}
	n.Kids = kids
	return n
}

// goTitleOf is the title a snapshot gives, made one line.
func goTitleOf(title string) string { return strings.Join(strings.Fields(title), " ") }

// goOwnerFile names, in an engine's run directory, the tabtopd it's for.
const goOwnerFile = "owner"

// sweepGoRunDirs removes run directories (tabtop-go-*) left by a tabtopd
// that's gone: killed, say, before it could remove them. Those of a
// tabtopd still running, this one included, are left alone.
func sweepGoRunDirs() {
	dirs, _ := filepath.Glob(filepath.Join(os.TempDir(), "tabtop-go-*"))
	for _, dir := range dirs {
		b, err := os.ReadFile(filepath.Join(dir, goOwnerFile))
		if err != nil {
			// Without an owner: one being made, unless it's old.
			if fi, err := os.Stat(dir); err != nil || time.Since(fi.ModTime()) < time.Hour {
				continue
			}
		} else if pid, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil {
			if err := syscall.Kill(pid, 0); pid == os.Getpid() || err == nil || errors.Is(err, syscall.EPERM) {
				continue
			}
		}
		os.RemoveAll(dir)
	}
}
