package main

import (
	"bytes"
	"context"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/crypto/chacha20poly1305"
)

// RFC 9380 appendix J.4.2 (curve25519_XMD:SHA-512_ELL2_NU_): the field
// element u[0] and the u-coordinate of map_to_curve's output, Q.x.
var elligator2Vectors = []struct {
	In  string `json:"in"`
	Out string `json:"out"`
}{
	{"608d892b641f0328523802a6603427c26e55e6f27e71a91a478148d45b5093cd", "51125222da5e763d97f3c10fcc92ea6860b9ccbbd2eb1285728f566721c1e65b"},
	{"46f5b22494bfeaa7f232cc8d054be68561af50230234d7d1d63d1d9abeca8da5", "7d56d1e08cb0ccb92baf069c18c49bb5a0dcd927eff8dcf75ca921ef7f3e6eeb"},
	{"235fe40c443766ce7e18111c33862d66c3b33267efa50d50f9e8e5d252a40aaa", "3fbe66b9c9883d79e8407150e7c2a1c8680bee496c62fabe4619a72b3cabe90f"},
	{"001e92a544463bda9bd04ddbe3d6eed248f82de32f522669efc5ddce95f46f5b", "227e0bb89de700385d19ec40e857db6e6a3e634b1c32962f370d26f84ff19683"},
	{"1a68a1af9f663592291af987203393f707305c7bac9c8d63d6a729bdc553dc19", "3bcd651ee54d5f7b6013898aab251ee8ecc0688166fce6e9548d38472f6bd196"},
}

func TestElligator2(t *testing.T) {
	for _, v := range elligator2Vectors {
		in, _ := new(big.Int).SetString(v.In, 16)
		if got := elligator2(in).Text(16); strings.TrimLeft(v.Out, "0") != got {
			t.Errorf("elligator2(%s) = %s, want %s", v.In, got, v.Out)
		}
	}
}

func TestCPace(t *testing.T) {
	sid := make([]byte, cpaceSID)
	rand.Read(sid)
	agree := func(prsA, prsB string) {
		a, ya, err := cpaceShare(cpaceGenerator(prsA, sid))
		if err != nil {
			t.Fatal(err)
		}
		b, yb, err := cpaceShare(cpaceGenerator(prsB, sid))
		if err != nil {
			t.Fatal(err)
		}
		ka, err := x25519(a, yb)
		if err != nil {
			t.Fatal(err)
		}
		kb, err := x25519(b, ya)
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Equal(ka, kb) != (prsA == prsB) {
			t.Fatalf("%q vs %q: keys equal = %v", prsA, prsB, bytes.Equal(ka, kb))
		}
	}
	agree("s3cret123456", "s3cret123456")
	agree("s3cret123456", "s3cret123457")
	// A long password still hashes (lv lengths over 127 bytes).
	long := strings.Repeat("x", 300)
	agree(long, long)
	if bytes.Equal(cpaceGenerator("a", sid), cpaceGenerator("b", sid)) {
		t.Fatal("same generator for different passwords")
	}
}

func TestOathCandidates(t *testing.T) {
	g := newUsersFile(t, "s3cret")
	e, err := readOathEntry(g.usersFile)
	if err != nil {
		t.Fatal(err)
	}
	got := e.candidates(time.Unix(59, 0))
	want := []string{"s3cret" + hotp(testKey, 0, 6), "s3cret" + hotp(testKey, 1, 6), "s3cret" + hotp(testKey, 2, 6)}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("candidates %v, want %v", got, want)
	}
	g = newUsersFile(t, "-")
	if e, _ = readOathEntry(g.usersFile); e.pin != "" {
		t.Fatalf("pin %q for '-'", e.pin)
	}
}

// tunnelClient is the browser's side of a session tunnel, done the way
// tunnel.js does it.
type tunnelClient struct {
	c            *websocket.Conn
	send, recv   cipher.AEAD
	sendN, recvN uint64
}

func wsURL(srvURL string) string { return "ws" + strings.TrimPrefix(srvURL, "http") + "/tunnel" }

func dialWS(t *testing.T, ctx context.Context, url string) *websocket.Conn {
	t.Helper()
	c, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	c.SetReadLimit(maxClientMessage + tunnelOverhead)
	t.Cleanup(func() { c.CloseNow() })
	return c
}

type testSession struct {
	id     string
	secret []byte
	logins []loginEvent // the logins before this one, from the login's reply
}

func loginHello(sid, ya []byte) []byte {
	return append(append([]byte{tunnelVersion, helloLogin}, sid...), ya...)
}

