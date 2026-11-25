package main

// Save of a clear WebM Media Source stream (gostreammse.go, mse-capture.js):
// each of the page's SourceBuffers is a WebM byte stream of its own, an
// init (the EBML header, its Segment's start, Info, Tracks) and Clusters,
// each staged as the viewer spills them. Saved, they're one WebM: our own
// header, the tracks renumbered, their blocks together in time order in
// clusters of our own (a block's time is 16 bits, relative to its
// cluster's), and Cues, so it can be seeked. Read twice: once for where
// each block is and when, once to write them, so nothing's held whole.
//
// What isn't saved as it is, rather than saved wrong: a track encrypted
// or otherwise encoded (ContentEncodings), tracks of different timescales,
// and (refused as they're staged) parts appended at an offset or within a
// window.

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"math"
	"sort"
)

const (
	ebmlHeaderID          = 0x1A45DFA3
	ebmlSegment           = 0x18538067
	ebmlSeekHead          = 0x114D9B74
	ebmlSeek              = 0x4DBB
	ebmlSeekID            = 0x53AB
	ebmlSeekPosition      = 0x53AC
	ebmlInfo              = 0x1549A966
	ebmlTimecodeScale     = 0x2AD7B1
	ebmlDuration          = 0x4489
	ebmlMuxingApp         = 0x4D80
	ebmlWritingApp        = 0x5741
	ebmlTracks            = 0x1654AE6B
	ebmlTrackEntry        = 0xAE
	ebmlTrackNumber       = 0xD7
	ebmlTrackUID          = 0x73C5
	ebmlTrackType         = 0x83
	ebmlContentEncodings  = 0x6D80
	ebmlCluster           = 0x1F43B675
	ebmlTimecode          = 0xE7
	ebmlSimpleBlock       = 0xA3
	ebmlBlockGroup        = 0xA0
	ebmlBlock             = 0xA1
	ebmlReferenceBlock    = 0xFB
	ebmlCues              = 0x1C53BB6B
	ebmlCuePoint          = 0xBB
	ebmlCueTime           = 0xB3
	ebmlCueTrackPositions = 0xB7
	ebmlCueTrack          = 0xF7
	ebmlCueClusterPos     = 0xF1
	ebmlDocType           = 0x4282
)

// webmTopLevel is the Segment's children: an unknown-sized Cluster ends at
// the next of them.
var webmTopLevel = map[uint32]bool{ebmlCluster: true, ebmlCues: true, ebmlSeekHead: true, ebmlInfo: true, ebmlTracks: true,
	0x1254C367: true /* Tags */, 0x1043A770: true /* Chapters */, 0x1941A469: true /* Attachments */, ebmlHeaderID: true, ebmlSegment: true}

var errWebM = errors.New("the buffered WebM stream isn't one that can be saved")

// isWebM is whether data begins as a WebM (or Matroska) stream does.
func isWebM(data []byte) bool {
	return len(data) >= 4 && binary.BigEndian.Uint32(data) == ebmlHeaderID
}

// ebmlElem is an element of b: its ID, where it starts, where its data
// starts and ends (b's end, for one of unknown size).
type ebmlElem struct {
	id               uint32
	start, data, end int
	unknown          bool
}

// ebmlAt reads the element at b[at:].
func ebmlAt(b []byte, at int) (ebmlElem, error) {
	if at >= len(b) {
		return ebmlElem{}, io.ErrUnexpectedEOF
	}
	first := b[at]
	n := 1
	for mask := byte(0x80); n <= 4 && first&mask == 0; mask >>= 1 {
		n++
	}
	if n > 4 || at+n > len(b) {
		return ebmlElem{}, errWebM
	}
	var id uint32
	for _, c := range b[at : at+n] {
		id = id<<8 | uint32(c)
	}
	size, sn, unknown, err := ebmlSize(b[at+n:])
	if err != nil {
		return ebmlElem{}, err
	}
	e := ebmlElem{id: id, start: at, data: at + n + sn, unknown: unknown}
	if unknown {
		e.end = len(b)
	} else {
		if size > int64(len(b)-e.data) {
			return ebmlElem{}, io.ErrUnexpectedEOF
		}
		e.end = e.data + int(size)
	}
	return e, nil
}

