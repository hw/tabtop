package main

// A remote browser tab, its engine's page, as goroute.go opens it: what the
// person does in the /go page (navigations, clicks, typing, forms sent,
// dialogs answered), carried out in the engine, and what the page does
// (loads, changes, new windows, dialogs, files), sent back.
//
// One goroutine (run) owns the tab's state and never waits on the engine:
// a single worker does the engine's jobs in turn (navigating, reading the
// document, reading changes, acting), and posts what came of each back to
// run. So run can always answer a dialog, which stops the page's scripts,
// and with them everything the worker waits on, until it's answered.
//
// Generations: every navigation, the person's or the page's (a link it
// follows, a form it sends, a redirect by script), starts one, numbered here
// and told to the page with "go-loading"; anything for an older generation
// is dropped. What changes in a document is read by the agent (goagent.js),
// in batches numbered from its snapshot; a batch out of order, or one the
// page can't place, and the whole document is read again.

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

//go:embed goagent.js
var goAgentJS string

// goDebug (TABTOP_GO_DEBUG=1) logs what each tab does, for finding out why
// a page misbehaves: the person's requests by kind, navigations,
// snapshots and changes, by size. Never addresses typed or values.
var goDebug = os.Getenv("TABTOP_GO_DEBUG") != ""

func goDebugf(format string, args ...any) {
	if goDebug {
		log.Printf("go-debug: "+format, args...)
	}
}

const (
	// goChangesEvery is the least time between reading changes, however
	// busy the page; goPollEvery how often they're looked for, until the
	// page has been still for goPollQuiet, then once a second.
	goChangesEvery = 100 * time.Millisecond
	// goAgainEvery is the least time between reading a whole document
	// again (on a gap in its changes, or a batch too large): a page that
	// forces that on every read would otherwise send up to a snapshot's
	// limit each time.
	goAgainEvery = time.Second
	goPollEvery  = 250 * time.Millisecond
	goPollQuiet  = 10 * time.Second
	// goChangesLimit is the largest batch of changes sent; a bigger one is
	// sent as the whole document again.
	goChangesLimit = 4 << 20
	// goDialogWait is how long a dialog waits for the person, before it's
	// answered for them: OK for an alert, Cancel for a question.
	goDialogWait = 60 * time.Second
	goActTimeout = 10 * time.Second
	// goActsWaiting bounds the person's acts queued for a page that isn't
	// taking them (each waits up to goActTimeout).
	goActsWaiting = 64
)

type goBrowser struct {
	t      msgConn
	e      *goEngine
	cdp    *cdpConn
	page   string // the CDP session of its page
	target string // its page's target
	frame  string // its main frame

	gen int // the newest generation
	// loading is the generation waiting for its load, if any; navigated,
	// whether its navigation has begun (an older page's late load event
	// isn't its).
	loading   int
	navigated bool
	// world is the isolated world the agent is in, for this document; 0
	// until it's made.
	world int
	// shown is the generation whose document the page has, and seq the
	// last batch of changes sent for it.
	shown, seq int
	url        string // the address shown
	// docURL is the address of the document the engine has now (its
	// main frame's, as last committed): what a dialog is said to come
	// from, not where the tab is going (a popup that loads in the tab is
	// announced before its opener's document goes).
	docURL string
	// docType is the media type of the main frame's document as it came
	// (Moli shows a PDF's bytes as a page of text, and says it's HTML).
	docType  string
	dirty    bool // the agent has changes to read
	readSoon <-chan time.Time
	// lastAgain is when the document was last read again whole; againGen,
	// the generation waiting to be (0: none), at againSoon.
	lastAgain  time.Time
	againGen   int
	againSoon  <-chan time.Time
	reading    bool // a read of changes is going
	lastRead   time.Time
	lastChange time.Time // when the document last changed
	dialog     bool      // a dialog is open
	popups     map[string]bool

	// The worker's jobs (reads, navigations) and the person's acts, each in
	// order, on queues of their own: an act may open a dialog, which stops
	// the page until it's answered, and reads mustn't be held up behind it.
	// What comes of them goes to run.
	jobs, acts *goQueue
	results    chan func()
	stop       chan struct{}
}

