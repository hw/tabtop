package main

// The page scripts under /tabtop/ (with the noble libraries'
// cryptography), the files page (a script that lists, fetches, uploads and
// deletes files through the tunnel), and /tunnel (see tunnel.go), which
// logs in or answers a session's request.

import (
	"bytes"
	"context"
	"crypto/rand"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io"
	"log"
	"net/http"
	"path"
	"slices"
	"strings"
	"time"

	"github.com/coder/websocket"
)

const (
	// Size of the data messages a file is sent in.
	fileChunk = 256 << 10
	// How many of a file's chunks may be sent before the page acknowledges
	// them, and how long the server waits for an acknowledgement.
	fileWindow = 32
	// The most a file request asks for a part of the file may get.
	maxFileRange = 16 << 20
	fileStall    = 2 * time.Minute
	// The downloads page loads its script and talks to the tunnel. It
	// registers download-sw.js and opens its downloads in a hidden frame;
	// blob: is for saving files held in memory where there's no service
	// worker, and for previews (see preview.js), which never use a frame.
	filesCSP = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; " +
		"img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self'; frame-src 'self'; form-action 'none'; frame-ancestors 'none'"
	// The download service worker fetches nothing itself.
	downloadSWCSP = "default-src 'none'"
)

//go:embed media-stream.js video-stream.js glyphs.js pdf-frame.js epub-frame.js md-frame.js json-view.js table-view.js transfer.js folder-model.js osc.js tunnel.js tunnel-protocol.js tunnel-crypto.js session.js session-state.js login-ui.js file-format.js sessions-view.js novnc.js files.js download-sw.js drop.js ui.js nav.js requests.js preview.js reconnect.js download.js expiry.js
var e2eFiles embed.FS

// The files of the noble libraries that tunnel.js imports, directly or
// through each other, from -noble-dir: @noble/ciphers for
// ChaCha20-Poly1305, and @noble/curves for X25519 and @noble/hashes for
// SHA-2 and HKDF where the browser's WebCrypto can't do them. The
// Dockerfile's noble stage copies the same list.
var nobleFiles = []string{
	"ciphers/chacha.js", "ciphers/_arx.js", "ciphers/_poly1305.js", "ciphers/utils.js",
	"curves/ed25519.js", "curves/utils.js", "curves/abstract/curve.js", "curves/abstract/edwards.js",
	"curves/abstract/fft.js", "curves/abstract/frost.js", "curves/abstract/hash-to-curve.js",
	"curves/abstract/modular.js", "curves/abstract/montgomery.js", "curves/abstract/oprf.js",
	"hashes/sha2.js", "hashes/_md.js", "hashes/_u64.js", "hashes/hkdf.js", "hashes/hmac.js", "hashes/utils.js",
}

// noblePath is where the noble files are served, under /tabtop/ (see
// assetSet). tunnel.js is served with its "./noble/" imports pointing there.
func (g *server) noblePath() string { return g.noble.path(g.nobleAssets()) }

func (g *server) nobleAssets() assets { return assets{"noble", g.nobleDir, nobleFiles} }

// The files of highlight.js that preview.js imports, from -highlight-dir,
// for the colours of text previews: its ES module build, with the common
// languages, and a few more. The Dockerfile's highlight stage copies the
// same list.
var highlightFiles = []string{
	"highlight.min.js", "languages/dockerfile.min.js", "languages/dos.min.js", "languages/latex.min.js",
	"languages/nginx.min.js", "languages/powershell.min.js", "languages/scala.min.js",
	// The classic builds, for the Markdown preview's frame (see md-frame.js),
	// which loads only classic scripts: modules would need CORS from the
	// frame's origin of its own.
	"classic/highlight.min.js", "classic/languages/dockerfile.min.js", "classic/languages/dos.min.js",
	"classic/languages/latex.min.js", "classic/languages/nginx.min.js", "classic/languages/powershell.min.js",
	"classic/languages/scala.min.js",
}

// The libraries the Markdown preview's frame renders with, from
// -preview-dir: KaTeX for math, and Mermaid for diagrams. The Dockerfile's
// preview stage copies the same list.
var previewFiles = []string{"katex.min.js", "mermaid.min.js"}

func (g *server) previewPath() string {
	if g.previewDir == "" {
		return "preview-missing"
	}
	return g.preview.path(g.previewAssets())
}

func (g *server) previewAssets() assets { return assets{"preview", g.previewDir, previewFiles} }

// mdFrameCSP is the Markdown preview frame's: scripts only from the site
// (its own, and the libraries), styles inline (Mermaid puts its own in its
// SVGs), and pictures only as blob: and data: URLs, which the page hands it
// (see md-frame.js). Nothing else: no fetching, no forms, no frames.
//
// Its own sandbox too, as the files page frames it: opened as a page of its
// own, or a popup, it's still at an origin of its own, not the site's.
const mdFrameCSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src blob: data:; " +
	"base-uri 'none'; form-action 'none'; frame-ancestors 'self'; " + frameSandbox

// frameSandbox is the frames' sandbox, as the files page gives it them.
const frameSandbox = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox"

