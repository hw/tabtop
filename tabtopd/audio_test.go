package main

import (
	"bytes"
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
	h := newAudioHub("test", "", 64, nil)
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
	clock := newManualClock()
	h.clock = clock.lifecycle()
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
	clock.Advance(3 * h.grace)
	select {
	case <-l.gone:
		t.Fatal("listener stopped although the desktop reconnected")
	default:
	}

	// The desktop going away stops the listener, then the recording.
	h.unlink("a", "ip1")
	clock.Advance(h.grace)
	eventually(t, "listener to stop", func() bool {
		select {
		case <-l.gone:
			return true
		default:
			return false
		}
	})
	clock.Advance(h.idle)
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
	clock := newManualClock()
	h.clock = clock.lifecycle()
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
	clock.Advance(200 * time.Millisecond)
	h.link("a", "ip1")
	h.unlink("a", "ip1")
	clock.Advance(200 * time.Millisecond) // past the first grace period, within the second
	if gone() {
		t.Fatal("listener stopped by the first disconnect's grace period")
	}
	clock.Advance(200 * time.Millisecond)
	if !gone() {
		t.Fatal("listener still running a grace period after the last disconnect")
	}
}

func TestAudioHubIdleStop(t *testing.T) {
	h, f := newTestHub()
	clock := newManualClock()
	h.clock = clock.lifecycle()
	h.link("a", "ip1")
	l, _ := h.join("a", "ip1")
	h.leave(l)
	// Rejoining before the idle timeout reuses the recording.
	l, _ = h.join("a", "ip1")
	clock.Advance(3 * h.idle)
	if !f.isRunning() || f.starts != 1 {
		t.Fatalf("running=%v starts=%d, want one continuous recording", f.isRunning(), f.starts)
	}
	h.leave(l)
	clock.Advance(h.idle)
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

// TestAudioHubSlowStart checks that a slow audio server holds up only the
// listeners waiting for it, and that they share one recording.
func TestAudioHubSlowStart(t *testing.T) {
	h, f := newTestHub()
	release := make(chan struct{})
	h.start = func(deliver func([]byte)) (func(), error) {
		<-release
		return f.start(deliver)
	}
	h.link("s", "ip")
	joined := make(chan error, 2)
	for range 2 {
		go func() {
			_, err := h.join("s", "ip")
			joined <- err
		}()
	}
	done := make(chan struct{})
	go func() {
		h.link("other", "ip")
		h.describe()
		h.listenerCount()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("the hub is locked while recording starts")
	}
	close(release)
	for range 2 {
		if err := <-joined; err != nil {
			t.Fatal(err)
		}
	}
	if f.starts != 1 || h.listenerCount() != 2 {
		t.Errorf("%d starts, %d listeners", f.starts, h.listenerCount())
	}
}

// TestAudioHubStartFails checks that a failed start fails every listener
// waiting for it, and that it isn't tried again until h.retry has passed.
func TestAudioHubStartFails(t *testing.T) {
	h, _ := newTestHub()
	clock := newManualClock()
	h.clock = clock.lifecycle()
	h.retry = 100 * time.Millisecond
	release := make(chan struct{})
	var mu sync.Mutex
	starts := 0
	h.start = func(deliver func([]byte)) (func(), error) {
		mu.Lock()
		starts++
		mu.Unlock()
		<-release
		return nil, errors.New("no audio server")
	}
	h.link("s", "ip")
	joined := make(chan error, 3)
	for range 3 {
		go func() {
			_, err := h.join("s", "ip")
			joined <- err
		}()
	}
	time.Sleep(20 * time.Millisecond)
	close(release)
	for range 3 {
		if err := <-joined; err == nil {
			t.Fatal("joined without audio")
		}
	}
	if _, err := h.join("s", "ip"); err == nil {
		t.Fatal("joined without audio")
	}
	mu.Lock()
	if starts != 1 {
		t.Errorf("%d starts before the retry delay, want 1", starts)
	}
	mu.Unlock()
	clock.Advance(h.retry)
	h.join("s", "ip")
	mu.Lock()
	defer mu.Unlock()
	if starts != 2 {
		t.Errorf("%d starts after the retry delay, want 2", starts)
	}
}

// TestMicOfferedLine: the gateway turns the microphone off by replacing
// this line of audio.js as it serves it (see scripts in page_assets.go); changed,
// that would silently do nothing.
func TestMicOfferedLine(t *testing.T) {
	if n := bytes.Count(audioJS, []byte("const micOffered = true;")); n != 1 {
		t.Errorf("audio.js has %d lines saying const micOffered = true;, not 1", n)
	}
}
