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
	"bytes"
	"compress/flate"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

//go:embed goagent.js
var goAgentJS string

// goObserveJS is the page's IntersectionObserver, run before its scripts
// (see goobserve.js).
//
//go:embed goobserve.js
var goObserveJS string

// goFetchJS is the page's fetch, patched for data: URLs, run before its
// scripts (see gofetch.js).
//
//go:embed gofetch.js
var goFetchJS string

// goMediaJS has the page's audio and video say what the person's browser
// found of their files (their size, their length), for engines that have
// no media of their own.
//
//go:embed gomedia.js
var goMediaJS string

// goSheetsJS tells the agent the rules a page's script put into its
// <style> elements (gosheets.js).
//
//go:embed gosheets.js
var goSheetsJS string

// goDialogsJS tells the agent what the page asked by alert, confirm and
// prompt, for an engine that answers them itself (goAdapter.noDialogs).
//
//go:embed godialogs.js
var goDialogsJS string

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
	t msgConn
	e *goEngine
	// The account's cookies (gocookies.go), and this tab's part of them.
	jar     *goCookieJar
	cookies goCookieTab
	// What it says it is (gouseragent.go): the engine's own, or, on a
	// phone (phone, set by a job), Chrome on Android's.
	engineUA  string
	uaMu      sync.Mutex
	userAgent string
	phone     bool
	cdp       *cdpConn
	page      string // the CDP session of its page
	target    string // its page's target
	frame     string // its main frame

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
	lastChange time.Time      // when the document last changed
	dialog     bool           // a dialog is open
	dialogMsg  map[string]any // what was sent of it (go-dialog)
	// navCancel gives up the load under way (navigate).
	navCancel context.CancelFunc
	// The generation whose load failed (Page.navigate's error), and where
	// it was to go.
	failed    int
	failedURL string
	// The generation whose document is the proxy's refusal, and why.
	refused    int
	refusedWhy string
	// The page's last events, by method and parameters (see ours).
	seenEvents [32]string
	seenAt     int
	// The dialogs the page shown (of gen askedGen) has opened, and the gen
	// of the page the person said may ask no more (answered here instead).
	asked, askedGen, quiet int
	popups                 map[string]bool
	// What the person's browser saw of observed elements, waiting to be
	// handed to the page (newest per element), and whether a handing over
	// is queued: one at a time, so they can't fill the acts' queue.
	ioWaiting map[[2]int]goIOEntry
	ioQueued  bool
	// The person's mouse: the move and wheel turn waiting, and whether one's
	// queued; the buttons held (the acts' queue's own, see goinput.go).
	moveWaiting, wheelWaiting, touchWaiting, dragWaiting *goClientMsg
	movesQueued                                          bool
	input                                                *goInput

	// The page's resources (goprefetch.go): fetched with resources, as
	// session's; kept in res; requests being answered. ctx ends with the
	// tab.
	resources *http.Client
	session   string
	res       *goResCache
	serving   int
	// What's being fetched ahead for the page shown (goprefetch.go).
	prefetcher *goPrefetcher
	// The page's frames from other origins, by CDP frame id; whether
	// they're being read, when they last were, and what's been sent of
	// them this second (goframes.go).
	children       map[string]*goChild
	framesReading  bool
	framesAt       time.Time
	framesBudgetAt time.Time
	framesSent     int
	ctx            context.Context
	cancel         context.CancelFunc
	deflate        bool // the page takes large messages compressed (sendLarge)
	// The page's requests not yet answered, and whether it was last said to
	// be busy loading (network): the page shown waits for it to settle.
	inflight map[string]bool
	netBusy  bool
	view     goView // the engine's window, as last set (zero: its own)

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
	Op        string  `json:"op"`
	URL       string  `json:"url"`
	Gen       int     `json:"gen"`
	Kind      string  `json:"kind"`
	ID        int     `json:"id"`
	Value     string  `json:"value"`
	Checked   bool    `json:"checked"`
	Key       string  `json:"key"`
	Code      string  `json:"code"`
	Shift     bool    `json:"shift"`
	Ctrl      bool    `json:"ctrl"`
	Alt       bool    `json:"alt"`
	Meta      bool    `json:"meta"`
	Submitter int     `json:"submitter"`
	Accept    bool    `json:"accept"`
	Quiet     bool    `json:"quiet"` // dialog: let this page ask no more
	Text      string  `json:"text"`
	View      *goView `json:"view"` // navigate, viewport: the frame's size
	// io: what the person's browser saw of the elements the page observes.
	Entries []goIOEntry `json:"entries"`
	// Real input (goinput.go). Mouse: Type move, down, up, cancel or wheel;
	// where within the element (fractions), which button and buttons, the
	// click count, the wheel's turn. Keys: Type down or up, the key's code,
	// where on the keyboard, held down.
	Type     string  `json:"type"`
	FX       float64 `json:"fx"`
	FY       float64 `json:"fy"`
	Button   int     `json:"button"`
	Buttons  int     `json:"buttons"`
	Count    int     `json:"count"`
	DX       float64 `json:"dx"`
	DY       float64 `json:"dy"`
	KeyCode  int     `json:"keyCode"`
	Location int     `json:"location"`
	Repeat   bool    `json:"repeat"`
	// scroll: where the person scrolled the element to.
	SX float64 `json:"sx"`
	SY float64 `json:"sy"`
	// touch: Type start, move, end or cancel; the fingers down, and
	// whether it was a tap (an end that didn't move).
	// mouse in an embedded page: its element, by the frame's own number
	// (ID being its iframe's).
	Frame  int            `json:"frame"`
	FDoc   int            `json:"fdoc"` // which of its documents Frame is of (its world, as its copy came)
	Points []goTouchPoint `json:"points"`
	Tap    bool           `json:"tap"`
	// drag: Type over, drop or cancel, at the element and place a mouse
	// event's are; what's dragged in from outside (its kinds, as it's
	// dragged over; itself, dropped).
	Items []goDragItem `json:"items"`
	// res: the page's request for a resource, by its number (goprefetch.go).
	RID int `json:"rid"`
	// res of media: the range of it (Length 0: its first byte, to learn
	// of it), and the file as it was opened.
	Offset  int64  `json:"offset"`
	Length  int64  `json:"length"`
	IfSize  int64  `json:"if_size"`
	IfMtime string `json:"if_mtime"`
}