// mdFrameHTML is the frame's page.
var mdFrameHTML = "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\">\n" +
	"<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>Markdown</title>\n<style>" +
	mdFrameCSS + highlightCSS + "</style>\n<main id=\"doc\"></main>\n<script src=\"md-frame.js\"></script>\n"

// highlightPath is where they're served, under /tabtop/; preview.js is
// served with its "./highlight/" imports pointing there. Without
// -highlight-dir, it's a path that serves nothing, and previews have no
// colours.
func (g *server) highlightPath() string {
	if g.highlightDir == "" {
		return "highlight-missing"
	}
	return g.highlight.path(g.highlightAssets())
}

func (g *server) highlightAssets() assets { return assets{"highlight", g.highlightDir, highlightFiles} }

// scripts serves the page scripts under /tabtop/, and the desktop's
// stylesheet for them.
func (g *server) scripts(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Content-Type", "text/javascript; charset=utf-8")
	h.Set("Cache-Control", "no-cache, no-transform")
	h.Set("X-Content-Type-Options", "nosniff")
	name := strings.TrimPrefix(r.URL.Path, "/tabtop/")
	switch {
	case name == "audio.js":
		if g.audio == nil {
			io.WriteString(w, "// Desktop audio is turned off (WEB_AUDIO=0).\n")
			return
		}
		js := audioJS
		if g.audio.play == nil {
			js = bytes.Replace(js, []byte("const micOffered = true;"), []byte("const micOffered = false;"), 1)
		}
		w.Write(js)
	case name == "mic-worklet.js" && g.audio != nil:
		w.Write(micWorkletJS)
	case name == "md-frame.html":
		h.Set("Content-Type", "text/html; charset=utf-8")
		h.Set("Content-Security-Policy", mdFrameCSP)
		h.Set("Referrer-Policy", "no-referrer")
		io.WriteString(w, mdFrameHTML)
	case name == "pdf-frame.html":
		h.Set("Content-Type", "text/html; charset=utf-8")
		h.Set("Content-Security-Policy", pdfFrameCSP)
		h.Set("Referrer-Policy", "no-referrer")
		io.WriteString(w, pdfFrameHTML)
	case name == "epub-frame.html":
		h.Set("Content-Type", "text/html; charset=utf-8")
		h.Set("Content-Security-Policy", mdFrameCSP)
		h.Set("Referrer-Policy", "no-referrer")
		io.WriteString(w, epubFrameHTML)
	case name == "pdf-frame.js":
		js, _ := e2eFiles.ReadFile(name)
		w.Write(bytes.ReplaceAll(js, []byte(`"./pdfjs/`), []byte(`"./`+g.pdfjsPath()+`/`)))
	case name == "glyphs.js":
		// Static UI artwork, also imported by frames with opaque origins.
		h.Set("Access-Control-Allow-Origin", "*")
		http.ServeFileFS(w, r, e2eFiles, name)
	case name == "md-frame.js":
		js, _ := e2eFiles.ReadFile(name)
		js = bytes.ReplaceAll(js, []byte(`"./preview/`), []byte(`"./`+g.previewPath()+`/`))
		w.Write(bytes.ReplaceAll(js, []byte(`"./highlight/`), []byte(`"./`+g.highlightPath()+`/`)))
	case name == "preview.js":
		js, _ := e2eFiles.ReadFile(name)
		w.Write(bytes.ReplaceAll(js, []byte(`"./highlight/`), []byte(`"./`+g.highlightPath()+`/`)))
	case name == "tunnel-crypto.js":
		js, _ := e2eFiles.ReadFile(name)
		w.Write(bytes.ReplaceAll(js, []byte(`"./noble/`), []byte(`"./`+g.noblePath()+`/`)))
	case name == "media-stream.js" || name == "video-stream.js" || name == "epub-frame.js" || name == "json-view.js" || name == "table-view.js" || name == "transfer.js" || name == "folder-model.js" || name == "osc.js" || name == "tunnel.js" || name == "tunnel-protocol.js" || name == "session-state.js" || name == "session.js" || name == "login-ui.js" || name == "file-format.js" || name == "sessions-view.js" || name == "novnc.js" || name == "files.js" || name == "drop.js" || name == "ui.js" || name == "nav.js" ||
		name == "requests.js" || name == "reconnect.js" || name == "download.js" || name == "expiry.js":
		http.ServeFileFS(w, r, e2eFiles, name)
	case name == "desktop.css":
		h.Set("Content-Type", "text/css; charset=utf-8")
		io.WriteString(w, desktopCSS)
	case name == "download-sw.js":
		h.Set("Service-Worker-Allowed", "../")
		h.Set("Content-Security-Policy", downloadSWCSP)
		http.ServeFileFS(w, r, e2eFiles, name)
	case g.noble.serve(w, r, g.nobleAssets(), name):
	case g.highlightDir != "" && g.highlight.serve(w, r, g.highlightAssets(), name):
	case g.previewDir != "" && g.preview.serve(w, r, g.previewAssets(), name):
	case g.servePDFJS(w, r, name):
	default:
		h.Del("Content-Type")
		http.NotFound(w, r)
	}
}

