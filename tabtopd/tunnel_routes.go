package main

// The requests a tunnel can make, each with whether it needs file support
// (WEB_FS) and what serves it: one table, so a request is gated as it's
// routed, and none can be added to one and left out of the other.

import (
	"errors"
	"fmt"
	"log"
	"slices"
	"strings"
	"time"
)

// tunnelCall is a request, as serveRequest received it, to answer.
type tunnelCall struct {
	t           *tunnel
	req         tunnelRequest
	session, ip string
	r           *tunnelResponder
}

type tunnelRoute struct {
	files bool // refused with file support off
	serve func(g *server, c *tunnelCall)
}

// files and other are routes that do, and don't, need file support.
func files(serve func(g *server, c *tunnelCall)) tunnelRoute {
	return tunnelRoute{files: true, serve: serve}
}
func other(serve func(g *server, c *tunnelCall)) tunnelRoute { return tunnelRoute{serve: serve} }

var tunnelRoutes = map[string]tunnelRoute{
	// The desktop, the terminal, and the desktop's sound.
	"vnc":   other((*server).routeVNC),
	"tty":   other((*server).routeTTY),
	"audio": other((*server).routeAudio),
	"mic":   other((*server).routeMic),

	// Sessions, and the activity log: kept with file support off.
	"logout":         other((*server).routeLogout),
	"end-session":    other((*server).routeEndSession),
	"logout-all":     other((*server).routeLogoutAll),
	"sessions":       other((*server).routeSessions),
	"name-session":   other((*server).routeNameSession),
	"seen":           other((*server).routeSeen),
	"activity":       other((*server).routeActivity),
	"activity-clear": other((*server).routeActivityClear),

	// Files.
	"list":         files(func(g *server, c *tunnelCall) { g.tunnelFiles(c.t, c.req, c.r) }),
	"file":         files(func(g *server, c *tunnelCall) { g.tunnelFiles(c.t, c.req, c.r) }),
	"upload":       files(func(g *server, c *tunnelCall) { g.tunnelUpload(c.t, c.req, c.r) }),
	"mkdir":        files(func(g *server, c *tunnelCall) { g.tunnelMkdir(c.t, c.req, c.r) }),
	"create":       files(func(g *server, c *tunnelCall) { g.tunnelCreate(c.t, c.req, c.r) }),
	"zip":          files(func(g *server, c *tunnelCall) { g.tunnelZip(c.t, c.req, c.ip, c.r) }),
	"rename":       files(func(g *server, c *tunnelCall) { g.tunnelRename(c.t, c.req, c.ip, c.r) }),
	"move":         files(func(g *server, c *tunnelCall) { g.tunnelMove(c.t, c.req, c.ip, c.r) }),
	"delete":       files(func(g *server, c *tunnelCall) { g.tunnelDelete(c.t, c.req, c.ip, c.r) }),
	"watch":        files(func(g *server, c *tunnelCall) { g.tunnelWatch(c.t, c.r) }),
	"changes":      files(func(g *server, c *tunnelCall) { g.tunnelChanges(c.t, c.req, c.r) }),
	"cleanup":      files((*server).routeCleanup),
	"zip-preview":  files(func(g *server, c *tunnelCall) { g.tunnelZipPreview(c.t, c.req, c.r) }),
	"zip-extract":  files(func(g *server, c *tunnelCall) { g.tunnelZipExtract(c.req, c.session, c.ip, c.r) }),
	"zip-download": files(func(g *server, c *tunnelCall) { g.tunnelZipDownload(c.t, c.req, c.session, c.ip, c.r) }),
	"file-patch":   files(func(g *server, c *tunnelCall) { g.tunnelFilePatch(c.req, c.session, c.ip, c.r) }),
	"file-search":  files(func(g *server, c *tunnelCall) { g.tunnelFileSearch(c.req, c.r) }),

	// Previews.
	"markdown":         files(func(g *server, c *tunnelCall) { g.tunnelMarkdown(c.t, c.req, c.r) }),
	"epub":             files(func(g *server, c *tunnelCall) { g.tunnelEpub(c.t, c.req, c.r) }),
	"epub-edit":        files(func(g *server, c *tunnelCall) { g.tunnelEpubEdit(c.t, c.req, c.r) }),
	"sqlite":           files(func(g *server, c *tunnelCall) { g.tunnelSQLite(c.req, c.r) }),
	"preview-resource": files(func(g *server, c *tunnelCall) { g.tunnelPreviewResource(c.t, c.req, c.r) }),

	// Fetching into Downloads, and share links to it.
	"fetch":        files(func(g *server, c *tunnelCall) { g.tunnelFetch(c.t, c.req, c.session, c.ip, c.r) }),
	"fetches":      files((*server).routeFetches),
	"share":        files(func(g *server, c *tunnelCall) { g.tunnelShare(c.req, c.session, c.ip, c.r) }),
	"share-again":  files((*server).routeShareAgain),
	"reshare":      files((*server).routeReshare),
	"reshare-many": files((*server).routeReshareMany),
	"unshare":      files((*server).routeUnshare),
}

