package main

// The person's mouse and keys, given to the engine as a browser's own input
// (Input.dispatchMouseEvent, Input.dispatchKeyEvent; see docs/browser-plan.md,
// section 6). The page gets trusted events, and the engine does with them
// what a browser does: a press and release make a click, a double click, a
// context menu; a press gives focus; Enter in a field sends its form; Space
// presses a button or ticks a box; Tab moves on.
//
// A pointer event comes as the element under it and where within it, as
// fractions across and down: the person's copy is laid out by their browser,
// so their places aren't the engine's. The engine scrolls the element into
// view if it must, lays out again (a one-pixel screenshot: neither a scroll
// nor a change of class does), and finds the place within it; if something
// else is there, its middle; failing that, a press is done as before, by
// script (a click, on release).
//
// Typing itself isn't sent as keys with text: the copy's fields are typed
// in, and their values sent ("input"), so keys go as rawKeyDown, which do
// what keys do but type nothing. Enter in a one-line field goes with its
// text, which is what sends the form.
//
// All of it runs on the acts' queue, in order, after what was typed before
// it; a press or key may open a dialog, which holds it until answered.
// Moves and the wheel wait one at a time, the newest kept (the wheel's
// turns added up), and are dropped while a dialog's open.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"
)

// goInputWait is how long one input may take: as long as a dialog it opens
// may wait for the person, and a little.
const goInputWait = goDialogWait + 10*time.Second

// goPress is a mouse button held down: given as input at x, y (real), or
// left to be a scripted click on release.
type goPress struct {
	real     bool
	scripted bool // pressed by the agent's script (goagent.js's mouse): released so too
	id       int
	x, y     float64
}

// goInput is the acts' queue's own: only its functions touch it.
type goInput struct {
	gen     int // the generation presses were made in
	pressed map[int]goPress
	// A touch: given as input (touching), or to be a scripted click on
	// what was touched (touchID) if it's a tap.
	touching bool
	touchID  int
	// Each finger's place in the engine less its place on the person's
	// screen, from when it went down: it moves as the finger does there
	// (not by what's under it, which a swipe scrolling the copy keeps the
	// same, a finger that moves seeming still, and its swipe a tap).
	fingers  map[int][2]float64
	dragging bool // something from outside is being dragged over the page
}

// goDragItem is one kind of what's dragged in, and itself once dropped.
type goDragItem struct {
	Type string `json:"type"`
	Data string `json:"data"`
}

// goDropMax is the most dropped at once, all kinds together (the page's
// message holding it is at most goClientMessage).
const goDropMax = 32 << 10

// goDragData is items as the engine takes them: of the kinds a page may be
// given, within goDropMax.
func goDragData(items []goDragItem) map[string]any {
	list := []map[string]any{}
	room := goDropMax
	for _, it := range items {
		if len(list) == 3 || (it.Type != "text/plain" && it.Type != "text/uri-list" && it.Type != "text/html") {
			continue
		}
		data := it.Data
		if len(data) > room {
			data = strings.ToValidUTF8(data[:room], "") // not a character cut in two
		}
		room -= len(data)
		list = append(list, map[string]any{"mimeType": it.Type, "data": data})
	}
	// Copy, link or move: the page's choice.
	return map[string]any{"items": list, "dragOperationsMask": 1 | 2 | 16}
}

// goTouchPoint is a finger: the element under it, where within it
// (fractions, as the mouse's), and its number.
type goTouchPoint struct {
	ID int     `json:"id"`
	FX float64 `json:"fx"`
	FY float64 `json:"fy"`
	T  int     `json:"t"`
	// Where the finger is on the person's screen (the copy's window, the
	// engine's size), to move it by.
	CX *float64 `json:"cx"`
	CY *float64 `json:"cy"`
}

// screenAt is where p says it is on the person's screen, if it says, and
// within reason.
func (p goTouchPoint) screenAt() (float64, float64, bool) {
	if p.CX == nil || p.CY == nil {
		return 0, 0, false
	}
	x, y := *p.CX, *p.CY
	ok := x >= -1e5 && x <= 1e5 && y >= -1e5 && y <= 1e5 // (NaN's neither)
	return x, y, ok
}

