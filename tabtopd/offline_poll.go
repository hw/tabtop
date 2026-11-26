package main

import (
	"context"
	"crypto/subtle"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
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
	pollWriteTimeout = 8 * time.Second

	pollFrameLimit  = maxClientMessage + tunnelOverhead
	pollBufferLimit = 2 << 20
	pollBatchLimit  = 256 << 10
	pollFrameCount  = 256
	pollSendCount   = 64
	pollSendLimit   = pollFrameLimit + 4
	pollSendBudget  = 64 << 20
)

type offlinePoll struct {
	mu       sync.Mutex
	tunnels  map[string]*pollTunnel
	creates  map[pollCreateKey]*pollTunnel
	slots    keyedSlots
	upstream pollUpstream
	stopping bool
	sending  atomic.Int64
}

type pollCreateKey struct {
	host, ip, id string
}

type pollTunnel struct {
	id, token string
	key       pollCreateKey
	ctx       context.Context
	cancel    context.CancelFunc
	ready     chan struct{}
	conn      *websocket.Conn // assigned before ready closes
	openError int

	mu           sync.Mutex
	sendMu       sync.Mutex // serializes writes with promotion and active deletion
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
	removed      bool
	polling      map[string]struct{}
	sent         uint64
	acked        uint64
	frames       [][]byte // buffered frames after acked
	buffered     int
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
}

type pollBatch struct {
	First    uint64     `json:"first,omitempty"`
	Messages [][]byte   `json:"messages,omitempty"`
	Switched string     `json:"switched,omitempty"`
	Active   bool       `json:"active,omitempty"`
	Close    *pollClose `json:"close,omitempty"`
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
		rc := http.NewResponseController(w)
		rc.SetReadDeadline(time.Now().Add(pollWriteTimeout))
		rc.SetWriteDeadline(time.Now().Add(pollWait + 2*pollWriteTimeout))
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
		}
		if p.tunnels == nil {
			p.tunnels = make(map[string]*pollTunnel)
			p.creates = make(map[pollCreateKey]*pollTunnel)
		}
		p.tunnels[t.id], p.creates[key] = t, t
		t.timer = time.AfterFunc(pollIdle, func() { p.expire(t) })
		original := r.Clone(ctx)
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
	writePollJSON(w, http.StatusCreated, pollOpened{t.id, active, t.token, g.offlinePollRotate.Milliseconds()})
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
	c.SetReadLimit(pollFrameLimit)
	t.conn = c
	close(t.ready)
	defer c.CloseNow()
	t.readUpstream()
}

func (p *offlinePoll) expire(t *pollTunnel) {
	t.mu.Lock()
	if t.removed {
		t.mu.Unlock()
		return
	}
	deadline := t.touched.Add(pollIdle)
	if t.close != nil {
		deadline = t.closedAt.Add(pollCloseGrace)
	}
	if wait := time.Until(deadline); wait > 0 {
		t.timer.Reset(wait)
		t.mu.Unlock()
		return
	}
	t.terminateLocked(websocket.StatusGoingAway, "")
	t.mu.Unlock()
	p.drop(t)
}

