package main

import "testing"

// TestGoRecycle: past its soft limit (goRecycleAt of its memory limit) for
// goRecycleAfter, not just for a moment, a tab's engine has its viewer
// advised to move it to a fresh one, once; and a viewer connecting again is
// advised again.
func TestGoRecycle(t *testing.T) {
	b, w := goClipTab()
	b.gen = 3
	b.e = &goEngine{cfg: goEngineConfig{memory: 1000}}
	b.e.rss.Store(500)
	b.recycleSoon()
	if len(goSentOf(w, "go-recycle")) != 0 {
		t.Fatal("advised under its soft limit")
	}
	// Past it a moment (a page loading), then under again: not advised.
	b.e.rss.Store(650)
	b.recycleSoon()
	if len(goSentOf(w, "go-recycle")) != 0 {
		t.Fatal("advised as soon as it's past its soft limit")
	}
	b.overSince = b.overSince.Add(-2 * goRecycleAfter)
	b.e.rss.Store(500)
	b.recycleSoon()
	b.e.rss.Store(650)
	b.recycleSoon()
	if len(goSentOf(w, "go-recycle")) != 0 {
		t.Fatal("advised for a moment past it, after a while under")
	}
	// Past it for long enough: advised, once.
	b.overSince = b.overSince.Add(-goRecycleAfter)
	b.recycleSoon()
	b.recycleSoon()
	advised := goSentOf(w, "go-recycle")
	if len(advised) != 1 || advised[0]["gen"] != float64(3) && advised[0]["gen"] != 3 {
		t.Fatalf("advised %v", advised)
	}
	b.recycleAgain()
	if len(goSentOf(w, "go-recycle")) != 2 {
		t.Errorf("a viewer connecting again not advised")
	}
	// An engine with no limit (0: none known) isn't past one.
	b2, w2 := goClipTab()
	b2.e = &goEngine{}
	b2.e.rss.Store(1 << 40)
	b2.recycleSoon()
	b2.recycleAgain()
	if len(goSentOf(w2, "go-recycle")) != 0 {
		t.Errorf("advised with no limit")
	}
}
