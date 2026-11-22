package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"maps"
	"math"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/Eyevinn/mp4ff/bits"
	"github.com/Eyevinn/mp4ff/mp4"
	"github.com/grafov/m3u8"
)

const manifestLimit = 2 << 20
const segmentLimit = 32 << 20

type streamTrack struct {
	base      *url.URL
	init      string
	parts     []string
	starts    []float64 // each part's start, in seconds; nil if not known
	dashShift float64   // maps DASH media time to period time, in seconds
	// The DASH presentationTimeOffset, its ticks and timescale: applied
	// exactly (in ticks, streamMedia.exact) to a track of that timescale, as
	// a float can't (an epoch-anchored 10 MHz stream's is past 2^53).
	dashTicks, dashScale int64
	length               float64 // how long it lasts, in seconds, as its manifest says; 0 if it doesn't
	ids                  map[uint32]uint32
	// MPEG-TS segments (no init): taken into MP4 as they're read
	// (gostreamts.go), each part after a discontinuity said so.
	ts    *tsRemux
	jumps map[int]bool
	first []byte // its first part, read for the header: not read again
	// A buffered stream's (MSE capture's): its init, and its parts read as
	// they're written (from its staging folder), instead of init/parts URLs.
	initData  []byte
	partCount int
	partAt    func(i int) ([]byte, error)
	offsets   []float64 // SourceBuffer timestampOffset for each captured part, in seconds
}

// A stream's request is tried streamTries times, for what can pass (a
// connection lost, the server busy or failing, a stall), waiting longer
// each time; one that gets nothing for streamStall has stalled. A save of
// hundreds of segments mustn't fail for one dropped request, nor a large
// segment on a slow link for taking long.
const (
	streamTries = 4
	streamStall = time.Minute
)

var errStreamStalled = errors.New("the stream server stopped sending")

// All manifest and segment requests use the tab’s download network policy.
type streamReader struct {
	ctx    context.Context
	client http.Client
	job    *fetchJob
}

func (s streamReader) read(base *url.URL, ref string, limit int64) ([]byte, *url.URL, error) {
	u, err := base.Parse(ref)
	if err != nil || len(u.String()) > 8192 || u.User != nil || (u.Scheme != "https" && u.Scheme != "http") {
		return nil, nil, errors.New("invalid stream URL")
	}
	if err := streamAllowed(u, s.job.from); err != nil {
		return nil, nil, err
	}
	wait := time.Second
	for try := 1; ; try++ {
		data, at, again, err := s.readOnce(u, limit)
		if err == nil || !again || try == streamTries || s.ctx.Err() != nil {
			return data, at, err
		}
		select {
		case <-s.ctx.Done():
			return nil, nil, s.ctx.Err()
		case <-time.After(wait):
		}
		wait *= 2
	}
}

