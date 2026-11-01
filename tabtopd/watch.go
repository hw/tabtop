package main

// Notices of files saved into ~/Downloads, for the desktop page: a file
// the desktop's browser has finished downloading, or one a program has
// written there, so it can be fetched from the page at once. Only files
// directly in ~/Downloads count, not those in its folders. And notices of
// any change in the folder the files page shows, so it can list it again.

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
	"unsafe"

	"github.com/coder/websocket"
	"golang.org/x/sys/unix"
)

const (
	// How long a file must go unchanged before it's told of, so a burst
	// of writes, or a download's last steps, make one notice.
	watchSettle = 700 * time.Millisecond
	// How long after one notice of a file another isn't sent, and how long
	// a name the gateway moved in itself stays quiet.
	watchQuiet = 10 * time.Second
	// A change in a folder the files page shows is told of once nothing
	// more has changed for changesSettle, or changesMax after the first,
	// so a steady stream of changes still shows.
	changesSettle = 250 * time.Millisecond
	changesMax    = time.Second
)

// Endings of the files browsers and others download into before renaming
// them to the file's real name.
var partialExts = []string{".crdownload", ".part", ".partial", ".download", ".tmp"}

// partialName reports whether name is a file being downloaded or uploaded,
// or hidden: one not to tell of.
func partialName(name string) bool {
	if strings.HasPrefix(name, ".") {
		return true
	}
	lower := strings.ToLower(name)
	for _, ext := range partialExts {
		if strings.HasSuffix(lower, ext) {
			return true
		}
	}
	return false
}

// placed notes that the gateway itself put name (a path in ~/Downloads)
// there, as a move does, so it isn't told of as saved.
func (g *server) placed(name string) {
	if path.Dir(name) != "." {
		return // the watch only covers ~/Downloads itself
	}
	g.placedMu.Lock()
	defer g.placedMu.Unlock()
	if g.placedAt == nil {
		g.placedAt = map[string]time.Time{}
	}
	now := time.Now()
	for n, t := range g.placedAt {
		if now.Sub(t) > watchQuiet {
			delete(g.placedAt, n)
		}
	}
	g.placedAt[name] = now
}

func (g *server) wasPlaced(name string) bool {
	g.placedMu.Lock()
	defer g.placedMu.Unlock()
	t, ok := g.placedAt[name]
	return ok && time.Since(t) <= watchQuiet
}

// watchDir calls each with every event inotify reports for dir, of
// those in mask, from a goroutine of its own, until stop is closed, then
// calls done. It returns at once, with an error if dir can't be watched.
func watchDir(dir string, mask uint32, stop <-chan struct{}, each func(ev *unix.InotifyEvent, name string), done func()) error {
	fd, err := unix.InotifyInit1(unix.IN_CLOEXEC | unix.IN_NONBLOCK)
	if err != nil {
		return err
	}
	f := os.NewFile(uintptr(fd), "inotify") // non-blocking, so Close ends a Read
	if _, err := unix.InotifyAddWatch(fd, dir, mask|unix.IN_ONLYDIR); err != nil {
		f.Close()
		return err
	}
	go func() {
		defer done()
		buf := make([]byte, 64<<10)
		for {
			n, err := f.Read(buf)
			if err != nil {
				return
			}
			for off := 0; off+unix.SizeofInotifyEvent <= n; {
				ev := (*unix.InotifyEvent)(unsafe.Pointer(&buf[off]))
				nameBytes := buf[off+unix.SizeofInotifyEvent : off+unix.SizeofInotifyEvent+int(ev.Len)]
				off += unix.SizeofInotifyEvent + int(ev.Len)
				each(ev, strings.TrimRight(string(nameBytes), "\x00"))
			}
		}
	}()
	go func() {
		<-stop
		f.Close()
	}()
	return nil
}

// watchDownloads calls saved with the name and size of each file saved
// into dir until stop is closed: written there and closed, or renamed
// there from a partial download's name (or moved in from elsewhere). A
// file renamed from another real name isn't new, and isn't told of. It
// returns once stop is closed, or if dir can't be watched.
func watchDownloads(dir string, stop <-chan struct{}, saved func(name string, size int64)) error {
	names := make(chan string, 64)
	from := map[uint32]string{} // rename cookie -> the name it was renamed from
	err := watchDir(dir, unix.IN_CLOSE_WRITE|unix.IN_MOVED_FROM|unix.IN_MOVED_TO, stop, func(ev *unix.InotifyEvent, name string) {
		switch {
		case ev.Mask&unix.IN_ISDIR != 0 || name == "" || partialName(name) && ev.Mask&unix.IN_MOVED_FROM == 0:
			return
		case ev.Mask&unix.IN_MOVED_FROM != 0:
			if len(from) > 256 {
				clear(from) // pairs whose other half went elsewhere
			}
			from[ev.Cookie] = name
			return
		case ev.Mask&unix.IN_MOVED_TO != 0:
			old, paired := from[ev.Cookie]
			delete(from, ev.Cookie)
			if paired && (!partialName(old) || strings.HasPrefix(old, uploadTempPrefix)) {
				return // renamed, or an upload replacing a file
			}
		}
		select {
		case names <- name:
		default: // the sender is behind: drop it, as noise
		}
	}, func() { close(names) })
	if err != nil {
		return err
	}

	pending := map[string]time.Time{} // name -> when it last changed
	told := map[string]time.Time{}
	tick := time.NewTicker(watchSettle / 2)
	defer tick.Stop()
	for {
		select {
		case name, ok := <-names:
			if !ok {
				return nil
			}
			pending[name] = time.Now()
		case now := <-tick.C:
			for name, at := range pending {
				if now.Sub(at) < watchSettle {
					continue
				}
				delete(pending, name)
				if now.Sub(told[name]) < watchQuiet {
					continue
				}
				st, err := os.Lstat(filepath.Join(dir, name))
				if err != nil || !st.Mode().IsRegular() {
					continue
				}
				told[name] = now
				saved(name, st.Size())
			}
			for name, at := range told {
				if now.Sub(at) > watchQuiet {
					delete(told, name)
				}
			}
		}
	}
}