// goIO is one of a page's IntersectionObserver targets, for the client to
// observe: added ("+", with its options) or no longer ("-"); or a
// ResizeObserver's (S, the box it watches; see goobserve.js).
type goIO struct {
	Op string    `json:"op"`
	O  int       `json:"o"`
	I  int       `json:"i"`
	M  string    `json:"m,omitempty"`
	T  []float64 `json:"t,omitempty"`
	R  int       `json:"r,omitempty"`
	S  string    `json:"s,omitempty"`
}

// goIOEntry is what the client saw of one: whether it shows, and how much.
type goIOEntry struct {
	O     int     `json:"o"`
	I     int     `json:"i"`
	Hit   bool    `json:"hit"`
	Ratio float64 `json:"ratio"`
	// Where it is, what of it shows and the root's bounds, as shown there:
	// x, y, width, height (nil if not known).
	B  []float64 `json:"b,omitempty"`
	R  []float64 `json:"r,omitempty"`
	RB []float64 `json:"rb,omitempty"`
	// A ResizeObserver's: the element's sizes there (client, scroll and
	// offset width and height, its content box's width and height).
	Z []float64 `json:"z,omitempty"`
}

// goSizes is z if it's sizes within reason, or nil.
func goSizes(z []float64) []float64 {
	if len(z) != 8 {
		return nil
	}
	for _, v := range z {
		if !(v >= 0 && v < 1e6) { // NaN too
			return nil
		}
	}
	return z
}

// goRect is r if it's a rectangle within reason, or nil.
func goRect(r []float64) []float64 {
	if len(r) != 4 {
		return nil
	}
	for _, v := range r {
		if !(v > -1e6 && v < 1e6) { // NaN too
			return nil
		}
	}
	return r
}

const (
	maxGoIO        = 5000 // targets in a snapshot or batch
	maxGoIOEntries = 1000 // entries in one message from the client
)