// loginAt runs the browser's side of a login tunnel. It returns the
// session, or the status the server closed with.
func loginAt(t *testing.T, ctx context.Context, url, credential string) (testSession, websocket.StatusCode) {
	t.Helper()
	c := dialWS(t, ctx, url)
	sid := make([]byte, cpaceSID)
	rand.Read(sid)
	a, ya, err := cpaceShare(cpaceGenerator(credential, sid))
	if err != nil {
		t.Fatal(err)
	}
	c.Write(ctx, websocket.MessageBinary, loginHello(sid, ya))
	_, reply, err := c.Read(ctx)
	if err != nil {
		return testSession{}, websocket.CloseStatus(err)
	}
	var keys [][]byte
	var tags []byte
	for i := 1; i+32 <= len(reply); i += 32 {
		yb := reply[i : i+32]
		k, _ := x25519(a, yb)
		ks := loginKeys(sid, k, ya, yb)
		keys = append(keys, ks)
		tags = append(tags, ks[64:96]...)
	}
	c.Write(ctx, websocket.MessageBinary, tags)
	_, confirm, err := c.Read(ctx)
	if err != nil {
		return testSession{}, websocket.CloseStatus(err)
	}
	for _, ks := range keys {
		if !bytes.Equal(confirm[1:], ks[96:]) {
			continue
		}
		recv, _ := chacha20poly1305.New(ks[32:64])
		_, ct, err := c.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		pt, err := recv.Open(nil, tunnelNonce(0), ct, nil)
		if err != nil {
			t.Fatal(err)
		}
		var res struct {
			Session, Secret string
			Logins          []loginEvent
		}
		json.Unmarshal(pt[1:], &res)
		secret, _ := base64.StdEncoding.DecodeString(res.Secret)
		return testSession{res.Session, secret, res.Logins}, 0
	}
	t.Fatal("no candidate matches the server's confirmation")
	return testSession{}, 0
}

func login(t *testing.T, ctx context.Context, srvURL, credential string) testSession {
	t.Helper()
	s, status := loginAt(t, ctx, wsURL(srvURL), credential)
	if status != 0 {
		t.Fatalf("login with %q: closed with %d", credential, status)
	}
	return s
}

// openSessionAt runs a session tunnel's handshake; the tunnel is nil if
// the server closed it (its status is returned).
func openSessionAt(t *testing.T, ctx context.Context, url string, s testSession) (*tunnelClient, websocket.StatusCode) {
	t.Helper()
	c := dialWS(t, ctx, url)
	eph, _ := ecdh.X25519().GenerateKey(rand.Reader)
	pub := eph.PublicKey().Bytes()
	c.Write(ctx, websocket.MessageBinary, append(append([]byte{tunnelVersion, helloSession}, pub...), s.id...))
	_, hello, err := c.Read(ctx)
	if err != nil {
		return nil, websocket.CloseStatus(err)
	}
	if len(hello) != 33 || hello[0] != tunnelVersion {
		t.Fatalf("server hello %x", hello)
	}
	ee, err := x25519(eph, hello[1:])
	if err != nil {
		t.Fatal(err)
	}
	keys := sessionKeys(ee, s.secret, pub, hello[1:], s.id)
	send, _ := chacha20poly1305.New(keys[:32])
	recv, _ := chacha20poly1305.New(keys[32:])
	return &tunnelClient{c: c, send: send, recv: recv}, 0
}

func openSession(t *testing.T, ctx context.Context, srvURL string, s testSession) *tunnelClient {
	t.Helper()
	tc, status := openSessionAt(t, ctx, wsURL(srvURL), s)
	if tc == nil {
		t.Fatalf("session tunnel closed with %d", status)
	}
	return tc
}

func (tc *tunnelClient) write(ctx context.Context, kind byte, p []byte) error {
	ct := tc.send.Seal(nil, tunnelNonce(tc.sendN), append([]byte{kind}, p...), nil)
	tc.sendN++
	return tc.c.Write(ctx, websocket.MessageBinary, ct)
}

func (tc *tunnelClient) read(ctx context.Context) (byte, []byte, error) {
	_, ct, err := tc.c.Read(ctx)
	if err != nil {
		return 0, nil, err
	}
	pt, err := tc.recv.Open(nil, tunnelNonce(tc.recvN), ct, nil)
	if err != nil {
		return 0, nil, err
	}
	tc.recvN++
	return pt[0], pt[1:], nil
}

