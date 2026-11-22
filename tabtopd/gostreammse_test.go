package main

import (
	"fmt"
	"path"
	"testing"
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