// readOnce asks for u once: what it got, where from (after redirects); or
// why not, and whether trying again may get it.
func (s streamReader) readOnce(u *url.URL, limit int64) (data []byte, at *url.URL, again bool, err error) {
	ctx, cancel := context.WithCancelCause(s.ctx)
	defer cancel(nil)
	stall := time.AfterFunc(streamStall, func() { cancel(errStreamStalled) })
	defer stall.Stop()
	req, err := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
	if err != nil {
		return nil, nil, false, err
	}
	s.job.from.apply(req)
	req.Header.Set("Accept-Encoding", "identity")
	if s.job.userAgent != "" {
		req.Header.Set("User-Agent", s.job.userAgent)
	} else {
		req.Header.Set("User-Agent", "TabTop")
	}
	res, err := s.client.Do(req)
	if err != nil {
		if errors.Is(context.Cause(ctx), errStreamStalled) {
			return nil, nil, true, errStreamStalled
		}
		// Refused, or what would be the same again, or the save cancelled:
		// not again.
		return nil, nil, s.ctx.Err() == nil && !streamFinal(err), fetchError(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		busy := res.StatusCode >= 500 || res.StatusCode == http.StatusTooManyRequests || res.StatusCode == http.StatusRequestTimeout
		return nil, nil, busy, fmt.Errorf("stream server answered %s", res.Status)
	}
	// Read as it comes, the stall timer put back with each part.
	var buf bytes.Buffer
	chunk := make([]byte, 64<<10)
	for {
		n, rerr := res.Body.Read(chunk)
		if n > 0 {
			stall.Reset(streamStall)
			buf.Write(chunk[:n])
			if int64(buf.Len()) > limit {
				return nil, nil, false, errors.New("stream segment or manifest is too large")
			}
		}
		if rerr == io.EOF {
			return buf.Bytes(), res.Request.URL, false, nil
		}
		if rerr != nil {
			if errors.Is(context.Cause(ctx), errStreamStalled) {
				return nil, nil, true, errStreamStalled
			}
			return nil, nil, s.ctx.Err() == nil, rerr
		}
	}
}

func (s streamReader) playlist(base *url.URL, ref string, master bool) ([]streamTrack, error) {
	data, u, err := s.read(base, ref, manifestLimit)
	if err != nil {
		return nil, err
	}
	if !bytes.HasPrefix(bytes.TrimSpace(data), []byte("#EXTM3U")) {
		return dashTracks(data, u)
	}
	playlist, _, err := decodeM3U8(data)
	if err != nil {
		return nil, err
	}
	switch p := playlist.(type) {
	case *m3u8.MasterPlaylist:
		if !master {
			return nil, errors.New("nested master playlists are unsupported")
		}
		var best *m3u8.Variant
		for _, v := range p.Variants {
			if !v.Iframe && (best == nil || v.Bandwidth > best.Bandwidth) {
				best = v
			}
		}
		if best == nil {
			return nil, errors.New("no video rendition")
		}
		tracks, err := s.playlist(u, best.URI, false)
		if err != nil {
			return nil, err
		}
		// Its audio: the group it names, looked for among every variant's
		// renditions (the m3u8 package gives a master's EXT-X-MEDIA to
		// whichever variant came first after them, an I-frame one, say).
		var audio *m3u8.Alternative
		for _, v := range p.Variants {
			for _, a := range v.Alternatives {
				if a != nil && a.Type == "AUDIO" && a.GroupId == best.Audio && (audio == nil || a.Default && !audio.Default) {
					audio = a
				}
			}
		}
		if best.Audio != "" && audio == nil {
			return nil, fmt.Errorf("the stream's audio (group %q) isn't listed", best.Audio)
		}
		if audio != nil && audio.URI != "" {
			parts, err := s.playlist(u, audio.URI, false)
			if err != nil {
				return nil, err
			}
			tracks = append(tracks, parts...)
		}
		return tracks, nil
	case *m3u8.MediaPlaylist:
		if bytes.Contains(data, []byte("#EXT-X-GAP")) {
			return nil, errors.New("playlist has missing segments")
		}
		if !p.Closed || p.Iframe || p.WV != nil || p.Key != nil && p.Key.Method != "NONE" {
			return nil, errors.New("Save stream requires an unencrypted on-demand playlist")
		}
		t := streamTrack{base: u}
		if p.Map != nil {
			t.init = p.Map.URI
		}
		// No init: MPEG-TS segments, taken into MP4 (gostreamts.go), across
		// discontinuities too (an ad's, say, its own clock).
		ts := t.init == ""
		at := 0.0
		for _, seg := range p.Segments {
			if seg == nil {
				continue
			}
			if seg.Key != nil && seg.Key.Method != "NONE" || seg.Discontinuity && !ts || seg.Limit != 0 || seg.Map != nil && (seg.Map.URI != t.init || seg.Map.Limit != 0) {
				return nil, errors.New("unsupported encryption, byte range, or track change")
			}
			if seg.Discontinuity {
				if t.jumps == nil {
					t.jumps = map[int]bool{}
				}
				t.jumps[len(t.parts)] = true
			}
			t.parts = append(t.parts, seg.URI)
			t.starts = append(t.starts, at)
			at += seg.Duration
		}
		t.length = at
		if len(t.parts) == 0 || !ts && p.Map.Limit != 0 {
			return nil, errors.New("Save stream requires fragmented MP4 or MPEG-TS segments")
		}
		if ts {
			t.ts = newTSRemux(nil) // (its clock, the stream's: saveStream's)
		}
		return []streamTrack{t}, nil
	}
	return nil, errors.New("unsupported manifest")
}

// streamBoxes visits top-level boxes without changing their byte layout.
func streamBoxes(data []byte, visit func([]byte, []byte) error) error {
	for len(data) > 0 {
		if len(data) < 8 {
			return io.ErrUnexpectedEOF
		}
		n := uint64(binary.BigEndian.Uint32(data))
		header := 8
		if n == 1 {
			if len(data) < 16 {
				return io.ErrUnexpectedEOF
			}
			n = binary.BigEndian.Uint64(data[8:])
			header = 16
		}
		if n == 0 {
			n = uint64(len(data))
		}
		if n < uint64(header) || n > uint64(len(data)) {
			return errors.New("invalid MP4 box length")
		}
		if err := visit(data[4:8], data[header:n]); err != nil {
			return err
		}
		data = data[n:]
	}
	return nil
}

// Fragment metadata is read without decoding or copying the media payload.
type streamSpan struct {
	decode, decodeEnd, start, end int64 // decode time and presentation interval, in track ticks
	implicit                      bool
	sync                          bool
}

type streamMedia struct {
	scale             uint32
	defaults          *mp4.TrexBox
	preroll           int64  // media ticks skipped by the DASH period edit
	exact             int64  // ticks added to every decode time, exactly (streamTrack.dashTicks)
	nextOutputDTS     int64  // inferred decode time in the rebased output
	nextDTS           uint64 // implicit base if a fragment omits tfdt
	capturedDecodeEnd float64
	capturedEnd       float64 // presentation end on the SourceBuffer clock
	captured          bool
}

func streamFragment(data []byte, ids map[uint32]uint32, media map[uint32]streamMedia, seq *uint32, shift float64) (spans map[uint32]streamSpan, err error) {
	// A site's (or a page's) fragment, decoded by mp4ff (streamTraf), which
	// can panic on what's malformed: an error, not the end of tabtopd (this
	// runs in a save's goroutine), as decodeStreamInit does.
	defer func() {
		if recover() != nil {
			spans, err = nil, errors.New("invalid MP4 fragment")
		}
	}()
	spans = make(map[uint32]streamSpan)
	var moof, mdat bool
	err = streamBoxes(data, func(kind, body []byte) error {
		switch string(kind) {
		case "mdat":
			mdat = true
		case "moof":
			moof = true
			return streamBoxes(body, func(k, b []byte) error {
				switch string(k) {
				case "mfhd":
					if len(b) != 8 {
						return io.ErrUnexpectedEOF
					}
					if seq != nil {
						*seq++
						binary.BigEndian.PutUint32(b[4:], *seq)
					}
				case "traf":
					return streamTraf(b, ids, media, seq != nil, shift, spans)
				}
				return nil
			})
		case "sidx", "ssix", "mfra", "styp":
			if seq != nil {
				copy(kind, "free")
			}
		case "moov":
			return errors.New("unexpected initialization segment")
		}
		return nil
	})
	if err == nil && (!moof || !mdat) {
		err = errors.New("invalid fragmented MP4 segment")
	}
	return spans, err
}

func streamTraf(body []byte, ids map[uint32]uint32, media map[uint32]streamMedia, write bool, shift float64, spans map[uint32]streamSpan) error {
	hdr := mp4.BoxHeader{Name: "traf", Size: uint64(len(body)) + 8, Hdrlen: 8}
	box, err := mp4.DecodeTrafSR(hdr, 0, bits.NewFixedSliceReader(body))
	if err != nil {
		return err
	}
	traf := box.(*mp4.TrafBox)
	if enc, _ := traf.ContainsSencBox(); enc {
		return errors.New("encrypted fragments are unsupported")
	}
	id := ids[traf.Tfhd.TrackID]
	if id == 0 || traf.Tfhd.HasBaseDataOffset() {
		return errors.New("unsupported fragment addressing")
	}
	m := media[id]
	base := m.nextDTS
	if traf.Tfdt != nil {
		base = traf.Tfdt.BaseMediaDecodeTime()
	}
	// Rounded half up: the same whole ticks whatever whole ticks the shift
	// is moved by (measureCapture's origin), as math.Round, half away from
	// zero, isn't (+0.5 up, -0.5 down: a fragment at -1).
	delta := math.Floor(shift*float64(m.scale) + 0.5)
	// A shift given in floating-point seconds (SourceBuffer's, a period's)
	// is exact in ticks only up to 2^53 of them; the ticks it's added to
	// are integers, exact however large (an epoch-anchored 10 MHz
	// stream's: 1.7e16).
	if math.IsNaN(delta) || math.Abs(delta) > 1<<53 || base > math.MaxInt64/2 {
		return errors.New("invalid stream timestamp")
	}
	if m.exact != 0 && (base > math.MaxInt64/2 || m.exact < -math.MaxInt64/2 || m.exact > math.MaxInt64/2) {
		return errors.New("invalid stream timestamp")
	}
	dts := int64(base) + m.exact + int64(delta)
	if write && traf.Tfdt == nil && m.nextOutputDTS != dts {
		return errors.New("cannot reposition a buffered fragment without a decode time")
	}
	if write && (dts < 0 || traf.Tfdt != nil && traf.Tfdt.Version == 0 && dts > math.MaxUint32) {
		return errors.New("fragment timestamp is out of range")
	}
	if write {
		err = streamBoxes(body, func(k, f []byte) error {
			switch string(k) {
			case "tfhd":
				binary.BigEndian.PutUint32(f[4:], id)
			case "tfdt":
				if len(f) < 8 || f[0] > 1 || (f[0] == 1 && len(f) < 12) {
					return errors.New("invalid fragment decode time")
				}
				if f[0] == 0 {
					binary.BigEndian.PutUint32(f[4:], uint32(dts))
				} else {
					binary.BigEndian.PutUint64(f[4:], uint64(dts))
				}
			}
			return nil
		})
		if err != nil {
			return err
		}
	}
	span, seen := spans[id]
	for _, run := range traf.Truns {
		run.AddSampleDefaultValues(traf.Tfhd, m.defaults)
		for _, sample := range run.Samples {
			pts := dts + int64(sample.CompositionTimeOffset)
			end := pts + int64(sample.Dur)
			if !seen {
				span = streamSpan{decode: dts, start: pts, end: end, sync: sample.IsSync()}
				seen = true
			} else {
				if pts < span.start {
					span.start, span.sync = pts, false
				}
				span.end = max(span.end, end)
			}
			dts += int64(sample.Dur)
		}
	}
	if seen {
		span.decodeEnd = dts
		span.implicit = span.implicit || traf.Tfdt == nil
		spans[id] = span
	}
	m.nextOutputDTS = dts
	m.nextDTS = uint64(dts - int64(delta) - m.exact)
	media[id] = m
	return nil
}

// Captured tracks may begin midway through a presentation. Measure their
// actual samples on the viewer's common clock before writing the movie header.
func measureCapture(ctx context.Context, tracks []streamTrack, media map[uint32]streamMedia) (float64, error) {
	origin := math.Inf(1)
	for i := range tracks {
		t := &tracks[i]
		if t.partAt == nil {
			continue
		}
		t.length = math.Inf(-1)
		parts := make([]map[uint32]streamSpan, t.partCount)
		for j := range t.partCount {
			if err := ctx.Err(); err != nil {
				return 0, err
			}
			data, err := t.partAt(j)
			if err != nil {
				return 0, err
			}
			spans, err := streamFragment(data, t.ids, media, nil, t.offset(j))
			if err != nil {
				return 0, err
			}
			parts[j] = spans
			start := math.Inf(1)
			for id, span := range spans {
				scale := float64(media[id].scale)
				start = min(start, float64(span.decode)/scale)
				origin = min(origin, float64(min(span.start, span.decode))/scale)
				end := float64(span.end) / scale
				m := media[id]
				if !m.captured || end > m.capturedEnd {
					m.capturedEnd = end
				}
				decodeEnd := float64(m.nextOutputDTS) / scale
				if !m.captured || decodeEnd > m.capturedDecodeEnd {
					m.capturedDecodeEnd = decodeEnd
				}
				m.captured = true
				media[id] = m
				t.length = max(t.length, end)
			}
			if math.IsInf(start, 1) {
				// No samples (a stream's filler, which ISO-BMFF allows):
				// kept where it came, at the start of the one before.
				start = 0
				if j > 0 {
					start = t.starts[j-1]
				}
			}
			t.starts = append(t.starts, start)
		}
		// Replay complete fragments chronologically after a backward seek.
		order, reordered, implicit, err := planCaptureParts(parts, t.starts)
		if err != nil {
			return 0, err
		}
		if len(order) != t.partCount {
			reordered = true
			t.partCount = len(order)
		}
		if reordered {
			if implicit {
				return 0, errors.New("cannot reorder buffered fragments with implicit timestamps")
			}
			read := t.partAt
			t.partAt = func(j int) ([]byte, error) { return read(order[j]) }
			offsets := make([]float64, len(order))
			starts := make([]float64, len(order))
			for j, part := range order {
				offsets[j], starts[j] = t.offset(part), t.starts[part]
			}
			t.offsets, t.starts = offsets, starts
		}
	}
	if math.IsInf(origin, 1) {
		return 0, nil
	}
	for id, m := range media {
		m.nextDTS, m.nextOutputDTS = 0, 0
		media[id] = m
	}
	for i := range tracks {
		tracks[i].length -= origin
	}
	return origin, nil
}

// planCaptureParts returns the original part indices in playback order,
// excluding retries fully covered by earlier parts. It also reports whether
// applying that plan changes the captured byte order.
func planCaptureParts(parts []map[uint32]streamSpan, starts []float64) ([]int, bool, bool, error) {
	order := make([]int, len(parts))
	for j := range order {
		order[j] = j
	}
	sort.SliceStable(order, func(a, b int) bool { return starts[order[a]] < starts[order[b]] })
	lastEnd := make(map[uint32]int64)
	reordered, implicit := false, false
	kept := order[:0]
	for _, part := range order {
		covered, overlaps := len(parts[part]) > 0, false
		for id, span := range parts[part] {
			end, seen := lastEnd[id]
			covered = covered && seen && span.decodeEnd <= end
			overlaps = overlaps || seen && span.decode < end
		}
		if covered {
			continue
		}
		if overlaps {
			return nil, false, false, errors.New("cannot save overlapping buffered fragments after a seek")
		}
		for id, span := range parts[part] {
			implicit = implicit || span.implicit
			lastEnd[id] = span.decodeEnd
		}
		reordered = reordered || part != len(kept)
		kept = append(kept, part)
	}
	if len(kept) != len(parts) {
		reordered = true
	}
	return kept, reordered, implicit, nil
}

func (t *streamTrack) offset(i int) float64 {
	if len(t.offsets) == 0 {
		return t.dashShift
	}
	return t.offsets[i]
}

// decodeM3U8 decodes an HLS playlist a website sent. The m3u8 package can
// panic on what's malformed, and a panic would end tabtopd (it runs in a
// fetch's goroutine, or the tab's): an error instead.
func decodeM3U8(data []byte) (p m3u8.Playlist, kind m3u8.ListType, err error) {
	defer func() {
		if recover() != nil {
			p, err = nil, errors.New("invalid HLS playlist")
		}
	}()
	return m3u8.Decode(*bytes.NewBuffer(data), true)
}

func decodeStreamInit(data []byte) (init *mp4.InitSegment, err error) {
	defer func() {
		if recover() != nil {
			init = nil
			err = errors.New("invalid MP4 initialization segment")
		}
	}()
	file, err := mp4.DecodeFileSR(bits.NewFixedSliceReader(data))
	if err != nil {
		return nil, err
	}
	if file.Init == nil || file.Moov == nil || file.Moov.Mvhd == nil || file.Moov.Mvex == nil || len(file.Moov.Traks) == 0 || len(file.Moov.Mvex.Trexs) != len(file.Moov.Traks) {
		return nil, errors.New("missing fragmented MP4 header")
	}
	for _, trak := range file.Moov.Traks {
		if trak.Tkhd == nil || trak.Mdia == nil || trak.Mdia.Mdhd == nil || trak.Mdia.Mdhd.Timescale == 0 || trak.Mdia.Minf == nil || trak.Mdia.Minf.Stbl == nil || trak.Mdia.Minf.Stbl.Stsd == nil {
			return nil, errors.New("incomplete MP4 track header")
		}
		stsd := trak.Mdia.Minf.Stbl.Stsd
		if stsd.Encv != nil || stsd.Enca != nil {
			return nil, errors.New("encrypted tracks are unsupported")
		}
	}
	return file.Init, nil
}

// streamName is what a stream at u is saved as: its manifest's name, as an
// MP4 (master.m3u8: master.mp4); stream.mp4 if its address has none.
func streamName(u *url.URL) string {
	name := urlName(u)
	stem := strings.TrimSuffix(name, path.Ext(name))
	if strings.Trim(stem, ". ") == "" {
		stem = "stream"
	}
	return cleanFetchName(stem + ".mp4")
}

// streamAllowed is why u, a stream's manifest or segment (or where one
// redirects), isn't fetched: what the engine itself couldn't reach (a port
// it may not, a site blocked in Site controls), or an ad's or tracker's
// for the tab's page; nil if it is.
func streamAllowed(u *url.URL, from *goFrom) error {
	switch {
	case !goPortAllowed(u):
		return streamRefusal("the stream names an address on a port the browser doesn't reach")
	case goBlockedHost(u.Hostname()):
		return streamRefusal(goRefusals["blocked"])
	case from.adBlocked(u, "media"):
		return streamRefusal(goRefusals["ads"])
	}
	return nil
}

// streamRefusal is streamAllowed's no: the same however often it's asked.
type streamRefusal string

func (r streamRefusal) Error() string { return string(r) }

// streamFinal is whether a request's err would be the same asked again:
// refused (by the address policy, or streamAllowed, a redirect's too), a
// name the DNS over HTTPS server hasn't, a certificate not trusted.
func streamFinal(err error) bool {
	var refused streamRefusal
	var unknown x509.UnknownAuthorityError
	var host x509.HostnameError
	var invalid x509.CertificateInvalidError
	var verify *tls.CertificateVerificationError
	return errors.Is(err, errFetchAddress) || errors.As(err, &refused) || errors.Is(err, errGoDNS) || errors.Is(err, errGoCertRevoked) ||
		errors.As(err, &unknown) || errors.As(err, &host) || errors.As(err, &invalid) || errors.As(err, &verify)
}

func (m *fetchManager) saveStream(ctx context.Context, j *fetchJob, u *url.URL, up *upload) (string, error) {
	// Called what it's saved as, from the start (not the manifest's name).
	name := streamName(u)
	j.set(func(j *fetchJob) { j.name = name })
	client := *j.client
	client.Timeout = 0 // (a stall stops a request instead: streamReader)
	redirect := client.CheckRedirect
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if err := streamAllowed(req.URL, j.from); err != nil {
			return err
		}
		j.from.apply(req)
		if redirect != nil {
			return redirect(req, via)
		}
		if len(via) >= 10 {
			return errors.New("it redirects too many times")
		}
		return nil
	}
	reader := streamReader{ctx, client, j}
	tracks, err := reader.playlist(u, "", true)
	if err != nil {
		return "", err
	}
	return m.writeStreamTracks(ctx, j, tracks, &reader, up, name)
}

