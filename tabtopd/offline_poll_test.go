package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/crypto/chacha20poly1305"
)

func TestOfflinePollRotation(t *testing.T) {
	cfg := defaultServerConfig()
	cfg.offlineClient = true
	cfg.base = "/desk/"
	cfg.novncDir = t.TempDir()
	cfg.downloadsDir = t.TempDir()
	cfg.usersFile = newUsersFile(t, "-").usersFile
	cfg.nobleDir = fakeNoble(t)
	g, err := newServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(g.offlinePoll.stop)
	h := g.handler()
	root := "http://localhost/desk/session/poll"
	ctx := testCtx(t)
	call := func(method, url, token string, body []byte) *httptest.ResponseRecorder {
		req := httptest.NewRequestWithContext(ctx, method, url, bytes.NewReader(body))
		req.Header.Set("Origin", "null")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		return w
	}
	sendJSON := func(method, url, token, field, value string, status int) map[string]string {
		t.Helper()
		data, err := json.Marshal(map[string]string{field: value})
		if err != nil {
			t.Fatal(err)
		}
		w := call(method, url, token, data)
		if w.Code != status {
			t.Fatalf("%s %s returned %d: %s", method, url, w.Code, w.Body)
		}
		var response map[string]string
		if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		return response
	}

	create := func() pollOpened {
		t.Helper()
		w := call("POST", root, "", []byte(`{"requestId":"79fddbae-43a5-47c1-993b-32b727151119"}`))
		var opened pollOpened
		if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &opened) != nil || opened.RotateAfter != 45000 {
			t.Fatalf("create returned %d: %s", w.Code, w.Body)
		}
		return opened
	}
	opened := create()
	tunnelID, active, token := opened.TunnelID, opened.ConnectionID, opened.Token
	if again := create(); again != opened {
		t.Fatalf("create retry returned a different tunnel: %v", again)
	}
	connections := root + "/" + tunnelID + "/connections"
	if response := call("GET", connections+"/"+active+"?after=0", "wrong", nil); response.Code != 404 {
		t.Fatalf("wrong token returned %d", response.Code)
	}
	after, sent := uint64(0), uint64(0)
	receive := func(id string, after uint64) pollBatch {
		t.Helper()
		w := call("GET", fmt.Sprintf("%s/%s?after=%d", connections, id, after), token, nil)
		if w.Code != 200 {
			t.Fatalf("receive after %d returned %d: %s", after, w.Code, w.Body)
		}
		var batch pollBatch
		if err := json.Unmarshal(w.Body.Bytes(), &batch); err != nil {
			t.Fatal(err)
		}
		return batch
	}
	send := func(retry bool, frames ...[]byte) {
		t.Helper()
		var body []byte
		for _, frame := range frames {
			body = binary.BigEndian.AppendUint32(body, uint32(len(frame)))
			body = append(body, frame...)
		}
		url := fmt.Sprintf("%s/%s/send?seq=%d", connections, active, sent+1)
		sent += uint64(len(frames))
		for {
			w := call("POST", url, token, body)
			if w.Code != 200 || w.Body.String() != fmt.Sprintf("{\"accepted\":%d}\n", sent) {
				t.Fatalf("send returned %d: %s", w.Code, w.Body)
			}
			if !retry {
				break
			}
			retry = false
		}
	}

	id, secret, _ := g.newSession("192.0.2.1", "poll-test")
	eph, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	pub := eph.PublicKey().Bytes()
	send(true, append(append([]byte{tunnelVersion, helloSession}, pub...), id...))
	hello := receive(active, 0)
	if hello.First != 1 || len(hello.Messages) != 1 || len(hello.Messages[0]) != 33 || hello.Messages[0][0] != tunnelVersion {
		t.Fatalf("unexpected server handshake: %+v", hello)
	}
	head := call(http.MethodHead, fmt.Sprintf("%s/%s?after=1", connections, active), token, nil)
	if head.Code != http.StatusMethodNotAllowed || head.Header().Get("Allow") != http.MethodGet {
		t.Fatalf("HEAD returned %d with headers %v", head.Code, head.Header())
	}
	if replay := receive(active, 0); replay.First != hello.First || len(replay.Messages) != 1 || !bytes.Equal(replay.Messages[0], hello.Messages[0]) {
		t.Fatal("HEAD discarded the unacknowledged handshake reply")
	}
	after++
	serverPub := hello.Messages[0][1:]
	ee, err := x25519(eph, serverPub)
	if err != nil {
		t.Fatal(err)
	}
	keys := sessionKeys(ee, secret, pub, serverPub, id)
	encrypt, _ := chacha20poly1305.New(keys[:32])
	decrypt, _ := chacha20poly1305.New(keys[32:64])

	plain := bytes.Repeat([]byte("abcd"), (fileWindow+4)*fileChunk/4)
	if err := os.WriteFile(filepath.Join(cfg.downloadsDir, "bridge.txt"), plain, 0600); err != nil {
		t.Fatal(err)
	}
	txNonce, rxNonce := uint64(0), uint64(0)
	encrypted := func(kind byte, data []byte) []byte {
		ct := encrypt.Seal(nil, tunnelNonce(txNonce), append([]byte{kind}, data...), nil)
		txNonce++
		return ct
	}
	send(true, encrypted(msgText, []byte(`{"type":"file","path":"bridge.txt"}`)))

	var got []byte
	rotations, credits := 0, 0
	for {
		batch := receive(active, after)
		if rotations == 0 {
			g.offlinePoll.mu.Lock()
			bridge := g.offlinePoll.tunnels[tunnelID]
			g.offlinePoll.mu.Unlock()
			if bridge == nil || bridge.receiveOwner() != id {
				t.Fatal("poll bridge did not recognize the authenticated session")
			}
		}
		if batch.Close != nil {
			if batch.Close.Code != websocket.StatusNormalClosure {
				t.Fatalf("unexpected close: %+v", batch.Close)
			}
			break
		}
		if batch.First != after+1 || len(batch.Messages) == 0 {
			t.Fatalf("unexpected receive sequence: %+v", batch)
		}
		if rotations < 3 {
			old := active
			next := sendJSON("POST", connections, token, "connectionId", old, 201)["connectionId"]
			if next == "" || next == old {
				t.Fatalf("invalid standby id %q", next)
			}
			if retry := sendJSON("POST", connections, token, "connectionId", old, 201)["connectionId"]; retry != next {
				t.Fatalf("prepare retry returned %q, want %q", retry, next)
			}
			for i := 0; i < 2; i++ {
				switchReply := sendJSON("POST", connections+"/"+old+"/switch", token, "connectionId", next, 200)
				if switchReply["connectionId"] != next {
					t.Fatalf("switch returned %v", switchReply)
				}
			}
			if oldReply := receive(old, after); oldReply.Switched != next {
				t.Fatalf("retired connection received %+v", oldReply)
			}
			active = next
			// Replay the response discarded at handoff through the new ID.
			replay := receive(active, after)
			if replay.First != batch.First || len(replay.Messages) < len(batch.Messages) {
				t.Fatalf("handoff lost part of a receive batch")
			}
			for i, frame := range batch.Messages {
				if !bytes.Equal(replay.Messages[i], frame) {
					t.Fatalf("handoff changed frame %d", i)
				}
			}
			if w := call("DELETE", connections+"/"+old, token, nil); w.Code != 204 {
				t.Fatalf("retiring connection returned %d", w.Code)
			}
			rotations++
		}
		var acks [][]byte
		for _, msg := range batch.Messages {
			decoded, err := decrypt.Open(nil, tunnelNonce(rxNonce), msg, nil)
			if err != nil {
				t.Fatalf("receive nonce %d: %v", rxNonce, err)
			}
			after++
			rxNonce++
			if decoded[0] == msgData {
				got = append(got, decoded[1:]...)
				if credits < 4 {
					acks = append(acks, encrypted(msgData, nil))
					credits++
				}
			}
		}
		if len(acks) > 0 {
			send(true, acks...)
		}
	}
	if rotations != 3 || !bytes.Equal(plain, got) {
		t.Fatalf("download after %d rotations: got %d bytes, want %d", rotations, len(got), len(plain))
	}
	if w := call("DELETE", connections+"/"+active, token, nil); w.Code != 204 {
		t.Fatalf("releasing tunnel returned %d", w.Code)
	}
	if w := call("GET", connections+"/"+active+"?after=0", token, nil); w.Code != 404 {
		t.Fatalf("released tunnel returned %d", w.Code)
	}
}

