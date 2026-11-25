package main

import (
	"io/fs"
	"log"
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
	// Uploads saved lately, by id, so a page that lost the answer, and asks
	// to carry on, is told it's saved rather than starting it again (see
	// recordDone).
	done recent[uploadDone]
}

// uploadDone is an upload saved: into dir, size bytes, and what the page
// was answered.
type uploadDone struct {
	dir   string
	size  int64
	reply map[string]any
}

const (
	// How long an upload cut off is kept to resume.
	partialKeep = time.Hour
	// Uploads cut off kept at once; past that, the oldest goes.
	maxPartials = 16
	// How long, and how many, uploads saved are remembered.
	uploadDoneKeep = 10 * time.Minute
	maxUploadDone  = 256
)

// recordDone remembers that the upload id, into dir, size bytes, was saved,
// and answered reply.
func (m *uploadManager) recordDone(id, dir string, size int64, reply map[string]any) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.done.add(id, uploadDone{dir, size, reply}, m.clock.Now(), uploadDoneKeep, maxUploadDone)
}

// wasDone reports whether the upload id was saved lately, into whatever
// folder, of whatever size: then there's nothing of it kept to carry on
// with (or wait for).
func (m *uploadManager) wasDone(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.done.get(id, m.clock.Now(), uploadDoneKeep)
	return ok
}

// doneUpload is what the upload id, into dir, size bytes, was answered when
// it was saved, if it was, lately; else nil.
func (m *uploadManager) doneUpload(id, dir string, size int64) map[string]any {
	m.mu.Lock()
	defer m.mu.Unlock()
	d, ok := m.done.get(id, m.clock.Now(), uploadDoneKeep)
	if !ok || d.dir != dir || d.size != size {
		return nil
	}
	return d.reply
}

// partialUpload is an upload cut off, kept to resume: its temporary file,
// in its folder dir, holding held bytes of a file size bytes long.
type partialUpload struct {
	root        *os.Root
	identity    fs.FileInfo
	device      uint64
	deviceKnown bool
	dir, tmp    string
	size, held  int64
	kept        time.Time
	timer       lifecycleTimer
	holding     int // how many hold it, while its folder may be deleted or moved (see holdUnder)
	// expired is set when its time ran out while it was held: it's
	// dropped once let go, where its file is by then.
	expired bool
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
	pin, err := u.root.OpenRoot(".")
	if err != nil {
		// Kept unpinned: when it's dropped, its temporary file is left
		// for cleanup or the next start to remove.
		log.Printf("can't keep an upload to resume: %v", err)
	}
	p := &partialUpload{root: pin, identity: identity, dir: u.dir, tmp: u.tmp, size: size, held: held, kept: m.clock.Now()}
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
		// Not one held: its file may be on its way elsewhere (see
		// release). If all are, there's one more than kept, for a while.
		dropped = m.dropPartialLocked(m.oldestPartialLocked(func(p *partialUpload) bool { return p.holding == 0 }))
	}
	m.partials[id] = p
	p.timer = m.clock.AfterFunc(partialKeep, func() {
		m.mu.Lock()
		var expired *partialUpload
		switch {
		case m.partials[id] != p:
		case p.holding > 0:
			p.expired = true // dropped once let go
		default:
			expired = m.dropPartialLocked(id)
		}
		m.mu.Unlock()
		removePartial(expired)
	})
	m.mu.Unlock()
	removePartial(dropped)
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
		p := m.dropPartialLocked(m.oldestPartialLocked(func(p *partialUpload) bool { return p.deviceKnown && p.device == device && p.holding == 0 }))
		m.mu.Unlock()
		if p == nil {
			return free, ok
		}
		removePartial(p)
	}
}

// uploadRoom counts resumable uploads on this destination's filesystem as
// free, since an upload needing that space reclaims them (see reclaimPartials).
func (m *uploadManager) uploadRoom(destination *os.File) (free, total int64, ok bool) {
	var device uint64
	free, total, device, ok = fileDiskSpace(destination)
	return min(m.withHeld(device, free, total), total), total, ok
}

// withHeld is free, of total on the filesystem device, counting as free
// what m's resumable uploads there hold.
func (m *uploadManager) withHeld(device uint64, free, total int64) int64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, p := range m.partials {
		if p.deviceKnown && p.device == device {
			free += min(p.held, max(0, total-free))
		}
	}
	return free
}

// reclaimPartials is uploadManager.reclaimPartials over every root's
// uploads kept to resume, this root's first: roots are often folders of
// one filesystem, where room one's kept upload takes is room another's
// new upload needs.
func (g *fileService) reclaimPartials(destination *os.File, need int64) (free int64, ok bool) {
	free, ok = g.root.transfers.reclaimPartials(destination, need)
	for _, root := range g.roots {
		if !ok || free >= need {
			break
		}
		if root != g.root {
			free, ok = root.transfers.reclaimPartials(destination, need)
		}
	}
	return free, ok
}

