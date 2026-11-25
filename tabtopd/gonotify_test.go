package main

import (
	"encoding/base64"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// goNotifyTab is goClipTab's tab, on a secure page, with the site
// settings kept in dir (none: "").
func goNotifyTestTab(t *testing.T, dir string) (*goBrowser, *goWrites) {
	b, w := goClipTab()
	b.docURL = "https://www.example.com/page"
	b.jobs = newGoQueue()
	file := ""
	if dir != "" {
		file = filepath.Join(dir, "sites.json")
	}
	b.sites = newGoSiteSettings(file)
	return b, w
}

// TestGoNotifyAsk: a permission asked for after the person's input is asked
// of them, named for the site; allowed, kept for the site (the page told
// granted); not after input, or by another origin's frame, not asked.
func TestGoNotifyAsk(t *testing.T) {
	dir := t.TempDir()
	b, w := goNotifyTestTab(t, dir)
	// Not after input: told it's still to ask, not asked.
	b.clipboard(1, 1, goClipboardOut{Notify: &goNotifyOut{Asks: []string{"a1"}}})
	if len(goSentOf(w, "go-notify-ask")) != 0 || b.acts.waiting() != 1 {
		t.Fatalf("asked with no input, or the page not answered")
	}
	b.inputAt, b.inputGen, b.inputWorld = time.Now(), 1, 1
	// Another origin's frame: nothing (it's denied in its own world).
	b.clipboard(1, 7, goClipboardOut{Notify: &goNotifyOut{Asks: []string{"a2"}}})
	if len(goSentOf(w, "go-notify-ask")) != 0 || b.acts.waiting() != 1 {
		t.Fatalf("a frame's ask asked, or answered")
	}
	b.clipboard(1, 1, goClipboardOut{Notify: &goNotifyOut{Asks: []string{"a3", "a4"}}})
	asks := goSentOf(w, "go-notify-ask")
	if len(asks) != 1 || asks[0]["site"] != "example.com" {
		t.Fatalf("asked %v", asks)
	}
	b.notifyAnswer(goClientMsg{Text: asks[0]["ask"].(string), Value: "allow"})
	if got := b.sites.notificationsFor("www.example.com"); got != "allow" {
		t.Errorf("kept %q", got)
	}
	if b.notifyState("example.com") != "granted" || b.acts.waiting() != 3 || b.jobs.waiting() != 1 {
		t.Errorf("state %s; %d told, %d jobs (the page's script again)", b.notifyState("example.com"), b.acts.waiting(), b.jobs.waiting())
	}
	// Kept: read again from the file.
	if again := newGoSiteSettings(filepath.Join(dir, "sites.json")); again.notificationsFor("example.com") != "allow" {
		t.Errorf("not kept in the file")
	}
	// Answered: a later ask is told so, not asked.
	b.clipboard(1, 1, goClipboardOut{Notify: &goNotifyOut{Asks: []string{"a5"}}})
	if len(goSentOf(w, "go-notify-ask")) != 1 || b.acts.waiting() != 4 {
		t.Errorf("asked again once allowed")
	}
	// An answer for no ask: nothing.
	b.notifyAnswer(goClientMsg{Text: "nope", Value: "block"})
	if b.sites.notificationsFor("example.com") != "allow" {
		t.Errorf("an answer for no ask was kept")
	}
	// Forgotten with the site.
	if err := b.sites.set("example.com", "forget"); err != nil || b.sites.notificationsFor("example.com") != "" {
		t.Errorf("not forgotten: %v", err)
	}
}

// TestGoNotifyPrivate: a private tab's answer is the tab's alone.
func TestGoNotifyPrivate(t *testing.T) {
	b, w := goNotifyTestTab(t, t.TempDir())
	b.private = true
	b.inputAt, b.inputGen, b.inputWorld = time.Now(), 1, 1
	b.clipboard(1, 1, goClipboardOut{Notify: &goNotifyOut{Asks: []string{"a1"}}})
	asks := goSentOf(w, "go-notify-ask")
	if len(asks) != 1 {
		t.Fatalf("asked %v", asks)
	}
	b.notifyAnswer(goClientMsg{Text: asks[0]["ask"].(string), Value: "block"})
	if b.sites.notificationsFor("example.com") != "" || b.notifyState("example.com") != "denied" {
		t.Errorf("a private tab's answer: kept %q, the tab's %s", b.sites.notificationsFor("example.com"), b.notifyState("example.com"))
	}
	if answers, _ := b.notifyAnswers(); answers["example.com"] != "block" {
		t.Errorf("not given the tab's pages: %v", answers)
	}
}

// TestGoNotifyShow: shown only once allowed, on a secure page, so many a
// minute; its title and body cut; its events passed back; closed by the
// page; all closed as the page is left.
func TestGoNotifyShow(t *testing.T) {
	b, w := goNotifyTestTab(t, "")
	show := func(id string) {
		b.clipboard(1, 1, goClipboardOut{Notify: &goNotifyOut{Shows: []goNotifyShow{{ID: id, Title: strings.Repeat("t", 1000), Body: "body", Tag: "x"}}}})
	}
	show("n0")
	if len(goSentOf(w, "go-notify")) != 0 || b.acts.waiting() != 1 {
		t.Fatalf("shown with no permission, or the page not told")
	}
	b.sites.set("example.com", "notifications-allow")
	// An insecure page's: not shown.
	b.docURL = "http://www.example.com/"
	show("n1")
	if len(goSentOf(w, "go-notify")) != 0 {
		t.Fatalf("an insecure page's shown")
	}
	b.docURL = "https://www.example.com/"
	for i := range goNotifyPerMin + 2 {
		show("n" + string(rune('a'+i)))
	}
	shown := goSentOf(w, "go-notify")
	if len(shown) != goNotifyPerMin {
		t.Fatalf("%d shown in a minute", len(shown))
	}
	if len(shown[0]["title"].(string)) != goNotifyTitle || shown[0]["site"] != "example.com" || shown[0]["body"] != "body" {
		t.Errorf("shown as %v", shown[0])
	}
	token := shown[0]["ask"].(string)
	before := b.acts.waiting()
	b.notifyEvent(goClientMsg{Text: token, Kind: "click"})
	b.notifyEvent(goClientMsg{Text: token, Kind: "bogus"})
	if b.acts.waiting() != before+1 {
		t.Errorf("the click not told, or a bogus event told")
	}
	// Closed by the page: the person's browser told.
	b.clipboard(1, 1, goClipboardOut{Notify: &goNotifyOut{Closes: []string{"na"}}})
	if c := goSentOf(w, "go-notify-close"); len(c) != 1 || c[0]["ask"] != token {
		t.Errorf("closed as %v", c)
	}
	b.notifyEvent(goClientMsg{Text: token, Kind: "close"})
	if _, ok := b.notifying.shown[token]; ok {
		t.Errorf("kept once closed")
	}
	b.notifyGone()
	if len(goSentOf(w, "go-notify-gone")) != 1 || len(b.notifying.shown) != 0 {
		t.Errorf("not let go with the page")
	}
}

// TestGoClipboardImages: a picture copied is passed on if it's a PNG; a
// read of the clipboard's items is given the picture sent in parts, if
// whole and a PNG.
func TestGoClipboardImages(t *testing.T) {
	b, w := goClipTab()
	b.inputAt, b.inputGen, b.inputWorld = time.Now(), 1, 1
	png := base64.StdEncoding.EncodeToString(append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 100)...))
	notPNG := base64.StdEncoding.EncodeToString([]byte("GIF89a......"))
	text := "alt"
	b.clipboard(1, 1, goClipboardOut{Copy: &text, CopyImage: &png})
	b.clipboard(1, 1, goClipboardOut{CopyImage: &notPNG})
	copies := goSentOf(w, "go-copy")
	if len(copies) != 1 || copies[0]["image"] != png || copies[0]["text"] != "alt" {
		t.Fatalf("copied %v", copies)
	}
	b.clipboard(1, 1, goClipboardOut{PasteReads: []string{"r1"}, PasteAsks: []string{"r2"}})
	asks := goSentOf(w, "go-paste-ask")
	if len(asks) != 2 || asks[0]["images"] != false || asks[1]["images"] != true {
		t.Fatalf("asked %v", asks)
	}
	token := asks[1]["ask"].(string)
	b.pastePart(goClientMsg{Text: token, Value: png[:40]})
	b.pastePart(goClientMsg{Text: token, Value: png[40:]})
	b.paste(goClientMsg{Text: token, Accept: true, Value: "text", Count: 108})
	if b.acts.waiting() != 1 {
		t.Fatalf("not answered")
	}
	if a := b.pasteAsks.m[token].v; a != nil {
		t.Errorf("kept once answered")
	}
	// A readText's ask takes no picture.
	b.pastePart(goClientMsg{Text: asks[0]["ask"].(string), Value: png})
	if a := b.pasteAsks.m[asks[0]["ask"].(string)].v; a == nil || a.image.Len() != 0 {
		t.Errorf("a readText given a picture")
	}
	if _, ok := goPNG(notPNG); ok {
		t.Errorf("goPNG took a GIF")
	}
}
