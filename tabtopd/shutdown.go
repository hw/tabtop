package main

import (
	"context"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// shutdownGrace is how long stopping waits for tunnels to close. In the
// container, runuser passes SIGTERM on and kills tabtopd 2 s later, so the
// rest (deleting uploads kept to resume) must be done by then.
const shutdownGrace = 1500 * time.Millisecond

// tunnelDrain tracks the tunnels open, so a stop can close them all and
// wait for them. http.Server.Shutdown neither closes nor waits for them:
// they're hijacked connections. Its zero value is ready to use.
type tunnelDrain struct {
	mu       sync.Mutex
	stopping bool
	open     map[*websocket.Conn]bool
	done     chan struct{} // closed when the last one goes after stopping
}

// add counts c as open, until the returned function is called. It's false
// once stopping, when c must be refused.
func (d *tunnelDrain) add(c *websocket.Conn) (func(), bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.stopping {
		return nil, false
	}
	if d.open == nil {
		d.open = map[*websocket.Conn]bool{}
	}
	d.open[c] = true
	return func() {
		d.mu.Lock()
		defer d.mu.Unlock()
		delete(d.open, c)
		if d.stopping && len(d.open) == 0 && d.done != nil {
			close(d.done)
			d.done = nil
		}
	}, true
}

// stop refuses new tunnels and closes the open ones with 1012 (service
// restart) and no reason, which pages take as a lost connection: they
// reconnect by themselves once the gateway is back. It returns once every
// tunnel's handler has finished, or ctx ends.
func (d *tunnelDrain) stop(ctx context.Context) error {
	d.mu.Lock()
	d.stopping = true
	var done chan struct{}
	if len(d.open) > 0 {
		if d.done == nil {
			d.done = make(chan struct{})
		}
		done = d.done
	}
	for c := range d.open {
		// Close waits for the browser's answer, up to seconds.
		go c.Close(websocket.StatusServiceRestart, "")
	}
	d.mu.Unlock()
	if done == nil {
		return nil
	}
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// shutdown closes every tunnel, waiting for them until ctx ends, then
// deletes the uploads kept to resume: they're kept in memory, so none can
// be resumed once the gateway is gone. And it removes TabTop Mic from a
// host's sound server, if it made it there. Fetches going are cancelled. One still going when ctx ends is
// left to the next start (removeStaleUploads).
func (g *server) shutdown(ctx context.Context) error {
	if g.fetches != nil {
		// Cancelled first, so they delete what they had while the
		// tunnels close.
		g.fetches.cancelMatching(func(*fetchJob) bool { return true })
	}
	err := g.drain.stop(ctx)
	if g.fetches != nil {
		g.fetches.stop(ctx)
	}
	g.transfers.removePartials()
	g.removeLinkPartials()
	if g.shares != nil {
		g.shares.flush()
	}
	g.activity.flush()
	if g.audio != nil && g.audio.devices != nil {
		g.audio.devices.remove()
	}
	return err
}

func (m *uploadManager) removePartials() {
	m.mu.Lock()
	var dropped []*partialUpload
	for id := range m.partials {
		dropped = append(dropped, m.dropPartialLocked(id))
	}
	m.mu.Unlock()
	for _, p := range dropped {
		m.removePartial(p)
	}
}
