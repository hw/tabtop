package main

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/Eyevinn/mp4ff/mp4"
)

// Each rendition uses track ID 1, as independently packaged streams often do.
func TestSaveStream(t *testing.T) {
	g, srv, s := newFetchServer(t)
	files := map[string][]byte{}
	for _, kind := range []string{"video", "audio"} {
		var init, part bytes.Buffer
		header := mp4.CreateEmptyInit()
		header.AddEmptyTrack(1000, kind, "eng")
		if kind == "audio" {
			header.Moov.Mvhd.Timescale = 48000 // a movie timescale of its own, the video's another
		}
		if err := header.Encode(&init); err != nil {
			t.Fatal(err)
		}
		frag, err := mp4.CreateFragment(1, 1)
		if err != nil {
			t.Fatal(err)
		}
		sample := mp4.FullSample{Sample: mp4.NewSample(0, 1000, uint32(len(kind)), 0), Data: []byte(kind)}
		frag.AddFullSample(sample)
		if err := frag.Encode(&part); err != nil {
			t.Fatal(err)
		}
		files["/"+kind+"/init.mp4"] = init.Bytes()
		files["/"+kind+"/1.m4s"] = part.Bytes()
		files["/"+kind+"/index.m3u8"] = []byte("#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:1\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:1,\n1.m4s\n#EXT-X-ENDLIST\n")
	}
	files["/master.m3u8"] = []byte("#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"English\",DEFAULT=YES,URI=\"audio/index.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=5000,AUDIO=\"a\"\nvideo/index.m3u8\n")
	dash := ""
	for _, kind := range []string{"video", "audio"} {
		dash += fmt.Sprintf(`<AdaptationSet mimeType="%s/mp4"><SegmentTemplate initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/$Number$.m4s" duration="1"/><Representation id="%s"/></AdaptationSet>`, kind, kind)
	}
	// The audio named, after an I-frame variant (which the m3u8 package gives
	// the renditions to); a segment that fails once, then comes; and audio
	// named that isn't listed.
	files["/iframe-first.m3u8"] = []byte("#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"English\",DEFAULT=YES,URI=\"audio/index.m3u8\"\n" +
		"#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1000,URI=\"video/index.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=5000,AUDIO=\"a\"\nvideo/index.m3u8\n")
	files["/flaky.m3u8"] = []byte("#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"English\",DEFAULT=YES,URI=\"audio/index.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=5000,AUDIO=\"a\"\nvideo/flaky-index.m3u8\n")
	files["/video/flaky-index.m3u8"] = bytes.Replace(files["/video/index.m3u8"], []byte("1.m4s"), []byte("1.m4s?flaky"), 1)
	files["/video/missing-audio.m3u8"] = []byte("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000,AUDIO=\"b\"\nindex.m3u8\n")
	files["/movie.mpd"] = []byte(`<MPD type="static" mediaPresentationDuration="PT1S"><Period>` + dash + `</Period></MPD>`)
	playlist := files["/video/index.m3u8"]
	files["/video/broken.m3u8"] = bytes.Replace(playlist, []byte("#EXT-X-ENDLIST"), []byte("#EXTINF:1,\nmissing.m4s\n#EXT-X-ENDLIST"), 1)
	files["/video/live.m3u8"] = bytes.Replace(playlist, []byte("#EXT-X-ENDLIST"), nil, 1)
	files["/video/encrypted.m3u8"] = bytes.Replace(playlist, []byte("#EXT-X-MAP"), []byte("#EXT-X-KEY:METHOD=AES-128,URI=\"key\"\n#EXT-X-MAP"), 1)
	var agents sync.Map // what each request said it was
	var flaked atomic.Int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		agents.Store(r.URL.Path, r.Header.Get("User-Agent"))
		if r.URL.RawQuery == "flaky" && flaked.Add(1) == 1 {
			http.Error(w, "busy", http.StatusServiceUnavailable)
			return
		}
		data, ok := files[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Write(data)
	}))
	defer remote.Close()
	g.defaultRoot().fetches.goClient = newFetchClient(func(netip.Addr) bool { return true })
	// A stream's saved from the tab that plays it, as it played it: a tab
	// of the session's, its engine gone (its cookies, then, the account's:
	// none here), its own user agent.
	tab := &goTab{token: "tab-token", session: s.id, ended: make(chan struct{}),
		b: &goBrowser{ctx: context.Background(), cdp: &cdpConn{err: errCDPClosed}, conn: &goConn{}, userAgent: "Mozilla/5.0 (the tab's)"}}
	g.goTabList().add(tab)
	// Without it, refused: not fetched without the tab's cookies and headers.
	{
		tc := openSession(t, testCtx(t), srv, s)
		if first := tc.request(t, testCtx(t), tunnelRequest{Type: "fetch", FromGo: true, SaveStream: true, URL: remote.URL + "/master.m3u8"}); first["ok"] == true || !strings.Contains(fmt.Sprint(first["error"]), "browser tab") {
			t.Fatalf("saved without its tab: %v", first)
		}
		// Another session's tab: not its own.
		other := &goTab{token: "other-token", session: "someone-else", ended: make(chan struct{}), b: tab.b}
		g.goTabList().add(other)
		tc = openSession(t, testCtx(t), srv, s)
		if first := tc.request(t, testCtx(t), tunnelRequest{Type: "fetch", FromGo: true, SaveStream: true, GoTab: "other-token", URL: remote.URL + "/master.m3u8"}); first["ok"] == true {
			t.Fatalf("saved from another session's tab: %v", first)
		}
	}
	for _, manifest := range []string{"master.m3u8", "movie.mpd", "iframe-first.m3u8", "flaky.m3u8"} {
		tc := openSession(t, testCtx(t), srv, s)
		first := tc.request(t, testCtx(t), tunnelRequest{Type: "fetch", FromGo: true, SaveStream: true, GoTab: "tab-token", URL: remote.URL + "/" + manifest})
		if first["ok"] != true {
			t.Fatal(first)
		}
		last := follow(t, tc)
		if last["error"] != nil {
			t.Fatal(last)
		}
		data, err := os.ReadFile(filepath.Join(g.downloadsDir, fetchedName(last)))
		if err != nil {
			t.Fatal(err)
		}
		out, err := mp4.DecodeFile(bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		if len(out.Moov.Traks) != 2 {
			t.Fatal("missing track")
		}
		seen := map[uint32]string{}
		for _, seg := range out.Segments {
			for _, f := range seg.Fragments {
				seen[f.Moof.Traf.Tfhd.TrackID] = string(f.Mdat.Data)
			}
		}
		if seen[1] != "video" || seen[2] != "audio" {
			t.Fatalf("unexpected payloads: %v", seen)
		}
		for _, path := range []string{"/" + manifest, "/video/init.mp4", "/audio/1.m4s"} {
			if ua, _ := agents.Load(path); ua != "Mozilla/5.0 (the tab's)" {
				t.Errorf("%s fetched as %q, not as its tab", path, ua)
			}
		}
	}
	if flaked.Load() < 2 {
		t.Error("the segment that failed once wasn't asked for again")
	}
	for _, name := range []string{"broken", "live", "encrypted", "missing-audio"} {
		tc := openSession(t, testCtx(t), srv, s)
		first := tc.request(t, testCtx(t), tunnelRequest{Type: "fetch", FromGo: true, SaveStream: true, GoTab: "tab-token", URL: remote.URL + "/video/" + name + ".m3u8"})
		if first["ok"] != true || follow(t, tc)["error"] == nil {
			t.Fatalf("expected %s to fail", name)
		}
		if _, err := os.Stat(filepath.Join(g.downloadsDir, name+".mp4")); !os.IsNotExist(err) {
			t.Fatalf("partial %s file published", name)
		}
	}

}

