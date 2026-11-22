package main

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// A server that sends the whole file for a part (no byte ranges): the
// file's downloaded once, and its parts answered from it, with or without
// its size said; what the page's browser would send goes with it.
func TestGoMediaWithoutRanges(t *testing.T) {
	clip := bytes.Repeat([]byte("0123456789abcdef"), 64<<10) // 1 MiB
	var whole atomic.Int32
	var cookie atomic.Value
	cookie.Store("")
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Range") == "" {
			whole.Add(1)
			cookie.Store(r.Header.Get("Cookie"))
		}
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("ETag", `"v1"`)
		if r.URL.Path == "/unsized.mp4" {
			w.(http.Flusher).Flush() // chunked: no length said
		} else {
			w.Header().Set("Content-Length", strconv.Itoa(len(clip)))
		}
		w.Write(clip) // whatever the Range: 200, all of it
	}))
	defer site.Close()
	client := newGoResourceClient(allowAll)
	from := &goFrom{cookies: func(u *url.URL) string { return "kept=yes" }}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	for _, path := range []string{"/sized.mp4", "/unsized.mp4"} {
		u := site.URL + path
		_, probe, err := goFetchMedia(ctx, "session", tunnelRequest{Resource: "media", URL: u}, client, goResourceSlots, "UA", from)
		if err != nil || probe["total_size"] != int64(len(clip)) || probe["mime"] != "video/mp4" || probe["validator"] != `"v1"` {
			t.Fatalf("%s: probe %v %v", path, probe, err)
		}
		for _, at := range []int64{0, 500_000, int64(len(clip)) - 100} {
			data, _, err := goFetchMedia(ctx, "session", tunnelRequest{Resource: "media", URL: u, Offset: at, Length: 100, IfSize: int64(len(clip)), IfMtime: `"v1"`}, client, goResourceSlots, "UA", from)
			if err != nil || !bytes.Equal(data, clip[at:at+100]) {
				t.Errorf("%s at %d: %v", path, at, err)
			}
		}
		// Past its end: refused, not padded.
		if _, _, err := goFetchMedia(ctx, "session", tunnelRequest{Resource: "media", URL: u, Offset: int64(len(clip)) - 10, Length: 100, IfSize: int64(len(clip)), IfMtime: `"v1"`}, client, goResourceSlots, "UA", from); err == nil || !strings.Contains(err.Error(), "ended early") {
			t.Errorf("%s past its end: %v", path, err)
		}
	}
	// Each downloaded once (the parts from it), with the page's cookies.
	if n := whole.Load(); n != 2 {
		t.Errorf("downloaded %d times, want once each", n)
	}
	if cookie.Load() != "kept=yes" {
		t.Errorf("sent cookies %q", cookie.Load())
	}
	// Forgotten: its file gone, and fetched again if asked.
	goMediaDownloads.Lock()
	var ds []*goMediaDownload
	for _, d := range goMediaDownloads.by {
		ds = append(ds, d)
	}
	goMediaDownloads.Unlock()
	for _, d := range ds {
		d.forget()
	}
	goMediaDownloads.Lock()
	left := len(goMediaDownloads.by)
	goMediaDownloads.Unlock()
	if left != 0 {
		t.Errorf("%d left after forgetting", left)
	}
}

// TestGoMediaDownloadExceptionTab: a download made with a tab's
// certificate exception isn't another tab's, of the same login.
func TestGoMediaDownloadExceptionTab(t *testing.T) {
	clip := bytes.Repeat([]byte("0123456789abcdef"), 4<<10)
	site := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Content-Length", strconv.Itoa(len(clip)))
		w.Write(clip) // no ranges: downloaded whole
	}))
	defer site.Close()
	client := newGoResourceClient(allowAll)
	excepted := &goCertExceptions{}
	excepted.add("127.0.0.1", false)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	u := site.URL + "/clip.mp4"
	if _, _, err := goFetchMedia(ctx, "shared", tunnelRequest{Resource: "media", URL: u}, client, goResourceSlots, "UA", &goFrom{certs: excepted}); err != nil {
		t.Fatalf("the tab with the exception: %v", err)
	}
	if _, _, err := goFetchMedia(ctx, "shared", tunnelRequest{Resource: "media", URL: u}, client, goResourceSlots, "UA", &goFrom{certs: &goCertExceptions{}}); err == nil {
		t.Error("another tab took the excepted tab's download")
	}
	goMediaDownloads.Lock()
	var ds []*goMediaDownload
	for _, d := range goMediaDownloads.by {
		ds = append(ds, d)
	}
	goMediaDownloads.Unlock()
	for _, d := range ds {
		d.forget()
	}
}
