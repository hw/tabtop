package main

// The browser's microphone, the other way from desktop audio (audio.go):
// audio.js records it, encodes it as Opus with WebCodecs and sends the
// packets through the encrypted tunnel; the gateway decodes them and plays
// them into a null sink (-mic-sink), whose monitor the desktop's PipeWire
// offers as the default microphone (see startup/desktop.sh).
//
// Like audio, a microphone needs the session to have the desktop open from
// the same IP, and stops when that goes.

import (
	"context"
	"errors"
	"fmt"
	"log"
	"slices"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/jfreymuth/pulse"
	"github.com/jfreymuth/pulse/proto"
)

const (
	micRate = 48000
	// Most audio held for the desktop, 200 ms: past that the oldest goes, so
	// a burst after a stall, or the browser's clock running a little fast
	// against PipeWire's, can't build up delay.
	micMaxBuffer = micRate / 5
	// Largest packet taken: a 120 ms Opus frame at its highest bitrate is
	// under 2 KB.
	micMaxPacket = 4 << 10
	// The latency asked of PipeWire for the playback.
	micLatency = 0.02
)

// micBuffer holds decoded samples until PipeWire asks for them.
type micBuffer struct {
	mu      sync.Mutex
	samples []int16
}

// push adds samples, dropping the oldest past micMaxBuffer.
func (b *micBuffer) push(p []int16) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.samples = append(b.samples, p...)
	if over := len(b.samples) - micMaxBuffer; over > 0 {
		b.samples = b.samples[:copy(b.samples, b.samples[over:])]
	}
}

// read fills out with what's held and silence after it: PipeWire's reader
// must always give all it asks for (the pulse library spins otherwise).
func (b *micBuffer) read(out []int16) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := copy(out, b.samples)
	b.samples = b.samples[:copy(b.samples, b.samples[n:])]
	clear(out[n:])
	return len(out), nil
}

// playMic plays buf into sink until the returned function is called.
func playMic(sink string, buf *micBuffer) (func(), error) {
	client, err := pulse.NewClient(pulse.ClientApplicationName("tabtopd"), pulse.ClientTimeout(5*time.Second))
	if err != nil {
		return nil, fmt.Errorf("connecting to the audio server: %w", err)
	}
	s, err := client.SinkByID(sink)
	if err != nil {
		client.Close()
		return nil, fmt.Errorf("finding microphone sink %q: %w", sink, err)
	}
	stream, err := client.NewPlayback(pulse.Int16Reader(buf.read), pulse.PlaybackMono,
		pulse.PlaybackSampleRate(micRate), pulse.PlaybackSink(s),
		pulse.PlaybackLatency(micLatency), pulse.PlaybackMediaName("microphone from the browser"))
	if err != nil {
		client.Close()
		return nil, fmt.Errorf("playing into microphone sink %q: %w", sink, err)
	}
	stream.Start()
	return func() {
		stream.Close()
		client.Close()
	}, nil
}

var errNoMic = errors.New("no microphone")

// joinMic starts a microphone for session token from ip, which must have
// the desktop open: errAudioDenied otherwise, or errNoMic if there's no
// microphone sink. The returned listener's gone closes when the desktop
// does.
func (h *audioHub) joinMic(token, ip string) (*audioListener, *micBuffer, func(), error) {
	if h.play == nil {
		return nil, nil, nil, errNoMic
	}
	h.mu.Lock()
	if token == "" || h.desktops[token][ip] <= 0 {
		h.mu.Unlock()
		return nil, nil, nil, errAudioDenied
	}
	l := &audioListener{token: token, ip: ip, gone: make(chan struct{})}
	h.mics[l] = struct{}{}
	h.mu.Unlock()
	buf := &micBuffer{}
	stop, err := h.play(buf)
	if err != nil {
		h.leaveMic(l)
		return nil, nil, nil, err
	}
	return l, buf, func() {
		stop()
		h.leaveMic(l)
	}, nil
}

func (h *audioHub) leaveMic(l *audioListener) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.mics, l)
}

