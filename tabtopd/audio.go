package main

// Desktop audio. Chromium plays into a PipeWire null sink; while anyone is
// listening, the gateway records the sink's monitor over the PulseAudio
// protocol (pipewire-pulse), encodes 10 ms Opus frames and sends them out:
//
//	/audio/ws          one Opus packet per WebSocket message, for the
//	                   low-latency player in audio.js (WebCodecs, so HTTPS
//	                   or localhost only)
//	/audio/stream.ogg  the same packets as an Ogg Opus stream, for an
//	                   <audio> element on plain HTTP; browsers buffer it, so
//	                   it lags by a second or more
//
// The desktop login happens inside RFB, so the browser has no credential an
// audio request could carry. Instead, loading vnc.html sets a random audio
// cookie; noVNC's /websockify request carries it, and once that connection
// logs in, the cookie may fetch audio from that connection's IP until the
// connection closes. Requiring the IP too means a cookie planted by someone
// else (say, a sibling subdomain) only works from the victim's own address.
// Audio requests never take a TOTP code, so they're no way around the login
// limit.

import (
	"context"
	"crypto/rand"
	_ "embed"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"slices"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/jfreymuth/pulse"
)

const (
	audioCookie   = "tabtop_audio"
	audioRate     = 48000
	audioChannels = 2
	audioFrame    = audioRate / 100 // samples per channel in a 10 ms frame
	// Bitrate range in kbit/s. Below the minimum, the constant-rate stream
	// gets too thin for Chromium's <audio> element to start promptly.
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
)

//go:embed audio.js
var audioJS []byte

var audioConfig = fmt.Sprintf(`{"codec":"opus","sampleRate":%d,"channels":%d,"frameMs":10}`, audioRate, audioChannels)

var errAudioDenied = errors.New("no logged-in desktop connection for this audio cookie and IP")

type audioHub struct {
	// start begins recording, calling deliver with each Opus packet, and
	// returns a function that stops it and the stream's pre-skip.
	start func(deliver func([]byte)) (stop func(), preSkip int, err error)
	grace time.Duration
	idle  time.Duration

	mu        sync.Mutex
	desktops  map[string]map[string]int // audio cookie -> client IP -> logged-in desktop connections
	listeners map[*audioListener]struct{}
	stop      func() // stops recording; nil when not recording
	preSkip   int
	idleTimer *time.Timer
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
		start:     func(deliver func([]byte)) (func(), int, error) { return recordSink(sink, kbps*1000, deliver) },
		grace:     audioGrace,
		idle:      audioIdle,
		desktops:  map[string]map[string]int{},
		listeners: map[*audioListener]struct{}{},
	}
}

// token returns r's audio cookie, or "" when audio is off or it has none.
func (h *audioHub) token(r *http.Request) string {
	if h == nil {
		return ""
	}
	c, err := r.Cookie(audioCookie)
	if err != nil {
		return ""
	}
	return c.Value
}

// setCookie gives a browser loading noVNC an audio cookie for the site's
// base path, unless it already has one. Until a desktop login vouches for
// it, the cookie grants nothing.
func (h *audioHub) setCookie(w http.ResponseWriter, r *http.Request, path string, secure bool) {
	if h == nil || h.token(r) != "" {
		return
	}
	b := make([]byte, 32)
	rand.Read(b)
	http.SetCookie(w, &http.Cookie{Name: audioCookie, Value: base64.RawURLEncoding.EncodeToString(b),
		Path: path, HttpOnly: true, Secure: secure, SameSite: http.SameSiteStrictMode})
}

// link records a logged-in desktop connection made with token from ip.
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
}