func TestOfflinePollAccessAndPreflight(t *testing.T) {
	g := &server{serverConfig: serverConfig{base: "/", vncOff: true}}
	request := func(h http.Handler, method, url, origin string) *httptest.ResponseRecorder {
		req := httptest.NewRequestWithContext(context.Background(), method, url, nil)
		req.Header.Set("Origin", origin)
		req.Header.Set("Access-Control-Request-Method", "POST")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		return w
	}
	const endpoint = "http://localhost/session/poll"
	if w := request(g.handler(), "POST", endpoint, "null"); w.Code != 404 {
		t.Fatalf("disabled bridge returned %d", w.Code)
	}
	g.offlineClient = true
	h := g.handler()
	if w := request(h, "OPTIONS", endpoint, "null"); w.Code != 204 || w.Header().Get("Access-Control-Allow-Origin") != "null" {
		t.Fatalf("preflight returned %d %v", w.Code, w.Header())
	}
	nested := endpoint + "/tunnel/connections/connection/switch"
	if w := request(h, "OPTIONS", nested, "null"); w.Code != 204 ||
		w.Header().Get("Access-Control-Allow-Headers") != "Authorization, Content-Type" {
		t.Fatalf("switch preflight returned %d %v", w.Code, w.Header())
	}
	for _, origin := range []string{"", "https://example.com"} {
		if w := request(h, "OPTIONS", endpoint, origin); w.Code != 403 || w.Header().Get("Access-Control-Allow-Origin") != "" {
			t.Fatalf("origin %q returned %d %v", origin, w.Code, w.Header())
		}
	}
	if w := request(h, "OPTIONS", "http://example.com/session/poll", "null"); w.Code != 403 {
		t.Fatalf("unapproved host returned %d", w.Code)
	}
}

