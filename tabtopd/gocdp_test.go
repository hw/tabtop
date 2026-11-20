package main

import "testing"

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