// TestDashDuration reads durations as MPDs write them, the full ISO 8601
// form packagers use too.
func TestDashDuration(t *testing.T) {
	for v, want := range map[string]float64{
		"PT3M30S": 210, "PT3M30.5S": 210.5, "P0Y0M0DT0H3M30.000S": 210, "P1DT1H": 90000, "P1W": 604800, "PT0.25S": 0.25,
	} {
		if got, err := dashDuration(v); err != nil || got != want {
			t.Errorf("%q: %v, %v; want %v", v, got, err, want)
		}
	}
	for _, v := range []string{"", "P", "PT", "3M30S", "PT3X", "P1Y", "P2M", "PTM", "PT30S3M", "PT0S"} {
		if got, err := dashDuration(v); err == nil {
			t.Errorf("%q read as %v", v, got)
		}
	}
}

// TestDashTemplateEnds counts segments to the period's end: by duration,
// with a full ISO 8601 duration; and a timeline repeating to the end,
// starting where presentationTimeOffset puts it.
func TestDashTemplateEnds(t *testing.T) {
	mpd := func(duration, template string) []byte {
		return []byte(`<MPD type="static" mediaPresentationDuration="` + duration + `"><Period><AdaptationSet mimeType="video/mp4">` +
			`<Representation id="v" bandwidth="1">` + template + `</Representation></AdaptationSet></Period></MPD>`)
	}
	u, _ := url.Parse("https://videos.example/a/manifest.mpd")
	for _, c := range []struct {
		name, duration, template string
		parts                    int
		last                     string
	}{
		{"by duration, the full form", "P0Y0M0DT0H3M30.000S", `<SegmentTemplate duration="4" timescale="1" initialization="init.mp4" media="seg-$Number$.m4s"/>`, 53, "seg-53.m4s"},
		{"a timeline from an offset", "PT60S", `<SegmentTemplate timescale="90000" presentationTimeOffset="900000" initialization="init.mp4" media="seg-$Time$.m4s"><SegmentTimeline><S t="900000" d="180000" r="-1"/></SegmentTimeline></SegmentTemplate>`, 30, "seg-6120000.m4s"},
		{"a timeline from 0", "PT10S", `<SegmentTemplate timescale="1" initialization="init.mp4" media="seg-$Time$.m4s"><SegmentTimeline><S d="2" r="-1"/></SegmentTimeline></SegmentTemplate>`, 5, "seg-8.m4s"},
	} {
		tracks, err := dashTracks(mpd(c.duration, c.template), u)
		if err != nil {
			t.Errorf("%s: %v", c.name, err)
			continue
		}
		if parts := tracks[0].parts; len(parts) != c.parts || parts[len(parts)-1] != c.last {
			t.Errorf("%s: %d parts, the last %q; want %d, %q", c.name, len(parts), parts[len(parts)-1], c.parts, c.last)
		}
	}
	// Repeating to an end it isn't told: an error that says so.
	if _, err := dashTracks(mpd("", `<SegmentTemplate duration="4" timescale="1" initialization="init.mp4" media="seg-$Number$.m4s"/>`), u); err == nil || !strings.Contains(err.Error(), "no duration") {
		t.Errorf("no duration: %v", err)
	}
}

