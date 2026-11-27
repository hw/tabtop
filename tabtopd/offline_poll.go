package main

import (
	"bufio"
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

const (
	pollPath         = "/session/poll"
	pollWait         = 20 * time.Second
	pollIdle         = 90 * time.Second
	pollStandby      = 30 * time.Second
	pollCloseGrace   = 30 * time.Second
	pollReplyIdle    = 90 * time.Second
	pollReplyMax     = 5 * time.Minute
	pollWriteTimeout = 8 * time.Second

	pollLegacyFrameLimit    = maxClientMessage + tunnelOverhead
	pollBufferLimit         = 2 << 20
	pollBatchLimit          = 256 << 10
	pollFragmentLimit       = 64 << 10
	pollFrameCount          = 256
	pollSendCount           = 64
	pollSendLimit           = maxClientMessage + tunnelOverhead + 4
	pollSendBudget          = 64 << 20
	pollSessionSendBudget   = 28 << 20
	pollHandshakeSendBudget = 8 << 20
	pollBodyRate            = 256 << 10
	pollClosedLimit         = 128 // each for successful and unsuccessful closes
	pollClosedPerIP         = 16
	pollReplyLimit          = 256
	pollReplyPerIP          = 48
	pollReceiveBudget       = 64 << 20
	// Leave room for another session's maximum legacy allocation even
	// when the handshake allowance is full.
	pollSessionReceiveBudget   = 28 << 20
	pollHandshakeReceiveBudget = 8 << 20
	pollReceiveWait            = 20 * time.Second
	pollReplyPerSession        = 64
)

type offlinePoll struct {
	mu             sync.Mutex
	tunnels        map[string]*pollTunnel
	creates        map[pollCreateKey]*pollTunnel
	slots          keyedSlots
	closed         keyedSlots
	finished       keyedSlots
	replies        keyedSlots
	replySessions  keyedSlots
	upstream       pollUpstream
	stopping       bool
	sendMu         sync.Mutex
	sending        int64
	sendByOwner    map[string]int64
	receiveMu      sync.Mutex
	receiving      int
	receiveByOwner map[string]int
	receiveChanged chan struct{}
}

type pollCreateKey struct {
	host, ip, id string
}

type pollTunnelContextKey struct{}

type pollTunnel struct {
	id, token string
	key       pollCreateKey
	ctx       context.Context
	cancel    context.CancelFunc
	ready     chan struct{}
	conn      *websocket.Conn // assigned before ready closes
	openError int
	stream    bool
	sending   atomic.Bool
	session   atomic.Pointer[string] // set only after proving possession of a live session
	bridge    *offlinePoll

	mu           sync.Mutex
	writeMu      sync.Mutex // orders WebSocket writes against promotion
	changed      chan struct{}
	touched      time.Time
	timer        *time.Timer
	active       string
	standby      string
	standbyUntil time.Time
	retired      string
	retiredOpen  bool
	close        *pollClose
	closedAt     time.Time
	lastAck      time.Time
	replySlot    bool
	replyOwner   string
	removed      bool
	polling      map[string]struct{}
	sent         uint64
	acked        uint64
	frames       []*pollFrame // buffered frames after acked
	buffered     int
}

type pollFrame struct {
	data   []byte
	more   bool
	refs   atomic.Int32
	bridge *offlinePoll
	owner  string
}

var errPollReceiveBusy = websocket.CloseError{
	Code: websocket.StatusTryAgainLater, Reason: "polling receive capacity exhausted",
}

func (p *offlinePoll) tryReserveReceive(owner string, n int) (bool, <-chan struct{}) {
	p.receiveMu.Lock()
	defer p.receiveMu.Unlock()
	limit := pollSessionReceiveBudget
	if owner == "" {
		limit = pollHandshakeReceiveBudget
	}
	if p.receiving+n > pollReceiveBudget || p.receiveByOwner[owner]+n > limit {
		if p.receiveChanged == nil {
			p.receiveChanged = make(chan struct{})
		}
		return false, p.receiveChanged
	}
	if n != 0 {
		if p.receiveByOwner == nil {
			p.receiveByOwner = make(map[string]int)
		}
		p.receiveByOwner[owner] += n
		p.receiving += n
	}
	return true, nil
}

func (p *offlinePoll) releaseReceive(owner string, n int) {
	if n == 0 {
		return
	}
	p.receiveMu.Lock()
	defer p.receiveMu.Unlock()
	p.receiveByOwner[owner] -= n
	if p.receiveByOwner[owner] == 0 {
		delete(p.receiveByOwner, owner)
	}
	p.receiving -= n
	if p.receiveChanged != nil {
		close(p.receiveChanged)
		p.receiveChanged = nil
	}
}

func (t *pollTunnel) reserveReceive(owner string, n int) error {
	if ok, changed := t.bridge.tryReserveReceive(owner, n); !ok {
		timer := time.NewTimer(pollReceiveWait)
		defer timer.Stop()
		for !ok {
			select {
			case <-t.ctx.Done():
				return t.ctx.Err()
			case <-timer.C:
				return errPollReceiveBusy
			case <-changed:
				ok, changed = t.bridge.tryReserveReceive(owner, n)
			}
		}
	}
	return nil
}

func (t *pollTunnel) receiveOwner() string {
	if session := t.session.Load(); session != nil {
		return *session
	}
	return ""
}

func (p *offlinePoll) receiveFrame(owner string, data []byte, more bool) *pollFrame {
	frame := &pollFrame{data: data, more: more, bridge: p, owner: owner}
	frame.refs.Store(1)
	return frame
}

func (f *pollFrame) release() {
	if f.refs.Add(-1) == 0 {
		f.bridge.releaseReceive(f.owner, cap(f.data))
	}
}

type pollClose struct {
	Code   websocket.StatusCode `json:"code"`
	Reason string               `json:"reason"`
}

type pollOpened struct {
	TunnelID     string `json:"tunnelId"`
	ConnectionID string `json:"connectionId"`
	Token        string `json:"token"`
	RotateAfter  int64  `json:"rotateAfterMs"`
	Fragments    bool   `json:"fragments,omitempty"`
}

type pollBatch struct {
	First    uint64     `json:"first,omitempty"`
	Messages [][]byte   `json:"messages,omitempty"`
	More     []bool     `json:"more,omitempty"`
	Switched string     `json:"switched,omitempty"`
	Active   bool       `json:"active,omitempty"`
	Close    *pollClose `json:"close,omitempty"`
	frames   []*pollFrame
}

func (g *server) offlinePollHandler() http.Handler {
	p := &g.offlinePoll
	mux := http.NewServeMux()
	mux.HandleFunc("POST "+pollPath, func(w http.ResponseWriter, r *http.Request) { p.create(w, r, g) })
	const connections = pollPath + "/{tunnel}/connections"
	mux.HandleFunc("POST "+connections, p.withTunnel((*pollTunnel).prepare))
	mux.HandleFunc("GET "+connections+"/{connection}", p.withTunnel((*pollTunnel).receive))
	mux.HandleFunc("POST "+connections+"/{connection}/send", p.withTunnel(p.send))
	mux.HandleFunc("POST "+connections+"/{connection}/switch", p.withTunnel((*pollTunnel).promote))
	mux.HandleFunc("DELETE "+connections+"/{connection}", p.withTunnel(p.removeConnection))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rc := http.NewResponseController(w)
		if r.Body != nil && r.Body != http.NoBody {
			rc.SetReadDeadline(time.Now().Add(requestBodyTimeout))
		}
		rc.SetWriteDeadline(time.Now().Add(pollWait + 2*pollWriteTimeout))
		w.Header().Set("Cache-Control", "no-store, no-transform")
		w.Header().Add("Vary", "Origin")
		if r.Header.Get("Origin") != "null" {
			http.Error(w, "offline origin required", http.StatusForbidden)
			return
		}
		if !g.tunnelHostAllowed(r) {
			g.refuseHost(r)
			http.Error(w, hostRefusedReason(hostName(r.Host)), http.StatusForbidden)
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", "null")
		if r.Method == http.MethodOptions {
			test := r.Clone(r.Context())
			test.Method = r.Header.Get("Access-Control-Request-Method")
			_, pattern := mux.Handler(test)
			if pattern == "" {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Set("Access-Control-Max-Age", "600")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func readPollJSON(w http.ResponseWriter, r *http.Request, into any) bool {
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
	d.DisallowUnknownFields()
	if d.Decode(into) != nil || d.Decode(new(any)) != io.EOF {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return false
	}
	return true
}

func writePollJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(value)
}

func writePollBatch(w http.ResponseWriter, batch pollBatch) {
	if len(batch.Messages) == 0 {
		writePollJSON(w, http.StatusOK, batch)
		return
	}
	// A legacy batch can contain a whole large message. Stream its base64
	// encoding to avoid a second full-sized allocation per HTTP response.
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if _, err := io.WriteString(w, `{"first":`+strconv.FormatUint(batch.First, 10)+`,"messages":[`); err != nil {
		return
	}
	for i, message := range batch.Messages {
		prefix := `"`
		if i != 0 {
			prefix = `,"`
		}
		if _, err := io.WriteString(w, prefix); err != nil {
			return
		}
		encoder := base64.NewEncoder(base64.StdEncoding, w)
		if _, err := encoder.Write(message); err != nil {
			return
		}
		if err := encoder.Close(); err != nil {
			return
		}
		if _, err := io.WriteString(w, `"`); err != nil {
			return
		}
	}
	tail := "]}"
	if len(batch.More) != 0 {
		more, _ := json.Marshal(batch.More) // a slice of booleans always marshals
		tail = `],"more":` + string(more) + "}"
	}
	io.WriteString(w, tail)
}

func (p *offlinePoll) create(w http.ResponseWriter, r *http.Request, g *server) {
	var req struct {
		RequestID string `json:"requestId"`
	}
	if !readPollJSON(w, r, &req) {
		return
	}
	if len(req.RequestID) != 36 {
		http.Error(w, "invalid request id", http.StatusBadRequest)
		return
	}
	key := pollCreateKey{host: r.Host, ip: limitKey(g.clientIP(r)), id: req.RequestID}
	p.mu.Lock()
	if p.stopping {
		p.mu.Unlock()
		http.Error(w, "service restarting", http.StatusServiceUnavailable)
		return
	}
	t := p.creates[key]
	if t == nil {
		if !p.slots.take(key.ip, 256, 48) {
			p.mu.Unlock()
			http.Error(w, "too many polling tunnels", http.StatusServiceUnavailable)
			return
		}
		ctx, cancel := context.WithCancel(context.Background())
		t = &pollTunnel{
			id: newToken(), token: newToken(), key: key, ctx: ctx, cancel: cancel,
			active: newToken(), ready: make(chan struct{}), changed: make(chan struct{}), touched: time.Now(),
			polling: make(map[string]struct{}, 3),
			stream:  r.URL.Query().Get("fragments") == "1",
			bridge:  p,
		}
		if p.tunnels == nil {
			p.tunnels = make(map[string]*pollTunnel)
			p.creates = make(map[pollCreateKey]*pollTunnel)
		}
		p.tunnels[t.id], p.creates[key] = t, t
		t.timer = time.AfterFunc(pollIdle, func() { p.expire(t) })
		original := r.Clone(context.WithValue(ctx, pollTunnelContextKey{}, t))
		original.Body = http.NoBody
		original.Header.Del("Authorization")
		go p.open(t, g, original)
	}
	p.mu.Unlock()

	select {
	case <-r.Context().Done():
		return
	case <-t.ready:
	}
	if t.openError != 0 {
		http.Error(w, "upstream WebSocket unavailable", t.openError)
		return
	}
	t.mu.Lock()
	active := t.active
	t.mu.Unlock()
	writePollJSON(w, http.StatusCreated, pollOpened{
		TunnelID: t.id, ConnectionID: active, Token: t.token,
		RotateAfter: g.offlinePollRotate.Milliseconds(), Fragments: t.stream,
	})
}

func (p *offlinePoll) open(t *pollTunnel, g *server, original *http.Request) {
	ctx, cancel := context.WithTimeout(t.ctx, pollWriteTimeout)
	c, resp, err := p.upstream.dial(ctx, g, original)
	cancel()
	if err != nil {
		t.openError = http.StatusBadGateway
		if resp != nil && resp.StatusCode == http.StatusServiceUnavailable {
			t.openError = resp.StatusCode
		}
		close(t.ready)
		p.drop(t)
		return
	}
	if t.stream {
		c.SetReadLimit(-1) // readUpstream reads bounded fragments from each message
	} else {
		c.SetReadLimit(pollLegacyFrameLimit)
	}
	t.conn = c
	close(t.ready)
	defer c.CloseNow()
	p.readUpstream(t)
}

func (p *offlinePoll) expire(t *pollTunnel) {
	t.mu.Lock()
	if t.removed {
		t.mu.Unlock()
		return
	}
	deadline := t.expiryLocked()
	if wait := time.Until(deadline); wait > 0 {
		t.timer.Reset(wait)
		t.mu.Unlock()
		return
	}
	if t.close == nil && len(t.frames) != 0 && !time.Now().Before(t.lastAck.Add(pollReplyIdle)) {
		p.terminateLocked(t, websocket.StatusTryAgainLater, "polling receiver stopped acknowledging messages")
	} else {
		p.terminateLocked(t, websocket.StatusGoingAway, "")
	}
	p.dropLocked(t)
	t.mu.Unlock()
}

func (t *pollTunnel) expiryLocked() time.Time {
	if t.close == nil {
		idle := t.touched.Add(pollIdle)
		if len(t.frames) != 0 {
			if stalled := t.lastAck.Add(pollReplyIdle); stalled.Before(idle) {
				return stalled
			}
		}
		return idle
	}
	last := t.closedAt
	if t.lastAck.After(last) {
		last = t.lastAck
	}
	if !t.replySlot || len(t.frames) == 0 {
		return last.Add(pollCloseGrace)
	}
	idle := last.Add(pollReplyIdle)
	hard := t.closedAt.Add(pollReplyMax)
	if hard.Before(idle) {
		return hard
	}
	return idle
}

func (p *offlinePoll) drop(t *pollTunnel) {
	t.mu.Lock()
	defer t.mu.Unlock()
	p.dropLocked(t)
}

// Lock order for lifecycle changes is t.mu, then p.mu.
func (p *offlinePoll) dropLocked(t *pollTunnel) {
	if t.removed {
		return
	}
	p.mu.Lock()
	if t.close == nil {
		p.slots.give(t.key.ip)
	} else if !t.replySlot {
		p.closedSlots(t.close.Code).give(t.key.ip)
	}
	p.unlinkLocked(t)
	p.mu.Unlock()
}

func (p *offlinePoll) closedSlots(code websocket.StatusCode) *keyedSlots {
	// Failed handshakes must leave room to deliver completed replies.
	if code == websocket.StatusNormalClosure {
		return &p.finished
	}
	return &p.closed
}

func (p *offlinePoll) unlinkLocked(t *pollTunnel) {
	t.removed = true
	t.timer.Stop()
	t.cancel()
	delete(p.tunnels, t.id)
	delete(p.creates, t.key)
	if t.replySlot {
		p.releaseReplyLocked(t)
	}
	for _, frame := range t.frames {
		frame.release()
	}
	t.frames = nil
	t.buffered = 0
}

func (p *offlinePoll) releaseReplyLocked(t *pollTunnel) {
	p.replies.give(t.key.ip)
	p.replySessions.give(t.replyOwner)
	t.replySlot = false
	t.replyOwner = ""
}

func (t *pollTunnel) bindSession(session string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.close != nil {
		return false
	}
	if t.replySlot {
		p := t.bridge
		p.mu.Lock()
		defer p.mu.Unlock()
		if !p.replySessions.take(session, noLimit, pollReplyPerSession) {
			return false
		}
		p.replySessions.give(t.replyOwner)
		t.replyOwner = session
	}
	t.session.Store(&session)
	return true
}

func (p *offlinePoll) stop() {
	p.mu.Lock()
	p.stopping = true
	tunnels := make([]*pollTunnel, 0, len(p.tunnels))
	for _, t := range p.tunnels {
		tunnels = append(tunnels, t)
	}
	p.mu.Unlock()
	for _, t := range tunnels {
		t.mu.Lock()
		p.terminateLocked(t, websocket.StatusServiceRestart, "")
		p.dropLocked(t)
		t.mu.Unlock()
	}
	p.upstream.stop()
}

func (p *offlinePoll) withTunnel(handle func(*pollTunnel, http.ResponseWriter, *http.Request)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p.mu.Lock()
		t := p.tunnels[r.PathValue("tunnel")]
		p.mu.Unlock()
		token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok || t == nil || r.Host != t.key.host || subtle.ConstantTimeCompare([]byte(token), []byte(t.token)) != 1 {
			http.NotFound(w, r)
			return
		}
		select {
		case <-t.ready:
			if t.openError == 0 {
				handle(t, w, r)
				return
			}
		default:
		}
		http.NotFound(w, r)
	}
}

func (t *pollTunnel) notifyLocked() {
	close(t.changed)
	t.changed = make(chan struct{})
}

func (p *offlinePoll) terminateLocked(t *pollTunnel, code websocket.StatusCode, reason string) {
	if t.close == nil {
		t.close = &pollClose{Code: code, Reason: reason}
		t.closedAt = time.Now()
		if !t.removed {
			p.mu.Lock()
			p.slots.give(t.key.ip)
			// A failed unauthenticated handshake can keep its ordinary
			// close entry, freeing the reply slot for other connections.
			if t.replySlot && code != websocket.StatusNormalClosure && t.session.Load() == nil {
				p.releaseReplyLocked(t)
			}
			if t.replySlot || p.closedSlots(code).take(t.key.ip, pollClosedLimit, pollClosedPerIP) {
				t.timer.Reset(time.Until(t.expiryLocked()))
			} else {
				p.unlinkLocked(t)
			}
			p.mu.Unlock()
		}
		t.notifyLocked()
	}
	t.cancel()
}

func (p *offlinePoll) readUpstream(t *pollTunnel) {
	err := t.readMessages()
	var closed websocket.CloseError
	if !errors.As(err, &closed) {
		closed.Code = websocket.StatusAbnormalClosure
	}
	t.mu.Lock()
	p.terminateLocked(t, closed.Code, closed.Reason)
	t.mu.Unlock()
}

func (t *pollTunnel) readMessages() error {
	var buffered *bufio.Reader
	for {
		kind, reader, err := t.conn.Reader(t.ctx)
		if err != nil {
			return err
		}
		if kind != websocket.MessageBinary {
			return websocket.CloseError{Code: websocket.StatusUnsupportedData, Reason: "expected a binary message"}
		}
		if buffered == nil {
			buffered = bufio.NewReaderSize(reader, pollFragmentLimit+1)
		} else {
			buffered.Reset(reader)
		}
		if t.stream {
			err = t.readFragments(buffered)
		} else {
			err = t.readLegacyMessage(buffered)
		}
		if err != nil {
			return err
		}
	}
}

func (t *pollTunnel) readFragments(r *bufio.Reader) error {
	// Look ahead one byte so a message ending at a fragment boundary
	// doesn't need an extra empty fragment.
	for {
		data, err := r.Peek(pollFragmentLimit + 1)
		if err != nil && err != io.EOF {
			return err
		}
		more := len(data) > pollFragmentLimit
		n := min(len(data), pollFragmentLimit)
		owner := t.receiveOwner()
		if err := t.reserveReceive(owner, n); err != nil {
			return err
		}
		fragment := make([]byte, n)
		copy(fragment, data)
		if err := t.bufferFrame(t.bridge.receiveFrame(owner, fragment, more)); err != nil {
			return err
		}
		if !more {
			return nil
		}
		r.Discard(n)
	}
}

func (t *pollTunnel) readLegacyMessage(r *bufio.Reader) error {
	// Legacy clients expect a whole WebSocket message per item. Charge
	// each allocation, including the overlap when its buffer grows.
	data := []byte{}
	owner := t.receiveOwner()
	defer func() { t.bridge.releaseReceive(owner, cap(data)) }()
	for {
		part, err := r.Peek(pollFragmentLimit + 1)
		if err != nil && err != io.EOF {
			return err
		}
		n := min(len(part), pollFragmentLimit)
		size := len(data) + n
		if size > pollLegacyFrameLimit {
			return websocket.CloseError{Code: websocket.StatusMessageTooBig}
		}
		if size > cap(data) {
			capacity := max(size, 2*cap(data))
			if capacity >= maxClientMessage {
				// Include the framing overhead in the last growth so a
				// maximum-size message doesn't need two full allocations.
				capacity = pollLegacyFrameLimit
			}
			if err := t.reserveReceive(owner, capacity); err != nil {
				return err
			}
			next := make([]byte, len(data), capacity)
			copy(next, data)
			t.bridge.releaseReceive(owner, cap(data))
			data = next
		}
		data = append(data, part[:n]...)
		if len(part) <= pollFragmentLimit {
			frame := t.bridge.receiveFrame(owner, data, false)
			data = nil
			return t.bufferFrame(frame)
		}
		r.Discard(n)
	}
}

func (t *pollTunnel) bufferFrame(frame *pollFrame) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	for t.close == nil && len(t.frames) != 0 && (t.buffered+len(frame.data) > pollBufferLimit || len(t.frames) >= pollFrameCount) {
		changed := t.changed
		t.mu.Unlock()
		<-changed
		t.mu.Lock()
	}
	if t.close != nil {
		frame.release()
		return context.Canceled
	}
	if !t.replySlot {
		p := t.bridge
		p.mu.Lock()
		if p.replies.take(t.key.ip, pollReplyLimit, pollReplyPerIP) {
			owner := t.receiveOwner()
			if p.replySessions.take(owner, noLimit, pollReplyPerSession) {
				t.replySlot, t.replyOwner = true, owner
			} else {
				p.replies.give(t.key.ip)
			}
		}
		p.mu.Unlock()
		if !t.replySlot {
			frame.release()
			return errPollReceiveBusy
		}
	}
	if len(t.frames) == 0 {
		t.lastAck = time.Now()
	}
	t.frames = append(t.frames, frame)
	t.buffered += len(frame.data)
	t.notifyLocked()
	return nil
}

func (t *pollTunnel) receive(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "receive requires GET", http.StatusMethodNotAllowed)
		return
	}
	query := r.URL.Query()
	confirm := query.Get("wait") == "active"
	after, err := strconv.ParseUint(query.Get("after"), 10, 64)
	if !confirm && err != nil {
		http.Error(w, "invalid receive sequence", http.StatusBadRequest)
		return
	}
	id := r.PathValue("connection")
	t.mu.Lock()
	if id != t.active && id != t.standby && !(id == t.retired && t.retiredOpen) {
		t.mu.Unlock()
		http.Error(w, "connection is gone", http.StatusGone)
		return
	}
	if _, busy := t.polling[id]; busy || len(t.polling) >= 3 {
		t.mu.Unlock()
		http.Error(w, "a receive is already pending", http.StatusTooManyRequests)
		return
	}
	t.polling[id] = struct{}{}
	t.mu.Unlock()
	defer func() {
		t.mu.Lock()
		delete(t.polling, id)
		t.mu.Unlock()
	}()
	timer := time.NewTimer(pollWait)
	defer timer.Stop()
	for {
		t.mu.Lock()
		batch, status := t.batchLocked(id, after, confirm)
		changed := t.changed
		t.mu.Unlock()
		switch status {
		case http.StatusOK:
			defer func() {
				for _, frame := range batch.frames {
					frame.release()
				}
			}()
			writePollBatch(w, batch)
			return
		case http.StatusNoContent:
			select {
			case <-changed:
				continue
			case <-timer.C:
				w.WriteHeader(status)
			case <-r.Context().Done():
			}
		default:
			http.Error(w, http.StatusText(status), status)
		}
		return
	}
}

