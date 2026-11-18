package main

import (
	"math"
	"testing"
)

// The person's modifier keys, buttons and numbers become CDP's, within
// bounds whatever the client sends.
func TestGoInputValues(t *testing.T) {
	if m := goModifiers(goClientMsg{Alt: true, Ctrl: true, Meta: true, Shift: true}); m != 15 {
		t.Errorf("all modifiers: %d", m)
	}
	if m := goModifiers(goClientMsg{Shift: true}); m != 8 {
		t.Errorf("shift: %d", m)
	}
	for b, want := range map[int]string{0: "left", 1: "middle", 2: "right", 3: "none", -1: "none"} {
		if got := goButton(b); got != want {
			t.Errorf("button %d: %s", b, got)
		}
	}
	for _, c := range []struct{ v, lo, hi, want float64 }{
		{0.5, 0, 1, 0.5}, {-3, 0, 1, 0}, {7, 0, 1, 1}, {math.NaN(), 0, 1, 0}, {math.Inf(1), -10, 10, 10}, {math.Inf(-1), -10, 10, -10},
	} {
		if got := goClamp(c.v, c.lo, c.hi); got != c.want {
			t.Errorf("clamp %v to [%v, %v]: %v", c.v, c.lo, c.hi, got)
		}
	}
}
