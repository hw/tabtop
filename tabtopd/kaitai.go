package main

// Kaitai parsers are static, generated assets. Serve them from disk on demand:
// the full gallery shouldn't become a permanent in-memory assetSet. Esbuild's
// hashed module names let the browser cache only the formats it actually uses.
import (
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path"
	"strings"
)

func (g *server) serveKaitai(w http.ResponseWriter, r *http.Request, name string) bool {
	file, ok := strings.CutPrefix(name, "kaitai/")
	if !ok || g.kaitaiDir == "" || !fs.ValidPath(file) {
		return false
	}
	// Only the public catalog, schema metadata and compiled parser modules.
	module := strings.HasPrefix(file, "parsers/") && path.Ext(file) == ".js"
	if file != "formats.json" && file != "schemas.json" && !module {
		return false
	}
	root, err := os.OpenRoot(g.kaitaiDir)
	if err != nil {
		return false
	}
	defer root.Close()
	f, err := root.OpenFile(file, os.O_RDONLY, 0)
	if err != nil {
		return false
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		return false
	}
	h := w.Header()
	h.Set("Content-Type", mime.TypeByExtension(path.Ext(file)))
	h.Set("Cache-Control", "no-cache, no-transform")
	if module {
		h.Set("Cache-Control", immutableCache)
	}
	// The worker can fetch only our own parser assets; it receives no session secrets.
	http.ServeContent(w, r, file, st.ModTime(), f)
	return true
}
