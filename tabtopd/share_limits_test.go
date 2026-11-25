package main

import (
	"errors"
	"strings"
	"testing"
	"time"
)

// TestShareLimits: what a link can't have is refused the same way, made,
// changed, or changed with others, by the store itself.
func TestShareLimits(t *testing.T) {
	ok := shareSpec{Life: time.Hour, Max: 3, Label: "  notes "}
	if err := ok.check(); err != nil || ok.Label != "notes" {
		t.Fatalf("a link it can have: %v, %q", err, ok.Label)
	}
	for name, spec := range map[string]shareSpec{
		"too short":            {Life: time.Second},
		"too long":             {Life: maxShareLife + time.Hour},
		"kept, made":           {Life: 0},
		"too many":             {Life: time.Hour, Max: maxShareCount + 1},
		"a download's bytes":   {Life: time.Hour, MaxBytes: 10},
		"an upload's no limit": {Life: time.Hour, Upload: true},
	} {
		if err := spec.check(); !errors.Is(err, errShareLimits) {
			t.Errorf("%s: %v", name, err)
		}
	}
	long := shareSpec{Life: time.Hour, Label: strings.Repeat("x", maxLabel+1)}
	if err := long.check(); !errors.Is(err, errShareLabel) {
		t.Errorf("a long label: %v", err)
	}
	s := newShareStore("", lifecycleClock{})
	if _, err := s.change("h", time.Second, 0, 0, ""); !errors.Is(err, errShareLimits) {
		t.Errorf("changed to a second: %v", err)
	}
	if _, err := s.change("h", 0, -1, 0, ""); !errors.Is(err, errShareLimits) {
		t.Errorf("changed to -1: %v", err)
	}
	if _, err := s.changeMany([]string{"h"}, 0, "a\nb", true); !errors.Is(err, errShareLabel) {
		t.Errorf("relabelled over two lines: %v", err)
	}
}
