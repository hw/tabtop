package main

// Save stream for HLS playlists of MPEG-TS segments (no EXT-X-MAP), as
// many sites still serve: each segment's video (H.264 or H.265) and sound
// (AAC, in ADTS frames, or MP3) taken out of its transport stream and put in an
// MP4 fragment, so the stream's saved as the one MP4 a fragmented MP4
// stream is (gosavestream.go writes them as it does those). Its header is
// made from the first segment's: the video's parameter sets, the sound's
// format. Times are the stream's own (its 90 kHz clock), from the
// earliest of its tracks' first, so a sound rendition of its own stays in
// step with the video; past a discontinuity (#EXT-X-DISCONTINUITY: another
// clock, an ad's, say) they go on from where they were.

import (
	"bytes"
	"errors"
	"fmt"

	"github.com/Eyevinn/mp4ff/aac"
	"github.com/Eyevinn/mp4ff/avc"
	"github.com/Eyevinn/mp4ff/mp4"
)

const (
	tsPacket    = 188
	tsClockRate = 90000
	tsWrap      = 1 << 33 // where a PTS or DTS starts again from 0
	aacFrame    = 1024    // samples in an AAC frame
)

// tsClock is when a stream's tracks start, on its 90 kHz clock: the
// earliest of their first times, shared by its renditions' remuxers.
type tsClock struct {
	origin int64
	set    bool
}

func (c *tsClock) saw(t int64) {
	if !c.set || t < c.origin {
		c.origin, c.set = t, true
	}
}

// tsStream is an elementary stream of the segments: the video's or the
// sound's.
type tsStream struct {
	pid     uint16
	video   bool
	hevc    bool
	trackID uint32 // in the header tsRemux makes

	pes      []byte // the PES packet being gathered
	last     int64  // the last time read, unwrapped (for the next's wrap)
	lastRead bool

	// The video's parameter sets, as the header has them; the sound's format.
	vps, sps, pps [][]byte
	rate          int
	objType       byte // AAC's audio object type; MPEG audio's object type indication (MP3's)
	channels      byte
	mp3           bool // MPEG audio (MP3), not AAC

	held    *mp4.FullSample // the video's last sample: its duration is known with the next's time
	lastDur uint32
	next    uint64 // the sound's next frame's decode time (its own timescale)
	started bool
	carry   []byte // an ADTS frame cut off at a PES's end
	samples []mp4.FullSample
}

// tsRemux takes a playlist's segments, in turn, out of MPEG-TS into MP4.
type tsRemux struct {
	clock   *tsClock
	pmt     uint16
	pmtRead bool
	streams map[uint16]*tsStream
	video   *tsStream
	audio   *tsStream
	shift   int64 // added to times past a discontinuity, so they go on
	jumped  bool  // a discontinuity's segment, its first time not yet read
	probing bool  // reading the first segment for the header: no samples kept
	first   int64 // (probing) the earliest time read
	firstOK bool
}

// tsRecover has a panic in reading a stream a website sent (mp4ff's, on a
// malformed parameter set, say) be an error, not the end of tabtopd: the
// save runs in a fetch's goroutine.
func tsRecover(err *error) {
	if r := recover(); r != nil {
		*err = errors.New("the stream's MPEG-TS segments couldn't be read")
	}
}

func newTSRemux(clock *tsClock) *tsRemux {
	return &tsRemux{clock: clock, streams: map[uint16]*tsStream{}}
}

// probe reads the first segment for what the header needs, and when the
// stream starts (told to the clock).
func (r *tsRemux) probe(seg []byte) (err error) {
	defer tsRecover(&err)
	r.probing = true
	defer func() { r.probing = false }()
	if err := r.read(seg); err != nil {
		return err
	}
	if r.video == nil && r.audio == nil {
		return errors.New("Save stream found no H.264, H.265, AAC or MP3 track in the stream's segments")
	}
	if r.video != nil && len(r.video.sps) == 0 {
		return errors.New("the stream's first segment has no video parameter sets")
	}
	if r.audio != nil && r.audio.rate == 0 {
		return errors.New("the stream's first segment has no sound frames")
	}
	if r.firstOK {
		r.clock.saw(r.first)
	}
	// Read again from the start, for its samples.
	for _, s := range r.streams {
		s.lastRead, s.pes = false, nil
	}
	return nil
}

