package main

import (
	"reflect"
	"testing"
	"time"
)

// TestGoVibratePattern: a pattern as it's felt: 99 entries at most, each
// 10 s at most and all 10 s, no pause at its end; nothing to feel, nil.
func TestGoVibratePattern(t *testing.T) {
	long := make([]float64, 150)
	for i := range long {
		long[i] = 10
	}
	for _, c := range []struct {
		raw  []float64
		want []int
	}{
		{[]float64{200}, []int{200}},
		{[]float64{100, 50, 100}, []int{100, 50, 100}},
		{[]float64{100, 50}, []int{100}},
		{[]float64{20000}, []int{10000}},
		{[]float64{6000, 1000, 6000}, []int{6000, 1000, 3000}},
		{[]float64{-5, 100, 100}, []int{0, 100, 100}},
		{[]float64{0}, nil},
		{[]float64{0, 100, 0}, nil},
		{[]float64{}, nil},
	} {
		if got := goVibratePattern(c.raw); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%v: %v, want %v", c.raw, got, c.want)
		}
	}
	if got := goVibratePattern(long); len(got) != 99 {
		t.Errorf("150 entries: %d", len(got))
	}
}

// TestGoVibrate: felt only after the person's input in the page, the
// page's own (not another origin's frame's), not again within
// goVibrateEvery; a cancel always.
func TestGoVibrate(t *testing.T) {
	b, w := goClipTab()
	felt := func() int { return len(goSentOf(w, "go-vibrate")) }
	b.clipboard(1, 1, goClipboardOut{Vibrate: []float64{200}})
	if felt() != 0 {
		t.Fatal("felt with no input")
	}
	b.inputAt, b.inputGen, b.inputWorld = time.Now(), 1, 1
	b.clipboard(1, 1, goClipboardOut{Vibrate: []float64{200, 100, 300}})
	sent := goSentOf(w, "go-vibrate")
	if len(sent) != 1 || !reflect.DeepEqual(sent[0]["pattern"], []any{200.0, 100.0, 300.0}) || sent[0]["gen"] != 1.0 {
		t.Fatalf("after input: %v", sent)
	}
	b.clipboard(1, 1, goClipboardOut{Vibrate: []float64{200}})
	if felt() != 1 {
		t.Error("felt again at once")
	}
	// A cancel passes, at once and unasked.
	b.clipboard(1, 1, goClipboardOut{Vibrate: []float64{0}})
	if sent := goSentOf(w, "go-vibrate"); len(sent) != 2 || len(sent[1]["pattern"].([]any)) != 0 {
		t.Errorf("cancel: %v", sent)
	}
	// Another origin's frame's (its world, 7), even after input there.
	b.vibratedAt = time.Time{}
	b.inputWorld = 7
	b.clipboard(1, 7, goClipboardOut{Vibrate: []float64{200}})
	if felt() != 2 {
		t.Error("another origin's frame's felt")
	}
	// Input long ago.
	b.inputWorld, b.inputAt = 1, time.Now().Add(-goChooserAfterInput-time.Second)
	b.clipboard(1, 1, goClipboardOut{Vibrate: []float64{200}})
	if felt() != 2 {
		t.Error("felt long after input")
	}
}