func (g *server) routeVNC(c *tunnelCall) {
	if g.vncOff {
		c.r.fail("The desktop is turned off (WEB_VNC=0).")
		return
	}
	c.t.c.SetReadLimit(maxClientMessage + tunnelOverhead)
	if c.r.accept(nil) {
		g.bridgeDesktop(c.t, c.session, c.ip)
	}
}

func (g *server) routeTTY(c *tunnelCall) {
	if g.termDir == "" {
		c.r.fail("The terminal is turned off.")
		return
	}
	if !g.openTTY(c.session) {
		c.r.fail("Too many open terminals.")
		return
	}
	defer g.closeTTY(c.session)
	c.t.c.SetReadLimit(maxTTYMessage + tunnelOverhead)
	// search: whether there's tmux's history to search (see tty.go).
	if c.r.accept(map[string]any{"search": g.ttyCommand == ""}) {
		g.serveTTY(c.t, c.session, c.ip)
	}
}

func (g *server) routeAudio(c *tunnelCall) {
	if g.audio == nil {
		c.r.fail("Desktop audio is turned off.")
		return
	}
	// Only while this session has the desktop open, from the same IP.
	l, err := g.audio.join(c.session, c.ip)
	switch {
	case errors.Is(err, errAudioDenied):
		c.r.fail("Connect to the desktop first.")
		return
	case err != nil:
		log.Printf("audio: %v", err)
		c.r.fail("Audio is unavailable.")
		return
	}
	log.Printf("audio tunnel listener from %s joined", c.ip)
	defer log.Printf("audio tunnel listener from %s left", c.ip)
	defer g.audio.leave(l)
	if c.r.accept(nil) {
		streamAudio(c.t, l)
	}
}

func (g *server) routeMic(c *tunnelCall) {
	if g.audio == nil {
		c.r.fail("Desktop audio is turned off.")
		return
	}
	// As for audio: only while this session has the desktop open, from
	// the same IP.
	l, buf, stop, err := g.audio.joinMic(c.session, c.ip)
	switch {
	case errors.Is(err, errNoMic):
		c.r.fail(noMicMsg)
		return
	case errors.Is(err, errAudioDenied):
		c.r.fail("Connect to the desktop first.")
		return
	case err != nil:
		log.Printf("microphone: %v", err)
		c.r.fail("The microphone is unavailable.")
		return
	}
	defer stop()
	log.Printf("microphone from %s on", c.ip)
	defer log.Printf("microphone from %s off", c.ip)
	if c.r.accept(map[string]any{"codec": "opus", "sampleRate": micRate, "channels": 1}) {
		receiveMic(c.t, l, buf)
	}
}

func (g *server) routeLogout(c *tunnelCall) {
	g.act(c.session, "logout", c.ip, "logged out")
	g.endSession(c.session, "Logged out.", c.t)
	c.r.finish(nil)
}

