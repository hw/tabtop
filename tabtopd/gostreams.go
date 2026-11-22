package main

// The streams a tab's page plays: the HLS and DASH manifests its engine
// fetches, offered as Save stream (go.js, the player's picker; saved by
// gosavestream.go). Each manifest is read once it's loaded (its body, from
// the engine), in the order they finish, so a master playlist is read
// before the playlists it names, which the player fetches after it: those
// (its variants, its audio) aren't offered on their own, as saved alone
// they'd be the video without its sound, or the sound alone; the master
// is, and saves both. What's offered is kept for the page shown, and sent
// again to a page that takes the tab back (goresume.go).
//
// Each is offered with what it is, as far as its manifests say: how tall
// its best picture is, and how long it lasts (or that it's live). A
// master playlist doesn't say how long: that comes with the first of its
// playlists the player loads (read, not offered), the master offered again
// with it. The page names the streams by it, and passes over an ad's, a
// short one beside a long one (go.js).

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"encoding/xml"
	"log"
	"math"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/grafov/m3u8"
)

// maxGoStreams is how many streams a page has offered; maxGoStreamsPending
// how many manifests wait for their bodies.
const (
	maxGoStreams        = 24
	maxGoStreamsPending = 64
)

type goStreams struct {
	mu      sync.Mutex
	gen     int                      // the page's they're of
	pending map[string]goStreamSeen  // by request: waiting for its body
	found   []string                 // offered
	about   map[string]goStreamAbout // what each offered is, by its address
	parts   map[string]string        // a master's variant and audio playlists: the master's
	queue   chan goStreamSeen
	// stale: the page's gone elsewhere in itself (pushState, replaceState):
	// what's offered is kept (a player's ?t=, or tracking taken out of the
	// address, is the same video) till another stream's offered.
	stale bool
	// gone: the last place's masters and their playlists, when another's
	// took their place: read again (a live player still polling), not
	// offered as streams of their own. True for those offered (a master):
	// once the page goes elsewhere again, they may be (Back to it); its
	// playlists stay gone till it is.
	gone map[string]bool
}

// goStreamAbout is what a stream offered is: its best picture's height
// (0 if not said), and how long it lasts in seconds (0 if not yet known),
// or that it's live (no end).
type goStreamAbout struct {
	Height   int     `json:"height,omitempty"`
	Duration float64 `json:"duration,omitempty"`
	Live     bool    `json:"live,omitempty"`
}

// timed is whether how long it lasts is known (or that it's live).
func (a goStreamAbout) timed() bool { return a.Duration > 0 || a.Live }

type goStreamSeen struct {
	id, url string
	gen     int
	at      time.Time // when its response came
}

// goStreamPendingFor is how long a manifest's response waits to load: one
// whose loading's end never came (its event dropped) is let go after it.
const goStreamPendingFor = time.Minute

// at has s be the page at gen's, from scratch if it was another's (s.mu
// held).
func (s *goStreams) at(gen int) {
	if s.gen == gen && s.pending != nil {
		return
	}
	s.gen, s.pending, s.found, s.about, s.parts, s.stale, s.gone = gen, map[string]goStreamSeen{}, nil, map[string]goStreamAbout{}, map[string]string{}, false, nil
}

// goManifestResponse is whether a response is a stream's manifest, by its
// type or its address's name.
func goManifestResponse(mime, path string) bool {
	mime, path = strings.ToLower(mime), strings.ToLower(path)
	return strings.Contains(mime, "mpegurl") || strings.Contains(mime, "dash+xml") || strings.HasSuffix(path, ".m3u8") || strings.HasSuffix(path, ".mpd")
}

// streamSeen notes a manifest's response (the tab's event loop): read once
// it's loaded.
func (b *goBrowser) streamSeen(id, u string) {
	s := &b.streams
	s.mu.Lock()
	defer s.mu.Unlock()
	s.at(b.gen)
	// Offered already, or part of one that is (a live playlist asked for
	// again every few seconds): not read again; but a part is, until its
	// master's length is known from one (and while its master's offered:
	// one let go, past maxGoStreams, has nothing to learn).
	master, part := s.parts[u]
	if _, gone := s.gone[u]; id == "" || gone || part && (s.about[master].timed() || !slices.Contains(s.found, master)) || slices.Contains(s.found, u) {
		return
	}
	if len(s.pending) >= maxGoStreamsPending {
		for k, seen := range s.pending {
			if time.Since(seen.at) > goStreamPendingFor {
				delete(s.pending, k)
			}
		}
		if len(s.pending) >= maxGoStreamsPending {
			return
		}
	}
	s.pending[id] = goStreamSeen{id: id, url: u, gen: b.gen, at: time.Now()}
}

// streamFailed is a request failed (the tab's event loop): a manifest
// noted is let go.
func (b *goBrowser) streamFailed(ev cdpEvent) {
	var p struct {
		ID string `json:"requestId"`
	}
	if json.Unmarshal(ev.Params, &p) != nil {
		return
	}
	s := &b.streams
	s.mu.Lock()
	delete(s.pending, p.ID)
	s.mu.Unlock()
}

