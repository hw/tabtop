package main

import "context"

// What the person's browser sends the tab (goClientMsg's Op), each taken
// by its rule of which generation it's of (its Gen):
const (
	// goOpAny: the tab's own (navigate, stop), or checked as it's
	// answered, by its token or ask (a read of the clipboard, a pop-up).
	goOpAny = iota
	// goOpThisGen: of the tab's generation now: what the page that's there
	// asked of the person's browser, said back (a lock, fullscreen left).
	goOpThisGen
	// goOpShown: of the page shown, of the generation now: what's done in
	// its copy (an event, what it observes).
	goOpShown
)

// goOp is one: its rule, and what's done.
type goOp struct {
	gen int
	do  func(b *goBrowser, m goClientMsg)
}

// goOps are what the person's browser may send, but "close" (run's own: it
// ends the tab).
var goOps map[string]goOp

func init() {
	goOps = map[string]goOp{
		"popup-answer": {goOpAny, func(b *goBrowser, m goClientMsg) { b.popupAnswer(m.ID, m.Accept, m.Remember) }},
		"navigate": {goOpAny, func(b *goBrowser, m goClientMsg) {
			if m.View != nil {
				b.setView(*m.View) // before the page loads, at its size
			}
			u, err := goURL(m.URL)
			if err != nil {
				b.newGen(false) // (the page shown stays)
				b.loading, b.loadTimeout = 0, nil
				b.fail(b.gen, err.Error())
				return
			}
			b.loadTimeout = b.navigate(u, "you")
		}},
		// Continue on a certificate warning (gocert.go): the host warned
		// of, at the address warned of, an exception for the tab from now,
		// and loaded again. (Refused, said: the page shows it's loading.)
		"cert-continue": {goOpAny, func(b *goBrowser, m goClientMsg) {
			u, err := goURL(m.URL)
			switch {
			case err != nil || b.certWarned == "" || u != b.certWarnedAt:
				b.fail(b.gen, "That warning is out of date: load the page again.")
			case b.certUnsupported.Load() && !b.certWarnedRevoked:
				b.fail(b.gen, "This browser's engine can't continue past a certificate warning.")
			case !b.certs.add(b.certWarned, b.certWarnedRevoked):
				b.fail(b.gen, "This tab has too many certificate exceptions: open the site in a new tab.")
			default:
				b.certWarned, b.certWarnedAt, b.certWarnedRevoked = "", "", false
				b.loadTimeout = b.navigate(u, "you")
			}
		}},
		"stop": {goOpAny, func(b *goBrowser, m goClientMsg) {
			b.newGen(false) // (the page shown stays, its load stopped)
			b.loading, b.loadTimeout = 0, nil
			shown := b.docURL
			b.job(func() any {
				ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
				defer cancel()
				err := b.cdp.call(ctx, b.page, "Page.stopLoading", nil, nil)
				b.certIgnore(ctx, shown) // (as the page shown is: the load stopped may not have come)
				return err
			}, func(any) {})
		}},
		"event":              {goOpShown, (*goBrowser).act},
		"files":              {goOpAny, (*goBrowser).chooseFiles},  // a chooser answered (gouploads.go)
		"paste":              {goOpAny, (*goBrowser).paste},        // a read of the clipboard answered (goclipboard.go)
		"paste-part":         {goOpAny, (*goBrowser).pastePart},    // and the picture given it, in parts
		"notify-permission":  {goOpAny, (*goBrowser).notifyAnswer}, // notifications allowed, or not (gonotify.go)
		"notify-event":       {goOpAny, (*goBrowser).notifyEvent},  // one shown, clicked or closed
		"device-answer":      {goOpAny, (*goBrowser).deviceAnswer}, // (godevice.go)
		"paste-image":        {goOpAny, (*goBrowser).pasteImage},   // (godevice.go)
		"drop-files":         {goOpAny, (*goBrowser).dropStart},    // files dropped on the page, to be sent
		"dropped":            {goOpAny, (*goBrowser).dropFiles},    // and sent: dropped there
		"res":                {goOpAny, (*goBrowser).serveRes},     // a resource for the page shown, from any generation (a page being left may still ask)
		"go-fs-cancel":       {goOpThisGen, func(b *goBrowser, m goClientMsg) { b.abortFSRead(m.Text) }},
		"pointerlock":        {goOpThisGen, func(b *goBrowser, m goClientMsg) { b.pointerLockState(m.Value) }}, // locked, couldn't, or left (gopointerlock.go)
		"orientation-answer": {goOpThisGen, (*goBrowser).orientationAnswered},                                  // locked, or couldn't (goorientation.go)
		"wakelock-lost":      {goOpThisGen, func(b *goBrowser, m goClientMsg) { b.wakeLockLost() }},            // couldn't keep it (gowakelock.go)
		"fullscreen-exit":    {goOpThisGen, func(b *goBrowser, m goClientMsg) { b.fullscreenExit() }},          // the person left it (gofullscreen.go)
		"media-action":       {goOpThisGen, (*goBrowser).mediaAction},                                          // a media control pressed (gomediasession.go)
		"resync": {goOpAny, func(b *goBrowser, m goClientMsg) {
			if m.Gen == b.shown && b.loading == 0 {
				b.readAgain(b.gen)
			}
		}},
		"viewport": {goOpAny, func(b *goBrowser, m goClientMsg) {
			if m.View != nil {
				b.setView(*m.View)
			}
		}},
		// Dark mode changed (Site controls): the page told again, and read
		// again whole, for its copy's styles to go by it too (goSchemeOf,
		// go-frame.js).
		"theme": {goOpAny, func(b *goBrowser, m goClientMsg) {
			b.job(func() any { b.schemeAt(""); return nil }, func(any) {
				if b.shown == b.gen && b.gen != 0 {
					b.readAgain(b.gen)
				}
			})
		}},
		// Not the person's doing as such: a page can make what it observes
		// come and go by itself, and mustn't keep the watchdog from seeing
		// it busy.
		"io": {goOpShown, func(b *goBrowser, m goClientMsg) { b.giveIO(m.Entries) }},
		"dialog": {goOpAny, func(b *goBrowser, m goClientMsg) {
			if m.Quiet && !b.dialog {
				b.quiet = b.gen // shown what it asked: no more of it
			}
			if b.dialog {
				if m.Quiet {
					b.quiet = b.gen
				}
				b.answer(m.Accept, m.Text)
				b.dialogTimeout = nil
			}
		}},
	}
}

// takeOp does what the person's browser sent (m), if it's of a generation
// its rule takes; one not known is said to be refused.
func (b *goBrowser) takeOp(m goClientMsg) {
	op, ok := goOps[m.Op]
	switch {
	case !ok:
		b.fail(b.gen, "Unknown request.")
	case op.gen == goOpThisGen && m.Gen != b.gen, op.gen == goOpShown && (m.Gen != b.shown || m.Gen != b.gen):
		// Of a page, or a document, that's gone.
	default:
		op.do(b, m)
	}
}
