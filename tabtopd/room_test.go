package main

import (
	"math"
	"os"
	"testing"
)

// TestRoom: what fits on a filesystem, said the same way whether resumable
// uploads are cleared for it or not.
func TestRoom(t *testing.T) {
	g, _ := newE2EServer(t)
	f, err := os.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	files := g.defaultFiles()
	for _, reclaim := range []bool{false, true} {
		if free, enough := files.room(f, 1, reclaim); !enough || free < 1 {
			t.Errorf("reclaim %v: a byte doesn't fit (%d free)", reclaim, free)
		}
		if free, enough := files.room(f, math.MaxInt64, reclaim); enough {
			t.Errorf("reclaim %v: more than any disk fits (%d free)", reclaim, free)
		}
	}
}