func (tc *tunnelClient) readJSON(t *testing.T, ctx context.Context) map[string]any {
	t.Helper()
	kind, p, err := tc.read(ctx)
	if err != nil || kind != msgText {
		t.Fatalf("reading a reply: kind %d, %q: %v", kind, p, err)
	}
	var v map[string]any
	if err := json.Unmarshal(p, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

// request sends req as the tunnel's request and returns the reply.
func (tc *tunnelClient) request(t *testing.T, ctx context.Context, req any) map[string]any {
	t.Helper()
	b, _ := json.Marshal(req)
	if err := tc.write(ctx, msgText, b); err != nil {
		t.Fatal(err)
	}
	return tc.readJSON(t, ctx)
}

func newE2EServerPin(t *testing.T, pin string) (*server, *httptest.Server) {
	t.Helper()
	g := newUsersFile(t, pin)
	novnc := t.TempDir()
	os.WriteFile(filepath.Join(novnc, "vnc.html"), []byte("noVNC"), 0o644)
	term := t.TempDir()
	for _, name := range ttyAssets {
		os.WriteFile(filepath.Join(term, name), []byte("export {}"), 0o644)
	}
	g.base, g.novncDir, g.downloadsDir, g.termDir, g.nobleDir = "/", novnc, t.TempDir(), term, fakeNoble(t)
	g.sessions = map[string]*session{}
	g.failures, g.pending, g.ttys = map[string][]time.Time{}, map[string]int{}, map[string]int{}
	srv := httptest.NewServer(g.handler())
	t.Cleanup(srv.Close)
	return g, srv
}

// fakeNoble lays out empty noble library files.
func fakeNoble(t *testing.T) string {
	t.Helper()
	noble := t.TempDir()
	for _, name := range nobleFiles {
		os.MkdirAll(filepath.Dir(filepath.Join(noble, name)), 0o755)
		os.WriteFile(filepath.Join(noble, name), []byte("export {}"), 0o644)
	}
	return noble
}

func newE2EServer(t *testing.T) (*server, *httptest.Server) {
	return newE2EServerPin(t, "-")
}

func testCtx(t *testing.T) context.Context {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func failureCount(g *server) int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.failures["127.0.0.1"])
}

func TestTunnelLogin(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)

	for _, cred := range []string{code(2), code(-2)} {
		if _, status := loginAt(t, ctx, wsURL(srv.URL), cred); status != closeLoginFailed {
			t.Fatalf("code outside the window: status %d", status)
		}
	}
	if n := failureCount(g); n != 2 {
		t.Errorf("%d failures counted, want 2", n)
	}
	// The previous, current and next codes all work, each once, in order.
	for _, offset := range []int64{-1, 0, 1} {
		s := login(t, ctx, srv.URL, code(offset))
		if secret, ok := g.sessionSecret(s.id); !ok || !bytes.Equal(secret, s.secret) {
			t.Fatalf("code(%d): session not stored", offset)
		}
	}
	// Used codes are refused, and earlier ones with them.
	for _, offset := range []int64{1, 0, -1} {
		if _, status := loginAt(t, ctx, wsURL(srv.URL), code(offset)); status != closeLoginFailed {
			t.Errorf("reused code(%d): status %d", offset, status)
		}
	}
}

func TestTunnelLoginPIN(t *testing.T) {
	_, srv := newE2EServerPin(t, "s3cret")
	ctx := testCtx(t)
	if _, status := loginAt(t, ctx, wsURL(srv.URL), code(0)); status != closeLoginFailed {
		t.Fatalf("code without the PIN: status %d", status)
	}
	if _, status := loginAt(t, ctx, wsURL(srv.URL), "wrong"+code(0)); status != closeLoginFailed {
		t.Fatalf("wrong PIN: status %d", status)
	}
	login(t, ctx, srv.URL, "s3cret"+code(0))
}

