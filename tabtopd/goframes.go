package main

// A page's embedded pages from other origins (see docs/browser-plan.md,
// section 6). Each is read in an isolated world and matched to its iframe
// in the parent document. The frame tree is followed through goFramesDepth
// levels; nested snapshots are attached to their iframe copies, while
// changes and input carry the owner-ID chain back to the correct frame world.
//
// Once a second, while a page is shown: the page's frames are listed
// (Page.getFrameTree); a new one is matched to its iframe (DOM.getFrameOwner,
// then the agent's number for it, which the copy must have already); and
// each that's new, navigated, or changed (its agent's changes) is read
// again. Resends are budgeted per tab, and a frame
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
	goFramesDepth  = 3               // cross-origin iframe nesting discovered
	goFrameLimit   = 2 << 20         // one frame's document, read
	goFramesBytes  = 4 << 20         // a tab's frames sent in a second
	goFramesEvery  = time.Second     // how often frames are looked at
	goFrameTimeout = 2 * time.Second // one frame's reading
	goFrameWaitMax = 8 * time.Second // the longest a changing frame waits
)

// goChild is one of the page's frames from another origin.
type goChild struct {
	id          string    // CDP frame ID
	parent      string    // CDP frame containing the iframe (the main frame at the top)
	parentWorld int       // agent world whose IDs name the iframe owner
	owner       int       // the agent's number for its iframe (0: not found yet)
	same        bool      // its page is the page's origin's: the agent reads it
	world       int       // its isolated world (0: to make)
	url         string    // its address, as last seen
	due         bool      // to be read whole
	next        time.Time // not read again before
	wait        time.Duration
	changed     int     // times in a row it's changed
	doc         *goNode // last document snapshot, for grafting nested frame copies
}

// goFrameRead is what a round of reading found of one frame.
type goFrameRead struct {
	id, parent, url string
	parentWorld     int
	owner           int
	same            bool
	world           int
	doc             []byte // its snapshot, if read
	changed         bool
	clip            goClipboardOut // what its page copied, asked to read (goclipboard.go)
	streams         string         // its streams' commands (goframestreams.go)
}

