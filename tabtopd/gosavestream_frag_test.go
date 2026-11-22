package main

import (
	"bytes"
	"context"
	"testing"

	"github.com/Eyevinn/mp4ff/mp4"
)

func encodedFragment(t *testing.T, decode uint64, samples int) []byte {
	t.Helper()
	frag, err := mp4.CreateFragment(1, 1)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < samples; i++ {
		frag.AddFullSample(mp4.FullSample{Sample: mp4.NewSample(mp4.SyncSampleFlags, 1000, 1, 0), DecodeTime: decode + uint64(i)*1000, Data: []byte{1}})
	}
	var buf bytes.Buffer
	if err := frag.Encode(&buf); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// TestStreamFragmentLargeDecodeTime: a fragment whose decode time is past
// 2^53 (a 10 MHz timescale anchored at the epoch: 1.7e16), moved by
// nothing, is written as it is: it was refused ("invalid stream
// timestamp"), failing HLS and DASH saves that had worked.
func TestStreamFragmentLargeDecodeTime(t *testing.T) {
	data := encodedFragment(t, 1<<54, 2)
	var seq uint32
	media := map[uint32]streamMedia{1: {scale: 10_000_000}}
	if _, err := streamFragment(data, map[uint32]uint32{1: 1}, media, &seq, 0); err != nil {
		t.Fatalf("refused: %v", err)
	}
	// Moved by a little (a B-frame preroll's lead): exact still, in ticks.
	spans, err := streamFragment(encodedFragment(t, 1<<54, 1), map[uint32]uint32{1: 1}, media, &seq, 1.5)
	if err != nil || spans[1].decode != 1<<54+15_000_000 {
		t.Errorf("moved by 1.5 s: %d, %v", spans[1].decode, err)
	}
	// A shift past 2^53 ticks, in seconds, can't be exact: refused.
	if _, err := streamFragment(encodedFragment(t, 1000, 1), map[uint32]uint32{1: 1}, media, &seq, 1e10); err == nil {
		t.Error("a float shift past 2^53 ticks taken")
	}
}

// TestMeasureCaptureEmptyFragment: a captured fragment with no samples
// (ISO-BMFF allows it: a stream's filler) doesn't fail the save.
func TestMeasureCaptureEmptyFragment(t *testing.T) {
	parts := [][]byte{encodedFragment(t, 90000, 2), encodedFragment(t, 92000, 0), encodedFragment(t, 94000, 2)}
	tracks := []streamTrack{{ids: map[uint32]uint32{1: 1}, partCount: len(parts), partAt: func(i int) ([]byte, error) { return parts[i], nil }}}
	media := map[uint32]streamMedia{1: {scale: 1000}}
	if _, err := measureCapture(context.Background(), tracks, media); err != nil {
		t.Fatalf("an empty fragment failed the save: %v", err)
	}
}

// TestStreamFragmentExactShift: a DASH presentationTimeOffset past 2^53
// ticks (an epoch-anchored 10 MHz stream's), in the media's timescale, is
// taken off exactly (streamMedia.exact): it was refused as a float shift.
func TestStreamFragmentExactShift(t *testing.T) {
	const pto = 17_000_000_000_000_000
	data := encodedFragment(t, pto+5000, 1)
	var seq uint32
	media := map[uint32]streamMedia{1: {scale: 10_000_000, exact: -pto}}
	spans, err := streamFragment(data, map[uint32]uint32{1: 1}, media, &seq, 0)
	if err != nil {
		t.Fatalf("refused: %v", err)
	}
	if spans[1].decode != 5000 {
		t.Errorf("decode time %d, want 5000", spans[1].decode)
	}
}

// TestStreamFragmentHalfTick: a buffered fragment moved by half a tick
// (its timestampOffset times its timescale ends in .5) is measured and
// written the same way: the measure rounded it up, the write (shifted by
// the origin it gave) down, to a decode time of -1, failing the save.
func TestStreamFragmentHalfTick(t *testing.T) {
	data := encodedFragment(t, 0, 1)
	media := map[uint32]streamMedia{1: {scale: 1000}}
	spans, err := streamFragment(data, map[uint32]uint32{1: 1}, media, nil, 0.0005)
	if err != nil {
		t.Fatal(err)
	}
	origin := float64(spans[1].decode) / 1000
	media = map[uint32]streamMedia{1: {scale: 1000}}
	var seq uint32
	written, err := streamFragment(encodedFragment(t, 0, 1), map[uint32]uint32{1: 1}, media, &seq, 0.0005-origin)
	if err != nil {
		t.Fatalf("written: %v", err)
	}
	if written[1].decode != 0 {
		t.Errorf("written at %d, want 0", written[1].decode)
	}
}