func goModifiers(m goClientMsg) int {
	n := 0
	if m.Alt {
		n |= 1
	}
	if m.Ctrl {
		n |= 2
	}
	if m.Meta {
		n |= 4
	}
	if m.Shift {
		n |= 8
	}
	return n
}

func goButton(b int) string {
	switch b {
	case 0:
		return "left"
	case 1:
		return "middle"
	case 2:
		return "right"
	}
	return "none"
}

func goClamp(v, lo, hi float64) float64 {
	if !(v >= lo) { // NaN too
		return lo
	}
	return min(v, hi)
}

// pointer takes a mouse event from the person: a press, release or end of a
// drag in order; a move or wheel turn kept, newest, until the last is done.
func (b *goBrowser) pointer(m goClientMsg) {
	if m.Frame != 0 {
		b.pointerInFrame(m)
		return
	}
	switch m.Type {
	case "move", "wheel":
		if b.dialog {
			return
		}
		if m.Type == "wheel" {
			if w := b.wheelWaiting; w != nil {
				m.DX, m.DY = m.DX+w.DX, m.DY+w.DY
			}
			b.wheelWaiting = &m
		} else {
			b.moveWaiting = &m
		}
		b.movesOn()
	case "down", "up", "cancel":
		if b.acts.waiting() >= goActsWaiting {
			return // the page isn't keeping up: dropped
		}
		b.movesFirst()
		world, gen := b.world, b.gen
		b.acts.add(func() {
			b.input.press(b, world, gen, m)
			b.post(func() { b.afterInput(gen) })
		})
	}
}

// touch takes a touch from the person: its start and end in order; a move
// kept, newest, as the mouse's are.
func (b *goBrowser) touch(m goClientMsg) {
	if len(m.Points) > 10 {
		m.Points = m.Points[:10]
	}
	switch m.Type {
	case "move":
		if b.dialog {
			return
		}
		b.touchWaiting = &m
		b.movesOn()
	case "start", "end", "cancel":
		if b.acts.waiting() >= goActsWaiting {
			return
		}
		// The moves before it given first: a finger let go before its moves
		// were (a quick swipe, a slow engine) was a finger that hadn't
		// moved, and its swipe a tap.
		b.movesFirst()
		world, gen := b.world, b.gen
		b.acts.add(func() {
			b.input.touch(b, world, gen, m)
			b.post(func() { b.afterInput(gen) })
		})
	}
}

// drag takes what the person drags in from outside: a drop or its end in
// order; where it's dragged over kept, newest, as moves are.
func (b *goBrowser) drag(m goClientMsg) {
	switch m.Type {
	case "over":
		if b.dialog {
			return
		}
		b.dragWaiting = &m
		b.movesOn()
	case "drop", "cancel":
		if b.acts.waiting() >= goActsWaiting {
			return
		}
		b.movesFirst()
		world, gen := b.world, b.gen
		b.acts.add(func() {
			b.input.drag(b, world, gen, m)
			b.post(func() { b.afterInput(gen) })
		})
	}
}

// frameWorld is the world an embedded page's numbers are of, its iframe
// being the page's element owner: the frame's own, for another origin's;
// the page's, for its own origin's (the page's agent numbers it). 0, nil
// if it's none of the page's frames (any more).
func (b *goBrowser) frameWorld(owner int) (int, *goChild) {
	for _, c := range b.children {
		if c.owner == owner && (c.parent == "" || c.parent == b.frame) {
			if c.same {
				return b.world, c
			}
			return c.world, c
		}
	}
	return 0, nil
}

