package main

import "testing"

// TestGoBadge: the page's badge (a count, a mark, 0 clearing it) passed on
// once each change; another origin's frame's, or an old page's, not; gone
// with the page; shown again to a viewer connecting again.
func TestGoBadge(t *testing.T) {
	b, w := goClipTab()
	n := func(v float64) *float64 { return &v }
	set := func(world, gen int, a goBadgeAsk) { b.clipboard(gen, world, goClipboardOut{Badge: &a}) }
	sent := func() []any {
		var out []any
		for _, m := range goSentOf(w, "go-badge") {
			out = append(out, m["count"])
		}
		return out
	}
	set(1, 1, goBadgeAsk{Count: n(3)})
	set(1, 1, goBadgeAsk{Count: n(3)})   // (the same: not again)
	set(7, 1, goBadgeAsk{Count: n(9)})   // another origin's frame
	set(1, 0, goBadgeAsk{Count: n(9)})   // an old page
	set(1, 1, goBadgeAsk{Flag: true})    // a mark
	set(1, 1, goBadgeAsk{Count: n(2e9)}) // cut to goBadgeMax
	set(1, 1, goBadgeAsk{Count: n(0)})   // cleared
	if got := sent(); len(got) != 4 || got[0] != float64(3) || got[1] != float64(goBadgeMark) || got[2] != float64(goBadgeMax) || got[3] != float64(0) {
		t.Fatalf("sent %v", got)
	}
	b.badgeGone()
	if len(sent()) != 4 {
		t.Errorf("a badge cleared again as its page went")
	}
	set(1, 1, goBadgeAsk{Count: n(5)})
	b.badgeAgain()
	b.badgeGone()
	b.badgeAgain()
	if got := sent(); len(got) != 7 || got[4] != float64(5) || got[5] != float64(5) || got[6] != float64(0) {
		t.Errorf("sent %v: shown again, gone with the page, not again once gone", got)
	}
}
