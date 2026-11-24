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
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

//go:embed goagent.js
var goAgentJS string

// goCanvasJS watches the page's Canvas2D draw calls before its scripts run.
// The isolated agent reads pixels only after a draw or during a snapshot.
//
//go:embed gocanvas.js
var goCanvasJS string

//go:embed gogl.js
var goGLJS string

//go:embed gogl-enums.js
var goGLEnumsJS string

//go:embed goglsl.js
var goGLSLJS string

//go:embed gogl-surface.js
var goGLSurfaceJS string

// goGLPageJS is the page's WebGL hook: the calls and extensions it
// records, its constants and its reading of shaders' source, then the hook,
// in one function, so that their names are
// its own, not the page's. (test/gogl.test.mjs puts them together the same
// way.)
var goGLPageJS = "(() => {\n" + goGLSurfaceJS + "\n" + goGLEnumsJS + "\n" + goGLSLJS + "\n" + goGLJS + "\n})();\n"

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

//go:embed goeme.js
var goEMEJS string

// goSheetsJS tells the agent the rules a page's script put into its
// <style> elements (gosheets.js).
//
//go:embed gosheets.js
var goSheetsJS string

// goShadowJS has the page's shadow roots read by the agent: a closed one
// made open (the page told it's closed), each one attached said
// (goshadow.js).
//
//go:embed goshadow.js
var goShadowJS string

// goDialogsJS tells the agent what the page asked by alert, confirm and
// prompt, for an engine that answers them itself (goAdapter.noDialogs).
//
//go:embed godialogs.js
var goDialogsJS string

// goClipboardJS passes on what the page copies, and asks the person for
// what it reads of the clipboard (goclipboard.go).
//
//go:embed goclipboard.js
var goClipboardJS string

// goFullscreenJS gives the page fullscreen, asked of the server
// (gofullscreen.go).
//
//go:embed gofullscreen.js
var goFullscreenJS string

//go:embed godevice.js
var goDeviceJS string

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
	goChangesLimit = 8 << 20
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
	jar        *goCookieJar
	storage    *goStorage
	storageTab goStorageTab
	// topFrame is the engine's top frame, whose documents are paused as
	// they're asked for (startStorage); "" if they aren't.
	topFrame string
	// adCount is the hosts refused as ads' for the page (goadblock.go).
	adCount goAdCount
	// streams are the streams the page plays: Save stream (gostreams.go).
	streams goStreams
	// colors is what its pages are told of light or dark (gotheme.go).
	colors goColors
	// hider is what's hidden on the page, as its classes and ids come
	// (goadblock.go); nil for nothing.
	hideMu  sync.Mutex
	hider   *goAdHider
	cookies goCookieTab
	// The site settings (gosites.go), and the pop-ups the person's asked about.
	sites     *goSiteSettings
	popupAsk  int
	popupAsks map[int]goPopupAsk
	// Reads of the clipboard the page asked for, waiting for the person,
	// by token (goclipboard.go).
	pasteAsks map[string]*goPasteAsk
	// The page's fullscreen, allowed (gofullscreen.go).
	fullscreen *goFullscreen
	// Its notifications (gonotify.go).
	notifying                     goNotifyTab
	devicePolicy, devicePolicyURL string
	viewerCaps                    goViewerCaps
	device                        *goDevicePending
	fs                            goFileSystem
	pip                           *goDevicePending
	imagePaste                    *goImagePaste
	// The script telling pages what the person's browser can do (godevice.go:
	// the jobs' worker's alone).
	deviceScript string
	// A position followed (watchPosition: godevice.go), and when it was
	// last passed on.
	locWatch       *goDevicePending
	locWatchAt     time.Time
	imagePasteBusy bool
	// Streams by the document that sent them first, and the frames that
	// have streamed lately, asked often (goframestreams.go).
	streamOwners  goStreamOwners
	streamWorlds  map[int]time.Time
	streamPolling bool
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
	lastAgain time.Time
	againGen  int
	againSoon <-chan time.Time
	reading   bool // a read of changes is going
	// glStreams are the WebGL streams of the document shown, by canvas
	// (goGLStream): set by each snapshot, carried on by its changes.
	glStreams  map[int]*goGLStream
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
	// certs are the tab's certificate exceptions (gocert.go); certWarned,
	// the host and address last warned of, the only ones Continue takes.
	certs                    *goCertExceptions
	certWarned, certWarnedAt string
	certWarnedRevoked        bool      // (the warning's for a revocation: gorevoke.go)
	docRequest               [2]string // the page's own document's request, and its address
	certErrText              string    // its certificate error, the engine's words
	certRetried              string    // a document the proxy refused (the engine ignoring errors), loaded again
	docPosted                bool      // its request isn't a GET (a form posted)
	// The closed shadow roots from its HTML, given to the agents
	// (goclosedroots.go).
	closed goClosedRoots
	// File inputs (gouploads.go): the chooser waiting for files, and
	// what's kept; and when the person last did something in the page,
	// for a chooser to be theirs.
	uploads  goUploads
	inputAt  time.Time
	inputGen int // the page it was in (a browser's activation goes with its page)
	// The world it was in: the page's agent's, or an embedded page's of
	// another origin (whose own input alone it may act on).
	inputWorld int
	// What the engine's been told of certificate errors (certIgnore's
	// alone, under certMu: the jobs and a paused document's request): 0 to
	// heed them, 1 to ignore them, -1 not known (a call that failed may
	// have been heeded).
	certMu   sync.Mutex
	certTold int8
	// certUnsupported: the engine can't ignore certificate errors (it
	// hasn't the method): no exception's continued to (cert-continue).
	certUnsupported atomic.Bool
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
	private   bool // a private tab's (goincognito.go): its fetches kept apart
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

	loadingURL string // where the generation loading goes (resume)
	// The page's requests waiting their turn (serveRes), and what those
	// being answered wait with: both ended as the page is left (leftPage).
	resQueue  []goClientMsg
	resCtx    context.Context
	resCancel context.CancelFunc
	sentGen   int // the generation of the last snapshot the person was sent (resume)

	// The person's connection, whichever is lent the tab now (none while
	// it's lost: goresume.go), as t; connections lent it come by attach.
	conn   *goConn
	attach chan *goLink
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
	Frame int   `json:"frame"`
	FDoc  int   `json:"fdoc"`            // which of its documents Frame is of (its world, as its copy came)
	Route []int `json:"route,omitempty"` // iframe owner IDs, outermost to innermost
	// Rich text (contenteditable; goinput.go): the copy's selection, [anchor,
	// offset, focus, offset] by node number; a key that edits (Edit: not
	// done in the copy, for the engine to type); an edit that isn't a key
	// (kind "edit": InputType, as a beforeinput's, and Value its text).
	Sel       []int          `json:"sel,omitempty"`
	Edit      bool           `json:"edit"`
	InputType string         `json:"inputType"`
	HTML      string         `json:"html"`           // a paste's, its text styled
	Docs      []int          `json:"docs,omitempty"` // parent document identities for Route
	Points    []goTouchPoint `json:"points"`
	Tap       bool           `json:"tap"`
	// drag: Type over, drop or cancel, at the element and place a mouse
	// event's are; what's dragged in from outside (its kinds, as it's
	// dragged over; itself, dropped).
	Items []goDragItem `json:"items"`
	// res: the page's request for a resource, by its number (goprefetch.go).
	RID int `json:"rid"`
	// res of media: the range of it (Length 0: its first byte, to learn
	// of it), and the file as it was opened.
	Offset  int64  `json:"offset"`
	Size    int64  `json:"size"`
	Length  int64  `json:"length"`
	IfSize  int64  `json:"if_size"`
	IfMtime string `json:"if_mtime"`
	// popup-answer: the pop-up (ID), opened or not (Accept), and the
	// answer kept for its site.
	Remember bool `json:"remember"`
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
	// Other: the person's switched to the other pages (the menu's Mobile
	// or Desktop, go.js): a phone's desktop ones, another's mobile ones.
	Other bool `json:"other"`
	// Which way up the device is held (screen.orientation's type, and its
	// angle), told the page as its screen's.
	Orientation string `json:"o"`
	Angle       int    `json:"a"`
	// The person's prefers-color-scheme (light or dark): the page's
	// (prefers-color-scheme: …) media queries and matchMedia follow it.
	Scheme string `json:"scheme"`
}