// frameWorldPath resolves each iframe owner in its containing frame. The
// owner IDs are local to that document, so matching only the outer iframe
// would send nested input to the wrong agent and node-number space.
func (b *goBrowser) frameWorldPath(owner int, route, docs []int) (int, *goChild) {
	if len(route) == 0 {
		return b.frameWorld(owner)
	}
	if len(route) > 2 || route[0] != owner || (len(docs) != 0 && len(docs) != len(route)) {
		return 0, nil
	}
	parent, parentWorld := b.frame, b.world
	var child *goChild
	for i, id := range route {
		if i == 0 && len(docs) != 0 && docs[i] != 0 {
			return 0, nil
		}
		child = nil
		for key, candidate := range b.children {
			if candidate.parent == parent && candidate.owner == id {
				child = candidate
				parent = key
				break
			}
		}
		if child == nil {
			return 0, nil
		}
		if i > 0 && len(docs) != 0 && docs[i] != 0 && docs[i] != parentWorld {
			return 0, nil
		}
		if child.same {
			// Same-origin frames are serialized and numbered by their parent's
			// agent, so their document runs in that same isolated world.
		} else {
			parentWorld = child.world
		}
	}
	return parentWorld, child
}

// inFrame runs one of the agent's calls in an embedded page's world, on
// the acts' queue, in that world only (were it gone, another world's
// numbers are another document's: evaluate would make the page's); then
// the frame is read again on the next round, and what the page changed.
func (b *goBrowser) inFrame(owner, fdoc int, route, docs []int, what string, expr string) {
	world, child := b.frameWorldPath(owner, route, docs)
	if world == 0 || b.acts.waiting() >= goActsWaiting {
		return
	}
	// Another origin's page numbers its nodes anew in each document (each
	// a world of its own): what was done in the copy of one isn't for the
	// next (it went elsewhere, or was replaced), whose same numbers are
	// other nodes, perhaps another site's.
	if !child.same && fdoc != world {
		goDebugf("frame %d %s: for a document gone (%d, now %d)", owner, what, fdoc, world)
		return
	}
	gen := b.gen
	b.acts.add(func() {
		ctx, cancel := context.WithTimeout(context.Background(), goInputWait)
		defer cancel()
		var r struct {
			Result struct {
				Value string `json:"value"`
			} `json:"result"`
		}
		err := b.cdp.call(ctx, b.page, "Runtime.evaluate", map[string]any{"expression": expr, "contextId": world, "returnByValue": true}, &r)
		goDebugf("frame %d %s: %s %v", owner, what, r.Result.Value, err)
		b.post(func() {
			if gen != b.gen {
				return
			}
			child.due, child.next, b.framesAt = true, time.Time{}, time.Time{} // read again, next round
			b.afterInput(gen)
		})
	})
}

// pointerInFrame gives the mouse to an element of an embedded page
// (m.Frame, by the frame's own number; m.ID its iframe's), by script, as
// the agent's mouse (pointer and mouse events, entering and leaving, a
// click where pressed, the wheel): its places there needn't be the copy's.
func (b *goBrowser) pointerInFrame(m goClientMsg) {
	switch m.Type {
	case "down", "up", "cancel", "move", "wheel":
	default:
		return
	}
	what, _ := json.Marshal(map[string]any{"kind": "mouse", "type": m.Type, "id": m.Frame, "fx": m.FX, "fy": m.FY,
		"button": int(goClamp(float64(m.Button), 0, 4)), "buttons": m.Buttons, "count": m.Count,
		"dx": goClamp(m.DX, -10000, 10000), "dy": goClamp(m.DY, -10000, 10000),
		"shift": m.Shift, "ctrl": m.Ctrl, "alt": m.Alt, "meta": m.Meta})
	arg, _ := json.Marshal(string(what))
	b.inFrame(m.ID, m.FDoc, m.Route, m.Docs, "mouse "+m.Type, "__tabtop.scripted("+string(arg)+")")
}

// actInFrame does what the person did in an embedded page (typing, a
// change, a key, focus, a form sent) by the agent there (act), as it's
// done when the engine won't take input: m.Frame its element.
func (b *goBrowser) actInFrame(m goClientMsg) {
	submitter := 0
	if m.Kind == "submit" {
		submitter = m.Submitter
	}
	a, _ := json.Marshal(map[string]any{"kind": m.Kind, "id": m.Frame, "value": m.Value, "checked": m.Checked, "key": m.Key,
		"code": m.Code, "shift": m.Shift, "ctrl": m.Ctrl, "alt": m.Alt, "meta": m.Meta, "submitter": submitter})
	arg, _ := json.Marshal(string(a))
	b.inFrame(m.ID, m.FDoc, m.Route, m.Docs, m.Kind, "__tabtop.act("+string(arg)+")")
}

