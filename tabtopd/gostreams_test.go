package main

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"
)

// TestGoStreamsOffered offers a page's streams each once: a master playlist,
// not the variant and audio playlists it names (saved alone, they'd be the
// video without its sound, or the sound alone); a media playlist played
// without one, and a DASH manifest; and sends them again to a page that
// takes the tab back, but not a page left's.
func TestGoStreamsOffered(t *testing.T) {
	w := &goWrites{}
	conn := &goConn{cur: newGoLink(w, false)}
	b := &goBrowser{t: conn, conn: conn, gen: 3}
	offered := func() []string {
		var out []string
		for _, m := range w.msg {
			var v struct {
				Type, URL string
				Gen       int
			}
			if json.Unmarshal(m, &v) == nil && v.Type == "go-manifest" {
				out = append(out, v.URL)
			}
		}
		w.msg = nil
		return out
	}
	master := []byte("#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"en\",DEFAULT=YES,URI=\"audio/en.m3u8\"\n" +
		"#EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO=\"a\"\nvideo/low.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,AUDIO=\"a\"\nvideo/high.m3u8\n")
	media := []byte("#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg1.m4s\n#EXT-X-ENDLIST\n")
	see := func(id, u string, body []byte) {
		b.streamSeen(id, u)
		b.offerStream(goStreamSeen{id: id, url: u, gen: b.gen}, body)
	}
	see("1", "https://videos.example/show/master.m3u8", master)
	see("2", "https://videos.example/show/video/high.m3u8", media)
	see("3", "https://videos.example/show/audio/en.m3u8", media)
	see("4", "https://other.example/clip/index.m3u8", media)    // played alone
	see("5", "https://dash.example/movie/manifest.mpd", nil)    // (its body not read: offered as it is)
	see("6", "https://videos.example/show/master.m3u8", master) // asked for again
	want := []string{"https://videos.example/show/master.m3u8", "https://other.example/clip/index.m3u8", "https://dash.example/movie/manifest.mpd"}
	if got := offered(); !slices.Equal(got, want) {
		t.Errorf("offered %q, want %q", got, want)
	}
	// Taken back: the same, again.
	b.resendStreams()
	if got := offered(); !slices.Equal(got, want) {
		t.Errorf("sent again %q, want %q", got, want)
	}
	// Another page: none of the last's, and its own read afresh (a
	// variant playlist alone, with no master read for this page, is one).
	b.gen = 4
	b.resendStreams()
	if got := offered(); len(got) != 0 {
		t.Errorf("a page left's sent again: %q", got)
	}
	b.offerStream(goStreamSeen{id: "7", url: "https://videos.example/show/video/high.m3u8", gen: 3}, media) // the last page's, read late
	see("8", "https://videos.example/show/video/high.m3u8", media)
	if got := offered(); !slices.Equal(got, []string{"https://videos.example/show/video/high.m3u8"}) {
		t.Errorf("the next page offered %q", got)
	}
}

// TestGoStreamsKept lets a failed manifest's request go, doesn't read again
// one offered (a live playlist's refreshes), keeps the newest past
// maxGoStreams, and starts afresh, saying so, as the page goes to another
// place in itself.
func TestGoStreamsKept(t *testing.T) {
	w := &goWrites{}
	conn := &goConn{cur: newGoLink(w, false)}
	b := &goBrowser{t: conn, conn: conn, gen: 1}
	event := func(id string) cdpEvent {
		p, _ := json.Marshal(map[string]string{"requestId": id})
		return cdpEvent{Params: p}
	}
	// Failed: let go, not kept waiting for good.
	for i := range maxGoStreamsPending {
		b.streamSeen(fmt.Sprint("f", i), fmt.Sprintf("https://live.example/%d.m3u8", i))
		b.streamFailed(event(fmt.Sprint("f", i)))
	}
	b.streamSeen("later", "https://vod.example/master.m3u8")
	if _, ok := b.streams.pending["later"]; !ok {
		t.Fatal("a manifest after failed ones isn't noted")
	}
	// Offered: not read again.
	b.offerStream(goStreamSeen{id: "later", url: "https://vod.example/master.m3u8", gen: 1}, nil)
	b.streamSeen("again", "https://vod.example/master.m3u8")
	if _, ok := b.streams.pending["again"]; ok {
		t.Error("an offered manifest is to be read again")
	}
	// The newest kept.
	for i := range maxGoStreams + 2 {
		b.offerStream(goStreamSeen{url: fmt.Sprintf("https://many.example/%d.m3u8", i), gen: 1}, nil)
	}
	if f := b.streams.found; len(f) != maxGoStreams || f[len(f)-1] != fmt.Sprintf("https://many.example/%d.m3u8", maxGoStreams+1) || slices.Contains(f, "https://vod.example/master.m3u8") {
		t.Errorf("kept %d, the last %q", len(f), f[len(f)-1])
	}
	// Another place in the page: none kept, and the page told.
	w.msg = nil
	b.streamsLeft()
	if len(b.streams.found) != 0 || len(w.msg) != 1 || !strings.Contains(string(w.msg[0]), `"go-manifests-clear"`) {
		t.Errorf("after leaving: %d kept, said %q", len(b.streams.found), w.msg)
	}
}
