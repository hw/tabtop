package main

// A remote browser tab outlives its connection (see docs/browser-plan.md,
// "A tab kept while its connection's lost"): its engine, page and all run
// on, for goDetachedFor, after the person's connection to it goes (the
// network dropped, the phone slept, the page reloaded), and a connection
// that brings the tab's token, from the same login session, takes it back
// where it is, the page as it is now. A tab runs on its own goroutine
// (runGoTab), not its connection's, which only lends it the connection
// (goLink) till it goes: the session's count of open connections isn't
// held by a tab no one's connected to. Closed by the person, or its session
// ended, it ends at once; not taken back in time, then.

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"log"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// goDetachedFor is the default time a tab runs on without a connection.
const goDetachedFor = 5 * time.Minute

// goLink is a connection lent to a tab, till done is closed: when the tab
// lets it go (it went, another took the tab, or the tab ended).
type goLink struct {
	conn    msgConn
	deflate bool // it takes large messages compressed (sendLarge)
	done    chan struct{}
	once    sync.Once
}

func newGoLink(conn msgConn, deflate bool) *goLink {
	return &goLink{conn: conn, deflate: deflate, done: make(chan struct{})}
}

func (l *goLink) release() { l.once.Do(func() { close(l.done) }) }

// errGoDetached is a write to a tab no one's connected to: dropped (what
// the page's like then is sent whole when it's taken back).
var errGoDetached = errors.New("no one's connected to the tab")

// goConn is a tab's connection, whichever is lent it now (none, while
// it's lost): what's written goes to that one.
type goConn struct {
	mu            sync.Mutex
	cur           *goLink
	downloads     int
	downloadsDone chan struct{}
	retiring      bool
	since         time.Time // when it was let go, with none since (zero: one's lent)
}

func (c *goConn) detachedAt(at time.Time) {
	c.mu.Lock()
	if c.cur == nil {
		c.since = at
	}
	c.mu.Unlock()
}

// detached reports when an unclaimed tab eligible for eviction was let go.
func (c *goConn) detached() (time.Time, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.since, c.cur == nil && !c.since.IsZero() && c.downloads == 0 && !c.retiring
}

// retireDetached reserves an idle tab for cleanup. A download starting at
// the deadline either holds the tab first or sees that it has already ended.
func (c *goConn) retireDetached() (bool, <-chan struct{}) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cur != nil || c.since.IsZero() || c.retiring {
		return false, nil
	}
	if c.downloads > 0 {
		return false, c.downloadsDone
	}
	c.retiring = true
	return true, nil
}

// holdDownload counts the job, independently of the tunnel following it.
func (g *server) holdDownload(t *goTab) (func(), error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	s := g.sessions[t.session]
	if s == nil || !g.liveLocked(s, g.clock.Now()) {
		return nil, errSessionEnded
	}
	c := t.b.conn
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.retiring {
		return nil, errGoDetached
	}
	select {
	case <-t.ended:
		return nil, errGoDetached
	default:
	}
	if c.downloads == 0 {
		c.downloadsDone = make(chan struct{})
	}
	c.downloads++
	s.downloads++
	if s.idle != nil {
		s.idle.Stop()
		s.idle = nil
	}
	return func() {
		g.mu.Lock()
		defer g.mu.Unlock()
		c.mu.Lock()
		defer c.mu.Unlock()
		c.downloads--
		if c.downloads == 0 {
			close(c.downloadsDone)
			c.downloadsDone = nil
		}
		s.downloads--
		if g.sessions[t.session] == s {
			g.idleIfUnusedLocked(t.session, s)
		}
	}, nil
}

