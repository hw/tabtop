package main

// The page scripts under /tabtop/ (with the noble libraries'
// cryptography), the files page (a script that lists, fetches, uploads and
// deletes files through the tunnel). Request dispatch and handlers live in
// tunnel_request.go; this file owns page assets and their security headers.

import (
	"bytes"
	"embed"
	"encoding/json"
	"html/template"
	"io"
	"log"
	"net/http"
	"strings"
)

const (
	// The downloads page loads its script and talks to the tunnel. It
	// registers download-sw.js and opens its downloads in a hidden frame;
	// blob: is for saving files held in memory where there's no service
	// worker, and for previews (see preview.js), which never use a frame.
	filesCSP = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; " +
		"img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self'; frame-src 'self'; form-action 'none'; frame-ancestors 'none'"
	// The download service worker fetches nothing itself.
	downloadSWCSP = "default-src 'none'; script-src 'self'"
)

//go:embed preview-pictures.js kaitai-errors.js format-combobox.js kaitai-view.js kaitai-worker.js hex-view.js files-actions.js preview-loaders.js preview-renderers.js ranged-file.js file-types.js file-types-worker.js preview-content.js preview-dom.js preview-editor.js preview-frames.js preview-links.js preview-model.js preview-settings.js preview-view.js stream-worker.js media-source.js media-stream.js video-stream.js glyphs.js pdf-frame.js epub-frame.js md-frame.js json-view.js table-view.js transfer.js folder-model.js osc.js tunnel.js tunnel-protocol.js tunnel-crypto.js session.js session-state.js login-ui.js file-format.js sessions-view.js novnc.js files.js download-sw.js drop.js ui.js nav.js requests.js preview.js reconnect.js download.js expiry.js
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
	case name == "nav.js":
		js, _ := e2eFiles.ReadFile(name)
		pages, _ := json.Marshal(map[string]bool{"desktop": !g.vncOff, "terminal": g.termDir != "", "files": !g.fsOff})
		w.Write(bytes.Replace(js, []byte(`{ desktop: true, terminal: true, files: true }`), pages, 1))
	case name == "preview.js" || name == "preview-content.js":
		js, _ := e2eFiles.ReadFile(name)
		w.Write(bytes.ReplaceAll(js, []byte(`"./highlight/`), []byte(`"./`+g.highlightPath()+`/`)))
	case name == "tunnel-crypto.js":
		js, _ := e2eFiles.ReadFile(name)
		w.Write(bytes.ReplaceAll(js, []byte(`"./noble/`), []byte(`"./`+g.noblePath()+`/`)))
	case name == "preview-pictures.js" || name == "kaitai-errors.js" || name == "format-combobox.js" || name == "kaitai-view.js" || name == "kaitai-worker.js" || name == "hex-view.js" || name == "files-actions.js" || name == "preview-loaders.js" || name == "preview-renderers.js" || name == "ranged-file.js" || name == "file-types.js" || name == "file-types-worker.js" || name == "preview-dom.js" || name == "preview-editor.js" || name == "preview-frames.js" || name == "preview-links.js" || name == "preview-model.js" || name == "preview-settings.js" || name == "preview-view.js" || name == "stream-worker.js" || name == "media-source.js" || name == "media-stream.js" || name == "video-stream.js" || name == "epub-frame.js" || name == "json-view.js" || name == "table-view.js" || name == "transfer.js" || name == "folder-model.js" || name == "osc.js" || name == "tunnel.js" || name == "tunnel-protocol.js" || name == "session-state.js" || name == "session.js" || name == "login-ui.js" || name == "file-format.js" || name == "sessions-view.js" || name == "novnc.js" || name == "files.js" || name == "drop.js" || name == "ui.js" || name == "nav.js" ||
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
	case g.serveKaitai(w, r, name):
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
	if g.fsOff {
		http.NotFound(w, r)
		return
	}
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
