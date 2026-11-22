package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"math"
	"path"
	"testing"

	"github.com/Eyevinn/mp4ff/mp4"
)

func TestMSEStageAppendAndInput(t *testing.T) {
	g, _, _ := newFetchServer(t)
	m := g.defaultRoot().fetches
	stage, err := m.openMSEStage("tab-1", ".")
	if err != nil {
		t.Fatal(err)
	}
	defer m.forgetMSEStage(stage.id)

	store, err := m.files.openStore()
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	init := []byte("init-bytes")
	part := []byte("moof-mdat-part")
	if err := stage.appendFrame(store, 0, mseKindInit, init); err != nil {
		t.Fatal(err)
	}
	if err := stage.appendFrame(store, 0, mseKindPart, part); err != nil {
		t.Fatal(err)
	}
	in, release, err := m.takeMSEStage(stage)
	if err != nil {
		t.Fatal(err)
	}
	if len(in.tracks) != 1 || in.tracks[0].init != path.Join(stage.dir, "t0-init") || len(in.tracks[0].parts) != 1 {
		t.Fatalf("input: %+v", in)
	}
	if data, err := store.root.ReadFile(in.tracks[0].parts[0]); err != nil || string(data) != string(part) {
		t.Fatalf("part: %q, %v", data, err)
	}
	if m.mseStage(stage.id) != nil {
		t.Error("a stage taken for saving still listed")
	}
	// Given back by the save, once it's done with the files.
	release()
	if _, err := store.root.Stat(stage.dir); err == nil {
		t.Error("staging folder left behind once released")
	}
}

func TestMSEStageRejectsOverSize(t *testing.T) {
	g, _, _ := newFetchServer(t)
	m := g.defaultRoot().fetches
	stage, err := m.openMSEStage("tab-1", ".")
	if err != nil {
		t.Fatal(err)
	}
	defer m.forgetMSEStage(stage.id)
	store, err := m.files.openStore()
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	stage.mu.Lock()
	stage.bytes = mseStageLimit - 10
	stage.mu.Unlock()
	if err := stage.appendFrame(store, 0, mseKindProgress, make([]byte, 20)); err == nil {
		t.Fatal("accepted oversized stage")
	}
}

func TestMSEStageAbortForTab(t *testing.T) {
	g, _, _ := newFetchServer(t)
	m := g.defaultRoot().fetches
	stage, err := m.openMSEStage("tab-x", ".")
	if err != nil {
		t.Fatal(err)
	}
	m.abortMSEStagesForTab("tab-x")
	if m.mseStage(stage.id) != nil {
		t.Fatal("stage still listed")
	}
	store, err := m.files.openStore()
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err := store.root.Stat(stage.dir); err == nil {
		t.Fatal("staging dir left behind")
	}
}

// TestMSEStageLimits: buffered streams can't fill the disk. A tab may keep
// mseStagesPerTab stages, and everyone mseStagesMax; all stages' bytes
// together are held to mseStagedMax (given back as a stage is forgotten);
// a piece that would leave less than fetchSpare free isn't written; and a
// stage is a write into its folder, which can't be deleted meanwhile.
func TestMSEStageLimits(t *testing.T) {
	g, _, _ := newFetchServer(t)
	m := g.defaultRoot().fetches
	store, err := m.files.openStore()
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	var stages []*mseStage
	for range mseStagesPerTab {
		s, err := m.openMSEStage("tab-a", ".")
		if err != nil {
			t.Fatal(err)
		}
		stages = append(stages, s)
	}
	if _, err := m.openMSEStage("tab-a", "."); err == nil {
		t.Error("a tab kept more stages than it may")
	}
	for i := 0; len(stages) < mseStagesMax; i++ {
		s, err := m.openMSEStage(fmt.Sprintf("tab-%d", i), ".")
		if err != nil {
			t.Fatal(err)
		}
		stages = append(stages, s)
	}
	if _, err := m.openMSEStage("tab-new", "."); err == nil {
		t.Error("more stages kept than everyone may")
	}

	// The folder's being written: not deleted meanwhile.
	if end, busy := g.defaultRoot().writes.startDeleting("."); !busy {
		end()
		t.Error("the staging folder could be deleted while a stream's staged in it")
	}

	// All stages' bytes together.
	m.mu.Lock()
	m.mseBytes = mseStagedMax - 10
	m.mu.Unlock()
	if err := stages[0].appendFrame(store, 0, mseKindInit, make([]byte, 20)); err == nil {
		t.Error("staged past what all stages may hold")
	}
	m.mu.Lock()
	m.mseBytes = 0
	m.mu.Unlock()
	if err := stages[0].appendFrame(store, 0, mseKindInit, make([]byte, 20)); err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	held := m.mseBytes
	m.mu.Unlock()
	if held != 20 {
		t.Errorf("held %d bytes, want 20", held)
	}

	// The disk's room, less what's kept spare.
	if free, _, ok := diskSpace(g.downloadsDir); ok {
		old := fetchSpare
		fetchSpare = free + 1<<30 // (no room at all)
		err := stages[1].appendFrame(store, 0, mseKindInit, make([]byte, 20))
		fetchSpare = old
		if err == nil {
			t.Error("staged with no room left on the disk")
		}
		m.mu.Lock()
		held = m.mseBytes
		m.mu.Unlock()
		if held != 20 {
			t.Errorf("a piece refused still held: %d bytes", held)
		}
	}

	for _, s := range stages {
		m.forgetMSEStage(s.id)
	}
	m.mu.Lock()
	held = m.mseBytes
	m.mu.Unlock()
	if held != 0 {
		t.Errorf("%d bytes still held, every stage forgotten", held)
	}
	if end, busy := g.defaultRoot().writes.startDeleting("."); busy {
		t.Error("the folder still busy, every stage forgotten")
	} else {
		end()
	}
	if _, err := m.openMSEStage("tab-a", "."); err != nil {
		t.Errorf("a stage refused, every other forgotten: %v", err)
	}
}

