package main

// The page's clipboard (goclipboard.js): what it copies (a Copy button's
// navigator.clipboard.writeText or write, document.execCommand("copy"))
// is put on the person's clipboard by their browser (go.js, go-copy), and
// what it reads (readText, read) is asked of the person each time
// (go-paste-ask), answered with what their browser's clipboard has
// (paste), or not.
//
// Only following the person's own input in the page, as a browser's
// clipboard is only the page's after a press or a key (its transient
// activation, here goChooserAfterInput, as a file chooser's): the engine
// sees no activation (measured, Moli 1.1.27), and what the page's world
// says it copied could be said at any time. Nothing copied or pasted is
// logged, only how much.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const (
	goCopyMax     = 1 << 20 // bytes of text copied, or pasted, passed on
	goPasteAsks   = 4       // reads waiting for the person at once
	goPasteAskFor = 2 * time.Minute
	// A picture copied, or pasted for the page: a PNG of 8 MiB at most (as
	// a pasted one, godevice.go's goPasteImageMax).
	goCopyImageMax = goPasteImageMax
)

var goPNGMagic = []byte("\x89PNG\r\n\x1a\n")

// goPNG is the PNG b64 says, if it's one (strict base64, 8 MiB at most).
func goPNG(b64 string) ([]byte, bool) {
	if len(b64) > base64.StdEncoding.EncodedLen(goCopyImageMax) {
		return nil, false
	}
	data, err := base64.StdEncoding.Strict().DecodeString(b64)
	if err != nil || !bytes.HasPrefix(data, goPNGMagic) {
		return nil, false
	}
	return data, true
}

// goPasteAsk is a read of the clipboard the page asked for: in which world
// (the page's agent's, or a frame's), by the page's own id for it.
type goPasteAsk struct {
	gen, world int
	id         string
	at         time.Time
	// A read of its items (read(), not readText()): a picture may be given,
	// sent in parts (paste-part), base64.
	images bool
	image  strings.Builder
}

var goPasteID = regexp.MustCompile(`^[a-z0-9]{1,40}$`)

// goClipboardOut is what an agent says the page asked of the person's
// browser: the page's newest copy and its reads of the clipboard, and its
// fullscreen, notifications, vibration and locks (featureAsks; its
// share, location and files are its devices: godevice.go).
type goClipboardOut struct {
	Copy *string `json:"copy"`
	// A picture copied (a PNG, base64), with Copy its text, if it had any.
	CopyImage *string  `json:"copyImage"`
	PasteAsks []string `json:"pasteAsks"`
	// Reads of the clipboard's items (its picture, and text).
	PasteReads []string `json:"pasteReads"`
	// And its fullscreen asked for, or left (gofullscreen.go).
	Fullscreen []goFullscreenAsk `json:"fullscreen"`
	// And its notifications (gonotify.go).
	Notify *goNotifyOut `json:"notify"`
	// And the pattern it last asked to be felt (govibrate.go).
	Vibrate []float64 `json:"vibrate"`
	// And its screen wake lock asked for, or let go (gowakelock.go).
	WakeLock []goWakeAsk `json:"wakeLock"`
	// And its screen's orientation locked, or unlocked (goorientation.go).
	Orientation []goOrientAsk `json:"orientation"`
	// And its pointer lock asked for, or left (gopointerlock.go).
	PointerLock []goPointerAsk `json:"pointerLock"`
}

// clipboard passes on what the page in world (of gen) asked of the
// person's browser: its fullscreen, notifications, vibration and locks
// (featureAsks, each by its own rules), and what it copied and asked to
// read, if that followed the person's input there.
func (b *goBrowser) clipboard(gen, world int, out goClipboardOut) {
	recent := b.recentInput(gen, world)
	if gen == b.gen {
		b.featureAsks(gen, world, out, recent)
	}
	if out.Copy == nil && out.CopyImage == nil && len(out.PasteAsks) == 0 && len(out.PasteReads) == 0 {
		return
	}
	if !recent {
		goDebugf("clipboard: not after the person's input: not passed on")
		for _, id := range append(out.PasteAsks, out.PasteReads...) {
			b.pasteRefused(world, id)
		}
		return
	}
	b.copied(gen, out)
	for _, id := range out.PasteAsks {
		b.pasteAsk(gen, world, id, false)
	}
	for _, id := range out.PasteReads {
		b.pasteAsk(gen, world, id, true)
	}
}