// tunnelWatch answers a watch request: it sends {"saved":name,"bytes":n}
// for each file saved into ~/Downloads (see watchDownloads) while the page
// keeps the tunnel open. The page sends nothing.
func (g *server) tunnelWatch(t *tunnel, reply func(map[string]any) bool, fail func(string)) {
	if st, err := os.Stat(g.downloadsDir); err != nil || !st.IsDir() {
		fail("The Downloads folder is missing.")
		return
	}
	if !reply(nil) {
		return
	}
	stop := make(chan struct{})
	go func() {
		// Reading ends when the page goes.
		for {
			if _, _, err := t.Read(context.Background()); err != nil {
				close(stop)
				return
			}
		}
	}()
	err := watchDownloads(g.downloadsDir, stop, func(name string, size int64) {
		if g.wasPlaced(name) {
			return
		}
		if writeJSON(t, map[string]any{"saved": name, "bytes": size}) != nil {
			t.Close(websocket.StatusNormalClosure, "")
		}
	})
	if err != nil {
		log.Printf("watching %s: %v", g.downloadsDir, err)
		t.Close(websocket.StatusInternalError, "Downloads can't be watched.")
		return
	}
	t.Close(websocket.StatusNormalClosure, "")
}

// watchChanges calls changed soon after anything in dir changes: an entry
// made, deleted, renamed, written or touched (see changesSettle). Changes
// to the gateway's own unfinished uploads, which aren't listed, don't
// count. It calls started once it's watching. It returns nil once stop is
// closed, errDirGone once dir is deleted or moved, or an error if it can't
// be watched.
func watchChanges(dir string, stop <-chan struct{}, started, changed func()) error {
	events := make(chan bool, 1) // true once dir itself is gone
	err := watchDir(dir, unix.IN_CREATE|unix.IN_DELETE|unix.IN_MOVED_FROM|unix.IN_MOVED_TO|unix.IN_CLOSE_WRITE|
		unix.IN_ATTRIB|unix.IN_DELETE_SELF|unix.IN_MOVE_SELF, stop, func(ev *unix.InotifyEvent, name string) {
		gone := ev.Mask&(unix.IN_DELETE_SELF|unix.IN_MOVE_SELF|unix.IN_IGNORED) != 0
		if !gone && (name == "" || strings.HasPrefix(name, uploadTempPrefix)) {
			return
		}
		if gone {
			events <- true // the sender returns on it, so this can't block for long
			return
		}
		select {
		case events <- false:
		default: // one's waiting already
		}
	}, func() { close(events) })
	if err != nil {
		return err
	}
	started()
	var first time.Time // of the changes not yet told of
	timer := time.NewTimer(time.Hour)
	timer.Stop()
	defer timer.Stop()
	for {
		select {
		case gone, ok := <-events:
			if !ok {
				return nil
			}
			if gone {
				changed()
				go func() {
					for range events { // until stop closes it
					}
				}()
				return errDirGone
			}
			now := time.Now()
			if first.IsZero() {
				first = now
			}
			timer.Reset(min(changesSettle, first.Add(changesMax).Sub(now)))
		case <-timer.C:
			first = time.Time{}
			changed()
		}
	}
}

var errDirGone = errors.New("the folder was deleted or moved")

// tunnelChanges answers a changes request: it sends {"changed":true} soon
// after anything in the folder at req.Path changes (see watchChanges),
// while the page keeps the tunnel open. The page sends nothing. If the
// folder is deleted or moved, it closes the tunnel, saying so.
func (g *server) tunnelChanges(t *tunnel, req tunnelRequest, reply func(map[string]any) bool, fail func(string)) {
	root, err := os.OpenRoot(g.downloadsDir)
	if err != nil {
		fail("The downloads folder is missing.")
		return
	}
	defer root.Close()
	name := strings.Trim(req.Path, "/")
	if name == "" {
		name = "."
	}
	f, err := root.Open(name) // confined to ~/Downloads, as for a list request
	if err != nil {
		fail("Not found.")
		return
	}
	defer f.Close()
	if st, err := f.Stat(); err != nil || !st.IsDir() {
		fail("Not a folder.")
		return
	}
	if !reply(nil) {
		return
	}
	stop := make(chan struct{})
	go func() {
		// Reading ends when the page goes.
		for {
			if _, _, err := t.Read(context.Background()); err != nil {
				close(stop)
				return
			}
		}
	}()
	// inotify takes a path: the open folder's, through /proc, so it's the
	// folder just opened inside ~/Downloads, even if a symlink is put in
	// its way since. Once it's watched, it's closed: the watch keeps hold
	// of the folder itself, and the folder open here would put off the
	// notice that it's deleted until it was closed.
	err = watchChanges(fmt.Sprintf("/proc/self/fd/%d", f.Fd()), stop, func() { f.Close() }, func() {
		if writeJSON(t, map[string]any{"changed": true}) != nil {
			t.Close(websocket.StatusNormalClosure, "")
		}
	})
	switch {
	case errors.Is(err, errDirGone):
		t.Close(websocket.StatusNormalClosure, "The folder was deleted or moved.")
	case err != nil:
		log.Printf("watching %s: %v", name, err)
		t.Close(websocket.StatusInternalError, "This folder can't be watched for changes.")
	default:
		t.Close(websocket.StatusNormalClosure, "")
	}
}
