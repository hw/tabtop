package main

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/andybalholm/brotli"
	"github.com/klauspost/compress/zstd"
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
	// Brotli, as a site sends it to a browser that asks; and a Brotli bomb.
	var brotlied, brBomb bytes.Buffer
	bw := brotli.NewWriter(&brotlied)
	bw.Write(css)
	bw.Close()
	bw = brotli.NewWriter(&brBomb)
	for i := 0; i < maxGoCSS/(1<<20)+2; i++ {
		bw.Write(make([]byte, 1<<20))
	}
	bw.Close()
	// zstd, deflate (zlib's, and bare), and one on another (gzip, then
	// Brotli of that); a zstd bomb, and one asking for a 64 MB window.
	enc := func(f func(io.Writer) io.WriteCloser, data []byte) []byte {
		var b bytes.Buffer
		w := f(&b)
		w.Write(data)
		w.Close()
		return b.Bytes()
	}
	zstdW := func(opts ...zstd.EOption) func(io.Writer) io.WriteCloser {
		return func(w io.Writer) io.WriteCloser { e, _ := zstd.NewWriter(w, opts...); return e }
	}
	zstded := enc(zstdW(), css)
	zstdBomb := enc(zstdW(), make([]byte, maxGoCSS+(1<<20)))
	// A frame whose header asks for a 64 MB window (2^(10+16)), one raw
	// block, the last, of "body{}" (written by hand: an encoder sizes the
	// window to what it has).
	raw := []byte("body{}")
	blockHeader := 1 | len(raw)<<3 // last, raw, its size
	zstdWide := append([]byte{0x28, 0xb5, 0x2f, 0xfd, 0x00, 16 << 3, byte(blockHeader), byte(blockHeader >> 8), byte(blockHeader >> 16)}, raw...)
	if zr, err := zstd.NewReader(bytes.NewReader(zstdWide), zstd.WithDecoderMaxWindow(128<<20)); err != nil {
		t.Fatal(err)
	} else if got, err := io.ReadAll(zr); err != nil || string(got) != "body{}" {
		t.Fatalf("the wide frame, allowed its window: %q %v", got, err) // it's well formed: refused for its window alone
	}
	zlibbed := enc(func(w io.Writer) io.WriteCloser { return zlib.NewWriter(w) }, css)
	flated := enc(func(w io.Writer) io.WriteCloser { f, _ := flate.NewWriter(w, flate.DefaultCompression); return f }, css)
	stacked := enc(func(w io.Writer) io.WriteCloser { return brotli.NewWriter(w) }, gzipped.Bytes())
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
		// What a tab says it is (no tab here: the desktop's, an engine's own
		// once one has said it, as in a test with Moli before), never TabTop.
		if ua := r.Header.Get("User-Agent"); !strings.HasPrefix(ua, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ") || !strings.Contains(ua, " Chrome/") || strings.Contains(strings.ToLower(ua), "tabtop") {
			t.Errorf("User-Agent %q", ua)
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
			if !strings.Contains(r.Header.Get("Accept-Encoding"), "br") {
				t.Errorf("Brotli not asked for: %q", r.Header.Get("Accept-Encoding"))
			}
			w.Header().Set("Content-Type", "text/css")
			w.Header().Set("Content-Encoding", "br")
			w.Write(brotlied.Bytes())
		case "/broken.br.css":
			w.Header().Set("Content-Type", "text/css")
			w.Header().Set("Content-Encoding", "br")
			w.Write([]byte("not really brotli"))
		case "/bomb.br.css":
			w.Header().Set("Content-Type", "text/css")
			w.Header().Set("Content-Encoding", "br")
			w.Write(brBomb.Bytes())
		case "/zstd.css", "/zstd-bomb.css", "/zstd-wide.css", "/deflate.css", "/raw-deflate.css", "/stacked.css", "/three.css", "/compress.css":
			if ae := r.Header.Get("Accept-Encoding"); ae != goAcceptEncoding {
				t.Errorf("Accept-Encoding %q", ae)
			}
			w.Header().Set("Content-Type", "text/css")
			body, coding := map[string][]byte{"/zstd.css": zstded, "/zstd-bomb.css": zstdBomb, "/zstd-wide.css": zstdWide, "/deflate.css": zlibbed, "/raw-deflate.css": flated, "/stacked.css": stacked, "/three.css": stacked, "/compress.css": css}[r.URL.Path],
				map[string]string{"/zstd.css": "zstd", "/zstd-bomb.css": "zstd", "/zstd-wide.css": "zstd", "/deflate.css": "deflate", "/raw-deflate.css": "deflate", "/stacked.css": "gzip, br", "/three.css": "gzip, br, identity, gzip", "/compress.css": "compress"}[r.URL.Path]
			w.Header().Set("Content-Encoding", coding)
			w.Write(body)
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
		{"css", "/brotli.css", "text/css", css},        // Brotli, decoded
		{"css", "/zstd.css", "text/css", css},
		{"css", "/deflate.css", "text/css", css},
		{"css", "/raw-deflate.css", "text/css", css}, // bare deflate, as some servers send
		{"css", "/stacked.css", "text/css", css},     // gzip, then Brotli of it
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
		{"css", "/broken.br.css", "couldn't be read"},
		{"css", "/bomb.br.css", "too large"},
		{"css", "/zstd-bomb.css", "too large"},
		{"css", "/zstd-wide.css", "couldn't be read"}, // asks to hold more than 8 MB
		{"css", "/three.css", "encoding"},             // too many, one on another
		{"css", "/compress.css", "encoding"},          // not asked for
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

// Audio and video for the /go page's players come in byte ranges, where
// the remote browser may go, on its ports.
func TestGoResourceMedia(t *testing.T) {
	clip := bytes.Repeat([]byte("0123456789"), 300)
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("ETag", `"v1"`)
		http.ServeContent(w, r, "clip.mp4", time.Time{}, bytes.NewReader(clip))
	}))
	defer site.Close()
	goTestPorts(t, portOf(t, site.URL))
	g, url, s := newGoServer(t, "")
	g.goResources = newGoResourceClient(allowAll) // the site is on loopback
	ctx := testCtx(t)
	ask := func(req tunnelRequest) (map[string]any, *tunnelClient) {
		tc := openSession(t, ctx, url, s)
		return tc.request(t, ctx, req), tc
	}
	probe, _ := ask(tunnelRequest{Type: "go-resource", Resource: "media", URL: site.URL + "/clip.mp4"})
	if probe["error"] != nil || probe["mime"] != "video/mp4" || probe["total_size"] != float64(len(clip)) || probe["validator"] != `"v1"` {
		t.Fatalf("probe: %v", probe)
	}
	part, tc := ask(tunnelRequest{Type: "go-resource", Resource: "media", URL: site.URL + "/clip.mp4", Offset: 1000, Length: 25, IfSize: int64(len(clip)), IfMtime: `"v1"`})
	if part["error"] != nil || part["size"] != float64(25) {
		t.Fatalf("range: %v", part)
	}
	if got := readGoResource(t, ctx, tc); !bytes.Equal(got, clip[1000:1025]) {
		t.Errorf("range bytes %q", got)
	}
	if r, _ := ask(tunnelRequest{Type: "go-resource", Resource: "media", URL: site.URL + "/" + strings.Repeat("x", maxGoURL)}); r["error"] == nil {
		t.Errorf("an address too long: %v", r)
	}
	// A session holding its share of slots waits for one (here, until its
	// request gives up), whatever others hold.
	var held []func()
	for range goResourcePerSession {
		release, _ := goSessionSlots.acquire(context.Background(), s.id)
		held = append(held, release)
	}
	slowCtx, slowCancel := context.WithTimeout(ctx, 300*time.Millisecond)
	defer slowCancel()
	tcSlow := openSession(t, ctx, url, s)
	slow, _ := json.Marshal(tunnelRequest{Type: "go-resource", Resource: "media", URL: site.URL + "/clip.mp4"})
	if err := tcSlow.write(slowCtx, msgText, slow); err == nil {
		if _, _, err := tcSlow.read(slowCtx); err == nil {
			t.Error("answered while its session held all its slots")
		}
	}
	for _, release := range held {
		release()
	}
	goTestPorts(t)
	if r, _ := ask(tunnelRequest{Type: "go-resource", Resource: "media", URL: site.URL + "/clip.mp4"}); r["error"] == nil {
		t.Errorf("another port: %v", r)
	}
}