// header is the MP4 header for the stream's tracks: the video (track 1)
// and the sound.
func (r *tsRemux) header() (init *mp4.InitSegment, err error) {
	defer tsRecover(&err)
	init = mp4.CreateEmptyInit()
	if v := r.video; v != nil {
		trak := init.AddEmptyTrack(tsClockRate, "video", "und")
		var err error
		if v.hevc {
			err = trak.SetHEVCDescriptor("hvc1", v.vps, v.sps, v.pps, nil, true)
		} else {
			err = trak.SetAVCDescriptor("avc1", v.sps, v.pps, true)
		}
		if err != nil {
			return nil, fmt.Errorf("the stream's video: %w", err)
		}
		v.trackID = trak.Tkhd.TrackID
	}
	if a := r.audio; a != nil {
		trak := init.AddEmptyTrack(uint32(a.rate), "audio", "und")
		if a.mp3 {
			// MP3 in MP4: an mp4a entry, its object type MPEG audio's, with
			// no decoder config (each frame's header says its format).
			esds := mp4.CreateEsdsBox(nil)
			esds.ESDescriptor.DecConfigDescriptor.ObjectType = a.objType
			esds.ESDescriptor.DecConfigDescriptor.DecSpecificInfo = nil
			trak.Mdia.Minf.Stbl.Stsd.AddChild(mp4.CreateAudioSampleEntryBox("mp4a", uint16(a.channels), 16, uint16(a.rate), esds))
		} else if err := trak.SetAACDescriptorWithChannelConfig(a.objType, a.channels, a.rate); err != nil {
			return nil, fmt.Errorf("the stream's sound: %w", err)
		}
		a.trackID = trak.Tkhd.TrackID
	}
	return init, nil
}

// segment is a segment's samples as an MP4 fragment (its track IDs the
// header's, its sequence number seq), or nil if it has none (yet: the
// video's last sample is held for the next segment).
func (r *tsRemux) segment(seg []byte, discontinuity bool, seq uint32) (frag []byte, err error) {
	defer tsRecover(&err)
	if discontinuity {
		r.jumped = true
		for _, s := range r.streams {
			s.lastRead = false // (another clock: not a wrap of this one)
		}
	}
	if err := r.read(seg); err != nil {
		return nil, err
	}
	return r.fragment(seq)
}

// finish is the last samples (the video's held one) as a fragment.
func (r *tsRemux) finish(seq uint32) (frag []byte, err error) {
	defer tsRecover(&err)
	if v := r.video; v != nil && v.held != nil {
		v.held.Dur = max(v.lastDur, 1)
		v.samples = append(v.samples, *v.held)
		v.held = nil
	}
	return r.fragment(seq)
}

