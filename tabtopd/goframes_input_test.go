package main

import "testing"

// What's done in an embedded page of another origin is for the document
// its copy came from (its world): for another (it went elsewhere, or was
// replaced, numbering its nodes anew) it's dropped, not done to the nodes
// that now have those numbers. Its own origin's frames are the page's
// agent's to number, never anew: those aren't checked.
func TestGoFrameInputForItsDocument(t *testing.T) {
	b := &goBrowser{acts: newGoQueue(), world: 3, children: map[string]*goChild{
		"other": {owner: 10, world: 42},
		"same":  {owner: 20, same: true},
	}}
	press := func(owner, fdoc int) goClientMsg {
		return goClientMsg{Kind: "mouse", Type: "down", ID: owner, Frame: 5, FDoc: fdoc}
	}
	for _, c := range []struct {
		name string
		m    goClientMsg
		done bool
	}{
		{"its document", press(10, 42), true},
		{"a document gone", press(10, 41), false},
		{"no document said", press(10, 0), false},
		{"not one of the page's frames", press(30, 42), false},
		{"its own origin's", press(20, 0), true},
		{"typing, a document gone", goClientMsg{Kind: "input", ID: 10, Frame: 5, FDoc: 7, Value: "secret"}, false},
		{"typing, its document", goClientMsg{Kind: "input", ID: 10, Frame: 5, FDoc: 42, Value: "x"}, true},
	} {
		before := b.acts.waiting()
		b.act(c.m)
		if done := b.acts.waiting() > before; done != c.done {
			t.Errorf("%s: queued %v, want %v", c.name, done, c.done)
		}
	}
}

func TestGoFrameInputNestedRoute(t *testing.T) {
	b := &goBrowser{acts: newGoQueue(), world: 3, frame: "main", children: map[string]*goChild{
		"outer": {parent: "main", owner: 10, world: 42},
		"inner": {parent: "outer", owner: 20, world: 77},
	}}
	world, child := b.frameWorldPath(10, []int{10, 20}, []int{0, 42})
	if world != 77 || child == nil || child.owner != 20 {
		t.Fatalf("nested route resolved to world %d, child %#v", world, child)
	}
	if world, child = b.frameWorldPath(10, []int{10, 20}, []int{0, 41}); world != 0 || child != nil {
		t.Fatalf("stale parent document accepted: world %d, child %#v", world, child)
	}
	if world, child = b.frameWorldPath(10, []int{10, 99}, []int{0, 42}); world != 0 || child != nil {
		t.Fatalf("unknown nested owner accepted: world %d, child %#v", world, child)
	}
}