// unlink records that a linked desktop connection closed. If no other one
// from the same IP is open after the grace period, the listeners for token
// from that IP are stopped.
func (h *audioHub) unlink(token, ip string) {
	if h == nil || token == "" {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.desktops[token][ip]--; h.desktops[token][ip] > 0 {
		return
	}
	time.AfterFunc(h.grace, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if h.desktops[token][ip] > 0 {
			return
		}
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
func (h *audioHub) join(token, ip string) (*audioListener, int, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if token == "" || h.desktops[token][ip] <= 0 {
		return nil, 0, errAudioDenied
	}
	if h.idleTimer != nil {
		h.idleTimer.Stop()
		h.idleTimer = nil
	}
	if h.stop == nil {
		stop, preSkip, err := h.start(h.deliver)
		if err != nil {
			return nil, 0, err
		}
		h.stop, h.preSkip = stop, preSkip
		log.Printf("audio recording started")
	}
	l := &audioListener{token: token, ip: ip, packets: make(chan []byte, audioQueue), gone: make(chan struct{})}
	h.listeners[l] = struct{}{}
	return l, h.preSkip, nil
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
	h.idleTimer = time.AfterFunc(h.idle, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		h.idleTimer = nil
		if len(h.listeners) > 0 || h.stop == nil {
			return
		}
		h.stop()
		h.stop = nil
		log.Printf("audio recording stopped: no listeners")
	})
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
func recordSink(sink string, bitrate int, deliver func([]byte)) (func(), int, error) {
	enc, err := newOpusEncoder(audioRate, audioChannels, bitrate)
	if err != nil {
		return nil, 0, err
	}
	preSkip := enc.lookahead()
	client, err := pulse.NewClient(pulse.ClientApplicationName("tabtopd"), pulse.ClientTimeout(5*time.Second))
	if err != nil {
		enc.close()
		return nil, 0, fmt.Errorf("connecting to the audio server: %w", err)
	}
	s, err := client.SinkByID(sink)
	if err != nil {
		client.Close()
		enc.close()
		return nil, 0, fmt.Errorf("finding audio sink %q: %w", sink, err)
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
		return nil, 0, fmt.Errorf("recording audio sink %q: %w", sink, err)
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
	return stop, preSkip, nil
}

func (g *server) audioScript(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	if g.audio == nil {
		io.WriteString(w, "// Desktop audio is turned off (WEB_AUDIO=0).\n")
		return
	}
	w.Write(audioJS)
}

func (g *server) joinAudio(w http.ResponseWriter, r *http.Request, kind string) (*audioListener, int, bool) {
	if g.audio == nil {
		http.NotFound(w, r)
		return nil, 0, false
	}
	ip := g.clientIP(r)
	l, preSkip, err := g.audio.join(g.audio.token(r), ip)
	switch {
	case errors.Is(err, errAudioDenied):
		http.Error(w, "log in to the desktop first", http.StatusForbidden)
		return nil, 0, false
	case err != nil:
		log.Printf("audio: %v", err)
		http.Error(w, "audio is unavailable", http.StatusServiceUnavailable)
		return nil, 0, false
	}
	log.Printf("audio %s listener from %s joined", kind, ip)
	return l, preSkip, true
}

func (g *server) leaveAudio(r *http.Request, l *audioListener, kind string) {
	g.audio.leave(l)
	log.Printf("audio %s listener from %s left", kind, g.clientIP(r))
}

// audioWS sends a JSON description of the stream, then one Opus packet per
// binary message. Accept rejects cross-origin requests.
func (g *server) audioWS(w http.ResponseWriter, r *http.Request) {
	l, _, ok := g.joinAudio(w, r, "websocket")
	if !ok {
		return
	}
	defer g.leaveAudio(r, l, "websocket")
	c, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer c.CloseNow()
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

func (g *server) audioOgg(w http.ResponseWriter, r *http.Request) {
	l, preSkip, ok := g.joinAudio(w, r, "ogg")
	if !ok {
		return
	}
	defer g.leaveAudio(r, l, "ogg")
	h := w.Header()
	h.Set("Content-Type", "audio/ogg")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	rc := http.NewResponseController(w)
	ow := newOggWriter(w)
	write := func(f func() error) bool {
		rc.SetWriteDeadline(time.Now().Add(10 * time.Second))
		return f() == nil && rc.Flush() == nil
	}
	if !write(func() error { return ow.writeHeaders(preSkip) }) {
		return
	}
	for {
		select {
		case p := <-l.packets:
			if !write(func() error { return ow.writePacket(p, audioFrame) }) {
				return
			}
		case <-l.gone:
			return
		case <-r.Context().Done():
			return
		}
	}
}

// oggWriter writes an Ogg Opus stream (RFC 7845), one packet per page so
// each one reaches the browser as soon as it's encoded.
type oggWriter struct {
	w       io.Writer
	serial  uint32
	seq     uint32
	granule uint64
}

func newOggWriter(w io.Writer) *oggWriter {
	var b [4]byte
	rand.Read(b[:])
	return &oggWriter{w: w, serial: binary.LittleEndian.Uint32(b[:])}
}

func (o *oggWriter) writeHeaders(preSkip int) error {
	head := []byte("OpusHead\x01")
	head = append(head, audioChannels)
	head = binary.LittleEndian.AppendUint16(head, uint16(preSkip))
	head = binary.LittleEndian.AppendUint32(head, audioRate)
	head = append(head, 0, 0, 0) // output gain, channel mapping family 0
	// 0x02: first page of the stream.
	if err := o.page(0x02, head); err != nil {
		return err
	}
	vendor := "tabtopd"
	tags := binary.LittleEndian.AppendUint32([]byte("OpusTags"), uint32(len(vendor)))
	tags = binary.LittleEndian.AppendUint32(append(tags, vendor...), 0) // no comments
	return o.page(0, tags)
}

func (o *oggWriter) writePacket(packet []byte, samples int) error {
	o.granule += uint64(samples)
	return o.page(0, packet)
}

func (o *oggWriter) page(flags byte, packet []byte) error {
	segments := len(packet)/255 + 1 // a final segment under 255 bytes ends the packet
	p := make([]byte, 27+segments, 27+segments+len(packet))
	copy(p, "OggS")
	p[5] = flags
	binary.LittleEndian.PutUint64(p[6:], o.granule)
	binary.LittleEndian.PutUint32(p[14:], o.serial)
	binary.LittleEndian.PutUint32(p[18:], o.seq)
	p[26] = byte(segments)
	for i := range segments - 1 {
		p[27+i] = 255
	}
	p[27+segments-1] = byte(len(packet) % 255)
	p = append(p, packet...)
	binary.LittleEndian.PutUint32(p[22:], oggCRC(p))
	o.seq++
	_, err := o.w.Write(p)
	return err
}

var oggCRCTable = func() (t [256]uint32) {
	for i := range t {
		c := uint32(i) << 24
		for range 8 {
			if c&0x80000000 != 0 {
				c = c<<1 ^ 0x04c11db7
			} else {
				c <<= 1
			}
		}
		t[i] = c
	}
	return t
}()

// oggCRC is Ogg's page checksum: CRC-32, polynomial 0x04c11db7, not
// reflected, zero initial value and no final XOR.
func oggCRC(b []byte) uint32 {
	var c uint32
	for _, x := range b {
		c = c<<8 ^ oggCRCTable[byte(c>>24)^x]
	}
	return c
}
