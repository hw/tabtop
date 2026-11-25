package main

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/crypto/chacha20poly1305"
)

type remoteTestClient struct {
	tc                *tunnelClient
	id, proof, secret string
	final             []byte
	expires           int64
}

func startRemoteTest(t *testing.T, ctx context.Context, serverURL string) remoteTestClient {
	t.Helper()
	c := dialWS(t, ctx, wsURL(serverURL))
	eph, _ := ecdh.X25519().GenerateKey(rand.Reader)
	binding := make([]byte, 32)
	rand.Read(binding)
	commit := sha256.Sum256(binding)
	hello := append(append([]byte{}, eph.PublicKey().Bytes()...), commit[:]...)
	if err := c.Write(ctx, websocket.MessageBinary, append([]byte{tunnelVersion, helloRemote}, hello...)); err != nil {
		t.Fatal(err)
	}
	_, response, err := c.Read(ctx)
	if err != nil || len(response) != 65 {
		t.Fatalf("remote hello %x: %v", response, err)
	}
	ee, err := x25519(eph, response[1:33])
	if err != nil {
		t.Fatal(err)
	}
	keys := remoteKeys(ee, hello, response[1:33], response[33:])
	send, _ := chacha20poly1305.New(keys[:32])
	recv, _ := chacha20poly1305.New(keys[32:])
	tc := &tunnelClient{c: c, send: send, recv: recv}
	meta := tc.readJSON(t, ctx)
	id := meta["id"].(string)
	expires := int64(meta["expires"].(float64))
	proof := remoteProof(hello, response[1:33], response[33:], id, meta["approval_url"].(string), expires)
	final := remoteApprovedKeys(ee, hello, response[1:33], response[33:], binding)
	tc.send, _ = chacha20poly1305.New(final[:32])
	tc.recv, _ = chacha20poly1305.New(final[32:])
	tc.sendN = 0
	tc.recvN = 0
	return remoteTestClient{tc, id, proof, base64.RawURLEncoding.EncodeToString(binding), final, expires}
}
func (r remoteTestClient) request(kind string) tunnelRequest {
	return tunnelRequest{Type: kind, RemoteID: r.id, RemoteProof: r.proof, RemoteSecret: r.secret}
}
func freshRemoteApprover(g *server) testSession {
	id, key, _ := g.newSession("192.0.2.5", "trusted phone")
	return testSession{id: id, secret: key}
}
func remoteCount(g *server) int {
	g.remoteAuth.mu.Lock()
	defer g.remoteAuth.mu.Unlock()
	return len(g.remoteAuth.pending)
}
func waitRemoteGone(t *testing.T, g *server) {
	t.Helper()
	waitUntil(t, "the pending request let go", func() bool { return remoteCount(g) == 0 })
}