func (t *pollTunnel) batchLocked(id string, after uint64, confirm bool) (pollBatch, int) {
	switch {
	case id == t.retired && t.retiredOpen:
		return pollBatch{Switched: t.active}, http.StatusOK
	case id == t.standby && time.Now().Before(t.standbyUntil):
		if t.close != nil {
			return pollBatch{Close: t.close}, http.StatusOK
		}
		return pollBatch{}, http.StatusNoContent
	case id != t.active:
		return pollBatch{}, http.StatusGone
	}
	t.touched = time.Now()
	if confirm {
		return pollBatch{Active: true}, http.StatusOK
	}
	if after < t.acked || after-t.acked > uint64(len(t.frames)) {
		return pollBatch{}, http.StatusConflict
	}
	if after > t.acked {
		for i := uint64(0); i < after-t.acked; i++ {
			t.buffered -= len(t.frames[i].data)
			t.frames[i].release()
			t.frames[i] = nil
		}
		t.frames = t.frames[after-t.acked:]
		t.acked = after
		t.lastAck = time.Now()
		if t.close != nil && t.replySlot && !t.removed {
			t.timer.Reset(time.Until(t.expiryLocked()))
		} else if len(t.frames) == 0 && t.replySlot {
			p := t.bridge
			p.mu.Lock()
			p.releaseReplyLocked(t)
			p.mu.Unlock()
		}
		t.notifyLocked()
	}
	if len(t.frames) == 0 {
		if t.close != nil {
			return pollBatch{Close: t.close}, http.StatusOK
		}
		return pollBatch{}, http.StatusNoContent
	}
	n, size := 1, len(t.frames[0].data)
	for n < len(t.frames) && size+len(t.frames[n].data) <= pollBatchLimit {
		size += len(t.frames[n].data)
		n++
	}
	batch := pollBatch{
		First: t.acked + 1, Messages: make([][]byte, n),
		frames: append([]*pollFrame(nil), t.frames[:n]...),
	}
	for i, frame := range batch.frames {
		frame.refs.Add(1) // keep the bytes charged until the HTTP write ends
		batch.Messages[i] = frame.data
		if frame.more {
			if batch.More == nil {
				batch.More = make([]bool, n)
			}
			batch.More[i] = true
		}
	}
	return batch, http.StatusOK
}

