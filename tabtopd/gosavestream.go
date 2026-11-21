package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/Eyevinn/mp4ff/bits"
	"github.com/Eyevinn/mp4ff/mp4"
	"github.com/grafov/m3u8"
)

const manifestLimit = 2 << 20
const segmentLimit = 32 << 20

type streamTrack struct {
	base   *url.URL
	init   string
	parts  []string
	starts []float64 // each part's start, in seconds; nil if not known
	ids    map[uint32]uint32
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
		// The address refused, or the save cancelled: not again.
		return nil, nil, s.ctx.Err() == nil && !errors.Is(err, errFetchAddress), fetchError(err)
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
	playlist, _, err := m3u8.Decode(*bytes.NewBuffer(data), true)
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
		at := 0.0
		for _, seg := range p.Segments {
			if seg == nil {
				continue
			}
			if seg.Key != nil && seg.Key.Method != "NONE" || seg.Discontinuity || seg.Limit != 0 || seg.Map != nil && (seg.Map.URI != t.init || seg.Map.Limit != 0) {
				return nil, errors.New("unsupported encryption, byte range, or track change")
			}
			t.parts = append(t.parts, seg.URI)
			t.starts = append(t.starts, at)
			at += seg.Duration
		}
		if t.init == "" || len(t.parts) == 0 || p.Map.Limit != 0 {
			return nil, errors.New("Save stream requires fragmented MP4 segments")
		}
		return []streamTrack{t}, nil
	}
	return nil, errors.New("unsupported manifest")
}

// Each fragment keeps its original sample offsets and decode timestamps. Only
// fixed-width track IDs and fragment sequence numbers change in the media.
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

func rewriteStreamFragment(data []byte, ids map[uint32]uint32, seq *uint32) error {
	var moof, mdat bool
	err := streamBoxes(data, func(kind, body []byte) error {
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
					*seq++
					binary.BigEndian.PutUint32(b[4:], *seq)
				case "traf":
					return streamBoxes(b, func(k, f []byte) error {
						if string(k) == "senc" {
							return errors.New("encrypted fragments are unsupported")
						}
						if string(k) == "tfhd" {
							if len(f) < 8 {
								return io.ErrUnexpectedEOF
							}
							id := ids[binary.BigEndian.Uint32(f[4:])]
							if id == 0 || f[3]&1 != 0 {
								return errors.New("unsupported fragment addressing")
							}
							binary.BigEndian.PutUint32(f[4:], id)
						}
						return nil
					})
				}
				return nil
			})
		case "sidx", "ssix", "mfra", "styp":
			// Keep the byte layout for relative sample offsets.
			copy(kind, "free")
		case "moov":
			return errors.New("unexpected initialization segment")
		}
		return nil
	})
	if err == nil && (!moof || !mdat) {
		return errors.New("invalid fragmented MP4 segment")
	}
	return err
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
		if trak.Tkhd == nil || trak.Mdia == nil || trak.Mdia.Minf == nil || trak.Mdia.Minf.Stbl == nil || trak.Mdia.Minf.Stbl.Stsd == nil {
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

func (m *fetchManager) saveStream(ctx context.Context, j *fetchJob, u *url.URL, up *upload) (string, error) {
	// Called what it's saved as, from the start (not the manifest's name).
	name := streamName(u)
	j.set(func(j *fetchJob) { j.name = name })
	client := *j.client
	client.Timeout = 0 // (a stall stops a request instead: streamReader)
	redirect := client.CheckRedirect
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
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
	var init *mp4.InitSegment
	var nextID uint32 = 1
	for i := range tracks {
		t := &tracks[i]
		data, _, err := reader.read(t.base, t.init, manifestLimit)
		if err != nil {
			return "", err
		}
		header, err := decodeStreamInit(data)
		if err != nil {
			return "", err
		}
		t.ids = make(map[uint32]uint32)
		for _, trak := range header.Moov.Traks {
			id := trak.Tkhd.TrackID
			if id == 0 || t.ids[id] != 0 {
				return "", errors.New("invalid track ID")
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
						return "", errors.New("invalid movie timescale")
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
				return "", errors.New("invalid track defaults")
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
		return "", errors.New("no media tracks")
	}
	init.Moov.Mvhd.NextTrackID = nextID
	if err := init.Encode(up); err != nil {
		return "", err
	}
	totalParts := 0
	for _, t := range tracks {
		totalParts += len(t.parts)
	}
	j.set(func(j *fetchJob) { j.parts = totalParts })
	var seq uint32
	for _, part := range streamOrder(tracks) {
		t := tracks[part.track]
		data, _, err := reader.read(t.base, t.parts[part.i], segmentLimit)
		if err != nil {
			return "", err
		}
		if err := rewriteStreamFragment(data, t.ids, &seq); err != nil {
			return "", err
		}
		if free, _, ok := m.files.uploadRoom(up.f); ok && free < int64(len(data))+fetchSpare {
			return "", errors.New("insufficient disk space for stream")
		}
		if _, err := up.Write(data); err != nil {
			return "", err
		}
		j.set(func(j *fetchJob) { j.got += int64(len(data)); j.partsDone++ })
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return name, nil
}

type streamPart struct{ track, i int }

// streamOrder is the order the tracks' parts are written in: by when each
// starts, so a player reading the file as it comes has each track's at the
// same time, though their parts' lengths differ (2 s of audio, 6 s of
// video); a track whose times aren't known, part by part, in turn with the
// others.
func streamOrder(tracks []streamTrack) []streamPart {
	var out []streamPart
	timed := true
	for _, t := range tracks {
		timed = timed && len(t.starts) == len(t.parts)
	}
	next := make([]int, len(tracks))
	for {
		pick := -1
		for k, t := range tracks {
			if next[k] >= len(t.parts) {
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