// movesOn queues the waiting move, wheel turn, touch move and drag, if
// none are queued.
func (b *goBrowser) movesOn() {
	if b.movesQueued || (b.moveWaiting == nil && b.wheelWaiting == nil && b.touchWaiting == nil && b.dragWaiting == nil) {
		return
	}
	move, wheel, touch, drag := b.moveWaiting, b.wheelWaiting, b.touchWaiting, b.dragWaiting
	b.moveWaiting, b.wheelWaiting, b.touchWaiting, b.dragWaiting = nil, nil, nil, nil
	b.movesQueued = true
	world, gen := b.world, b.gen
	b.acts.add(func() {
		b.input.moves(b, world, gen, move, wheel, touch, drag)
		b.post(func() {
			b.movesQueued = false
			if gen == b.gen && !b.dialog {
				b.changed(goChangesEvery)
				b.movesOn()
			}
		})
	})
}

// moves gives the engine the moves waiting, those there are, in order.
func (in *goInput) moves(b *goBrowser, world, gen int, move, wheel, touch, drag *goClientMsg) {
	for _, m := range []*goClientMsg{move, wheel} {
		if m != nil {
			in.move(b, world, gen, *m)
		}
	}
	if touch != nil {
		in.touch(b, world, gen, *touch)
	}
	if drag != nil {
		in.drag(b, world, gen, *drag)
	}
}

// movesFirst queues the moves waiting (kept, newest: movesOn), before what
// comes after them: a press, a release, a finger down or let go, a drop.
func (b *goBrowser) movesFirst() {
	move, wheel, touch, drag := b.moveWaiting, b.wheelWaiting, b.touchWaiting, b.dragWaiting
	if move == nil && wheel == nil && touch == nil && drag == nil {
		return
	}
	b.moveWaiting, b.wheelWaiting, b.touchWaiting, b.dragWaiting = nil, nil, nil, nil
	world, gen := b.world, b.gen
	b.acts.add(func() {
		b.input.moves(b, world, gen, move, wheel, touch, drag)
	})
}

// key takes a key from the person, in order with the rest.
func (b *goBrowser) key(m goClientMsg) {
	if b.acts.waiting() >= goActsWaiting || len(m.Key) > 32 || len(m.Code) > 32 {
		return
	}
	world, gen := b.world, b.gen
	b.acts.add(func() {
		b.input.key(b, world, gen, m)
		b.post(func() { b.afterInput(gen) })
	})
}

// afterInput reads what an input changed, now and again in a moment, as an
// act's are (see act).
func (b *goBrowser) afterInput(gen int) {
	if gen != b.gen || b.dialog {
		return
	}
	b.dirty = true
	b.readChanges()
	go func() {
		select {
		case <-time.After(300 * time.Millisecond):
			b.post(func() { b.changed(0) })
		case <-b.stop:
		}
	}()
}

// at finds where in the engine's window real input at element id, at fx,
// fy across and down it, lands on it.
func (b *goBrowser) at(ctx context.Context, world, id int, fx, fy float64) (x, y float64, ok bool) {
	if _, res, err := b.evaluate(ctx, world, "__tabtop.into("+strconv.Itoa(id)+")"); err != nil || res != "ok" {
		return 0, 0, false
	}
	// Laid out again: the scroll, and changes of class (a menu shown on
	// hover), aren't, until then.
	if b.relayout(ctx) != nil {
		return 0, 0, false
	}
	arg, _ := json.Marshal(fmt.Sprintf(`{"id":%d,"fx":%g,"fy":%g}`, id, goClamp(fx, 0, 1), goClamp(fy, 0, 1)))
	_, res, err := b.evaluate(ctx, world, "__tabtop.point("+string(arg)+")")
	if err != nil || res == "" {
		return 0, 0, false
	}
	var p struct{ X, Y float64 }
	if json.Unmarshal([]byte(res), &p) != nil {
		return 0, 0, false
	}
	return p.X, p.Y, true
}

