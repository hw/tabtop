package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"sync"
	"testing"
	"time"
)

func TestOggCRC(t *testing.T) {
	// CRC-32/CKSUM's check value without its final XOR.
	if got := oggCRC([]byte("123456789")); got != 0x765e7680^0xffffffff {
		t.Errorf("oggCRC = %#x", got)
	}
}

func TestOggWriter(t *testing.T) {
	var buf bytes.Buffer
	o := newOggWriter(&buf)
	if err := o.writeHeaders(120); err != nil {
		t.Fatal(err)
	}
	if err := o.writePacket(bytes.Repeat([]byte{7}, 300), audioFrame); err != nil {
		t.Fatal(err)
	}
	var pages [][]byte
	for b := buf.Bytes(); len(b) > 0; {
		n := 27 + int(b[26])
		for _, s := range b[27:n] {
			n += int(s)
		}
		pages, b = append(pages, b[:n]), b[n:]
	}
	if len(pages) != 3 {
		t.Fatalf("got %d pages, want 3", len(pages))
	}
	for i, p := range pages {
		if string(p[:4]) != "OggS" || binary.LittleEndian.Uint32(p[18:]) != uint32(i) {
			t.Errorf("page %d: bad capture pattern or sequence number", i)
		}
		withoutCRC := bytes.Clone(p)
		copy(withoutCRC[22:26], []byte{0, 0, 0, 0})
		if binary.LittleEndian.Uint32(p[22:]) != oggCRC(withoutCRC) {
			t.Errorf("page %d: bad CRC", i)
		}
	}
	if pages[0][5] != 0x02 || string(pages[0][28:36]) != "OpusHead" ||
		binary.LittleEndian.Uint16(pages[0][38:]) != 120 {
		t.Errorf("bad OpusHead page: %q", pages[0])
	}
	if string(pages[1][28:36]) != "OpusTags" {
		t.Errorf("bad OpusTags page: %q", pages[1])
	}
	// 300 bytes: lacing values 255, 45.
	if p := pages[2]; p[26] != 2 || p[27] != 255 || p[28] != 45 || binary.LittleEndian.Uint64(p[6:]) != audioFrame {
		t.Errorf("bad audio page header: %v", p[:29])
	}
}

// fakeRecorder stands in for PipeWire in hub tests.
type fakeRecorder struct {
	mu      sync.Mutex
	running bool
	starts  int
	deliver func([]byte)
}

func (f *fakeRecorder) start(deliver func([]byte)) (func(), int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.running, f.deliver = true, deliver
	f.starts++
	return func() {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.running = false
	}, 120, nil
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
		if _, _, err := h.join(tc.token, tc.ip); !errors.Is(err, errAudioDenied) {
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
	l, preSkip, err := h.join("a", "ip1")
	if err != nil || preSkip != 120 || !f.isRunning() {
		t.Fatalf("join: err=%v preSkip=%d running=%v", err, preSkip, f.isRunning())
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
	if _, _, err := h.join("a", "ip1"); !errors.Is(err, errAudioDenied) {
		t.Errorf("join after logout: err = %v, want errAudioDenied", err)
	}
}

func TestAudioHubIdleStop(t *testing.T) {
	h, f := newTestHub()
	h.link("a", "ip1")
	l, _, _ := h.join("a", "ip1")
	h.leave(l)
	// Rejoining before the idle timeout reuses the recording.
	l, _, _ = h.join("a", "ip1")
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
	l, _, _ := h.join("a", "ip1")
	for range audioQueue + 10 {
		f.deliver([]byte("x")) // must not block
	}
	if len(l.packets) != audioQueue {
		t.Errorf("queued %d packets, want %d", len(l.packets), audioQueue)
	}
}