type goCDPFrame struct {
	Frame struct {
		ID  string `json:"id"`
		URL string `json:"url"`
	} `json:"frame"`
	ChildFrames []goCDPFrame `json:"childFrames"`
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
			ChildFrames []goCDPFrame
		}
	}
	if b.cdp.call(ctx, b.page, "Page.getFrameTree", nil, &tree) != nil || tree.FrameTree.Frame.ID != main {
		return nil
	}
	goDebugf("frame tree: %d direct children", len(tree.FrameTree.ChildFrames))
	var out []goFrameRead
	now := time.Now()
	var walk func([]goCDPFrame, string, int, int)
	walk = func(frames []goCDPFrame, parent string, parentWorld, depth int) {
		for _, f := range frames {
			if len(out) >= goFramesMax {
				return
			}
			c, had := known[f.Frame.ID]
			r := goFrameRead{id: f.Frame.ID, parent: parent, parentWorld: parentWorld, url: f.Frame.URL, owner: c.owner, same: c.same, world: c.world}
			if had && (c.url != f.Frame.URL || c.parent != parent || c.parentWorld != parentWorld) {
				r.owner, r.same, r.world, c.due = 0, false, 0, true
			}
			if r.owner == 0 {
				r.owner, r.same = b.frameOwner(ctx, parentWorld, f.Frame.ID)
				c.due = true
			}
			goDebugf("frame %s under %s owner %d same %v children %d", f.Frame.ID, parent, r.owner, r.same, len(f.ChildFrames))
			if r.owner != 0 && !r.same {
				if c.due || !had || !now.Before(c.next) {
					fctx, fcancel := context.WithTimeout(context.Background(), goFrameTimeout)
					r.doc, r.world, r.changed = b.readFrame(fctx, f.Frame.ID, r.world, c.due || !had)
					fcancel()
				}
				// What it copied, each round, however long it waits to be
				// read again (a copy's only passed on soon after the press).
				if r.world != 0 {
					fctx, fcancel := context.WithTimeout(context.Background(), goFrameTimeout)
					r.clip = b.frameCopied(fctx, r.world)
					r.streams = b.frameStreams(fctx, r.world)
					fcancel()
				}
			}
			out = append(out, r)
			childWorld := parentWorld
			if !r.same {
				childWorld = r.world
			}
			// Its frames' owners are found in its world: none yet (its own
			// owner not found, its read failed), none looked for, as a
			// context of 0 could be the page's own, where the page could
			// answer for the agent (goAgentJS's frameOwner).
			if depth < goFramesDepth && childWorld != 0 {
				walk(f.ChildFrames, f.Frame.ID, childWorld, depth+1)
			}
		}
	}
	walk(tree.FrameTree.ChildFrames, main, world, 1)
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
	// A frame's document over the limit with its canvases: read again
	// without them (shown as too large), not dropped whole.
	fit := func(raw string) string {
		if len(raw) <= goFrameLimit {
			return raw
		}
		goDebugf("frame snapshot %d bytes: read again without its canvases", len(raw))
		run("globalThis.__tabtopFrameCanvasCap = 0")
		again, err := run("__tabtop.snapshot()")
		run("delete globalThis.__tabtopFrameCanvasCap")
		if err != nil {
			return raw
		}
		return again
	}
	if world != 0 {
		raw, err := run("__tabtop.snapshot()")
		if err == nil {
			return goFrameDoc(fit(raw)), world, true
		}
	}
	var made struct {
		ExecutionContextID int `json:"executionContextId"`
	}
	if b.cdp.call(ctx, b.page, "Page.createIsolatedWorld", map[string]any{"frameId": frame, "worldName": "tabtop"}, &made) != nil {
		goDebugf("frame %s: cannot create isolated world", frame)
		return nil, 0, false
	}
	world = made.ExecutionContextID
	// (Told it's a frame's world first: its canvases kept within what a
	// frame's document may come to, goFrameLimit.)
	run("globalThis.__tabtopFrameWorld = true")
	raw, err := run(goAgentJS)
	if err != nil {
		goDebugf("frame %s world %d: cannot install agent: %v", frame, world, err)
		return nil, 0, false
	}
	doc := goFrameDoc(fit(raw))
	goDebugf("frame %s world %d: snapshot %d bytes", frame, world, len(doc))
	return doc, world, true
}

// frameCopied is what the page in a frame's world copied, and its reads of
// the clipboard, since it was last asked.
func (b *goBrowser) frameCopied(ctx context.Context, world int) goClipboardOut {
	var r struct {
		Result struct {
			Value string `json:"value"`
		} `json:"result"`
	}
	var out goClipboardOut
	if b.cdp.call(ctx, b.page, "Runtime.evaluate", map[string]any{"expression": "globalThis.__tabtop?.copied?.() ?? \"\"", "contextId": world, "returnByValue": true}, &r) == nil && r.Result.Value != "" {
		json.Unmarshal([]byte(r.Result.Value), &out)
	}
	return out
}