// goOrientations are screen.orientation's types, as CDP names them.
var goOrientations = map[string]string{
	"portrait-primary": "portraitPrimary", "portrait-secondary": "portraitSecondary",
	"landscape-primary": "landscapePrimary", "landscape-secondary": "landscapeSecondary",
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
	// Not one of its types: the screen's shape says.
	if _, ok := goOrientations[v.Orientation]; !ok {
		v.Orientation, v.Angle = "landscape-primary", 90
		if v.SH >= v.SW {
			v.Orientation, v.Angle = "portrait-primary", 0
		}
	}
	if v.Angle%90 != 0 || v.Angle < 0 || v.Angle >= 360 {
		v.Angle = 0
	}
	if v.Scheme != "light" && v.Scheme != "dark" {
		v.Scheme = "light"
	}
	return v
}

func newGoBrowser(e *goEngine, cdp *cdpConn, page, target string) *goBrowser {
	ctx, cancel := context.WithCancel(context.Background())
	conn := &goConn{}
	resCtx, resCancel := context.WithCancel(ctx)
	return &goBrowser{resCtx: resCtx, resCancel: resCancel, t: conn, conn: conn, attach: make(chan *goLink), e: e, cdp: cdp, page: page, target: target, popups: map[string]bool{},
		input: &goInput{pressed: map[int]goPress{}}, res: newGoResCache(), ctx: ctx, cancel: cancel,
		jobs: newGoQueue(), acts: newGoQueue(), results: make(chan func(), 16), stop: make(chan struct{}), certs: &goCertExceptions{}}
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
	if b.conn.deflate() && len(p) >= goDeflateFrom {
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
	lost := make(chan *goLink)
	stop := b.stop
	defer close(stop)
	defer b.cancel()
	// Whichever connection's lent it lets go as it ends.
	defer func() {
		if l := b.conn.swap(nil); l != nil {
			l.release()
		}
	}()
	// read reads what the person sends over l, till it goes.
	read := func(l *goLink) {
		go func() {
			for {
				typ, p, err := l.conn.Read(context.Background())
				var m goClientMsg
				if err == nil && (typ != websocket.MessageText || json.Unmarshal(p, &m) != nil) {
					l.conn.Close(websocket.StatusPolicyViolation, "bad message")
					err = errors.New("bad message")
				}
				if err != nil {
					select {
					case lost <- l:
					case <-stop:
					}
					return
				}
				select {
				case msgs <- m:
				case <-stop:
					return
				}
			}
		}()
	}
	// No connection: the tab runs on so long (goDetachedFor), then ends.
	var detached <-chan time.Time
	var downloadsDone <-chan struct{}
	taken := false // taken by a connection yet (the first, or one back)
	go b.jobs.run(stop)
	go b.acts.run(stop)
	// The page's fetch, patched for data: URLs (gofetch.js), and its
	// IntersectionObserver stand-in (goobserve.js), in every document from
	// now on, before its own scripts: queued before any navigation.
	b.job(func() any {
		ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
		defer cancel()
		source := goFetchJS + "\n" + goObserveJS + "\n" + goMediaJS + "\n" + goCanvasJS + "\n" + goGLPageJS + "\n" + goEMEJS + "\n" + goSheetsJS + "\n" + goShadowJS + "\n" + goClipboardJS + "\n" + goFullscreenJS
		if b.e != nil && b.e.adapter.noDialogs {
			source += "\n" + goDialogsJS
		}
		return b.cdp.call(ctx, b.page, "Page.addScriptToEvaluateOnNewDocument", map[string]any{"source": source}, nil)
	}, func(r any) { goDebugf("fetch for data:, observer stand-in: %v", r) })
	b.notifyRegister() // (the sites' notification answers: gonotify.go)
	b.deviceRegister() // (what the person's browser can do: godevice.go)
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
		case l := <-b.attach:
			// A connection: the first, or one back for the tab, or one
			// taking it from another (the same tab opened again elsewhere,
			// or the old connection not yet seen to be gone).
			if was := b.conn.swap(l); was != nil {
				// Told, and closed, aside: a connection that's gone (the
				// reason it's taken) mustn't hold the tab up.
				go func() {
					defer was.release()
					ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
					defer cancel()
					if p, err := json.Marshal(map[string]any{"type": "go-taken"}); err == nil && was.conn.Write(ctx, websocket.MessageText, p) == nil {
						closed := make(chan struct{})
						go func() {
							was.conn.Close(websocket.StatusNormalClosure, "This tab was opened in another window.")
							close(closed)
						}()
						select {
						case <-closed:
							return
						case <-ctx.Done():
						}
					}
					was.conn.CloseNow()
				}()
			}
			detached = nil
			downloadsDone = nil
			read(l)
			if taken {
				b.releaseDevices()
				b.resume()
			}
			taken = true
		case l := <-lost:
			if b.conn.link() != l {
				l.release() // one already let go
				continue
			}
			b.conn.swap(nil)
			b.releaseDevices()
			l.release()
			b.conn.detachedAt(time.Now())
			detached = time.After(goDetachedFor)
			goDebugf("tab detached: kept %v", goDetachedFor)
		case <-detached:
			detached = nil
			var retire bool
			retire, downloadsDone = b.conn.retireDetached()
			if retire {
				return
			}
		case <-downloadsDone:
			var retire bool
			retire, downloadsDone = b.conn.retireDetached()
			if retire {
				return
			}
		case m := <-msgs:
			goDebugf("op %s %s id %d gen %d (tab at gen %d, shown %d, loading %d)", m.Op, m.Kind, m.ID, m.Gen, b.gen, b.shown, b.loading)
			// What the person does (not a resync, which the client asks for
			// by itself): the engine's work for it isn't a runaway page's.
			switch m.Op {
			case "navigate", "stop", "dialog":
				b.e.use()
			case "event":
				if m.Gen == b.shown && m.Gen == b.gen {
					b.e.use()
					// A press, a key, a touch (not a move or a scroll): what a
					// browser lets a page open a chooser after.
					if m.Kind == "click" || m.Kind == "key" || m.Kind == "touch" && m.Type != "move" || m.Kind == "mouse" && (m.Type == "down" || m.Type == "up") {
						b.inputAt, b.inputGen = time.Now(), b.gen
						// And where: an embedded page of another origin's world,
						// or the page's (goclipboard.go: what's passed on of a
						// frame's is its own input's only).
						b.inputWorld = b.world
						if m.Frame != 0 {
							if w, _ := b.frameWorldPath(m.ID, m.Route, m.Docs); w != 0 {
								b.inputWorld = w
							}
						}
					}
				}
			}
			switch m.Op {
			case "close":
				// Closed by the person (its tab): not kept.
				b.t.Close(websocket.StatusNormalClosure, "This tab was closed.")
				return
			case "popup-answer":
				b.popupAnswer(m.ID, m.Accept, m.Remember)
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
			case "cert-continue":
				// Continue on a certificate warning (gocert.go): the host
				// warned of, at the address warned of, an exception for the
				// tab from now, and loaded again.
				// (Refused, said: the page shows it's loading.)
				u, err := goURL(m.URL)
				if err != nil || b.certWarned == "" || u != b.certWarnedAt {
					b.fail(b.gen, "That warning is out of date: load the page again.")
					continue
				}
				if b.certUnsupported.Load() && !b.certWarnedRevoked {
					b.fail(b.gen, "This browser's engine can't continue past a certificate warning.")
					continue
				}
				if !b.certs.add(b.certWarned, b.certWarnedRevoked) {
					b.fail(b.gen, "This tab has too many certificate exceptions: open the site in a new tab.")
					continue
				}
				b.certWarned, b.certWarnedAt, b.certWarnedRevoked = "", "", false
				loadTimeout = b.navigate(u, "you")
			case "stop":
				b.gen++
				b.loading, loadTimeout = 0, nil
				shown := b.docURL
				b.job(func() any {
					ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
					defer cancel()
					err := b.cdp.call(ctx, b.page, "Page.stopLoading", nil, nil)
					b.certIgnore(ctx, shown) // (as the page shown is: the load stopped may not have come)
					return err
				}, func(any) {})
			case "event":
				if m.Gen != b.shown || m.Gen != b.gen {
					continue // for a document that's gone
				}
				b.act(m)
			case "files":
				b.chooseFiles(m) // a chooser answered (gouploads.go)
			case "paste":
				b.paste(m) // a read of the clipboard answered (goclipboard.go)
			case "paste-part":
				b.pastePart(m) // and the picture given it, in parts
			case "notify-permission":
				b.notifyAnswer(m) // notifications allowed, or not (gonotify.go)
			case "notify-event":
				b.notifyEvent(m) // one shown, clicked or closed
			case "device-answer":
				b.deviceAnswer(m)
			case "go-fs-cancel":
				if m.Gen == b.gen {
					b.abortFSRead(m.Text)
				}
			case "paste-image":
				b.pasteImage(m)
			case "fullscreen-exit":
				b.fullscreenExit() // the person left it (gofullscreen.go)
			case "drop-files":
				b.dropStart(m) // files dropped on the page, to be sent
			case "dropped":
				b.dropFiles(m) // and sent: dropped there
			case "resync":
				if m.Gen == b.shown && b.loading == 0 {
					b.readAgain(b.gen)
				}
			case "viewport":
				if m.View != nil {
					b.setView(*m.View)
				}
			case "theme":
				// Dark mode changed (Site controls): the page told again, and
				// read again whole, for its copy's styles to go by it too
				// (goSchemeOf, go-frame.js).
				b.job(func() any { b.schemeAt(""); return nil }, func(any) {
					if b.shown == b.gen && b.gen != 0 {
						b.readAgain(b.gen)
					}
				})
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
			b.framesSoon()       // other origins' frames: once a second
			b.frameStreamsSoon() // and those streaming, as often as the page
			b.notifySoon()       // notification answers changed (gonotify.go)
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
			b.t.Close(websocket.StatusNormalClosure, "The page's engine was stopped.")
			return
		case <-b.cdp.done:
			b.fail(b.gen, "The page's engine stopped answering.")
			b.t.Close(websocket.StatusNormalClosure, "The page's engine stopped answering.")
			return
		}
	}
}