// TestStreamName names a saved stream after its manifest, as an MP4, and
// stream.mp4 where its address has no name.
func TestStreamName(t *testing.T) {
	for raw, want := range map[string]string{"https://cdn.example/show/master.m3u8": "master.mp4", "https://cdn.example/movie.mpd?x=1": "movie.mp4",
		"https://cdn.example/?token=abc": "stream.mp4", "https://cdn.example/": "stream.mp4"} {
		u, _ := url.Parse(raw)
		if got := streamName(u); got != want {
			t.Errorf("%s: %q, want %q", raw, got, want)
		}
	}
}

// TestStreamOrder writes the tracks' parts by when each starts (6 s video
// parts, 2 s audio ones: three audio to each video), in turn where a
// track's times aren't known.
func TestStreamOrder(t *testing.T) {
	video := streamTrack{parts: []string{"v0", "v1"}, starts: []float64{0, 6}}
	audio := streamTrack{parts: []string{"a0", "a1", "a2", "a3", "a4", "a5"}, starts: []float64{0, 2, 4, 6, 8, 10}}
	names := func(tracks []streamTrack) (out []string) {
		for _, p := range streamOrder(tracks) {
			out = append(out, tracks[p.track].parts[p.i])
		}
		return out
	}
	if got := names([]streamTrack{video, audio}); !slices.Equal(got, []string{"v0", "a0", "a1", "a2", "v1", "a3", "a4", "a5"}) {
		t.Errorf("by time: %v", got)
	}
	audio.starts = nil
	if got := names([]streamTrack{video, audio}); !slices.Equal(got, []string{"v0", "a0", "v1", "a1", "a2", "a3", "a4", "a5"}) {
		t.Errorf("in turn: %v", got)
	}
}