// streamsLeft is the page gone to another place in itself (pushState,
// replaceState): its streams offered are kept till another's offered (a
// single-page site's next video), which takes their place (offerStream).
// An address rewritten for the same video keeps them.
func (b *goBrowser) streamsLeft() {
	s := &b.streams
	s.mu.Lock()
	s.at(b.gen)
	s.stale = len(s.found) > 0
	// (Gone elsewhere again: the streams let go before may be this place's,
	// gone back to; their playlists, polled by a player still, aren't
	// streams of their own: gone till their master's offered again.)
	for u, offered := range s.gone {
		if offered {
			delete(s.gone, u)
		}
	}
	stale := s.stale
	s.mu.Unlock()
	// The page told: the streams it has are the last place's, perhaps (a
	// player's own buffer, there, the likelier).
	if stale {
		b.send(map[string]any{"type": "go-manifests-stale", "gen": b.gen})
	}
}

// streamLoaded is a request finished (the tab's event loop): a manifest
// noted is read, in turn.
func (b *goBrowser) streamLoaded(ev cdpEvent) {
	var p struct {
		ID string `json:"requestId"`
	}
	if json.Unmarshal(ev.Params, &p) != nil {
		return
	}
	s := &b.streams
	s.mu.Lock()
	seen, ok := s.pending[p.ID]
	delete(s.pending, p.ID)
	if ok && s.queue == nil {
		s.queue = make(chan goStreamSeen, maxGoStreamsPending)
		go b.readStreams(s.queue)
	}
	q := s.queue
	s.mu.Unlock()
	if ok {
		select {
		case q <- seen:
		default: // (more than a page offers: left)
		}
	}
}

func (b *goBrowser) readStreams(q chan goStreamSeen) {
	for {
		select {
		case <-b.ctx.Done():
			return
		case m := <-q:
			ctx, cancel := context.WithTimeout(b.ctx, goCallTimeout)
			var r struct {
				Body   string `json:"body"`
				Base64 bool   `json:"base64Encoded"`
			}
			var body []byte
			if b.cdp.call(ctx, b.page, "Network.getResponseBody", map[string]string{"requestId": m.id}, &r) == nil {
				body = []byte(r.Body)
				if r.Base64 {
					body, _ = base64.StdEncoding.DecodeString(r.Body)
				}
			}
			cancel()
			b.offerStreamSafely(m, body)
		}
	}
}

// offerStreamSafely is offerStream, a panic in it (what a website sent,
// read) logged and passed over, not the end of tabtopd.
func (b *goBrowser) offerStreamSafely(m goStreamSeen, body []byte) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("go: a stream's manifest couldn't be read: %v", r)
		}
	}()
	b.offerStream(m, body)
}

// offerStream offers m's stream (its manifest's body, nil if the engine
// couldn't give it), with what it is, unless it's part of one offered, or
// offered already. A part read tells its master's length: the master's
// offered again with it.
func (b *goBrowser) offerStream(m goStreamSeen, body []byte) {
	u, err := url.Parse(m.url)
	if err != nil {
		return
	}
	about, parts, master := goReadManifest(body)
	s := &b.streams
	s.mu.Lock()
	if s.gen != m.gen || s.pending == nil {
		s.mu.Unlock()
		return // the page it was of is left
	}
	// A new stream after the page went elsewhere in itself: the next
	// video's, in place of those offered before.
	// (The page told once s.mu's let go, before what's offered now.)
	cleared := false
	_, wasGone := s.gone[m.url]
	if _, part := s.parts[m.url]; s.stale && !part && !slices.Contains(s.found, m.url) && !wasGone {
		if s.gone == nil || len(s.gone) > 512 {
			s.gone = map[string]bool{}
		}
		for _, u := range s.found {
			s.gone[u] = true
		}
		for u := range s.parts {
			if _, offered := s.gone[u]; !offered {
				s.gone[u] = false
			}
		}
		s.found, s.about, s.parts, s.stale = nil, map[string]goStreamAbout{}, map[string]string{}, false
		cleared = true
	}
	if _, gone := s.gone[m.url]; gone {
		s.mu.Unlock()
		return // (the last place's, read again)
	}
	unlock := func() {
		s.mu.Unlock()
		if cleared {
			b.send(map[string]any{"type": "go-manifests-clear", "gen": m.gen})
		}
	}
	for _, part := range parts {
		if r, err := u.Parse(part); part != "" && err == nil {
			if _, had := s.parts[r.String()]; !had {
				s.parts[r.String()] = m.url
			}
			if !s.gone[r.String()] {
				delete(s.gone, r.String()) // (its again, its master offered)
			}
		}
	}
	if of, part := s.parts[m.url]; !master && part {
		// Its master's: how long it lasts, if that's not known yet.
		was := s.about[of]
		if !slices.Contains(s.found, of) || was.timed() || !about.timed() {
			unlock()
			return
		}
		was.Duration, was.Live = about.Duration, about.Live
		s.about[of] = was
		unlock()
		b.send(goManifestMessage(m.gen, of, was))
		return
	}
	if slices.Contains(s.found, m.url) {
		unlock()
		return
	}
	// The newest kept: past maxGoStreams, the oldest goes (as the page's
	// list does).
	if len(s.found) >= maxGoStreams {
		gone := s.found[0]
		delete(s.about, gone)
		s.found = slices.Delete(s.found, 0, 1)
		for part, of := range s.parts {
			if of == gone {
				delete(s.parts, part)
			}
		}
	}
	s.found = append(s.found, m.url)
	s.about[m.url] = about
	unlock()
	b.send(goManifestMessage(m.gen, m.url, about))
}