// resume tells a connection taking the tab back what's there now: the
// page loading (its snapshot follows as it would); or the page shown, read
// whole: as the same document again, if it's the one the person was last
// sent (a copy still shown keeps its place, a new one starts where the
// page is scrolled), else as a page it went to meanwhile; and what it's
// asking. A page that failed is loaded again by the person, as before.
func (b *goBrowser) resume() {
	switch {
	case b.loading != 0:
		b.send(map[string]any{"type": "go-loading", "gen": b.loading, "url": b.loadingURL, "by": "resume"})
	case b.shown == b.gen && b.gen != 0 && b.sentGen == b.gen:
		b.lastAgain = time.Time{} // at once
		b.readAgain(b.gen)
	case b.shown == b.gen && b.gen != 0 && !b.reading:
		// The page went elsewhere while no one was connected (a link, a
		// redirect, a timer): a page of its own, as it would have been,
		// with an entry of its own in the person's history.
		b.send(map[string]any{"type": "go-loading", "gen": b.gen, "url": b.url, "by": "page"})
		b.snapshot(b.gen, false)
	default:
		// Nothing shown (its load failed, or it was a file): the page
		// loads its address again, as without a tab to take back.
		b.send(map[string]any{"type": "go-reload", "gen": b.gen})
	}
	b.askAgain()
	for id, a := range b.popupAsks {
		b.send(map[string]any{"type": "go-popup-ask", "gen": b.gen, "id": id, "url": a.url, "site": a.site})
	}
	b.resendStreams() // Save stream offered again (gostreams.go)
}