func TestOfflinePollClosedSlots(t *testing.T) {
	p := &offlinePoll{tunnels: make(map[string]*pollTunnel), creates: make(map[pollCreateKey]*pollTunnel)}
	key := pollCreateKey{host: "localhost", ip: "192.0.2.1"}
	for i := range pollClosedPerIP + 2 {
		key.id = fmt.Sprint(i)
		ctx, cancel := context.WithCancel(context.Background())
		tunnel := &pollTunnel{
			id: key.id, key: key, ctx: ctx, cancel: cancel,
			changed: make(chan struct{}), timer: time.AfterFunc(time.Hour, func() {}),
		}
		t.Cleanup(func() { p.drop(tunnel) })
		if !p.slots.take(key.ip, 1, 1) {
			t.Fatal("closed tunnel still occupies the live slot")
		}
		p.tunnels[tunnel.id], p.creates[key] = tunnel, tunnel
		code := websocket.StatusPolicyViolation
		if i == pollClosedPerIP+1 {
			code = websocket.StatusNormalClosure
		}
		tunnel.mu.Lock()
		p.terminateLocked(tunnel, code, "")
		tunnel.mu.Unlock()
		if ctx.Err() == nil || p.slots.total != 0 {
			t.Fatalf("close left context %v and %d live slots", ctx.Err(), p.slots.total)
		}
		if wantCached := i != pollClosedPerIP; (p.tunnels[tunnel.id] == tunnel) != wantCached {
			t.Fatalf("tunnel %d cached = %v, want %v", i, !tunnel.removed, wantCached)
		}
	}
	p.stop()
	if p.closed.total != 0 || p.finished.total != 0 || len(p.tunnels) != 0 || len(p.creates) != 0 {
		t.Fatal("stop left cached tunnel entries")
	}
}