func (p *offlinePoll) reserveSend(owner string, n int64) bool {
	if n == 0 {
		return true
	}
	p.sendMu.Lock()
	defer p.sendMu.Unlock()
	limit := int64(pollSessionSendBudget)
	if owner == "" {
		limit = pollHandshakeSendBudget
	}
	if p.sending+n > pollSendBudget || p.sendByOwner[owner]+n > limit {
		return false
	}
	if p.sendByOwner == nil {
		p.sendByOwner = make(map[string]int64)
	}
	p.sendByOwner[owner] += n
	p.sending += n
	return true
}

func (p *offlinePoll) releaseSend(owner string, n int64) {
	if n == 0 {
		return
	}
	p.sendMu.Lock()
	defer p.sendMu.Unlock()
	p.sendByOwner[owner] -= n
	if p.sendByOwner[owner] == 0 {
		delete(p.sendByOwner, owner)
	}
	p.sending -= n
}

func (p *offlinePoll) send(t *pollTunnel, w http.ResponseWriter, r *http.Request) {
	seq, err := strconv.ParseUint(r.URL.Query().Get("seq"), 10, 64)
	if err != nil || seq == 0 {
		http.Error(w, "invalid send sequence", http.StatusBadRequest)
		return
	}
	if !t.sending.CompareAndSwap(false, true) {
		http.Error(w, "a send is already pending", http.StatusTooManyRequests)
		return
	}
	defer t.sending.Store(false)
	t.mu.Lock()
	id := r.PathValue("connection")
	acked := t.sent
	active := id == t.active
	closed := t.close != nil
	t.mu.Unlock()
	if !active || seq > acked+1 {
		http.Error(w, "invalid connection or send sequence", http.StatusConflict)
		return
	}
	if closed && seq > acked {
		http.Error(w, "tunnel closed", http.StatusGone)
		return
	}
	owner := t.receiveOwner()
	limit := int64(pollSendLimit)
	switch {
	case acked == 0:
		limit = tunnelHelloLimit + 4
	case owner == "":
		// Reserve large bodies only after the first encrypted application
		// request has proved possession of a live session's key.
		limit = tunnelRequestLimit + 4
	}
	if r.ContentLength > limit {
		http.Error(w, "message batch is too large", http.StatusRequestEntityTooLarge)
		return
	}
	reserve := limit
	if r.ContentLength >= 0 {
		reserve = r.ContentLength
	}
	if !p.reserveSend(owner, reserve) {
		http.Error(w, "too many messages being sent", http.StatusTooManyRequests)
		return
	}
	defer p.releaseSend(owner, reserve)
	// Give larger messages time to arrive while bounding how long they can
	// hold the reservation. Keep time for the subsequent upstream write.
	rc := http.NewResponseController(w)
	bodyTime := pollWriteTimeout
	bodyContext := t.ctx
	if closed {
		// A retry for a send already committed can still be acknowledged.
		// Give it the short deadline since the tunnel has already closed.
		bodyContext = context.Background()
	} else {
		bodyTime += time.Duration(reserve) * time.Second / pollBodyRate
	}
	deadline := time.Now().Add(bodyTime)
	rc.SetReadDeadline(deadline)
	rc.SetWriteDeadline(deadline.Add(2 * pollWriteTimeout))

	// The HTTP upload and the WebSocket use different connections. End
	// the body read when the tunnel closes, without waiting for the client.
	canceled := make(chan struct{})
	stop := context.AfterFunc(bodyContext, func() {
		rc.SetReadDeadline(time.Now())
		close(canceled)
	})
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if !stop() {
		<-canceled
	}
	if err != nil {
		status := http.StatusBadRequest
		var netErr net.Error
		switch {
		case bodyContext.Err() != nil:
			status = http.StatusGone
		case errors.As(err, &netErr) && netErr.Timeout():
			status = http.StatusRequestTimeout
		}
		http.Error(w, "cannot read message", status)
		return
	}
	var frames [][]byte
	for len(body) >= 4 && len(frames) < pollSendCount {
		size := uint64(binary.BigEndian.Uint32(body))
		body = body[4:]
		if size > uint64(len(body)) {
			http.Error(w, "invalid message size", http.StatusBadRequest)
			return
		}
		frames = append(frames, body[:size])
		body = body[size:]
	}
	if len(body) != 0 || len(frames) == 0 || seq+uint64(len(frames)-1) < seq {
		http.Error(w, "invalid message batch", http.StatusBadRequest)
		return
	}
	if r.Context().Err() != nil {
		return
	}
	accepted, status := p.writeFrames(t, id, seq, frames, acked)
	if status != http.StatusOK {
		http.Error(w, http.StatusText(status), status)
		return
	}
	writePollJSON(w, http.StatusOK, map[string]uint64{"accepted": accepted})
}

