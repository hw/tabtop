package main

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Media's types, by their first bytes.
func TestSniffMedia(t *testing.T) {
	for _, c := range []struct {
		head []byte
		want string
	}{
		{[]byte("\x00\x00\x00\x20ftypisom\x00\x00\x02\x00"), "video/mp4"},
		{[]byte("\x00\x00\x00\x1cftypM4A \x00\x00\x00\x00"), "audio/mp4"},
		{[]byte("\x00\x00\x00\x14ftypqt  \x00\x00\x00\x00"), "video/quicktime"},
		{append([]byte{0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84}, "webm"...), "video/webm"},
		{append([]byte{0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x88}, "matroska"...), "video/x-matroska"},
		{[]byte("OggS\x00\x02vorbis"), "audio/ogg"},
		{[]byte("OggS\x00\x02\x80theora"), "video/ogg"},
		{[]byte("fLaC\x00\x00\x00\x22"), "audio/flac"},
		{[]byte("RIFF\x24\x00\x00\x00WAVEfmt "), "audio/wav"},
		{[]byte("ID3\x04\x00"), "audio/mpeg"},
		{[]byte{0xff, 0xfb, 0x90, 0x64}, "audio/mpeg"},
		{[]byte{0xff, 0xf1, 0x50, 0x80}, "audio/aac"},
		{[]byte("<!doctype html><script>x</script>"), ""},
		{[]byte("\x89PNG\r\n\x1a\n"), ""},
		{nil, ""},
	} {
		if got := sniffMedia(c.head); got != c.want {
			t.Errorf("%q: %q, want %q", c.head, got, c.want)
		}
		if c.want != "" && !previewResourceType("media", c.want) {
			t.Errorf("%s isn't a type players take", c.want)
		}
	}
}

// A video a CDN labels binary/octet-stream, with byte ranges: probed and
// read in parts as the MP4 it is, its first bytes asked for once; a page
// labelled so is refused, as before.
func TestGoMediaUnlabelled(t *testing.T) {
	clip := append([]byte("\x00\x00\x00\x20ftypisom\x00\x00\x02\x00isomiso2avc1mp41"), bytes.Repeat([]byte{7}, 4000)...)
	var firsts atomic.Int32
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.Header.Get("Range"), "bytes=0-") {
			firsts.Add(1)
		}
		w.Header().Set("Content-Type", "binary/octet-stream")
		w.Header().Set("ETag", `"v1"`)
		body := clip
		if r.URL.Path == "/page.mp4" {
			body = []byte("<!doctype html><script>x</script>" + strings.Repeat(" ", 600))
		}
		http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(body))
	}))
	defer site.Close()
	client := newGoResourceClient(allowAll)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	_, probe, err := goFetchMedia(ctx, "session", tunnelRequest{Resource: "media", URL: site.URL + "/clip"}, client, goResourceSlots, "UA", nil)
	if err != nil || probe["mime"] != "video/mp4" || probe["total_size"] != int64(len(clip)) {
		t.Fatalf("probe: %v %v", probe, err)
	}
	for _, at := range []int64{0, 1000, int64(len(clip)) - 50} {
		data, reply, err := goFetchMedia(ctx, "session", tunnelRequest{Resource: "media", URL: site.URL + "/clip", Offset: at, Length: 50, IfSize: int64(len(clip)), IfMtime: `"v1"`}, client, goResourceSlots, "UA", nil)
		if err != nil || !bytes.Equal(data, clip[at:at+50]) || reply["mime"] != "video/mp4" {
			t.Errorf("part at %d: %v %v", at, reply, err)
		}
	}
	// Its first bytes asked for once to be looked at (and once as the
	// part at 0, and the probe's): not for every part.
	if n := firsts.Load(); n > 3 {
		t.Errorf("its start asked for %d times", n)
	}
	if _, _, err := goFetchMedia(ctx, "session", tunnelRequest{Resource: "media", URL: site.URL + "/page.mp4"}, client, goResourceSlots, "UA", nil); err == nil || !strings.Contains(err.Error(), "unsupported content type") {
		t.Errorf("a page labelled as bytes: %v", err)
	}
}