// ebmlSize reads a size (or a block's track number: the same coding).
func ebmlSize(b []byte) (size int64, n int, unknown bool, err error) {
	if len(b) == 0 {
		return 0, 0, false, io.ErrUnexpectedEOF
	}
	n = 1
	for mask := byte(0x80); n <= 8 && b[0]&mask == 0; mask >>= 1 {
		n++
	}
	if n > 8 || n > len(b) {
		return 0, 0, false, errWebM
	}
	v := uint64(b[0] & (0xFF >> n))
	all := v == uint64(0xFF>>n)
	for _, c := range b[1:n] {
		v = v<<8 | uint64(c)
		all = all && c == 0xFF
	}
	if all {
		return 0, n, true, nil
	}
	if v > math.MaxInt64 {
		return 0, 0, false, errWebM
	}
	return int64(v), n, false, nil
}

// ebmlChildren visits the elements of b[from:to]; an unknown-sized one
// ends at to, or at the next element that's one of stop.
func ebmlChildren(b []byte, from, to int, stop map[uint32]bool, visit func(ebmlElem) error) error {
	for at := from; at < to; {
		e, err := ebmlAt(b[:to], at)
		if err != nil {
			return err
		}
		if e.unknown {
			e.end = to
			for c := e.data; c < to; {
				k, err := ebmlAt(b[:to], c)
				if err != nil {
					break
				}
				if stop[k.id] {
					e.end = c
					break
				}
				if k.unknown {
					break
				}
				c = k.end
			}
		}
		if err := visit(e); err != nil {
			return err
		}
		at = e.end
	}
	return nil
}

func ebmlUintOf(b []byte) uint64 {
	var v uint64
	for _, c := range b {
		v = v<<8 | uint64(c)
	}
	return v
}

// Writing.

func ebmlPutID(w *bytes.Buffer, id uint32) {
	switch {
	case id >= 1<<24:
		w.Write([]byte{byte(id >> 24), byte(id >> 16), byte(id >> 8), byte(id)})
	case id >= 1<<16:
		w.Write([]byte{byte(id >> 16), byte(id >> 8), byte(id)})
	case id >= 1<<8:
		w.Write([]byte{byte(id >> 8), byte(id)})
	default:
		w.WriteByte(byte(id))
	}
}

// ebmlSizeLen is the least bytes size takes (all ones being "unknown").
func ebmlSizeLen(size int64) int {
	n := 1
	for n < 8 && uint64(size) >= 1<<(7*n)-1 {
		n++
	}
	return n
}

// ebmlPutSize writes size in width bytes (0: the least).
func ebmlPutSize(w *bytes.Buffer, size int64, width int) {
	if width == 0 {
		width = ebmlSizeLen(size)
	}
	v := uint64(size) | 1<<(7*width)
	for i := width - 1; i >= 0; i-- {
		w.WriteByte(byte(v >> (8 * i)))
	}
}

func ebmlElement(id uint32, payload []byte) []byte {
	var w bytes.Buffer
	ebmlPutID(&w, id)
	ebmlPutSize(&w, int64(len(payload)), 0)
	w.Write(payload)
	return w.Bytes()
}

// ebmlUint is an unsigned integer element, in width bytes (0: the least).
func ebmlUint(id uint32, v uint64, width int) []byte {
	if width == 0 {
		width = 1
		for width < 8 && v >= 1<<(8*width) {
			width++
		}
	}
	p := make([]byte, width)
	for i := width - 1; i >= 0; i-- {
		p[i] = byte(v)
		v >>= 8
	}
	return ebmlElement(id, p)
}

func ebmlFloat(id uint32, f float64) []byte {
	p := make([]byte, 8)
	binary.BigEndian.PutUint64(p, math.Float64bits(f))
	return ebmlElement(id, p)
}

// webmInput is a staged track's: its init, and its parts, read as needed.
type webmInput struct {
	init      []byte
	partCount int
	partAt    func(int) ([]byte, error)
}