// Independent SourceBuffers can have different time origins and can change
// timestampOffset between appends. The saved file uses their common clock.
func TestMSESavedTimeline(t *testing.T) {
	g, _, _ := newFetchServer(t)
	m := g.defaultRoot().fetches
	stage, err := m.openMSEStage("timeline", ".")
	if err != nil {
		t.Fatal(err)
	}
	defer m.forgetMSEStage(stage.id)
	store, err := m.files.openStore()
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	for i, kind := range []string{"audio", "video"} {
		scale := []uint32{48000, 90000}[i]
		header := mp4.CreateEmptyInit()
		header.AddEmptyTrack(scale, kind, "und")
		var buf bytes.Buffer
		if err := header.Encode(&buf); err != nil {
			t.Fatal(err)
		}
		if err := stage.appendFrame(store, i, mseKindInit, buf.Bytes()); err != nil {
			t.Fatal(err)
		}
		for _, j := range []int{1, 0} { // A backward seek appended the earlier segment last.
			frag, err := mp4.CreateFragment(1, 1)
			if err != nil {
				t.Fatal(err)
			}
			clock := 100000 + i*100 + j*10
			ptsOffset := int32(0)
			if i == 1 {
				ptsOffset = int32(scale) * 8 / 100
			}
			flags := uint32(mp4.SyncSampleFlags)
			if j == 1 {
				flags = mp4.NonSyncSampleFlags
			}
			frag.AddFullSample(mp4.FullSample{Sample: mp4.NewSample(flags, scale, 1, ptsOffset), DecodeTime: uint64(clock) * uint64(scale), Data: []byte{1}})
			buf.Reset()
			// Keep a large common origin after the per-track clock adjustments.
			binary.Write(&buf, binary.BigEndian, float64(95000+j-clock))
			if err := frag.Encode(&buf); err != nil {
				t.Fatal(err)
			}
			if err := stage.appendFrame(store, i, mseKindTimedPart, buf.Bytes()); err != nil {
				t.Fatal(err)
			}
		}
	}
	in, release, err := m.takeMSEStage(stage)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if err := m.runMSE(context.Background(), &fetchJob{real: "."}, in); err != nil {
		t.Fatal(err)
	}
	data, err := store.root.ReadFile("stream.mp4")
	if err != nil {
		t.Fatal(err)
	}
	out, err := mp4.DecodeFile(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Sidxs) != 2 {
		t.Fatalf("indexes: %d", len(out.Sidxs))
	}
	for i, idx := range out.Sidxs {
		wantStart := uint64(0)
		if i == 1 {
			wantStart = 7200
		}
		if idx.EarliestPresentationTime != wantStart || len(idx.SidxRefs) != 2 {
			t.Fatalf("index: %+v", idx)
		}
		pos := idx.AnchorPoint
		for j, ref := range idx.SidxRefs {
			if ref.SubSegmentDuration != idx.Timescale || (ref.StartsWithSAP == 1) != (j == 0) {
				t.Fatalf("index reference: %+v", ref)
			}
			if pos+8 > uint64(len(data)) {
				t.Fatalf("index outside media: %d", pos)
			}
			box, err := mp4.DecodeBox(pos, bytes.NewReader(data[pos:]))
			if err != nil {
				t.Fatal(err)
			}
			moof, ok := box.(*mp4.MoofBox)
			if !ok || moof.Traf.Tfhd.TrackID != idx.ReferenceID || moof.Traf.Tfdt.BaseMediaDecodeTime() != uint64(j)*uint64(idx.Timescale) {
				t.Fatalf("index points to wrong fragment: %v", box)
			}
			pos += uint64(ref.ReferencedSize)
		}
	}
	if d := float64(out.Moov.Mvhd.Duration) / float64(out.Moov.Mvhd.Timescale); math.Abs(d-2.08) > 0.001 {
		t.Fatalf("movie duration %f", d)
	}
}