var goIOMargin = regexp.MustCompile(`^(-?(\d+(\.\d+)?|\.\d+)(px|%)( |$)){1,4}$`)

// goCleanIO keeps what's well formed of a page's observed targets: it's the
// page's (its own script could send anything), and goes to the client's
// real IntersectionObserver.
func goCleanIO(list []goIO) []goIO {
	out := []goIO{}
	for _, x := range list {
		if len(out) >= maxGoIO {
			break
		}
		if x.O <= 0 || x.I <= 0 || x.R < 0 {
			continue
		}
		switch x.Op {
		case "-":
			out = append(out, goIO{Op: "-", O: x.O, I: x.I})
		case "+":
			if x.S != "" {
				switch x.S {
				case "content-box", "border-box", "device-pixel-content-box":
					out = append(out, goIO{Op: "+", O: x.O, I: x.I, S: x.S})
				}
				continue
			}
			if len(x.M) > 64 || !goIOMargin.MatchString(x.M) || len(x.T) == 0 || len(x.T) > 101 {
				continue
			}
			ok := true
			for _, t := range x.T {
				ok = ok && t >= 0 && t <= 1
			}
			if ok {
				out = append(out, goIO{Op: "+", O: x.O, I: x.I, M: x.M, T: x.T, R: x.R})
			}
		}
	}
	return out
}

// goView is the size of the person's frame, which the engine's window is
// made: CSS pixels, and the device pixel ratio.
type goView struct {
	W   int     `json:"w"`
	H   int     `json:"h"`
	DPR float64 `json:"dpr"`
	// The display the page is told of: the person's window (the frame's
	// within it), not their screen.
	SW int `json:"sw"`
	SH int `json:"sh"`
	// The person's device has touch: the page is told so, and given it.
	Touch bool `json:"touch"`
}

// clamped is v within what's sensible to lay a page out at.
func (v goView) clamped() goView {
	v.W = min(max(v.W, 160), 7680)
	v.H = min(max(v.H, 160), 4320)
	if !(v.DPR >= 0.5) { // NaN too
		v.DPR = 1
	}
	v.DPR = min(v.DPR, 4)
	// At least the window's: the display holds it.
	v.SW = min(max(v.SW, v.W), 7680)
	v.SH = min(max(v.SH, v.H), 4320)
	return v
}

func newGoBrowser(t msgConn, e *goEngine, cdp *cdpConn, page, target string) *goBrowser {
	ctx, cancel := context.WithCancel(context.Background())
	return &goBrowser{t: t, e: e, cdp: cdp, page: page, target: target, popups: map[string]bool{},
		input: &goInput{pressed: map[int]goPress{}}, res: newGoResCache(), ctx: ctx, cancel: cancel,
		jobs: newGoQueue(), acts: newGoQueue(), results: make(chan func(), 16), stop: make(chan struct{})}
}

// goNetBusy is how many of a page's requests may be going and it still be
// idle: some never end (a long poll, a stream), and analytics beacons
// mustn't hold a page back. (The page shown holds back a while at most.)
const goNetBusy = 2

// network follows the page's requests, and tells the page shown when it
// starts or stops having more than goNetBusy going.
func (b *goBrowser) network(ev cdpEvent) {
	var p struct {
		RequestID string `json:"requestId"`
	}
	if json.Unmarshal(ev.Params, &p) != nil || p.RequestID == "" {
		return
	}
	if b.inflight == nil {
		b.inflight = map[string]bool{}
	}
	if ev.Method == "Network.requestWillBeSent" {
		if len(b.inflight) < 1000 {
			b.inflight[p.RequestID] = true
		}
	} else {
		delete(b.inflight, p.RequestID)
	}
	if busy := len(b.inflight) > goNetBusy; busy != b.netBusy {
		b.netBusy = busy
		b.send(map[string]any{"type": "go-net", "gen": b.gen, "busy": busy})
	}
}

// goDeflateFrom is the size a message is compressed from (sendLarge).
const goDeflateFrom = 16 << 10