// webmTrack is a track of the file to be written.
type webmTrack struct {
	entry []byte // its TrackEntry's children, as the page's
	video bool
	in    int    // its input
	orig  uint64 // its number there
}

// webmBlockAt is a block, where it is (its input's part, and its element
// there) and when (in the timescale's units, from the stream's start).
type webmBlockAt struct {
	track    int // in the file (0-based)
	time     int64
	key      bool
	in, part int
	group    bool
	// Its element there (start, its data, end) and its Block's (a
	// SimpleBlock's: the same), and its track number's length there.
	start, data, end    int
	bStart, bData, bEnd int
	numLen              int
	size                int64 // its element's, as written
}

// webmBlockSizes are a block's payload and element sizes, as written (its
// track number t's length here, not there).
func webmBlockSizes(b *webmBlockAt) (blockPayload, payload int64) {
	blockPayload = int64(b.bEnd-b.bData) - int64(b.numLen) + int64(ebmlSizeLen(int64(b.track+1)))
	if !b.group {
		return blockPayload, blockPayload
	}
	blockElem := 1 + int64(ebmlSizeLen(blockPayload)) + blockPayload
	return blockPayload, int64(b.end-b.data) - int64(b.bEnd-b.bStart) + blockElem
}

// webmBlockHead reads a Block's (or SimpleBlock's) track number, and the
// length of its number, time and flags.
func webmBlockHead(b []byte) (track uint64, head int, rel int16, flags byte, err error) {
	t, n, unknown, err := ebmlSize(b)
	if err != nil || unknown || len(b) < n+3 {
		return 0, 0, 0, 0, errWebM
	}
	return uint64(t), n + 3, int16(binary.BigEndian.Uint16(b[n:])), b[n+2], nil
}

// parseWebMInit is an init's timescale and its tracks' entries.
func parseWebMInit(b []byte) (scale uint64, entries []ebmlElem, err error) {
	h, err := ebmlAt(b, 0)
	if err != nil || h.id != ebmlHeaderID {
		return 0, nil, errWebM
	}
	if err := ebmlChildren(b, h.data, h.end, nil, func(e ebmlElem) error {
		if e.id == ebmlDocType && string(b[e.data:e.end]) != "webm" && string(b[e.data:e.end]) != "matroska" {
			return errWebM
		}
		return nil
	}); err != nil {
		return 0, nil, err
	}
	// The Segment's start: its size (known, or not) runs past the init,
	// which ends where its media begins.
	if len(b) < h.end+4 || binary.BigEndian.Uint32(b[h.end:]) != ebmlSegment {
		return 0, nil, errWebM
	}
	_, sn, _, err := ebmlSize(b[h.end+4:])
	if err != nil {
		return 0, nil, errWebM
	}
	seg := ebmlElem{id: ebmlSegment, start: h.end, data: h.end + 4 + sn}
	scale = 1000000
	end := len(b)
	err = ebmlChildren(b, seg.data, end, webmTopLevel, func(e ebmlElem) error {
		switch e.id {
		case ebmlInfo:
			return ebmlChildren(b, e.data, e.end, nil, func(c ebmlElem) error {
				if c.id == ebmlTimecodeScale {
					scale = ebmlUintOf(b[c.data:c.end])
				}
				return nil
			})
		case ebmlTracks:
			return ebmlChildren(b, e.data, e.end, nil, func(c ebmlElem) error {
				if c.id != ebmlTrackEntry {
					return nil
				}
				entries = append(entries, c)
				return ebmlChildren(b, c.data, c.end, nil, func(k ebmlElem) error {
					if k.id == ebmlContentEncodings {
						return errors.New("the buffered WebM stream is encrypted or encoded, and can't be saved")
					}
					return nil
				})
			})
		case ebmlCluster:
			return io.EOF // (its media: the init's over)
		}
		return nil
	})
	if err != nil && !errors.Is(err, io.EOF) {
		return 0, nil, err
	}
	if scale == 0 || scale > 1e9 || len(entries) == 0 {
		return 0, nil, errWebM
	}
	return scale, entries, nil
}

