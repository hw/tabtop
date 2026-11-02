package main

import (
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
	active = m.track("resume", func() {
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
	g := &server{serverConfig: serverConfig{downloadsDir: t.TempDir()}}
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
	go func() { g.transfers.keepPartial(u, 10); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		g.mu.Unlock()
		t.Fatal("upload state blocked on the session mutex")
	}
	g.mu.Unlock()
	g.transfers.mu.Lock()
	p := g.transfers.dropPartialLocked(u.id())
	g.transfers.mu.Unlock()
	g.transfers.removePartial(p)
}

func TestUploadManagerOldCompletionKeepsNewOwner(t *testing.T) {
	var m uploadManager
	old := m.track("id", nil)
	next := m.track("id", nil)
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
