package main

// Streams (Media Source, gomedia.js) of the page's embedded pages: each
// frame's page relays its SourceBuffers' commands as the page's does, but
// a frame's world is read apart (goframes.go), and its batches of changes
// only say whether it changed. So each frame's world is asked for its
// streams' commands itself (the agent's frameStreams): in each round of
// the frames', and, once one has streamed, as often as the page's changes
// are read (goPollEvery), for a while after it last had any.
//
// A stream's number is the page's (random, gomedia.js: one document's
// can't be told from another's by it); the first world to send one has it
// (goStreamOwners), so a frame can't feed the page's player, nor one
// frame another's. The players are the person's browser's (go-media.js),
// laid under the frame's copy as the page's are.

import (
	"context"
	"encoding/json"
	"time"
)

const goFrameStreamsFor = 20 * time.Second // a frame asked often, after its last streaming

// goStreamOwners is which world sent each stream first (of the page shown).
type goStreamOwners struct {
	gen   int
	owner map[int]int // stream -> world
}

// streamsFrom keeps of a world's stream commands those of streams it has
// (or that nothing's had yet: now its), for the page of gen.
func (b *goBrowser) streamsFrom(gen, world int, commands []json.RawMessage) []json.RawMessage {
	if len(commands) == 0 {
		return nil
	}
	if b.streamOwners.gen != gen || b.streamOwners.owner == nil {
		b.streamOwners = goStreamOwners{gen: gen, owner: map[int]int{}}
	}
	kept := commands[:0:0]
	for _, raw := range commands {
		var c struct {
			Stream int `json:"stream"`
		}
		if json.Unmarshal(raw, &c) != nil || c.Stream <= 0 {
			continue
		}
		owner, had := b.streamOwners.owner[c.Stream]
		if !had {
			if len(b.streamOwners.owner) >= 256 {
				continue
			}
			b.streamOwners.owner[c.Stream] = world
			owner = world
		}
		if owner != world {
			goDebugf("stream %d: from another document than its own, dropped", c.Stream)
			continue
		}
		kept = append(kept, raw)
	}
	return kept
}

// frameStreamsGot passes on what a frame's world said of its streams, and
// its EME requests (goframeeme.go).
func (b *goBrowser) frameStreamsGot(gen, world int, raw string) {
	if raw == "" || gen != b.gen || b.shown != gen {
		return
	}
	var got struct {
		Streams []json.RawMessage `json:"streams"`
		EME     []json.RawMessage `json:"eme"`
		// Its players its page started or stopped ({o: "m", i, v}).
		Plays []struct {
			O string `json:"o"`
			I int    `json:"i"`
			V string `json:"v"`
		} `json:"plays"`
	}
	if json.Unmarshal([]byte(raw), &got) != nil {
		return
	}
	b.frameActive(world)
	if kept := b.streamsFrom(gen, world, got.Streams); len(kept) > 0 {
		goDebugf("frame world %d: %d stream commands", world, len(kept))
		b.send(map[string]any{"type": "go-streams", "gen": gen, "streams": kept})
	}
	b.frameEME(gen, world, got.EME)
	// Its plays, for its players (the person's browser's, by its world and
	// their nodes: go-frame.js).
	var plays []map[string]any
	for _, p := range got.Plays {
		if p.O == "m" && p.I > 0 && p.I < 1<<32 && len(plays) < 32 {
			plays = append(plays, map[string]any{"i": p.I, "v": p.V == "true"})
		}
	}
	if len(plays) > 0 && world > 0 && world < goFrameWorldMax {
		goDebugf("frame world %d: %d players started or stopped", world, len(plays))
		b.send(map[string]any{"type": "go-frame-plays", "gen": gen, "doc": world, "plays": plays})
	}
}

// frameActive has a frame's world asked as often as the page's changes are
// read, for a while (goFrameStreamsFor): it's streaming, or its DRM's
// talking with the person's browser.
func (b *goBrowser) frameActive(world int) {
	if b.streamWorlds == nil {
		b.streamWorlds = map[int]time.Time{}
	}
	b.streamWorlds[world] = time.Now()
}

// frameStreams is what the page in a frame's world has of its streams'
// commands, as the agent says them ("" if none).
func (b *goBrowser) frameStreams(ctx context.Context, world int) string {
	var r struct {
		Result struct {
			Value string `json:"value"`
		} `json:"result"`
	}
	if b.cdp.call(ctx, b.page, "Runtime.evaluate", map[string]any{"expression": "globalThis.__tabtop?.frameStreams?.() ?? \"\"", "contextId": world, "returnByValue": true}, &r) != nil {
		return ""
	}
	return r.Result.Value
}

// frameStreamsSoon asks the frames that have streamed lately for their
// streams' commands, if none is being asked.
func (b *goBrowser) frameStreamsSoon() {
	if b.streamPolling || b.shown != b.gen || len(b.streamWorlds) == 0 {
		return
	}
	var worlds []int
	for w, at := range b.streamWorlds {
		if time.Since(at) > goFrameStreamsFor {
			delete(b.streamWorlds, w)
			continue
		}
		worlds = append(worlds, w)
	}
	if len(worlds) == 0 {
		return
	}
	b.streamPolling = true
	gen := b.gen
	b.job(func() any {
		out := map[int]string{}
		for _, w := range worlds {
			ctx, cancel := context.WithTimeout(context.Background(), goFrameTimeout)
			out[w] = b.frameStreams(ctx, w)
			cancel()
		}
		return out
	}, func(r any) {
		b.streamPolling = false
		for w, raw := range r.(map[int]string) {
			if raw != "" {
				b.frameStreamsGot(gen, w, raw)
			}
		}
	})
}