// goScrollAt is where a page says it's scrolled, within reason.
func goScrollAt(at [2]float64) [2]float64 {
	for i, v := range at {
		if !(v >= 0 && v <= 1e7) {
			at[i] = 0
		}
	}
	return at
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
	b.leftPage()
	b.gen++
	gen := b.gen
	if goBlockedHost(goURLHost(u)) {
		// Not asked for: the proxy would refuse it, as anything of it.
		b.loading = 0
		b.send(map[string]any{"type": "go-loading", "gen": gen, "url": u, "by": by})
		b.fail(gen, goRefusals["blocked"])
		return nil
	}
	b.loading, b.navigated, b.world, b.dirty, b.docType = gen, false, 0, false, ""
	b.loadingURL = u
	b.pageAt(u) // going there, even to an ad's site, loads it (goadblock.go)
	b.newAdPage()
	b.popupAsks = nil // asked about by the page left: gone with it
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
	shown := b.docURL // (the page left, still shown if this load fails)
	b.job(func() any {
		defer cancel()
		var r struct {
			FrameID   string `json:"frameId"`
			LoaderID  string `json:"loaderId"`
			ErrorText string `json:"errorText"`
		}
		b.certIgnore(ctx, u) // an exception's host: its certificate's errors ignored
		err := b.cdp.call(ctx, b.page, "Page.navigate", map[string]any{"url": u}, &r)
		if err == nil && r.ErrorText != "" {
			err = errors.New(r.ErrorText)
		}
		if err != nil {
			// Not loaded: certificate errors as the page still shown is.
			cctx, ccancel := context.WithTimeout(context.Background(), goCallTimeout)
			b.certIgnore(cctx, shown)
			ccancel()
		}
		return func() {
			if r.FrameID != "" {
				b.frame = r.FrameID
			}
			if gen != b.gen {
				return // an older generation's
			}
			switch {
			case err != nil && goCertError(err.Error()):
				b.loading = 0
				b.failed, b.failedURL = gen, u
				b.certWarning(gen, u, err.Error())
			case err != nil:
				b.loading = 0
				b.failed, b.failedURL = gen, u
				// The tunnel refused for its certificate's revocation
				// (gorevoke.go), the address's host or where it redirected
				// (the document's last request): TabTop's warning, to go
				// back or on (to there).
				at := ""
				if strings.HasPrefix(u, "https:") && b.certs.tookRevoked(goCertHostOf(u)) {
					at = u
				} else if d := b.docRequest[1]; d != "" && d != u && strings.HasPrefix(d, "https:") && b.certs.tookRevoked(goCertHostOf(d)) {
					// (As Continue's address will be taken: goURL.)
					at = d
					if g, err := goURL(d); err == nil {
						at = g
					}
				}
				if at != "" {
					b.failedURL = at
					b.certWarning(gen, at, "net::ERR_CERT_REVOKED")
				} else {
					b.fail(gen, goNavError(err))
				}
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
	first := b.view == (goView{})
	touch := v.Touch != b.view.Touch || first
	scheme := v.Scheme != b.view.Scheme || first
	b.view = v
	b.job(func() any {
		ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
		defer cancel()
		b.applyUA(ctx, goMobile(v))
		metrics := map[string]any{
			"width": v.W, "height": v.H, "deviceScaleFactor": v.DPR, "mobile": false,
			// The screen is the person's window: their own isn't told.
			"screenWidth": v.SW, "screenHeight": v.SH,
			"screenOrientation": map[string]any{"type": goOrientations[v.Orientation], "angle": v.Angle},
		}
		err := b.cdp.call(ctx, b.page, "Emulation.setDeviceMetricsOverride", metrics, nil)
		if err != nil {
			// An engine that won't be told which way up: its size all the same.
			delete(metrics, "screenOrientation")
			err = b.cdp.call(ctx, b.page, "Emulation.setDeviceMetricsOverride", metrics, nil)
		}
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
		if scheme {
			// The person's light or dark: CSS and matchMedia in the engine,
			// unless the page's site's Dark mode says otherwise (gotheme.go).
			// Told whether or not the engine took the size: it's not asked
			// again for the same scheme (b.view has it).
			b.deviceScheme(v.Scheme)
		}
		if err == nil {
			err = b.relayout(ctx)
		}
		return err
	}, func(r any) {
		goDebugf("view %dx%d at %g on %dx%d %s %d, touch %v, %s: %v", v.W, v.H, v.DPR, v.SW, v.SH, v.Orientation, v.Angle, v.Touch, v.Scheme, r)
		b.changed(goChangesEvery)
	})
}

// event handles one of the engine's events.
func (b *goBrowser) event(ev cdpEvent, loadTimeout, dialogTimeout <-chan time.Time) (<-chan time.Time, <-chan time.Time) {
	switch ev.Method {
	case "Fetch.requestPaused":
		b.storagePaused(ev)
	case "DOMStorage.domStorageItemAdded", "DOMStorage.domStorageItemUpdated", "DOMStorage.domStorageItemRemoved", "DOMStorage.domStorageItemsCleared":
		b.storageEvent(ev)
	case "Target.targetCreated", "Target.targetInfoChanged":
		// A window the page opened (window.open, a link to a new
		// window): closed in the engine, and its address given to the
		// page above, which opens it in a tab of its own (go-tabs.js), or
		// has this one load it, as a navigation of the page's.
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
			b.popup(u) // opened, refused or asked about, as its site's set (gosites.go)
		}
		return loadTimeout, dialogTimeout
	}
	if !b.ours(ev) {
		return loadTimeout, dialogTimeout
	}
	switch ev.Method {
	case "Page.fileChooserOpened":
		b.fileChooserOpened(ev) // a file input's (gouploads.go)
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
				b.popup(u) // as a popup's (above)
			}
			break
		}
		goDebugf("frame navigated (loading %d)", b.loading)
		b.frame = p.Frame.ID
		b.storageShown(p.Frame.URL)
		b.world, b.dirty = 0, false // a new document, a new world
		b.children = nil            // and its own frames
		b.inflight, b.netBusy = nil, false
		b.docURL = ""
		b.certRetried = "" // (a new page: a refused document of its, loaded again once)
		if u, err := goURL(p.Frame.URL); err == nil {
			b.docURL = u
			b.schemeAt(u) // (told already, where its request was paused)
			// Certificate errors ignored while it's an exception's host,
			// only (gocert.go).
			b.job(func() any {
				ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
				defer cancel()
				b.certIgnore(ctx, u)
				return nil
			}, func(any) {})
			if b.cdp != nil && b.cdp.interceptionDisabled.Load() {
				b.pageAt(u)
				b.newAdPage()
			}
		}
		if b.loading != 0 {
			b.navigated = true
		} else if u, err := goURL(p.Frame.URL); err == nil && b.failed == b.gen && u == b.failedURL {
			// The engine's own page for the load that failed (Lightpanda
			// commits one): not the page going anywhere.
		} else if u, err := goURL(p.Frame.URL); err == nil {
			// The page went somewhere by itself: a link, a form, a
			// redirect by script.
			b.leftPage()
			b.gen++
			b.loading, b.navigated = b.gen, true
			b.loadingURL = u
			b.popupAsks = nil // asked about by the page left: gone with it
			b.send(map[string]any{"type": "go-loading", "gen": b.gen, "url": u, "by": "page"})
			loadTimeout = time.After(goLoadTimeout)
			b.askAgain()
		}
	case "Network.responseReceived":
		var p struct {
			RequestID string `json:"requestId"`
			Type      string `json:"type"`
			FrameID   string `json:"frameId"`
			Response  struct {
				URL      string            `json:"url"`
				MimeType string            `json:"mimeType"`
				Headers  map[string]string `json:"headers"`
			} `json:"response"`
		}
		json.Unmarshal(ev.Params, &p)
		// A stream's manifest: read once it's loaded, to offer it as Save
		// stream (gostreams.go).
		if u, err := url.Parse(p.Response.URL); err == nil && len(p.Response.URL) <= 8192 && (u.Scheme == "https" || u.Scheme == "http") &&
			goManifestResponse(p.Response.MimeType, u.Path) {
			b.streamSeen(p.RequestID, p.Response.URL)
		}
		if p.Type == "Document" && (p.FrameID == b.frame || b.frame == "") {
			// The proxy's refusal, shown as the page by an engine that
			// doesn't fail the load (Obscura): the person's told instead.
			for k, v := range p.Response.Headers {
				if msg, ok := goRefusals[v]; ok && strings.EqualFold(k, goRefusedHeader) {
					b.refused, b.refusedWhy = b.gen, msg
				}
			}
			b.devicePolicyURL, b.devicePolicy = p.Response.URL, ""
			for key, value := range p.Response.Headers {
				if strings.EqualFold(key, "Permissions-Policy") {
					b.devicePolicy = value
				}
			}
			// Its type alone: Moli keeps its parameters (charset), as
			// Chrome doesn't.
			media, _, _ := strings.Cut(p.Response.MimeType, ";")
			b.docType = strings.ToLower(strings.TrimSpace(media))
		}
	case "Network.requestWillBeSent", "Network.loadingFinished", "Network.loadingFailed":
		switch ev.Method {
		case "Network.loadingFinished":
			b.streamLoaded(ev)
			b.closedLoaded(ev)
		case "Network.loadingFailed":
			b.streamFailed(ev)
			if u := b.docFailedCert(ev); u != "" {
				loadTimeout = b.certFailed(u, loadTimeout)
			} else if u := b.docRequest[1]; b.docFailed(ev) && b.loading == 0 && strings.HasPrefix(u, "https:") && b.certs.tookRevoked(goCertHostOf(u)) {
				// A page it went to whose certificate's revoked (the tunnel
				// refused it: gorevoke.go): warned of, as a load of its own.
				b.certErrText = "net::ERR_CERT_REVOKED"
				loadTimeout = b.certFailed(u, loadTimeout)
			} else if b.docFailed(ev) && b.loading == 0 {
				// The page's own load failed, not come: certificate errors as
				// the page still shown is (they were set for the one going).
				// (Not a load of TabTop's going: it sets its own, after.)
				shown := b.docURL
				b.job(func() any {
					ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
					defer cancel()
					b.certIgnore(ctx, shown)
					b.schemeAt(shown) // (its light or dark, too: gotheme.go)
					return nil
				}, func(any) {})
			}
		case "Network.requestWillBeSent":
			b.docRequested(ev)
			b.closedRequested(ev)
		}
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
		// Or a single-page site's next video (pushState, an address of its
		// own, not just a fragment's): its streams afresh.
		var p struct {
			FrameID string `json:"frameId"`
			URL     string `json:"url"`
		}
		json.Unmarshal(ev.Params, &p)
		unfragment := func(u string) string { u, _, _ = strings.Cut(u, "#"); return u }
		if (p.FrameID == b.frame || b.frame == "") && p.URL != "" && unfragment(p.URL) != unfragment(b.url) {
			b.streamsLeft()
		}
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
	URL   string     `json:"url"`
	Base  string     `json:"base"`
	Title string     `json:"title"`
	Type  string     `json:"type"`
	Doc   *goNode    `json:"doc"`
	IO    []goIO     `json:"io"`
	At    [2]float64 `json:"at"` // where the window's scrolled
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
				goDebugf("snapshot gen %d: read failed: %v", gen, err)
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
				goDebugf("snapshot gen %d: invalid document (%d bytes, JSON error: %t)", gen, len(raw), err != nil)
				b.fail(gen, "The page couldn't be read.")
				return
			}
			b.url = s.URL
			b.glStreams = make(map[int]*goGLStream)
			goGLStreamsOf(s.Doc, b.glStreams)
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
			p, err := json.Marshal(map[string]any{"type": "go-snapshot", "gen": gen, "url": s.URL, "base": s.Base, "title": goTitleOf(s.Title), "doc": s.Doc, "again": again, "io": goCleanIO(s.IO), "at": goScrollAt(s.At),
				"mediaPolicy": b.sites.mediaFor(goURLHost(s.URL)), "videoHosts": b.sites.videoHostList(), "hide": b.startHiding(s.URL, s.Doc),
				"scheme": b.goSchemeOf(s.URL), "certException": strings.HasPrefix(s.URL, "https://") && b.certs.allows(goCertHostOf(s.URL))})
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
			if b.sendLarge(p) == nil {
				b.sentGen = gen // the page the person has (resume)
			}
			if b.dirty {
				b.readChanges()
			}
			b.closedShown()
		}
	}, func(r any) { r.(func())() })
}

