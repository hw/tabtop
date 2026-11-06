package main

// PDF previews: the files page shows a PDF with pdf.js, in a sandboxed
// frame of its own (pdf-frame.html, pdf-frame.js), as Markdown is shown:
// nothing in it can reach the site. The frame doesn't get the file: it
// asks the page for the parts pdf.js needs, as it needs them, and the page
// fetches each through the tunnel with a file request for a part (see
// Offset and Length in tunnelRequest), so a big PDF moves only as far as
// it's read. PDF scripts never run: the frame has no scripting sandbox.
//
// pdf.js comes from -pdfjs-dir: its library and worker, as modules, the
// character maps and fonts some PDFs need, and its WebAssembly image
// decoders. The frame, at an origin of its own, loads them with CORS, so
// they're served to any origin: they're the published library's files.

import (
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// pdfFrameCSP is the PDF frame's: scripts only from the site (pdf.js), and
// its WebAssembly decoders; its worker from a data: URL, as one from the
// site can't be started at the frame's origin (nor, as a module, from a
// blob: URL, in Chrome); fetching only the site's
// files (fonts, character maps); pictures as blob: and data: URLs, and
// fonts as data: ones, as pdf.js makes them. Nothing else.
const pdfFrameCSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src data:; connect-src 'self'; " +
	"style-src 'unsafe-inline'; img-src blob: data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; " + frameSandbox

// pdfFrameHTML is the frame's page.
var pdfFrameHTML = "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\">\n" +
	"<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>PDF</title>\n<style>" +
	pdfFrameCSS + "</style>\n<div id=\"bar\"></div><main id=\"pages\"></main>\n<script src=\"pdf-frame.js\"></script>\n"

// The parts of pdf.js the frame uses, by folder in -pdfjs-dir; each
// folder's files are all served.
var pdfjsFolders = []string{".", "cmaps", "standard_fonts", "wasm", "iccs"}

// pdfjsFiles lists the files of pdf.js in dir to serve: those in
// pdfjsFolders, but not its scripting sandbox, which runs PDFs' scripts.
// It's read once, as the gateway starts (see newServer).
func pdfjsFiles(dir string) []string {
	var names []string
	for _, sub := range pdfjsFolders {
		des, err := fs.ReadDir(os.DirFS(filepath.Join(dir, sub)), ".")
		if err != nil {
			continue
		}
		for _, de := range des {
			name := de.Name()
			if !de.Type().IsRegular() || strings.Contains(name, "sandbox") || strings.Contains(name, "quickjs") {
				continue
			}
			if sub != "." {
				name = sub + "/" + name
			}
			names = append(names, name)
		}
	}
	slices.Sort(names)
	return names
}

func (g *server) pdfjsAssets() assets { return assets{"pdfjs", g.pdfjsDir, g.pdfjsNames} }

// pdfjsPath is where pdf.js is served, under /tabtop/; pdf-frame.js is
// served with its "./pdfjs/" pointing there.
func (g *server) pdfjsPath() string {
	if g.pdfjsDir == "" || !slices.Contains(g.pdfjsNames, "pdf.min.mjs") {
		return "pdfjs-missing"
	}
	return g.pdfjs.path(g.pdfjsAssets())
}

// servePDFJS serves name, if it's one of pdf.js's files, to any origin.
func (g *server) servePDFJS(w http.ResponseWriter, r *http.Request, name string) bool {
	if g.pdfjsDir == "" || !strings.HasPrefix(name, "pdfjs-") {
		return false
	}
	w.Header().Set("Access-Control-Allow-Origin", "*")
	if !g.pdfjs.serve(w, r, g.pdfjsAssets(), name) {
		w.Header().Del("Access-Control-Allow-Origin")
		return false
	}
	return true
}
