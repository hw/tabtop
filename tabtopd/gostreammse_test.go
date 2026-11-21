package main

import (
	"encoding/binary"
	"fmt"
	"path"
	"testing"
)

func TestParseMSEPayloadProgressive(t *testing.T) {
	data := []byte("ftyp....moov....mdat....fake")
	buf := encodeMSETest(1, func(w *mseWriter) {
		w.u8(1)
		w.bytes(data)
	})
	in, err := parseMSEPayload(buf)
	if err != nil {
		t.Fatal(err)
	}
	if string(in.progressive) != string(data) || len(in.tracks) != 0 {
		t.Fatalf("progressive: %+v", in)
	}
}

func TestParseMSEPayloadFragmented(t *testing.T) {
	init := []byte("init-seg")
	part1, part2 := []byte("moof1"), []byte("moof2")
	buf := encodeMSETest(1, func(w *mseWriter) {
		w.u8(0)
		w.bytes(init)
		w.u32(2)
		w.bytes(part1)
		w.bytes(part2)
	})
	in, err := parseMSEPayload(buf)
	if err != nil {
		t.Fatal(err)
	}
	if len(in.tracks) != 1 || len(in.progressive) != 0 {
		t.Fatalf("tracks: %+v", in)
	}
	tr := in.tracks[0]
	if string(tr.initData) != string(init) || len(tr.partData) != 2 ||
		string(tr.partData[0]) != string(part1) || string(tr.partData[1]) != string(part2) {
		t.Fatalf("track: %+v", tr)
	}
}

func TestParseMSEPayloadRejectsJunk(t *testing.T) {
	if _, err := parseMSEPayload([]byte{0, 0, 0, 0}); err == nil {
		t.Fatal("accepted empty tracks")
	}
	if _, err := parseMSEPayload([]byte{0, 0, 0, 2, 1, 0, 0, 0, 1, 'x'}); err == nil {
		t.Fatal("accepted progressive with a second track")
	}
}

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
	in, err := stage.input(store)
	if err != nil {
		t.Fatal(err)
	}
	if len(in.tracks) != 1 || string(in.tracks[0].initData) != string(init) ||
		len(in.tracks[0].partData) != 1 || string(in.tracks[0].partData[0]) != string(part) {
		t.Fatalf("input: %+v", in)
	}
	if _, err := store.root.Stat(path.Join(stage.dir, "t0-init")); err != nil {
		t.Fatal(err)
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

type mseWriter struct{ b []byte }

func encodeMSETest(n uint32, write func(*mseWriter)) []byte {
	w := &mseWriter{b: make([]byte, 4)}
	binary.BigEndian.PutUint32(w.b, n)
	write(w)
	return w.b
}

func (w *mseWriter) u8(v byte) { w.b = append(w.b, v) }
func (w *mseWriter) u32(v uint32) {
	var b [4]byte
	binary.BigEndian.PutUint32(b[:], v)
	w.b = append(w.b, b[:]...)
}
func (w *mseWriter) bytes(p []byte) {
	w.u32(uint32(len(p)))
	w.b = append(w.b, p...)
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