func TestTunnelLoginLimit(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	sid := make([]byte, cpaceSID)
	_, ya, _ := cpaceShare(cpaceGenerator("x", sid))

	// A login abandoned after the server's shares isn't a failure, and its
	// reservation is released.
	c := dialWS(t, ctx, wsURL(srv.URL))
	c.Write(ctx, websocket.MessageBinary, loginHello(sid, ya))
	if _, _, err := c.Read(ctx); err != nil {
		t.Fatal(err)
	}
	c.Close(websocket.StatusNormalClosure, "")
	eventually(t, "the reservation released", func() bool {
		g.mu.Lock()
		defer g.mu.Unlock()
		return g.pending["127.0.0.1"] == 0
	})
	if n := failureCount(g); n != 0 {
		t.Fatalf("abandoned login counted %d failures", n)
	}

	// Garbage tags fail like a wrong code.
	c = dialWS(t, ctx, wsURL(srv.URL))
	c.Write(ctx, websocket.MessageBinary, loginHello(sid, ya))
	c.Read(ctx)
	c.Write(ctx, websocket.MessageBinary, make([]byte, 96))
	if _, _, err := c.Read(ctx); websocket.CloseStatus(err) != closeLoginFailed {
		t.Fatalf("garbage tags: %v", err)
	}

	// Logins waiting for their tags hold the remaining attempts.
	for range maxFailures - 1 {
		c := dialWS(t, ctx, wsURL(srv.URL))
		c.Write(ctx, websocket.MessageBinary, loginHello(sid, ya))
		if _, _, err := c.Read(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if _, status := loginAt(t, ctx, wsURL(srv.URL), code(0)); status != closeLoginRefused {
		t.Fatalf("login past the limit: status %d", status)
	}
}

func TestTunnelLoginBusy(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	fillLoginWork(t)
	if _, status := loginAt(t, ctx, wsURL(srv.URL), code(0)); status != websocket.StatusTryAgainLater {
		t.Fatalf("login with every slot taken: status %d", status)
	}
	if n := failureCount(g); n != 0 {
		t.Fatalf("a busy login counted %d failures", n)
	}
}

func TestTunnelSessions(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))

	if _, status := openSessionAt(t, ctx, wsURL(srv.URL), testSession{id: "nope", secret: s.secret}); status != closeLogin {
		t.Errorf("unknown session: status %d", status)
	}
	// A handshake bigger than any real one is refused unread.
	if _, status := openSessionAt(t, ctx, wsURL(srv.URL), testSession{id: strings.Repeat("x", 1000), secret: s.secret}); status != websocket.StatusMessageTooBig {
		t.Errorf("1000-byte session id: status %d", status)
	}
	// So is a request bigger than any real one.
	tc := openSession(t, ctx, srv.URL, s)
	tc.write(ctx, msgText, []byte(`{"type":"list","path":"`+strings.Repeat("x", 1100<<10)+`"}`))
	if _, _, err := tc.read(ctx); websocket.CloseStatus(err) != websocket.StatusMessageTooBig {
		t.Errorf("1.1 MiB request: %v", err)
	}
	// The right id with the wrong secret: the server can't read the request.
	tc = openSession(t, ctx, srv.URL, testSession{id: s.id, secret: make([]byte, 32)})
	tc.write(ctx, msgText, []byte(`{"type":"list"}`))
	if _, _, err := tc.read(ctx); websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Errorf("wrong secret: %v", err)
	}
	// A changed message, or one replayed out of order, ends the tunnel.
	tc = openSession(t, ctx, srv.URL, s)
	ct := tc.send.Seal(nil, tunnelNonce(0), []byte("\x01{\"type\":\"list\"}"), nil)
	ct[3] ^= 1
	tc.c.Write(ctx, websocket.MessageBinary, ct)
	if _, _, err := tc.read(ctx); websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Errorf("tampered message: %v", err)
	}
	tc = openSession(t, ctx, srv.URL, s)
	tc.sendN = 1
	tc.write(ctx, msgText, []byte(`{"type":"list"}`))
	if _, _, err := tc.read(ctx); websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Errorf("wrong nonce: %v", err)
	}
	// An old protocol version.
	c := dialWS(t, ctx, wsURL(srv.URL))
	c.Write(ctx, websocket.MessageBinary, append([]byte{1}, make([]byte, 32)...))
	if _, _, err := c.Read(ctx); websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Errorf("version 1: %v", err)
	}

	if reply := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "logout"}); reply["ok"] != true {
		t.Fatalf("logout: %v", reply)
	}
	if _, ok := g.sessionSecret(s.id); ok {
		t.Fatal("session still valid after logout")
	}
	if _, status := openSessionAt(t, ctx, wsURL(srv.URL), s); status != closeLogin {
		t.Errorf("after logout: status %d", status)
	}
}

