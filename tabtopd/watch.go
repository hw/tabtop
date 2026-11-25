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
	"path"
	"time"

	"github.com/coder/websocket"
)

// placed notes that the gateway itself put name (a path in ~/Downloads)
// there, as a move does, so it isn't told of as saved.
func (g *fileService) placed(name string) {
	if path.Dir(name) != "." {
		return // the watch only covers ~/Downloads itself
	}
	g.root.placedMu.Lock()
	defer g.root.placedMu.Unlock()
	if g.root.placedAt == nil {
		g.root.placedAt = map[string]time.Time{}
	}
	now := time.Now()
	for n, t := range g.root.placedAt {
		if now.Sub(t) > watchQuiet {
			delete(g.root.placedAt, n)
		}
	}
	g.root.placedAt[name] = now
}

func (g *fileService) wasPlaced(name string) bool {
	g.root.placedMu.Lock()
	defer g.root.placedMu.Unlock()
	t, ok := g.root.placedAt[name]
	return ok && time.Since(t) <= watchQuiet
}

// tunnelWatch answers a watch request: it sends {"saved":name,"bytes":n}
// for each file saved into ~/Downloads (see monitorDownloads) while the page
// keeps the tunnel open. The page sends nothing.
func (g *fileService) tunnelWatch(call *tunnelCall) {
	t, r := call.t, call.r
	store, err := g.openStore()
	if err != nil {
		r.fail("The folder is missing.")
		return
	}
	dir, err := openRootDirectory(store.root, ".")
	store.Close()
	if err != nil {
		r.fail("The folder is missing.")
		return
	}
	// Register through the checked descriptor, then release it: while it's
	// open, deleting the folder sends no event, and the watch would go on
	// watching a folder nobody can see.
	source, err := openDirectoryEvents(fmt.Sprintf("/proc/self/fd/%d", dir.Fd()), downloadWatchMask)
	dir.Close()
	if err != nil {
		r.fail("This folder can't be watched.")
		return
	}
	defer source.Close()
	if !r.accept(nil) {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stop := t.CloseRead(ctx).Done()
	err = monitorDownloads(g.downloadsDir, source, stop, func(name string, size int64) bool {
		if g.wasPlaced(name) {
			return true
		}
		return writeJSON(t, map[string]any{"saved": name, "bytes": size}) == nil
	})
	if err != nil {
		log.Printf("watching %s: %v", g.downloadsDir, err)
		t.Close(websocket.StatusInternalError, "This folder can't be watched.")
		return
	}
	r.finish(nil)
}

var errDirGone = errors.New("the folder was deleted or moved")

// tunnelChanges answers a changes request: it sends {"changed":true} soon
// after anything in the folder at req.Path changes (see monitorChanges),
// while the page keeps the tunnel open. The page sends nothing. If the
// folder is deleted or moved, it closes the tunnel, saying so.
func (g *fileService) tunnelChanges(call *tunnelCall) {
	t, req, r := call.t, call.req, call.r
	root, err := g.openStore()
	if err != nil {
		r.fail("The exposed folder is unavailable.")
		return
	}
	defer root.Close()
	name := req.dir()
	f, _, err := root.open(name) // confined to ~/Downloads, as for a list request
	if err != nil {
		r.fail("Not found.")
		return
	}
	defer f.Close()
	if st, err := f.Stat(); err != nil || !st.IsDir() {
		r.fail("Not a folder.")
		return
	}
	// Register through the confined open descriptor. Release it once inotify
	// holds the directory, so an open descriptor cannot delay deletion notices.
	source, err := openDirectoryEvents(fmt.Sprintf("/proc/self/fd/%d", f.Fd()), changesWatchMask)
	if err != nil {
		r.fail("This folder can't be watched for changes.")
		return
	}
	defer source.Close()
	f.Close()
	if !r.accept(nil) {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stop := t.CloseRead(ctx).Done()
	err = monitorChanges(source, stop, func() bool {
		return writeJSON(t, map[string]any{"changed": true}) == nil
	})
	switch {
	case errors.Is(err, errDirGone):
		t.Close(websocket.StatusNormalClosure, "The folder was deleted or moved.")
	case err != nil:
		log.Printf("watching %q: %v", name, err)
		t.Close(websocket.StatusInternalError, "This folder can't be watched for changes.")
	default:
		r.finish(nil)
	}
}
