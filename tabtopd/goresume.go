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

// goDetachedFor is how long a tab runs on without a connection (a
// variable for tests).
var goDetachedFor = 5 * time.Minute

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
	mu  sync.Mutex
	cur *goLink
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

// lend lends t the call's connection, till the tab lets it go; false if
// the tab ended first.
func (t *goTab) lend(l *goLink) bool {
	select {
	case t.b.attach <- l:
	case <-t.ended:
		return false
	}
	<-l.done
	return true
}

// logGoTab says, without where it went or its token, what became of a
// tab's connection.
func logGoTab(what, ip string) { log.Printf("go: remote browser tab %s (%s)", what, ip) }