// letGoAway lets go of a button pressed in the page away from it (above
// and left of its window, over nothing): not a click. Obscura takes a
// release outside its window as one on what was pressed (a click); another
// button's release ends the press with none (measured).
func (b *goBrowser) letGoAway(ctx context.Context, button int) {
	let := goButton(button)
	if b.gaps().letGoClicks {
		let = map[bool]string{true: "left", false: "right"}[button == 2]
	}
	b.mouse(ctx, "mouseReleased", -1, -1, let, goClientMsg{})
}

// gaps is what the engine leaves out of input (goInputGaps).
func (b *goBrowser) gaps() goInputGaps {
	if b.e == nil {
		return goInputGaps{}
	}
	return b.e.adapter.input
}

// scripted has the agent do what the engine leaves out of input (pointer
// events and the like: goInputGaps.pointer): see goagent.js's scripted. It
// returns what the agent said, "" if the engine does it itself.
func (b *goBrowser) scripted(ctx context.Context, world int, what map[string]any) string {
	if !b.gaps().pointer {
		return ""
	}
	return b.agentInput(ctx, world, what)
}

// agentInput has the agent do one of goagent.js's scripted things.
func (b *goBrowser) agentInput(ctx context.Context, world int, what map[string]any) string {
	a, _ := json.Marshal(what)
	arg, _ := json.Marshal(string(a))
	_, res, err := b.evaluate(ctx, world, "__tabtop.scripted("+string(arg)+")")
	goDebugf("scripted %v: %s %v", what["kind"], res, err)
	return res
}

// mouse gives the engine one mouse event at x, y. An error that's the
// engine not answering in time is the event given (a dialog holds it);
// any other, it wasn't.
func (b *goBrowser) mouse(ctx context.Context, typ string, x, y float64, button string, m goClientMsg) (given bool) {
	p := map[string]any{"type": typ, "x": x, "y": y, "button": button,
		"buttons": int(goClamp(float64(m.Buttons), 0, 31)), "clickCount": int(goClamp(float64(m.Count), 0, 3)),
		"modifiers": goModifiers(m)}
	if typ == "mouseWheel" {
		p["deltaX"], p["deltaY"] = goClamp(m.DX, -10000, 10000), goClamp(m.DY, -10000, 10000)
	}
	err := b.cdp.call(ctx, b.page, "Input.dispatchMouseEvent", p, nil)
	goDebugf("input %s %s at %.0f,%.0f: %v", typ, button, x, y, err)
	return err == nil || errors.Is(err, context.DeadlineExceeded)
}

// release lets go of every button held, away from the page (above and left
// of its window, over nothing: so not a click): a press let go outside the
// frame, or the window left, or a press in a document that's gone.
func (in *goInput) release(b *goBrowser) {
	for button, p := range in.pressed {
		if p.real {
			ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
			b.letGoAway(ctx, button)
			cancel()
		}
	}
	in.pressed = map[int]goPress{}
	if in.touching {
		ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
		b.touchInput(ctx, "touchEnd", nil, goClientMsg{})
		cancel()
	}
	in.touching, in.touchID = false, 0
	if in.dragging {
		ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
		b.dragInput(ctx, "dragCancel", -1, -1, goClientMsg{})
		cancel()
		in.dragging = false
	}
}