// receiveMic decodes the Opus packets c sends into buf, until c closes or
// the desktop goes (l.gone).
func receiveMic(c msgConn, l *audioListener, buf *micBuffer) {
	dec, err := newOpusDecoder(micRate, 1)
	if err != nil {
		log.Printf("microphone: %v", err)
		c.Close(websocket.StatusInternalError, "")
		return
	}
	defer dec.close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		select {
		case <-l.gone:
			c.Close(websocket.StatusNormalClosure, "desktop disconnected")
		case <-ctx.Done():
		}
	}()
	for {
		typ, p, err := c.Read(ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageBinary || len(p) > micMaxPacket {
			c.Close(websocket.StatusPolicyViolation, "bad microphone packet")
			return
		}
		pcm, err := dec.decode(p)
		if err != nil {
			continue // one bad packet is a moment of silence
		}
		buf.push(pcm)
	}
}

// The microphone's devices: a null sink the gateway plays into, and a
// source that offers its monitor as an ordinary microphone. In the full
// image, startup/desktop.sh makes them, as the default source; with the
// host's sound server (-mic-create), the gateway makes them itself there,
// not as the default, and removes them when it stops.
const (
	micSinkName   = "tabtop_mic"
	micSourceName = "tabtop_mic_in"
	micName       = "TabTop Mic"
)

var micModules = []struct{ name, args string }{
	{"module-null-sink", "sink_name=" + micSinkName + ` sink_properties="device.description='` + micName + ` (feed)'"`},
	{"module-remap-source", "master=" + micSinkName + ".monitor source_name=" + micSourceName +
		` source_properties="device.description='` + micName + `'"`},
}

// micDevices makes the microphone's devices on the sound server when
// they're missing, and removes the ones it made.
type micDevices struct {
	mu     sync.Mutex
	loaded []uint32 // modules it loaded, by index
}

// ensure makes the sink and the source, unless they're there already. Ones
// a gateway made with these same modules, left by a run that was killed,
// say, are taken over, to be removed on stopping like its own. (So are
// another gateway's, on the same sound server: whichever stops first takes
// them, and the other makes them again when a browser next turns it on.)
func (d *micDevices) ensure() error {
	d.mu.Lock()
	defer d.mu.Unlock()
	client, err := pulse.NewClient(pulse.ClientApplicationName("tabtopd"), pulse.ClientTimeout(5*time.Second))
	if err != nil {
		return fmt.Errorf("connecting to the audio server: %w", err)
	}
	defer client.Close()
	var modules proto.GetModuleInfoListReply
	if err := client.RawRequest(&proto.GetModuleInfoList{}, &modules); err != nil {
		return fmt.Errorf("listing the audio server's modules: %w", err)
	}
	exists := []func() bool{
		func() bool { _, err := client.SinkByID(micSinkName); return err == nil },
		func() bool { _, err := client.SourceByID(micSourceName); return err == nil },
	}
	for i, m := range micModules {
		if exists[i]() {
			for _, info := range modules {
				if info.ModuleName == m.name && info.ModuleArgs == m.args && !slices.Contains(d.loaded, info.ModuleIndex) {
					d.loaded = append(d.loaded, info.ModuleIndex)
					log.Printf("took over %s's %s, left on the audio server (module %d)", micName, m.name, info.ModuleIndex)
				}
			}
			continue
		}
		var reply proto.LoadModuleReply
		if err := client.RawRequest(&proto.LoadModule{Name: m.name, Args: m.args}, &reply); err != nil {
			return fmt.Errorf("making %s's %s: %w", micName, m.name, err)
		}
		d.loaded = append(d.loaded, reply.ModuleIndex)
		log.Printf("made %s's %s on the audio server (module %d)", micName, m.name, reply.ModuleIndex)
	}
	return nil
}

// remove unloads the modules ensure loaded, the source first.
func (d *micDevices) remove() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.loaded) == 0 {
		return
	}
	client, err := pulse.NewClient(pulse.ClientApplicationName("tabtopd"), pulse.ClientTimeout(time.Second))
	if err != nil {
		log.Printf("removing %s: %v", micName, err)
		return
	}
	defer client.Close()
	for _, index := range slices.Backward(d.loaded) {
		if err := client.RawRequest(&proto.UnloadModule{ModuleIndex: index}, nil); err != nil {
			log.Printf("removing %s's module %d: %v", micName, index, err)
		}
	}
	d.loaded = nil
	log.Printf("removed %s from the audio server", micName)
}