// Requests are drained as a batch is made, even when its DOM changes
// are too large to use and the viewer needs a fresh snapshot.
type goPageRequests struct {
	EME     []json.RawMessage `json:"eme"`
	Devices []goDeviceAsk     `json:"devices"`
}

func goRequestsOf(raw string) goPageRequests {
	var r goPageRequests
	if json.Unmarshal([]byte(raw), &r) != nil {
		return goPageRequests{}
	}
	return r
}

// emeAgain sends a batch's EME requests (the page's, taken from its queue
// as the batch was made: asked once only) when the rest of it is let go,
// to be read again: they'd be lost, the page's DRM left waiting.
func (b *goBrowser) emeAgain(gen int, eme []json.RawMessage) {
	if len(eme) == 0 || len(eme) > 4 || !strings.HasPrefix(b.docURL, "https://") {
		return
	}
	p, _ := json.Marshal(map[string]any{"type": "go-eme", "gen": gen, "eme": eme})
	b.sendLarge(p)
}

type goChanges struct {
	goPageRequests
	Streams []json.RawMessage `json:"streams"`
	Seq     int               `json:"seq"`
	URL     string            `json:"url"`
	Title   string            `json:"title"`
	Ops     []json.RawMessage `json:"ops"`
	IO      []goIO            `json:"io"`
	// GLGone: WebGL canvases sent before that have left the document, no
	// longer counted among its WebGL canvases (goGLStreamsMax).
	GLGone []int `json:"glGone"`
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
	// What it copied, and its reads of the clipboard (goclipboard.go).
	goClipboardOut
	// Where rich text's caret is (goagent.js's caret), with what an edit
	// changed: [anchor, offset, focus, offset].
	Sel []int `json:"sel"`
	// Adopted stylesheets' texts first said, by number (goagent.js's cssRef).
	CSS map[string]string `json:"css"`
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
				if err == nil {
					batch := goRequestsOf(raw)
					b.emeAgain(gen, batch.EME)
					b.devices(gen, batch.Devices)
				}
				b.readAgain(gen) // read it all again
				return
			}
			if raw == "" {
				return
			}
			var c goChanges
			if err := json.Unmarshal([]byte(raw), &c); err != nil || c.Seq != b.seq+1 {
				if err == nil {
					b.devices(gen, c.Devices)
					b.emeAgain(gen, c.EME) // (a batch missed before it: this one's let go too)
				}
				b.readAgain(gen)
				return
			}
			b.seq = c.Seq
			b.lastChange = time.Now()
			for i, id := range c.GLGone {
				if i == goGLStreamsMax*4 {
					break
				}
				delete(b.glStreams, id)
			}
			if c.Again {
				goDebugf("changes gen %d seq %d: read again (nodes of another world)", gen, c.Seq)
				b.emeAgain(gen, c.EME)
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
			b.devices(gen, c.Devices)
			b.clipboard(gen, b.world, c.goClipboardOut)
			c.Streams = b.streamsFrom(gen, b.world, c.Streams) // (its own streams only: goframestreams.go)
			if io, scrolls := goCleanIO(c.IO), goCleanScrolls(c.Scrolls); len(c.Ops) > 0 || len(c.Streams) > 0 || len(c.EME) > 0 || len(io) > 0 || len(scrolls) > 0 {
				if b.glStreams == nil {
					b.glStreams = make(map[int]*goGLStream)
				}
				seen := goSeen{gl: b.glStreams}
				ops := goCleanOps(c.Ops, &seen)
				goDebugf("changes gen %d seq %d: %d ops, %d observed, %d scrolled", gen, c.Seq, len(ops), len(io), len(scrolls))
				changes := map[string]any{"type": "go-changes", "gen": gen, "seq": c.Seq, "title": goTitleOf(c.Title), "ops": ops, "io": io, "scrolls": scrolls, "streams": c.Streams}
				if strings.HasPrefix(b.docURL, "https://") && len(c.EME) <= 4 {
					changes["eme"] = c.EME
				}
				if sel := goSel(c.Sel); sel != nil && len(ops) > 0 {
					changes["sel"] = sel
				}
				if css := goCleanCSS(c.CSS); len(css) > 0 {
					changes["css"] = css
				}
				// What its new classes and ids bring to hide, with them.
				if hide := b.moreHiding(seen.nodes, seen.attrs); len(hide) > 0 {
					changes["hide"] = hide
				}
				p, _ := json.Marshal(changes)
				b.sendLarge(p)
				// A WebGL canvas drawn since the last read is likely being
				// animated: read again at the least interval, not the poll's.
				for _, op := range ops {
					if m, ok := op.(map[string]any); ok && m["o"] == "g" && b.readSoon == nil {
						b.readSoon = time.After(goChangesEvery)
						break
					}
				}
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
		"code": m.Code, "shift": m.Shift, "ctrl": m.Ctrl, "alt": m.Alt, "meta": m.Meta, "submitter": m.Submitter, "x": m.SX, "y": m.SY,
		"sel": goSel(m.Sel), "edit": m.Edit, "inputType": m.InputType, "html": m.HTML})
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

