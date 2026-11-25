package main

import (
	"math"
	"testing"
	"time"
)

// TestGoMediaSession: the page's session passed on as it changes (cleaned:
// its actions those there are, a position that's one), not again unchanged,
// its position alone not soon again; another origin's frame's, or an old
// page's, not at all; cleared as the page goes, said again to the next to
// connect. A control pressed is the page's handler's only if it has one,
// as the person's input in the page.
func TestGoMediaSession(t *testing.T) {
	b, w := goClipTab()
	say := func(world, gen int, s goMediaSessionOut) { b.clipboard(gen, world, goClipboardOut{MediaSession: &s}) }
	sent := func() []map[string]any { return goSentOf(w, "go-media-session") }
	song := goMediaSessionOut{
		Metadata: &goMediaMetadata{Title: "Song", Artist: "Band", Album: "Record"},
		State:    "playing",
		Actions:  []string{"play", "pause", "bogus", "play", "nexttrack"},
		Position: &goMediaPosition{Duration: 10, Rate: 1, Position: 3},
	}
	say(1, 1, song)
	got := sent()
	if len(got) != 1 {
		t.Fatalf("sent %d", len(got))
	}
	md, _ := got[0]["metadata"].(map[string]any)
	if md["title"] != "Song" || md["artist"] != "Band" || got[0]["state"] != "playing" || len(got[0]["actions"].([]any)) != 3 {
		t.Errorf("sent %v", got[0])
	}
	say(1, 1, song) // unchanged
	say(7, 1, song) // another origin's frame
	say(1, 0, goMediaSessionOut{State: "paused"})
	moved := song
	moved.Position = &goMediaPosition{Duration: 10, Rate: 1, Position: 3.5}
	say(1, 1, moved) // its position alone, at once: later
	if n := len(sent()); n != 1 || b.mediaSess.later == nil {
		t.Fatalf("sent %d (its position, at once; again unchanged; another's), later %v", n, b.mediaSess.later)
	}
	paused := moved
	paused.State = "paused"
	say(1, 1, paused) // more than its position: at once, the one waiting with it
	if got := sent(); len(got) != 2 || got[1]["state"] != "paused" || got[1]["position"].(map[string]any)["position"] != 3.5 || b.mediaSess.later != nil {
		t.Fatalf("sent %v", got)
	}
	// A position that isn't one: none.
	bad := paused
	bad.Position = &goMediaPosition{Duration: 5, Rate: 1, Position: 6}
	if c := goMediaSessionClean(bad); c.Position != nil {
		t.Errorf("a position past its end kept")
	}
	bad.Position = &goMediaPosition{Duration: math.NaN(), Rate: 1}
	if c := goMediaSessionClean(bad); c.Position != nil {
		t.Errorf("a NaN duration kept")
	}
	if c := goMediaSessionClean(goMediaSessionOut{Position: &goMediaPosition{Duration: -1, Rate: 2, Position: 40}}); c.Position == nil || c.State != "none" {
		t.Errorf("a live stream's position: %+v", c)
	}

	// Pressed: the page's handler called, as its input; one it hasn't, not.
	before := b.acts.waiting()
	b.inputAt = time.Time{}
	b.mediaAction(goClientMsg{Kind: "nexttrack"})
	b.mediaAction(goClientMsg{Kind: "seekto", DX: 2})
	if b.acts.waiting() != before+1 || !b.recentInput(1, 1) {
		t.Errorf("%d called (want 1: seekto isn't the page's), input %v", b.acts.waiting()-before, b.recentInput(1, 1))
	}

	b.mediaSessionAgain()
	if got := sent(); len(got) != 3 || got[2]["state"] != "paused" {
		t.Errorf("not said again: %v", got)
	}
	b.mediaSessionGone()
	b.mediaSessionGone()
	b.mediaSessionAgain()
	if got := sent(); len(got) != 4 || got[3]["metadata"] != nil || got[3]["state"] != "none" || len(got[3]["actions"].([]any)) != 0 {
		t.Errorf("cleared as %v", got)
	}
	b.mediaAction(goClientMsg{Kind: "pause"})
	if b.acts.waiting() != before+1 {
		t.Errorf("pressed for a page gone")
	}
}
