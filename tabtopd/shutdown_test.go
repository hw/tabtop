package main

import (
	"context"
	"errors"
	"io/fs"
	"path/filepath"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// Stopping closes every tunnel, logged in or not, with 1012 and no reason,
// which pages take as lost and reconnect from; refuses new ones; and waits
// for their handlers.
func TestShutdownClosesTunnels(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	session := openSession(t, ctx, srv.URL, s)  // waiting for its request
	handshake := dialWS(t, ctx, wsURL(srv.URL)) // no hello yet

	closed := make(chan error, 2)
	for _, c := range []*websocket.Conn{session.c, handshake} {
		go func() {
			_, _, err := c.Read(ctx)
			closed <- err
		}()
	}
	// Both handlers are running once the handshake one is counted too.
	for deadline := time.Now().Add(5 * time.Second); ; {
		g.drain.mu.Lock()
		n := len(g.drain.open)
		g.drain.mu.Unlock()
		if n == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d tunnels open, want 2", n)
		}
		time.Sleep(10 * time.Millisecond)
	}

	stopCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := g.shutdown(stopCtx); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	if n := len(g.drain.open); n != 0 {
		t.Errorf("%d tunnels still open after shutdown", n)
	}
	for range 2 {
		var ce websocket.CloseError
		err := <-closed
		if !errors.As(err, &ce) || ce.Code != websocket.StatusServiceRestart || ce.Reason != "" {
			t.Errorf("tunnel closed with %v, want 1012 and no reason", err)
		}
	}

	c := dialWS(t, ctx, wsURL(srv.URL))
	if _, _, err := c.Read(ctx); websocket.CloseStatus(err) != websocket.StatusServiceRestart {
		t.Errorf("tunnel after shutdown: %v", err)
	}
}

// A browser that never answers the close doesn't hold up the stop past its
// deadline.
func TestShutdownDeadline(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	dialWS(t, ctx, wsURL(srv.URL)) // never read, so never answers the close
	for deadline := time.Now().Add(5 * time.Second); ; {
		g.drain.mu.Lock()
		n := len(g.drain.open)
		g.drain.mu.Unlock()
		if n == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("tunnel not counted")
		}
		time.Sleep(10 * time.Millisecond)
	}
	stopCtx, cancel := context.WithTimeout(ctx, 300*time.Millisecond)
	defer cancel()
	start := time.Now()
	g.shutdown(stopCtx)
	if took := time.Since(start); took > 2*time.Second {
		t.Errorf("shutdown took %s with a 300ms deadline", took)
	}
}

// Uploads kept to resume are deleted: nothing can resume them after a
// restart.
func TestShutdownRemovesPartialUploads(t *testing.T) {
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
	g.transfers.keepPartial(u, 10)
	if n := countFiles(t, g.downloadsDir); n != 1 {
		t.Fatalf("%d files before shutdown, want the upload's", n)
	}
	if err := g.shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := countFiles(t, g.downloadsDir); n != 0 {
		t.Errorf("%d files left after shutdown", n)
	}
	if len(g.transfers.partials) != 0 {
		t.Error("partial upload still kept")
	}
}

func countFiles(t *testing.T, dir string) int {
	t.Helper()
	n := 0
	filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			n++
		}
		return nil
	})
	return n
}