func TestRemoteApprovalEndToEnd(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	r := startRemoteTest(t, ctx, srv.URL)
	approver := login(t, ctx, srv.URL, code(0)) // Actual fresh CPace login on the trusted device.
	request := func(req tunnelRequest) map[string]any {
		return openSession(t, ctx, srv.URL, approver).request(t, ctx, req)
	}
	info := request(r.request("remote-auth-info"))
	if info["code"] != remoteCode(r.proof) || info["ip"] == nil {
		t.Fatalf("info: %v", info)
	}
	bad := r.request("remote-auth-approve")
	bad.RemoteProof = strings.Repeat("A", 43)
	if res := request(bad); res["error"] == nil {
		t.Fatal("wrong transcript approved")
	}
	bad = r.request("remote-auth-approve")
	bad.RemoteSecret = base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	if res := request(bad); res["error"] == nil {
		t.Fatal("wrong secret approved")
	}
	if res := request(r.request("remote-auth-approve")); res["decided"] != true {
		t.Fatalf("approve: %v", res)
	}
	if res := request(r.request("remote-auth-approve")); res["error"] == nil {
		t.Fatal("approval replay succeeded")
	}
	if res := r.tc.readJSON(t, ctx); res["approved"] != true {
		t.Fatalf("no approval: %v", res)
	}
	ack, _ := json.Marshal(map[string]string{"proof": r.proof})
	if err := r.tc.write(ctx, msgText, ack); err != nil {
		t.Fatal(err)
	}
	result := r.tc.readJSON(t, ctx)
	key, _ := base64.StdEncoding.DecodeString(result["secret"].(string))
	session := testSession{id: result["session"].(string), secret: key}
	if expiry := int64(result["expires"].(float64)); expiry > g.clock.Now().Add(remoteSessionMax+time.Second).UnixMilli() {
		t.Fatal("remote session too long")
	}
	go r.tc.c.Read(ctx)
	if res := openSession(t, ctx, srv.URL, session).request(t, ctx, tunnelRequest{Type: "sessions"}); res["error"] != nil {
		t.Fatalf("new session unusable: %v", res)
	}
	waitRemoteGone(t, g)
	g.endSession(session.id, "revoked", nil)
	if _, ok := g.sessionSecret(session.id); ok {
		t.Fatal("remote session could not be revoked")
	}
}
func TestRemoteRequiresFreshApprovalAndExactBinding(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	approver := freshRemoteApprover(g)
	r := startRemoteTest(t, ctx, srv.URL)
	// An existing session may inspect, but cannot approve or deny.
	for _, kind := range []string{"remote-auth-approve", "remote-auth-deny"} {
		res := openSession(t, ctx, srv.URL, approver).request(t, ctx, r.request(kind))
		if res["error"] == nil {
			t.Fatalf("old session %s", kind)
		}
	}
	fresh := freshRemoteApprover(g)
	g.mu.Lock()
	g.sessions[fresh.id].remoteApproved = true
	g.mu.Unlock()
	if res := openSession(t, ctx, srv.URL, fresh).request(t, ctx, r.request("remote-auth-approve")); res["error"] == nil {
		t.Fatal("remote session delegated approval")
	}
	g.mu.Lock()
	g.sessions[fresh.id].remoteApproved = false
	g.mu.Unlock()
	wrong := r.request("remote-auth-info")
	wrong.RemoteProof = strings.Repeat("B", 43)
	if res := openSession(t, ctx, srv.URL, fresh).request(t, ctx, wrong); res["error"] != errRemoteMissing.Error() {
		t.Fatalf("mismatch: %v", res)
	}
	// An interceptor knowing the unauthenticated ECDH exchange still lacks
	// the QR binding secret. An unrelated approval key cannot open the reply.
	unrelated, _ := chacha20poly1305.New(make([]byte, 32))
	real, _ := chacha20poly1305.New(r.final[32:])
	ct := real.Seal(nil, tunnelNonce(0), []byte("approved"), nil)
	if _, err := unrelated.Open(nil, tunnelNonce(0), ct, nil); err == nil {
		t.Fatal("approval did not require secret")
	}
	res := openSession(t, ctx, srv.URL, fresh).request(t, ctx, r.request("remote-auth-deny"))
	if res["decided"] != true {
		t.Fatalf("deny: %v", res)
	}
	if _, _, err := r.tc.c.Read(ctx); websocket.CloseStatus(err) != closeLoginFailed {
		t.Fatalf("denied requester: %v", err)
	}
	waitRemoteGone(t, g)
}
func TestRemoteCancelExpiryAndLimits(t *testing.T) {
	t.Run("disconnect", func(t *testing.T) {
		g, srv := newE2EServer(t)
		ctx := testCtx(t)
		r := startRemoteTest(t, ctx, srv.URL)
		r.tc.c.CloseNow()
		waitRemoteGone(t, g)
		g.passkeyWaits.mu.Lock()
		defer g.passkeyWaits.mu.Unlock()
		if g.passkeyWaits.total != 0 {
			t.Fatal("wait slot leaked")
		}
	})
	t.Run("expired", func(t *testing.T) {
		g, srv := newE2EServer(t)
		ctx := testCtx(t)
		r := startRemoteTest(t, ctx, srv.URL)
		a := freshRemoteApprover(g)
		g.remoteAuth.mu.Lock()
		g.remoteAuth.pending[r.id].expires = g.clock.Now().Add(-time.Second)
		g.remoteAuth.mu.Unlock()
		res := openSession(t, ctx, srv.URL, a).request(t, ctx, r.request("remote-auth-approve"))
		if res["error"] == nil {
			t.Fatal("expired approved")
		}
		r.tc.c.CloseNow()
		waitRemoteGone(t, g)
	})
	t.Run("bounded", func(t *testing.T) {
		g, srv := newE2EServer(t)
		ctx := testCtx(t)
		var clients []remoteTestClient
		for range passkeyWaitsPerIP {
			clients = append(clients, startRemoteTest(t, ctx, srv.URL))
		}
		c := dialWS(t, ctx, wsURL(srv.URL))
		eph, _ := ecdh.X25519().GenerateKey(rand.Reader)
		hello := append(append([]byte{tunnelVersion, helloRemote}, eph.PublicKey().Bytes()...), make([]byte, 32)...)
		c.Write(ctx, websocket.MessageBinary, hello)
		if _, _, err := c.Read(ctx); websocket.CloseStatus(err) != websocket.StatusTryAgainLater {
			t.Fatalf("limit: %v", err)
		}
		if remoteCount(g) != passkeyWaitsPerIP {
			t.Fatal("wrong pending count")
		}
		for _, r := range clients {
			r.tc.c.CloseNow()
		}
		waitRemoteGone(t, g)
	})
}
func TestRemoteApprovalRace(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	r := startRemoteTest(t, ctx, srv.URL)
	a := freshRemoteApprover(g)
	var wg sync.WaitGroup
	results := make(chan bool, 2)
	for range 2 {
		wg.Go(func() {
			res := openSession(t, ctx, srv.URL, a).request(t, ctx, r.request("remote-auth-deny"))
			results <- res["decided"] == true
		})
	}
	wg.Wait()
	close(results)
	wins := 0
	for ok := range results {
		if ok {
			wins++
		}
	}
	if wins != 1 {
		t.Fatalf("%d decisions won", wins)
	}
	r.tc.c.Read(ctx)
	waitRemoteGone(t, g)
}

