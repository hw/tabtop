package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestPreviewResource(t *testing.T) {
	data := []byte("\x89PNG\r\n\x1a\nexternal picture")
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" {
			t.Error("forwarded credentials")
		}
		switch r.URL.Path {
		case "/redirect":
			http.Redirect(w, r, "/image", http.StatusFound)
		case "/html":
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprint(w, "<script>bad()</script>")
		case "/large":
			w.Header().Set("Content-Type", "image/png")
			w.Header().Set("Content-Length", fmt.Sprint(maxPreviewResource+1))
		case "/chunked":
			w.Header().Set("Content-Type", "image/png")
			w.(http.Flusher).Flush()
			w.Write(bytes.Repeat([]byte("x"), maxPreviewResource+1))
		default:
			w.Header().Set("Content-Type", "image/png")
			w.Write(data)
		}
	}))
	defer remote.Close()
	g, address, session := newFetchServer(t)
	manager := g.fetches
	defer func() { g.fetches = manager }()
	ctx := testCtx(t)
	for _, path := range []string{"/image", "/redirect"} {
		tc := openSession(t, ctx, address, session)
		reply := tc.request(t, ctx, tunnelRequest{Type: "preview-resource", URL: remote.URL + path})
		if reply["mime"] != "image/png" || reply["size"] != float64(len(data)) {
			t.Fatalf("reply: %v", reply)
		}
		var got []byte
		for {
			kind, b, err := tc.read(ctx)
			if err != nil {
				break
			}
			if kind != msgData {
				t.Fatalf("unexpected message %d", kind)
			}
			got = append(got, b...)
			tc.write(ctx, msgData, nil)
		}
		if !bytes.Equal(got, data) {
			t.Fatalf("wrong picture: %q", got)
		}
	}
	for _, url := range []string{remote.URL + "/html", remote.URL + "/large", remote.URL + "/chunked", "file:///etc/passwd", strings.Replace(remote.URL, "http://", "http://user:secret@", 1)} {
		reply := openSession(t, ctx, address, session).request(t, ctx, tunnelRequest{Type: "preview-resource", URL: url})
		if reply["error"] == nil {
			t.Fatalf("accepted invalid resource %s: %v", url, reply)
		}
	}
	// The normal production policy refuses loopback even though a test server allowed it above.
	g.fetches.resourceClient = newFetchClient(fetchPolicy(false))
	if reply := openSession(t, ctx, address, session).request(t, ctx, tunnelRequest{Type: "preview-resource", URL: remote.URL + "/image"}); reply["error"] == nil {
		t.Fatal("private address was fetched")
	}
	g.fetches = nil
	if reply := openSession(t, ctx, address, session).request(t, ctx, tunnelRequest{Type: "preview-resource", URL: remote.URL + "/image"}); reply["error"] == nil {
		t.Fatal("WEB_FETCH=0 bypassed")
	}
}

func TestPreviewResourceCancellation(t *testing.T) {
	started, cancelled := make(chan struct{}), make(chan struct{})
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(started); <-r.Context().Done(); close(cancelled) }))
	defer remote.Close()
	_, address, session := newFetchServer(t)
	ctx := testCtx(t)
	tc := openSession(t, ctx, address, session)
	request, _ := json.Marshal(tunnelRequest{Type: "preview-resource", URL: remote.URL})
	tc.write(ctx, msgText, request)
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("resource did not start")
	}
	tc.c.CloseNow()
	select {
	case <-cancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream resource was not cancelled")
	}
}

func TestPreviewFrameResourcePolicy(t *testing.T) {
	for _, mode := range []string{"", "none", "proxy", "direct", "unknown"} {
		policy := previewFrameCSP(httptest.NewRequest("GET", "/tabtop/md-frame.html?external="+mode, nil))
		if strings.Contains(policy, "img-src blob: data: http: https:;") != (mode == "direct") {
			t.Fatalf("mode %s: %s", mode, policy)
		}
		if !strings.Contains(policy, "default-src 'none'") || !strings.Contains(policy, frameSandbox) {
			t.Fatalf("weakened sandbox for %s", mode)
		}
	}
}