// writeWebM writes the inputs as one WebM to w: total is told its size
// first (an error from it: not written), and wrote what's written as it goes.
func writeWebM(ctx context.Context, inputs []webmInput, w io.Writer, total func(int64) error, wrote func(int64)) error {
	var scale uint64
	var tracks []webmTrack
	byOrig := make([]map[uint64]int, len(inputs))
	for i, in := range inputs {
		s, entries, err := parseWebMInit(in.init)
		if err != nil {
			return err
		}
		if scale != 0 && s != scale {
			return errors.New("the buffered WebM tracks' timescales differ, and can't be saved together")
		}
		scale = s
		byOrig[i] = map[uint64]int{}
		for _, e := range entries {
			t := webmTrack{entry: in.init[e.data:e.end], in: i}
			ebmlChildren(in.init, e.data, e.end, nil, func(c ebmlElem) error {
				switch c.id {
				case ebmlTrackNumber:
					t.orig = ebmlUintOf(in.init[c.data:c.end])
				case ebmlTrackType:
					t.video = ebmlUintOf(in.init[c.data:c.end]) == 1
				}
				return nil
			})
			if _, dup := byOrig[i][t.orig]; dup || t.orig == 0 || len(tracks) >= 16 {
				return errWebM
			}
			byOrig[i][t.orig] = len(tracks)
			tracks = append(tracks, t)
		}
	}
	if len(tracks) == 0 {
		return errWebM
	}
	// Where each block is, and when.
	var blocks []webmBlockAt
	for i, in := range inputs {
		for p := 0; p < in.partCount; p++ {
			if err := ctx.Err(); err != nil {
				return err
			}
			data, err := in.partAt(p)
			if err != nil {
				return err
			}
			err = ebmlChildren(data, 0, len(data), webmTopLevel, func(cl ebmlElem) error {
				if cl.id != ebmlCluster {
					return nil
				}
				var at int64
				return ebmlChildren(data, cl.data, cl.end, nil, func(e ebmlElem) error {
					switch e.id {
					case ebmlTimecode:
						at = int64(ebmlUintOf(data[e.data:e.end]))
					case ebmlSimpleBlock, ebmlBlockGroup:
						bst, bs, be, key := e.start, e.data, e.end, false
						if e.id == ebmlBlockGroup {
							bs, key = -1, true
							ebmlChildren(data, e.data, e.end, nil, func(c ebmlElem) error {
								switch c.id {
								case ebmlBlock:
									bst, bs, be = c.start, c.data, c.end
								case ebmlReferenceBlock:
									key = false
								}
								return nil
							})
							if bs < 0 {
								return errWebM
							}
						}
						orig, _, rel, flags, err := webmBlockHead(data[bs:be])
						if err != nil {
							return err
						}
						if e.id == ebmlSimpleBlock {
							key = flags&0x80 != 0
						}
						t, ok := byOrig[i][orig]
						if !ok {
							return nil // (a track its init didn't have: left out)
						}
						_, numLen, _, _ := ebmlSize(data[bs:])
						blocks = append(blocks, webmBlockAt{track: t, time: at + int64(rel), key: key, in: i, part: p, group: e.id == ebmlBlockGroup,
							start: e.start, data: e.data, end: e.end, bStart: bst, bData: bs, bEnd: be, numLen: numLen})
					}
					return nil
				})
			})
			if err != nil {
				return err
			}
		}
	}
	if len(blocks) == 0 {
		return errors.New("buffered stream has no media segments yet")
	}
	// In time order (a block appended again, as the page seeks back, once).
	sort.SliceStable(blocks, func(a, b int) bool { return blocks[a].time < blocks[b].time })
	last := make([]int64, len(tracks))
	seen := make([]bool, len(tracks))
	kept := blocks[:0]
	for _, b := range blocks {
		if seen[b.track] && b.time <= last[b.track] {
			continue
		}
		seen[b.track], last[b.track] = true, b.time
		kept = append(kept, b)
	}
	blocks = kept
	origin := blocks[0].time
	for i := range blocks {
		_, payload := webmBlockSizes(&blocks[i])
		blocks[i].size = 1 + int64(ebmlSizeLen(payload)) + payload
	}
	return webmWrite(ctx, inputs, tracks, blocks, scale, origin, w, total, wrote)
}