// goQueue runs functions one at a time, in order, on a goroutine of its
// own; unbounded, as a job dropped would leave a read never finished.
type goQueue struct {
	mu    sync.Mutex
	queue []func()
	wake  chan struct{}
}

func newGoQueue() *goQueue { return &goQueue{wake: make(chan struct{}, 1)} }

// waiting is how many functions are queued, not yet started.
func (q *goQueue) waiting() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.queue)
}

func (q *goQueue) add(f func()) {
	q.mu.Lock()
	q.queue = append(q.queue, f)
	q.mu.Unlock()
	select {
	case q.wake <- struct{}{}:
	default:
	}
}

func (q *goQueue) run(stop <-chan struct{}) {
	for {
		q.mu.Lock()
		if len(q.queue) == 0 {
			q.mu.Unlock()
			select {
			case <-q.wake:
				continue
			case <-stop:
				return
			}
		}
		f := q.queue[0]
		q.queue = q.queue[1:]
		q.mu.Unlock()
		f()
	}
}

type goClientMsg struct {
	Op        string `json:"op"`
	URL       string `json:"url"`
	Gen       int    `json:"gen"`
	Kind      string `json:"kind"`
	ID        int    `json:"id"`
	Value     string `json:"value"`
	Checked   bool   `json:"checked"`
	Key       string `json:"key"`
	Code      string `json:"code"`
	Shift     bool   `json:"shift"`
	Ctrl      bool   `json:"ctrl"`
	Alt       bool   `json:"alt"`
	Meta      bool   `json:"meta"`
	Submitter int    `json:"submitter"`
	Accept    bool   `json:"accept"`
	Text      string `json:"text"`
}

func newGoBrowser(t msgConn, e *goEngine, cdp *cdpConn, page, target string) *goBrowser {
	return &goBrowser{t: t, e: e, cdp: cdp, page: page, target: target, popups: map[string]bool{},
		jobs: newGoQueue(), acts: newGoQueue(), results: make(chan func(), 16), stop: make(chan struct{})}
}

func (b *goBrowser) send(v map[string]any) error {
	return writeJSON(b.t, v)
}

func (b *goBrowser) fail(gen int, message string) {
	b.send(map[string]any{"type": "go-error", "gen": gen, "message": message})
}

// job runs f on the worker, after the jobs before it; then, on run's
// goroutine, done with its result.
func (b *goBrowser) job(f func() any, done func(any)) {
	b.jobs.add(func() {
		r := f()
		b.post(func() { done(r) })
	})
}

// post hands f to run, unless the tab has closed.
func (b *goBrowser) post(f func()) {
	select {
	case b.results <- f:
	case <-b.stop:
	}
}