// writeStreamTracks remuxes tracks into up as a fragmented MP4. reader is
// used to fetch HTTP segments; nil when parts are already in memory (MSE).
func (m *fetchManager) writeStreamTracks(ctx context.Context, j *fetchJob, tracks []streamTrack, reader *streamReader, up *upload, name string) (string, error) {
	init, media, err := buildStreamInit(tracks, reader)
	if err != nil {
		return "", err
	}
	// A presentationTimeOffset in the media's own timescale: applied in
	// ticks, exactly; what's left of the shift (none) as seconds.
	for i := range tracks {
		t := &tracks[i]
		if t.dashTicks == 0 || t.dashScale <= 0 || t.dashScale > math.MaxUint32 {
			continue
		}
		same := len(t.ids) > 0
		for _, id := range t.ids {
			same = same && int64(media[id].scale) == t.dashScale
		}
		if !same {
			continue
		}
		for _, id := range t.ids {
			m := media[id]
			m.exact = t.dashTicks
			media[id] = m
		}
		t.dashShift -= float64(t.dashTicks) / float64(t.dashScale)
		if math.Abs(t.dashShift) < 1e-9 {
			t.dashShift = 0
		}
	}
	// B-frames may need decoding before the DASH period starts. MP4 decode
	// times are unsigned. Retain this preroll and skip it with a track edit.
	for i := range tracks {
		t := &tracks[i]
		if t.dashShift == 0 && t.dashTicks == 0 { // (a period's offset taken off exactly: its lead still to find)
			continue
		}
		t.first, _, err = reader.read(t.base, t.parts[0], segmentLimit)
		if err != nil {
			return "", err
		}
		spans, err := streamFragment(t.first, t.ids, maps.Clone(media), nil, t.dashShift)
		if err != nil {
			return "", err
		}
		var lead float64
		for id, span := range spans {
			lead = max(lead, -float64(span.decode)/float64(media[id].scale))
		}
		t.dashShift += lead
		for _, id := range t.ids {
			m := media[id]
			m.preroll = int64(math.Round(lead * float64(m.scale)))
			media[id] = m
		}
	}
	origin, err := measureCapture(ctx, tracks, media)
	if err != nil {
		return "", err
	}
	// Store the manifest duration or the measured captured duration so file
	// players can seek before they have read all the media fragments.
	length := 0.0
	for _, t := range tracks {
		length = max(length, t.length)
	}
	if scale := init.Moov.Mvhd.Timescale; length > 0 && scale > 0 {
		d := uint64(math.Round(length * float64(scale)))
		init.Moov.Mvhd.Duration = d
		if d > math.MaxUint32 {
			init.Moov.Mvhd.Version = 1
		}
		for _, trak := range init.Moov.Traks {
			trak.Tkhd.Duration = d
			if m := media[trak.Tkhd.TrackID]; m.captured {
				seconds := m.capturedEnd - origin
				trak.Tkhd.Duration = uint64(math.Round(seconds * float64(scale)))
				trak.Mdia.Mdhd.Duration = uint64(math.Round((m.capturedDecodeEnd - origin) * float64(m.scale)))
				if trak.Mdia.Mdhd.Duration > math.MaxUint32 {
					trak.Mdia.Mdhd.Version = 1
				}
			}
			if trak.Tkhd.Duration > math.MaxUint32 {
				trak.Tkhd.Version = 1
			}
		}
		mvex := init.Moov.Mvex
		if mvex.Mehd == nil {
			// (First in its mvex, before the trex boxes, as the format has it.)
			mvex.Mehd = &mp4.MehdBox{}
			mvex.Children = append([]mp4.Box{mvex.Mehd}, mvex.Children...)
		}
		mvex.Mehd.Version, mvex.Mehd.FragmentDuration = 1, int64(d)
	}
	for _, trak := range init.Moov.Traks {
		lead := media[trak.Tkhd.TrackID].preroll
		if lead == 0 {
			continue
		}
		if trak.Edts == nil {
			elst := &mp4.ElstBox{Version: 1, Entries: []mp4.ElstEntry{{MediaTime: lead, MediaRateInteger: 1, SegmentDuration: trak.Tkhd.Duration}}}
			trak.AddChild(&mp4.EdtsBox{Elst: []*mp4.ElstBox{elst}, Children: []mp4.Box{elst}})
		} else {
			for _, elst := range trak.Edts.Elst {
				elst.Version = 1
				for j := range elst.Entries {
					if elst.Entries[j].MediaTime >= 0 {
						elst.Entries[j].MediaTime += lead
					}
				}
			}
		}
	}
	if err := init.Encode(up); err != nil {
		return "", err
	}
	// The remaining write path emits fragments in playback order and fills the
	// reserved seek index once all segment sizes and times are known.
	return m.writeStreamFragments(ctx, j, tracks, reader, up, name, init, media, origin)
}