// Nothing is served outside the tunnel except the pages and scripts, and
// proxies are asked not to change any of it.
func TestEndpoints(t *testing.T) {
	g, srv := newE2EServer(t)
	noble := "/tabtop/" + g.noblePath()
	noRedirect := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	for _, tc := range []struct {
		method, path string
		want         int
	}{
		{"GET", "/vnc.html", http.StatusOK},
		{"GET", "/websockify", http.StatusNotFound},
		{"GET", "/audio/ws", http.StatusNotFound},
		{"GET", "/audio/stream.ogg", http.StatusNotFound},
		{"GET", "/tty/ws", http.StatusNotFound},
		{"POST", "/tty/", http.StatusMethodNotAllowed},
		{"POST", "/downloads/", http.StatusMethodNotAllowed},
		{"PUT", "/downloads/a.txt", http.StatusMethodNotAllowed},
		{"DELETE", "/downloads/a.txt", http.StatusMethodNotAllowed},
		{"GET", "/tty/", http.StatusOK},
		{"GET", "/tty/" + g.ttyPath() + "/ghostty-web.js", http.StatusOK},
		{"GET", "/downloads/", http.StatusOK},
		{"GET", "/downloads/a%20b/c", http.StatusSeeOther},
		{"GET", "/tabtop/e2e.js", http.StatusNotFound},
		{"GET", "/tabtop/upload.js", http.StatusNotFound},
		{"GET", "/tabtop/download-sw.js", http.StatusOK},
		{"GET", "/tabtop/stream/x/f.bin", http.StatusNotFound},
		{"GET", "/tabtop/tunnel.js", http.StatusOK},
		{"GET", "/tabtop/files.js", http.StatusOK},
		{"GET", "/tabtop/ui.js", http.StatusOK},
		{"GET", "/tabtop/nav.js", http.StatusOK},
		{"GET", "/tabtop/requests.js", http.StatusOK},
		{"GET", "/tabtop/preview.js", http.StatusOK},
		{"GET", "/tabtop/reconnect.js", http.StatusOK},
		{"GET", "/tabtop/download.js", http.StatusOK},
		{"GET", "/tabtop/desktop.css", http.StatusOK},
		{"GET", "/tabtop/novnc.js", http.StatusOK},
		{"GET", noble + "/ciphers/chacha.js", http.StatusOK},
		{"GET", noble + "/curves/abstract/montgomery.js", http.StatusOK},
		{"GET", noble + "/ciphers/aes.js", http.StatusNotFound},
		{"GET", noble + "/curves/nist.js", http.StatusNotFound},
		{"GET", "/tabtop/noble/ciphers/chacha.js", http.StatusNotFound},
		{"GET", "/tabtop/noble-000000000000/ciphers/chacha.js", http.StatusNotFound},
		{"GET", "/tabtop/nope.js", http.StatusNotFound},
	} {
		req, _ := http.NewRequest(tc.method, srv.URL+tc.path, strings.NewReader("password=123456"))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		resp, err := noRedirect.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != tc.want {
			t.Errorf("%s %s: %d, want %d", tc.method, tc.path, resp.StatusCode, tc.want)
		}
		if len(resp.Cookies()) > 0 {
			t.Errorf("%s %s set a cookie", tc.method, tc.path)
		}
		cache := resp.Header.Get("Cache-Control")
		// Errors from the file server drop Cache-Control; there's nothing in
		// them to change.
		if resp.StatusCode < 400 && !strings.Contains(cache, "no-transform") {
			t.Errorf("%s %s: Cache-Control %q lacks no-transform", tc.method, tc.path, cache)
		}
		switch tc.method + " " + tc.path {
		case "GET " + noble + "/ciphers/chacha.js":
			if cache != immutableCache {
				t.Errorf("noble file cached as %q", cache)
			}
		case "GET /tabtop/desktop.css":
			if ct := resp.Header.Get("Content-Type"); ct != "text/css; charset=utf-8" || !strings.Contains(string(body), "#transfers") {
				t.Errorf("desktop.css is served as %q with %d bytes", ct, len(body))
			}
		case "GET /tabtop/tunnel.js":
			if cache != "no-cache, no-transform" || strings.Contains(string(body), `"./noble/`) ||
				!strings.Contains(string(body), `"./`+g.noblePath()+`/ciphers/chacha.js"`) {
				t.Errorf("tunnel.js (cached as %q) doesn't import from %s", cache, noble)
			}
		case "GET /downloads/a%20b/c":
			if loc := resp.Header.Get("Location"); loc != "/downloads/#/a%20b/c" {
				t.Errorf("redirect to %q", loc)
			}
		case "GET /downloads/":
			csp := resp.Header.Get("Content-Security-Policy")
			for _, want := range []string{"connect-src 'self'", "worker-src 'self'", "frame-src 'self'"} {
				if !strings.Contains(csp, want) {
					t.Errorf("downloads CSP %q lacks %s", csp, want)
				}
			}
		case "GET /tabtop/download-sw.js":
			if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/javascript") ||
				resp.Header.Get("Content-Security-Policy") != downloadSWCSP {
				t.Errorf("download-sw.js served as %q, CSP %q", ct, resp.Header.Get("Content-Security-Policy"))
			}
		}
	}
}

