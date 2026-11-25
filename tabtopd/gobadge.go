package main

// The page's app badge (gobadge.js): the latest count it set, or its mark
// (set with no count), shown by the person's browser (go.js, go-badge) on
// the tab's title and, where it's an installed app, its own badge. The top
// page's only (a frame of its origin sets the page's; another origin's,
// nothing); gone with the page (leftPage), shown again to the next that
// connects (connBack).

// goBadgeAsk is what the page last set: Count (0 clears it), or Flag.
type goBadgeAsk struct {
	Count *float64 `json:"count"`
	Flag  bool     `json:"flag"`
}

// goBadgeMark is the badge as a mark (no count); 0 is none.
const goBadgeMark = -1

// goBadgeMax is the largest count passed on (the person's browser shows
// 99+ past 99 anyway).
const goBadgeMax = 1_000_000

// badge passes on the badge the page in world (of gen) set.
func (b *goBrowser) badge(gen, world int, a goBadgeAsk) {
	if world != b.world || gen != b.gen {
		return
	}
	v := 0
	switch {
	case a.Flag:
		v = goBadgeMark
	case a.Count != nil && *a.Count >= 1:
		v = int(min(*a.Count, goBadgeMax))
	}
	if v == b.badgeShown {
		return
	}
	b.badgeShown = v
	b.sendBadge()
}

func (b *goBrowser) sendBadge() {
	b.send(map[string]any{"type": "go-badge", "gen": b.gen, "count": b.badgeShown})
}

// badgeGone clears the badge of the page left.
func (b *goBrowser) badgeGone() {
	if b.badgeShown != 0 {
		b.badgeShown = 0
		b.sendBadge()
	}
}

// badgeAgain shows the badge to a viewer connecting again.
func (b *goBrowser) badgeAgain() {
	if b.badgeShown != 0 {
		b.sendBadge()
	}
}
