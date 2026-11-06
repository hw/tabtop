package main

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestIsolatedChildOutputLimit(t *testing.T) {
	const input = "hello\n"
	const want = "<p>hello</p>\n"
	for _, limit := range []int{0, len(want) - 1, len(want), len(want) + 1} {
		result := runIsolatedChild(isolatedChild{
			Args: []string{markdownChildArg}, Input: strings.NewReader(input),
			Timeout: 10 * time.Second, OutputLimit: limit,
		})
		if result.TimedOut {
			t.Fatalf("limit %d: child timed out", limit)
		}
		if len(result.Output) > limit {
			t.Errorf("limit %d: retained %d bytes", limit, len(result.Output))
		}
		if limit < len(want) {
			if !result.Overflow || !errors.Is(result.Err, errChildOutputLimit) {
				t.Errorf("limit %d: overflow=%v, error=%v", limit, result.Overflow, result.Err)
			}
		} else if result.Overflow || result.Err != nil || string(result.Output) != want {
			t.Errorf("limit %d: output=%q, overflow=%v, error=%v", limit, result.Output, result.Overflow, result.Err)
		}
	}
}