// featureAsks passes on what the page asked of the person's browser other
// than its clipboard (fullscreen before its orientation: a lock's allowed
// only in it).
func (b *goBrowser) featureAsks(gen, world int, out goClipboardOut, recent bool) {
	if len(out.Fullscreen) > 0 {
		b.fullscreenAsks(gen, world, out.Fullscreen, recent)
	}
	if out.Notify != nil {
		b.notify(gen, world, *out.Notify, recent)
	}
	if out.Vibrate != nil {
		b.vibrate(gen, world, out.Vibrate, recent)
	}
	if len(out.WakeLock) > 0 {
		b.wakeLockAsks(gen, world, out.WakeLock, recent)
	}
	if len(out.Orientation) > 0 {
		b.orientationAsks(gen, world, out.Orientation)
	}
	if len(out.PointerLock) > 0 {
		b.pointerLockAsks(gen, world, out.PointerLock, recent)
	}
}

// copied puts what the page copied (its text, a picture) on the person's
// clipboard.
func (b *goBrowser) copied(gen int, out goClipboardOut) {
	if out.Copy == nil && out.CopyImage == nil {
		return
	}
	m := map[string]any{"type": "go-copy", "gen": gen}
	if out.Copy != nil {
		m["text"] = goCut(*out.Copy, goCopyMax)
	}
	if out.CopyImage != nil {
		if png, ok := goPNG(*out.CopyImage); ok {
			m["image"] = *out.CopyImage
			goDebugf("clipboard: a %d-byte picture copied", len(png))
		} else {
			goDebugf("clipboard: a picture copied that isn't a PNG of %d MiB at most: not passed on", goCopyImageMax>>20)
		}
	}
	if _, text := m["text"]; text || m["image"] != nil {
		goDebugf("clipboard: %d bytes of text copied", len(goStr(m["text"])))
		b.send(m)
	}
}

// pasteAsk asks the person whether the page's read of the clipboard (its
// id) is answered: its text, or its items too (images, read()).
func (b *goBrowser) pasteAsk(gen, world int, id string, images bool) {
	if !goPasteID.MatchString(id) {
		return
	}
	b.pasteAsksDue()
	if len(b.pasteAsks) >= goPasteAsks {
		b.pasteRefused(world, id)
		return
	}
	// Named for the page that asked, and the page it's in if that's
	// another (an embedded page's).
	site, top := b.worldSite(world), goPageSite(b.docURL)
	if site == "" {
		b.pasteRefused(world, id)
		return
	}
	if site == top {
		top = ""
	}
	if b.pasteAsks == nil {
		b.pasteAsks = map[string]*goPasteAsk{}
	}
	token := goToken()
	b.pasteAsks[token] = &goPasteAsk{gen: gen, world: world, id: id, at: time.Now(), images: images}
	b.send(map[string]any{"type": "go-paste-ask", "gen": gen, "ask": token, "site": site, "within": top, "images": images})
}

// recentInput is whether the person's input in the tab was soon enough
// before, and where, for the page in world (of gen) to act on it: the
// page's own on any (an embedded page's activation is its parents' too);
// an embedded page of another origin's, on its own only.
func (b *goBrowser) recentInput(gen, world int) bool {
	if gen != b.gen || b.shown != gen || b.inputGen != gen || time.Since(b.inputAt) > goChooserAfterInput {
		return false
	}
	return world == b.world || world == b.inputWorld
}

// worldSite is the site of the page in world: the page's, or an embedded
// page's (by its address as last read).
func (b *goBrowser) worldSite(world int) string {
	if world == b.world {
		return goPageSite(b.docURL)
	}
	for _, c := range b.children {
		if c.world == world && !c.same {
			return goPageSite(c.url)
		}
	}
	return ""
}

