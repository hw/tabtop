package main

// Closed shadow roots from a page's HTML (<template shadowrootmode=
// "closed">): the parser attaches them without attachShadow, so
// goshadow.js can't make them open, and nothing in the page's world or
// the agent's can read them. CDP can, measured in Moli: an agent's world's
// document, described whole (DOM.describeNode, pierce), lists them, and
// DOM.resolveNode gives one to that world. So the server finds them in
// each agent's document (the page's, with the frames of its origin it
// reads; another origin's frame's, in its own world: Moli leaves those out
// of the page's) and gives each to that agent (__tabtop.closedRoot), which
// then reads it as it reads any root. The page's own world still has it
// closed.
//
// Looked for only once a document's HTML has had one (its body, as the
// engine got it): a document described whole is slow on a large page
// (measured: 15,000 nodes, 6.6 MB in 0.86 s), and such roots are rare.
// And without DOM.enable, which has the engine say every node's change
// from then on.

import (
	"context"
	"encoding/json"
	"regexp"
	"time"
)

// goClosedDSD finds a closed declarative shadow root in HTML (the old
// attribute's name too).
var goClosedDSD = regexp.MustCompile(`(?i)<template\b[^>]*\bshadowroot(?:mode)?\s*=\s*["']?closed`)

// goClosedRootsMax bounds the roots given in a page.
const goClosedRootsMax = 4096

type goClosedRoots struct {
	docs     map[string]bool // Document requests (any frame) to look at once loaded, by request ID
	seen     bool            // a document's HTML had one since the last look: every world looked in
	fresh    bool            // a world not looked in yet (made since) is to be
	retry    bool            // the page's world is to be looked in again (a root it couldn't take yet)
	has      bool            // a document's HTML has had one, since the page's own was asked for
	scanning bool
	later    int             // roots an agent couldn't take yet (a frame it hadn't read), looked for again as frames are read
	tries    int             // times looked for again so, this generation
	gen      int             // the generation given and looked in
	given    map[[2]int]bool // the roots given: (world, its backend node ID)
	worlds   map[int]bool    // the worlds looked in
}

// closedRequested notes a document's request (any frame's), to look at
// its HTML once it's loaded; the page's own, a page of its own: none had
// yet.
func (b *goBrowser) closedRequested(ev cdpEvent) {
	var p struct {
		RequestID string `json:"requestId"`
		Type      string `json:"type"`
		FrameID   string `json:"frameId"`
	}
	if json.Unmarshal(ev.Params, &p) != nil || p.Type != "Document" || p.RequestID == "" {
		return
	}
	c := &b.closed
	if p.FrameID == b.frame {
		c.has, c.seen, c.fresh, c.retry, c.later = false, false, false, false, 0
	}
	if c.docs == nil {
		c.docs = map[string]bool{}
	}
	if len(c.docs) < 64 {
		c.docs[p.RequestID] = true
	}
}

// closedLoaded looks at a document's HTML, loaded, for a closed root.
func (b *goBrowser) closedLoaded(ev cdpEvent) {
	var p struct {
		RequestID string `json:"requestId"`
	}
	if json.Unmarshal(ev.Params, &p) != nil || !b.closed.docs[p.RequestID] {
		return
	}
	delete(b.closed.docs, p.RequestID)
	b.job(func() any {
		ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
		defer cancel()
		var body struct {
			Body          string `json:"body"`
			Base64Encoded bool   `json:"base64Encoded"`
		}
		if b.cdp.call(ctx, b.page, "Network.getResponseBody", map[string]any{"requestId": p.RequestID}, &body) != nil || body.Base64Encoded {
			return false
		}
		return goClosedDSD.MatchString(body.Body)
	}, func(r any) {
		if r.(bool) {
			goDebugf("closed roots: a document's HTML has one")
			b.closed.seen, b.closed.has = true, true
			b.closedRootsSoon()
		}
	})
}

// closedWorlds is each agent's world: the page's, and each frame's of
// another origin that has one.
func (b *goBrowser) closedWorlds() []int {
	worlds := []int{b.world}
	for _, ch := range b.children {
		if !ch.same && ch.world != 0 {
			worlds = append(worlds, ch.world)
		}
	}
	return worlds
}

