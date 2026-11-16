package main

import (
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestUploadManagerResumeInterruptsWithoutTransport(t *testing.T) {
	var m uploadManager
	store, err := openDownloadStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	var interrupted atomic.Bool
	var active *activeUpload
	active = m.track("resume", "", func() {
		interrupted.Store(true)
		m.untrack("resume", active) // interruption must run outside the mutex
	})
	done := make(chan struct{})
	go func() { m.claimPartial(store, "resume", ".", 10); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("resume interruption deadlocked")
	}
	if !interrupted.Load() || !active.resumed.Load() {
		t.Fatal("resume did not interrupt its previous owner")
	}
}

func TestUploadManagerDoesNotTakeSessionLock(t *testing.T) {
	g := withDefaultRoot(t, &server{serverConfig: serverConfig{downloadsDir: t.TempDir()}})
	store, err := openDownloadStore(g.downloadsDir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	u, err := store.startUpload(".")
	if err != nil {
		t.Fatal(err)
	}
	g.mu.Lock()
	done := make(chan struct{})
	go func() { g.defaultRoot().transfers.keepPartial(u, 10); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		g.mu.Unlock()
		t.Fatal("upload state blocked on the session mutex")
	}
	g.mu.Unlock()
	g.defaultRoot().transfers.mu.Lock()
	p := g.defaultRoot().transfers.dropPartialLocked(u.id())
	g.defaultRoot().transfers.mu.Unlock()
	removePartial(p)
}

func TestUploadManagerOldCompletionKeepsNewOwner(t *testing.T) {
	var m uploadManager
	old := m.track("id", "", nil)
	next := m.track("id", "", nil)
	m.untrack("id", old)
	if m.active["id"] != next {
		t.Fatal("old completion removed the new owner")
	}
	select {
	case <-old.over:
	default:
		t.Fatal("old completion was not signalled")
	}
	m.untrack("id", next)
	if len(m.active) != 0 {
		t.Fatal("active upload leaked")
	}
}

func TestUploadManagerRestrictsReclamationToDestination(t *testing.T) {
	store, err := openDownloadStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	destination, err := openRootDirectory(store.root, ".")
	if err != nil {
		t.Fatal(err)
	}
	defer destination.Close()
	var m uploadManager
	keep := func() *upload {
		u, err := store.startUpload(".")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := u.Write(make([]byte, 1<<20)); err != nil {
			t.Fatal(err)
		}
		if err := u.f.Sync(); err != nil {
			t.Fatal(err)
		}
		m.keepPartial(u, 2<<20)
		return u
	}
	foreign, local := keep(), keep()
	_, total, dev, ok := fileDiskSpace(destination)
	if !ok {
		t.Fatal("cannot read destination space")
	}
	if p := m.partials[local.id()]; !p.deviceKnown || p.device != dev {
		t.Fatal("kept upload did not record its filesystem")
	}
	// Model a retained upload on another device, older than the local one.
	// Its reported size makes any cross-device accounting immediately visible.
	m.partials[foreign.id()].device = dev ^ 1
	m.partials[foreign.id()].held = total
	room, _, ok := m.uploadRoom(destination)
	if !ok || room >= total {
		t.Fatalf("foreign partial counted as destination space: room=%d total=%d", room, total)
	}
	if _, ok := m.reclaimPartials(destination, 1<<62); !ok {
		t.Fatal("space query failed")
	}
	if len(m.partials) != 1 || m.partials[foreign.id()] == nil {
		t.Fatal("reclamation removed a partial from another filesystem")
	}
	if _, err := store.root.Stat(local.tmp); !os.IsNotExist(err) {
		t.Fatalf("local partial still exists: %v", err)
	}
	if _, err := store.root.Stat(foreign.tmp); err != nil {
		t.Fatalf("foreign partial was deleted: %v", err)
	}
	removePartial(m.dropPartialLocked(foreign.id()))
}

func TestFileDiskSpaceUsesOpenedFilesystem(t *testing.T) {
	f, err := os.Open("/dev/shm")
	if err != nil {
		t.Skip(err)
	}
	defer f.Close()
	_, total, device, ok := fileDiskSpace(f)
	if !ok {
		t.Fatal("space query failed")
	}
	info, err := f.Stat()
	if err != nil {
		t.Fatal(err)
	}
	st, ok := identitySys(info)
	if !ok || device != uint64(st.Dev) {
		t.Fatal("queried another filesystem device")
	}
	_, wantTotal, ok := diskSpace("/dev/shm")
	if !ok || total != wantTotal {
		t.Fatalf("total=%d, want %d", total, wantTotal)
	}
}

type stoppedTimer struct{}

func (stoppedTimer) Stop() bool { return true }

// A kept upload held, as its folder's moved or deleted, isn't dropped by
// its time running out, nor to make room; once let go, it's dropped then.
func TestUploadManagerHeldPartialsStay(t *testing.T) {
	store, err := openDownloadStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	var expire func()
	m := uploadManager{clock: lifecycleClock{afterFunc: func(_ time.Duration, f func()) lifecycleTimer { expire = f; return stoppedTimer{} }}}
	store.root.Mkdir("f", 0o755)
	u, err := store.startUpload("f")
	if err != nil {
		t.Fatal(err)
	}
	u.Write([]byte("part"))
	m.keepPartial(u, 10)
	held, busy := m.holdUnder("f", nil)
	if busy || len(held) != 1 {
		t.Fatalf("held %v, busy %v", held, busy)
	}
	expire()
	destination, _ := openRootDirectory(store.root, ".")
	defer destination.Close()
	m.reclaimPartials(destination, 1<<62)
	if len(m.partials) != 1 {
		t.Fatal("a held upload was dropped")
	}
	if _, err := store.root.Stat(u.tmp); err != nil {
		t.Fatalf("its file: %v", err)
	}
	m.release(held, false, nil)
	if len(m.partials) != 0 {
		t.Fatal("expired while held, it stayed once let go")
	}
	if _, err := store.root.Stat(u.tmp); !os.IsNotExist(err) {
		t.Fatalf("its file stayed: %v", err)
	}
}

// Held twice (two deletes over nested folders at once), it's not let go
// for both by the first release: the second, whose folder went, drops it.
func TestUploadManagerHeldTwice(t *testing.T) {
	dir := t.TempDir()
	store, err := openDownloadStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	var m uploadManager
	os.MkdirAll(filepath.Join(dir, "a", "b"), 0o755)
	u, err := store.startUpload("a/b")
	if err != nil {
		t.Fatal(err)
	}
	u.Write([]byte("part"))
	m.keepPartial(u, 10)
	outer, _ := m.holdUnder("a", nil)
	inner, _ := m.holdUnder("a/b", nil)
	m.release(outer, false, nil)
	if p := m.partials[u.id()]; p == nil || p.holding != 1 {
		t.Fatal("let go for both by one")
	}
	if up, _ := m.claimPartial(store, u.id(), "a/b", 10); up != nil {
		t.Fatal("claimed while still held")
	}
	m.release(inner, true, nil)
	if len(m.partials) != 0 {
		t.Fatal("not dropped by the one whose folder went")
	}
}