func TestOfflinePollSetsDeadlinesBeforeEarlyResponses(t *testing.T) {
	g := &server{}
	h := g.offlinePollHandler()
	for _, tc := range []struct {
		method, host, origin string
		status               int
	}{
		{http.MethodPost, "localhost", "", http.StatusForbidden},
		{http.MethodPost, "example.com", "null", http.StatusForbidden},
		{http.MethodOptions, "localhost", "null", http.StatusNoContent},
	} {
		r := httptest.NewRequest(tc.method, "http://"+tc.host+pollPath, bytes.NewBufferString("body"))
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("Access-Control-Request-Method", http.MethodPost)
		w := &pollDeadlineRecorder{ResponseRecorder: httptest.NewRecorder()}
		h.ServeHTTP(w, r)
		if w.Code != tc.status || w.readDeadline.IsZero() || w.writeDeadline.IsZero() {
			t.Errorf("%s %s from %q got %d with deadlines %v and %v", tc.method, tc.host, tc.origin, w.Code, w.readDeadline, w.writeDeadline)
		}
	}
}

func TestOfflinePollHTTP1IdleReceive(t *testing.T) {
	g := &server{serverConfig: serverConfig{base: "/", offlineClient: true, vncOff: true}}
	ready := make(chan struct{})
	close(ready)
	g.offlinePoll.tunnels = map[string]*pollTunnel{
		"tunnel": {
			key: pollCreateKey{host: "localhost"}, active: "connection", token: "token", ready: ready,
			changed: make(chan struct{}), polling: make(map[string]struct{}),
		},
	}
	listener := &pollPipeListener{conns: make(chan net.Conn, 1), done: make(chan struct{})}
	srv := &http.Server{Handler: g.handler()}
	go srv.Serve(listener)
	t.Cleanup(func() { srv.Close() })
	transport := &http.Transport{
		DisableKeepAlives: true,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			client, server := net.Pipe()
			select {
			case listener.conns <- server:
				return client, nil
			case <-ctx.Done():
				client.Close()
				server.Close()
				return nil, ctx.Err()
			}
		},
	}
	client := &http.Client{Transport: transport, Timeout: pollWait + 5*time.Second}
	r, err := http.NewRequest(http.MethodGet, "http://localhost"+pollPath+"/tunnel/connections/connection?after=0", nil)
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Origin", "null")
	r.Header.Set("Authorization", "Bearer token")
	start := time.Now()
	res, err := client.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if elapsed := time.Since(start); res.ProtoMajor != 1 || res.StatusCode != http.StatusNoContent || elapsed < pollWait {
		t.Fatalf("%s idle poll got %d after %v, want 204 after %v", res.Proto, res.StatusCode, elapsed, pollWait)
	}
}

func TestOfflinePollPrivatePipeAllowsPausedReads(t *testing.T) {
	g := &server{serverConfig: serverConfig{offlineClient: true}, pingInterval: 20 * time.Millisecond}
	t.Cleanup(g.offlinePoll.stop)
	ctx := testCtx(t)
	r := httptest.NewRequestWithContext(ctx, http.MethodPost, "http://localhost"+pollPath, nil)
	r.Header.Set("Origin", "null")
	conn, _, err := g.offlinePoll.upstream.dial(ctx, g, r)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.CloseNow() })
	// Leave the pipe's read side idle long enough for the public
	// WebSocket heartbeat to time out if it were running here.
	time.Sleep(5 * g.pingInterval)
	if err := conn.Write(ctx, websocket.MessageBinary, []byte{0, 0}); err != nil {
		t.Fatalf("private pipe closed while the reader was paused: %v", err)
	}
	if _, _, err := conn.Read(ctx); websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Fatalf("the private server did not process the hello: %v", err)
	}
}