// routeEndSession ends another of the sessions listed, by its handle (see
// sessionsReport), and the links it made, so it keeps no access through
// them.
func (g *server) routeEndSession(c *tunnelCall) {
	session, ip, name := c.session, c.ip, c.req.Name
	if !g.endSessionByHandle(name, session, ip) {
		c.r.fail("That session is over already, or it's this one.")
		return
	}
	g.act(session, "end-session", ip, "ended another session")
	if g.fetches != nil {
		g.fetches.cancelMatching(func(j *fetchJob) bool { return j.by == name })
	}
	if n := g.revokeShares(func(l *shareLink) bool { return l.By == name }); n > 0 {
		log.Printf("%d share links revoked with the session ended from %s", n, ip)
		g.act(session, "share", ip, "revoked %d link%s the ended session made", n, plural(n))
	}
	c.r.finish(nil)
}

func (g *server) routeLogoutAll(c *tunnelCall) {
	log.Printf("all sessions logged out from %s", c.ip)
	g.act(c.session, "logout-all", c.ip, "logged out everywhere")
	g.endAllSessions("Logged out everywhere.", c.t)
	if g.fetches != nil {
		g.fetches.cancelMatching(func(*fetchJob) bool { return true })
	}
	if n := g.revokeShares(func(*shareLink) bool { return true }); n > 0 {
		log.Printf("%d share links revoked with every session", n)
		g.act(c.session, "share", c.ip, "revoked every link (%d) with logging out everywhere", n)
	}
	c.r.finish(nil)
}

func (g *server) routeSessions(c *tunnelCall) {
	report := g.sessionsReport(c.session, c.t)
	if w := g.ipWarningOf(c.t); w != "" {
		report["ip_warning"] = w
	}
	if g.shares != nil {
		report["shares"] = g.shares.list(sessionHandle(c.session))
	}
	c.r.finish(report)
}

// routeNameSession names a session listed, by its handle (this one for
// ""), req.Label ("" for none).
func (g *server) routeNameSession(c *tunnelCall) {
	label, ok := shareLabel(c.req.Label)
	if !ok || len([]rune(label)) > 50 {
		c.r.fail("A session's name is one line of at most 50 characters.")
		return
	}
	before := g.sessionName(c.session)
	found, own := g.nameSession(c.req.Name, c.session, label)
	if !found {
		c.r.fail("That session is over already.")
		return
	}
	switch {
	case own && label != before:
		g.act(c.session, "session", c.ip, "named this session %q", label)
	case !own:
		g.act(c.session, "session", c.ip, "named another session %q", label)
	}
	c.r.finish(nil)
}

// routeSeen marks the files page's security warnings as seen: what's
// listed now no longer marks it (see sessionsReport).
func (g *server) routeSeen(c *tunnelCall) {
	g.mu.Lock()
	g.seen = time.Now()
	g.mu.Unlock()
	log.Printf("security warnings marked as seen from %s", c.ip)
	c.r.finish(nil)
}

// routeActivity answers with the newest req.Max entries of the activity
// log (all for 0).
func (g *server) routeActivity(c *tunnelCall) {
	entries, total := g.activity.list(c.req.Max)
	c.r.finish(map[string]any{"entries": entries, "total": total, "max": maxActivity})
}

func (g *server) routeActivityClear(c *tunnelCall) {
	g.activity.clear(c.ip, g.sessionName(c.session))
	log.Printf("activity log cleared from %s", c.ip)
	c.r.finish(nil)
}

// routeCleanup deletes uploads cut off and temporary files (see
// cleanup.go), or with req.DryRun, counts them.
func (g *server) routeCleanup(c *tunnelCall) {
	rep := g.cleanup(c.req.DryRun)
	if !c.req.DryRun && (rep.Kept > 0 || rep.Temps > 0) {
		log.Printf("cleaned up from %s: %d uploads kept to carry on, %d temporary files, %s", c.ip, rep.Kept, rep.Temps, humanSize(rep.Bytes))
		g.act(c.session, "cleanup", c.ip, "cleaned up %s: %d upload%s kept to carry on, and %d leftover temporary file%s",
			humanSize(rep.Bytes), rep.Kept, plural(rep.Kept), rep.Temps, plural(rep.Temps))
	}
	c.r.finish(map[string]any{"cleanup": rep})
}

func (g *server) routeFetches(c *tunnelCall) {
	if g.fetches == nil {
		c.r.fail("Fetching from URLs is turned off (WEB_FETCH=0).")
		return
	}
	c.r.finish(map[string]any{"fetches": g.fetches.list()})
}