// goManifestMessage tells the page of a stream offered, and what it is.
func goManifestMessage(gen int, u string, about goStreamAbout) map[string]any {
	msg := map[string]any{"type": "go-manifest", "gen": gen, "url": u}
	if about.Height > 0 {
		msg["height"] = about.Height
	}
	if about.Duration > 0 {
		msg["duration"] = math.Round(about.Duration)
	}
	if about.Live {
		msg["live"] = true
	}
	return msg
}

// goReadManifest reads what a manifest (an HLS playlist or a DASH MPD)
// says of its stream: its best picture's height and how long it lasts;
// and, for a master playlist, the playlists it names.
func goReadManifest(body []byte) (about goStreamAbout, parts []string, master bool) {
	trimmed := bytes.TrimSpace(body)
	if bytes.HasPrefix(trimmed, []byte("#EXTM3U")) {
		p, kind, err := decodeM3U8(body)
		if err != nil {
			return
		}
		if kind == m3u8.MASTER {
			for _, v := range p.(*m3u8.MasterPlaylist).Variants {
				if v == nil {
					continue
				}
				about.Height = max(about.Height, goStreamHeight(v.Resolution))
				parts = append(parts, v.URI)
				for _, a := range v.Alternatives {
					if a != nil {
						parts = append(parts, a.URI)
					}
				}
			}
			return about, parts, true
		}
		if media, ok := p.(*m3u8.MediaPlaylist); ok {
			if !media.Closed {
				about.Live = true
				return
			}
			for _, seg := range media.Segments {
				if seg != nil && seg.Duration > 0 {
					about.Duration += seg.Duration
				}
			}
		}
		return
	}
	if bytes.HasPrefix(trimmed, []byte("<")) {
		var mpd struct {
			Type     string `xml:"type,attr"`
			Duration string `xml:"mediaPresentationDuration,attr"`
			Periods  []struct {
				Duration string `xml:"duration,attr"`
				Sets     []struct {
					Height int `xml:"height,attr"`
					Reps   []struct {
						Height int `xml:"height,attr"`
					} `xml:"Representation"`
				} `xml:"AdaptationSet"`
			} `xml:"Period"`
		}
		if xml.Unmarshal(body, &mpd) != nil {
			return
		}
		if mpd.Type == "dynamic" {
			about.Live = true
		} else if d, err := dashDuration(mpd.Duration); err == nil && d > 0 {
			about.Duration = d
		} else {
			for _, p := range mpd.Periods {
				if d, err := dashDuration(p.Duration); err == nil && d > 0 {
					about.Duration += d
				}
			}
		}
		for _, p := range mpd.Periods {
			for _, set := range p.Sets {
				about.Height = max(about.Height, set.Height)
				for _, r := range set.Reps {
					about.Height = max(about.Height, r.Height)
				}
			}
		}
	}
	return
}

// goStreamHeight is the height in an HLS RESOLUTION ("1920x1080"), 0 if
// it doesn't say one.
func goStreamHeight(resolution string) int {
	_, h, ok := strings.Cut(strings.ToLower(resolution), "x")
	if !ok {
		return 0
	}
	n := 0
	for _, c := range h {
		if c < '0' || c > '9' || n > 100000 {
			return 0
		}
		n = n*10 + int(c-'0')
	}
	return n
}

// resendStreams sends the page's streams again, to a page taking the tab
// back.
func (b *goBrowser) resendStreams() {
	s := &b.streams
	s.mu.Lock()
	found, gen, stale := slices.Clone(s.found), s.gen, s.stale
	about := make([]goStreamAbout, len(found))
	for i, u := range found {
		about[i] = s.about[u]
	}
	s.mu.Unlock()
	if gen != b.gen {
		return
	}
	for i, u := range found {
		b.send(goManifestMessage(gen, u, about[i]))
	}
	if stale && len(found) > 0 {
		b.send(map[string]any{"type": "go-manifests-stale", "gen": gen}) // (the page's moved in itself since)
	}
}
