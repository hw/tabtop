package main

// A page's embedded pages from other origins (see docs/browser-plan.md,
// section 6). The agent in the page's world reads the frames of its own
// origin into the snapshot itself (goagent.js); another origin's it can't
// see into. Those are read here, each in an isolated world of its own, and
// sent after the page, each whole, as its iframe's content, as the agent
// sends a frame of its own origin that's changed: {o: "c", i: the iframe's
// number, c: [its document]}. A slow, looping or huge frame then holds up
// nothing but itself.
//
// Once a second, while a page is shown: the page's frames are listed
// (Page.getFrameTree); a new one is matched to its iframe (DOM.getFrameOwner,
// then the agent's number for it, which the copy must have already); and
// each that's new, navigated, or changed (its agent's changes) is read
// again. Only the page's own frames: a frame's frames, of yet another
// origin, show as unavailable. Resends are budgeted per tab, and a frame
// that changes every time waits longer each time.

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

var errGoFrameGone = errors.New("the frame's document went")

const (
	goFramesMax    = 16              // other origins' frames read for a page
	goFrameLimit   = 2 << 20         // one frame's document, read
	goFramesBytes  = 4 << 20         // a tab's frames sent in a second
	goFramesEvery  = time.Second     // how often frames are looked at
	goFrameTimeout = 2 * time.Second // one frame's reading
	goFrameWaitMax = 8 * time.Second // the longest a changing frame waits
)

// goChild is one of the page's frames from another origin.
type goChild struct {
	owner   int       // the agent's number for its iframe (0: not found yet)
	same    bool      // its page is the page's origin's: the agent reads it
	world   int       // its isolated world (0: to make)
	url     string    // its address, as last seen
	due     bool      // to be read whole
	next    time.Time // not read again before
	wait    time.Duration
	changed int // times in a row it's changed
}

// goFrameRead is what a round of reading found of one frame.
type goFrameRead struct {
	id, url string
	owner   int
	same    bool
	world   int
	doc     []byte // its snapshot, if read
	changed bool
}

// framesSoon reads the page's frames, if it's time and nothing's reading.
func (b *goBrowser) framesSoon() {
	if b.framesReading || b.shown != b.gen || b.loading != 0 || b.world == 0 || b.dialog || time.Since(b.framesAt) < goFramesEvery {
		return
	}
	b.framesReading, b.framesAt = true, time.Now()
	gen, world, main := b.gen, b.world, b.frame
	known := map[string]goChild{}
	for id, c := range b.children {
		known[id] = *c
	}
	b.job(func() any {
		return b.readFrames(world, main, known)
	}, func(r any) {
		b.framesReading = false
		if gen == b.gen && b.shown == gen {
			b.framesRead(r.([]goFrameRead))
		}
	})
}

// framesAgain has every frame read whole on the next round: the page was
// read again, and its iframes drawn empty.
func (b *goBrowser) framesAgain() {
	for _, c := range b.children {
		c.due, c.next = true, time.Time{}
	}
	b.framesAt = time.Time{}
}

// readFrames (on the jobs' queue) lists the page's frames and reads those
// due of another origin.
func (b *goBrowser) readFrames(world int, main string, known map[string]goChild) []goFrameRead {
	ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
	defer cancel()
	var tree struct {
		FrameTree struct {
			Frame       struct{ ID string }
			ChildFrames []struct {
				Frame struct{ ID, URL string }
			}
		}
	}
	if b.cdp.call(ctx, b.page, "Page.getFrameTree", nil, &tree) != nil || tree.FrameTree.Frame.ID != main {
		return nil
	}
	var out []goFrameRead
	now := time.Now()
	for _, f := range tree.FrameTree.ChildFrames {
		if len(out) >= goFramesMax {
			break
		}
		c, had := known[f.Frame.ID]
		r := goFrameRead{id: f.Frame.ID, url: f.Frame.URL, owner: c.owner, same: c.same, world: c.world}
		if had && c.url != f.Frame.URL {
			// Navigated: a new document, its owner perhaps another origin now.
			r.owner, r.same, r.world, c.due = 0, false, 0, true
		}
		if r.owner == 0 {
			r.owner, r.same = b.frameOwner(ctx, world, f.Frame.ID)
			c.due = true
		}
		if r.owner == 0 || r.same {
			out = append(out, r) // not shown yet, or the agent's to read
			continue
		}
		if !c.due && now.Before(c.next) {
			out = append(out, r)
			continue
		}
		fctx, fcancel := context.WithTimeout(context.Background(), goFrameTimeout)
		r.doc, r.world, r.changed = b.readFrame(fctx, f.Frame.ID, r.world, c.due)
		fcancel()
		out = append(out, r)
	}
	return out
}