func TestOfflinePollSetsDeadlineBeforeOuterRedirect(t *testing.T) {
	g := &server{serverConfig: serverConfig{base: "/desk/", offlineClient: true, vncOff: true}}
	for _, path := range []string{"/desk", "/desk/session//poll"} {
		r := httptest.NewRequest(http.MethodPost, "http://localhost"+path, bytes.NewBufferString("body"))
		w := &pollDeadlineRecorder{ResponseRecorder: httptest.NewRecorder()}
		g.handler().ServeHTTP(w, r)
		if w.Code < 300 || w.Code >= 400 || w.readDeadline.IsZero() {
			t.Errorf("%s returned %d with deadline %v", path, w.Code, w.readDeadline)
		}
	}
}

func TestOfflinePollRetainsRepliesAndChargesInFlightBatches(t *testing.T) {
	p := &offlinePoll{tunnels: make(map[string]*pollTunnel), creates: make(map[pollCreateKey]*pollTunnel)}
	ctx, cancel := context.WithCancel(context.Background())
	tunnel := &pollTunnel{
		id: "test", active: "active", key: pollCreateKey{ip: "192.0.2.1"},
		bridge: p, ctx: ctx, cancel: cancel, changed: make(chan struct{}),
		timer: time.AfterFunc(time.Hour, func() {}),
	}
	p.slots.take(tunnel.key.ip, 1, 1)
	p.tunnels[tunnel.id], p.creates[tunnel.key] = tunnel, tunnel
	t.Cleanup(func() { p.drop(tunnel) })
	for range pollClosedPerIP {
		if !p.finished.take(tunnel.key.ip, pollClosedLimit, pollClosedPerIP) {
			t.Fatal("could not fill the close cache")
		}
	}
	data := []byte("reply")
	if ok, _ := p.tryReserveReceive("", cap(data)); !ok {
		t.Fatal("could not reserve receive bytes")
	}
	if err := tunnel.bufferFrame(p.receiveFrame("", data, false)); err != nil {
		t.Fatal(err)
	}
	for owner, n := range map[string]int{
		"one": pollSessionReceiveBudget, "two": pollSessionReceiveBudget,
		"three": pollReceiveBudget - 2*pollSessionReceiveBudget - cap(data),
	} {
		if ok, _ := p.tryReserveReceive(owner, n); !ok {
			t.Fatal("could not reserve the rest of the receive budget")
		}
		defer p.releaseReceive(owner, n)
	}
	if ok, _ := p.tryReserveReceive("four", 1); ok {
		t.Fatal("receive budget admitted more bytes than its limit")
	}

	tunnel.mu.Lock()
	p.terminateLocked(tunnel, websocket.StatusNormalClosure, "")
	tunnel.closedAt = time.Now().Add(-pollCloseGrace - time.Second)
	tunnel.mu.Unlock()
	p.expire(tunnel)
	if p.slots.total != 0 || p.tunnels[tunnel.id] != tunnel || p.replies.total != 1 {
		t.Fatal("unread reply was removed or still occupies a live slot")
	}

	tunnel.mu.Lock()
	batch, status := tunnel.batchLocked(tunnel.active, 0, false)
	tunnel.mu.Unlock()
	t.Cleanup(func() {
		for _, frame := range batch.frames {
			frame.release()
		}
	})
	if status != http.StatusOK || len(batch.Messages) != 1 || !bytes.Equal(batch.Messages[0], data) {
		t.Fatalf("retained reply got %d and %+v", status, batch)
	}

	tunnel.mu.Lock()
	closed, status := tunnel.batchLocked(tunnel.active, 1, false)
	expiry := tunnel.expiryLocked()
	tunnel.mu.Unlock()
	if status != http.StatusOK || closed.Close == nil || time.Until(expiry) < pollCloseGrace/2 {
		t.Fatalf("last acknowledgement returned %d and %+v, expiry %v", status, closed, expiry)
	}
	p.drop(tunnel)
	if p.replies.total != 0 || p.receiveByOwner[""] != cap(data) {
		t.Fatal("reply slot or in-flight batch was accounted incorrectly")
	}
}