func (r *tsRemux) fragment(seq uint32) ([]byte, error) {
	var ids []uint32
	for _, s := range []*tsStream{r.video, r.audio} {
		if s != nil && len(s.samples) > 0 {
			ids = append(ids, s.trackID)
		}
	}
	if len(ids) == 0 {
		return nil, nil
	}
	frag, err := mp4.CreateMultiTrackFragment(seq, ids)
	if err != nil {
		return nil, err
	}
	for _, s := range []*tsStream{r.video, r.audio} {
		if s == nil {
			continue
		}
		for _, sample := range s.samples {
			if err := frag.AddFullSampleToTrack(sample, s.trackID); err != nil {
				return nil, err
			}
		}
		s.samples = s.samples[:0]
	}
	var out bytes.Buffer
	if err := frag.Encode(&out); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// read goes through a segment's transport stream packets: its tables, then
// its streams' PES packets, each gathered and taken as it ends (the next
// one's start, or the segment's end).
func (r *tsRemux) read(seg []byte) error {
	at := tsSync(seg, 0)
	if at < 0 {
		if bytes.HasPrefix(seg, []byte("ID3")) || len(seg) > 1 && seg[0] == 0xff && seg[1]&0xf0 == 0xf0 {
			return errors.New("Save stream doesn't support packed audio segments")
		}
		return errors.New("Save stream requires fragmented MP4 or MPEG-TS segments")
	}
	for at+tsPacket <= len(seg) {
		p := seg[at : at+tsPacket]
		if p[0] != 0x47 {
			if at = tsSync(seg, at+1); at < 0 {
				break
			}
			continue
		}
		at += tsPacket
		start := p[1]&0x40 != 0
		pid := uint16(p[1]&0x1f)<<8 | uint16(p[2])
		control := p[3] >> 4 & 3
		payload := p[4:]
		if control&2 != 0 {
			if len(payload) == 0 || int(payload[0])+1 > len(payload) {
				continue
			}
			payload = payload[int(payload[0])+1:]
		}
		if control&1 == 0 || len(payload) == 0 {
			continue
		}
		switch {
		case pid == 0:
			if start {
				r.pat(payload)
			}
		case r.pmtRead && pid == r.pmt:
			if start {
				if err := r.pmtTable(payload); err != nil {
					return err
				}
			}
		default:
			s := r.streams[pid]
			if s == nil {
				continue
			}
			if start {
				if err := r.pesDone(s); err != nil {
					return err
				}
				s.pes = append(s.pes[:0], payload...)
			} else if s.pes != nil {
				s.pes = append(s.pes, payload...)
			}
		}
	}
	for _, s := range []*tsStream{r.video, r.audio} {
		if s != nil {
			if err := r.pesDone(s); err != nil {
				return err
			}
		}
	}
	return nil
}

// tsSync is where packets start in seg, from at: a sync byte with another a
// packet on (or the end), -1 if none.
func tsSync(seg []byte, at int) int {
	for i := at; i+tsPacket <= len(seg); i++ {
		if seg[i] == 0x47 && (i+2*tsPacket > len(seg) || seg[i+tsPacket] == 0x47) {
			return i
		}
	}
	return -1
}

// psiSection is a table's section in a packet's payload (after its
// pointer field), cut to its length, without its CRC.
func psiSection(payload []byte) []byte {
	if len(payload) < 1 || int(payload[0])+1 > len(payload) {
		return nil
	}
	s := payload[int(payload[0])+1:]
	if len(s) < 3 {
		return nil
	}
	n := int(s[1]&0x0f)<<8 | int(s[2])
	if n < 9 || 3+n > len(s) {
		return nil
	}
	return s[:3+n-4]
}

func (r *tsRemux) pat(payload []byte) {
	s := psiSection(payload)
	if s == nil || s[0] != 0 {
		return
	}
	for i := 8; i+4 <= len(s); i += 4 {
		if program := uint16(s[i])<<8 | uint16(s[i+1]); program != 0 {
			r.pmt, r.pmtRead = uint16(s[i+2]&0x1f)<<8|uint16(s[i+3]), true
			return
		}
	}
}

func (r *tsRemux) pmtTable(payload []byte) error {
	s := psiSection(payload)
	if s == nil || s[0] != 2 || len(s) < 12 {
		return nil
	}
	i := 12 + (int(s[10]&0x0f)<<8 | int(s[11]))
	var otherSound string
	for i+5 <= len(s) {
		kind, pid := s[i], uint16(s[i+1]&0x1f)<<8|uint16(s[i+2])
		i += 5 + (int(s[i+3]&0x0f)<<8 | int(s[i+4]))
		switch kind {
		case 0x1b, 0x24: // H.264, H.265
			if r.video == nil {
				r.video = &tsStream{pid: pid, video: true, hevc: kind == 0x24}
				r.streams[pid] = r.video
			}
		case 0x0f: // AAC, in ADTS
			if r.audio == nil {
				r.audio = &tsStream{pid: pid}
				r.streams[pid] = r.audio
			}
		case 0x03, 0x04: // MPEG audio (MP3)
			if r.audio == nil {
				r.audio = &tsStream{pid: pid, mp3: true}
				r.streams[pid] = r.audio
			}
		case 0x81, 0x87:
			otherSound = "AC-3"
		case 0x11:
			otherSound = "AAC in LATM"
		}
	}
	if r.audio == nil && otherSound != "" && r.probing {
		// (Saved without it, it'd be a video with no sound, unsaid.)
		return fmt.Errorf("Save stream can't keep the stream's sound (%s)", otherSound)
	}
	return nil
}

// tsTime reads a PES header's 33-bit time.
func tsTime(b []byte) int64 {
	return int64(b[0]>>1&7)<<30 | int64(b[1])<<22 | int64(b[2]>>1)<<15 | int64(b[3])<<7 | int64(b[4]>>1)
}

// unwrap has t go on from s's last time across the clock's wrap.
func (s *tsStream) unwrap(t int64) int64 {
	if s.lastRead {
		for t < s.last-tsWrap/2 {
			t += tsWrap
		}
		for t > s.last+tsWrap/2 {
			t -= tsWrap
		}
	}
	s.last, s.lastRead = t, true
	return t
}

// pesDone takes s's PES packet gathered: its times, and its video sample or
// its sound's frames.
func (r *tsRemux) pesDone(s *tsStream) error {
	p := s.pes
	s.pes = nil
	if len(p) < 9 || p[0] != 0 || p[1] != 0 || p[2] != 1 {
		return nil
	}
	flags, size := p[7], int(p[8])
	if 9+size > len(p) || flags&0x80 == 0 || size < 5 {
		return nil // (no time: not one to place)
	}
	pts := tsTime(p[9:])
	dts := pts
	if flags&0x40 != 0 && size >= 10 {
		dts = tsTime(p[14:])
	}
	pts = pts - dts // (as an offset, from the decode time)
	dts = s.unwrap(dts)
	data := p[9+size:]
	if r.probing {
		if !r.firstOK || dts < r.first {
			r.first, r.firstOK = dts, true
		}
	} else if r.jumped {
		// Past a discontinuity: on from where the stream was.
		r.jumped = false
		r.shift = r.expected() - (dts - r.clock.origin)
	}
	at := dts - r.clock.origin + r.shift
	if s.video {
		return r.videoSample(s, data, max(at, 0), int32(pts))
	}
	return r.audioFrames(s, data, at)
}

// expected is when the stream's next sample would have been (on the 90 kHz
// clock, from its start), as it's gone so far.
func (r *tsRemux) expected() int64 {
	if v := r.video; v != nil && v.held != nil {
		return int64(v.held.DecodeTime) + int64(v.lastDur)
	}
	if a := r.audio; a != nil && a.started {
		return int64(a.next) * tsClockRate / int64(a.rate)
	}
	return 0
}

func (r *tsRemux) videoSample(s *tsStream, data []byte, at int64, offset int32) error {
	var vps, sps, pps [][]byte
	var sample []byte
	sync := false
	for _, nalu := range avc.ExtractNalusFromByteStream(data) {
		if len(nalu) == 0 {
			continue
		}
		var keep bool
		if s.hevc {
			if len(nalu) < 2 {
				continue
			}
			switch kind := nalu[0] >> 1 & 0x3f; {
			case kind == 32:
				vps = append(vps, nalu)
				keep = !inSets(s.vps, nalu)
			case kind == 33:
				sps = append(sps, nalu)
				keep = !inSets(s.sps, nalu)
			case kind == 34:
				pps = append(pps, nalu)
				keep = !inSets(s.pps, nalu)
			case kind == 35: // an access unit delimiter
			default:
				keep = true
				sync = sync || kind >= 16 && kind <= 21
			}
		} else {
			switch kind := nalu[0] & 0x1f; kind {
			case 7:
				sps = append(sps, nalu)
				keep = !inSets(s.sps, nalu)
			case 8:
				pps = append(pps, nalu)
				keep = !inSets(s.pps, nalu)
			case 9: // an access unit delimiter
			default:
				keep = true
				sync = sync || kind == 5
			}
		}
		if keep {
			sample = append(sample, byte(len(nalu)>>24), byte(len(nalu)>>16), byte(len(nalu)>>8), byte(len(nalu)))
			sample = append(sample, nalu...)
		}
	}
	if r.probing {
		// The header's parameter sets: the first segment's first.
		if len(s.sps) == 0 && len(sps) > 0 && len(pps) > 0 && (!s.hevc || len(vps) > 0) {
			s.vps, s.sps, s.pps = vps, sps, pps
		}
		return nil
	}
	if len(sample) == 0 {
		return nil
	}
	flags := mp4.NonSyncSampleFlags
	if sync {
		flags = mp4.SyncSampleFlags
	}
	if s.held != nil {
		if d := at - int64(s.held.DecodeTime); d > 0 && d < 10*tsClockRate {
			s.lastDur = uint32(d)
		}
		s.held.Dur = max(s.lastDur, 1)
		s.samples = append(s.samples, *s.held)
		if at < int64(s.held.DecodeTime)+int64(s.held.Dur) {
			at = int64(s.held.DecodeTime) + int64(s.held.Dur) // (never back in time)
		}
	}
	s.held = &mp4.FullSample{Sample: mp4.NewSample(flags, 0, uint32(len(sample)), max(offset, 0)), DecodeTime: uint64(at), Data: sample}
	return nil
}

func inSets(sets [][]byte, nalu []byte) bool {
	for _, s := range sets {
		if bytes.Equal(s, nalu) {
			return true
		}
	}
	return false
}

// audioFrames takes a PES packet's sound frames (AAC's in ADTS, or MP3's):
// each a sample, one after another; the first at the packet's time if
// that's more than a frame from where they'd got to (a gap, a jump).
func (r *tsRemux) audioFrames(s *tsStream, data []byte, at int64) error {
	if len(s.carry) > 0 {
		data = append(s.carry, data...)
		s.carry = nil
	}
	read := aacFrameAt
	if s.mp3 {
		read = mp3FrameAt
	}
	for len(data) >= 7 {
		f := read(data)
		if f.length == 0 {
			data = data[1:] // (not a frame's start: on to one)
			continue
		}
		if f.length > len(data) {
			s.carry = append([]byte(nil), data...)
			return nil
		}
		data = data[f.length:]
		if s.rate == 0 {
			if f.layer != 0 && f.layer != 3 {
				return fmt.Errorf("Save stream can't keep the stream's sound (MPEG audio layer %d)", f.layer)
			}
			s.rate, s.objType, s.channels = f.rate, f.objType, f.channels
		}
		if r.probing {
			continue
		}
		if f.rate != s.rate {
			return errors.New("the stream's sound changes its sample rate partway")
		}
		dur := uint64(f.samples)
		when := uint64(max(at, 0) * int64(s.rate) / tsClockRate)
		if !s.started || when > s.next+dur || when+dur < s.next && at >= 0 {
			if s.started && when < s.next {
				when = s.next // (never back in time)
			}
			s.next, s.started = when, true
		}
		s.samples = append(s.samples, mp4.FullSample{Sample: mp4.NewSample(mp4.SyncSampleFlags, uint32(dur), uint32(len(f.payload)), 0), DecodeTime: s.next, Data: f.payload})
		s.next += dur
		at = -1 // (the packet's later frames: one after another)
	}
	return nil
}

// soundFrame is a sound frame at the start of some data: its length there
// (0: not a frame's start), what's kept of it as a sample, how many of the
// sound's samples it holds, and the sound's format.
type soundFrame struct {
	length, samples, rate int
	payload               []byte
	objType, channels     byte
	layer                 int // (MPEG audio's)
}

// aacFrameAt reads an ADTS frame: kept without its header (the MP4's
// header has the sound's format).
func aacFrameAt(data []byte) soundFrame {
	if data[0] != 0xff || data[1]&0xf6 != 0xf0 {
		return soundFrame{}
	}
	headerLen := 7
	if data[1]&1 == 0 {
		headerLen = 9 // with a CRC
	}
	f := soundFrame{
		objType:  data[2]>>6 + 1,
		rate:     aac.FrequencyTable[data[2]>>2&0x0f],
		channels: data[2]&1<<2 | data[3]>>6,
		length:   int(data[3]&3)<<11 | int(data[4])<<3 | int(data[5]>>5),
		samples:  aacFrame * (int(data[6]&3) + 1),
	}
	if f.rate == 0 || f.length < headerLen {
		return soundFrame{}
	}
	if f.length <= len(data) {
		f.payload = data[headerLen:f.length]
	}
	return f
}

// MPEG audio's bit rates (kbit/s), by version (1; 2 and 2.5) and layer
// (I, II, III), and sample rates by version (1, 2, 2.5).
var (
	mpegRates = [2][3][15]int{
		{{0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448},
			{0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384},
			{0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320}},
		{{0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256},
			{0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160},
			{0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160}},
	}
	mpegSampleRates = [3][3]int{{44100, 48000, 32000}, {22050, 24000, 16000}, {11025, 12000, 8000}}
)

// mp3FrameAt reads an MPEG audio frame: kept whole, as MP4 keeps MP3's.
// Its object type is MPEG-1 audio's (0x6b) or, at MPEG-2's lower rates,
// MPEG-2's (0x69).
func mp3FrameAt(data []byte) soundFrame {
	if data[0] != 0xff || data[1]&0xe0 != 0xe0 {
		return soundFrame{}
	}
	version, layerBits := data[1]>>3&3, data[1]>>1&3
	rateIndex, sampleIndex := int(data[2]>>4), int(data[2]>>2&3)
	if version == 1 || layerBits == 0 || rateIndex == 0 || rateIndex == 15 || sampleIndex == 3 {
		return soundFrame{} // (reserved, or a free bit rate: not a frame to place)
	}
	layer := 4 - int(layerBits) // 1, 2 or 3
	v, objType := 0, byte(0x6b)
	sampleRates := mpegSampleRates[0]
	switch version {
	case 2:
		v, objType, sampleRates = 1, 0x69, mpegSampleRates[1]
	case 0:
		v, objType, sampleRates = 1, 0x69, mpegSampleRates[2]
	}
	bitRate := mpegRates[v][layer-1][rateIndex] * 1000
	rate := sampleRates[sampleIndex]
	padding := int(data[2] >> 1 & 1)
	f := soundFrame{rate: rate, objType: objType, layer: layer, channels: 2}
	if data[3]>>6 == 3 {
		f.channels = 1
	}
	switch {
	case layer == 1:
		f.length, f.samples = (12*bitRate/rate+padding)*4, 384
	case layer == 2 || v == 0:
		f.length, f.samples = 144*bitRate/rate+padding, 1152
	default: // layer III, MPEG-2 or 2.5
		f.length, f.samples = 72*bitRate/rate+padding, 576
	}
	if f.length < 4 {
		return soundFrame{}
	}
	if f.length <= len(data) {
		f.payload = data[:f.length]
	}
	return f
}
