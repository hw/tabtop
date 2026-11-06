package main

import (
	"errors"
	"io"
	"math"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/coder/websocket"
)

// sine is n samples of a 440 Hz tone at 48 kHz, starting at sample from.
func sine(from, n int) []int16 {
	out := make([]int16, n)
	for i := range out {
		out[i] = int16(8000 * math.Sin(2*math.Pi*440*float64(from+i)/micRate))
	}
	return out
}

func energy(p []int16) float64 {
	var sum float64
	for _, s := range p {
		sum += float64(s) * float64(s)
	}
	return sum / float64(max(len(p), 1))
}

func TestOpusMonoRoundTrip(t *testing.T) {
	enc, err := newOpusEncoder(micRate, 1, 32000)
	if err != nil {
		t.Fatal(err)
	}
	defer enc.close()
	dec, err := newOpusDecoder(micRate, 1)
	if err != nil {
		t.Fatal(err)
	}
	defer dec.close()
	var last []int16
	for i := range 10 {
		packet, err := enc.encode(sine(i*960, 960))
		if err != nil {
			t.Fatal(err)
		}
		pcm, err := dec.decode(packet)
		if err != nil {
			t.Fatal(err)
		}
		if len(pcm) != 960 {
			t.Fatalf("decoded %d samples, want 960", len(pcm))
		}
		last = pcm
	}
	if e := energy(last); e < energy(sine(0, 960))/4 {
		t.Errorf("decoded tone has energy %.0f, far below the input's", e)
	}
	if _, err := dec.decode([]byte{0xff, 0xff, 0xff}); err == nil {
		t.Error("garbage decoded without an error")
	}
	if _, err := dec.decode(nil); err == nil {
		t.Error("an empty packet decoded without an error")
	}
}

func TestMicBuffer(t *testing.T) {
	var b micBuffer
	b.push([]int16{1, 2, 3})
	out := make([]int16, 5)
	if n, _ := b.read(out); n != 5 || out[0] != 1 || out[2] != 3 || out[3] != 0 || out[4] != 0 {
		t.Errorf("read %d: %v, want 1 2 3 then silence", n, out)
	}
	if n, _ := b.read(out); n != 5 || energy(out) != 0 {
		t.Errorf("empty buffer read %d: %v, want silence", n, out)
	}
	// Past micMaxBuffer, the oldest goes.
	big := make([]int16, micMaxBuffer+100)
	for i := range big {
		big[i] = int16(i % 1000)
	}
	b.push(big)
	if len(b.samples) != micMaxBuffer || b.samples[0] != big[100] {
		t.Errorf("held %d starting %d, want %d starting %d", len(b.samples), b.samples[0], micMaxBuffer, big[100])
	}
}

// fakeMic stands in for playMic, keeping the buffer it was given.
type fakeMic struct {
	mu      sync.Mutex
	buf     *micBuffer
	playing int
}

func (f *fakeMic) play(buf *micBuffer) (func(), error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.buf = buf
	f.playing++
	return func() {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.playing--
	}, nil
}

func (f *fakeMic) held() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.buf == nil {
		return 0
	}
	f.buf.mu.Lock()
	defer f.buf.mu.Unlock()
	return len(f.buf.samples)
}

func (f *fakeMic) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.playing
}

func TestTunnelMic(t *testing.T) {
	g, srv := newE2EServer(t)
	g.vncAddr = "unix:" + fakeXvncUnix(t)
	hub, _ := newTestHub()
	g.audio = hub
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))

	// No microphone sink: the page hides its button on this reply.
	if reply := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "mic"}); reply["error"] != noMicMsg {
		t.Fatalf("mic without a sink: %v", reply)
	}
	f := &fakeMic{}
	hub.play = f.play
	// Only while the session has the desktop open.
	if reply := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "mic"}); reply["error"] == nil || reply["error"] == noMicMsg {
		t.Fatalf("mic without the desktop: %v", reply)
	}
	desktop := openSession(t, ctx, srv.URL, s)
	if reply := desktop.request(t, ctx, tunnelRequest{Type: "vnc"}); reply["ok"] != true {
		t.Fatalf("vnc: %v", reply)
	}
	desktop.read(ctx) // the greeting: the desktop is linked by now

	mic := openSession(t, ctx, srv.URL, s)
	if reply := mic.request(t, ctx, tunnelRequest{Type: "mic"}); reply["ok"] != true || reply["codec"] != "opus" {
		t.Fatalf("mic: %v", reply)
	}
	enc, err := newOpusEncoder(micRate, 1, 32000)
	if err != nil {
		t.Fatal(err)
	}
	defer enc.close()
	for i := range 5 {
		packet, _ := enc.encode(sine(i*960, 960))
		if err := mic.write(ctx, msgData, packet); err != nil {
			t.Fatal(err)
		}
	}
	eventually(t, "the packets decoded into the microphone", func() bool { return f.held() == 5*960 })

	// The desktop going ends the microphone, after the grace period.
	desktop.c.Close(websocket.StatusNormalClosure, "")
	if _, _, err := mic.read(ctx); websocket.CloseStatus(err) != websocket.StatusNormalClosure {
		t.Errorf("mic after the desktop closed: %v", err)
	}
	eventually(t, "playback stopped", func() bool { return f.count() == 0 })

	// A packet too big for any Opus frame ends it.
	desktop = openSession(t, ctx, srv.URL, s)
	desktop.request(t, ctx, tunnelRequest{Type: "vnc"})
	desktop.read(ctx)
	mic = openSession(t, ctx, srv.URL, s)
	if reply := mic.request(t, ctx, tunnelRequest{Type: "mic"}); reply["ok"] != true {
		t.Fatalf("mic again: %v", reply)
	}
	mic.write(ctx, msgData, make([]byte, micMaxPacket+1))
	if _, _, err := mic.read(ctx); websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Errorf("oversized packet: %v", err)
	}
}

// audio.js is told whether there's a microphone, so its button only shows
// when there is.
func TestAudioJSOffersMic(t *testing.T) {
	g, srv := newE2EServer(t)
	hub, _ := newTestHub()
	g.audio = hub
	get := func() string {
		res, err := http.Get(srv.URL + "/tabtop/audio.js")
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return string(b)
	}
	if js := get(); !strings.Contains(js, "const micOffered = false;") {
		t.Error("audio.js offers a microphone the gateway hasn't got")
	}
	hub.play = (&fakeMic{}).play
	if js := get(); !strings.Contains(js, "const micOffered = true;") {
		t.Error("audio.js doesn't offer the microphone")
	}
}

func TestJoinMicWithoutSink(t *testing.T) {
	h, _ := newTestHub()
	h.link("s", "ip")
	if _, _, _, err := h.joinMic("s", "ip"); !errors.Is(err, errNoMic) {
		t.Errorf("err = %v, want errNoMic", err)
	}
}
