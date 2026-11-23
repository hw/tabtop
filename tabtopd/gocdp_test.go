package main

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

func TestCDPDocumentPauseReserve(t *testing.T) {
	c := &cdpConn{Events: make(chan cdpEvent, cdpEvents+cdpPauseReserve)}
	for seq := uint64(1); seq <= cdpEvents; seq++ {
		if !c.queueEvent(cdpEvent{Seq: seq, Method: "Network.requestWillBeSent"}) {
			t.Fatal("routine event rejected before its limit")
		}
	}
	if c.queueEvent(cdpEvent{Method: "Network.loadingFinished"}) {
		t.Fatal("routine event used the pause reserve")
	}
	for seq := uint64(cdpEvents + 1); seq <= cdpEvents+cdpPauseReserve; seq++ {
		if !c.queueEvent(cdpEvent{Seq: seq, Method: "Fetch.requestPaused"}) {
			t.Fatal("paused request rejected before its reserve filled")
		}
	}
	for want := uint64(1); want <= cdpEvents+cdpPauseReserve; want++ {
		if event := <-c.Events; event.Seq != want {
			t.Fatalf("event order: got %d, want %d", event.Seq, want)
		}
	}
}

// TestCDPRequestGone: a paused request canceled, or overtaken by another
// navigation, is gone (nothing to do); any other failure isn't.
func TestCDPRequestGone(t *testing.T) {
	for err, want := range map[error]bool{
		&cdpError{Code: -32000, Message: "RequestNotFound"}:                             true,
		&cdpError{Code: -32000, Message: "Renderer Document is no longer current"}:      true,
		&cdpError{Code: -32000, Message: "network load is no longer waiting"}:           true,
		fmt.Errorf("resuming: %w", &cdpError{Code: -32000, Message: "RequestNotFound"}): true,
		&cdpError{Code: -32000, Message: "Invalid InterceptionId"}:                      false,
		errors.New("context deadline exceeded"):                                         false,
	} {
		if got := cdpRequestGone(err); got != want {
			t.Errorf("%v: gone %v, want %v", err, got, want)
		}
	}
}

// TestCDPCallCanceledKeepsConnection: a call given up (its load replaced
// by another, say) before or as it's sent fails alone; the engine's
// connection, the tab's for everything else, goes on. (The WebSocket
// closes itself when a write's context ends, and the lock a write takes
// first is had or not at random once it has.)
func TestCDPCallCanceledKeepsConnection(t *testing.T) {
	c, _ := fakeCDP(t, func(string, int) bool { return false })
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	for i := 0; i < 32; i++ {
		if err := c.call(canceled, "", "Page.navigate", nil, nil); !errors.Is(err, context.Canceled) {
			t.Fatalf("call %d with its context canceled: %v", i, err)
		}
	}
	ctx, done := context.WithTimeout(context.Background(), 5*time.Second)
	defer done()
	if err := c.call(ctx, "", "Runtime.evaluate", nil, nil); err != nil {
		t.Fatalf("a call after those canceled: %v", err)
	}
}
