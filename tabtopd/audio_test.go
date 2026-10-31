package main

import (
	"errors"
	"sync"
	"testing"
	"time"
)

// fakeRecorder stands in for PipeWire in hub tests.
type fakeRecorder struct {
	mu      sync.Mutex
	running bool
	starts  int
	deliver func([]byte)
}

func (f *fakeRecorder) start(deliver func([]byte)) (func(), error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.running, f.deliver = true, deliver
	f.starts++
	return func() {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.running = false
	}, nil
}

func (f *fakeRecorder) isRunning() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.running
}

func newTestHub() (*audioHub, *fakeRecorder) {
	f := &fakeRecorder{}
	h := newAudioHub("test", 64)
	h.start, h.grace, h.idle = f.start, 20*time.Millisecond, 20*time.Millisecond
	return h, f
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	for range 100 {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestAudioHubNeedsDesktopLogin(t *testing.T) {
	h, f := newTestHub()
	h.link("linked", "ip1")
	for _, tc := range []struct{ token, ip string }{{"", "ip1"}, {"never-linked", "ip1"}, {"linked", "ip2"}} {
		if _, err := h.join(tc.token, tc.ip); !errors.Is(err, errAudioDenied) {
			t.Errorf("join(%q, %q): err = %v, want errAudioDenied", tc.token, tc.ip, err)
		}
	}
	if f.starts != 0 {
		t.Error("recording started for a refused listener")
	}
}

func TestAudioHubLifecycle(t *testing.T) {
	h, f := newTestHub()
	h.link("a", "ip1")
	l, err := h.join("a", "ip1")
	if err != nil || !f.isRunning() {
		t.Fatalf("join: err=%v running=%v", err, f.isRunning())
	}
	f.deliver([]byte("pkt"))
	if got := <-l.packets; string(got) != "pkt" {
		t.Errorf("got packet %q", got)
	}

	// A reconnect within the grace period keeps the listener.
	h.unlink("a", "ip1")
	h.link("a", "ip1")
	time.Sleep(3 * h.grace)
	select {
	case <-l.gone:
		t.Fatal("listener stopped although the desktop reconnected")
	default:
	}

	// The desktop going away stops the listener, then the recording.
	h.unlink("a", "ip1")
	eventually(t, "listener to stop", func() bool {
		select {
		case <-l.gone:
			return true
		default:
			return false
		}
	})
	h.leave(l) // the handler leaves after seeing gone; must be harmless
	eventually(t, "recording to stop", func() bool { return !f.isRunning() })
	if _, err := h.join("a", "ip1"); !errors.Is(err, errAudioDenied) {
		t.Errorf("join after logout: err = %v, want errAudioDenied", err)
	}
}

// TestAudioHubGraceFromLastUnlink checks that the grace period runs from
// the last disconnect: a reconnect and another disconnect, both within the
// first one's grace period, start it again.
func TestAudioHubGraceFromLastUnlink(t *testing.T) {
	h, _ := newTestHub()
	h.grace = 300 * time.Millisecond
	h.link("a", "ip1")
	l, err := h.join("a", "ip1")
	if err != nil {
		t.Fatal(err)
	}
	gone := func() bool {
		select {
		case <-l.gone:
			return true
		default:
			return false
		}
	}
	h.unlink("a", "ip1")
	time.Sleep(200 * time.Millisecond)
	h.link("a", "ip1")
	h.unlink("a", "ip1")
	time.Sleep(200 * time.Millisecond) // past the first grace period, within the second
	if gone() {
		t.Fatal("listener stopped by the first disconnect's grace period")
	}
	time.Sleep(200 * time.Millisecond)
	if !gone() {
		t.Fatal("listener still running a grace period after the last disconnect")
	}
}

func TestAudioHubIdleStop(t *testing.T) {
	h, f := newTestHub()
	h.link("a", "ip1")
	l, _ := h.join("a", "ip1")
	h.leave(l)
	// Rejoining before the idle timeout reuses the recording.
	l, _ = h.join("a", "ip1")
	time.Sleep(3 * h.idle)
	if !f.isRunning() || f.starts != 1 {
		t.Fatalf("running=%v starts=%d, want one continuous recording", f.isRunning(), f.starts)
	}
	h.leave(l)
	eventually(t, "recording to stop", func() bool { return !f.isRunning() })
}

func TestAudioHubDropsWhenQueueFull(t *testing.T) {
	h, f := newTestHub()
	h.link("a", "ip1")
	l, _ := h.join("a", "ip1")
	for range audioQueue + 10 {
		f.deliver([]byte("x")) // must not block
	}
	if len(l.packets) != audioQueue {
		t.Errorf("queued %d packets, want %d", len(l.packets), audioQueue)
	}
}