func (b *goBrowser) run() {
	msgs := make(chan goClientMsg)
	stop := b.stop
	defer close(stop)
	go func() {
		defer close(msgs)
		for {
			typ, p, err := b.t.Read(context.Background())
			if err != nil {
				return
			}
			var m goClientMsg
			if typ != websocket.MessageText || json.Unmarshal(p, &m) != nil {
				b.t.Close(websocket.StatusPolicyViolation, "bad message")
				return
			}
			select {
			case msgs <- m:
			case <-stop:
				return
			}
		}
	}()
	go b.jobs.run(stop)
	go b.acts.run(stop)
	ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
	b.cdp.call(ctx, "", "Target.setDiscoverTargets", map[string]any{"discover": true}, nil)
	cancel()
	// Changes are polled for: a CDP binding the agent could signal by
	// stops Moli (1.1.25) following links within a page.
	poll := time.NewTicker(goPollEvery)
	defer poll.Stop()

	var loadTimeout, dialogTimeout <-chan time.Time
	for {
		select {
		case m, ok := <-msgs:
			if !ok {
				return
			}
			goDebugf("op %s %s id %d gen %d (tab at gen %d, shown %d, loading %d)", m.Op, m.Kind, m.ID, m.Gen, b.gen, b.shown, b.loading)
			// What the person does (not a resync, which the client asks for
			// by itself): the engine's work for it isn't a runaway page's.
			switch m.Op {
			case "navigate", "stop", "dialog":
				b.e.use()
			case "event":
				if m.Gen == b.shown && m.Gen == b.gen {
					b.e.use()
				}
			}
			switch m.Op {
			case "navigate":
				u, err := goURL(m.URL)
				if err != nil {
					b.gen++
					b.loading, loadTimeout = 0, nil
					b.fail(b.gen, err.Error())
					continue
				}
				loadTimeout = b.navigate(u, "you")
			case "stop":
				b.gen++
				b.loading, loadTimeout = 0, nil
				b.job(func() any {
					ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
					defer cancel()
					return b.cdp.call(ctx, b.page, "Page.stopLoading", nil, nil)
				}, func(any) {})
			case "event":
				if m.Gen != b.shown || m.Gen != b.gen {
					continue // for a document that's gone
				}
				b.act(m)
			case "resync":
				if m.Gen == b.shown && b.loading == 0 {
					b.readAgain(b.gen)
				}
			case "dialog":
				if b.dialog {
					b.answer(m.Accept, m.Text)
					dialogTimeout = nil
				}
			default:
				b.fail(b.gen, "Unknown request.")
			}
		case f := <-b.results:
			f()
		case ev := <-b.cdp.Events:
			loadTimeout, dialogTimeout = b.event(ev, loadTimeout, dialogTimeout)
		case <-b.readSoon:
			b.readSoon = nil
			b.readChanges()
		case <-b.againSoon:
			b.againSoon = nil
			if gen := b.againGen; gen != 0 {
				b.againGen = 0
				b.readAgain(gen)
			}
		case <-poll.C:
			// Often while the page changes; once a second once it's
			// been still a while.
			if time.Since(b.lastChange) < goPollQuiet || time.Since(b.lastRead) >= time.Second {
				b.dirty = true
				b.readChanges()
			}
		case <-loadTimeout:
			// Show what has loaded, slow as the rest is.
			gen := b.loading
			b.loading, loadTimeout = 0, nil
			b.snapshot(gen, false)
		case <-dialogTimeout:
			dialogTimeout = nil
			if b.dialog {
				b.answer(false, "") // OK for an alert; Cancel for a question
				b.send(map[string]any{"type": "go-dialog-closed", "gen": b.gen})
			}
		case <-b.e.killed:
			b.fail(b.gen, "The page's engine was stopped: "+b.e.killReason()+".")
			b.t.Close(websocket.StatusNormalClosure, "")
			return
		case <-b.cdp.done:
			b.fail(b.gen, "The page's engine stopped answering.")
			b.t.Close(websocket.StatusNormalClosure, "")
			return
		}
	}
}

// navigate starts a generation that loads u, by "you" (the person) or "page"
// (the page itself, as when it opens a window); it returns the generation's
// load timeout.
func (b *goBrowser) navigate(u, by string) <-chan time.Time {
	b.gen++
	gen := b.gen
	b.loading, b.navigated, b.world, b.dirty, b.docType = gen, false, 0, false, ""
	b.send(map[string]any{"type": "go-loading", "gen": gen, "url": u, "by": by})
	b.job(func() any {
		ctx, cancel := context.WithTimeout(context.Background(), goLoadTimeout)
		defer cancel()
		var r struct {
			FrameID   string `json:"frameId"`
			LoaderID  string `json:"loaderId"`
			ErrorText string `json:"errorText"`
		}
		err := b.cdp.call(ctx, b.page, "Page.navigate", map[string]any{"url": u}, &r)
		if err == nil && r.ErrorText != "" {
			err = errors.New(r.ErrorText)
		}
		return func() {
			if r.FrameID != "" {
				b.frame = r.FrameID
			}
			if gen != b.gen {
				return // an older generation's
			}
			switch {
			case err != nil:
				b.loading = 0
				b.fail(gen, goNavError(err))
			case r.LoaderID == "":
				// Within the same document (a fragment): no load follows.
				b.loading = 0
				b.snapshot(gen, false)
			}
		}
	}, func(r any) { r.(func())() })
	return time.After(goLoadTimeout)
}

