package main

// The page's fullscreen (gofullscreen.js): asked for after the person's
// own input (goChooserAfterInput, as a browser asks for its activation),
// it's allowed: the element is laid over the engine's window, and over its
// frames' (an iframe of another origin's, laid over its parent's window,
// here: fullscreenHost), and the person's browser shows the page alone,
// over its screen (go.js, go-fullscreen). Left by the page, the person's
// browser leaves it; left by the person (fullscreen-exit), the page's told.

import "encoding/json"

// goFullscreenAsk is the page's: on, asked for (its id, for the answer),
// or not, left.
type goFullscreenAsk struct {
	On bool   `json:"on"`
	ID string `json:"id"`
}

// goFullscreen is the page's fullscreen, allowed: the world its element's
// in, and the iframes laid over their windows for it.
type goFullscreen struct {
	gen, world int
	hosts      []goFullscreenHost
}

type goFullscreenHost struct{ world, owner int }

// fullscreenAsks answers what the page in world asked of fullscreen:
// allowed if recent (it followed the person's input).
func (b *goBrowser) fullscreenAsks(gen, world int, asks []goFullscreenAsk, recent bool) {
	for _, a := range asks {
		if !a.On {
			if f := b.fullscreen; f != nil && f.world == world {
				b.fullscreenLet(false)
				b.send(map[string]any{"type": "go-fullscreen", "gen": gen, "on": false})
			}
			continue
		}
		if !goPasteID.MatchString(a.ID) {
			continue
		}
		ok := recent && world != 0
		if ok {
			if f := b.fullscreen; f != nil && f.world != world {
				b.fullscreenLet(true) // another frame's: that one's left
			}
			b.fullscreen = &goFullscreen{gen: gen, world: world, hosts: b.fullscreenHosts(world)}
			for _, h := range b.fullscreen.hosts {
				b.agentCall(h.world, "fullscreenHost", h.owner, true)
			}
			goDebugf("fullscreen: allowed (%d frames over)", len(b.fullscreen.hosts))
			b.send(map[string]any{"type": "go-fullscreen", "gen": gen, "on": true})
		} else {
			goDebugf("fullscreen: not after the person's input: refused")
		}
		answer, _ := json.Marshal(map[string]any{"id": a.ID, "ok": ok})
		b.agentCall(world, "fullscreen", string(answer))
	}
}

// fullscreenHosts is the iframes of other origins a frame's world is in,
// innermost first: each by its parent's agent's number for it.
func (b *goBrowser) fullscreenHosts(world int) []goFullscreenHost {
	var hosts []goFullscreenHost
	for w, depth := world, 0; w != b.world && depth < 4; depth++ {
		var c *goChild
		for _, ch := range b.children {
			if ch.world == w && !ch.same {
				c = ch
				break
			}
		}
		if c == nil || c.owner == 0 || c.parentWorld == 0 {
			break
		}
		hosts = append(hosts, goFullscreenHost{world: c.parentWorld, owner: c.owner})
		w = c.parentWorld
	}
	return hosts
}

// fullscreenLet lets the page's fullscreen go: its frames' iframes back in
// place, and the page told (tell: it didn't leave it itself).
func (b *goBrowser) fullscreenLet(tell bool) {
	f := b.fullscreen
	if f == nil {
		return
	}
	b.fullscreen = nil
	b.orientationGone() // (its lock goes with it: goorientation.go)
	if f.gen != b.gen {
		return // its page gone, with all that was done in it
	}
	for _, h := range f.hosts {
		b.agentCall(h.world, "fullscreenHost", h.owner, false)
	}
	if tell {
		b.agentCall(f.world, "fullscreen", `{"exit":true}`)
	}
}

// fullscreenExit: the person left fullscreen, the page's to be told.
func (b *goBrowser) fullscreenExit() {
	if b.fullscreen != nil {
		goDebugf("fullscreen: left by the person")
	}
	b.fullscreenLet(true)
}

// fullscreenGone: the page went (a load), its fullscreen with it, the
// person's browser to leave it too.
func (b *goBrowser) fullscreenGone() {
	if b.fullscreen == nil {
		return
	}
	b.fullscreen = nil
	b.orientationGone()
	b.send(map[string]any{"type": "go-fullscreen", "gen": b.gen, "on": false})
}