func TestOfflinePollReceiveCapacityIsSharedFairly(t *testing.T) {
	p := &offlinePoll{}
	ctx := testCtx(t)
	tunnel := &pollTunnel{bridge: p, ctx: ctx}
	if ok, _ := p.tryReserveReceive("busy", pollSessionReceiveBudget); !ok {
		t.Fatal("could not reserve one session's capacity")
	}
	if ok, _ := p.tryReserveReceive("busy", 1); ok {
		t.Fatal("one session exceeded its receive allowance")
	}
	if ok, _ := p.tryReserveReceive("other", 1); !ok {
		t.Fatal("a full session blocked another session")
	}
	done := make(chan error, 1)
	go func() { done <- tunnel.reserveReceive("busy", 1) }()
	p.releaseReceive("busy", pollSessionReceiveBudget)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("receive capacity did not wake the waiting session")
	}
	p.releaseReceive("busy", 1)
	p.releaseReceive("other", 1)
}

func TestOfflinePollLegacyMessageFitsBesideFullSession(t *testing.T) {
	p := &offlinePoll{}
	for owner, n := range map[string]int{"": pollHandshakeReceiveBudget, "busy": pollSessionReceiveBudget} {
		if ok, _ := p.tryReserveReceive(owner, n); !ok {
			t.Fatal("could not reserve receive capacity")
		}
		defer p.releaseReceive(owner, n)
	}
	ctx, cancel := context.WithCancel(testCtx(t))
	tunnel := &pollTunnel{
		bridge: p, ctx: ctx, cancel: cancel, changed: make(chan struct{}),
		timer: time.AfterFunc(time.Hour, func() {}),
	}
	p.slots.take(tunnel.key.ip, 1, 1)
	t.Cleanup(func() { p.drop(tunnel) })
	if !tunnel.bindSession("legacy") {
		t.Fatal("could not bind legacy session")
	}
	message := make([]byte, pollLegacyFrameLimit)
	reader := bufio.NewReaderSize(bytes.NewReader(message), pollFragmentLimit+1)
	if err := tunnel.readLegacyMessage(reader); err != nil {
		t.Fatal(err)
	}
	if len(tunnel.frames) != 1 || len(tunnel.frames[0].data) != len(message) {
		t.Fatal("maximum-size legacy message was not delivered whole")
	}
}

func TestOfflinePollLiveReplyRequiresAcknowledgementProgress(t *testing.T) {
	p := &offlinePoll{tunnels: make(map[string]*pollTunnel), creates: make(map[pollCreateKey]*pollTunnel)}
	ctx, cancel := context.WithCancel(context.Background())
	tunnel := &pollTunnel{
		id: "stalled", active: "active", key: pollCreateKey{ip: "192.0.2.1"},
		bridge: p, ctx: ctx, cancel: cancel, changed: make(chan struct{}),
		timer: time.AfterFunc(time.Hour, func() {}), touched: time.Now(),
	}
	p.slots.take(tunnel.key.ip, 1, 1)
	p.tunnels[tunnel.id], p.creates[tunnel.key] = tunnel, tunnel
	t.Cleanup(func() { p.drop(tunnel) })
	if !tunnel.bindSession("session") {
		t.Fatal("could not bind test session")
	}
	data := []byte("reply")
	if err := tunnel.reserveReceive("session", cap(data)); err != nil {
		t.Fatal(err)
	}
	if err := tunnel.bufferFrame(p.receiveFrame("session", data, false)); err != nil {
		t.Fatal(err)
	}
	tunnel.mu.Lock()
	tunnel.lastAck = time.Now().Add(-pollReplyIdle - time.Second)
	tunnel.batchLocked(tunnel.active, 0, true)
	tunnel.mu.Unlock()
	p.expire(tunnel)
	if !tunnel.removed || tunnel.close == nil || tunnel.close.Code != websocket.StatusTryAgainLater || p.receiving != 0 {
		t.Fatal("polling without acknowledgement progress retained the live reply")
	}
}