// event handles one of the engine's events.
func (b *goBrowser) event(ev cdpEvent, loadTimeout, dialogTimeout <-chan time.Time) (<-chan time.Time, <-chan time.Time) {
	switch ev.Method {
	case "Target.targetCreated", "Target.targetInfoChanged":
		// A window the page opened (window.open, a link to a new
		// window): closed in the engine, and its address loaded in this
		// tab instead, as a navigation of the page's.
		var p struct {
			TargetInfo struct {
				TargetID string `json:"targetId"`
				Type     string `json:"type"`
				URL      string `json:"url"`
			} `json:"targetInfo"`
		}
		json.Unmarshal(ev.Params, &p)
		info := p.TargetInfo
		if info.Type != "page" || info.TargetID == b.target || info.TargetID == "" || b.popups[info.TargetID] {
			return loadTimeout, dialogTimeout
		}
		if u, err := goURL(info.URL); err == nil {
			b.popups[info.TargetID] = true
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
				defer cancel()
				b.cdp.call(ctx, "", "Target.closeTarget", map[string]any{"targetId": info.TargetID}, nil)
			}()
			loadTimeout = b.navigate(u, "page")
		}
		return loadTimeout, dialogTimeout
	}
	if ev.SessionID != b.page {
		return loadTimeout, dialogTimeout
	}
	switch ev.Method {
	case "Page.javascriptDialogOpening":
		var p struct {
			Type    string `json:"type"`
			Message string `json:"message"`
			Default string `json:"defaultPrompt"`
			URL     string `json:"url"`
		}
		json.Unmarshal(ev.Params, &p)
		b.dialog = true
		if p.Type == "beforeunload" {
			b.answer(true, "") // leaving goes ahead
			return loadTimeout, dialogTimeout
		}
		if len(p.Message) > 2000 {
			p.Message = p.Message[:2000] + "…"
		}
		if len(p.Default) > 2000 {
			p.Default = p.Default[:2000]
		}
		from, err := goURL(p.URL)
		if err != nil {
			from = b.docURL
		}
		b.send(map[string]any{"type": "go-dialog", "gen": b.gen, "kind": p.Type, "message": p.Message, "default": p.Default, "url": from})
		dialogTimeout = time.After(goDialogWait)
	case "Page.frameNavigated":
		var p struct {
			Frame struct {
				ID       string `json:"id"`
				ParentID string `json:"parentId"`
				URL      string `json:"url"`
			} `json:"frame"`
		}
		json.Unmarshal(ev.Params, &p)
		if p.Frame.ParentID != "" {
			break // a frame's, not the page's
		}
		goDebugf("frame navigated (loading %d)", b.loading)
		b.frame = p.Frame.ID
		b.world, b.dirty = 0, false // a new document, a new world
		b.docURL = ""
		if u, err := goURL(p.Frame.URL); err == nil {
			b.docURL = u
		}
		if b.loading != 0 {
			b.navigated = true
		} else if u, err := goURL(p.Frame.URL); err == nil {
			// The page went somewhere by itself: a link, a form, a
			// redirect by script.
			b.gen++
			b.loading, b.navigated = b.gen, true
			b.send(map[string]any{"type": "go-loading", "gen": b.gen, "url": u, "by": "page"})
			loadTimeout = time.After(goLoadTimeout)
		}
	case "Network.responseReceived":
		var p struct {
			Type     string `json:"type"`
			FrameID  string `json:"frameId"`
			Response struct {
				MimeType string `json:"mimeType"`
			} `json:"response"`
		}
		json.Unmarshal(ev.Params, &p)
		if p.Type == "Document" && (p.FrameID == b.frame || b.frame == "") {
			// Its type alone: Moli keeps its parameters (charset), as
			// Chrome doesn't.
			media, _, _ := strings.Cut(p.Response.MimeType, ";")
			b.docType = strings.ToLower(strings.TrimSpace(media))
		}
	case "Page.loadEventFired":
		if b.loading != 0 && b.navigated {
			gen := b.loading
			b.loading, loadTimeout = 0, nil
			b.snapshot(gen, false)
		}
	case "Page.navigatedWithinDocument":
		// A fragment followed: the address, read with the next changes.
		b.changed(0)
	}
	return loadTimeout, dialogTimeout
}