func TestEpubRemotePicturesAreInert(t *testing.T) {
	chapter := `<html xmlns="http://www.w3.org/1999/xhtml"><body><img src="https://example.com/remote.png" onerror="bad()"/><img src="//example.com/other.png"/><img src="file:///etc/passwd"/><svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/svg.png"/></svg></body></html>`
	z := openTestEpub(t, makeEpub(t, "OEBPS/text/ch1.xhtml", chapter))
	got, err := z.renderChapter("OEBPS/text/ch1.xhtml")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"https://example.com/remote.png", "https://example.com/other.png", "https://example.com/svg.png"} {
		if !strings.Contains(got, want) {
			t.Fatalf("remote resource removed: %s", got)
		}
	}
	for _, bad := range []string{"onerror", "bad()", "file:", "<svg"} {
		if strings.Contains(got, bad) {
			t.Fatalf("unsafe content retained: %s", got)
		}
	}
}

func TestPreviewStylesFontsAndMediaRanges(t *testing.T) {
	media := bytes.Repeat([]byte("0123456789abcdef"), 150000)
	version := `"one"`
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/style.css":
			w.Header().Set("Content-Type", "text/css")
			fmt.Fprint(w, `@import "nested.css";p{color:red}`)
		case "/font.woff2":
			w.Header().Set("Content-Type", "font/woff2")
			w.Write([]byte("wOF2font-body"))
		case "/fake.woff2":
			w.Header().Set("Content-Type", "font/woff2")
			fmt.Fprint(w, "<script>bad()</script>")
		case "/ignores.mp4":
			w.Header().Set("Content-Type", "video/mp4")
			w.WriteHeader(http.StatusOK)
		case "/invalid.mp4":
			w.Header().Set("Content-Type", "video/mp4")
			w.Header().Set("Content-Range", "bytes 99-100/200")
			w.WriteHeader(http.StatusPartialContent)
			w.Write([]byte("xx"))
		default:
			w.Header().Set("Content-Type", "video/mp4")
			w.Header().Set("ETag", version)
			http.ServeContent(w, r, "test.mp4", time.Unix(1700000000, 0), bytes.NewReader(media))
		}
	}))
	defer remote.Close()
	_, address, session := newFetchServer(t)
	ctx := testCtx(t)
	read := func(req tunnelRequest) (map[string]any, []byte) {
		tc := openSession(t, ctx, address, session)
		reply := tc.request(t, ctx, req)
		if reply["error"] != nil {
			return reply, nil
		}
		var got []byte
		for {
			kind, b, err := tc.read(ctx)
			if err != nil {
				break
			}
			if kind != msgData {
				t.Fatal("unexpected message")
			}
			got = append(got, b...)
			tc.write(ctx, msgData, nil)
		}
		return reply, got
	}
	for _, kind := range []string{"css", "font"} {
		path := "/style.css"
		if kind == "font" {
			path = "/font.woff2"
		}
		reply, got := read(tunnelRequest{Type: "preview-resource", Resource: kind, URL: remote.URL + path})
		if reply["error"] != nil || len(got) == 0 {
			t.Fatalf("%s: %v", kind, reply)
		}
	}
	info, one := read(tunnelRequest{Type: "preview-resource", Resource: "media", URL: remote.URL + "/test.mp4"})
	if len(one) != 1 || info["total_size"] != float64(len(media)) || info["validator"] != version {
		t.Fatalf("metadata: %v %q", info, one)
	}
	reply, chunk := read(tunnelRequest{Type: "preview-resource", Resource: "media", URL: remote.URL + "/test.mp4", Offset: 1 << 20, Length: 100, IfSize: int64(len(media)), IfMtime: version})
	if reply["error"] != nil || !bytes.Equal(chunk, media[1<<20:(1<<20)+100]) {
		t.Fatalf("range: %v", reply)
	}
	for _, req := range []tunnelRequest{
		{Type: "preview-resource", Resource: "font", URL: remote.URL + "/fake.woff2"},
		{Type: "preview-resource", Resource: "media", URL: remote.URL + "/ignores.mp4"},
		{Type: "preview-resource", Resource: "media", URL: remote.URL + "/invalid.mp4"},
		{Type: "preview-resource", Resource: "media", URL: remote.URL + "/test.mp4", Length: maxPreviewMediaRange + 1, IfSize: int64(len(media))},
		{Type: "preview-resource", Resource: "media", URL: remote.URL + "/test.mp4", Length: 100, IfSize: int64(len(media)), IfMtime: `"stale"`},
	} {
		if reply, _ := read(req); reply["error"] == nil {
			t.Fatalf("invalid resource accepted: %+v", req)
		}
	}
}