type pollBodyReader func([]byte) (int, error)

func (r pollBodyReader) Read(p []byte) (int, error) { return r(p) }

type pollDeadlineRecorder struct {
	*httptest.ResponseRecorder
	readDeadline   time.Time
	writeDeadline  time.Time
	onReadDeadline func(time.Time)
}

func (w *pollDeadlineRecorder) SetReadDeadline(d time.Time) error {
	w.readDeadline = d
	if w.onReadDeadline != nil {
		w.onReadDeadline(d)
	}
	return nil
}

func TestOfflinePollDeleteCancelsUpload(t *testing.T) {
	p := &offlinePoll{tunnels: make(map[string]*pollTunnel), creates: make(map[pollCreateKey]*pollTunnel)}
	ctx, cancel := context.WithCancel(context.Background())
	tunnel := &pollTunnel{
		id: "upload", active: "active", key: pollCreateKey{ip: "192.0.2.1"}, sent: 1,
		ctx: ctx, cancel: cancel, changed: make(chan struct{}), timer: time.AfterFunc(time.Hour, func() {}),
	}
	p.slots.take(tunnel.key.ip, 1, 1)
	p.tunnels[tunnel.id], p.creates[tunnel.key] = tunnel, tunnel
	t.Cleanup(func() { p.drop(tunnel) })
	if !tunnel.bindSession("upload-session") {
		t.Fatal("could not bind upload session")
	}
	started, expired, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	expire := sync.OnceFunc(func() { close(expired) })
	w := &pollDeadlineRecorder{
		ResponseRecorder: httptest.NewRecorder(),
		onReadDeadline: func(deadline time.Time) {
			if !deadline.After(time.Now()) {
				expire()
			}
		},
	}
	reader := pollBodyReader(func([]byte) (int, error) {
		close(started)
		<-expired
		return 0, os.ErrDeadlineExceeded
	})
	send := httptest.NewRequest(http.MethodPost, "/send?seq=2", reader)
	send.SetPathValue("connection", "active")
	send.ContentLength = 4 << 20
	go func() {
		defer close(done)
		p.send(tunnel, w, send)
	}()
	t.Cleanup(func() { expire(); <-done })
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("upload did not start")
	}
	deletion := httptest.NewRequest(http.MethodDelete, "/", nil)
	deletion.SetPathValue("connection", "active")
	deleted := httptest.NewRecorder()
	p.removeConnection(tunnel, deleted, deletion)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("upload remained blocked after deletion")
	}
	if deleted.Code != http.StatusNoContent || w.Code != http.StatusGone || p.sending != 0 {
		t.Fatalf("delete got %d, send got %d, %d bytes still reserved", deleted.Code, w.Code, p.sending)
	}
}

func (w *pollDeadlineRecorder) SetWriteDeadline(d time.Time) error {
	w.writeDeadline = d
	return nil
}