// readAgain reads generation gen's document again whole, at most once
// each goAgainEvery: asked sooner, it's done when that's up.
func (b *goBrowser) readAgain(gen int) {
	if gen != b.gen || b.shown != gen || b.loading != 0 {
		return // gone, or a new one's coming anyway
	}
	if b.reading {
		b.againGen = gen
		if b.againSoon == nil {
			b.againSoon = time.After(goChangesEvery)
		}
		return
	}
	if wait := goAgainEvery - time.Since(b.lastAgain); wait > 0 {
		b.againGen = gen
		if b.againSoon == nil {
			b.againSoon = time.After(wait)
		}
		return
	}
	b.againGen, b.lastAgain = 0, time.Now()
	b.snapshot(gen, true)
}

// changed has the document's changes read in after (or later, if they're
// being read).
func (b *goBrowser) changed(after time.Duration) {
	if b.shown != b.gen || b.loading != 0 {
		return
	}
	b.dirty = true
	if b.readSoon == nil && !b.reading {
		b.readSoon = time.After(after)
	}
}

// answer answers the open dialog.
func (b *goBrowser) answer(accept bool, text string) {
	b.dialog = false
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
		defer cancel()
		params := map[string]any{"accept": accept}
		if accept && text != "" {
			params["promptText"] = text
		}
		b.cdp.call(ctx, b.page, "Page.handleJavaScriptDialog", params, nil)
	}()
}

// evaluate runs expr in the agent's world, making it (and the agent) if
// there's none for this document yet, and returns the string it returns.
func (b *goBrowser) evaluate(ctx context.Context, world int, expr string) (int, string, error) {
	for try := 0; try < 2; try++ {
		if world == 0 {
			var err error
			if world, err = b.makeWorld(ctx); err != nil {
				return 0, "", err
			}
		}
		var r struct {
			Result struct {
				Value string `json:"value"`
			} `json:"result"`
			Exception *struct {
				Text      string `json:"text"`
				Exception struct {
					Description string `json:"description"`
				} `json:"exception"`
			} `json:"exceptionDetails"`
		}
		err := b.cdp.call(ctx, b.page, "Runtime.evaluate", map[string]any{"expression": expr, "contextId": world, "returnByValue": true}, &r)
		if err == nil && r.Exception == nil {
			return world, r.Result.Value, nil
		}
		if r.Exception != nil {
			err = fmt.Errorf("%s %s", r.Exception.Text, r.Exception.Exception.Description)
			if !strings.Contains(err.Error(), "__tabtop") {
				return world, "", err // the agent's own failure, not a lost world
			}
		}
		world = 0 // the world went with its document: make another, once
	}
	return 0, "", errors.New("the page's document couldn't be reached")
}

// makeWorld makes an isolated world in the page's main frame.
func (b *goBrowser) makeWorld(ctx context.Context) (int, error) {
	var tree struct {
		FrameTree struct {
			Frame struct {
				ID string `json:"id"`
			} `json:"frame"`
		} `json:"frameTree"`
	}
	if err := b.cdp.call(ctx, b.page, "Page.getFrameTree", nil, &tree); err != nil {
		return 0, err
	}
	var world struct {
		ID int `json:"executionContextId"`
	}
	err := b.cdp.call(ctx, b.page, "Page.createIsolatedWorld", map[string]any{"frameId": tree.FrameTree.Frame.ID, "worldName": "tabtop"}, &world)
	return world.ID, err
}