// webmCluster is a cluster as written: its time, its blocks, its payload's
// size, and where it is in the Segment's data.
type webmCluster struct {
	time     int64
	from, to int
	size     int64
	pos      int64
	cue      bool
}

// webmEntry is a track's entry, renumbered n (its UID too).
func webmEntry(t webmTrack, n int) []byte {
	var p bytes.Buffer
	ebmlChildren(t.entry, 0, len(t.entry), nil, func(c ebmlElem) error {
		switch c.id {
		case ebmlTrackNumber:
			p.Write(ebmlUint(ebmlTrackNumber, uint64(n), 0))
		case ebmlTrackUID:
			p.Write(ebmlUint(ebmlTrackUID, uint64(n), 0))
		default:
			p.Write(t.entry[c.start:c.end])
		}
		return nil
	})
	return ebmlElement(ebmlTrackEntry, p.Bytes())
}

// webmBlockBytes writes b (of data, its part's) renumbered and at rel in
// its cluster.
func webmBlockBytes(w *bytes.Buffer, data []byte, b *webmBlockAt, rel int16) {
	blockPayload, payload := webmBlockSizes(b)
	block := func() {
		ebmlPutSize(w, int64(b.track+1), 0) // (a track number's coded as a size is)
		w.Write([]byte{byte(uint16(rel) >> 8), byte(rel)})
		w.Write(data[b.bData+b.numLen+2 : b.bEnd]) // its flags, and frames
	}
	if !b.group {
		w.WriteByte(ebmlSimpleBlock)
		ebmlPutSize(w, payload, 0)
		block()
		return
	}
	w.WriteByte(ebmlBlockGroup)
	ebmlPutSize(w, payload, 0)
	w.Write(data[b.data:b.bStart])
	w.WriteByte(ebmlBlock)
	ebmlPutSize(w, blockPayload, 0)
	block()
	w.Write(data[b.bEnd:b.end])
}