// touch gives the engine a touch: the fingers down where they are on the
// engine's page (each found as a press's place is), or, at the end, none.
// The engine makes a tap's click itself, and a swipe's none. A touch the
// engine can't be given (nowhere for it) is, if a tap, a click by script.
func (in *goInput) touch(b *goBrowser, world, gen int, m goClientMsg) {
	if in.gen != gen {
		in.release(b)
		in.gen = gen
	}
	ctx, cancel := context.WithTimeout(context.Background(), goInputWait)
	defer cancel()
	switch m.Type {
	case "start", "move":
		if m.Type == "move" && !in.touching {
			return
		}
		if m.Type == "start" || in.fingers == nil {
			in.fingers = map[int][2]float64{}
		}
		var points []map[string]any
		for _, p := range m.Points {
			id := p.T & 0xffff
			cx, cy, onScreen := p.screenAt()
			var x, y float64
			if off, ok := in.fingers[id]; ok && onScreen {
				x, y = cx+off[0], cy+off[1] // moved as it moved there
			} else if ex, ey, ok := b.at(ctx, world, p.ID, p.FX, p.FY); ok {
				x, y = ex, ey // down: on what's under it
				if onScreen {
					in.fingers[id] = [2]float64{ex - cx, ey - cy}
				}
			} else {
				continue
			}
			points = append(points, map[string]any{"x": x, "y": y, "id": id, "radiusX": 1, "radiusY": 1, "force": 1})
		}
		if len(points) == 0 {
			if m.Type == "start" && !in.touching && len(m.Points) > 0 {
				in.touchID = m.Points[0].ID
			}
			return
		}
		typ := "touchMove"
		if m.Type == "start" {
			typ = "touchStart"
		}
		if b.touchInput(ctx, typ, points, m) {
			in.touching = true
		}
	case "end", "cancel":
		in.fingers = nil
		if in.touching {
			in.touching = false
			// Cancelled (by the browser, or a finger on a player that wasn't
			// a swipe): no tap's click of the engine's own.
			typ := "touchEnd"
			if m.Type == "cancel" {
				typ = "touchCancel"
			}
			b.touchInput(ctx, typ, nil, m)
			return
		}
		if id := in.touchID; id != 0 && m.Type == "end" && m.Tap {
			b.actNow(ctx, world, goClientMsg{Kind: "click", ID: id})
		}
		in.touchID = 0
	}
}

// drag gives the engine what's dragged in from outside, where it's
// dragged over or dropped (found as a press's place is), as a browser's
// drag: entering, over, then dropped, or gone.
func (in *goInput) drag(b *goBrowser, world, gen int, m goClientMsg) {
	if in.gen != gen {
		in.release(b)
		in.gen = gen
	}
	ctx, cancel := context.WithTimeout(context.Background(), goInputWait)
	defer cancel()
	if m.Type == "cancel" {
		if in.dragging {
			in.dragging = false
			b.dragInput(ctx, "dragCancel", -1, -1, m)
		}
		return
	}
	x, y, ok := b.at(ctx, world, m.ID, m.FX, m.FY)
	if !ok {
		return
	}
	if !in.dragging {
		if !b.dragInput(ctx, "dragEnter", x, y, m) {
			return
		}
		in.dragging = true
	}
	if m.Type == "drop" {
		b.dragInput(ctx, "dragOver", x, y, m)
		in.dragging = false
		b.dragInput(ctx, "drop", x, y, m)
		return
	}
	b.dragInput(ctx, "dragOver", x, y, m)
}

// dragInput gives the engine one drag event; as mouse does.
func (b *goBrowser) dragInput(ctx context.Context, typ string, x, y float64, m goClientMsg) (given bool) {
	err := b.cdp.call(ctx, b.page, "Input.dispatchDragEvent", map[string]any{"type": typ, "x": x, "y": y,
		"data": goDragData(m.Items), "modifiers": goModifiers(m)}, nil)
	goDebugf("input %s at %.0f,%.0f: %v", typ, x, y, err)
	return err == nil || errors.Is(err, context.DeadlineExceeded)
}

// touchInput gives the engine one touch event; as mouse does.
func (b *goBrowser) touchInput(ctx context.Context, typ string, points []map[string]any, m goClientMsg) (given bool) {
	if points == nil {
		points = []map[string]any{}
	}
	err := b.cdp.call(ctx, b.page, "Input.dispatchTouchEvent", map[string]any{"type": typ, "touchPoints": points, "modifiers": goModifiers(m)}, nil)
	goDebugf("input %s, %d points: %v", typ, len(points), err)
	return err == nil || errors.Is(err, context.DeadlineExceeded)
}