// routeShareAgain shows a link listed, by its handle, again.
func (g *server) routeShareAgain(c *tunnelCall) {
	if g.shares == nil {
		c.r.fail("Share links are turned off (WEB_SHARE=0).")
		return
	}
	reply, err := g.shares.shareLinkAgain(c.req.Name)
	if err != nil {
		c.r.fail(err.Error())
		return
	}
	g.act(c.session, "share", c.ip, "showed the link to %s again", folderOrPath(reply))
	c.r.finish(reply)
}

// routeReshare changes a link listed, by its handle: to end req.Expires
// seconds from now (0 keeps when it ends), with req.Max, req.MaxBytes and
// req.Label.
func (g *server) routeReshare(c *tunnelCall) {
	req := c.req
	life := time.Duration(req.Expires) * time.Second
	if g.shares == nil || req.Expires != 0 && (life < time.Minute || life > maxShareLife) || req.Max < 0 || req.Max > 1000 {
		c.r.fail("That's not a lifetime or limit a link can have.")
		return
	}
	label, ok := shareLabel(req.Label)
	if !ok {
		c.r.fail(fmt.Sprintf("A label is one line of at most %d characters.", maxLabel))
		return
	}
	l, err := g.shares.change(req.Name, life, req.Max, req.MaxBytes, label)
	if err != nil {
		c.r.fail(err.Error())
		return
	}
	n := g.shares.now(l)
	log.Printf("share link to %q changed from %s: until %s, %s", l.Path, c.ip, n.Expires.Format(time.RFC3339), maxText(n.Max))
	// (What it was changed to, as sent and as now() read it under the
	// lock: another change can come meanwhile.)
	g.act(c.session, "share", c.ip, "changed the %s to %s%s: until %s, %s", linkKind(l), linkTarget(l), labelQuote(label), n.Expires.UTC().Format("2006-01-02 15:04 UTC"),
		countText(n.Max, map[bool]string{true: "file", false: "download"}[l.Upload]))
	c.r.finish(map[string]any{"expires": n.Expires})
}

// routeReshareMany changes links listed, by their handles in req.Names:
// each made to end req.Expires seconds from now (0 keeps when it ends),
// and with req.Relabel, labelled req.Label.
func (g *server) routeReshareMany(c *tunnelCall) {
	req := c.req
	life := time.Duration(req.Expires) * time.Second
	label, ok := shareLabel(req.Label)
	if g.shares == nil || req.Expires != 0 && (life < time.Minute || life > maxShareLife) || !ok {
		c.r.fail("That's not a lifetime or label a link can have.")
		return
	}
	changed := g.shares.changeMany(req.Names, life, label, req.Relabel)
	if len(changed) == 0 {
		c.r.fail("Those links have ended already.")
		return
	}
	what := []string{}
	if life > 0 {
		what = append(what, "to end "+lifeText(life)+" from now")
	}
	if req.Relabel {
		what = append(what, fmt.Sprintf("labelled %q", label))
	}
	slices.Sort(changed)
	g.act(c.session, "share", c.ip, "changed %d link%s (%s): %s", len(changed), plural(len(changed)), strings.Join(changed, ", "), strings.Join(what, ", "))
	c.r.finish(map[string]any{"changed": len(changed)})
}

// routeUnshare revokes links listed, by their handles (see shareInfo):
// req.Name, or req.Names.
func (g *server) routeUnshare(c *tunnelCall) {
	handles := map[string]bool{c.req.Name: c.req.Name != ""}
	for _, h := range c.req.Names {
		handles[h] = true
	}
	var revoked []string
	n := g.revokeShares(func(l *shareLink) bool {
		if handles[l.handle()] {
			revoked = append(revoked, linkTarget(l)+labelText(l))
			return true
		}
		return false
	})
	if n == 0 {
		c.r.fail("That link has ended already.")
		return
	}
	slices.Sort(revoked)
	log.Printf("%d share links revoked from %s", n, c.ip)
	g.act(c.session, "share", c.ip, "revoked the link%s to %s", plural(n), strings.Join(revoked, ", "))
	c.r.finish(map[string]any{"revoked": n})
}