type goSnapshot struct {
	URL   string  `json:"url"`
	Base  string  `json:"base"`
	Title string  `json:"title"`
	Type  string  `json:"type"`
	Doc   *goNode `json:"doc"`
}

// goShownTypes are the documents shown as pages; anything else (a PDF, a
// picture, an archive) is offered to be saved.
func goShownType(media string) bool {
	switch media {
	case "", "text/html", "application/xhtml+xml", "text/plain", "image/svg+xml", "text/xml", "application/xml":
		return true
	}
	return false
}

// snapshot reads the whole document (installing the agent, which then
// watches it for changes) and sends it, for generation gen; with again, as
// the same document read afresh, for the page to keep its place in.
func (b *goBrowser) snapshot(gen int, again bool) {
	world := b.world
	b.reading = true
	b.job(func() any {
		ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
		defer cancel()
		world, raw, err := b.evaluate(ctx, world, goAgentJS)
		return func() {
			b.reading = false
			if gen != b.gen {
				return // superseded while it was read
			}
			if err != nil {
				b.fail(gen, "The page couldn't be read.")
				return
			}
			b.world = world
			if len(raw) > goSnapshotLimit {
				b.fail(gen, fmt.Sprintf("The page is too large to show (%d MB).", len(raw)>>20))
				return
			}
			var s goSnapshot
			if err := json.Unmarshal([]byte(raw), &s); err != nil || goClean(s.Doc) == nil {
				b.fail(gen, "The page couldn't be read.")
				return
			}
			b.url = s.URL
			if media := b.docType; !goShownType(media) || !goShownType(s.Type) {
				// A file, not a page.
				if goShownType(media) {
					media = s.Type
				}
				u, err := goURL(s.URL)
				if err != nil {
					b.fail(gen, "The page led to a file that can't be saved from here.")
					return
				}
				b.send(map[string]any{"type": "go-file", "gen": gen, "url": u, "mime": media})
				return
			}
			p, err := json.Marshal(map[string]any{"type": "go-snapshot", "gen": gen, "url": s.URL, "base": s.Base, "title": goTitleOf(s.Title), "doc": s.Doc, "again": again})
			if err != nil || len(p) > goSnapshotLimit {
				b.fail(gen, "The page is too large to show.")
				return
			}
			b.shown, b.seq, b.lastChange = gen, 0, time.Now()
			goDebugf("snapshot gen %d, %d bytes", gen, len(p))
			b.t.Write(context.Background(), websocket.MessageText, p)
			if b.dirty {
				b.readChanges()
			}
		}
	}, func(r any) { r.(func())() })
}

type goChanges struct {
	Seq   int               `json:"seq"`
	URL   string            `json:"url"`
	Title string            `json:"title"`
	Ops   []json.RawMessage `json:"ops"`
}

// readChanges reads what's changed in the document since it was last
// read, and sends it.
func (b *goBrowser) readChanges() {
	if b.reading || b.againGen != 0 || b.world == 0 || b.shown != b.gen || b.loading != 0 {
		return
	}
	gen, world := b.gen, b.world
	b.reading, b.dirty, b.lastRead = true, false, time.Now()
	b.job(func() any {
		ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
		defer cancel()
		_, raw, err := b.evaluate(ctx, world, "__tabtop.changes()")
		return func() {
			b.reading = false
			if gen != b.gen || b.loading != 0 {
				return
			}
			if err != nil || len(raw) > goChangesLimit {
				b.readAgain(gen) // read it all again
				return
			}
			if raw == "" {
				return
			}
			var c goChanges
			if json.Unmarshal([]byte(raw), &c) != nil || c.Seq != b.seq+1 {
				b.readAgain(gen)
				return
			}
			b.seq = c.Seq
			b.lastChange = time.Now()
			if c.URL != b.url {
				if u, err := goURL(c.URL); err == nil {
					// The page changed its address itself (history.pushState).
					b.url = u
					b.send(map[string]any{"type": "go-url", "gen": gen, "url": u, "title": goTitleOf(c.Title)})
				}
			}
			if len(c.Ops) > 0 {
				ops := goCleanOps(c.Ops)
				goDebugf("changes gen %d seq %d: %d ops", gen, c.Seq, len(ops))
				p, _ := json.Marshal(map[string]any{"type": "go-changes", "gen": gen, "seq": c.Seq, "title": goTitleOf(c.Title), "ops": ops})
				b.t.Write(context.Background(), websocket.MessageText, p)
			}
			if b.dirty {
				b.readChanges()
			}
		}
	}, func(r any) { r.(func())() })
}

