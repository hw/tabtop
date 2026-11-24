package main

// The page's pointer lock (gopointerlock.js): asked for by the top page
// after the person's input there (recentInput, as a browser asks for its
// activation), where the person's browser can lock (goViewerCaps.
// PointerLock), the person's browser locks its pointer to the copy (go.js,
// go-frame.js, go-pointerlock). Once it has (pointerlock "on"), the page's
// told, and the pointer's moves, buttons and wheel come as "locked" input,
// given to the locked element by the agent (goagent.js). Left there (Esc,
// its window left: "off"), refused there ("error"), left by the page, or
// gone with it (a load), it's left in both.

import (
	"context"
	"encoding/json"
	"time"
)

// goPointerAsk is the page's: a lock asked for (its id, for the answer), or
// left.
type goPointerAsk struct {
	On bool   `json:"on"`
	ID string `json:"id"`
}

// goPointerLock is the page's lock: asked of the person's browser, or held
// there.
type goPointerLock struct {
	gen, world int
	id         string
	held       bool
	at         time.Time
}

// goPointerLockWait is how long the person's browser has to lock.
const goPointerLockWait = 8 * time.Second

// pointerLockAsks passes on what the page in world asked of its lock.
func (b *goBrowser) pointerLockAsks(gen, world int, asks []goPointerAsk, recent bool) {
	for _, a := range asks {
		if !a.On {
			if l := b.pointerLock; l != nil && l.world == world {
				b.pointerLock = nil
				b.send(map[string]any{"type": "go-pointerlock", "gen": gen, "on": false})
			}
			continue
		}
		if !goPasteID.MatchString(a.ID) {
			continue
		}
		// One asked of the person's browser and not answered (long ago):
		// let go.
		if l := b.pointerLock; l != nil && !l.held && time.Since(l.at) > goPointerLockWait {
			b.pointerLockAnswer(l, false)
			b.pointerLock = nil
		}
		ok := world == b.world && world != 0 && recent && b.viewerCaps.PointerLock && (b.pointerLock == nil || b.pointerLock.held)
		if !ok {
			goDebugf("pointer lock: refused (the page's own %v, after input %v, the viewer's %v)", world == b.world, recent, b.viewerCaps.PointerLock)
			b.pointerLockAnswer(&goPointerLock{world: world, id: a.ID}, false)
			continue
		}
		b.pointerLock = &goPointerLock{gen: gen, world: world, id: a.ID, at: time.Now()}
		goDebugf("pointer lock: asked of the person's browser")
		b.send(map[string]any{"type": "go-pointerlock", "gen": gen, "on": true})
	}
}

// pointerLockAnswer gives the page its lock's answer.
func (b *goBrowser) pointerLockAnswer(l *goPointerLock, ok bool) {
	j, _ := json.Marshal(map[string]any{"id": l.id, "ok": ok})
	b.agentCall(l.world, "pointerLock", string(j))
}

// pointerLockState: the person's browser locked ("on"), couldn't
// ("error"), or left it ("off").
func (b *goBrowser) pointerLockState(state string) {
	l := b.pointerLock
	if l == nil || l.gen != b.gen {
		return
	}
	switch state {
	case "on":
		if !l.held {
			l.held = true
			goDebugf("pointer lock: held")
			b.pointerLockAnswer(l, true)
		}
	case "error":
		if !l.held {
			b.pointerLock = nil
			b.pointerLockAnswer(l, false)
		}
	case "off":
		b.pointerLock = nil
		if l.held {
			goDebugf("pointer lock: left by the person")
			b.agentCall(l.world, "pointerLock", `{"exit":true}`)
		} else {
			b.pointerLockAnswer(l, false)
		}
	}
}

// lockedInput gives the locked pointer's move, button or wheel to the page.
func (b *goBrowser) lockedInput(m goClientMsg) {
	l := b.pointerLock
	if l == nil || !l.held || l.gen != b.gen || m.Gen != b.gen {
		return
	}
	switch m.Type {
	case "move", "wheel":
		if b.acts.waiting() >= goActsWaiting/2 {
			return // the page isn't keeping up: a move or turn dropped
		}
	case "down", "up":
		if b.acts.waiting() >= goActsWaiting {
			return
		}
	default:
		return
	}
	what := map[string]any{"kind": "locked", "phase": m.Type, "dx": m.DX, "dy": m.DY, "button": m.Button, "buttons": m.Buttons,
		"shift": m.Shift, "ctrl": m.Ctrl, "alt": m.Alt, "meta": m.Meta}
	world, gen := l.world, l.gen
	b.acts.add(func() {
		ctx, cancel := context.WithTimeout(b.ctx, goCallTimeout)
		defer cancel()
		b.agentInput(ctx, world, what)
		b.post(func() { b.afterInput(gen) })
	})
}

// pointerLockLost: the person's browser went (its connection lost): its
// lock with it, the page told it's left (or refused, if it wasn't yet).
func (b *goBrowser) pointerLockLost() {
	l := b.pointerLock
	if l == nil || l.gen != b.gen {
		b.pointerLock = nil
		return
	}
	b.pointerLockState("off")
}

// pointerLockGone: the page went (a load), its lock with it, the person's
// browser to leave it too.
func (b *goBrowser) pointerLockGone() {
	if b.pointerLock == nil {
		return
	}
	b.pointerLock = nil
	b.send(map[string]any{"type": "go-pointerlock", "gen": b.gen, "on": false})
}