var filesTmpl = template.Must(template.New("files").Parse(pageHead + `
<title>Downloads</title><body>
<p>Loading…</p>
<script type="module" src="{{.Script}}"></script>`))

// filesPage serves the files page. It's the same for every path: the
// script shows the directory named after the "#", so other paths redirect
// there.
func (g *server) filesPage(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Cache-Control", "no-store, no-transform")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	rest := strings.TrimPrefix(r.URL.Path, filesPrefix)
	if token, name, ok := shareRequest(rest); ok && g.shares != nil {
		g.serveShare(w, r, token, name)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if rest != "" {
		http.Redirect(w, r, g.abs(filesPrefix)+"#/"+escapePath(rest), http.StatusSeeOther)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", filesCSP)
	w.WriteHeader(http.StatusOK)
	if err := filesTmpl.Execute(w, map[string]any{"Script": "../tabtop/files.js"}); err != nil {
		log.Printf("rendering page: %v", err)
	}
}

// tunnelRequest is a session tunnel's first message: what it's for.
type tunnelRequest struct {
	Type  string   `json:"type"` // vnc, logout, logout-all, end-session, sessions, seen, tty, list, file, zip, upload, mkdir, rename, move, delete, watch, changes, audio, mic, share, share-again, reshare, unshare, cleanup, name-session, reshare-many, zip-preview, markdown, epub, epub-edit, fetch, fetches, activity or activity-clear
	Path  string   `json:"path,omitempty"`
	Name  string   `json:"name,omitempty"`  // upload, mkdir: the file's or folder's name, in the folder at Path; rename: the new name; end-session: the session's handle
	Size  int64    `json:"size,omitempty"`  // upload: its size
	Names []string `json:"names,omitempty"` // zip: what to put in it, in the folder at Path
	To    string   `json:"to,omitempty"`    // move: the folder to move what's at Path into
	// upload: replace a file that has the name, rather than save under a
	// free one
	Replace bool `json:"replace,omitempty"`
	// upload, with Replace: only if the file there is still as the page
	// read it, with this version (see fileVersion) and IfSize;
	// file and epub: only of the file as it was
	IfMtime string `json:"if_mtime,omitempty"`
	IfSize  int64  `json:"if_size,omitempty"`
	// epub: a chapter or picture of the book at Path, by its path in the
	// book, rather than the book (see epub.go)
	Item string `json:"item,omitempty"`
	// epub-edit: the book's new title and author (see epub_edit.go)
	Title   string `json:"title,omitempty"`
	Creator string `json:"creator,omitempty"`
	// file: only Length bytes of it, from Offset (see maxFileRange)
	Offset int64 `json:"offset,omitempty"`
	Length int64 `json:"length,omitempty"`
	// upload: the id of one cut off, to carry on with (see keepPartial)
	Resume string `json:"resume,omitempty"`
	// share: how long the link lasts, in seconds, and how many downloads
	// it allows (0 for no limit)
	Expires int64 `json:"expires,omitempty"`
	Max     int   `json:"max,omitempty"`
	// share: an upload link, into the folder at Path, rather than a
	// download link; Max is then files, and MaxBytes what they may come to
	// in all
	Upload   bool  `json:"upload,omitempty"`
	MaxBytes int64 `json:"max_bytes,omitempty"`
	// fetch: the address to fetch into the folder at Path (or, with Name,
	// the id of a fetch to follow)
	URL string `json:"url,omitempty"`
	// share, reshare: the link's label
	Label string `json:"label,omitempty"`
	// share: for downloading the file now, from this page, over HTTPS (a
	// preview's Direct Download): the link, for one download, is counted
	// as made, and comes with a ticket that fetches it (see ticket)
	Direct bool `json:"direct,omitempty"`
	// reshare-many: set the label too
	Relabel bool `json:"relabel,omitempty"`
	// cleanup: only say what it would delete
	DryRun bool `json:"dry_run,omitempty"`
}

type fileEntry struct {
	Name     string `json:"name"`
	Dir      bool   `json:"dir,omitempty"`
	Size     string `json:"size,omitempty"`
	Bytes    int64  `json:"bytes,omitempty"` // Size exactly
	Modified string `json:"modified"`
	Time     int64  `json:"time"` // Modified, in Unix seconds
}

// tunnelWS accepts a tunnel and runs its handshake: a login, or a
// session's request. Accept rejects cross-origin requests, as for every
// WebSocket here.
func (g *server) tunnelWS(w http.ResponseWriter, r *http.Request) {
	ip := g.clientIP(r)
	handshaken, ok := g.handshakes.start(limitKey(ip))
	if !ok {
		http.Error(w, "too many connections being set up", http.StatusServiceUnavailable)
		return
	}
	defer handshaken()
	c, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	untrack, ok := g.drain.add(c)
	if !ok {
		// Stopping: as lost, to try again once it's back.
		c.Close(websocket.StatusServiceRestart, "")
		return
	}
	defer untrack()
	defer c.CloseNow()
	c.SetReadLimit(tunnelHelloLimit)
	alive, stop := context.WithCancel(context.Background())
	defer stop()
	interval := g.pingInterval
	if interval == 0 {
		interval = pingInterval
	}
	go keepalive(alive, c, interval)

	ctx, cancel := context.WithTimeout(context.Background(), handshakeTimeout)
	typ, hello, err := c.Read(ctx)
	cancel()
	if err != nil {
		return
	}
	if typ != websocket.MessageBinary || len(hello) < 2 || hello[0] != tunnelVersion {
		c.Close(websocket.StatusPolicyViolation, "unsupported tunnel version; reload the page")
		return
	}
	switch hello[1] {
	case helloLogin:
		g.loginTunnel(c, ip, browserName(r.Header.Get("User-Agent")), hello[2:])
	case helloSession:
		t, session := g.sessionTunnel(c, hello[2:])
		handshaken() // from here, the session's limit applies
		if t != nil {
			detach, err := g.attach(session, ip, t)
			switch err {
			case errSessionEnded:
				t.Close(closeLogin, err.Error())
				return
			case errTooManyTunnels:
				t.Close(websocket.StatusTryAgainLater, err.Error())
				return
			}
			defer detach()
			t.req = r
			g.serveRequest(t, session, ip)
		}
	default:
		c.Close(websocket.StatusPolicyViolation, "bad hello")
	}
}

// serveRequest answers a session tunnel's request.
func (g *server) serveRequest(t *tunnel, session, ip string) {
	ctx, cancel := context.WithTimeout(context.Background(), tunnelTimeout)
	typ, msg, err := t.Read(ctx)
	cancel()
	var req tunnelRequest
	if err != nil || typ != websocket.MessageText || json.Unmarshal(msg, &req) != nil {
		t.Close(websocket.StatusPolicyViolation, "bad request")
		return
	}
	r := &tunnelResponder{t: t}

	switch req.Type {
	case "vnc":
		t.c.SetReadLimit(maxClientMessage + tunnelOverhead)
		if r.accept(nil) {
			g.bridgeDesktop(t, session, ip)
		}

	case "logout":
		g.act(session, "logout", ip, "logged out")
		g.endSession(session, "Logged out.", t)
		r.finish(nil)

	case "end-session":
		// Another of the sessions listed, by its handle (see sessionsReport).
		if !g.endSessionByHandle(req.Name, session, ip) {
			r.fail("That session is over already, or it's this one.")
			return
		}
		g.act(session, "end-session", ip, "ended another session")
		// And the links it made, so it keeps no access through them.
		if g.fetches != nil {
			g.fetches.cancelMatching(func(j *fetchJob) bool { return j.by == req.Name })
		}
		if n := g.revokeShares(func(l *shareLink) bool { return l.By == req.Name }); n > 0 {
			log.Printf("%d share links revoked with the session ended from %s", n, ip)
			g.act(session, "share", ip, "revoked %d link%s the ended session made", n, plural(n))
		}
		r.finish(nil)

	case "logout-all":
		log.Printf("all sessions logged out from %s", ip)
		g.act(session, "logout-all", ip, "logged out everywhere")
		g.endAllSessions("Logged out everywhere.", t)
		if g.fetches != nil {
			g.fetches.cancelMatching(func(*fetchJob) bool { return true })
		}
		if n := g.revokeShares(func(*shareLink) bool { return true }); n > 0 {
			log.Printf("%d share links revoked with every session", n)
			g.act(session, "share", ip, "revoked every link (%d) with logging out everywhere", n)
		}
		r.finish(nil)

	case "sessions":
		report := g.sessionsReport(session, t)
		if w := g.ipWarningOf(t); w != "" {
			report["ip_warning"] = w
		}
		if g.shares != nil {
			report["shares"] = g.shares.list(sessionHandle(session))
		}
		r.finish(report)

	case "share":
		g.tunnelShare(req, session, ip, r)

	case "fetch":
		g.tunnelFetch(t, req, session, ip, r)
	case "activity":
		// The newest req.Max entries of the activity log (all for 0).
		entries, total := g.activity.list(req.Max)
		r.finish(map[string]any{"entries": entries, "total": total, "max": maxActivity})
	case "activity-clear":
		g.activity.clear(ip, g.sessionName(session))
		log.Printf("activity log cleared from %s", ip)
		r.finish(nil)
	case "fetches":
		if g.fetches == nil {
			r.fail("Fetching from URLs is turned off (WEB_FETCH=0).")
			return
		}
		r.finish(map[string]any{"fetches": g.fetches.list()})
	case "reshare":
		// A link listed, by its handle, changed: req.Expires seconds from
		// now (0 keeps when it ends), req.Max, and req.MaxBytes.
		life := time.Duration(req.Expires) * time.Second
		if g.shares == nil || req.Expires != 0 && (life < time.Minute || life > maxShareLife) || req.Max < 0 || req.Max > 1000 {
			r.fail("That's not a lifetime or limit a link can have.")
			return
		}
		label, ok := shareLabel(req.Label)
		if !ok {
			r.fail(fmt.Sprintf("A label is one line of at most %d characters.", maxLabel))
			return
		}
		l, err := g.shares.change(req.Name, life, req.Max, req.MaxBytes, label)
		if err != nil {
			r.fail(err.Error())
			return
		}
		n := g.shares.now(l)
		log.Printf("share link to %q changed from %s: until %s, %s", l.Path, ip, n.Expires.Format(time.RFC3339), maxText(n.Max))
		// (What it was changed to, as sent and as now() read it under the
		// lock: another change can come meanwhile.)
		g.act(session, "share", ip, "changed the %s to %s%s: until %s, %s", linkKind(l), linkTarget(l), labelQuote(label), n.Expires.UTC().Format("2006-01-02 15:04 UTC"),
			countText(n.Max, map[bool]string{true: "file", false: "download"}[l.Upload]))
		r.finish(map[string]any{"expires": n.Expires})
	case "share-again":
		// A link listed, by its handle, to show again.
		if g.shares == nil {
			r.fail("Share links are turned off (WEB_SHARE=0).")
			return
		}
		reply, err := g.shares.shareLinkAgain(req.Name)
		if err != nil {
			r.fail(err.Error())
			return
		}
		g.act(session, "share", ip, "showed the link to %s again", folderOrPath(reply))
		r.finish(reply)
	case "unshare":
		// Links listed, by their handles (see shareInfo): req.Name, or
		// req.Names.
		handles := map[string]bool{req.Name: req.Name != ""}
		for _, h := range req.Names {
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
			r.fail("That link has ended already.")
			return
		}
		slices.Sort(revoked)
		log.Printf("%d share links revoked from %s", n, ip)
		g.act(session, "share", ip, "revoked the link%s to %s", plural(n), strings.Join(revoked, ", "))
		r.finish(map[string]any{"revoked": n})

	case "name-session":
		// A session listed, by its handle (this one for ""), named
		// req.Label ("" for none).
		label, ok := shareLabel(req.Label)
		if !ok || len([]rune(label)) > 50 {
			r.fail("A session's name is one line of at most 50 characters.")
			return
		}
		before := g.sessionName(session)
		found, own := g.nameSession(req.Name, session, label)
		if !found {
			r.fail("That session is over already.")
			return
		}
		switch {
		case own && label != before:
			g.act(session, "session", ip, "named this session %q", label)
		case !own:
			g.act(session, "session", ip, "named another session %q", label)
		}
		r.finish(nil)
	case "reshare-many":
		// Links listed, by their handles in req.Names: each made to end
		// req.Expires seconds from now (0 keeps when it ends), and with
		// req.Relabel, labelled req.Label.
		life := time.Duration(req.Expires) * time.Second
		label, ok := shareLabel(req.Label)
		if g.shares == nil || req.Expires != 0 && (life < time.Minute || life > maxShareLife) || !ok {
			r.fail("That's not a lifetime or label a link can have.")
			return
		}
		changed := g.shares.changeMany(req.Names, life, label, req.Relabel)
		if len(changed) == 0 {
			r.fail("Those links have ended already.")
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
		g.act(session, "share", ip, "changed %d link%s (%s): %s", len(changed), plural(len(changed)), strings.Join(changed, ", "), strings.Join(what, ", "))
		r.finish(map[string]any{"changed": len(changed)})
	case "cleanup":
		// Uploads cut off and temporary files, deleted (see cleanup.go),
		// or with req.DryRun, counted.
		rep := g.cleanup(req.DryRun)
		if !req.DryRun && (rep.Kept > 0 || rep.Temps > 0) {
			log.Printf("cleaned up from %s: %d uploads kept to carry on, %d temporary files, %s", ip, rep.Kept, rep.Temps, humanSize(rep.Bytes))
			g.act(session, "cleanup", ip, "cleaned up %s: %d upload%s kept to carry on, and %d leftover temporary file%s",
				humanSize(rep.Bytes), rep.Kept, plural(rep.Kept), rep.Temps, plural(rep.Temps))
		}
		r.finish(map[string]any{"cleanup": rep})
	case "seen":
		// The files page's security warnings, marked as seen: what's
		// listed now no longer marks it (see sessionsReport).
		g.mu.Lock()
		g.seen = time.Now()
		g.mu.Unlock()
		log.Printf("security warnings marked as seen from %s", ip)
		r.finish(nil)

	case "tty":
		if g.termDir == "" {
			r.fail("The terminal is turned off.")
			return
		}
		if !g.openTTY(session) {
			r.fail("Too many open terminals.")
			return
		}
		defer g.closeTTY(session)
		t.c.SetReadLimit(maxTTYMessage + tunnelOverhead)
		// search: whether there's tmux's history to search (see tty.go).
		if r.accept(map[string]any{"search": g.ttyCommand == ""}) {
			g.serveTTY(t, session, ip)
		}

	case "list", "file":
		g.tunnelFiles(t, req, r)

	case "zip-preview":
		g.tunnelZipPreview(t, req, r)

	case "markdown":
		g.tunnelMarkdown(t, req, r)

	case "epub":
		g.tunnelEpub(t, req, r)

	case "epub-edit":
		g.tunnelEpubEdit(t, req, r)

	case "upload":
		g.tunnelUpload(t, req, r)

	case "mkdir":
		g.tunnelMkdir(t, req, r)

	case "zip":
		g.tunnelZip(t, req, ip, r)

	case "rename":
		g.tunnelRename(t, req, ip, r)

	case "move":
		g.tunnelMove(t, req, ip, r)

	case "watch":
		g.tunnelWatch(t, r)

	case "changes":
		g.tunnelChanges(t, req, r)

	case "delete":
		g.tunnelDelete(t, req, ip, r)

	case "audio":
		if g.audio == nil {
			r.fail("Desktop audio is turned off.")
			return
		}
		// Only while this session has the desktop open, from the same IP.
		l, err := g.audio.join(session, ip)
		switch {
		case errors.Is(err, errAudioDenied):
			r.fail("Connect to the desktop first.")
			return
		case err != nil:
			log.Printf("audio: %v", err)
			r.fail("Audio is unavailable.")
			return
		}
		log.Printf("audio tunnel listener from %s joined", ip)
		defer log.Printf("audio tunnel listener from %s left", ip)
		defer g.audio.leave(l)
		if r.accept(nil) {
			streamAudio(t, l)
		}

	case "mic":
		if g.audio == nil {
			r.fail("Desktop audio is turned off.")
			return
		}
		// As for audio: only while this session has the desktop open, from
		// the same IP.
		l, buf, stop, err := g.audio.joinMic(session, ip)
		switch {
		case errors.Is(err, errNoMic):
			r.fail(noMicMsg)
			return
		case errors.Is(err, errAudioDenied):
			r.fail("Connect to the desktop first.")
			return
		case err != nil:
			log.Printf("microphone: %v", err)
			r.fail("The microphone is unavailable.")
			return
		}
		defer stop()
		log.Printf("microphone from %s on", ip)
		defer log.Printf("microphone from %s off", ip)
		if r.accept(map[string]any{"codec": "opus", "sampleRate": micRate, "channels": 1}) {
			receiveMic(t, l, buf)
		}

	default:
		r.fail("Unknown request.")
	}
}

// tunnelMarkdown answers a markdown request: the file at req.Path, as
// HTML for the preview's frame (see markdown.go), in {"html": ...}.
func (g *server) tunnelMarkdown(t *tunnel, req tunnelRequest, r *tunnelResponder) {
	if req.Path == "" {
		// Text being edited (see the editor in preview.js), req.Size bytes
		// of it, sent after the request as data, as an upload's is: too
		// much, as JSON, for a request.
		if req.Size < 0 || req.Size > maxMarkdown {
			r.fail(errMarkdownTooBig.Error())
			return
		}
		if !r.accept(nil) {
			return
		}
		t.c.SetReadLimit(fileChunk + tunnelOverhead)
		text := make([]byte, 0, req.Size)
		for int64(len(text)) < req.Size {
			ctx, cancel := context.WithTimeout(context.Background(), fileStall)
			typ, p, err := t.Read(ctx)
			cancel()
			if err != nil {
				return
			}
			if typ != websocket.MessageBinary || int64(len(text)+len(p)) > req.Size {
				t.Close(websocket.StatusPolicyViolation, "bad text")
				return
			}
			text = append(text, p...)
		}
		html, err := renderMarkdownIsolated(bytes.NewReader(text))
		if err != nil {
			r.fail(err.Error())
			return
		}
		r.finish(map[string]any{"html": html})
		return
	}
	store, err := openDownloadStore(g.downloadsDir)
	if err != nil {
		r.fail("The downloads folder is missing.")
		return
	}
	defer store.Close()
	f, st, err := store.open(path.Clean(strings.Trim(req.Path, "/")))
	if err != nil {
		r.fail("Not found.")
		return
	}
	// Closed however this ends, a folder or other than a file too.
	defer f.Close()
	if !st.Mode().IsRegular() {
		r.fail("Not found.")
		return
	}
	if st.Size() > maxMarkdown {
		r.fail(errMarkdownTooBig.Error())
		return
	}
	html, err := renderMarkdownIsolated(f)
	if err != nil {
		r.fail(err.Error())
		return
	}
	r.finish(map[string]any{"html": html})
}

// revokeShares revokes the share links that match, if links are on.
func (g *server) revokeShares(match func(*shareLink) bool) int {
	// Then the uploads in pieces through those links go, as they've ended.
	defer g.dropEndedLinkPartials()
	if g.shares == nil {
		return 0
	}
	return g.shares.revoke(match)
}

// tunnelShare makes a share link to the file or folder at req.Path, for
// req.Expires seconds and req.Max downloads. The reply has the token, which
// the gateway doesn't keep: the page makes the URL from it, with its own
// address, rather than one the gateway would have to guess from behind a
// proxy.
func (g *server) tunnelShare(req tunnelRequest, session, ip string, r *tunnelResponder) {
	if g.shares == nil {
		r.fail("Share links are turned off (WEB_SHARE=0).")
		return
	}
	if req.Direct && (req.Upload || req.Max != 1) {
		r.fail("A direct download is of a file, once.")
		return
	}
	life := time.Duration(req.Expires) * time.Second
	if life < time.Minute || life > maxShareLife || req.Max < 0 || req.Max > 1000 ||
		req.Upload && (req.MaxBytes <= 0 || req.MaxBytes > maxUploadLinkBytes) || !req.Upload && req.MaxBytes != 0 {
		r.fail("That's not a lifetime or limit a link can have.")
		return
	}
	store, err := openDownloadStore(g.downloadsDir)
	if err != nil {
		r.fail("The downloads folder is missing.")
		return
	}
	defer store.Close()
	// Cleaned first, so "./" or "a/.." are Downloads itself too.
	name := path.Clean(strings.Trim(req.Path, "/"))
	if name == "" {
		name = "."
	}
	if name == "." && !req.Upload {
		r.fail("Share a file or folder in Downloads, not Downloads itself.")
		return
	}
	f, st, err := store.open(name)
	if err != nil {
		r.fail("Not found.")
		return
	}
	f.Close()
	if req.Upload && !st.IsDir() {
		r.fail("Files can only be uploaded into a folder.")
		return
	}
	label, ok := shareLabel(req.Label)
	if !ok {
		r.fail(fmt.Sprintf("A label is one line of at most %d characters.", maxLabel))
		return
	}
	token, l, err := g.shares.create(path.Clean(name), st, shareSpec{Label: label, Life: life, Max: req.Max, Upload: req.Upload, MaxBytes: req.MaxBytes, Once: req.Direct},
		sessionHandle(session), ip)
	if errors.Is(err, errTooManyShares) {
		r.fail(err.Error())
		return
	}
	if err != nil {
		r.fail("The link couldn't be made.")
		return
	}
	// As made: read under the lock, as it can be changed (by another page)
	// as soon as it's made.
	n := g.shares.now(l)
	ticket := ""
	if req.Direct {
		// Counted now, for this page's own download, which the ticket
		// lets fetch the file, rather than the link's page.
		if err := g.shares.use(l, ip, false); err != nil {
			r.fail("The link couldn't be made.")
			return
		}
		g.logShareUse(l, ip)
		ticket = g.shares.ticket(l, ip)
	}
	if l.Upload {
		log.Printf("upload link to %q made from %s, for %s, %s files, up to %s", l.Path, ip, life, maxText(req.Max), humanSize(req.MaxBytes))
		g.act(session, "share", ip, "made an upload link to %s%s, for %s, %s, up to %s", folderText(l.Path), labelQuote(label), lifeText(life), countText(req.Max, "file"), humanSize(req.MaxBytes))
	} else {
		log.Printf("share link to %q made from %s, for %s, %s", l.Path, ip, life, maxText(req.Max))
		g.act(session, "share", ip, "made a share link to %s%s, for %s, %s", linkTarget(l), labelQuote(label), lifeText(life), countText(req.Max, "download"))
	}
	res := map[string]any{"token": token, "handle": l.handle(), "name": l.name(), "dir": l.Dir, "upload": l.Upload, "expires": n.Expires}
	if ticket != "" {
		res["ticket"] = ticket
	}
	r.finish(res)
}

// noMicMsg is the reply when there's no microphone (WEB_MIC=0, or host
// audio), which audio.js takes as a reason to hide its button.
const noMicMsg = "There's no microphone here."

// bridgeDesktop connects a session tunnel to Xvnc, or the VNC server at
// -vnc-addr. The session is the login: Xvnc listens on a socket only the
// desktop user can open and asks for none, so noVNC goes straight to the
// desktop, and a server elsewhere is given the login password, if there's
// one for it (see rfbauth.go). Logging out, or the session ending, closes
// it.
func (g *server) bridgeDesktop(t *tunnel, session, ip string) {
	cooling := g.vncBackoff.begin()
	reserved := true
	defer func() {
		if reserved {
			g.vncBackoff.release()
		}
	}()
	if cooling && g.vncX509 {
		// Logged once, when it failed (see vncBackoff).
		t.Close(websocket.StatusTryAgainLater, "cannot log in to the desktop")
		return
	}
	vnc, err := g.dialVNC()
	if err != nil {
		log.Printf("cannot reach VNC server: %v", err)
		t.Close(websocket.StatusInternalError, "cannot reach the desktop")
		return
	}
	conn := &tunnelConn{t: t}
	conn.SetDeadline(time.Now().Add(rfbHandshakeTimeout))
	// With a password for it (VNC_UPSTREAM_PASSWORD), the VNC server gets
	// that, and noVNC no security (see rfbauth.go). The login's own
	// password is never sent anywhere.
	// While cooling down without VNC_X509, the gateway doesn't log in, and
	// noVNC asks for the server's password (see vncBackoff).
	if password := g.vncPassword(); !cooling && (password != "" || g.vncX509) {
		if password == "" {
			vnc.Close()
			log.Printf("VNC_X509 needs VNC_UPSTREAM_PASSWORD, and there's none")
			t.Close(websocket.StatusInternalError, "cannot log in to the desktop")
			return
		}
		result, authErr := g.vncSecurity(vnc, conn, password)
		vnc, err = result.conn, authErr
		switch {
		case result.outcome == vncAuthenticated:
			g.vncBackoff.record(nil)
			g.vncBackoff.succeeded()
		case result.outcome == vncPasswordRejected && err == nil:
			g.vncBackoff.record(errVNCPasswordRejected)
		case err != nil && !errors.Is(err, errPageHandshake):
			g.vncBackoff.record(err)
		}
		if err != nil {
			if errors.Is(err, errPageHandshake) {
				// The page went part way: not a failed login.
				log.Printf("desktop tunnel from %s: %v", ip, err)
			} else {
				log.Printf("logging in to the VNC server: %v; not trying again for %v", err, g.vncBackoff.failed())
			}
			if vnc != nil {
				vnc.Close()
			}
			t.Close(websocket.StatusInternalError, "cannot log in to the desktop")
			return
		}
		if result.outcome == vncPasswordRejected {
			log.Printf("noVNC asks for the VNC server's password; VNC_UPSTREAM_PASSWORD isn't tried again for %v", g.vncBackoff.failed())
		}
	}
	defer vnc.Close()
	conn.SetDeadline(time.Time{})
	g.vncBackoff.release()
	reserved = false
	log.Printf("desktop tunnel from %s opened", ip)
	g.audio.link(session, ip)
	defer g.audio.unlink(session, ip)

	done := make(chan struct{}, 2)
	go func() { io.Copy(vnc, conn); done <- struct{}{} }()
	go func() { io.Copy(conn, vnc); done <- struct{}{} }()
	<-done
	conn.Close()
	vnc.Close()
	<-done
	log.Printf("desktop tunnel from %s closed", ip)
}

// tunnelFiles answers a list request with the directory's entries, and a
// file request with the file's name and size, then its contents in data
// messages.
func (g *server) tunnelFiles(t *tunnel, req tunnelRequest, r *tunnelResponder) {
	// os.Root confines every lookup to the directory: ".." and symlinks
	// leading outside it fail, even if they change between checks.
	store, err := openDownloadStore(g.downloadsDir)
	if err != nil {
		r.fail("The downloads folder is missing.")
		return
	}
	defer store.Close()
	name := strings.Trim(req.Path, "/")
	if name == "" {
		name = "."
	}
	f, st, err := store.open(name)
	if err != nil {
		r.fail("Not found.")
		return
	}
	defer f.Close()

	if req.Type == "list" {
		if !st.IsDir() {
			r.fail("Not a folder.")
			return
		}
		entries, truncated, err := store.listDir(name, f)
		if err != nil {
			r.fail("Not found.")
			return
		}
		out := make([]fileEntry, 0, len(entries))
		for _, e := range entries {
			out = append(out, fileEntry{Name: strings.TrimSuffix(e.Name, "/"), Dir: e.dir, Size: e.Size, Bytes: e.bytes,
				Modified: e.Modified, Time: e.time})
		}
		res := map[string]any{"entries": out, "truncated": truncated, "max": maxListing, "tz": g.timeZone, "share": g.shares != nil, "fetch": g.fetches != nil}
		if free, total, ok := g.transfers.uploadRoom(f); ok {
			res["free"], res["total"] = free, total
		}
		r.finish(res)
		return
	}

	if !st.Mode().IsRegular() {
		r.fail("Not a file.")
		return
	}
	// A part of it, with Length: from Offset, as much as there is, up to
	// maxFileRange; and with IfMtime, only of the file as it was (the PDF
	// preview reads a file in parts, which mustn't come from two versions).
	from, n := int64(0), st.Size()
	if req.Length != 0 {
		if req.Offset < 0 || req.Length < 0 || req.Length > maxFileRange || req.Offset > st.Size() {
			r.fail("That's not a part of the file.")
			return
		}
		from, n = req.Offset, min(req.Length, st.Size()-req.Offset)
	}
	if req.IfMtime != "" && (fileVersion(st) != req.IfMtime || st.Size() != req.IfSize) {
		r.fail(errChangedSince.Error())
		return
	}
	if !r.accept(map[string]any{"name": st.Name(), "size": st.Size(), "mtime": fileVersion(st), "offset": from, "length": n}) {
		return
	}
	w := newChunkWriter(t)
	defer w.stop()
	if _, err := io.CopyN(w, io.NewSectionReader(f, from, n), n); err != nil {
		w.fail(err)
		return
	}
	if w.flush() == nil {
		r.finish(nil)
	}
}

func writeJSON(c msgConn, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), tunnelTimeout)
	defer cancel()
	return c.Write(ctx, websocket.MessageText, b)
}

// Session tokens are 32 random bytes, and sessionIDLen characters long.
var sessionIDLen = base64.RawURLEncoding.EncodedLen(32)

func newToken() string {
	b := make([]byte, 32)
	rand.Read(b) // can't fail: since Go 1.24, it crashes the program instead
	return base64.RawURLEncoding.EncodeToString(b)
}
