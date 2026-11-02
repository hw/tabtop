package main

import (
	"io/fs"
	"os"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// uploadManager owns active and resumable upload transitions independently
// of authentication and session state. Filesystem work runs outside mu.
type uploadManager struct {
	clock    lifecycleClock
	mu       sync.Mutex
	partials map[string]*partialUpload
	active   map[string]*activeUpload
}

const (
	// How long an upload cut off is kept to resume.
	partialKeep = time.Hour
	// Uploads cut off kept at once; past that, the oldest goes.
	maxPartials = 16
)

// partialUpload is an upload cut off, kept to resume: its temporary file,
// in its folder dir, holding held bytes of a file size bytes long.
type partialUpload struct {
	rootDir     string
	identity    fs.FileInfo
	device      uint64
	deviceKnown bool
	dir, tmp    string
	size, held  int64
	kept        time.Time
	timer       lifecycleTimer
}

// keepPartial keeps u, an upload of a file size bytes long cut off by the
// connection, for partialKeep, so the page can resume it by its id with
// claimPartial; after that, or once maxPartials newer ones are kept, it's
// deleted, or sooner if an upload needs the room (see reclaimPartials). A
// restart deletes it too (see removeStaleUploads).
func (m *uploadManager) keepPartial(u *upload, size int64) {
	held := int64(0)
	identity, statErr := u.f.Stat()
	if statErr == nil {
		held = identity.Size()
	}
	u.f.Close()
	p := &partialUpload{rootDir: u.root.Name(), identity: identity, dir: u.dir, tmp: u.tmp, size: size, held: held, kept: m.clock.Now()}
	if st, ok := identitySys(identity); ok {
		p.device, p.deviceKnown = uint64(st.Dev), true
	}
	id := u.id()
	m.mu.Lock()
	var dropped *partialUpload
	if m.partials == nil {
		m.partials = map[string]*partialUpload{}
	}
	if len(m.partials) >= maxPartials {
		dropped = m.dropPartialLocked(m.oldestPartialLocked(nil))
	}
	m.partials[id] = p
	p.timer = m.clock.AfterFunc(partialKeep, func() {
		m.mu.Lock()
		var expired *partialUpload
		if m.partials[id] == p {
			expired = m.dropPartialLocked(id)
		}
		m.mu.Unlock()
		m.removePartial(expired)
	})
	m.mu.Unlock()
	m.removePartial(dropped)
}

// oldestPartialLocked is the oldest eligible upload, or "" if none is.
// A nil predicate accepts every upload. m.mu must be held.
func (m *uploadManager) oldestPartialLocked(eligible func(*partialUpload) bool) string {
	oldest := ""
	for k, q := range m.partials {
		if eligible != nil && !eligible(q) {
			continue
		}
		if oldest == "" || q.kept.Before(m.partials[oldest].kept) {
			oldest = k
		}
	}
	return oldest
}

// reclaimPartials deletes uploads kept to resume, the oldest first, until
// need bytes are free on the destination's filesystem, or none on that
// filesystem are left, and returns the bytes free then. A page reloaded or closed
// part way through an upload can't resume it, so the room those take is
// only borrowed.
func (m *uploadManager) reclaimPartials(destination *os.File, need int64) (int64, bool) {
	for {
		free, _, device, ok := fileDiskSpace(destination)
		if !ok || free >= need {
			return free, ok
		}
		m.mu.Lock()
		p := m.dropPartialLocked(m.oldestPartialLocked(func(p *partialUpload) bool { return p.deviceKnown && p.device == device }))
		m.mu.Unlock()
		if p == nil {
			return free, ok
		}
		m.removePartial(p)
	}
}

// uploadRoom counts resumable uploads on this destination's filesystem as
// free, since an upload needing that space reclaims them (see reclaimPartials).
func (m *uploadManager) uploadRoom(destination *os.File) (free, total int64, ok bool) {
	var device uint64
	free, total, device, ok = fileDiskSpace(destination)
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, p := range m.partials {
		if p.deviceKnown && p.device == device {
			free += min(p.held, max(0, total-free))
		}
	}
	return min(free, total), total, ok
}

// dropPartialLocked detaches an upload for removal outside m.mu.
func (m *uploadManager) dropPartialLocked(id string) *partialUpload {
	p := m.partials[id]
	if p == nil {
		return nil
	}
	delete(m.partials, id)
	p.timer.Stop()
	return p
}

func (m *uploadManager) removePartial(p *partialUpload) {
	if p == nil {
		return
	}
	if root, err := openDownloadStore(p.rootDir); err == nil {
		root.removeTemporary(p.tmp)
		root.Close()
	}
}

// activeUpload is an upload going on, through t, which can be resumed
// before the server notices its connection is lost: resumed is then set,
// and its connection closed, and over is closed once it's kept.
type activeUpload struct {
	interrupt func()
	resumed   atomic.Bool
	over      chan struct{}
}

// claimPartial takes the upload kept as id (see keepPartial) to carry on
// with, if it's into dir and of a file size bytes long, and returns it
// and how much of the file it has; else nil, and the page starts again.
// If that upload still seems to be going on, as when the page has lost its
// connection before the server noticed, it's stopped and kept first.
func (m *uploadManager) claimPartial(store *downloadStore, id, dir string, size int64) (*upload, int64) {
	m.mu.Lock()
	if a := m.active[id]; a != nil {
		m.mu.Unlock()
		a.resumed.Store(true)
		if a.interrupt != nil {
			a.interrupt()
		}
		select {
		case <-a.over:
		case <-time.After(5 * time.Second):
			return nil, 0
		}
		m.mu.Lock()
	}
	p := m.partials[id]
	if p == nil || p.dir != dir || p.size != size {
		m.mu.Unlock()
		return nil, 0
	}
	delete(m.partials, id)
	p.timer.Stop()
	m.mu.Unlock()
	return store.resume(p, size)
}

func (m *uploadManager) track(id string, interrupt func()) *activeUpload {
	a := &activeUpload{interrupt: interrupt, over: make(chan struct{})}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.active == nil {
		m.active = map[string]*activeUpload{}
	}
	m.active[id] = a
	return a
}
func (m *uploadManager) untrack(id string, a *activeUpload) {
	m.mu.Lock()
	if m.active[id] == a {
		delete(m.active, id)
	}
	m.mu.Unlock()
	close(a.over)
}

// identitySys supplies the filesystem device captured with the partial file.
func identitySys(info fs.FileInfo) (*syscall.Stat_t, bool) {
	if info == nil {
		return nil, false
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	return st, ok
}
