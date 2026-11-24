package main

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// webmSplit is a WebM file as a page's SourceBuffer is given it: its init
// (up to its first Cluster), then each Cluster (as mse-capture.js spills).
func webmSplit(t *testing.T, data []byte) (init []byte, parts [][]byte) {
	t.Helper()
	h, err := ebmlAt(data, 0)
	if err != nil {
		t.Fatal(err)
	}
	seg, err := ebmlAt(data, h.end)
	if err != nil || seg.id != ebmlSegment {
		t.Fatalf("no segment: %v", err)
	}
	first := -1
	ebmlChildren(data, seg.data, len(data), webmTopLevel, func(e ebmlElem) error {
		if e.id == ebmlCluster {
			if first < 0 {
				first = e.start
			}
			parts = append(parts, data[e.start:e.end])
		}
		return nil
	})
	if first < 0 {
		t.Fatal("no clusters")
	}
	return data[:first], parts
}

// TestGoWebMSave: a video's and a sound's WebM streams (each a page's
// SourceBuffer's, an init and its clusters, a cluster appended twice, as
// a seek back does) saved as one WebM: both tracks, as long as the
// streams, played through by ffmpeg without an error.
func TestGoWebMSave(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg isn't installed")
	}
	dir := t.TempDir()
	make := func(name string, args ...string) []byte {
		out := filepath.Join(dir, name)
		cmd := exec.Command("ffmpeg", append(append([]string{"-hide_banner", "-loglevel", "error", "-y"}, args...), out)...)
		if b, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("ffmpeg: %v %s", err, b)
		}
		data, err := os.ReadFile(out)
		if err != nil {
			t.Fatal(err)
		}
		return data
	}
	video := make("v.webm", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=12", "-t", "4", "-c:v", "libvpx", "-g", "12", "-b:v", "200k", "-f", "webm")
	audio := make("a.webm", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:a", "libopus", "-f", "webm")
	var inputs []webmInput
	for _, data := range [][]byte{video, audio} {
		init, parts := webmSplit(t, data)
		if len(parts) > 1 {
			parts = append(parts[:2], parts[1:]...) // its second cluster appended again
		}
		inputs = append(inputs, webmInput{init: init, partCount: len(parts), partAt: func(i int) ([]byte, error) { return parts[i], nil }})
	}
	var out bytes.Buffer
	var told, got int64
	if err := writeWebM(context.Background(), inputs, &out, func(n int64) error { told = n; return nil }, func(n int64) { got += n }); err != nil {
		t.Fatal(err)
	}
	if told != int64(out.Len()) || got != told {
		t.Errorf("said %d bytes, wrote %d (counted %d)", told, out.Len(), got)
	}
	saved := filepath.Join(dir, "saved.webm")
	if err := os.WriteFile(saved, out.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	probe, err := exec.Command("ffprobe", "-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "csv=p=0", saved).CombinedOutput()
	if err != nil {
		t.Fatalf("ffprobe: %v %s", err, probe)
	}
	lines := strings.Fields(string(probe))
	if len(lines) != 3 || lines[0] != "video" || lines[1] != "audio" {
		t.Fatalf("ffprobe says %q", probe)
	}
	if d, _ := strconv.ParseFloat(lines[2], 64); d < 3.8 || d > 4.3 {
		t.Errorf("lasts %v s, not 4", d)
	}
	if b, err := exec.Command("ffmpeg", "-v", "error", "-i", saved, "-f", "null", "-").CombinedOutput(); err != nil || len(bytes.TrimSpace(b)) > 0 {
		t.Errorf("ffmpeg played it with %v: %s", err, b)
	}
	// Each frame once (the cluster appended twice, written once): as many
	// video frames as the stream's.
	count := func(file string) string {
		b, _ := exec.Command("ffprobe", "-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", file).Output()
		return strings.TrimSpace(string(b))
	}
	if a, b := count(filepath.Join(dir, "v.webm")), count(saved); a != b || a == "" {
		t.Errorf("the stream has %s video frames, the saved file %s", a, b)
	}
	// Cues, for seeking: one, at least, pointing at a cluster.
	if !bytes.Contains(out.Bytes(), []byte{0x1C, 0x53, 0xBB, 0x6B}) {
		t.Error("no Cues")
	}
}

// TestGoWebMRefused: an encrypted track, and tracks of different
// timescales, aren't saved.
func TestGoWebMRefused(t *testing.T) {
	cat := func(p ...[]byte) []byte { return bytes.Join(p, nil) }
	init := func(scale uint64, extra []byte) []byte {
		head := ebmlElement(ebmlHeaderID, ebmlElement(ebmlDocType, []byte("webm")))
		info := ebmlElement(ebmlInfo, ebmlUint(ebmlTimecodeScale, scale, 0))
		entry := ebmlElement(ebmlTrackEntry, cat(ebmlUint(ebmlTrackNumber, 1, 0), ebmlUint(ebmlTrackType, 1, 0), extra))
		var seg bytes.Buffer
		ebmlPutID(&seg, ebmlSegment)
		seg.Write([]byte{0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF}) // unknown
		seg.Write(info)
		seg.Write(ebmlElement(ebmlTracks, entry))
		return cat(head, seg.Bytes())
	}
	cluster := ebmlElement(ebmlCluster, cat(ebmlUint(ebmlTimecode, 0, 0), ebmlElement(ebmlSimpleBlock, []byte{0x81, 0, 0, 0x80, 1, 2, 3})))
	in := func(i []byte) webmInput {
		return webmInput{init: i, partCount: 1, partAt: func(int) ([]byte, error) { return cluster, nil }}
	}
	var out bytes.Buffer
	if err := writeWebM(context.Background(), []webmInput{in(init(1000000, nil))}, &out, nil, nil); err != nil {
		t.Fatalf("a plain track refused: %v", err)
	}
	if err := writeWebM(context.Background(), []webmInput{in(init(1000000, ebmlElement(ebmlContentEncodings, nil)))}, &out, nil, nil); err == nil {
		t.Error("an encoded (encrypted) track saved")
	}
	if err := writeWebM(context.Background(), []webmInput{in(init(1000000, nil)), in(init(1000, nil))}, &out, nil, nil); err == nil {
		t.Error("tracks of different timescales saved together")
	}
	if isWebM([]byte{0, 0, 0, 0x20, 'f', 't', 'y', 'p'}) || !isWebM(init(1000000, nil)) {
		t.Error("isWebM")
	}
}