// pressByElement gives a press, release or let go to the element pointed
// at, by script, for an engine whose places aren't to be trusted
// (goInputGaps.byElement).
func (in *goInput) pressByElement(b *goBrowser, world int, m goClientMsg) {
	ctx, cancel := context.WithTimeout(context.Background(), goInputWait)
	defer cancel()
	b.agentInput(ctx, world, map[string]any{"kind": "mouse", "type": m.Type, "id": m.ID, "fx": m.FX, "fy": m.FY,
		"button": int(goClamp(float64(m.Button), 0, 4)), "buttons": m.Buttons, "count": m.Count,
		"shift": m.Shift, "ctrl": m.Ctrl, "alt": m.Alt, "meta": m.Meta})
}

func (in *goInput) press(b *goBrowser, world, gen int, m goClientMsg) {
	if in.gen != gen {
		in.release(b)
		in.gen = gen
	}
	if b.gaps().byElement {
		in.pressByElement(b, world, m)
		return
	}
	if m.Type == "cancel" {
		in.release(b)
		return
	}
	button := int(goClamp(float64(m.Button), 0, 4))
	ctx, cancel := context.WithTimeout(context.Background(), goInputWait)
	defer cancel()
	switch m.Type {
	case "down":
		if old, held := in.pressed[button]; held && old.real {
			b.letGoAway(ctx, button)
		}
		x, y, ok := b.at(ctx, world, m.ID, m.FX, m.FY)
		if ok {
			b.scripted(ctx, world, map[string]any{"kind": "pointer", "type": "pointerdown", "x": x, "y": y, "button": button, "buttons": m.Buttons})
		}
		if ok && b.mouse(ctx, "mousePressed", x, y, goButton(button), m) {
			in.pressed[button] = goPress{real: true, id: m.ID, x: x, y: y}
			return
		}
		// Nowhere to give it as input (the engine has the element nowhere,
		// or something over it): pressed by script, as a press is, with
		// its pointer and mouse events (a page's own gesture code, as
		// YouTube's buttons', goes by those, not by the click).
		b.agentInput(ctx, world, map[string]any{"kind": "mouse", "type": "down", "id": m.ID, "fx": m.FX, "fy": m.FY,
			"button": button, "buttons": m.Buttons, "count": m.Count, "shift": m.Shift, "ctrl": m.Ctrl, "alt": m.Alt, "meta": m.Meta})
		in.pressed[button] = goPress{id: m.ID, scripted: true}
	case "up":
		p, held := in.pressed[button]
		if !held {
			return // its press wasn't seen
		}
		delete(in.pressed, button)
		if p.real {
			x, y, ok := b.at(ctx, world, m.ID, m.FX, m.FY)
			if !ok {
				x, y = p.x, p.y
			}
			b.mouse(ctx, "mouseReleased", x, y, goButton(button), m)
			b.scripted(ctx, world, map[string]any{"kind": "pointer", "type": "pointerup", "x": x, "y": y, "button": button, "buttons": m.Buttons})
			if button == 2 {
				b.scripted(ctx, world, map[string]any{"kind": "contextmenu", "x": x, "y": y})
			}
			return
		}
		// Pressed by script: let go so, a click if where it was pressed.
		b.agentInput(ctx, world, map[string]any{"kind": "mouse", "type": "up", "id": m.ID, "fx": m.FX, "fy": m.FY,
			"button": button, "buttons": m.Buttons, "count": m.Count, "shift": m.Shift, "ctrl": m.Ctrl, "alt": m.Alt, "meta": m.Meta})
	}
}

