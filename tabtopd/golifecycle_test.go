package main

import (
	"testing"
	"time"
)

// TestGoConnLostAndBack: the person's browser gone, the page's fullscreen
// goes with it (the page told it's left: a browser enters fullscreen only
// at its person's press, so the next can't be put back in it); a
// connection that takes the tab back is asked again what the page waits
// on the person for: its notification permission, its reads of the
// clipboard.
func TestGoConnLostAndBack(t *testing.T) {
	b, w := goClipTab()
	b.inputAt, b.inputGen, b.inputWorld = time.Now(), 1, 1
	b.clipboard(1, 1, goClipboardOut{Fullscreen: []goFullscreenAsk{{On: true, ID: "f1"}}})
	if b.fullscreen == nil {
		t.Fatal("fullscreen not allowed")
	}
	b.orientLocked = true
	waiting := b.acts.waiting()
	b.connLost()
	if b.fullscreen != nil || b.orientLocked || b.acts.waiting() == waiting {
		t.Errorf("connection lost: fullscreen %+v, orientation locked %v, page told %d", b.fullscreen, b.orientLocked, b.acts.waiting()-waiting)
	}

	b2, w2 := goClipTab()
	b2.inputAt, b2.inputGen, b2.inputWorld = time.Now(), 1, 1
	b2.clipboard(1, 1, goClipboardOut{PasteAsks: []string{"p1"}, Notify: &goNotifyOut{Asks: []string{"n1"}}})
	pastes, notifies := len(goSentOf(w2, "go-paste-ask")), len(goSentOf(w2, "go-notify-ask"))
	if pastes != 1 || notifies != 1 {
		t.Fatalf("asked %d reads and %d permissions", pastes, notifies)
	}
	b2.connLost()
	b2.connBack()
	again := goSentOf(w2, "go-paste-ask")
	if len(again) != 2 || again[1]["ask"] != again[0]["ask"] || again[1]["site"] != again[0]["site"] {
		t.Errorf("the read asked again as %v", again)
	}
	if n := goSentOf(w2, "go-notify-ask"); len(n) != 2 || n[1]["ask"] != n[0]["ask"] {
		t.Errorf("the permission asked again as %v", n)
	}
	_ = w
}
