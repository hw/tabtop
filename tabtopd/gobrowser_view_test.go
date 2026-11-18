package main

import (
	"math"
	"testing"
)

// The engine's window is made the frame's size, within sensible bounds.
func TestGoViewClamped(t *testing.T) {
	for _, c := range []struct{ in, want goView }{
		{goView{400, 800, 2}, goView{400, 800, 2}},
		{goView{0, 0, 0}, goView{160, 160, 1}},
		{goView{100000, 100000, 10}, goView{7680, 4320, 4}},
		{goView{1280, 720, math.NaN()}, goView{1280, 720, 1}},
		{goView{-5, 300, -1}, goView{160, 300, 1}},
	} {
		if got := c.in.clamped(); got != c.want {
			t.Errorf("%+v: %+v, want %+v", c.in, got, c.want)
		}
	}
}
