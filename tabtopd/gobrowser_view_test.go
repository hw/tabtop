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
		got := c.in.clamped()
		got.Orientation, got.Angle = "", 0 // below
		if got != c.want {
			t.Errorf("%+v: %+v, want %+v", c.in, got, c.want)
		}
	}
}

// Which way up: one of screen.orientation's types and a quarter turn, or
// the screen's shape.
func TestGoViewOrientation(t *testing.T) {
	for _, c := range []struct {
		sw, sh int
		o      string
		a      int
		wantO  string
		wantA  int
	}{
		{390, 844, "portrait-primary", 0, "portrait-primary", 0},
		{844, 390, "landscape-primary", 90, "landscape-primary", 90},
		{844, 390, "landscape-secondary", 270, "landscape-secondary", 270},
		{390, 844, "portrait-secondary", 180, "portrait-secondary", 180},
		{844, 390, "", 0, "landscape-primary", 90},        // not said: its shape
		{390, 844, "sideways", 45, "portrait-primary", 0}, // nonsense
		{844, 390, "landscape-primary", 45, "landscape-primary", 0},
		{844, 390, "landscape-primary", -90, "landscape-primary", 0},
		{844, 390, "landscape-primary", 360, "landscape-primary", 0},
	} {
		got := goView{W: c.sw, H: c.sh, DPR: 2, SW: c.sw, SH: c.sh, Orientation: c.o, Angle: c.a}.clamped()
		if got.Orientation != c.wantO || got.Angle != c.wantA {
			t.Errorf("%dx%d %q %d: %q %d, want %q %d", c.sw, c.sh, c.o, c.a, got.Orientation, got.Angle, c.wantO, c.wantA)
		}
		if _, ok := goOrientations[got.Orientation]; !ok {
			t.Errorf("%q has no CDP name", got.Orientation)
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
		{Op: "+", O: 2, I: 11, S: "border-box", M: "ignored", T: []float64{9}, R: 3}, // a ResizeObserver's
		{Op: "+", O: 2, I: 12, S: "margin-box"},                                      // no such box
	}
	got := goCleanIO(in)
	if len(got) != 4 || got[0].I != 2 || got[1].I != 3 || got[1].R != 4 || got[2].Op != "-" || got[2].M != "" || got[2].T != nil {
		t.Fatalf("kept %+v", got)
	}
	if r := got[3]; r.I != 11 || r.S != "border-box" || r.M != "" || r.T != nil || r.R != 0 {
		t.Errorf("a ResizeObserver's kept as %+v", r)
	}
	many := make([]goIO, maxGoIO+10)
	for i := range many {
		many[i] = goIO{Op: "-", O: 1, I: i + 1}
	}
	if n := len(goCleanIO(many)); n != maxGoIO {
		t.Errorf("kept %d of too many", n)
	}
}

// Where the page scrolled is passed on only well formed: it's the page's.
func TestGoCleanScrolls(t *testing.T) {
	got := goCleanScrolls([]goScroll{
		{I: 1, X: 0, Y: 646},
		{I: 2, Into: [2]string{"start", "nearest"}},
		{I: 3, Into: [2]string{"start", "url(x)"}}, // not a place
		{I: 0, Y: 10},                              // no element
		{I: 4, Y: -1},                              // before the start
		{I: 5, Y: 2e7},                             // beyond reason
		{I: 6, X: math.NaN()},
	})
	if len(got) != 2 || got[0]["y"] != 646.0 || got[1]["into"] != [2]string{"start", "nearest"} {
		t.Fatalf("kept %v", got)
	}
	many := make([]goScroll, 100)
	for i := range many {
		many[i] = goScroll{I: i + 1}
	}
	if n := len(goCleanScrolls(many)); n != 64 {
		t.Errorf("kept %d of too many", n)
	}
}

// Sizes from the client are eight numbers within reason, or none.
func TestGoSizes(t *testing.T) {
	ok := []float64{400, 670, 400, 6500, 400, 670, 400, 670}
	if goSizes(ok) == nil {
		t.Error("refused sizes within reason")
	}
	for _, z := range [][]float64{nil, ok[:7], {400, 670, 400, 6500, 400, 670, 400, -1}, {400, 670, 400, 6500, 400, 670, 400, 2e6}} {
		if goSizes(z) != nil {
			t.Errorf("kept %v", z)
		}
	}
	if goSizes([]float64{0, 0, 0, 0, 0, 0, 0, math.NaN()}) != nil {
		t.Error("kept NaN")
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
