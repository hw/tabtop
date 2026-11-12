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
	"io/fs"
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

//go:embed image-batch.js image-export.js pdf-image-editor.js image-mask.js image-inpaint.js image-inpaint-worker.js image-draw.js image-place.js image-fill.js image-background.js image-background-worker.js third-party/* image-meta.js image-view.js sqlite-view.js disasm-worker.js x86-asm.js preview-html-links.js preview-css.js preview-html-resources.js preview-resources.js preview-media.js preview-pictures.js kaitai-errors.js format-combobox.js kaitai-view.js kaitai-worker.js hex-view.js files-actions.js preview-loaders.js preview-renderers.js ranged-file.js file-types.js file-types-worker.js preview-content.js preview-dom.js preview-editor.js preview-frames.js preview-links.js preview-model.js preview-settings.js preview-view.js stream-worker.js media-source.js media-stream.js video-stream.js glyphs.js pdf-frame.js epub-frame.js md-frame.js json-view.js table-view.js transfer.js folder-model.js osc.js tunnel.js tunnel-protocol.js tunnel-crypto.js session.js session-state.js stored.js login-ui.js file-format.js sessions-view.js novnc.js files.js download-sw.js drop.js ui.js nav.js requests.js preview.js reconnect.js download.js expiry.js
var pageFiles embed.FS

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
var mdFrameCSP = frameCSP("")

// directFrameCSP is the same frame's in Direct mode, which may also load
// pictures, stylesheets, fonts and media from the web itself.
var directFrameCSP = frameCSP(" http: https:")

// frameCSP is the preview frames' policy, with web, if not "", added to
// what pictures, styles, fonts and media may load from.
func frameCSP(web string) string {
	return "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'" + web + "; img-src blob: data:" + web + "; " +
		"media-src blob:" + web + "; font-src blob:" + web + "; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; " + frameSandbox
}

// Only a frame explicitly opened in Direct mode may load from the web.
func previewFrameCSP(r *http.Request) string {
	if r.URL.Query().Get("external") == "direct" {
		return directFrameCSP
	}
	return mdFrameCSP
}

// frameSandbox is the frames' sandbox, as the files page gives it them.
const frameSandbox = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox"

// mdFrameHTML is the frame's page.
var mdFrameHTML = "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\">\n" +
	"<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>Markdown</title>\n<style>" +
	mdFrameCSS + highlightCSS + "</style>\n<main id=\"doc\"></main>\n<script src=\"third-party/css-tree.js\"></script><script src=\"preview-css.js\"></script><script src=\"preview-html-links.js\"></script><script src=\"preview-html-resources.js\"></script><script src=\"md-frame.js\"></script>\n"

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

// The disassembler the hex view's worker loads (see disasm-worker.js), from
// -disasm-dir: iced-x86, made loadable in a worker by the Dockerfile's
// disasm stage. Read when a page first asks for them.
var disasmFiles = []string{"iced.js", "iced_x86_bg.wasm"}

func (g *server) disasmAssets() assets { return assets{"disasm", g.disasmDir, disasmFiles} }

func (g *server) disasmPath() string {
	if g.disasmDir == "" {
		return "disasm-missing"
	}
	return g.disasm.path(g.disasmAssets())
}

// MI-GAN has its own asset set so opening background removal doesn't load it.
var inpaintFiles = []string{"migan.onnx"}

func (g *server) inpaintAssets() assets { return assets{"inpaint", g.inpaintDir, inpaintFiles} }
func (g *server) inpaintPath() string {
	if g.inpaintDir == "" {
		return "inpaint-missing"
	}
	return g.inpaint.path(g.inpaintAssets())
}