// goFrameDoc is a frame's snapshot, if it's within the limit.
func goFrameDoc(raw string) []byte {
	if raw == "" || len(raw) > goFrameLimit {
		if raw != "" {
			goDebugf("frame snapshot %d bytes: over the limit, not shown", len(raw))
		}
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
		b.clipboard(b.gen, r.world, r.clip)
		b.frameStreamsGot(b.gen, r.world, r.streams)
		c := b.children[r.id]
		if c == nil {
			c = &goChild{due: true}
			b.children[r.id] = c
		}
		if c.url != r.url || c.owner != r.owner {
			c.due = true
		}
		c.id, c.parent, c.parentWorld, c.url, c.owner, c.same, c.world = r.id, r.parent, r.parentWorld, r.url, r.owner, r.same, r.world
		if r.doc == nil {
			continue
		}
		var s goSnapshot
		if json.Unmarshal(r.doc, &s) != nil || goClean(s.Doc) == nil {
			continue
		}
		// (Its kids cleaned already, just now: wrapped, not cleaned again,
		// their WebGL logs not checked again.)
		base, _ := goURL(s.Base)
		c.doc = &goNode{ID: s.Doc.ID, Type: 9, Base: base, Kids: s.Doc.Kids, CSS: s.Doc.CSS}
		goGLStreamsOf(c.doc, make(map[int]*goGLStream)) // its WebGL canvases bounded as a page's are
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
			for _, w := range goWants(c.doc, s.Base) {
				b.prefetcher.want(b, w, 0)
			}
		}
	}
	// Graft deepest documents first, so a refreshed parent snapshot retains
	// every already-read nested frame when the outer copy is resent.
	for i := len(reads) - 1; i >= 0; i-- {
		r := reads[i]
		c := b.children[r.id]
		if c == nil || c.doc == nil || c.same || c.parent == b.frame {
			continue
		}
		parent := b.children[c.parent]
		if parent == nil || parent.doc == nil {
			continue
		}
		owner := findGoNode(parent.doc, c.owner)
		if owner != nil && owner.Name == "iframe" {
			owner.Kids = []*goNode{c.doc}
			owner.FrameDoc = c.world
		}
	}
	// Address nested updates by the chain of iframe IDs in each parent
	// document. This keeps focus and pending text in containing copies intact.
	sent := map[string]bool{}
	for _, r := range reads {
		if r.doc == nil {
			continue
		}
		c := b.children[r.id]
		if c == nil || c.doc == nil {
			continue
		}
		root := c
		var path []int
		for root.parent != b.frame {
			path = append(path, root.owner)
			root = b.children[root.parent]
			if root == nil {
				break
			}
		}
		if root == nil || (root.doc == nil && !root.same) {
			continue
		}
		key, content, frameDoc := r.id, c.doc, c.world
		if c == root {
			key, content, frameDoc = root.id, root.doc, root.world
		} else {
			for i, j := 0, len(path)-1; i < j; i, j = i+1, j-1 {
				path[i], path[j] = path[j], path[i]
			}
		}
		if sent[key] || (c != root && sent[root.id]) {
			continue
		}
		sent[key] = true
		opData := map[string]any{"o": "c", "i": root.owner, "c": []*goNode{content}, "f": frameDoc}
		if c != root {
			opData["path"] = path
		}
		op, _ := json.Marshal(opData)
		// Within a second's budget; or, first in its second, one larger (a
		// frame with its nested frames grafted in can be more than the
		// budget, and would otherwise never be sent), up to a snapshot's.
		if b.framesSent > 0 && b.framesSent+len(op) > goFramesBytes || len(op) > goSnapshotLimit {
			c.due = true
			continue
		}
		b.framesSent += len(op)
		p, _ := json.Marshal(map[string]any{"type": "go-changes", "gen": b.gen, "seq": b.seq, "ops": []json.RawMessage{op}})
		goDebugf("frame %d nested %v: %d bytes", root.owner, path, len(p))
		b.sendLarge(p)
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
	b.closedFramesRead() // (a closed root waiting for its frame's world)
}

func findGoNode(n *goNode, id int) *goNode {
	if n == nil {
		return nil
	}
	if n.ID == id {
		return n
	}
	// A separately read document has its own node-number space. Never find
	// an iframe owner by matching a node inside that document.
	if n.Type == 1 && n.Name == "iframe" && n.FrameDoc != 0 {
		return nil
	}
	for _, child := range n.Kids {
		if found := findGoNode(child, id); found != nil {
			return found
		}
	}
	if n.Shadow != nil {
		return findGoNode(n.Shadow, id)
	}
	return nil
}
