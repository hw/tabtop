package main

import "testing"

// TestGoDropInFrame: files dropped on an embedded page go to its world
// only if it's still the document they were dropped on; one gone, or not
// known, is refused (the person told), nothing put anywhere.
func TestGoDropInFrame(t *testing.T) {
	b, w := goClipTab()
	refused := func() int { return len(goSentOf(w, "go-file-chooser-refused")) }
	// The frame's document since replaced (another fdoc).
	b.dropInFrame(goClientMsg{ID: 9, Frame: 3, FDoc: 5}, []string{"/run/tt/a/a.txt"}, 1)
	if refused() != 1 || b.acts.waiting() != 0 {
		t.Fatalf("a drop on a document gone: refused %d, queued %d", refused(), b.acts.waiting())
	}
	// No such embedded page.
	b.dropInFrame(goClientMsg{ID: 99, Frame: 3, FDoc: 7}, []string{"/run/tt/a/a.txt"}, 1)
	if refused() != 2 || b.acts.waiting() != 0 {
		t.Fatalf("a drop on no embedded page: refused %d, queued %d", refused(), b.acts.waiting())
	}
	// The same document: given to its world.
	b.dropInFrame(goClientMsg{ID: 9, Frame: 3, FDoc: 7}, []string{"/run/tt/a/a.txt"}, 1)
	if refused() != 2 || b.acts.waiting() != 1 {
		t.Errorf("a drop on its document: refused %d, queued %d", refused(), b.acts.waiting())
	}
}