// room reports whether need bytes fit on f's filesystem, and how much is
// free there. With reclaim, resumable uploads are cleared first, the
// oldest first and only as many as need takes (reclaimPartials): what a
// save the person asked for takes before a page that may never come back
// to resume. Without, only what's free now counts: the room resumable
// uploads hold isn't free unless they're cleared. A filesystem whose space
// can't be read is room enough (the write itself then says).
func (g *fileService) room(f *os.File, need int64, reclaim bool) (free int64, enough bool) {
	var ok bool
	if reclaim {
		free, ok = g.reclaimPartials(f, need)
	} else {
		free, _, _, ok = fileDiskSpace(f)
	}
	return free, !ok || need <= free
}

// uploadRoom is uploadManager.uploadRoom, counting every root's resumable
// uploads on the destination's filesystem (see reclaimPartials).
func (g *fileService) uploadRoom(destination *os.File) (free, total int64, ok bool) {
	var device uint64
	free, total, device, ok = fileDiskSpace(destination)
	free = g.root.transfers.withHeld(device, free, total)
	for _, root := range g.roots {
		if root != g.root {
			free = root.transfers.withHeld(device, free, total)
		}
	}
	return min(free, total), total, ok
}

// hold holds p while its folder may be deleted or moved (see holdUnder):
// counted, as two can hold it at once (a delete and a move of folders one
// in the other). Nothing carries it on while it's held.
func (p *partialUpload) hold() { p.holding++ }

// let lets go of one hold of p, and says whether it's now to be given up:
// with drop (its folder gone), or, its time up while it was held, once
// the last lets it go.
func (p *partialUpload) let(drop bool) bool {
	p.holding--
	return drop || p.expired && p.holding == 0
}

// inFolderOf is whether a folder, as recorded, is folder or in it, as
// resolve has them (links followed: see fileService.resolved), if it's
// given; dirs, those to be asked about, resolved now: before the lock
// they're kept under is taken again, as resolving can take a while on a
// slow disk.
func inFolderOf(folder string, dirs []string, resolve func(string) string) func(dir string) bool {
	real := map[string]string{} // by the folder as recorded
	if resolve != nil {
		for _, d := range dirs {
			if _, ok := real[d]; !ok {
				real[d] = resolve(d)
			}
		}
	}
	return func(dir string) bool {
		if r, ok := real[dir]; ok {
			dir = r
		}
		return inFolder(dir, folder)
	}
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

// removePartial deletes p's temporary file. It needs no manager: p has
// left the one it was in.
func removePartial(p *partialUpload) {
	if p == nil {
		return
	}
	if p.root != nil {
		defer p.root.Close()
		(&downloadStore{root: p.root}).removeTemporary(p.tmp)
		return
	}
	// Unpinned (see keepPartial): reopening its folder by path could reach
	// a replacement, so its file is left to cleanup.
}

// activeUpload is an upload going on, through t, which can be resumed
// before the server notices its connection is lost: resumed is then set,
// and its connection closed, and over is closed once it's kept.
type activeUpload struct {
	dir       string // the folder it's into
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
	if p == nil || p.holding > 0 || p.dir != dir || p.size != size {
		m.mu.Unlock()
		return nil, 0
	}
	delete(m.partials, id)
	p.timer.Stop()
	m.mu.Unlock()
	if p.root != nil {
		defer p.root.Close()
	}
	return store.resume(p, size)
}

func (m *uploadManager) track(id, dir string, interrupt func()) *activeUpload {
	a := &activeUpload{dir: dir, interrupt: interrupt, over: make(chan struct{})}
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

// holdUnder reports whether an upload into folder, or a folder in it, is
// going on. If none is, those kept there to resume are held, so none can
// carry on meanwhile (see claimPartial), and their ids returned, for
// release once it's known whether the folder's gone (see holdWrites).
// Folders are compared as resolve has them (links followed: see
// fileService.resolved), if it's given, folder already so; resolved
// before m.mu is taken, as resolving can take a while on a slow disk.
// (Nothing new starts in folder meanwhile: its writes are held first.)
func (m *uploadManager) holdUnder(folder string, resolve func(string) string) (held []string, busy bool) {
	var dirs []string
	if resolve != nil {
		m.mu.Lock()
		for _, a := range m.active {
			dirs = append(dirs, a.dir)
		}
		for _, p := range m.partials {
			dirs = append(dirs, p.dir)
		}
		m.mu.Unlock()
	}
	in := inFolderOf(folder, dirs, resolve)
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, a := range m.active {
		if in(a.dir) {
			return nil, true
		}
	}
	for id, p := range m.partials {
		if in(p.dir) {
			p.hold()
			held = append(held, id)
		}
	}
	return held, false
}

// release lets the uploads held carry on, or, with drop, gives them up;
// moved, if not nil, is where a file in their folder went.
func (m *uploadManager) release(held []string, drop bool, moved func(string) string) {
	var gone []*partialUpload
	m.mu.Lock()
	for _, id := range held {
		p := m.partials[id]
		if p == nil || p.holding == 0 {
			continue // gone meanwhile
		}
		// Dropped by any that holds it whose folder's gone; or, its time
		// up, once the last lets it go.
		if p.let(drop) {
			p := m.dropPartialLocked(id)
			if moved != nil {
				p.tmp = moved(p.tmp)
			}
			gone = append(gone, p)
		}
	}
	m.mu.Unlock()
	for _, p := range gone {
		removePartial(p)
	}
}