// The append window is on the viewer clock. A dependent video sample after
// a discarded picture stays out until a keyframe, even in the next append.
func TestMSEAppendWindow(t *testing.T) {
	g, _, _ := newFetchServer(t)
	m := g.defaultRoot().fetches
	stage, err := m.openMSEStage("window", ".")
	if err != nil {
		t.Fatal(err)
	}
	defer m.forgetMSEStage(stage.id)
	store, err := m.files.openStore()
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	init := mp4.CreateEmptyInit()
	init.AddEmptyTrack(1000, "video", "und")
	var buf bytes.Buffer
	if err := init.Encode(&buf); err != nil {
		t.Fatal(err)
	}
	if err := stage.appendFrame(store, 0, mseKindInit, buf.Bytes()); err != nil {
		t.Fatal(err)
	}
	// The window includes times 2..4. Drop frame 0, the dependent frame 1,
	// and frame 4 which straddles the window end. Frame 5 in the next part
	// also depends on the dropped frame. Frame 6 can restart decoding.
	for j, flags := range [][]uint32{
		{mp4.SyncSampleFlags, mp4.NonSyncSampleFlags, mp4.SyncSampleFlags, mp4.NonSyncSampleFlags, mp4.SyncSampleFlags},
		{mp4.NonSyncSampleFlags, mp4.SyncSampleFlags},
	} {
		buf.Reset()
		frag, err := mp4.CreateFragment(1, 1)
		if err != nil {
			t.Fatal(err)
		}
		for i, flag := range flags {
			n := 5*j + i
			frag.AddFullSample(mp4.FullSample{Sample: mp4.NewSample(flag, 1000, 1, 0), DecodeTime: uint64(n) * 1000, Data: []byte{byte(n)}})
		}
		kind := byte(mseKindTimedPart)
		binary.Write(&buf, binary.BigEndian, float64(1))
		if j == 0 {
			kind = mseKindWindowPart
			binary.Write(&buf, binary.BigEndian, float64(2))
			binary.Write(&buf, binary.BigEndian, float64(5.5))
		}
		if err := frag.Encode(&buf); err != nil {
			t.Fatal(err)
		}
		if err := stage.appendFrame(store, 0, kind, buf.Bytes()); err != nil {
			t.Fatal(err)
		}
	}
	in, release, err := m.takeMSEStage(stage)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if err := m.runMSE(context.Background(), &fetchJob{real: "."}, in); err != nil {
		t.Fatal(err)
	}
	b, err := store.root.ReadFile("stream.mp4")
	if err != nil {
		t.Fatal(err)
	}
	f, err := mp4.DecodeFile(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	var frames []byte
	for _, seg := range f.Segments {
		for _, frag := range seg.Fragments {
			frames = append(frames, frag.Mdat.Data...)
		}
	}
	if !bytes.Equal(frames, []byte{2, 3, 6}) {
		t.Fatalf("saved frame numbers %v", frames)
	}
}

// TestMSESavedAgain: a segment appended again (the player seeking back past
// what it had let go, or retrying one) is saved once, not refused.
func TestMSESavedAgain(t *testing.T) {
	g, _, _ := newFetchServer(t)
	m := g.defaultRoot().fetches
	stage, err := m.openMSEStage("again", ".")
	if err != nil {
		t.Fatal(err)
	}
	defer m.forgetMSEStage(stage.id)
	store, err := m.files.openStore()
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	const scale = 90000
	header := mp4.CreateEmptyInit()
	header.AddEmptyTrack(scale, "video", "und")
	var buf bytes.Buffer
	if err := header.Encode(&buf); err != nil {
		t.Fatal(err)
	}
	if err := stage.appendFrame(store, 0, mseKindInit, buf.Bytes()); err != nil {
		t.Fatal(err)
	}
	for _, j := range []int{0, 1, 2, 1} {
		frag, err := mp4.CreateFragment(uint32(j+1), 1)
		if err != nil {
			t.Fatal(err)
		}
		frag.AddFullSample(mp4.FullSample{Sample: mp4.NewSample(mp4.SyncSampleFlags, scale, 1, 0), DecodeTime: uint64(j) * scale, Data: []byte{byte(j)}})
		buf.Reset()
		binary.Write(&buf, binary.BigEndian, float64(0))
		if err := frag.Encode(&buf); err != nil {
			t.Fatal(err)
		}
		if err := stage.appendFrame(store, 0, mseKindTimedPart, buf.Bytes()); err != nil {
			t.Fatal(err)
		}
	}
	in, release, err := m.takeMSEStage(stage)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if err := m.runMSE(context.Background(), &fetchJob{real: "."}, in); err != nil {
		t.Fatal(err)
	}
	data, err := store.root.ReadFile("stream.mp4")
	if err != nil {
		t.Fatal(err)
	}
	out, err := mp4.DecodeFile(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Sidxs) != 1 || len(out.Sidxs[0].SidxRefs) != 3 {
		t.Fatalf("indexes: %d, %+v", len(out.Sidxs), out.Sidxs)
	}
}