func (p *offlinePoll) writeFrames(t *pollTunnel, id string, seq uint64, frames [][]byte, acked uint64) (uint64, int) {
	if !t.writeMu.TryLock() {
		return 0, http.StatusTooManyRequests
	}
	defer t.writeMu.Unlock()
	t.mu.Lock()
	last := seq + uint64(len(frames)-1)
	switch {
	case id != t.active:
		t.mu.Unlock()
		return 0, http.StatusConflict
	case last <= acked:
		t.mu.Unlock()
		return acked, http.StatusOK
	case t.close != nil:
		t.mu.Unlock()
		return 0, http.StatusGone
	}
	t.touched = time.Now()
	t.mu.Unlock()

	// The write can finish after its HTTP response was lost. A retry then
	// observes sent, and never writes that message to the WebSocket twice.
	ctx, cancel := context.WithTimeout(t.ctx, pollWriteTimeout)
	defer cancel()
	for i, data := range frames {
		n := seq + uint64(i)
		if n <= acked {
			continue
		}
		err := t.conn.Write(ctx, websocket.MessageBinary, data)
		t.mu.Lock()
		if err != nil {
			p.terminateLocked(t, websocket.StatusAbnormalClosure, "")
			t.mu.Unlock()
			return 0, http.StatusBadGateway
		}
		t.sent = n
		t.mu.Unlock()
	}
	return last, http.StatusOK
}

