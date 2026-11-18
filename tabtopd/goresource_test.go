package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// readGoResource reads a go-resource reply's bytes, acknowledging each
// chunk as the page does.
func readGoResource(t *testing.T, ctx context.Context, tc *tunnelClient) []byte {
	t.Helper()
	var got []byte
	for {
		kind, b, err := tc.read(ctx)
		if err != nil {
			return got
		}
		if kind != msgData {
			t.Fatalf("unexpected message %d", kind)
		}
		got = append(got, b...)
		tc.write(ctx, msgData, nil)
	}
}

func TestGoResource(t *testing.T) {
	png := []byte("\x89PNG\r\n\x1a\nremote picture")
	css := []byte("body { color: teal; background: url(bg.png) }")
	woff2 := append([]byte("wOF2"), bytes.Repeat([]byte{1}, 100)...)
	var gzipped bytes.Buffer
	zw := gzip.NewWriter(&gzipped)
	zw.Write(css)
	zw.Close()
	var bomb bytes.Buffer // 1 MB compressed to almost nothing, many times over the limit
	zw = gzip.NewWriter(&bomb)
	for i := 0; i < maxGoCSS/(1<<20)+2; i++ {
		zw.Write(make([]byte, 1<<20))
	}
	zw.Close()
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for _, h := range []string{"Cookie", "Authorization", "Referer"} {
			if r.Header.Get(h) != "" {
				t.Errorf("the site was sent %s", h)
			}
		}
		if r.Header.Get("User-Agent") != goUserAgent {
			t.Errorf("User-Agent %q", r.Header.Get("User-Agent"))
		}
		switch r.URL.Path {
		case "/pic.png":
			w.Header().Set("Content-Type", "image/png")
			w.Write(png)
		case "/moved.png":
			http.Redirect(w, r, "/pic.png", http.StatusFound)
		case "/style.css":
			w.Header().Set("Content-Type", "text/css; charset=utf-8")
			if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
				w.Header().Set("Content-Encoding", "gzip")
				w.Write(gzipped.Bytes())
				return
			}
			w.Write(css)
		case "/bomb.css":
			w.Header().Set("Content-Type", "text/css")
			w.Header().Set("Content-Encoding", "gzip")
			w.Write(bomb.Bytes())
		case "/brotli.css":
			w.Header().Set("Content-Type", "text/css")
			w.Header().Set("Content-Encoding", "br")
			w.Write([]byte("not really brotli"))
		case "/font.woff2":
			w.Header().Set("Content-Type", "font/woff2")
			w.Write(woff2)
		case "/fake-font.woff2":
			w.Header().Set("Content-Type", "font/woff2")
			w.Write([]byte("<script>x</script>"))
		case "/page.html":
			w.Header().Set("Content-Type", "text/html")
			w.Write([]byte("<script>x</script>"))
		case "/unlabelled.png":
			w.Header().Set("Content-Type", "binary/octet-stream")
			w.Write(png)
		case "/unlabelled.html":
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Write([]byte("<!doctype html><script>x</script>"))
		case "/unlabelled.svg":
			w.Header().Set("Content-Type", "binary/octet-stream")
			w.Write([]byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>`))
		case "/other-port.png":
			http.Redirect(w, r, "http://127.0.0.1:1/pic.png", http.StatusFound)
		case "/huge.png":
			w.Header().Set("Content-Type", "image/png")
			w.Header().Set("Content-Length", fmt.Sprint(maxGoImage+1))
		default:
			http.NotFound(w, r)
		}
	}))
	defer site.Close()
	goTestPorts(t, portOf(t, site.URL))
	g, url, s := newGoServer(t, "")
	g.goResources = newGoResourceClient(allowAll) // the site is on loopback
	ctx := testCtx(t)
	fetch := func(kind, path string) (map[string]any, *tunnelClient) {
		tc := openSession(t, ctx, url, s)
		return tc.request(t, ctx, tunnelRequest{Type: "go-resource", Resource: kind, URL: site.URL + path}), tc
	}
	// fetchOnly is fetch, its bytes left unread: the connection's closed,
	// as a page does, so that it doesn't hold one of the session's slots.
	fetchOnly := func(kind, path string) (map[string]any, *tunnelClient) {
		reply, tc := fetch(kind, path)
		tc.c.CloseNow()
		return reply, tc
	}

	for _, tc := range []struct {
		kind, path, mime string
		want             []byte
	}{
		{"image", "/pic.png", "image/png", png},
		{"image", "/moved.png", "image/png", png},
		{"image", "/unlabelled.png", "image/png", png}, // labelled as bytes, seen to be a PNG
		{"css", "/style.css", "text/css", css},         // decompressed
		{"font", "/font.woff2", "font/woff2", woff2},
	} {
		reply, conn := fetch(tc.kind, tc.path)
		if reply["error"] != nil || reply["mime"] != tc.mime || reply["size"] != float64(len(tc.want)) {
			t.Errorf("%s: %v", tc.path, reply)
			continue
		}
		if got := readGoResource(t, ctx, conn); !bytes.Equal(got, tc.want) {
			t.Errorf("%s: got %q", tc.path, got)
		}
	}
	if reply, _ := fetchOnly("image", "/moved.png"); reply["url"] != site.URL+"/pic.png" {
		t.Errorf("after a redirect, url %v", reply["url"])
	}

	for _, tc := range []struct{ kind, path, want string }{
		{"css", "/bomb.css", "too large"},
		{"css", "/brotli.css", "encoding"},
		{"font", "/fake-font.woff2", "font"},
		{"image", "/page.html", "type"},
		{"image", "/unlabelled.html", "type"},
		{"image", "/unlabelled.svg", "type"},
		{"css", "/pic.png", "type"},
		{"image", "/huge.png", "too large"},
		{"image", "/missing.png", "HTTP 404"},
		{"image", "/other-port.png", "HTTP 302"}, // not followed to another port
		{"script", "/pic.png", "Unsupported"},
	} {
		if reply, _ := fetchOnly(tc.kind, tc.path); reply["error"] == nil || !strings.Contains(reply["error"].(string), tc.want) {
			t.Errorf("%s as %s: %v, want an error about %q", tc.path, tc.kind, reply, tc.want)
		}
	}
	for _, bad := range []string{"file:///etc/passwd", "javascript:x", strings.Replace(site.URL, "http://", "http://u:p@", 1) + "/pic.png"} {
		tc := openSession(t, ctx, url, s)
		if reply := tc.request(t, ctx, tunnelRequest{Type: "go-resource", Resource: "image", URL: bad}); reply["error"] == nil {
			t.Errorf("%s was fetched", bad)
		}
	}

	// Only HTTP's and HTTPS's ports, as the engine's proxy: not the test
	// site's.
	goTestPorts(t)
	if reply, _ := fetchOnly("image", "/pic.png"); reply["error"] == nil || !strings.Contains(reply["error"].(string), "ports 80 and 443") {
		t.Errorf("another port: %v", reply)
	}
	goTestPorts(t, portOf(t, site.URL))
	// The real policy refuses loopback, the test site's address.
	g.goResources = newGoResourceClient(fetchPolicy(false))
	if reply, _ := fetchOnly("image", "/pic.png"); reply["error"] == nil {
		t.Error("a loopback address was fetched")
	}
	g.goOn = false
	if reply, _ := fetchOnly("image", "/pic.png"); reply["error"] == nil || !strings.Contains(reply["error"].(string), "WEB_GO=0") {
		t.Errorf("with the remote browser off: %v", reply)
	}
}

// One session holds at most goResourcePerSession of the broker's slots;
// another still gets one, and a session's share goes once it's unused.
func TestGoSessionSlots(t *testing.T) {
	s := goSessionWork{work: map[string]*goSessionShare{}}
	var held []func()
	for range goResourcePerSession {
		release, ok := s.acquire(context.Background(), "a")
		if !ok {
			t.Fatal("a slot within the share refused")
		}
		held = append(held, release)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if _, ok := s.acquire(ctx, "a"); ok {
		t.Fatal("a session got more than its share")
	}
	other, ok := s.acquire(context.Background(), "b")
	if !ok {
		t.Fatal("another session was held up")
	}
	other()
	for _, release := range held {
		release()
	}
	if len(s.work) != 0 {
		t.Fatalf("shares left: %v", s.work)
	}
}