func TestTunnelFiles(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	big := make([]byte, (fileWindow+2)*fileChunk+123)
	rand.Read(big)
	os.MkdirAll(filepath.Join(g.downloadsDir, "sub"), 0o755)
	os.WriteFile(filepath.Join(g.downloadsDir, "sub", "big.bin"), big, 0o644)
	os.WriteFile(filepath.Join(g.downloadsDir, "a.txt"), []byte("hi"), 0o644)
	os.WriteFile(filepath.Join(filepath.Dir(g.downloadsDir), "secret"), []byte("no"), 0o644)
	s := login(t, ctx, srv.URL, code(0))

	reply := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "list"})
	b, _ := json.Marshal(reply["entries"])
	var entries []fileEntry
	json.Unmarshal(b, &entries)
	if reply["ok"] != true || len(entries) != 2 || entries[0].Name != "sub" || !entries[0].Dir ||
		entries[1].Name != "a.txt" || entries[1].Size != "2 B" {
		t.Fatalf("list: %v", reply)
	}
	for _, p := range []string{"../secret", "sub/../../secret", "/../secret"} {
		if reply := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "file", Path: p}); reply["error"] == nil {
			t.Errorf("file %q outside Downloads: %v", p, reply)
		}
	}

	tc := openSession(t, ctx, srv.URL, s)
	reply = tc.request(t, ctx, tunnelRequest{Type: "file", Path: "sub/big.bin"})
	if reply["name"] != "big.bin" || reply["size"] != float64(len(big)) {
		t.Fatalf("file: %v", reply)
	}
	// The server sends fileWindow chunks, then waits for them to be
	// acknowledged.
	type msg struct {
		kind byte
		p    []byte
		err  error
	}
	msgs := make(chan msg, 100)
	go func() {
		for {
			kind, p, err := tc.read(ctx)
			msgs <- msg{kind, p, err}
			if err != nil {
				return
			}
		}
	}()
	var got []byte
	for range fileWindow {
		m := <-msgs
		if m.err != nil || m.kind != msgData {
			t.Fatalf("file data: kind %d: %v", m.kind, m.err)
		}
		got = append(got, m.p...)
	}
	select {
	case m := <-msgs:
		t.Fatalf("sent more than %d chunks before any were acknowledged: %d bytes, %v", fileWindow, len(m.p), m.err)
	case <-time.After(300 * time.Millisecond):
	}
	for range fileWindow {
		tc.write(ctx, msgData, nil)
	}
	for {
		m := <-msgs
		if websocket.CloseStatus(m.err) == websocket.StatusNormalClosure {
			break
		}
		if m.err != nil || m.kind != msgData {
			t.Fatalf("file data: kind %d: %v", m.kind, m.err)
		}
		got = append(got, m.p...)
		tc.write(ctx, msgData, nil)
	}
	if !bytes.Equal(got, big) {
		t.Fatalf("file: got %d bytes, want %d, or different contents", len(got), len(big))
	}
}

func TestTunnelTTY(t *testing.T) {
	_, srv := newE2EServer(t)
	old := ttyCommand
	ttyCommand = func() *exec.Cmd {
		return exec.Command("sh", "-c", "stty -echo; echo ready; read x; stty size; echo got $x")
	}
	t.Cleanup(func() { ttyCommand = old })
	ctx := testCtx(t)

	tc := openSession(t, ctx, srv.URL, login(t, ctx, srv.URL, code(0)))
	if reply := tc.request(t, ctx, tunnelRequest{Type: "tty"}); reply["ok"] != true {
		t.Fatalf("tty: %v", reply)
	}
	var out strings.Builder
	readUntil := func(want string) {
		t.Helper()
		for !strings.Contains(out.String(), want) {
			_, p, err := tc.read(ctx)
			if err != nil {
				t.Fatalf("waiting for %q, got %q: %v", want, out.String(), err)
			}
			out.Write(p)
		}
	}
	readUntil("ready")
	tc.write(ctx, msgText, []byte(`{"type":"resize","cols":100,"rows":30}`))
	tc.write(ctx, msgText, []byte(`{"type":"resize","cols":0,"rows":99999}`)) // ignored
	tc.write(ctx, msgData, []byte("hello\r"))
	readUntil("got hello")
	if !strings.Contains(out.String(), "30 100") {
		t.Errorf("terminal size not applied: %q", out.String())
	}
	// The program exiting ends the tunnel.
	if _, _, err := tc.read(ctx); websocket.CloseStatus(err) != websocket.StatusNormalClosure {
		t.Errorf("after exit: %v, want a normal close", err)
	}
}