// goSeen is what a batch of changes brought: nodes added, and attributes
// set (for what's hidden on the page, goadblock.go).
type goSeen struct {
	nodes []*goNode
	attrs [][2]string
	// gl is the tab's WebGL streams by canvas node ID (goGLStream): a delta
	// is checked against its canvas's, and a full log starts it afresh.
	gl map[int]*goGLStream
}

// goCanvasOp adds to a canvas's op the iframes it's within (a same-origin
// frame's canvas, numbered as the page's nodes are), if they're plausible.
func goCanvasOp(op map[string]any, path []int) map[string]any {
	if len(path) == 0 || len(path) > 4 {
		return op
	}
	for _, id := range path {
		if id <= 0 {
			return op
		}
	}
	op["path"] = path
	return op
}

// goChangeOp is one of a batch's changes (goagent.js's ops).
type goChangeOp struct {
	O    string    `json:"o"`
	I    int       `json:"i"`
	N    string    `json:"n"`
	V    *string   `json:"v"`
	PE   string    `json:"pe"`
	GL   *goGLLog  `json:"gl"`   // o "g"
	Path []int     `json:"path"` // a canvas's iframes, outermost first: a same-origin frame's
	C    []*goNode `json:"c"`
	S    *goNode   `json:"s"`  // o "s": a shadow root attached to element I
	SS   int       `json:"ss"` // o "ss": the adopted stylesheets of shadow root I, by number
}

