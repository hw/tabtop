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
	// (The master offered again with its length, once its variant's read:
	// TestGoStreamsAbout.)
	if got := offered(); !slices.Equal(got, slices.Insert(slices.Clone(want), 1, want[0])) {
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

// TestGoStreamsMalformed: a playlist that makes the m3u8 package panic
// (found by fuzzing it) is an error, not the end of tabtopd: as a page's
// manifest read, and as a stream saved.
func TestGoStreamsMalformed(t *testing.T) {
	for _, in := range []string{"#EXT-X-MAP:\n0", "#EXTM3U\n#EXT-X-MAP:\n0"} {
		if _, _, err := decodeM3U8([]byte(in)); err == nil {
			t.Errorf("%q: no error", in)
		}
	}
	w := &goWrites{}
	conn := &goConn{cur: newGoLink(w, false)}
	b := &goBrowser{t: conn, conn: conn, gen: 1}
	b.streamSeen("1", "https://bad.example/x.m3u8")
	b.offerStream(goStreamSeen{id: "1", url: "https://bad.example/x.m3u8", gen: 1}, []byte("#EXTM3U\n#EXT-X-MAP:\n0"))
}

// TestGoStreamsAbout offers each stream with what it is: a master with its
// best picture's height, then, once one of its playlists is read, again
// with how long it lasts (only once); a media playlist played alone with
// its length, or as live; a DASH manifest with both; and sends them again
// as they are to a page taking the tab back.
func TestGoStreamsAbout(t *testing.T) {
	w := &goWrites{}
	conn := &goConn{cur: newGoLink(w, false)}
	b := &goBrowser{t: conn, conn: conn, gen: 1}
	said := func() []string {
		var out []string
		for _, m := range w.msg {
			var v map[string]any
			if json.Unmarshal(m, &v) == nil && v["type"] == "go-manifest" {
				out = append(out, fmt.Sprintf("%v h%v d%v live%v", v["url"], v["height"], v["duration"], v["live"]))
			}
		}
		w.msg = nil
		return out
	}
	see := func(id, u string, body string) {
		b.streamSeen(id, u)
		b.offerStream(goStreamSeen{id: id, url: u, gen: b.gen}, []byte(body))
	}
	master := "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080\nhigh.m3u8\n"
	vod := "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\n1.m4s\n#EXTINF:6,\n2.m4s\n#EXTINF:3.4,\n3.m4s\n#EXT-X-ENDLIST\n"
	live := "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\n1.m4s\n"
	mpd := `<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT1H2M3S"><Period><AdaptationSet height="720"><Representation height="480"/></AdaptationSet><AdaptationSet><Representation height="1440"/></AdaptationSet></Period></MPD>`
	see("1", "https://v.example/m/master.m3u8", master)
	see("2", "https://v.example/m/high.m3u8", vod)
	see("3", "https://v.example/m/low.m3u8", vod) // its length known already: not said again
	see("4", "https://ad.example/ad.m3u8", vod)
	see("5", "https://tv.example/live.m3u8", live)
	see("6", "https://d.example/movie.mpd", mpd)
	want := []string{
		"https://v.example/m/master.m3u8 h1080 d<nil> live<nil>",
		"https://v.example/m/master.m3u8 h1080 d15 live<nil>",
		"https://ad.example/ad.m3u8 h<nil> d15 live<nil>",
		"https://tv.example/live.m3u8 h<nil> d<nil> livetrue",
		"https://d.example/movie.mpd h1440 d3723 live<nil>",
	}
	if got := said(); !slices.Equal(got, want) {
		t.Errorf("said\n%q\nwant\n%q", got, want)
	}
	b.resendStreams()
	if got := said(); !slices.Equal(got, slices.Delete(slices.Clone(want), 0, 1)) {
		t.Errorf("sent again %q", got)
	}
	if h := goStreamHeight("1280X720"); h != 720 {
		t.Errorf("height %d", h)
	}
}
