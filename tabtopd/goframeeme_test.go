package main

import (
	"encoding/json"
	"testing"
)

// TestGoFrameEME: an embedded page's EME requests are passed on marked with
// its world, if it's a secure frame of another origin in a secure page;
// answers given to that world only, while it's the frame's; a frame gone
// tells the person's browser its keys and sessions go.
func TestGoFrameEME(t *testing.T) {
	b, w := goClipTab()
	b.docURL = "https://www.example.com/page"
	b.shown = 1
	b.children = map[string]*goChild{
		"f": {id: "f", world: 7, url: "https://player.example/embed", parentWorld: 1},
		"s": {id: "s", world: 0, same: true, url: "https://www.example.com/same"},
		"h": {id: "h", world: 9, url: "http://insecure.example/embed", parentWorld: 1},
	}
	req := `{"eme":[{"request":5,"op":"access","system":"org.w3.clearkey","configs":[{}],"node":0}]}`
	b.frameStreamsGot(1, 7, req)
	b.frameStreamsGot(1, 9, req) // an insecure frame's: dropped
	b.frameStreamsGot(1, 3, req) // no frame's: dropped
	got := goSentOf(w, "go-eme")
	if len(got) != 1 || got[0]["doc"] != float64(7) {
		t.Fatalf("passed on %v", got)
	}
	if _, ok := b.streamWorlds[7]; !ok {
		t.Errorf("the frame not asked often after its EME")
	}
	// The page insecure: none.
	b.docURL = "http://www.example.com/page"
	b.frameStreamsGot(1, 7, req)
	if len(goSentOf(w, "go-eme")) != 1 {
		t.Errorf("a frame's EME passed on in an insecure page")
	}
	b.docURL = "https://www.example.com/page"
	// Answers: to its world, not to one that isn't a frame's.
	b.act(goClientMsg{Op: "event", Kind: "eme-reply", Gen: 1, FDoc: 7, Value: `{"request":5,"value":1}`})
	if b.acts.waiting() != 1 {
		t.Errorf("the frame's answer not given it (%d queued)", b.acts.waiting())
	}
	b.act(goClientMsg{Op: "event", Kind: "eme-reply", Gen: 1, FDoc: 9, Value: `{}`})
	b.act(goClientMsg{Op: "event", Kind: "eme-reply", Gen: 1, FDoc: 4, Value: `{}`})
	if b.acts.waiting() != 1 {
		t.Errorf("an answer given to a world that isn't a secure frame's")
	}
	b.emeGone(7)
	if gone := goSentOf(w, "go-eme-gone"); len(gone) != 1 || gone[0]["doc"] != float64(7) {
		t.Errorf("gone told as %v", gone)
	}
	var cmds []json.RawMessage
	json.Unmarshal(mustJSON(got[0]["eme"]), &cmds)
	if len(cmds) != 1 {
		t.Errorf("requests %s", mustJSON(got[0]["eme"]))
	}
}

// TestGoFramePlays: an embedded page's players started or stopped by it are
// passed on marked with its world; ill-formed ones not.
func TestGoFramePlays(t *testing.T) {
	b, w := goClipTab()
	b.shown = 1
	b.frameStreamsGot(1, 7, `{"plays":[{"o":"m","i":12,"v":"true"},{"o":"m","i":13,"v":"false"},{"o":"x","i":14,"v":"true"},{"o":"m","i":0,"v":"true"}]}`)
	b.frameStreamsGot(2, 7, `{"plays":[{"o":"m","i":12,"v":"true"}]}`) // another page's: none
	got := goSentOf(w, "go-frame-plays")
	if len(got) != 1 || got[0]["doc"] != float64(7) {
		t.Fatalf("passed on %v", got)
	}
	plays, _ := got[0]["plays"].([]any)
	if len(plays) != 2 || plays[0].(map[string]any)["v"] != true || plays[1].(map[string]any)["v"] != false {
		t.Errorf("plays %v", plays)
	}
}

func mustJSON(v any) []byte {
	p, _ := json.Marshal(v)
	return p
}
