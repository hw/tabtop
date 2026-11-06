package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
)

func (g *server) handler() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/", novncHeaders(novncCSP(g.novncDir), http.FileServerFS(noListingFS{os.DirFS(g.novncDir)})))
	mux.HandleFunc(filesPrefix, g.filesPage)
	mux.HandleFunc(ttyPrefix, g.tty)
	// The mux would add the trailing slash itself, but to the path without
	// the base.
	for _, p := range []string{filesPrefix, ttyPrefix} {
		mux.Handle(strings.TrimSuffix(p, "/"), http.RedirectHandler(g.abs(p), http.StatusMovedPermanently))
	}
	mux.HandleFunc("/tabtop/", g.scripts)
	mux.HandleFunc("/tunnel", g.tunnelWS)
	mux.HandleFunc("/healthz", g.healthz)
	mux.HandleFunc("/doctor", g.doctor)
	return noTransform(g.stripBase(mux))
}

// novncCSPFormat is the desktop page's Content-Security-Policy, with the
// hashes of its inline scripts to put in (see novncCSP). Everything it
// loads is the site's own: the session it keeps in localStorage is only as
// safe as the scripts that can run beside it. Images may also be data: and
// blob: URLs (noVNC's cursors, the bar's icons); media is noVNC's bell; a
// worker and a hidden frame from the site save downloads (see download.js).
const novncCSPFormat = "default-src 'none'; script-src 'self'%s; style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data: blob:; media-src 'self'; font-src 'self'; connect-src 'self'; worker-src 'self'; frame-src 'self'; " +
	"manifest-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'"

// inlineScript matches a script element and what's in it; scriptSrc, an
// element that loads its script from a file instead.
var (
	inlineScript = regexp.MustCompile(`(?is)<script\b([^>]*)>(.*?)</script>`)
	scriptSrc    = regexp.MustCompile(`(?i)\bsrc\s*=`)
)

// novncCSP is the desktop page's Content-Security-Policy, allowing the
// inline scripts in dir's vnc.html (noVNC's start-up module) by their
// SHA-256, as the browser hashes them: with line endings made \n.
func novncCSP(dir string) string {
	page, _ := os.ReadFile(filepath.Join(dir, "vnc.html")) // a missing page is the doctor's to report
	var hashes strings.Builder
	for _, m := range inlineScript.FindAllSubmatch(page, -1) {
		if scriptSrc.Match(m[1]) {
			continue
		}
		text := bytes.ReplaceAll(bytes.ReplaceAll(m[2], []byte("\r\n"), []byte("\n")), []byte("\r"), []byte("\n"))
		sum := sha256.Sum256(text)
		hashes.WriteString(" 'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'")
	}
	return fmt.Sprintf(novncCSPFormat, hashes.String())
}

// novncHeaders guards the desktop page and the rest of noVNC's files, as
// the files and terminal pages are guarded: csp, which also keeps other
// sites from showing them in a frame (where clicks and keys meant for
// their own page could reach the desktop), as X-Frame-Options does for
// older browsers, and none is taken for another type than it's served as.
func novncHeaders(csp string, h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hd := w.Header()
		hd.Set("Content-Security-Policy", csp)
		hd.Set("X-Frame-Options", "DENY")
		hd.Set("X-Content-Type-Options", "nosniff")
		hd.Set("Referrer-Policy", "no-referrer")
		h.ServeHTTP(w, r)
	})
}

// noTransform asks proxies, and CDNs such as Cloudflare, to pass every
// response on unchanged: one that rewrites or "optimizes" the page scripts
// could break the tunnel, or weaken it without anyone noticing. Handlers
// that set Cache-Control themselves include it too.
func noTransform(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-transform")
		h.ServeHTTP(w, r)
	})
}

// stripBase serves h under g.base. The base without its trailing slash
// redirects to it, and paths outside it are not found. Everything the
// browser loads uses relative URLs, so only the server's redirects need the
// base put back (abs).
func (g *server) stripBase(h http.Handler) http.Handler {
	if g.base == "/" {
		return h
	}
	trimmed := strings.TrimSuffix(g.base, "/")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == trimmed:
			http.Redirect(w, r, g.base, http.StatusMovedPermanently)
		case strings.HasPrefix(r.URL.Path, g.base):
			r2 := new(http.Request)
			*r2 = *r
			r2.URL = new(url.URL)
			*r2.URL = *r.URL
			r2.URL.Path = strings.TrimPrefix(r.URL.Path, trimmed)
			// The base has no characters that need escaping, so an escaped
			// path starts with it too (else EscapedPath ignores RawPath).
			r2.URL.RawPath = strings.TrimPrefix(r.URL.RawPath, trimmed)
			h.ServeHTTP(w, r2)
		default:
			http.NotFound(w, r)
		}
	})
}

// abs turns a path as the handlers see it ("/fs/") into the one the
// browser uses ("/tabtop/fs/").
func (g *server) abs(p string) string {
	return g.base + strings.TrimPrefix(p, "/")
}

// parseBasePath checks a -base-path value and gives it a leading and
// trailing slash. Its segments are limited to unreserved URL characters, so
// it can go into redirects and HTML as it is.
func parseBasePath(s string) (string, error) {
	trimmed := strings.Trim(s, "/")
	if trimmed == "" {
		return "/", nil
	}
	for seg := range strings.SplitSeq(trimmed, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return "", fmt.Errorf("%q has an empty, . or .. segment", s)
		}
		for _, c := range seg {
			if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("-._~", c)) {
				return "", fmt.Errorf("%q may only contain letters, digits, -, ., _, ~ and /", s)
			}
		}
	}
	return "/" + trimmed + "/", nil
}

// noListingFS hides directories without an index.html, so the file server
// doesn't list noVNC's source tree.
type noListingFS struct{ fs.FS }

func (f noListingFS) Open(name string) (fs.File, error) {
	file, err := f.FS.Open(name)
	if err != nil {
		return nil, err
	}
	if st, err := file.Stat(); err == nil && st.IsDir() {
		if _, err := fs.Stat(f.FS, path.Join(name, "index.html")); err != nil {
			file.Close()
			return nil, fs.ErrNotExist
		}
	}
	return file, nil
}
