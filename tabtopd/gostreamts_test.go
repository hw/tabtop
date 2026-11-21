package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestSaveStreamTS saves HLS streams of MPEG-TS segments, made by ffmpeg
// (skipped without it), as MP4s that ffprobe reads and ffmpeg decodes
// without an error, as long as they are, their video and sound together:
// H.264 (with B-frames) and AAC muxed; H.265; two clips on clocks of their
// own, a discontinuity between; a clock that wraps partway; the sound a
// rendition of its own; MP3 sound (MPEG-1's rates and MPEG-2's); each
// indexed. One with AC-3 sound is refused, not saved silent.
func TestSaveStreamTS(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg isn't installed")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe isn't installed")
	}
	dir := t.TempDir()
	hls := func(name string, secs int, args ...string) {
		t.Helper()
		cmd := append([]string{"-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
			"-t", fmt.Sprint(secs)}, args...)
		cmd = append(cmd, "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod", "-hls_segment_filename", filepath.Join(dir, name+"%d.ts"), filepath.Join(dir, name+".m3u8"))
		if out, err := exec.Command("ffmpeg", cmd...).CombinedOutput(); err != nil {
			t.Fatalf("ffmpeg %s: %v\n%s", name, err, out)
		}
	}
	h264 := []string{"-c:v", "libx264", "-preset", "ultrafast", "-g", "50", "-bf", "2", "-pix_fmt", "yuv420p"}
	hls("muxed", 6, append(h264, "-c:a", "aac")...)
	hls("hevc", 4, "-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error", "-g", "50", "-c:a", "aac")
	hls("later", 4, append(h264, "-c:a", "aac", "-output_ts_offset", "1000")...)
	hls("wraps", 6, append(h264, "-c:a", "aac", "-output_ts_offset", fmt.Sprint(float64(tsWrap)/tsClockRate-3))...)
	hls("video", 6, append(h264, "-an")...)
	hls("sound", 6, "-vn", "-c:a", "aac")
	hls("mp3", 4, append(h264, "-c:a", "libmp3lame")...)
	hls("mp3-low", 4, append(h264, "-c:a", "libmp3lame", "-ar", "22050")...) // MPEG-2's lower rate
	hls("ac3", 4, append(h264, "-c:a", "ac3")...)
	read := func(name string) string {
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	// The muxed clip, then the later one, its own clock: a discontinuity.
	later := read("later.m3u8")
	later = later[strings.Index(later, "#EXTINF"):]
	joined := strings.Replace(read("muxed.m3u8"), "#EXT-X-ENDLIST\n", "#EXT-X-DISCONTINUITY\n"+later, 1)
	os.WriteFile(filepath.Join(dir, "joined.m3u8"), []byte(joined), 0o644)
	os.WriteFile(filepath.Join(dir, "master.m3u8"), []byte("#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"English\",DEFAULT=YES,URI=\"sound.m3u8\"\n"+
		"#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=320x180,AUDIO=\"a\"\nvideo.m3u8\n"), 0o644)

	g, srv, s := newFetchServer(t)
	remote := newTestFileServer(t, dir)
	g.defaultRoot().fetches.goClient = newFetchClient(func(netip.Addr) bool { return true })
	tab := &goTab{token: "tab-token", session: s.id, ended: make(chan struct{}),
		b: &goBrowser{ctx: context.Background(), cdp: &cdpConn{err: errCDPClosed}, conn: &goConn{}, userAgent: "Mozilla/5.0 (the tab's)"}}
	g.goTabList().add(tab)
	save := func(manifest string) (string, error) {
		tc := openSession(t, testCtx(t), srv, s)
		first := tc.request(t, testCtx(t), tunnelRequest{Type: "fetch", FromGo: true, SaveStream: true, GoTab: "tab-token", URL: remote + "/" + manifest})
		if first["ok"] != true {
			t.Fatal(first)
		}
		last := follow(t, tc)
		if last["error"] != nil {
			return "", fmt.Errorf("%v", last["error"])
		}
		return filepath.Join(g.downloadsDir, fetchedName(last)), nil
	}
	for _, c := range []struct {
		manifest string
		secs     float64
		video    string
		audio    string
	}{
		{"muxed.m3u8", 6, "h264", "aac"},
		{"hevc.m3u8", 4, "hevc", "aac"},
		{"joined.m3u8", 10, "h264", "aac"},
		{"wraps.m3u8", 6, "h264", "aac"},
		{"master.m3u8", 6, "h264", "aac"},
		{"mp3.m3u8", 4, "h264", "mp3"},
		{"mp3-low.m3u8", 4, "h264", "mp3"},
	} {
		file, err := save(c.manifest)
		if err != nil {
			t.Errorf("%s: %v", c.manifest, err)
			continue
		}
		out, err := exec.Command("ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_name,codec_type,start_time,duration", "-of", "json", file).Output()
		if err != nil {
			t.Errorf("%s: ffprobe: %v", c.manifest, err)
			continue
		}
		var probe struct {
			Format  struct{ Duration string }
			Streams []struct {
				CodecName string `json:"codec_name"`
				CodecType string `json:"codec_type"`
				StartTime string `json:"start_time"`
				Duration  string
			}
		}
		json.Unmarshal(out, &probe)
		codecs := map[string]string{}
		for _, st := range probe.Streams {
			codecs[st.CodecType] = st.CodecName
			var start, d float64
			fmt.Sscan(st.StartTime, &start)
			fmt.Sscan(st.Duration, &d)
			if start > 0.2 || math.Abs(d-c.secs) > 0.3 {
				t.Errorf("%s: its %s starts at %s, lasts %s; want 0 and %v", c.manifest, st.CodecType, st.StartTime, st.Duration, c.secs)
			}
		}
		if codecs["video"] != c.video || codecs["audio"] != c.audio {
			t.Errorf("%s: tracks %v", c.manifest, codecs)
		}
		// Indexed (a sidx for each track, after the header): what a player
		// reading it as a file (Chrome's) learns its length from, and seeks by.
		data, _ := os.ReadFile(file)
		var top []string
		streamBoxes(data, func(kind, _ []byte) error { top = append(top, string(kind)); return nil })
		if len(top) < 4 || top[2] != "sidx" || top[3] != "sidx" {
			t.Errorf("%s: its boxes %v, not indexed", c.manifest, top)
		}
		if errs, _ := exec.Command("ffmpeg", "-v", "error", "-i", file, "-f", "null", "-").CombinedOutput(); len(errs) > 0 {
			t.Errorf("%s: decoding it: %s", c.manifest, errs)
		}
	}
	if _, err := save("ac3.m3u8"); err == nil || !strings.Contains(err.Error(), "AC-3") {
		t.Errorf("a stream with AC-3 sound: %v", err)
	}
}

// newTestFileServer serves dir's files, for the test's run.
func newTestFileServer(t *testing.T, dir string) string {
	srv := httptest.NewServer(http.FileServer(http.Dir(dir)))
	t.Cleanup(srv.Close)
	return srv.URL
}

// TestTSRemuxMalformed: what a website sends that the parsers can't take
// (parameter sets cut short, a segment of noise) is an error, not a panic
// that would end tabtopd.
func TestTSRemuxMalformed(t *testing.T) {
	for _, v := range []*tsStream{
		{video: true, sps: [][]byte{{0x67}}, pps: [][]byte{{0x68}}},
		{video: true, hevc: true, vps: [][]byte{{0x40}}, sps: [][]byte{{0x42}}, pps: [][]byte{{0x44}}},
	} {
		r := newTSRemux(&tsClock{})
		r.video = v
		if _, err := r.header(); err == nil {
			t.Errorf("hevc %t: no error", v.hevc)
		}
	}
	noise := make([]byte, 188*4)
	for i := range noise {
		noise[i] = byte(i * 7)
	}
	for i := 0; i < len(noise); i += 188 {
		noise[i] = 0x47
	}
	if err := newTSRemux(&tsClock{}).probe(noise); err == nil {
		t.Error("noise: no error")
	}
}
