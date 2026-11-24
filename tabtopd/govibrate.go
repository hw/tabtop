package main

// The page's vibration (govibrate.js): navigator.vibrate's pattern, felt on
// the person's device (go.js, go-vibrate) if it followed their own input in
// the page (recentInput, as its clipboard and notifications are asked),
// not more often than goVibrateEvery, and at most goVibrateTotal in all. A
// cancel (0, []) always passes. Another origin's frame's isn't felt, as in
// Chrome.

import "time"

const (
	goVibrateEntries = 99     // entries of a pattern, as Chrome's
	goVibrateEntry   = 10_000 // ms an entry, as Chrome's
	goVibrateTotal   = 10_000 // ms a pattern, all its entries
	goVibrateEvery   = 250 * time.Millisecond
)

// goVibratePattern is the pattern as it's to be felt: so many entries, each
// and all within reason, with no pause at its end (nothing to wait for);
// nil if there's nothing to feel (a cancel).
func goVibratePattern(raw []float64) []int {
	if len(raw) > goVibrateEntries {
		raw = raw[:goVibrateEntries]
	}
	out := make([]int, 0, len(raw))
	total, felt := 0, false
	for i, v := range raw {
		ms := 0
		if v > 0 {
			ms = int(min(v, goVibrateEntry))
		}
		if total+ms > goVibrateTotal {
			ms = goVibrateTotal - total
		}
		total += ms
		out = append(out, ms)
		if i%2 == 0 && ms > 0 {
			felt = true
		}
		if total >= goVibrateTotal {
			break
		}
	}
	if len(out)%2 == 0 && len(out) > 0 {
		out = out[:len(out)-1] // a pause at its end: nothing after it
	}
	if !felt {
		return nil
	}
	return out
}

// vibrate passes on the pattern the page in world last asked to be felt.
func (b *goBrowser) vibrate(gen, world int, raw []float64, recent bool) {
	pattern := goVibratePattern(raw)
	if pattern == nil {
		b.send(map[string]any{"type": "go-vibrate", "gen": gen, "pattern": []int{}})
		return
	}
	switch {
	case world != b.world:
		goDebugf("vibrate: another origin's frame's: not felt")
	case !recent:
		goDebugf("vibrate: not after the person's input: not felt")
	case time.Since(b.vibratedAt) < goVibrateEvery:
		goDebugf("vibrate: again within %v: not felt", goVibrateEvery)
	default:
		b.vibratedAt = time.Now()
		b.send(map[string]any{"type": "go-vibrate", "gen": gen, "pattern": pattern})
	}
}