func buildStreamInit(tracks []streamTrack, reader *streamReader) (*mp4.InitSegment, map[uint32]streamMedia, error) {
	var init *mp4.InitSegment
	var nextID uint32 = 1
	clock := &tsClock{} // (MPEG-TS renditions': one clock)
	var err error
	for i := range tracks {
		t := &tracks[i]
		var header *mp4.InitSegment
		if t.ts != nil {
			// Its header made from its first segment's tracks.
			t.ts.clock = clock
			if t.first == nil {
				if reader == nil {
					return nil, nil, errors.New("missing MPEG-TS segment")
				}
				if t.first, _, err = reader.read(t.base, t.parts[0], segmentLimit); err != nil {
					return nil, nil, err
				}
			}
			if err = t.ts.probe(t.first); err == nil {
				header, err = t.ts.header()
			}
		} else if len(t.initData) > 0 {
			header, err = decodeStreamInit(t.initData)
		} else {
			var data []byte
			if reader == nil {
				return nil, nil, errors.New("missing MP4 initialization segment")
			}
			if data, _, err = reader.read(t.base, t.init, manifestLimit); err == nil {
				header, err = decodeStreamInit(data)
			}
		}
		if err != nil {
			return nil, nil, err
		}
		t.ids = make(map[uint32]uint32)
		for _, trak := range header.Moov.Traks {
			id := trak.Tkhd.TrackID
			if id == 0 || t.ids[id] != 0 {
				return nil, nil, errors.New("invalid track ID")
			}
			t.ids[id] = nextID
			trak.Tkhd.TrackID = nextID
			nextID++
			if init != nil {
				// Another rendition, its movie's timescale perhaps its own (90000
				// for its video, 48000 for its audio): its track's durations, which
				// count in it, counted in the first's. (Its samples count in its
				// media's timescale, which stays.)
				if from, to := header.Moov.Mvhd.Timescale, init.Moov.Mvhd.Timescale; from != to {
					if from == 0 || to == 0 {
						return nil, nil, errors.New("invalid movie timescale")
					}
					rescale := func(d uint64) uint64 { return d * uint64(to) / uint64(from) }
					trak.Tkhd.Duration = rescale(trak.Tkhd.Duration)
					if trak.Edts != nil {
						for _, elst := range trak.Edts.Elst {
							for k := range elst.Entries {
								elst.Entries[k].SegmentDuration = rescale(elst.Entries[k].SegmentDuration)
							}
						}
					}
				}
				init.Moov.AddChild(trak)
			}
		}
		for _, trex := range header.Moov.Mvex.Trexs {
			trex.TrackID = t.ids[trex.TrackID]
			if trex.TrackID == 0 {
				return nil, nil, errors.New("invalid track defaults")
			}
			if init != nil {
				init.Moov.Mvex.AddChild(trex)
			}
		}
		if init == nil {
			init = header
		}
	}
	if init == nil {
		return nil, nil, errors.New("no media tracks")
	}
	init.Moov.Mvhd.NextTrackID = nextID
	media := make(map[uint32]streamMedia)
	for _, trak := range init.Moov.Traks {
		media[trak.Tkhd.TrackID] = streamMedia{scale: trak.Mdia.Mdhd.Timescale}
	}
	for _, defaults := range init.Moov.Mvex.Trexs {
		m := media[defaults.TrackID]
		m.defaults = defaults
		media[defaults.TrackID] = m
	}
	return init, media, nil
}