func (p *offlinePoll) drop(t *pollTunnel) {
	t.mu.Lock()
	t.removed = true
	t.timer.Stop()
	t.cancel()
	t.mu.Unlock()
	p.mu.Lock()
	if p.tunnels[t.id] == t {
		delete(p.tunnels, t.id)
		delete(p.creates, t.key)
		p.slots.give(t.key.ip)
	}
	p.mu.Unlock()
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
		t.terminateLocked(websocket.StatusServiceRestart, "")
		t.mu.Unlock()
		p.drop(t)
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

func (t *pollTunnel) terminateLocked(code websocket.StatusCode, reason string) {
	if t.close == nil {
		t.close = &pollClose{Code: code, Reason: reason}
		t.closedAt = time.Now()
		if !t.removed {
			t.timer.Reset(pollCloseGrace)
		}
		t.notifyLocked()
	}
	t.cancel()
}

func (t *pollTunnel) readUpstream() {
	for {
		kind, data, err := t.conn.Read(t.ctx)
		if err != nil {
			var closed websocket.CloseError
			if !errors.As(err, &closed) {
				closed.Code = websocket.StatusAbnormalClosure
			}
			t.mu.Lock()
			t.terminateLocked(closed.Code, closed.Reason)
			t.mu.Unlock()
			return
		}
		t.mu.Lock()
		if kind != websocket.MessageBinary {
			t.terminateLocked(websocket.StatusUnsupportedData, "expected a binary message")
		}
		for t.close == nil && len(t.frames) != 0 && (t.buffered+len(data) > pollBufferLimit || len(t.frames) >= pollFrameCount) {
			changed := t.changed
			t.mu.Unlock()
			<-changed
			t.mu.Lock()
		}
		if t.close != nil {
			t.mu.Unlock()
			return
		}
		t.frames = append(t.frames, data)
		t.buffered += len(data)
		t.notifyLocked()
		t.mu.Unlock()
	}
}

func (t *pollTunnel) receive(w http.ResponseWriter, r *http.Request) {
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
			writePollJSON(w, status, batch)
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
			t.buffered -= len(t.frames[i])
			t.frames[i] = nil
		}
		t.frames = t.frames[after-t.acked:]
		t.acked = after
		t.notifyLocked()
	}
	if len(t.frames) == 0 {
		if t.close != nil {
			return pollBatch{Close: t.close}, http.StatusOK
		}
		return pollBatch{}, http.StatusNoContent
	}
	n, size := 1, len(t.frames[0])
	for n < len(t.frames) && size+len(t.frames[n]) <= pollBatchLimit {
		size += len(t.frames[n])
		n++
	}
	return pollBatch{First: t.acked + 1, Messages: append([][]byte(nil), t.frames[:n]...)}, http.StatusOK
}

func (p *offlinePoll) send(t *pollTunnel, w http.ResponseWriter, r *http.Request) {
	seq, err := strconv.ParseUint(r.URL.Query().Get("seq"), 10, 64)
	if err != nil || seq == 0 {
		http.Error(w, "invalid send sequence", http.StatusBadRequest)
		return
	}
	t.sendMu.Lock()
	defer t.sendMu.Unlock()
	t.mu.Lock()
	id := r.PathValue("connection")
	acked := t.sent
	active := id == t.active
	t.mu.Unlock()
	if !active || seq > acked+1 {
		http.Error(w, "invalid connection or send sequence", http.StatusConflict)
		return
	}
	limit := int64(pollSendLimit)
	if acked == 0 {
		limit = tunnelHelloLimit + 4
	}
	if r.ContentLength > limit {
		http.Error(w, "message batch is too large", http.StatusRequestEntityTooLarge)
		return
	}
	reserve := limit
	if r.ContentLength >= 0 {
		reserve = r.ContentLength
	}
	inFlight := p.sending.Add(reserve)
	defer p.sending.Add(-reserve)
	if inFlight > pollSendBudget {
		http.Error(w, "too many messages being sent", http.StatusTooManyRequests)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		http.Error(w, "cannot read message", http.StatusBadRequest)
		return
	}
	var frames [][]byte
	for len(body) >= 4 && len(frames) < pollSendCount {
		size := int(binary.BigEndian.Uint32(body))
		body = body[4:]
		if size > len(body) {
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
	t.mu.Lock()
	last := seq + uint64(len(frames)-1)
	switch {
	case last <= acked:
		t.mu.Unlock()
		writePollJSON(w, http.StatusOK, map[string]uint64{"accepted": acked})
		return
	case t.close != nil:
		t.mu.Unlock()
		http.Error(w, "tunnel closed", http.StatusGone)
		return
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
			t.terminateLocked(websocket.StatusAbnormalClosure, "")
			t.mu.Unlock()
			http.Error(w, "upstream write failed", http.StatusBadGateway)
			return
		}
		t.sent = n
		t.mu.Unlock()
	}
	writePollJSON(w, http.StatusOK, map[string]uint64{"accepted": last})
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
	t.sendMu.Lock()
	defer t.sendMu.Unlock()
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
		http.Error(w, "cannot switch connections", http.StatusConflict)
		return
	}
	id := t.active
	t.mu.Unlock()
	writePollJSON(w, http.StatusOK, map[string]string{"connectionId": id})
}

func (p *offlinePoll) removeConnection(t *pollTunnel, w http.ResponseWriter, r *http.Request) {
	t.sendMu.Lock()
	defer t.sendMu.Unlock()
	t.mu.Lock()
	switch id := r.PathValue("connection"); id {
	case t.active:
		t.terminateLocked(websocket.StatusNormalClosure, "")
		t.mu.Unlock()
		p.drop(t)
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
