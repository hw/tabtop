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

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/url"
	"slices"
	"strings"
	"sync"

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
	gen     int                     // the page's they're of
	pending map[string]goStreamSeen // by request: waiting for its body
	found   []string                // offered
	parts   map[string]bool         // a master's variant and audio playlists
	queue   chan goStreamSeen
}

type goStreamSeen struct {
	id, url string
	gen     int
}

// at has s be the page at gen's, from scratch if it was another's (s.mu
// held).
func (s *goStreams) at(gen int) {
	if s.gen == gen && s.pending != nil {
		return
	}
	s.gen, s.pending, s.found, s.parts = gen, map[string]goStreamSeen{}, nil, map[string]bool{}
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
	// again every few seconds): not read again.
	if id == "" || s.parts[u] || slices.Contains(s.found, u) || len(s.pending) >= maxGoStreamsPending {
		return
	}
	s.pending[id] = goStreamSeen{id: id, url: u, gen: b.gen}
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

// streamsLeft is the page gone to another place in itself (a single-page
// site's next video, by pushState): its streams afresh, told to the page.
func (b *goBrowser) streamsLeft() {
	s := &b.streams
	s.mu.Lock()
	had := len(s.found) > 0
	s.pending = nil
	s.at(b.gen)
	s.mu.Unlock()
	if had {
		b.send(map[string]any{"type": "go-manifests-clear", "gen": b.gen})
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
			b.offerStream(m, body)
		}
	}
}

// offerStream offers m's stream (its manifest's body, nil if the engine
// couldn't give it), unless it's part of one offered, or offered already.
func (b *goBrowser) offerStream(m goStreamSeen, body []byte) {
	u, err := url.Parse(m.url)
	if err != nil {
		return
	}
	var parts []string
	master := false
	if bytes.HasPrefix(bytes.TrimSpace(body), []byte("#EXTM3U")) {
		if p, kind, err := m3u8.Decode(*bytes.NewBuffer(body), true); err == nil && kind == m3u8.MASTER {
			master = true
			for _, v := range p.(*m3u8.MasterPlaylist).Variants {
				if v == nil {
					continue
				}
				parts = append(parts, v.URI)
				for _, a := range v.Alternatives {
					if a != nil {
						parts = append(parts, a.URI)
					}
				}
			}
		}
	}
	s := &b.streams
	s.mu.Lock()
	if s.gen != m.gen || s.pending == nil {
		s.mu.Unlock()
		return // the page it was of is left
	}
	for _, part := range parts {
		if r, err := u.Parse(part); part != "" && err == nil {
			s.parts[r.String()] = true
		}
	}
	if !master && s.parts[m.url] || slices.Contains(s.found, m.url) {
		s.mu.Unlock()
		return
	}
	// The newest kept: past maxGoStreams, the oldest goes (as the page's
	// list does).
	if len(s.found) >= maxGoStreams {
		s.found = slices.Delete(s.found, 0, 1)
	}
	s.found = append(s.found, m.url)
	s.mu.Unlock()
	b.send(map[string]any{"type": "go-manifest", "gen": m.gen, "url": m.url})
}

// resendStreams sends the page's streams again, to a page taking the tab
// back.
func (b *goBrowser) resendStreams() {
	s := &b.streams
	s.mu.Lock()
	found, gen := slices.Clone(s.found), s.gen
	s.mu.Unlock()
	if gen != b.gen {
		return
	}
	for _, u := range found {
		b.send(map[string]any{"type": "go-manifest", "gen": gen, "url": u})
	}
}