func TestOfflinePollSendAdmissionAndDeadline(t *testing.T) {
	p := &offlinePoll{}
	ctx := testCtx(t)
	tunnel := &pollTunnel{
		active: "old", standby: "next", standbyUntil: time.Now().Add(time.Minute),
		sent: 1, changed: make(chan struct{}), ctx: ctx,
	}
	send := func(body io.Reader, size int64) *http.Request {
		r := httptest.NewRequestWithContext(ctx, http.MethodPost, "http://localhost/send?seq=2", body)
		r.ContentLength = size
		r.SetPathValue("connection", "old")
		return r
	}
	started, release := make(chan struct{}), make(chan struct{})
	first := httptest.NewRecorder()
	done := make(chan struct{})
	const size = 4 << 20
	unread := pollBodyReader(func([]byte) (int, error) {
		t.Error("a rejected send was allowed to read")
		return 0, io.EOF
	})
	unverified := httptest.NewRecorder()
	p.send(tunnel, unverified, send(unread, size))
	if unverified.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("large send before authentication got %d, want 413", unverified.Code)
	}
	if !tunnel.bindSession("upload-session") {
		t.Fatal("could not bind upload session")
	}
	pause := pollBodyReader(func([]byte) (int, error) {
		close(started)
		<-release
		return 0, io.EOF
	})
	body := io.MultiReader(pause, bytes.NewReader([]byte{0, 0, 0, 1, 'x'}))
	w := &pollDeadlineRecorder{ResponseRecorder: first}
	go func() {
		defer close(done)
		p.send(tunnel, w, send(body, size))
	}()
	resume := sync.OnceFunc(func() { close(release) })
	t.Cleanup(func() { resume(); <-done })
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("first send did not start reading")
	}
	if remaining := time.Until(w.readDeadline); remaining < 20*time.Second ||
		w.writeDeadline.Sub(w.readDeadline) != 2*pollWriteTimeout {
		t.Fatalf("large body deadline in %v, response deadline %v", remaining, w.writeDeadline)
	}
	if got := p.sending; got != size {
		t.Fatalf("reserved %d bytes before reading, want %d", got, size)
	}

	duplicate := httptest.NewRecorder()
	p.send(tunnel, duplicate, send(unread, size))
	if duplicate.Code != http.StatusTooManyRequests {
		t.Fatalf("concurrent send got %d, want 429", duplicate.Code)
	}

	switchReq := httptest.NewRequestWithContext(ctx, http.MethodPost, "http://localhost/switch",
		bytes.NewBufferString(`{"connectionId":"next"}`))
	switchReq.SetPathValue("connection", "old")
	switched := httptest.NewRecorder()
	tunnel.promote(switched, switchReq)
	if switched.Code != http.StatusOK {
		t.Fatalf("switch during body read got %d: %s", switched.Code, switched.Body)
	}
	resume()
	<-done
	if first.Code != http.StatusConflict || p.sending != 0 {
		t.Fatalf("send after promotion got %d with %d bytes reserved", first.Code, p.sending)
	}
}

func TestOfflinePollSendCapacityIsSharedFairly(t *testing.T) {
	p := &offlinePoll{}
	for owner, size := range map[string]int64{
		"busy": pollSessionSendBudget, "": pollHandshakeSendBudget,
	} {
		if !p.reserveSend(owner, size) || p.reserveSend(owner, 1) {
			t.Fatalf("unexpected send allowance for %q", owner)
		}
	}
	if !p.reserveSend("other", pollSendLimit) {
		t.Fatal("busy session blocked a maximum-size send from another session")
	}
	if !p.reserveSend("other", pollSessionSendBudget-pollSendLimit) || p.reserveSend("third", 1) {
		t.Fatal("unexpected global send allowance")
	}
	p.releaseSend("other", pollSessionSendBudget)
	if !p.reserveSend("third", pollSendLimit) {
		t.Fatal("released capacity stayed occupied")
	}
	p.releaseSend("busy", pollSessionSendBudget)
	p.releaseSend("", pollHandshakeSendBudget)
	p.releaseSend("third", pollSendLimit)
	if p.sending != 0 || len(p.sendByOwner) != 0 {
		t.Fatal("send reservations were not released")
	}
}
