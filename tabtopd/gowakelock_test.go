package main

import (
	"testing"
	"time"
)

// TestGoWakeLock: a secure top page's wake lock is allowed after the
// person's input there, where their browser has one; the person's held
// while any sentinel is, let go with the last, or with the page; lost
// there, the page's released.
func TestGoWakeLock(t *testing.T) {
	ask := func(on bool, id string) goClipboardOut {
		return goClipboardOut{WakeLock: []goWakeAsk{{On: on, ID: id}}}
	}
	b, w := goClipTab()
	b.viewerCaps.WakeLock = true
	b.clipboard(1, 1, ask(true, "a"))
	if len(b.wakeHeld) != 0 || len(goSentOf(w, "go-wakelock")) != 0 || b.acts.waiting() != 1 {
		t.Fatalf("allowed with no input: held %v", b.wakeHeld)
	}
	b.inputAt, b.inputGen, b.inputWorld = time.Now(), 1, 1
	b.clipboard(1, 1, ask(true, "a"))
	b.clipboard(1, 1, ask(true, "b"))
	if on := goSentOf(w, "go-wakelock"); len(b.wakeHeld) != 2 || len(on) != 1 || on[0]["on"] != true {
		t.Fatalf("after input: held %v, told %v", b.wakeHeld, on)
	}
	b.clipboard(1, 1, ask(false, "a"))
	if len(goSentOf(w, "go-wakelock")) != 1 {
		t.Error("let go with a sentinel still held")
	}
	b.clipboard(1, 1, ask(false, "b"))
	if off := goSentOf(w, "go-wakelock"); len(off) != 2 || off[1]["on"] != false {
		t.Errorf("the last let go: told %v", off)
	}
	// Lost in the person's browser: the page's released.
	b.clipboard(1, 1, ask(true, "c"))
	waiting := b.acts.waiting()
	b.wakeLockLost()
	if len(b.wakeHeld) != 0 || b.acts.waiting() != waiting+1 {
		t.Errorf("lost: held %v", b.wakeHeld)
	}
	// Gone with its page.
	b.clipboard(1, 1, ask(true, "d"))
	b.wakeLockGone()
	if off := goSentOf(w, "go-wakelock"); len(b.wakeHeld) != 0 || off[len(off)-1]["on"] != false {
		t.Errorf("not let go with its page: %v", off)
	}
	// Another origin's frame's, an insecure page's, and one where the
	// person's browser has none: refused.
	b2, w2 := goClipTab()
	b2.viewerCaps.WakeLock = true
	b2.inputAt, b2.inputGen, b2.inputWorld = time.Now(), 1, 7
	b2.clipboard(1, 7, ask(true, "a"))
	b3, w3 := goClipTab()
	b3.viewerCaps.WakeLock = true
	b3.docURL = "http://www.example.com/page"
	b3.inputAt, b3.inputGen, b3.inputWorld = time.Now(), 1, 1
	b3.clipboard(1, 1, ask(true, "a"))
	b4, w4 := goClipTab()
	b4.inputAt, b4.inputGen, b4.inputWorld = time.Now(), 1, 1
	b4.clipboard(1, 1, ask(true, "a"))
	for i, c := range []struct {
		b *goBrowser
		w *goWrites
	}{{b2, w2}, {b3, w3}, {b4, w4}} {
		if len(c.b.wakeHeld) != 0 || len(goSentOf(c.w, "go-wakelock")) != 0 {
			t.Errorf("case %d allowed", i)
		}
	}
}
