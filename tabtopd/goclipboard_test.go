package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// goClipTab is a tab showing gen 1, its page's agent in world 1 and an
// embedded page of another origin (ads.example) in world 7, its messages
// to the person's browser kept.
func goClipTab() (*goBrowser, *goWrites) {
	w := &goWrites{}
	conn := &goConn{cur: newGoLink(w, false)}
	b := &goBrowser{t: conn, conn: conn, gen: 1, shown: 1, world: 1, frame: "main", docURL: "https://www.example.com/page", acts: newGoQueue()}
	b.children = map[string]*goChild{"f": {id: "f", parent: "main", owner: 9, world: 7, url: "https://ads.example/x", parentWorld: 1}}
	return b, w
}

func goSentOf(w *goWrites, typ string) []map[string]any {
	var out []map[string]any
	for _, raw := range w.msg {
		var m map[string]any
		if json.Unmarshal(raw, &m) == nil && m["type"] == typ {
			out = append(out, m)
		}
	}
	return out
}

// TestGoClipboardAfterInput: what the page copies is passed on only soon
// after the person's input in the same page; an embedded page of another
// origin's, only after input in it (the page's own, after any in the tab).
func TestGoClipboardAfterInput(t *testing.T) {
	text := "copied"
	for _, c := range []struct {
		name               string
		inputWorld, asking int
		ago                time.Duration
		inputGen           int
		want               bool
	}{
		{"the page, after its input", 1, 1, time.Second, 1, true},
		{"the page, after input in its frame", 7, 1, time.Second, 1, true},
		{"a frame, after its own input", 7, 7, time.Second, 1, true},
		{"a frame, after the page's input", 1, 7, time.Second, 1, false},
		{"long after", 1, 1, goChooserAfterInput + time.Second, 1, false},
		{"input on the page before", 1, 1, time.Second, 0, false},
	} {
		b, w := goClipTab()
		b.inputAt, b.inputGen, b.inputWorld = time.Now().Add(-c.ago), c.inputGen, c.inputWorld
		b.clipboard(1, c.asking, goClipboardOut{Copy: &text})
		got := goSentOf(w, "go-copy")
		if (len(got) == 1) != c.want {
			t.Errorf("%s: passed on %d times, want %v", c.name, len(got), c.want)
		}
		if len(got) == 1 && got[0]["text"] != text {
			t.Errorf("%s: passed on %v", c.name, got[0]["text"])
		}
	}
}

// TestGoClipboardCopyCut: a copy past goCopyMax is cut, at a character's
// start, not passed on as the page made it.
func TestGoClipboardCopyCut(t *testing.T) {
	b, w := goClipTab()
	b.inputAt, b.inputGen, b.inputWorld = time.Now(), 1, 1
	text := strings.Repeat("é", goCopyMax) // two bytes each
	b.clipboard(1, 1, goClipboardOut{Copy: &text})
	got := goSentOf(w, "go-copy")
	if len(got) != 1 {
		t.Fatalf("passed on %d times", len(got))
	}
	s := got[0]["text"].(string)
	if len(s) > goCopyMax || len(s)%2 != 0 || !strings.HasPrefix(text, s) {
		t.Errorf("cut to %d bytes", len(s))
	}
	if goCut("aé", 2) != "a" {
		t.Errorf("goCut cut within a character: %q", goCut("aé", 2))
	}
}

// TestGoPasteAsk: a read is asked of the person, named for the page that
// asked (an embedded page's, within the page's); answered with what they
// allowed; refused when not after input, or past the asks at once.
func TestGoPasteAsk(t *testing.T) {
	b, w := goClipTab()
	b.inputAt, b.inputGen, b.inputWorld = time.Now(), 1, 7
	b.clipboard(1, 7, goClipboardOut{PasteAsks: []string{"abc"}})
	asks := goSentOf(w, "go-paste-ask")
	if len(asks) != 1 || asks[0]["site"] != "ads.example" || asks[0]["within"] != "example.com" {
		t.Fatalf("asked %v", asks)
	}
	token := asks[0]["ask"].(string)
	b.paste(goClientMsg{Text: token, Accept: true, Value: "for the page"})
	if len(b.pasteAsks.m) != 0 || b.acts.waiting() != 1 {
		t.Errorf("answered: %d asks kept, %d calls queued", len(b.pasteAsks.m), b.acts.waiting())
	}
	// An answer to an ask that isn't there: nothing.
	b.paste(goClientMsg{Text: token, Accept: true, Value: "again"})
	if b.acts.waiting() != 1 {
		t.Errorf("an answer for no ask was given to the page")
	}
	// Not after the frame's own input: refused (the page told), not asked.
	b2, w2 := goClipTab()
	b2.inputAt, b2.inputGen, b2.inputWorld = time.Now(), 1, 1
	b2.clipboard(1, 7, goClipboardOut{PasteAsks: []string{"abc"}})
	if len(goSentOf(w2, "go-paste-ask")) != 0 || b2.acts.waiting() != 1 {
		t.Errorf("a frame's read after the page's input: asked, or not refused")
	}
	// Past goPasteAsks at once: the rest refused.
	b3, w3 := goClipTab()
	b3.inputAt, b3.inputGen, b3.inputWorld = time.Now(), 1, 1
	b3.clipboard(1, 1, goClipboardOut{PasteAsks: []string{"a1", "a2", "a3", "a4", "a5", "a6"}})
	if n := len(goSentOf(w3, "go-paste-ask")); n != goPasteAsks || b3.acts.waiting() != 6-goPasteAsks {
		t.Errorf("asked %d, refused %d", n, b3.acts.waiting())
	}
	// A page's id that isn't one: neither.
	b4, w4 := goClipTab()
	b4.inputAt, b4.inputGen, b4.inputWorld = time.Now(), 1, 1
	b4.clipboard(1, 1, goClipboardOut{PasteAsks: []string{`x");alert(1);("`}})
	if len(goSentOf(w4, "go-paste-ask")) != 0 || b4.acts.waiting() != 0 {
		t.Errorf("a malformed id was asked or answered")
	}
}

