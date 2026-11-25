package main

import (
	"os"
	"testing"
	"time"
)

// waitBudget is how long a test waits at most for what it expects to
// happen: generous, as a loaded machine (CI, -race) is slow, and only a
// failing test waits it out. TABTOP_TEST_WAIT (a duration) changes it.
var waitBudget = func() time.Duration {
	if d, err := time.ParseDuration(os.Getenv("TABTOP_TEST_WAIT")); err == nil && d > 0 {
		return d
	}
	return 10 * time.Second
}()

// waitUntil waits for cond to hold, failing the test with what it waited
// for if it doesn't within waitBudget.
func waitUntil(t testing.TB, what string, cond func() bool) {
	t.Helper()
	for deadline := time.Now().Add(waitBudget); !cond(); time.Sleep(5 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
	}
}
