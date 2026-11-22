package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

// TestGoEMEAgain: a batch of changes let go (too large, a batch missed
// before it, nodes of another world) still sends its EME requests (taken
// from the page's queue as it was made: asked once), on an https page.
func TestGoEMEAgain(t *testing.T) {
	big := `{"seq":9,"ops":["` + strings.Repeat("x", goChangesLimit) + `"],"eme":[{"request":1,"op":"access"},{"request":2,"op":"keys"}]}`
	eme := goEMEOf(big)
	if len(eme) != 2 {
		t.Fatalf("a batch too large: %d EME requests read from it, want 2", len(eme))
	}
	w := &goWrites{}
	conn := &goConn{cur: newGoLink(w, false)}
	b := &goBrowser{t: conn, conn: conn, gen: 3, docURL: "https://drm.example/watch"}
	b.emeAgain(3, eme)
	if len(w.msg) != 1 || !bytes.Contains(w.msg[0], []byte(`"go-eme"`)) || !bytes.Contains(w.msg[0], []byte(`"request":2`)) {
		t.Fatalf("not sent: %q", w.msg)
	}
	var m struct {
		Type string            `json:"type"`
		Gen  int               `json:"gen"`
		EME  []json.RawMessage `json:"eme"`
	}
	if json.Unmarshal(w.msg[0], &m) != nil || m.Gen != 3 || len(m.EME) != 2 {
		t.Errorf("sent as %s", w.msg[0])
	}
	// Not on a plain http page (nor more than a batch has).
	b.docURL = "http://drm.example/watch"
	b.emeAgain(3, eme)
	b.docURL = "https://drm.example/watch"
	b.emeAgain(3, append(eme, eme[0], eme[1], eme[0]))
	if len(w.msg) != 1 {
		t.Errorf("sent where it shouldn't be: %d messages", len(w.msg))
	}
}
