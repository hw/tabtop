package main

// A small Chrome DevTools Protocol client, for the remote browser's engine
// (goengine.go): commands and their results, and events, over the engine's
// WebSocket, reached through its socket. Only what /go uses: Target, Page,
// DOM, Emulation, Network and Runtime, with sessions flattened onto the one
// connection.
import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"sync"

	"github.com/coder/websocket"
)

type cdpEvent struct {
	Method    string          `json:"method"`
	Params    json.RawMessage `json:"params"`
	SessionID string          `json:"sessionId"`
}

type cdpError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *cdpError) Error() string { return fmt.Sprintf("CDP error %d: %s", e.Code, e.Message) }

type cdpMessage struct {
	ID        int64           `json:"id"`
	Method    string          `json:"method"`
	Params    json.RawMessage `json:"params"`
	SessionID string          `json:"sessionId"`
	Result    json.RawMessage `json:"result"`
	Error     *cdpError       `json:"error"`
}

// cdpEvents is how many events wait to be read before more are dropped.
const cdpEvents = 1024

// cdpReadLimit is the largest message read: a whole document's DOM.
const cdpReadLimit = 64 << 20

type cdpConn struct {
	ws      *websocket.Conn
	mu      sync.Mutex
	next    int64
	pending map[int64]chan cdpMessage
	// Events are the engine's events, in order; when nobody reads them,
	// the newest are dropped and dropped counts them.
	Events  chan cdpEvent
	dropped int
	done    chan struct{}
	err     error
}

// dialCDP connects to the engine's browser endpoint.
func dialCDP(ctx context.Context, e *goEngine) (*cdpConn, error) {
	v, err := e.version(ctx)
	if err != nil {
		return nil, err
	}
	raw, _ := v["webSocketDebuggerUrl"].(string)
	u, err := url.Parse(raw)
	if err != nil || u.Path == "" {
		return nil, fmt.Errorf("the engine gave no usable WebSocket URL: %q", raw)
	}
	ws, _, err := websocket.Dial(ctx, "ws://"+e.cdpHost+u.Path, &websocket.DialOptions{HTTPClient: e.client()})
	if err != nil {
		return nil, err
	}
	ws.SetReadLimit(cdpReadLimit)
	c := &cdpConn{ws: ws, pending: map[int64]chan cdpMessage{}, Events: make(chan cdpEvent, cdpEvents), done: make(chan struct{})}
	go c.read()
	return c, nil
}

func (c *cdpConn) read() {
	var err error
	for {
		var m cdpMessage
		var b []byte
		_, b, err = c.ws.Read(context.Background())
		if err != nil {
			break
		}
		if json.Unmarshal(b, &m) != nil {
			continue
		}
		if m.ID != 0 {
			c.mu.Lock()
			ch := c.pending[m.ID]
			delete(c.pending, m.ID)
			c.mu.Unlock()
			if ch != nil {
				ch <- m
			}
			continue
		}
		select {
		case c.Events <- cdpEvent{Method: m.Method, Params: m.Params, SessionID: m.SessionID}:
		default:
			c.mu.Lock()
			c.dropped++
			c.mu.Unlock()
		}
	}
	c.mu.Lock()
	c.err = err
	for id, ch := range c.pending {
		close(ch)
		delete(c.pending, id)
	}
	c.mu.Unlock()
	close(c.done)
}

var errCDPClosed = errors.New("the engine's connection closed")

// call sends method, in session ("" for the browser), and decodes its
// result into result (if not nil).
func (c *cdpConn) call(ctx context.Context, session, method string, params, result any) error {
	c.mu.Lock()
	if c.err != nil {
		c.mu.Unlock()
		return errCDPClosed
	}
	c.next++
	id := c.next
	ch := make(chan cdpMessage, 1)
	c.pending[id] = ch
	c.mu.Unlock()
	msg := map[string]any{"id": id, "method": method}
	if params != nil {
		msg["params"] = params
	}
	if session != "" {
		msg["sessionId"] = session
	}
	b, err := json.Marshal(msg)
	if err == nil {
		err = c.ws.Write(ctx, websocket.MessageText, b)
	}
	if err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return err
	}
	select {
	case m, ok := <-ch:
		if !ok {
			return errCDPClosed
		}
		if m.Error != nil {
			return m.Error
		}
		if result != nil && len(m.Result) > 0 {
			return json.Unmarshal(m.Result, result)
		}
		return nil
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return ctx.Err()
	}
}

func (c *cdpConn) close() {
	c.ws.Close(websocket.StatusNormalClosure, "")
	<-c.done
}

// newPage opens a blank page and attaches to it, returning its session.
func (c *cdpConn) newPage(ctx context.Context) (string, error) {
	session, _, err := c.newPageTarget(ctx)
	return session, err
}

// newPageTarget is newPage, with the page's target too.
func (c *cdpConn) newPageTarget(ctx context.Context) (string, string, error) {
	var created struct {
		TargetID string `json:"targetId"`
	}
	if err := c.call(ctx, "", "Target.createTarget", map[string]any{"url": "about:blank"}, &created); err != nil {
		return "", "", err
	}
	var attached struct {
		SessionID string `json:"sessionId"`
	}
	if err := c.call(ctx, "", "Target.attachToTarget", map[string]any{"targetId": created.TargetID, "flatten": true}, &attached); err != nil {
		return "", "", err
	}
	return attached.SessionID, created.TargetID, nil
}
