package main

// Notices of files saved into ~/Downloads, for the desktop page: a file
// the desktop's browser has finished downloading, or one a program has
// written there, so it can be fetched from the page at once. Only files
// directly in ~/Downloads count, not those in its folders.

import (
	"context"
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

// watchDownloads calls saved with the name and size of each file saved
// into dir until stop is closed: written there and closed, or renamed
// there from a partial download's name (or moved in from elsewhere). A
// file renamed from another real name isn't new, and isn't told of. It
// returns once stop is closed, or if dir can't be watched.
func watchDownloads(dir string, stop <-chan struct{}, saved func(name string, size int64)) error {
	fd, err := unix.InotifyInit1(unix.IN_CLOEXEC | unix.IN_NONBLOCK)
	if err != nil {
		return err
	}
	f := os.NewFile(uintptr(fd), "inotify") // non-blocking, so Close ends a Read
	defer f.Close()
	if _, err := unix.InotifyAddWatch(fd, dir, unix.IN_CLOSE_WRITE|unix.IN_MOVED_FROM|unix.IN_MOVED_TO|unix.IN_ONLYDIR); err != nil {
		return err
	}
	names := make(chan string, 64)
	go func() {
		defer close(names)
		buf := make([]byte, 64<<10)
		from := map[uint32]string{} // rename cookie -> the name it was renamed from
		for {
			n, err := f.Read(buf)
			if err != nil {
				return
			}
			for off := 0; off+unix.SizeofInotifyEvent <= n; {
				ev := (*unix.InotifyEvent)(unsafe.Pointer(&buf[off]))
				nameBytes := buf[off+unix.SizeofInotifyEvent : off+unix.SizeofInotifyEvent+int(ev.Len)]
				off += unix.SizeofInotifyEvent + int(ev.Len)
				name := strings.TrimRight(string(nameBytes), "\x00")
				switch {
				case ev.Mask&unix.IN_ISDIR != 0 || name == "" || partialName(name) && ev.Mask&unix.IN_MOVED_FROM == 0:
					continue
				case ev.Mask&unix.IN_MOVED_FROM != 0:
					if len(from) > 256 {
						clear(from) // pairs whose other half went elsewhere
					}
					from[ev.Cookie] = name
					continue
				case ev.Mask&unix.IN_MOVED_TO != 0:
					old, paired := from[ev.Cookie]
					delete(from, ev.Cookie)
					if paired && (!partialName(old) || strings.HasPrefix(old, uploadTempPrefix)) {
						continue // renamed, or an upload replacing a file
					}
				}
				select {
				case names <- name:
				default: // the sender is behind: drop it, as noise
				}
			}
		}
	}()
	go func() {
		<-stop
		f.Close()
	}()

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
