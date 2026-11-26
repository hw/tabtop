package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

// A sized fetch (Content-Length 1000) cut off part way is resumed; the
// server answers the range with an endless 206 body (no length). Nothing
// bounds that body by the size first declared, nor by the room kept free
// for unsized fetches, so it streams onto the disk without end.
func TestFetchResumedRangeKeepsToItsSize(t *testing.T) {
	_, srv, s := newFetchServer(t)
	var sent206 atomic.Int64
	var calls atomic.Int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch calls.Add(1) {
		case 1:
			w.Header().Set("Accept-Ranges", "bytes")
			w.Header().Set("ETag", `"v1"`)
			w.Header().Set("Content-Length", "1000")
			w.Write(bytes.Repeat([]byte("a"), 500))
			w.(http.Flusher).Flush()
			panic(http.ErrAbortHandler)
		case 2:
			w.Header().Set("Accept-Ranges", "bytes")
			w.Header().Set("ETag", `"v1"`)
			w.Header().Set("Content-Range", "bytes 500-999/1000")
			w.WriteHeader(http.StatusPartialContent)
			chunk := bytes.Repeat([]byte("z"), 64<<10)
			for i := 0; i < 1024; i++ { // 64 MiB, for a range of 500 bytes
				if _, err := w.Write(chunk); err != nil {
					return
				}
				w.(http.Flusher).Flush()
				sent206.Add(int64(len(chunk)))
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer remote.Close()
	tc := openSession(t, testCtx(t), srv, s)
	tc.request(t, testCtx(t), tunnelRequest{Type: "fetch", URL: remote.URL + "/f.bin"})
	last := follow(t, tc)
	if n := sent206.Load(); n > 8<<20 {
		t.Fatalf("a 500-byte range of a 1000-byte file took %d bytes onto the disk (last %v)", n, last)
	}
}
