package main

// Encrypted Media (EME) in the page's embedded pages: a frame's page asks
// for its keys and sessions as the page's does (goeme.js), the person's
// browser's CDM doing them (go-eme.js). A frame of the page's origin is
// read by the page's agent, so its requests are the page's; another
// origin's are its own world's, read with its streams (the agent's
// frameStreams, goframestreams.go), and passed on marked with that world
// (go-eme's doc, set here: not the page's to say), for the person's browser
// to keep apart, its keys and sessions its own; their answers given back
// to that world only, while it's the frame's.
//
// Only where the page and the frame are both secure (https), as EME is.

import (
	"context"
	"encoding/json"
	"strings"
)

// goFrameWorldMax bounds a frame's world's number (the person's browser
// numbers a frame's players world × 2³² + node: go-frame.js).
const goFrameWorldMax = 1 << 20

// frameEMEChild is the frame of another origin whose world is world, if
// it's one that may use EME (secure, as its page is).
func (b *goBrowser) frameEMEChild(world int) *goChild {
	if world <= 0 || world >= goFrameWorldMax || !strings.HasPrefix(b.docURL, "https://") {
		return nil
	}
	for _, c := range b.children {
		if c.world == world && !c.same && strings.HasPrefix(c.url, "https://") {
			return c
		}
	}
	return nil
}

// frameEME passes on a frame's world's EME requests.
func (b *goBrowser) frameEME(gen, world int, eme []json.RawMessage) {
	if len(eme) == 0 {
		return
	}
	if b.frameEMEChild(world) == nil {
		goDebugf("frame world %d: EME requests, not a secure frame's of another origin: dropped", world)
		return
	}
	if len(eme) > 4 {
		eme = eme[:4]
	}
	goDebugf("frame world %d: %d EME requests", world, len(eme))
	p, _ := json.Marshal(map[string]any{"type": "go-eme", "gen": gen, "eme": eme, "doc": world})
	b.sendLarge(p)
}

// emeInFrame gives a frame's world the person's browser's answer to one of
// its EME requests (m.FDoc: the world), if it's still that frame's.
func (b *goBrowser) emeInFrame(m goClientMsg) {
	if m.Gen != b.gen || b.shown != b.gen || len(m.Value) > maxGoURL*8 || b.acts.waiting() >= goActsWaiting {
		return
	}
	world := m.FDoc
	if b.frameEMEChild(world) == nil {
		goDebugf("frame world %d: an EME answer for a frame gone", world)
		return
	}
	b.frameActive(world) // (its next request asked for soon)
	b.acts.add(func() {
		ctx, cancel := context.WithTimeout(context.Background(), goActTimeout)
		defer cancel()
		res, err := b.actNow(ctx, world, m)
		goDebugf("frame world %d: EME answer: %s %v", world, res, err)
	})
}

// emeGone tells the person's browser a frame's world is gone (the frame
// went elsewhere, or was taken out): its keys and sessions let go.
func (b *goBrowser) emeGone(world int) {
	if world > 0 {
		b.send(map[string]any{"type": "go-eme-gone", "gen": b.gen, "doc": world})
	}
}
