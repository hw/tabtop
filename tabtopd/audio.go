package main

// Desktop audio. Chromium plays into a PipeWire null sink; while anyone is
// listening, the gateway records the sink's monitor over the PulseAudio
// protocol (pipewire-pulse), encodes 10 ms Opus frames and sends them
// through the encrypted tunnel, one packet per message, to the player in
// audio.js (WebCodecs, so HTTPS or localhost only).
//
// An audio tunnel's session must have the desktop open from the same IP
// (see e2e.go): audio follows the desktop, and never takes a TOTP code, so
// it's no way around the login limit.

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"log"
	"slices"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/jfreymuth/pulse"
)

const (
	audioRate     = 48000
	audioChannels = 2
	audioFrame    = audioRate / 100 // samples per channel in a 10 ms frame
	// Bitrate range in kbit/s.
	minAudioBitrate = 32
	maxAudioBitrate = 256
	// Packets queued per listener (500 ms) before new ones are dropped, so a
	// slow client loses audio instead of falling ever further behind.
	audioQueue = 50
	// How long audio outlives its desktop connection, so a noVNC reconnect
	// doesn't cut it.
	audioGrace = 5 * time.Second
	// How long recording continues after the last listener leaves, so a
	// quick reconnect doesn't restart it.
	audioIdle = 10 * time.Second
	// How long after recording failed to start a listener gets the same
	// error instead of trying again, so many tabs don't make one outage
	// many waits.
	audioRetry = 3 * time.Second
)

//go:embed audio.js
var audioJS []byte

var audioConfig = fmt.Sprintf(`{"codec":"opus","sampleRate":%d,"channels":%d,"frameMs":10}`, audioRate, audioChannels)

var errAudioDenied = errors.New("no open desktop for this session and IP")

type audioHub struct {
	// start begins recording, calling deliver with each Opus packet, and
	// returns a function that stops it.
	start func(deliver func([]byte)) (stop func(), err error)
	sink  string
	kbps  int
	grace time.Duration
	idle  time.Duration
	retry time.Duration

	mu        sync.Mutex
	desktops  map[string]map[string]int // session -> client IP -> open desktop tunnels
	graceGen  map[audioDesktop]uint64   // changes with each link and unlink, so older grace timers do nothing
	listeners map[*audioListener]struct{}
	stop      func() // stops recording; nil when not recording
	// While recording starts or stops, which talks to the audio server
	// and so happens without h.mu held.
	changing  *audioChange
	failed    time.Time // when recording last failed to start
	failErr   error     // why; nil once it starts
	idleTimer *time.Timer
}

type audioDesktop struct{ token, ip string }

// audioChange is recording starting or stopping: done is closed when it's
// over, and err is then why a start failed.
type audioChange struct {
	done chan struct{}
	err  error
}

type audioListener struct {
	token   string
	ip      string
	packets chan []byte
	gone    chan struct{} // closed when the listener's desktop connection is gone
}

// newAudioHub streams sink's sound, encoded at kbps kbit/s.
func newAudioHub(sink string, kbps int) *audioHub {
	return &audioHub{
		start:     func(deliver func([]byte)) (func(), error) { return recordSink(sink, kbps*1000, deliver) },
		sink:      sink,
		kbps:      kbps,
		grace:     audioGrace,
		idle:      audioIdle,
		retry:     audioRetry,
		desktops:  map[string]map[string]int{},
		graceGen:  map[audioDesktop]uint64{},
		listeners: map[*audioListener]struct{}{},
	}
}

// checkSink connects to the audio server and looks up the sink, for the
// doctor report.
func (h *audioHub) checkSink() error {
	client, err := pulse.NewClient(pulse.ClientApplicationName("tabtopd"), pulse.ClientTimeout(2*time.Second))
	if err != nil {
		return fmt.Errorf("connecting to the audio server: %w", err)
	}
	defer client.Close()
	if _, err := client.SinkByID(h.sink); err != nil {
		return fmt.Errorf("finding audio sink %q: %w", h.sink, err)
	}
	return nil
}

func (h *audioHub) describe() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	state := "idle"
	if h.stop != nil {
		state = "recording"
	}
	return fmt.Sprintf("sink %s at %d kbit/s, %s", h.sink, h.kbps, state)
}

func (h *audioHub) listenerCount() int {
	if h == nil {
		return 0
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.listeners)
}