func (in *goInput) move(b *goBrowser, world, gen int, m goClientMsg) {
	if in.gen != gen {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
	defer cancel()
	if b.gaps().byElement {
		typ := "move"
		if m.Type == "wheel" {
			typ = "wheel"
		}
		b.agentInput(ctx, world, map[string]any{"kind": "mouse", "type": typ, "id": m.ID, "fx": m.FX, "fy": m.FY,
			"buttons": m.Buttons, "dx": goClamp(m.DX, -10000, 10000), "dy": goClamp(m.DY, -10000, 10000)})
		return
	}
	x, y, ok := b.at(ctx, world, m.ID, m.FX, m.FY)
	if !ok {
		return
	}
	if m.Type == "wheel" {
		b.mouse(ctx, "mouseWheel", x, y, "none", m)
		return
	}
	b.scripted(ctx, world, map[string]any{"kind": "pointer", "type": "pointermove", "x": x, "y": y, "buttons": m.Buttons})
	button := "none"
	for i, name := range []string{"left", "right", "middle"} {
		if m.Buttons&(1<<i) != 0 {
			button = name
			break
		}
	}
	b.mouse(ctx, "mouseMoved", x, y, button, m)
}

// keyScripted does, for an engine that doesn't, what a key does besides
// its events: Space (on its release) or Enter pressing what has the focus,
// as a click there, given as input (a trusted click, as a browser's is);
// Tab moving the focus on.
func (in *goInput) keyScripted(ctx context.Context, b *goBrowser, world int, m goClientMsg) {
	gaps := b.gaps()
	if goModifiers(m)&^8 != 0 {
		return
	}
	switch {
	case m.Key == "Tab" && m.Type == "down" && gaps.tab:
		b.agentInput(ctx, world, map[string]any{"kind": "tab", "back": m.Shift})
	case (m.Key == " " && m.Type == "up" || m.Key == "Enter" && m.Type == "down") && slices.Contains(gaps.activate, m.Key):
		if b.agentInput(ctx, world, map[string]any{"kind": "activate", "id": m.ID, "key": m.Key}) != "click" {
			return
		}
		if gaps.byElement {
			b.agentInput(ctx, world, map[string]any{"kind": "mouse", "type": "click", "id": m.ID, "fx": 0.5, "fy": 0.5, "button": 0, "count": 1})
			return
		}
		if x, y, ok := b.at(ctx, world, m.ID, 0.5, 0.5); ok {
			click := goClientMsg{Buttons: 1, Count: 1}
			if b.mouse(ctx, "mousePressed", x, y, "left", click) {
				click.Buttons = 0
				b.mouse(ctx, "mouseReleased", x, y, "left", click)
			}
		}
	}
}

func (in *goInput) key(b *goBrowser, world, gen int, m goClientMsg) {
	ctx, cancel := context.WithTimeout(context.Background(), goInputWait)
	defer cancel()
	p := map[string]any{"key": m.Key, "code": m.Code,
		"windowsVirtualKeyCode": int(goClamp(float64(m.KeyCode), 0, 255)), "nativeVirtualKeyCode": int(goClamp(float64(m.KeyCode), 0, 255)),
		"modifiers": goModifiers(m), "autoRepeat": m.Repeat, "location": int(goClamp(float64(m.Location), 0, 3))}
	if m.Type == "up" {
		p["type"] = "keyUp"
	} else {
		_, res, err := b.evaluate(ctx, world, "__tabtop.keyTo("+strconv.Itoa(m.ID)+")")
		if err != nil || res == "gone" {
			return
		}
		p["type"] = "rawKeyDown"
		if m.Key == "Enter" && res == "field" && goModifiers(m)&^8 == 0 {
			// Enter in a one-line field, as typed: it sends the form.
			p["type"], p["text"], p["unmodifiedText"] = "keyDown", "\r", "\r"
		}
	}
	err := b.cdp.call(ctx, b.page, "Input.dispatchKeyEvent", p, nil)
	goDebugf("input key %s %q: %v", p["type"], m.Key, err)
	if err == nil {
		in.keyScripted(ctx, b, world, m)
	}
	if err != nil && !errors.Is(err, context.DeadlineExceeded) && m.Type == "down" {
		// The engine wouldn't take it: by script, as before.
		b.actNow(ctx, world, goClientMsg{Kind: "key", ID: m.ID, Key: m.Key, Code: m.Code, Shift: m.Shift, Ctrl: m.Ctrl, Alt: m.Alt, Meta: m.Meta})
	}
}