// pasteAsksDue lets go of reads asked for long ago (the page's own wait
// is over: goclipboard.js), or by a page gone.
func (b *goBrowser) pasteAsksDue() {
	for token, a := range b.pasteAsks {
		if a.gen != b.gen || time.Since(a.at) > goPasteAskFor {
			delete(b.pasteAsks, token)
		}
	}
}

// paste answers a read the page asked for (m.Text, the ask's token): with
// what the person's clipboard had (m.Value), if they allowed it (Accept).
func (b *goBrowser) paste(m goClientMsg) {
	b.pasteAsksDue()
	a, ok := b.pasteAsks[m.Text]
	if !ok {
		return
	}
	delete(b.pasteAsks, m.Text)
	if !m.Accept {
		b.pasteRefused(a.world, a.id)
		return
	}
	text := m.Value
	if len(text) > goCopyMax {
		text = goCut(text, goCopyMax)
	}
	answer := map[string]any{"id": a.id, "text": text}
	// Its picture, sent before in parts: given if it's whole (Count, its
	// bytes) and a PNG.
	if a.images && m.Count > 0 {
		if png, ok := goPNG(a.image.String()); ok && len(png) == m.Count {
			answer["image"] = a.image.String()
			goDebugf("clipboard: a %d-byte picture pasted for the page", len(png))
		} else {
			goDebugf("clipboard: a picture pasted for the page that isn't whole, or a PNG: not given")
		}
	}
	goDebugf("clipboard: %d bytes pasted for the page", len(text))
	b.pasted(a.world, answer)
}

// pastePart is a part of the picture the person's browser gives a read
// (m.Text, the ask's token): base64, in order, up to goCopyImageMax.
func (b *goBrowser) pastePart(m goClientMsg) {
	a, ok := b.pasteAsks[m.Text]
	if !ok || !a.images || len(m.Value) == 0 || len(m.Value) > 64<<10 {
		return
	}
	if a.image.Len()+len(m.Value) > base64.StdEncoding.EncodedLen(goCopyImageMax) {
		a.images = false // (too large: none given)
		a.image.Reset()
		return
	}
	a.image.WriteString(m.Value)
}

// goStr is v if it's a string, else "".
func goStr(v any) string {
	s, _ := v.(string)
	return s
}

func (b *goBrowser) pasteRefused(world int, id string) {
	if goPasteID.MatchString(id) {
		b.pasted(world, map[string]any{"id": id})
	}
}

// pasted gives the agent in world the answer, for the page.
func (b *goBrowser) pasted(world int, answer map[string]any) {
	a, _ := json.Marshal(answer)
	b.agentCall(world, "pasted", string(a))
}

// agentCall calls the agent's fn in world with args (each JSON-encoded:
// never the page's text as code), on the acts' queue.
func (b *goBrowser) agentCall(world int, fn string, args ...any) {
	if world == 0 {
		return
	}
	expr := "__tabtop." + fn + "("
	for i, a := range args {
		j, _ := json.Marshal(a)
		if i > 0 {
			expr += ","
		}
		expr += string(j)
	}
	expr += ")"
	b.acts.add(func() {
		ctx, cancel := context.WithTimeout(context.Background(), goActTimeout)
		defer cancel()
		b.evaluateIn(ctx, world, expr)
	})
}

// evaluateIn runs one of the agent's own calls (fixed text and JSON,
// never the page's) in world, as it is: not made again if it's gone.
func (b *goBrowser) evaluateIn(ctx context.Context, world int, expr string) {
	b.cdp.call(ctx, b.page, "Runtime.evaluate", map[string]any{"expression": expr, "contextId": world, "returnByValue": true}, nil)
}

// goPageSite is the site of the page at u, or "".
func goPageSite(u string) string {
	p, err := url.Parse(u)
	if err != nil || p.Hostname() == "" {
		return ""
	}
	return goSite(p.Hostname())
}

// goCut is s cut to at most n bytes, at a character's start.
func goCut(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && n < len(s) && s[n]&0xc0 == 0x80 {
		n--
	}
	return s[:n]
}
