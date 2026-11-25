package main

import "testing"

// TestGoOps: what the person's browser sends is taken by its generation's
// rule: one of the tab's generation now only for what a page asked of it.
func TestGoOps(t *testing.T) {
	b, _ := goClipTab()
	b.gen = 2
	b.wakeHeld = map[string]bool{"w": true}
	b.takeOp(goClientMsg{Op: "wakelock-lost", Gen: 1})
	if len(b.wakeHeld) != 1 {
		t.Error("a page gone's lost wake lock released this page's")
	}
	b.takeOp(goClientMsg{Op: "wakelock-lost", Gen: 2})
	if len(b.wakeHeld) != 0 {
		t.Error("this page's lost wake lock kept")
	}
	for op, o := range goOps {
		if o.do == nil || o.gen < goOpAny || o.gen > goOpShown {
			t.Errorf("%s: %+v", op, o)
		}
	}
	if _, ok := goOps["close"]; ok {
		t.Error("close is run's own")
	}
}