// sendLarge sends a JSON message that may be large (a snapshot, a batch
// of changes, a frame's page): compressed, if the page takes it and it's
// worth it, as a binary message of request number 0 (four zero bytes, as
// a resource's bytes have their request's, goprefetch.go) then raw
// deflate; else as text. Snapshots shrink four to seven times: what's
// compressed is the page's own content, which its site has already.
func (b *goBrowser) sendLarge(p []byte) error {
	if b.deflate && len(p) >= goDeflateFrom {
		var z bytes.Buffer
		z.Write([]byte{0, 0, 0, 0})
		w, _ := flate.NewWriter(&z, flate.BestSpeed)
		w.Write(p)
		w.Close()
		if z.Len() < len(p)*9/10 {
			return b.t.Write(context.Background(), websocket.MessageBinary, z.Bytes())
		}
	}
	return b.t.Write(context.Background(), websocket.MessageText, p)
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
	defer b.cancel()
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
	// The page's fetch, patched for data: URLs (gofetch.js), and its
	// IntersectionObserver stand-in (goobserve.js), in every document from
	// now on, before its own scripts: queued before any navigation.
	b.job(func() any {
		ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
		defer cancel()
		source := goFetchJS + "\n" + goObserveJS + "\n" + goMediaJS + "\n" + goSheetsJS
		if b.e != nil && b.e.adapter.noDialogs {
			source += "\n" + goDialogsJS
		}
		return b.cdp.call(ctx, b.page, "Page.addScriptToEvaluateOnNewDocument", map[string]any{"source": source}, nil)
	}, func(r any) { goDebugf("fetch for data:, observer stand-in: %v", r) })
	ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
	b.cdp.call(ctx, "", "Target.setDiscoverTargets", map[string]any{"discover": true}, nil)
	cancel()
	// Changes are polled for: a CDP binding the agent could signal by
	// stops Moli (1.1.25) following links within a page.
	poll := time.NewTicker(goPollEvery)
	defer poll.Stop()
	// What its sites set in cookies, taken now and then (gocookies.go).
	cookieSync := time.NewTicker(goCookiesEvery)
	defer cookieSync.Stop()

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
				if m.View != nil {
					b.setView(*m.View) // before the page loads, at its size
				}
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
			case "viewport":
				if m.View != nil {
					b.setView(*m.View)
				}
			case "res":
				// A resource for the page shown, from any generation: a
				// page being left may still ask, and it's kept.
				b.serveRes(m)
			case "io":
				// Not the person's doing as such: a page can make what it
				// observes come and go by itself, and mustn't keep the
				// watchdog from seeing it busy.
				if m.Gen == b.shown && m.Gen == b.gen {
					b.giveIO(m.Entries)
				}
			case "dialog":
				if m.Quiet && !b.dialog {
					b.quiet = b.gen // shown what it asked: no more of it
				}
				if b.dialog {
					if m.Quiet {
						b.quiet = b.gen
					}
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
		case <-cookieSync.C:
			go b.syncCookies()
		case <-poll.C:
			// Often while the page changes; once a second once it's
			// been still a while.
			if time.Since(b.lastChange) < goPollQuiet || time.Since(b.lastRead) >= time.Second {
				b.dirty = true
				b.readChanges()
			}
			b.framesSoon() // other origins' frames: once a second
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

// askAgain sends the open dialog again, of the generation now loading: a
// page that asked and then went (Lightpanda loads a window the page opens
// in its place, a dialog still open) is still waiting, and the page here
// closes a dialog when a load starts.
func (b *goBrowser) askAgain() {
	if b.dialog && b.dialogMsg != nil {
		b.dialogMsg["gen"] = b.gen
		b.send(b.dialogMsg)
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
	b.askAgain()
	// A load another one replaces is given up: its Page.navigate (which an
	// engine may leave unanswered, sent while a dialog held the page) mustn't
	// hold up the jobs behind it, the next load and its snapshot among them.
	if b.navCancel != nil {
		b.navCancel()
	}
	ctx, cancel := context.WithTimeout(context.Background(), goLoadTimeout)
	b.navCancel = cancel
	b.job(func() any {
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
				b.failed, b.failedURL = gen, u
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

// giveIO hands what the person's browser saw of the page's observed
// elements to the page, on the acts' queue (the page's callbacks run then,
// and may open a dialog): at most one handing over queued, the rest
// waiting for it, newest kept.
func (b *goBrowser) giveIO(entries []goIOEntry) {
	if b.ioWaiting == nil {
		b.ioWaiting = map[[2]int]goIOEntry{}
	}
	for _, e := range entries[:min(len(entries), maxGoIOEntries)] {
		if e.O > 0 && e.I > 0 && len(b.ioWaiting) < maxGoIO {
			e.Ratio = min(max(e.Ratio, 0), 1)
			e.B, e.R, e.RB, e.Z = goRect(e.B), goRect(e.R), goRect(e.RB), goSizes(e.Z)
			b.ioWaiting[[2]int{e.O, e.I}] = e
		}
	}
	if b.ioQueued || len(b.ioWaiting) == 0 || b.world == 0 {
		return
	}
	list := make([]goIOEntry, 0, len(b.ioWaiting))
	for _, e := range b.ioWaiting {
		list = append(list, e)
	}
	b.ioWaiting = nil
	b.ioQueued = true
	a, _ := json.Marshal(list)
	arg, _ := json.Marshal(string(a))
	world, gen := b.world, b.gen
	b.acts.add(func() {
		ctx, cancel := context.WithTimeout(context.Background(), goActTimeout)
		defer cancel()
		_, res, err := b.evaluate(ctx, world, "__tabtop.io("+string(arg)+")")
		goDebugf("io: %d entries, %s %v", len(list), res, err)
		b.post(func() {
			b.ioQueued = false
			if gen != b.gen {
				b.ioWaiting = nil
				return
			}
			b.changed(goChangesEvery) // what the page's callbacks did
			b.giveIO(nil)             // and what came meanwhile
		})
	})
}

// setView makes the engine's window v's size, if it isn't already: the
// page sees it (innerWidth, media queries, resize events) and is laid out
// at it. Its layout is computed again (a screenshot of one pixel does
// that; a resize alone doesn't), and what the page changed is read. An
// engine that can't is left as it was.
func (b *goBrowser) setView(v goView) {
	v = v.clamped()
	if v == b.view {
		return
	}
	touch := v.Touch != b.view.Touch || b.view == (goView{})
	b.view = v
	b.job(func() any {
		ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
		defer cancel()
		if goPhone(v) {
			b.phoneUA(ctx) // before what's loaded next: it's asked for as a phone
		}
		err := b.cdp.call(ctx, b.page, "Emulation.setDeviceMetricsOverride", map[string]any{
			"width": v.W, "height": v.H, "deviceScaleFactor": v.DPR, "mobile": false,
			// The screen is the person's window: their own isn't told.
			"screenWidth": v.SW, "screenHeight": v.SH,
		}, nil)
		if err == nil && touch {
			// Touch points only when it's on (Moli refuses 0); and an engine
			// that can't is laid out at the new size all the same.
			p := map[string]any{"enabled": v.Touch}
			if v.Touch {
				p["maxTouchPoints"] = 5
			}
			if terr := b.cdp.call(ctx, b.page, "Emulation.setTouchEmulationEnabled", p, nil); terr != nil {
				goDebugf("touch emulation %v: %v", v.Touch, terr)
			}
		}
		if err == nil {
			err = b.relayout(ctx)
		}
		return err
	}, func(r any) {
		goDebugf("view %dx%d at %g on %dx%d, touch %v: %v", v.W, v.H, v.DPR, v.SW, v.SH, v.Touch, r)
		b.changed(goChangesEvery)
	})
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
	if !b.ours(ev) {
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
		if b.dialog {
			goDebugf("dialog %s opened with one open", p.Type)
		}
		b.dialog = true
		if p.Type == "beforeunload" {
			b.answer(true, "") // leaving goes ahead
			return loadTimeout, dialogTimeout
		}
		// A page that asks again and again (in a loop, on every key) would
		// keep the person answering: once they've said it may ask no
		// more, it's answered here, as a browser that stops a page's
		// dialogs does: OK to an alert, no to a question.
		if b.askedGen != b.gen {
			b.askedGen, b.asked = b.gen, 0
		}
		b.asked++
		if b.quiet == b.gen {
			b.answer(false, "")
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
		goDebugf("dialog %s (%d of gen %d) opened", p.Type, b.asked, b.gen)
		b.dialogMsg = map[string]any{"type": "go-dialog", "gen": b.gen, "kind": p.Type, "message": p.Message, "default": p.Default, "url": from, "again": b.asked > 1}
		b.send(b.dialogMsg)
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
		if b.frame != "" && p.Frame.ID != "" && p.Frame.ID != b.frame && !b.popups[p.Frame.ID] {
			// Another top-level frame: a window the page opened, that an
			// engine keeps as a frame of this target (Lightpanda), not a
			// target of its own. Its address is loaded in this tab instead,
			// as a popup's is (Target.targetCreated, above).
			if u, err := goURL(p.Frame.URL); err == nil {
				b.popups[p.Frame.ID] = true
				loadTimeout = b.navigate(u, "page")
			}
			break
		}
		goDebugf("frame navigated (loading %d)", b.loading)
		b.frame = p.Frame.ID
		b.world, b.dirty = 0, false // a new document, a new world
		b.children = nil            // and its own frames
		b.inflight, b.netBusy = nil, false
		b.docURL = ""
		if u, err := goURL(p.Frame.URL); err == nil {
			b.docURL = u
		}
		if b.loading != 0 {
			b.navigated = true
		} else if u, err := goURL(p.Frame.URL); err == nil && b.failed == b.gen && u == b.failedURL {
			// The engine's own page for the load that failed (Lightpanda
			// commits one): not the page going anywhere.
		} else if u, err := goURL(p.Frame.URL); err == nil {
			// The page went somewhere by itself: a link, a form, a
			// redirect by script.
			b.gen++
			b.loading, b.navigated = b.gen, true
			b.send(map[string]any{"type": "go-loading", "gen": b.gen, "url": u, "by": "page"})
			loadTimeout = time.After(goLoadTimeout)
			b.askAgain()
		}
	case "Network.responseReceived":
		var p struct {
			Type     string `json:"type"`
			FrameID  string `json:"frameId"`
			Response struct {
				MimeType string            `json:"mimeType"`
				Headers  map[string]string `json:"headers"`
			} `json:"response"`
		}
		json.Unmarshal(ev.Params, &p)
		if p.Type == "Document" && (p.FrameID == b.frame || b.frame == "") {
			// The proxy's refusal, shown as the page by an engine that
			// doesn't fail the load (Obscura): the person's told instead.
			for k, v := range p.Response.Headers {
				if msg, ok := goRefusals[v]; ok && strings.EqualFold(k, goRefusedHeader) {
					b.refused, b.refusedWhy = b.gen, msg
				}
			}
			// Its type alone: Moli keeps its parameters (charset), as
			// Chrome doesn't.
			media, _, _ := strings.Cut(p.Response.MimeType, ";")
			b.docType = strings.ToLower(strings.TrimSpace(media))
		}
	case "Network.requestWillBeSent", "Network.loadingFinished", "Network.loadingFailed":
		b.network(ev)
	case "Page.domContentEventFired", "Page.loadEventFired":
		// The page is shown once its document's been read and its deferred
		// scripts have run (DOMContentLoaded), not after everything it loads
		// (the load event, up to seconds later): what it does after comes
		// as changes, as anything later does.
		if b.loading != 0 && b.navigated {
			gen := b.loading
			b.loading, loadTimeout = 0, nil
			b.snapshot(gen, false)
		} else if ev.Method == "Page.loadEventFired" {
			b.changed(0) // what it did as it finished loading
		}
	case "Page.navigatedWithinDocument":
		// A fragment followed: the address, read with the next changes.
		b.changed(0)
	}
	return loadTimeout, dialogTimeout
}

// ours is whether ev is an event of the page's to act on: on the session
// tabtopd attached; or, with an engine that sends its page's events on a
// session of its own too (goAdapter.anySession: some on both, some on its
// own only), on any session, but once: one that's the same as one of the
// last few is a copy, passed over.
func (b *goBrowser) ours(ev cdpEvent) bool {
	if b.e == nil || !b.e.adapter.anySession {
		return ev.SessionID == b.page
	}
	if ev.SessionID == "" {
		return false
	}
	key := ev.Method + " " + string(ev.Params)
	for _, seen := range b.seenEvents {
		if seen == key {
			return false
		}
	}
	b.seenEvents[b.seenAt%len(b.seenEvents)] = key
	b.seenAt++
	return true
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
	goDebugf("dialog answered: %v", accept)
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
	IO    []goIO  `json:"io"`
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
			if b.failed == gen {
				// Failed to load (the person's told): what the engine
				// shows in its place (Lightpanda commits a page of its
				// own) isn't shown here.
				return
			}
			if b.refused == gen {
				// Not a page: the proxy's refusal (see responseReceived).
				b.loading = 0
				b.fail(gen, "The page couldn't be loaded: "+b.refusedWhy)
				return
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
			p, err := json.Marshal(map[string]any{"type": "go-snapshot", "gen": gen, "url": s.URL, "base": s.Base, "title": goTitleOf(s.Title), "doc": s.Doc, "again": again, "io": goCleanIO(s.IO)})
			if err != nil || len(p) > goSnapshotLimit {
				b.fail(gen, "The page is too large to show.")
				return
			}
			b.shown, b.seq, b.lastChange = gen, 0, time.Now()
			if !again {
				b.visited(s.URL)
				go b.syncCookies() // what it set as it loaded
			}
			b.framesAgain() // its iframes were drawn empty
			if !again {
				b.prefetch(s.Doc, s.Base) // what it'll ask for, on its way
			}
			goDebugf("snapshot gen %d, %d bytes", gen, len(p))
			b.sendLarge(p)
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
	IO    []goIO            `json:"io"`
	// Again: what changed can't be said as changes (the engine named nodes
	// of the page's world): the document's to be read again whole.
	Again bool `json:"again"`
	// What the page asked by alert, confirm or prompt, with an engine that
	// answered it itself (godialogs.js).
	Asked []struct {
		Kind    string `json:"kind"`
		Message string `json:"message"`
	} `json:"asked"`
	// Where the page scrolled its elements itself (goobserve.js).
	Scrolls []goScroll `json:"scrolls"`
}

// goScroll is where the page scrolled one of its elements itself, for the
// client to scroll its copy so: to x, y, or into view (Into: block, inline).
type goScroll struct {
	I    int       `json:"i"`
	X    float64   `json:"x"`
	Y    float64   `json:"y"`
	Into [2]string `json:"into"`
}

// goCleanScrolls keeps what's well formed of where the page scrolled: it's
// the page's (its own script could say anything).
func goCleanScrolls(list []goScroll) []map[string]any {
	out := []map[string]any{}
	where := map[string]bool{"start": true, "center": true, "end": true, "nearest": true}
	for _, s := range list {
		if len(out) >= 64 {
			break
		}
		switch {
		case s.I <= 0:
		case s.Into != [2]string{}:
			if where[s.Into[0]] && where[s.Into[1]] {
				out = append(out, map[string]any{"i": s.I, "into": s.Into})
			}
		case s.X >= 0 && s.X < 1e7 && s.Y >= 0 && s.Y < 1e7:
			out = append(out, map[string]any{"i": s.I, "x": s.X, "y": s.Y})
		}
	}
	return out
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
			if c.Again {
				goDebugf("changes gen %d seq %d: read again (nodes of another world)", gen, c.Seq)
				b.readAgain(gen)
				return
			}
			if c.URL != b.url {
				if u, err := goURL(c.URL); err == nil {
					// The page changed its address itself (history.pushState).
					b.url = u
					b.send(map[string]any{"type": "go-url", "gen": gen, "url": u, "title": goTitleOf(c.Title)})
				}
			}
			for i, q := range c.Asked {
				if i == 8 || b.quiet == gen {
					break // a page asking in a loop: the person said no more
				}
				if q.Kind != "alert" && q.Kind != "confirm" && q.Kind != "prompt" {
					continue
				}
				if len(q.Message) > 2000 {
					q.Message = q.Message[:2000] + "…"
				}
				goDebugf("dialog %s asked, answered by the engine", q.Kind)
				b.send(map[string]any{"type": "go-dialog-notice", "gen": gen, "kind": q.Kind, "message": q.Message, "url": b.docURL})
			}
			if io, scrolls := goCleanIO(c.IO), goCleanScrolls(c.Scrolls); len(c.Ops) > 0 || len(io) > 0 || len(scrolls) > 0 {
				ops := goCleanOps(c.Ops)
				goDebugf("changes gen %d seq %d: %d ops, %d observed, %d scrolled", gen, c.Seq, len(ops), len(io), len(scrolls))
				p, _ := json.Marshal(map[string]any{"type": "go-changes", "gen": gen, "seq": c.Seq, "title": goTitleOf(c.Title), "ops": ops, "io": io, "scrolls": scrolls})
				b.sendLarge(p)
			}
			if b.dirty {
				b.readChanges()
			}
		}
	}, func(r any) { r.(func())() })
}

// actNow does what the person did in the page, by script (goagent.js's
// act): on the acts' queue, from act, or from real input that couldn't be
// given (goinput.go).
func (b *goBrowser) actNow(ctx context.Context, world int, m goClientMsg) (string, error) {
	a, _ := json.Marshal(map[string]any{"kind": m.Kind, "id": m.ID, "value": m.Value, "checked": m.Checked, "key": m.Key,
		"code": m.Code, "shift": m.Shift, "ctrl": m.Ctrl, "alt": m.Alt, "meta": m.Meta, "submitter": m.Submitter, "x": m.SX, "y": m.SY})
	arg, _ := json.Marshal(string(a))
	_, res, err := b.evaluate(ctx, world, "__tabtop.act("+string(arg)+")")
	return res, err
}

// relayout has the engine lay the page out again, as it does only when
// asked for a picture (a pixel of one): a scroll, changes of class.
func (b *goBrowser) relayout(ctx context.Context) error {
	return b.cdp.call(ctx, b.page, "Page.captureScreenshot", map[string]any{
		"format": "png", "clip": map[string]any{"x": 0, "y": 0, "width": 1, "height": 1, "scale": 1},
	}, nil)
}

// goCleanOps takes event handler attributes and what's never shown out of a
// batch of changes, as goClean does a snapshot.
func goCleanOps(raw []json.RawMessage) []any {
	out := []any{} // [] if none, not null: a batch may bring only what's observed
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
		case "m": // a player started or stopped by the page
			out = append(out, map[string]any{"o": "m", "i": op.I, "v": op.V != nil && *op.V == "true"})
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
	if m.Frame != 0 {
		// In an embedded page: by its own agent, as the engine's input
		// can't be aimed there (goinput.go).
		switch {
		case m.Kind == "mouse":
			b.pointerInFrame(m)
		case m.Kind == "key" && m.Type == "up":
			// A key's press is done by script, all of it (keydown,
			// keypress, keyup; Enter sending its form): its release is in it.
		case m.Kind == "click", m.Kind == "input", m.Kind == "change", m.Kind == "key", m.Kind == "submit", m.Kind == "focus":
			if len(m.Value) <= maxGoURL*8 {
				b.actInFrame(m)
			}
		}
		return
	}
	switch {
	case m.Kind == "mouse":
		b.pointer(m) // real input (goinput.go)
		return
	case m.Kind == "touch":
		b.touch(m)
		return
	case m.Kind == "drag":
		b.drag(m)
		return
	case m.Kind == "key" && (m.Type == "down" || m.Type == "up"):
		b.key(m)
		return
	}
	switch m.Kind {
	case "click", "input", "change", "key", "submit", "focus", "scroll", "media-meta":
	default:
		return
	}
	if len(m.Value) > maxGoURL*8 {
		return
	}
	if b.acts.waiting() >= goActsWaiting {
		return // the page isn't keeping up (stuck, or a dialog's open): dropped
	}
	world, gen := b.world, b.gen
	// On the acts' queue, in order (typing, then the Enter that uses it),
	// not the worker's: an act may open a dialog, which stops the page
	// until answered, and reads mustn't wait behind it.
	b.acts.add(func() {
		ctx, cancel := context.WithTimeout(context.Background(), goActTimeout)
		defer cancel()
		res, err := b.actNow(ctx, world, m)
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
