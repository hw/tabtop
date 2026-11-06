package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// immutableCache is how long browsers may keep an assetSet's files: for
// good, since their path changes with their contents.
const immutableCache = "public, max-age=31536000, immutable, no-transform"

// assetRetry is how long after an assetSet failed to load it's tried again.
const assetRetry = 10 * time.Second

// assetSet is files from a directory that browsers keep: the noble files
// and the terminal's. They're read once, all of them, and served from
// memory under label- and a hash of their contents, so a new image's files
// get a new path, and a path always gives the bytes it was named after. If
// one can't be read, none are served until a read after assetRetry works.
// Each is kept gzipped too, since no-transform asks proxies not to
// compress them.
type assetSet struct {
	mu     sync.Mutex
	tag    string
	files  map[string]asset
	failed time.Time
}

type asset struct {
	data, gz []byte // gz is nil if gzip doesn't make it smaller
}

// assets names an assetSet's files: label, and names in dir.
type assets struct {
	label, dir string
	names      []string
}

// load reads the files if they aren't yet, and returns the path they're
// served under and their contents; "" and nil if one can't be read.
func (a *assetSet) load(f assets) (string, map[string]asset) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.files == nil && time.Since(a.failed) >= assetRetry {
		files := map[string]asset{}
		h := sha256.New()
		for _, name := range f.names {
			data, err := os.ReadFile(filepath.Join(f.dir, name)) // a missing file is the doctor's to report
			if err != nil {
				a.failed = time.Now()
				return "", nil
			}
			files[name] = asset{data, gzipped(data)}
			h.Write([]byte(name))
			h.Write(sha256Sum(data))
		}
		a.tag, a.files = f.label+"-"+hex.EncodeToString(h.Sum(nil))[:12], files
	}
	return a.tag, a.files
}

// gzipped is data compressed, or nil if that saves less than a tenth.
func gzipped(data []byte) []byte {
	var b bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&b, gzip.DefaultCompression) // 3% bigger than best, 3x faster
	zw.Write(data)
	zw.Close()
	if b.Len() > len(data)*9/10 {
		return nil
	}
	return b.Bytes()
}

// path is where the files are served, relative to the page using them.
func (a *assetSet) path(f assets) string {
	if tag, _ := a.load(f); tag != "" {
		return tag
	}
	return f.label + "-missing" // served as nothing, so the page fails to load
}

// serve serves name, which is "<path>/<file>", if it's one of the files.
func (a *assetSet) serve(w http.ResponseWriter, r *http.Request, f assets, name string) bool {
	tag, files := a.load(f)
	file, ok := strings.CutPrefix(name, tag+"/")
	as, known := files[file]
	if tag == "" || !ok || !known {
		return false
	}
	h := w.Header()
	h.Set("Cache-Control", immutableCache)
	typ := mime.TypeByExtension(path.Ext(file))
	if path.Ext(file) == ".woff2" {
		typ = "font/woff2" // not in Go's table, nor always the system's; nosniff needs the right type
	}
	if typ == "" {
		typ = "application/octet-stream" // pdf.js's character maps (.bcmap), say: not sniffed as something else
	}
	h.Set("Content-Type", typ)
	data := as.data
	if as.gz != nil {
		h.Set("Vary", "Accept-Encoding")
		if acceptsGzip(r) {
			h.Set("Content-Encoding", "gzip")
			data = as.gz
		}
	}
	http.ServeContent(w, r, file, time.Time{}, bytes.NewReader(data))
	return true
}

// acceptsGzip reports whether r's Accept-Encoding allows gzip: by name, or
// failing that by "*".
func acceptsGzip(r *http.Request) bool {
	gzipQ, anyQ := -1.0, -1.0
	for _, part := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
		coding, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		q := 1.0
		if v, ok := strings.CutPrefix(strings.TrimSpace(params), "q="); ok {
			if f, err := strconv.ParseFloat(v, 64); err == nil {
				q = f
			} else {
				q = 0
			}
		}
		switch coding = strings.TrimSpace(coding); {
		case strings.EqualFold(coding, "gzip"):
			gzipQ = q
		case coding == "*":
			anyQ = q
		}
	}
	if gzipQ >= 0 {
		return gzipQ > 0
	}
	return anyQ > 0
}