func (t *pollTunnel) prepare(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ConnectionID string `json:"connectionId"`
	}
	if !readPollJSON(w, r, &req) {
		return
	}
	t.mu.Lock()
	if t.close != nil || t.active != req.ConnectionID {
		t.mu.Unlock()
		http.Error(w, "connection is no longer active", http.StatusConflict)
		return
	}
	now := time.Now()
	t.touched = now
	if t.standby == "" || !now.Before(t.standbyUntil) {
		t.standby = newToken()
		t.standbyUntil = now.Add(pollStandby)
		t.notifyLocked()
	}
	id := t.standby
	t.mu.Unlock()
	writePollJSON(w, http.StatusCreated, map[string]string{"connectionId": id})
}

func (t *pollTunnel) promote(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ConnectionID string `json:"connectionId"`
	}
	if !readPollJSON(w, r, &req) {
		return
	}
	if !t.writeMu.TryLock() {
		http.Error(w, "an upstream write is pending", http.StatusTooManyRequests)
		return
	}
	t.mu.Lock()
	old := r.PathValue("connection")
	now := time.Now()
	switch {
	case old == t.retired && req.ConnectionID == t.active:
		// The switch already committed, even if its HTTP response was lost.
	case old == t.active && req.ConnectionID != "" && req.ConnectionID == t.standby && now.Before(t.standbyUntil) && t.close == nil:
		t.retired, t.active, t.standby = t.active, t.standby, ""
		t.retiredOpen = true
		t.touched = now
		t.notifyLocked()
	default:
		t.mu.Unlock()
		t.writeMu.Unlock()
		http.Error(w, "cannot switch connections", http.StatusConflict)
		return
	}
	id := t.active
	t.mu.Unlock()
	t.writeMu.Unlock()
	writePollJSON(w, http.StatusOK, map[string]string{"connectionId": id})
}

func (p *offlinePoll) removeConnection(t *pollTunnel, w http.ResponseWriter, r *http.Request) {
	t.mu.Lock()
	switch id := r.PathValue("connection"); id {
	case t.active:
		p.terminateLocked(t, websocket.StatusNormalClosure, "")
		p.dropLocked(t)
		t.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
		return
	case t.standby:
		t.standby = ""
		t.notifyLocked()
	case t.retired:
		t.retiredOpen = false
		t.notifyLocked()
	}
	t.mu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}
