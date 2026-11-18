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
	"strconv"
	"time"
)

// goInputWait is how long one input may take: as long as a dialog it opens
// may wait for the person, and a little.
const goInputWait = goDialogWait + 10*time.Second

// goPress is a mouse button held down: given as input at x, y (real), or
// left to be a scripted click on release.
type goPress struct {
	real bool
	id   int
	x, y float64
}

// goInput is the acts' queue's own: only its functions touch it.
type goInput struct {
	gen     int // the generation presses were made in
	pressed map[int]goPress
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
		world, gen := b.world, b.gen
		b.acts.add(func() {
			b.input.press(b, world, gen, m)
			b.post(func() { b.afterInput(gen) })
		})
	}
}

// movesOn queues the waiting move and wheel turn, if none are queued.
func (b *goBrowser) movesOn() {
	if b.movesQueued || (b.moveWaiting == nil && b.wheelWaiting == nil) {
		return
	}
	move, wheel := b.moveWaiting, b.wheelWaiting
	b.moveWaiting, b.wheelWaiting = nil, nil
	b.movesQueued = true
	world, gen := b.world, b.gen
	b.acts.add(func() {
		for _, m := range []*goClientMsg{move, wheel} {
			if m != nil {
				b.input.move(b, world, gen, *m)
			}
		}
		b.post(func() {
			b.movesQueued = false
			if gen == b.gen && !b.dialog {
				b.changed(goChangesEvery)
				b.movesOn()
			}
		})
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
			b.mouse(ctx, "mouseReleased", -1, -1, goButton(button), goClientMsg{})
			cancel()
		}
	}
	in.pressed = map[int]goPress{}
}

func (in *goInput) press(b *goBrowser, world, gen int, m goClientMsg) {
	if in.gen != gen {
		in.release(b)
		in.gen = gen
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
			b.mouse(ctx, "mouseReleased", -1, -1, goButton(button), goClientMsg{})
		}
		x, y, ok := b.at(ctx, world, m.ID, m.FX, m.FY)
		if ok && b.mouse(ctx, "mousePressed", x, y, goButton(button), m) {
			in.pressed[button] = goPress{real: true, id: m.ID, x: x, y: y}
			return
		}
		in.pressed[button] = goPress{id: m.ID}
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
			return
		}
		// Not given as input (nowhere for it): a click, by script, as
		// before, on what was pressed.
		if button == 0 {
			b.actNow(ctx, world, goClientMsg{Kind: "click", ID: p.id})
		}
	}
}

func (in *goInput) move(b *goBrowser, world, gen int, m goClientMsg) {
	if in.gen != gen {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
	defer cancel()
	x, y, ok := b.at(ctx, world, m.ID, m.FX, m.FY)
	if !ok {
		return
	}
	if m.Type == "wheel" {
		b.mouse(ctx, "mouseWheel", x, y, "none", m)
		return
	}
	button := "none"
	for i, name := range []string{"left", "right", "middle"} {
		if m.Buttons&(1<<i) != 0 {
			button = name
			break
		}
	}
	b.mouse(ctx, "mouseMoved", x, y, button, m)
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
	if err != nil && !errors.Is(err, context.DeadlineExceeded) && m.Type == "down" {
		// The engine wouldn't take it: by script, as before.
		b.actNow(ctx, world, goClientMsg{Kind: "key", ID: m.ID, Key: m.Key, Code: m.Code, Shift: m.Shift, Ctrl: m.Ctrl, Alt: m.Alt, Meta: m.Meta})
	}
}
