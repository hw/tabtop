package main

import (
	"math"
	"testing"
)

// The engine's window is made the frame's size, within sensible bounds;
// its display the person's window, at least the frame's size.
func TestGoViewClamped(t *testing.T) {
	v := func(w, h int, dpr float64, sw, sh int) goView { return goView{W: w, H: h, DPR: dpr, SW: sw, SH: sh} }
	for _, c := range []struct{ in, want goView }{
		{v(400, 800, 2, 400, 900), v(400, 800, 2, 400, 900)},
		{v(0, 0, 0, 0, 0), v(160, 160, 1, 160, 160)},
		{v(100000, 100000, 10, 100000, 100000), v(7680, 4320, 4, 7680, 4320)},
		{v(1280, 720, math.NaN(), 1280, 800), v(1280, 720, 1, 1280, 800)},
		{v(-5, 300, -1, 0, 0), v(160, 300, 1, 160, 300)},        // no display said: the window's
		{v(1280, 720, 1, 640, 360), v(1280, 720, 1, 1280, 720)}, // smaller than the window
		{goView{W: 400, H: 800, DPR: 2, Touch: true}, goView{W: 400, H: 800, DPR: 2, SW: 400, SH: 800, Touch: true}},
	} {
		if got := c.in.clamped(); got != c.want {
			t.Errorf("%+v: %+v, want %+v", c.in, got, c.want)
		}
	}
}

// A page's observed elements go to the client's real IntersectionObserver
// only well formed: its options are the page's.
func TestGoCleanIO(t *testing.T) {
	in := []goIO{
		{Op: "+", O: 1, I: 2, M: "0px 0px 0px 0px", T: []float64{0}},
		{Op: "+", O: 1, I: 3, M: "10% -5px 0px 1.5px", T: []float64{0, 0.5, 1}, R: 4},
		{Op: "-", O: 1, I: 2, M: "ignored", T: []float64{9}},
		{Op: "+", O: 1, I: 5, M: "url(x)", T: []float64{0}},              // not a margin
		{Op: "+", O: 1, I: 6, M: "0px", T: []float64{1.5}},               // over 1
		{Op: "+", O: 1, I: 7, M: "0px", T: nil},                          // none
		{Op: "+", O: 0, I: 8, M: "0px", T: []float64{0}},                 // no observer
		{Op: "+", O: 1, I: 9, M: "0px 0px 0px 0px 0px", T: []float64{0}}, // five
		{Op: "?", O: 1, I: 10},
	}
	got := goCleanIO(in)
	if len(got) != 3 || got[0].I != 2 || got[1].I != 3 || got[1].R != 4 || got[2].Op != "-" || got[2].M != "" || got[2].T != nil {
		t.Fatalf("kept %+v", got)
	}
	many := make([]goIO, maxGoIO+10)
	for i := range many {
		many[i] = goIO{Op: "-", O: 1, I: i + 1}
	}
	if n := len(goCleanIO(many)); n != maxGoIO {
		t.Errorf("kept %d of too many", n)
	}
}

// Rectangles from the client are four numbers within reason, or none.
func TestGoRect(t *testing.T) {
	for _, c := range []struct {
		in []float64
		ok bool
	}{
		{[]float64{0, 10, 200, 100.5}, true},
		{[]float64{-50, -20, 0, 0}, true},
		{[]float64{1, 2, 3}, false},
		{[]float64{1, 2, 3, 4, 5}, false},
		{[]float64{0, 0, math.Inf(1), 1}, false},
		{[]float64{0, 0, math.NaN(), 1}, false},
		{[]float64{0, 0, 2e6, 1}, false},
		{nil, false},
	} {
		if got := goRect(c.in) != nil; got != c.ok {
			t.Errorf("%v: kept %v", c.in, got)
		}
	}
}