func webmWrite(ctx context.Context, inputs []webmInput, tracks []webmTrack, blocks []webmBlockAt, scale uint64, origin int64, w io.Writer, total func(int64) error, wrote func(int64)) error {
	hasVideo := false
	for _, t := range tracks {
		hasVideo = hasVideo || t.video
	}
	every := int64(2e9 / float64(scale)) // a cluster's least, beginning at a key frame
	if every < 1 {
		every = 1
	}
	const maxSpan = math.MaxInt16 // a block's time in its cluster
	var clusters []webmCluster
	for i := range blocks {
		b := &blocks[i]
		t := b.time - origin
		vkey := tracks[b.track].video && b.key
		var c *webmCluster
		if len(clusters) > 0 {
			c = &clusters[len(clusters)-1]
		}
		if c == nil || t-c.time > maxSpan || c.size > 5<<20 ||
			((vkey || !hasVideo) && t-c.time >= every) {
			clusters = append(clusters, webmCluster{time: t, from: i, cue: vkey || !hasVideo})
			c = &clusters[len(clusters)-1]
			c.size = int64(len(ebmlUint(ebmlTimecode, uint64(t), 0)))
		}
		c.to = i + 1
		c.size += b.size
	}
	// How long it lasts: its last block's time, and as long again as the
	// gap before it, in its track.
	var end int64
	lastOf := make([]int64, len(tracks))
	gapOf := make([]int64, len(tracks))
	seen := make([]bool, len(tracks))
	for _, b := range blocks {
		t := b.time - origin
		if seen[b.track] {
			gapOf[b.track] = t - lastOf[b.track]
		}
		seen[b.track], lastOf[b.track] = true, t
	}
	for i := range tracks {
		end = max(end, lastOf[i]+gapOf[i])
	}
	cat := func(parts ...[]byte) []byte { return bytes.Join(parts, nil) }
	head := ebmlElement(ebmlHeaderID, cat(ebmlUint(0x4286, 1, 0), ebmlUint(0x42F7, 1, 0), ebmlUint(0x42F2, 4, 0), ebmlUint(0x42F3, 8, 0),
		ebmlElement(ebmlDocType, []byte("webm")), ebmlUint(0x4287, 4, 0), ebmlUint(0x4285, 2, 0)))
	info := ebmlElement(ebmlInfo, cat(ebmlUint(ebmlTimecodeScale, scale, 0), ebmlFloat(ebmlDuration, float64(end)),
		ebmlElement(ebmlMuxingApp, []byte("TabTop")), ebmlElement(ebmlWritingApp, []byte("TabTop"))))
	var entries []byte
	for i, t := range tracks {
		entries = append(entries, webmEntry(t, i+1)...)
	}
	tracksEl := ebmlElement(ebmlTracks, entries)
	idBytes := func(id uint32) []byte {
		var b bytes.Buffer
		ebmlPutID(&b, id)
		return b.Bytes()
	}
	seekHead := func(info, tracks, cues int64) []byte {
		seek := func(id uint32, pos int64) []byte {
			return ebmlElement(ebmlSeek, cat(ebmlElement(ebmlSeekID, idBytes(id)), ebmlUint(ebmlSeekPosition, uint64(pos), 8)))
		}
		return ebmlElement(ebmlSeekHead, cat(seek(ebmlInfo, info), seek(ebmlTracks, tracks), seek(ebmlCues, cues)))
	}
	// Where each is in the Segment's data (the SeekHead's size is the same
	// whatever the positions: they're 8 bytes each).
	posInfo := int64(len(seekHead(0, 0, 0)))
	posTracks := posInfo + int64(len(info))
	pos := posTracks + int64(len(tracksEl))
	cueTrack := uint64(1)
	for i, t := range tracks {
		if t.video {
			cueTrack = uint64(i + 1)
			break
		}
	}
	var points []byte
	for i := range clusters {
		c := &clusters[i]
		c.pos = pos
		pos += 4 + 8 + c.size
		if c.cue || i == 0 {
			points = append(points, ebmlElement(ebmlCuePoint, cat(ebmlUint(ebmlCueTime, uint64(c.time), 0),
				ebmlElement(ebmlCueTrackPositions, cat(ebmlUint(ebmlCueTrack, cueTrack, 0), ebmlUint(ebmlCueClusterPos, uint64(c.pos), 0)))))...)
		}
	}
	cues := ebmlElement(ebmlCues, points)
	head2 := seekHead(posInfo, posTracks, pos)
	segment := int64(len(head2)+len(info)+len(tracksEl)) + (pos - posTracks - int64(len(tracksEl))) + int64(len(cues))
	if total != nil {
		if err := total(int64(len(head)) + 4 + 8 + segment); err != nil {
			return err
		}
	}
	var out bytes.Buffer
	flush := func() error {
		if out.Len() == 0 {
			return nil
		}
		n, err := w.Write(out.Bytes())
		if wrote != nil {
			wrote(int64(n))
		}
		out.Reset()
		return err
	}
	out.Write(head)
	ebmlPutID(&out, ebmlSegment)
	ebmlPutSize(&out, segment, 8)
	out.Write(head2)
	out.Write(info)
	out.Write(tracksEl)
	// The blocks, each read again from its part (the last read of each
	// input kept: they're mostly in order).
	type cached struct {
		part int
		data []byte
	}
	cache := make([]cached, len(inputs))
	for i := range cache {
		cache[i].part = -1
	}
	for _, c := range clusters {
		if err := ctx.Err(); err != nil {
			return err
		}
		ebmlPutID(&out, ebmlCluster)
		ebmlPutSize(&out, c.size, 8)
		out.Write(ebmlUint(ebmlTimecode, uint64(c.time), 0))
		for i := c.from; i < c.to; i++ {
			b := &blocks[i]
			if cache[b.in].part != b.part {
				data, err := inputs[b.in].partAt(b.part)
				if err != nil {
					return err
				}
				cache[b.in] = cached{part: b.part, data: data}
			}
			webmBlockBytes(&out, cache[b.in].data, b, int16(b.time-origin-c.time))
			if out.Len() >= 1<<20 {
				if err := flush(); err != nil {
					return err
				}
			}
		}
	}
	out.Write(cues)
	return flush()
}
