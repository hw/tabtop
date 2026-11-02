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
	"strings"
	"time"

	"github.com/coder/websocket"
)

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

// tunnelWatch answers a watch request: it sends {"saved":name,"bytes":n}
// for each file saved into ~/Downloads (see monitorDownloads) while the page
// keeps the tunnel open. The page sends nothing.
func (g *server) tunnelWatch(t *tunnel, r *tunnelResponder) {
	if st, err := os.Stat(g.downloadsDir); err != nil || !st.IsDir() {
		r.fail("The Downloads folder is missing.")
		return
	}
	source, err := openDirectoryEvents(g.downloadsDir, downloadWatchMask)
	if err != nil {
		r.fail("Downloads can't be watched.")
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
		t.Close(websocket.StatusInternalError, "Downloads can't be watched.")
		return
	}
	r.finish(nil)
}

var errDirGone = errors.New("the folder was deleted or moved")

// tunnelChanges answers a changes request: it sends {"changed":true} soon
// after anything in the folder at req.Path changes (see monitorChanges),
// while the page keeps the tunnel open. The page sends nothing. If the
// folder is deleted or moved, it closes the tunnel, saying so.
func (g *server) tunnelChanges(t *tunnel, req tunnelRequest, r *tunnelResponder) {
	root, err := openDownloadStore(g.downloadsDir)
	if err != nil {
		r.fail("The downloads folder is missing.")
		return
	}
	defer root.Close()
	name := strings.Trim(req.Path, "/")
	if name == "" {
		name = "."
	}
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