func (m *fetchManager) writeStreamFragments(ctx context.Context, j *fetchJob, tracks []streamTrack, reader *streamReader, up *upload, name string, init *mp4.InitSegment, media map[uint32]streamMedia, origin float64) (string, error) {
	totalParts, tsTracks := 0, 0
	for _, t := range tracks {
		totalParts += streamPartCount(t)
		if t.ts != nil {
			tsTracks++
		}
	}
	j.set(func(j *fetchJob) { j.parts = totalParts })
	// Room for the file's index, after its header: filled in at its end.
	index := newStreamIndex(init, int64(init.Size()), totalParts+tsTracks)
	if _, err := up.Write(index.reserved()); err != nil {
		return "", err
	}
	var seq uint32
	var err error
	write := func(t *streamTrack, data, read []byte, shift float64) error {
		if len(data) > 0 {
			times, err := streamFragment(data, t.ids, media, &seq, shift)
			if err != nil {
				return err
			}
			if free, _, ok := m.files.uploadRoom(up.f); ok && free < int64(len(data))+fetchSpare {
				return errors.New("insufficient disk space for stream")
			}
			if _, err := up.Write(data); err != nil {
				return err
			}
			for id, span := range times {
				span.start -= media[id].preroll
				span.end -= media[id].preroll
				times[id] = span
			}
			index.add(len(data), times)
		}
		if read != nil {
			j.set(func(j *fetchJob) { j.got += int64(len(read)); j.partsDone++ })
		}
		return nil
	}
	for _, part := range streamOrder(tracks) {
		t := &tracks[part.track]
		var data []byte
		if part.i == 0 && t.first != nil {
			data, t.first = t.first, nil
		} else if t.partAt != nil {
			if part.i >= t.partCount {
				return "", errors.New("missing media segment")
			}
			if data, err = t.partAt(part.i); err != nil {
				return "", err
			}
		} else if reader == nil {
			return "", errors.New("missing media segment")
		} else if data, _, err = reader.read(t.base, t.parts[part.i], segmentLimit); err != nil {
			return "", err
		}
		if t.ts != nil {
			// Taken into an MP4 fragment (none, yet, if it's held).
			frag, err := t.ts.segment(data, t.jumps[part.i], seq+1)
			if err != nil {
				return "", err
			}
			if err := write(t, frag, data, 0); err != nil {
				return "", err
			}
			continue
		}
		if err := write(t, data, data, t.offset(part.i)-origin); err != nil {
			return "", err
		}
	}
	// The MPEG-TS tracks' last samples, held for a next segment there isn't.
	for i := range tracks {
		if t := &tracks[i]; t.ts != nil {
			frag, err := t.ts.finish(seq + 1)
			if err != nil {
				return "", err
			}
			if err := write(t, frag, nil, 0); err != nil {
				return "", err
			}
		}
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if box := index.boxes(); box != nil {
		if _, err := up.f.WriteAt(box, index.at); err != nil {
			return "", err
		}
	}
	return name, nil
}

// streamIndex is a saved stream's index (a sidx box for each track, as
// ffmpeg's global_sidx writes them): each segment written, its size, and
// how long each track's part of it lasts. A fragmented MP4's header has no
// samples; without an index, a player reading it as a file (Chrome's,
// through FFmpeg) takes its first fragment's length for the whole, and
// can't seek past it. Its room is reserved after the header, as the
// segments' number is known (at most one entry each, and one for each
// MPEG-TS track's last samples), and filled in once they're written.
type streamIndex struct {
	at      int64 // where it goes in the file
	room    int   // the bytes reserved for it
	tracks  []streamIndexTrack
	sizes   []int
	times   []map[uint32]streamSpan
	entries int // the most it was reserved for
}

type streamIndexTrack struct{ id, scale uint32 }

func streamIndexSize(entries int) int { return 40 + 12*entries } // a version 1 sidx

func newStreamIndex(init *mp4.InitSegment, at int64, entries int) *streamIndex {
	x := &streamIndex{at: at, entries: entries}
	for _, trak := range init.Moov.Traks {
		if trak.Mdia != nil && trak.Mdia.Mdhd != nil && trak.Mdia.Mdhd.Timescale > 0 {
			x.tracks = append(x.tracks, streamIndexTrack{trak.Tkhd.TrackID, trak.Mdia.Mdhd.Timescale})
		}
	}
	x.room = len(x.tracks)*streamIndexSize(entries) + 8 // (and a free box's header, at least)
	return x
}

// reserved is its room, as a free box, written after the header.
func (x *streamIndex) reserved() []byte {
	b := make([]byte, x.room)
	binary.BigEndian.PutUint32(b, uint32(x.room))
	copy(b[4:], "free")
	return b
}

func (x *streamIndex) add(size int, times map[uint32]streamSpan) {
	x.sizes = append(x.sizes, size)
	x.times = append(x.times, times)
}

type streamIndexReference struct {
	size     uint32
	duration uint32
	sync     bool
}

type streamIndexPlan struct {
	track      streamIndexTrack
	earliest   uint64
	firstSkip  uint64
	references []streamIndexReference
}

// plan builds track references and timing without coupling those decisions to
// the binary sidx layout.
func (x *streamIndex) plan() ([]streamIndexPlan, bool) {
	n := len(x.sizes)
	if n == 0 || n > x.entries || len(x.tracks) == 0 {
		return nil, false
	}
	plans := make([]streamIndexPlan, 0, len(x.tracks))
	for _, tr := range x.tracks {
		var refs []int
		var skip uint64
		for i := range n {
			if _, ok := x.times[i][tr.id]; ok {
				refs = append(refs, i)
			} else if len(refs) == 0 {
				skip += uint64(x.sizes[i])
			}
		}
		if len(refs) == 0 {
			continue
		}
		if len(refs) > math.MaxUint16 {
			return nil, false
		}
		p := streamIndexPlan{
			track: tr, earliest: uint64(max(x.times[refs[0]][tr.id].start, 0)),
			firstSkip: skip, references: make([]streamIndexReference, 0, len(refs)),
		}
		for j, i := range refs {
			span := x.times[i][tr.id]
			stop := n
			duration := span.end - span.start
			if j+1 < len(refs) {
				stop = refs[j+1]
				duration = x.times[stop][tr.id].start - span.start
			}
			var size uint64
			for _, s := range x.sizes[i:stop] {
				size += uint64(s)
			}
			if size > math.MaxInt32 || duration < 0 || duration > math.MaxUint32 {
				return nil, false
			}
			p.references = append(p.references, streamIndexReference{uint32(size), uint32(duration), span.sync})
		}
		plans = append(plans, p)
	}
	return plans, len(plans) > 0
}

// boxes is the index, and a free box filling the rest of its room; nil if
// it can't be said (more segments than its room, or none).
func (x *streamIndex) boxes() []byte {
	plans, ok := x.plan()
	if !ok {
		return nil
	}
	var out []byte
	for _, p := range plans {
		box := make([]byte, streamIndexSize(len(p.references)))
		binary.BigEndian.PutUint32(box, uint32(len(box)))
		copy(box[4:], "sidx")
		box[8] = 1
		binary.BigEndian.PutUint32(box[12:], p.track.id)
		binary.BigEndian.PutUint32(box[16:], p.track.scale)
		binary.BigEndian.PutUint64(box[20:], p.earliest)
		binary.BigEndian.PutUint64(box[28:], p.firstSkip)
		binary.BigEndian.PutUint16(box[38:], uint16(len(p.references)))
		for j, ref := range p.references {
			e := box[40+12*j:]
			binary.BigEndian.PutUint32(e, ref.size)
			binary.BigEndian.PutUint32(e[4:], ref.duration)
			if ref.sync {
				binary.BigEndian.PutUint32(e[8:], 0x80000000)
			}
		}
		out = append(out, box...)
	}
	if len(out) == 0 {
		return nil
	}
	rest := x.room - len(out)
	// first_offset: what's between each box's end and the first segment.
	for at := 0; at < len(out); {
		size := int(binary.BigEndian.Uint32(out[at:]))
		binary.BigEndian.PutUint64(out[at+28:], binary.BigEndian.Uint64(out[at+28:])+uint64(len(out)-(at+size)+rest))
		at += size
	}
	free := make([]byte, rest)
	binary.BigEndian.PutUint32(free, uint32(rest))
	copy(free[4:], "free")
	return append(out, free...)
}

type streamPart struct{ track, i int }

// streamOrder is the order the tracks' parts are written in: by when each
// starts, so a player reading the file as it comes has each track's at the
// same time, though their parts' lengths differ (2 s of audio, 6 s of
// video); a track whose times aren't known, part by part, in turn with the
// others.
func streamPartCount(t streamTrack) int {
	if t.partAt != nil {
		return t.partCount
	}
	return len(t.parts)
}

func streamOrder(tracks []streamTrack) []streamPart {
	var out []streamPart
	timed := true
	for _, t := range tracks {
		timed = timed && len(t.starts) == streamPartCount(t)
	}
	next := make([]int, len(tracks))
	for {
		pick := -1
		for k, t := range tracks {
			if next[k] >= streamPartCount(t) {
				continue
			}
			if pick < 0 {
				pick = k
				continue
			}
			if timed {
				if t.starts[next[k]] < tracks[pick].starts[next[pick]] {
					pick = k
				}
			} else if next[k] < next[pick] {
				pick = k
			}
		}
		if pick < 0 {
			return out
		}
		out = append(out, streamPart{pick, next[pick]})
		next[pick]++
	}
}
