package main

import "testing"

// TestGoOrientation: a lock is asked of the person's browser only while the
// page is in its own fullscreen, where that browser can lock; its answer is
// the page's; with its fullscreen gone, it's unlocked there.
func TestGoOrientation(t *testing.T) {
	lock := func(typ, id string) goClipboardOut {
		return goClipboardOut{Orientation: []goOrientAsk{{Lock: typ, ID: id}}}
	}
	b, w := goClipTab()
	b.viewerCaps.Orientation = true
	// Not in its fullscreen: refused (the page answered, nothing asked).
	b.clipboard(1, 1, lock("landscape", "a"))
	if len(goSentOf(w, "go-orientation")) != 0 || b.acts.waiting() != 1 {
		t.Fatal("asked with no fullscreen")
	}
	b.fullscreen = &goFullscreen{gen: 1, world: 1}
	b.clipboard(1, 1, lock("sideways", "b"))
	if len(goSentOf(w, "go-orientation")) != 0 {
		t.Fatal("asked for a type that isn't one")
	}
	b.clipboard(1, 1, lock("landscape", "c"))
	sent := goSentOf(w, "go-orientation")
	if len(sent) != 1 || sent[0]["lock"] != "landscape" || sent[0]["id"] != "c" {
		t.Fatalf("asked %v", sent)
	}
	waiting := b.acts.waiting()
	b.orientationAnswered(goClientMsg{Op: "orientation-answer", Gen: 1, Text: "c"})
	if !b.orientLocked || b.acts.waiting() != waiting+1 {
		t.Error("its answer not the page's")
	}
	// An answer for no lock asked: nothing.
	b.orientationAnswered(goClientMsg{Op: "orientation-answer", Gen: 1, Text: "zz"})
	if b.acts.waiting() != waiting+1 {
		t.Error("an answer for nothing passed on")
	}
	// Its fullscreen left: unlocked there.
	b.fullscreenLet(false)
	if s := goSentOf(w, "go-orientation"); len(s) != 2 || s[1]["unlock"] != true || b.orientLocked {
		t.Errorf("not unlocked with its fullscreen: %v", s)
	}
	// Where the person's browser can't lock: refused at once.
	b2, w2 := goClipTab()
	b2.fullscreen = &goFullscreen{gen: 1, world: 1}
	b2.clipboard(1, 1, lock("portrait", "a"))
	if len(goSentOf(w2, "go-orientation")) != 0 {
		t.Error("asked of a browser that can't lock")
	}
}