// link records a desktop tunnel opened by session token from ip.
func (h *audioHub) link(token, ip string) {
	if h == nil || token == "" {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.desktops[token] == nil {
		h.desktops[token] = map[string]int{}
	}
	h.desktops[token][ip]++
	h.graceGen[audioDesktop{token, ip}]++
}

// unlink records that a linked desktop tunnel closed. If no other one from
// the same IP is open after the grace period, counted from the last one to
// close, the listeners for token from that IP are stopped.
func (h *audioHub) unlink(token, ip string) {
	if h == nil || token == "" {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.desktops[token][ip]--; h.desktops[token][ip] > 0 {
		return
	}
	d := audioDesktop{token, ip}
	h.graceGen[d]++
	gen := h.graceGen[d]
	time.AfterFunc(h.grace, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if h.graceGen[d] != gen {
			return // linked again since, and maybe unlinked again too
		}
		delete(h.graceGen, d)
		delete(h.desktops[token], ip)
		if len(h.desktops[token]) == 0 {
			delete(h.desktops, token)
		}
		for l := range h.listeners {
			if l.token == token && l.ip == ip {
				close(l.gone)
				delete(h.listeners, l)
			}
		}
		h.idleCheckLocked()
	})
}

// join adds a listener, starting the recording if it's the first.
func (h *audioHub) join(token, ip string) (*audioListener, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for {
		if token == "" || h.desktops[token][ip] <= 0 {
			// Gone while recording started, maybe: let it stop again.
			h.idleCheckLocked()
			return nil, errAudioDenied
		}
		if h.idleTimer != nil {
			h.idleTimer.Stop()
			h.idleTimer = nil
		}
		if h.stop != nil {
			break
		}
		if c := h.changing; c != nil {
			// Wait for the start or stop going on, then look again; a
			// failed start fails every listener that waited for it.
			h.mu.Unlock()
			<-c.done
			h.mu.Lock()
			if c.err != nil {
				return nil, c.err
			}
			continue
		}
		if h.failErr != nil && time.Since(h.failed) < h.retry {
			return nil, h.failErr
		}
		c := &audioChange{done: make(chan struct{})}
		h.changing = c
		h.mu.Unlock()
		stop, err := h.start(h.deliver)
		h.mu.Lock()
		h.changing, c.err = nil, err
		close(c.done)
		if err != nil {
			h.failed, h.failErr = time.Now(), err
			return nil, err
		}
		h.failErr = nil
		h.stop = stop
		log.Printf("audio recording started")
	}
	l := &audioListener{token: token, ip: ip, packets: make(chan []byte, audioQueue), gone: make(chan struct{})}
	h.listeners[l] = struct{}{}
	return l, nil
}

func (h *audioHub) leave(l *audioListener) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.listeners[l]; ok {
		delete(h.listeners, l)
		h.idleCheckLocked()
	}
}

// idleCheckLocked stops recording audioIdle after the last listener left.
// h.mu must be held.
func (h *audioHub) idleCheckLocked() {
	if len(h.listeners) > 0 || h.stop == nil || h.idleTimer != nil {
		return
	}
	var timer *time.Timer
	timer = time.AfterFunc(h.idle, func() {
		h.mu.Lock()
		if h.idleTimer != timer || len(h.listeners) > 0 || h.stop == nil || h.changing != nil {
			h.mu.Unlock()
			return
		}
		h.idleTimer = nil
		stop, c := h.stop, &audioChange{done: make(chan struct{})}
		h.stop, h.changing = nil, c
		h.mu.Unlock()
		stop()
		h.mu.Lock()
		h.changing = nil
		close(c.done)
		h.mu.Unlock()
		log.Printf("audio recording stopped: no listeners")
	})
	h.idleTimer = timer
}

func (h *audioHub) deliver(packet []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for l := range h.listeners {
		select {
		case l.packets <- packet:
		default: // queue full: drop rather than build up delay
		}
	}
}

// recordSink records sink's monitor and encodes it. Recording, encoding and
// delivery run on separate goroutines, so a slow listener can't stall the
// PulseAudio connection.
func recordSink(sink string, bitrate int, deliver func([]byte)) (func(), error) {
	enc, err := newOpusEncoder(audioRate, audioChannels, bitrate)
	if err != nil {
		return nil, err
	}
	client, err := pulse.NewClient(pulse.ClientApplicationName("tabtopd"), pulse.ClientTimeout(5*time.Second))
	if err != nil {
		enc.close()
		return nil, fmt.Errorf("connecting to the audio server: %w", err)
	}
	s, err := client.SinkByID(sink)
	if err != nil {
		client.Close()
		enc.close()
		return nil, fmt.Errorf("finding audio sink %q: %w", sink, err)
	}

	pcm := make(chan []int16, 50)
	stream, err := client.NewRecord(pulse.Int16Writer(func(p []int16) (int, error) {
		select {
		case pcm <- slices.Clone(p):
		default: // encoder behind: drop
		}
		return len(p), nil
	}), pulse.RecordStereo, pulse.RecordSampleRate(audioRate), pulse.RecordMonitor(s),
		pulse.RecordLatency(float64(audioFrame)/audioRate), pulse.RecordMediaName("desktop audio for the browser"))
	if err != nil {
		client.Close()
		enc.close()
		return nil, fmt.Errorf("recording audio sink %q: %w", sink, err)
	}

	done := make(chan struct{})
	go func() {
		defer enc.close()
		frame := make([]int16, 0, 2*audioFrame*audioChannels)
		for {
			select {
			case <-done:
				return
			case p := <-pcm:
				frame = append(frame, p...)
				for len(frame) >= audioFrame*audioChannels {
					packet, err := enc.encode(frame[:audioFrame*audioChannels])
					frame = frame[:copy(frame, frame[audioFrame*audioChannels:])]
					if err != nil {
						log.Printf("audio encoding: %v", err)
						continue
					}
					deliver(packet)
				}
			}
		}
	}()
	stream.Start()
	stop := func() {
		stream.Close()
		client.Close()
		close(done)
	}
	return stop, nil
}

// streamAudio sends l's packets through the tunnel c: a JSON
// description of the stream, then one Opus packet per binary message.
func streamAudio(c msgConn, l *audioListener) {
	ctx := c.CloseRead(context.Background()) // nothing is read; ends when the client goes
	send := func(typ websocket.MessageType, p []byte) error {
		ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		return c.Write(ctx, typ, p)
	}
	if send(websocket.MessageText, []byte(audioConfig)) != nil {
		return
	}
	for {
		select {
		case p := <-l.packets:
			if send(websocket.MessageBinary, p) != nil {
				return
			}
		case <-l.gone:
			c.Close(websocket.StatusNormalClosure, "desktop disconnected")
			return
		case <-ctx.Done():
			return
		}
	}
}