// fakeXvncUnix listens like Xvnc on a Unix socket with no login: it greets,
// then echoes.
func fakeXvncUnix(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "vnc.sock")
	l, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				c.Write([]byte("RFB 003.008\n"))
				io.Copy(c, c)
			}()
		}
	}()
	return path
}

func TestTunnelDesktopAndAudio(t *testing.T) {
	g, srv := newE2EServer(t)
	g.vncAddr = "unix:" + fakeXvncUnix(t)
	hub, _ := newTestHub()
	g.audio = hub
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))

	if err := g.vncListening(); err != nil {
		t.Errorf("healthz on the socket: %v", err)
	}
	// Audio only while the session has the desktop open.
	if reply := openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "audio"}); reply["error"] == nil {
		t.Fatalf("audio without the desktop: %v", reply)
	}
	desktop := openSession(t, ctx, srv.URL, s)
	if reply := desktop.request(t, ctx, tunnelRequest{Type: "vnc"}); reply["ok"] != true {
		t.Fatalf("vnc: %v", reply)
	}
	if _, p, err := desktop.read(ctx); err != nil || string(p) != "RFB 003.008\n" {
		t.Fatalf("greeting %q: %v", p, err)
	}
	desktop.write(ctx, msgData, []byte("ping"))
	if _, p, err := desktop.read(ctx); err != nil || string(p) != "ping" {
		t.Fatalf("echo %q: %v", p, err)
	}
	// The desktop takes messages bigger than a request, as for a pasted
	// clipboard.
	big := bytes.Repeat([]byte("clipboard"), 200<<10/9)
	desktop.write(ctx, msgData, big)
	var echo []byte
	for len(echo) < len(big) {
		_, p, err := desktop.read(ctx)
		if err != nil {
			t.Fatalf("echo of %d bytes, after %d: %v", len(big), len(echo), err)
		}
		echo = append(echo, p...)
	}
	if !bytes.Equal(echo, big) {
		t.Fatal("big message echoed wrong")
	}
	audio := openSession(t, ctx, srv.URL, s)
	if reply := audio.request(t, ctx, tunnelRequest{Type: "audio"}); reply["ok"] != true {
		t.Fatalf("audio: %v", reply)
	}
	if cfg := audio.readJSON(t, ctx); cfg["codec"] != "opus" {
		t.Fatalf("audio config: %v", cfg)
	}
	// Logging out closes the desktop, and the page logs in again.
	openSession(t, ctx, srv.URL, s).request(t, ctx, tunnelRequest{Type: "logout"})
	for {
		if _, _, err := desktop.read(ctx); err != nil {
			if websocket.CloseStatus(err) != closeLogin {
				t.Fatalf("desktop after logout: %v", err)
			}
			break
		}
	}
}

// TestTunnelRefusesOtherSites checks that a page on another site can't open
// a tunnel, which could spend the visitor's login attempts.
func TestTunnelRefusesOtherSites(t *testing.T) {
	_, srv := newE2EServer(t)
	h := http.Header{}
	h.Set("Origin", "https://evil.example")
	c, resp, err := websocket.Dial(testCtx(t), wsURL(srv.URL), &websocket.DialOptions{HTTPHeader: h})
	if err == nil {
		c.CloseNow()
		t.Fatal("a tunnel from another site was accepted")
	}
	if resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Errorf("response %v, want 403", resp)
	}
}

