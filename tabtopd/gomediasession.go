package main

// The page's media session (gomediasession.js): what it says it's playing
// (title, artist, album, artwork), whether it's playing, where, and which
// of the person's media controls it answers, shown by the person's browser
// as its own session (go.js, go-media-session): on a phone's lock screen,
// its notification, a keyboard's media keys. Those it answers, pressed
// there, are the page's handlers' (media-action), as the person's own
// input in the page.
//
// The top page's only (a frame of its origin's is the page's; another
// origin's says nothing); its latest passed on as it changes, but a change
// of its position alone not more often than goMediaPositionEvery (the
// person's browser moves it on by its rate meanwhile). Its artwork fetched
// here, as the page's pictures are (goMediaArt of them, each goMediaArtMax
// at most, a raster picture), never by the person's browser. Gone with the
// page (leftPage), said again to the next to connect (connBack).

import (
	"context"
	"encoding/json"
	"math"
	"reflect"
	"slices"
	"time"
)

// goMediaActions are the actions passed on (the person's browser's own
// may be fewer: those it has).
var goMediaActions = []string{"play", "pause", "seekbackward", "seekforward", "previoustrack", "nexttrack", "skipad", "stop", "seekto",
	"togglemicrophone", "togglecamera", "togglescreenshare", "hangup", "previousslide", "nextslide", "enterpictureinpicture", "voiceactivity"}

const (
	goMediaPositionEvery = time.Second
	goMediaArt           = 3         // pictures of its artwork fetched, its first
	goMediaArtMax        = 512 << 10 // bytes of each
	goMediaArtKept       = 32        // fetched kept (a playlist's), by address
	goMediaArtWait       = 5 * time.Second
	goMediaText          = 300 // characters of its title, artist and album passed on
)

type goMediaImage struct {
	Src   string `json:"src"`
	Sizes string `json:"sizes"`
	Type  string `json:"type"`
}

type goMediaMetadata struct {
	Title   string         `json:"title"`
	Artist  string         `json:"artist"`
	Album   string         `json:"album"`
	Artwork []goMediaImage `json:"artwork"`
}

// goMediaPosition is where it's playing: Duration -1 is an endless one (a
// live stream's).
type goMediaPosition struct {
	Duration float64 `json:"duration"`
	Rate     float64 `json:"rate"`
	Position float64 `json:"position"`
}

// goMediaSessionOut is what the page last said of its session.
type goMediaSessionOut struct {
	Metadata *goMediaMetadata `json:"metadata"`
	State    string           `json:"state"`
	Actions  []string         `json:"actions"`
	Position *goMediaPosition `json:"position"`
}

// goMediaSessionTab is the tab's: its page's session as last sent (shown),
// a change of its position alone waiting its turn (later), and the
// artwork fetched (art: address -> data: address, "" if it wasn't one).
type goMediaSessionTab struct {
	shown    *goMediaSessionOut
	sentAt   time.Time
	later    *goMediaSessionOut
	waiting  bool // (later's turn to come: a timer's set)
	art      map[string]string
	fetching map[string]bool
}

// goMediaSessionClean is s within reason: its text cut, its actions those
// there are (each once), its state one there is, a position that's one.
func goMediaSessionClean(s goMediaSessionOut) goMediaSessionOut {
	out := goMediaSessionOut{State: "none", Actions: []string{}}
	if s.State == "paused" || s.State == "playing" {
		out.State = s.State
	}
	for _, a := range s.Actions {
		if slices.Contains(goMediaActions, a) && !slices.Contains(out.Actions, a) {
			out.Actions = append(out.Actions, a)
		}
	}
	if m := s.Metadata; m != nil {
		c := &goMediaMetadata{Title: goCut(m.Title, goMediaText), Artist: goCut(m.Artist, goMediaText), Album: goCut(m.Album, goMediaText), Artwork: []goMediaImage{}}
		for _, i := range m.Artwork[:min(len(m.Artwork), 8)] {
			c.Artwork = append(c.Artwork, goMediaImage{Src: i.Src, Sizes: goCut(i.Sizes, 100), Type: goCut(i.Type, 100)})
		}
		out.Metadata = c
	}
	if p := s.Position; p != nil {
		ok := func(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }
		if ok(p.Duration) && ok(p.Rate) && ok(p.Position) && (p.Duration >= 0 || p.Duration == -1) && p.Rate != 0 && p.Position >= 0 && (p.Duration == -1 || p.Position <= p.Duration) {
			out.Position = &goMediaPosition{Duration: p.Duration, Rate: p.Rate, Position: p.Position}
		}
	}
	return out
}