func (c *goConn) link() *goLink {
	if c == nil {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.cur
}

// swap makes l the connection (nil: none), returning the one it was.
func (c *goConn) swap(l *goLink) *goLink {
	c.mu.Lock()
	defer c.mu.Unlock()
	was := c.cur
	c.cur = l
	if l != nil {
		c.since = time.Time{}
	}
	return was
}

func (c *goConn) deflate() bool {
	l := c.link()
	return l != nil && l.deflate
}

func (c *goConn) Read(ctx context.Context) (websocket.MessageType, []byte, error) {
	return 0, nil, errors.New("a tab's connection is read by its tab") // (run)
}

func (c *goConn) Write(ctx context.Context, typ websocket.MessageType, p []byte) error {
	l := c.link()
	if l == nil {
		return errGoDetached
	}
	return l.conn.Write(ctx, typ, p)
}

func (c *goConn) Close(code websocket.StatusCode, reason string) error {
	if l := c.link(); l != nil {
		return l.conn.Close(code, reason)
	}
	return nil
}

func (c *goConn) CloseNow() error {
	if l := c.link(); l != nil {
		return l.conn.CloseNow()
	}
	return nil
}

func (c *goConn) CloseRead(ctx context.Context) context.Context { return ctx }

// goTab is a tab, by its token: its session's, and its browser's.
type goTab struct {
	token, session string
	private        bool // a private tab (goincognito.go)
	b              *goBrowser
	ended          chan struct{} // closed as it ends
}

// goTabs are the tabs running, by token.
type goTabs struct {
	mu sync.Mutex
	by map[string]*goTab
}

func (g *server) goTabList() *goTabs {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.goTabs == nil {
		g.goTabs = &goTabs{by: map[string]*goTab{}}
	}
	return g.goTabs
}

// goToken is a new tab's token: 128 random bits, unguessable; and only a
// connection of the same session may use it.
func goToken() string {
	var b [16]byte
	rand.Read(b[:])
	return base64.RawURLEncoding.EncodeToString(b[:])
}

func (ts *goTabs) add(t *goTab) {
	ts.mu.Lock()
	ts.by[t.token] = t
	ts.mu.Unlock()
}

func (ts *goTabs) remove(t *goTab) {
	ts.mu.Lock()
	if ts.by[t.token] == t {
		delete(ts.by, t.token)
	}
	ts.mu.Unlock()
}

// find is the tab of token, if it's session's and still running.
func (ts *goTabs) find(token, session string) *goTab {
	if token == "" || len(token) > 64 {
		return nil
	}
	ts.mu.Lock()
	t := ts.by[token]
	ts.mu.Unlock()
	if t == nil || t.session != session {
		return nil
	}
	select {
	case <-t.ended:
		return nil
	default:
		return t
	}
}

// ofSession is the tabs of session.
func (ts *goTabs) ofSession(session string) []*goTab {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	var out []*goTab
	for _, t := range ts.by {
		if t.session == session {
			out = append(out, t)
		}
	}
	return out
}

// browsers is every tab's browser, private ones too (which the account's
// jar doesn't list: goincognito.go).
func (ts *goTabs) browsers() []*goBrowser {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	out := make([]*goBrowser, 0, len(ts.by))
	for _, t := range ts.by {
		out = append(out, t.b)
	}
	return out
}

// goSessionEnded ends the session's tabs, connected or not: what it opened
// doesn't outlive it (logging out, its time up, ended from another).
func (g *server) goSessionEnded(session string) {
	g.mu.Lock()
	ts := g.goTabs
	g.mu.Unlock()
	if ts == nil {
		return
	}
	for _, t := range ts.ofSession(session) {
		t.b.e.kill("its session ended")
	}
}

// goTakeWait is how long a connection waits for its tab to take it
// before the one it has is cut (a tab held up writing to a connection gone
// without a word: a write gives up only after tunnelWriteTimeout); and
// goTakeMax, before it gives up.
var goTakeWait, goTakeMax = 3 * time.Second, 15 * time.Second

// lend lends t the call's connection, till the tab lets it go; false if
// the tab ended first, or (back, a tab already running) didn't take it.
func (t *goTab) lend(l *goLink, back bool) bool {
	var cut, giveUp <-chan time.Time
	if back {
		cut, giveUp = time.After(goTakeWait), time.After(goTakeMax)
	}
	for {
		select {
		case t.b.attach <- l:
			<-l.done
			return true
		case <-t.ended:
			return false
		case <-cut:
			if was := t.b.conn.link(); was != nil {
				was.conn.CloseNow()
			}
		case <-giveUp:
			return false
		}
	}
}

// makeRoom ends the session's tab let go longest ago, if any is (kept for
// a connection that may not come: a page closed, not just cut off), so a
// new tab can be had at the session's limit; whether one was.
func (ts *goTabs) makeRoom(session string) bool {
	var oldest *goTab
	var at time.Time
	for _, t := range ts.ofSession(session) {
		if since, ok := t.b.conn.detached(); ok && (oldest == nil || since.Before(at)) {
			oldest, at = t, since
		}
	}
	if oldest == nil {
		return false
	}
	if ok, _ := oldest.b.conn.retireDetached(); !ok {
		return false
	}
	oldest.b.e.kill("a new tab took its place")
	select {
	case <-oldest.ended:
	case <-time.After(10 * time.Second):
	}
	return true
}

// logGoTab says, without where it went or its token, what became of a
// tab's connection.
func logGoTab(what, ip string) { log.Printf("go: remote browser tab %s (%s)", what, ip) }
