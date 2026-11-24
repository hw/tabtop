package main

// The page's screen wake lock (gowakelock.js): asked for by a secure top
// page after the person's own input there (recentInput), where the
// person's browser has one (goViewerCaps.WakeLock), it's allowed: the
// person's browser holds a wake lock of its own (go.js, go-wakelock) while
// any of the page's sentinels is held. Let go by the page (each sentinel),
// or gone with it (a load), the person's is let go too; the person's lost
// (wakelock-lost: it couldn't be held), the page's are released.

import (
	"encoding/json"
	"strings"
)

// goWakeAsk is the page's: a sentinel asked for (on, its id for the
// answer), or let go.
type goWakeAsk struct {
	On bool   `json:"on"`
	ID string `json:"id"`
}

const goWakeHeld = 32 // sentinels held at once, at most

// wakeLockAsks answers what the page in world asked of its wake lock.
func (b *goBrowser) wakeLockAsks(gen, world int, asks []goWakeAsk, recent bool) {
	was := len(b.wakeHeld)
	for _, a := range asks {
		if !goPasteID.MatchString(a.ID) {
			continue
		}
		if !a.On {
			delete(b.wakeHeld, a.ID)
			continue
		}
		ok := world == b.world && world != 0 && recent && b.viewerCaps.WakeLock &&
			strings.HasPrefix(b.docURL, "https://") && len(b.wakeHeld) < goWakeHeld
		if ok {
			if b.wakeHeld == nil {
				b.wakeHeld = map[string]bool{}
			}
			b.wakeHeld[a.ID] = true
			goDebugf("wake lock: allowed (%d held)", len(b.wakeHeld))
		} else {
			goDebugf("wake lock: refused (the page's own %v, after input %v, the viewer's %v)", world == b.world, recent, b.viewerCaps.WakeLock)
		}
		answer, _ := json.Marshal(map[string]any{"id": a.ID, "ok": ok})
		b.agentCall(world, "wakeLock", string(answer))
	}
	switch now := len(b.wakeHeld); {
	case was == 0 && now > 0:
		b.send(map[string]any{"type": "go-wakelock", "gen": gen, "on": true})
	case was > 0 && now == 0:
		b.send(map[string]any{"type": "go-wakelock", "gen": gen, "on": false})
	}
}

// wakeLockLost: the person's browser couldn't hold its wake lock: the
// page's sentinels are released.
func (b *goBrowser) wakeLockLost() {
	if len(b.wakeHeld) == 0 {
		return
	}
	goDebugf("wake lock: lost in the person's browser")
	b.wakeHeld = nil
	b.agentCall(b.world, "wakeLock", `{"lost":true}`)
}

// wakeLockAgain: a connection taking the tab back (resume): its browser
// holds the page's wake lock, if the page holds one.
func (b *goBrowser) wakeLockAgain() {
	if len(b.wakeHeld) > 0 {
		b.send(map[string]any{"type": "go-wakelock", "gen": b.gen, "on": true})
	}
}

// wakeLockGone: the page went (a load), its wake lock with it, the
// person's browser to let go of its own.
func (b *goBrowser) wakeLockGone() {
	if len(b.wakeHeld) == 0 {
		return
	}
	b.wakeHeld = nil
	b.send(map[string]any{"type": "go-wakelock", "gen": b.gen, "on": false})
}