// Approval alone never issues a session: the requester must prove the final
// channel key, and the approving session must remain live through issuance.
func TestRemoteFinishRequiresProofAndLiveApprover(t *testing.T) {
	for _, mode := range []string{"wrong-key", "wrong-proof", "revoked"} {
		t.Run(mode, func(t *testing.T) {
			g, srv := newE2EServer(t)
			ctx := testCtx(t)
			r := startRemoteTest(t, ctx, srv.URL)
			a := freshRemoteApprover(g)
			res := openSession(t, ctx, srv.URL, a).request(t, ctx, r.request("remote-auth-approve"))
			if res["decided"] != true {
				t.Fatalf("approve: %v", res)
			}
			r.tc.readJSON(t, ctx)
			proof := r.proof
			if mode == "wrong-key" {
				r.tc.send, _ = chacha20poly1305.New(make([]byte, 32))
			}
			if mode == "wrong-proof" {
				proof = strings.Repeat("C", 43)
			}
			if mode == "revoked" {
				g.endSession(a.id, "revoked", nil)
			}
			ack, _ := json.Marshal(map[string]string{"proof": proof})
			if err := r.tc.write(ctx, msgText, ack); err != nil {
				t.Fatal(err)
			}
			if _, _, err := r.tc.c.Read(ctx); err == nil {
				t.Fatal("issued session without final verification")
			}
			waitRemoteGone(t, g)
			g.mu.Lock()
			defer g.mu.Unlock()
			for id := range g.sessions {
				if id != a.id {
					t.Fatal("unauthorized remote session minted")
				}
			}
		})
	}
}

func TestRemoteURLsAndPage(t *testing.T) {
	for _, raw := range []string{"https://trusted.example/tabtop/auth/approve", "http://localhost:6080/auth/approve", "http://127.0.0.1:6080/auth/approve"} {
		if !validApprovalURL(raw) {
			t.Fatal(raw)
		}
	}
	for _, raw := range []string{"http://example.com/auth/approve", "javascript:alert(1)", "https://user:pass@example.com/auth/approve", "https://example.com/auth/approve?x=y", "https://example.com/auth/approve#x"} {
		if validApprovalURL(raw) {
			t.Fatal(raw)
		}
	}
	g, srv := newE2EServer(t)
	g.base = "/nested/"
	request := httptest.NewRequest("GET", "https://example.com/auth/approve", nil)
	request.Header.Set("Origin", "https://example.com")
	raw, err := g.approvalURL(request)
	if err != nil || raw != "https://example.com/nested/auth/approve" {
		t.Fatalf("base: %s %v", raw, err)
	}
	g.base = "/"
	response, err := http.Get(srv.URL + "/auth/approve")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 || response.Header.Get("Referrer-Policy") != "no-referrer" || !strings.Contains(response.Header.Get("Content-Security-Policy"), "frame-ancestors 'none'") {
		t.Fatal("approval page not isolated")
	}
	for _, name := range []string{"remote-approve.js", "remote-auth-view.js", "third-party/qrcodegen.js"} {
		w := httptest.NewRecorder()
		g.scripts(w, httptest.NewRequest("GET", "/tabtop/"+name, nil))
		if w.Code != 200 || bytes.Contains(w.Body.Bytes(), []byte("404 page not found")) {
			t.Fatalf("missing asset %s", name)
		}
	}
}