// Background removal uses only ONNX Runtime's WASM backend, in a worker.
var backgroundFiles = []string{"ort.wasm.min.js", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm", "u2netp.onnx"}

func (g *server) backgroundAssets() assets {
	return assets{"background", g.backgroundDir, backgroundFiles}
}

func (g *server) backgroundPath() string {
	if g.backgroundDir == "" {
		return "background-missing"
	}
	return g.background.path(g.backgroundAssets())
}

// disasmWorkerCSP is the disassembly worker's: its own scripts, fetching
// its WebAssembly, and running it; nothing else. The page itself isn't
// allowed WebAssembly.
const disasmWorkerCSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'"

// backgroundWorkerCSP is the background-removal worker's: its own scripts
// (ONNX Runtime), fetching its WebAssembly and model, and running them;
// nothing else. The same as the disassembler's for now, but its own, so
// either can change without the other.
const backgroundWorkerCSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'"

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
		h.Set("Content-Security-Policy", previewFrameCSP(r))
		h.Set("Referrer-Policy", "no-referrer")
		io.WriteString(w, mdFrameHTML)
	case name == "pdf-frame.html":
		h.Set("Content-Type", "text/html; charset=utf-8")
		h.Set("Content-Security-Policy", pdfFrameCSP)
		h.Set("Referrer-Policy", "no-referrer")
		io.WriteString(w, pdfFrameHTML)
	case name == "epub-frame.html":
		h.Set("Content-Type", "text/html; charset=utf-8")
		h.Set("Content-Security-Policy", previewFrameCSP(r))
		h.Set("Referrer-Policy", "no-referrer")
		io.WriteString(w, epubFrameHTML)
	case name == "pdf-frame.js":
		js, _ := pageFiles.ReadFile(name)
		w.Write(bytes.ReplaceAll(js, []byte(`"./pdfjs/`), []byte(`"./`+g.pdfjsPath()+`/`)))
	case name == "glyphs.js":
		// Static UI artwork, also imported by frames with opaque origins.
		h.Set("Access-Control-Allow-Origin", "*")
		http.ServeFileFS(w, r, pageFiles, name)
	case name == "md-frame.js":
		js, _ := pageFiles.ReadFile(name)
		js = bytes.ReplaceAll(js, []byte(`"./preview/`), []byte(`"./`+g.previewPath()+`/`))
		w.Write(bytes.ReplaceAll(js, []byte(`"./highlight/`), []byte(`"./`+g.highlightPath()+`/`)))
	case name == "nav.js":
		js, _ := pageFiles.ReadFile(name)
		pages, _ := json.Marshal(map[string]bool{"desktop": !g.vncOff, "terminal": g.termDir != "", "files": !g.fsOff})
		w.Write(bytes.Replace(js, []byte(`{ desktop: true, terminal: true, files: true }`), pages, 1))
	case name == "preview.js" || name == "preview-content.js":
		js, _ := pageFiles.ReadFile(name)
		w.Write(bytes.ReplaceAll(js, []byte(`"./highlight/`), []byte(`"./`+g.highlightPath()+`/`)))
	case name == "image-inpaint-worker.js":
		h.Set("Content-Security-Policy", backgroundWorkerCSP)
		js, _ := pageFiles.ReadFile(name)
		js = bytes.ReplaceAll(js, []byte(`"./background/`), []byte(`"./`+g.backgroundPath()+`/`))
		w.Write(bytes.ReplaceAll(js, []byte(`"./inpaint/`), []byte(`"./`+g.inpaintPath()+`/`)))
	case name == "image-background-worker.js":
		h.Set("Content-Security-Policy", backgroundWorkerCSP)
		js, _ := pageFiles.ReadFile(name)
		w.Write(bytes.ReplaceAll(js, []byte(`"./background/`), []byte(`"./`+g.backgroundPath()+`/`)))
	case name == "disasm-worker.js":
		h.Set("Content-Security-Policy", disasmWorkerCSP)
		js, _ := pageFiles.ReadFile(name)
		w.Write(bytes.ReplaceAll(js, []byte(`"./disasm/`), []byte(`"./`+g.disasmPath()+`/`)))
	case name == "tunnel-crypto.js":
		js, _ := pageFiles.ReadFile(name)
		w.Write(bytes.ReplaceAll(js, []byte(`"./noble/`), []byte(`"./`+g.noblePath()+`/`)))
	case name == "desktop.css":
		h.Set("Content-Type", "text/css; charset=utf-8")
		io.WriteString(w, desktopCSS)
	case name == "download-sw.js":
		h.Set("Service-Worker-Allowed", "../")
		h.Set("Content-Security-Policy", downloadSWCSP)
		http.ServeFileFS(w, r, pageFiles, name)
	case servedAsIs(name):
		http.ServeFileFS(w, r, pageFiles, name)
	case g.noble.serve(w, r, g.nobleAssets(), name):
	case g.highlightDir != "" && g.highlight.serve(w, r, g.highlightAssets(), name):
	case g.previewDir != "" && g.preview.serve(w, r, g.previewAssets(), name):
	case g.inpaintDir != "" && g.inpaint.serve(w, r, g.inpaintAssets(), name):
	case g.backgroundDir != "" && g.background.serve(w, r, g.backgroundAssets(), name):
	case g.disasmDir != "" && g.disasm.serve(w, r, g.disasmAssets(), name):
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

// servedAsIs reports whether name is one of the page's own scripts (or a
// third-party one's licence), embedded above, served as it is: any not
// served some other way first.
func servedAsIs(name string) bool {
	if !strings.HasSuffix(name, ".js") && !strings.HasSuffix(name, ".LICENSE") {
		return false
	}
	st, err := fs.Stat(pageFiles, name)
	return err == nil && st.Mode().IsRegular()
}
