package main

import (
	"context"
	"testing"
	"time"
)

// A request waiting for a busy slot stops waiting once it's given up on,
// rather than for the whole wait.
func TestPreviewWorkGivenUpWhileWaiting(t *testing.T) {
	work := newPreviewWork(1)
	release, ok := work.acquire()
	if !ok {
		t.Fatal("no slot")
	}
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(50*time.Millisecond, cancel)
	start := time.Now()
	if _, ok := work.acquireContext(ctx); ok {
		t.Fatal("got a busy slot")
	}
	if d := time.Since(start); d > time.Second {
		t.Fatalf("waited %v after being given up on", d)
	}
	release()
	if r, ok := work.acquireContext(context.Background()); !ok {
		t.Fatal("a free slot not given")
	} else {
		r()
	}
}