// mediaSession passes on the session the page in world (of gen) said.
func (b *goBrowser) mediaSession(gen, world int, s goMediaSessionOut) {
	if world != b.world || gen != b.gen {
		return
	}
	ms := &b.mediaSess
	clean := goMediaSessionClean(s)
	if ms.shown != nil && reflect.DeepEqual(*ms.shown, clean) {
		ms.later = nil
		return
	}
	// Its position alone changed, soon after the last: in its turn.
	if ms.shown != nil && time.Since(ms.sentAt) < goMediaPositionEvery {
		moved := *ms.shown
		moved.Position = clean.Position
		if reflect.DeepEqual(moved, clean) {
			ms.later = &clean
			if !ms.waiting {
				ms.waiting = true
				time.AfterFunc(goMediaPositionEvery-time.Since(ms.sentAt), func() {
					b.post(func() {
						ms.waiting = false
						if l := ms.later; l != nil && gen == b.gen {
							ms.later = nil
							b.sendMediaSession(*l)
						}
					})
				})
			}
			return
		}
	}
	ms.later = nil
	b.sendMediaSession(clean)
}

// sendMediaSession sends s (with its artwork fetched so far: the rest
// fetched, and s sent again once they've come).
func (b *goBrowser) sendMediaSession(s goMediaSessionOut) {
	ms := &b.mediaSess
	ms.shown, ms.sentAt = &s, time.Now()
	m := map[string]any{"type": "go-media-session", "gen": b.gen, "state": s.State, "actions": s.Actions, "position": s.Position, "metadata": nil}
	if md := s.Metadata; md != nil {
		art := []goMediaImage{}
		var fetch []string
		for _, i := range md.Artwork[:min(len(md.Artwork), goMediaArt)] {
			data, ok := ms.art[i.Src]
			switch {
			case !ok && !ms.fetching[i.Src]:
				fetch = append(fetch, i.Src)
			case ok && data != "":
				art = append(art, goMediaImage{Src: data, Sizes: i.Sizes, Type: i.Type})
			}
		}
		m["metadata"] = map[string]any{"title": md.Title, "artist": md.Artist, "album": md.Album, "artwork": art}
		if len(fetch) > 0 {
			b.mediaArtwork(b.gen, fetch)
		}
	}
	b.send(m)
}

// mediaArtwork fetches the pictures at srcs, and sends the session again
// with them, if the page's still there.
func (b *goBrowser) mediaArtwork(gen int, srcs []string) {
	ms := &b.mediaSess
	if ms.fetching == nil {
		ms.fetching = map[string]bool{}
	}
	for _, src := range srcs {
		ms.fetching[src] = true
	}
	go func() {
		ctx, cancel := context.WithTimeout(b.ctx, goMediaArtWait)
		defer cancel()
		got := map[string]string{}
		for _, src := range srcs {
			got[src] = b.notifyPicture(ctx, src, goMediaArtMax)
		}
		b.post(func() {
			if ms.art == nil || len(ms.art)+len(got) > goMediaArtKept {
				ms.art = map[string]string{}
			}
			for src, data := range got {
				ms.art[src] = data
				delete(ms.fetching, src)
			}
			goDebugf("media session: %d of its artwork fetched", len(got))
			if gen == b.gen && ms.shown != nil {
				b.sendMediaSession(*ms.shown)
			}
		})
	}()
}

// mediaSessionGone clears the session of the page left.
func (b *goBrowser) mediaSessionGone() {
	ms := &b.mediaSess
	ms.later = nil
	if ms.shown == nil {
		return
	}
	ms.shown = nil
	b.send(map[string]any{"type": "go-media-session", "gen": b.gen, "state": "none", "actions": []string{}, "position": nil, "metadata": nil})
}

// mediaSessionAgain says the session to a viewer connecting again.
func (b *goBrowser) mediaSessionAgain() {
	if s := b.mediaSess.shown; s != nil {
		b.sendMediaSession(*s)
	}
}

// mediaAction is the person's media control pressed (m.Kind, its action;
// m.DX, the time it seeks to or by; m.Checked, a fast seek): the page's
// handler for it called, if it has one, as the person's input in the page.
func (b *goBrowser) mediaAction(m goClientMsg) {
	s := b.mediaSess.shown
	if s == nil || !slices.Contains(s.Actions, m.Kind) || b.shown != b.gen {
		return
	}
	b.inputAt, b.inputGen, b.inputWorld = time.Now(), b.gen, b.world
	if b.e != nil {
		b.e.use()
	}
	a := map[string]any{"action": m.Kind}
	if (m.Kind == "seekto" || m.Kind == "seekbackward" || m.Kind == "seekforward") && !math.IsNaN(m.DX) && !math.IsInf(m.DX, 0) && m.DX >= 0 {
		a["time"] = m.DX
	}
	if m.Kind == "seekto" && m.Checked {
		a["fast"] = true
	}
	j, _ := json.Marshal(a)
	goDebugf("media session: %s pressed", m.Kind)
	b.agentCall(b.world, "mediaAction", string(j))
}