// TestGoFullscreenAsks: allowed after the person's input, an embedded
// page's laying its iframe over the page's window; refused otherwise; let
// go by the page, the person's browser told; gone with the page.
func TestGoFullscreenAsks(t *testing.T) {
	b, w := goClipTab()
	b.inputAt, b.inputGen, b.inputWorld = time.Now(), 1, 7
	b.clipboard(1, 7, goClipboardOut{Fullscreen: []goFullscreenAsk{{On: true, ID: "f1"}}})
	if b.fullscreen == nil || len(b.fullscreen.hosts) != 1 || b.fullscreen.hosts[0] != (goFullscreenHost{world: 1, owner: 9}) {
		t.Fatalf("allowed as %+v", b.fullscreen)
	}
	if on := goSentOf(w, "go-fullscreen"); len(on) != 1 || on[0]["on"] != true {
		t.Fatalf("told %v", on)
	}
	b.clipboard(1, 7, goClipboardOut{Fullscreen: []goFullscreenAsk{{On: false}}})
	if b.fullscreen != nil || len(goSentOf(w, "go-fullscreen")) != 2 {
		t.Errorf("left by the page: still %+v", b.fullscreen)
	}
	// Not after input: refused.
	b2, w2 := goClipTab()
	b2.clipboard(1, 1, goClipboardOut{Fullscreen: []goFullscreenAsk{{On: true, ID: "f1"}}})
	if b2.fullscreen != nil || len(goSentOf(w2, "go-fullscreen")) != 0 || b2.acts.waiting() != 1 {
		t.Errorf("allowed with no input")
	}
	// The page left: gone, the person's browser told.
	b3, w3 := goClipTab()
	b3.inputAt, b3.inputGen, b3.inputWorld = time.Now(), 1, 1
	b3.clipboard(1, 1, goClipboardOut{Fullscreen: []goFullscreenAsk{{On: true, ID: "f1"}}})
	b3.fullscreenGone()
	if b3.fullscreen != nil || len(goSentOf(w3, "go-fullscreen")) != 2 {
		t.Errorf("not let go with its page")
	}
}

// TestGoStreamsFrom: a stream's commands are its first sender's: another
// document's for the same number are dropped (a frame can't feed the
// page's player); a new page starts afresh.
func TestGoStreamsFrom(t *testing.T) {
	b, _ := goClipTab()
	cmd := func(stream int) json.RawMessage {
		p, _ := json.Marshal(map[string]any{"stream": stream, "op": "append"})
		return p
	}
	if got := b.streamsFrom(1, 1, []json.RawMessage{cmd(5), cmd(6)}); len(got) != 2 {
		t.Fatalf("the page's own: %d kept", len(got))
	}
	if got := b.streamsFrom(1, 7, []json.RawMessage{cmd(5), cmd(8)}); len(got) != 1 || !strings.Contains(string(got[0]), `"stream":8`) {
		t.Errorf("a frame's for the page's stream kept: %s", got)
	}
	if got := b.streamsFrom(1, 1, []json.RawMessage{cmd(8), json.RawMessage(`{"op":"x"}`)}); len(got) != 0 {
		t.Errorf("the page's for the frame's stream, or one with no stream, kept: %s", got)
	}
	if got := b.streamsFrom(2, 7, []json.RawMessage{cmd(5)}); len(got) != 1 {
		t.Errorf("a new page's stream 5 dropped as the last page's")
	}
}
