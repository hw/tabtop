package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestGoFramesLargeGraftedFrameSent: another site's frame whose nested
// frames, grafted into it, make it more than a second's frame budget is
// still sent (once in a second, alone): it was never sent, and read again
// whole every second, for good.
func TestGoFramesLargeGraftedFrameSent(t *testing.T) {
	w := &goWrites{}
	conn := &goConn{cur: newGoLink(w, false)}
	b := &goBrowser{t: conn, conn: conn, gen: 1, frame: "main"}
	text := func(id int) *goNode { return &goNode{ID: id, Type: 3, Value: strings.Repeat("x", 1500<<10)} }
	doc := func(n *goNode) []byte {
		p, _ := json.Marshal(map[string]any{"doc": n, "base": "https://ads.example/"})
		return p
	}
	outer := &goNode{ID: 1, Type: 9, Kids: []*goNode{{ID: 2, Type: 1, Name: "iframe"}, {ID: 3, Type: 1, Name: "iframe"}, text(4)}}
	reads := []goFrameRead{
		{id: "outer", parent: "main", url: "https://ads.example/", owner: 10, world: 5, doc: doc(outer)},
		{id: "a", parent: "outer", url: "https://a.example/", owner: 2, world: 6, doc: doc(&goNode{ID: 1, Type: 9, Kids: []*goNode{text(2)}})},
		{id: "b", parent: "outer", url: "https://b.example/", owner: 3, world: 7, doc: doc(&goNode{ID: 1, Type: 9, Kids: []*goNode{text(2)}})},
	}
	b.framesRead(reads)
	sent := 0
	for _, m := range w.msg {
		if strings.Contains(string(m), `"go-changes"`) && strings.Contains(string(m), `"i":10`) {
			sent++
		}
	}
	if sent == 0 {
		t.Fatalf("the outer frame (with its nested frames) never sent: %d messages", len(w.msg))
	}
}
