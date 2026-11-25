package main

import (
	"testing"
	"time"
)

// TestGoPointerLock: the top page's lock is asked of the person's browser
// after their input there; the page's told once that browser has it, its
// locked input passed on while it's held; left there, the page's told;
// refused with no input, in another origin's frame, or where it can't lock.
func TestGoPointerLock(t *testing.T) {
	ask := func(on bool, id string) goClipboardOut {
		return goClipboardOut{PointerLock: []goPointerAsk{{On: on, ID: id}}}
	}
	b, w := goClipTab()
	b.viewerCaps.PointerLock = true
	b.clipboard(1, 1, ask(true, "a"))
	if b.pointerLock != nil || len(goSentOf(w, "go-pointerlock")) != 0 || b.acts.waiting() != 1 {
		t.Fatal("asked with no input")
	}
	b.inputAt, b.inputGen, b.inputWorld = time.Now(), 1, 1
	b.clipboard(1, 1, ask(true, "b"))
	if on := goSentOf(w, "go-pointerlock"); b.pointerLock == nil || len(on) != 1 || on[0]["on"] != true {
		t.Fatalf("after input: %+v, told %v", b.pointerLock, on)
	}
	// Input before it's held: not the page's.
	waiting := b.acts.waiting()
	b.lockedInput(goClientMsg{Gen: 1, Kind: "locked", Type: "move", DX: 5})
	if b.acts.waiting() != waiting {
		t.Error("locked input passed on before it's held")
	}
	b.pointerLockState("on")
	if !b.pointerLock.held || b.acts.waiting() != waiting+1 {
		t.Fatal("held there: the page not told")
	}
	b.lockedInput(goClientMsg{Gen: 1, Kind: "locked", Type: "move", DX: 5})
	b.lockedInput(goClientMsg{Gen: 1, Kind: "locked", Type: "down"})
	b.lockedInput(goClientMsg{Gen: 1, Kind: "locked", Type: "sideways"})
	if b.acts.waiting() != waiting+3 {
		t.Errorf("locked input: %d queued, want 2", b.acts.waiting()-waiting-1)
	}
	// Left there (Esc): the page told.
	b.pointerLockState("off")
	if b.pointerLock != nil || b.acts.waiting() != waiting+4 {
		t.Error("left there: the page not told")
	}
	// Left by the page: the person's browser told.
	b.clipboard(1, 1, ask(true, "c"))
	b.pointerLockState("on")
	b.clipboard(1, 1, ask(false, ""))
	if off := goSentOf(w, "go-pointerlock"); b.pointerLock != nil || off[len(off)-1]["on"] != false {
		t.Errorf("left by the page: %v", off)
	}
	// Refused there: the page told, nothing held.
	b.clipboard(1, 1, ask(true, "d"))
	b.pointerLockState("error")
	if b.pointerLock != nil {
		t.Error("refused there, still held")
	}
	// Gone with its page.
	b.clipboard(1, 1, ask(true, "e"))
	b.pointerLockGone()
	if off := goSentOf(w, "go-pointerlock"); b.pointerLock != nil || off[len(off)-1]["on"] != false {
		t.Errorf("not left with its page: %v", off)
	}
	// The person's browser gone (its connection lost): the page told it's
	// left, the wake lock kept for the next to take again, the orientation
	// lock let go.
	b.clipboard(1, 1, ask(true, "f"))
	b.pointerLockState("on")
	b.wakeHeld = map[string]bool{"w": true}
	b.orientLocked = true
	waiting = b.acts.waiting()
	b.connLost()
	if b.pointerLock != nil || b.acts.waiting() != waiting+1 || b.orientLocked || len(b.wakeHeld) != 1 {
		t.Errorf("connection lost: lock %+v, told %d, orientation %v, wake %v", b.pointerLock, b.acts.waiting()-waiting, b.orientLocked, b.wakeHeld)
	}
	b.wakeLockAgain()
	if on := goSentOf(w, "go-wakelock"); len(on) != 1 || on[0]["on"] != true {
		t.Errorf("taken back: wake lock told %v", on)
	}
	// Another origin's frame's, and where the person's browser can't lock.
	b2, w2 := goClipTab()
	b2.viewerCaps.PointerLock = true
	b2.inputAt, b2.inputGen, b2.inputWorld = time.Now(), 1, 7
	b2.clipboard(1, 7, ask(true, "a"))
	b3, w3 := goClipTab()
	b3.inputAt, b3.inputGen, b3.inputWorld = time.Now(), 1, 1
	b3.clipboard(1, 1, ask(true, "a"))
	if len(goSentOf(w2, "go-pointerlock")) != 0 || len(goSentOf(w3, "go-pointerlock")) != 0 {
		t.Error("asked for a frame's, or of a browser that can't lock")
	}
}