// TestTunnelPings checks that an idle tunnel is pinged, so proxies don't
// close it.
func TestTunnelPings(t *testing.T) {
	g, srv := newE2EServer(t)
	g.pingInterval = 20 * time.Millisecond
	var pings atomic.Int32
	c, _, err := websocket.Dial(testCtx(t), wsURL(srv.URL), &websocket.DialOptions{
		OnPingReceived: func(context.Context, []byte) bool { pings.Add(1); return true },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	// Pings are only seen while reading; nothing else arrives.
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	c.Read(ctx)
	if n := pings.Load(); n < 3 {
		t.Errorf("%d pings in 200ms at a 20ms interval", n)
	}
}

func TestTunnelUnderBasePath(t *testing.T) {
	g, _ := newE2EServer(t)
	g.base = "/x/"
	srv := httptest.NewServer(g.handler())
	t.Cleanup(srv.Close)
	ctx := testCtx(t)

	if code, body := fetch(t, srv.URL+"/x/tabtop/tunnel.js"); code != http.StatusOK || !strings.Contains(body, g.noblePath()) {
		t.Errorf("/x/tabtop/tunnel.js: %d %q", code, body)
	}
	noRedirect := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := noRedirect.Get(srv.URL + "/x/downloads/a")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if loc := resp.Header.Get("Location"); loc != "/x/downloads/#/a" {
		t.Errorf("redirect to %q", loc)
	}
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/x/tunnel"
	s, status := loginAt(t, ctx, url, code(0))
	if status != 0 {
		t.Fatalf("login under /x/: %d", status)
	}
	tc, _ := openSessionAt(t, ctx, url, s)
	if tc == nil || tc.request(t, ctx, tunnelRequest{Type: "list"})["ok"] != true {
		t.Fatal("list under /x/")
	}
}

// The page's tunnel.js against tabtopd, in Node, with each of its crypto
// backends: the Elligator2 map against RFC 9380, then a login, a listing
// and a file, which needs the handshakes, key derivations and framing to
// agree byte for byte. Needs
// Node 22 or later, and $TABTOP_NOBLE_DIR laid out as the image's
// /opt/noble (see the README).
func TestTunnelInteropWithJS(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not found")
	}
	nobleDir := os.Getenv("TABTOP_NOBLE_DIR")
	if nobleDir == "" {
		t.Skip("TABTOP_NOBLE_DIR not set")
	}
	// tunnel.js imports ./noble/..., as it's served.
	dir := t.TempDir()
	copyFile := func(from, to string) {
		data, err := os.ReadFile(from)
		if err != nil {
			t.Fatal(err)
		}
		os.MkdirAll(filepath.Dir(to), 0o755)
		os.WriteFile(to, data, 0o644)
	}
	copyFile("tunnel.js", filepath.Join(dir, "tunnel.js"))
	copyFile("testdata/tunnel_interop.mjs", filepath.Join(dir, "interop.mjs"))
	for _, name := range nobleFiles {
		copyFile(filepath.Join(nobleDir, name), filepath.Join(dir, "noble", name))
	}

	// A long PIN, so the length prefixes in CPace take more than one byte.
	pin := strings.Repeat("p4ss", 50)
	g, srv := newE2EServerPin(t, pin)
	data := make([]byte, (fileWindow+1)*fileChunk+77) // more than one window, so it needs acknowledgements
	rand.Read(data)
	os.WriteFile(filepath.Join(g.downloadsDir, "f.bin"), data, 0o644)
	vectors, _ := json.Marshal(elligator2Vectors)
	refusing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "no", http.StatusForbidden)
	}))
	defer refusing.Close()

	// Once with each of tunnel.js's crypto backends, each logging in with
	// its own code, since codes are single-use.
	for i, backend := range []string{"webcrypto", "noble"} {
		t.Run(backend, func(t *testing.T) {
			cmd := exec.Command(node, filepath.Join(dir, "interop.mjs"),
				wsURL(srv.URL), pin+code(int64(i)), string(vectors), backend, wsURL(refusing.URL))
			cmd.Stderr = os.Stderr
			out, err := cmd.Output()
			var exit *exec.ExitError
			if errors.As(err, &exit) && exit.ExitCode() == 3 {
				t.Skipf("node can't run tunnel.js: %s", out)
			}
			if err != nil {
				t.Fatalf("node: %v\n%s", err, out)
			}
			var res struct {
				Backend   string
				Refused   []string
				Elligator []string
				Session   string
				Entries   []fileEntry
				FileSHA   string
			}
			if err := json.Unmarshal(out, &res); err != nil {
				t.Fatalf("node output %q: %v", out, err)
			}
			if res.Backend != backend {
				if backend == "webcrypto" {
					t.Skipf("this node's WebCrypto lacks X25519 (used %s)", res.Backend)
				}
				t.Fatalf("ran with %s", res.Backend)
			}
			if !slices.Equal(res.Refused, []string{"TunnelError", "TunnelError"}) {
				t.Errorf("logging in and opening a tunnel where WebSockets are refused: %v", res.Refused)
			}
			for i, v := range elligator2Vectors {
				if i >= len(res.Elligator) || res.Elligator[i] != strings.TrimLeft(v.Out, "0") {
					t.Errorf("JS elligator2(%s) = %v, want %s", v.In, res.Elligator, v.Out)
				}
			}
			if _, ok := g.sessionSecret(res.Session); !ok {
				t.Errorf("session %q isn't valid", res.Session)
			}
			if len(res.Entries) != 1 || res.Entries[0].Name != "f.bin" {
				t.Errorf("entries %+v", res.Entries)
			}
			sum := sha256.Sum256(data)
			if res.FileSHA != hex.EncodeToString(sum[:]) {
				t.Errorf("file came through as %s", res.FileSHA)
			}
		})
	}
}