// goCleanOps takes event handler attributes and what's never shown out of a
// batch of changes, as goClean does a snapshot; what it brings is noted in
// seen, if it's given.
func goCleanOps(raw []json.RawMessage, seen *goSeen) []any {
	out := []any{} // [] if none, not null: a batch may bring only what's observed
	for _, r := range raw {
		var op goChangeOp
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
					if seen != nil {
						seen.nodes = append(seen.nodes, k)
						if seen.gl != nil {
							goGLStreamsOf(c, seen.gl)
						}
					}
				}
			}
			out = append(out, map[string]any{"o": "c", "i": op.I, "c": kids})
		case "s":
			// A shadow root, given to an element sent before: cleaned as a
			// snapshot's.
			if op.S == nil || op.S.Type != 11 {
				continue
			}
			if c := goClean(op.S); c != nil {
				out = append(out, map[string]any{"o": "s", "i": op.I, "s": c})
				// (Its canvases counted; not its classes, for hiding: the
				// page's hiding rules don't reach into a shadow root.)
				if seen != nil && seen.gl != nil {
					goGLStreamsOf(c, seen.gl)
				}
			}
		case "ss":
			if op.SS >= 0 {
				out = append(out, map[string]any{"o": "ss", "i": op.I, "ss": op.SS})
			}
		case "a":
			if strings.HasPrefix(strings.ToLower(op.N), "on") {
				continue
			}
			out = append(out, map[string]any{"o": "a", "i": op.I, "n": op.N, "v": op.V})
			if seen != nil && op.V != nil && (op.N == "class" || op.N == "id") {
				seen.attrs = append(seen.attrs, [2]string{op.N, *op.V})
			}
		case "m": // a player started or stopped by the page
			out = append(out, map[string]any{"o": "m", "i": op.I, "v": op.V != nil && *op.V == "true"})
		case "p": // a Canvas2D pixel update: PNG only, size checked again here
			if op.I <= 0 {
				continue
			}
			if seen != nil && seen.gl != nil {
				delete(seen.gl, op.I) // a WebGL canvas shown otherwise needs a full log again
			}
			pixels := ""
			if op.V != nil && goCanvasPNGValid(*op.V) {
				pixels = *op.V
			}
			reason := goCanvasError(op.PE)
			if pixels != "" {
				reason = ""
			}
			out = append(out, goCanvasOp(map[string]any{"o": "p", "i": op.I, "v": pixels, "pe": reason}, op.Path))
		case "g": // bounded WebGL replay log: a full one (r), or the calls since the last
			if op.I <= 0 {
				continue
			}
			out = append(out, seen.glOp(&op))
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
	if m.Kind == "eme-reply" && m.FDoc != 0 {
		b.emeInFrame(m) // an embedded page's EME answered (goframeeme.go)
		return
	}
	if m.Frame != 0 {
		// In an embedded page: by its own agent, as the engine's input
		// can't be aimed there (goinput.go).
		switch {
		case m.Kind == "mouse":
			b.pointerInFrame(m)
		case m.Kind == "key" && m.Type == "up":
			// A key's press is done by script, all of it (keydown,
			// keypress, keyup; Enter sending its form): its release is in it.
		case m.Kind == "click", m.Kind == "input", m.Kind == "change", m.Kind == "key", m.Kind == "submit", m.Kind == "focus", m.Kind == "edit", m.Kind == "media-meta":
			if len(m.Value)+len(m.HTML) <= maxGoURL*8 {
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
	case m.Kind == "edit":
		b.edit(m)
		return
	}
	switch m.Kind {
	case "click", "input", "change", "key", "submit", "focus", "scroll", "media-meta", "eme-reply":
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

// --- Certificate errors (gocert.go) ------------------------------------

// certIgnore has the engine ignore certificate errors while raw (the
// page's address, or the one it's going to) is an exception's host, and
// only then; on the tab's own session. (A job's: a CDP call.)
func (b *goBrowser) certIgnore(ctx context.Context, raw string) {
	u, err := url.Parse(raw)
	want := err == nil && u.Scheme == "https" && b.certs.ignores(u.Hostname())
	told := int8(0)
	if want {
		told = 1
	}
	b.certMu.Lock()
	defer b.certMu.Unlock()
	if b.certTold == told || b.cdp == nil {
		return
	}
	// Ignoring, as the proxy goes: so from before the engine's told to till
	// it's certainly been told not to. A call that fails, or times out, may
	// have been heeded: what it's been told isn't known, and it's told again
	// next time, whichever.
	if want {
		b.certs.ignoring.Store(true)
	}
	err = b.cdp.call(ctx, b.page, "Security.setIgnoreCertificateErrors", map[string]any{"ignore": want}, nil)
	var cdpErr *cdpError
	if errors.As(err, &cdpErr) && cdpErr.Code == -32601 {
		// An engine without it: it heeds them, certainly; nothing's
		// continued to on it (cert-continue), and the exception just made
		// for its error is taken away (it'd only skip TabTop's own checks).
		b.certUnsupported.Store(true)
		if want {
			b.certs.dropEngine(u.Hostname())
		}
		b.certTold = 0
		b.certs.ignoring.Store(false)
		b.certs.heeding()
		return
	}
	if err != nil && ctx.Err() == nil {
		// Once more at once (not left for the next load to put right).
		err = b.cdp.call(ctx, b.page, "Security.setIgnoreCertificateErrors", map[string]any{"ignore": want}, nil)
	}
	if err != nil {
		goDebugf("certificate errors ignored %v: %v", want, err)
		b.certTold = -1
		return
	}
	b.certTold = told
	b.certs.ignoring.Store(want)
	if !want {
		b.certs.heeding()
	}
}

// certWarning tells the page that u's certificate isn't trusted (errText,
// the engine's), with what it says (read on a connection of tabtopd's
// own): TabTop's warning, with Back and Continue (go.js).
func (b *goBrowser) certWarning(gen int, u, errText string) {
	host := goURLHost(u)
	parsed, err := url.Parse(u)
	if err != nil || host == "" {
		b.fail(gen, goNavError(errors.New(errText)))
		return
	}
	name := parsed.Hostname()
	revoked := strings.Contains(errText, "ERR_CERT_REVOKED")
	b.certWarned, b.certWarnedAt, b.certWarnedRevoked = name, u, revoked
	var dial func(ctx context.Context, network, addr string) (net.Conn, error)
	if b.e != nil && b.e.proxy != nil {
		dial = b.e.proxy.dialer.DialContext // (the address policy's)
	}
	// (Read on a goroutine of its own, not the tab's jobs: a host can take
	// its time, and the tab's next load mustn't wait for it.)
	go func() {
		var d *goCertDetails
		if parsed.Port() == "" || parsed.Port() == "443" {
			d = goCertProbe(b.ctx, dial, name)
		}
		if d != nil && revoked && d.Problem == "" {
			d.Problem = "revoked by its issuer"
		}
		b.post(func() {
			if gen != b.gen {
				return
			}
			msg := map[string]any{"type": "go-cert-warning", "gen": gen, "url": u, "host": name, "reason": goCertReason(errText)}
			if d != nil {
				msg["cert"] = d
			}
			b.send(msg)
		})
	}()
}

// docRequested notes the request for the page's own document (a link the
// page followed, a form, a redirect by script), to know it if it fails.
func (b *goBrowser) docRequested(ev cdpEvent) {
	var p struct {
		RequestID string `json:"requestId"`
		Type      string `json:"type"`
		FrameID   string `json:"frameId"`
		Request   struct {
			URL    string `json:"url"`
			Method string `json:"method"`
		} `json:"request"`
	}
	if json.Unmarshal(ev.Params, &p) == nil && p.Type == "Document" && (p.FrameID == b.frame || b.frame == "") {
		b.docRequest = [2]string{p.RequestID, p.Request.URL}
		b.docPosted = p.Request.Method != "" && p.Request.Method != "GET"
	}
}

// docFailed is whether ev is the failure of the page's own document's
// request.
func (b *goBrowser) docFailed(ev cdpEvent) bool {
	var p struct {
		RequestID string `json:"requestId"`
		Type      string `json:"type"`
	}
	return json.Unmarshal(ev.Params, &p) == nil && p.Type == "Document" && p.RequestID != "" && p.RequestID == b.docRequest[0]
}

// docFailedCert is the address of the page's own document whose request
// failed for its certificate, or was refused by the proxy as the engine
// ignored certificate errors (certErrText "", then), if ev is that.
func (b *goBrowser) docFailedCert(ev cdpEvent) string {
	var p struct {
		RequestID string `json:"requestId"`
		Type      string `json:"type"`
		ErrorText string `json:"errorText"`
	}
	if json.Unmarshal(ev.Params, &p) != nil || p.Type != "Document" || p.RequestID == "" || p.RequestID != b.docRequest[0] {
		return ""
	}
	u, err := goURL(b.docRequest[1])
	if err != nil {
		return ""
	}
	// Refused by the proxy as the engine ignored certificate errors (its
	// page an exception's), another host's: loaded again, heeding them, once.
	// (Not a form posted: loaded again, it'd be got, its data lost.)
	if b.certs.tookRefused(goCertHostOf(u)) && b.certRetried != u && !b.docPosted {
		b.certRetried = u
		b.certErrText = ""
		return u
	}
	if !goCertError(p.ErrorText) {
		return ""
	}
	b.certErrText = p.ErrorText
	return u
}

// certFailed is a document the page went to (by itself) refused for its
// certificate: an exception's host (the person's continued to it, in this
// tab) loaded again, its errors ignored; else, as a load of its own, warned
// of. One the proxy refused as the engine ignored errors is loaded again,
// heeding them (navigate: certIgnore). (One the person asked for is warned
// of by navigate.)
func (b *goBrowser) certFailed(u string, loadTimeout <-chan time.Time) <-chan time.Time {
	if b.failed == b.gen && b.failedURL == u || b.loading == b.gen && b.loadingURL == u && !b.navigated {
		// A load asked for (navigate's): warned of there, as its
		// Page.navigate answers (this event can come first).
		return loadTimeout
	}
	if b.certErrText == "" || b.certs.allows(goCertHostOf(u)) && !b.certs.ignoring.Load() {
		// (Refused as the engine ignored errors: then heeding them.)
		return b.navigate(u, "page")
	}
	b.leftPage()
	b.gen++
	b.loading, b.navigated = 0, false
	b.failed, b.failedURL = b.gen, u
	b.send(map[string]any{"type": "go-loading", "gen": b.gen, "url": u, "by": "page"})
	b.certWarning(b.gen, u, b.certErrText)
	return nil
}

// goCertHostOf is raw's host name (no port).
func goCertHostOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return u.Hostname()
}
