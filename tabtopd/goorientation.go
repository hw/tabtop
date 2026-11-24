package main

// The page's screen orientation lock (goorientation.js): asked for while
// the page is in its own fullscreen (gofullscreen.go: allowed after the
// person's press), from its world, where the person's browser can lock
// (goViewerCaps.Orientation), the person's browser locks its screen (go.js,
// go-orientation) and its answer is the page's (orientation-answer).
// Unlocked by the page, or with its fullscreen or the page gone, it's
// unlocked there too.

import (
	"encoding/json"
	"slices"
	"time"
)

// goOrientAsk is the page's: a lock (its type, and its id for the answer),
// or an unlock.
type goOrientAsk struct {
	Lock   string `json:"lock"`
	ID     string `json:"id"`
	Unlock bool   `json:"unlock"`
}

var goOrientTypes = []string{"any", "natural", "landscape", "portrait", "portrait-primary", "portrait-secondary", "landscape-primary", "landscape-secondary"}

// goOrientWait is how long a lock waits for the person's browser's answer.
const goOrientWait = 10 * time.Second

// goOrientLock is a lock asked of the person's browser: whose, for the
// answer.
type goOrientLock struct {
	gen, world int
	at         time.Time
}

// orientationAsks passes on the page's locks and unlocks.
func (b *goBrowser) orientationAsks(gen, world int, asks []goOrientAsk) {
	for _, a := range asks {
		if a.Unlock {
			if b.orientLocked {
				b.orientLocked = false
				b.send(map[string]any{"type": "go-orientation", "gen": gen, "unlock": true})
			}
			continue
		}
		if !goPasteID.MatchString(a.ID) || !slices.Contains(goOrientTypes, a.Lock) {
			continue
		}
		f := b.fullscreen
		switch {
		case f == nil || f.world != world || f.gen != gen:
			goDebugf("orientation: not in its fullscreen: refused")
			b.orientAnswer(world, a.ID, false, "SecurityError")
		case !b.viewerCaps.Orientation:
			b.orientAnswer(world, a.ID, false, "NotSupportedError")
		default:
			for id, l := range b.orientAsks {
				if time.Since(l.at) > goOrientWait || l.gen != b.gen {
					delete(b.orientAsks, id)
				}
			}
			if len(b.orientAsks) >= 4 {
				b.orientAnswer(world, a.ID, false, "AbortError")
				continue
			}
			if b.orientAsks == nil {
				b.orientAsks = map[string]goOrientLock{}
			}
			b.orientAsks[a.ID] = goOrientLock{gen: gen, world: world, at: time.Now()}
			b.send(map[string]any{"type": "go-orientation", "gen": gen, "lock": a.Lock, "id": a.ID})
		}
	}
}

// orientAnswer gives the page in world its lock's answer.
func (b *goBrowser) orientAnswer(world int, id string, ok bool, why string) {
	j, _ := json.Marshal(map[string]any{"id": id, "ok": ok, "error": why})
	b.agentCall(world, "orientation", string(j))
}

// orientationAnswered: the person's browser locked (or couldn't) for the
// lock m.Text names, m.Value its error's name.
func (b *goBrowser) orientationAnswered(m goClientMsg) {
	l, ok := b.orientAsks[m.Text]
	if !ok {
		return
	}
	delete(b.orientAsks, m.Text)
	if l.gen != b.gen {
		return
	}
	locked := m.Value == ""
	if locked {
		b.orientLocked = true
	}
	b.orientAnswer(l.world, m.Text, locked, m.Value)
}

// orientationGone: the page's fullscreen left, or the page gone: its lock
// let go there.
func (b *goBrowser) orientationGone() {
	b.orientAsks = nil
	if b.orientLocked {
		b.orientLocked = false
		b.send(map[string]any{"type": "go-orientation", "gen": b.gen, "unlock": true})
	}
}