// frameOwner is the agent's number for frame's iframe, and whether the
// agent reads its page itself; 0 if the copy doesn't have it yet.
func (b *goBrowser) frameOwner(ctx context.Context, world int, frame string) (int, bool) {
	var owner struct{ BackendNodeID int }
	if b.cdp.call(ctx, b.page, "DOM.getFrameOwner", map[string]any{"frameId": frame}, &owner) != nil || owner.BackendNodeID == 0 {
		return 0, false
	}
	var node struct{ Object struct{ ObjectID string } }
	if b.cdp.call(ctx, b.page, "DOM.resolveNode", map[string]any{"backendNodeId": owner.BackendNodeID, "executionContextId": world}, &node) != nil || node.Object.ObjectID == "" {
		return 0, false
	}
	var res struct{ Result struct{ Value string } }
	if b.cdp.call(ctx, b.page, "Runtime.callFunctionOn", map[string]any{"objectId": node.Object.ObjectID, "returnByValue": true,
		"functionDeclaration": `function () { return globalThis.__tabtop ? __tabtop.frameOwner(this) : ""; }`}, &res) != nil {
		return 0, false
	}
	b.cdp.call(ctx, b.page, "Runtime.releaseObject", map[string]any{"objectId": node.Object.ObjectID}, nil)
	var o struct {
		ID       int  `json:"id"`
		Readable bool `json:"readable"`
	}
	if json.Unmarshal([]byte(res.Result.Value), &o) != nil {
		return 0, false
	}
	return o.ID, o.Readable
}

// readFrame reads frame's document whole, in its world (made, and the
// agent put there, if it's 0 or gone), if whole is set or its agent saw
// changes; the world, and whether it changed.
func (b *goBrowser) readFrame(ctx context.Context, frame string, world int, whole bool) ([]byte, int, bool) {
	// run runs one of the agent's own calls (fixed text, never the page's)
	// in the frame's isolated world, over CDP.
	run := func(expr string) (string, error) {
		var r struct {
			Result struct {
				Value string `json:"value"`
			} `json:"result"`
			Exception *struct{} `json:"exceptionDetails"`
		}
		err := b.cdp.call(ctx, b.page, "Runtime.evaluate", map[string]any{"expression": expr, "contextId": world, "returnByValue": true}, &r)
		if err == nil && r.Exception != nil {
			err = errGoFrameGone
		}
		return r.Result.Value, err
	}
	if world != 0 && !whole {
		changes, err := run("__tabtop.changes()")
		if err == nil && changes == "" {
			return nil, world, false
		}
		if err != nil {
			world = 0 // its document went: a new world for the new one
		}
	}
	if world != 0 {
		raw, err := run("__tabtop.snapshot()")
		if err == nil {
			return goFrameDoc(raw), world, true
		}
	}
	var made struct {
		ExecutionContextID int `json:"executionContextId"`
	}
	if b.cdp.call(ctx, b.page, "Page.createIsolatedWorld", map[string]any{"frameId": frame, "worldName": "tabtop"}, &made) != nil {
		return nil, 0, false
	}
	world = made.ExecutionContextID
	raw, err := run(goAgentJS)
	if err != nil {
		return nil, 0, false
	}
	return goFrameDoc(raw), world, true
}

// goFrameDoc is a frame's snapshot, if it's within the limit.
func goFrameDoc(raw string) []byte {
	if raw == "" || len(raw) > goFrameLimit {
		return nil
	}
	return []byte(raw)
}

// framesRead keeps what a round found and sends what was read: each a
// frame's whole document, as its iframe's content, within the tab's
// budget; what doesn't fit waits for the next round.
func (b *goBrowser) framesRead(reads []goFrameRead) {
	if b.children == nil {
		b.children = map[string]*goChild{}
	}
	seen := map[string]bool{}
	now := time.Now()
	if now.Sub(b.framesBudgetAt) >= time.Second {
		b.framesBudgetAt, b.framesSent = now, 0
	}
	for _, r := range reads {
		seen[r.id] = true
		c := b.children[r.id]
		if c == nil {
			c = &goChild{due: true}
			b.children[r.id] = c
		}
		if c.url != r.url || c.owner != r.owner {
			c.due = true
		}
		c.url, c.owner, c.same, c.world = r.url, r.owner, r.same, r.world
		if r.doc == nil {
			continue
		}
		var s goSnapshot
		if json.Unmarshal(r.doc, &s) != nil || goClean(s.Doc) == nil {
			continue
		}
		doc := &goNode{ID: s.Doc.ID, Type: 9, Base: s.Base, Kids: s.Doc.Kids}
		goClean(doc)
		// f: which document it is, its world (made anew for each), for the
		// copy to say with what's done in it (inFrame checks it).
		op, _ := json.Marshal(map[string]any{"o": "c", "i": c.owner, "c": []*goNode{doc}, "f": c.world})
		if b.framesSent+len(op) > goFramesBytes {
			c.due = true // next round
			continue
		}
		b.framesSent += len(op)
		p, _ := json.Marshal(map[string]any{"type": "go-changes", "gen": b.gen, "seq": b.seq, "ops": []json.RawMessage{op}})
		goDebugf("frame %d: %d bytes", c.owner, len(p))
		b.sendLarge(p)
		c.due = false
		// One that changes every time is read less often, up to every
		// goFrameWaitMax; one that's settled, every round.
		if r.changed {
			c.changed++
		}
		c.wait = 0
		if c.changed > 2 {
			c.wait = min(goFrameWaitMax, time.Duration(c.changed-2)*time.Second)
		}
		c.next = now.Add(c.wait)
		if b.prefetcher != nil {
			for _, w := range goWants(doc, s.Base) {
				b.prefetcher.want(b, w, 0)
			}
		}
	}
	for id := range b.children {
		if !seen[id] {
			delete(b.children, id) // gone from the page
		}
	}
	for _, r := range reads {
		if c := b.children[r.id]; c != nil && r.doc == nil && !r.changed && c.changed > 0 {
			c.changed-- // settling
		}
	}
}