// goCleanOps takes event handler attributes and what's never shown out of a
// batch of changes, as goClean does a snapshot.
func goCleanOps(raw []json.RawMessage) []any {
	var out []any
	for _, r := range raw {
		var op struct {
			O string    `json:"o"`
			I int       `json:"i"`
			N string    `json:"n"`
			V *string   `json:"v"`
			C []*goNode `json:"c"`
		}
		if json.Unmarshal(r, &op) != nil {
			continue
		}
		switch op.O {
		case "c":
			kids := []any{}
			for _, k := range op.C {
				if k == nil {
					continue
				}
				if k.Type == 0 { // a reference to a node already shown: {i, r}
					kids = append(kids, map[string]any{"i": k.ID, "r": 1})
				} else if c := goClean(k); c != nil {
					kids = append(kids, c)
				}
			}
			out = append(out, map[string]any{"o": "c", "i": op.I, "c": kids})
		case "a":
			if strings.HasPrefix(strings.ToLower(op.N), "on") {
				continue
			}
			out = append(out, map[string]any{"o": "a", "i": op.I, "n": op.N, "v": op.V})
		case "t", "v":
			v := ""
			if op.V != nil {
				v = *op.V
			}
			out = append(out, map[string]any{"o": op.O, "i": op.I, "v": v})
		}
	}
	return out
}

// act does what the person did, in the page, then reads what it changed.
func (b *goBrowser) act(m goClientMsg) {
	switch m.Kind {
	case "click", "input", "change", "key", "submit", "focus":
	default:
		return
	}
	if len(m.Value) > maxGoURL*8 {
		return
	}
	if b.acts.waiting() >= goActsWaiting {
		return // the page isn't keeping up (stuck, or a dialog's open): dropped
	}
	a, _ := json.Marshal(map[string]any{"kind": m.Kind, "id": m.ID, "value": m.Value, "checked": m.Checked, "key": m.Key,
		"code": m.Code, "shift": m.Shift, "ctrl": m.Ctrl, "alt": m.Alt, "meta": m.Meta, "submitter": m.Submitter})
	arg, _ := json.Marshal(string(a))
	world, gen := b.world, b.gen
	// On the acts' queue, in order (typing, then the Enter that uses it),
	// not the worker's: an act may open a dialog, which stops the page
	// until answered, and reads mustn't wait behind it.
	b.acts.add(func() {
		ctx, cancel := context.WithTimeout(context.Background(), goActTimeout)
		defer cancel()
		_, res, err := b.evaluate(ctx, world, "__tabtop.act("+string(arg)+")")
		goDebugf("act %s %d: %s %v", m.Kind, m.ID, res, err)
		b.post(func() {
			if gen != b.gen || b.dialog {
				return
			}
			if err != nil {
				b.snapshot(gen, true) // the document went: read it again
				return
			}
			// What it changed, now and once more in a moment, the address
			// included (history.pushState, a fragment), which the page may
			// change after the act, and no change to the document shows.
			b.dirty = true
			b.readChanges()
			go func() {
				select {
				case <-time.After(300 * time.Millisecond):
					b.post(func() { b.changed(0) })
				case <-b.stop:
				}
			}()
		})
	})
}