// closedRootsSoon looks for closed roots, given to no agent yet, once the
// page's shown: in every agent's world if a document had one since the
// last look, else in those not looked in yet, and the page's again if
// it's to be.
func (b *goBrowser) closedRootsSoon() {
	c := &b.closed
	if !(c.seen || c.fresh || c.retry) || c.scanning || b.shown != b.gen || b.loading != 0 || b.world == 0 {
		return
	}
	if c.gen != b.gen {
		c.gen, c.given, c.worlds, c.tries = b.gen, map[[2]int]bool{}, map[int]bool{}, 0
	}
	var worlds []int
	for _, w := range b.closedWorlds() {
		if c.seen || !c.worlds[w] || c.retry && w == b.world {
			worlds = append(worlds, w)
		}
	}
	c.seen, c.fresh, c.retry = false, false, false
	if len(worlds) == 0 {
		return
	}
	c.scanning = true
	gen, page := b.gen, b.world
	given := make(map[[2]int]bool, len(c.given))
	for k := range c.given {
		given[k] = true
	}
	b.job(func() any {
		return b.scanClosedRoots(worlds, given)
	}, func(r any) {
		c.scanning = false
		s := r.(goClosedScan)
		got := s.given
		goDebugf("closed roots: %d given, %d to give later, in %d worlds", len(got), s.later, len(worlds))
		if gen != b.gen {
			return
		}
		for _, w := range worlds {
			c.worlds[w] = true
			if w == page {
				c.later = s.later // (retried in the page's world only: its frames')
			}
		}
		for _, k := range got {
			c.given[k] = true
			// Given to another origin's frame's agent: its document's read
			// again whole, the root with it (no change there says so).
			for _, ch := range b.children {
				if !ch.same && ch.world == k[0] {
					ch.due, ch.next = true, time.Time{}
					b.framesAt = time.Time{}
				}
			}
		}
		if len(got) > 0 {
			b.changed(0) // the page's agent has them: what it sends of them
		}
		b.closedRootsSoon() // (another document had one since)
	})
}

// closedShown is told the page's document's been read (snapshot): in a
// world not looked in (a new one), looked for.
func (b *goBrowser) closedShown() {
	if b.closed.has {
		b.closed.fresh = true
	}
	b.closedRootsSoon()
}

// closedFramesRead is told the frames were read: a frame's world not
// looked in (one made since) is looked in.
func (b *goBrowser) closedFramesRead() {
	c := &b.closed
	if !c.has {
		return
	}
	if c.later > 0 && c.gen == b.gen && c.tries < 10 {
		c.tries++
		c.retry = true
	}
	c.fresh = true
	b.closedRootsSoon()
}

type goClosedScan struct {
	given [][2]int // the roots given: (world, its backend node ID)
	later int      // the roots an agent couldn't take yet
}

// scanClosedRoots (on the jobs' queue) describes each world's document
// whole, through its roots and the frames it reads, and gives each closed
// root not given yet to that world's agent.
func (b *goBrowser) scanClosedRoots(worlds []int, given map[[2]int]bool) goClosedScan {
	var out goClosedScan
	ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
	defer cancel()
	type node struct {
		BackendNodeID   int     `json:"backendNodeId"`
		ShadowRootType  string  `json:"shadowRootType"`
		Children        []*node `json:"children"`
		ShadowRoots     []*node `json:"shadowRoots"`
		ContentDocument *node   `json:"contentDocument"`
	}
	release := func(id string) {
		if id != "" {
			b.cdp.call(ctx, b.page, "Runtime.releaseObject", map[string]any{"objectId": id}, nil)
		}
	}
	// object is the world's object for a node, or its document.
	object := func(world, id int) string {
		var r struct {
			Object struct {
				ObjectID string `json:"objectId"`
			} `json:"object"`
			Result struct {
				ObjectID string `json:"objectId"`
			} `json:"result"`
		}
		if id == 0 {
			if b.cdp.call(ctx, b.page, "Runtime.evaluate", map[string]any{"expression": "document", "contextId": world}, &r) != nil {
				return ""
			}
			return r.Result.ObjectID
		}
		if b.cdp.call(ctx, b.page, "DOM.resolveNode", map[string]any{"backendNodeId": id, "executionContextId": world}, &r) != nil {
			return ""
		}
		return r.Object.ObjectID
	}
	for _, world := range worlds {
		doc := object(world, 0)
		if doc == "" {
			continue
		}
		var d struct{ Node *node }
		err := b.cdp.call(ctx, b.page, "DOM.describeNode", map[string]any{"objectId": doc, "depth": -1, "pierce": true}, &d)
		release(doc)
		if err != nil || d.Node == nil {
			continue
		}
		var found [][2]int // root, host
		var walk func(n *node, depth int)
		walk = func(n *node, depth int) {
			if depth > 512 || len(found)+len(given) >= goClosedRootsMax {
				return
			}
			for _, s := range n.ShadowRoots {
				if s.ShadowRootType == "closed" && !given[[2]int{world, s.BackendNodeID}] {
					found = append(found, [2]int{s.BackendNodeID, n.BackendNodeID})
				}
				walk(s, depth+1)
			}
			for _, ch := range n.Children {
				walk(ch, depth+1)
			}
			if n.ContentDocument != nil {
				walk(n.ContentDocument, depth+1) // (a frame of its origin, which its agent reads)
			}
		}
		walk(d.Node, 0)
		for _, f := range found {
			root, host := object(world, f[0]), object(world, f[1])
			var r struct {
				Result struct {
					Value string `json:"value"`
				} `json:"result"`
			}
			if root != "" && host != "" && b.cdp.call(ctx, b.page, "Runtime.callFunctionOn", map[string]any{"objectId": root, "returnByValue": true,
				"arguments":           []map[string]string{{"objectId": host}},
				"functionDeclaration": `function (host) { return globalThis.__tabtop?.closedRoot ? __tabtop.closedRoot(this, host) : ""; }`}, &r) == nil {
				switch r.Result.Value {
				case "ok":
					out.given = append(out.given, [2]int{world, f[0]})
				case "later":
					out.later++
				}
			}
			release(root)
			release(host)
		}
	}
	return out
}
